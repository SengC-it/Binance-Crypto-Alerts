import type { Candle, MarketRegime, Side } from "@/lib/core/types";
import type { HistoricalDataset } from "@/lib/backtest/types";
import {
  calculateMetrics,
  evaluatePromotionGate,
  roundMetric,
  type CostStressMetrics,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import type { FeatureFrame, SignalFeatureFamily } from "./feature-snapshot";

export type StopStyle = "STRUCTURE" | "ATR" | "HYBRID";

export interface StructuralParameters {
  breakoutLookback: number;
  volumeRatioMin: number;
  retestDistanceATR: number;
  maxExtensionATR: number;
  pullbackMinATR: number;
  pullbackMaxATR: number;
  trendAgeMinBars: number;
  compressionBarsMin: number;
  compressionRangeMaxATR: number;
  expansionVolumeMin: number;
  expansionVolatilityMin: number;
  stopATRMultiplier: number;
  structureLookback: number;
}

export interface StructuralCandidateDefinition {
  id: string;
  side: Side;
  family: SignalFeatureFamily;
  variant: number;
  hypothesis: string;
  marketMechanism: string;
  expectedRegime: string;
  entryLogic: string;
  invalidationLogic: string;
  expectedHoldingHorizonHours: number;
  expectedFailureMode: string;
  parameters: StructuralParameters;
  stopStyle: StopStyle;
  rewardRisk: number;
}

export interface StructuralTrade extends ValidationTrade {
  candidateId: string;
  family: SignalFeatureFamily;
  stopStyle: StopStyle;
  entryPrice: number;
  exitPrice: number;
  entryExtensionATR: number | null;
  mfeR: number;
  maeR: number;
  timeToMfeHours: number | null;
  timeToMaeHours: number | null;
  hitHalfRBeforeStop: boolean;
  hitOneRBeforeStop: boolean;
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END";
  delayedEntryBars: number;
  fold?: string;
}

export interface StructuralCandidateResult {
  candidate: StructuralCandidateDefinition;
  trades: StructuralTrade[];
  metrics: ValidationMetrics;
  costStress: CostStressMetrics;
  foldMetrics: Array<{ fold: string; metrics: ValidationMetrics }>;
  selectionScore: number;
}

export interface CandidateValueSeries {
  candidateId: string;
  values: number[];
}

export interface PromotionStressSummary {
  delayedEntry: ValidationMetrics;
  plus10Bps: ValidationMetrics;
  plus15Bps: ValidationMetrics;
  removeTop3: ValidationMetrics;
  parameterPerturbation: Array<{
    label: string;
    metrics: ValidationMetrics;
    passed: boolean;
  }>;
}

const baseParameters: StructuralParameters = {
  breakoutLookback: 20,
  volumeRatioMin: 1.15,
  retestDistanceATR: 0.75,
  maxExtensionATR: 0.9,
  pullbackMinATR: 0.35,
  pullbackMaxATR: 1.6,
  trendAgeMinBars: 16,
  compressionBarsMin: 8,
  compressionRangeMaxATR: 4.5,
  expansionVolumeMin: 1.25,
  expansionVolatilityMin: 1.15,
  stopATRMultiplier: 1.25,
  structureLookback: 8,
};

function candidate(
  input: Omit<StructuralCandidateDefinition, "parameters"> & { parameters?: Partial<StructuralParameters> },
): StructuralCandidateDefinition {
  return { ...input, parameters: { ...baseParameters, ...input.parameters } };
}

/**
 * The registry is deliberately finite. Every registered experiment is run and
 * retained in the reports; no parameter is generated from an observed result.
 */
export const V53_CANDIDATE_REGISTRY: readonly StructuralCandidateDefinition[] = [
  candidate({
    id: "LONG-BREAKOUT_RETEST_V2-01",
    side: "LONG",
    family: "BREAKOUT_RETEST_V2",
    variant: 1,
    hypothesis: "A compressed range followed by a volume-confirmed breakout and a shallow retest can preserve continuation edge without late chasing.",
    marketMechanism: "Order-flow imbalance from a range expansion is tested when former resistance becomes support.",
    expectedRegime: "BULL with BTC/ETH agreement and non-extreme breadth",
    entryLogic: "Prior-bar clean high breakout, current-bar retest of the former high, close back above the level, controlled extension.",
    invalidationLogic: "Retest closes below former resistance or stop is hit before target.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Failed breakout, thin volume, or entry after an already extended impulse.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { volumeRatioMin: 1.15, retestDistanceATR: 0.75, maxExtensionATR: 0.9 },
  }),
  candidate({
    id: "LONG-BREAKOUT_RETEST_V2-02",
    side: "LONG",
    family: "BREAKOUT_RETEST_V2",
    variant: 2,
    hypothesis: "A stricter breakout volume threshold should separate clean continuation from noisy range breaks.",
    marketMechanism: "High participation confirms a state change before the support retest.",
    expectedRegime: "BULL",
    entryLogic: "Thirty-bar level break, high relative volume, shallow retest and reclaim without extension above one ATR.",
    invalidationLogic: "Level rejection or a wide retest that signals distribution.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Volume spike without follow-through or broad market disagreement.",
    stopStyle: "STRUCTURE",
    rewardRisk: 2,
    parameters: { breakoutLookback: 30, volumeRatioMin: 1.4, retestDistanceATR: 0.6, maxExtensionATR: 1 },
  }),
  candidate({
    id: "LONG-BREAKOUT_RETEST_V2-03",
    side: "LONG",
    family: "BREAKOUT_RETEST_V2",
    variant: 3,
    hypothesis: "A longer compression and a conservative retest can reduce false breakouts even at the cost of fewer trades.",
    marketMechanism: "Energy accumulation in a narrow range creates asymmetric continuation only after the level is defended.",
    expectedRegime: "BULL or RANGE-to-BULL transition",
    entryLogic: "Twenty-bar break after compression, retest within one ATR, positive momentum re-acceleration.",
    invalidationLogic: "Retest fails or the signal is too far from EMA/level.",
    expectedHoldingHorizonHours: 72,
    expectedFailureMode: "Compression resolves in the opposite direction or lacks breadth support.",
    stopStyle: "ATR",
    rewardRisk: 1.6,
    parameters: { compressionBarsMin: 12, compressionRangeMaxATR: 3.8, retestDistanceATR: 1, maxExtensionATR: 0.75 },
  }),
  candidate({
    id: "LONG-TREND_PULLBACK_LONG-01",
    side: "LONG",
    family: "TREND_PULLBACK_LONG",
    variant: 1,
    hypothesis: "A mature higher-timeframe uptrend should reward controlled pullbacks that re-accelerate from EMA/structure.",
    marketMechanism: "Continuation buyers defend a known value area after weak counter-trend supply is absorbed.",
    expectedRegime: "BULL on 1h and 4h",
    entryLogic: "Bull trend age, one-to-four ATR pullback, close above EMA with positive momentum acceleration.",
    invalidationLogic: "Trend alignment breaks or the pullback exceeds the structural risk band.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Trend exhaustion and a deeper regime transition masked as a pullback.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { pullbackMinATR: 0.35, pullbackMaxATR: 1.6, trendAgeMinBars: 16, maxExtensionATR: 0.9 },
  }),
  candidate({
    id: "LONG-TREND_PULLBACK_LONG-02",
    side: "LONG",
    family: "TREND_PULLBACK_LONG",
    variant: 2,
    hypothesis: "Shallower pullbacks with a stronger momentum turn may avoid buying exhausted rebounds.",
    marketMechanism: "Fast re-acceleration after a shallow reset indicates demand remains dominant.",
    expectedRegime: "BULL",
    entryLogic: "Short controlled pullback, RSI recovery, volume expansion and limited EMA distance.",
    invalidationLogic: "No momentum turn or close under the fast EMA.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "Signal arrives during low-liquidity drift.",
    stopStyle: "ATR",
    rewardRisk: 1.7,
    parameters: { pullbackMinATR: 0.25, pullbackMaxATR: 1.1, trendAgeMinBars: 12, volumeRatioMin: 1.2, maxExtensionATR: 0.75 },
  }),
  candidate({
    id: "LONG-TREND_PULLBACK_LONG-03",
    side: "LONG",
    family: "TREND_PULLBACK_LONG",
    variant: 3,
    hypothesis: "Longer trend age and a deeper but still bounded pullback may improve entry location when volatility is elevated.",
    marketMechanism: "A deeper liquidity sweep that holds structure can reset extension without invalidating the trend.",
    expectedRegime: "BULL with elevated but non-spiking volatility",
    entryLogic: "Deeper pullback, structure hold, bullish close and no late chase.",
    invalidationLogic: "Structure breaks or price remains below EMA after the pullback.",
    expectedHoldingHorizonHours: 72,
    expectedFailureMode: "Trend age becomes exhaustion rather than continuation.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.6,
    parameters: { pullbackMinATR: 0.8, pullbackMaxATR: 2.1, trendAgeMinBars: 24, maxExtensionATR: 1.0 },
  }),
  candidate({
    id: "LONG-VOLATILITY_EXPANSION_LONG-01",
    side: "LONG",
    family: "VOLATILITY_EXPANSION_LONG",
    variant: 1,
    hypothesis: "A measured volatility expansion from compression can create directional continuation before the move becomes crowded.",
    marketMechanism: "Volatility re-pricing plus volume participation produces a temporary directional imbalance.",
    expectedRegime: "BULL or RANGE-to-BULL",
    entryLogic: "Compression, range expansion, volume confirmation, close near high and controlled extension.",
    invalidationLogic: "Expansion lacks follow-through or is an isolated spike.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "News-like spike mean reverts immediately.",
    stopStyle: "ATR",
    rewardRisk: 1.7,
    parameters: { compressionBarsMin: 8, compressionRangeMaxATR: 4.5, expansionVolumeMin: 1.25, expansionVolatilityMin: 1.15 },
  }),
  candidate({
    id: "LONG-VOLATILITY_EXPANSION_LONG-02",
    side: "LONG",
    family: "VOLATILITY_EXPANSION_LONG",
    variant: 2,
    hypothesis: "A stricter compression and expansion threshold should reject single-bar anomalies.",
    marketMechanism: "Sustained range expansion with two-sided confirmation is more likely to represent information arrival.",
    expectedRegime: "BULL",
    entryLogic: "Tight compression, current and prior expansion confirmation, high volume and positive benchmark alignment.",
    invalidationLogic: "One-bar spike, weak close, or extension beyond one ATR.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Breakout occurs after the exploitable move has already happened.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { compressionBarsMin: 12, compressionRangeMaxATR: 3.8, expansionVolumeMin: 1.5, expansionVolatilityMin: 1.3, maxExtensionATR: 0.8 },
  }),
  candidate({
    id: "LONG-VOLATILITY_EXPANSION_LONG-03",
    side: "LONG",
    family: "VOLATILITY_EXPANSION_LONG",
    variant: 3,
    hypothesis: "A lower threshold variant tests whether the structural idea survives realistic signal sparsity without a narrow optimum.",
    marketMechanism: "Early but confirmed expansion may retain more of the move than late breakout entry.",
    expectedRegime: "RANGE-to-BULL",
    entryLogic: "Compression followed by positive expansion, moderate participation and no extreme extension.",
    invalidationLogic: "Expansion fails to hold the compression boundary.",
    expectedHoldingHorizonHours: 24,
    expectedFailureMode: "False positive expansion in a range.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.5,
    parameters: { compressionBarsMin: 6, compressionRangeMaxATR: 5.2, expansionVolumeMin: 1.1, expansionVolatilityMin: 1.05, maxExtensionATR: 1.0 },
  }),
  candidate({
    id: "SHORT-BREAKDOWN_RETEST_SHORT-01",
    side: "SHORT",
    family: "BREAKDOWN_RETEST_SHORT",
    variant: 1,
    hypothesis: "A support breakdown followed by a controlled retest from below can provide cleaner short entries than late trend rejection.",
    marketMechanism: "Former support becomes overhead supply after trapped longs exit on the retest.",
    expectedRegime: "BEAR with BTC/ETH agreement",
    entryLogic: "Prior-bar clean support breakdown, retest of former support, bearish close and controlled downside extension.",
    invalidationLogic: "Retest reclaims support or the stop is hit before target.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Breakdown is absorbed and becomes a bear trap.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { volumeRatioMin: 1.15, retestDistanceATR: 0.75, maxExtensionATR: 0.9 },
  }),
  candidate({
    id: "SHORT-BREAKDOWN_RETEST_SHORT-02",
    side: "SHORT",
    family: "BREAKDOWN_RETEST_SHORT",
    variant: 2,
    hypothesis: "Higher-volume, longer-lookback breakdowns may reduce noise while preserving a retest edge.",
    marketMechanism: "A broad support failure attracts trend followers and offers a defined invalidation on the retest.",
    expectedRegime: "BEAR",
    entryLogic: "Thirty-bar support break, strong volume, shallow retest and rejection.",
    invalidationLogic: "Reclaim of support or a retest wider than the defined ATR distance.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Capitulation exhaustion and rapid reclaim.",
    stopStyle: "STRUCTURE",
    rewardRisk: 2,
    parameters: { breakoutLookback: 30, volumeRatioMin: 1.4, retestDistanceATR: 0.6, maxExtensionATR: 1 },
  }),
  candidate({
    id: "SHORT-BREAKDOWN_RETEST_SHORT-03",
    side: "SHORT",
    family: "BREAKDOWN_RETEST_SHORT",
    variant: 3,
    hypothesis: "A compression-to-breakdown variant tests whether a prepared support failure is more stable than an impulsive drop.",
    marketMechanism: "Compression releases downside and the retest exposes stranded demand at the old floor.",
    expectedRegime: "RANGE-to-BEAR or BEAR",
    entryLogic: "Compressed support break, bounded retest and downside re-acceleration.",
    invalidationLogic: "The old floor is reclaimed.",
    expectedHoldingHorizonHours: 72,
    expectedFailureMode: "Range expansion is not directional.",
    stopStyle: "ATR",
    rewardRisk: 1.6,
    parameters: { compressionBarsMin: 12, compressionRangeMaxATR: 3.8, retestDistanceATR: 1, maxExtensionATR: 0.75 },
  }),
  candidate({
    id: "SHORT-FAILED_BREAKOUT_SHORT-01",
    side: "SHORT",
    family: "FAILED_BREAKOUT_SHORT",
    variant: 1,
    hypothesis: "A failed upside breakout with reclaim failure can expose trapped breakout buyers and create a distinct reversal edge.",
    marketMechanism: "Failed expansion leaves late longs positioned above invalidation while downside confirmation accelerates exits.",
    expectedRegime: "BULL exhaustion or RANGE transition",
    entryLogic: "Recent upside break, loss of breakout level, failed reclaim, bearish confirmation and no late downside chase.",
    invalidationLogic: "Price reclaims the failed-breakout level.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "Breakout resumes after a shallow shakeout.",
    stopStyle: "HYBRID",
    rewardRisk: 1.7,
    parameters: { volumeRatioMin: 1.1, retestDistanceATR: 0.8, maxExtensionATR: 0.9 },
  }),
  candidate({
    id: "SHORT-FAILED_BREAKOUT_SHORT-02",
    side: "SHORT",
    family: "FAILED_BREAKOUT_SHORT",
    variant: 2,
    hypothesis: "Requiring a stronger failed reclaim should reduce false reversals at the expense of sample size.",
    marketMechanism: "Repeated inability to hold the breakout level creates asymmetric downside once trapped demand capitulates.",
    expectedRegime: "BULL exhaustion",
    entryLogic: "High-volume upside break, two-bar failure, failed reclaim and momentum turn below the level.",
    invalidationLogic: "Clean reclaim with renewed volume.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The market is trending and the failed breakout is only a pause.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.8,
    parameters: { volumeRatioMin: 1.35, retestDistanceATR: 0.6, maxExtensionATR: 0.8 },
  }),
  candidate({
    id: "SHORT-FAILED_BREAKOUT_SHORT-03",
    side: "SHORT",
    family: "FAILED_BREAKOUT_SHORT",
    variant: 3,
    hypothesis: "A lower-volume rejection variant tests whether failed structure, rather than volume alone, carries the reversal signal.",
    marketMechanism: "The key information is inability to hold the breakout, not the absolute size of participation.",
    expectedRegime: "RANGE or BULL-to-RANGE",
    entryLogic: "Upside probe, close below the level, lower high, bearish candle and bounded extension.",
    invalidationLogic: "Higher-high reclaim or lack of downside confirmation.",
    expectedHoldingHorizonHours: 24,
    expectedFailureMode: "Low-volume noise and whipsaw.",
    stopStyle: "ATR",
    rewardRisk: 1.5,
    parameters: { volumeRatioMin: 0.95, retestDistanceATR: 1, maxExtensionATR: 1 },
  }),
  candidate({
    id: "SHORT-TREND_PULLBACK_SHORT-01",
    side: "SHORT",
    family: "TREND_PULLBACK_SHORT",
    variant: 1,
    hypothesis: "A mature higher-timeframe downtrend should reward controlled rebounds that reject resistance and re-accelerate lower.",
    marketMechanism: "Counter-trend supply is absorbed at value/resistance before continuation sellers regain control.",
    expectedRegime: "BEAR on 1h and 4h",
    entryLogic: "Bear trend age, one-to-four ATR rebound, close below EMA and negative momentum acceleration.",
    invalidationLogic: "Trend alignment breaks or rebound exceeds the structural risk band.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Downtrend is ending and rebound becomes a reversal.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { pullbackMinATR: 0.35, pullbackMaxATR: 1.6, trendAgeMinBars: 16, maxExtensionATR: 0.9 },
  }),
  candidate({
    id: "SHORT-TREND_PULLBACK_SHORT-02",
    side: "SHORT",
    family: "TREND_PULLBACK_SHORT",
    variant: 2,
    hypothesis: "Shallow rebounds with a stronger downside turn may avoid shorting an exhausted decline.",
    marketMechanism: "Fast resumption after a shallow reset indicates supply remains dominant.",
    expectedRegime: "BEAR",
    entryLogic: "Short bounded rebound, RSI rejection, volume expansion and limited EMA distance.",
    invalidationLogic: "No downside momentum turn or close above the fast EMA.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "Low-liquidity drift or a bear-market bounce.",
    stopStyle: "ATR",
    rewardRisk: 1.7,
    parameters: { pullbackMinATR: 0.25, pullbackMaxATR: 1.1, trendAgeMinBars: 12, volumeRatioMin: 1.2, maxExtensionATR: 0.75 },
  }),
  candidate({
    id: "SHORT-TREND_PULLBACK_SHORT-03",
    side: "SHORT",
    family: "TREND_PULLBACK_SHORT",
    variant: 3,
    hypothesis: "A deeper bounded rebound can improve short entry location during elevated volatility while preserving a downtrend structure.",
    marketMechanism: "Liquidity is collected above the recent low before sellers reassert control.",
    expectedRegime: "BEAR with elevated but non-spiking volatility",
    entryLogic: "Deeper rebound, resistance hold, bearish close and no late downside chase.",
    invalidationLogic: "Resistance breaks or price remains above EMA after the rebound.",
    expectedHoldingHorizonHours: 72,
    expectedFailureMode: "Trend age becomes exhaustion rather than continuation.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.6,
    parameters: { pullbackMinATR: 0.8, pullbackMaxATR: 2.1, trendAgeMinBars: 24, maxExtensionATR: 1 },
  }),
] as const;

export function candidateFamilies(side: Side): SignalFeatureFamily[] {
  return [...new Set(V53_CANDIDATE_REGISTRY.filter((item) => item.side === side).map((item) => item.family))];
}

export function candidateRegistrySummary(): Record<string, unknown> {
  return {
    totalCandidates: V53_CANDIDATE_REGISTRY.length,
    candidatesPerSide: {
      LONG: V53_CANDIDATE_REGISTRY.filter((item) => item.side === "LONG").length,
      SHORT: V53_CANDIDATE_REGISTRY.filter((item) => item.side === "SHORT").length,
    },
    familyCounts: Object.fromEntries([...new Set(V53_CANDIDATE_REGISTRY.map((item) => item.family))].map((family) => [
      family,
      V53_CANDIDATE_REGISTRY.filter((item) => item.family === family).length,
    ])),
    selectionPolicy: "Finite preregistered registry; all candidates and failed results are retained. Selection uses nested inner-fold stability, never peak single-fold NetR.",
    registry: V53_CANDIDATE_REGISTRY,
  };
}

export function detectStructuralSignal(
  frame: FeatureFrame,
  candles: Candle[],
  definition: StructuralCandidateDefinition,
): boolean {
  const p = definition.parameters;
  const index = frame.index;
  if (index < Math.max(100, p.breakoutLookback + 3) || index >= candles.length - 1) return false;
  if (frame.atr <= 0 || frame.emaFast === null || frame.emaSlow === null) return false;
  const side = definition.side;
  const benchmarkRegimes = [frame.btcRegime, frame.ethRegime].filter((regime) => regime !== "UNKNOWN");
  const expectedBenchmarkRegime = side === "LONG" ? "BULL" : "BEAR";
  const alignedBenchmark = benchmarkRegimes.length === 0
    || benchmarkRegimes.every((regime) => regime === expectedBenchmarkRegime);
  const breadthAligned = frame.breadth === null || (side === "LONG" ? frame.breadth >= 0.35 : frame.breadth <= 0.65);
  if (!alignedBenchmark || !breadthAligned) return false;

  switch (definition.family) {
    case "BREAKOUT_RETEST_V2":
      return side === "LONG"
        ? breakoutRetestSignal(frame, candles, p, "LONG")
        : false;
    case "BREAKDOWN_RETEST_SHORT":
      return side === "SHORT"
        ? breakoutRetestSignal(frame, candles, p, "SHORT")
        : false;
    case "TREND_PULLBACK_LONG":
      return side === "LONG" && trendPullbackSignal(frame, p, "LONG");
    case "TREND_PULLBACK_SHORT":
      return side === "SHORT" && trendPullbackSignal(frame, p, "SHORT");
    case "VOLATILITY_EXPANSION_LONG":
      return side === "LONG" && volatilityExpansionSignal(frame, candles, p, "LONG");
    case "FAILED_BREAKOUT_SHORT":
      return side === "SHORT" && failedBreakoutSignal(frame, candles, p);
    default:
      return false;
  }
}

function breakoutRetestSignal(
  frame: FeatureFrame,
  candles: Candle[],
  p: StructuralParameters,
  side: Side,
): boolean {
  const index = frame.index;
  const level = side === "LONG"
    ? rollingHigh(candles, index - 1, p.breakoutLookback)
    : rollingLow(candles, index - 1, p.breakoutLookback);
  if (level === null) return false;
  const breakout = candles[index - 1];
  const current = candles[index];
  const cleanBreak = side === "LONG"
    ? breakout.close > level && breakout.high > level
    : breakout.close < level && breakout.low < level;
  const retest = side === "LONG"
    ? current.low <= level + frame.atr * p.retestDistanceATR && current.close > level
    : current.high >= level - frame.atr * p.retestDistanceATR && current.close < level;
  const candleDirection = side === "LONG" ? current.close > current.open : current.close < current.open;
  const extension = side === "LONG" ? frame.longEntryExtensionATR : frame.shortEntryExtensionATR;
  return cleanBreak
    && retest
    && candleDirection
    && extension !== null
    && extension >= -0.5
    && extension <= p.maxExtensionATR
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && (side === "LONG" ? frame.momentumAcceleration === null || frame.momentumAcceleration > -0.5 : frame.momentumAcceleration === null || frame.momentumAcceleration < 0.5);
}

function trendPullbackSignal(frame: FeatureFrame, p: StructuralParameters, side: Side): boolean {
  const trend = side === "LONG"
    ? (frame.marketRegime === "BULL" && frame.fourHourRegime === "BULL")
    : (frame.marketRegime === "BEAR" && frame.fourHourRegime === "BEAR");
  const age = side === "LONG" ? frame.bullTrendAge : frame.bearTrendAge;
  const depth = side === "LONG" ? frame.longPullbackDepth : frame.shortPullbackDepth;
  const extension = side === "LONG" ? frame.longEntryExtensionATR : frame.shortEntryExtensionATR;
  const momentum = frame.momentumAcceleration;
  const candleDirection = side === "LONG" ? frame.close > frame.open : frame.close < frame.open;
  const rsiOkay = frame.rsi === null || (side === "LONG" ? frame.rsi >= 42 && frame.rsi <= 72 : frame.rsi >= 28 && frame.rsi <= 58);
  return trend
    && age >= p.trendAgeMinBars
    && depth !== null
    && depth >= p.pullbackMinATR
    && depth <= p.pullbackMaxATR
    && extension !== null
    && extension <= p.maxExtensionATR
    && candleDirection
    && rsiOkay
    && (momentum === null || (side === "LONG" ? momentum > -0.25 : momentum < 0.25))
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin * 0.75);
}

