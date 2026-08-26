# V5.6 Profitable Signal Yield Optimization — Executive Summary

## Scope
A finite, preregistered research registry evaluates failed-breakout balance, wick rejection, breakdown continuation, regime ensembles, and an independent LONG hypothesis. Historical signals use only closed 15m candles; execution is the next 15m candle open.

## Results
LONG: candidate=V56-LONG-REGIME-ENSEMBLE-01; purged OOS=6 trades, AvgR=0.3013, PF=1.5418, NetR=1.8078; holdout=1 trades; decision=SHADOW_ONLY.
SHORT: candidate=V56-SHORT-FAILED_BREAKOUT-BALANCED-125; purged OOS=108 trades, AvgR=0.3212, PF=1.5979, NetR=34.6877; holdout=147 trades; decision=SHADOW_ONLY.
Forward #002 evidence: DATA_UNAVAILABLE; feature snapshots=DATA_UNAVAILABLE, settled trades=DATA_UNAVAILABLE, calendar days=DATA_UNAVAILABLE.

## Evidence limits
- The point-in-time universe manifest is INCOMPLETE, so survivor-bias risk remains a hard Promotion failure.
- Candidate selection is finite and selection-adjusted confidence is reported across the full registry.
- Frozen holdout is isolated and evaluated only after candidate selection; it is never used to tune parameters.
- Forward #002 is read-only diagnostic evidence and is not used to select, tune, or promote a candidate.

## Decision
V5.6 remains research-only / SHADOW_ONLY. Production remains `trend-rejection-short-v1`; no Production Email promotion, strategy switch, migration, deployment, or merge is authorized by this PR.