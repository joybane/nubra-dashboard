// Headless reconstruction of a strategy's Strategy-Analysis chart, for the end-of-day auto-snapshot.
//
// This MIRRORS the client build in src/components/StrategyAnalysisView.tsx (effect 3a + the live
// P&L formula). Keep the formulas here in sync with that file: P&L = side·(close − avg)·qty, closed
// legs frozen at side·(exit_price − avg)·qty after their exit minute, all prices in rupees (paise/100).

const IST_OFFSET = 5.5 * 60 * 60; // seconds

export interface SnapPosition {
  ref_id: number;
  display_name?: string;
  zanskar_name?: string;
  order_side?: string;
  qty: number;            // unsigned
  avg_price: number;      // paise
  realised_pnl?: number;  // paise
  entry_time?: number;    // ns
  exit_time?: number;     // ns
  exit_price?: number;    // paise
  derivative_type?: string;
}

interface HistBar { time: number; open: number; high: number; low: number; close: number }
interface Pt { time: number; value: number }
interface GreekPt { time: number; delta: number; gamma: number; theta: number; vega: number }

export interface SnapshotData {
  version: 1;
  underlying: string | null;
  positions: SnapPosition[];          // open (qty != 0)
  closedPositions: SnapPosition[];    // closed (qty == 0)
  chart: {
    underlyingBars: HistBar[];
    legPriceData: Array<[number, Pt[]]>;
    legPnlData: Array<[number, Pt[]]>;
    basketPnlData: Pt[];
    legGreeksHist: Array<[number, GreekPt[]]>;
    pnlFrom: number; pnlTo: number; sessionOpen: number; sessionClose: number;
  };
}

type FetchTimeseries = (body: object) => Promise<unknown>;