function volatilityExpansionSignal(
  frame: FeatureFrame,
  candles: Candle[],
  p: StructuralParameters,
  side: Side,
): boolean {
  const previous = candles[frame.index - 1];
  const priorHigh = rollingHigh(candles, frame.index, 20);
  if (!previous || priorHigh === null) return false;
  const extension = side === "LONG" ? frame.longEntryExtensionATR : frame.shortEntryExtensionATR;
  const directional = side === "LONG" ? frame.close > frame.open && frame.close > priorHigh : frame.close < frame.open;
  return frame.compressionBars >= p.compressionBarsMin
    && frame.compressionRangeATR !== null
    && frame.compressionRangeATR <= p.compressionRangeMaxATR
    && frame.volatilityExpansion !== null
    && frame.volatilityExpansion >= p.expansionVolatilityMin
    && (frame.volumeRatio === null || frame.volumeRatio >= p.expansionVolumeMin)
    && directional
    && extension !== null
    && extension >= -0.25
    && extension <= p.maxExtensionATR
    && (frame.momentumAcceleration === null || frame.momentumAcceleration > 0);
}

function failedBreakoutSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const level = rollingHigh(candles, index - 2, p.breakoutLookback);
  if (level === null || index < 4) return false;
  const recent = candles.slice(Math.max(0, index - 5), index);
  const attemptedBreak = recent.some((candle) => candle.high > level && candle.close > level);
  const failed = frame.close < level && candles[index - 1].close < level;
  const lowerHigh = frame.high < Math.max(...recent.slice(0, -1).map((candle) => candle.high));
  const extension = frame.shortEntryExtensionATR;
  return attemptedBreak
    && failed
    && lowerHigh
    && (frame.marketRegime === "RANGE" || frame.marketRegime === "BULL" || frame.oneHourRegime === "RANGE")
    && (frame.rsi === null || frame.rsi < 58)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && extension !== null
    && extension <= p.maxExtensionATR
    && frame.momentumAcceleration !== null
    && frame.momentumAcceleration < 0.5;
}

