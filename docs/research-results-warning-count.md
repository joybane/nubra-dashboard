# Research results: does a count of warning signs separate the big-loss days?

"Above" means max loss above the median of all days of that index. Cut-offs come from the earlier half only. Groups under 20 days are marked (<20).

1. NIFTY, later years: count 0 is 42% above the line, count 3 is 65% and 4-or-more is 68% (about 67% for 3-or-more together), a gap of about 25 points.
2. The best single flags in the same years give 70% vs 53% (gapOpen) and 69% vs 51% (ivRatio), gaps of 17 and 18 points, so the count is wider, but that compares the extreme group against "flagged vs not".
3. The light version (4 flags) in NIFTY later years: 45% at 0 and 67% at 3-or-more, a 22-point gap, so it keeps most of the full gap.
4. SENSEX later years: count 0 is 41% and 3-or-more is about 57% (3 is only 47%, 4-or-more 61%), a gap of about 16 points; the light version gives 46% vs 70% (43 days). Both together, later years: 41% at 0 vs about 63% at 3-or-more.
5. Skipping count ≥ 3 skips 86 to 135 NIFTY days a year (2024: 135, 2025: 86, 2026: 92 so far); 60% of all skipped NIFTY days were above the line (62% in 2024, 69% in 2025, 72% in 2026), and the days still traded are 43% above against 50% if nothing is skipped. SENSEX skips 82 to 110 days a year, 56% of them above the line.
6. On NIFTY count ≥ 3 days, selling further out lowers the median loss in ₹ (OTM 2 ₹1,463, OTM 4 ₹1,067, OTM 6 ₹714) and the touch rate (71%, 24%, 8%), but median loss as % of premium rises (15%, 18%, 19%).

Check figures: NIFTY 1,438 days (91 without a price file), SENSEX 792 (20 without). Sanity on NIFTY with all-row cut-offs: ivRatio flagged 68% vs 46%, strikeDist flagged 64% vs 47%.

## T1. By count (all eight flags)

**T1 – NIFTY, earlier years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 189 | 33% | ₹624 | ₹3,617 | 33% |
| 1 | 156 | 38% | ₹757 | ₹3,097 | 37% |
| 2 | 103 | 50% | ₹1,019 | ₹4,718 | 50% |
| 3 | 71 | 37% | ₹678 | ₹4,298 | 42% |
| 4 or more | 200 | 58% | ₹1,302 | ₹5,218 | 78% |

**T1 – NIFTY, later years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 124 | 42% | ₹808 | ₹4,325 | 43% |
| 1 | 151 | 48% | ₹972 | ₹4,732 | 57% |
| 2 | 123 | 54% | ₹1,259 | ₹6,075 | 57% |
| 3 | 99 | 65% | ₹1,672 | ₹7,557 | 66% |
| 4 or more | 222 | 68% | ₹2,082 | ₹7,518 | 78% |

**T1 – NIFTY, all years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 313 | 36% | ₹658 | ₹3,807 | 37% |
| 1 | 307 | 43% | ₹855 | ₹4,359 | 47% |
| 2 | 226 | 52% | ₹1,138 | ₹5,959 | 54% |
| 3 | 170 | 53% | ₹1,115 | ₹5,605 | 56% |
| 4 or more | 422 | 63% | ₹1,623 | ₹6,406 | 78% |

**T1 – SENSEX, earlier years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 81 | 37% | ₹779 | ₹5,252 | 65% |
| 1 | 82 | 50% | ₹1,337 | ₹5,625 | 79% |
| 2 | 77 | 44% | ₹1,096 | ₹6,130 | 83% |
| 3 | 55 | 49% | ₹1,318 | ₹6,710 | 87% |
| 4 or more | 101 | 58% | ₹1,618 | ₹9,201 | 87% |

**T1 – SENSEX, later years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 96 | 41% | ₹937 | ₹3,960 | 79% |
| 1 | 91 | 51% | ₹1,379 | ₹5,830 | 90% |
| 2 | 49 | 59% | ₹1,934 | ₹5,919 | 90% |
| 3 | 49 | 47% | ₹1,155 | ₹5,301 | 88% |
| 4 or more | 111 | 61% | ₹2,015 | ₹8,654 | 94% |

