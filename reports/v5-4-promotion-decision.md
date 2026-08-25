# V5.4 Promotion Decision

This is a research-only decision. V5.3 parameters remain frozen and no Production promotion is authorized.

- PIT universe: **INCOMPLETE**
- Candidate: **SHORT-FAILED_BREAKOUT_SHORT-02**
- Promotion status: **SHADOW_ONLY**

- OOS: 133 trades, AvgR 0.2513, PF 1.4493, NetR 33.4293
- promotion_lcb95: -0.2604
- Holdout: 34 trades, AvgR 0.1554, PF 1.2704, NetR 5.2842
- +10bps: 9.6248 NetR
- +15bps: -2.2774 NetR
- Delay: 0.1711 AvgR / 21.7308 NetR
- Remove top3: 28.0761 NetR

## Gates
| Gate | Result | Evidence |
|---|---|---|
| data_quality | FAIL | PIT_UNIVERSE=INCOMPLETE; exact historical listing/delisting and contract status evidence is unavailable. |
| minimum_sample_size | PASS | 133 trades; requires >= 100 |
| purged_walk_forward | PASS | 3Y_CORE: 4/6, 1Y_BROAD: 4/6 positive folds; requires >= 6 folds and >= 4/6 positive per dataset group |
| net_edge | PASS | netR=33.4293, avgR=0.2513, PF=1.4493 |
| lower_confidence_bound | FAIL | LCB95=-0.2604 |
| cost_stress_plus_10bps | PASS | +10bps netR=9.6248, avgR=0.0724 |
| frozen_holdout | PASS | trades=34, netR=5.2842, PF=1.2704 |
| concentration | PASS | topSymbol=9.3%, topFold=25.0% |
| time_stability | PASS | positiveMonths=66.7% |
| control_comparison | FAIL | FAIL / DATA_UNAVAILABLE: No immutable Production control trade export was added by this research-only PR. |
| regime_conditional | PASS | BULL: 67 trades, avgR=0.3178; RANGE: 66 trades, avgR=0.1839 |
| naive_lcb_reported | PASS | naive bootstrap LCB95=0.0169 |
| selection_adjusted_lcb | FAIL | selection-adjusted LCB95=-0.2604 |
| cost_stress_plus_15bps | FAIL | +15bps netR=-2.2774, avgR=-0.0171 |
| delayed_entry | PASS | next-15m netR=21.7308, avgR=0.1711 |
| remove_top_3_trades | PASS | remove-top-3 netR=28.0761 |
| parameter_perturbation | PASS | -20%=PASS, -10%=PASS, +10%=PASS, +20%=PASS |
| promotion_lcb95 | FAIL | conservative promotion_lcb95=-0.2604 |

SHORT: **SHADOW_ONLY**
LONG: **SHADOW_ONLY (not optimized in V5.4)**
