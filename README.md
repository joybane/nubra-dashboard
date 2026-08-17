# bRODHa — Nubra Trading Dashboard

A self-hosted, full-stack trading dashboard for Indian equity derivatives. It connects to
the **Nubra broker API** for live market data, option chains, and authentication; ships a
**paper-trading simulation engine (SimBroker)**; and includes a **historical backtesting
engine** built on locally-stored Parquet option data.

> Single-user, runs on your own machine. Broker credentials never reach the browser — the
> Node server acts as an auth proxy and holds the session token server-side only.

---

## Tech stack

| Layer         | Technology                                                  |
| ------------- | ----------------------------------------------------------- |
| Frontend      | React 19, TypeScript, Vite 6, TailwindCSS 3 + DaisyUI 4     |
| Backend       | Node.js (ESM, `--experimental-strip-types`), Fastify 5      |
| Real-time     | WebSocket (`ws` server-side, native browser WS client-side) |
| Database      | SQLite via `better-sqlite3` (`paper.db`)                    |
| Data format   | Parquet (`hyparquet`) for backtest historical data          |
| Serialization | Protobuf (`protobufjs`, schema `nubra.proto`) for broker WS |
| Charts        | `lightweight-charts`                                        |

---

## Getting started

### Prerequisites

- Node.js ≥ 20 (developed on v24)
- A Nubra brokerage account (phone + MPIN)

### Configure

Create `.env` in this directory:

```bash
PHONE_NO=<registered mobile number>
MPIN=<broker MPIN>
SERVER_PORT=3000
NUBRA_BASE_URL=https://api2.nubra.io
```

Optional: `NUBRA_MARGIN_BASE_URL`, `SERVER_HOST`, `CORS_ORIGINS`, and the local-margin
overrides read by `server/marginEngine.ts` — `LOCAL_MARGIN_ELM_INDEX`,
`LOCAL_MARGIN_ELM_DEEP_OTM`, `LOCAL_MARGIN_ELM_LONG_DATED`, `LOCAL_MARGIN_ELM_EXPIRY_ADDON`,
`LOCAL_MARGIN_ELM_STOCK`, `LOCAL_MARGIN_MCX_RATE_FLOOR`, `LOCAL_MARGIN_MCX_RATE_CAP`,
`LOCAL_MARGIN_SHORT_OPTION_MIN`, `LOCAL_MARGIN_DEFAULT_IV`.

> **`.env`, `session.json` and `uat-session.json` must never be committed.** They hold the
> MPIN, the phone number, and a live broker auth token. All three were tracked until
> 2026-08-14 and are now git-ignored, but they remain in the history of this repository —
> rotating the MPIN and re-authenticating is the only thing that actually revokes them.

### Network exposure

Nothing in this server authenticates the **caller**. `requireAuth` asks whether the server
holds a broker session, not who is asking, so any request that reaches the port is trusted
with paper trading, the account, and the Nubra REST proxy. Two settings control who can
reach it, and both are closed by default:

| Variable       | Default     | Effect                                                            |
| -------------- | ----------- | ----------------------------------------------------------------- |
| `SERVER_HOST`  | `127.0.0.1` | Bind address. Set `0.0.0.0` to reach the dashboard from the LAN.  |
| `CORS_ORIGINS` | _(empty)_   | Extra browser origins allowed to script the API, comma separated. |

`localhost`/`127.0.0.1` on the server port and on the Vite dev ports (8000, 5173) are always
allowed — see `server/corsPolicy.ts`. Requests with no `Origin` header (same-origin
navigation, curl, server-to-server) are unaffected.

### Install & run

```bash
npm install
npm start          # server (:3000) + Vite dev (:8000) together
```

Then open http://localhost:8000 and complete the OTP → MPIN login.

> **:8000 is Vite; :3000 is the server serving the prebuilt `dist/`.** Only the former has
> HMR. A source edit is invisible at :3000 until `npm run build` runs, so when a change
> "didn't take effect" there, compare `dist/` mtimes against the file before re-reading the
> logic.

---

## Scripts

| Script                 | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `npm start`            | Run server + Vite dev concurrently       |
| `npm run dev`          | Vite dev only (`:8000`)                  |
| `npm run server`       | Server only (`:3000`)                    |
| `npm run build`        | Type-check + production build to `dist/` |
| `npm run preview`      | Preview the production build             |
| `npm run typecheck`    | TypeScript check, no emit                |
| `npm run lint`         | ESLint                                   |
| `npm run lint:fix`     | ESLint with autofix                      |
| `npm run format`       | Prettier write                           |
| `npm run format:check` | Prettier check (CI-friendly)             |
| `npm test`             | Run the Vitest suite once                |
| `npm run test:watch`   | Vitest in watch mode                     |

---

## Architecture at a glance

```
Browser (React SPA)
   │  HTTP  /auth/*  /api/*  /paper/*        WebSocket  /ws (JSON)
   ▼
Fastify server (server/index.ts composition root + route modules)
   ├─ Auth state machine (idle → awaiting_otp → awaiting_mpin → authenticated)
   ├─ Nubra REST proxy (silent re-auth on 401/403)
   ├─ Nubra WS relay (protobuf → decoded JSON broadcast)
   ├─ SimBroker  — paper trading, in-memory + SQLite (paper.db)
   ├─ MarginEngine — SPAN local fallback
   └─ BacktestEngine (server/backtest/*) — Parquet historical data
```

- **Prices are stored in paise (INR × 100)** everywhere server-side and in SQLite; the
  frontend divides by 100 for display.
- **Position key** is `"ref_id:basket_group_id"`, so the same instrument can appear in
  multiple baskets at once. `qty` is signed (positive = long, negative = short).

This README is the single authoritative technical reference for the project. Update it
whenever behavior, architecture, routes, storage, or major module responsibilities change.

---

## Repository layout

```
src/                 React frontend
  workspace/         Multi-pane workspace shell (layouts, panes)
  components/        Navbar, terminals, dialogs, analysis views
  hooks/             WS, paper-trading, basket, greek-overlay, OI-profile contexts/hooks
  lib/               Greek aggregation/rendering, GEX, strategy templates, utils
  backtest/          Frontend backtest types + views
server/              Fastify server
  authRoutes.ts      Authentication HTTP routes
  marketDataRoutes.ts Market-data, instrument, historical, and option-chain routes
  paperRoutes.ts     Paper-trading, margin, basket, and strategy-snapshot routes
  nubraBacktestRoutes.ts Broker-history replay routes
  simBroker.ts       Paper-trading execution and position engine
  backtest/          Parquet engine plus HTTP routes (engine, dataLayer, analysis, sweep, walkforward)
  paperDb.ts         All SQLite operations
  marginEngine.ts    Local SPAN margin fallback
_archive/            Historical one-off scripts / backups (git-ignored, safe to delete)
```

---

## Code quality

- **TypeScript strict mode** is on.
- **ESLint** (flat config) + **Prettier** enforce correctness and formatting.
- **Vitest** covers money-math modules, route contracts, backtest behavior, and SimBroker.

Run `npm run lint && npm run typecheck && npm test` before committing.

---

## Authentication flow

The server is an authentication proxy; broker credentials and the session token are never
sent to the browser.

1. `POST /auth/send-otp` calls Nubra `/sendphoneotp` using `PHONE_NO` from `.env`.
2. `POST /auth/verify-otp` verifies the OTP and stores the returned `auth_token`.
3. `POST /auth/verify-pin` uses `MPIN` from `.env` to obtain the `session_token`.
4. The session token remains in `authState.sessionToken` on the server.
5. The auth token is persisted in `session.json` for silent restoration after restart.
6. Broker 401/403 responses trigger guarded silent re-authentication with a 30-second cooldown.
7. Failed re-authentication resets the state and broadcasts an idle auth status.

Auth states are `idle`, `awaiting_otp`, `awaiting_mpin`, and `authenticated`.

---

## Server API

### Authentication

| Method | Path               | Purpose                                                  |
| ------ | ------------------ | -------------------------------------------------------- |
| POST   | `/auth/send-otp`   | Send an OTP to the configured phone                      |
| POST   | `/auth/verify-otp` | Verify OTP and persist the auth token                    |
| POST   | `/auth/verify-pin` | Verify MPIN, obtain session token, and connect broker WS |
| GET    | `/auth/status`     | Return authentication status                             |
| POST   | `/auth/logout`     | Clear authentication and disconnect broker WS            |

