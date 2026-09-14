/**
 * One-shot hand-off into the Nubra BT view: "open this date, this expiry, these legs".
 *
 * Nubra BT keeps its whole configuration in component state and always opens on the previous
 * trading day, so there was no way to arrive at it pre-filled. The sender (the Analysis tab) stores
 * a hand-off here and switches its pane's view; Nubra BT reads it while initialising its state and
 * clears it once applied.
 *
 * Read with `peek` during render and cleared from an effect, never taken in an initialiser:
 * StrictMode renders twice, and a destructive read in the first render would leave the second —
 * the one React keeps — with nothing.
 */

export interface NubraBtHandoffLeg {
  strike: number;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  lots: number;
}

export interface NubraBtHandoff {
  underlying: string;
  date: string;
  expiry: string;
  entryTime: string;
  exitTime: string;
  legs: NubraBtHandoffLeg[];
}

let pending: NubraBtHandoff | null = null;

export function setNubraBtHandoff(handoff: NubraBtHandoff): void {
  pending = handoff;
}

export function peekNubraBtHandoff(): NubraBtHandoff | null {
  return pending;
}

/** Clears only the hand-off it is given, so a newer one sent meanwhile survives. */
export function clearNubraBtHandoff(handoff: NubraBtHandoff | null): void {
  if (handoff && pending === handoff) pending = null;
}
