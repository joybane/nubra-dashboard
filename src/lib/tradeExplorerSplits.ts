import {
  COLUMN_BY_KEY,
  bucketRows,
  categoryValues,
  formatCell,
  numbers,
  quantile,
  spread,
  type Bucket,
  type CellValue,
  type Column,
  type DayRow,
} from './tradeExplorer';

/**
 * Readings known when the trade is placed. Only these may explain a split by default.
 * The order matters: when several readings pick the same days, the earliest one here is shown.
 */
export const ENTRY_KEYS = [
  'dte',
  'ivLevel',
  'warnGroup',
  'weekday',
  'same',
  'ivRatio',
  'gap',
  'gapPct',
  'ceChange',
  'peChange',
  'both',
  'morning',
  't1',
  't2',
  'wait',
  'premium',
  'ivNow',
  'ivUsual',
  'ceIv',
  'peIv',
  'skew',
  'prevMaxLoss',
  'deltaLean',
  'theta',
  'vega',
];
/** How the day went. Shown only when the user asks; they explain a loss but cannot predict it. */
export const AFTER_KEYS = [
  'maxLossAt',
  'toMaxLoss',
  'range',
  'move',
  'touched',
  'path',
  'moveFifth',
  'direction',
  'speedGroup',
  'speedMin',
  'losingLeg',
  'bestProfit',
];
export type Outcome = 'maxLoss' | 'maxLossPct';
/** Category columns whose values have a real order, so "this value and everything after it" is a fair cut. */
const ORDERED = ['dte', 'ivLevel'];

export interface Split {
  key: string;
  /** e.g. "IV ratio 1.24 or more" */
  worseLabel: string;
  /** e.g. "IV ratio below 1.24" */
  betterLabel: string;
  worse: DayRow[];
  better: DayRow[];
  /** Days with no reading on this column. */
  blank: number;
  /** Always ≥ 0: gap between the two medians, in outcome spreads. */
  score: number;
  /** 0–1, filled by `splitChances`; null = not checked yet. */
  chance: number | null;
  /** Labels of other columns that pick nearly the same days. */
  same: string[];
}

// ── numeric helpers ──────────────────────────────────────────────────────────

