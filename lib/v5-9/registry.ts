import type { Side } from "@/lib/core/types";
import type { SignalFeatureFamily } from "@/lib/v5-3/feature-snapshot";
import type { StopStyle, StructuralParameters } from "@/lib/v5-3/structural";

export const V59_BASELINE_COMMIT = "576a6a2556da5dd184ad569ec018621ede9660a6";
export const V59_PRIMARY_EDGE_ID = "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01";
export const V59_DEV_START = Date.parse("2020-01-01T00:00:00.000Z");
export const V59_DEV_END = Date.parse("2026-07-31T23:59:59.999Z");
export const V59_UNTOUCHED_START = Date.parse("2023-01-01T00:00:00.000Z");
export const V59_UNTOUCHED_END = Date.parse("2026-07-31T23:59:59.999Z");
export const V59_PURGE_HOURS = 72;
export const V59_FEE_RATE = 0.0004;
export const V59_BASE_SLIPPAGE_BPS = 2;
export const V59_RISK_PER_TRADE_USDT = 50;
export const V59_COOLDOWN_HOURS = 8;
export const V59_MAX_CORE_FEATURES = 12;
export const V59_MAX_EVENTS_PER_FAMILY = 1_000;

/**
 * This list is frozen before any V5.9 outcome is read. It deliberately excludes
 * every symbol in data/validation-universe-50.json and uses only established
 * contract/liquidity proxies, not strategy returns, for selection.
 */
export const V59_UNTOUCHED_SYMBOLS = [
  "1INCHUSDT",
  "ALGOUSDT",
  "ATOMUSDT",
  "BCHUSDT",
  "CAKEUSDT",
  "CRVUSDT",
  "DOTUSDT",
  "DYDXUSDT",
  "EGLDUSDT",
  "EOSUSDT",
  "FETUSDT",
  "GALAUSDT",
  "KAVAUSDT",
  "MATICUSDT",
  "OPUSDT",
  "RUNEUSDT",
  "SANDUSDT",
  "SEIUSDT",
  "TRXUSDT",
  "VETUSDT",
] as const;

export type V59EventFamily =
  | "FAILED_BREAKOUT_LIQUIDITY_REJECTION"
  | "SUPPORT_BREAKDOWN_RETEST"
  | "TREND_PULLBACK_CONTINUATION"
  | "VOLATILITY_COMPRESSION_EXPANSION"
  | "CROSS_MARKET_DOWNSIDE_MOMENTUM";

export interface V59EventDefinition {
  id: V59EventFamily;
  side: "LONG" | "SHORT" | "BOTH";
  hypothesis: string;
  economicLogic: string;
  detector: string;
}

export const V59_EVENT_REGISTRY: readonly V59EventDefinition[] = [
  {
    id: "FAILED_BREAKOUT_LIQUIDITY_REJECTION",
    side: "BOTH",
    hypothesis: "A closed-candle breakout failure exposes trapped directional liquidity.",
    economicLogic: "A failed acceptance beyond a recent range level can create forced exits and short-horizon reversal flow.",
    detector: "Prior closed candles probe and close beyond a 20-bar level; the current closed candle rejects back through that level.",
  },
  {
    id: "SUPPORT_BREAKDOWN_RETEST",
    side: "SHORT",
    hypothesis: "A support breakdown followed by a bounded retest can expose overhead supply.",
    economicLogic: "Former support becomes an invalidation reference after trapped longs test it from below.",
    detector: "A prior closed candle breaks a 20-bar floor and the current closed candle retests and rejects that floor.",
  },
  {
    id: "TREND_PULLBACK_CONTINUATION",
    side: "BOTH",
    hypothesis: "A bounded pullback inside an established higher-timeframe trend may resume the prevailing flow.",
    economicLogic: "A controlled reset can improve entry location while trend alignment supplies directional continuation pressure.",
    detector: "Closed-candle trend alignment, bounded pullback depth, and directional re-acceleration; no next-bar fields are read.",
  },
  {
    id: "VOLATILITY_COMPRESSION_EXPANSION",
    side: "BOTH",
    hypothesis: "A measured release from compressed range can produce a directional event before late chasing.",
    economicLogic: "Stored range energy plus participation can create temporary order-flow imbalance.",
    detector: "Closed compression/range statistics followed by closed-candle range and participation expansion.",
  },
  {
    id: "CROSS_MARKET_DOWNSIDE_MOMENTUM",
    side: "SHORT",
    hypothesis: "Synchronous benchmark weakness can improve the base rate of local downside momentum events.",
    economicLogic: "Cross-market risk reduction can reinforce local supply and reduce isolated-symbol mean reversion.",
    detector: "Already-closed BTC/ETH regime context, breadth, and local bearish momentum only.",
  },
] as const;

export interface V59RiskTemplate {
  id: string;
  rewardRisk: number;
  stopStyle: StopStyle;
  maxHoldHours: number;
  parameters: Partial<StructuralParameters>;
}

