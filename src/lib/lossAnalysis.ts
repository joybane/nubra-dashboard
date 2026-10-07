/**
 * The Signal Backtest tab's Losses view: losses only, in ₹ per lot, for all days and for each
 * distance from expiry.
 *
 *  - The exit table: exit levels are the worst points that 90 %, 75 % … 5 % of the days actually
 *    reached (and the average worst point) — never round numbers chosen for the person. For each:
 *    the red days, the money lost, the average, median and worst loss, against holding.
 *  - After the hit: for the days that reached a level, how the loss moved from then on, told in the
 *    table's own levels (and zero): fell further to −₹2,090, came back to −₹1,030, fell to a new
 *    low at −₹2,580, recovered to zero, fell back into loss… as a tree. A move is reaching the next
 *    level; it turns when the loss comes back a whole level. Every ₹ figure is a level from the
 *    data or a median / mean of what those days did, every share a count of days.
 *
 * An exit fills at its level, or where the minute began when the loss jumped through it (the same
 * stop path the Stop-loss view uses). Profit is shown as zero loss: the view follows losses only.
 */
import type { SignalBacktestRow } from './signalBacktest';
import { reachedBy, stopHit } from './stopLoss';

/** Rows that carry stop paths and loss series — all of them, unless the server predates the view. */
export const hasLossSeries = (rows: SignalBacktestRow[]): boolean =>
  rows.length > 0 && rows.every((r) => r.trade.stop && r.trade.series);

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export const mean = (values: number[]): number =>
  values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;

/** The day's worst point, ₹ per lot (0 if it never went below entry). */
export const worstPoint = (r: SignalBacktestRow, lots: number): number =>
  (r.trade.stop!.trade.steps.at(-1)?.[1] ?? 0) / lots;

// ── The exit table ────────────────────────────────────────────────────────────

/** The shares of days whose worst point the exit levels are taken at. */
export const EXIT_SHARES = [0.9, 0.75, 0.5, 0.25, 0.1, 0.05] as const;

export interface ExitRow {
  /** 'hold' = no exit; 'share' = the level that share of days reached; 'mean' = the average worst point. */
  kind: 'hold' | 'share' | 'mean';
  share: number | null;
  /** ₹ per lot; null for hold. */
  level: number | null;
  redDays: number;
  redPct: number;
  /** ₹ per lot, positive. */
  lost: number;
  avg: number;
  median: number;
  worst: number;
}

/** The loss of every red day with an exit at ₹ `rupees` for the run's lots (0 = hold), ₹ per lot. */
function redLosses(rows: SignalBacktestRow[], rupees: number, lots: number): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const hit = rupees > 0 ? stopHit(r.trade.stop!.trade, rupees) : null;
    const pnl = hit ? -hit.loss : r.trade.pnl;
    if (pnl < 0) out.push(-pnl / lots);
  }
  return out;
}

function exitRow(
  rows: SignalBacktestRow[],
  lots: number,
  kind: ExitRow['kind'],
  share: number | null,
  level: number | null,
): ExitRow {
  const losses = redLosses(rows, level == null ? 0 : level * lots, lots);
  const lost = losses.reduce((s, v) => s + v, 0);
  return {
    kind,
    share,
    level,
    redDays: losses.length,
    redPct: rows.length ? (losses.length / rows.length) * 100 : 0,
    lost,
    avg: mean(losses),
    median: median(losses),
    worst: losses.length ? Math.max(...losses) : 0,
  };
}

/** Exit levels are shown and applied rounded to ₹10. */
const round10 = (v: number) => Math.round(v / 10) * 10;

export interface LossGroup {
  key: string;
  label: string;
  rows: SignalBacktestRow[];
  /** The typical day's worst point, ₹ per lot: median and mean over all the group's days. */
  medianMaxLoss: number;
  meanMaxLoss: number;
  /** Hold first, then the exits from the nearest level out. */
  exits: ExitRow[];
}

