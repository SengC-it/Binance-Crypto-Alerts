# V5.3 Structural Edge Reconstruction — Promotion Decision

Production baseline: `d5d2520f3f6307384494501e212bfb4b6ab059b2`
V5.2 checkpoint: `9b69efa2299157d1bf5cd334cc697d75a5af6203`

This is a research-only decision. The V5.2 conclusions remain frozen and no Production promotion is authorized.

### LONG
- Selected structural candidate: `LONG-TREND_PULLBACK_LONG-03`
- Status: **SHADOW_ONLY**
- Nested selection procedure OOS (inner selection → outer validation): 40 trades, AvgR -0.2385, PF 0.6745, NetR -9.5389
- Fixed final candidate OOS (Promotion basis): 57 unique trades, AvgR -0.2768, PF 0.6295, NetR -15.7798
- Fixed candidate dataset groups: 3Y_CORE=44 trades/-0.2147 AvgR/0.7015 PF/-9.4450 NetR; 1Y_BROAD=16 trades/-0.4494 AvgR/0.4571 PF/-7.1911 NetR
- Fixed candidate naive LCB95: -0.5450; selection-adjusted LCB95: -0.7526
- Frozen holdout: 7 trades, AvgR -1.0997, PF 0.0000
- +10bps: NetR -24.6856, AvgR -0.4331; +15bps: NetR -29.1385, AvgR -0.5112
- Delay stress: NetR -26.6412, AvgR -0.4844; remove top 3: -20.4415 NetR
- Positive months: 33.3%; MaxDDR: 17.2102; EquityDD: 8.61%
- Gates: data_quality=FAIL, minimum_sample_size=FAIL, purged_walk_forward=FAIL, net_edge=FAIL, lower_confidence_bound=FAIL, cost_stress_plus_10bps=FAIL, frozen_holdout=FAIL, concentration=PASS, time_stability=FAIL, control_comparison=FAIL, regime_conditional=FAIL, naive_lcb_reported=PASS, selection_adjusted_lcb=FAIL, cost_stress_plus_15bps=FAIL, delayed_entry=FAIL, remove_top_3_trades=FAIL, parameter_perturbation=FAIL

### SHORT
- Selected structural candidate: `SHORT-FAILED_BREAKOUT_SHORT-02`
- Status: **SHADOW_ONLY**
- Nested selection procedure OOS (inner selection → outer validation): 177 trades, AvgR 0.1454, PF 1.2460, NetR 25.7357
- Fixed final candidate OOS (Promotion basis): 133 unique trades, AvgR 0.2513, PF 1.4493, NetR 33.4293
- Fixed candidate dataset groups: 3Y_CORE=96 trades/0.2637 AvgR/1.4676 PF/25.3194 NetR; 1Y_BROAD=63 trades/0.5562 AvgR/2.2953 PF/35.0384 NetR
- Fixed candidate naive LCB95: -0.0289; selection-adjusted LCB95: -0.2604
- Frozen holdout: 37 trades, AvgR 0.2024, PF 1.3616
- +10bps: NetR 9.6248, AvgR 0.0724; +15bps: NetR -2.2774, AvgR -0.0171
- Delay stress: NetR 21.7308, AvgR 0.1711; remove top 3: 28.0761 NetR
- Positive months: 66.7%; MaxDDR: 12.5449; EquityDD: 6.27%
- Gates: data_quality=FAIL, minimum_sample_size=PASS, purged_walk_forward=PASS, net_edge=PASS, lower_confidence_bound=FAIL, cost_stress_plus_10bps=PASS, frozen_holdout=PASS, concentration=PASS, time_stability=PASS, control_comparison=FAIL, regime_conditional=PASS, naive_lcb_reported=PASS, selection_adjusted_lcb=FAIL, cost_stress_plus_15bps=FAIL, delayed_entry=PASS, remove_top_3_trades=PASS, parameter_perturbation=PASS

## Hard boundary
- Production Email enablement: NO
- Strategy switch or automatic promotion: NO
- Supabase migration/write: NO
- Production deployment or merge: NO
- 1Y Broad PIT membership: PROXY; this hard-fails promotion until immutable membership history exists.