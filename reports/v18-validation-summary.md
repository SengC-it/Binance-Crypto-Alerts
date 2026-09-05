# V18 Taker-Flow Absorption Reversal — Result Stage

- Freeze commit: c8b8c1e728079ce947e4b2314442a44d04d8ed90
- Freeze manifest body SHA256: 8c7353680ff085625fbbaad932d7064afb431448e759008bb0a809b4fc6c16d8
- Historical returns read: true (exactly the 301 frozen event identities)
- Outcome: next full 5m OPEN entry; close of the candle ending exactly 60 minutes after entry
- Costs: 4bps/side fee + 2bps/side slippage; 12bps baseline round trip; +5/+10/+20bps additive stress
- Parameter search: false; no signal, exit, stop, TP, or loss filtering was changed

## Primary OOS (2022–2024): trades=83, NetR=-0.20423885590005855, AvgR=-0.002460709107229621, PF=0.2568972359542831, MaxDD=0.21926894997158586, unavailable=0
- Bootstrap 95% LCB of mean net return: -0.003826836431827956
- +10bps stress: trades=83, NetR=-0.28723885590005865, AvgR=-0.0034607091072296225, PF=0.1536128061946323, MaxDD=0.299268949971586, unavailable=0
- BTC primary: trades=28, NetR=-0.05745507842974655, AvgR=-0.0020519670867766627, PF=0.24096061769139876, MaxDD=0.06448237925787462, unavailable=0
- ETH primary: trades=55, NetR=-0.14678377747031204, AvgR=-0.0026687959540056734, PF=0.26295450021313344, MaxDD=0.16574300932689506, unavailable=0
- BUY_FLOW_ABSORBED → SHORT: trades=161, NetR=-0.2214966754654462, AvgR=-0.0013757557482325853, PF=0.5073452429880977, MaxDD=0.25737331044518563, unavailable=0
- SELL_FLOW_ABSORBED → LONG: trades=140, NetR=-0.18838722049265266, AvgR=-0.0013456230035189475, PF=0.46633236342917134, MaxDD=0.196649864433064, unavailable=0
- Holdout A (2025): trades=85, NetR=-0.02265144466673237, AvgR=-0.00026648758431449846, PF=0.8608233543282477, MaxDD=0.06114098759254252, unavailable=0
- Holdout B (2026-01..07): trades=133, NetR=-0.18299359539130788, AvgR=-0.0013758916946714878, PF=0.4986527497569499, MaxDD=0.18981851530144525, unavailable=0

## Frozen promotion decision
- Classification: V18_TAKER_FLOW_ABSORPTION_REJECTED
- Promotion candidate: FAIL
- Research stop: YES

## Boundaries
- Production changed: NO
- Production Email: OFF
- Deploy: NO
- Merge: NO
- Migration: NO
- Private Binance API / order placement / auto trading: NO

All detailed metrics, controls, stress cases, yearly partitions, and unavailable outcome identities are in the Result JSON artifacts.
