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

Optional: `NUBRA_MARGIN_BASE_URL`, `NSE_SPAN_RISK_FILE`, `LOCAL_MARGIN_EXPOSURE_RATE`,
`LOCAL_MARGIN_NAKED_SHORT_SPAN_RATE`, `LOCAL_MARGIN_STRANGLE_SECOND_LEG_ADDON`.

### Install & run

```bash
npm install
npm start          # server (:3000) + Vite dev (:8000) together
```

Then open http://localhost:8000 and complete the OTP → MPIN login.

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

| Method | Path                                 | Purpose                                      |
| ------ | ------------------------------------ | -------------------------------------------- |
| GET    | `/api/refdata?exchange=NSE`          | Get daily server-cached exchange instruments |
| GET    | `/api/instruments/search`            | Fuzzy-search refdata                         |
| GET    | `/api/instruments/lookup`            | Look up one instrument by `ref_id`           |
| POST   | `/api/historical`                    | Proxy Nubra chart timeseries data            |
| GET    | `/api/optionchain/:instrument`       | Get an enriched option chain                 |
| GET    | `/api/optionchain/:instrument/price` | Get the underlying price (NSE/BSE only — MCX 500s upstream) |

All of these accept `?exchange=` (`NSE` default, plus `BSE` and `MCX`). It is omitted from the
outbound request when NSE, so those calls stay byte-identical to what they have always been.

#### Historical data retention — the docs are wrong below one minute

The vendor docs say "intervals less than 1 day → last 3 months". That holds for `1m` and
coarser. **Sub-minute is a rolling 7×24 hours**, and only `1s` and `10s` exist — `5s` is
accepted but returns nothing, `15s`/`30s` return 500. Measured 2026-08-03 on both NSE and MCX:
at 21:07 IST, 27 Jul 20:00 IST returned 500 while 27 Jul 22:00 IST returned data, so the cutoff
is exactly `now − 168h`.

A window that **straddles** that edge fails the *entire* query with a 500 rather than clipping,
so `startDate` must be clamped — `clampSubMinuteStart` in `src/lib/utils.ts`, applied inside
`fetchRange`, which every historical fetch goes through. Note also that 1s bars are tick-driven
rather than filled: over one 20-minute window NIFTY yields 1200, a crude future 413, a crude
option 35.

### Local Parquet backtesting