export interface StructuralRunOptions {
  startTime?: number;
  endTime?: number;
  delayBars?: number;
  maxHoldHours?: number;
  takerFeeRate?: number;
  slippageBps?: number;
  riskPerTradeUsdt?: number;
  cooldownHours?: number;
}

export function runStructuralCandidate(
  dataset: HistoricalDataset,
  frames: FeatureFrame[],
  definition: StructuralCandidateDefinition,
  options: StructuralRunOptions = {},
): StructuralTrade[] {
  const candles = dataset.candles["15m"];
  const delayBars = Math.max(0, Math.floor(options.delayBars ?? 0));
  const maxHoldBars = Math.max(1, Math.floor((options.maxHoldHours ?? definition.expectedHoldingHorizonHours) * 4));
  const feeRate = options.takerFeeRate ?? 0.0004;
  const slippageRate = (options.slippageBps ?? 2) / 10_000;
  const riskUsdt = options.riskPerTradeUsdt ?? 50;
  const cooldownMs = (options.cooldownHours ?? 8) * 60 * 60 * 1000;
  const start = options.startTime ?? Number.NEGATIVE_INFINITY;
  const end = options.endTime ?? Number.POSITIVE_INFINITY;
  const trades: StructuralTrade[] = [];
  let lastEntryTime = Number.NEGATIVE_INFINITY;
  let lastExitTime = Number.NEGATIVE_INFINITY;

  for (const frame of frames) {
    if (frame.signalTimestamp < start || frame.signalTimestamp > end) continue;
    if (!detectStructuralSignal(frame, candles, definition)) continue;
    const entryIndex = frame.index + 1 + delayBars;
    if (entryIndex >= candles.length) continue;
    const entry = candles[entryIndex];
    if (entry.openTime < start || entry.closeTime > end) continue;
    if (entry.openTime < lastEntryTime + cooldownMs || entry.openTime < lastExitTime) continue;
    const plan = buildStructuralPlan(candles, frame, entry, definition);
    if (!plan || plan.riskPrice <= 0 || !Number.isFinite(plan.riskPrice)) continue;
    const trade = simulateTrade(dataset, candles, frame, entryIndex, plan, definition, {
      delayBars,
      maxHoldBars,
      feeRate,
      slippageRate,
      riskUsdt,
      end,
    });
    if (!trade) continue;
    trades.push(trade);
    lastEntryTime = entry.openTime;
    lastExitTime = trade.exitTime ?? entry.closeTime;
  }
  return trades;
}

