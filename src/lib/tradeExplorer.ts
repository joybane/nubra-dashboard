/**
 * The Trade Explorer's data work: one flat row per day out of a saved Signal Backtest run, the
 * columns, per-column filters, grouping and group figures. No React here.
 */
import { ivSignalByDate, IV_LEVELS } from './ivSignal';
import { dteShort, type SignalBacktestRow, type SignalUnderlying } from './signalBacktest';

/** The Strangle Max Loss report's groups for a day, added when the run was saved. */
export interface ReportGroups {
  path: number | null;
  warn: number | null;
  moveFifth: number | null;
  dir: string | null;
  leg: string | null;
  speed: number | null;
  lossGroup: number | null;
  bigDipLine: number | null;
}
/** Legs whose stored prices ran out, priced from the nearest strike's IV, and the figures before that. */
export interface EstimatedLegs {
  legs: Array<{ kind: 'CE' | 'PE'; strike: number; from: string; close: Array<number | null> }>;
  before: { pnl: number; maxLoss: number; exitTime: string };
}
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
export type SavedRow = SignalBacktestRow & {
  groups?: ReportGroups;
  estimated?: EstimatedLegs;
  setLabel?: string;
  worstSet?: string;
  worstLoss?: number;
  comparisons?: ExplorerComparison[];
};

export const LOSS_GROUPS = [
  'Small dip → profit',
  'Small dip → loss',
  'Big dip → recovered to profit',
  'Big dip → loss',
];
export const PATH_TYPES = [
  'Quiet',
  'Medium range, one-way trend',
  'Medium range, partly back',
  'Medium range, out and back',
  'Big range, one-way trend',
  'Big range, partly back',
  'Big range, out and back',
];
export const WARNING_SIGNS = [
  'IV high for now',
  'Big signal gap',
  'Bad previous day',
  'Big morning move',
];
const WARN_GROUPS = ['IV high for now', 'Other warning signs only', 'Calm (no warning sign)'];
const MOVE_FIFTHS = ['Smallest fifth', '2nd fifth', '3rd fifth', '4th fifth', 'Largest fifth'];
const DIRECTIONS = ['Quiet day', 'Spot went furthest up', 'Spot went furthest down'];
const SPEEDS = ['Fast', 'Middle', 'Slow'];
const LEGS = ['Call', 'Put'];

/** The report's ready-made groupings, in the order its sections show them. */
export const REPORT_GROUPS: Array<{ key: string; label: string }> = [
  { key: 'dte', label: 'Day to expiry' },
  { key: 'lossGroup', label: 'Loss group' },
  { key: 'ivLevel', label: 'IV level' },
  { key: 'path', label: 'Path type' },
  { key: 'touched', label: 'Strike touched' },
  { key: 'warnGroup', label: 'Warning signs' },
  { key: 'year', label: 'Year' },
  { key: 'moveFifth', label: 'Move vs IV' },
  { key: 'direction', label: 'Direction' },
  { key: 'speedGroup', label: 'Speed' },
  { key: 'losingLeg', label: 'Losing leg' },
];

export type CellValue = number | string | null;

export interface DayRow {
  raw: SavedRow;
  values: Record<string, CellValue>;
}

export type ColumnType = 'num' | 'time' | 'date' | 'cat' | 'text';

export interface Column {
  key: string;
  label: string;
  /** Full meaning, for the header tooltip and the column picker. */
  title: string;
  section: string;
  type: ColumnType;
  width: number;
  digits?: number;
  unit?: 'rupee' | 'pct';
  /** Colour by sign. */
  signed?: boolean;
  /** A label that happens to be a number (a strike): no group figure. */
  noFigure?: boolean;
  shown?: boolean;
  /** Category values in their natural order; absent = sorted from the data. */
  order?: Array<string | number>;
  name?: (v: string | number) => string;
}

const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const YES_NO = ['Yes', 'No'];

