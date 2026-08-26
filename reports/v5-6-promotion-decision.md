# V5.6 Profitable Signal Yield Optimization — Promotion Decision

Research baseline: `6033fa1095bfae6f8b2f20c70cbc543221741bc8`
Production baseline/control: `a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d` / `trend-rejection-short-v1`
Forward #002: `v55-fbos02-forward-002` (DATA_UNAVAILABLE; selection use=NOT_USED_FOR_SELECTION)

This is a research-only evaluation. No V5.5 identity, manifest, runtime, Production environment, database schema, or email path was changed.

### LONG
- Final candidate: **V56-LONG-REGIME-ENSEMBLE-01**
- Decision: **SHADOW_ONLY**
- Purged OOS: 6 trades, NetR 1.8078, AvgR 0.3013, PF 1.5418
- Frozen holdout: 1 trades, NetR -1.0993, AvgR -1.0993, PF 0.0000
- Control A OOS: 0 trades, NetR 0.0000, AvgR 0.0000, PF 0.0000
- Cost stress: base 1.8078 NetR; +10bps 0.8684; +15bps 0.3987; one-bar delay 1.8028
- Selection-adjusted LCB95: -1.0993
- Yield: 0.0384 alerts/week
- Gates: finite_preregistered_registry=PASS, point_in_time_universe=FAIL, historical_quality=FAIL, frozen_holdout=FAIL, realistic_cost_base_plus10=PASS, confidence_acceptable=FAIL, materially_beats_control_a=FAIL, risk_acceptable=PASS, yield_useful=FAIL, no_leakage_or_backfill=PASS, historical_runtime_parity=PASS, short_prospective_smoke=FAIL

### SHORT
- Final candidate: **V5.5-CONTROL-SHORT-FAILED_BREAKOUT_SHORT-02**
- Decision: **SHADOW_ONLY**
- Purged OOS: 91 trades, NetR 34.4182, AvgR 0.3782, PF 1.7365
- Frozen holdout: 111 trades, NetR 51.8437, AvgR 0.4671, PF 2.0053
- Control A OOS: 533 trades, NetR 122.5867, AvgR 0.2300, PF 1.3801
- Cost stress: base 34.4182 NetR; +10bps 17.3041; +15bps 8.7470; one-bar delay 16.4160
- Selection-adjusted LCB95: -0.1727
- Yield: 0.5817 alerts/week
- Gates: finite_preregistered_registry=PASS, point_in_time_universe=FAIL, historical_quality=FAIL, frozen_holdout=PASS, realistic_cost_base_plus10=PASS, confidence_acceptable=FAIL, materially_beats_control_a=FAIL, risk_acceptable=PASS, yield_useful=FAIL, no_leakage_or_backfill=PASS, historical_runtime_parity=PASS, short_prospective_smoke=FAIL

## Hard boundary
- V5.6 Production Email promotion: **NO**
- Automatic strategy switch/promotion: **NO**
- Production deployment or merge: **NO**
- Supabase migration/write/backfill: **NO**
- V5.5 Forward #002 remains the only prospective evidence source and remains observation-only.