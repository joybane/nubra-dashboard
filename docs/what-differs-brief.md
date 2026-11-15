# Brief: Trade Explorer "What differs" panel + similar-days filter fix

You are implementing one feature in `E:\Derivativesproject\nubra-dashboard`. Everything you need is in
this file. The design is final: do not redesign, do not ask questions, do not explore the codebase.

## Ground rules (they keep this cheap)

- Implement directly in this session. Do NOT delegate to a subagent or "executor", even though
  `AGENTS.md` says to: this brief is the delegation.
- If typecheck, lint or build fails in a file you did not edit, report it and stop. Do not fix it.
- Read ONLY the line ranges listed under "What to read". Never read `src/TradeExplorer.tsx` or
  `src/lib/tradeExplorer.ts` whole (1,600 and 1,300 lines). Find edit points with Grep on the quoted
  anchor text, because line numbers may have shifted a little.
- New logic goes in NEW files. Existing files get only the small edits listed here.
- The working tree already has uncommitted changes in several files, including
  `src/TradeExplorer.tsx`. Leave them alone. Do not commit, stash, revert or reformat anything you did
  not write.
- Do not start, stop or restart any server. `localhost:3000` is a live process that serves `dist/`.
- No new dependencies. No server changes. No changes to the saved-run data.
- All wording shown to the user is plain English, as written in this brief. Money is ₹ per lot.
- Run only the commands under "Checks". Finish with the short report under "Report back".

## What the user wants

In the Trade Explorer ("Trade by trade" view) the user picks a set of days by any criteria (column
filters, "Find similar days", or both). They then want to know: among these days, which reading that
was known at the signal separates the big-loss days from the small-loss days, and to drill into
either side and ask again.

## What to read

| File | Lines | Why |
| --- | --- | --- |
| `src/lib/tradeExplorer.ts` | 93–120 | `DayRow`, `Column`, `CellValue` |
| `src/lib/tradeExplorer.ts` | 899–916 | `formatCell` |
| `src/lib/tradeExplorer.ts` | 963–970 | `categoryValues(c, rows)` |
| `src/lib/tradeExplorer.ts` | 1000–1013 | `quantile`, `numbers` |
| `src/lib/tradeExplorer.ts` | 1103–1111 | `spread` |
| `src/lib/tradeExplorer.ts` | 1160–1199, 1287–1299 | `Bucket`, `bucketRows`, `money`, `share`, `bucketFilter` |
| `src/lib/tradeExplorer.test.ts` | 1–45 | how tests build `DayRow`s (`day(...)` helper) |
| `src/components/TradeExplorerCharts.tsx` | 88–102 | card markup and class names to reuse |
| `src/tradeExplorer.css` | 209–240, 630–660 | `.te-analysis`, `.te-chart-card`, `.te-analysis-overlay` styles |
| `src/TradeExplorer.tsx` | 405–415, 556–562, 1010–1022, 1362–1384 | state, filter pipeline, toolbar checkbox, overlay |

## Part 1 — filter fix (`src/TradeExplorer.tsx`)

Anchor: `const kept = applyFilters(scored, filters);`

Today filters run first and then the closest N days are taken, so adding a filter during a
similar-days search swaps in new, less similar days. Change it so the closest N are taken first and
filters then narrow them:

```ts
const filtered = useMemo(
  () => applyFilters(similar ? nearest(scored, similar.keep) : scored, filters),
  [scored, filters, similar],
);
```

Then, inside the `te-similar` strip, change the sentence that starts `Distance 0 is identical` (Grep
for it) by appending: ` Column filters narrow these days.`

## Part 2 — split logic (new file `src/lib/tradeExplorerSplits.ts`)

Two one-word edits in `src/lib/tradeExplorer.ts` first: add `export` to `const numbers` and to
`function spread`.

### Constants

```ts
/**
 * Readings known when the trade is placed. Only these may explain a split by default.
 * The order matters: when several readings pick the same days, the earliest one here is shown.
 */
export const ENTRY_KEYS = ['dte','ivLevel','warnGroup','weekday','same','ivRatio','gap','gapPct',
  'ceChange','peChange','both','morning','t1','t2','wait','premium','ivNow','ivUsual','ceIv','peIv',
  'skew','prevMaxLoss','deltaLean','theta','vega'];
/** How the day went. Shown only when the user asks; they explain a loss but cannot predict it. */
export const AFTER_KEYS = ['maxLossAt','toMaxLoss','range','move','touched','path','moveFifth',
  'direction','speedGroup','speedMin','losingLeg','bestProfit'];
export type Outcome = 'maxLoss' | 'maxLossPct';
/** Category columns whose values have a real order, so "this value and everything after it" is a fair cut. */
const ORDERED = ['dte', 'ivLevel'];
```