export const COLUMNS: Column[] = [
  // Date comes first and stays pinned.
  {
    key: 'date',
    label: 'Date',
    title: 'Trading day',
    section: 'Day',
    type: 'date',
    width: 118,
    shown: true,
  },
  {
    key: 'dte',
    label: 'Day',
    title: 'Trading days to expiry',
    section: 'Day',
    type: 'cat',
    width: 76,
    shown: true,
    order: [0, 1, 2, 3, 4, 5],
    name: (v) => dteShort(Number(v)),
  },
  {
    key: 'weekday',
    label: 'Weekday',
    title: 'Weekday',
    section: 'Day',
    type: 'cat',
    width: 76,
    order: WEEKDAY_ORDER,
  },
  { key: 'year', label: 'Year', title: 'Year', section: 'Day', type: 'cat', width: 70 },
  { key: 'month', label: 'Month', title: 'Month', section: 'Day', type: 'cat', width: 84 },
  {
    key: 'source',
    label: 'Data',
    title: "Where the day's prices came from",
    section: 'Day',
    type: 'cat',
    width: 70,
  },

  {
    key: 't1',
    label: 't1',
    title: 'First matching moment',
    section: 'Signal',
    type: 'time',
    width: 74,
    shown: true,
  },
  {
    key: 't2',
    label: 'Signal',
    title: 'Second matching moment, when the signal fires (t2)',
    section: 'Signal',
    type: 'time',
    width: 74,
    shown: true,
  },
  {
    key: 'wait',
    label: 't1→t2 min',
    title: 'Minutes between the two matching moments',
    section: 'Signal',
    type: 'num',
    width: 78,
    digits: 0,
  },
  {
    key: 'morning',
    label: 'Morning %',
    title: 'Spot move from 09:15 to the signal',
    section: 'Signal',
    type: 'num',
    width: 82,
    digits: 2,
    unit: 'pct',
    signed: true,
  },
  {
    key: 'ceChange',
    label: 'Call t1→t2',
    title: "Seller's change on the 09:15 call between t1 and t2, ₹ per lot",
    section: 'Signal',
    type: 'num',
    width: 86,
    digits: 0,
    unit: 'rupee',
    signed: true,
    shown: true,
  },
  {
    key: 'peChange',
    label: 'Put t1→t2',
    title: "Seller's change on the 09:15 put between t1 and t2, ₹ per lot",
    section: 'Signal',
    type: 'num',
    width: 86,
    digits: 0,
    unit: 'rupee',
    signed: true,
    shown: true,
  },
  {
    key: 'both',
    label: 'Both t1→t2',
    title: 'Both legs together between t1 and t2, ₹ per lot',
    section: 'Signal',
    type: 'num',
    width: 86,
    digits: 0,
    unit: 'rupee',
    signed: true,
  },
  {
    key: 'gap',
    label: 'Mismatch ₹',
    title: 'How far the call and put changes disagreed, ₹ per lot',
    section: 'Signal',
    type: 'num',
    width: 88,
    digits: 0,
    unit: 'rupee',
    shown: true,
  },
  {
    key: 'gapPct',
    label: 'Mismatch %',
    title: 'Mismatch as a share of the bigger leg (the rule needs at least 50%)',
    section: 'Signal',
    type: 'num',
    width: 88,
    digits: 0,
    unit: 'pct',
    shown: true,
  },

  {
    key: 'ceIv',
    label: 'Call IV',
    title: 'IV of the 09:15 call at the signal',
    section: 'IV signal',
    type: 'num',
    width: 70,
    digits: 2,
  },
  {
    key: 'peIv',
    label: 'Put IV',
    title: 'IV of the 09:15 put at the signal',
    section: 'IV signal',
    type: 'num',
    width: 70,
    digits: 2,
  },
  {
    key: 'skew',
    label: 'Put−call IV',
    title: 'Put IV minus call IV, points',
    section: 'IV signal',
    type: 'num',
    width: 84,
    digits: 2,
    signed: true,
  },
  {
    key: 'ivNow',
    label: 'IV now',
    title: 'Average of the call and put IV at the signal',
    section: 'IV signal',
    type: 'num',
    width: 72,
    digits: 2,
    shown: true,
  },
  {
    key: 'ivUsual',
    label: 'Usual IV',
    title: 'Median of the last 20 readings on the same days to expiry',
    section: 'IV signal',
    type: 'num',
    width: 74,
    digits: 2,
  },
  {
    key: 'ivRatio',
    label: 'IV ratio',
    title: 'IV now ÷ usual IV',
    section: 'IV signal',
    type: 'num',
    width: 72,
    digits: 2,
    shown: true,
  },
  {
    key: 'ivLevel',
    label: 'IV level',
    title: "The phone app's five levels",
    section: 'IV signal',
    type: 'cat',
    width: 92,
    shown: true,
    order: [...IV_LEVELS],
  },

  {
    key: 'theta',
    label: 'Theta ₹',
    title: 'Theta of both 09:15 legs at the signal, ₹ per lot per day',
    section: 'Greeks',
    type: 'num',
    width: 78,
    digits: 0,
    unit: 'rupee',
    signed: true,
  },
  {
    key: 'vega',
    label: 'Vega ₹',
    title: 'Vega of both 09:15 legs at the signal, ₹ per lot per IV point',
    section: 'Greeks',
    type: 'num',
    width: 74,
    digits: 0,
    unit: 'rupee',
  },
  {
    key: 'deltaLean',
    label: 'Delta lean',
    title: '|call delta + put delta| of the 09:15 legs at the signal',
    section: 'Greeks',
    type: 'num',
    width: 78,
    digits: 2,
  },

  { key: 'entry', label: 'Entry', title: 'Entry time', section: 'Trade', type: 'time', width: 70 },
  {
    key: 'ceSold',
    label: 'Call sold',
    title: 'Call strike sold',
    section: 'Trade',
    type: 'num',
    width: 78,
    digits: 0,
    shown: true,
    noFigure: true,
  },
  {
    key: 'peSold',
    label: 'Put sold',
    title: 'Put strike sold',
    section: 'Trade',
    type: 'num',
    width: 78,
    digits: 0,
    shown: true,
    noFigure: true,
  },
  {
    key: 'same',
    label: 'Same as 09:15',
    title: 'Whether the strikes sold are the 09:15 legs',
    section: 'Trade',
    type: 'cat',
    width: 94,
    order: YES_NO,
  },
  {
    key: 'premium',
    label: 'Premium',
    title: 'Call + put price at entry, ₹ per lot',
    section: 'Trade',
    type: 'num',
    width: 84,
    digits: 0,
    unit: 'rupee',
    shown: true,
  },
  {
    key: 'maxLoss',
    label: 'Max loss',
    title: 'Deepest the trade went during the day, ₹ per lot',
    section: 'Trade',
    type: 'num',
    width: 88,
    digits: 0,
    unit: 'rupee',
    shown: true,
  },
  {
    key: 'maxLossPct',
    label: 'Max loss %',
    title: 'Max loss as a share of the premium',
    section: 'Trade',
    type: 'num',
    width: 84,
    digits: 0,
    unit: 'pct',
  },
  {
    key: 'maxLossAt',
    label: 'Max loss at',
    title: 'Time of the max loss',
    section: 'Trade',
    type: 'time',
    width: 84,
    shown: true,
  },
  {
    key: 'toMaxLoss',
    label: 'Entry→max min',
    title: 'Minutes from entry to the max loss',
    section: 'Trade',
    type: 'num',
    width: 96,
    digits: 0,
  },
  {
    key: 'pnl',
    label: '15:29',
    title: 'Result at the 15:29 exit, ₹ per lot',
    section: 'Trade',
    type: 'num',
    width: 84,
    digits: 0,
    unit: 'rupee',
    signed: true,
    shown: true,
  },
  {
    key: 'red',
    label: 'Closed red',
    title: 'Whether the 15:29 result was a loss',
    section: 'Trade',
    type: 'cat',
    width: 82,
    order: YES_NO,
  },

  {
    key: 'range',
    label: 'Range %',
    title: 'Spot high minus low after entry, % of entry spot',
    section: 'After entry',
    type: 'num',
    width: 76,
    digits: 2,
    unit: 'pct',
  },
  {
    key: 'move',
    label: 'Move %',
    title: 'Spot move from entry to exit',
    section: 'After entry',
    type: 'num',
    width: 76,
    digits: 2,
    unit: 'pct',
    signed: true,
  },
  {
    key: 'touched',
    label: 'Touched',
    title: 'Whether spot reached a sold strike after entry',
    section: 'After entry',
    type: 'cat',
    width: 78,
    order: YES_NO,
    shown: true,
  },
  {
    key: 'prevMaxLoss',
    label: 'Prev max loss',
    title: "The previous trading day's max loss, ₹ per lot",
    section: 'After entry',
    type: 'num',
    width: 96,
    digits: 0,
    unit: 'rupee',
  },
];

