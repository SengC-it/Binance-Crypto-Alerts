import type { Candle, FundingRatePoint, Side } from "@/lib/core/types";

export type V7Family =
  | "OI_PRICE_DIVERGENCE"
  | "OI_TAKER_FLOW"
  | "CROWDING_REVERSAL";

export type V7DataStatus = "PASS" | "DATA_INSUFFICIENT" | "INCOMPLETE";

export interface DerivativesMetricsPoint {
  timestamp: number;
  sourceTimestamp: number;
  openInterest: number;
  openInterestValue: number;
  takerLongShortVolumeRatio: number;
  globalLongShortAccountRatio: number;
}

export interface V7Dataset {
  symbol: string;
  candles1h: Candle[];
  candles4h: Candle[];
  candles15m: Candle[];
  derivatives: DerivativesMetricsPoint[];
  fundingRates: FundingRatePoint[];
}

export interface V7Configuration {
  id: string;
  family: V7Family;
  side: Side;
  hypothesis: string;
  invalidation: string;
  exit: string;
  parameters: Record<string, number | string>;
}

export interface V7RiskTemplate {
  id: string;
  stopAtrMultiplier: number;
  rewardRisk: number;
  maxHoldBars: number;
  trailingAtrMultiplier?: number;
}

export interface V7FeatureSnapshot {
  timestamp: number;
  priceReturn1h: number;
  priceReturn4h: number;
  realizedVolatility: number;
  atr: number;
  oiLevelPercentile: number;
  oiChange1h: number;
  oiChange4h: number;
  oiAcceleration: number;
  priceOiDivergence: number;
  takerBuyRatio: number;
  takerImbalanceChange: number;
  funding: number;
  fundingPercentile: number;
  longShortRatio: number;
  longShortRatioChange: number;
}

export interface V7Signal {
  family: V7Family;
  configurationId: string;
  symbol: string;
  side: Side;
  signalTimestamp: number;
  signalCandleCloseTime: number;
  executionTimestamp: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN";
  featureSnapshot: V7FeatureSnapshot;
  hypothesis: string;
  invalidation: string;
}

export interface V7Trade {
  family: V7Family;
  configurationId: string;
  symbol: string;
  side: Side;
  signalTimestamp: number;
  executionTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: "TARGET" | "STOP" | "TRAIL" | "TIME" | "END_OF_DATA";
  stopPrice: number;
  targetPrice: number;
  riskPrice: number;
  rewardRisk: number;
  quantity: number;
  grossR: number;
  netR: number;
  feesR: number;
  slippageR: number;
  fundingR: number;
  costStressBps: number;
  oiRegime: "RISING" | "FALLING" | "FLAT" | "UNKNOWN";
  fundingRegime: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "UNKNOWN";
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN";
}

export interface V7MetricSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  avgR: number;
  profitFactor: number;
  maxDD: number;
  cvar95: number | null;
  positiveMonthRatio: number | null;
  symbolBreadth: number;
  positiveSymbolRatio: number | null;
  totalNetPnlUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
}

export interface V7StressSummary {
  base: V7MetricSummary;
  plus5Bps: V7MetricSummary;
  plus10Bps: V7MetricSummary;
  plus15Bps: V7MetricSummary;
}

export interface V7YieldMetrics {
  calendarDays: number;
  calendarMonths: number;
  alertsPerWeek: number;
  alertsPerMonth: number;
  activeMonthRatio: number;
  medianAlertsPerMonth: number | null;
  p95DroughtDays: number;
  maxDroughtDays: number;
}

export interface V7RunResult {
  runId: string;
  family: V7Family;
  configId: string;
  riskTemplateId: string;
  side: Side;
  trades: V7Trade[];
  metrics: V7MetricSummary;
  stress: V7StressSummary;
  yield: V7YieldMetrics;
  pareto: boolean;
  selectionScore: number;
}

export interface V7FoldResult {
  fold: string;
  selectedRunId: string;
  trades: number;
  netR: number;
  avgR: number;
  profitFactor: number;
  positive: boolean;
}

export interface V7NestedResult {
  selectedRun: V7RunResult;
  nestedTrades: V7Trade[];
  folds: V7FoldResult[];
  metrics: V7MetricSummary;
  stress: V7StressSummary;
  yield: V7YieldMetrics;
  positiveFoldRatio: number;
  medianFoldNetR: number;
  promotionLCB: number;
}

export interface V7ValidationResult {
  status: V7DataStatus;
  metrics: V7MetricSummary;
  stress: V7StressSummary;
  symbols: number;
  gate: Record<string, boolean>;
}