interface StructuralPlan {
  stopPrice: number;
  targetPrice: number;
  riskPrice: number;
}

function buildStructuralPlan(
  candles: Candle[],
  frame: FeatureFrame,
  entry: Candle,
  definition: StructuralCandidateDefinition,
): StructuralPlan | null {
  const p = definition.parameters;
  const side = definition.side;
  const structure = side === "LONG"
    ? Math.min(...candles.slice(Math.max(0, frame.index - p.structureLookback), frame.index + 1).map((candle) => candle.low))
    : Math.max(...candles.slice(Math.max(0, frame.index - p.structureLookback), frame.index + 1).map((candle) => candle.high));
  const atrStop = side === "LONG" ? entry.open - frame.atr * p.stopATRMultiplier : entry.open + frame.atr * p.stopATRMultiplier;
  const structureStop = side === "LONG" ? structure - frame.atr * 0.1 : structure + frame.atr * 0.1;
  const stopPrice = definition.stopStyle === "ATR"
    ? atrStop
    : definition.stopStyle === "STRUCTURE"
      ? structureStop
      : side === "LONG" ? Math.min(atrStop, structureStop) : Math.max(atrStop, structureStop);
  const riskPrice = side === "LONG" ? entry.open - stopPrice : stopPrice - entry.open;
  if (riskPrice <= frame.atr * 0.15 || riskPrice > frame.atr * 5) return null;
  return {
    stopPrice,
    targetPrice: side === "LONG" ? entry.open + riskPrice * definition.rewardRisk : entry.open - riskPrice * definition.rewardRisk,
    riskPrice,
  };
}