COLUMNS.push(
  {
    key: 'spot1',
    label: 'Spot t1',
    title: 'Spot at t1',
    section: 'Signal',
    type: 'num',
    width: 84,
    digits: 1,
  },
  {
    key: 'spot2',
    label: 'Spot t2',
    title: 'Spot at t2',
    section: 'Signal',
    type: 'num',
    width: 84,
    digits: 1,
  },
  {
    key: 'ce1',
    label: 'Call at t1',
    title: 'Price of the 09:15 call at t1',
    section: 'Signal',
    type: 'num',
    width: 78,
    digits: 2,
  },
  {
    key: 'ce2',
    label: 'Call at t2',
    title: 'Price of the 09:15 call at t2',
    section: 'Signal',
    type: 'num',
    width: 78,
    digits: 2,
  },
  {
    key: 'pe1',
    label: 'Put at t1',
    title: 'Price of the 09:15 put at t1',
    section: 'Signal',
    type: 'num',
    width: 78,
    digits: 2,
  },
  {
    key: 'pe2',
    label: 'Put at t2',
    title: 'Price of the 09:15 put at t2',
    section: 'Signal',
    type: 'num',
    width: 78,
    digits: 2,
  },
  {
    key: 'exit',
    label: 'Exit',
    title: 'Exit time. Before 15:29 means the prices stopped early',
    section: 'Trade',
    type: 'time',
    width: 66,
  },
  {
    key: 'bestProfit',
    label: 'Best profit',
    title: 'The most the trade was in profit during the day, ₹ per lot',
    section: 'Trade',
    type: 'num',
    width: 86,
    digits: 0,
    unit: 'rupee',
  },
  {
    key: 'dataEnd',
    label: 'Prices',
    title: 'Whether a sold leg stopped having prices before the close',
    section: 'Trade',
    type: 'cat',
    width: 92,
    order: ['Full day', 'Estimated'],
  },
  {
    key: 'lossGroup',
    label: 'Loss group',
    title: 'Loss group: big dip means past the typical max loss for that day to expiry',
    section: 'Report groups',
    type: 'cat',
    width: 170,
    shown: true,
    order: LOSS_GROUPS,
  },
  {
    key: 'path',
    label: 'Path type',
    title: 'Path type: how far spot ranged after entry and whether it came back',
    section: 'Report groups',
    type: 'cat',
    width: 170,
    order: PATH_TYPES,
  },
  {
    key: 'warnGroup',
    label: 'Warning',
    title: 'Warning signs group',
    section: 'Report groups',
    type: 'cat',
    width: 150,
    order: WARN_GROUPS,
  },
  {
    key: 'warnings',
    label: 'Warning signs',
    title: 'Which warning signs the day had',
    section: 'Report groups',
    type: 'text',
    width: 200,
  },
  {
    key: 'moveFifth',
    label: 'Move vs IV',
    title: 'Furthest spot move after entry against the move IV priced, in fifths',
    section: 'Report groups',
    type: 'cat',
    width: 104,
    order: MOVE_FIFTHS,
  },
  {
    key: 'direction',
    label: 'Direction',
    title: "Direction of spot's furthest point from entry",
    section: 'Report groups',
    type: 'cat',
    width: 150,
    order: DIRECTIONS,
  },
  {
    key: 'speedGroup',
    label: 'Speed',
    title: 'How fast the max loss came, in thirds of the same day to expiry',
    section: 'Report groups',
    type: 'cat',
    width: 74,
    order: SPEEDS,
  },
  {
    key: 'speedMin',
    label: 'Half→max min',
    title: 'Minutes from first reaching half of the max loss to the max loss',
    section: 'Report groups',
    type: 'num',
    width: 92,
    digits: 0,
  },
  {
    key: 'losingLeg',
    label: 'Losing leg',
    title: 'The leg that lost most',
    section: 'Report groups',
    type: 'cat',
    width: 78,
    order: LEGS,
  },
);

