import {
  applyFilters,
  COLUMN_BY_KEY,
  parseBound,
  nearest,
  quantile,
  withSimilarity,
  type DayRow,
  type Filters,
  type SimilarPlan,
} from './tradeExplorer';
import { LOT_SIZE, type SignalUnderlying } from './signalBacktest';
import type { Outcome } from './tradeExplorerSplits';
import {
  applySpec,
  type Cond,
  type LossGroup,
  type Prepared,
  type Trait,
  type WorstLine,
} from './tradeExplorerTraits';

// ── strike distances ─────────────────────────────────────────────────────────

export interface SlimDay {
  maxLoss: number | null;
  maxLossPct: number | null;
  touched: boolean | null;
}
export type SlimSet = Map<string, SlimDay>;

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function slimSet(rows: DayRow[]): SlimSet {
  const out: SlimSet = new Map();
  for (const r of rows) {
    if (finite(r.values.maxLoss) == null && finite(r.values.maxLossPct) == null) continue;
    out.set(r.raw.date, {
      maxLoss: finite(r.values.maxLoss),
      maxLossPct: finite(r.values.maxLossPct),
      touched: r.values.touched == null ? null : r.values.touched === 'Yes',
    });
  }
  return out;
}

export interface SetLine {
  days: number;
  medianLoss: number | null;
  oneInTen: number | null;
  medianPct: number | null;
  usualPct: number | null;
  worseShare: number | null;
  touchedShare: number | null;
}

const present = (v: Array<number | null>) => v.filter((x): x is number => x != null);

export function setLine(dates: ReadonlySet<string>, slim: SlimSet): SetLine {
  const chosen = [...dates].flatMap((d) => {
    const s = slim.get(d);
    return s ? [s] : [];
  });
  const touched = chosen.filter((s) => s.touched != null);
  const loss = present(chosen.map((s) => s.maxLoss));
  const pct = present(chosen.map((s) => s.maxLossPct));
  const usualPct = quantile(present([...slim.values()].map((s) => s.maxLossPct)), 0.5);
  return {
    days: chosen.length,
    medianLoss: quantile(loss, 0.5),
    oneInTen: quantile(loss, 0.9),
    medianPct: quantile(pct, 0.5),
    usualPct,
    touchedShare: touched.length ? touched.filter((s) => s.touched).length / touched.length : null,
    worseShare:
      usualPct == null || !pct.length ? null : pct.filter((v) => v > usualPct).length / pct.length,
  };
}

// ── cross-check on the other index ───────────────────────────────────────────

export interface Cross {
  days: number;
  a: number;
  b: number;
  word: 'Also holds' | 'Does not hold' | 'Too few days';
}

const MIN_CROSS_DAYS = 15;

function andOf(po: Prepared, conds: Cond[]): Uint8Array {
  const parts = conds.map((c) => applySpec(po, c.key, c.spec));
  const has = new Uint8Array(po.n);
  for (let i = 0; i < po.n; i++) has[i] = parts.every((p) => p[i] === 1) ? 1 : 0;
  return has;
}

export function crossWorst(po: Prepared, lineO: number, line: WorstLine, base: number): Cross {
  const has = andOf(po, line.second ? [line.cond, line.second] : [line.cond]);
  let days = 0;
  let above = 0;
  let allAbove = 0;
  for (let i = 0; i < po.n; i++) {
    const up = po.y[i] > lineO ? 1 : 0;
    allAbove += up;
    if (has[i]) {
      days++;
      above += up;
    }
  }
  const a = days ? above / days : 0;
  const b = po.n ? allAbove / po.n : 0;
  const word =
    days < MIN_CROSS_DAYS
      ? 'Too few days'
      : a - b >= (line.share - base) / 2
        ? 'Also holds'
        : 'Does not hold';
  return { days, a, b, word };
}