function simulateTrade(
  dataset: HistoricalDataset,
  candles: Candle[],
  frame: FeatureFrame,
  entryIndex: number,
  plan: StructuralPlan,
  definition: StructuralCandidateDefinition,
  options: { delayBars: number; maxHoldBars: number; feeRate: number; slippageRate: number; riskUsdt: number; end: number },
): StructuralTrade | null {
  const entry = candles[entryIndex];
  const sideSign = definition.side === "LONG" ? 1 : -1;
  const quantity = options.riskUsdt / plan.riskPrice;
  const entryFill = entry.open * (1 + sideSign * options.slippageRate);
  let maxFavorableR = 0;
  let maxAdverseR = 0;
  let timeToMfeHours: number | null = null;
  let timeToMaeHours: number | null = null;
  let exit = candles[Math.min(candles.length - 1, entryIndex + options.maxHoldBars)];
  let rawExitPrice = exit.close;
  let exitReason: StructuralTrade["exitReason"] = exit.closeTime >= options.end ? "TIME_LIMIT" : "DATA_END";
  let hitHalfRBeforeStop = false;
  let hitOneRBeforeStop = false;
  const endIndex = Math.min(candles.length - 1, entryIndex + options.maxHoldBars);

  for (let index = entryIndex; index <= endIndex; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > options.end) break;
    const favorablePrice = definition.side === "LONG" ? candle.high : candle.low;
    const adversePrice = definition.side === "LONG" ? candle.low : candle.high;
    const favorableR = Math.max(0, (favorablePrice - entry.open) * sideSign / plan.riskPrice);
    const adverseR = Math.max(0, (entry.open - adversePrice) * sideSign / plan.riskPrice);
    if (favorableR > maxFavorableR) {
      maxFavorableR = favorableR;
      timeToMfeHours = (candle.closeTime - entry.closeTime) / 3_600_000;
    }
    if (adverseR > maxAdverseR) {
      maxAdverseR = adverseR;
      timeToMaeHours = (candle.closeTime - entry.closeTime) / 3_600_000;
    }
    if (favorableR >= 0.5) hitHalfRBeforeStop = true;
    if (favorableR >= 1) hitOneRBeforeStop = true;
    const stopHit = definition.side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const targetHit = definition.side === "LONG" ? candle.high >= plan.targetPrice : candle.low <= plan.targetPrice;
    if (stopHit) {
      exit = candle;
      rawExitPrice = plan.stopPrice;
      exitReason = "STOP";
      break;
    }
    if (targetHit) {
      exit = candle;
      rawExitPrice = plan.targetPrice;
      exitReason = "TAKE_PROFIT";
      break;
    }
    if (index === endIndex || candle.closeTime >= options.end) {
      exit = candle;
      rawExitPrice = candle.close;
      exitReason = candle.closeTime >= options.end ? "TIME_LIMIT" : "DATA_END";
    }
  }

  const exitFill = rawExitPrice * (1 - sideSign * options.slippageRate);
  const grossPnlUsdt = (exitFill - entryFill) * sideSign * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * options.feeRate;
  const fundingUsdt = calculateFunding(dataset, entry.closeTime, exit.closeTime, entryFill * quantity, sideSign);
  const pnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    symbol: dataset.symbol,
    side: definition.side,
    entryTime: entry.closeTime,
    exitTime: exit.closeTime,
    rMultiple: pnlUsdt / options.riskUsdt,
    netPnlUsdt: pnlUsdt,
    pnlUsdt,
    theoreticalRiskUsdt: options.riskUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt: Math.abs((entry.open - entryFill) * quantity) + Math.abs((rawExitPrice - exitFill) * quantity),
    marketRegime: frame.marketRegime,
    candidateId: definition.id,
    family: definition.family,
    stopStyle: definition.stopStyle,
    entryPrice: entryFill,
    exitPrice: exitFill,
    entryExtensionATR: definition.side === "LONG" ? frame.longEntryExtensionATR : frame.shortEntryExtensionATR,
    mfeR: maxFavorableR,
    maeR: maxAdverseR,
    timeToMfeHours,
    timeToMaeHours,
    hitHalfRBeforeStop,
    hitOneRBeforeStop,
    exitReason,
    delayedEntryBars: options.delayBars,
  };
}

