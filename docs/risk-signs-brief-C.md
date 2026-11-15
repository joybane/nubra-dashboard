# Brief C: Trade Explorer "Risk signs" count and "Rule tester"

You are the executor. Implement this brief in `E:\Derivativesproject\nubra-dashboard` exactly as
written, directly in this session (this brief overrides the executor rule in `AGENTS.md`). The
design is final and every rule was already run on the real data. Fable reviews at two checkpoints.

## Ground rules

- No redesign, no questions to the user, no exploring. Read ONLY what "What to read" lists; find
  edit points with Grep on the quoted anchors.
- New logic and views go in NEW files; existing files get only the listed edits.
- Do not change the behaviour of the six existing "What differs" views beyond what is listed.
- No commits. No new dependencies. No server changes. Do not start, stop or restart any server.
- If typecheck, lint or a test fails in a file you did not edit, report it and stop.
- Wording is plain English exactly as given. Money is ₹ per lot.

## What the user wants

Research on their data showed that no single reading at the signal marks the big-loss days, but
four simple signs counted together do, steadily, on NIFTY and SENSEX. They want:

1. **Risk signs**: a count (0 to 4) of four signs known at the signal, as table columns and as a
   view that shows how the days on screen did for each count.
2. **Rule tester**: for the days on screen ("flagged days"), what skipping them would have done
   year by year, and what selling further out on them would have done.

The name is "Risk signs" on purpose: the table already has the report's own "Warning" and
"Warning signs" columns, which are a different thing.

## What to read

| File | What | Why |
| --- | --- | --- |
| `src/lib/tradeExplorer.ts` | Grep `key: 'gapPct'` (11 lines) | shape of a column entry |
| `src/lib/tradeExplorer.ts` | Grep `export function buildDayRows` and read to the end of that function (about 125 lines) | where rows are built |
| `src/lib/tradeExplorerSplits.ts` | Grep `export const ENTRY_KEYS` (30 lines) | list to extend |
| `src/lib/tradeExplorerGlossary.ts` | whole file (short) | texts to extend |
| `src/lib/tradeExplorerCompare.ts` | lines 20–75 | `SlimDay`, `slimSet`, `SetLine`, `setLine` |
| `src/components/TradeExplorerCompareViews.tsx` | lines 1–165 | the set loader to share, table markup to copy |
| `src/components/TradeExplorerSplits.tsx` | lines 27–60, and Grep `mode === 'worst'` (read 15 lines around each match) | modes, props, controls |
| `src/components/TradeExplorerLossViews.tsx` | Grep `glossFor` (read 25 lines around the first use) | how the `?` info box is drawn; reuse it |
| `src/TradeExplorer.tsx` | Grep `const [splitMode` (5 lines) | mode state |

---

## Part 1 — the readings (edit `src/lib/tradeExplorer.ts`)

### 1.1 Three new columns (add to `COLUMNS`, after the `gapPct` entry)

| key | label | title | section | type | other |
| --- | --- | --- | --- | --- | --- |
| `strikeDist` | `Strike distance` | `How far the sold strikes are from spot, counted in implied moves to expiry (1.00 = one implied move away)` | `Signal` | `num` | `width: 100, digits: 2` |
| `warnCount` | `Risk signs` | `How many of the four risk signs were present at the signal (0 to 4)` | `Signal` | `num` | `width: 84, digits: 0` |
| `warnSigns` | `Signs present` | `Which risk signs were present at the signal` | `Signal` | `text` | `width: 220` |

None is `shown` by default.

### 1.2 Pure helpers (export all, place just above `buildDayRows`)