/** Three templates are independent identities; no RR grid is searched. */
export const V59_RISK_TEMPLATES: readonly V59RiskTemplate[] = [
  {
    id: "V59-RISK-1.5R",
    rewardRisk: 1.5,
    stopStyle: "ATR",
    maxHoldHours: 36,
    parameters: { stopATRMultiplier: 1.25 },
  },
  {
    id: "V59-RISK-1.8R",
    rewardRisk: 1.8,
    stopStyle: "HYBRID",
    maxHoldHours: 48,
    parameters: { stopATRMultiplier: 1.25 },
  },
  {
    id: "V59-RISK-2.0R",
    rewardRisk: 2,
    stopStyle: "STRUCTURE",
    maxHoldHours: 72,
    parameters: { stopATRMultiplier: 1.25 },
  },
] as const;

export type V59ModelFamily = "LOGISTIC_L2" | "SHALLOW_TREE";

export interface V59ModelConfig {
  id: string;
  family: V59ModelFamily;
  probabilityThreshold: number;
  l2: number;
}

/** Six configurations = two small model families x three pre-registered thresholds. */
export const V59_MODEL_CONFIGS: readonly V59ModelConfig[] = [
  { id: "V59-LOGISTIC-L2-T55", family: "LOGISTIC_L2", probabilityThreshold: 0.55, l2: 0.1 },
  { id: "V59-LOGISTIC-L2-T60", family: "LOGISTIC_L2", probabilityThreshold: 0.6, l2: 0.1 },
  { id: "V59-LOGISTIC-L2-T65", family: "LOGISTIC_L2", probabilityThreshold: 0.65, l2: 0.1 },
  { id: "V59-SHALLOW-TREE-T55", family: "SHALLOW_TREE", probabilityThreshold: 0.55, l2: 0 },
  { id: "V59-SHALLOW-TREE-T60", family: "SHALLOW_TREE", probabilityThreshold: 0.6, l2: 0 },
  { id: "V59-SHALLOW-TREE-T65", family: "SHALLOW_TREE", probabilityThreshold: 0.65, l2: 0 },
] as const;

export const V59_CORE_FEATURE_NAMES = [
  "local_regime",
  "btc_regime",
  "eth_regime",
  "btc_eth_alignment",
  "market_breadth",
  "atr_percentile",
  "volatility_percentile",
  "volume_ratio",
  "rsi_normalized",
  "trend_age_normalized",
  "entry_extension_atr",
  "funding_percentile",
] as const;

export interface V59ResearchRules {
  positiveLabel: string;
  highQualityLabel: string;
  outerWalkForward: string;
  innerSelection: string;
  purgeHours: number;
  modelSelection: string;
  untouchedGate: Record<string, string>;
  yieldGate: Record<string, string>;
}

export const V59_RESEARCH_RULES: V59ResearchRules = {
  positiveLabel: "POSITIVE when fixed-cost net R > 0",
  highQualityLabel: "HIGH_QUALITY when fixed-cost net R >= +0.5R; descriptive only",
  outerWalkForward: "Purged nested walk-forward over the development pool; outer validation is never used to select a model/config.",
  innerSelection: "Each outer training window runs deterministic inner purged folds, then fits the selected model/config on the full outer training window.",
  purgeHours: V59_PURGE_HOURS,
  modelSelection: "At most six frozen model/threshold configurations; risk templates remain separate fixed identities.",
  untouchedGate: {
    signals: ">= 50",
    untouchedSymbols: ">= 10",
    netR: "> 0",
    avgR: "> 0",
    profitFactor: ">= 1.20",
    plus10BpsNetR: "> 0",
    positiveSymbolRatio: ">= 0.60",
  },
  yieldGate: {
    alertsPerMonth: ">= 2",
    activeMonthRatio: ">= 0.65",
    medianAlertsPerMonth: ">= 1",
    p95DroughtDays: "<= 45",
    maxDroughtDays: "<= 60",
  },
};

export function eventFamilyToStructuralFamily(family: V59EventFamily, side: Side): SignalFeatureFamily {
  if (family === "TREND_PULLBACK_CONTINUATION") return side === "LONG" ? "TREND_PULLBACK_LONG" : "TREND_PULLBACK_SHORT";
  if (family === "VOLATILITY_COMPRESSION_EXPANSION") return side === "LONG" ? "VOLATILITY_EXPANSION_LONG" : "BREAKDOWN_RETEST_SHORT";
  if (family === "FAILED_BREAKOUT_LIQUIDITY_REJECTION") return side === "LONG" ? "BREAKOUT_RETEST_V2" : "FAILED_BREAKOUT_SHORT";
  return side === "LONG" ? "BREAKOUT_RETEST_V2" : "BREAKDOWN_RETEST_SHORT";
}
