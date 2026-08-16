import { describe, test, expect } from 'vitest';
import { pickAxisTarget, type AxisCandidate } from './axisFollow';

/** Three lines at fixed heights, standing in for a pane of overlays. */
const vega: AxisCandidate<string> = { key: 'vega', y: 100 };
const theta: AxisCandidate<string> = { key: 'theta', y: 200 };
const iv: AxisCandidate<string> = { key: 'iv', y: 300 };
const lines = [vega, theta, iv];

/** Two lines running close together — the case the stickiness rule exists for. */
const near = [
  { key: 'a', y: 100 },
  { key: 'b', y: 114 },
];

describe('pickAxisTarget', () => {
  test('takes the nearest line when nothing is selected yet', () => {
    expect(pickAxisTarget(lines, 205, null)).toBe('theta');
    expect(pickAxisTarget(lines, 98, null)).toBe('vega');
  });

  test('switches once the cursor is clearly onto another line', () => {
    expect(pickAxisTarget(lines, 300, 'vega')).toBe('iv');
  });

  test('holds the incumbent while the cursor drifts through empty space', () => {
    // 500 is nowhere near any line. Blanking the axis here would mean it vanishes exactly when you
    // move off a line to go and read its ticks.
    expect(pickAxisTarget(lines, 500, 'theta')).toBe('theta');
    // …and with nothing selected there is genuinely nothing to point at.
    expect(pickAxisTarget(lines, 500, null)).toBeNull();
  });

  test('a marginal challenger does not steal the axis — the stickiness rule', () => {
    // Cursor at 108, both lines well within range: b is 6 away, a is 8. b is nearer, but only by
    // 2px, so an axis already on a stays there. Without this, two lines running close together
    // trade the axis back and forth on nothing but cursor jitter.
    expect(pickAxisTarget(near, 108, 'a')).toBe('a');
    // Sit decisively on b and it does hand over.
    expect(pickAxisTarget(near, 114, 'a')).toBe('b');
  });

  test('an incumbent that has left the chart is replaced immediately', () => {
    // 'gone' is not in the candidate list — its measure was switched off. Any line in range wins.
    expect(pickAxisTarget(lines, 205, 'gone')).toBe('theta');
  });

  test('an incumbent out of range loses to anything within it', () => {
    // Cursor is on iv (300); the incumbent vega is 200px away, well past maxDistance, so it has no
    // claim to stickiness.
    expect(pickAxisTarget(lines, 300, 'vega')).toBe('iv');
  });

  test('no cursor means no change — a crosshair event without a point decides nothing', () => {
    expect(pickAxisTarget(lines, null, 'theta')).toBe('theta');
    expect(pickAxisTarget(lines, NaN, 'theta')).toBe('theta');
  });

  test('non-finite candidate positions are skipped, not ranked as nearest', () => {
    const broken = [{ key: 'broken', y: NaN }, theta];
    expect(pickAxisTarget(broken, 205, null)).toBe('theta');
  });

  test('an empty pane keeps whatever was selected', () => {
    expect(pickAxisTarget([], 205, 'theta')).toBe('theta');
    expect(pickAxisTarget([], 205, null)).toBeNull();
  });

  test('the thresholds are tunable, and both are respected', () => {
    // A tight radius makes the axis let go sooner: vega is 30px away, past a 10px reach.
    expect(pickAxisTarget(lines, 130, null, { maxDistancePx: 10 })).toBeNull();
    // Zero stickiness makes it purely nearest-wins, so the same 2px lead that was ignored above
    // now takes the axis.
    expect(pickAxisTarget(near, 108, 'a', { stickinessPx: 0 })).toBe('b');
  });
});
