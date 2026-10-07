/**
 * One signal-driven option trade, entered a set number of minutes after the signal and held to the
 * exit minute (end of day by default).
 *
 * Strikes, by `strikeMode`:
 *  - OTM: ATM is spot at the ENTRY minute rounded to the listed step; CE = ATM + N·step,
 *    PE = ATM − N·step (N = 0 is ATM itself). N is the override for the day's distance from expiry
 *    (trading days: 0 = the expiry day, 1 = the day before…) when one is set, otherwise `otmSteps`.
 *    Distance from expiry, not weekday: the expiry weekday has moved over the years, and a Monday
 *    has meant the expiry day, the day before it, or neither.
 *  - PREMIUM: each leg takes the strike whose entry price falls inside that leg's ₹ range, the one
 *    closest to the middle of the range winning (a tie goes to the strike nearer ATM). Only strikes
 *    the data holds can be found — the analysis ladder, plus whatever the OHLC source adds.
 *
 * Entry price: the mean of the entry minute's open and close. Opens exist only in the local parquet
 * tree; where there is none the close alone is used and the leg is marked `basis: 'close'`.
 *
 * Max profit / max loss are the best and worst mark-to-market from the minute after entry through
 * the exit minute. Each minute contributes max(high, close) and min(low, close) — the close may come
 * from a different source than the high/low (Nubra closes, parquet highs/lows), so taking the
 * extreme of both keeps the band honest. Without a high/low the close alone is used. A missing
 * minute is skipped, never filled forward.
 *
 * With both legs the combined extremes add each leg's same-direction extreme minute by minute, so
 * they are a best-case/worst-case bound (two legs need not peak at the same second of a minute).
 * Final P&L is exact: exit close − entry price. Everything is gross — no charges or slippage.
 *
 * Stop paths (`trade.stop`) are what a stop-loss is judged on, and they do NOT use that bound: in a
 * strangle the call's high and the put's high rarely fall in the same minute, so adding them makes
 * every dip look deeper than it was. A minute's combined loss is instead the legs at their closes,
 * or one leg at its adverse extreme with the others at their closes, whichever is worse. The
 * target path (`trade.target`) is the same thing toward profit. See `excursionPathOf`.
 */
import {
  SESSION_BARS,
  STRIKE_STEP,
  hhmmAt,
  minuteIndex,
  round2,
  type DaySeries,
  type Grid,
} from '../analysis/daySeries.ts';

export type LegChoice = 'CE' | 'PE' | 'BOTH';
export type OptionKind = 'CE' | 'PE';
export type StrikeMode = 'OTM' | 'PREMIUM';
/** A ₹ entry-price range, inclusive: [min, max]. */
export type PremiumRange = [number, number];

export interface TradeParams {
  legs: LegChoice;
  side: 'BUY' | 'SELL';
  strikeMode: StrikeMode;
  /** OTM mode: strikes out of the money from ATM at the entry minute; 0 = ATM. */
  otmSteps: number;
  /** OTM mode: override by trading days to expiry ("0" = expiry day); a missing key uses `otmSteps`. */
  otmStepsByDte: Record<string, number>;
  /** PREMIUM mode: ₹ entry-price range per leg, inclusive. */
  cePremiumMin: number;
  cePremiumMax: number;
  pePremiumMin: number;
  pePremiumMax: number;
  /** PREMIUM mode: override of the CE / PE range above by trading days to expiry; a missing key uses it. */
  cePremiumByDte: Record<string, PremiumRange>;
  pePremiumByDte: Record<string, PremiumRange>;
  /**
   * PREMIUM mode: trade only the expiry distances that have a range chosen above. The global range
   * is then not used at all, and a day without a choice is skipped — the ranges come from the data's
   * premium sets, not from a number typed in.
   */
  premiumTiersOnly: boolean;
  /** Minutes after the signal minute (t2) to enter. */
  delayMinutes: number;
  lots: number;
  /** HH:MM, the square-off minute. */
  exitTime: string;
}

export const DEFAULT_TRADE_PARAMS: TradeParams = {
  legs: 'BOTH',
  side: 'SELL',
  strikeMode: 'OTM',
  otmSteps: 2,
  otmStepsByDte: {},
  cePremiumMin: 40,
  cePremiumMax: 60,
  pePremiumMin: 40,
  pePremiumMax: 60,
  cePremiumByDte: {},
  pePremiumByDte: {},
  premiumTiersOnly: false,
  delayMinutes: 1,
  lots: 1,
  exitTime: '15:29',
};