function calculateFunding(dataset: HistoricalDataset, entryTime: number, exitTime: number, notional: number, sideSign: number): number {
  return (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - sideSign * notional * point.fundingRate, 0);
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const start = Math.max(0, endExclusive - period);
  const window = candles.slice(start, endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function rollingLow(candles: Candle[], endExclusive: number, period: number): number | null {
  const start = Math.max(0, endExclusive - period);
  const window = candles.slice(start, endExclusive);
  return window.length < period ? null : Math.min(...window.map((candle) => candle.low));
}

export function extensionBucket(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "DATA_UNAVAILABLE";
  if (value <= 0.25) return "<=0.25";
  if (value <= 0.5) return "0.25-0.5";
  if (value <= 0.75) return "0.5-0.75";
  if (value <= 1) return "0.75-1.0";
  return ">1.0";
}

export function summarizeExtensionBuckets(trades: StructuralTrade[]): Array<Record<string, unknown>> {
  const buckets = ["<=0.25", "0.25-0.5", "0.5-0.75", "0.75-1.0", ">1.0", "DATA_UNAVAILABLE"];
  return buckets.map((bucket) => {
    const rows = trades.filter((trade) => extensionBucket(trade.entryExtensionATR) === bucket);
    const metrics = calculateMetrics(rows);
    return {
      bucket,
      metrics: serializeMetrics(metrics),
      mfeR: rows.length > 0 ? average(rows.map((trade) => trade.mfeR)) : null,
      maeR: rows.length > 0 ? average(rows.map((trade) => trade.maeR)) : null,
      stopRate: rows.length > 0 ? rows.filter((trade) => trade.exitReason === "STOP").length / rows.length : null,
      hitHalfRBeforeStop: rows.length > 0 ? rows.filter((trade) => trade.hitHalfRBeforeStop).length / rows.length : null,
      hitOneRBeforeStop: rows.length > 0 ? rows.filter((trade) => trade.hitOneRBeforeStop).length / rows.length : null,
    };
  });
}

export function selectStableCandidate(results: Array<{
  candidate: StructuralCandidateDefinition;
  foldMetrics: Array<{ metrics: ValidationMetrics }>;
  metrics: ValidationMetrics;
}>): StructuralCandidateDefinition | null {
  if (results.length === 0) return null;
  const scored = results.map((result) => ({
    candidate: result.candidate,
    score: stabilityScore(result.foldMetrics.map((item) => item.metrics), result.metrics),
  }));
  scored.sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
  return scored[0]?.candidate ?? null;
}

export function stabilityScore(folds: ValidationMetrics[], aggregate: ValidationMetrics): number {
  const avgValues = folds.map((fold) => fold.avgNetR);
  const pfValues = folds.map((fold) => Number.isFinite(fold.profitFactor) ? Math.min(fold.profitFactor, 5) : 5);
  const medianAvg = median(avgValues);
  const medianPf = median(pfValues);
  const positiveRatio = folds.length > 0 ? folds.filter((fold) => fold.netR > 0).length / folds.length : 0;
  const ddPenalty = Math.min(aggregate.maxDrawdownR, 100) / 100;
  const lcb = aggregate.lowerConfidenceBound95 ?? -1;
  return medianAvg * 100 + Math.log1p(Math.max(0, medianPf)) * 5 + positiveRatio * 10 + lcb * 10 - ddPenalty;
}

export function selectionAdjustedLowerConfidenceBound(
  series: CandidateValueSeries[],
  selectedCandidateId: string,
  repetitions = 1_000,
  blockLength = 5,
): number | null {
  const usable = series.filter((item) => item.values.length >= 2 && item.values.every(Number.isFinite));
  const selected = usable.find((item) => item.candidateId === selectedCandidateId);
  if (!selected) return null;
  const observedMean = average(selected.values);
  if (observedMean === null) return null;
  const centered = usable.map((item) => ({
    ...item,
    centered: item.values.map((value) => value - (average(item.values) ?? 0)),
  }));
  const maxima: number[] = [];
  let state = (usable.length * 17_231 + selected.values.length * 97_531 + 7) >>> 0;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let maximum = Number.NEGATIVE_INFINITY;
    for (const item of centered) {
      const values: number[] = [];
      const blocks = Math.ceil(item.centered.length / Math.max(1, blockLength));
      for (let block = 0; block < blocks && values.length < item.centered.length; block += 1) {
        const start = Math.floor(random() * item.centered.length);
        for (let offset = 0; offset < blockLength && values.length < item.centered.length; offset += 1) {
          values.push(item.centered[(start + offset) % item.centered.length]);
        }
      }
      maximum = Math.max(maximum, average(values) ?? 0);
    }
    maxima.push(maximum);
  }
  maxima.sort((left, right) => left - right);
  const quantile = maxima[Math.floor((repetitions - 1) * 0.975)] ?? 0;
  return observedMean - quantile;
}

export function removeTopTrades(trades: StructuralTrade[], count = 3): StructuralTrade[] {
  const sorted = [...trades].sort((left, right) => right.rMultiple - left.rMultiple);
  const removed = new Set(sorted.slice(0, count));
  return trades.filter((trade) => !removed.has(trade));
}

export function trueEquityDrawdown(trades: ValidationTrade[], initialEquityUsdt = 10_000): {
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  finalEquityUsdt: number;
} {
  let equity = initialEquityUsdt;
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of [...trades].sort((left, right) => left.entryTime - right.entryTime)) {
    equity += trade.netPnlUsdt ?? trade.pnlUsdt ?? (trade.rMultiple * (trade.theoreticalRiskUsdt ?? 0));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    maxDrawdownUsdt: maxDrawdown,
    maxDrawdownPercent: initialEquityUsdt > 0 ? maxDrawdown / initialEquityUsdt * 100 : 0,
    finalEquityUsdt: equity,
  };
}

