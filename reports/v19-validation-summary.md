# V19 Result Validation Summary

- Experiment: `V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP`
- Freeze commit: `f10df65620a630add002d0aaf3c0dff4d8f23c83`
- Freeze manifestBodySha256: `cf84b3e141b8709cf5dbe254a0767edc110cb48741b5c777d574b60506337e94`
- Frozen event identities: `5855`; frozen BTC-shock clusters: `2872`.
- Historical returns read: **true**, exactly once from frozen event identities.
- Parameter search: **false**.

## Primary OOS

- Trades: 3887; clusters: 1902; net: -4.767595118969587; average net: -0.0012265487828581393; PF: 0.6810607745078957; cluster bootstrap LCB95 is recorded in `v19-confidence.json`.
- Outcome data unavailable: 0.

## Holdouts

- Holdout A net: -0.46208003425966265
- Holdout B net: -0.5999847924056042

## Decision

- Classification: **V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP_REJECTED**
- Promotion: **FAIL**
- Research stop: **YES**
- Production Email remains **OFF**; no deploy, merge, migration, private API, order placement, or auto trading.
