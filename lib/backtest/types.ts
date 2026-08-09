import type { Candle, FundingRatePoint, Instrument } from "@/lib/core/types";
import type { StrategyParams } from "@/lib/core/strategies";

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

export interface BacktestTrade {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyFamily: string;
  entryTime: number;
  exitTime: number;
  score: number;
  entryPrice: number;
  exitPrice: number;
  rMultiple: number;
  pnlUsdt: number;
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  slippageUsdt: number;
  theoreticalRiskUsdt: number;
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END";
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
}

export interface BacktestResult {
  params: StrategyParams;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
}

export interface OptimizerResult {
  params: StrategyParams;
  train: BacktestMetrics;
  outOfSample: BacktestMetrics;
  datasetCount: number;
  eligible: boolean;
}
