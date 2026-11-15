# Brief A: Trade Explorer "Loss groups" and "Worst criteria" views

You are the executor. Implement this brief in `E:\Derivativesproject\nubra-dashboard` exactly as
written. The design is final and every rule below was already tried on the real data. Your job is
execution only; quality review is done by Fable at two checkpoints (see "Fable checkpoints").

## Ground rules (they keep this cheap)

- Implement directly in this session. Do NOT hand the work to an "executor" subagent even though
  `AGENTS.md` says to: this brief is that delegation. The only subagent use allowed is the Fable
  review described below.
- Do not redesign, do not ask the user questions, do not explore the codebase. Read ONLY the line
  ranges under "What to read". Find edit points with Grep on the quoted anchor text.
- New logic goes in NEW files. Existing files get only the small edits listed.
- Do NOT change or remove the existing "Natural split" and "Split by loss size" views.
- The working tree has other uncommitted changes. Leave them alone. Do not commit, stash or revert.
  If typecheck, lint or build fails in a file you did not edit, report it and stop.
- Do not start, stop or restart any server. `localhost:3000` is a live process serving `dist/`.
- No new dependencies. No server changes.
- User-facing wording is plain English exactly as given here. Money is ₹ per lot.

## What the user wants

The user picks days by any criteria (column filters, "Find similar days", or nothing). On those
days they want:

1. A movable **loss line** (starts at the median max loss). Days above the line are the focus.
2. The days cut into **loss groups**, and for EACH group: what was unique about it at the signal,
   what was unique during the day, and whether that day-trait could have been seen at the signal.
3. For every reading named: **what it is, how it differs from look-alikes, where to see it.**
4. A **worst-criteria list**: which signal-time conditions put the most days above the line.
5. Every finding marked with whether it is the same in earlier and later years, plus example days.

Signal-time findings always come first; "during the day" is secondary.

## What to read

| File | Lines | Why |
| --- | --- | --- |
| `src/lib/tradeExplorer.ts` | 93–120 | `DayRow`, `Column` |
| `src/lib/tradeExplorer.ts` | Grep `export function formatCell`, `export function categoryValues`, `export function quantile` (read ~12 lines each) | helpers |
| `src/lib/tradeExplorerSplits.ts` | 19–63, 132–143 | `ENTRY_KEYS`, `AFTER_KEYS`, `Outcome`, `mulberry32` |
| `src/lib/tradeExplorerSplits.test.ts` | 1–25 | how tests build `DayRow`s |
| `src/components/TradeExplorerSplits.tsx` | 1–40, 79–200 | props, controls row, how a view is rendered |
| `src/tradeExplorer.css` | Grep `.te-split` (read from the first match to the end of file) | classes to reuse |
| `src/TradeExplorer.tsx` | Grep `const [splitMode`, and `<TradeExplorerSplits` (read 30 lines) | wiring |

Export `mulberry32` from `tradeExplorerSplits.ts` (add the word `export`) and reuse it.

---

## Part 1 — logic (new file `src/lib/tradeExplorerTraits.ts`)

All functions work on index arrays over one prepared list, so nothing is recomputed.

### 1.1 `prepare(rows, outcome)`

Keep rows whose `values[outcome]` is a finite number, sort by `raw.date` ascending, return
`{ rows, y: number[], n, half: Math.floor(n / 2), canHalves: n >= 150 }`. Index `< half` =
"earlier years", the rest = "later years".

### 1.2 `conditions(p, keys)` → `Cond[]`

```ts
export interface Cond {
  key: string;      // column key
  label: string;
  has: Uint8Array;  // 1 where the row meets the condition (0 when the reading is missing)
  n: number;        // how many rows meet it
  /** How the condition was made, so it can be re-applied to another list of days later. */
  spec: { kind: 'ge' | 'lt'; p: number } | { kind: 'eq'; value: string | number };
}
```

