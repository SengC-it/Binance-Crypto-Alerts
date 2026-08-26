# V5.8 Regime Dependency Reconstruction — Promotion Decision

Manifest: **v58-regime-dependency-reconstruction-01**; all manifests and the eight-gate registry were frozen before fresh return data was read.
Primary: **V561-SHORT-FAILED-BREAKOUT-REVERSAL-01** / FAILED_BREAKOUT_REVERSAL; parameter change: NO.
Development ungated: {"trades":79,"wins":37,"losses":42,"netR":16.1516,"avgR":0.2045,"profitFactor":1.3528,"maxDrawdownR":12.5069,"cvar95":-1.2084,"stopRate":0.5316,"positivePeriods":14,"periods":24,"positivePeriodRatio":0.5833,"totalNetPnlUsdt":807.5795,"totalFeesUsdt":241.8156,"totalFundingUsdt":2.2833,"totalSlippageUsdt":120.9079}.
BURNED_EXTERNAL diagnostic (not fresh validation): {"trades":73,"wins":29,"losses":44,"netR":2.4339,"avgR":0.0333,"profitFactor":1.051,"maxDrawdownR":11.6297,"cvar95":-1.2153,"stopRate":0.6027,"positivePeriods":8,"periods":22,"positivePeriodRatio":0.3636,"totalNetPnlUsdt":121.6957,"totalFeesUsdt":204.1205,"totalFundingUsdt":17.8765,"totalSlippageUsdt":102.0603}.

## Regime-gated Primary
- Selected gate for fresh validation: **V58-GATE-BREADTH-NOT-EXTREME**.
- Nested OOS: {"trades":22,"wins":6,"losses":16,"netR":-7.2095,"avgR":-0.3277,"profitFactor":0.5899,"maxDrawdownR":10.555,"cvar95":-1.2313,"stopRate":0.7273,"positivePeriods":2,"periods":10,"positivePeriodRatio":0.2,"totalNetPnlUsdt":-360.4774,"totalFeesUsdt":71.908,"totalFundingUsdt":7.3845,"totalSlippageUsdt":35.954}; folds: [{"fold":"fold-1","trades":9,"netR":1.5767,"avgR":0.1752,"profitFactor":1.2983,"positive":true,"selectedGate":"V58-GATE-ATR-MID-RANGE"},{"fold":"fold-2","trades":7,"netR":-5.241,"avgR":-0.7487,"profitFactor":0.2523,"positive":false,"selectedGate":"V58-GATE-ATR-MID-RANGE"},{"fold":"fold-3","trades":0,"netR":0,"avgR":0,"profitFactor":0,"positive":false,"selectedGate":"V58-GATE-BREADTH-NOT-EXTREME"},{"fold":"fold-4","trades":3,"netR":-3.1597,"avgR":-1.0532,"profitFactor":0,"positive":false,"selectedGate":"V58-GATE-BREADTH-NOT-EXTREME"},{"fold":"fold-5","trades":1,"netR":1.7385,"avgR":1.7385,"profitFactor":null,"positive":true,"selectedGate":"V58-GATE-BREADTH-NOT-EXTREME"},{"fold":"fold-6","trades":2,"netR":-2.1241,"avgR":-1.0621,"profitFactor":0,"positive":false,"selectedGate":"V58-GATE-BREADTH-NOT-EXTREME"}].
- Promotion checks: {"nestedTrades":false,"netR":false,"avgR":false,"profitFactor":false,"positiveFoldRatio":false,"medianFoldNetR":false,"plus10BpsNetR":false,"selectionAdjustedLcb95":false,"promotionLcb95":false}; status: **FAIL**.

## Fresh validation
- Status: **INCONCLUSIVE**; source: Binance USDT-M Futures Data Vision; period: {"start":"2020-01-01T00:00:00.000Z","end":"2020-12-31T23:59:59.999Z"}.
- Metrics: {"trades":0,"wins":0,"losses":0,"netR":0,"avgR":0,"profitFactor":0,"maxDrawdownR":0,"cvar95":null,"stopRate":null,"positivePeriods":0,"periods":0,"positivePeriodRatio":null,"totalNetPnlUsdt":0,"totalFeesUsdt":0,"totalFundingUsdt":0,"totalSlippageUsdt":0}.

## Decision
- Business verdict: **INCONCLUSIVE**; Email Promotion: **FAIL**.
- Exact current Production replay: DATA_UNAVAILABLE; no replacement or email eligibility is authorized.

## Hard boundary
- Production change: NO
- V5.5 #002 change: NO
- Strategy tuning/manifest change: NO
- Supabase migration: NO
- Deploy: NO
- Merge: NO
- Auto trading: NO
