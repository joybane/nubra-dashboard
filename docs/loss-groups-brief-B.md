# Brief B: strike distances, cross-check on the other index, saved criteria

Run this ONLY after Brief A (`docs/loss-groups-brief-A.md`) is finished and working. You are the
executor: implement exactly as written. Quality review is done by Fable at two checkpoints.

## Ground rules (same as Brief A)

- Implement directly in this session; do NOT hand off to an "executor" subagent despite
  `AGENTS.md`. The only subagent use allowed is the Fable review below.
- No redesign, no questions to the user, no exploring. Read ONLY what "What to read" lists; find
  edit points with Grep on the quoted anchors.
- New logic in NEW files; existing files get only the listed edits. Do not change the behaviour
  of the four existing views (Loss groups, Worst criteria, Natural split, Split by loss size)
  beyond the additions described here.
- Leave other uncommitted changes alone. No commits. If typecheck/lint/build fails in a file you
  did not edit, report and stop.
- Do not start, stop or restart any server. No new dependencies. No server changes.
- Wording is plain English exactly as given. Money is ₹ per lot.

## What the user wants

1. **Strike distances.** For the days on screen, how the same days did if a different strike
   distance had been sold (OTM 0 to OTM 7).
2. **Cross-check on the other index.** Each signal-time finding says whether it also holds on
   SENSEX (or on NIFTY, when looking at SENSEX).
3. **Saved criteria.** Name and save the current criteria; compare up to three side by side.

## What to read

| File | Lines | Why |
| --- | --- | --- |
| `src/lib/tradeExplorerTraits.ts` | the exported interfaces and function signatures only (Grep `^export`) | built in Brief A |
| `src/components/TradeExplorerLossViews.tsx` | whole file | built in Brief A; you add the cross-check mark |
| `src/components/TradeExplorerSplits.tsx` | the props interface and the controls row (Grep `interface Props`, `te-split-controls`) | add two modes and a toggle |
| `src/lib/explorerCache.ts` | whole file (short) | `cachedJson` |
| `src/lib/tradeExplorer.ts` | Grep `export function withSimilarity`, `export function nearest`, `export function applyFilters`, `export interface SimilarPlan`, `export type Filters` (signatures only) | re-applying a criteria |
| `src/TradeExplorer.tsx` | Grep `interface Settings` (12 lines), `function loadSettings` (32 lines), `const url = \`/api/signal-backtest/explorer-sets` (30 lines), `<TradeExplorerSplits` (35 lines), `clearExplorerCache();` (3 lines) | wiring |

Facts you need (already verified):

- `GET /api/signal-backtest/explorer-sets?underlying=<NIFTY|SENSEX>&set=<key>` returns
  `{ ok, rows, setLabel, … }`. Set keys for strike distance are `otm0` … `otm7`. `saved` is the
  same trade as `otm2`. Each response is about 3.5 MB gzipped, so load them one at a time.
- `buildDayRows(body.rows, underlying)` turns a response into `DayRow[]` with `values.maxLoss`,
  `values.maxLossPct` and `values.premium` for every set.

---

## Part 1 — logic (new file `src/lib/tradeExplorerCompare.ts`)

### 1.1 Strike distances

```ts
export interface SlimDay { maxLoss: number | null; maxLossPct: number | null }
export type SlimSet = Map<string, SlimDay>;                    // date → figures
export function slimSet(rows: DayRow[]): SlimSet
export interface SetLine {
  days: number;               // of the chosen dates, how many this set has figures for
  medianLoss: number | null;  // ₹
  oneInTen: number | null;    // ₹, 0.9 quantile
  medianPct: number | null;   // % of premium
  usualPct: number | null;    // this set's median % over ALL its days
  worseShare: number | null;  // share of the chosen days whose % is above usualPct
}
export function setLine(dates: ReadonlySet<string>, slim: SlimSet): SetLine
```

### 1.2 Cross-check on the other index

Uses Brief A's `prepare`, `lossGroups`, `applySpec`, `Cond`, `Trait`, `WorstLine`.

```ts
export interface Cross { days: number; a: number; b: number; word: 'Also holds' | 'Does not hold' | 'Too few days' }
```

- `crossWorst(po, lineO, line: WorstLine, base: number): Cross` — `po` is the other index's
  prepared list, `lineO` its own loss line (same percentile). Rebuild the line's condition(s)
  on `po` with `applySpec` (AND them when `second` is set). `days` = rows meeting it;
  `a` = share of those above `lineO`; `b` = share of ALL `po` rows above `lineO`.
  `Too few days` when `days < 15`; `Also holds` when `a − b >= (line.share − base) / 2`; else
  `Does not hold`.