export function lossGroup(
  key: string,
  label: string,
  rows: SignalBacktestRow[],
  lots: number,
): LossGroup {
  const worsts = rows.map((r) => worstPoint(r, lots));
  const levels = new Map<number, ExitRow>();
  for (const share of EXIT_SHARES) {
    const level = round10(reachedBy(worsts, share));
    if (level > 0 && !levels.has(level)) {
      levels.set(level, exitRow(rows, lots, 'share', share, level));
    }
  }
  const avgLevel = round10(mean(worsts));
  if (avgLevel > 0 && !levels.has(avgLevel)) {
    levels.set(avgLevel, exitRow(rows, lots, 'mean', null, avgLevel));
  }
  return {
    key,
    label,
    rows,
    medianMaxLoss: median(worsts),
    meanMaxLoss: mean(worsts),
    exits: [
      exitRow(rows, lots, 'hold', null, null),
      ...[...levels.values()].sort((a, b) => a.level! - b.level!),
    ],
  };
}

/** All days, then one group per distance from expiry the rows hold (unknown last). */
export function lossGroups(
  rows: SignalBacktestRow[],
  lots: number,
  dteName: (dte: number) => string,
): LossGroup[] {
  if (!rows.length) return [];
  const byDte = new Map<number | null, SignalBacktestRow[]>();
  for (const r of rows) {
    const k = r.dte ?? null;
    byDte.set(k, [...(byDte.get(k) ?? []), r]);
  }
  const dteGroups = [...byDte.entries()]
    .sort(([a], [b]) => (a ?? 99) - (b ?? 99))
    .map(([dte, g]) =>
      lossGroup(
        dte == null ? 'unknown' : String(dte),
        dte == null ? 'Unknown' : dteName(dte),
        g,
        lots,
      ),
    );
  return [lossGroup('all', 'All days', rows, lots), ...dteGroups];
}

// ── After the hit ─────────────────────────────────────────────────────────────

export type MoveKind = 'further' | 'newLow' | 'fellBack' | 'reloss' | 'zero' | 'back';

interface Point {
  /** Loss, ₹ per lot, 0 when the trade is in profit. */
  v: number;
  m: number;
}

/**
 * The loss from the minute the level was hit to the exit, ₹ per lot: each minute's worst point,
 * then its close (the close ends the minute, so the worst came first). The hit minute is the one
 * the exit table fires in, so the two always count the same days.
 */
function pointsAfterHit(
  r: SignalBacktestRow,
  rupees: number,
  lots: number,
): { points: Point[]; hitMinute: number; closeLoss: number } | null {
  const hit = stopHit(r.trade.stop!.trade, rupees);
  const s = r.trade.series;
  if (!hit || !s) return null;
  const points: Point[] = [];
  let closeLoss = 0;
  for (let i = Math.max(0, hit.slot - s.from); i < s.close.length; i++) {
    const c = s.close[i];
    if (c == null) continue;
    const m = s.from + i;
    points.push({ v: Math.max(0, c + (s.worst[i] ?? 0)) / lots, m });
    points.push({ v: Math.max(0, c) / lots, m });
    closeLoss = c / lots;
  }
  if (!points.length) return null;
  return { points, hitMinute: hit.slot, closeLoss };
}

export interface Move {
  kind: MoveKind;
  /** +1 = the loss grew, −1 = it shrank. */
  dir: 1 | -1;
  /** The furthest level the move reached (index into the levels, and ₹ per lot). */
  toIdx: number;
  level: number;
  /** The furthest the loss actually got on the way, ₹ per lot (between `level` and the next one). */
  ext: number;
  /** Session minute of that point. */
  m: number;
}

/** Index of the deepest level the loss has reached (levels[i] ≤ v). */
function levelBelow(levels: number[], v: number): number {
  let i = 0;
  while (i + 1 < levels.length && levels[i + 1] <= v) i++;
  return i;
}
/** Index of the shallowest level the loss has come back to (levels[i] ≥ v). */
function levelAbove(levels: number[], v: number): number {
  let i = levels.length - 1;
  while (i - 1 >= 0 && levels[i - 1] >= v) i--;
  return i;
}

/**
 * The moves from the hit on, in levels (ascending, starting with 0; the hit level at `hitIdx`). A
 * move is the loss reaching the next level, deeper or back toward zero; one that keeps going is
 * one move to the furthest level it reached. It turns when the loss comes back a whole level from
 * there, so wiggles inside a band between two levels are never moves.
 */
