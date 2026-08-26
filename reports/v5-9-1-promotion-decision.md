# V5.9.1 Expectancy-Calibrated Meta-Label Validation Decision

Baseline: **25f99797603b3500cd9e44bd6e3154e8d2475a0d**; research-only, no Production/runtime change.
V5.9 zero-signal root cause: **threshold mismatch confirmed = true**.
Nested development: {"trades":14,"wins":1,"losses":13,"winRate":0.0714,"netR":-11.3996,"avgR":-0.8143,"profitFactor":0.1462,"maxDD":11.3996,"cvar95":-1.112,"plus10BpsNetR":-12.3247,"symbolBreadth":8,"positiveSymbolRatio":0.125,"totalNetPnlUsdt":-569.9787,"totalFeesUsdt":18.5018,"totalFundingUsdt":-49.5748,"totalSlippageUsdt":9.2509}; promotion: **FAIL**; calibration: **FAIL**.
New untouched holdout: {"trades":0,"wins":0,"losses":0,"winRate":0,"netR":0,"avgR":0,"profitFactor":0,"maxDD":0,"cvar95":null,"plus10BpsNetR":0,"symbolBreadth":0,"positiveSymbolRatio":null,"totalNetPnlUsdt":0,"totalFeesUsdt":0,"totalFundingUsdt":0,"totalSlippageUsdt":0}; status: **INCONCLUSIVE**.
Three-system comparison: {"ungatedPrimary":{"metrics":{"trades":82,"wins":37,"losses":45,"winRate":0.4512,"netR":12.6599,"avgR":0.1544,"profitFactor":1.2574,"maxDD":19.1866,"cvar95":-1.1895,"plus10BpsNetR":-0.3192,"symbolBreadth":20,"positiveSymbolRatio":0.75,"totalNetPnlUsdt":632.9959,"totalFeesUsdt":259.5832,"totalFundingUsdt":-12.7284,"totalSlippageUsdt":129.7917},"yield":{"calendarDays":1308,"calendarMonths":43,"alertsPerWeek":0.4388379204892966,"alertsPerMonth":1.9069767441860466,"activeMonthRatio":0.6744186046511628,"medianAlertsPerMonth":2,"p95DroughtDays":67.66666666666667,"maxDroughtDays":100.45833333333333}},"v59OldProbabilityRule":{"metrics":{"trades":0,"wins":0,"losses":0,"winRate":0,"netR":0,"avgR":0,"profitFactor":0,"maxDD":0,"cvar95":null,"plus10BpsNetR":0,"symbolBreadth":0,"positiveSymbolRatio":null,"totalNetPnlUsdt":0,"totalFeesUsdt":0,"totalFundingUsdt":0,"totalSlippageUsdt":0},"yield":{"calendarDays":1308,"calendarMonths":43,"alertsPerWeek":0,"alertsPerMonth":0,"activeMonthRatio":0,"medianAlertsPerMonth":0,"p95DroughtDays":1308,"maxDroughtDays":1308},"status":"INCONCLUSIVE","diagnosticOnly":true},"v591EvRule":{"metrics":{"trades":0,"wins":0,"losses":0,"winRate":0,"netR":0,"avgR":0,"profitFactor":0,"maxDD":0,"cvar95":null,"plus10BpsNetR":0,"symbolBreadth":0,"positiveSymbolRatio":null,"totalNetPnlUsdt":0,"totalFeesUsdt":0,"totalFundingUsdt":0,"totalSlippageUsdt":0},"yield":{"calendarDays":1308,"calendarMonths":43,"alertsPerWeek":0,"alertsPerMonth":0,"activeMonthRatio":0,"medianAlertsPerMonth":0,"p95DroughtDays":1308,"maxDroughtDays":1308},"status":"INCONCLUSIVE"},"v591VsPrimary":"INCONCLUSIVE","question":"Does V5.9.1 provide more usable email alerts with positive historical expectancy?"}.
Business verdict: **INCONCLUSIVE**; Email Promotion Candidate: **FAIL**.

## Old holdout boundary
The original V5.9 20-symbol holdout is BURNED_AFTER_ZERO_SIGNAL_REVIEW and POST_HOC_DIAGNOSTIC_ONLY; it is never promotion evidence.

## Hard boundary
- Production: NO change
- V5.5/#002: NO change
- Production email: NO change
- Supabase migration: NO
- Deploy: NO
- Merge: NO
- Auto trading: NO
- Strategy/parameters/manifest: FROZEN
