# Nubra REST API V3 — cheat sheet

Distilled from `nubra-rest-api-v3.md` (vendor export, source set `docs/rest-api-v3/**`,
generated 2026-07-21). **Read this file first.** Only open the full export for exact payload
examples or proto definitions; everything load-bearing is reproduced here.

Older exports on disk, for reference: `~/Downloads/nubra-api-rest-api-llm-builder.md`
(2026-03-18, the pre-V3 `docs/rest-api/**` set) and `v3nubra-...md.txt` (2026-06-18 V3).

---

## Divergences from this repo — read before integrating

- The doc's PROD base is `https://api.nubra.io`. This app's `.env` uses **`api2.nubra.io`**.
  V3 endpoints are documented only against `api.nubra.io` / `uatapi.nubra.io`.
- **`charts/timeseries` serves `iv_bid`, `iv_ask`, `iv_mid` — confirmed live 2026-08-03.**
  The main README used to claim there is "no `iv` field under any name"; that probe tried
  `iv`, `implied_volatility`, `impliedVolatility`, `implied_vol`, `ivPct`, `volatility` but
  never the `iv_*` trio. README and memory corrected.
- **What `iv_*` is, measured (25,436 points, NIFTY 8 DTE):** IVs of the L1 bid / ask / mid,
  decimal units, computed off the **forward** — not off spot, whatever Nubra support says.
  Parity-forward inversion reproduces `iv_mid` to 0.057 vol pts vs 0.757 for spot; their
  implied forward sits 0.4 index points from the parity forward. The option chain's `iv` and
  the timeseries `iv_mid` are **bit-identical** — one vendor volatility, not two. (The
  *parquet* `iv` column in the backtest tree is a separate product and does not match.)
- **`charts/timeseries` rejects >10 symbols per query** — `"maximum 10 values allowed in one
  query"`. Batch wide strike ladders; 60 REST req/min is the ceiling.
- `GET /ipaddress/validate` returns `current_ip_address` vs registered primary/secondary and
  an `is_matched` boolean. This is the direct diagnostic for the dead V3 margin API —
  it says whether the static-IP gate is what's rejecting calls, rather than inferring it.
- Prices are exchange-native integers (paise) throughout, matching this repo's convention.

---

## Auth

Headers on every authenticated call: `Authorization: Bearer <session_token>` +
`x-device-id: <device_id>` (+ `Content-Type: application/json` when sending a body).
Pick a device id at login and reuse it for the whole session.

| # | Call | Headers | Returns |
| - | ---- | ------- | ------- |
| 1 | `POST /sendphoneotp` `{phone, skip_totp:false}` | none | `temp_token` |
| 2 | `POST /sendphoneotp` `{phone, skip_totp:true}` | `x-temp-token` | **new** `temp_token` |
| 3 | `POST /verifyphoneotp` `{phone, otp}` | `x-temp-token` (latest), `x-device-id` | `auth_token` |
| 4 | `POST /verifypin` `{pin}` | `Authorization: Bearer <auth_token>`, `x-device-id`; **no** `x-temp-token` | `session_token` |

Step 2 rotates the token — step 3 must use the newest one. TOTP is an optional second flow:
`GET /totp/generate-secret`, `POST /totp/enable {mpin,totp}`, `POST /totp/login {phone,totp,otp:""}`
(returns `auth_token`, then step 4 as above), `POST /totp/disable {mpin}`.

`GET /userinfo` returns `env_info.market_ws_url` and `env_info.user_ws_url`.

## Errors

Shape is `{"error": "...", "nubra_error_code": ""}` (the code field is reserved, always empty).

- **400** — bad payload, bad enum, bad instrument, price/qty rule violation.
- **440** — session expired/invalid. Re-authenticate; do **not** treat as retriable.
  Also returned by bhavcopy for not-yet-generated, future, or non-trading dates.
- **500** — upstream OMS failure. Retry with exponential backoff.

## Rate limits

Historical REST **60 req/min**. Trading UAT **100 ops/sec**, enforced per IP (documented as a
validation baseline, not a production promise). WebSocket subscriptions are weight-based per
tier; over-weight subscribes are rejected, so unsubscribe to free weight.

---

## Market data

| Call | Notes |
| ---- | ----- |
| `GET refdata/refdata/{YYYY-MM-DD}?exchange=NSE` | Instrument master. `exchange` ∈ NSE/BSE/MCX, default NSE. |
| `GET optionchains/{instrument}/price` | Snapshot: `price`, `prev_close`, `change`. |
| `GET optionchains/{instrument}?exchange=&expiry=` | Full chain. Pass the **underlying** (`asset` field), not the option symbol. |
| `GET orderbooks/{ref_id}?levels=N` | Depth. No `exchange` param — context comes from the `ref_id`. |
| `POST charts/timeseries` | Historical candles. |
| `GET bhavcopy/nse/{date}?format=csv&type={Type}{yyyymmdd}` | Raw CSV. `{date}` and the type's date suffix must match. |