export function evaluateV53PromotionGate(input: {
  metrics: ValidationMetrics;
  holdout: ValidationMetrics | null;
  control: ValidationMetrics | null;
  costStress: CostStressMetrics;
  folds: Array<{ netR: number; trades: number }>;
  foldGroups?: Array<{ id: string; folds: Array<{ netR: number; trades: number }> }>;
  regimeMetrics?: Array<{ regime: string; metrics: ValidationMetrics }>;
  dataQuality: { passed: boolean; reason: string };
  adjustedLcb: number | null;
  delayedEntry: ValidationMetrics;
  removeTop3: ValidationMetrics;
  perturbations: Array<{ label: string; metrics: ValidationMetrics; passed: boolean }>;
}): { status: "PRODUCTION_EMAIL_ELIGIBLE" | "SHADOW_ONLY" | "REJECTED"; gates: Array<{ id: string; passed: boolean; evidence: string }> } {
  const adjustedMetrics = { ...input.metrics, lowerConfidenceBound95: input.adjustedLcb };
  const base = evaluatePromotionGate({
    metrics: adjustedMetrics,
    holdout: input.holdout,
    control: input.control,
    costStress: input.costStress,
    folds: input.folds,
    foldGroups: input.foldGroups,
    regimeMetrics: input.regimeMetrics,
    dataQuality: input.dataQuality,
  }).gates;
  const gates = [
    ...base,
    {
      id: "naive_lcb_reported",
      passed: input.metrics.lowerConfidenceBound95 !== null,
      evidence: `naive LCB95=${format(input.metrics.lowerConfidenceBound95)}`,
    },
    {
      id: "selection_adjusted_lcb",
      passed: input.adjustedLcb !== null && input.adjustedLcb > 0,
      evidence: `selection-adjusted LCB95=${format(input.adjustedLcb)}`,
    },
    {
      id: "cost_stress_plus_15bps",
      passed: input.costStress.plus15Bps.netR > 0 && input.costStress.plus15Bps.avgNetR > 0,
      evidence: `+15bps netR=${format(input.costStress.plus15Bps.netR)}, avgR=${format(input.costStress.plus15Bps.avgNetR)}`,
    },
    {
      id: "delayed_entry",
      passed: input.delayedEntry.netR > 0 && input.delayedEntry.avgNetR > 0,
      evidence: `next-15m netR=${format(input.delayedEntry.netR)}, avgR=${format(input.delayedEntry.avgNetR)}`,
    },
    {
      id: "remove_top_3_trades",
      passed: input.removeTop3.netR > 0,
      evidence: `remove-top-3 netR=${format(input.removeTop3.netR)}`,
    },
    {
      id: "parameter_perturbation",
      passed: input.perturbations.length > 0 && input.perturbations.every((item) => item.passed),
      evidence: input.perturbations.map((item) => `${item.label}=${item.passed ? "PASS" : "FAIL"}`).join(", ") || "DATA_UNAVAILABLE",
    },
  ];
  return {
    status: gates.every((gate) => gate.passed)
      ? "PRODUCTION_EMAIL_ELIGIBLE"
      : input.metrics.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
    gates,
  };
}

