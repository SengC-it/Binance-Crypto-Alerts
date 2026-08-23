export type Side = "LONG" | "SHORT";
export type Timeframe = "15m" | "1h" | "4h";
export type MarketRegime = "BULL" | "BEAR" | "RANGE" | "UNKNOWN";
export type MarketStateKey =
  | "BULL_STRONG"
  | "BULL_PULLBACK"
  | "BULL_WEAK"
  | "BEAR_STRONG"
  | "BEAR_REBOUND"
  | "BEAR_WEAK"
  | "OTHER"
  | "UNKNOWN";
export type SignalTier = "A" | "B" | "C";
export type PolicyStatus = "DRAFT" | "CANDIDATE" | "SHADOW" | "APPROVED" | "REJECTED" | "RETIRED";
export type DirectionApprovalStatus = "DRAFT" | "CANDIDATE" | "SHADOW_ONLY" | "APPROVED" | "REJECTED";
export type SetupType = "TREND_PULLBACK" | "TREND_REJECTION" | "BREAKOUT_RETEST" | "NO_SETUP";
export type EntryTrigger = "REJECTION_REBREAK" | "BREAKOUT_RETEST" | "NONE";
export type FundingDataStatus = "AVAILABLE" | "UNKNOWN";
export type StrategyHealthStatus = "HEALTHY" | "DEGRADED" | "FAIL_CLOSED" | "UNKNOWN";
export type ReversalRisk = "LOW" | "MEDIUM" | "HIGH";
export type MomentumPhase = "HEALTHY" | "LATE" | "EXHAUSTION";
export type AdmissionRejectionReason =
  | "CHASE"
  | "WRONG_REGIME"
  | "NO_TRIGGER"
  | "NEGATIVE_EV"
  | "INSUFFICIENT_SAMPLE"
  | "COST_STRESS_FAIL"
  | "UNKNOWN_MARKET_STATE"
  | "DIRECTION_NOT_APPROVED"
  | "UNIVERSE_REJECTED"
  | "MISSING_POLICY"
  | "LOW_CONFIDENCE"
  | "FUNDING_UNAVAILABLE"
  | "INVALID_STRUCTURE"
  | "ENTRY_EDGE_REJECTED"
  | "STRATEGY_HEALTH_UNKNOWN"
  | "STRATEGY_HEALTH_DEGRADED"
  | "STRATEGY_HEALTH_FAIL_CLOSED";

export interface NoChaseFeatures {
  distanceToFastEmaAtr: number;
  distanceToSlowEmaAtr: number;
  distanceToStructureAtr: number;
  recentMoveAtr: number;
  candleBodyAtr: number;
  rangeExpansionAtr: number;
  rsi: number;
  volumeRatio: number;
  pullbackDepth: number;
  breakoutExtensionAtr: number;
}

export interface NoChaseAssessment {
  passed: boolean;
  reasons: AdmissionRejectionReason[];
  features: NoChaseFeatures;
}

export interface EntryEdgeFeatures {
  distanceFromFastEmaAtr: number;
  distanceFromSlowEmaAtr: number;
  distanceFromStructureAtr: number;
  recentDirectionalMoveAtr: number;
  setupAgeBars: number;
  pullbackRecencyBars: number;
  breakoutExtensionAtr: number;
  candleBodyAtr: number;
  upperWickAtr: number;
  lowerWickAtr: number;
  rsi: number;
  reversalRisk: ReversalRisk;
  momentumPhase: MomentumPhase;
  marketConfirmation: {
    btcAligned: boolean;
    ethAligned: boolean;
    breadthAligned: boolean;
  };
}

export interface GlobalMarketState {
  key: MarketStateKey;
  btcRegime: MarketRegime;
  ethRegime?: MarketRegime;
  breadth: number | null;
  sourceTimestamp: number;
  breadthUniverseId?: string;
  breadthUniverseSize?: number;
}

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
  maxLeverage?: number;
  quoteVolume24h?: number;
  universeRank?: number;
  onboardDate?: number;
}

export interface MarketSnapshot {
  instrument: Instrument;
  tickerPrice: number;
  candles: Partial<Record<Timeframe, Candle[]>>;
  sourceTimestamp: number;
  globalMarketState?: GlobalMarketState;
  fundingRates?: FundingRatePoint[];
  fundingDataStatus?: FundingDataStatus;
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
  marketState?: MarketStateKey;
  setupType?: SetupType;
  entryTrigger?: EntryTrigger;
  entryQuality?: number;
  noChase?: NoChaseAssessment;
  entryEdgeFeatures?: EntryEdgeFeatures;
  reversalRisk?: ReversalRisk;
  momentumPhase?: MomentumPhase;
  expectedGrossR?: number | null;
  expectedNetR?: number | null;
  confidence?: number;
  calibrationSamples?: number;
  rejectionReason?: AdmissionRejectionReason;
}

export interface ScoredCandidate extends StrategyCandidate {
  score: number;
  scoreComponents: ScoreComponents;
  structuralScore?: number;
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
