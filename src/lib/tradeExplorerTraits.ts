import { COLUMN_BY_KEY, categoryValues, formatCell, quantile, type DayRow } from './tradeExplorer';
import { mulberry32, type Outcome } from './tradeExplorerSplits';

export interface Prepared {
  rows: DayRow[];
  y: number[];
  n: number;
  half: number;
  canHalves: boolean;
}

export type Spec = { kind: 'ge' | 'lt'; p: number } | { kind: 'eq'; value: string | number };

export interface Cond {
  key: string;
  label: string;
  /** 1 where the row meets the condition (0 when the reading is missing). */
  has: Uint8Array;
  n: number;
  /** How the condition was made, so it can be re-applied to another list of days later. */
  spec: Spec;
}

export type Years =
  | ''
  | 'Same in earlier and later years'
  | 'Earlier years only'
  | 'Later years only'
  | 'Not steady across years';

export interface Trait {
  cond: Cond;
  inGroup: number;
  groupSize: number;
  elsewhere: number;
  elseSize: number;
  diff: number;
  kind: 'unique' | 'lean' | 'weak';
  strong: boolean;
  same: string[];
  years: Years;
  examples: string[];
}

export interface PairTrait extends Trait {
  /** The two conditions the pair is made of (`cond` is their AND). */
  first: Cond;
  second: Cond;
}

/** A candidate after the fold step: the condition plus its figures. */
export interface Kept {
  cond: Cond;
  a: number;
  b: number;
  cov: number;
  other: number;
  diff: number;
  same: string[];
}

export interface LossGroup {
  id: string;
  label: string;
  idx: number[];
  rare: boolean;
}

export interface WorstLine {
  cond: Cond;
  second?: Cond;
  days: number;
  share: number;
  lift: number;
  median: number;
  same: string[];
  years: Years;
  examples: string[];
  worseWith: WorstLine[];
}

const colLabel = (key: string) => COLUMN_BY_KEY.get(key)?.label ?? key;

const median = (v: number[]) => quantile(v, 0.5) ?? 0;

export function prepare(rows: DayRow[], outcome: Outcome): Prepared {
  const kept = rows.filter((r) => {
    const v = r.values[outcome];
    return typeof v === 'number' && Number.isFinite(v);
  });
  kept.sort((a, b) => (a.raw.date < b.raw.date ? -1 : a.raw.date > b.raw.date ? 1 : 0));
  const n = kept.length;
  return {
    rows: kept,
    y: kept.map((r) => r.values[outcome] as number),
    n,
    half: Math.floor(n / 2),
    canHalves: n >= 150,
  };
}

const numericReadings = (p: Prepared, key: string) =>
  p.rows.flatMap((r) => {
    const v = r.values[key];
    return typeof v === 'number' && Number.isFinite(v) ? [v] : [];
  });