COLUMNS.push(
  {
    key: 'tradeSet',
    label: 'Trade set',
    title: 'Selected trade set',
    section: 'Trade',
    type: 'cat',
    width: 180,
  },
  {
    key: 'ceEntry',
    label: 'Call sale ₹',
    title: 'Call price sold, per option unit',
    digits: 2,
    unit: 'rupee',
    section: 'Trade',
    type: 'num',
    width: 90,
  },
  {
    key: 'peEntry',
    label: 'Put sale ₹',
    title: 'Put price sold, per option unit',
    digits: 2,
    unit: 'rupee',
    section: 'Trade',
    type: 'num',
    width: 90,
  },
  {
    key: 'worstSet',
    label: 'Worst set',
    title: 'Set with the largest max loss on this day, among available pairs',
    section: 'Trade',
    type: 'cat',
    width: 210,
  },
  {
    key: 'worstLoss',
    label: 'Worst-set loss',
    title: 'Largest max loss across available sets, ₹ per lot',
    unit: 'rupee',
    section: 'Trade',
    type: 'num',
    width: 110,
  },
);
export const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));
export const DEFAULT_COLUMN_KEYS = COLUMNS.filter((c) => c.shown).map((c) => c.key);

const ratioPct = (top: number, bottom: number) => (bottom > 0 ? (top / bottom) * 100 : null);
const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

