// ─────────────────────────────────────────────────────────────────────────────
// Execution engine — bar-by-bar intraday simulation.
//
// Per trading day: resolve each leg's expiry + strike at entry, optionally gate
// the day on entry filters, enter at entryTime (or a delayed wait-&-trade bar),
// then walk minute bars applying per-leg SL/target/trailing (conservative
// intra-bar: stop-loss assumed to fill before target when a single bar spans
// both), per-leg re-entry, and portfolio-level max-profit / max-loss, finally
// squaring off at exitTime.
//
// A leg is modelled as a "slot" that can hold a sequence of episodes (the
// original entry plus any re-entries). Each episode becomes one row in the day's
// leg results, tagged with `seq` (0 = original).
// ─────────────────────────────────────────────────────────────────────────────
import type {
  Adjustment, BacktestConfig, ChargeBreakdown, DayTrade, EntryFilters, ExitReason, IntradayLegPoint,
  IntradayPoint, Leg, OptionType, Side, StrikeSelection, TradeLegResult, TrailStop, WeekdayCode,
} from './types.ts';
import {
  loadExpiryDay, resolveExpiry,
  type Bar, type ExpiryDay,
} from './dataLayer.ts';
import { bsDelta, yearsToExpiry } from './greeks.ts';

const WD: WeekdayCode[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

export function enumerateTradingDays(from: string, to: string, days?: WeekdayCode[]): string[] {
  const out: string[] = [];
  const allow = days && days.length ? new Set(days) : null;
  const start = new Date(`${from}T12:00:00Z`);
  const end   = new Date(`${to}T12:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay(); // 0=Sun
    if (dow === 0 || dow === 6) continue;
    const code = WD[dow - 1];
    if (allow && !allow.has(code)) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function firstBarFrom(bars: Bar[], hhmm: string): Bar | null {
  for (const b of bars) if (b.hhmm >= hhmm) return b;
  return null;
}

// Coerce a config value to a finite number. JSON from a client may deliver numeric
// fields as strings; without this, e.g. `spot + "-200"` string-concats to NaN and the
// strike silently resolves to the floor of the grid instead of the intended strike.
function num(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Find the first bar at or after a target time in a (possibly absent) series.
function barFrom(series: Bar[] | undefined, hhmm: string): Bar | null {
  if (!series) return null;
  for (const b of series) if (b.hhmm >= hhmm) return b;
  return null;
}

// Resolve a leg's strike SELECTION to an absolute strike present on the date.
// Operates on the stitched ExpiryDay, whose `strikes` are the true per-date
// strikes — unlike the old path that labelled every floating ATM±N bucket with
// its first row's strike (correct only on an expiry's first captured day).
function chooseStrike(
  sel: StrikeSelection, day: ExpiryDay, optionType: OptionType,
  entrySpot: number, entryHHMM: string, date: string, expiry: string,
): number | null {
  const strikes = day.strikes;
  if (!strikes.length) return null;
  const nearestTo = (target: number): number =>
    strikes.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best, strikes[0]);
  const map = optionType === 'CALL' ? day.call : day.put;

  // Premium of a strike at entry (this option type), or null if no/NaN bar.
  const premAt = (s: number): number | null => {
    const b = barFrom(map.get(s), entryHHMM);
    return b && Number.isFinite(b.close) ? b.close : null;
  };
  // |Black-Scholes delta| of a strike at entry, or null.
  const deltaAt = (s: number): number | null => {
    const b = barFrom(map.get(s), entryHHMM);
    if (!b) return null;
    return Math.abs(bsDelta(optionType, b.spot, s, b.iv, yearsToExpiry(date, entryHHMM, expiry)));
  };
  // ATM straddle premium at entry (ATM CE close + ATM PE close) — used by
  // STRADDLE_WIDTH and ATM_STRADDLE_PREMIUM_PCT.
  const atmStraddlePremium = (): number | null => {
    let ai = 0, bestD = Infinity;
    strikes.forEach((s, i) => { const d = Math.abs(s - entrySpot); if (d < bestD) { bestD = d; ai = i; } });
    const atm = strikes[ai];
    const ce = barFrom(day.call.get(atm), entryHHMM);
    const pe = barFrom(day.put.get(atm), entryHHMM);
    if (!ce || !pe || !Number.isFinite(ce.close) || !Number.isFinite(pe.close)) return null;
    return ce.close + pe.close;
  };
  // Pick the strike whose premium is nearest a target (used by several criteria).
  const closestPremium = (tgt: number): number | null => {
    let best: number | null = null, bestDiff = Infinity;
    for (const s of strikes) {
      const p = premAt(s); if (p == null) continue;
      const diff = Math.abs(p - tgt);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
  };

  switch (sel.method) {
    case 'ATM': {
      let ai = 0, bestD = Infinity;
      strikes.forEach((s, i) => { const d = Math.abs(s - entrySpot); if (d < bestD) { bestD = d; ai = i; } });
      const shifted = ai + Math.round(num(sel.atmOffset, 0));
      if (shifted < 0 || shifted >= strikes.length) return null;
      return strikes[shifted];
    }
    case 'POINTS_FROM_SPOT':
      return nearestTo(entrySpot + num(sel.pointsFromSpot, 0));
    case 'PERCENT_FROM_SPOT':
      return nearestTo(entrySpot * (1 + num(sel.percentFromSpot, 0) / 100));
    case 'FIXED_STRIKE':
      return sel.absoluteStrike != null ? nearestTo(num(sel.absoluteStrike)) : null;
    case 'CLOSEST_PREMIUM':
      return closestPremium(num(sel.premiumTarget, 0));
    case 'PREMIUM_GTE': {
      // smallest premium still ≥ threshold (most-OTM strike meeting the floor)
      const tgt = num(sel.premiumTarget, 0);
      let best: number | null = null, bestPrem = Infinity;
      for (const s of strikes) {
        const p = premAt(s); if (p == null) continue;
        if (p >= tgt && p < bestPrem) { bestPrem = p; best = s; }
      }
      return best;
    }
    case 'PREMIUM_LTE': {
      // largest premium still ≤ threshold (least-OTM strike under the cap)
      const tgt = num(sel.premiumTarget, 0);
      let best: number | null = null, bestPrem = -Infinity;
      for (const s of strikes) {
        const p = premAt(s); if (p == null) continue;
        if (p <= tgt && p > bestPrem) { bestPrem = p; best = s; }
      }
      return best;
    }
    case 'PREMIUM_RANGE': {
      // strike whose premium falls within [min,max], nearest the band midpoint
      const lo = num(sel.premiumMin, 0), hi = num(sel.premiumMax, 0);
      const mid = (lo + hi) / 2;
      let best: number | null = null, bestDiff = Infinity;
      for (const s of strikes) {
        const p = premAt(s); if (p == null || p < lo || p > hi) continue;
        const diff = Math.abs(p - mid);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    }
    case 'DELTA_RANGE': {
      const lo = Math.abs(num(sel.deltaMin, 0)), hi = Math.abs(num(sel.deltaMax, 1));
      const mid = (lo + hi) / 2;
      let best: number | null = null, bestDiff = Infinity;
      for (const s of strikes) {
        const d = deltaAt(s); if (d == null || d < lo || d > hi) continue;
        const diff = Math.abs(d - mid);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    }
    case 'STRADDLE_WIDTH': {
      // strike at ATM ± (multiplier × ATM-straddle premium): CALL above, PUT below.
      const straddle = atmStraddlePremium();
      if (straddle == null) return null;
      const width = straddle * num(sel.straddleWidthMult, 1);
      return nearestTo(optionType === 'CALL' ? entrySpot + width : entrySpot - width);
    }
    case 'ATM_STRADDLE_PREMIUM_PCT': {
      // strike whose premium ≈ pct% of the ATM straddle premium
      const straddle = atmStraddlePremium();
      if (straddle == null) return null;
      return closestPremium(straddle * (num(sel.straddlePremiumPct, 0) / 100));
    }
    case 'DELTA': {
      const tgt = Math.abs(num(sel.targetDelta, 0.5));
      const tYears = yearsToExpiry(date, entryHHMM, expiry);
      let best: number | null = null, bestDiff = Infinity;
      for (const s of strikes) {
        const b = barFrom(map.get(s), entryHHMM);
        if (!b) continue;
        const d = Math.abs(bsDelta(optionType, b.spot, s, b.iv, tYears));
        const diff = Math.abs(d - tgt);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    }
    default:
      return null;
  }
}

// ── premium-based SL / target levels ─────────────────────────────────────────
function premiumLevels(side: Side, entry: number, sl: Leg['stopLoss'], tgt: Leg['target']) {
  let slPrice: number | null = null, tgtPrice: number | null = null;
  const pct = (v: number, up: boolean) => up ? entry * (1 + v / 100) : entry * (1 - v / 100);
  const slV = num(sl.value), tgtV = num(tgt.value);
  if (sl.type === 'PREMIUM_PERCENT' && sl.value != null) slPrice = side === 'SELL' ? pct(slV, true) : pct(slV, false);
  if (sl.type === 'PREMIUM_ABSOLUTE' && sl.value != null) slPrice = side === 'SELL' ? entry + slV : entry - slV;
  if (tgt.type === 'PREMIUM_PERCENT' && tgt.value != null) tgtPrice = side === 'SELL' ? pct(tgtV, false) : pct(tgtV, true);
  if (tgt.type === 'PREMIUM_ABSOLUTE' && tgt.value != null) tgtPrice = side === 'SELL' ? entry - tgtV : entry + tgtV;
  return { slPrice, tgtPrice };
}

// ── underlying-based SL / target levels ──────────────────────────────────────
// A position is "bullish" (gains as the underlying rises) when it is a long CALL
// or a short PUT; otherwise "bearish". SL = adverse move, target = favourable.
function isBullish(side: Side, optionType: OptionType): boolean {
  return (side === 'BUY' && optionType === 'CALL') || (side === 'SELL' && optionType === 'PUT');
}
function underlyingLevels(
  side: Side, optionType: OptionType, entrySpot: number,
  sl: Leg['stopLoss'], tgt: Leg['target'],
) {
  const bull = isBullish(side, optionType);
  const pts = (v: number, pct: boolean) => pct ? entrySpot * (v / 100) : v;
  let slSpot: number | null = null, tgtSpot: number | null = null;
  const slPts = sl.type === 'UNDERLYING_POINTS' || sl.type === 'UNDERLYING_PERCENT' ? (sl.value != null ? num(sl.value) : null) : null;
  const tgPts = tgt.type === 'UNDERLYING_POINTS' || tgt.type === 'UNDERLYING_PERCENT' ? (tgt.value != null ? num(tgt.value) : null) : null;
  if (slPts != null) {
    const d = pts(slPts, sl.type === 'UNDERLYING_PERCENT');
    slSpot = bull ? entrySpot - d : entrySpot + d; // adverse
  }
  if (tgPts != null) {
    const d = pts(tgPts, tgt.type === 'UNDERLYING_PERCENT');
    tgtSpot = bull ? entrySpot + d : entrySpot - d; // favourable
  }
  return { slSpot, tgtSpot, bull };
}

// ── per-leg slot / episode model ─────────────────────────────────────────────
interface Episode {
  side:       Side;
  strike:     number;
  expiry:     string;
  optionType: OptionType;
  entryRaw:   number;
  entryFill:  number;
  entryTime:  string;
  entrySpot:  number;
  exitRaw:    number;
  exitFill:   number;
  exitTime:   string;
  exitReason: ExitReason;
  qty:        number;
  seq:        number;
  highAfterEntry: number;
  lowAfterEntry:  number;
}

interface Slot {
  leg:       Leg;
  strike:    number;
  expiry:    string;
  lots:      number;   // actual lots used this day (after position sizing)
  qty:       number;   // lots × lotSize
  byTs:      Map<number, Bar>;
  episodes:  Episode[];
  // current open position
  open:      boolean;
  side:      Side;
  entryRaw:  number;
  entryFill: number;
  entryTime: string;
  entryTs:   number;   // epoch-sec of the entry bar — exits are skipped on this bar (no look-ahead)
  entrySpot: number;
  slPrice:   number | null;   // premium-based stop (mutated by trailing)
  tgtPrice:  number | null;   // premium-based target
  slSpot:    number | null;   // underlying-based stop
  tgtSpot:   number | null;   // underlying-based target
  bull:      boolean;
  lastRaw:   number;
  seq:       number;
  reentriesUsed: number;
  // pending re-entry waiting for a trigger bar
  pending?:  { mode: 'ASAP' | 'COST' | 'REVERSE_ASAP'; side: Side; refPrice: number };
  // per-episode high/low tracking
  highAfterEntry: number;
  lowAfterEntry:  number;
}

function openPosition(slot: Slot, side: Side, bar: Bar, slip: number, cfg: BacktestConfig): void {
  const leg = slot.leg;
  // Fill at the bar OPEN (the price at the start of the entry minute). This matches
  // AlgoTest's convention — verified against its trade report: their entry/exit
  // prices track the minute's open, not its close. Filling at close would let the
  // within-minute drift leak into every fill (a systematic edge of several points
  // per leg that compounds across legs and days).
  const entryRaw = bar.open;
  slot.open = true;
  slot.side = side;
  slot.entryRaw = entryRaw;
  slot.entryFill = side === 'SELL' ? entryRaw * (1 - slip) : entryRaw * (1 + slip);
  slot.entryTime = bar.hhmm;
  slot.entryTs = bar.ts;
  slot.entrySpot = bar.spot;
  slot.lastRaw = entryRaw;
  // Post-entry extremes start AT the entry price. The entry bar's own high/low
  // span pre-entry action and must not seed these (look-ahead); subsequent bars expand them.
  slot.highAfterEntry = entryRaw;
  slot.lowAfterEntry = entryRaw;
  const pl = premiumLevels(side, entryRaw, leg.stopLoss, leg.target);
  slot.slPrice = pl.slPrice;
  slot.tgtPrice = pl.tgtPrice;
  const ul = underlyingLevels(side, leg.optionType, bar.spot, leg.stopLoss, leg.target);
  slot.slSpot = ul.slSpot;
  slot.tgtSpot = ul.tgtSpot;
  slot.bull = ul.bull;
  void cfg;
}

// Square-off / EOD fill price for a still-open slot at a given minute: the bar's
// OPEN (AlgoTest convention — see openPosition), falling back to the last known
// raw premium if that minute's bar is missing for this slot.
function slotFillAt(slot: Slot, ts: number): number {
  const b = slot.byTs.get(ts);
  return b && Number.isFinite(b.open) ? b.open : slot.lastRaw;
}

function closePosition(slot: Slot, exitRaw: number, reason: ExitReason, hhmm: string, slip: number): void {
  const fill = slot.side === 'SELL' ? exitRaw * (1 + slip) : exitRaw * (1 - slip);
  slot.episodes.push({
    side: slot.side, strike: slot.strike, expiry: slot.expiry, optionType: slot.leg.optionType,
    entryRaw: slot.entryRaw, entryFill: slot.entryFill, entryTime: slot.entryTime, entrySpot: slot.entrySpot,
    exitRaw, exitFill: fill, exitTime: hhmm, exitReason: reason, qty: slot.qty, seq: slot.seq,
    highAfterEntry: slot.highAfterEntry, lowAfterEntry: slot.lowAfterEntry,
  });
  slot.open = false;
}

// Tighten the premium stop according to the trailing rule (favourable = premium
// falling for a SELL, rising for a BUY). Uses the bar's favourable extreme.
function applyTrail(slot: Slot, bar: Bar): void {
  const t: TrailStop | undefined = slot.leg.trail;
  if (!t || t.type === 'NONE') return;
  const sell = slot.side === 'SELL';
  const favExtreme = sell ? slot.entryRaw - bar.low : bar.high - slot.entryRaw;
  if (favExtreme <= 0) return;
  const trigger = t.trigger ?? 0;
  if (favExtreme < trigger) return;

  // candidate new stop (premium price); only tightened below.
  let candidate: number | null = null;
  if (t.type === 'TO_COST') {
    candidate = slot.entryRaw;
  } else if (t.type === 'LOCK') {
    const lock = t.lock ?? 0;
    candidate = sell ? slot.entryRaw - lock : slot.entryRaw + lock;
  } else if (t.type === 'TRAIL' || t.type === 'LOCK_AND_TRAIL') {
    const step = t.step && t.step > 0 ? t.step : 1;
    const move = t.trail ?? 0;
    const steps = Math.floor((favExtreme - trigger) / step) + 1;
    const trailed = sell ? slot.entryRaw - steps * move : slot.entryRaw + steps * move;
    if (t.type === 'LOCK_AND_TRAIL') {
      const lock = t.lock ?? 0;
      const locked = sell ? slot.entryRaw - lock : slot.entryRaw + lock;
      candidate = sell ? Math.max(trailed, locked) : Math.min(trailed, locked);
    } else {
      candidate = trailed;
    }
  }
  if (candidate == null) return;
  // tighten only: for SELL the stop sits above entry and moves down; for BUY below and moves up.
  if (slot.slPrice == null) slot.slPrice = candidate;
  else slot.slPrice = sell ? Math.min(slot.slPrice, candidate) : Math.max(slot.slPrice, candidate);
}

function episodeGross(e: Episode): number {
  return e.side === 'SELL' ? (e.entryRaw - e.exitRaw) * e.qty : (e.exitRaw - e.entryRaw) * e.qty;
}
function episodeNet(e: Episode): number {
  return e.side === 'SELL' ? (e.entryFill - e.exitFill) * e.qty : (e.exitFill - e.entryFill) * e.qty;
}
// mark-to-market of a slot's currently open position at a raw premium
function openGross(slot: Slot, raw: number): number {
  return slot.side === 'SELL' ? (slot.entryRaw - raw) * slot.qty : (raw - slot.entryRaw) * slot.qty;
}

// ── exit-rule evaluation (PURE) ──────────────────────────────────────────────
// Strategy logic only: given an open slot and a bar, decide whether it exits and
// at what price/reason. No mutation, no I/O — execution is the caller's job. This
// is the rule/execution boundary that lets exit rules change without touching the
// PnL/episode machinery. Stop-loss is evaluated before target so that a bar whose
// range spans both fills at the stop (conservative worst-case).
type ExitKind = 'SL' | 'TGT';
interface ExitDecision { price: number; reason: ExitReason; kind: ExitKind; }

function evaluateExit(slot: Slot, bar: Bar, date: string): ExitDecision | null {
  const sell = slot.side === 'SELL';
  const trailing = slot.leg.trail != null && slot.leg.trail.type !== 'NONE';

  // 1) premium-based stop (level is a premium price; mutated by trailing)
  if (slot.slPrice != null) {
    const hit = sell ? bar.high >= slot.slPrice : bar.low <= slot.slPrice;
    if (hit) return { price: slot.slPrice, reason: trailing ? 'TRAIL_SL' : 'STOPLOSS', kind: 'SL' };
  }
  // 2) underlying-based stop (exit at the prevailing premium = bar open)
  if (slot.slSpot != null) {
    const hit = slot.bull ? bar.low <= slot.slSpot : bar.high >= slot.slSpot;
    if (hit) return { price: bar.open, reason: 'STOPLOSS', kind: 'SL' };
  }
  // 3) premium-based target
  if (slot.tgtPrice != null) {
    const hit = sell ? bar.low <= slot.tgtPrice : bar.high >= slot.tgtPrice;
    if (hit) return { price: slot.tgtPrice, reason: 'TARGET', kind: 'TGT' };
  }
  // 4) underlying-based target
  if (slot.tgtSpot != null) {
    const hit = slot.bull ? bar.high >= slot.tgtSpot : bar.low <= slot.tgtSpot;
    if (hit) return { price: bar.open, reason: 'TARGET', kind: 'TGT' };
  }
  // 5) delta-based stop/target (Black-Scholes |delta| from the bar's IV/spot)
  const slDelta = slot.leg.stopLoss.type === 'DELTA';
  const tgtDelta = slot.leg.target.type === 'DELTA';
  if (slDelta || tgtDelta) {
    const tY = yearsToExpiry(date, bar.hhmm, slot.expiry);
    const absDelta = Math.abs(bsDelta(slot.leg.optionType, bar.spot, slot.strike, bar.iv, tY));
    if (slDelta && slot.leg.stopLoss.value != null && absDelta >= num(slot.leg.stopLoss.value)) {
      return { price: bar.open, reason: 'STOPLOSS', kind: 'SL' };
    }
    if (tgtDelta && slot.leg.target.value != null && absDelta <= num(slot.leg.target.value)) {
      return { price: bar.open, reason: 'TARGET', kind: 'TGT' };
    }
  }
  return null;
}

// ── days-to-expiry (calendar) ────────────────────────────────────────────────
function dte(date: string, expiry: string): number {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${expiry}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// ── margin estimate ──────────────────────────────────────────────────────────
// SPAN+exposure proxy for a *naked* short index option ≈ 10% of contract notional.
const SHORT_NOTIONAL_PCT = 0.10;

interface MarginLeg {
  optionType: OptionType; side: Side; strike: number;
  qty: number;     // total units (lots × lotSize)
  premium: number; // per-unit entry premium (raw)
  spot: number;    // underlying spot at entry
}

// Approximate the broker margin required to *put on* the position, recognising
// vertical-spread hedges so defined-risk structures (e.g. iron condors) aren't
// charged as four naked legs. Per option type, each short is hedged by the
// tightest protective long (higher-strike call / lower-strike put); the hedged
// quantity costs only the spread width (its max loss), the unhedged short
// quantity costs the naked SPAN proxy, and any leftover long costs its premium.
function estimateMargin(legs: MarginLeg[]): number {
  let margin = 0;
  for (const ot of ['CALL', 'PUT'] as OptionType[]) {
    const shorts = legs.filter((l) => l.optionType === ot && l.side === 'SELL').map((l) => ({ ...l }));
    const longs  = legs.filter((l) => l.optionType === ot && l.side === 'BUY').map((l) => ({ ...l }));
    for (const s of shorts) {
      let remaining = s.qty;
      const hedges = longs
        .filter((l) => l.qty > 0 && (ot === 'CALL' ? l.strike > s.strike : l.strike < s.strike))
        .sort((a, b) => (ot === 'CALL' ? a.strike - b.strike : b.strike - a.strike)); // tightest hedge first
      for (const l of hedges) {
        if (remaining <= 0) break;
        const m = Math.min(remaining, l.qty);
        margin += Math.abs(l.strike - s.strike) * m; // defined risk of the vertical
        remaining -= m; l.qty -= m;
      }
      if (remaining > 0) margin += s.spot * SHORT_NOTIONAL_PCT * remaining; // naked portion
    }
    for (const l of longs) if (l.qty > 0) margin += l.premium * l.qty; // unhedged long = premium paid
  }
  return margin;
}

// ── charges model (Indian index-option F&O cost stack) ───────────────────────
// Itemised statutory + broker costs. Turnover for an option order = premium × qty.
// Rates reflect the post-Oct-2024 schedule used by discount brokers (Zerodha-style).
const BROKERAGE_PER_ORDER = 20;        // flat ₹20 per executed order …
const BROKERAGE_PCT       = 0.0003;    // … or 0.03% of turnover, whichever is lower
const STT_SELL_PCT        = 0.001;     // 0.10% on the SELL-side premium (options)
const SEBI_PCT            = 0.000001;  // ₹10 per crore = 0.0001%, both sides
const STAMP_BUY_PCT       = 0.00003;   // 0.003% on the BUY-side premium
const GST_PCT             = 0.18;      // 18% on (brokerage + exchange + sebi)
const TXN_PCT: Record<string, number> = {
  NIFTY:  0.0003503,  // NSE index options exchange transaction charge (0.03503%)
  SENSEX: 0.000325,   // BSE Sensex options exchange transaction charge (≈0.0325%)
};

interface ChargeLeg { entryRaw: number; exitRaw: number; side: Side; qty: number; }

// Each episode is one entry order + one exit order. STT is levied on the sell leg
// (entry for a SELL, exit for a BUY); stamp duty on the buy leg.
function computeCharges(legs: ChargeLeg[], underlying: string, slippageCost: number): ChargeBreakdown {
  const txnPct = TXN_PCT[underlying] ?? TXN_PCT.NIFTY;
  let brokerage = 0, stt = 0, exchange = 0, sebi = 0, stampDuty = 0;
  for (const l of legs) {
    const entryVal = l.entryRaw * l.qty;
    const exitVal  = l.exitRaw  * l.qty;
    const sellVal  = l.side === 'SELL' ? entryVal : exitVal;
    const buyVal   = l.side === 'SELL' ? exitVal  : entryVal;
    brokerage += Math.min(BROKERAGE_PER_ORDER, BROKERAGE_PCT * entryVal);
    brokerage += Math.min(BROKERAGE_PER_ORDER, BROKERAGE_PCT * exitVal);
    exchange  += txnPct * (entryVal + exitVal);
    sebi      += SEBI_PCT * (entryVal + exitVal);
    stt       += STT_SELL_PCT * sellVal;
    stampDuty += STAMP_BUY_PCT * buyVal;
  }
  const gst = GST_PCT * (brokerage + exchange + sebi);
  const total = brokerage + stt + exchange + sebi + stampDuty + gst + slippageCost;
  return {
    brokerage: round2(brokerage), stt: round2(stt), exchange: round2(exchange),
    sebi: round2(sebi), stampDuty: round2(stampDuty), gst: round2(gst),
    slippage: round2(slippageCost), total: round2(total),
  };
}

// Peak concurrent margin across the day: at every episode entry, recompute the
// SPAN proxy over all episodes that are simultaneously live. Re-entries and
// adjustments that add legs (or re-strike) raise this above the initial margin.
function peakConcurrentMargin(episodes: Episode[]): number {
  if (!episodes.length) return 0;
  const events = [...new Set(episodes.map((e) => e.entryTime))].sort();
  let peak = 0;
  for (const t of events) {
    const live = episodes.filter((e) => e.entryTime <= t && t < e.exitTime);
    if (!live.length) continue;
    const m = estimateMargin(live.map((e) => ({
      optionType: e.optionType, side: e.side, strike: e.strike,
      qty: e.qty, premium: e.entryRaw, spot: e.entrySpot,
    })));
    if (m > peak) peak = m;
  }
  return peak;
}

// Re-resolve a leg's strike at a LATER point in the day (used by RE ASAP re-entry
// and reverse re-entry). AlgoTest's "RE ASAP" does NOT re-enter the stopped-out
// absolute strike — it re-runs the leg's selection rule (ATM±N, delta, premium…)
// against the CURRENT spot, so on a trending day the replacement sits at a fresh
// strike (verified against AlgoTest: a stopped-out ATM-2 PUT 26100 re-enters at
// 26000 after spot fell ~100 pts). Returns the new strike's intraday series keyed
// from `atTs`, plus the entry bar at `atTs`. Caches make the loads cheap.
async function resolveSlotStrike(
  leg: Leg, cfg: BacktestConfig, date: string, atTs: number, atHHMM: string, atSpot: number,
): Promise<{ strike: number; expiry: string; byTs: Map<number, Bar>; bar: Bar } | null> {
  const res = await resolveExpiry(cfg.underlying, leg.expiry.flag, date, leg.expiry.offset);
  if (!res) return null;
  const legDay = await loadExpiryDay(cfg.underlying, res.expiry, res.flag, date);
  if (!legDay.strikes.length) return null;
  const strike = chooseStrike(leg.strike, legDay, leg.optionType, atSpot, atHHMM, date, res.expiry);
  if (strike == null) return null;
  const dayBars = (leg.optionType === 'CALL' ? legDay.call : legDay.put).get(strike);
  if (!dayBars || !dayBars.length) return null;
  const byTs = new Map<number, Bar>();
  for (const b of dayBars) if (b.ts >= atTs) byTs.set(b.ts, b);
  const bar = byTs.get(atTs);
  if (!bar || !Number.isFinite(bar.close)) return null;
  return { strike, expiry: res.expiry, byTs, bar };
}

async function simulateDay(
  cfg: BacktestConfig, legs: Leg[], date: string, extMult = 1, collectSeries = false,
): Promise<{ trade: DayTrade; series?: IntradayPoint[] } | null> {
  const slip = cfg.slippagePct / 100;
  const filters: EntryFilters = cfg.entryFilters ?? {};
  const series: IntradayPoint[] = [];

  // 1) reference expiry/strike grid from leg[0]; scan strikes centre-out to the
  //    first contract with bars today (far-OTM strikes are illiquid/missing).
  const ref = legs[0];
  const refRes = await resolveExpiry(cfg.underlying, ref.expiry.flag, date, ref.expiry.offset);
  if (!refRes) return null;

  // DTE filter on the reference expiry
  const refDte = dte(date, refRes.expiry);
  if (filters.dteMin != null && refDte < filters.dteMin) return null;
  if (filters.dteMax != null && refDte > filters.dteMax) return null;

  const refDay = await loadExpiryDay(cfg.underlying, refRes.expiry, refRes.flag, date);
  if (!refDay.strikes.length) return null;

  // Master clock + reference premium: the near-ATM strike whose stitched CALL
  // series covers the most of the session (stays liquid all day). Spot is read
  // off this series; per-leg strikes are resolved separately below.
  let refDayBars: Bar[] | undefined;
  let entryBar: Bar | null = null;
  for (const s of refDay.strikes) {
    const db = refDay.call.get(s);
    if (!db || !db.length) continue;
    const eb = firstBarFrom(db, cfg.entryTime);
    if (!eb || !Number.isFinite(eb.close)) continue;
    if (!refDayBars || db.length > refDayBars.length) { refDayBars = db; entryBar = eb; }
  }
  if (!refDayBars || !entryBar) return null; // holiday / no data

  // IV filter on the reference contract at entry
  if (filters.ivMin != null && entryBar.iv < filters.ivMin) return null;
  if (filters.ivMax != null && entryBar.iv > filters.ivMax) return null;

  // wait-&-trade: delay entry until reference premium moves waitTradePct from entryTime
  if (filters.waitTradePct != null && filters.waitTradePct > 0) {
    const base = entryBar.close;
    let hit: Bar | null = null;
    for (const b of refDayBars) {
      if (b.ts < entryBar.ts) continue;
      if (b.hhmm > cfg.exitTime) break;
      if (base > 0 && Math.abs(b.close - base) / base * 100 >= filters.waitTradePct) { hit = b; break; }
    }
    if (!hit) return null; // condition never met today
    entryBar = hit;
  }

  const entryTs   = entryBar.ts;
  const entrySpot = entryBar.spot;
  const entryHHMM = entryBar.hhmm;

  // 2) build a slot per leg
  const slots: Slot[] = [];
  let combinedEntryPremium = 0;
  for (const leg of legs) {
    const res = await resolveExpiry(cfg.underlying, leg.expiry.flag, date, leg.expiry.offset);
    if (!res) return null;
    const legDay = await loadExpiryDay(cfg.underlying, res.expiry, res.flag, date);
    if (!legDay.strikes.length) return null;
    const strike = chooseStrike(leg.strike, legDay, leg.optionType, entrySpot, entryHHMM, date, res.expiry);
    if (strike == null) return null;
    const dayBars = (leg.optionType === 'CALL' ? legDay.call : legDay.put).get(strike);
    if (!dayBars || !dayBars.length) return null;
    const eBar = firstBarFrom(dayBars, entryHHMM);
    if (!eBar || !Number.isFinite(eBar.close)) return null;

    const byTs = new Map<number, Bar>();
    for (const b of dayBars) if (b.ts >= entryTs) byTs.set(b.ts, b);

    const slot: Slot = {
      leg, strike, expiry: res.expiry, lots: leg.lots, qty: leg.lots * cfg.lotSize, byTs,
      episodes: [], open: false, side: leg.side, entryRaw: 0, entryFill: 0,
      entryTime: entryHHMM, entryTs: 0, entrySpot: eBar.spot, slPrice: null, tgtPrice: null,
      slSpot: null, tgtSpot: null, bull: false, lastRaw: eBar.close, seq: 0, reentriesUsed: 0,
      highAfterEntry: 0, lowAfterEntry: 999999,
    };
    openPosition(slot, leg.side, eBar, slip, cfg);
    combinedEntryPremium += eBar.close;
    slots.push(slot);
  }

  // premium-band filter (combined per-unit entry premium of all legs)
  if (filters.premiumMin != null && combinedEntryPremium < filters.premiumMin) return null;
  if (filters.premiumMax != null && combinedEntryPremium > filters.premiumMax) return null;

  // ── position sizing — scale every leg's lots for this day ──────────────────
  // extMult carries cross-day state (MARTINGALE streak); sizeMult is intraday
  // (CAPITAL_PERCENT premium-at-risk, VOLATILITY_TARGET inverse-IV).
  const sizing = cfg.sizing;
  let sizeMult = 1;
  if (sizing) {
    if (sizing.mode === 'CAPITAL_PERCENT' && sizing.capital && sizing.riskPct) {
      const perLotSetRisk = combinedEntryPremium * cfg.lotSize; // ₹ premium for 1× of each leg
      const budget = sizing.capital * (sizing.riskPct / 100);
      if (perLotSetRisk > 0) sizeMult = budget / perLotSetRisk;
    } else if (sizing.mode === 'VOLATILITY_TARGET' && sizing.baselineIv) {
      const refIv = entryBar.iv;
      if (refIv > 0) sizeMult = sizing.baselineIv / refIv;
    }
  }
  let totalMult = extMult * sizeMult;
  if (!(totalMult > 0)) totalMult = 1;
  if (sizing?.maxLots && totalMult > sizing.maxLots) totalMult = sizing.maxLots;
  if (totalMult !== 1) {
    for (const slot of slots) {
      slot.lots = Math.max(1, Math.round(slot.leg.lots * totalMult));
      slot.qty = slot.lots * cfg.lotSize;
    }
  }

  // margin required to enter — captured now, from the initial legs only, before
  // any adjustment appends replacement slots (which would otherwise double-count).
  const marginRequired = estimateMargin(slots.map((s) => ({
    optionType: s.leg.optionType, side: s.side, strike: s.strike,
    qty: s.qty, premium: s.entryRaw, spot: s.entrySpot,
  })));

  // 3) timeline: reference bars from entry to exitTime
  const timeline = refDayBars.filter((b) => b.ts >= entryTs && b.hhmm <= cfg.exitTime);
  let portfolioReason: ExitReason | null = null;
  const adjs: Adjustment[] = (cfg.adjustments ?? []).filter(a => a.enabled);
  let adjUsed = 0;
  // pending adjustment: waiting N bars before entering replacement legs
  let adjPending: { adj: Adjustment; barsLeft: number; spot: number; hhmm: string } | null = null;

  for (const tb of timeline) {
    const ts = tb.ts;
    let legSlHit = false, legTgtHit = false;

    for (const slot of slots) {
      // Pending RE ASAP / REVERSE re-entry: re-select the strike at the CURRENT spot
      // and enter on this bar. Handled BEFORE the old strike's bar-existence guard
      // because the replacement may sit on a different strike than the one that
      // stopped out (and the old strike could even have a data gap this minute).
      if (!slot.open && slot.pending && !adjPending &&
          (slot.pending.mode === 'ASAP' || slot.pending.mode === 'REVERSE_ASAP')) {
        const p = slot.pending;
        const re = await resolveSlotStrike(slot.leg, cfg, date, ts, tb.hhmm, tb.spot);
        if (re) {
          slot.strike = re.strike; slot.expiry = re.expiry; slot.byTs = re.byTs;
          slot.seq += 1; slot.reentriesUsed += 1; slot.pending = undefined;
          openPosition(slot, p.side, re.bar, slip, cfg);
        }
        continue; // entered (or retry next bar); nothing else to do for this slot
      }

      const bar = slot.byTs.get(ts);
      if (!bar || !Number.isFinite(bar.close)) continue; // missing / NaN minute — treat as no data

      if (slot.open) {
        // No look-ahead: we entered at this bar's close, so its high/low predate the fill.
        if (ts === slot.entryTs) { slot.lastRaw = bar.close; continue; }
        slot.lastRaw = bar.close;
        if (bar.high > slot.highAfterEntry) slot.highAfterEntry = bar.high;
        if (bar.low < slot.lowAfterEntry) slot.lowAfterEntry = bar.low;

        const decision = evaluateExit(slot, bar, date);
        if (decision) {
          closePosition(slot, decision.price, decision.reason, bar.hhmm, slip);
          if (decision.kind === 'SL') legSlHit = true; else legTgtHit = true;
          if (!adjPending) scheduleReentry(slot);
        } else {
          // Tighten the trailing stop only AFTER the exit check, so a tightened
          // level can never trigger on the same bar that set it (within-bar look-ahead).
          applyTrail(slot, bar);
        }
      } else if (slot.pending && !adjPending && slot.pending.mode === 'COST') {
        // RE COST stays on the SAME strike and waits for its premium to trade back
        // through the original entry cost (ASAP/REVERSE were handled above).
        const p = slot.pending;
        if (bar.low <= p.refPrice && bar.high >= p.refPrice) {
          slot.seq += 1;
          slot.reentriesUsed += 1;
          slot.pending = undefined;
          openPosition(slot, p.side, bar, slip, cfg);
        }
      }
    }

    // ── Adjustment trigger check ──────────────────────────────────────────────
    // After processing all slots this bar, check if an adjustment should fire.
    if (!adjPending && adjs.length > 0) {
      for (const adj of adjs) {
        const max = adj.maxAdjustments ?? 1;
        if (adjUsed >= max) continue;
        let fire = false;
        if (adj.trigger === 'ON_ANY_LEG_SL' && legSlHit) fire = true;
        if (adj.trigger === 'ON_ANY_LEG_TGT' && legTgtHit) fire = true;
        // portfolio triggers checked below
        if (fire) {
          // exit ALL remaining open slots immediately (complete square-off) at the
          // trigger bar's open — AlgoTest closes the non-SL legs at this same instant.
          for (const slot of slots) {
            if (slot.open) closePosition(slot, slotFillAt(slot, ts), 'STOPLOSS', tb.hhmm, slip);
            slot.pending = undefined;
          }
          adjUsed++;
          const delay = adj.delayBars ?? 0;
          if (delay > 0) {
            adjPending = { adj, barsLeft: delay, spot: tb.spot, hhmm: tb.hhmm };
          } else {
            // enter replacement legs immediately on next bar (handled below)
            adjPending = { adj, barsLeft: 0, spot: tb.spot, hhmm: tb.hhmm };
          }
          break; // only one adjustment per bar
        }
      }
    }

    // ── Process pending adjustment entry ─────────────────────────────────────
    if (adjPending) {
      if (adjPending.barsLeft <= 0) {
        // Enter replacement legs using current spot for strike selection
        const replLegs = adjPending.adj.replacementLegs.filter(l => l.enabled);
        for (const rLeg of replLegs) {
          // find if we can reuse an existing slot or need to add one
          // for simplicity, add as new slots
          const res = await resolveExpiry(cfg.underlying, rLeg.expiry.flag, date, rLeg.expiry.offset);
          if (!res) continue;
          const adjDay = await loadExpiryDay(cfg.underlying, res.expiry, res.flag, date);
          if (!adjDay.strikes.length) continue;
          const adjSpot = tb.spot;
          const strike = chooseStrike(rLeg.strike, adjDay, rLeg.optionType, adjSpot, tb.hhmm, date, res.expiry);
          if (strike == null) continue;
          const dayBars = (rLeg.optionType === 'CALL' ? adjDay.call : adjDay.put).get(strike);
          if (!dayBars || !dayBars.length) continue;
          const byTs2 = new Map<number, Bar>();
          for (const b of dayBars) if (b.ts >= ts) byTs2.set(b.ts, b);
          const adjBar = byTs2.get(ts);
          if (!adjBar) continue;
          const newSlot: Slot = {
            leg: rLeg, strike, expiry: res.expiry,
            lots: rLeg.lots, qty: rLeg.lots * cfg.lotSize, byTs: byTs2,
            episodes: [], open: false, side: rLeg.side,
            entryRaw: 0, entryFill: 0, entryTime: tb.hhmm, entryTs: 0, entrySpot: adjBar.spot,
            slPrice: null, tgtPrice: null, slSpot: null, tgtSpot: null,
            bull: false, lastRaw: adjBar.close, seq: 0, reentriesUsed: 0,
            highAfterEntry: 0, lowAfterEntry: 999999,
          };
          openPosition(newSlot, rLeg.side, adjBar, slip, cfg);
          slots.push(newSlot);
        }
        adjPending = null;
      } else {
        adjPending.barsLeft--;
      }
    }

    // intraday MTM snapshot (only when a single-day detail view requested it)
    if (collectSeries) {
      let total = 0;
      const legPts: IntradayLegPoint[] = [];
      for (const slot of slots) {
        let legPnl = 0;
        for (const e of slot.episodes) legPnl += episodeGross(e);
        const bar = slot.byTs.get(ts);
        const raw = bar && Number.isFinite(bar.close) ? bar.close : slot.lastRaw;
        if (slot.open) legPnl += openGross(slot, raw);
        total += legPnl;
        legPts.push({ legId: slot.leg.id, seq: slot.seq, pnl: round2(legPnl), price: round2(raw) });
      }
      series.push({ hhmm: tb.hhmm, spot: round2(tb.spot), total: round2(total), legs: legPts });
    }

    // portfolio MTM across open + realised episodes this day
    const pr = cfg.portfolioRisk;
    if (pr && (pr.maxProfit || pr.maxLoss)) {
      let mtm = 0;
      for (const slot of slots) {
        for (const e of slot.episodes) mtm += episodeGross(e);
        if (slot.open) mtm += openGross(slot, slot.lastRaw);
      }
      if (pr.maxProfit && mtm >= pr.maxProfit) portfolioReason = 'PORTFOLIO_TP';
      else if (pr.maxLoss && mtm <= -Math.abs(pr.maxLoss)) portfolioReason = 'PORTFOLIO_SL';
      if (portfolioReason) {
        // check portfolio-level adjustment triggers before breaking
        let adjFired = false;
        if (!adjPending && adjs.length > 0) {
          for (const adj of adjs) {
            if (adjUsed >= (adj.maxAdjustments ?? 1)) continue;
            if ((adj.trigger === 'ON_PORTFOLIO_SL' && portfolioReason === 'PORTFOLIO_SL') ||
                (adj.trigger === 'ON_PORTFOLIO_TP' && portfolioReason === 'PORTFOLIO_TP')) {
              for (const slot of slots) if (slot.open) closePosition(slot, slotFillAt(slot, ts), portfolioReason, tb.hhmm, slip);
              adjUsed++;
              adjPending = { adj, barsLeft: adj.delayBars ?? 0, spot: tb.spot, hhmm: tb.hhmm };
              adjFired = true;
              portfolioReason = null; // don't break — let adjustment handle it
              break;
            }
          }
        }
        if (!adjFired) {
          for (const slot of slots) if (slot.open) closePosition(slot, slotFillAt(slot, ts), portfolioReason!, tb.hhmm, slip);
          break;
        }
      }
    }
  }

  // 4) EOD square-off for anything still open
  const lastBar = timeline.length ? timeline[timeline.length - 1] : entryBar;
  for (const slot of slots) {
    if (!slot.open) continue;
    closePosition(slot, slotFillAt(slot, lastBar.ts), 'EOD', lastBar.hhmm, slip);
  }

  // 5) tally — one result row per episode
  const legResults: TradeLegResult[] = [];
  const allEpisodes: Episode[] = [];
  let grossPnl = 0, netPnl = 0;
  for (const slot of slots) {
    for (const e of slot.episodes) {
      allEpisodes.push(e);
      const gross = episodeGross(e);
      const net = episodeNet(e);
      grossPnl += gross; netPnl += net;
      // guard against the sentinel seeds ever leaking if a slot skipped openPosition
      const hi = e.highAfterEntry > 0 ? e.highAfterEntry : e.entryRaw;
      const lo = e.lowAfterEntry < 999999 ? e.lowAfterEntry : e.entryRaw;
      legResults.push({
        legId: slot.leg.id, optionType: e.optionType, side: e.side, strike: e.strike,
        expiry: e.expiry, lots: slot.lots, entryTime: e.entryTime, exitTime: e.exitTime,
        entryPrice: round2(e.entryFill), exitPrice: round2(e.exitFill), entrySpot: round2(e.entrySpot),
        pnl: round2(net), exitReason: e.exitReason, seq: e.seq,
        highAfterEntry: round2(hi), lowAfterEntry: round2(lo),
      });
    }
  }

  // 5b) final realised MTM snapshot (anchors the intraday curve to grossPnl)
  if (collectSeries) {
    let total = 0;
    const legPts: IntradayLegPoint[] = [];
    for (const slot of slots) {
      let legPnl = 0;
      for (const e of slot.episodes) legPnl += episodeGross(e);
      total += legPnl;
      legPts.push({ legId: slot.leg.id, seq: slot.seq, pnl: round2(legPnl), price: round2(slot.lastRaw) });
    }
    series.push({ hhmm: lastBar.hhmm, spot: round2(lastBar.spot), total: round2(total), legs: legPts });
  }

  const slippageCost = grossPnl - netPnl;
  const charges = computeCharges(
    allEpisodes.map((e) => ({ entryRaw: e.entryRaw, exitRaw: e.exitRaw, side: e.side, qty: e.qty })),
    cfg.underlying, slippageCost,
  );
  const costs = charges.total;
  const pnl = grossPnl - costs;
  const maxMargin = Math.max(marginRequired, peakConcurrentMargin(allEpisodes));

  // ROI on the margin that was blocked to enter the trade.
  const roiPct = marginRequired > 0 ? round2((pnl / marginRequired) * 100) : 0;

  const exitReason: ExitReason = portfolioReason
    ?? dominantReason(legResults.map((r) => r.exitReason), pnl);

  const trade: DayTrade = {
    date, entrySpot: round2(entrySpot), exitSpot: round2(lastBar.spot),
    legs: legResults, grossPnl: round2(grossPnl), costs: round2(costs),
    pnl: round2(pnl), cumPnl: 0, exitReason,
    margin: round2(marginRequired), maxMargin: round2(maxMargin), roiPct, charges,
  };
  return collectSeries ? { trade, series } : { trade };
}

// Decide whether (and how) to queue a re-entry after a slot just closed.
function scheduleReentry(slot: Slot): void {
  const re = slot.leg.reentry;
  if (!re || re.mode === 'NONE') return;
  const max = re.max ?? 0;
  if (slot.reentriesUsed >= max) return;
  const last = slot.episodes[slot.episodes.length - 1];
  if (!last) return;
  const wasSL = last.exitReason === 'STOPLOSS' || last.exitReason === 'TRAIL_SL';
  const wasTgt = last.exitReason === 'TARGET';
  const onSL = re.onStopLoss ?? true;
  const onTgt = re.onTarget ?? false;
  if (wasSL && !onSL) return;
  if (wasTgt && !onTgt) return;
  if (!wasSL && !wasTgt) return; // don't re-enter EOD / portfolio exits

  if (re.mode === 'REVERSE_ASAP') {
    slot.pending = { mode: 'REVERSE_ASAP', side: last.side === 'SELL' ? 'BUY' : 'SELL', refPrice: last.entryRaw };
  } else if (re.mode === 'COST') {
    slot.pending = { mode: 'COST', side: last.side, refPrice: last.entryRaw };
  } else {
    slot.pending = { mode: 'ASAP', side: last.side, refPrice: last.entryRaw };
  }
}

// Summarise a day's per-leg exit reasons into one label. NEVER fabricate a reason
// that didn't occur: if no leg hit a target, the day is not a TARGET day even when
// it ended profitable (a leg can stop out while the other rides to EOD in profit).
function dominantReason(reasons: ExitReason[], pnl: number): ExitReason {
  if (!reasons.length) return 'EOD';
  const has = (r: ExitReason) => reasons.includes(r);
  const sl = has('STOPLOSS') || has('TRAIL_SL');
  const tgt = has('TARGET');
  // Both a target and a stop fired on different legs → break by the day's sign.
  if (sl && tgt) return pnl >= 0 ? 'TARGET' : (has('TRAIL_SL') ? 'TRAIL_SL' : 'STOPLOSS');
  if (tgt) return 'TARGET';
  if (sl) return has('TRAIL_SL') ? 'TRAIL_SL' : 'STOPLOSS';
  return 'EOD';
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export async function runDays(
  cfg: BacktestConfig, dates: string[],
): Promise<{ trades: DayTrade[]; warnings: string[]; scanned: number }> {
  const legs = cfg.legs.filter((l) => l.enabled);
  const trades: DayTrade[] = [];
  const warnings: string[] = [];
  let cum = 0, skipped = 0;
  const martingale = cfg.sizing?.mode === 'MARTINGALE';
  const mFactor = cfg.sizing?.factor && cfg.sizing.factor > 0 ? cfg.sizing.factor : 2;
  let consecLosses = 0;
  for (const date of dates) {
    let day: DayTrade | null = null;
    const extMult = martingale ? Math.pow(mFactor, consecLosses) : 1;
    try {
      const res = await simulateDay(cfg, legs, date, extMult);
      day = res ? res.trade : null;
    } catch (e) {
      if (warnings.length < 20) warnings.push(`${date}: ${(e as Error).message}`);
    }
    if (day) {
      cum += day.pnl; day.cumPnl = round2(cum); trades.push(day);
      if (martingale) consecLosses = day.pnl < 0 ? consecLosses + 1 : 0;
    } else skipped++;
  }
  if (skipped) warnings.push(`${skipped} day(s) skipped (holiday / no data / entry filter not met).`);
  return { trades, warnings, scanned: dates.length };
}

// Single-day detailed run: returns the day's trade plus its minute-by-minute P&L
// curve (for the trade-detail view). cumPnl is left at 0 (single-day scope).
export async function runSingleDay(
  cfg: BacktestConfig, date: string,
): Promise<{ trade: DayTrade; series: IntradayPoint[] } | null> {
  const legs = cfg.legs.filter((l) => l.enabled);
  const res = await simulateDay(cfg, legs, date, 1, true);
  if (!res) return null;
  return { trade: res.trade, series: res.series ?? [] };
}
