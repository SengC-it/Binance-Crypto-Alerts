# V5.3 Production Backtest Parity Audit

Generated: 2026-08-24T15:20:51.667Z
Source: `public.bca_paper_trades`
Strategy: `trend-rejection-short-v1`
Verdict: **FAIL**
Failure classification: **MODEL_PARITY_FAILURE**
Historical control reliable: **NO**

## Read-only extraction
- Data source: immutable_read_only_export
- Settled prospective rows: 13
- Query timestamp: 2026-08-24T15:20:51.667Z
- Extraction query: `SELECT id,symbol,side,strategy_family,strategy_version,entry_time,entry_price,entry_fill_price,stop_price,take_profit_price,max_hold_until,quantity,theoretical_risk_usdt,exit_time,exit_price,exit_reason,r_multiple,net_pnl_usdt,fees_usdt,funding_usdt,slippage_usdt,metadata FROM public.bca_paper_trades WHERE strategy_version = 'trend-rejection-short-v1' AND exit_time IS NOT NULL ORDER BY entry_time ASC`
- Query error: Production paper trade query failed: Invalid API key
- Prospective metrics: 13 trades, AvgR -0.6195, PF 0.3082, NetR -8.0540

## Replay classification
- MATCH: 0
- PARTIAL_MATCH: 11
- MISMATCH: 2
- DATA_UNAVAILABLE: 0
- 89dbe5df-0312-4236-b622-757251ab47d2 / DOLOUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- f4886ad4-0a98-4a68-9820-0519c161fe1b / HEIUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- b07b708e-1d3e-46cc-a91b-f27575e8526f / TUTUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 18b6e209-b80e-4724-a864-5a9cd07ee32a / BLESSUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- a60bf76b-c13d-441f-b182-2d164413fe37 / LABUSDT: **MISMATCH** — stop_price: actual=0.0792, replay=0.07916; take_profit_price: actual=0.0744, replay=0.07449; theoretical_risk_usdt: actual=41.2368, replay=40.205879999999794; exit_price: actual=0.07921584, replay=0.07917583199999999; fees_usdt: actual=1.61648586, replay=1.6160734084704; net_pnl_usdt: actual=-43.66152714, replay=-42.62998850447015; r_multiple: actual=-1.05880008, replay=-1.060292387692307; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 9cdf90ed-686d-4773-8c0d-608a0b379dca / HOMEUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- c783bdeb-cfc6-4b88-aa78-911b5b8fe9b1 / HOMEUSDT: **MISMATCH** — No current Production candidate passed signal, score, side, family, regime, and entry-timing admission at the exact timestamp.; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 79da8d92-034f-48e0-a89e-a8d2a8863bb4 / BICOUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 24aa3446-8e18-46a3-85ed-67f85b853680 / HEIUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 366ea9c8-8c32-452d-913a-709c2d331f95 / APRUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 27a3e161-0b02-4ed3-b54c-3b3cb6e643bd / GRVTUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 78ea99f6-2a93-4e34-b900-98f4b43d0194 / LABUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row
- 16026485-b3f6-4236-97e1-8db899592812 / TACUSDT: **PARTIAL_MATCH**; DATA_UNAVAILABLE: Production paper row does not persist the admitted candidate score; Production paper row does not persist the admitted market regime; global claimSignal cooldown/cap context is not reconstructable from a single paper row

## Control configuration parity
- Status: **PASS**
- Checked: strategyVersion, entryMode, scoreThreshold, stopAtrMultiplier, rewardRisk, sideFilter, strategyFamily, regimeAlignment, cooldownHours, maxHoldHours, entryIntervalHours, maxConcurrentPositions, maxPositionNotionalUsdt, riskPerTradeUsdt, perSignalRiskCapUsdt, dailyRiskBudgetUsdt, takerFeeRate, slippageBps, maxExecutionCostRiskFraction, universeTopSymbols, scanTimeframes, entryReference, closedCandleHandling
- Mismatches: none
- Unavailable: none

## Boundary
- Read-only query only; no database write or migration.
- No strategy tuning, candidate addition, Production Email enablement, merge, or deployment.