/** Rebuild a condition's `has` on any prepared list. */
export function applySpec(p: Prepared, key: string, spec: Spec): Uint8Array {
  const has = new Uint8Array(p.n);
  if (spec.kind === 'eq') {
    for (let i = 0; i < p.n; i++) if (p.rows[i].values[key] === spec.value) has[i] = 1;
    return has;
  }
  const cut = quantile(numericReadings(p, key), spec.p);
  if (cut == null) return has;
  for (let i = 0; i < p.n; i++) {
    const v = p.rows[i].values[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (spec.kind === 'ge' ? v >= cut : v < cut) has[i] = 1;
  }
  return has;
}

const CUT_PS = [0.2, 0.33, 0.5, 0.67, 0.8];

export function conditions(p: Prepared, keys: string[]): Cond[] {
  const out: Cond[] = [];
  const push = (key: string, label: string, spec: Spec) => {
    const has = applySpec(p, key, spec);
    let n = 0;
    for (let i = 0; i < p.n; i++) n += has[i];
    out.push({ key, label, has, n, spec });
  };
  for (const key of keys) {
    const c = COLUMN_BY_KEY.get(key);
    if (!c || c.type === 'text' || c.type === 'date') continue;
    if (c.type === 'cat') {
      for (const v of categoryValues(c, p.rows)) {
        if (v == null) continue;
        push(key, `${c.label}: ${formatCell(c, v)}`, { kind: 'eq', value: v });
      }
      continue;
    }
    const vals = numericReadings(p, key);
    if (vals.length < 8) continue;
    const seen = new Set<number>();
    for (const q of CUT_PS) {
      const cut = quantile(vals, q);
      if (cut == null || seen.has(cut)) continue;
      seen.add(cut);
      const shown = formatCell(c, cut);
      const time = c.type === 'time';
      push(key, `${c.label} ${shown} ${time ? 'or later' : 'or more'}`, { kind: 'ge', p: q });
      push(key, `${c.label} ${time ? 'before' : 'below'} ${shown}`, { kind: 'lt', p: q });
    }
  }
  return out;
}

// ── loss groups ──────────────────────────────────────────────────────────────

export function lossGroups(p: Prepared, line: number, fmt: (v: number) => string): LossGroup[] {
  const { y } = p;
  const above: number[] = [];
  const below: number[] = [];
  for (let i = 0; i < p.n; i++) (y[i] > line ? above : below).push(i);
  const out: LossGroup[] = [
    { id: 'allAbove', label: `All days above ${fmt(line)}`, idx: above, rare: false },
  ];
  const rareCut = quantile(y, 0.95) ?? line;
  const rareIdx = above.filter((i) => y[i] > rareCut);
  const useRare = rareIdx.length >= 8 && rareCut > line;
  const freq = useRare ? above.filter((i) => y[i] <= rareCut) : above;
  const top = useRare ? rareCut : above.length ? Math.max(...above.map((i) => y[i])) : line;
  if (freq.length >= 60) {
    const m = median(freq.map((i) => y[i]));
    out.push({
      id: 'high1',
      label: `${fmt(line)} to ${fmt(m)}`,
      idx: freq.filter((i) => y[i] <= m),
      rare: false,
    });
    out.push({
      id: 'high2',
      label: `${fmt(m)} to ${fmt(top)}`,
      idx: freq.filter((i) => y[i] > m),
      rare: false,
    });
  } else if (useRare && freq.length) {
    out.push({ id: 'high1', label: `${fmt(line)} to ${fmt(top)}`, idx: freq, rare: false });
  }
  if (useRare) out.push({ id: 'rare', label: `Above ${fmt(rareCut)}`, idx: rareIdx, rare: true });
  out.push({ id: 'below', label: `Up to ${fmt(line)}`, idx: below, rare: false });
  return out;
}

// ── traits ───────────────────────────────────────────────────────────────────

function maskOf(p: Prepared, group: LossGroup): Uint8Array {
  const m = new Uint8Array(p.n);
  for (const i of group.idx) m[i] = 1;
  return m;
}

/** a = group rows meeting `has`, b = other rows meeting it. */
function counts(mask: Uint8Array, has: Uint8Array, from = 0, to = mask.length) {
  let a = 0;
  let b = 0;
  for (let i = from; i < to; i++) {
    if (!has[i]) continue;
    if (mask[i]) a++;
    else b++;
  }
  return { a, b };
}

function yearsOf(p: Prepared, mask: Uint8Array, has: Uint8Array, diff: number): Years {
  if (!p.canHalves) return '';
  const holds = (from: number, to: number) => {
    let gs = 0;
    for (let i = from; i < to; i++) gs += mask[i];
    const os = to - from - gs;
    if (gs === 0 || os === 0) return false;
    const { a, b } = counts(mask, has, from, to);
    return a / gs - b / os >= diff / 2;
  };
  const early = holds(0, p.half);
  const late = holds(p.half, p.n);
  if (early && late) return 'Same in earlier and later years';
  if (early) return 'Earlier years only';
  if (late) return 'Later years only';
  return 'Not steady across years';
}

function examplesOf(
  p: Prepared,
  rowsIdx: number[],
  has: Uint8Array,
  target: number,
  limit = 3,
): string[] {
  return rowsIdx
    .filter((i) => has[i])
    .sort((x, z) => Math.abs(p.y[x] - target) - Math.abs(p.y[z] - target))
    .slice(0, limit)
    .map((i) => p.rows[i].raw.date);
}

const overlap = (x: Uint8Array, z: Uint8Array) => {
  let both = 0;
  let either = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const zi = z[i];
    if (xi & zi) both++;
    if (xi | zi) either++;
  }
  return either ? both / either : 0;
};

/** Walk in order; a later condition that picks (nearly) the same days joins an earlier one. */
function fold<T extends { cond: { has: Uint8Array; key: string }; same: string[] }>(
  list: T[],
  limit: number,
): T[] {
  const kept: T[] = [];
  for (const c of list) {
    const host = kept.find((k) => overlap(k.cond.has, c.cond.has) >= 0.7);
    if (host) {
      const name = colLabel(c.cond.key);
      if (name !== colLabel(host.cond.key) && !host.same.includes(name)) host.same.push(name);
      continue;
    }
    if (kept.length < limit) kept.push(c);
  }
  return kept;
}

