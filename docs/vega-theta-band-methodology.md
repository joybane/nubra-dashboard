# Vega/Theta Band methodology

The shared indicator hook routes its default `mine + floating + session + chained` Vega and Theta
lines through `ReferenceBandMachine`. Chart, Tracker, Nubra Backtest, and Strategy Analysis all use
that same hook.

For each contract, membership is `0.05 <= abs(delta) <= 0.60`, inclusive. A delta whose absolute
value exceeds one is divided by 100. CE and PE have independent state, and Vega and Theta have
independent entry maps while sharing the same membership event.

On entry, the available Greek becomes that contract's baseline. Its contribution is then
`current - entry`. Leaving the band or losing a known delta deletes both baselines. Re-entry creates
new baselines. Missing Greek values are not zero and produce a gap when an entire side has no finite
contributors.

Historical processing uses one dated expiry and one-minute vendor `l1bid`, `l1ask`, `delta`,
`vega`, and `theta`. At each spot minute it carries every field independently to the latest value at
or before that minute. It evaluates the strike nearest spot on the first accepted bar, then the
strike nearest the previous synthetic forward, plus two adjacent strikes on either side. A
candidate needs CE and PE and positive combined bid and ask. The cheapest straddle wins and
supplies:

```text
CE_mid = (CE_bid + CE_ask) / 2
PE_mid = (PE_bid + PE_ask) / 2
F      = strike + CE_mid - PE_mid
```

If no candidate qualifies, the bar is skipped before entry maps are changed.

Live packets are ingested before visible points are coalesced to seconds. While history loads or
refreshes they are buffered, then replayed after history through a fresh machine. Live book gating
is enabled only when real bid/ask fields exist in the packet.
