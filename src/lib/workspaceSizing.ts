/** Reserve a usable chart above the terminal, including on short desktop windows. */
export function terminalHeight(requested: number, available: number) {
  const max = Math.max(40, available - Math.min(200, available * 0.4));
  const min = Math.min(120, max);
  return Math.min(max, Math.max(min, requested));
}

/** Clamp the transfer, not each side independently: the total must stay constant. */
export function resizePair(first: number, second: number, deltaPercent: number) {
  const transfer = Math.max(15 - first, Math.min(second - 15, deltaPercent));
  return [first + transfer, second - transfer];
}