export function keptFor(p: Prepared, group: LossGroup, conds: Cond[]): Kept[] {
  const gs = group.idx.length;
  const es = p.n - gs;
  if (!gs || !es) return [];
  const mask = maskOf(p, group);
  const cands: Kept[] = [];
  for (const cond of conds) {
    const { a, b } = counts(mask, cond.has);
    const cov = a / gs;
    const other = b / es;
    const diff = cov - other;
    if (cov >= 0.5 && diff > 0) cands.push({ cond, a, b, cov, other, diff, same: [] });
  }
  cands.sort((x, z) => z.diff - x.diff);
  const bestPerKey: Kept[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.cond.key)) continue;
    seen.add(c.cond.key);
    bestPerKey.push(c);
  }
  return fold(bestPerKey, 8);
}

function toTrait(p: Prepared, group: LossGroup, mask: Uint8Array, k: Kept): Trait {
  const gs = group.idx.length;
  const kind = k.diff >= 0.35 && k.other <= 0.35 ? 'unique' : k.diff >= 0.1 ? 'lean' : 'weak';
  const target = median(group.idx.map((i) => p.y[i]));
  return {
    cond: k.cond,
    inGroup: k.a,
    groupSize: gs,
    elsewhere: k.b,
    elseSize: p.n - gs,
    diff: k.diff,
    kind,
    strong: k.diff >= 0.35,
    same: k.same,
    years: yearsOf(p, mask, k.cond.has, k.diff),
    examples: examplesOf(p, group.idx, k.cond.has, target),
  };
}

export function groupTraitSet(
  p: Prepared,
  group: LossGroup,
  conds: Cond[],
): { traits: Trait[]; kept: Kept[] } {
  const kept = keptFor(p, group, conds);
  const mask = maskOf(p, group);
  return { traits: kept.slice(0, 3).map((k) => toTrait(p, group, mask, k)), kept };
}

export function groupTraits(p: Prepared, group: LossGroup, conds: Cond[]): Trait[] {
  return groupTraitSet(p, group, conds).traits;
}

export function traitChance(p: Prepared, group: LossGroup, conds: Cond[], topDiff: number): number {
  const gs = group.idx.length;
  const n = p.n;
  const es = n - gs;
  if (!gs || !es) return 1;
  const shuffles = n <= 500 ? 200 : 40;
  const rand = mulberry32(12345);
  const mask = new Uint8Array(n);
  for (let i = 0; i < gs; i++) mask[i] = 1;
  const usable = conds.filter((c) => c.n > 0);
  let hits = 0;
  for (let s = 0; s < shuffles; s++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = mask[i];
      mask[i] = mask[j];
      mask[j] = t;
    }
    let best = -Infinity;
    for (let c = 0; c < usable.length; c++) {
      const has = usable[c].has;
      let a = 0;
      for (let i = 0; i < n; i++) a += has[i] & mask[i];
      const cov = a / gs;
      if (cov < 0.5) continue;
      const diff = cov - (usable[c].n - a) / es;
      if (diff > best) best = diff;
    }
    if (best >= topDiff) hits++;
  }
  return hits / shuffles;
}

export function pairTrait(p: Prepared, group: LossGroup, kept: Kept[]): PairTrait | null {
  if (p.n < 300) return null;
  const gs = group.idx.length;
  const es = p.n - gs;
  if (!gs || !es || !kept.length) return null;
  const mask = maskOf(p, group);
  const list = kept.slice(0, 8);
  let best: { x: Kept; z: Kept; has: Uint8Array; a: number; b: number; diff: number } | null = null;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].cond.key === list[j].cond.key) continue;
      const has = new Uint8Array(p.n);
      let a = 0;
      let b = 0;
      for (let r = 0; r < p.n; r++) {
        if (list[i].cond.has[r] & list[j].cond.has[r]) {
          has[r] = 1;
          if (mask[r]) a++;
          else b++;
        }
      }
      if (a / gs < 0.5) continue;
      const diff = a / gs - b / es;
      if (!best || diff > best.diff) best = { x: list[i], z: list[j], has, a, b, diff };
    }
  }
  if (!best) return null;
  const cov = best.a / gs;
  if (cov < 0.5 || best.diff < list[0].diff + 0.1) return null;
  const years = yearsOf(p, mask, best.has, best.diff);
  if (years !== 'Same in earlier and later years') return null;
  const other = best.b / es;
  let n = 0;
  for (let r = 0; r < p.n; r++) n += best.has[r];
  const cond: Cond = {
    key: best.x.cond.key,
    label: `${best.x.cond.label} and ${best.z.cond.label}`,
    has: best.has,
    n,
    spec: best.x.cond.spec,
  };
  const target = median(group.idx.map((i) => p.y[i]));
  return {
    cond,
    first: best.x.cond,
    second: best.z.cond,
    inGroup: best.a,
    groupSize: gs,
    elsewhere: best.b,
    elseSize: es,
    diff: best.diff,
    kind: best.diff >= 0.35 && other <= 0.35 ? 'unique' : best.diff >= 0.1 ? 'lean' : 'weak',
    strong: best.diff >= 0.35,
    same: [],
    years,
    examples: examplesOf(p, group.idx, best.has, target),
  };
}