/** A clock time stored as minutes from midnight. */
function clock(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export function formatClock(minutes: number): string {
  const t = Math.round(minutes);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function maxLossOf(r: SignalBacktestRow): number {
  const steps = r.trade.stop?.trade.steps;
  return Math.max(0, steps?.length ? steps[steps.length - 1][1] : -r.trade.maxLoss);
}

function speedBounds(rows: SavedRow[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  for (const dte of new Set(rows.map((r) => r.dte))) {
    if (dte == null) continue;
    const v = rows.flatMap((r) =>
      r.dte === dte && maxLossOf(r) > 0 && r.groups?.speed != null ? [r.groups.speed] : [],
    );
    const a = quantile(v, 1 / 3);
    const b = quantile(v, 2 / 3);
    if (a != null && b != null) out.set(dte, [a, b]);
  }
  return out;
}

export function buildDayRows(rows: SavedRow[], underlying: SignalUnderlying): DayRow[] {
  const iv = ivSignalByDate(rows, underlying);
  const speeds = speedBounds(rows);
  let prevMaxLoss: number | null = null;
  return [...rows]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((raw: SavedRow) => {
      const { signal: s, trade: t, groups: G } = raw;
      const speed = maxLossOf(raw) > 0 ? (G?.speed ?? null) : null;
      const bounds = raw.dte != null ? speeds.get(raw.dte) : undefined;
      const warn = G?.warn ?? null;
      const targetSteps = t.target?.steps;
      const ce = t.legs.find((l) => l.kind === 'CE');
      const pe = t.legs.find((l) => l.kind === 'PE');
      const g = s.greeks?.t2;
      const reading = iv.get(raw.date);
      const lot = t.qty;
      const maxLoss = maxLossOf(raw);
      const premium =
        t.stop?.trade.premium ?? ((ce?.entryPrice ?? 0) + (pe?.entryPrice ?? 0)) * lot;
      const entry = clock(t.entryTime);
      const maxLossAt = maxLoss > 0 ? clock(t.maxLossTime) : null;
      const high = t.spotHigh ?? null;
      const low = t.spotLow ?? null;
      const d = new Date(`${raw.date}T00:00:00Z`);
      const ceG = g?.CE ?? null;
      const peG = g?.PE ?? null;
      const values: Record<string, CellValue> = {
        date: raw.date,
        tradeSet: raw.setLabel ?? (t.otmSteps == null ? 'Premium selection' : `OTM ${t.otmSteps}`),
        ceEntry: ce?.entryPrice ?? null,
        peEntry: pe?.entryPrice ?? null,
        worstSet: raw.worstSet ?? null,
        worstLoss: raw.worstLoss ?? null,
        dte: raw.dte ?? null,
        weekday: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
        year: raw.date.slice(0, 4),
        month: raw.date.slice(0, 7),
        source: raw.source === 'nubra' ? 'Nubra' : 'Local',
        t1: clock(s.t1),
        t2: clock(s.t2),
        wait: (clock(s.t2) ?? 0) - (clock(s.t1) ?? 0),
        morning: s.legs.entrySpot > 0 ? (s.spot2 / s.legs.entrySpot - 1) * 100 : null,
        ceChange: s.ceDelta,
        peChange: s.peDelta,
        both: s.totalDelta,
        gap: s.gap,
        gapPct: ratioPct(s.gap, Math.max(Math.abs(s.ceDelta), Math.abs(s.peDelta))),
        ceIv: ceG?.iv ?? null,
        peIv: peG?.iv ?? null,
        skew: ceG && peG ? peG.iv - ceG.iv : null,
        ivNow: reading?.ivNow ?? null,
        ivHistoryCount: reading?.historyCount ?? 0,
        ivUsual: reading?.usual ?? null,
        ivRatio: reading?.ratio ?? null,
        ivLevel: reading?.level != null ? IV_LEVELS[reading.level] : null,
        theta: ceG && peG ? (ceG.theta + peG.theta) * lot : null,
        vega: ceG && peG ? (ceG.vega + peG.vega) * lot : null,
        deltaLean: ceG && peG ? Math.abs(ceG.delta + peG.delta) : null,
        entry,
        ceSold: ce?.strike ?? null,
        peSold: pe?.strike ?? null,
        same: yesNo(ce?.strike === s.legs.ceStrike && pe?.strike === s.legs.peStrike),
        premium,
        maxLoss,
        maxLossPct: ratioPct(maxLoss, premium),
        maxLossAt,
        toMaxLoss: maxLossAt != null && entry != null ? maxLossAt - entry : null,
        pnl: t.pnl,
        red: yesNo(t.pnl < 0),
        range:
          high != null && low != null && t.entrySpot > 0
            ? ((high - low) / t.entrySpot) * 100
            : null,
        move: t.exitSpot != null && t.entrySpot > 0 ? (t.exitSpot / t.entrySpot - 1) * 100 : null,
        touched: yesNo(
          (high != null && ce != null && high >= ce.strike) ||
            (low != null && pe != null && low <= pe.strike),
        ),
        prevMaxLoss,
        spot1: s.spot1,
        spot2: s.spot2,
        ce1: s.ce1,
        ce2: s.ce2,
        pe1: s.pe1,
        pe2: s.pe2,
        exit: clock(t.exitTime),
        bestProfit: targetSteps?.length
          ? Math.max(0, targetSteps[targetSteps.length - 1][1])
          : null,
        dataEnd: raw.estimated ? 'Estimated' : 'Full day',
        lossGroup: G?.lossGroup != null ? LOSS_GROUPS[G.lossGroup] : null,
        path: G?.path != null ? PATH_TYPES[G.path] : null,
        warnGroup:
          warn == null
            ? null
            : warn === 0
              ? WARN_GROUPS[2]
              : warn & 1
                ? WARN_GROUPS[0]
                : WARN_GROUPS[1],
        warnings:
          warn == null
            ? null
            : warn === 0
              ? 'None'
              : WARNING_SIGNS.filter((_, k) => warn & (1 << k)).join(', '),
        moveFifth: G?.moveFifth != null ? MOVE_FIFTHS[G.moveFifth] : null,
        direction: G?.dir ? DIRECTIONS[['q', 'u', 'd'].indexOf(G.dir)] : null,
        speedGroup:
          speed == null || !bounds
            ? null
            : speed <= bounds[0]
              ? SPEEDS[0]
              : speed <= bounds[1]
                ? SPEEDS[1]
                : SPEEDS[2],
        speedMin: speed,
        losingLeg: G?.leg === 'C' ? 'Call' : G?.leg === 'P' ? 'Put' : null,
      };
      prevMaxLoss = maxLoss;
      return { raw, values };
    });
}

// ── display ──────────────────────────────────────────────────────────────────

export function formatCell(c: Column, v: CellValue): string {
  if (v == null || v === '') return '–';
  if (c.type === 'time') return formatClock(Number(v));
  if (c.type === 'cat') return c.name ? c.name(v) : String(v);
  if (typeof v === 'string') return v;
  const abs = Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: c.digits ?? 0,
    maximumFractionDigits: c.digits ?? 0,
  });
  const sign = v < 0 ? '−' : c.signed && v > 0 ? '+' : '';
  if (c.unit === 'rupee') return `${sign}₹${abs}`;
  if (c.unit === 'pct') return `${sign}${abs}%`;
  return `${sign}${abs}`;
}

// ── filters ──────────────────────────────────────────────────────────────────

/** Range columns keep the text as typed; category columns list the values still allowed. */
export interface ColumnFilter {
  min?: string;
  max?: string;
  values?: Array<string | number | null>;
}
export type Filters = Record<string, ColumnFilter>;

/** A typed bound as a comparable number, or null when empty or unreadable. */
export function parseBound(c: Column, text: string | undefined): number | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (c.type === 'time') {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(t);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  const v = Number(t.replace(/[,₹%\s]/g, ''));
  return Number.isFinite(v) ? v : null;
}

export function filterActive(f: ColumnFilter | undefined): boolean {
  return !!f && (f.values !== undefined || !!f.min?.trim() || !!f.max?.trim());
}

function passes(row: DayRow, c: Column, f: ColumnFilter): boolean {
  const v = row.values[c.key];
  if (f.values) return f.values.includes(v);
  if (c.type === 'date') {
    const s = String(v);
    return (!f.min || s >= f.min) && (!f.max || s <= f.max);
  }
  const lo = parseBound(c, f.min);
  const hi = parseBound(c, f.max);
  if (lo == null && hi == null) return true;
  if (typeof v !== 'number') return false;
  return (lo == null || v >= lo) && (hi == null || v <= hi);
}

export function applyFilters(rows: DayRow[], filters: Filters): DayRow[] {
  const active = Object.entries(filters).flatMap(([key, f]) => {
    const c = COLUMN_BY_KEY.get(key);
    return c && filterActive(f) ? [[c, f] as const] : [];
  });
  return active.length ? rows.filter((r) => active.every(([c, f]) => passes(r, c, f))) : rows;
}

/** Every value a category column holds, in its natural order; blanks last. */
export function categoryValues(c: Column, rows: DayRow[]): Array<string | number | null> {
  const seen = new Set(rows.map((r) => r.values[c.key]));
  const known = (c.order ?? [...seen].filter((v) => v != null).sort()).filter((v) => seen.has(v));
  return seen.has(null) ? [...known, null] : known;
}

// ── sorting ──────────────────────────────────────────────────────────────────

export interface SortState {
  key: string;
  dir: 1 | -1;
}

function rank(c: Column, v: CellValue): CellValue {
  if (c.type !== 'cat' || !c.order || v == null) return v;
  return (c.order as CellValue[]).indexOf(v);
}

/** Blanks always sort last, whichever way the column runs. */
function compare(a: CellValue, b: CellValue, dir: 1 | -1): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (a === b) return 0;
  return (a < b ? -1 : 1) * dir;
}