export function levelMoves(points: Point[], levels: number[], hitIdx: number): Move[] {
  const legs: Array<{ dir: 1 | -1; toIdx: number; ext: number; m: number }> = [];
  let dir: 0 | 1 | -1 = 0;
  let cur = hitIdx;
  let ext = points[0].v;
  let extM = points[0].m;
  for (const p of points) {
    if (dir === 0) {
      if (cur + 1 < levels.length && p.v >= levels[cur + 1]) {
        dir = 1;
        cur = levelBelow(levels, p.v);
      } else if (cur > 0 && p.v <= levels[cur - 1]) {
        dir = -1;
        cur = levelAbove(levels, p.v);
      }
      if (dir !== 0) {
        ext = p.v;
        extM = p.m;
      }
      continue;
    }
    if (dir === 1) {
      if (p.v > ext) {
        ext = p.v;
        extM = p.m;
        cur = Math.max(cur, levelBelow(levels, p.v));
      } else if (cur > 0 && p.v <= levels[cur - 1]) {
        legs.push({ dir: 1, toIdx: cur, ext, m: extM });
        dir = -1;
        cur = levelAbove(levels, p.v);
        ext = p.v;
        extM = p.m;
      }
    } else if (p.v < ext) {
      ext = p.v;
      extM = p.m;
      cur = Math.min(cur, levelAbove(levels, p.v));
    } else if (cur + 1 < levels.length && p.v >= levels[cur + 1]) {
      legs.push({ dir: -1, toIdx: cur, ext, m: extM });
      dir = 1;
      cur = levelBelow(levels, p.v);
      ext = p.v;
      extM = p.m;
    }
  }
  if (dir !== 0) legs.push({ dir, toIdx: cur, ext, m: extM });

  // Name each move by where it went against the hit level, zero, and the deepest level so far.
  const moves: Move[] = [];
  let deepest = hitIdx;
  let lastWasZero = false;
  legs.forEach((leg, i) => {
    let kind: MoveKind;
    if (leg.dir === 1) {
      kind =
        i === 0 ? 'further' : lastWasZero ? 'reloss' : leg.toIdx > deepest ? 'newLow' : 'fellBack';
      deepest = Math.max(deepest, leg.toIdx);
    } else {
      kind = leg.toIdx === 0 ? 'zero' : 'back';
    }
    lastWasZero = kind === 'zero';
    moves.push({
      kind,
      dir: leg.dir,
      toIdx: leg.toIdx,
      level: levels[leg.toIdx],
      ext: leg.ext,
      m: leg.m,
    });
  });
  return moves;
}

/** How deep the tree goes before the rest of a day's moves are summed up as "kept swinging". */
export const MAX_MOVES = 6;

export interface Spread {
  median: number;
  mean: number;
}
const spread = (values: number[]): Spread => ({ median: median(values), mean: mean(values) });

export interface TreeNode {
  /** 'hit' (the root), a move, 'close' (no further move: held to the exit) or 'more' (kept swinging). */
  kind: MoveKind | 'hit' | 'close' | 'more';
  /** Moves: the level reached, ₹ per lot. */
  level?: number;
  /** Path of moves from the hit, for keys. */
  path: string;
  days: number;
  /** Share of the parent's days. */
  pct: number;
  dates: string[];
  /** Moves: the furthest the loss got on the way (₹/lot), when, and how long after the hit. */
  ext?: Spread;
  minute?: number;
  minutesAfterHit?: number;
  /** 'close' and 'more': the closing loss (₹/lot; negative = closed in profit). */
  close?: Spread;
  closedAtOrAboveZero?: number;
  /** 'more': median number of moves beyond the tree. */
  extraMoves?: number;
  children: TreeNode[];
}

export interface AfterHit {
  level: number;
  days: number;
  /** The levels the moves are told in, ₹ per lot, ascending from 0. */
  levels: number[];
  /** Median minute the level was hit. */
  hitMinute: number;
  /**
   * The whole rest of the day: the deepest loss after the hit (₹/lot), the days whose loss got
   * back to zero at some point, and the closing loss (negative = profit).
   */
  summary: { deepest: Spread; backToZero: number; close: Spread };
  root: TreeNode;
}

interface DayPath {
  date: string;
  moves: Move[];
  hitMinute: number;
  closeLoss: number;
}

