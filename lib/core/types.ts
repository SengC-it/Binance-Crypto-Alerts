export type Side = "LONG" | "SHORT";
export type Timeframe = "15m" | "1h" | "4h";
export type MarketRegime = "BULL" | "BEAR" | "RANGE" | "UNKNOWN";
export type StrategyHealthStatus = "HEALTHY" | "DEGRADED" | "FAIL_CLOSED" | "UNKNOWN";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface FundingRatePoint {
  fundingTime: number;
  fundingRate: number;
}

export interface Instrument {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  priceTick: number;
  quantityStep: number;
  minQuantity?: number;
  minNotional?: number;
  pricePrecision?: number;
  quantityPrecision?: number;
  maxLeverage?: number;
  quoteVolume24h?: number;
  universeRank?: number;
  onboardDate?: number;
}

export interface ExecutionCandleOpen {
  openTime: number;
  open: number;
}

export interface MarketSnapshot {
  instrument: Instrument;
  tickerPrice: number;
  candles: Partial<Record<Timeframe, Candle[]>>;
  sourceTimestamp: number;
  nextExecutionCandle?: ExecutionCandleOpen | null;
}

export interface ScoreComponents {
  trendAlignment: number;
  momentum: number;
  structure: number;
  liquidity: number;
  volatility: number;
  regimeFit: number;
  dataQuality: number;
}

export interface StrategyCandidate {
  strategyFamily: "TREND" | "BREAKOUT" | "MEAN_REVERSION";
  side: Side;
  primaryTimeframe: Timeframe;
  confirmationTimeframes: Timeframe[];
  entryPrice: number;
  stopReferencePrice: number;
  atr: number;
  scoreComponents: ScoreComponents;
  marketRegime: MarketRegime;
  regimeDependency: "LOW" | "MEDIUM" | "HIGH";
  rationale: string[];
}

export interface ScoredCandidate extends StrategyCandidate {
  score: number;
  scoreComponents: ScoreComponents;
}

export interface RiskPolicy {
  marginUsdt: number;
  leverage: number;
  singleSignalRiskCapUsdt: number;
  dailyRiskBudgetUsdt: number;
  maxHoldHours: number;
  rewardRisk?: number;
  riskPerTradeUsdt?: number;
  maxPositionNotionalUsdt?: number;
}

export interface TradePlan {
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  rewardRisk: number;
  assumedMarginUsdt: number;
  assumedLeverage: number;
  positionNotionalUsdt: number;
  quantity: number;
  theoreticalRiskUsdt: number;
  riskOverSingleCap: boolean;
  validUntil: number;
}
