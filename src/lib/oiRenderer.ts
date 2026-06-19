export type OiLeg = Record<string, unknown>;
export type OiSnap = { ce: OiLeg[]; pe: OiLeg[] };

export function normalizeStrike(sp: number): number {
  return sp > 10000 ? sp / 100 : sp;
}

export type StrikeMap = Record<number, { ceOi: number; peOi: number }>;

export function buildStrikeMap(ceList: OiLeg[], peList: OiLeg[]): StrikeMap {
  const map: StrikeMap = {};
  for (const ce of ceList) {
    const sp = normalizeStrike(Number(ce.sp));
    if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
    map[sp].ceOi += Number(ce.oi ?? ce.open_interest) || 0;
  }
  for (const pe of peList) {
    const sp = normalizeStrike(Number(pe.sp));
    if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
    map[sp].peOi += Number(pe.oi ?? pe.open_interest) || 0;
  }
  return map;
}

export interface DrawOIParams {
  canvas: HTMLCanvasElement;
  containerW: number;
  containerH: number;
  priceToCoordinate: (price: number) => number | null;
  oiChain: OiSnap;
  enabled: boolean;
  widthScale: number;
  showCalls: boolean;
  showPuts: boolean;
  mode: 'oi' | 'oi_change';
  histFetched: boolean;
  historicalMap: Map<string, { ts: number; v: number }[]>;
  symbolMap: { ce: Map<number, string>; pe: Map<number, string> };
  fromMs: number | null;
  toMs: number | null;
  baseline: OiSnap | null;
  toSnap: OiSnap | null;
  deltasOut: Record<number, { ceDelta: number; peDelta: number }>;
  isToday: boolean;
}

const PRICE_SCALE_W = 72;
const BAR_H = 20;

let _lastDrawMaxVal = 1;

function getHistOI(
  historicalMap: Map<string, { ts: number; v: number }[]>,
  name: string,
  targetMs: number | null,
): number {
  const s = historicalMap.get(name);
  if (!s?.length) return 0;
  if (targetMs === null) return s[s.length - 1].v;
  let best = s[0];
  for (const pt of s) { if (pt.ts / 1_000_000 <= targetMs) best = pt; else break; }
  return best?.v ?? 0;
}

function firstHistTs(historicalMap: Map<string, { ts: number; v: number }[]>): number | null {
  for (const series of historicalMap.values()) {
    if (series.length) return series[0].ts / 1_000_000;
  }
  return null;
}