**T1 – SENSEX, all years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 177 | 39% | ₹825 | ₹4,339 | 73% |
| 1 | 173 | 50% | ₹1,352 | ₹5,790 | 85% |
| 2 | 126 | 50% | ₹1,314 | ₹6,223 | 86% |
| 3 | 104 | 48% | ₹1,242 | ₹6,615 | 88% |
| 4 or more | 212 | 60% | ₹1,802 | ₹9,010 | 91% |

**T1 – Both, earlier years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 270 | 34% | 15% | 145% | 43% |
| 1 | 238 | 42% | 14% | 89% | 51% |
| 2 | 180 | 47% | 15% | 165% | 64% |
| 3 | 126 | 42% | 13% | 78% | 62% |
| 4 or more | 301 | 58% | 15% | 89% | 81% |

**T1 – Both, later years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 220 | 41% | 15% | 87% | 59% |
| 1 | 242 | 49% | 15% | 100% | 69% |
| 2 | 172 | 56% | 16% | 117% | 66% |
| 3 | 148 | 59% | 17% | 122% | 73% |
| 4 or more | 333 | 65% | 15% | 82% | 83% |

**T1 – Both, all years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 490 | 37% | 15% | 107% | 50% |
| 1 | 480 | 45% | 14% | 96% | 60% |
| 2 | 352 | 51% | 15% | 158% | 65% |
| 3 | 274 | 51% | 15% | 89% | 68% |
| 4 or more | 634 | 62% | 15% | 87% | 82% |

## T2. Which flags carry it

**T2 – NIFTY, all later days** (719 days, 56% above)

| flag | days flagged | % above when flagged | % above when not |
|---|---|---|---|
| ivRatio | 212 | 69% | 51% |
| strikeDist | 291 | 66% | 50% |
| range5 | 133 | 64% | 55% |
| gapOpen | 146 | 70% | 53% |
| prevRange | 183 | 62% | 54% |
| mornRange | 208 | 67% | 52% |
| mismatch | 341 | 60% | 53% |
| prevMaxLoss | 329 | 59% | 54% |

**T2 – NIFTY, later days where ivRatio is NOT flagged** (507 days, 51% above)

| flag | days flagged | % above when flagged | % above when not |
|---|---|---|---|
| ivRatio | 0 (<20) | – | 51% |
| strikeDist | 128 | 59% | 48% |
| range5 | 56 | 57% | 50% |
| gapOpen | 77 | 61% | 49% |
| prevRange | 84 | 52% | 51% |
| mornRange | 107 | 64% | 48% |
| mismatch | 215 | 57% | 46% |
| prevMaxLoss | 188 | 53% | 50% |

**T2 – SENSEX, all later days** (396 days, 52% above)

| flag | days flagged | % above when flagged | % above when not |
|---|---|---|---|
| ivRatio | 82 | 68% | 47% |
| strikeDist | 84 | 68% | 47% |
| range5 | 121 | 62% | 47% |
| gapOpen | 176 | 55% | 49% |
| prevRange | 128 | 57% | 49% |
| mornRange | 124 | 62% | 47% |
| mismatch | 41 | 56% | 51% |
| prevMaxLoss | 151 | 55% | 50% |

**T2 – SENSEX, later days where ivRatio is NOT flagged** (314 days, 47% above)

| flag | days flagged | % above when flagged | % above when not |
|---|---|---|---|
| ivRatio | 0 (<20) | – | 47% |
| strikeDist | 30 | 70% | 45% |
| range5 | 62 | 55% | 46% |
| gapOpen | 121 | 47% | 48% |
| prevRange | 74 | 49% | 47% |
| mornRange | 70 | 53% | 46% |
| mismatch | 29 | 48% | 47% |
| prevMaxLoss | 101 | 47% | 48% |

## T3. Light version (four flags)

**T3 – NIFTY, earlier years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 325 | 35% | ₹657 | ₹3,579 | 37% |
| 1 | 210 | 45% | ₹986 | ₹3,804 | 45% |
| 2 | 113 | 51% | ₹1,146 | ₹4,634 | 72% |
| 3 or more | 71 | 68% | ₹2,041 | ₹6,921 | 86% |