/** Moves the k-th smallest of a[0..n) into a[k], with everything before it no larger. */
function select(a: Float64Array, n: number, k: number): void {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const p = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

function medianOf(buf: Float64Array, n: number): number {
  const k = n >> 1;
  select(buf, n, k);
  if (n & 1) return buf[k];
  let m = -Infinity;
  for (let i = 0; i < k; i++) if (buf[i] > m) m = buf[i];
  return (m + buf[k]) / 2;
}

function spreadOf(values: number[]): number {
  if (values.length < 2) return 1;
  const iqr = (quantile(values, 0.75) as number) - (quantile(values, 0.25) as number);
  if (iqr > 0) return iqr;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 0 ? hi - lo : 1;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── candidates ───────────────────────────────────────────────────────────────

interface Cand {
  a: number[];
  b: number[];
  aLabel: string;
  bLabel: string;
}

interface Prepared {
  valid: DayRow[];
  y: Float64Array;
  spread: number;
  minSide: number;
}

function prepare(rows: DayRow[], outcome: Outcome, outcomeValues?: Map<DayRow, number>): Prepared {
  const valid: DayRow[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const v = outcomeValues ? outcomeValues.get(r) : r.values[outcome];
    if (typeof v === 'number' && Number.isFinite(v)) {
      valid.push(r);
      ys.push(v);
    }
  }
  return {
    valid,
    y: Float64Array.from(ys),
    spread: spreadOf(ys),
    minSide: Math.max(8, Math.floor(0.15 * valid.length)),
  };
}

const hasReading = (c: Column, r: DayRow) => {
  const v = r.values[c.key];
  return c.type === 'num' || c.type === 'time' ? typeof v === 'number' : v != null && v !== '';
};

function buildCands(c: Column, valid: DayRow[], minSide: number): Cand[] {
  const out: Cand[] = [];
  const push = (cand: Cand) => {
    if (cand.a.length >= minSide && cand.b.length >= minSide) out.push(cand);
  };
  if (c.type === 'num' || c.type === 'time') {
    const vals = numbers(valid, c.key).sort((x, y) => x - y);
    const cuts = new Set<number>();
    for (let p = 2; p <= 8 && vals.length; p++) {
      const i = (vals.length - 1) * (p / 10);
      const lo = Math.floor(i);
      cuts.add(vals[lo] + (vals[Math.ceil(i)] - vals[lo]) * (i - lo));
    }
    for (const cut of cuts) {
      const a: number[] = [];
      const b: number[] = [];
      valid.forEach((r, i) => {
        const v = r.values[c.key];
        if (typeof v !== 'number') return;
        if (v >= cut) a.push(i);
        else b.push(i);
      });
      const shown = formatCell(c, cut);
      push(
        c.type === 'time'
          ? {
              a,
              b,
              aLabel: `${c.label} at ${shown} or later`,
              bLabel: `${c.label} before ${shown}`,
            }
          : { a, b, aLabel: `${c.label} ${shown} or more`, bLabel: `${c.label} below ${shown}` },
      );
    }
  } else if (c.type === 'cat') {
    const values = categoryValues(c, valid).filter((v): v is string | number => v != null);
    const idx = new Map<string | number, number[]>();
    valid.forEach((r, i) => {
      const v = r.values[c.key];
      if (v == null || v === '') return;
      const list = idx.get(v);
      if (list) list.push(i);
      else idx.set(v, [i]);
    });
    const label = (vs: Array<string | number>) => vs.map((v) => formatCell(c, v)).join(', ');
    for (const v of values) {
      const a = idx.get(v) ?? [];
      const b: number[] = [];
      for (const [k, list] of idx) if (k !== v) b.push(...list);
      push({
        a,
        b,
        aLabel: `${c.label}: ${formatCell(c, v)}`,
        bLabel: `${c.label}: any other`,
      });
    }
    if (ORDERED.includes(c.key)) {
      for (let i = 1; i < values.length; i++) {
        const a = values.slice(i).flatMap((v) => idx.get(v) ?? []);
        const b = values.slice(0, i).flatMap((v) => idx.get(v) ?? []);
        push({
          a,
          b,
          aLabel: `${c.label}: ${label(values.slice(i))}`,
          bLabel: `${c.label}: ${label(values.slice(0, i))}`,
        });
      }
    }
  }
  return out;
}

/** Signed gap between the medians of side A and side B, in outcome spreads. */
function candGap(cand: Cand, y: Float64Array, sa: Float64Array, sb: Float64Array, sp: number) {
  for (let i = 0; i < cand.a.length; i++) sa[i] = y[cand.a[i]];
  for (let i = 0; i < cand.b.length; i++) sb[i] = y[cand.b[i]];
  return (medianOf(sa, cand.a.length) - medianOf(sb, cand.b.length)) / sp;
}

// ── best split of one column ─────────────────────────────────────────────────

function bestOf(p: Prepared, key: string): Split | null {
  const c = COLUMN_BY_KEY.get(key);
  if (!c || p.valid.length < 2 * p.minSide) return null;
  const cands = buildCands(c, p.valid, p.minSide);
  if (!cands.length) return null;
  const sa = new Float64Array(p.valid.length);
  const sb = new Float64Array(p.valid.length);
  let best: Cand | null = null;
  let bestGap = 0;
  for (const cand of cands) {
    const g = candGap(cand, p.y, sa, sb, p.spread);
    if (!best || Math.abs(g) > Math.abs(bestGap)) {
      best = cand;
      bestGap = g;
    }
  }
  if (!best) return null;
  const aWorse = bestGap >= 0;
  const A = best.a.map((i) => p.valid[i]);
  const B = best.b.map((i) => p.valid[i]);
  return {
    key,
    worseLabel: aWorse ? best.aLabel : best.bLabel,
    betterLabel: aWorse ? best.bLabel : best.aLabel,
    worse: aWorse ? A : B,
    better: aWorse ? B : A,
    blank: p.valid.length - A.length - B.length,
    score: Math.abs(bestGap),
    chance: null,
    same: [],
  };
}

export function bestSplit(
  rows: DayRow[],
  key: string,
  outcome: Outcome,
  outcomeValues?: Map<DayRow, number>,
): Split | null {
  return bestOf(prepare(rows, outcome, outcomeValues), key);
}

// ── ranking ──────────────────────────────────────────────────────────────────

export function rankSplits(rows: DayRow[], outcome: Outcome, keys: string[] = ENTRY_KEYS): Split[] {
  const all: Split[] = [];
  const prepared = prepare(rows, outcome);
  for (const k of keys) {
    const s = bestOf(prepared, k);
    if (s) all.push(s);
  }
  all.sort((x, y) => y.score - x.score);

  const worseSet = new Map<Split, Set<DayRow>>();
  const setOf = (s: Split) => {
    let w = worseSet.get(s);
    if (!w) worseSet.set(s, (w = new Set(s.worse)));
    return w;
  };
  const kept: Split[] = [];
  for (const s of all) {
    const cs = COLUMN_BY_KEY.get(s.key) as Column;
    let joined = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      const ck = COLUMN_BY_KEY.get(k.key) as Column;
      const wa = setOf(k);
      const wb = setOf(s);
      let both = 0;
      let either = 0;
      for (const r of rows) {
        if (!hasReading(ck, r) || !hasReading(cs, r)) continue;
        const inA = wa.has(r);
        const inB = wb.has(r);
        if (inA && inB) both++;
        if (inA || inB) either++;
      }
      if (either === 0 || both / either < 0.7) continue;
      joined = true;
      if (keys.indexOf(s.key) < keys.indexOf(k.key) && s.score >= 0.9 * k.score) {
        s.same = [...k.same, ck.label];
        kept[i] = s;
      } else {
        k.same.push(cs.label);
      }
      break;
    }
    if (!joined) kept.push(s);
  }
  return kept;
}

// ── chance check ─────────────────────────────────────────────────────────────

export function splitChances(
  rows: DayRow[],
  outcome: Outcome,
  keys: string[],
  splits: Split[],
): { headline: number; perSplit: number[] } {
  const p = prepare(rows, outcome);
  const n = p.valid.length;
  const perKey: Cand[][] = keys.map((k) => {
    const c = COLUMN_BY_KEY.get(k);
    return c && n >= 2 * p.minSide ? buildCands(c, p.valid, p.minSide) : [];
  });
  const shuffles = n <= 500 ? 200 : 40;
  const rand = mulberry32(20260115);
  const y = Float64Array.from(p.y);
  const sa = new Float64Array(n);
  const sb = new Float64Array(n);
  const keyIndex = splits.map((s) => keys.indexOf(s.key));
  const hits = splits.map(() => 0);
  let headHits = 0;
  const topReal = splits.length ? splits[0].score : 0;
  const eps = 1e-12;
  for (let s = 0; s < shuffles; s++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = y[i];
      y[i] = y[j];
      y[j] = t;
    }
    let top = 0;
    const bestByKey = perKey.map((cands) => {
      let m = 0;
      for (const cand of cands) {
        const g = Math.abs(candGap(cand, y, sa, sb, p.spread));
        if (g > m) m = g;
      }
      if (m > top) top = m;
      return m;
    });
    if (top >= topReal - eps) headHits++;
    splits.forEach((sp, i) => {
      if (keyIndex[i] >= 0 && bestByKey[keyIndex[i]] >= sp.score - eps) hits[i]++;
    });
  }
  return { headline: headHits / shuffles, perSplit: hits.map((h) => h / shuffles) };
}

