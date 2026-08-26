import type { Candle, FundingRatePoint, MarketRegime, Side } from "@/lib/core/types";
import type { ValidationMetrics, ValidationTrade } from "@/lib/v5-2/validation";

export type V6Family = "TIME_SERIES_TREND" | "CROSS_SECTIONAL_MOMENTUM" | "TREND_CARRY";

export type V6Direction = Side;

export interface V6Dataset {
  symbol: string;
  candles4h: Candle[];
  fundingRates: FundingRatePoint[];
}

export interface V6Configuration {
  id: string;
  family: V6Family;
  side: "LONG" | "SHORT" | "BOTH";
  description: string;
  breakoutLookback?: 20 | 40 | 60;
  exitLookback?: 10 | 20;
  rankFraction?: 0.05 | 0.1 | 0.2;
  fundingRule?: "AVOID_EXTREME_CROWDING" | "CARRY_PREFERENCE" | "NEUTRAL_CROWDING";
}

export type V6RiskTemplateId = "V6-RISK-ATR-1.5R" | "V6-RISK-TRAIL-2.0R" | "V6-RISK-TIME-1.0R";

export interface V6RiskTemplate {
  id: V6RiskTemplateId;
  description: string;
  stopAtrMultiplier: number;
  rewardRisk: number;
  maxHoldBars: number;
  trailingAtrMultiplier?: number;
}

export interface V6Signal {
  signalId: string;
  symbol: string;
  family: V6Family;
  configId: string;
  side: V6Direction;
  signalIndex: number;
  signalTimestamp: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_4H_NEXT_BAR_OPEN";
  marketRegime: MarketRegime;
  features: Record<string, number>;
}

export interface V6Trade extends ValidationTrade {
  signalId: string;
  family: V6Family;
  configId: string;
  riskTemplateId: V6RiskTemplateId;
  side: V6Direction;
  signalTimestamp: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_4H_NEXT_BAR_OPEN";
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  riskPrice: number;
  exitReason: "STOP" | "TAKE_PROFIT" | "TRAILING_STOP" | "TIME_STOP" | "DATA_END";
  marketRegime: MarketRegime;
  cluster: "BTC_BETA" | "BTC_ETH";
}

export interface V6MetricSummary {
  metrics: ValidationMetrics;
  cvar95: number | null;
  symbolBreadth: number;
  positiveSymbolRatio: number | null;
}

export interface V6CostStressSummary {
  base: V6MetricSummary;
  plus5Bps: V6MetricSummary;
  plus10Bps: V6MetricSummary;
  plus15Bps: V6MetricSummary;
}

export interface V6YieldSummary {
  calendarDays: number;
  calendarMonths: number;
  alertsPerWeek: number;
  alertsPerMonth: number;
  activeMonthRatio: number | null;
  medianAlertsPerMonth: number | null;
  p95DroughtDays: number | null;
  maxDroughtDays: number | null;
}

export interface V6Run {
  id: string;
  family: V6Family;
  config: V6Configuration;
  riskTemplate: V6RiskTemplate;
  side: V6Direction;
  signals: V6Signal[];
  trades: V6Trade[];
}

export interface V6CandidateEvaluation {
  runId: string;
  family: V6Family;
  configId: string;
  riskTemplateId: V6RiskTemplateId;
  side: V6Direction;
  metrics: V6MetricSummary;
  stress: V6CostStressSummary;
  yield: V6YieldSummary;
  pareto: boolean;
  selectionScore: number;
}

export interface V6FoldResult {
  fold: string;
  selectedRunId: string | null;
  trades: number;
  netR: number;
  avgR: number;
  profitFactor: number | null;
  positive: boolean;
}

export interface V6ValidationResult {
  status: "PASS" | "FAIL" | "INCONCLUSIVE" | "DATA_INSUFFICIENT";
  metrics: V6MetricSummary;
  stress: V6CostStressSummary;
  yield: V6YieldSummary;
  gate: Record<string, boolean>;
  symbols: number;
  dataStatus: string;
}

export interface V6FamilyResult {
  family: V6Family;
  configurations: V6CandidateEvaluation[];
  folds: V6FoldResult[];
  nestedTrades: V6Trade[];
  nested: V6MetricSummary;
  stress: V6CostStressSummary;
  yield: V6YieldSummary;
  positiveFoldRatio: number | null;
  medianFoldNetR: number | null;
  promotionLCB: number | null;
  selectedRun: V6Run | null;
  validationA: V6ValidationResult;
  validationB: V6ValidationResult;
  passed: boolean;
}

export interface V6PortfolioSummary {
  metrics: V6MetricSummary;
  maxConcurrent: number;
  maxSymbolConcentration: number;
  maxClusterConcentration: number;
  rejectedForCapacity: number;
  rejectedForSymbolConcentration: number;
  rejectedForClusterConcentration: number;
  concentrationProxy: string;
}