### Market data

| Method | Path                                 | Purpose                                                     |
| ------ | ------------------------------------ | ----------------------------------------------------------- |
| GET    | `/api/refdata?exchange=NSE`          | Get daily server-cached exchange instruments                |
| GET    | `/api/instruments/search`            | Fuzzy-search refdata                                        |
| GET    | `/api/instruments/lookup`            | Look up one instrument by `ref_id`                          |
| POST   | `/api/historical`                    | Proxy Nubra chart timeseries data                           |
| GET    | `/api/optionchain/:instrument`       | Get an enriched option chain                                |
| GET    | `/api/optionchain/:instrument/price` | Get the underlying price (NSE/BSE only — MCX 500s upstream) |

All of these accept `?exchange=` (`NSE` default, plus `BSE` and `MCX`). It is omitted from the
outbound request when NSE, so those calls stay byte-identical to what they have always been.

#### Historical data retention — the docs are wrong below one minute

The vendor docs say "intervals less than 1 day → last 3 months". That holds for `1m` and
coarser. **Sub-minute is a rolling 7×24 hours**, and only `1s` and `10s` exist — `5s` is
accepted but returns nothing, `15s`/`30s` return 500. Measured 2026-08-03 on both NSE and MCX:
at 21:07 IST, 27 Jul 20:00 IST returned 500 while 27 Jul 22:00 IST returned data, so the cutoff
is exactly `now − 168h`.

A window that **straddles** that edge fails the _entire_ query with a 500 rather than clipping,
so `startDate` must be clamped — `clampSubMinuteStart` in `src/lib/utils.ts`, applied inside
`fetchRange`, which every historical fetch goes through. Note also that 1s bars are tick-driven
rather than filled: over one 20-minute window NIFTY yields 1200, a crude future 413, a crude
option 35.

### Local Parquet backtesting

| Method | Path                        | Purpose                                         |
| ------ | --------------------------- | ----------------------------------------------- |
| GET    | `/api/backtest/meta`        | Get available underlyings and expiry ranges     |
| POST   | `/api/backtest/run`         | Run a full backtest                             |
| POST   | `/api/backtest/day`         | Get one trading day's intraday detail           |
| POST   | `/api/backtest/sweep`       | Run a one- or two-dimensional parameter sweep   |
| POST   | `/api/backtest/walkforward` | Run walk-forward optimisation                   |
| GET    | `/api/iv-history`           | Daily ATM IV baseline for the Tracker's IV rank |

`server/nubraBacktestRoutes.ts` additionally exposes Nubra broker-history chain/evaluation
routes used for single-day replay and comparison.

### Paper trading

| Method       | Path                           | Purpose                                               |
| ------------ | ------------------------------ | ----------------------------------------------------- |
| GET / POST   | `/paper/orders`                | List or place orders                                  |
| POST         | `/paper/orders/multi`          | Place independent orders                              |
| POST         | `/paper/orders/basket`         | Place grouped basket legs and snapshot margin         |
| POST         | `/paper/orders/modify/:id`     | Amend an open order's price, trigger or quantity      |
| DELETE       | `/paper/orders/:id`            | Cancel an order                                       |
| GET          | `/paper/positions`             | Get open positions and unrealised PnL                 |
| GET          | `/paper/positions/closed`      | Get closed positions and realised PnL                 |
| GET          | `/paper/holdings`              | Return holdings (empty for this derivatives-only app) |
| GET          | `/paper/pnl`                   | Get realised, unrealised, and total PnL               |
| POST         | `/paper/margin`                | Calculate single-leg margin                           |
| POST         | `/paper/margin/basket`         | Calculate basket margin with local SPAN fallback      |
| GET / POST   | `/paper/baskets`               | List or save baskets                                  |
| PUT / DELETE | `/paper/baskets/:id`           | Update or delete a basket                             |
| PUT          | `/paper/strategy/rename`       | Rename a grouped strategy                             |
| POST         | `/paper/strategy/snapshot`     | Save or update a frozen strategy snapshot             |
| GET          | `/paper/strategy/snapshots`    | List snapshots                                        |
| GET / DELETE | `/paper/strategy/snapshot/:id` | Get or delete one snapshot                            |
| GET          | `/paper/auth/status`           | Return paper-trading auth status                      |
| GET          | `/paper/debug`                 | Return subscription, position, and WS diagnostics     |

Every route above is behind `requireAuth` except `/paper/auth/status` and `/paper/debug`, which
are the two that have to answer while logged out. The four `/paper/strategy/snapshot*` routes
were outside the guard until 2026-08-15, which left the one store on this server that accepts an
arbitrary-sized JSON blob as its only unguarded writer.

`POST /paper/orders/modify/:id` takes any of `order_price`, `trigger_price`, `order_qty` (prices
in paise, quantity in units) and 400s on an empty patch, a non-numeric or negative value, or a
zero or fractional quantity. It answers `{ ok, order }` with the amended order, because the amendment can cross
a standing market and fill on the spot — a bare ack would leave the client polling to find out.
The Orders tab drives it from an inline editor on any open, unfilled row; `src/lib/orderAmendment.ts`
holds the rupees→paise conversion and the change detection, so only edited fields are sent.

---

## WebSocket protocol and live-data flow

The browser connects to `/ws` and sends JSON subscription messages:

```js
{ action: 'subscribe', payload: { instruments: [], indexes: [] }, interval: '1m', exchange: 'NSE' }
{ action: 'unsubscribe', /* matching payload */ }
{ action: 'subscribe_oc', asset: 'NIFTY', expiry: '20250124', exchange: 'NSE' }
{ action: 'unsubscribe_oc', /* matching asset and expiry */ }
```

The server broadcasts these JSON message types:

- `auth_status`: authentication state changes
- `ws_status`: broker WebSocket connectivity
- `ohlcv`: decoded chart candles
- `index_tick`: decoded index ticks
- `option_chain`: decoded option-chain updates
- `position_ltp`: batched position prices (approximately every 200 ms)

Nubra sends binary protobuf messages. The server decodes the `AnyMsg` envelope using
`nubra.proto`, dispatches the contained index/OHLCV/option-chain message, routes prices to
SimBroker, and broadcasts decoded JSON to browser clients.

Option-chain flow is:

1. Browser fetches the initial chain through `/api/optionchain/:instrument`.
2. Browser sends `subscribe_oc` for the selected asset and expiry.
3. Server forwards the subscription to Nubra's WebSocket.
4. Nubra sends protobuf updates.
5. Server decodes and broadcasts `option_chain` JSON.
6. React state updates through `useWsContext` subscribers.
7. Closing the pane sends `unsubscribe_oc`.

---

## SimBroker behavior

`SimBroker` lives in `server/simBroker.ts`; persistence operations live in
`server/paperDb.ts`.

- Prices are stored in paise throughout the server and database.
- Position identity is `ref_id:basket_group_id`.
- Positive quantities are long; negative quantities are short.
- Market orders fill immediately at simulated ask for buys or bid for sells.
- Regular limit orders fill when the simulated market crosses the limit.
- Stop-loss orders trigger first, then follow market- or limit-fill behavior.
- Amending an open order (`modifyOrder`) persists through `dbModifyOrder`, rejects non-numeric,
  negative or zero-quantity values without partially applying them, and re-evaluates the order
  against the last tick — the same immediate-fill attempt `placeOrder` makes, because fills are
  otherwise only checked when a price _changes_ and a limit moved onto the wrong side of a
  standing market would sit there until it did.
- Every live tick flows through `SimBroker.onLtp()`, fill checking, position updates, and
  `position_ltp` broadcasting.
- At 15:35 IST on weekdays, the server creates end-of-day basket snapshots unless a manual
  snapshot already exists.

`simSpread(ltp)` supplies a price-sensitive half-spread for simulated execution.

---

## Database schema

`paper.db` is SQLite and is initialized/migrated by `server/paperDb.ts`.

