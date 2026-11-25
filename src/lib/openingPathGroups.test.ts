import { describe, expect, it } from 'vitest';
import { OPENING_SESSION_MINUTES, type OpeningGrid } from './openingStrangle';
import {
  classifyOpeningPath,
  diagnoseOpeningPath,
  validOpeningMoveCutoff,
} from './openingPathGroups';

const END = OPENING_SESSION_MINUTES - 1;

function marks(path: number[], close: number | null): OpeningGrid {
  const pnl: OpeningGrid = Array(OPENING_SESSION_MINUTES).fill(0);
  path.forEach((mark, i) => {
    pnl[i + 1] = mark;
  });
  pnl[END] = close;
  return pnl;
}

function group(path: number[], close: number, cutoff = 25) {
  return classifyOpeningPath({ entry: 0, entryCredit: 100, close }, marks(path, close), cutoff);
}

describe('opening strangle curve movement', () => {
  it('separates paths with the same close and respects the order of zones', () => {
    expect(group([40, 35], 30)).toBe('roseHeld');
    expect(group([-35], 30)).toBe('fellRecoveredNonnegative');
    expect(group([35], -30)).toBe('roseFadedNonpositive');
    expect(group([-35, -39], -30)).toBe('fellStayed');
  });

  it('splits cross-zone recoveries and givebacks by the gross closing mark', () => {
    expect(group([-35, 35], -1)).toBe('fellRecoveredNegative');
    expect(group([-35, 35], 0)).toBe('fellRecoveredNonnegative');
    expect(group([-35, 35], 1)).toBe('fellRecoveredNonnegative');
    expect(group([35, -35], 1)).toBe('roseFadedPositive');
    expect(group([35, -35], 0)).toBe('roseFadedNonpositive');
    expect(group([35, -35], -1)).toBe('roseFadedNonpositive');
  });

  it('counts zone alternation across neutral marks without treating neutral as a reversal', () => {
    expect(group([-25, 0, 25, 0, -26], -30)).toBe('swings');
    expect(group([25, -25, 26], 30)).toBe('swings');
    expect(group([25, 0, 10, 25], 30)).toBe('roseHeld');
  });

  it('recognizes material partial recoveries and givebacks inside a single zone', () => {
    expect(group([-80], -40)).toBe('fellRecoveredNegative');
    expect(group([-80], -40.01)).toBe('fellStayed');
    expect(group([-30], -5)).toBe('fellRecoveredNegative');
    expect(group([-30], 0)).toBe('fellRecoveredNonnegative');
    expect(group([-30], 5)).toBe('fellRecoveredNonnegative');
    expect(group([80], 40)).toBe('roseFadedPositive');
    expect(group([80], 40.01)).toBe('roseHeld');
    expect(group([30], 5)).toBe('roseFadedPositive');
    expect(group([30], 0)).toBe('roseFadedNonpositive');
    expect(group([30], -5)).toBe('roseFadedNonpositive');
  });

  it('uses the exact path close for the outcome split', () => {
    expect(
      classifyOpeningPath({ entry: 0, entryCredit: 100, close: -5 }, marks([-35], 0), 25),
    ).toBe('fellRecoveredNonnegative');
  });

  it('includes exact cutoff touches and accepts any positive finite cutoff', () => {
    expect(group([24.99, -24.99], 20)).toBe('small');
    expect(group([25], 25)).toBe('roseHeld');
    expect(group([-25], -25)).toBe('fellStayed');
    expect(group([25], 25, 25.01)).toBe('small');
    expect(validOpeningMoveCutoff(0.01)).toBe(true);
    for (const cutoff of [0, -1, NaN, Infinity]) {
      expect(validOpeningMoveCutoff(cutoff)).toBe(false);
      expect(group([40], 40, cutoff)).toBe('insufficient');
    }
  });

  it('requires ninety percent coverage after the actual entry and an exact closing mark', () => {
    const pnl = marks([35], 25);
    const day = { entry: 5, entryCredit: 100, close: 25 };
    pnl[2] = -50;
    for (let i = day.entry; i < day.entry + 37; i++) pnl[i] = null;
    expect(classifyOpeningPath(day, pnl, 25)).toBe('roseHeld');
    pnl[42] = null;
    expect(classifyOpeningPath(day, pnl, 25)).toBe('insufficient');
    expect(classifyOpeningPath(day, marks([40], null), 25)).toBe('insufficient');
    expect(classifyOpeningPath({ ...day, close: null }, marks([40], 25), 25)).toBe('insufficient');
    expect(classifyOpeningPath({ ...day, entryCredit: 0 }, marks([40], 25), 25)).toBe(
      'insufficient',
    );
    expect(classifyOpeningPath(day, undefined, 25)).toBe('insufficient');
  });

  it('diagnoses missing close and low coverage independently at the coverage boundary', () => {
    const pnl = marks([], null);
    const day = { entry: 0, entryCredit: 100, close: null };
    pnl.fill(null, 1, 37);
    expect(diagnoseOpeningPath(day, pnl)).toEqual({
      issues: ['missingClose'],
      coverage: { observed: 338, possible: 375, lastCompleteMinute: 373 },
    });
    pnl[37] = NaN;
    expect(diagnoseOpeningPath(day, pnl)).toEqual({
      issues: ['missingClose', 'lowCoverage'],
      coverage: { observed: 337, possible: 375, lastCompleteMinute: 373 },
    });
    pnl[38] = Infinity;
    pnl[END] = 0;
    expect(diagnoseOpeningPath({ ...day, close: 0 }, pnl)).toEqual({
      issues: ['lowCoverage'],
      coverage: { observed: 337, possible: 375, lastCompleteMinute: 374 },
    });
  });

  it('identifies unavailable paths and other eligibility issues without inferring coverage', () => {
    expect(diagnoseOpeningPath({ entry: -1, entryCredit: 0, close: 10 }, undefined)).toEqual({
      issues: ['unavailablePath', 'invalidEntry', 'nonpositiveCredit'],
      coverage: undefined,
    });
    const pnl = marks([60], 0);
    pnl[6] = null;
    expect(diagnoseOpeningPath({ entry: 5, entryCredit: 100, close: 0 }, pnl).coverage).toEqual({
      observed: 369,
      possible: 370,
      lastCompleteMinute: 374,
    });
  });
});