Refdata instrument fields: `ref_id`, `strike_price`, `option_type`, `token`, `stock_name`,
`series`, `zanskar_name`, `lot_size`, `asset`, `expiry` (YYYYMMDD int), `exchange`,
`derivative_type`, `isin`, `asset_type`, `tick_size`, `underlying_prev_close`.

Chain leg fields: `ref_id`, `inst_id`, `ts`, `sp`, `ls`, `ltp`, `ltpchg`, `iv`, `delta`,
`gamma`, `theta`, `vega`, `oi`, `volume`; chain carries `atm`, `cp`, `all_expiries`.

### `charts/timeseries`

Body is `{"query":[{exchange, type, values[], fields[], startDate, endDate, interval, intraDay, realTime}]}`.
`type` ∈ `STOCK`, `INDEX`, `OPT`, `FUT`, `CHAIN`. Intervals `1s,1m,2m,3m,5m,15m,30m,1h,1d,1w,1mth`.

Fields: `open`, `high`, `low`, `close`, `tick_volume`, `cumulative_volume`,
`cumulative_volume_premium`, `cumulative_oi`, `cumulative_call_oi`, `cumulative_put_oi`,
`cumulative_fut_oi`, `l1bid`, `l1ask`, `theta`, `delta`, `gamma`, `vega`,
**`iv_bid`, `iv_ask`, `iv_mid`**, `cumulative_volume_delta`.

Retention: sub-daily intervals → last **3 months**; daily or coarser → up to **10 years** (stocks).
Response nests as `result[].values[].{symbol}.{field}[] = {ts (ns), v}`.

---

## WebSockets

**Market data** — connect to `env_info.market_ws_url` (`/apibatch/ws`). Text commands:

```
batch_subscribe [token] index {"indexes":["NIFTY"]} NSE
batch_subscribe [token] index_bucket {"indexes":["NIFTY"]} 5m NSE
batch_subscribe [token] orderbook {"instruments":[1120031]}
batch_subscribe [token] greeks {"instruments":[1120031]}
batch_subscribe [token] option [{"exchange":"NSE","asset":"NIFTY","expiry":"20260203"}]
```

`batch_unsubscribe` mirrors each. **The JSON must contain no spaces.** Index and instrument
symbols both go in `indexes`; the response splits them into `indexes` / `instruments`.
Option-chain updates arrive one packet per chain, not batched.

Connection-level controls: `socket_interval <channel> <1s|5s|10s|30s|1m|5m|10m>` (second-based
intervals carry subscription limits, minute-based are unlimited; default is tick-level),
`post_market true` (static EOD snapshot for after-hours testing), `orderbook_depth 1..20`
(default 20).

Payloads are protobuf wrapped in `GenericData{key, Any data}`. Messages:
`BatchWebSocketIndexMessage`, `BatchWebSocketIndexBucketMessage`, `BatchWebSocketOrderbookMessage`,
`BatchWebSocketGreeksMessage`, `WebSocketMsgOptionChainUpdate`. Note the `Interval` enum omits
`1s`/`10s`/`30s`/`1yr` for `index_bucket` despite the subscribe string accepting them.

**Order updates** — connect to `env_info.user_ws_url`, then send the text message
`subscribe <session_token> notifications notification`. Binary payloads are an outer `Any`
whose `value` is another `Any`; for V3 the inner `type_url` ends in **`NubraToClientIntentUpdate`**.
`intentOrderResponse.tradeFill` present (with `tradeQty`) ⇒ fill event, absent ⇒ order event.
`Invalid Token` ⇒ re-auth and reconnect.

Proto gotcha: the request-type field is misspelled in the wire format —
`intent_order_requst_type` / `intentOrderRequstType`. Raw decoders must handle that spelling.

---

## Trading (OMS V3 intent orders)

Every request body wraps items in an `orders[]` array, camelCase fields, even for one order.

| Workflow | Endpoint |
| -------- | -------- |
| Place single / multi / strategy | `POST sentinel/orders/create` |
| Modify (single or multi) | `POST sentinel/orders/modify` |
| Cancel | `POST sentinel/orders/cancel` |
| Get orders | `GET sentinel/orders` |
| Margin estimate | `POST sentinel/orders/funds_required` |

Enums: `side` BUY/SELL · `deliveryType` IDAY/CNC · `priceType` LIMIT/MARKET ·
`validityType` DAY/IOC/GTE · `executionMode` ENTRY/ENTRY_AND_EXIT/EXIT.