```sql
orders(order_id PK, ref_id, nubra_name, display_name, order_type, order_side,
       order_price, trigger_price, order_qty, filled_qty, avg_filled_price,
       order_status, order_time, filled_time, order_delivery_type, validity_type,
       tag, sl_triggered, basket_group_id, strategy_name, margin_required)

fills(fill_id AUTOINCREMENT PK, order_id, ref_id, fill_price, fill_qty, fill_time, side)

positions(ref_id + basket_group_id = composite PK,
          nubra_name, display_name, qty, avg_price, realized_pnl,
          last_traded_price, order_delivery_type, strategy_name,
          entry_time, exit_time, exit_price, entry_qty)

pnl_ticks(id AUTOINCREMENT PK, ts, ref_id, ltp, qty, avg_price,
          unrealized_pnl, realized_pnl, total_pnl)

name_map(name TEXT PK, ref_id)
meta(key TEXT PK, value)
saved_baskets(basket_id TEXT PK, name, symbol, expiry, legs_json, created_at, updated_at)
oc_subs(key TEXT PK)
saved_strategies(snapshot_id TEXT PK, basket_group_id, strategy_name, underlying,
                 trade_date, total_pnl, leg_count, source, created_at, updated_at, data_json)
```

Startup migrations add newer order and position columns when required. Strategy snapshots
are unique by `(basket_group_id, trade_date)`.

`entry_qty` is the signed size the position was opened at, kept so a closed position reports
its real quantity and side. Rows written before the column existed are `NULL`, and those fall
back to deriving the size from `realized_pnl / |exit_price − avg_price|` — a lossy estimate that
was the _only_ path until the column was added, because `entry_qty` was computed at fill time
and never persisted.

The `positions` upsert deliberately re-writes `entry_time` and `entry_qty` on conflict. A closed
position can be re-opened under the same `(ref_id, basket_group_id)` key, and leaving those out
pinned the row to the first entry it ever had — which then mis-dated it after a restart, and
`entry_time` is what the end-of-day snapshot groups a strategy's trade date by. `strategy_name`
is deliberately **not** in the conflict clause: renames go through `dbRenameStrategy`, and a
later fill still carries the name its order was placed under.

`server/paperDb.test.ts` exercises the DDL and both migration paths against a scratch file via
the `PAPER_DB_PATH` override, which exists for exactly that reason — the app itself always uses
`paper.db` beside the repo root.

---

## Backtest engine

| File                             | Responsibility                                           |
| -------------------------------- | -------------------------------------------------------- |
| `server/backtest/types.ts`       | Canonical configuration, result, trade, and metric types |
| `server/backtest/index.ts`       | Public backtest exports and validators                   |
| `server/backtest/routes.ts`      | Fastify endpoint registration                            |
| `server/backtest/engine.ts`      | Tick-by-tick simulation loop                             |
| `server/backtest/dataLayer.ts`   | Parquet loading, caching, and expiry lookup              |
| `server/backtest/analysis.ts`    | Performance metrics, Monte Carlo, and strategy score     |
| `server/backtest/greeks.ts`      | Black-Scholes IV and Greeks                              |
| `server/backtest/sweep.ts`       | Parameter sweep execution                                |
| `server/backtest/walkforward.ts` | In-sample optimisation and out-of-sample evaluation      |
| `server/backtest/audit*.ts`      | Historical-data audit utilities                          |

`BacktestConfig` controls date/time range, underlying, slippage, legs, portfolio risk,
entry filters, position sizing, and adjustments. Leg configuration supports multiple strike
selection methods, stop/target types, trailing behavior, and re-entry. Results contain daily
trades, equity, monthly/weekday aggregation, extensive risk metrics, warnings, optional Monte
Carlo analysis, and a strategy score.

The implemented feature phases cover core simulation, trailing/re-entry, extended metrics,
dynamic position sizing, position adjustments, Monte Carlo analysis, and strategy grading.

---

## Frontend map

### Primary views

| File                    | Responsibility                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `src/App.tsx`           | Provider composition, authentication, theme, and root overlays |
| `src/CandleChart.tsx`   | OHLCV candlestick chart                                        |
| `src/OptionChain.tsx`   | Live option-chain table and Greeks                             |
| `src/StraddleChart.tsx` | ATM straddle premium chart                                     |
| `src/StrategyChart.tsx` | Strategy chart                                                 |
| `src/BasketOrder.tsx`   | Basket construction and paper-order workflow                   |
| `src/Backtest.tsx`      | Backtest configuration and result views                        |
| `src/NubraBacktest.tsx` | Broker-history single-day replay, three-pane chart             |
| `src/Watchlist.tsx`     | Instrument watchlist and prices                                |
| `src/Tracker.tsx`       | Position tracking                                              |

### Important components and hooks

| File                                      | Responsibility                                   |
| ----------------------------------------- | ------------------------------------------------ |
| `src/components/Navbar.tsx`               | Navigation, instrument search, and theme control |
| `src/components/LoginOverlay.tsx`         | OTP and MPIN flow                                |
| `src/components/OrderTerminal.tsx`        | Orders, positions, and PnL terminal              |
| `src/components/OrderTicket.tsx`          | Order placement dialog                           |
| `src/components/StrategyAnalysisView.tsx` | Strategy chart, Greeks, and PnL analysis         |
| `src/hooks/useWsContext.tsx`              | WebSocket provider and subscriptions             |
| `src/hooks/useBasketContext.tsx`          | Shared basket state                              |
| `src/hooks/useBasketChain.ts`             | Basket option-chain retrieval                    |
| `src/hooks/useBasketPersistence.ts`       | Basket server persistence                        |
| `src/hooks/useGreekOverlay.ts`            | Greek aggregation and overlays                   |
| `src/hooks/useOIProfile.ts`               | Open-interest profiles                           |
| `src/hooks/useMarginCalc.ts`              | Margin requests                                  |
| `src/hooks/usePaperTrading.tsx`           | Paper orders, positions, and PnL polling         |
| `src/hooks/useWatchlistContext.tsx`       | Watchlist state                                  |

`src/workspace/` implements the persisted multi-pane workspace. Supported views are chart,
option chain, straddle, strategy, basket, backtest, watchlist, and tracker. Supported layouts
are single, horizontal split, vertical split, grid, left-heavy, and right-heavy.

`src/lib/` contains Greek aggregation/rendering, open-interest rendering, GEX calculations,
strategy templates, chart lifecycle guards (`chartLifecycle.ts`), pinned-crosshair state
(`chartPins.ts`), cursor-following axis selection (`axisFollow.ts`), and shared utilities.
`src/backtest/` contains frontend backtest types, leg configuration, intraday trade charts, and
client analysis helpers. Shared frontend domain interfaces live in `src/types.ts`.

### Nubra BT greeks pane

Two greek surfaces live in `src/NubraBacktest.tsx` and they are **not** the same thing. The
`Greeks` toggle plots net / CE / PE delta, gamma, theta and vega of **the legs you configured**,
computed per minute from each leg's own price by inverting IV and re-pricing under Black-76. The
`Indicators` toggle mounts `GreekIndicatorPane`, the shared Vega/Theta/IV overlay of the whole
near-the-money basket described in the next section, which knows nothing about the configured
legs. Both changes below are about the first pane only.

**Its time grid is the legs' bars, not the P&L curve.** `basketPnlData` is clipped server-side to
entry→exit (`nubraBacktestRoutes.ts` keeps only `m >= entryMin && m <= exitMin`) because it is a
_position_ P&L curve; `legPriceData` and `underlyingBars` are unfiltered. Using the clipped series
as the greeks grid cut the pane off at the exit bar — 356 points, 09:20–15:15, against the
session's 870 on CRUDEOIL 14-08-2026. Greeks here are a property of the legs at their quantity,
not of a position, so they stay defined for every minute a leg has a price, exactly like the leg
lines in the price pane. The grid is now the union of every leg's bar times **floored to the
minute** — the same key the spot/leg lookups and `padToGrid` use, so two legs can never contribute
two points inside one minute. The Greeks popover reads the last point of the greeks series for the
same reason, so with no crosshair it agrees with the pane's own last-value labels.

