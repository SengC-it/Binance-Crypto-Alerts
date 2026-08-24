# V5.3 Structural Edge Reconstruction — Promotion Decision

Production baseline: `d5d2520f3f6307384494501e212bfb4b6ab059b2`
V5.2 checkpoint: `9b69efa2299157d1bf5cd334cc697d75a5af6203`

This is a research-only decision. The V5.2 conclusions remain frozen and no Production promotion is authorized.

### LONG
- Selected structural candidate: `LONG-TREND_PULLBACK_LONG-03`
- Status: **SHADOW_ONLY**
- Nested OOS: 41 trades, AvgR -0.2595, PF 0.6501, NetR -10.6383
- Naive LCB95: -0.5824; selection-adjusted LCB95: -1.0793
- Frozen holdout: 7 trades, AvgR -1.0997, PF 0.0000
- +10bps: NetR -17.0789, AvgR -0.4166; +15bps: NetR -20.2993, AvgR -0.4951
- Delay stress: NetR -38.3742, AvgR -0.3997; remove top 3: -15.7008 NetR
- Positive months: 36.4%; MaxDDR: 14.5963; EquityDD: 7.30%
- Gates: data_quality=FAIL, minimum_sample_size=FAIL, purged_walk_forward=FAIL, net_edge=FAIL, lower_confidence_bound=FAIL, cost_stress_plus_10bps=FAIL, frozen_holdout=FAIL, concentration=PASS, time_stability=FAIL, control_comparison=FAIL, regime_conditional=FAIL, naive_lcb_reported=PASS, selection_adjusted_lcb=FAIL, cost_stress_plus_15bps=FAIL, delayed_entry=FAIL, remove_top_3_trades=FAIL, parameter_perturbation=FAIL

### SHORT
- Selected structural candidate: `SHORT-FAILED_BREAKOUT_SHORT-02`
- Status: **SHADOW_ONLY**
- Nested OOS: 177 trades, AvgR 0.1454, PF 1.2460, NetR 25.7357
- Naive LCB95: -0.1188; selection-adjusted LCB95: -0.1510
- Frozen holdout: 50 trades, AvgR 0.2496, PF 1.4584
- +10bps: NetR -6.6056, AvgR -0.0373; +15bps: NetR -22.7763, AvgR -0.1287
- Delay stress: NetR 54.7984, AvgR 0.1839; remove top 3: 20.3825 NetR
- Positive months: 55.6%; MaxDDR: 19.7598; EquityDD: 9.88%
- Gates: data_quality=FAIL, minimum_sample_size=PASS, purged_walk_forward=FAIL, net_edge=PASS, lower_confidence_bound=FAIL, cost_stress_plus_10bps=FAIL, frozen_holdout=PASS, concentration=PASS, time_stability=FAIL, control_comparison=FAIL, regime_conditional=PASS, naive_lcb_reported=PASS, selection_adjusted_lcb=FAIL, cost_stress_plus_15bps=FAIL, delayed_entry=PASS, remove_top_3_trades=PASS, parameter_perturbation=PASS

## Hard boundary
- Production Email enablement: NO
- Strategy switch or automatic promotion: NO
- Supabase migration/write: NO
- Production deployment or merge: NO
- 1Y Broad PIT membership: PROXY; this hard-fails promotion until immutable membership history exists.