```ts
/** Half the gap between the sold strikes, in implied moves to expiry. */
export function strikeDistance(ce: number | null, pe: number | null, spot: number | null,
  ivNow: number | null, dte: number | null): number | null
//  null if any input is null, or spot <= 0 or ivNow <= 0.
//  = ((ce − pe) / 2 / spot × 100) / ((ivNow / Math.sqrt(252)) × Math.sqrt(Math.max(0.35, dte + 0.75)))

export const RISK_SIGNS = [
  { id: 'iv',   key: 'ivRatio',     label: 'IV ratio high',           side: 'ge', p: 0.8  },
  { id: 'dist', key: 'strikeDist',  label: 'Strikes close',           side: 'le', p: 0.2  },
  { id: 'gap',  key: 'gap',         label: 'Mismatch large',          side: 'ge', p: 0.8  },
  { id: 'prev', key: 'prevMaxLoss', label: 'Previous day loss large', side: 'ge', p: 0.67 },
] as const;

/** Each sign's cut-off: that quantile of the column over the given rows (null if no readings). */
export function riskCuts(rows: DayRow[]): Record<string, number | null>      // keyed by sign id

/** Which signs a row shows. A missing reading is "not present". `ge` is >= cut, `le` is <= cut. */
export function riskFlags(row: DayRow, cuts: Record<string, number | null>): boolean[]  // RISK_SIGNS order
```

### 1.3 Fill the columns in `buildDayRows`

- Inside the per-row `values` object add
  `strikeDist: strikeDistance(ce?.strike ?? null, pe?.strike ?? null, s.spot2, <the same IV-now value this row stores as ivNow>, raw.dte ?? null)`.
- `buildDayRows` currently returns the mapped array directly. Keep the array in a constant, then
  do one more pass before returning it: `cuts = riskCuts(out)`; for each row set
  `values.warnCount` = number of true flags and `values.warnSigns` = the present signs' labels
  joined with ` · `, or `None`.

Cut-offs therefore come from all days of whichever trade set and index was loaded.

### 1.4 Other small edits

- `src/lib/tradeExplorerSplits.ts`: add `'strikeDist'` to `ENTRY_KEYS` right after `'gapPct'`, and
  `'warnCount'` as the LAST entry.
- `src/lib/tradeExplorerGlossary.ts`:
  - `WHAT.strikeDist` = `How far the sold strikes sit from spot, counted in implied moves: half the gap between the two strikes, divided by the move IV is pricing between now and expiry. Below about 0.25 the strikes are close; a strike 150 points away is close when IV is high and far when IV is low.`
  - `WHAT.warnCount` = `How many of four signs were present at the signal: IV ratio high (top fifth), strikes close (closest fifth), mismatch large (top fifth), previous day's loss large (top third). The cut-offs come from all days of the trade set on screen.`
  - `UNLIKE.warnCount` = `Not the same as the report's "Warning" and "Warning signs" columns, which use the report's own four tests and cut-offs. "Risk signs" is a plain count, and more signs meant more days above the loss line on both NIFTY and SENSEX.`
  - "Where to see it" for `strikeDist`, `warnCount`, `warnSigns`: override to
    `In the table only (add the column from "Columns").` (follow the file's existing override
    mechanism).

---

## Part 2 — logic (new file `src/lib/tradeExplorerRisk.ts`)

```ts
export interface LadderRow { label: string; rows: DayRow[]; days: number;
  above: number | null;      // share of these days with outcome > line
  median: number | null; oneInTen: number | null;
  touched: number | null }   // share with values.touched === 'Yes'
export function riskLadder(rows: DayRow[], outcome: Outcome, line: number): LadderRow[]
//  six rows: counts 0, 1, 2, 3, 4 (label `<k> signs`, `1 sign` for one) and a last row
//  `3 or more`. Only rows with a numeric outcome and a numeric warnCount are used.

export interface SignRow { id: string; label: string; cut: number | null; days: number;
  aboveWith: number | null; aboveWithout: number | null; rows: DayRow[] }
export function riskSignTable(rows: DayRow[], outcome: Outcome, line: number,
  cuts: Record<string, number | null>): SignRow[]          // one per RISK_SIGNS entry

export interface YearRow { year: string; days: number; flagged: number;
  flaggedAbove: number; flaggedBelow: number;
  restAbove: number | null;  // share above the line among the days NOT flagged
  allAbove: number | null }  // share above the line among all days of the year
export function ruleYears(allRows: DayRow[], flagged: ReadonlySet<string>, outcome: Outcome,
  line: number): YearRow[]   // one per calendar year (ascending), then a row with year 'All years'
```

