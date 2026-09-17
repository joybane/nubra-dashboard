import { describe, expect, it } from 'vitest';
import { finiteSegments, nearestPointIndex } from './svgChartGeometry';

describe('chart hover selection', () => {
  it('selects the closest plotted sample with uneven or descending x values', () => {
    expect(nearestPointIndex([0, 1, 100], 2)).toBe(1);
    expect(nearestPointIndex([100, 1, 0], 2)).toBe(1);
    expect(nearestPointIndex([NaN, 20, Infinity], 21)).toBe(1);
    expect(nearestPointIndex([], 10)).toBe(-1);
  });
});
describe('chart gaps', () => {
  it('breaks paths at null, infinite and invalid observations', () => {
    expect(finiteSegments([0, 1, 2, 3, 4, 5, 6], [10, 11, null, 13, Infinity, 15, 16])).toEqual([[0, 1], [3], [5, 6]]);
    expect(finiteSegments([0, NaN, 2], [1, 2, 3])).toEqual([[0], [2]]);
    expect(finiteSegments([0, 1], [null, undefined])).toEqual([]);
  });
});
