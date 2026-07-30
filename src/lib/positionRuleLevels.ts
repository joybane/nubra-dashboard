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