**T3 – NIFTY, later years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 164 | 45% | ₹917 | ₹4,660 | 47% |
| 1 | 199 | 49% | ₹1,025 | ₹5,386 | 57% |
| 2 | 163 | 64% | ₹1,661 | ₹5,862 | 66% |
| 3 or more | 193 | 67% | ₹2,166 | ₹8,367 | 77% |

**T3 – NIFTY, all years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 489 | 38% | ₹749 | ₹3,955 | 40% |
| 1 | 409 | 47% | ₹1,012 | ₹4,527 | 51% |
| 2 | 276 | 59% | ₹1,385 | ₹5,497 | 68% |
| 3 or more | 264 | 67% | ₹2,135 | ₹7,999 | 80% |

**T3 – SENSEX, earlier years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 179 | 42% | ₹934 | ₹5,581 | 72% |
| 1 | 108 | 51% | ₹1,346 | ₹6,636 | 87% |
| 2 | 77 | 56% | ₹1,551 | ₹9,057 | 88% |
| 3 or more | 32 | 56% | ₹1,779 | ₹9,649 | 88% |

**T3 – SENSEX, later years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 187 | 46% | ₹1,132 | ₹5,151 | 82% |
| 1 | 108 | 50% | ₹1,382 | ₹6,456 | 94% |
| 2 | 58 | 60% | ₹1,929 | ₹7,369 | 90% |
| 3 or more | 43 | 70% | ₹2,744 | ₹10,288 | 100% |

**T3 – SENSEX, all years**

| count | days | % above line | median max loss (₹) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 366 | 44% | ₹1,037 | ₹5,325 | 77% |
| 1 | 216 | 50% | ₹1,346 | ₹6,573 | 90% |
| 2 | 135 | 58% | ₹1,651 | ₹8,954 | 89% |
| 3 or more | 75 | 64% | ₹1,971 | ₹10,281 | 95% |

**T3 – Both, earlier years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 504 | 37% | 14% | 121% | 49% |
| 1 | 318 | 47% | 15% | 101% | 59% |
| 2 | 190 | 53% | 13% | 107% | 78% |
| 3 or more | 103 | 64% | 15% | 76% | 86% |

**T3 – Both, later years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 351 | 46% | 16% | 119% | 66% |
| 1 | 307 | 50% | 15% | 102% | 70% |
| 2 | 221 | 63% | 15% | 67% | 72% |
| 3 or more | 236 | 67% | 15% | 86% | 81% |

**T3 – Both, all years**

| count | days | % above line | median max loss (% of premium) | 1 in 10 past | % strike touched |
|---|---|---|---|---|---|
| 0 | 855 | 41% | 15% | 121% | 56% |
| 1 | 625 | 48% | 15% | 102% | 65% |
| 2 | 411 | 58% | 15% | 89% | 75% |
| 3 or more | 339 | 66% | 15% | 82% | 83% |

## T4. Skip rule, year by year

**T4 – NIFTY, skip when count ≥ 2**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2021 | 0 | 246 | 149 | 77 | 72 | 32% | 44% |
| 2022 | 0 | 247 | 163 | 85 | 78 | 39% | 48% |
| 2023 | 19 | 245 | 72 | 38 | 34 | 35% | 40% |
| 2024 | 245 | 245 | 173 | 108 | 65 | 42% | 56% |
| 2025 | 246 | 246 | 140 | 84 | 56 | 42% | 52% |
| 2026 | 209 | 209 | 121 | 82 | 39 | 51% | 61% |
| **total** | 719 | 1438 | 818 | 474 | 344 | 40% | 50% |

**T4 – NIFTY, skip when count ≥ 3**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2021 | 0 | 246 | 108 | 56 | 52 | 38% | 44% |
| 2022 | 0 | 247 | 136 | 73 | 63 | 41% | 48% |
| 2023 | 19 | 245 | 35 | 18 | 17 | 39% | 40% |
| 2024 | 245 | 245 | 135 | 84 | 51 | 49% | 56% |
| 2025 | 246 | 246 | 86 | 59 | 27 | 44% | 52% |
| 2026 | 209 | 209 | 92 | 66 | 26 | 52% | 61% |
| **total** | 719 | 1438 | 592 | 356 | 236 | 43% | 50% |