/** Contract size per lot — the same one-lot quantities the Analysis tab uses. */
export const LOT_SIZE: Record<string, number> = { NIFTY: 65, SENSEX: 20 };

export interface OhlcSeries {
  o: Grid;
  h: Grid;
  l: Grid;
  c: Grid;
}

/** Option open/high/low/close per minute for one contract, when a source has them. */
export interface OhlcSource {
  series(kind: OptionKind, strike: number): OhlcSeries | null;
  /** Every strike the source holds for this side — widens what PREMIUM mode can choose from. */
  strikes(kind: OptionKind): number[];
}

export interface LegTrade {
  kind: OptionKind;
  strike: number;
  /** Entry minute's open, when known. */
  entryOpen: number | null;
  entryClose: number;
  /** (open + close) / 2, or the close alone without an open. */
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  /** True when the exit minute had no price and the last earlier close was used. */
  exitFallback: boolean;
  pnl: number;
  maxProfit: number;
  maxProfitTime: string;
  maxLoss: number;
  maxLossTime: string;
  /** 'ohlc' when open/high/low were available for this contract, else 'close'. */
  basis: 'ohlc' | 'close';
}

export interface SignalTrade {
  entryTime: string;
  entrySpot: number;
  atm: number;
  step: number;
  /** OTM mode: the steps used on this day (the override for its expiry distance, or the default); null in PREMIUM mode. */
  otmSteps: number | null;
  qty: number;
  side: 'BUY' | 'SELL';
  legs: LegTrade[];
  exitTime: string;
  pnl: number;
  maxProfit: number;
  maxProfitTime: string;
  maxLoss: number;
  maxLossTime: string;
  basis: 'ohlc' | 'close' | 'mixed';
  /** Where a stop-loss would fire: on the whole trade, and on each leg alone (same order as `legs`). */
  stop: { trade: StopPath; legs: StopPath[] };
  /**
   * Where a profit target on the whole trade would fire: a `StopPath` toward profit — each step is a
   * minute the profit went higher than before, [minute, best ₹ profit that minute, ₹ profit as it began].
   */
  target: StopPath;
  /** The whole trade's loss every minute from entry to exit (see `LossSeries`). */
  series: LossSeries;
  /** Spot at the exit minute (the last leg's), and its highest and lowest close from entry to exit. */
  exitSpot: number | null;
  spotHigh: number | null;
  spotLow: number | null;
}

/**
 * Every minute after entry at which the loss went deeper than it had been, which is all a stop-loss
 * needs: a stop of ₹X fires in the first step whose `depth` reaches X, and fills at X, or at `start`
 * when the minute already began past X (a jump through the stop).
 */
export interface StopPath {
  /** ₹ premium at entry (entry price × qty, over the legs it covers) — what a % stop is a share of. */
  premium: number;
  /** [minute index, deepest ₹ loss in that minute, ₹ loss as the minute began]; losses are positive. */
  steps: Array<[number, number, number]>;
}

/**
 * A trade's loss minute by minute, ₹ for the run's lots, rounded to the rupee; positive = a loss,
 * negative = a profit. Index i is session minute `from + i`, through the exit minute; null where a
 * leg had no price. `worst[i]` is how much worse than `close[i]` the minute got (0 or more), by the
 * same one-leg-at-its-extreme rule as the stop path, so close + worst is that minute's stop depth.
 */
export interface LossSeries {
  from: number;
  close: Array<number | null>;
  worst: Array<number | null>;
}

export type TradeResult = { ok: true; trade: SignalTrade } | { ok: false; reason: string };