### `bestSplit(rows, key, outcome, outcomeValues?)`

Returns the single best two-way cut of `rows` on column `key`, or `null`.

- Use only rows whose outcome is a number. `minSide = max(8, floor(0.15 × that count))`.
- Candidates:
  - `num` / `time` column: take the column's numeric values, and for each p in
    0.2, 0.3, …, 0.8 take `quantile(values, p)`; de-duplicate. Side A = value `>= cut`, side B =
    value `< cut`. Rows with no reading are in neither side.
  - `cat` column: for each non-null value in `categoryValues(c, rows)`: A = equals it, B = any other
    non-null value. If the key is in `ORDERED`, also for each position i ≥ 1 in that ordered list:
    A = value is at position ≥ i, B = the rest.
  - Skip `text` and `date` columns.
- Skip a candidate when either side has fewer than `minSide` rows.
- `score = (median outcome of A − median outcome of B) / outcomeSpread`, where `outcomeSpread` is
  the outcome's inter-quartile range over the rows (fall back to max − min, then 1).
- Keep the candidate with the largest `|score|`.
- Return it oriented so `worse` is the side with the higher median outcome:

```ts
export interface Split {
  key: string;
  /** e.g. "IV ratio 1.24 or more" */  worseLabel: string;
  /** e.g. "IV ratio below 1.24" */    betterLabel: string;
  worse: DayRow[];
  better: DayRow[];
  /** Days with no reading on this column. */ blank: number;
  /** Always ≥ 0: gap between the two medians, in outcome spreads. */ score: number;
  /** 0–1, filled by `splitChances`; null = not checked yet. */ chance: number | null;
  /** Labels of other columns that pick nearly the same days. */ same: string[];
}
```

- Labels (use `formatCell(c, value)` for values and `c.label` for the column):
  - number: `"<label> <cut> or more"` / `"<label> below <cut>"`
  - time: `"<label> at <cut> or later"` / `"<label> before <cut>"`
  - one category value: `"<label>: <value>"` / `"<label>: any other"`
  - ordered tail: `"<label>: <v1>, <v2>…"` (the values in A, comma-separated) / the same for B.
- `outcomeValues` (optional `Map<DayRow, number>`) replaces the outcome read from the row. It exists
  only for the chance check below.

### `rankSplits(rows, outcome, keys = ENTRY_KEYS)`

1. `bestSplit` for every key; drop nulls; sort by `score`, largest first.
2. Fold repeats. Walk the sorted list; a split joins an already-kept one when their WORSE sides
   pick nearly the same days: among rows that have a reading on both columns,
   `(days in both worse sides) / (days in either worse side) >= 0.7`. Do not compare the better
   sides (they are large and overlap by luck). When it joins, it is dropped from the list and its
   `c.label` goes onto the kept split's `same`. Exception: if the joining split's key comes
   earlier in `keys` than the kept one's AND its score is at least 90% of the kept one's, it
   replaces the kept one (taking over its `same` plus the replaced label) in the same list position.
   This makes `Day: Exp` the shown line rather than `Vega ₹ below ₹290`.
3. Return the kept list with `chance: null`. This step has no shuffling and must be fast
   (well under 100 ms on 1,438 rows).

### `splitChances(rows, outcome, keys, splits)`

Returns `{ headline: number, perSplit: number[] }` (same order as `splits`). Kept separate because
it is the slow part.

- Shuffles: 200 when there are ≤ 500 rows, else 40. Seeded generator (e.g. mulberry32, fixed seed)
  so the answer never flickers.
- Each shuffle: permute the outcome values among the rows; for EVERY key in `keys` compute the best
  shuffled score (the `bestSplit` search with the shuffled values).
  - `perSplit[i]` counts shuffles where that split's own key scored ≥ its real score.
  - `headline` counts shuffles where the best score over ALL keys ≥ the real top score. This is the
    honest test for the headline, because the headline is the best of about 25 readings.
  - Divide the counts by the number of shuffles.
- Build each key's candidate side memberships (row indexes) ONCE and reuse them in every shuffle;
  compute medians on typed arrays. Target: under 700 ms on 1,438 rows. If slower, lower the
  40 (not below 30).

### `chanceWord(chance)`

`null` → `''`; `< 0.05` → `'Clear'`; `< 0.2` → `'Could be chance'`; else `'Not reliable'`.

### `bandCompare(rows, outcome, bands, keys = ENTRY_KEYS)`

For the second view. `bucketRows(rows, outcomeColumn, bands)` (drop the "No reading" bucket) gives
the loss groups, smallest loss first. For each key return one line:

- `num` / `time`: the median in each group; `gap = (last group median − first group median) /
  spread(rows, key)`.
- `cat`: in each group, the most common value and its share of that group; `gap` = the largest
  difference, over all values, between that value's share in the last group and in the first.
- Sort lines by `|gap|`, largest first. Return `{ groups: Bucket[], lines }`.

### Tests (new file `src/lib/tradeExplorerSplits.test.ts`, vitest, same `day(...)` style)

Keep to these five:

1. A column that perfectly separates high and low outcome is ranked first, with the right side as
   `worse` and both labels correct.
2. A side smaller than `minSide` is never returned.
3. A second column that is an exact copy of the first is folded into `same`, not listed; and a
   column whose worse side shares under 70% of days stays listed.
4. `splitChances`: `headline` and the perfect column's `perSplit` are below 0.05; a column whose
   two sides have identical outcome medians (score 0) gets `perSplit` of 1.
5. `bandCompare` orders a separating column above a constant one.

## Part 3 — the panel (new file `src/components/TradeExplorerSplits.tsx`)

Props:

```ts
{
  rows: DayRow[];                       // the days on screen (`filtered`)
  outcome: Outcome; onOutcome(o): void;
  mode: 'split' | 'bands'; onMode(m): void;
  trail: string[];                      // labels of the steps drilled so far
  onBack(): void;                       // undo the last step
  onPick(key: string, side: DayRow[], label: string, close: boolean): void;
}
```

`showAfter` (local state, default off) is a checkbox "Also show what happened after entry"; when
on, `keys = [...ENTRY_KEYS, ...AFTER_KEYS]`, else `ENTRY_KEYS`.

Compute only the active view, with `useMemo`: `rankSplits` on `[rows, outcome, keys]` when
`mode === 'split'`, `bandCompare` on `[rows, outcome, keys, bands]` when `mode === 'bands'`.

Chance marks arrive a moment later so the panel paints at once: in a `useEffect` on the ranked
list, `setTimeout(…, 0)` → `splitChances(...)` → store in state (clear the timeout on cleanup, and
ignore a result for an older list). Until it arrives show `checking…` where the chance word goes,
and treat the headline as not yet judged (show the split, no badge).

Layout, top to bottom, reusing `.te-analysis` / `.te-chart-card` / `.te-card-heading` /
`.te-eyebrow` / `.te-badge` / `.te-caption`:

1. **Controls row.** "Measure loss in" with two buttons: `₹ per lot` (maxLoss), `% of premium`
   (maxLossPct). "View" with two buttons: `Natural split`, `Split by loss size`. The `showAfter`
   checkbox. If `trail.length`: the trail as `All chosen days › step › step` and a `← Back` button.
2. **Natural split view** (`mode === 'split'`):
   - Headline card. Eyebrow `BIGGEST DIFFERENCE`. The headline's chance is `headline` from
     `splitChances`; list rows use `perSplit`. If there is no split, or the headline chance
     is `>= 0.2`: heading `Nothing clearly separates these days`, caption
     `Try more days, or a different measure.` and still show the list below.
     Otherwise heading = the first split's `worseLabel`, and two side-by-side blocks (worse on the
     left, tinted with `var(--red)` at low opacity; better on the right). Each block shows: its
     label, `N days`, `Median max loss`, `1 in 10 past`, `Worst` (from the chosen outcome: median,
     0.9 quantile, max; format with `formatCell(outcomeColumn, v)`), and two buttons:
     `Split these further` → `onPick(key, side, label, false)` and
     `Show these days` → `onPick(key, side, label, true)`.
     Under the blocks: the chance word as a badge; `Same days as: a, b, c` when `same.length`;
     `N days have no reading` when `blank > 0`; and `Few days: one day can move these figures`
     when either side has fewer than `SMALL_SAMPLE` (20) days.
   - List card. Eyebrow `ALL READINGS`, heading `Where were losses highest?`. One row per kept
     split (including the first): worse label · days · median, then `against`, then better label ·
     days · median, then the chance word, then `Same days as …` in muted text. Clicking the worse
     or the better half of a row calls `onPick(key, side, label, false)`.
3. **Split by loss size view** (`mode === 'bands'`): a select `halves | thirds | fifths` (local
   state, default thirds). A table: one column per loss group, header = group label, `N days`
   (muted, with `few` when under 20); one row per line, cells = median (`formatCell`) or
   `value (share%)` for categories; rows already sorted by gap. Clicking a group header calls
   `onPick(outcome, group.rows, group.label, false)`.
4. With fewer than 16 rows show only: `Too few days to compare (N). Widen the criteria.`

