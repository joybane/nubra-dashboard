/**
 * Grid math for `ChartNavigator`: positions on a sorted, minute-spaced list of chart times.
 * Kept out of the component file so it can be unit-tested (and so fast refresh keeps working).
 */

export const MINUTE = 60;

/** Fractional position of `t` on a sorted, minute-spaced grid (clamped to its ends). */
export function timeToIndex(times: readonly number[], t: number): number {
  const n = times.length;
  if (!n) return 0;
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1 + Math.min(1, (t - times[n - 1]) / MINUTE);
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo + Math.min(1, (t - times[lo]) / MINUTE);
}

/** Inverse of `timeToIndex`: a fractional grid position back to a chart time. */
export function indexToTime(times: readonly number[], idx: number): number {
  const n = times.length;
  if (!n) return 0;
  const clamped = Math.max(0, Math.min(n, idx));
  const i = Math.min(n - 1, Math.floor(clamped));
  return times[i] + (clamped - i) * MINUTE;
}
