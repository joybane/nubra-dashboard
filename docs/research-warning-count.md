# Research task: does a count of warning signs separate the big-loss days?

Research only. Do NOT change any app file. Work directly in this session (no subagents), from
`E:\Derivativesproject\nubra-dashboard`. Write ONE throwaway script `scratch/warn-count.mts`, run it
with `npx tsx scratch/warn-count.mts`, write the results file, then delete the script. Do not read
other source files; everything needed is below.

## Question

Every signal-time reading only leans. If several are present together, do the days separate much
better? Answer for NIFTY, SENSEX and both together, and show what skipping such days would have
done year by year.

## Data

- Days: `.signal-cache/<UND>/explorer-run.json` → `buildDayRows(json.rows, UND)` from
  `../src/lib/tradeExplorer` (`UND` is `'NIFTY'` or `'SENSEX'`). Use rows with a numeric
  `values.maxLoss`, sorted by `raw.date` ascending.
- Useful fields: `values.maxLoss`, `values.maxLossPct`, `values.ivRatio`, `values.ivNow`,
  `values.gap` (Mismatch ₹), `values.prevMaxLoss`, `values.t2` (minutes since midnight),
  `values.touched` (`'Yes'`/`'No'`), `raw.dte`, `raw.signal.spot2`, `raw.signal.legs.ceStrike`,
  `raw.signal.legs.peStrike`.
- Spot path per day (a forward, from put-call parity). Use this function as is; a missing or short
  file means that day has no path:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeDay } from '../server/signalBacktest/ohlcDayStore.ts';
const BARS = 375; // one per minute from 09:15
function forward(und: string, date: string): Float64Array | null {
  const f = `.signal-cache/${und}/parquet/${date}.ohlc.gz`;
  if (!existsSync(f)) return null;
  const d = decodeDay(gunzipSync(readFileSync(f)));
  if (!d) return null;
  const pe = new Map(d.strikes.PE.map((k, i) => [k, d.blocks.PE[i]]));
  const out = new Float64Array(BARS).fill(NaN);
  for (let m = 0; m < BARS; m++) {
    let best = Infinity, fw = NaN;
    d.strikes.CE.forEach((k, i) => {
      const p = pe.get(k); if (!p) return;
      const c = d.blocks.CE[i][3 * BARS + m], q = p[3 * BARS + m];   // closes
      if (c > 0 && q > 0 && Math.abs(c - q) < best) { best = Math.abs(c - q); fw = k + c - q; }
    });
    out[m] = fw;
  }
  return Array.from(out).filter((x) => x > 0).length >= 300 ? out : null;
}
```

- Other strike distances: `.signal-cache/<UND>/explorer-sets/<the one folder>/otm<N>.json.gz`
  (gunzip → JSON → `buildDayRows(json.rows, UND)`), N = 0…7. `otm2` is the same trade as the saved
  run.

## Readings (per day; `null` when an input is missing)

Per day with a path `F`: `open` = first valid value, `close` = last, `hi`/`lo` = max/min,
`range% = (hi − lo) / open × 100`. "Previous day" = the previous row in the sorted list.

| Name | Definition | Flag when |
| --- | --- | --- |
| ivRatio | `values.ivRatio` | ≥ 80th percentile |
| strikeDist | `((ceStrike − peStrike) / 2 / spot2 × 100) ÷ (ivNow / √252 × √max(0.35, dte + 0.75))` | ≤ 20th percentile |
| range5 | mean `range%` of the previous 5 days (all 5 needed) | ≥ 67th percentile |
| gapOpen | `abs(today's open − previous day's close) / previous close × 100` | ≥ 67th percentile |
| prevRange | previous day's `range%` | ≥ 67th percentile |
| mornRange | `(max − min) / first × 100` of `F` from 09:15 up to the signal minute (`t2 − 555`) | ≥ 67th percentile |
| mismatch | `values.gap` | ≥ 80th percentile |
| prevMaxLoss | `values.prevMaxLoss` | ≥ 67th percentile |

A missing reading counts as "not flagged".

## Method (this order matters: it keeps the test honest)

For each index separately:

1. `half = floor(n / 2)`. Rows before `half` are the **earlier** years, the rest the **later** years.
2. Compute every percentile cut-off **from the earlier rows only**. Apply those cut-offs to all rows.
3. `count` = number of flags on the day (0–8). Group as `0`, `1`, `2`, `3`, `4 or more`.
4. Loss line = median `maxLoss` of ALL rows of that index. "Above" = `maxLoss > line`.

"Both" = the NIFTY and SENSEX rows put together, each row keeping its own index's flags and its
own index's "above" result. Report money only per index; in Both report `maxLossPct` instead.

## Tables to produce

**T1. By count.** For NIFTY, SENSEX and Both, and within each for earlier years, later years and
all: one row per count group with `days`, `% above the line`, `median max loss`
(₹; `% of premium` for Both), `1 in 10 past` (0.9 quantile), `% strike touched`.

**T2. Which flags carry it.** Per index, later years only: for each flag, `days flagged`,
`% above when flagged`, `% above when not`. Then the same for each flag among days where
`ivRatio` is NOT flagged (does anything help when IV is normal?).

**T3. Light version.** Repeat T1 using only the four flags that need no price file
(ivRatio, strikeDist, mismatch, prevMaxLoss), groups `0`, `1`, `2`, `3 or more`.

**T4. Skip rule, year by year.** Per index, for the rules `count ≥ 2`, `count ≥ 3`, `count ≥ 4`
and `ivRatio flagged`: one row per calendar year plus a total row with `days in year`,
`days skipped`, `skipped that were above the line`, `skipped that stayed below`,
`% above among days still traded`, `% above if nothing is skipped`. Mark which years are in the
later half.

**T5. Sell further out instead.** NIFTY only, for the days with `count ≥ 3` (all years): for
OTM 2, 4 and 6 give `days`, `median max loss ₹`, `1 in 10 past ₹`, `median % of premium`,
`% strike touched`. Then the same three lines for the days with `count ≤ 1`, for comparison.

## Output

Write `docs/research-results-warning-count.md` with the five tables (markdown tables, numbers
rounded: % to whole numbers, ₹ to whole rupees) and, above them, at most eight plain sentences
answering:

1. In the later years, how far apart are count 0 and count 3-or-more on `% above the line`?
2. Is that gap wider than the single best flag gives alone?
3. Does the light version (T3) keep most of the gap?
4. Does it hold on SENSEX, and on Both?
5. For `count ≥ 3`: how many days a year does it skip, and what share of those were above the line?
6. On those days, does selling further out lower the loss in ₹, in % of premium, and the touch rate?

State numbers, not opinions. If a group has fewer than 20 days, say so next to its figures.

## Checks before reporting

- Row counts: NIFTY about 1,438 days (about 91 without a price file), SENSEX about 790 (about 20
  without).
- Sanity figures on NIFTY, all years, cut-offs from all rows (compute once just to check, do not
  put in the results): `ivRatio` ≥ its 80th percentile → about 68% above the line against 45%;
  `strikeDist` ≤ its 20th percentile → about 64% against 47%. If you are far off, a reading is
  built wrongly: fix it before going on.
- Delete `scratch/warn-count.mts`. `git status` must show only the new results file.

## Report back (under 10 lines)

The eight sentences, the path of the results file, and anything you could not do as written.