export function crossTrait(
  po: Prepared,
  groupsO: LossGroup[],
  groupId: string,
  trait: Trait,
): Cross | null {
  const group = groupsO.find((g) => g.id === groupId);
  if (!group) return null;
  const has = applySpec(po, trait.cond.key, trait.cond.spec);
  const inGroup = new Uint8Array(po.n);
  for (const i of group.idx) inGroup[i] = 1;
  let a = 0;
  let b = 0;
  for (let i = 0; i < po.n; i++) {
    if (!has[i]) continue;
    if (inGroup[i]) a++;
    else b++;
  }
  const gs = group.idx.length;
  const es = po.n - gs;
  const aShare = gs ? a / gs : 0;
  const bShare = es ? b / es : 0;
  const word =
    gs < MIN_CROSS_DAYS
      ? 'Too few days'
      : aShare - bShare >= trait.diff / 2
        ? 'Also holds'
        : 'Does not hold';
  return { days: gs, a: aShare, b: bShare, word };
}

// ── saved criteria ───────────────────────────────────────────────────────────

export interface SavedCriteria {
  name: string;
  filters: Filters;
  similar: SimilarPlan | null;
  /** Missing on criteria saved while both indices used a 65-unit signal. */
  signalMoneyBasis?: 'per-lot';
}

const SIGNAL_MONEY_KEYS = ['ceChange', 'peChange', 'both', 'gap'];
const LEGACY_SIGNAL_QTY = 65;
const FILTER_SETTINGS_VERSION = 1;

function legacySignalFilters(filters: Filters, underlying: SignalUnderlying): Filters {
  const lot = LOT_SIZE[underlying];
  if (lot === LEGACY_SIGNAL_QTY) return filters;
  const next = { ...filters };
  for (const key of SIGNAL_MONEY_KEYS) {
    const filter = filters[key];
    if (!filter) continue;
    const scale = (value: number) => (value * lot) / LEGACY_SIGNAL_QTY;
    const bound = (value: string) => {
      const n = /\d/.test(value) ? parseBound(COLUMN_BY_KEY.get(key)!, value) : null;
      return n == null ? value : String(scale(n));
    };
    next[key] = {
      ...filter,
      ...(typeof filter.min === 'string' && { min: bound(filter.min) }),
      ...(typeof filter.max === 'string' && { max: bound(filter.max) }),
      ...(filter.values && {
        values: filter.values.map((v) => (typeof v === 'number' ? scale(v) : v)),
      }),
    };
  }
  return next;
}

/** Active filters become literal per-lot bounds when an older settings record is loaded. */
export function migrateActiveFilters(
  filters: Filters,
  underlying: SignalUnderlying,
  version?: number,
): { filters: Filters; filterSettingsVersion: number } {
  return version != null && version >= FILTER_SETTINGS_VERSION
    ? { filters, filterSettingsVersion: version }
    : {
        filters: legacySignalFilters(filters, underlying),
        filterSettingsVersion: FILTER_SETTINGS_VERSION,
      };
}

export function criteriaFilters(c: SavedCriteria, underlying: SignalUnderlying): Filters {
  return c.signalMoneyBasis === 'per-lot' ? c.filters : legacySignalFilters(c.filters, underlying);
}

export function applyCriteria(
  days: DayRow[],
  c: SavedCriteria,
  underlying: SignalUnderlying,
): DayRow[] {
  return applyFilters(
    c.similar ? nearest(withSimilarity(days, c.similar), c.similar.keep) : days,
    criteriaFilters(c, underlying),
  );
}

export interface LadderCol {
  days: number;
  median: number | null;
  oneInTen: number | null;
  worst: number | null;
  aboveLine: number | null;
  bands: number[];
}

/** Band i = cuts[i-1] < value <= cuts[i]; the first has no lower bound, the last no upper bound. */
export function ladder(rows: DayRow[], outcome: Outcome, line: number, cuts: number[]): LadderCol {
  const v = present(rows.map((r) => finite(r.values[outcome])));
  const bands = new Array<number>(cuts.length + 1).fill(0);
  for (const x of v) {
    let i = 0;
    while (i < cuts.length && x > cuts[i]) i++;
    bands[i]++;
  }
  return {
    days: v.length,
    median: quantile(v, 0.5),
    oneInTen: quantile(v, 0.9),
    worst: v.length ? Math.max(...v) : null,
    aboveLine: v.length ? v.filter((x) => x > line).length / v.length : null,
    bands,
  };
}