// IST calendar date (YYYY-MM-DD) of an epoch-ns timestamp. Used as the snapshot's trade_date so the
// client manual-save and the server EOD job key the same row regardless of server timezone.
export function istDateString(ns: number): string {
  const d = new Date(ns / 1_000_000 + IST_OFFSET * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function deriveUnderlying(positions: SnapPosition[]): string | null {
  for (const p of positions) {
    const name = p.display_name || p.zanskar_name || '';
    const match = name.match(/^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY)/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

// Parse /charts/timeseries response into 1m bars (mirrors fetchHistorical in the client).
function parseBars(data: unknown): HistBar[] {
  const bars: HistBar[] = [];
  const result = (data as { result?: Array<{ values?: Array<Record<string, {
    open?: Array<{ ts?: string | number; v: number }>; high?: Array<{ v: number }>;
    low?: Array<{ v: number }>; close?: Array<{ v: number }>;
  }>> }> }).result;
  for (const group of result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        const opens = chart.open || [], highs = chart.high || [], lows = chart.low || [], closes = chart.close || [];
        const len = Math.min(opens.length, highs.length, lows.length, closes.length);
        for (let i = 0; i < len; i++) {
          const ts = opens[i].ts;
          if (ts == null) continue;
          const t = Number(BigInt(String(ts)) / 1_000_000_000n) + IST_OFFSET;
          bars.push({ time: t, open: opens[i].v / 100, high: highs[i].v / 100, low: lows[i].v / 100, close: closes[i].v / 100 });
        }
      }
    }
  }
  return bars;
}

async function fetchHistorical(
  fetchTs: FetchTimeseries, symbol: string, type: string, startDate: Date, endDate: Date,
): Promise<HistBar[]> {
  try {
    const data = await fetchTs({
      query: [{
        exchange: 'NSE', type, values: [symbol], fields: ['open', 'high', 'low', 'close'],
        startDate: startDate.toISOString(), endDate: endDate.toISOString(),
        interval: '1m', intraDay: false, realTime: false,
      }],
    });
    return parseBars(data);
  } catch {
    return [];
  }
}

// Build the full snapshot for one basket's positions, or null if there's nothing to chart.
export async function buildBasketSnapshot(
  allPositions: SnapPosition[], fetchTs: FetchTimeseries,
): Promise<{ underlying: string | null; tradeDate: string; data: SnapshotData; totalPnl: number; legCount: number } | null> {
  const underlying = deriveUnderlying(allPositions);
  if (!underlying) return null;

  // Unique legs by ref_id.
  const seen = new Set<number>();
  const legs: Array<{ refId: number; zanskarName: string; derivativeType: string }> = [];
  for (const p of allPositions) {
    if (seen.has(p.ref_id) || !p.zanskar_name) continue;
    seen.add(p.ref_id);
    legs.push({ refId: p.ref_id, zanskarName: p.zanskar_name, derivativeType: p.derivative_type || 'OPT' });
  }
  if (legs.length === 0) return null;

  const entryTimes = allPositions.map(p => p.entry_time || 0).filter(t => t > 0);
  const exitTimes = allPositions.map(p => p.exit_time || 0).filter(t => t > 0);
  if (entryTimes.length === 0) return null;

  const earliestNs = Math.min(...entryTimes);
  const latestNs = exitTimes.length > 0 ? Math.max(...exitTimes) : 0;
  const entryDate = new Date(earliestNs / 1_000_000);
  const y = entryDate.getFullYear(), mo = entryDate.getMonth(), d = entryDate.getDate();
  const sessionOpen = Date.UTC(y, mo, d, 3, 45, 0) / 1000 + IST_OFFSET;
  const sessionClose = Date.UTC(y, mo, d, 10, 0, 0) / 1000 + IST_OFFSET;
  const pnlFrom = Math.floor(earliestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET;
  const pnlTo = latestNs > 0
    ? Math.min(Math.ceil(latestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET, sessionClose)
    : sessionClose;
  const startDate = new Date(Date.UTC(y, mo, d, 3, 45, 0));
  const endDate = new Date(Date.UTC(y, mo, d, 10, 0, 0));

  const legFetches = legs.map(leg => {
    const type = leg.derivativeType === 'OPT' ? 'OPT' : leg.derivativeType === 'FUT' ? 'FUT' : 'STOCK';
    return fetchHistorical(fetchTs, leg.zanskarName, type, startDate, endDate).then(bars => ({ leg, bars }));
  });
  const [underlyingRaw, ...legResults] = await Promise.all([
    fetchHistorical(fetchTs, underlying, 'INDEX', startDate, endDate),
    ...legFetches,
  ]);

  const underlyingBars = underlyingRaw.filter(b => b.time >= sessionOpen && b.time <= sessionClose);
  const legPriceData = new Map<number, Pt[]>();
  const legPnlData = new Map<number, Pt[]>();
  const pnlByTime = new Map<number, Map<number, number>>();

  for (const { leg, bars } of legResults) {
    const sessionBars = bars.filter(b => b.time >= sessionOpen && b.time <= sessionClose);
    if (sessionBars.length === 0) continue;
    legPriceData.set(leg.refId, sessionBars.map(b => ({ time: b.time, value: b.close })));
    const pos = allPositions.find(p => p.ref_id === leg.refId);
    if (pos) {
      const side = (pos.order_side || '').includes('BUY') ? 1 : -1;
      const avgPrice = (pos.avg_price || 0) / 100;
      const qty = pos.qty || 0;
      const exitChartTime = pos.exit_time ? Math.floor(pos.exit_time / 1_000_000_000 / 60) * 60 + IST_OFFSET : 0;
      const realizedPnl = pos.exit_price != null ? side * (pos.exit_price / 100 - avgPrice) * qty : 0;
      const pnlBars = sessionBars.filter(b => b.time >= pnlFrom && b.time <= pnlTo);
      const points = pnlBars.map(b => ({
        time: b.time,
        value: exitChartTime > 0 && b.time > exitChartTime ? realizedPnl : side * (b.close - avgPrice) * qty,
      }));
      legPnlData.set(leg.refId, points);
      for (const pt of points) {
        if (!pnlByTime.has(pt.time)) pnlByTime.set(pt.time, new Map());
        pnlByTime.get(pt.time)!.set(leg.refId, pt.value);
      }
    }
  }

  const basketPnlData: Pt[] = [];
  if (pnlByTime.size > 0) {
    for (const t of [...pnlByTime.keys()].sort((a, b) => a - b)) {
      let total = 0;
      for (const v of pnlByTime.get(t)!.values()) total += v;
      basketPnlData.push({ time: t, value: total });
    }
  }

  // Historical greeks for option legs (one call), mirrors the client.
  const legGreeksHist = new Map<number, GreekPt[]>();
  const greekSymbols = legs.filter(l => l.derivativeType === 'OPT').map(l => l.zanskarName);
  if (greekSymbols.length > 0) {
    try {
      const gData = await fetchTs({
        query: [{
          exchange: 'NSE', type: 'OPT', values: greekSymbols, fields: ['delta', 'gamma', 'theta', 'vega'],
          startDate: startDate.toISOString(), endDate: endDate.toISOString(),
          interval: '1m', intraDay: false, realTime: false,
        }],
      });
      const result = (gData as { result?: Array<{ values?: Array<Record<string, Record<string, Array<{ ts: number | string; v: number }>>>> }> }).result;
      for (const group of result || []) {
        for (const symbolMap of group.values || []) {
          for (const [symName, fields] of Object.entries(symbolMap)) {
            const leg = legs.find(l => l.zanskarName === symName);
            if (!leg || !fields.delta?.length) continue;
            const dArr = fields.delta || [], gArr = fields.gamma || [], tArr = fields.theta || [], vArr = fields.vega || [];
            const points: GreekPt[] = [];
            for (let i = 0; i < dArr.length; i++) {
              const t = Number(BigInt(String(dArr[i].ts)) / 1_000_000_000n) + IST_OFFSET;
              if (t < sessionOpen || t > sessionClose) continue;
              points.push({ time: t, delta: dArr[i].v, gamma: gArr[i]?.v || 0, theta: tArr[i]?.v || 0, vega: vArr[i]?.v || 0 });
            }
            if (points.length > 0) legGreeksHist.set(leg.refId, points);
          }
        }
      }
    } catch { /* greeks optional */ }
  }

  if (underlyingBars.length === 0 && legPriceData.size === 0) return null;

  const totalPnl = basketPnlData.length > 0 ? basketPnlData[basketPnlData.length - 1].value * 100 : 0; // → paise
  const data: SnapshotData = {
    version: 1,
    underlying,
    positions: allPositions.filter(p => p.qty !== 0),
    closedPositions: allPositions.filter(p => p.qty === 0),
    chart: {
      underlyingBars,
      legPriceData: [...legPriceData.entries()],
      legPnlData: [...legPnlData.entries()],
      basketPnlData,
      legGreeksHist: [...legGreeksHist.entries()],
      pnlFrom, pnlTo, sessionOpen, sessionClose,
    },
  };
  return { underlying, tradeDate: istDateString(earliestNs), data, totalPnl, legCount: legs.length };
}
