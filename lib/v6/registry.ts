import type { V6Configuration, V6Family, V6RiskTemplate } from "@/lib/v6/types";

export const V6_BASELINE_COMMIT = "4925d1b819770149a98c7014ef984fd1dba1a89c";
export const V6_DEV_START = Date.parse("2020-01-01T00:00:00.000Z");
export const V6_DEV_END = Date.parse("2026-07-31T23:59:59.999Z");
export const V6_PURGE_HOURS = 72;
export const V6_FEE_RATE = 0.0004;
export const V6_BASE_SLIPPAGE_BPS = 2;
export const V6_RISK_PER_TRADE_USDT = 50;
export const V6_BAR_MS = 4 * 60 * 60 * 1_000;

/**
 * These are the only signal configurations registered for the V6 bake-off.
 * Risk templates are fixed exit identities applied without a TP/SL grid search.
 */
export const V6_CONFIGURATIONS: readonly V6Configuration[] = [
  { id: "V6-A-TS-20-10", family: "TIME_SERIES_TREND", side: "BOTH", description: "20-bar Donchian breakout, 10-bar trend exit", breakoutLookback: 20, exitLookback: 10 },
  { id: "V6-A-TS-20-20", family: "TIME_SERIES_TREND", side: "BOTH", description: "20-bar Donchian breakout, 20-bar trend exit", breakoutLookback: 20, exitLookback: 20 },
  { id: "V6-A-TS-40-10", family: "TIME_SERIES_TREND", side: "BOTH", description: "40-bar Donchian breakout, 10-bar trend exit", breakoutLookback: 40, exitLookback: 10 },
  { id: "V6-A-TS-40-20", family: "TIME_SERIES_TREND", side: "BOTH", description: "40-bar Donchian breakout, 20-bar trend exit", breakoutLookback: 40, exitLookback: 20 },
  { id: "V6-A-TS-60-10", family: "TIME_SERIES_TREND", side: "BOTH", description: "60-bar Donchian breakout, 10-bar trend exit", breakoutLookback: 60, exitLookback: 10 },
  { id: "V6-A-TS-60-20", family: "TIME_SERIES_TREND", side: "BOTH", description: "60-bar Donchian breakout, 20-bar trend exit", breakoutLookback: 60, exitLookback: 20 },
  { id: "V6-B-CSM-5", family: "CROSS_SECTIONAL_MOMENTUM", side: "BOTH", description: "Top/bottom 5% by 7d, 30d and volatility-adjusted momentum", rankFraction: 0.05 },
  { id: "V6-B-CSM-10", family: "CROSS_SECTIONAL_MOMENTUM", side: "BOTH", description: "Top/bottom 10% by 7d, 30d and volatility-adjusted momentum", rankFraction: 0.1 },
  { id: "V6-B-CSM-20", family: "CROSS_SECTIONAL_MOMENTUM", side: "BOTH", description: "Top/bottom 20% by 7d, 30d and volatility-adjusted momentum", rankFraction: 0.2 },
  { id: "V6-C-CARRY-AVOID", family: "TREND_CARRY", side: "BOTH", description: "40-bar trend breakout with extreme-crowding avoidance", breakoutLookback: 40, exitLookback: 20, fundingRule: "AVOID_EXTREME_CROWDING" },
  { id: "V6-C-CARRY-PREFERENCE", family: "TREND_CARRY", side: "BOTH", description: "40-bar trend breakout with carry preference", breakoutLookback: 40, exitLookback: 20, fundingRule: "CARRY_PREFERENCE" },
  { id: "V6-C-CARRY-NEUTRAL", family: "TREND_CARRY", side: "BOTH", description: "40-bar trend breakout with neutral-crowding filter", breakoutLookback: 40, exitLookback: 20, fundingRule: "NEUTRAL_CROWDING" },
] as const;

export const V6_RISK_TEMPLATES: readonly V6RiskTemplate[] = [
  { id: "V6-RISK-ATR-1.5R", description: "ATR stop with fixed 1.5R target", stopAtrMultiplier: 1.5, rewardRisk: 1.5, maxHoldBars: 18 },
  { id: "V6-RISK-TRAIL-2.0R", description: "ATR stop with trailing trend exit and 2R target cap", stopAtrMultiplier: 1.5, rewardRisk: 2, maxHoldBars: 30, trailingAtrMultiplier: 2 },
  { id: "V6-RISK-TIME-1.0R", description: "ATR stop with fixed 1R target and short time stop", stopAtrMultiplier: 1.5, rewardRisk: 1, maxHoldBars: 10 },
] as const;

export const V6_FAMILIES: readonly V6Family[] = ["TIME_SERIES_TREND", "CROSS_SECTIONAL_MOMENTUM", "TREND_CARRY"];

export const V6_RESEARCH_RULES = {
  configurationBudget: "12 signal configurations; <=24 preregistered configurations",
  timeframes: "4h primary; 1d context may be derived from closed 4h bars; no 15m alpha",
  execution: "closed 4h signal candle followed by the next contiguous 4h open; no same-bar execution",
  costs: "taker fee 4bps, base slippage 2bps, stress totals 5/10/15bps, funding from historical funding points",
  development: "all previously observed data is Development Pool; nested purged walk-forward with 72h embargo",
  selection: "Pareto frontier across profitability, risk, robustness, yield, and breadth; never highest NetR alone",
  validationA: ">=50 trades, >=10 symbols, NetR>0, AvgR>0, PF>=1.20, +10bps NetR>0",
  validationB: ">=30 trades, NetR>0, AvgR>0, PF>1.10",
  yield: "alerts/month>=4, preferred 1-5/week, activeMonthRatio>=0.70, median/month>=2, p95 drought<=30d, max<=45d",
  familyGate: "nested trades>=100, NetR>0, AvgR>=0.10R, PF>=1.25, positive folds>=0.67, median fold NetR>0, +10bps>0, promotion LCB>=0, breadth>=15",
  noPromotionWithoutBothValidations: true,
} as const;

export const V6_VALIDATION_A_CANDIDATES = [
  "0GUSDT", "1000FLOKIUSDT", "1000LUNCUSDT", "1000RATSUSDT", "1000SATSUSDT", "1000SHIBUSDT", "1000WHYUSDT", "1000XECUSDT",
  "APEUSDT", "ACHUSDT", "ANKRUSDT", "API3USDT", "ALICEUSDT", "ALPHAUSDT", "ARPAUSDT", "AUDIOUSDT", "AUCTIONUSDT", "AXSUSDT", "BADGERUSDT", "BAKEUSDT", "BALUSDT", "BANDUSDT",
  "BEATUSDT", "BLUAIUSDT", "BTWUSDT", "CYSUSDT", "GWEIUSDT", "MMTUSDT",
] as const;

export const V6_VALIDATION_A_MANIFEST_ID = "v6-binance-usdtm-remaining-symbols-2020-01-01-2026-07-31";
export const V6_VALIDATION_B_MANIFEST_ID = "v6-cross-exchange-transferability-bybit-okx-2020-01-01-2026-07-31";
