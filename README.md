# bRODHa — Nubra Trading Dashboard

A self-hosted, full-stack trading dashboard for Indian equity derivatives. It connects to
the **Nubra broker API** for live market data, option chains, and authentication; ships a
**paper-trading simulation engine (SimBroker)**; and includes a **historical backtesting
engine** built on locally-stored Parquet option data.

> Single-user, runs on your own machine. Broker credentials never reach the browser — the
> Node server acts as an auth proxy and holds the session token server-side only.

---

## Tech stack

| Layer        | Technology                                                      |
| ------------ | --------------------------------------------------------------- |
| Frontend     | React 19, TypeScript, Vite 6, TailwindCSS 3 + DaisyUI 4         |
| Backend      | Node.js (ESM, `--experimental-strip-types`), Fastify 5          |
| Real-time    | WebSocket (`ws` server-side, native browser WS client-side)     |
| Database     | SQLite via `better-sqlite3` (`paper.db`)                        |
| Data format  | Parquet (`hyparquet`) for backtest historical data             |
| Serialization| Protobuf (`protobufjs`, schema `nubra.proto`) for broker WS     |
| Charts       | `lightweight-charts`                                            |

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

| Script                 | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `npm start`            | Run server + Vite dev concurrently                  |
| `npm run dev`          | Vite dev only (`:8000`)                             |
| `npm run server`       | Server only (`:3000`)                               |
| `npm run build`        | Type-check + production build to `dist/`            |
| `npm run preview`      | Preview the production build                        |
| `npm run typecheck`    | TypeScript check, no emit                           |
| `npm run lint`         | ESLint                                              |
| `npm run lint:fix`     | ESLint with autofix                                 |
| `npm run format`       | Prettier write                                      |
| `npm run format:check` | Prettier check (CI-friendly)                        |
| `npm test`             | Run the Vitest suite once                           |
| `npm run test:watch`   | Vitest in watch mode                                |

---

## Architecture at a glance

```
Browser (React SPA)
   │  HTTP  /auth/*  /api/*  /paper/*        WebSocket  /ws (JSON)
   ▼
Fastify server (server/index.ts)
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

A deeper, always-current architecture reference lives in
[`../.ai-context/project-overview.md`](../.ai-context/project-overview.md).

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
  backtest/          Backtest engine (engine, dataLayer, analysis, greeks, sweep, walkforward)
  paperDb.ts         All SQLite operations
  marginEngine.ts    Local SPAN margin fallback
_archive/            Historical one-off scripts / backups (git-ignored, safe to delete)
```

---

## Code quality

- **TypeScript strict mode** is on.
- **ESLint** (flat config) + **Prettier** enforce correctness and formatting.
- **Vitest** covers the pure money-math modules (greeks, backtest metrics, margin, GEX payoff).

Run `npm run lint && npm run typecheck && npm test` before committing.
