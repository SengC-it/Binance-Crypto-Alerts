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
- Yield: 0.0460 alerts/week (0.1998/month)
- Gates: finite_preregistered_registry=PASS, point_in_time_universe=FAIL, historical_quality=FAIL, frozen_holdout=FAIL, realistic_cost_base_plus10=PASS, confidence_acceptable=FAIL, materially_beats_control_a=FAIL, risk_acceptable=PASS, yield_useful=FAIL, no_leakage_or_backfill=PASS, historical_runtime_parity=PASS, short_prospective_smoke=PASS

### SHORT
- Final candidate: **V56-SHORT-FAILED_BREAKOUT-BALANCED-125**
- Decision: **SHADOW_ONLY**
- Purged OOS: 108 trades, NetR 34.6877, AvgR 0.3212, PF 1.5979
- Frozen holdout: 147 trades, NetR 67.6274, AvgR 0.4601, PF 1.9749
- Control A OOS: 533 trades, NetR 122.5867, AvgR 0.2300, PF 1.3801
- Cost stress: base 34.6877 NetR; +10bps 13.6827; +15bps 3.1803; one-bar delay 8.4649
- Selection-adjusted LCB95: -0.1658
- Yield: 0.8271 alerts/week (3.5966/month)
- Gates: finite_preregistered_registry=PASS, point_in_time_universe=FAIL, historical_quality=PASS, frozen_holdout=PASS, realistic_cost_base_plus10=PASS, confidence_acceptable=FAIL, materially_beats_control_a=FAIL, risk_acceptable=PASS, yield_useful=PASS, no_leakage_or_backfill=PASS, historical_runtime_parity=PASS, short_prospective_smoke=PASS

## Old Production comparison (SHORT; same OOS window/universe/cost/next-open reference)
- Old Production: NetR 122.5867, AvgR 0.23, PF 1.3801, alerts/week 4.0821
- V5.5 Control B: NetR 34.4182, AvgR 0.3782, PF 1.7365, alerts/week 0.6969
- V5.6 selected: NetR 34.6877, AvgR 0.3212, PF 1.5979, alerts/week 0.8271
- Relaxed-only audit vs V5.5 Control B (descriptive canonical-key overlap): OOS 17 trades, NetR 0.2695; holdout 36 trades, NetR 15.7837
- Historical profitability verdict versus Old Production: **NO**

## Hard boundary
- V5.6 Production Email promotion: **NO**
- Automatic strategy switch/promotion: **NO**
- Production deployment or merge: **NO**
- Supabase migration/write/backfill: **NO**
- V5.5 Forward #002 remains the only prospective evidence source and remains observation-only; its future returns are not used for V5.6 selection.
- The former 50-settled-trades/30-calendar-days rule is not an Email Promotion hard gate in V5.6; implementation parity and prospective smoke remain required.