import { REPORT_SETS, REPORT_GROUP_CUTS } from './explorerSetsConfig.ts';
import { DEFAULT_TRADE_PARAMS, simulateSignalTrade, type OhlcSource } from './trade.ts';
import { minuteIndex, hhmmAt, type DaySeries } from '../analysis/daySeries.ts';
import type { SignalBacktestRow } from './routes.ts';

export interface ExplorerComparison {
  key: string;
  label: string;
  ceStrike: number | null;
  peStrike: number | null;
  cePrice: number | null;
  pePrice: number | null;
  premium: number;
  maxLoss: number;
  maxLossTime: string;
  pnl: number;
}

/** Recompute trade-dependent report groups for the newly selected pair. */
export function classifyExplorerSets(
  rows: Array<SignalBacktestRow & { groups?: Record<string, unknown> }>,
  underlying: string,
) {
  const med = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
  };
  const loss = (r: SignalBacktestRow) =>
    Math.max(0, r.trade.stop?.trade.steps.at(-1)?.[1] ?? -r.trade.maxLoss);
  const cuts = REPORT_GROUP_CUTS[underlying as keyof typeof REPORT_GROUP_CUTS];
  const lines = new Map<number, number>();
  for (const d of new Set(rows.map((r) => r.dte)))
    if (d != null) lines.set(d, med(rows.filter((r) => r.dte === d).map(loss)));
  const recent = new Map<number, number[]>();
  let previous: number | null = null;
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const t = r.trade,
      steps = t.stop?.trade.steps ?? [],
      ml = loss(r);
    const last = steps.at(-1),
      half = steps.find((s) => s[1] >= ml / 2);
    const legLoss = (kind: string) =>
      t.stop?.legs[t.legs.findIndex((l) => l.kind === kind)]?.steps.at(-1)?.[1] ?? 0;
    const d = String(r.dte);
    const w = (
      cuts.warnings as Record<string, { iv: number; gap: number; prev: number; move: number }>
    )[d];
    const history = recent.get(r.dte!) ?? [];
    const g = r.signal.greeks?.t2;
    const iv = g?.CE && g?.PE ? (g.CE.iv + g.PE.iv) / 2 : null;
    const line = lines.get(r.dte!);
    r.groups = {
      ...r.groups,
      speed: ml > 0 && last && half ? last[0] - half[0] : null,
      leg: ml > 0 ? (legLoss('CE') >= legLoss('PE') ? 'C' : 'P') : null,
      bigDipLine: line ?? null,
      lossGroup: line == null ? null : (ml >= line ? 2 : 0) + (t.pnl > 0 ? 0 : 1),
      warn: w
        ? (iv != null && history.length >= 4 && iv / med(history.slice(-8)) > w.iv ? 1 : 0) |
          (r.signal.gap > w.gap ? 2 : 0) |
          (previous != null && previous > w.prev ? 4 : 0) |
          (Math.abs(r.signal.spot2 / r.signal.legs.entrySpot - 1) * 100 > w.move ? 8 : 0)
        : null,
    };
    previous = ml;
    if (iv != null && iv > 0) {
      history.push(iv);
      recent.set(r.dte!, history);
    }
  }
}
export const explorerSetOptions = (underlying: string) => {
  const bands = new Set<string>();
  for (const combos of Object.values(REPORT_SETS[underlying as keyof typeof REPORT_SETS])) {
    for (const c of combos) if (c.kind === 'band') bands.add(c.key);
  }
  return [
    { key: 'saved', label: 'Saved run · OTM 2' },
    { key: 'worst', label: 'Largest max loss each day · all available sets' },
    ...Array.from({ length: 8 }, (_, n) => ({
      key: `otm${n}`,
      label: n ? `OTM ${n}` : 'ATM / OTM 0',
    })),
    ...[...bands]
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
      .map((key) => ({ key, label: `Price band ${key.slice(4)} · range by expiry` })),
  ];
};

/** Reuses the saved signal; only the sold strikes change. No future data enters strike selection. */
export function explorerDaySets(
  base: SignalBacktestRow,
  day: DaySeries,
  ohlc: OhlcSource | null,
  underlying: string,
  selected: string,
) {
  const config = REPORT_SETS[underlying as keyof typeof REPORT_SETS] as Record<
    string,
    Array<{ key: string; label: string; kind: string; lo: number | null; hi: number | null }>
  >;
  const bands = config[String(base.dte)]?.filter((c) => c.kind === 'band') ?? [];
  const definitions = [
    ...Array.from({ length: 8 }, (_, n) => ({
      key: `otm${n}`,
      label: n ? `OTM ${n}` : 'ATM',
      kind: 'otm',
      lo: null as number | null,
      hi: null as number | null,
    })),
    ...bands,
  ];
  const comparisons: ExplorerComparison[] = [];
  let selectedTrade: SignalBacktestRow['trade'] | null = null;
  let selectedLabel = '';
  let worstTrade: SignalBacktestRow['trade'] | null = null;
  let worst: ExplorerComparison | null = null;
  for (const def of definitions) {
    const params = {
      ...DEFAULT_TRADE_PARAMS,
      lots: 1,
      premiumTiersOnly: false,
      strikeMode: def.kind === 'otm' ? ('OTM' as const) : ('PREMIUM' as const),
      otmSteps: def.kind === 'otm' ? Number(def.key.slice(3)) : 2,
      cePremiumMin: def.lo ?? 0,
      cePremiumMax: def.hi ?? 0,
      pePremiumMin: def.lo ?? 0,
      pePremiumMax: def.hi ?? 0,
    };
    const result = simulateSignalTrade(day, minuteIndex(base.signal.t2), params, ohlc, base.dte);
    if (!result.ok) continue;
    const t = result.trade;
    const ce = t.legs.find((l) => l.kind === 'CE');
    const pe = t.legs.find((l) => l.kind === 'PE');
    const label =
      def.kind === 'otm' ? def.label : `Band ${def.key.slice(4)} · ₹${def.lo}–${def.hi} per leg`;
    const c = {
      key: def.key,
      label,
      ceStrike: ce?.strike ?? null,
      peStrike: pe?.strike ?? null,
      cePrice: ce?.entryPrice ?? null,
      pePrice: pe?.entryPrice ?? null,
      premium: ((ce?.entryPrice ?? 0) + (pe?.entryPrice ?? 0)) * t.qty,
      maxLoss: Math.max(0, -t.maxLoss),
      maxLossTime: t.maxLossTime,
      pnl: t.pnl,
    };
    // Stop-path depths are positive losses, matching Trade Explorer's max-loss measure.
    c.maxLoss = t.stop
      ? Math.max(0, ...t.stop.trade.steps.map((step) => step[1]))
      : Math.max(0, -t.maxLoss);
    if (t.stop?.trade.steps.length)
      c.maxLossTime = hhmmAt(t.stop.trade.steps[t.stop.trade.steps.length - 1][0]);
    t.maxLossTime = c.maxLossTime;
    comparisons.push(c);
    if (!worst || c.maxLoss > worst.maxLoss) {
      worst = c;
      worstTrade = t;
    }
    if (def.key === selected) {
      selectedTrade = t;
      selectedLabel = label;
    }
  }
  if (selected === 'worst') {
    selectedTrade = worstTrade;
    selectedLabel = worst?.label ?? '';
  }
  return { trade: selectedTrade, label: selectedLabel, worst, comparisons };
}