export function drawOI(p: DrawOIParams): void {
  const { canvas, containerW: w, containerH: h, priceToCoordinate } = p;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!p.enabled) return;

  const maxBarW = (w - PRICE_SCALE_W) * 0.35 * p.widthScale;

  if (p.mode === 'oi_change' && p.histFetched) {
    const ceOiBysp = new Map<number, number>();
    for (const c of p.oiChain.ce) ceOiBysp.set(Number(c.sp), Number(c.oi) || 0);
    const peOiBysp = new Map<number, number>();
    for (const pe of p.oiChain.pe) peOiBysp.set(Number(pe.sp), Number(pe.oi) || 0);

    const deltas: Record<number, { ceDelta: number; peDelta: number }> = {};
    const seen = new Set<number>();
    for (const ce of p.oiChain.ce) {
      const sp = Number(ce.sp);
      if (seen.has(sp)) continue;
      seen.add(sp);
      const ceName = p.symbolMap.ce.get(sp) || '';
      const peName = p.symbolMap.pe.get(sp) || '';
      if (!ceName && !peName) continue;
      const defaultFrom = p.fromMs ?? firstHistTs(p.historicalMap);
      const ceBase = getHistOI(p.historicalMap, ceName, defaultFrom);
      const peBase = getHistOI(p.historicalMap, peName, defaultFrom);
      const ceEnd = p.toMs !== null
        ? getHistOI(p.historicalMap, ceName, p.toMs)
        : p.isToday
          ? (ceOiBysp.get(sp) || getHistOI(p.historicalMap, ceName, null))
          : getHistOI(p.historicalMap, ceName, null);
      const peEnd = p.toMs !== null
        ? getHistOI(p.historicalMap, peName, p.toMs)
        : p.isToday
          ? (peOiBysp.get(sp) || getHistOI(p.historicalMap, peName, null))
          : getHistOI(p.historicalMap, peName, null);
      deltas[sp] = { ceDelta: ceEnd - ceBase, peDelta: peEnd - peBase };
    }
    Object.assign(p.deltasOut, deltas);

    let maxAbs = 1;
    for (const d of Object.values(deltas)) {
      const ca = Math.abs(d.ceDelta), pa = Math.abs(d.peDelta);
      if (ca > maxAbs) maxAbs = ca;
      if (pa > maxAbs) maxAbs = pa;
    }
    _lastDrawMaxVal = maxAbs;
    const right = w - PRICE_SCALE_W;

    for (const [spStr, { ceDelta, peDelta }] of Object.entries(deltas)) {
      const strikeRs = Number(spStr) / 100;
      const y = priceToCoordinate(strikeRs);
      if (y == null || y < 2 || y > h - 2) continue;
      if (p.showCalls && ceDelta !== 0) {
        const bw = Math.max(3, Math.min((Math.abs(ceDelta) / maxAbs) * maxBarW, maxBarW));
        ctx.globalAlpha = ceDelta > 0 ? 0.85 : 0.35;
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(right - bw, y - BAR_H / 2, bw, BAR_H / 2);
      }
      if (p.showPuts && peDelta !== 0) {
        const bw = Math.max(3, Math.min((Math.abs(peDelta) / maxAbs) * maxBarW, maxBarW));
        ctx.globalAlpha = peDelta > 0 ? 0.85 : 0.35;
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(right - bw, y, bw, BAR_H / 2);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }

  // absolute OI mode
  let ceList = p.toSnap ? p.toSnap.ce : p.oiChain.ce;
  let peList = p.toSnap ? p.toSnap.pe : p.oiChain.pe;
  if (p.baseline) {
    const ceBase: Record<number, number> = {};
    const peBase: Record<number, number> = {};
    for (const c of p.baseline.ce) ceBase[Number(c.sp)] = Number(c.oi) || 0;
    for (const p_ of p.baseline.pe) peBase[Number(p_.sp)] = Number(p_.oi) || 0;
    ceList = ceList.map(c => ({ ...c, oi: Math.max(0, (Number(c.oi) || 0) - (ceBase[Number(c.sp)] || 0)) }));
    peList = peList.map(pe => ({ ...pe, oi: Math.max(0, (Number(pe.oi) || 0) - (peBase[Number(pe.sp)] || 0)) }));
  }

  const map = buildStrikeMap(ceList, peList);
  let maxOi = 1;
  for (const v of Object.values(map)) {
    if (v.ceOi > maxOi) maxOi = v.ceOi;
    if (v.peOi > maxOi) maxOi = v.peOi;
  }
  _lastDrawMaxVal = maxOi;
  const right = w - PRICE_SCALE_W;

  for (const [strikeStr, { ceOi, peOi }] of Object.entries(map)) {
    const strike = Number(strikeStr);
    const y = priceToCoordinate(strike);
    if (y == null || y < 2 || y > h - 2) continue;
    if (p.showCalls && ceOi > 0) {
      const bw = Math.max(3, Math.min((ceOi / maxOi) * maxBarW, maxBarW));
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(right - bw, y - BAR_H / 2, bw, BAR_H / 2);
    }
    if (p.showPuts && peOi > 0) {
      const bw = Math.max(3, Math.min((peOi / maxOi) * maxBarW, maxBarW));
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(right - bw, y, bw, BAR_H / 2);
    }
  }
  ctx.globalAlpha = 1;
}

export interface HoverHitParams {
  x: number;
  y: number;
  containerW: number;
  widthScale: number;
  oiChain: OiSnap;
  priceToCoordinate: (price: number) => number | null;
  coordinateToPrice: (y: number) => number | null;
  mode: 'oi' | 'oi_change';
  histFetched: boolean;
  deltas: Record<number, { ceDelta: number; peDelta: number }>;
}

export function hitTestOIBar(p: HoverHitParams): { strike: number; ceOi: number; peOi: number } | null {
  const maxBarW = (p.containerW - PRICE_SCALE_W) * 0.35 * p.widthScale;
  const handleX = p.containerW - PRICE_SCALE_W - maxBarW;
  if (p.x < handleX - 5) return null;

  const price = p.coordinateToPrice(p.y);
  if (price == null || price <= 0) return null;

  const isChangeMode = p.mode === 'oi_change' && p.histFetched;
  const strikeMap: StrikeMap = {};

  if (isChangeMode) {
    for (const [spStr, { ceDelta, peDelta }] of Object.entries(p.deltas)) {
      strikeMap[Number(spStr) / 100] = { ceOi: ceDelta, peOi: peDelta };
    }
  } else {
    Object.assign(strikeMap, buildStrikeMap(p.oiChain.ce, p.oiChain.pe));
  }

  const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
  if (strikes.length < 2) return null;

  const nearest = strikes.reduce((prev, curr) =>
    Math.abs(curr - price) < Math.abs(prev - price) ? curr : prev, strikes[0]);
  const interval = strikes[1] - strikes[0];
  if (Math.abs(nearest - price) > interval * 0.65) return null;

  const d = strikeMap[nearest];
  const yStrike = p.priceToCoordinate(nearest);
  if (yStrike == null) return null;

  const right = p.containerW - PRICE_SCALE_W;
  const maxVal = _lastDrawMaxVal;
  const bwCe = Math.max(3, Math.min((Math.abs(d.ceOi) / maxVal) * maxBarW, maxBarW));
  const bwPe = Math.max(3, Math.min((Math.abs(d.peOi) / maxVal) * maxBarW, maxBarW));
  const overCe = d.ceOi !== 0 && p.y >= yStrike - BAR_H / 2 && p.y <= yStrike && p.x >= right - bwCe;
  const overPe = d.peOi !== 0 && p.y >= yStrike && p.y <= yStrike + BAR_H / 2 && p.x >= right - bwPe;

  if (overCe || overPe) return { strike: nearest, ceOi: d.ceOi, peOi: d.peOi };
  return null;
}
