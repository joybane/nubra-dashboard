import { describe, it, expect } from 'vitest';
import { planResize } from './paneResize';

/**
 * Where a divider drag takes its height from. The rule this replaced only ever took it from the
 * pane that flexes, so hiding the price chart — which promotes a much shorter pane to the flexing
 * one — left every other handle with a few pixels of travel and then nothing, which reads as "the
 * dividers stopped working".
 */
describe('planResize', () => {
  const pane = (height: number, min: number) => ({ height, min });

  it('takes from the pane directly above, not from one further up', () => {
    // price(flex) / pnl(fixed) / greeks(dragged). Growing greeks by 50 must come out of pnl.
    const plan = planResize(50, pane(150, 80), [pane(200, 80)], 400);
    expect(plan.target).toBe(200);
    expect(plan.above).toEqual([150]);
  });

  it('cascades upward once the nearest pane is at its floor', () => {
    const plan = planResize(100, pane(150, 80), [pane(120, 80), pane(300, 80)]);
    expect(plan.target).toBe(250);
    expect(plan.above).toEqual([80, 240]);
  });

  it('falls back to the flexing pane only after the fixed panes are spent', () => {
    const plan = planResize(100, pane(150, 80), [pane(120, 80)], 400);
    // 40 from the pane above down to its floor, the remaining 60 from the flexing pane, which
    // takes whatever is left over and so needs no height of its own.
    expect(plan.target).toBe(250);
    expect(plan.above).toEqual([80]);
  });

  it('stops when every pane above is at its floor and nothing flexes', () => {
    const plan = planResize(200, pane(150, 80), [pane(80, 80)], 0);
    expect(plan.target).toBe(150);
    expect(plan.above).toEqual([80]);
  });

  it('grows into unclaimed height without shrinking anyone', () => {
    // No flexing pane on screen: the stack is short of its column and that gap is free to take.
    const plan = planResize(60, pane(150, 80), [pane(200, 80)], 0, 90);
    expect(plan.target).toBe(210);
    expect(plan.above).toEqual([200]);
  });

  it('spends the unclaimed height first and only then squeezes the pane above', () => {
    const plan = planResize(100, pane(150, 80), [pane(200, 80)], 0, 40);
    expect(plan.target).toBe(250);
    expect(plan.above).toEqual([140]);
  });

  it('hands height back to the pane above when dragged down', () => {
    const plan = planResize(-40, pane(150, 80), [pane(200, 80)], 400);
    expect(plan.target).toBe(110);
    expect(plan.above).toEqual([240]);
  });

  it('shrinks no further than the dragged pane’s own floor', () => {
    const plan = planResize(-500, pane(150, 80), [pane(200, 80)]);
    expect(plan.target).toBe(80);
    expect(plan.above).toEqual([270]);
  });

  it('lets the flexing pane absorb the slack when it is the pane directly above', () => {
    const plan = planResize(-40, pane(150, 80), [], 400);
    expect(plan.target).toBe(110);
    expect(plan.above).toEqual([]);
  });

  it('is a no-op when the drag has not moved', () => {
    const plan = planResize(0, pane(150, 80), [pane(200, 80)], 400);
    expect(plan.target).toBe(150);
    expect(plan.above).toEqual([200]);
  });
});
