# V5.2 Promotion Decision

## Decision

**NO_PRODUCTION_PROMOTION**

Validation base: d5d2520f3f6307384494501e212bfb4b6ab059b2
Control: trend-rejection-short-v1
PIT universe: **PROXY** / SURVIVOR_BIAS=PROXY (93 cache files available; the frozen 50-symbol membership is not an immutable historical membership export).

The gates below are measured independently for LONG and SHORT. A strategy can only be Production Email eligible if every required gate passes on the same frozen evidence, including 3Y Core, 1Y Broad, purged walk-forward, cost stress and frozen holdout.

## LONG

- Selected research variant: **BREAKOUT_RETEST**
- Status: **SHADOW_ONLY**

| Gate | Result | Evidence |
|---|---|---|
| data_quality | FAIL | PIT_UNIVERSE=PROXY; 1Y Broad coverage 45/50 |
| minimum_sample_size | FAIL | 25 trades; requires >= 100 |
| purged_walk_forward | FAIL | 3Y_CORE: 2/6, 1Y_BROAD: 3/6 positive folds; requires >= 6 folds and >= 4/6 positive per dataset group |
| net_edge | FAIL | netR=-0.6182, avgR=-0.0247, PF=0.9643 |
| lower_confidence_bound | FAIL | LCB95=-0.3615 |
| cost_stress_plus_10bps | FAIL | +10bps netR=-3.6182, avgR=-0.1447 |
| frozen_holdout | FAIL | trades=13, netR=7.1934, PF=2.1427 |
| concentration | PASS | topSymbol=DATA_UNAVAILABLE, topFold=11.5% |
| time_stability | FAIL | positiveMonths=41.7% |
| control_comparison | FAIL | control unavailable |
| regime_conditional | FAIL | BULL: 25 trades, avgR=-0.0247 |

## SHORT

- Selected research variant: **TREND_REJECTION**
- Status: **SHADOW_ONLY**

| Gate | Result | Evidence |
|---|---|---|
| data_quality | FAIL | PIT_UNIVERSE=PROXY; 1Y Broad coverage 45/50 |
| minimum_sample_size | FAIL | 30 trades; requires >= 100 |
| purged_walk_forward | FAIL | 3Y_CORE: 2/6, 1Y_BROAD: 1/6 positive folds; requires >= 6 folds and >= 4/6 positive per dataset group |
| net_edge | FAIL | netR=-9.2038, avgR=-0.3068, PF=0.5965 |
| lower_confidence_bound | FAIL | LCB95=-0.8614 |
| cost_stress_plus_10bps | FAIL | +10bps netR=-12.7752, avgR=-0.4258 |
| frozen_holdout | FAIL | trades=12, netR=-4.1194, PF=0.5835 |
| concentration | PASS | topSymbol=DATA_UNAVAILABLE, topFold=21.1% |
| time_stability | FAIL | positiveMonths=21.4% |
| control_comparison | FAIL | candidate netR=-9.2038 vs control -9.2038; DD=15.8816 vs 15.8816 |
| regime_conditional | FAIL | BEAR: 30 trades, avgR=-0.3068 |

## Guardrails

- Production strategy remains trend-rejection-short-v1.
- No Production Email enablement or strategy switch is performed by this validation.
- No Binance private API, order, position, or account action is used.
- No Supabase migration or database mutation is performed.
- PR #1 remains Research / Draft and is not merged or promoted.
- Shadow supporting evidence is DATA_UNAVAILABLE because the read-only query returned zero settled rows; see reports/v5-2-shadow-supporting-evidence.json.
- The 12-trade control sample is evidence of current degradation, not a permanent symbol blacklist.

Dataset groups: 3Y_CORE=24/24, 1Y_BROAD=45/50.