**A minute missing any leg publishes nothing at all.** An illiquid leg can skip a 1-minute bar
entirely — CRUDEOIL 2026-08-14 skipped four, at 09:41, 10:39, 10:57 and 13:27. Dropping just that
leg from the sum published a one-leg figure under the `net` label: theta 43.7 → 22.1 and vega
−5.41 → −2.76 for one bar, snapping back on the next, which reads as a needle spike rather than as
the missing data it is. The loop now skips the whole minute and `padToGrid` renders the hole as
whitespace. Over that day's payload the largest bar-to-bar theta jump falls from 21.6 to 1.64 and
vega from 2.75 to 0.03. Carrying the last price forward was rejected deliberately: now that the
pane runs to 23:29, a leg that goes dark for a long stretch would otherwise accrue a whole tail of
fabricated greeks.

Two known gaps, both left as they are. `getGreeksAtTime`, which feeds the popover's per-leg
breakdown, still sums whatever legs it holds on those minutes — its net is partial there, but the
table names the legs it used, so the omission is visible rather than silent, and returning null
would blank the popover. And the loop still falls back to `iv = 0.2` when the solve fails, against
`impliedVolatility`'s documented contract of returning NaN and never a fabricated default; it
fired zero times across that session, so it is a latent wart rather than a live one.

---

## Greek and IV overlays

`src/hooks/useGreekOverlay.ts` drives the Vega / Theta / IV overlays. One hook instance per
measure; `src/components/GreekControls.tsx` renders the shared toolbar button and settings tray.
Five host views mount them, and none forks the hook, the controls or the maths — a change to a
Greek formula reaches all five:

| Host                                | How                                        |
| ----------------------------------- | ------------------------------------------ |
| Chart (`CandleChart.tsx`)           | Sub-pane below the candles                 |
| Tracker (`Tracker.tsx`)             | Inline on the price pane                   |
| Nubra BT (`NubraBacktest.tsx`)      | `Indicators` toggle → `GreekIndicatorPane` |
| Live / historical positions         | Same toggle in `StrategyAnalysisView.tsx`  |
| Backtest day (`TradeChartView.tsx`) | Same toggle, under the Net Greeks pane     |

`src/components/GreekIndicatorPane.tsx` is a self-contained chart pane wrapping the three
overlays — the Tracker's chart block minus the data loading, taking its bars from the host. It
hands its chart **and its underlying reference series** up via `onChartReady`: the series is what
a host must name in `setCrosshairPosition` to push a synced crosshair onto the pane.

Each host enrolls it in that host's own scroll and crosshair sync. Where a host builds its charts
inside one big effect (Nubra BT, the backtest day view) the enrollment lives in a small standalone
effect, because that effect owns the lifecycle of the charts it syncs while this one belongs to a
child component. Pushing a crosshair in from outside is safe there because those handlers already
ignore programmatic echoes — the `param.point === undefined && param.time !== undefined` branch.

#### Price scales: one full-height scale per measure, and two ways to read it

The pane shows two visible axes — the underlying reference line owns **right**, and **left** is
driven by the anchor described below — plus a private overlay scale per measure. Putting every
measure's totals on one shared axis does not work: Vega sits near +70 and Theta near −75, so each
holds the axis open for the other, neither can ever expand, and zooming changes nothing because
every window is still spanned by both. On CRUDEOIL, Theta at −246 flattened Vega into a straight
line.

Separation comes from the **scales**, not from the space. Every measure's overlay scale spans the
**full** pane with `autoScale: true`, so lightweight-charts re-fits each one to the visible window
on every zoom — per-window normalisation for free, with real values throughout: no transform on the
data and no de-normalising `priceFormat.formatter`. `autoScale` is stated at the call site in
`greekRenderer` rather than left to the library default, because it is the arrangement rather than
a detail: a frozen scale silently breaks it.

An earlier version instead sliced the pane into disjoint horizontal `scaleMargins` **bands**, one
per measure. That did separate them, but it also pinned Vega to the top third and Theta to the
bottom third for good and left each measure a third of the height to move in. `ScaleBand` and
`setBand` are gone; the cost of removing them, stated plainly, is that vertical position is no
longer comparable **across** measures — a Theta line above a Vega line means nothing.

That cost is what the next two sections pay off. Nine lines sharing a pane are only readable if you
can put real ticks against any one of them and magnify any one of them, and neither is possible
through the library's own controls once a line is on an overlay scale.

#### The left axis follows the cursor

A pane can show at most **two** price axes: lightweight-charts builds a `PriceAxisWidget` for
`left` and `right` and nothing else. One of those is the underlying's, so with five greek scales in
here any fixed assignment leaves most lines reading off floating last-value tags — and the Δ pairs
never get one at all.

So the left axis follows the cursor. Hover a line and the axis takes **that line's** range and its
own number format; move to another and it changes. All nine lines are reachable, IV and the dashed
Δ pairs included.

It cannot be done by moving series onto the axis — `priceScaleId` is fixed at series creation, so
following the cursor that way would destroy and rebuild four series per hover. An invisible **anchor
series** sits alone on the `left` scale instead, and its `autoscaleInfoProvider` returns whichever
line's range is wanted (read live via `IPriceScaleApi.getVisibleRange`, which is new in 5.2.0 and
does resolve overlay ids). Nothing moves between scales; one series' options change. The anchor
carries the underlying's time grid because a source with no points in view contributes nothing to a
scale's recalculation and its provider is then never consulted. The ticks land in the right place
because every overlay scale here carries identical `scaleMargins`, so two scales holding one range
paint their gridlines at the same y.

Three details that are load-bearing rather than polish. The nearest line is chosen by
`pickAxisTarget` (`src/lib/axisFollow.ts`) with a radius and a **stickiness** margin — nine lines
crossing in a 200px pane would otherwise trade the axis on cursor jitter, and drifting into empty
space would blank it exactly when you move off a line to go and read its ticks. The header caption
names the current line, because an axis gutter is a canvas and cannot label itself. And that caption
is also the **lock**: hover-follow alone is unusable for reading a line's shape, since moving toward
the ticks changes the axis to whatever you passed over.

The anchor is not a reading, so `greekRows` takes a list of series to exclude rather than one —
otherwise it appears as a nameless row in every tooltip and pinned card.

Two consequences worth knowing. Before the first hover there is no target, so the **left axis is
blank** rather than defaulting to a measure — a deliberate choice: an axis silently describing a
line you did not pick is worse than one that is visibly waiting. And a measure switched off, or
flipped between mine/industry or totals/Δ, destroys its series; the hit test self-heals on the next
hover (a target missing from the candidate list has no claim to stickiness), but the caption and any
lock are cleared eagerly so neither can sit there naming a line that has gone.

#### Stretching the lines

The same two-gutter limit means the library's own price-axis drag reaches one measure's totals and
leaves the other seven untouched: `handleScale.axisPressedMouseMove.price` is read only inside
`PriceAxisWidget`'s mouse handlers, and an overlay scale has no widget, no hit area and no handler.
Pane-body price scrolling is no escape either — it uses `pane.defaultPriceScale()`.

A drag on **either** gutter is therefore claimed capture-phase (the trick `bindPinTrigger` uses) and
applies one `{ zoom, pan }` factor to every greek and IV line at once. `handleScale` itself is
untouched, so the time axis, wheel and pinch are exactly as they were, and the library's own axis
handler never sees the mousedown and cannot double-apply on top.

| Gesture                         | Effect                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| Drag up / down on either gutter | Stretch or compress every line, same direction as the native gesture |
| Shift + drag on either gutter   | Pan every line together                                              |
| Hover a line                    | The left axis takes its range and number format                      |
| Click the header caption        | Lock / unlock the axis on that line                                  |
| `⟲`, or double-click the plot   | Back to 1×, unlocked, everything auto-scaling                        |

The zoom is exponential in the drag distance, so the feel is the same at 1× and at 10× — a linear
factor crawls when you are zoomed in and lurches when you are not. A factor other than 1 is shown
beside `⟲` (`2.4×`); at 1 it is hidden, because a readout that is always on screen stops being a
signal.

What moves is a **factor over each scale's own auto-fit**, never a fixed range — `makeVScaleProvider`
in `greekRenderer.ts` rewrites what `original()` returned. Every scale stays on autoscale, so each
keeps re-fitting the visible window as the time axis zooms with the stretch multiplied on top, and no
line can be stranded off-pane. `IPriceScaleApi.setVisibleRange` would have been the shorter road and
is exactly that trap: it forces `autoScale: false`. `pan` is denominated in the auto **half-range**,
not in price, so one gesture moves a line at +60 and one at −300 by the same number of pixels.