Styling: append a short block to the END of `src/tradeExplorer.css` with `te-split-` prefixed
classes. Use the existing variables (`var(--border)`, `var(--bg-card)`, `var(--text-muted)`,
`var(--red)`); no hard-coded colours, so both themes work. Blocks stack in one column under 760px.

## Part 4 — wiring (`src/TradeExplorer.tsx`)

1. Import the panel, `bucketFilter` (if not already imported), and the `Outcome` type.
2. State, next to `const [showCharts, setShowCharts] = useState(false);`:

```ts
const [showSplits, setShowSplits] = useState(false);
const [splitOutcome, setSplitOutcome] = useState<Outcome>('maxLoss');
const [splitMode, setSplitMode] = useState<'split' | 'bands'>('split');
const [splitTrail, setSplitTrail] = useState<
  Array<{ label: string; key: string; prev: ColumnFilter | undefined }>
>([]);
```

3. Toolbar: right after the `Analysis charts` checkbox label, add the same markup for a checkbox
   labelled `What differs`, bound to `showSplits`. Turning it off also clears `splitTrail`.
   Also, in the `te-similar` strip, right before the `Stop ×` button (anchor:
   `onClick={stopSimilar}`), add a button with the same `te-similar-action` class labelled
   `What differs` that sets `showSplits` to true.
4. Overlay: right after the `{showCharts && (…)}` block, add the same overlay markup with the
   heading `What differs between these days` and the close button, containing the panel:

```tsx
<TradeExplorerSplits
  rows={filtered}
  outcome={splitOutcome} onOutcome={setSplitOutcome}
  mode={splitMode} onMode={setSplitMode}
  trail={splitTrail.map((s) => s.label)}
  onBack={() => {
    const last = splitTrail[splitTrail.length - 1];
    if (!last) return;
    setFilter(last.key, last.prev);
    setSplitTrail(splitTrail.slice(0, -1));
  }}
  onPick={(key, side, label, close) => {
    const c = COLUMN_BY_KEY.get(key);
    if (!c) return;
    const prev = filters[key];
    setFilter(key, bucketFilter(c, { id: '', label, rows: side }));
    if (close) { setShowSplits(false); setSplitTrail([]); }
    else setSplitTrail([...splitTrail, { label, key, prev }]);
  }}
/>
```

   `bucketFilter` turns a side into the exact filter that keeps those days, so drilling is just a
   normal column filter: the table, the summary strip and "Clear N filters" all keep working.
   The close button also clears `splitTrail`.

## Checks (run from `nubra-dashboard`, in this order, fix what fails)

```bash
npx vitest run src/lib/tradeExplorerSplits.test.ts src/lib/tradeExplorer.test.ts
npx prettier --write src/lib/tradeExplorerSplits.ts src/lib/tradeExplorerSplits.test.ts src/components/TradeExplorerSplits.tsx
npx eslint src/lib/tradeExplorerSplits.ts src/lib/tradeExplorerSplits.test.ts src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx
npx prettier --check src/TradeExplorer.tsx src/lib/tradeExplorer.ts src/tradeExplorer.css
npm run typecheck
npm run build
```

The code snippets in this brief are not prettier-shaped; reshape your own lines. If
`prettier --check` flags one of those three existing files, fix only the lines you added (do not
run `--write` on them if it would touch lines that are not yours).

`npm run build` refreshes what `localhost:3000` serves. If a built-in browser is available, open
`http://localhost:3000`, click `Trade Explorer`, then `Trade by trade`, tick `What differs`, and
compare with the expected figures below (NIFTY, saved run OTM 2, all 1,438 days, no filters). If no
browser is available, skip this and say so.

| Measure | Expected headline | Worse side | Better side |
| --- | --- | --- | --- |
| ₹ per lot | `IV level: Very high`, marked `Clear`, with `Same days as: IV ratio` | 294 days, median about ₹2,069 | 1,123 days, median about ₹891 |
| % of premium | `Day: Exp`, marked `Clear`, with `Same days as:` Vega ₹, Premium, Theta ₹ | 302 days, median 60% | 1,136 days, median 13% |

These figures come from a trial run of the same rules. In the ₹ list the next lines should be
`Warning: IV high for now` (293 days, about ₹2,041 against ₹921) and `Call IV 22.87 or more`.
Small differences in the cut value are fine; a different top reading is a bug.

Then click `Split these further` on the worse side: the status line under the toolbar must show the
smaller day count, the trail must show one step, and `← Back` must restore the full set.

## Report back (keep it under 15 lines)

- Files created and files edited.
- Result of each check command (pass/fail, and the failure text if any).
- The headline split and day counts you saw for both measures, or "browser check skipped".
- Anything in this brief you could not do as written, and what you did instead.
