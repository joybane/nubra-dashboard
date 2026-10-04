import { describe, expect, it } from 'vitest';
import { indexToTime, timeToIndex } from './navigatorMath';

// Two sessions' tails on a minute grid, with the overnight gap between them.
const DAY1 = [1000 * 60, 1001 * 60, 1002 * 60];
const DAY2 = [2000 * 60, 2001 * 60];
const GRID = [...DAY1, ...DAY2];

describe('navigatorMath', () => {
  it('places a time inside a minute fractionally', () => {
    expect(timeToIndex(GRID, 1001 * 60 + 30)).toBeCloseTo(1.5);
  });

  it('collapses the overnight gap: the gap maps onto the end of the last bar before it', () => {
    expect(timeToIndex(GRID, 1500 * 60)).toBe(3); // 2 + a full minute, i.e. the next session's start
    expect(timeToIndex(GRID, 2000 * 60)).toBe(3);
  });

  it('clamps to the ends', () => {
    expect(timeToIndex(GRID, 0)).toBe(0);
    expect(timeToIndex(GRID, 9e9)).toBe(GRID.length);
    expect(indexToTime(GRID, -5)).toBe(GRID[0]);
    expect(indexToTime(GRID, 99)).toBe(GRID[GRID.length - 1] + 60);
  });

  it('round-trips positions on the grid', () => {
    for (const idx of [0, 0.25, 1, 2.5, 3, 4.75])
      expect(timeToIndex(GRID, indexToTime(GRID, idx))).toBeCloseTo(idx);
  });

  it('handles an empty grid', () => {
    expect(timeToIndex([], 123)).toBe(0);
    expect(indexToTime([], 3)).toBe(0);
  });
});