`intentOrderId` is the identifier for everything downstream — get, modify, cancel, realtime.
A strategy order gets **one** strategy-level id; legs are detail beneath it and have no ids.

### Three placement shapes

- **Single** — `isMultiLeg:false`, top-level `refId`, no `legs`.
- **Multi** — several independent `isMultiLeg:false` items in one `orders[]`. A batch, *not* a
  strategy; each item keeps its own fields and gets its own `intentOrderId`.
- **Strategy** — `isMultiLeg:true`, non-empty `legs[]`, **no top-level `refId`**. Top-level
  `side` must be `BUY` (leg direction is the sign of `legs[].unitQty`), `deliveryType` must be
  `CNC`. `qty` is the common executable base quantity (usually the lot size — 65 for NIFTY);
  `legs[].unitQty` is the signed per-leg lot multiplier. Scale the whole strategy by
  multiplying top-level `qty` (2 units of a 65-lot ⇒ `qty:130`). There is **no** top-level
  `multiplier` field. Entry/exit controls live at the strategy level, never per leg.

### Order controls

`entryConfig.triggers.ltp.{above|below|atOrAbove|atOrBelow}.value`, `entryConfig.entryTime`,
`exitConfig.exitTime`, `exitConfig.stoplossParams.{stoplossTriggerPrice, stoplossLimitPrice,
stoplossTrailJump}`, `exitConfig.targetParams.{targetProfitTriggerPrice, targetProfitLimitPrice}`.
Price wrappers take `{"value": int}` or `{"disabled": true}`.
`icebergInfo` takes `maxQtyPerLeg` **or** `numberOfLegs`, never both.

### Gotchas that cause rejections

- `MARKET` ⇒ omit `entryPrice`, set `validityType:"IOC"`.
- `GTE` ⇒ `deliveryType:"CNC"` + `goodTillDate`. Intraday GTE is rejected outright
  ("Intraday orders cannot have an expiry beyond today"). For F&O, `goodTillDate` must not
  exceed contract expiry; stocks cap at one year. Don't combine GTE with `exitConfig.exitTime`.
- `stratTags` takes **exactly one** tag, hyphen-separated only — no underscores, spaces,
  colons, plus signs, or timestamps.
- Keep `targetProfitTriggerPrice >= targetProfitLimitPrice`.
- Snap limit/trigger prices to the contract `tick_size`.
- Modify: send `orderId` + only changed fields; never resend `legs`, `isMultiLeg`,
  `basketParams`, or (for strategies) top-level `refId`/`side`. Set `executionMode` per item.
- Cancel: `{orderId}` cancels the whole order; add `exitTriggerKind` ∈ `STOPLOSS`,
  `TARGET_PROFIT`, `TRAILING_STOP` to drop just that trigger and leave the order live.

### Response semantics

Create returns **201** with the normalized order (`intentOrderId`, `status`, `intentOrderType`
∈ REGULAR/TRIGGER/ICEBERG/FLEXI, `refData`, `timestamps`). Trigger/timed payloads come back
normalized — a trigger+SL request may return `intentOrderType:"TRIGGER"` with `exitConfig` as
an array. `goodTillDate` and `icebergInfo` may not echo back faithfully.

**Modify and cancel return an acknowledgement only** (`"...request pushed successfully"`). A
200 means accepted, not applied — confirm via `GET sentinel/orders` and compare `orderPrice`,
`status`, `timestamps.lastModifiedAt`.

`GET sentinel/orders` returns orders **bucketed by lifecycle**, not as a flat list:
`open`, `executed`, `cancelled`, `expired`, `rejected`, `gtt` (good-till orders land in `gtt`).
Filters `?intentOrderId=1,2,3` and `?stratTags=a-b,c-d` narrow results but keep the buckets.

### Margin

`POST sentinel/orders/funds_required` — same payload as placement plus top-level
`requestType:"NEW"`. Returns `{code, marginInfo:{totalMargin, message}, brokerageInfo:
{totalChargesFloat}, totalFundsRequired, willDefaultBePlacedAsAmo, willBeAutoSliced}`.
Estimation only; it never places anything.

---

## Portfolio (snapshots — none of these auto-update)

| Call | Returns |
| ---- | ------- |
| `GET /sentinel/portfolio/holdings` | `portfolio.holdingStats` + `holdings[]` (avgPrice, haircut, marginBenefit, pledge fields) |
| `GET /sentinel/portfolio/positions` | `portfolio.positionStats` + flattened `positions[]` (net/buy/sell qty, avg prices, pnl) |
| `GET /sentinel/portfolio/user_funds_and_margin` | `portFundsAndMargin` — SOD funds, collateral, blocked/available margin, MTM splits, brokerage |

Use `funds_required` for pre-trade margin; `user_funds_and_margin` is capital visibility only.