**T4 – NIFTY, skip when count ≥ 4**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2021 | 0 | 246 | 76 | 45 | 31 | 37% | 44% |
| 2022 | 0 | 247 | 110 | 61 | 49 | 42% | 48% |
| 2023 | 19 | 245 | 19 | 13 | 6 | 38% | 40% |
| 2024 | 245 | 245 | 90 | 55 | 35 | 54% | 56% |
| 2025 | 246 | 246 | 55 | 39 | 16 | 47% | 52% |
| 2026 | 209 | 209 | 72 | 53 | 19 | 54% | 61% |
| **total** | 719 | 1438 | 422 | 266 | 156 | 45% | 50% |

**T4 – NIFTY, skip when ivRatio flagged**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2021 | 0 | 246 | 65 | 40 | 25 | 38% | 44% |
| 2022 | 0 | 247 | 53 | 33 | 20 | 44% | 48% |
| 2023 | 19 | 245 | 29 | 16 | 13 | 38% | 40% |
| 2024 | 245 | 245 | 79 | 52 | 27 | 52% | 56% |
| 2025 | 246 | 246 | 39 | 28 | 11 | 49% | 52% |
| 2026 | 209 | 209 | 87 | 64 | 23 | 52% | 61% |
| **total** | 719 | 1438 | 352 | 233 | 119 | 45% | 50% |

**T4 – SENSEX, skip when count ≥ 2**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2023 | 0 | 93 | 30 | 10 | 20 | 33% | 33% |
| 2024 | 0 | 242 | 157 | 87 | 70 | 48% | 53% |
| 2025 | 183 | 244 | 123 | 57 | 66 | 49% | 48% |
| 2026 | 213 | 213 | 132 | 86 | 46 | 43% | 57% |
| **total** | 396 | 792 | 442 | 240 | 202 | 45% | 50% |

**T4 – SENSEX, skip when count ≥ 3**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2023 | 0 | 93 | 16 | 5 | 11 | 34% | 33% |
| 2024 | 0 | 242 | 110 | 64 | 46 | 48% | 53% |
| 2025 | 183 | 244 | 82 | 41 | 41 | 46% | 48% |
| 2026 | 213 | 213 | 108 | 67 | 41 | 51% | 57% |
| **total** | 396 | 792 | 316 | 177 | 139 | 46% | 50% |

**T4 – SENSEX, skip when count ≥ 4**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2023 | 0 | 93 | 7 | 3 | 4 | 33% | 33% |
| 2024 | 0 | 242 | 75 | 45 | 30 | 50% | 53% |
| 2025 | 183 | 244 | 50 | 27 | 23 | 46% | 48% |
| 2026 | 213 | 213 | 80 | 52 | 28 | 52% | 57% |
| **total** | 396 | 792 | 212 | 127 | 85 | 46% | 50% |

**T4 – SENSEX, skip when ivRatio flagged**

| year | later-half days | days in year | skipped | skipped above line | skipped below | % above among traded | % above if nothing skipped |
|---|---|---|---|---|---|---|---|
| 2023 | 0 | 93 | 16 | 6 | 10 | 32% | 33% |
| 2024 | 0 | 242 | 52 | 32 | 20 | 51% | 53% |
| 2025 | 183 | 244 | 19 | 15 | 4 | 45% | 48% |
| 2026 | 213 | 213 | 71 | 47 | 24 | 52% | 57% |
| **total** | 396 | 792 | 158 | 100 | 58 | 47% | 50% |

## T5. Sell further out instead

**T5 – NIFTY, days with count ≥ 3, all years**

| strike | days | median max loss (₹) | 1 in 10 past (₹) | median % of premium | % strike touched |
|---|---|---|---|---|---|
| OTM 2 | 592 | ₹1,463 | ₹6,356 | 15% | 71% |
| OTM 4 | 592 | ₹1,067 | ₹5,485 | 18% | 24% |
| OTM 6 | 592 | ₹714 | ₹4,184 | 19% | 8% |

**T5 – NIFTY, days with count ≤ 1, all years**

| strike | days | median max loss (₹) | 1 in 10 past (₹) | median % of premium | % strike touched |
|---|---|---|---|---|---|
| OTM 2 | 620 | ₹769 | ₹4,050 | 15% | 42% |
| OTM 4 | 620 | ₹362 | ₹2,527 | 17% | 8% |
| OTM 6 | 620 | ₹163 | ₹1,394 | 16% | 1% |