Changing the factor is not enough on its own — nothing tells the library the value moved. `applyVScale`
re-applies the option on one series, which raises a Light invalidation; the pane widget then
recalculates its left, right **and every overlay** scale, so one poke re-runs every provider in the
pane. That is why a stretch drag costs three `applyOptions` calls per frame and not eight.

**Reset is `⟲` in the pane header, or a double-click on the plot**, and it clears all three states
that can leave the pane somewhere the user cannot get out of by hovering: the stretch factor, a
locked axis, and any scale an earlier drag latched off autoscale. That last one is why
`GreekPane.resetScales` / `IvPane.resetScales` exist at all — the Δ pairs and the non-hovered
measures live on overlay scales whose ids are built inside `greekRenderer` from an internal
`scaleKey`, so there is no id to hand `chart.priceScale()` and nothing else in the app could recover
them. The handler deliberately leaves the **time** scale alone: this chart is enrolled in the host's
scroll sync, so resetting it would drag price and P&L along with it.

Both features are opt-in per host. `vScale` and the anchor exist only in `GreekIndicatorPane`; the
Tracker and the Chart view pass no `vScale`, so no `autoscaleInfoProvider` is installed and they stay
on exactly the library's own autoscale path.

#### Enrolling the pane: three things that bite

**A shared logical range only aligns charts that share a bar grid.** The pane's underlying line
goes through `barsToSessionLine`, which drops out-of-session bars; a host charting raw bars is
therefore offset by the count of leading pre-open ones — Nubra BT, whose `underlyingBars` start
~08:50, sat ~25 bars off its Indicators pane. `StrategyAnalysisView` escapes it only because it
clips to the session first, and `TradeChartView` because it syncs on **time** ranges. The fix in
`NubraBacktest.tsx` is to shift the range by `logicalAtTime(to, t) − logicalAtTime(from, t)` for
one instant both charts hold, `t` taken from `series.dataByIndex(centre, NearestLeft ?? NearestRight)`.
It is grid-agnostic, collapses to a plain copy when the grids match, and is exact because
`coordinateToLogical` returns integers — so the two-way binding still settles.

**Crosshair sync is symmetric and eventless.** `setCrosshairPosition` draws the lines but
suppresses the event (`skipEvent: true`), so whichever side pushes must also push the readout:
the pane exposes `syncCrosshair` as the third `onChartReady` argument, and the host feeds its own
tooltip updater the same instant. Nubra BT binds all three sibling panes → Indicators **and**
Indicators → all three siblings, so hovering the Greeks pane raises the pane's card and hovering
the pane raises the siblings' cards.

**Guard the push with a re-entrancy flag, never a "cursor is in pane X" latch.** lightweight-charts
re-fires a _pointed_ crosshair event whenever a chart's model updates — synthetic positions
included — so a crosshair pushed onto a pane comes back looking exactly like the cursor arriving
there. A latch set on that never releases and the pane freezes on one instant. The flag in
`NubraBacktest.tsx` is set and cleared in a `finally` around the push itself, the same shape the
range sync already used.

#### Chart lifecycle: `src/lib/chartLifecycle.ts`

Cross-chart sync makes disposal a hazard, because a removed chart does not fail where you touch
it. `chart.remove()` disposes the pane canvases but the model still holds the widget's invalidate
handler, so a later `setData` / `setVisibleLogicalRange` / `setCrosshairPosition` quietly schedules
a repaint; the **next frame** paints disposed canvases and throws `Object is disposed` from inside
the library, with no application frame on the stack and no try/catch at the call site able to reach
it. `removeChart` records the disposal, `isChartLive` answers the question, and `chartFrame` covers
the rAF case. Every chart teardown in `src/` goes through `removeChart` — the only literal
`.remove()` call left is the one inside it. Sync bindings hold **getters** for their targets rather
than captured handles, so each event re-reads liveness instead of trusting a handle from bind time.

`src/lib/greekTooltip.ts` handles that echo from the other side, and is where every "what do the
overlay lines read at instant X" question is answered:

| Export               | Answers                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `greekRows`          | Every visible overlay line's colour, title, value **and series** at a bar |
| `seriesValueAt`      | One series' value, carried forward from the last bar at or before it      |
| `logicalAtTime`      | Bar index for a timestamp — a pin has no cursor, so no `param.logical`    |
| `diffGreekRows`      | Two readings of one pane, paired by series title and subtracted           |
| `bindGreekCrosshair` | Wires the above into a pane's hover tooltip                               |

A row carries the series it was read from, which is what lets the axis-follow hit test ask where
each line sits on screen (`priceToCoordinate`) without walking the pane's series a second time.

Readings are carried forward with `MismatchDirection.NearestLeft` rather than requiring an exact
hit, because greek history is 1-minute while a live price line is 1-second: an exact read misses
at ~59 of every 60 cursor positions and the rows would blink out. The same carry-forward is what
lets a **synced** crosshair (no `point`, no `seriesData`) and a **pinned** card (no cursor at all)
show the same numbers a live hover does — including the underlying price row.

**Pins** work on the Indicators pane too. The host owns the pin list (`usePinnedTimes`) and passes
it down; the pane binds its own trigger and renders both its own card **and its own Δ strip**,
because the hosts' own cards and strips come from `buildPaneSnapshots`, which knows the price / P&L
/ Greeks shapes and nothing about which aggregate overlays are switched on. Both are built from the
same `rowsAt`, so a frozen card and the strip beside it can never describe different lines.
`diffGreekRows` pairs the two readings by series **title**, not by position: toggling a measure
between the pins shifts the list, and a positional pairing would quietly subtract Theta from Vega.
The host must NOT also bind a trigger on the pane's wrapper — both listeners are capture-phase, so
one middle-click would toggle the pin on and straight back off.

`PinnedCrosshairLayer` reserves a band at the foot of every pane for that strip, so Nubra BT's and
`StrategyAnalysisView`'s own panes inherit the fix too. The removable `n ✕` badges keep the bottom
20px and the strip sits directly above them — both used to be anchored to the bottom, so whichever
badge landed on the strip wrote straight through it. The layout pass measures the strip (after
capping its width, since a wrapped strip is taller) and keeps the pinned cards above it; `zIndex`
is the backstop for a card taller than its pane, because a card that overflows can be scrolled back
into view while a strip written over is simply lost. The strip wraps to a second row rather than
clipping — the Indicators pane can list nine rows where its siblings list three.

The settings tray is portalled to `document.body` and positioned by `src/lib/popupPlacement.ts`.
It has to be: as an `absolute` child it was clipped by four nested `overflow-hidden` ancestors,
and overflow clipping is immune to z-index.

**Live data is gated on the real calendar day, not the last loaded bar.** The two coincide on
the Chart and Tracker, so the distinction was invisible until a host charted a past window —
where a loaded-day guard would clamp a `Date.now()` snapshot onto a historical session's last
bar, printing today's greeks as that day's close. See `istTodayKey` in the hook.

Aggregation lives in `src/lib/greekAggregator.ts` and plots a delta-filtered near-the-money
basket, CE and PE as separate lines. The delta band is CE `[0.05, 0.609]` and PE
`[-0.609, -0.05]`.

| Setting     | Options              | Meaning                                                                      |
| ----------- | -------------------- | ---------------------------------------------------------------------------- |
| Method      | `mine` / `industry`  | Raw per-contract Greek sum, vs. notional `greek × OI × lotSize`              |
| Basket      | `fixed` / `floating` | Membership locked at t₀, vs. re-filtered every snapshot (default `floating`) |
| Composition | `chained` / `raw`    | Splice out membership steps, vs. plain Σ (default `chained`)                 |
| Baseline    | `session` / `window` | Where t₀ sits (default `session`)                                            |
| Series      | totals / diff / both | Absolute sum (solid) vs. change-from-t₀ (dashed, overlay scale; default `diff`) |

History loads a trailing window ending at the selected day — 7 days by default, matching the
Chart and Tracker candle loads. Hosts reviewing a single trade pass `histDays={1}`, so a Nubra BT
run or a position reconstructs just its own session and the `HISTORIC DAY` picker moves to
another. Cost is linear in this, which is why a backtest's full multi-month range is not fetched.