function evaluateBaseGate(input: {
  metrics: ValidationMetrics;
  holdout: ValidationMetrics | null;
  control: ValidationMetrics | null;
  costStress: CostStressMetrics;
  folds: Array<{ netR: number; trades: number }>;
  foldGroups?: Array<{ id: string; folds: Array<{ netR: number; trades: number }> }>;
  regimeMetrics?: Array<{ regime: string; metrics: ValidationMetrics }>;
  dataQuality: { passed: boolean; reason: string };
}): Array<{ id: string; passed: boolean; evidence: string }> {
  const positiveFolds = input.folds.filter((fold) => fold.netR > 0).length;
  const foldPass = input.foldGroups
    ? input.foldGroups.every((group) => group.folds.length >= 6 && group.folds.filter((fold) => fold.netR > 0).length >= 4)
    : input.folds.length >= 6 && positiveFolds >= 4;
  const positiveRegimes = (input.regimeMetrics ?? []).every((item) => item.metrics.trades < 10 || (item.metrics.avgNetR > 0 && item.metrics.profitFactor >= 1));
  return [
    { id: "data_quality", passed: input.dataQuality.passed, evidence: input.dataQuality.reason },
    { id: "minimum_sample_size", passed: input.metrics.trades >= 100, evidence: `${input.metrics.trades} trades; requires >=100` },
    { id: "purged_walk_forward", passed: foldPass, evidence: `${positiveFolds}/${input.folds.length} positive outer folds; requires >=4/6 per dataset group` },
    { id: "net_edge", passed: input.metrics.netR > 0 && input.metrics.avgNetR > 0 && input.metrics.profitFactor >= 1.15, evidence: `netR=${format(input.metrics.netR)}, avgR=${format(input.metrics.avgNetR)}, PF=${format(input.metrics.profitFactor)}` },
    { id: "frozen_holdout", passed: input.holdout !== null && input.holdout.trades >= 30 && input.holdout.netR > 0 && input.holdout.avgNetR > 0 && input.holdout.profitFactor >= 1.1, evidence: input.holdout ? `${input.holdout.trades} trades, netR=${format(input.holdout.netR)}, PF=${format(input.holdout.profitFactor)}` : "holdout unavailable" },
    { id: "cost_stress_plus_10bps", passed: input.costStress.plus10Bps.netR > 0 && input.costStress.plus10Bps.avgNetR > 0, evidence: `+10bps netR=${format(input.costStress.plus10Bps.netR)}, avgR=${format(input.costStress.plus10Bps.avgNetR)}` },
    { id: "positive_months", passed: input.metrics.positiveMonthRatio !== null && input.metrics.positiveMonthRatio >= 0.6, evidence: `positive month ratio=${formatPercent(input.metrics.positiveMonthRatio)}` },
    { id: "concentration", passed: (input.metrics.topSymbolProfitShare === null || input.metrics.topSymbolProfitShare <= 0.25) && (input.metrics.topFoldProfitShare === null || input.metrics.topFoldProfitShare <= 0.4), evidence: `topSymbol=${formatPercent(input.metrics.topSymbolProfitShare)}, topFold=${formatPercent(input.metrics.topFoldProfitShare)}` },
    { id: "control_comparison", passed: input.control !== null && input.metrics.netR > input.control.netR && input.metrics.avgNetR > input.control.avgNetR && input.metrics.profitFactor > input.control.profitFactor && input.metrics.maxDrawdownR <= input.control.maxDrawdownR * 1.1 + 1e-9, evidence: input.control ? `candidate netR=${format(input.metrics.netR)} vs control=${format(input.control.netR)}, PF=${format(input.metrics.profitFactor)} vs ${format(input.control.profitFactor)}` : "LONG direct Production control unavailable" },
    { id: "regime_conditional", passed: positiveRegimes, evidence: (input.regimeMetrics ?? []).map((item) => `${item.regime}:${item.metrics.trades} trades/${format(item.metrics.avgNetR)} avgR`).join(", ") || "DATA_UNAVAILABLE" },
  ];
}

export function buildPerturbationSummary(
  baseline: ValidationMetrics,
  perturbations: Array<{ label: string; metrics: ValidationMetrics }>,
): Array<{ label: string; metrics: ValidationMetrics; passed: boolean }> {
  return perturbations.map((item) => ({
    ...item,
    passed: item.metrics.trades === 0
      ? false
      : item.metrics.netR > 0 && item.metrics.avgNetR > baseline.avgNetR * -2,
  }));
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function serializeMetrics(metrics: ValidationMetrics): Record<string, unknown> {
  return {
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: roundMetric(metrics.winRate),
    netR: roundMetric(metrics.netR),
    avgNetR: roundMetric(metrics.avgNetR),
    profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null,
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    lowerConfidenceBound95: roundMetric(metrics.lowerConfidenceBound95),
    positiveMonths: metrics.positiveMonths,
    months: metrics.months,
    positiveMonthRatio: roundMetric(metrics.positiveMonthRatio),
    topSymbolProfitShare: roundMetric(metrics.topSymbolProfitShare),
    topFoldProfitShare: roundMetric(metrics.topFoldProfitShare),
    totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt),
  };
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : `${(value * 100).toFixed(1)}%`;
}
