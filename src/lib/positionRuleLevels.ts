// ─────────────────────────────────────────────────────────────────────────────
// Live position SL/target level math — the single source of truth shared by the
// server (server/positionRules.ts, which actually fires the exits) and the rule
// editor (src/components/PositionRuleEditor.tsx, which previews the resulting
// trigger price). Keeping one implementation is the point: a preview that can
// drift from what fires is worse than no preview at all.
//
// Deliberately self-contained — no imports. The equivalent backtest helper lives
// in server/backtest/engine.ts (`premiumLevels`), but that module pulls in the
// parquet data layer (node fs + hyparquet) and cannot be imported by browser
// code. The PREMIUM_PERCENT / PREMIUM_ABSOLUTE formulas below are byte-for-byte
// the backtest's; positionRuleLevels.test.ts pins them with explicit expected
// values so the two cannot silently diverge.
// ─────────────────────────────────────────────────────────────────────────────

export type LiveSLTargetType =
  | 'NONE'
  | 'PREMIUM_PRICE' // absolute premium level in ₹ — "exit when LTP reaches X"
  | 'PREMIUM_PERCENT' // % of entry premium, moved in the adverse/favourable direction
  | 'PREMIUM_ABSOLUTE'; // ₹ offset from entry, adverse for SL / favourable for target

export interface LiveSLTarget {
  type: LiveSLTargetType;
  value?: number;
}

export type LiveSide = 'BUY' | 'SELL';

// Coerce to a finite number. JSON from the browser can deliver numeric fields as
// strings; without this `entry + "84"` string-concats and the level resolves to
// NaN (mirrors `num()` in server/backtest/engine.ts).
function num(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Resolve SL/target rule definitions to absolute premium levels in ₹.
 *
 * A short position profits as the premium falls, so its stop sits *above* entry
 * and its target *below*; a long is the mirror image. PREMIUM_PRICE is
 * direction-agnostic — the user named the level outright.
 *
 * Returns null for a level that is switched off (type NONE, or no value given).
 */
export function liveLevels(
  side: LiveSide,
  entryRs: number,
  sl: LiveSLTarget | undefined,
  tgt: LiveSLTarget | undefined,
): { slPrice: number | null; tgtPrice: number | null } {
  const sell = side === 'SELL';
  const entry = num(entryRs);
  const pct = (v: number, up: boolean) => (up ? entry * (1 + v / 100) : entry * (1 - v / 100));

  let slPrice: number | null = null;
  let tgtPrice: number | null = null;

  if (sl && sl.value != null) {
    const v = num(sl.value);
    if (sl.type === 'PREMIUM_PRICE') slPrice = v;
    else if (sl.type === 'PREMIUM_PERCENT') slPrice = sell ? pct(v, true) : pct(v, false);
    else if (sl.type === 'PREMIUM_ABSOLUTE') slPrice = sell ? entry + v : entry - v;
  }
  if (tgt && tgt.value != null) {
    const v = num(tgt.value);
    if (tgt.type === 'PREMIUM_PRICE') tgtPrice = v;
    else if (tgt.type === 'PREMIUM_PERCENT') tgtPrice = sell ? pct(v, false) : pct(v, true);
    else if (tgt.type === 'PREMIUM_ABSOLUTE') tgtPrice = sell ? entry - v : entry + v;
  }
  return { slPrice, tgtPrice };
}

// ─── Time-based exit ─────────────────────────────────────────────────────────
// "Square off at 15:15 whether or not the SL/target ever fires." A wall-clock IST
// HH:MM, deliberately not a date: the rule outlives the session it was written in
// (it is persisted in SQLite), and a trader who says "15:15" means 15:15 on
// whichever day the position is still open.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** IST is UTC+5:30 with no DST, so a fixed offset is exact rather than an approximation. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Accept only a well-formed 24-hour HH:MM, and return undefined for everything else.
 *
 * Undefined rather than a thrown error because this is the API boundary's sanitizer: a garbled
 * value means "no time exit", exactly as `sanitizeSLTarget` downgrades an unknown SL type to
 * NONE. Silently arming a rule at a time nobody can predict would be the worse failure.
 */
export function normalizeExitTime(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return HHMM.test(s) ? s : undefined;
}

/** Minutes past IST midnight for an HH:MM, or null if it is not one. */
export function exitTimeMinutes(hhmm: unknown): number | null {
  const s = normalizeExitTime(hhmm);
  if (!s) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
}

/** Wall-clock IST minute-of-day for an instant, independent of the host's own timezone. */
export function istMinuteOfDay(nowMs: number = Date.now()): number {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/**
 * Is a time exit due?
 *
 * True from the configured minute onward, with no upper bound. The bound is deliberately absent:
 * the whole point of the rule is that it still acts on a position nobody closed, and a window
 * would make it silently give up in exactly the cases it exists for — the server was restarting
 * at 15:15, the browser was shut, the feed was quiet. The editor says so in as many words, since
 * arming a time that has already passed therefore exits immediately.
 */
export function exitTimeDue(exitTime: unknown, nowMs: number = Date.now()): boolean {
  const target = exitTimeMinutes(exitTime);
  return target != null && istMinuteOfDay(nowMs) >= target;
}

/**
 * Would this level be hit at `ltpRs`? The comparison direction is the same one
 * `evaluateAndFire` uses, exported so the editor can warn "this exits
 * immediately" instead of letting the user discover it by losing the position.
 */
export function levelHit(
  kind: 'SL' | 'TARGET',
  side: LiveSide,
  level: number | null,
  ltpRs: number,
): boolean {
  if (level == null) return false;
  const sell = side === 'SELL';
  // A short's premium rising is a loss; a long's premium falling is a loss.
  return kind === 'SL'
    ? sell
      ? ltpRs >= level
      : ltpRs <= level
    : sell
      ? ltpRs <= level
      : ltpRs >= level;
}