Also extend `src/lib/tradeExplorerCompare.ts` (small edit): `SlimDay` gains
`touched: boolean | null` (from `values.touched === 'Yes'`, null when the value is missing) and
`SetLine` gains `touchedShare: number | null` (share of the chosen days, among those with a
non-null `touched`, where it is true). Update `slimSet` and `setLine`.

### Tests (new file `src/lib/tradeExplorerRisk.test.ts`, vitest, hand-built rows)

1. `strikeDistance(22100, 21900, 22000, 16, 2)` is about 0.27 (to 2 decimals), and is `null` when
   `ivNow` is null.
2. `riskFlags`: a row at or beyond every cut-off gives four `true`; a row with no `ivRatio`
   reading gives `false` for that sign.
3. `riskLadder` returns six rows, the last one's `days` equals the days with 3 plus the days
   with 4, and `above` is the right share.
4. `ruleYears` gives one row per year plus `All years`, and
   `flaggedAbove + flaggedBelow === flagged` on every row.
5. `setLine` reports `touchedShare` from the chosen dates only.

### Fable checkpoint 1 — run it now

---

## Part 3 — views (new file `src/components/TradeExplorerRiskViews.tsx`)

First, a small refactor in `src/components/TradeExplorerCompareViews.tsx` so both files share one
loader: move the loading logic of `StrikeDistancesView` (the `slimSets` map lookups, `load`,
`loading`, `failed`, the `alive` ref) into an exported hook
`useSlimSets(underlying): { get(setKey): SlimSet | undefined; loading: string | null;
failed: ReadonlySet<string>; anyLoaded: boolean; load(): Promise<void> }` and make
`StrikeDistancesView` use it. Export `SETS`, `rupees` and `percent` too. Behaviour must not change:
nothing loads before the click, one set at a time, plain `fetch`, stop on unmount.

### `RiskSignsView`

Props: `{ rows: DayRow[]; allRows: DayRow[]; outcome: Outcome; linePct: number;
onPick(picks: Array<{ key: string; side: DayRow[]; label: string }>, close: boolean): void }`.

`line` = `quantile` of the outcome over `rows` at `linePct`. `cuts = riskCuts(allRows)`.

1. Card, eyebrow `RISK SIGNS`, title `How did these days do, by number of signs?`, caption
   `Four signs known at the signal. Cut-offs come from all <n> days of this trade set.`
2. The four definitions, one line each, with the `?` info box (`glossFor(sign.key)`):
   - `IV ratio high: IV ratio <cut> or more`
   - `Strikes close: Strike distance <cut> or less`
   - `Mismatch large: Mismatch ₹ <cut> or more`
   - `Previous day loss large: Prev max loss <cut> or more`
   (format each cut with `formatCell` of its column).
3. Ladder table from `riskLadder`: columns `Signs` · `Days` · `Above <line>` (%) ·
   `Median max loss` · `1 in 10 past` · `Strike touched` (%). Add `few` beside a day count under
   20. The `3 or more` row is visually separated (top border). Clicking a row's label calls
   `onPick([{ key: 'warnCount', side: row.rows, label: 'Risk signs: ' + row.label }], false)`.