export function chanceWord(chance: number | null): string {
  if (chance == null) return '';
  if (chance < 0.05) return 'Clear';
  if (chance < 0.2) return 'Could be chance';
  return 'Not reliable';
}

// ── split by loss size ───────────────────────────────────────────────────────

export interface BandCell {
  /** Median for number/time columns; most common value for categories. */
  value: CellValue;
  /** Category columns only: that value's share of the group. */
  share: number | null;
}
export interface BandLine {
  key: string;
  label: string;
  column: Column;
  cells: BandCell[];
  gap: number;
}

export function bandCompare(
  rows: DayRow[],
  outcome: Outcome,
  bands: number,
  keys: string[] = ENTRY_KEYS,
): { groups: Bucket[]; lines: BandLine[] } {
  const oc = COLUMN_BY_KEY.get(outcome) as Column;
  const groups = bucketRows(rows, oc, bands).filter((b) => b.id !== 'blank');
  const lines: BandLine[] = [];
  for (const key of keys) {
    const c = COLUMN_BY_KEY.get(key);
    if (!c) continue;
    if (c.type === 'num' || c.type === 'time') {
      const cells = groups.map((g) => ({
        value: quantile(numbers(g.rows, key), 0.5),
        share: null,
      }));
      const first = cells[0]?.value;
      const last = cells[cells.length - 1]?.value;
      const gap =
        groups.length >= 2 && first != null && last != null
          ? (last - first) / spread(rows, key)
          : 0;
      lines.push({ key, label: c.label, column: c, cells, gap });
    } else if (c.type === 'cat') {
      const shares = groups.map((g) => {
        const m = new Map<string | number, number>();
        let total = 0;
        for (const r of g.rows) {
          const v = r.values[key];
          if (v == null || v === '') continue;
          total++;
          m.set(v, (m.get(v) ?? 0) + 1);
        }
        return { m, total };
      });
      const cells = shares.map(({ m, total }) => {
        let top: string | number | null = null;
        let n = 0;
        for (const [v, k] of m) {
          if (k > n) {
            top = v;
            n = k;
          }
        }
        return { value: top, share: total ? n / total : null };
      });
      let gap = 0;
      if (groups.length >= 2) {
        const f = shares[0];
        const l = shares[shares.length - 1];
        const seen = new Set([...f.m.keys(), ...l.m.keys()]);
        for (const v of seen) {
          const d =
            (l.total ? (l.m.get(v) ?? 0) / l.total : 0) -
            (f.total ? (f.m.get(v) ?? 0) / f.total : 0);
          if (Math.abs(d) > Math.abs(gap)) gap = d;
        }
      }
      lines.push({ key, label: c.label, column: c, cells, gap });
    }
  }
  lines.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
  return { groups, lines };
}