export function sortRows(rows: DayRow[], sort: SortState): DayRow[] {
  const c = COLUMN_BY_KEY.get(sort.key);
  if (!c) return rows;
  return [...rows].sort(
    (a, b) =>
      compare(rank(c, a.values[c.key]), rank(c, b.values[c.key]), sort.dir) ||
      (a.raw.date < b.raw.date ? 1 : -1),
  );
}

// ── figures ──────────────────────────────────────────────────────────────────

export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const numbers = (rows: DayRow[], key: string) =>
  rows.flatMap((r) => {
    const v = r.values[key];
    return typeof v === 'number' ? [v] : [];
  });

export type Aggregate = 'median' | 'mean' | 'max' | 'min';

export function aggregate(rows: DayRow[], key: string, how: Aggregate): number | null {
  const v = numbers(rows, key);
  if (!v.length) return null;
  if (how === 'median') return quantile(v, 0.5);
  if (how === 'mean') return v.reduce((a, b) => a + b, 0) / v.length;
  return how === 'max' ? Math.max(...v) : Math.min(...v);
}

export interface LossSummary {
  days: number;
  median: number | null;
  mean: number | null;
  oneInTen: number | null;
  worst: number | null;
  closedRed: number | null;
}

export function lossSummary(rows: DayRow[]): LossSummary {
  const ml = numbers(rows, 'maxLoss');
  return {
    days: rows.length,
    median: quantile(ml, 0.5),
    mean: aggregate(rows, 'maxLoss', 'mean'),
    oneInTen: quantile(ml, 0.9),
    worst: ml.length ? Math.max(...ml) : null,
    closedRed: rows.length ? rows.filter((r) => r.values.red === 'Yes').length / rows.length : null,
  };
}

