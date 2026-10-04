# Frontend repair and verification — 26 September 2026

## Scope

Preserve the navigation and control placement of Dark, Light and Graphite. Improve Bloomberg and the separate Apex experience. This pass repairs the existing implementation rather than replacing trading features or changing broker/data behavior. Unrelated working-tree changes were left intact.

## Repairs

- **Theme changes reset workspace controls.** The application previously switched between different component trees. All five experiences now share a stable workspace ancestry. Theme changes retain local chart controls, Greek visibility and terminal state.
- **Greek header gaps and price bleed.** Removed independently sticky rows and hard-coded offsets. The complete opaque table header now sticks as one unit. Separate table borders eliminate the remaining paint seam; a conflicting Bloomberg border-collapse rule was removed.
- **Chart/terminal sizing.** Shared flex containers maintain the available workspace height. Terminal resizing is bounded by its actual parent and responds to viewport changes. Expanding a collapsed terminal retains its chosen height. Extreme drags cannot take the entire chart area.
- **Split divider drift.** The divider now clamps the amount transferred between panes, preserving their total proportion and both minimum sizes.
- **Narrow pane controls.** Chart controls wrap without a hidden horizontal toolbar. Option chains keep a readable minimum table width and scroll inside the pane rather than compressing all 16 columns.
- **Density side effects.** Density is a single shared preference across shells. Table styling excludes the chart library's internal layout tables. Comfortable mode no longer stretches the small inline trading buttons.
- **Experience polish.** Apex has readable navigation and context typography, larger inspector text, a persisted optional inspector, and accurate search wording. Bloomberg has one module navigation instead of two, clearer text and working Alt+1–8 shortcuts rather than nonfunctional F-key labels. Stream status describes connection state, not guaranteed fresh quotes.
- **Keyboard/accessibility.** Existing theme/layout menus support arrow keys, Home/End and Escape with focus return. The command palette identifies its active option. The terminal resize handle supports arrow keys; terminal icons have descriptive labels and collapsed content is inert.

## Automated verification

| Check | Result |
| --- | --- |
| Production build / frontend TypeScript | Passed |
| Server TypeScript check | Passed |
| Vitest (`--testTimeout=30000`) | 667 tests passed in 64 files |
| Lint of touched TS/TSX files | 0 errors; 2 existing warnings |
| Git whitespace check | Passed; Git reports the repository's existing LF/CRLF conversion notices |

New regression tests cover extreme terminal sizes, short windows, and repeated split transfers at both boundaries.

The two existing lint warnings are the `updateCells` effect dependency in `OptionChain.tsx` and the unused `onExit` argument in `OrderTerminal.tsx`. They were not suppressed or silently rewritten as part of styling work.

## Browser verification

Used the running production frontend at `http://127.0.0.1:3000/`, with 1280×720 and 1920×920 desktop viewports.

- Opened Chart, Option Chain, Basket, Backtest, Nubra BT, Watchlist, Tracker and Analysis in all five themes: no render-boundary failures in the current build. This is navigation/render smoke coverage, not exhaustive validation of each view's operations.
- Inspected rendered screenshots of all five themes; checked Apex with its inspector both open and closed.
- Measured a **0 px gap** between the two option-chain header rows in all five themes. Scrolled the chain and checked comfortable density in Graphite and Apex.
- Toggled Volume, collapsed the terminal, and switched Apex → Dark → Light → Graphite → Bloomberg: Volume remained enabled and the terminal remained collapsed.
- Hid Greeks and switched Bloomberg → Graphite: Greeks remained hidden.
- Exercised Single, H-Split, V-Split, Grid, T-Left and T-Right in Apex. Tested keyboard menu selection and dismissal.
- Repeated terminal resize keystrokes beyond both limits. At 1280×720, the maximum terminal size retained a 200 px single-pane workspace.
- Executed a theme change through the command palette and confirmed the dialog closed. Enabled the chart's Vega panel and verified its rendered series.
- Browser diagnostics contained only the stale-chunk error caused by rebuilding while the old page was open; it cleared after loading the new build. No subsequent runtime errors were recorded during the checks above.

Screenshots are saved outside the repository at `E:/Derivativesproject/frontend-review/apex-desktop.png` and `E:/Derivativesproject/frontend-review/graphite-greeks.png`.

## Limits and handoff

Reload an already-open dashboard once to load the rebuilt assets. A tab left on an older build can request JavaScript chunks that the rebuild has replaced.

No orders were placed, amended, cancelled or exited. Authentication was not changed. Broker execution, every strategy/backtest combination, disconnect recovery and long-running live-market behavior were not exhaustively exercised. This review is not a guarantee that the whole application is bug-free.