// ── could it be seen at the signal? ──────────────────────────────────────────

export interface Trace {
  cond: Cond;
  withRate: number;
  withoutRate: number;
  days: number;
  sure: boolean;
}

export function traceBack(p: Prepared, dayCond: Cond, entryConds: Cond[]): Trace | null {
  const n = p.n;
  const minN = Math.max(15, Math.floor(0.15 * n));
  const day = dayCond.has;
  const gapIn = (e: Uint8Array, from: number, to: number) => {
    let withN = 0;
    let withDay = 0;
    let outN = 0;
    let outDay = 0;
    for (let i = from; i < to; i++) {
      if (e[i]) {
        withN++;
        withDay += day[i];
      } else {
        outN++;
        outDay += day[i];
      }
    }
    if (!withN || !outN) return { gap: 0, w: 0, o: 0, withN };
    return { gap: withDay / withN - outDay / outN, w: withDay / withN, o: outDay / outN, withN };
  };
  let best: { cond: Cond; gap: number; w: number; o: number } | null = null;
  for (const e of entryConds) {
    if (e.n < minN || n - e.n < minN) continue;
    const g = gapIn(e.has, 0, n);
    if (!best || g.gap > best.gap) best = { cond: e, gap: g.gap, w: g.w, o: g.o };
  }
  if (!best) return null;
  const result = (sure: boolean): Trace => ({
    cond: best.cond,
    withRate: best.w,
    withoutRate: best.o,
    days: best.cond.n,
    sure,
  });
  if (p.canHalves) {
    if (best.gap < 0.15) return null;
    const early = gapIn(best.cond.has, 0, p.half).gap;
    const late = gapIn(best.cond.has, p.half, n).gap;
    if (early < best.gap / 2 || late < best.gap / 2) return null;
    return result(true);
  }
  return best.gap >= 0.25 ? result(false) : null;
}

// ── worst criteria ───────────────────────────────────────────────────────────

function aboveFlags(p: Prepared, line: number) {
  const above = new Uint8Array(p.n);
  let total = 0;
  for (let i = 0; i < p.n; i++) {
    if (p.y[i] > line) {
      above[i] = 1;
      total++;
    }
  }
  return { above, total };
}

function lineYears(
  p: Prepared,
  above: Uint8Array,
  has: Uint8Array,
  share: number,
  base: number,
): Years {
  if (!p.canHalves) return '';
  const need = (share - base) / 2;
  const holds = (from: number, to: number) => {
    let rows = 0;
    let rowsAbove = 0;
    let allAbove = 0;
    for (let i = from; i < to; i++) {
      allAbove += above[i];
      if (has[i]) {
        rows++;
        rowsAbove += above[i];
      }
    }
    if (rows < 10) return false;
    return rowsAbove / rows - allAbove / (to - from) >= need;
  };
  const early = holds(0, p.half);
  const late = holds(p.half, p.n);
  if (early && late) return 'Same in earlier and later years';
  if (early) return 'Earlier years only';
  if (late) return 'Later years only';
  return 'Not steady across years';
}

const minSingle = (n: number) => Math.max(20, Math.floor(0.08 * n));

