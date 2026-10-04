import { describe, expect, it } from 'vitest';
import { resizePair, terminalHeight } from './workspaceSizing';

describe('workspace sizing', () => {
  it('preserves usable chart space on an extreme terminal drag', () => {
    expect(terminalHeight(2000, 700)).toBe(500);
    expect(terminalHeight(-50, 700)).toBe(120);
    expect(terminalHeight(220, 700)).toBe(220);
  });
  it('fits short windows without a minimum taller than the available space', () => {
    expect(terminalHeight(220, 150)).toBe(90);
    expect(terminalHeight(600, 400)).toBe(240);
  });
  it('keeps split proportions bounded and totals stable after repeated drags', () => {
    expect(resizePair(50, 50, 100)).toEqual([85, 15]);
    expect(resizePair(85, 15, 5)).toEqual([85, 15]);
    expect(resizePair(85, 15, -100)).toEqual([15, 85]);
    expect(resizePair(15, 85, 10)).toEqual([25, 75]);
  });
});