/**
 * For the rows that reached `level` (₹ per lot, one of `levels`): the tree of what the loss did
 * next, told in `levels` (the group's exit levels; 0 is added).
 */
export function afterHit(
  rows: SignalBacktestRow[],
  level: number,
  lots: number,
  levels: number[],
): AfterHit | null {
  const ladder = [...new Set([0, ...levels.filter((l) => l > 0)])].sort((a, b) => a - b);
  const hitIdx = ladder.indexOf(level);
  if (hitIdx < 0) return null;
  const hits: Array<{ date: string; pts: NonNullable<ReturnType<typeof pointsAfterHit>> }> = [];
  for (const r of rows) {
    const pts = pointsAfterHit(r, level * lots, lots);
    if (pts) hits.push({ date: r.date, pts });
  }
  if (!hits.length) return null;

  const days: DayPath[] = hits.map((h) => ({
    date: h.date,
    moves: levelMoves(h.pts.points, ladder, hitIdx),
    hitMinute: h.pts.hitMinute,
    closeLoss: h.pts.closeLoss,
  }));

  const root: TreeNode = {
    kind: 'hit',
    level,
    path: '',
    days: days.length,
    pct: 100,
    dates: days.map((d) => d.date),
    children: [],
  };
  // Gather days per node first, then work out each node's figures.
  const members = new Map<TreeNode, Array<{ day: DayPath; move?: Move }>>();
  const childOf = (node: TreeNode, kind: TreeNode['kind'], move?: Move): TreeNode => {
    const path = `${node.path}/${move ? `${kind}@${move.toIdx}` : kind}`;
    let child = node.children.find((c) => c.path === path);
    if (!child) {
      child = {
        kind,
        ...(move ? { level: move.level } : {}),
        path,
        days: 0,
        pct: 0,
        dates: [],
        children: [],
      };
      node.children.push(child);
      members.set(child, []);
    }
    return child;
  };
  for (const day of days) {
    let node = root;
    for (const move of day.moves.slice(0, MAX_MOVES)) {
      node = childOf(node, move.kind, move);
      members.get(node)!.push({ day, move });
    }
    const end = childOf(node, day.moves.length > MAX_MOVES ? 'more' : 'close');
    members.get(end)!.push({ day });
  }

  const fill = (node: TreeNode, parentDays: number) => {
    const list = node === root ? days.map((day) => ({ day, move: undefined })) : members.get(node)!;
    if (node !== root) {
      node.days = list.length;
      node.pct = parentDays ? (list.length / parentDays) * 100 : 0;
      node.dates = list.map((x) => x.day.date);
    }
    const moves = list.map((x) => x.move).filter((m): m is Move => !!m);
    if (moves.length) {
      node.ext = spread(moves.map((m) => m.ext));
      node.minute = Math.round(median(moves.map((m) => m.m)));
      node.minutesAfterHit = Math.round(median(list.map((x) => x.move!.m - x.day.hitMinute)));
    }
    if (node.kind === 'close' || node.kind === 'more') {
      node.close = spread(list.map((x) => x.day.closeLoss));
      node.closedAtOrAboveZero = list.filter((x) => x.day.closeLoss <= 0).length;
      if (node.kind === 'more') {
        node.extraMoves = median(list.map((x) => x.day.moves.length - MAX_MOVES));
      }
    }
    // Biggest branches first; "held to close" and "kept swinging" last.
    node.children.sort((a, b) => {
      const endA = a.kind === 'close' || a.kind === 'more' ? 1 : 0;
      const endB = b.kind === 'close' || b.kind === 'more' ? 1 : 0;
      return endA - endB || members.get(b)!.length - members.get(a)!.length;
    });
    for (const c of node.children) fill(c, list.length);
  };
  fill(root, days.length);

  return {
    level,
    days: days.length,
    levels: ladder,
    hitMinute: Math.round(median(days.map((d) => d.hitMinute))),
    summary: {
      deepest: spread(hits.map((h) => Math.max(...h.pts.points.map((p) => p.v)))),
      backToZero: hits.filter((h) => h.pts.points.some((p) => p.v <= 0)).length,
      close: spread(days.map((d) => d.closeLoss)),
    },
    root,
  };
}