4. Second table from `riskSignTable`, title `Each sign on its own`: `Sign` · `Days with it` ·
   `Above the line with it` (%) · `Without it` (%). Clicking a sign's label picks that sign's
   column (`key` = the sign's column key, `side` = its rows).
5. Under 30 rows show only `Too few days (<n>). Widen the criteria.`

### `RuleTesterView`

Props: `{ rows: DayRow[]; allRows: DayRow[]; outcome: Outcome; underlying: SignalUnderlying;
tradeSet: string; onPick(...same as above...) }`.

The **flagged days** are the days on screen (`rows`); everything is measured against all days of
the trade set (`allRows`). `line` = median of the outcome over `allRows`.

1. If `rows.length === allRows.length` (nothing is flagged yet) show only:
   `Choose the days to test first. Filter the table, click a line in Worst criteria, or use one
   of these:` and three buttons `2 or more risk signs`, `3 or more risk signs`,
   `4 risk signs`. A button calls `onPick` with `key: 'warnCount'` and `side` = the rows of
   `allRows` whose `warnCount` is at least that number (`close: false`).
2. Otherwise a card, eyebrow `RULE TESTER`, title `What if these <k> days had been treated
   differently?`, caption `Flagged days are the days on screen. The loss line is <line>, the
   median of all <n> days of this trade set.`
3. Table `If you had skipped them` from `ruleYears`: `Year` · `Days` · `Flagged` ·
   `Flagged, above the line` · `Flagged, below the line` · `Other days above the line` (%) ·
   `All days above the line` (%). The `All years` row is bold.
4. Section `If you had sold further out on them`. Uses `useSlimSets(underlying)`.
   - Before loading: the button `Load the eight strike distances` (same wording as the Strike
     distances view) and nothing else.
   - After: one table with a row per set (`OTM 0 (ATM)` … `OTM 7`) and two column groups,
     `Flagged days` and `Other days`, each with `Days` · `Median max loss` · `1 in 10 past` ·
     `Median, % of premium` · `Strike touched` (%). Flagged = `setLine(flaggedDates, slim)`;
     other = `setLine(allDates minus flaggedDates, slim)`. Mark the set on screen with
     `on screen` (`saved` counts as `otm2`).
   - Caption: `Selling further out collects less premium, so rupees fall while "% of premium"
     can rise. "Strike touched" shows how often spot reached a sold strike.`

Styling: append `te-risk-` classes to the END of `src/tradeExplorer.css`, reusing the existing
card and table classes (`te-chart-card`, `te-card-heading`, `te-eyebrow`, `te-caption`, the
`te-cmp-` table classes). Existing variables only, no hard-coded colours.

---

## Part 4 — wiring

### `src/components/TradeExplorerSplits.tsx`

1. `SplitMode` gains `'risk'` and `'rule'`.
2. Add two buttons to the `View` group right AFTER `Worst criteria`: `Risk signs` (risk) and
   `Rule tester` (rule).
3. The loss line control is shown in `risk` mode as well (extend the existing `isLoss` test). It
   stays hidden in `rule` mode. "Also show what happened after entry" stays hidden in both.
4. Render `<RiskSignsView rows={rows} allRows={props.allRows} outcome={outcome}
   linePct={linePct} onPick={props.onPickMany} />` and `<RuleTesterView rows={rows}
   allRows={props.allRows} outcome={outcome} underlying={props.underlying}
   tradeSet={props.tradeSet} onPick={props.onPickMany} />`.

### `src/TradeExplorer.tsx`

Nothing but the type: the `splitMode` state already uses `SplitMode`; make sure it compiles.

### `E:\Derivativesproject\CLAUDE.md`

In the "What differs" bullet list add one line after the `tradeExplorerCompare.ts` line:
`  - \`tradeExplorerRisk.ts\`: the risk-signs count (four signs, cut-offs from the loaded set; the
readings themselves are built in \`tradeExplorer.ts\`) and the rule tester.`
and change `six views` to `eight views`.

---

## Fable checkpoints

The user has approved these two reviews. If you have an `advisor` tool call it (no arguments);
otherwise use the Agent tool with `model: "fable"` and the prompt below. Wait for the reply,
never predict it. Apply every defect. At most one re-review per checkpoint, only for a blocking
defect.

**Checkpoint 1 — after Parts 1–2 and the tests pass.**

> Review only. In `E:\Derivativesproject\nubra-dashboard`, read `docs/risk-signs-brief-C.md`
> Parts 1–2, the file `src/lib/tradeExplorerRisk.ts`, and
> `git diff -- src/lib/tradeExplorer.ts src/lib/tradeExplorerCompare.ts src/lib/tradeExplorerSplits.ts src/lib/tradeExplorerGlossary.ts`.
> Check: the strike-distance formula; `ge` is >= and `le` is <=; a missing reading is "not
> present"; cut-offs come from the rows passed to `buildDayRows`; the second pass in
> `buildDayRows` does not change any other value; `3 or more` is counts 3 and 4; year rows add
> up. Do not edit files or read other files. Reply with at most 10 numbered defects (file:line,
> problem, exact fix, `blocking` or `minor`), or `No defects`.

**Checkpoint 2 — after all checks pass, before the report.**

> Review only. In `E:\Derivativesproject\nubra-dashboard`, read `docs/risk-signs-brief-C.md`
> Parts 3–4 and "Acceptance", the file `src/components/TradeExplorerRiskViews.tsx`, and
> `git diff -- src/components/TradeExplorerCompareViews.tsx src/components/TradeExplorerSplits.tsx src/tradeExplorer.css`.
> Check: the shared loader still loads nothing before the click, one set at a time, and stops on
> unmount; the Strike distances view behaves as before; the rule tester measures against all
> days of the set, not the days on screen; wording matches the brief; no hard-coded colours.
> Do not edit files. Reply with at most 10 numbered defects (file:line, problem, exact fix,
> `blocking` or `minor`), or `No defects`.

## Checks (run from `nubra-dashboard`, in this order)

```bash
npx vitest run src/lib/tradeExplorerRisk.test.ts src/lib/tradeExplorerCompare.test.ts src/lib/tradeExplorerTraits.test.ts src/lib/tradeExplorerSplits.test.ts src/lib/tradeExplorer.test.ts
npx prettier --write src/lib/tradeExplorerRisk.ts src/lib/tradeExplorerRisk.test.ts src/components/TradeExplorerRiskViews.tsx
npx eslint src/lib/tradeExplorerRisk.ts src/lib/tradeExplorerRisk.test.ts src/lib/tradeExplorer.ts src/lib/tradeExplorerCompare.ts src/components/TradeExplorerRiskViews.tsx src/components/TradeExplorerCompareViews.tsx src/components/TradeExplorerSplits.tsx
npx prettier --check src/lib/tradeExplorer.ts src/lib/tradeExplorerCompare.ts src/lib/tradeExplorerSplits.ts src/lib/tradeExplorerGlossary.ts src/components/TradeExplorerCompareViews.tsx src/components/TradeExplorerSplits.tsx src/tradeExplorer.css
npm run typecheck
```

If an existing test fails only because `ENTRY_KEYS` grew or rows gained three values, update
that test's expectation and say so in the report. Any other failure is a defect in your change.

## Acceptance (figures from a trial run of these same rules)

Write this temporary script as `scratch/accept-c.mts`, run `npx tsx scratch/accept-c.mts`, compare,
then DELETE it:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildDayRows, quantile, riskCuts } from '../src/lib/tradeExplorer';
import { riskLadder, riskSignTable, ruleYears } from '../src/lib/tradeExplorerRisk';
import { slimSet, setLine } from '../src/lib/tradeExplorerCompare';
const load = (u: 'NIFTY' | 'SENSEX', set: string) => {
  const base = `.signal-cache/${u}/explorer-sets`;
  const body = JSON.parse(gunzipSync(readFileSync(`${base}/${readdirSync(base)[0]}/${set}.json.gz`)).toString('utf8'));
  return buildDayRows(body.rows, u);
};
for (const u of ['NIFTY', 'SENSEX'] as const) {
  const rows = load(u, 'saved');
  const line = quantile(rows.map((r) => r.values.maxLoss as number), 0.5) as number;
  console.log(u, rows.length, 'line', Math.round(line), riskCuts(rows));
  for (const l of riskLadder(rows, 'maxLoss', line)) console.log(' ', l.label, l.days, l.above, l.median, l.oneInTen, l.touched);
  for (const s of riskSignTable(rows, 'maxLoss', line, riskCuts(rows))) console.log(' ', s.label, s.days, s.aboveWith, s.aboveWithout);
  if (u !== 'NIFTY') continue;
  const flagged = new Set(rows.filter((r) => (r.values.warnCount as number) >= 3).map((r) => r.raw.date));
  const others = new Set(rows.filter((r) => !flagged.has(r.raw.date)).map((r) => r.raw.date));
  for (const y of ruleYears(rows, flagged, 'maxLoss', line)) console.log(' ', y);
  for (const n of [2, 4, 6]) { const s = slimSet(load('NIFTY', `otm${n}`)); console.log('  OTM', n, setLine(flagged, s), setLine(others, s)); }
}
```

Expected. Shares are shown here as whole percentages. Small rounding differences are fine; a day
count off by more than a few is a bug.

**NIFTY (1,438 days, line ₹1,070).** Cut-offs: IV ratio 1.24, strike distance 0.24, mismatch
₹546, previous day loss ₹2,027.

| Signs | Days | Above the line | Median | 1 in 10 past | Touched |
| --- | --- | --- | --- | --- | --- |
| 0 | 675 | 40% | ₹787 | ₹4,012 | 43% |
| 1 | 407 | 54% | ₹1,222 | ₹5,400 | 59% |
| 2 | 196 | 61% | ₹1,695 | ₹6,455 | 72% |
| 3 | 104 | 62% | ₹1,594 | ₹6,332 | 80% |
| 4 | 56 | 73% | ₹2,978 | ₹9,438 | 84% |
| 3 or more | 160 | 66% | ₹2,059 | | |

Each sign: IV ratio high 284 days, 68% against 46% · Strikes close 288, 64% against 47% ·
Mismatch large 289, 62% against 47% · Previous day loss large 474, 56% against 47%.

Rule "3 or more signs", by year (days, flagged, flagged above, flagged below, others above, all
above): 2021: 246, 15, 10, 5, 42%, 44% · 2022: 247, 20, 12, 8, 47%, 48% · 2023: 245, 8, 5, 3,
40%, 40% · 2024: 245, 44, 24, 20, 57%, 56% · 2025: 246, 30, 22, 8, 50%, 52% · 2026: 209, 43, 32,
11, 57%, 61% · All years: 1438, 160, 105, 55, 48%, 50%.

| Set | Flagged: days, median, 1 in 10, % of premium, touched | Other days: days, median, 1 in 10, % of premium, touched |
| --- | --- | --- |
| OTM 2 | 160, ₹2,059, ₹7,999, 12.7%, 81% | 1,278, ₹995, ₹4,953, 15.7%, 53% |
| OTM 4 | 160, ₹1,581, ₹7,314, 14.6%, 34% | 1,278, ₹554, ₹3,376, 17.7%, 13% |
| OTM 6 | 160, ₹1,189, ₹6,866, 16.0%, 13% | 1,278, ₹275, ₹2,386, 17.0%, 3% |

**SENSEX (792 days, line about ₹1,325).** Days and share above by count: 0: 366, 44% · 1: 214,
50% · 2: 137, 58% · 3: 55, 65% · 4: 20, 65% · 3 or more: 75, 65%.

Finally `npm run build`. If a built-in browser is available: `http://localhost:3000` →
`Trade Explorer` → `Trade by trade` → tick `What differs` → `Risk signs`: the ladder matches the
NIFTY table. Click `3 or more`, then `Rule tester`: the year table matches, and the strike
distances load only after the button is clicked. `Strike distances` (the older view) must still
work. If no browser is available, say so.

## Report back (under 15 lines)

- Files created and edited.
- Each check command: pass/fail (failure text if any), and any existing test you had to update.
- Acceptance figures that did not match, with what you got.
- What Fable reported at each checkpoint and what you changed.
- Anything you could not do as written.
