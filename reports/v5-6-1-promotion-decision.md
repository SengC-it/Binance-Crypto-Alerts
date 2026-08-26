# V5.6.1 Evidence Correctness + Multi-Edge Email Ensemble — Promotion Decision

Research baseline: `c94ad43ab7477a9c4d770ea234137425c174821f`; Production baseline: `a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d`
Control A manifest: DATA_UNAVAILABLE; exact replay is not claimed when unavailable.
PIT: CONSERVATIVE_MONTHLY; external validation: DATA_UNAVAILABLE (No complete local immutable cache covers the frozen external interval; no returns were fabricated.)
Forward #002: DATA_UNAVAILABLE; No independent Production/Supabase export or credential is available in the research workspace; no fabricated zero-row result was used.

## Evidence semantics
A = development/inner selection. B = nested outer OOS used for the primary promotion estimate. C = external validation, frozen before reading results. The previously reviewed V5.6 holdout is burned and remains diagnostic only.

### LONG
- Best single selected from development/inner data: **V561-LONG-LIQUIDITY-RECLAIM-01**
- Nested outer OOS: 1 trades, NetR -1.0654, AvgR -1.0654, PF 0.0000
- Confidence: raw DATA_UNAVAILABLE, block DATA_UNAVAILABLE, symbol DATA_UNAVAILABLE, fold DATA_UNAVAILABLE, selection-adjusted DATA_UNAVAILABLE, promotion DATA_UNAVAILABLE
- Yield: 0.0110/week, 0.0478/month, active 0.0455, median 1.0000, p95 drought 446.0312, max 446.0312
- Family edge: INDEPENDENT_LONG_LIQUIDITY_RECLAIM=FAIL
- Ensemble: DATA_UNAVAILABLE; 0 canonical signals, NetR 0.0000
- Decision: **SHADOW_ONLY**; gates: finite_preregistered_registry=PASS, exact_production_control_provenance=FAIL, conservative_pit_universe=PASS, local_pit_cache_coverage=FAIL, nested_outer_oos_quality=FAIL, external_validation=FAIL, confidence=FAIL, useful_email_yield=FAIL, independent_family_edge=FAIL, ensemble_marginal_contribution=FAIL, control_comparison=FAIL, no_leakage_or_backfill=PASS, prospective_confirmation=FAIL

### SHORT
- Best single selected from development/inner data: **V561-SHORT-FAILED-BREAKOUT-REVERSAL-01**
- Nested outer OOS: 40 trades, NetR 20.6614, AvgR 0.5165, PF 2.1017
- Confidence: raw 0.0791, block -0.0359, symbol 0.0234, fold -0.4497, selection-adjusted 0.0172, promotion -0.4497
- Yield: 0.4396/week, 1.9113/month, active 0.5000, median 2.0000, p95 drought 51.6667, max 224.0417
- Family edge: FAILED_BREAKOUT_REVERSAL=PASS, BREAKDOWN_RETEST_CONTINUATION_V2=FAIL, VOLATILITY_COMPRESSION_BREAKDOWN=FAIL, TREND_PULLBACK_SHORT_V2=FAIL
- Ensemble: FAILED_BREAKOUT_REVERSAL; 42 canonical signals, NetR 23.9375
- Decision: **SHADOW_ONLY**; gates: finite_preregistered_registry=PASS, exact_production_control_provenance=FAIL, conservative_pit_universe=PASS, local_pit_cache_coverage=FAIL, nested_outer_oos_quality=FAIL, external_validation=FAIL, confidence=FAIL, useful_email_yield=FAIL, independent_family_edge=PASS, ensemble_marginal_contribution=PASS, control_comparison=FAIL, no_leakage_or_backfill=PASS, prospective_confirmation=FAIL

## Business comparison
- Verdict: **INCONCLUSIVE**
- Reason: Exact current Production configuration unavailable; research_defaults and older parity reports are not an exact replay substitute.
- Exact Old Production: DATA_UNAVAILABLE
- V5.5 Control B: DATA_UNAVAILABLE NetR
- Best V5.6.1 single: DATA_UNAVAILABLE NetR
- Best V5.6.1 ensemble: DATA_UNAVAILABLE NetR

## Hard boundary
- Production Email promotion: NO
- Production strategy/env/code change: NO
- V5.5 Forward #002 change: NO
- Supabase migration/write/backfill: NO
- Deployment/merge: NO