- `crossTrait(po, groupsO, groupId, trait: Trait): Cross | null` — `null` when the other index
  has no group with that id (`allAbove` and `below` always exist; the sub-bands may not). Rebuild the condition on `po`; `days` = that group's size;
  `a` = share of the group meeting it; `b` = share of the other rows meeting it.
  `Too few days` when the group has under 15 days; `Also holds` when `a − b >= trait.diff / 2`.

### 1.3 Saved criteria

```ts
export interface SavedCriteria { name: string; filters: Filters; similar: SimilarPlan | null }
export function applyCriteria(days: DayRow[], c: SavedCriteria): DayRow[]
//   = applyFilters(c.similar ? nearest(withSimilarity(days, c.similar), c.similar.keep) : days, c.filters)
export interface LadderCol { days: number; median: number | null; oneInTen: number | null; worst: number | null;
  aboveLine: number | null;    // share of days above `line`
  bands: number[] }            // day count in each band
export function ladder(rows: DayRow[], outcome: Outcome, line: number, cuts: number[]): LadderCol
//   band i = cuts[i-1] < value <= cuts[i]; first band has no lower bound, last no upper bound
```

### 1.4 Tests (new file `src/lib/tradeExplorerCompare.test.ts`)

Five small cases: `setLine` counts only dates present and computes `worseShare` against the
set's own usual; `crossWorst` gives `Too few days` under 15 and `Also holds` for a planted
condition; `crossTrait` returns `null` for a missing group id; `applyCriteria` returns no rows
when the similar-days date is not in the list; `ladder` band counts add up to `days`.

### Fable checkpoint 1 — run it now

---

## Part 2 — views (new file `src/components/TradeExplorerCompareViews.tsx`)

### `StrikeDistancesView`

Props: `{ rows: DayRow[]; underlying: SignalUnderlying; tradeSet: string }`.

- A module-level `Map<string, SlimSet>` keyed `<underlying>|<setKey>`, plus an exported
  `clearSlimSets()` that empties it.
- Nothing loads until the user clicks `Load the eight strike distances`. Then, ONE AT A TIME for
  `otm0` … `otm7`: plain `fetch` (NOT `cachedJson`, so the big response is not kept),
  `buildDayRows`, `slimSet`, store, and let the response go. Show `Loading OTM <n>…` meanwhile.
  Stop quietly if the component unmounts. A failed set shows `not available` in its row.