// ── grouping ─────────────────────────────────────────────────────────────────

export interface Bucket {
  id: string;
  label: string;
  rows: DayRow[];
}

/** Category columns give one group per value; number and time columns split into equal-sized bands. */
export function bucketRows(rows: DayRow[], c: Column, bands: number): Bucket[] {
  if (c.type === 'cat') {
    return categoryValues(c, rows).map((v) => ({
      id: String(v),
      label: v == null ? 'No reading' : formatCell(c, v),
      rows: rows.filter((r) => r.values[c.key] === v),
    }));
  }
  const present = rows.filter((r) => typeof r.values[c.key] === 'number');
  const sorted = numbers(present, c.key).sort((a, b) => a - b);
  const edges = Array.from({ length: bands + 1 }, (_, i) => quantile(sorted, i / bands) as number);
  const out: Bucket[] = [];
  if (sorted.length) {
    for (let i = 0; i < bands; i++) {
      const lo = edges[i];
      const hi = edges[i + 1];
      const members = present.filter((r) => {
        const v = r.values[c.key] as number;
        return (i === 0 ? v >= lo : v > lo) && v <= hi;
      });
      if (members.length) {
        out.push({
          id: `b${i}`,
          label: `${formatCell(c, lo)} to ${formatCell(c, hi)}`,
          rows: members,
        });
      }
    }
  }
  const blank = rows.filter((r) => typeof r.values[c.key] !== 'number');
  if (blank.length) out.push({ id: 'blank', label: 'No reading', rows: blank });
  return out;
}