export function worstCriteria(
  p: Prepared,
  line: number,
  entryConds: Cond[],
): { base: number; lines: WorstLine[] } | null {
  if (p.n < 60) return null;
  const { n } = p;
  const { above, total } = aboveFlags(p, line);
  const base = total / n;
  const minS = minSingle(n);

  const measure = (has: Uint8Array, cnt: number) => {
    let ab = 0;
    for (let i = 0; i < n; i++) ab += has[i] & above[i];
    const share = ab / cnt;
    const outShare = n - cnt ? (total - ab) / (n - cnt) : 0;
    return { share, lift: share - outShare };
  };

  const cands: Array<{ cond: Cond; share: number; lift: number; same: string[] }> = [];
  for (const cond of entryConds) {
    if (cond.n < minS || n - cond.n < minS) continue;
    const m = measure(cond.has, cond.n);
    if (m.lift > 0) cands.push({ cond, ...m, same: [] });
  }
  cands.sort((x, z) => z.lift - x.lift);
  const seen = new Set<string>();
  const perKey = cands.filter((c) => {
    if (seen.has(c.cond.key)) return false;
    seen.add(c.cond.key);
    return true;
  });
  const singles = fold(perKey, 6);

  const dayY = (has: Uint8Array) => {
    const v: number[] = [];
    for (let i = 0; i < n; i++) if (has[i]) v.push(p.y[i]);
    return v;
  };
  const aboveIdx: number[] = [];
  for (let i = 0; i < n; i++) if (above[i]) aboveIdx.push(i);

  const lines: WorstLine[] = singles.map((s) => {
    const med = median(dayY(s.cond.has));
    const line1: WorstLine = {
      cond: s.cond,
      days: s.cond.n,
      share: s.share,
      lift: s.lift,
      median: med,
      same: s.same,
      years: lineYears(p, above, s.cond.has, s.share, base),
      examples: examplesOf(p, aboveIdx, s.cond.has, med),
      worseWith: [],
    };
    if (p.n >= 300) line1.worseWith = worseWith(s);
    return line1;
  });

  function worseWith(s: { cond: Cond; share: number }): WorstLine[] {
    const minDays = Math.max(20, Math.floor(0.04 * n));
    const out: Array<{
      cond: { has: Uint8Array; key: string };
      second: Cond;
      days: number;
      share: number;
      lift: number;
      same: string[];
    }> = [];
    for (const e of entryConds) {
      if (e.key === s.cond.key) continue;
      const has = new Uint8Array(n);
      let days = 0;
      for (let i = 0; i < n; i++) {
        if (s.cond.has[i] & e.has[i]) {
          has[i] = 1;
          days++;
        }
      }
      if (days < minDays || days > 0.8 * s.cond.n) continue;
      const m = measure(has, days);
      if (m.share < s.share + 0.05) continue;
      if (lineYears(p, above, has, m.share, base) !== 'Same in earlier and later years') continue;
      out.push({ cond: { has, key: e.key }, second: e, days, ...m, same: [] });
    }
    out.sort((x, z) => z.share - x.share);
    const keys = new Set<string>();
    const perSecond = out.filter((c) => {
      if (keys.has(c.second.key)) return false;
      keys.add(c.second.key);
      return true;
    });
    return fold(perSecond, 3).map((c) => {
      const med = median(dayY(c.cond.has));
      return {
        cond: s.cond,
        second: c.second,
        days: c.days,
        share: c.share,
        lift: c.lift,
        median: med,
        same: c.same,
        years: 'Same in earlier and later years' as const,
        examples: examplesOf(p, aboveIdx, c.cond.has, med),
        worseWith: [],
      };
    });
  }

  return { base, lines };
}

export function worstChance(
  p: Prepared,
  line: number,
  entryConds: Cond[],
  topLift: number,
): number {
  const { n } = p;
  const { above, total } = aboveFlags(p, line);
  const minS = minSingle(n);
  const usable = entryConds.filter((c) => c.n >= minS && n - c.n >= minS);
  if (!usable.length || !total || total === n) return 1;
  const flags = Uint8Array.from(above);
  const rand = mulberry32(54321);
  const shuffles = 200;
  let hits = 0;
  for (let s = 0; s < shuffles; s++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = flags[i];
      flags[i] = flags[j];
      flags[j] = t;
    }
    let best = -Infinity;
    for (let c = 0; c < usable.length; c++) {
      const has = usable[c].has;
      let ab = 0;
      for (let i = 0; i < n; i++) ab += has[i] & flags[i];
      const cnt = usable[c].n;
      const lift = ab / cnt - (total - ab) / (n - cnt);
      if (lift > best) best = lift;
    }
    if (best >= topLift) hits++;
  }
  return hits / shuffles;
}