`spec.p` is the quantile that produced the cut (the first one, when two give the same cut).
Export a helper `applySpec(p, key, spec): Uint8Array` that rebuilds `has` on any prepared list
(`ge`/`lt`: cut = `quantile` of that list's own values at `spec.p`; `eq`: equals `value`), and
build `has` in `conditions` with it so there is one code path.

- `num` / `time` column (skip if fewer than 8 readings): for p in 0.2, 0.33, 0.5, 0.67, 0.8 take
  `quantile(values, p)`, de-duplicate. Two conditions per cut:
  - `>= cut`: label `"<label> <cut> or more"` (time: `"<label> <cut> or later"`)
  - `< cut`: label `"<label> below <cut>"` (time: `"<label> before <cut>"`)
- `cat` column: one condition per non-null value from `categoryValues`: `"<label>: <value>"`.
- Skip `text` and `date` columns. Format values with `formatCell(c, v)`, label is `c.label`.

### 1.3 `lossGroups(p, line, fmt)` → `LossGroup[]`

`{ id, label, idx: number[], rare: boolean }`, returned in this order:

1. **`allAbove`**: every day with `y > line`. Label `All days above <line>`. Always present. This
   is the user's main question (above the line against below it).
2. `rareCut = quantile(y, 0.95)`. The rare days are those above the line with `y > rareCut`; use
   a rare group only if it has at least 8 days and `rareCut > line`. The remaining above-line days
   are the "frequent" ones.
3. Sub-bands of the frequent days, only when they add something:
   - 60 or more frequent days: split at their own median `m` into `high1` = `<line> to <m>`
     (`y <= m`) and `high2` = `<m> to <top>`.
   - fewer than 60 but a rare group is used: one band `high1` = `<line> to <top>`.
   - fewer than 60 and no rare group: no sub-bands (`allAbove` already is that group).
   `<top>` is `rareCut` when the rare group is used, else the largest `y`.
4. **`rare`** (if used): label `Above <rareCut>`, `rare: true`.
5. **`below`**: `y <= line`. Label `Up to <line>`. Always present, always last.

"Elsewhere" for any group always means every row of `p` that is not in that group.

`fmt` formats an outcome value (the panel passes `formatCell(outcomeColumn, v)`).

### 1.4 `groupTraits(p, group, conds)` → `Trait[]` (at most 3)

For each condition: `a` = rows of the group that meet it, `b` = other rows that meet it,
`cov = a / groupSize`, `other = b / (n − groupSize)`, `diff = cov − other`.

1. Keep conditions with `cov >= 0.5` and `diff > 0`. Sort by `diff`, largest first.
2. Keep only the best condition per column key.
3. Fold same-day conditions (walk in order): a condition joins an earlier kept one when
   `(rows meeting both) / (rows meeting either) >= 0.7`; push its column label onto the kept
   one's `same` (no duplicates, never the kept one's own label) and drop it.
4. Take the first 3. For each:

```ts
export interface Trait {
  cond: Cond;
  inGroup: number; groupSize: number;    // "186 of 288"
  elsewhere: number; elseSize: number;   // "523 of 1,150"
  diff: number;
  kind: 'unique' | 'lean' | 'weak';      // see below
  strong: boolean;                       // diff >= 0.35 (decides what gets traced back)
  same: string[];
  years: '' | 'Same in earlier and later years' | 'Earlier years only' | 'Later years only'
           | 'Not steady across years';
  examples: string[];                    // 3 dates
}
```

- `kind`: `unique` needs BOTH `diff >= 0.35` AND `other <= 0.35` (common here and rare
  elsewhere; 83% against 48% is not unique). Otherwise `lean` when `diff >= 0.10`, else `weak`.
- `years`: `''` when `!p.canHalves`. Otherwise compute `cov − other` separately on the earlier
  rows and on the later rows; a half "holds" when its value is `>= diff / 2`. Both hold → `Same in
  earlier and later years`; one → `Earlier years only` / `Later years only`; none → `Not steady
  across years`.