export type TableItem =
  | { kind: 'group'; id: string; depth: number; label: string; rows: DayRow[]; open: boolean }
  | { kind: 'day'; depth: number; row: DayRow };

export interface GroupPlan {
  first: string | null;
  second: string | null;
  bands: number;
  /** Order groups by the sorted column's group figure rather than their own order. */
  sortGroups: boolean;
  how: Aggregate;
}

/** The table's lines, top to bottom: days only, or groups with the open ones' contents under them. */
export function buildItems(
  rows: DayRow[],
  sort: SortState,
  plan: GroupPlan,
  open: ReadonlySet<string>,
): TableItem[] {
  const first = plan.first ? COLUMN_BY_KEY.get(plan.first) : undefined;
  if (!first) return sortRows(rows, sort).map((row) => ({ kind: 'day', depth: 0, row }));
  const sortColumn = COLUMN_BY_KEY.get(sort.key);
  const order = (buckets: Bucket[]) => {
    if (!plan.sortGroups || !sortColumn) return buckets;
    const figure = (b: Bucket): CellValue =>
      sortColumn.type === 'num' || sortColumn.type === 'time'
        ? aggregate(b.rows, sort.key, plan.how)
        : null;
    return [...buckets].sort((a, b) => compare(figure(a), figure(b), sort.dir));
  };
  const second =
    plan.second && plan.second !== plan.first ? COLUMN_BY_KEY.get(plan.second) : undefined;
  const items: TableItem[] = [];
  const addDays = (list: DayRow[], depth: number) => {
    for (const row of sortRows(list, sort)) items.push({ kind: 'day', depth, row });
  };
  for (const a of order(bucketRows(rows, first, plan.bands))) {
    const isOpen = open.has(a.id);
    items.push({ kind: 'group', id: a.id, depth: 0, label: a.label, rows: a.rows, open: isOpen });
    if (!isOpen) continue;
    if (!second) {
      addDays(a.rows, 1);
      continue;
    }
    for (const b of order(bucketRows(a.rows, second, plan.bands))) {
      const id = `${a.id}/${b.id}`;
      const subOpen = open.has(id);
      items.push({ kind: 'group', id, depth: 1, label: b.label, rows: b.rows, open: subOpen });
      if (subOpen) addDays(b.rows, 2);
    }
  }
  return items;
}

/** Every group id the plan produces, for "expand all". */
export function allGroupIds(rows: DayRow[], plan: GroupPlan): string[] {
  const first = plan.first ? COLUMN_BY_KEY.get(plan.first) : undefined;
  if (!first) return [];
  const second =
    plan.second && plan.second !== plan.first ? COLUMN_BY_KEY.get(plan.second) : undefined;
  return bucketRows(rows, first, plan.bands).flatMap((a) => [
    a.id,
    ...(second ? bucketRows(a.rows, second, plan.bands).map((b) => `${a.id}/${b.id}`) : []),
  ]);
}