| Method | Path                        | Purpose                                       |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/api/backtest/meta`        | Get available underlyings and expiry ranges   |
| POST   | `/api/backtest/run`         | Run a full backtest                           |
| POST   | `/api/backtest/day`         | Get one trading day's intraday detail         |
| POST   | `/api/backtest/sweep`       | Run a one- or two-dimensional parameter sweep |
| POST   | `/api/backtest/walkforward` | Run walk-forward optimisation                 |
| GET    | `/api/iv-history`           | Daily ATM IV baseline for the Tracker's IV rank |

`server/nubraBacktestRoutes.ts` additionally exposes Nubra broker-history chain/evaluation
routes used for single-day replay and comparison.

### Paper trading

| Method       | Path                           | Purpose                                               |
| ------------ | ------------------------------ | ----------------------------------------------------- |
| GET / POST   | `/paper/orders`                | List or place orders                                  |
| POST         | `/paper/orders/multi`          | Place independent orders                              |
| POST         | `/paper/orders/basket`         | Place grouped basket legs and snapshot margin         |
| POST         | `/paper/orders/modify/:id`     | Modify an open order                                  |
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
          entry_time, exit_time, exit_price)

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
strategy templates, and shared utilities. `src/backtest/` contains frontend backtest types,
leg configuration, intraday trade charts, and client analysis helpers. Shared frontend domain
interfaces live in `src/types.ts`.

---

## Greek and IV overlays

`src/hooks/useGreekOverlay.ts` drives the Vega / Theta / IV overlays shared by the Chart
(sub-pane) and Tracker (inline on the price pane) views. One hook instance per measure;
`src/components/GreekControls.tsx` renders the shared toolbar button and settings popup.

Aggregation lives in `src/lib/greekAggregator.ts` and plots a delta-filtered near-the-money
basket, CE and PE as separate lines. The delta band is CE `[0.05, 0.609]` and PE
`[-0.609, -0.05]`.

| Setting  | Options              | Meaning                                                        |
| -------- | -------------------- | -------------------------------------------------------------- |
| Method   | `mine` / `industry`  | Raw per-contract Greek sum, vs. notional `greek × OI × lotSize` |
| Basket   | `fixed` / `floating` | Membership locked at t₀, vs. re-filtered every snapshot         |
| Baseline | `session` / `window` | Where t₀ sits (default `session`)                               |
| Series   | totals / diff / both | Absolute sum (solid) vs. change-from-t₀ (dashed, overlay scale) |

**Baseline** matters because history loads a trailing 7-day window. `session` (default)
re-anchors t₀ at every IST trading day, so the fixed basket re-locks each 9:15 and the diff
series returns to zero — each session is self-contained while the whole window stays on
screen. `window` uses one t₀ for the entire range. Totals under a floating basket are
baseline-independent; only diff and fixed-basket membership respond.

### Historical Greek reconstruction

History is reconstructed at 1-minute resolution (per-point IV inversion is too slow for 1s);
the live tail stays true per-tick from the `option_chain` WS feed, with a 4-second REST
fallback poll once WS has been silent for 6 seconds. Precedence in `mergeHistory` is:

1. Broker-served `delta`/`vega`/`theta` if the timeseries carries them.
2. Broker-served `iv` + Black-76.
3. Invert IV from `close` + forward, then Black-76.

**Probed live 2026-07-30:** the timeseries *does* serve historical `delta`/`vega`/`theta`
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

`mergeHistory` still derives IV by inversion on the broker-Greek path (gated on the IV overlay
being active, since Vega/Theta never read it). Given the above that is now a *choice* rather
than a necessity, and a cheap one to revisit — [useGreekOverlay.ts](src/hooks/useGreekOverlay.ts)
requests `'iv'` in `HIST_FIELDS`, the one name that is never served, so a single-word change to
`'iv_mid'` would switch history onto the vendor series. **Left as-is deliberately.** The
~0.26 vol-point offset documented in `server/backtest/ivHistory.ts` is against the *parquet*
`iv` column, which this measurement shows is a different product from the API series — so that
offset neither justifies nor forbids the switch, and nothing has yet measured the parquet
column against `iv_mid` on an overlapping date. Until that is done, one pipeline end to end
beats two that agree to 0.057 vol points for reasons nobody has pinned down.

One incidental constraint found while sampling: `charts/timeseries` rejects more than
**10 symbols per query** (`"maximum 10 values allowed in one query"`), so wide ladders must be
batched.

**Black-76 prices off the forward, and the forward's *level* is what matters.** Use
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
points. Compounding spot at `+r` therefore moved the forward the *wrong way*, and made
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
back to bisection on `[1e-4, 5]` when vega collapses. `mergeHistory` drops unpriceable legs
and reports the count via the `partial` history state, so gaps are visible rather than
smoothed over.

### IV measures

IV is aggregated by `buildIvSeries()`, deliberately **not** through `legValue()`/Method —
summing raw IV across strikes is meaningless and the `industry` OI weighting is nonsense for
a volatility. Measures are interpolated at constant **delta** rather than fixed strike, so
the series stays comparable as spot moves. Output is in vol points (percent); the broker
serves `iv` as a decimal.

| Measure | Definition                            | Reads as   |
| ------- | ------------------------------------- | ---------- |
| `atm`   | IV at 50Δ, CE and PE averaged         | vol level  |
| `rr25`  | `IV(25Δ CE) − IV(25Δ PE)`             | skew       |
| `fly25` | `½·(IV(25Δ CE) + IV(25Δ PE)) − ATM IV` | smile      |

Each selected expiry is interpolated separately and the per-expiry measures averaged, since
the same delta on two expiries carries different IVs. Points that cannot be computed are
omitted rather than extrapolated.

### IV rank and IV percentile

The measures above give the *level* of vol but no sense of whether that level is high. Rank and
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

1. Request Nubra v3 `/sentinel/orders/funds_required` using `NUBRA_MARGIN_BASE_URL`.
2. If unavailable, use `server/marginEngine.ts` with configurable rates and the optional NSE
   SPAN risk file.

`normalizeMarginResponse()` converts supported broker response shapes into total margin,
SPAN, exposure, option premium, margin benefit, and per-leg margin values.

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
The rule is: option expiry → the *next* futures expiry. Verified exactly across 12 chains and
four commodities, where each chain's `cp` equalled its future's LTP **to the paisa**:

| option expiry              | underlying future       | note                        |
| -------------------------- | ----------------------- | --------------------------- |
| CRUDEOIL 20260817          | `FUT_CRUDEOIL_20260819` |                             |
| GOLD 20260831 and 20260925 | `FUT_GOLD_20261005`     | two options, one future     |
| SILVERM 20260924 / 20261027| `FUT_SILVERM_20261130`  | same                        |

So Black-76 with `F` = the futures price is exact, and `buildParityForwards` is bypassed
entirely on MCX. `mcxUnderlyingFutureExpiry` and `mcxFutureSymbol` in `src/lib/GexService.ts`
do the mapping. This makes commodity Greeks *simpler* than NIFTY's, where the forward must be
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

**Verification.** Reconstructing delta from our own Black-76 and comparing against the broker's
historical `delta` scores **0.00137** mean error on crude (15,638 points) versus **0.00125** on
NIFTY measured identically — one control that validates `F`, `T` and the model together. Our
close-inverted IV sits 0.256 vol points from the vendor's `iv_mid` on crude against 0.043 on
NIFTY, which is the same *relative* accuracy given crude runs ~65 % IV and NIFTY ~11 %.

**Two caveats, both deliberate:**

- **Margin is not calibrated for MCX.** Every constant in `server/marginEngine.ts` is an NSE
  equity-derivatives parameter, and the broker margin API is dead, so there is nothing to defer
  to. Commodity legs run the same model-driven 16-scenario simulation and the response says
  "NOT calibrated to exchange parameters" outright rather than passing off an NSE-rated number.
  `LOCAL_MARGIN_ELM_COMMODITY` and `LOCAL_MARGIN_PSR_COMMODITY` take real figures once obtained.
- **`optionchains/{sym}/price` returns 500 for MCX** in every documented symbol form, while NSE
  works through the identical code path — an upstream limitation. Harmless: its only caller is a
  fallback that fires when the chain reports no `cp`, and the MCX chain always carries one.

---

## Conventions

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