- Table, one row per set, columns: `Strikes` (`OTM 0 (ATM)`, `OTM 1`, …) · `Days` ·
  `Median max loss` (₹) · `1 in 10 past` (₹) · `Median, % of premium` · `Its usual day` (the
  set's `usualPct`) · `Days worse than its usual` (`worseShare` as %).
- Mark the row of the trade set on screen (`saved` counts as `otm2`) with the text `on screen`.
- Caption above the table: `The same <n> days, with a different strike distance sold. Rupees
  fall as you sell further out because less premium is collected; "% of premium" and "days worse
  than its usual" show whether the days were actually easier.`

### `SavedCriteriaView`

Props:

```ts
{
  allRows: DayRow[]; outcome: Outcome;
  current: { filters: Filters; similar: SimilarPlan | null };
  saved: SavedCriteria[]; onSaved(list: SavedCriteria[]): void;
  onLoad(c: SavedCriteria): void;
}
```

- Top row: a text input `Name` and a button `Save the criteria on screen` (disabled when the
  name is empty; saving under an existing name replaces it; at most 12 are kept, oldest dropped).
- List of saved criteria: a checkbox (at most 3 ticked; default the first 3), the name, a
  one-line summary (`similar to <date> · <k> filters` / `<k> filters` / `no filters`), a
  `Load` button (`onLoad`) and a `Delete ×` button.
- Comparison table. Columns: `All days` first, then each ticked criteria (via
  `applyCriteria(allRows, c)`; show `not available here` when it gives 0 days). The loss line is
  the median of `allRows` on the chosen outcome, and `cuts` are the 0.25, 0.5 and 0.75 quantiles
  of `allRows` (so every column is measured against the same levels; say so in a caption:
  `Loss line and bands come from all <n> days of this trade set.`). Rows: `Days` ·
  `Median max loss` · `1 in 10 past` · `Worst` · `Days above <line>` (%) · then one row per
  band, labelled `Up to <c1>`, `<c1> to <c2>`, `<c2> to <c3>`, `Above <c3>`, showing
  `<count> (<share>%)`.

Styling: append `te-cmp-` classes to the END of `src/tradeExplorer.css`, reusing the existing
card, table and muted classes. Existing variables only.

---

## Part 3 — cross-check mark (edit `src/components/TradeExplorerLossViews.tsx`)

- Both views take one more optional prop: `other?: { name: string; rows: DayRow[] }`.
- When present: `po = prepare(other.rows, outcome)`, `lineO = quantile(po.y, linePct)`,
  `groupsO = lossGroups(po, lineO, …)` (memoised).
- Loss groups, AT THE SIGNAL only: after each trait line add, in muted text,
  `<name>: <a>% of its <days> days here, <b>% elsewhere · <word>` from `crossTrait` (nothing when
  it returns `null`). Not for pairs, not for day-traits.
- Worst criteria: after each line and each "made worse by" line add
  `<name>: <a>% of <days> days above its line (all days <b>%) · <word>` from `crossWorst`.
- Add one caption at the top of each view when `other` is present:
  `Cross-check uses all <name> days of the same trade set, not your criteria.`

---

## Part 4 — wiring

### `src/components/TradeExplorerSplits.tsx`

1. Mode type gains `'sets'` and `'saved'`; add buttons `Strike distances` and `Saved criteria`
   at the END of the `View` group.
2. New props: `underlying`, `tradeSet`, `allRows`, `current`, `saved`, `onSaved`, `onLoad`
   (passed straight to the two new views), and `other?: { name: string; rows: DayRow[] }`.
3. In `groups` and `worst` modes add a checkbox `Cross-check on <other index name>` (local
   state, default on). Pass `other` to the loss views only when it is ticked and `other` exists.
4. The loss line control and "Also show what happened after entry" stay hidden in the two new
   modes.

### `src/TradeExplorer.tsx`

1. `Settings` gets `savedCriteria?: SavedCriteria[]`; in `loadSettings` add
   `savedCriteria: Array.isArray(raw.savedCriteria) ? raw.savedCriteria : undefined`.
2. `splitMode` type gains the two modes.
3. Other index rows: a `useEffect` that runs only while `showSplits` is true. It fetches the
   same URL as the main load but with the other underlying and the same `tradeSet`, via
   `cachedJson`, then `buildDayRows(body.rows, otherUnderlying)` into state
   `otherRows: DayRow[] | null` (null on failure or while loading; guard with a `live` flag as
   the main load does). Pass `other={otherRows ? { name: otherUnderlying, rows: otherRows } :
   undefined}`.
4. Pass `underlying`, `tradeSet`, `allRows={days ?? []}`, `current={{ filters, similar }}`,
   `saved={settings.savedCriteria ?? []}`, `onSaved={(list) => update({ savedCriteria: list })}`.
5. `onLoad`: if `c.similar` is null and a similar-days search is running, call the existing
   `stopSimilar()` first (it restores the sort). Then `update({ filters: c.filters })`; if
   `c.similar` is set, `setSimilar(c.similar)` and `update({ sort: { key: SIMILAR_KEY, dir: 1 } })`.
   Finally `setSplitTrail([])`. Read `const stopSimilar` (12 lines) first so the order of the
   state updates does not undo the new filters.
6. Next to the existing `clearExplorerCache();` call add `clearSlimSets();`.

---

## Fable checkpoints

Same procedure as Brief A (the user has approved these reviews; wait for each reply, never
predict it): at exactly two points, call the `advisor` tool if you have one,
otherwise the Agent tool with `model: "fable"` and the prompt below. Apply every defect. At most
one re-review per checkpoint, only for a blocking defect.

**Checkpoint 1 — after Part 1 and its tests pass.**

> Review only. Read `docs/loss-groups-brief-B.md` Part 1 and `src/lib/tradeExplorerCompare.ts` in
> `E:\Derivativesproject\nubra-dashboard`. Check each function against its rule: which rows are
> counted, the "half the gap" rule, the 15-day minimum, band edges, and that a similar-days date
> missing from the list gives no rows. Do not edit files or read other files. Reply with at most
> 10 numbered defects (file:line, problem, exact fix, `blocking` or `minor`), or `No defects`.

**Checkpoint 2 — after all checks pass, before the report.**

> Review only. Read `docs/loss-groups-brief-B.md` Parts 2–4 and "Acceptance", then
> `src/components/TradeExplorerCompareViews.tsx` and `git diff -- src/components/TradeExplorerLossViews.tsx
> src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx src/tradeExplorer.css` in
> `E:\Derivativesproject\nubra-dashboard`. Check: sets load one at a time with plain fetch and
> only after the click; loading stops on unmount; the cross-check is marked on signal-time
> findings only and says it uses all days; saved criteria survive a reload and loading one
> restores filters and the similar-days search; the four older views behave as before; wording
> matches the brief. Do not edit files. Reply with at most 10 numbered defects (file:line,
> problem, exact fix, `blocking` or `minor`), or `No defects`.

## Checks (run from `nubra-dashboard`, in this order)

```bash
npx vitest run src/lib/tradeExplorerCompare.test.ts src/lib/tradeExplorerTraits.test.ts
npx prettier --write src/lib/tradeExplorerCompare.ts src/lib/tradeExplorerCompare.test.ts src/components/TradeExplorerCompareViews.tsx
npx eslint src/lib/tradeExplorerCompare.ts src/lib/tradeExplorerCompare.test.ts src/components/TradeExplorerCompareViews.tsx src/components/TradeExplorerLossViews.tsx src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx
npx prettier --check src/components/TradeExplorerLossViews.tsx src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx src/tradeExplorer.css
npm run typecheck
```

## Acceptance (figures from a trial run)

Write this temporary script as `scratch/accept-b.mts`, run `npx tsx scratch/accept-b.mts`, compare,
then DELETE it:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildDayRows, quantile } from '../src/lib/tradeExplorer';
import { ENTRY_KEYS } from '../src/lib/tradeExplorerSplits';
import { prepare, conditions, worstCriteria } from '../src/lib/tradeExplorerTraits';
import { slimSet, setLine, crossWorst } from '../src/lib/tradeExplorerCompare';
const load = (u: 'NIFTY' | 'SENSEX', set: string) => {
  const base = `.signal-cache/${u}/explorer-sets`;
  const body = JSON.parse(gunzipSync(readFileSync(`${base}/${readdirSync(base)[0]}/${set}.json.gz`)).toString('utf8'));
  return buildDayRows(body.rows, u);
};
const nifty = load('NIFTY', 'saved');
const dates = new Set(nifty.filter((r) => r.values.ivLevel === 'Very high').map((r) => r.raw.date));
for (const n of [0, 2, 5, 7]) console.log('OTM', n, setLine(dates, slimSet(load('NIFTY', `otm${n}`))));
const p = prepare(nifty, 'maxLoss'), line = quantile(p.y, 0.5) as number;
const w = worstCriteria(p, line, conditions(p, ENTRY_KEYS))!;
const po = prepare(load('SENSEX', 'saved'), 'maxLoss');
console.log(w.lines[0].cond.label, crossWorst(po, quantile(po.y, 0.5) as number, w.lines[0], w.base));
```

Expected (criteria = NIFTY days with IV level Very high, 294 days):

| Item | Expected |
| --- | --- |
| OTM 0 | 294 days, median ₹2,409, 1 in 10 ₹8,521, median 13.6%, usual 11.7%, worse on 55% |
| OTM 2 | 294 days, median ₹2,069, 1 in 10 ₹7,935, median 17.5%, usual 15.2%, worse on 54% |
| OTM 5 | 294 days, median ₹1,090, 1 in 10 ₹5,666, median 21.1%, usual 17.5%, worse on 56% |
| OTM 7 | 294 days, median ₹785, 1 in 10 ₹4,840, median 21.4%, usual 15.9%, worse on 58% |
| Cross-check of `IV level: Very high` on SENSEX | 160 days, about 63% above its line, all days 50%, `Also holds` |

Finally `npm run build`. If a built-in browser is available: `http://localhost:3000` →
`Trade Explorer` → `Trade by trade` → tick `What differs`.

- `Worst criteria`: each line carries a `SENSEX: …` cross-check sentence.
- `Strike distances`: nothing loads until the button is clicked; then eight rows fill in one by
  one and `OTM 2` is marked `on screen`.
- `Saved criteria`: save the criteria on screen under a name, reload the page, it is still
  listed; `Load` restores it.

If no browser is available, say so.

## Report back (under 15 lines)

- Files created and edited.
- Each check command: pass/fail (failure text if any).
- Acceptance lines that did not match, with what you got.
- What Fable reported at each checkpoint and what you changed.
- Anything you could not do as written.