**Basket** defaults to `floating`, so the line reads the near-the-money basket as it actually
is, re-filtered on every snapshot. `fixed` locks membership at t₀ and keeps legs that have since
drifted out of the delta band — the lens for following one day's cohort, and the one the diff
series and the `session` baseline are built around. The toggle lives in `useGreekOverlay`'s state
and is not persisted, so every fresh mount opens on `floating`.

**Baseline** matters because of that trailing window. `session` (default)
re-anchors t₀ at every IST trading day, so the fixed basket re-locks and the diff series
returns to zero at that day's first snapshot — not at a fixed clock time, since a partial
day starts late and MCX opens at 09:00. Each session is self-contained while the whole
window stays on screen. `window` uses one t₀ for the entire range. Totals under a floating
basket are baseline-independent; only diff and fixed-basket membership respond.

**Composition** exists because the delta band's upper edge sits almost exactly on the vega
peak. Vega ∝ φ(d₁) is maximal at Δ≈0.5, and `CE_DELTA_MAX = 0.609` is d₁ = +0.276, where vega
is still 96% of that maximum — so a strike crossing the top edge takes a near-maximal
contribution with it and the total steps for a reason that is not Greek movement. On NIFTY at
~6 DTE that is roughly 15% of the CE total per crossing, triggered by about 50 index points.

`chained` (default) removes it the way every other field does: evaluate the outgoing and the
incoming basket at the **same** snapshot and carry the difference forward as an offset.
Continuous-futures back-adjustment, the S&P divisor and CPI chain-linking are all this
algorithm; the continuous-time form is the Divisia index. The offset is additive, not
multiplicative — vega sums approach zero near expiry and a ratio would blow up there.

Two supporting details. Membership only flips once a leg has disagreed with it for
`MEMBERSHIP_DWELL_MS` (60 s), because the accumulated offset grows with the _number_ of splices
(the well-known drift in back-adjusted futures); this is a dwell timer, not a retention band,
so the 0.05 / 0.609 thresholds are untouched. It is denominated in **time, not snapshots**:
history arrives at 1m and the live tail at ~2s, so a snapshot count would have meant a 2-minute
debounce on history and a 4-second one live — no real protection exactly where the chart is
densest. The series should have the same shape however often it is sampled. And
`baseline: 'session'` zeroes the offset every day, which caps drift for free.

The trade is that a chained level is an artifact in the same sense as a back-adjusted futures
price: it answers "what would this basket be worth had composition never changed", not "what is
the current basket worth". `raw` gives the latter, and is what `buildSeries` returns by default
when no `composition` is passed.

Separately and always on, `buildSeries` carries each leg forward on its last known values. The
broker's 1m timeseries is per-field, so a leg can print delta without vega; before this it
still qualified for the basket (it has a delta) yet contributed zero, which read on the chart
as a one-bar collapse of the whole total. A leg silent for longer than `CARRY_STALE_MS`
(15 min) is dropped rather than carried indefinitely.

### Historical Greek reconstruction

History is reconstructed at 1-minute resolution (per-point IV inversion is too slow for 1s);
the live tail stays true per-tick from the `option_chain` WS feed, with a 4-second REST
fallback poll once WS has been silent for 6 seconds. Precedence in `buildHistorySnapshots` is:

1. Broker-served `delta`/`vega`/`theta` if the timeseries carries them.
2. Broker-served `iv` + Black-76.
3. Invert IV from `close` + forward, then Black-76.

**Probed live 2026-07-30:** the timeseries _does_ serve historical `delta`/`vega`/`theta`
(values match the live chain), so path 1 normally wins — an older assumption that the broker
stores no historical Greeks is out of date.

**Corrected 2026-08-03: the timeseries also serves historical IV**, as `iv_bid` / `iv_mid` /
`iv_ask`. The 2026-07-30 probe concluded otherwise, but it only tried `iv`,
`implied_volatility`, `impliedVolatility`, `implied_vol`, `ivPct`, and `volatility` — never the
`iv_*` names, which are the ones the V3 field list documents. Re-probed against
`NIFTY2680424750CE` (1 DTE ATM CE) over a full session: 376/376 one-minute points populated on
all three, no nulls or zeros, `iv_bid < iv_mid < iv_ask` throughout, range 0.1106–0.1201 —
a genuine bid/ask volatility spread, matching `close` and `delta` point-for-point.

#### What `iv_*` actually is — measured 2026-08-03