- `examples`: among the group's rows that meet the condition, the 3 whose outcome is closest to
  the group's median outcome; return their `raw.date`.

### 1.5 `traitChance(p, group, conds, topDiff)` → number (0–1)

How often shuffled data gives a best `diff` at least as large as `topDiff`. Shuffle the group
membership (a `Uint8Array` of n with `groupSize` ones; Fisher–Yates with `mulberry32`, fixed seed),
and for every shuffle take the largest `diff` over ALL `conds` that have `cov >= 0.5`. 200 shuffles
when `n <= 500`, else 40. Return `hits / shuffles`. This is the slow part: plain loops over the
`Uint8Array`s, no allocation inside the shuffle loop.

### 1.6 `pairTrait(p, group, kept)` → `Trait | null`

Only when `p.n >= 300`. `kept` = the folded list from 1.4 step 3 (so look-alike readings cannot
pair with each other), first 8 entries. For every
pair with different keys build the AND condition (label `"<A> and <B>"`, `key` = A's key) and score
it as in 1.4. Return the best pair only if `cov >= 0.5`, `diff >= (best single diff) + 0.10`, and
its `years` is `Same in earlier and later years`. (On the real data this rule almost never fires;
that is intended.) Add `export interface PairTrait extends Trait {
second: Cond }` so the UI can filter on both columns.

### 1.7 `traceBack(p, dayCond, entryConds)` → `{ cond, withRate, withoutRate, days, sure } | null`

"Could this day-trait be seen at the signal?" For each entry condition `e` with
`e.n >= minN` and `n − e.n >= minN`, where `minN = max(15, floor(0.15 × n))`:
`withRate` = share of `e` rows that meet `dayCond`, `withoutRate` = share of the other rows that
meet it. Take the largest `withRate − withoutRate` (the gap).

- `p.canHalves`: return it only if the gap is at least 0.15 AND the same gap computed on the
  earlier rows alone and on the later rows alone is each at least half of it. `sure: true`.
- otherwise: return it only if the gap is at least 0.25. `sure: false`.
- else `null`.

### 1.8 `worstCriteria(p, line, entryConds)` → `{ base: number, lines: WorstLine[] } | null`

`null` when `p.n < 60`. `above[i] = y[i] > line`. `base` = share of all rows above the line.

```ts
export interface WorstLine {
  cond: Cond; second?: Cond;       // second is set on "made worse by" lines
  days: number; share: number;     // share of these days above the line
  lift: number;                    // share − share among the rows that do not meet it
  median: number;                  // median outcome of these days
  same: string[];
  years: Trait['years'];
  examples: string[];              // 3 dates above the line, closest to this line's median
  worseWith: WorstLine[];          // empty on "made worse by" lines
}
```

- Singles: conditions with `n >= minS` and `p.n − n >= minS`, `minS = max(20, floor(0.08 × n))`.
  `lift = share − (share above the line among rows NOT meeting it)`. Keep `lift > 0`, sort by
  `lift`, best per key, fold as in 1.4 step 3, take the first 6.
- `years` for a line: `''` when `!p.canHalves`. Else compute, per half, the share above the line
  for the line's rows and for all rows of that half; a half holds when
  `(line share − half's overall share) >= (share − base) / 2` and the line has at least 10 rows in
  that half. Words as in 1.4.
- `worseWith` (only when `p.n >= 300`), for each of the 6 singles: every other-key entry condition
  ANDed with it, keeping pairs with `days >= max(20, floor(0.04 × n))`, `days <= 0.8 × single's
  days`, `share >= single's share + 0.05`, and `years === 'Same in earlier and later years'`. Sort
  by `share`, best per second key, fold as in 1.4 step 3 (using the pair's own `has`), first 3.

### 1.9 `worstChance(p, line, entryConds, topLift)` → number (0–1)

Used only when `!p.canHalves` (small sets have no years check). Shuffle the above-the-line flags
(fixed seed, 200 shuffles) and, for each shuffle, take the largest single-condition `lift` over all
conditions that pass the `minS` size rule of 1.8. Return the share of shuffles whose best lift is
at least `topLift` (the real first line's `lift`).

### 1.10 Tests (new file `src/lib/tradeExplorerTraits.test.ts`)

Six small vitest cases with hand-built rows (same `day(...)` style as the existing test file):

1. `lossGroups`: 200 rows with outcomes 1…200, line 100 → ids in order `allAbove` (100 days),
   `high1`, `high2`, `rare` (10 days), `below` (100 days).
2. `lossGroups` with 50 rows → only `allAbove` and `below`.
3. `groupTraits`: a flag column that is `Yes` for 9 of 10 group rows and 1 of 30 others comes
   first with `kind: 'unique'`, `inGroup: 9`, `elsewhere: 1`.
4. A second column that copies the first is folded into `same`.
5. `traceBack` returns `null` when no entry condition changes the day-trait's rate by 0.25; and
   a trait at 80% here / 45% elsewhere is `lean` with `strong: true`, not `unique`.
6. `worstCriteria` returns `null` under 60 rows and ranks a planted condition first on 120 rows.

### Fable checkpoint 1 — run it now (see "Fable checkpoints")

---

## Part 2 — glossary (new file `src/lib/tradeExplorerGlossary.ts`)

```ts
export interface Gloss { what: string; unlike?: string; where: string }
export function glossFor(key: string): Gloss
```

- `what` = the entry from `WHAT` below if present, else the column's `title`.
- `unlike` = the entry from `UNLIKE` below if present.
- `where` = `Table column "<label>". <panel sentence><live sentence>` where the panel sentence
  comes from the column's `section`:
  - `Signal` → `In a day's detail: "The signal".`
  - `IV signal` → `In a day's detail: "IV signal for this day".`
  - `Greeks` → `In a day's detail: "Greeks and IV at the signal".`
  - `Day`, `Trade` → `In a day's detail: the facts at the top.`
  - `After entry`, `Report groups` → `In a day's detail: the chart and "Minute by minute".`
  - overrides: `prevMaxLoss` → `In the table only: it is the previous day's Max loss.`;
    `warnGroup` → `In a day's detail: the facts at the top.`
  - and the live sentence is ` Live: the IV SIGNAL card on the phone.` for `ivRatio`, `ivLevel`,
    `ivNow`, `ivUsual` only.

`WHAT` (use these texts verbatim):

| key | what |
| --- | --- |
| ivNow | The raw IV at the signal: the average of the call and put IV. It is not compared with anything. |
| ivUsual | What IV normally is on this day-to-expiry: the middle value of the last 20 such days. |
| ivRatio | IV now divided by the usual IV. 1.00 means normal for this day-to-expiry; 1.20 means 20% higher than normal. |
| ivLevel | The IV ratio placed in the phone app's five levels, Very low to Very high. The cut-offs differ by index and day-to-expiry. |
| warnGroup | The report's warning group. "IV high for now" = IV now was well above the middle of the last 8 readings (a short memory, with the report's own cut-off for each day-to-expiry). "Other warning signs only" = IV was not high by that test, but the mismatch, the previous day's max loss or the morning move was large. "Calm" = none of these. |
| ceIv | IV of the one call leg (the 09:15 call) at the signal. |
| peIv | IV of the one put leg (the 09:15 put) at the signal. |
| skew | Put IV minus call IV, in points. Above zero means the put is priced richer than the call. |
| ceChange | How much the seller gained or lost on the 09:15 call between t1 and the signal, ₹ per lot. |
| peChange | How much the seller gained or lost on the 09:15 put between t1 and the signal, ₹ per lot. |
| both | The call and put changes added together, ₹ per lot. |
| gap | How far the call change and the put change disagreed, ₹ per lot. This is the mismatch the signal is built on. |
| gapPct | The mismatch as a share of the bigger leg's change. The rule needs at least 50%. |
| premium | Call plus put price collected at entry, ₹ per lot. |
| theta | Time decay of both legs at the signal, ₹ per lot per day. More negative = more decay. |
| vega | How much both legs move for one point of IV, ₹ per lot. |
| deltaLean | How one-sided the position is at the signal: 0 is balanced, higher leans to one side. |
| prevMaxLoss | The previous trading day's max loss, ₹ per lot. Known before today's signal. |
| morning | How far spot moved from 09:15 to the signal. |
| dte | Trading days left to expiry: Exp is expiry day. |

`UNLIKE` (verbatim; one text shared by each family):

- `ivNow`, `ivUsual`, `ivRatio`, `ivLevel`, `ceIv`, `peIv`, `skew`, `warnGroup`:
  `There are several IV readings. "IV now" is the raw level. "IV ratio" and "IV level" compare it with the last 20 days on the same day-to-expiry (the phone's IV SIGNAL). The warning "IV high for now" compares it with only the last 8 readings and uses the report's cut-offs, so it picks partly different days from "IV level: Very high". "Call IV" and "Put IV" are single legs. "Put−call IV" is the gap between them. A finding about one is not a finding about the others.`
- `ceChange`, `peChange`, `both`, `gap`, `gapPct`:
  `"Call t1→t2" and "Put t1→t2" are each leg's own change. "Both" adds them. "Mismatch ₹" is how far they disagreed, and "Mismatch %" is that as a share of the bigger leg.`
- `premium`, `theta`, `vega`:
  `Premium, Theta and Vega all grow with days to expiry and with IV, so they often pick the same days as "Day" or the IV readings.`
- `t1`, `t2`, `wait`:
  `"t1" is the first matching moment, "Signal" (t2) is when the trade is placed, and "t1→t2 min" is the wait between them.`

---

## Part 3 — views (new file `src/components/TradeExplorerLossViews.tsx`)

Two exported components. Both get the same props:

```ts
interface LossViewProps {
  rows: DayRow[];
  outcome: Outcome;
  linePct: number;                       // 0.30 … 0.90
  onPick(picks: Array<{ key: string; side: DayRow[]; label: string }>, close: boolean): void;
  onOpenDay(date: string): void;
}
```

Shared, at the top of the file:

- `const p = useMemo(() => prepare(rows, outcome), …)`, `line = quantile(p.y, linePct)`,
  `entry = conditions(p, ENTRY_KEYS)`, `after = conditions(p, AFTER_KEYS)` (each memoised).
- `sideOf(cond)` = the rows of `p.rows` where `cond.has` is 1 (this is what `onPick` receives).
- `<TraitLine>`: one finding. Layout:
  `<kind badge> <cond.label> <? button>` then
  `<inGroup> of <groupSize> here · <elsewhere> of <elseSize> elsewhere` then, in muted text,
  `Same days as: …` (if any) · the `years` word (if any) · `Examples:` three date buttons
  (`onOpenDay(date)`). The label itself is a button: `onPick([{ key, side: sideOf(cond), label }],
  false)`; for a `PairTrait` pass both conditions.
  - Badge words: `Unique`, `Lean`, `Weak`.
  - The `?` button toggles an info box under the line with three rows from `glossFor(key)`:
    `What it is`, `Not the same as` (only if `unlike`), `Where to see it`.
- Under 30 rows both views show only: `Too few days (<n>). Widen the criteria.`

### `LossGroupsView`

Top: one line `Loss line <line> · <k> of <n> days above it`.

Then one card per group, in the order `lossGroups` returns them (`allAbove`, the frequent bands,
`rare`, `below`). Card heading: the group label, a badge `<days> days`, plus `rare` for the rare
group and `few` when under 20 days. Card body, in this order:

1. **`AT THE SIGNAL`** (eyebrow). `groupTraits(p, group, entry)` then `pairTrait`.
   - While the chance for this section is being computed show `checking…`.
   - Chance `>= 0.2`, or no traits: one sentence `Nothing at the signal marks these days.` and, if
     there are traits, the first one below it in muted style with the badge `Could be chance`.
   - Otherwise list the traits (and the pair, labelled `Together`), and add the badge
     `Could be chance` to the section when chance is between 0.05 and 0.2.
2. **`DURING THE DAY`** (eyebrow, muted caption `Known only after the day is over.`). Same rules
   with `after`. No pair here.
3. **`COULD IT BE SEEN AT THE SIGNAL?`** For each day-trait with `strong` true (at most 2):
   `traceBack(p, trait.cond, entry)` →
   `<day-trait label>: yes. <cond.label> → <withRate>% of <days> days, against <withoutRate>%
   otherwise.` with a `?` button for that signal reading, plus ` Few days: could be chance.` when
   `sure` is false; or
   `<day-trait label>: not visible at the signal.`

Chances: compute all sections' `traitChance` in ONE `useEffect` with `setTimeout(…, 0)` after the
traits are known (clear the timeout on cleanup; ignore results for an older `p`/`line`), store them
in state keyed by `<group id>|signal` / `<group id>|day`.

### `WorstCriteriaView`

`worstCriteria(p, line, entry)`.

- `null` → `Too few days for a worst-criteria list (<n>). It needs 60.`
- Heading eyebrow `WORST CRITERIA`, title `Which conditions put the most days above the line?`,
  caption `Of all these days, <base>% are above <line>.`
- One row per line: `<cond.label> <?>` · `<days> days` · `<share>% above the line` ·
  `median <median>` · muted: `Same days as …` · `years` word · three example date buttons.
  Clicking the label: `onPick([{ key, side, label }], false)`.
- Under a row, indented, its `worseWith` lines prefixed `made worse by`:
  `<second.label> <?>` · days · share · median · years. Clicking one picks BOTH conditions
  (`onPick` with two entries; each `side` is that condition's own rows).
- When `!p.canHalves`: compute `worstChance` deferred (same `setTimeout` pattern). While waiting
  show `checking…`. Chance `>= 0.2` → replace the title with
  `No condition clearly raises the losses on these days.` and show the rows in muted style;
  between 0.05 and 0.2 → badge `Could be chance` next to the title. Also add the caption
  `Too few days to check earlier against later years.`

Styling: append `te-loss-` classes to the END of `src/tradeExplorer.css`, reusing
`.te-chart-card`, `.te-card-heading`, `.te-eyebrow`, `.te-badge`, `.te-caption`, `.te-split-muted`.
Only existing CSS variables, no hard-coded colours. Above-the-line cards get a left border in
`var(--red)`. One column under 760px.

---

## Part 4 — wiring

### `src/components/TradeExplorerSplits.tsx`

1. Mode type becomes `'groups' | 'worst' | 'split' | 'bands'` (props `mode` / `onMode`).
2. New props: `onPickMany(picks: Array<{ key: string; side: DayRow[]; label: string }>, close:
   boolean): void` and `onOpenDay(date: string): void`.
3. In the `View` button group add, BEFORE `Natural split`: `Loss groups` (groups) and
   `Worst criteria` (worst).
4. Local state `const [linePct, setLinePct] = useState(0.5)`; reset it to 0.5 in a `useEffect`
   on `[rows]`. When mode is `groups` or `worst`, show in the controls row:
   `Loss line` + `<input type="range" min={0.3} max={0.9} step={0.05}>` + the text
   `<line value> · top <100 − pct>% of days` (line value = `quantile` of the outcome at
   `linePct`, formatted with `formatCell`). Hide the `Also show what happened after entry`
   checkbox in these two modes.
5. Render `<LossGroupsView>` / `<WorstCriteriaView>` for the two new modes, passing
   `onPick={props.onPickMany}`. Make sure `rankSplits` / `bandCompare` are not computed in the
   new modes (their `useMemo`s already check `mode`; keep that true).

### `src/TradeExplorer.tsx`

1. `splitMode` state type gets the two new values and its default becomes `'groups'`.
2. Pass `onPickMany`: for each pick, `setFilter(key, bucketFilter(column, { id: '', label, rows:
   side }))`; if `close`, close the overlay and clear the trail; else append ALL picks to
   `splitTrail` in one `setSplitTrail` call (each with its own `prev` filter, read before setting).
   Also make every picked column visible: if a picked key is missing from `settings.columns`
   (or from `settings.detailColumns` when that is set), add it with one functional `setSettings`
   update.
3. Pass `onOpenDay={(date) => { setSelected(date); setShowSplits(false); setSplitTrail([]); }}`.

---

## Fable checkpoints

Fable reviews; you fix. The user has approved these two Fable reviews. Use them at exactly two
points. Wait for the review's reply before continuing; never guess or predict what it will say. If you have an `advisor` tool, call it
(no arguments). Otherwise use the Agent tool with `model: "fable"` and the prompt given. Apply
every defect it reports, then continue. At most ONE re-review per checkpoint, and only if a defect
was marked blocking.

**Checkpoint 1 — after Part 1 and its tests pass.** Agent prompt:

> Review only. Read `docs/loss-groups-brief-A.md` sections 1.1–1.8 and the file
> `src/lib/tradeExplorerTraits.ts` in `E:\Derivativesproject\nubra-dashboard`. Check each function
> against its rule: thresholds, `>=` vs `>`, the fold rule, the halves rule, the shuffle count,
> which rows count as "elsewhere". Do not edit files and do not read other files. Reply with at
> most 10 numbered defects, each with file:line, what is wrong, the exact fix, and `blocking` or
> `minor`. If there are none reply `No defects`.

**Checkpoint 2 — after all checks pass, before the report.** Agent prompt:

> Review only. Read `docs/loss-groups-brief-A.md` Parts 2–4 and "Acceptance", then
> `src/lib/tradeExplorerGlossary.ts`, `src/components/TradeExplorerLossViews.tsx`, and
> `git diff -- src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx src/tradeExplorer.css`
> in `E:\Derivativesproject\nubra-dashboard`. Check: wording matches the brief; signal-time
> findings come before day findings; the old two views are untouched; chance work is deferred and
> cancelled on cleanup; no hard-coded colours; a pair pick filters both columns. Do not edit files.
> Reply with at most 10 numbered defects (file:line, problem, exact fix, `blocking` or `minor`),
> or `No defects`.

## Checks (run from `nubra-dashboard`, in this order)

```bash
npx vitest run src/lib/tradeExplorerTraits.test.ts src/lib/tradeExplorerSplits.test.ts
npx prettier --write src/lib/tradeExplorerTraits.ts src/lib/tradeExplorerTraits.test.ts src/lib/tradeExplorerGlossary.ts src/components/TradeExplorerLossViews.tsx
npx eslint src/lib/tradeExplorerTraits.ts src/lib/tradeExplorerTraits.test.ts src/lib/tradeExplorerGlossary.ts src/components/TradeExplorerLossViews.tsx src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx
npx prettier --check src/components/TradeExplorerSplits.tsx src/TradeExplorer.tsx src/lib/tradeExplorerSplits.ts src/tradeExplorer.css
npm run typecheck
```

If `prettier --check` flags an existing file, fix only your own lines by hand.

## Acceptance (figures from a trial run of these same rules)

Write this temporary script as `scratch/accept-a.mts`, run `npx tsx scratch/accept-a.mts`, compare,
then DELETE it:

```ts
import { readFileSync } from 'node:fs';
import { buildDayRows, quantile } from '../src/lib/tradeExplorer';
import { ENTRY_KEYS, AFTER_KEYS } from '../src/lib/tradeExplorerSplits';
import { prepare, conditions, lossGroups, groupTraits, traceBack, worstCriteria } from '../src/lib/tradeExplorerTraits';
const run = JSON.parse(readFileSync('.signal-cache/NIFTY/explorer-run.json', 'utf8'));
const p = prepare(buildDayRows(run.rows, 'NIFTY'), 'maxLoss');
const line = quantile(p.y, 0.5) as number;
const entry = conditions(p, ENTRY_KEYS), after = conditions(p, AFTER_KEYS);
console.log('n', p.n, 'line', Math.round(line));
for (const g of lossGroups(p, line, (v) => String(Math.round(v)))) {
  const s = groupTraits(p, g, entry)[0], d = groupTraits(p, g, after)[0];
  const t = d && traceBack(p, d.cond, entry);
  console.log(g.id, g.label, g.idx.length, '| signal:', s?.cond.label, s?.inGroup, s?.elsewhere, s?.kind, s?.years,
    '| day:', d?.cond.label, d?.inGroup, d?.elsewhere, d?.kind, '| seen:', t ? `${t.cond.label} ${Math.round(t.withRate * 100)} vs ${Math.round(t.withoutRate * 100)}` : 'no');
}
const w = worstCriteria(p, line, entry)!;
for (const l of w.lines) console.log('WORST', l.cond.label, l.days, Math.round(l.share * 100), Math.round(l.median), l.same.join(','), l.years, '|', l.worseWith.map((x) => `${x.second!.label} ${x.days} ${Math.round(x.share * 100)}`).join(' ; '));
```

Expected (NIFTY saved run, all 1,438 days, ₹, line at the median). Small differences in a cut
value are fine; a different top reading or a day count off by more than a few is a bug.

| Item | Expected |
| --- | --- |
| n, line | 1438, 1070 |
| Groups, in order | allAbove: 719 days · high1 (1070 to 2379): 324 · high2 (2379 to 7675): 323 · rare (above 7675): 72 · below (up to 1070): 719 |
| allAbove, signal | `IV ratio 0.98 or more`, 417 here, 292 elsewhere, `lean` |
| allAbove, day | `Touched: Yes`, 639 here, 165 elsewhere, `unique` |
| high1, signal | a `weak` trait (diff under 0.10) |
| high2, signal | `IV now 14.12 or more`, 249 here, 714 elsewhere, `lean` |
| high2, day | `Touched: Yes`, 315 here, 489 elsewhere, `lean` with `strong`; seen: `IV level: Very high` 83 vs 49 |
| rare, signal | `IV ratio 0.98 or more`, 60 here, 649 elsewhere, `lean` (48% elsewhere is too common for `unique`), same in earlier and later years |
| rare, day | `Range % 1.07% or more`, 71 here, 217 elsewhere, `unique` |
| below, signal | `IV ratio below 0.98`, 421 here, 287 elsewhere, `lean` |
| below, day | `Touched: No`, 554 here, 80 elsewhere, `unique` |
| Worst line 1 | `IV level: Very high`, 294 days, 68% above, median 2069, same days as IV ratio, same in earlier and later years; made worse by `Day: Exp` (62 days, 77%) |
| Worst line 2 | `Warning: IV high for now`, 293 days, 65% above, median 2041 |

Finally `npm run build` (this refreshes what `localhost:3000` serves). If a built-in browser is
available: open `http://localhost:3000` → `Trade Explorer` → `Trade by trade` → tick
`What differs`. It must open on `Loss groups` with five cards, `All days above ₹1,070` first. Move the loss
line to the right: the day count above it must fall and the cards must change. Click `Worst
criteria`: the first row must be `IV level: Very high`. Click a trait label: the trail shows one
step and `← Back` restores the days. `Natural split` and `Split by loss size` must still work. If
no browser is available, say so.

## Report back (under 15 lines)

- Files created and edited.
- Each check command: pass/fail (failure text if any).
- The acceptance lines that did not match, with what you got.
- What Fable reported at each checkpoint and what you changed.
- Anything you could not do as written.
