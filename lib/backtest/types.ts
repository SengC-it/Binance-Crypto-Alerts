import type { DirectionalCostAwareScoreModel, OpportunityPolicyFeatures } from "@/lib/core/opportunity-policy";
import type { Candle, FundingRatePoint, Instrument, MarketRegime, MarketStateKey } from "@/lib/core/types";
import type { DirectionalScoreCalibrationModel } from "@/lib/core/scoring";
import type { StrategyParams } from "@/lib/core/strategies";
import type { ForwardEdgeMetrics } from "./forward-metrics";

export interface HistoricalDataset {
  symbol: string;
  instrument: Instrument;
  candles: {
    "15m": Candle[];
    "1h"?: Candle[];
    "4h"?: Candle[];
  };
  fundingRates?: FundingRatePoint[];
}

export interface DynamicExitPolicy {
  breakevenTriggerR?: number;
  profitLockTriggerR?: number;
  profitLockR?: number;
  trailingActivationR?: number;
  trailingDistanceR?: number;
  timeStopHours?: number;
  minimumProgressR?: number;
}

export interface TradePathMetrics {
  maxFavorableR: number;
  maxAdverseR: number;
  timeToMaxFavorableHours: number;
  holdingHours: number;
  grossExitR: number;
  givebackR: number;
}

export interface BacktestTrade {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyFamily: string;
  marketRegime: MarketRegime;
  marketState?: MarketStateKey;
  entryTime: number;
  exitTime: number;
  score: number;
  entryPrice: number;
  exitPrice: number;
  referenceEntryPrice?: number;
  referenceExitPrice?: number;
  quantity?: number;
  rMultiple: number;
  pnlUsdt: number;
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  slippageUsdt: number;
  theoreticalRiskUsdt: number;
  policyFeatures?: OpportunityPolicyFeatures;
  expectedNetR?: number | null;
  path?: TradePathMetrics;
  forward?: ForwardEdgeMetrics;
  exitReason: "STOP" | "TAKE_PROFIT" | "BREAKEVEN" | "PROFIT_LOCK" | "TRAILING_STOP" | "TIME_STOP" | "TIME_LIMIT" | "DATA_END";
}

export interface BacktestMetrics {
  sampleDays: number;
  minimumSampleDays: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  netPnlUsdt: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  maxDrawdownUsdt: number;
  finalEquityUsdt: number;
  initialCapitalUsdt: number;
  eligible: boolean;
  averageNetR?: number;
  medianNetR?: number;
  cvar95?: number;
  averageMfeR?: number;
  averageMaeR?: number;
  stopFirstRate?: number;
}

export interface BacktestResult {
  params: StrategyParams;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
}

export interface PortfolioRejectionCounts {
  maxConcurrentPositions: number;
  singleSignalRisk: number;
  dailyRiskBudget: number;
  dailyLossLimit: number;
  emailCap: number;
  capitalFloor: number;
}

export interface PortfolioBacktestResult {
  params: StrategyParams;
  metrics: BacktestMetrics;
  rawMetrics: BacktestMetrics;
  rawTrades: BacktestTrade[];
  trades: BacktestTrade[];
  rejectionCounts: PortfolioRejectionCounts;
}

export interface OptimizerResult {
  params: StrategyParams;
  train: BacktestMetrics;
  validation: BacktestMetrics;
  outOfSample: BacktestMetrics;
  datasetCount: number;
  eligible: boolean;
}