function stepFor(day: DaySeries): number {
  const known = STRIKE_STEP[day.underlying];
  if (known) return known;
  const strikes = [...Object.keys(day.ce), ...Object.keys(day.pe)]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const gap = strikes[i] - strikes[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? step : 50;
}

/** "the expiry day", "1 day before expiry", "2 days before expiry"… for a reason a person reads. */
export function describeDte(dte: number | null): string {
  if (dte == null) return 'a day whose expiry distance is unknown';
  if (dte === 0) return 'the expiry day';
  return `${dte} day${dte === 1 ? '' : 's'} before expiry`;
}

/** OTM steps for a day at `dte` trading days from expiry: its override, else the default. */
export function otmStepsFor(params: TradeParams, dte: number | null): number {
  const override = dte == null ? undefined : params.otmStepsByDte?.[String(dte)];
  return override ?? params.otmSteps;
}

/**
 * The ₹ range a PREMIUM-mode leg sells in on a day `dte` trading days from expiry: that distance's
 * choice, else the global range — or null when only chosen distances trade and this one has no choice.
 */
export function premiumRangeFor(
  params: TradeParams,
  kind: OptionKind,
  dte: number | null,
): PremiumRange | null {
  const byDte = kind === 'CE' ? params.cePremiumByDte : params.pePremiumByDte;
  const override = dte == null ? undefined : byDte?.[String(dte)];
  if (override) return override;
  if (params.premiumTiersOnly) return null;
  return kind === 'CE'
    ? [params.cePremiumMin, params.cePremiumMax]
    : [params.pePremiumMin, params.pePremiumMax];
}

/** A leg's per-minute prices: the day's close grid, with the OHLC source filling what it lacks. */
interface LegPrices {
  close(m: number): number | null;
  open(m: number): number | null;
  high(m: number): number | null;
  low(m: number): number | null;
  hasOhlc: boolean;
}

function legPrices(
  day: DaySeries,
  kind: OptionKind,
  strike: number,
  ohlc: OhlcSource | null,
): LegPrices | null {
  const grid = (kind === 'CE' ? day.ce : day.pe)[String(strike)];
  const s = ohlc?.series(kind, strike) ?? null;
  if (!grid && !s) return null;
  return {
    close: (m) => grid?.[m] ?? s?.c[m] ?? null,
    open: (m) => s?.o[m] ?? null,
    high: (m) => s?.h[m] ?? null,
    low: (m) => s?.l[m] ?? null,
    hasOhlc: s != null,
  };
}

/**
 * A leg's close for every minute of the session — the prices the trade is marked against, with the
 * same fallback from the day's ladder to the OHLC source — or null when neither holds the strike.
 */
export function legCloses(
  day: DaySeries,
  kind: OptionKind,
  strike: number,
  ohlc: OhlcSource | null,
): Grid | null {
  const p = legPrices(day, kind, strike, ohlc);
  return p ? Array.from({ length: SESSION_BARS }, (_, m) => p.close(m)) : null;
}

/** The entry minute's price: mean of open and close, or the close alone. */
function entryOf(
  p: LegPrices,
  m: number,
): { open: number | null; close: number; price: number } | null {
  const close = p.close(m);
  if (close == null) return null;
  const open = p.open(m);
  return { open, close, price: open != null ? (open + close) / 2 : close };
}

function extremes(p: LegPrices, m: number): { hi: number; lo: number } | null {
  const vals = [p.close(m), p.high(m), p.low(m)].filter((v): v is number => v != null);
  if (!vals.length) return null;
  return { hi: Math.max(...vals), lo: Math.min(...vals) };
}

export function simulateSignalTrade(
  day: DaySeries,
  signalIndex: number,
  params: TradeParams,
  ohlc: OhlcSource | null,
  /** Trading days from the day to its expiry (0 = the expiry day); null when unknown. */
  dte: number | null = null,
): TradeResult {
  const entryIdx = signalIndex + params.delayMinutes;
  const exitIdx = minuteIndex(params.exitTime);
  if (exitIdx < 0) return { ok: false, reason: `exit ${params.exitTime} is outside the session` };
  if (entryIdx >= SESSION_BARS || entryIdx >= exitIdx) {
    return { ok: false, reason: 'entry is not before exit' };
  }
  const entryTime = hhmmAt(entryIdx);
  const entrySpot = day.spot[entryIdx];
  if (entrySpot == null) return { ok: false, reason: `no spot at entry ${entryTime}` };

  const step = stepFor(day);
  const atm = Math.round(entrySpot / step) * step;
  const qty = params.lots * (LOT_SIZE[day.underlying] ?? 1);
  const sign = params.side === 'BUY' ? 1 : -1;
  const kinds: OptionKind[] = params.legs === 'BOTH' ? ['CE', 'PE'] : [params.legs];
  const otmSteps = params.strikeMode === 'OTM' ? otmStepsFor(params, dte) : null;

  const legs: LegTrade[] = [];
  const perLeg: Array<{ prices: LegPrices; entry: number }> = [];
  for (const kind of kinds) {
    const picked =
      params.strikeMode === 'PREMIUM'
        ? pickByPremium(day, kind, entryIdx, atm, params, ohlc, dte)
        : kind === 'CE'
          ? atm + otmSteps! * step
          : atm - otmSteps! * step;
    if (typeof picked === 'string') return { ok: false, reason: picked };
    const strike = picked;
    const prices = legPrices(day, kind, strike, ohlc);
    if (!prices) return { ok: false, reason: `no data for ${strike} ${kind}` };
    const entry = entryOf(prices, entryIdx);
    if (!entry) {
      return { ok: false, reason: `no ${strike} ${kind} price at entry ${entryTime}` };
    }
    const { open: entryOpen, close: entryClose, price: entryPrice } = entry;
    const mtm = (price: number) => sign * (price - entryPrice) * qty;

    let maxProfit = -Infinity;
    let maxProfitIdx = -1;
    let maxLoss = Infinity;
    let maxLossIdx = -1;
    let lastCloseIdx = -1;
    for (let m = entryIdx + 1; m <= exitIdx; m++) {
      const x = extremes(prices, m);
      if (!x) continue;
      const fav = mtm(sign > 0 ? x.hi : x.lo);
      const adv = mtm(sign > 0 ? x.lo : x.hi);
      if (fav > maxProfit) {
        maxProfit = fav;
        maxProfitIdx = m;
      }
      if (adv < maxLoss) {
        maxLoss = adv;
        maxLossIdx = m;
      }
      if (prices.close(m) != null) lastCloseIdx = m;
    }
    if (lastCloseIdx < 0) {
      return { ok: false, reason: `no ${strike} ${kind} price after entry` };
    }
    const exitPrice = prices.close(lastCloseIdx)!;
    legs.push({
      kind,
      strike,
      entryOpen,
      entryClose,
      entryPrice: round2(entryPrice),
      exitTime: hhmmAt(lastCloseIdx),
      exitPrice,
      exitFallback: lastCloseIdx !== exitIdx,
      pnl: round2(mtm(exitPrice)),
      maxProfit: round2(maxProfit),
      maxProfitTime: hhmmAt(maxProfitIdx),
      maxLoss: round2(maxLoss),
      maxLossTime: hhmmAt(maxLossIdx),
      basis: prices.hasOhlc && entryOpen != null ? 'ohlc' : 'close',
    });
    perLeg.push({ prices, entry: entryPrice });
  }

  let maxProfit = legs[0].maxProfit;
  let maxProfitTime = legs[0].maxProfitTime;
  let maxLoss = legs[0].maxLoss;
  let maxLossTime = legs[0].maxLossTime;
  if (perLeg.length > 1) {
    // Combined bound: only minutes where every leg has a price.
    let best = -Infinity;
    let bestIdx = -1;
    let worst = Infinity;
    let worstIdx = -1;
    for (let m = entryIdx + 1; m <= exitIdx; m++) {
      let fav = 0;
      let adv = 0;
      let complete = true;
      for (const { prices, entry } of perLeg) {
        const x = extremes(prices, m);
        if (!x) {
          complete = false;
          break;
        }
        fav += sign * ((sign > 0 ? x.hi : x.lo) - entry) * qty;
        adv += sign * ((sign > 0 ? x.lo : x.hi) - entry) * qty;
      }
      if (!complete) continue;
      if (fav > best) {
        best = fav;
        bestIdx = m;
      }
      if (adv < worst) {
        worst = adv;
        worstIdx = m;
      }
    }
    if (bestIdx < 0) return { ok: false, reason: 'no minute with prices for both legs' };
    maxProfit = round2(best);
    maxProfitTime = hhmmAt(bestIdx);
    maxLoss = round2(worst);
    maxLossTime = hhmmAt(worstIdx);
  }

  const bases = new Set(legs.map((l) => l.basis));
  const pathOf = (covered: typeof perLeg, toward: 'loss' | 'profit' = 'loss') =>
    excursionPathOf(covered, sign, qty, entryIdx, exitIdx, toward);
  const exitTime = legs.reduce((t, l) => (l.exitTime > t ? l.exitTime : t), legs[0].exitTime);
  let spotHigh: number | null = null;
  let spotLow: number | null = null;
  let exitSpot: number | null = null;
  for (let m = entryIdx; m <= minuteIndex(exitTime); m++) {
    const v = day.spot[m];
    if (v == null) continue;
    if (spotHigh == null || v > spotHigh) spotHigh = v;
    if (spotLow == null || v < spotLow) spotLow = v;
    exitSpot = v;
  }
  return {
    ok: true,
    trade: {
      entryTime,
      entrySpot,
      atm,
      step,
      otmSteps,
      qty,
      side: params.side,
      legs,
      exitTime,
      pnl: round2(legs.reduce((s, l) => s + l.pnl, 0)),
      maxProfit,
      maxProfitTime,
      maxLoss,
      maxLossTime,
      basis: bases.size > 1 ? 'mixed' : legs[0].basis,
      stop: { trade: pathOf(perLeg), legs: perLeg.map((p) => pathOf([p])) },
      target: pathOf(perLeg, 'profit'),
      series: lossSeriesOf(perLeg, sign, qty, entryIdx, exitIdx),
      exitSpot,
      spotHigh,
      spotLow,
    },
  };
}

/**
 * The stop path (toward 'loss') or target path (toward 'profit') of a set of legs held together:
 * the minutes whose depth (see `minuteMarks`) went past every minute before.
 */
function excursionPathOf(
  legs: Array<{ prices: LegPrices; entry: number }>,
  sign: number,
  qty: number,
  entryIdx: number,
  exitIdx: number,
  toward: 'loss' | 'profit',
): StopPath {
  const steps: StopPath['steps'] = [];
  let deepest = 0;
  for (const { m, depth, start } of minuteMarks(legs, sign, qty, entryIdx, exitIdx, toward)) {
    if (depth > deepest) {
      deepest = depth;
      steps.push([m, round2(depth), round2(start)]);
    }
  }
  return {
    premium: round2(legs.reduce((s, l) => s + l.entry, 0) * qty),
    steps,
  };
}

/**
 * The whole trade's loss every minute from entry to exit, as the stop path marks it: the close,
 * and how much worse the minute got than its close. What the Losses view follows after a loss
 * level is hit.
 */
function lossSeriesOf(
  legs: Array<{ prices: LegPrices; entry: number }>,
  sign: number,
  qty: number,
  entryIdx: number,
  exitIdx: number,
): LossSeries {
  const from = entryIdx + 1;
  const close: LossSeries['close'] = new Array(Math.max(0, exitIdx - entryIdx)).fill(null);
  const worst: LossSeries['worst'] = new Array(close.length).fill(null);
  for (const mark of minuteMarks(legs, sign, qty, entryIdx, exitIdx, 'loss')) {
    close[mark.m - from] = Math.round(mark.close);
    worst[mark.m - from] = Math.round(mark.depth - mark.close);
  }
  return { from, close, worst };
}

/**
 * Each minute after entry (only where every leg has a close), toward 'loss' or 'profit':
 *  - `close`: the value at the closes;
 *  - `depth`: the worse (better) of that and each leg alone at its extreme — high when short for
 *    a loss, low for a profit — with the other legs at their closes: one leg spiking at a time,
 *    not all at once;
 *  - `start`: the value as the minute began: at the opens when every leg has one, else at the
 *    previous minute's closes, else (the minute before is missing) at this minute's closes, so an
 *    order that falls in a data gap fills where the data resumes rather than at a price nobody saw.
 * Without high/low (close-only runs) the depth is simply the value at the closes.
 */
function minuteMarks(
  legs: Array<{ prices: LegPrices; entry: number }>,
  sign: number,
  qty: number,
  entryIdx: number,
  exitIdx: number,
  toward: 'loss' | 'profit',
): Array<{ m: number; close: number; depth: number; start: number }> {
  const dir = toward === 'loss' ? 1 : -1;
  const lossAt = (entry: number, price: number) => -dir * sign * (price - entry) * qty;
  const sumLoss = (pick: (p: LegPrices) => number | null): number | null => {
    let total = 0;
    for (const { prices, entry } of legs) {
      const v = pick(prices);
      if (v == null) return null;
      total += lossAt(entry, v);
    }
    return total;
  };

  const marks: Array<{ m: number; close: number; depth: number; start: number }> = [];
  let prevClose = sumLoss((p) => p.close(entryIdx));
  for (let m = entryIdx + 1; m <= exitIdx; m++) {
    const closeLoss = sumLoss((p) => p.close(m));
    if (closeLoss == null) {
      prevClose = null;
      continue;
    }
    let depth = closeLoss;
    for (const { prices, entry } of legs) {
      const x = extremes(prices, m);
      if (!x) continue;
      const close = prices.close(m)!;
      const alone = closeLoss - lossAt(entry, close) + lossAt(entry, sign * dir > 0 ? x.lo : x.hi);
      if (alone > depth) depth = alone;
    }
    const start = sumLoss((p) => p.open(m)) ?? prevClose ?? closeLoss;
    if (start > depth) depth = start;
    marks.push({ m, close: closeLoss, depth, start });
    prevClose = closeLoss;
  }
  return marks;
}

/** PREMIUM mode: the strike whose entry price is inside the leg's range, closest to its middle. */
function pickByPremium(
  day: DaySeries,
  kind: OptionKind,
  entryIdx: number,
  atm: number,
  params: TradeParams,
  ohlc: OhlcSource | null,
  dte: number | null,
): number | string {
  const range = premiumRangeFor(params, kind, dte);
  if (!range) return `no ${kind} premium range chosen for ${describeDte(dte)}`;
  const [lo, hi] = range;
  const mid = (lo + hi) / 2;
  let best: { strike: number; off: number; dist: number } | null = null;
  for (const strike of candidateStrikes(day, kind, ohlc)) {
    const prices = legPrices(day, kind, strike, ohlc);
    const e = prices && entryOf(prices, entryIdx);
    if (!e || e.price < lo || e.price > hi) continue;
    const off = Math.abs(e.price - mid);
    const dist = Math.abs(strike - atm);
    if (!best || off < best.off || (off === best.off && dist < best.dist)) {
      best = { strike, off, dist };
    }
  }
  return best ? best.strike : `no ${kind} strike priced ₹${lo}–${hi} at ${hhmmAt(entryIdx)}`;
}

/** Every strike a PREMIUM-mode leg could take on one side: the day's own ladder plus the OHLC source's. */
function candidateStrikes(day: DaySeries, kind: OptionKind, ohlc: OhlcSource | null): number[] {
  const strikes = new Set<number>(Object.keys(kind === 'CE' ? day.ce : day.pe).map(Number));
  for (const k of ohlc?.strikes(kind) ?? []) strikes.add(k);
  return [...strikes].filter(Number.isFinite);
}

/** Prices under this are left out of the premium sets: ticks on a dying strike, not something to sell. */
export const MIN_SET_PRICE = 1;

/** The entry-minute prices, per side, of the strikes a premium rule could sell. */
export interface PremiumUniverse {
  CE: number[];
  PE: number[];
}

/**
 * What a PREMIUM-mode leg has to choose from at `entryIdx`: the entry price (same convention as the
 * trade itself) of every strike `pickByPremium` would consider, limited to ATM and out of the money
 * — the strikes a premium seller means — and to `MIN_SET_PRICE` and up. Null when there is no spot.
 */
export function premiumUniverse(
  day: DaySeries,
  entryIdx: number,
  ohlc: OhlcSource | null,
): PremiumUniverse | null {
  const entrySpot = day.spot[entryIdx];
  if (entrySpot == null) return null;
  const step = stepFor(day);
  const atm = Math.round(entrySpot / step) * step;
  const out: PremiumUniverse = { CE: [], PE: [] };
  for (const kind of ['CE', 'PE'] as const) {
    for (const strike of candidateStrikes(day, kind, ohlc)) {
      if (kind === 'CE' ? strike < atm : strike > atm) continue;
      const prices = legPrices(day, kind, strike, ohlc);
      const e = prices && entryOf(prices, entryIdx);
      if (e && e.price >= MIN_SET_PRICE) out[kind].push(e.price);
    }
  }
  return out;
}
