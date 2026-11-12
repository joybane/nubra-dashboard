// ─────────────────────────────────────────────────────────────────────────────
// Live LTPs → positions state, at most once per painted frame.
//
// The order terminal and the strategy view each listen to `option_chain` and `position_ltp`, and
// used to call setPositions on every message. The two arrive back to back for the same tick (the
// server derives position_ltp from the chain feed), and each expiry's chain is its own message, so
// one market tick could re-render a several-thousand-line component two or more times. Updates
// that land within one frame now merge into a single setState; a hidden tab (no frames) renders
// nothing until it is shown, then applies the latest prices in one go.
//
// Last write wins per ref_id, which is exactly what applying the messages one by one did.
// ─────────────────────────────────────────────────────────────────────────────

interface HasLtp {
  ref_id: number;
  last_traded_price?: number | null;
}

/** Positions with `ltps` applied; returns `prev` itself when nothing changed so React can bail out. */
export function mergeLtps<T extends HasLtp>(prev: T[], ltps: Map<number, number>): T[] {
  let changed = false;
  const next = prev.map((p) => {
    const v = ltps.get(p.ref_id);
    if (v != null && v !== p.last_traded_price) {
      changed = true;
      return { ...p, last_traded_price: v };
    }
    return p;
  });
  return changed ? next : prev;
}

export interface LtpBatcher {
  /** Queue prices; they are applied on the next animation frame. */
  push(ltps: Map<number, number>): void;
  /** Drop anything queued and cancel the pending frame (call from effect cleanup). */
  cancel(): void;
}

export function createLtpBatcher(apply: (ltps: Map<number, number>) => void): LtpBatcher {
  let pending: Map<number, number> | null = null;
  let handle: number | null = null;
  const flush = () => {
    handle = null;
    const ltps = pending;
    pending = null;
    if (ltps && ltps.size > 0) apply(ltps);
  };
  return {
    push(ltps) {
      if (ltps.size === 0) return;
      pending ??= new Map();
      for (const [k, v] of ltps) pending.set(k, v);
      handle ??= requestAnimationFrame(flush);
    },
    cancel() {
      if (handle != null) cancelAnimationFrame(handle);
      handle = null;
      pending = null;
    },
  };
}
