/** Select by plotted x coordinate; index interpolation is wrong for uneven samples. */
export function nearestPointIndex(xs: readonly number[], target: number): number {
  let best = -1;
  let distance = Infinity;
  xs.forEach((x, i) => {
    const next = Math.abs(x - target);
    if (Number.isFinite(x) && next < distance) { best = i; distance = next; }
  });
  return best;
}

/** Missing observations form gaps, not fabricated connections between samples. */
export function finiteSegments(xs: readonly number[], ys: readonly unknown[]): number[][] {
  const segments: number[][] = [];
  let segment: number[] = [];
  xs.forEach((x, i) => {
    if (Number.isFinite(x) && typeof ys[i] === 'number' && Number.isFinite(ys[i])) {
      segment.push(i);
    } else if (segment.length) { segments.push(segment); segment = []; }
  });
  if (segment.length) segments.push(segment);
  return segments;
}
