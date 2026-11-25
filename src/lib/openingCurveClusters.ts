import { OPENING_MOVE_COVERAGE } from './openingPathGroups';
import { OPENING_SESSION_MINUTES, type OpeningGrid } from './openingStrangle';

const WINDOW = 15;
const MARKS_PER_WINDOW = 5;
const COMMON_WINDOWS = 18;
const MIN_SESSIONS = 24;
const MIN_GROUP = 8;
const MAX_GROUPS = 6;
const MAX_ITERATIONS = 10;
const MIN_SILHOUETTE = 0.24;
const MIN_MEDOID_DISTANCE = 0.18;
const SCORE_TOLERANCE = 0.025;
const END = OPENING_SESSION_MINUTES - 1;

export interface OpeningCurveSession {
  date: string;
  entry: number;
  entryCredit: number;
  pnl: OpeningGrid;
}

export interface OpeningCurveSubgroup {
  representative: string;
  dates: string[];
}

interface Profile {
  date: string;
  marks: Array<number | null>;
}

function scale(pnl: number, credit: number) {
  return Math.sign(pnl) * Math.log1p((4 * Math.abs(pnl)) / credit);
}

function validMark(mark: number | null | undefined): mark is number {
  return mark != null && Number.isFinite(mark);
}

function profile({ date, entry, entryCredit, pnl }: OpeningCurveSession): Profile | null {
  const close = pnl[END];
  if (
    !Number.isInteger(entry) ||
    entry < 0 ||
    entry > END ||
    !Number.isFinite(entryCredit) ||
    entryCredit <= 0 ||
    !validMark(close)
  )
    return null;

  let observed = 1;
  const marks: Profile['marks'] = [];
  for (let from = 0; from < END; from += WINDOW) {
    const values = pnl.slice(Math.max(from, entry), Math.min(from + WINDOW, END)).filter(validMark);
    observed += values.length;
    if (values.length < MARKS_PER_WINDOW) {
      marks.push(null);
      continue;
    }
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    marks.push(scale(median, entryCredit));
  }
  if (observed * 100 < (END - entry + 1) * OPENING_MOVE_COVERAGE) return null;
  return { date, marks: [...marks, scale(close, entryCredit)] };
}

function distance(left: Profile, right: Profile): number {
  let total = 0;
  let shared = 0;
  for (let i = 0; i < left.marks.length; i++) {
    const a = left.marks[i];
    const b = right.marks[i];
    if (a == null || b == null) continue;
    total += (a - b) ** 2;
    shared++;
  }
  return shared >= COMMON_WINDOWS ? Math.sqrt(total / shared) : Infinity;
}

type Distance = (a: number, b: number) => number;

function medoid(members: number[], measure: Distance): number {
  let best = members[0];
  let minimum = Infinity;
  for (const candidate of members) {
    let total = 0;
    for (const other of members) total += measure(candidate, other);
    if (total < minimum) {
      minimum = total;
      best = candidate;
    }
  }
  return best;
}

function assign(rows: number[], centers: number[], measure: Distance): number[][] {
  const groups = centers.map(() => [] as number[]);
  for (const row of rows) {
    let best = 0;
    let minimum = measure(row, centers[0]);
    for (let j = 1; j < centers.length; j++) {
      const value = measure(row, centers[j]);
      if (value < minimum || row === centers[j]) {
        minimum = value;
        best = j;
      }
    }
    groups[best].push(row);
  }
  return groups;
}

/** Add the center that most reduces total distance to the closest existing center. */
function nextMedoid(rows: number[], centers: number[], measure: Distance): number | null {
  const nearest = rows.map((row) => Math.min(...centers.map((center) => measure(row, center))));
  let minimum = nearest.reduce((sum, value) => sum + value, 0);
  let best = null;
  for (const candidate of rows) {
    if (centers.includes(candidate)) continue;
    let total = 0;
    for (const row of rows) total += Math.min(nearest[row], measure(row, candidate));
    if (total < minimum) {
      minimum = total;
      best = candidate;
    }
  }
  return best;
}

function fit(rows: number[], initial: number[], measure: Distance) {
  let centers = initial;
  let groups = assign(rows, centers, measure);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const proposed = groups.map((members, j) =>
      members.length ? medoid(members, measure) : centers[j],
    );
    if (proposed.every((center, j) => center === centers[j])) break;
    centers = proposed;
    groups = assign(rows, centers, measure);
  }
  return { centers, groups };
}

function silhouette(groups: number[][], measure: Distance): number {
  let total = 0;
  let count = 0;
  for (const members of groups) {
    for (const row of members) {
      let within = 0;
      for (const other of members) within += measure(row, other);
      within /= members.length - 1;
      let between = Infinity;
      for (const alternative of groups) {
        if (alternative === members) continue;
        let mean = 0;
        for (const other of alternative) mean += measure(row, other);
        between = Math.min(between, mean / alternative.length);
      }
      const denominator = Math.max(within, between);
      total += denominator ? (between - within) / denominator : 0;
      count++;
    }
  }
  return total / count;
}

/** Group whole sessions by their timed P&L profiles. Membership ignores display settings. */
export function clusterOpeningCurves(sessions: OpeningCurveSession[]): OpeningCurveSubgroup[] {
  if (sessions.length < MIN_SESSIONS) return [];
  const profiles = sessions
    .map(profile)
    .filter((value): value is Profile => value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const count = profiles.length;
  if (count < MIN_SESSIONS) return [];

  const rows = profiles.map((_, i) => i);
  const cache = new Float64Array(count * count);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < i; j++) {
      const value = distance(profiles[i], profiles[j]);
      if (!Number.isFinite(value)) return [];
      cache[i * count + j] = value;
      cache[j * count + i] = value;
    }
  }
  const measure: Distance = (a, b) => cache[a * count + b];
  let centers = [medoid(rows, measure)];
  const supported: Array<ReturnType<typeof fit> & { score: number }> = [];
  const maxGroups = Math.min(MAX_GROUPS, Math.floor(count / MIN_GROUP));
  for (let k = 2; k <= maxGroups; k++) {
    const added = nextMedoid(rows, centers, measure);
    if (added == null) break;
    const result = fit(rows, [...centers, added], measure);
    centers = result.centers;
    if (result.groups.some((group) => group.length < MIN_GROUP)) continue;
    if (
      centers.some((center, i) =>
        centers.slice(0, i).some((other) => measure(center, other) < MIN_MEDOID_DISTANCE),
      )
    )
      continue;
    const score = silhouette(result.groups, measure);
    if (score >= MIN_SILHOUETTE) supported.push({ ...result, score });
  }

  if (!supported.length) return [];
  const best = Math.max(...supported.map(({ score }) => score));
  const chosen = supported.find(({ score }) => score >= best - SCORE_TOLERANCE)!;
  return chosen.groups
    .map((group, i) => ({
      representative: profiles[chosen.centers[i]].date,
      dates: group.map((row) => profiles[row].date),
    }))
    .sort((a, b) => a.representative.localeCompare(b.representative));
}