Nubra support was asked directly and answered "Black-Scholes on spot", then contradicted
itself in the same paragraph ("if forward-based… put-call parity or spot compounded at a
risk-free rate… the exact method may depend") and gave no rate. So it was measured instead.

Sample: NIFTY expiry 20260811 (8 DTE), 49 strikes spanning ±5% of ATM, both sides, full
session at 1m — 25,436 usable points from 25,734 considered. The probe reuses `GexService`'s
own `forwardFromParity` / `impliedVolatility` rather than reimplementing them, and its delta
control reproduces the broker's own `delta` to a mean 0.00133, so the harness is sound.

| forward source | unpriceable | mean \|IV − `iv_mid`\| |
| -------------- | ----------- | ---------------------- |
| parity         | 17 / 25436  | **0.057 vol pts**      |
| spot           | 500 / 25436 | 0.757 vol pts          |
| `spot·e^{rT}`  | 1325/ 25436 | 0.750 vol pts          |

**The vendor prices off the forward, not spot** — parity beats spot by 13×, and there is no
residual skew tilt (median signed error 0.000 vol pts on both the ITM and OTM wings; a wrong
forward tilts the wings in opposite directions). Backing their forward out of their own
`iv_mid` + `delta` at near-ATM strikes puts it **0.4 index points** from the parity forward
(n=7437). Their support answer was wrong on the one question that mattered.

**Chain `iv` and timeseries `iv_mid` are the same series** — bit-identical across 10 near-ATM
legs, to every digit served. There are not two vendor volatilities; there is one.

The bid/ask IV band is real but narrow: median width 0.023 vol pts (≈7 ticks at this expiry's
vega). Our `close`-inverted IV lands inside it 41.6% of the time, and when outside misses by a
median 0.008 vol pts, biased above the mid 3.5:1 — last trade sits above mid more often than
below, which is a price-selection artifact and not a model difference.

`buildHistorySnapshots` still derives IV by inversion on the broker-Greek path (gated on the IV overlay
being active, since Vega/Theta never read it). Given the above that is now a _choice_ rather
than a necessity, and a cheap one to revisit — [useGreekOverlay.ts](src/hooks/useGreekOverlay.ts)
requests `'iv'` in `HIST_FIELDS`, the one name that is never served, so a single-word change to
`'iv_mid'` would switch history onto the vendor series. **Left as-is deliberately.** The
~0.26 vol-point offset documented in `server/backtest/ivHistory.ts` is against the _parquet_
`iv` column, which this measurement shows is a different product from the API series — so that
offset neither justifies nor forbids the switch, and nothing has yet measured the parquet
column against `iv_mid` on an overlapping date. Until that is done, one pipeline end to end
beats two that agree to 0.057 vol points for reasons nobody has pinned down.

One incidental constraint found while sampling: `charts/timeseries` rejects more than
**10 symbols per query** (`"maximum 10 values allowed in one query"`), so wide ladders must be
batched.

**Black-76 prices off the forward, and the forward's _level_ is what matters.** Use
`forwardFromParity(K, C, P, r, T)` — `F = K + (C − P)·e^{rT}` at the strike nearest spot —
whenever a CE/PE pair is available. Measured against a live NIFTY chain (spot 24257.45,
5.2 days, 122 populated legs):

| forward source | unpriceable | mean \|IV − brokerIV\| |
| -------------- | ----------- | ---------------------- |
| parity         | 0 / 122     | 0.13 vol pts           |
| spot           | 11 / 122    | 0.79 vol pts           |
| `spot·e^{rT}`  | 14 / 122    | 1.33 vol pts           |

On that occasion NIFTY's basis was **negative** — parity implied 24231.48 against a 24257.45
spot, and inverting the broker's own IV+delta independently gave 24232.12, agreeing to 0.6
points. Compounding spot at `+r` therefore moved the forward the _wrong way_, and made
genuinely-traded ITM calls look sub-intrinsic (11 of 122 legs traded below spot-intrinsic)
which the no-arb guard then rejects. The carry rate barely matters by comparison: `r = 0`
versus `r = 0.07` moved the mean error only 0.79 → 0.79.

**The sign is not a constant, so do not encode it.** The 2026-08-03 sweep above measured the
same basis at a **median +18.1 points** (mean +12.8, range −172.3 to +38.8 across the session)
on the 8 DTE expiry — positive, where the earlier reading was negative. That is not a
contradiction so much as the point: the basis moves with the session and the tenor, which is
precisely why parity is read per timestamp rather than assumed. Any static carry constant,
of either sign, is wrong somewhere.

The historical path was validated the same way, against the broker's own historical `delta`
across 8988 one-minute points: parity reproduced it to a mean error of **0.00092** with 0
unpriceable points, versus 0.01723 / 28 for spot and 0.05109 / 254 for `spot·e^{rT}`. Parity
coverage was 753/753 timestamps, since CE and PE close series share ~97.7% of their timestamps
at a given strike. The basis **moves** intraday (median −8.9, range −41 to +64), so no static
carry constant substitutes for parity.

`useGreekOverlay` builds a per-expiry, per-timestamp parity forward from the `close` series it
already fetches. `StrategyAnalysisView`, `NubraBacktest` and `backtest/TradeChartView` have no
CE/PE pair to hand and so pass **spot** as the forward proxy — deliberately, per the table
above. `server/backtest/greeks.ts` assumes `r ≈ 0`, where forward equals spot, and is unaffected.

**Theta is model-specific.** `blackScholes` uses `(-(df·F·n(d1)·σ)/(2√T) + r·price)/365` on the
Black-76 branch and the spot-model formula on the `isFutures: false` branch. Under Black-76 a
deep-ITM option has **positive** theta — its price is ≈ `df·(F−K)` and the discount factor
unwinds toward 1 as expiry approaches — which is correct, not a bug. Every analytic Greek is
regression-tested against finite differences of the function's own price.

`impliedVolatility()` returns **NaN** when no finite IV exists (sub-intrinsic or
past the no-arbitrage bound) or the solve fails — it never substitutes a default. It rejects
out-of-bound prices up front, seeds from Brenner–Subrahmanyam, runs Newton-Raphson, and falls
back to bisection on `[1e-4, 5]` when vega collapses. `buildHistorySnapshots` drops unpriceable legs
and reports the count via the `partial` history state, so gaps are visible rather than
smoothed over.

### IV measures

IV is aggregated by `buildIvSeries()`, deliberately **not** through `legValue()`/Method —
summing raw IV across strikes is meaningless and the `industry` OI weighting is nonsense for
a volatility. Measures are interpolated at constant **delta** rather than fixed strike, so
the series stays comparable as spot moves. Output is in vol points (percent); the broker
serves `iv` as a decimal.

| Measure | Definition                             | Reads as  |
| ------- | -------------------------------------- | --------- |
| `atm`   | IV at 50Δ, CE and PE averaged          | vol level |
| `rr25`  | `IV(25Δ CE) − IV(25Δ PE)`              | skew      |
| `fly25` | `½·(IV(25Δ CE) + IV(25Δ PE)) − ATM IV` | smile     |

Each selected expiry is interpolated separately and the per-expiry measures averaged, since
the same delta on two expiries carries different IVs. Points that cannot be computed are
omitted rather than extrapolated.

### IV rank and IV percentile

The measures above give the _level_ of vol but no sense of whether that level is high. Rank and
percentile supply the context, shown in the IV popup for the `atm` measure only — `rr25` and
`fly25` are skew and smile, so placing either inside a range built from ATM levels would be a
category error.

- **Rank** — `(current − min) / (max − min)`, position in the historical **range**.
- **Percentile** — share of sessions at or below current, position in the **distribution**.

Both are shown because they disagree usefully: one crisis print can pin an end of the range, so
rank reads low while percentile reads high. That divergence is the signal that the range has an
outlier in it.

**Baseline** — `server/backtest/ivHistory.ts`, served by `GET /api/iv-history?und=&days=`. The
broker serves no historical IV, so the baseline is read from the backtest parquet tree instead:
the `ATM` bucket is by construction the strike nearest spot, and the expiry folder names are the
expiry calendar, so no broker calls or calendar reconstruction are needed. ~600 ms cold for a
year, then cached per expiry. Underlyings outside the tree (BANKNIFTY, single stocks) return 400
and the UI reports no baseline rather than ranking against the wrong instrument.

Three decisions in that file are load-bearing, each forced by measurement:

1. **Inverted, not read.** The `iv` column exists, but the live reading being ranked comes from
   the app's own parity-forward inversion. Across 160 matched marks the vendor column sat below
   it on ~95 % (median 0.26 vol points) — a one-directional offset between a reading and its own
   range. The baseline is therefore inverted with the same `impliedVolatility` the overlay uses,
   from the CE/PE closes at the shared ATM strike, making the offset structurally zero. The
   vendor number is retained per observation as a drift witness and asserted on in tests.
2. **0 DTE excluded.** On expiry day the ATM premium is nearly all remaining-minutes, so its
   implied vol tracks the countdown: 14.1 → 0.4 over one afternoon on 2025-11-04, with 0-DTE
   p05/p25 at 1.97/5.26 against 1-DTE's 9.71/11.87. Included, it would drag every range's floor
   down. A 0-DTE selection is refused rather than compared to 1–2 DTE history.
3. **A 6 vol-point floor.** Vendor breakages print absurd values for a whole day — 2025-12-30
   reports an identical 1.2818695 from two unrelated contracts. One such day left in would define
   the bottom of the range.

**Maturity matching** — index IV rises mechanically into expiry, so a reading is ranked only
against observations at comparable maturity. The tree cannot support a daily constant-maturity
series (a weekly file covers only its own final week, so 30-DTE data exists roughly one date a
month), so `src/lib/ivRank.ts` buckets instead: 1–2, 3–7, 8–15, 16–31, 32+ DTE. A band under
`MIN_SAMPLE` reports why instead of borrowing a shorter maturity — 32+ is empty in practice,
so far-dated selections correctly get no rank. Measured 1-year sample: 45 / 129 / 56 / 82 / 0.

---

## Margin calculation

Basket margin follows this chain:

1. Request Nubra v3 `/sentinel/orders/funds_required` using `NUBRA_MARGIN_BASE_URL`. This is
   the authoritative number and it works — the response comes back `estimated: false`,
   `source: nubra-margin-api`.
2. Only if that request fails, fall back to `server/marginEngine.ts`, which prices the basket
   from the live feed: a 16-scenario SPAN simulation on NSE, or a per-commodity scan rate on
   MCX. The response is tagged `estimated: true` and the UI badges it `(Est.)`.

`normalizeMarginResponse()` converts supported broker response shapes into total margin,
SPAN, exposure, option premium, margin benefit, and per-leg margin values.

**The `exchange` field on the request decides which of the two you get.** The route builds the
v3 payload from it, and an MCX basket tagged `NSE` is rejected outright with
`"Strategy Flexi is not supported in MCX"` — so it silently degrades to the local estimate,
priced by the wrong model. Callers holding only a position (no refdata row) must therefore read
the exchange off the **zanskar** name, never `display_name`: `strategyPositionExchange()` in
`src/lib/strategyPositionMeta.ts` is the helper that does this correctly, and it scans every
leg rather than trusting the first. See the MCX section below for why `display_name` cannot
work. This bit the Positions panel until 2026-08-17, where
`exchangeFromName(display_name || zanskar_name)` short-circuited on the one name that can never
match the MCX shape: a crude strangle whose real margin was ₹5,08,135 displayed ₹1,71,125.

An estimate is not a substitute for the broker figure — it disagreed by a factor of three in
that case. Treat a persistent `(Est.)` badge on a live position as a bug to diagnose, not as a
number to trust.

---

## Commodities (MCX)

Added 2026-08-03. MCX is reached through the same endpoints as NSE/BSE with `exchange=MCX`, and
the app treats it as a first-class asset class everywhere except the local-Parquet backtest tab,
which reads an NSE-only tree. Everything below was measured against the live API, not taken from
the vendor docs.

**Scale.** 15,766 instruments, 30 commodities. Options exist on 11 — CRUDEOIL, CRUDEOILM,
NATURALGAS, NATGASMINI, GOLD, GOLDM, SILVER, SILVERM, COPPER, ZINC, MCXBULLDEX; the other 19 are
futures-only and degrade to a chartable instrument with no chain.

**Symbols are the zanskar form, and that is the trading symbol.** On MCX `stock_name` equals
`zanskar_name` (unlike NSE): `FUT_CRUDEOIL_20260819`, `OPT_CRUDEOIL_20260817_CE_875000`.
`charts/timeseries` takes them verbatim with `type: "FUT"` / `"OPT"`. Refdata carries four
fields NSE rows lack — `prev_close`, `freeze_qty_limit`, `asset_code`, `zanskar_id` — and
`asset_type` is `COM_FO`.

#### The forward is observable, so none of the NIFTY parity machinery applies

Commodity options are options **on futures**, and the option expiry is not the futures expiry.
The rule is: option expiry → the _next_ futures expiry. Verified exactly across 12 chains and
four commodities, where each chain's `cp` equalled its future's LTP **to the paisa**:

| option expiry               | underlying future       | note                    |
| --------------------------- | ----------------------- | ----------------------- |
| CRUDEOIL 20260817           | `FUT_CRUDEOIL_20260819` |                         |
| GOLD 20260831 and 20260925  | `FUT_GOLD_20261005`     | two options, one future |
| SILVERM 20260924 / 20261027 | `FUT_SILVERM_20261130`  | same                    |

So Black-76 with `F` = the futures price is exact, and `buildParityForwards` is bypassed
entirely on MCX. `mcxUnderlyingFutureExpiry` and `mcxFutureSymbol` in `src/lib/GexService.ts`
do the mapping. This makes commodity Greeks _simpler_ than NIFTY's, where the forward must be
implied — see the forward section above, none of which is relevant here.

**Session is 09:00–23:30 IST, 870 one-minute bars a day** against NSE's 375.
`MARKET_SESSIONS` / `marketSession(exchange)` in `src/lib/utils.ts` is the single source of
truth, mirrored by hand into `server/ocFeedGuard.ts` (the server cannot import the app bundle —
**keep the two tables in step**). Every session filter and time grid derives from it; before
this, anything after 15:30 was silently discarded.

**Expiry settles at the exchange close, not 15:30** (`expiryInstantMs`). Measured by inverting
the vendor's own `vega` + `iv_mid` for `T` under Black-76 — vega scales as √T so `T` is well
determined, whereas delta barely moves with `T` and scattered uselessly. 4,344 points put MCX
expiry at ~00:20 IST the following day after bias removal; the same method on NIFTY, where
15:30 is known, returns +41 min. So ~1 h of residual is inside the method's own error bar, and
15:30 is excluded for MCX by roughly nine hours.

**The chain is keyed by the commodity; the underlying is a futures contract.** Fetch and
subscribe as `CRUDEOIL`, price off `FUT_CRUDEOIL_20260819`. `getChainAsset(inst)` versus
`getSymbol(inst)` in `src/types.ts` is that distinction — do not collapse them. Positions and
orders only ever carry a name, so `exchangeFromName()` (client) and `parseDisplayName()`
(server) read the exchange off the zanskar shape; the old `/^([A-Z]+)/` asset rule returns
**"OPT"** for every MCX instrument, which would have left commodity positions holding no feed.

A position carries **two** names and only one of them works here. `zanskar_name` is
`OPT_CRUDEOIL_20260817_PE_780000`; `display_name` is the human `CRUDEOIL 7800 PE`, which is
deliberately stripped of the `OPT_`/`FUT_` prefix and therefore **can never** match the MCX
pattern. Because `display_name` is always populated, writing
`exchangeFromName(p.display_name || p.zanskar_name)` short-circuits on the name that always
fails and silently resolves every commodity position to `NSE`. Always pass the zanskar name
first, or better, call `strategyPositionExchange(positions)`, which encodes the precedence and
checks all the legs.

**Verification.** Reconstructing delta from our own Black-76 and comparing against the broker's
historical `delta` scores **0.00137** mean error on crude (15,638 points) versus **0.00125** on
NIFTY measured identically — one control that validates `F`, `T` and the model together. Our
close-inverted IV sits 0.256 vol points from the vendor's `iv_mid` on crude against 0.043 on
NIFTY, which is the same _relative_ accuracy given crude runs ~65 % IV and NIFTY ~11 %.

**Two caveats, both deliberate:**

- **The local MCX margin estimate is uncalibrated, so prefer the broker.** The broker margin API
  does answer for MCX and is authoritative — request it with `exchange=MCX` and note that the
  exchange refuses the **Flexi** strategy tag, which is what an `NSE`-tagged commodity basket
  sends. The local fallback in `computeCommodityMargin()` is deliberately a different shape from
  the NSE path: MCX behaves as a flat per-commodity charge (a scan rate on spot, plus premium,
  bounded by `LOCAL_MARGIN_MCX_RATE_FLOOR`/`_CAP`) with **no cross-leg netting**, so the
  16-scenario SPAN simulation is not merely mis-rated for commodities, it is the wrong model.
  The rate is derived from live IV, realised vol and gaps rather than an exchange table, so
  treat it as an order-of-magnitude figure only.
- **`optionchains/{sym}/price` returns 500 for MCX** in every documented symbol form, while NSE
  works through the identical code path — an upstream limitation. Harmless: its only caller is a
  fallback that fires when the chain reports no `cp`, and the MCX chain always carries one.

---

## Conventions

- **An open position's P&L is mark-to-market _plus_ what it has already booked.** A leg can be
  squared off in part: it stays in `/paper/positions` with the remaining quantity and carries the
  booked amount in `realised_pnl`. `openPositionPnlPaise` in `src/lib/paperPnl.ts` sums both, which
  is what makes the terminal's per-leg P&L, its group totals and its Day P&L agree with
  `/paper/pnl`. `openPositionUnrealisedPnlPaise` is the mark-to-market half on its own, and is what
  the `P&L %` column is a percentage of — the two can differ in sign on a partially closed leg, so
  each cell is coloured by the number it actually shows.
- **Irreversible actions confirm through `ConfirmDialog`**, never `window.confirm`. That is the
  square-off buttons in the Positions tab (both the per-strategy one and Exit All) and logout. A
  pending square-off holds position _keys_ and re-reads the book when confirmed, so a leg that
  closed while the dialog was open cannot be ordered against.
- `nubra_name` is the broker's exchange-prefixed instrument name.
- `zanskar_name` is the legacy/alternate API name.
- `stock_name` is the plain underlying name.
- `display_name` is human-readable.
- `ref_id` is the numeric subscription and routing identifier.
- Basket group IDs use `bg_<timestamp>_<random>` and bind multi-leg positions and analysis.
- Snapshot IDs combine basket group ID and trade date.
- Theme preference is stored as `nubra-theme` in `localStorage` and applied through the
  document's `data-theme` attribute.
- WebSocket subscriptions return an unsubscribe function and must be cleaned up by React
  effects.

---

## High-risk change areas

| Area                                      | Why it has broad impact                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `server/index.ts`                         | Auth recovery, WS relay, subscriptions, scheduling, and module wiring |
| `server/paperRoutes.ts`                   | Orders, positions, rules, margin, baskets, and snapshots              |
| `server/nubraBacktestRoutes.ts`           | Broker-history replay and evaluation                                  |
| `server/simBroker.ts`                     | Fills, positions, persistence, and PnL ticks                          |
| `server/backtest/engine.ts`               | Core historical simulation behavior                                   |
| `server/backtest/types.ts`                | Canonical backtest contracts                                          |
| `server/paperDb.ts`                       | SQLite schema and persistence                                         |
| `src/components/StrategyAnalysisView.tsx` | Strategy rendering and analysis                                       |
| `src/components/OrderTerminal.tsx`        | Paper-trading terminal behavior                                       |
| `src/Backtest.tsx`                        | Backtest UI and result presentation                                   |
| `src/BasketOrder.tsx`                     | Multi-leg construction and submission                                 |
| `src/types.ts`                            | Shared frontend contracts                                             |

Changes in these areas should be preceded by dependency review and followed by type-checking,
focused tests, the full test suite, a production build, and live smoke checks where applicable.
