# V5.3 Structural Edge Reconstruction — Executive Summary

## What was tested
Six preregistered structural families (three LONG, three SHORT), three finite variants per family, 3Y Core and 1Y Broad proxy data, six purged outer folds, inner-fold stability selection, frozen holdout, block bootstrap and selection-adjusted confidence.

## Findings
1. LONG best structural family: TREND_PULLBACK_LONG; nested selection OOS 40 trades, AvgR -0.2385, PF 0.6745; fixed candidate OOS 57 unique trades, AvgR -0.2768, PF 0.6295.
2. SHORT best structural family: FAILED_BREAKOUT_SHORT; nested selection OOS 177 trades, AvgR 0.1454, PF 1.2460; fixed candidate OOS 133 unique trades, AvgR 0.2513, PF 1.4493.
3. All registered candidates, including zero-trade and failed candidates, are retained in the candidate reports.
4. Entry extension, stop style, delay and cost stress are reported; selected LONG delay AvgR -0.4844, selected SHORT delay AvgR 0.1711.
5. Concentration and true reference-equity drawdown are reported by direction; no symbol is blacklisted from these research results.
6. No direction is eligible for Production Email unless every unchanged V5.2 hard gate and every V5.3 robustness gate passes; PIT_UNIVERSE=PROXY remains a hard failure.

## Rejected or unavailable
- LONG rejected/failed candidates: LONG-BREAKOUT_RETEST_V2-01, LONG-BREAKOUT_RETEST_V2-02, LONG-BREAKOUT_RETEST_V2-03, LONG-TREND_PULLBACK_LONG-02, LONG-TREND_PULLBACK_LONG-03, LONG-VOLATILITY_EXPANSION_LONG-01, LONG-VOLATILITY_EXPANSION_LONG-02, LONG-VOLATILITY_EXPANSION_LONG-03
- SHORT rejected/failed candidates: SHORT-BREAKDOWN_RETEST_SHORT-01, SHORT-BREAKDOWN_RETEST_SHORT-02, SHORT-BREAKDOWN_RETEST_SHORT-03, SHORT-TREND_PULLBACK_SHORT-01, SHORT-TREND_PULLBACK_SHORT-02, SHORT-TREND_PULLBACK_SHORT-03
- DATA_UNAVAILABLE: true point-in-time universe membership; prospective feature telemetry; any historical field absent from the immutable cache.

## Decision
LONG: **SHADOW_ONLY**
SHORT: **SHADOW_ONLY**
Production remains on trend-rejection-short-v1. This PR contains no production code path, database write, migration, deployment, or strategy change.