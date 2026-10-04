/**
 * The Decay matcher (the live tracker in server/mismatchTracker.ts) replayed over one Nubra BT day.
 *
 * The engine is the live one, unchanged, driven the way the live feed drives it: the broker's 1m
 * closes are the "earlier minute" side of every comparison, and the "now" side walks forward from
 * the entry to the end of the exit minute. That walk uses the recorded 1s ticks wherever the broker
 * still holds them — sub-minute history is a rolling 168h — and each minute's close before that,
 * so a day older than a week is still scored, just once a minute instead of once a second.
 *
 * Pure: no I/O, no clock. The route in server/nubraBacktestRoutes.ts fetches and passes `nowMs`.
 */
import {
  StrategyMismatchTracker,
  istMinuteToMs,
  type MismatchCase,
  type StrategyLegs,
} from './mismatchTracker.ts';

/** Sub-minute history is kept for exactly this long (measured 2026-08-03). */
export const TICK_RETENTION_MS = 168 * 3_600_000;
/** Kept clear of the retention edge: a 1s query that straddles it fails as a whole. */
const TICK_EDGE_MARGIN_MS = 5 * 60_000;

type Kind = 'spot' | 'ce' | 'pe';
export type MinuteCloses = Record<Kind, Array<{ minute: number; close: number }>>;
/** Traded seconds (IST seconds past midnight) and their close, in rupees. */
export type SecondCloses = Record<Kind, Array<{ sec: number; close: number }>>;

/**
 * The first IST second of `date` the broker can still serve 1s bars for, or null when none of the
 * window `[fromSec, toSec]` is inside retention. `fromSec` itself when all of it is.
 */
export function tickCoverageStart(
  date: string,
  fromSec: number,
  toSec: number,
  nowMs: number,
): number | null {
  const earliestMs = nowMs - TICK_RETENTION_MS + TICK_EDGE_MARGIN_MS;
  const secMs = (sec: number) => istMinuteToMs(date, 0) + sec * 1000;
  if (earliestMs <= secMs(fromSec)) return fromSec;
  if (earliestMs > secMs(toSec)) return null;
  return Math.ceil((earliestMs - secMs(0)) / 1000);
}

export interface DecayReplayInput {
  legs: StrategyLegs;
  date: string;
  /** Entry and exit minutes, IST minutes past midnight. The exit minute is scored to its end. */
  entryMinute: number;
  exitMinute: number;
  closes: MinuteCloses;
  /** 1s ticks from `tickFromSec` on; null when the day has none left. */
  ticks: SecondCloses | null;
  tickFromSec: number | null;
}

export interface DecayReplayResult {
  cases: MismatchCase[];
  /** How the "now" side was walked. */
  resolution: 'tick' | '1m' | 'mixed';
  /** Number of moments fed to the engine. */
  steps: number;
}

export function replayDecay(input: DecayReplayInput): DecayReplayResult {
  const { legs, date, entryMinute, exitMinute, closes, ticks } = input;
  const tracker = new StrategyMismatchTracker(legs);
  for (const kind of ['spot', 'ce', 'pe'] as const) {
    tracker.setBrokerCloses(date, kind, closes[kind]);
  }

  const firstSec = entryMinute * 60;
  const lastSec = exitMinute * 60 + 59;
  const tickFrom =
    ticks && input.tickFromSec != null ? Math.max(input.tickFromSec, firstSec) : null;
  const minuteUntil = tickFrom ?? lastSec + 1;

  // Moment → whichever prices changed at it. The engine carries the others forward.
  const steps = new Map<number, Partial<Record<Kind, number>>>();
  const put = (sec: number, kind: Kind, close: number) => {
    const at = steps.get(sec);
    if (at) at[kind] = close;
    else steps.set(sec, { [kind]: close });
  };

  // Before the ticks: one moment per minute, at its last second, priced at the minute's close.
  for (const kind of ['spot', 'ce', 'pe'] as const) {
    for (const { minute, close } of closes[kind]) {
      const sec = minute * 60 + 59;
      if (sec >= firstSec && sec < minuteUntil && sec <= lastSec) put(sec, kind, close);
    }
  }
  if (ticks && tickFrom != null) {
    for (const kind of ['spot', 'ce', 'pe'] as const) {
      let seed: number | undefined;
      for (const { sec, close } of ticks[kind]) {
        if (sec < tickFrom) seed = close;
        else if (sec <= lastSec) put(sec, kind, close);
      }
      // The walk opens with every series priced as of its first second: a 1s bar exists only for
      // a second that traded, and an option can be quiet for a while. Without this the engine
      // would score nothing until all three had traded once after the entry.
      seed ??= closes[kind].filter((c) => c.minute * 60 + 59 < tickFrom).at(-1)?.close;
      if (seed != null && steps.get(tickFrom)?.[kind] == null) put(tickFrom, kind, seed);
    }
  }

  const baseMs = istMinuteToMs(date, 0);
  const ordered = [...steps.keys()].sort((a, b) => a - b);
  for (const sec of ordered) tracker.onTick(steps.get(sec)!, baseMs + sec * 1000);

  const resolution = tickFrom == null ? '1m' : tickFrom <= firstSec ? 'tick' : ('mixed' as const);
  return { cases: tracker.cases, resolution, steps: ordered.length };
}

/** The wire shape the client's strips and case card read (src/lib/mismatchCases.ts). */
export function decayCaseDto(c: MismatchCase) {
  return {
    case_no: c.caseNo,
    color_idx: c.colorIdx,
    versions: c.versions.map((v) => ({
      t1_ns: v.t1Ns,
      t2_ns: v.t2Ns,
      spot1: v.spot1,
      spot2: v.spot2,
      ce1: v.ce1,
      ce2: v.ce2,
      pe1: v.pe1,
      pe2: v.pe2,
      ce_delta: v.ceDelta,
      pe_delta: v.peDelta,
      gap: v.gap,
    })),
  };
}
