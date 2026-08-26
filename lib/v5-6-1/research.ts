import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, MarketRegime, Side } from "@/lib/core/types";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import {
  buildStructuralPlan,
  type StopStyle,
  type StructuralCandidateDefinition,
  type StructuralParameters,
  type StructuralPlan,
} from "@/lib/v5-3/structural";
import type { ValidationMetrics, ValidationTrade } from "@/lib/v5-2/validation";

export const V561_MAX_CANDIDATES = 30;
export const V561_CONTROL_B_ID = "V5.5-CONTROL-SHORT-FAILED_BREAKOUT_SHORT-02";

export type V561StrategyFamily =
  | "FAILED_BREAKOUT_REVERSAL"
  | "BREAKDOWN_RETEST_CONTINUATION_V2"
  | "VOLATILITY_COMPRESSION_BREAKDOWN"
  | "TREND_PULLBACK_SHORT_V2"
  | "INDEPENDENT_LONG_LIQUIDITY_RECLAIM";

export interface V561CandidateDefinition {
  id: string;
  side: Side;
  family: V561StrategyFamily;
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

export interface V561Trade extends ValidationTrade {
  candidateId: string;
  strategyIdentity: string;
  family: V561StrategyFamily | "FROZEN_CONTROL";
  entryPrice: number;
  exitPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  riskPrice?: number;
  mfeR: number;
  maeR: number;
  timeToMfeHours: number | null;
  timeToMaeHours: number | null;
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END";
  delayedEntryBars: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN" | "BINANCE_15M_DELAYED_BAR_OPEN";
  fold?: string;
}

export interface DedupeResult<T extends ValidationTrade> {
  rawRows: T[];
  uniqueRows: T[];
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  duplicateKeys: string[];
}

const BASE_PARAMETERS: StructuralParameters = {
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

function defineCandidate(input: Omit<V561CandidateDefinition, "parameters"> & { parameters?: Partial<StructuralParameters> }): V561CandidateDefinition {
  return { ...input, parameters: { ...BASE_PARAMETERS, ...input.parameters } };
}

/**
 * V5.6.1 is a finite registry. Each family is implemented by a separate
 * detector below; no observed return is used to add or alter a candidate.
 */
export const V561_CANDIDATE_REGISTRY: readonly V561CandidateDefinition[] = [
  defineCandidate({
    id: "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01",
    side: "SHORT",
    family: "FAILED_BREAKOUT_REVERSAL",
    variant: 1,
    hypothesis: "A failed upside breakout followed by two closes below the level traps late buyers and creates a reversal edge.",
    marketMechanism: "Failed expansion leaves demand above invalidation while supply controls the reclaim failure.",
    expectedRegime: "BULL exhaustion or RANGE transition",
    entryLogic: "Closed failed-breakout frame, lower high, bearish confirmation and bounded next-open entry.",
    invalidationLogic: "Reclaim of the prior upside breakout level.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The breakout resumes after a temporary shakeout.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.8,
    parameters: { breakoutLookback: 20, volumeRatioMin: 1.35, retestDistanceATR: 0.6, maxExtensionATR: 0.8 },
  }),
  defineCandidate({
    id: "V561-SHORT-BREAKDOWN-RETEST-CONTINUATION-V2-01",
    side: "SHORT",
    family: "BREAKDOWN_RETEST_CONTINUATION_V2",
    variant: 1,
    hypothesis: "A support breakdown, bounded retest from below, rejection and continuation confirmation should improve short entry location.",
    marketMechanism: "Former support becomes overhead supply after trapped longs test the broken level.",
    expectedRegime: "BEAR or RANGE-to-BEAR",
    entryLogic: "Closed support break, below-level retest, rejection close and lower continuation close.",
    invalidationLogic: "The broken support is reclaimed on a closed candle.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "Absorption turns the breakdown into a bear trap.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { breakoutLookback: 20, volumeRatioMin: 1.1, retestDistanceATR: 0.8, maxExtensionATR: 0.9 },
  }),
  defineCandidate({
    id: "V561-SHORT-VOLATILITY-COMPRESSION-BREAKDOWN-01",
    side: "SHORT",
    family: "VOLATILITY_COMPRESSION_BREAKDOWN",
    variant: 1,
    hypothesis: "Compression followed by downside range expansion and participation confirmation can expose a controlled continuation edge.",
    marketMechanism: "Stored range energy resolves lower when volume and realized volatility expand together.",
    expectedRegime: "RANGE-to-BEAR or BEAR",
    entryLogic: "Closed compression, downside range expansion below the prior floor, volume and volatility confirmation.",
    invalidationLogic: "The compression floor is reclaimed after the expansion.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "A one-bar volatility shock mean reverts inside the range.",
    stopStyle: "ATR",
    rewardRisk: 1.7,
    parameters: { compressionBarsMin: 8, compressionRangeMaxATR: 4.5, expansionVolumeMin: 1.25, expansionVolatilityMin: 1.15, maxExtensionATR: 0.9 },
  }),
  defineCandidate({
    id: "V561-SHORT-TREND-PULLBACK-V2-01",
    side: "SHORT",
    family: "TREND_PULLBACK_SHORT_V2",
    variant: 1,
    hypothesis: "In a mature bear trend, a rebound into value followed by a fresh lower-low rejection can offer continuation without shorting the initial impulse.",
    marketMechanism: "Counter-trend liquidity is absorbed near value before the dominant supply regime resumes.",
    expectedRegime: "BEAR on 1h and 4h",
    entryLogic: "Bear alignment, bounded rebound into EMA/value, bearish rejection and fresh lower-low confirmation.",
    invalidationLogic: "A closed reclaim above the rebound value zone.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The rebound is a true trend reversal rather than a pullback.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { pullbackMinATR: 0.45, pullbackMaxATR: 1.8, trendAgeMinBars: 20, volumeRatioMin: 1.05, maxExtensionATR: 0.85 },
  }),
  defineCandidate({
    id: "V561-LONG-LIQUIDITY-RECLAIM-01",
    side: "LONG",
    family: "INDEPENDENT_LONG_LIQUIDITY_RECLAIM",
    variant: 1,
    hypothesis: "A bullish trend that sweeps value and reclaims the recent high can provide a distinct LONG continuation edge.",
    marketMechanism: "A downside liquidity sweep resets positioning before demand reclaims the local range.",
    expectedRegime: "BULL or RANGE-to-BULL",
    entryLogic: "Bull alignment, bounded liquidity sweep, bullish reclaim and next-open execution.",
    invalidationLogic: "The swept value area is lost on a closed candle.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The sweep is distribution and the trend has already turned lower.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { pullbackMinATR: 0.4, pullbackMaxATR: 1.7, trendAgeMinBars: 18, volumeRatioMin: 1.05, maxExtensionATR: 0.85 },
  }),
];

export function canonicalResearchSignalKey(trade: Pick<V561Trade, "symbol" | "side" | "entryTime" | "candidateId" | "strategyIdentity">): string {
  return [trade.strategyIdentity || trade.candidateId, trade.symbol, trade.side ?? "UNKNOWN", trade.entryTime].join("|");
}

export function dedupeResearchTrades<T extends V561Trade>(trades: T[]): DedupeResult<T> {
  const seen = new Set<string>();
  const uniqueRows: T[] = [];
  const duplicateKeys: string[] = [];
  for (const trade of trades) {
    const key = canonicalResearchSignalKey(trade);
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    uniqueRows.push(trade);
  }
  return {
    rawRows: trades,
    uniqueRows,
    rawCount: trades.length,
    uniqueCount: uniqueRows.length,
    duplicateCount: trades.length - uniqueRows.length,
    duplicateKeys: [...new Set(duplicateKeys)],
  };
}

export interface YieldMetrics {
  calendarDays: number;
  calendarMonths: number;
  alertsPerDay: number;
  alertsPerWeek: number;
  alertsPerMonth: number;
  activeMonthRatio: number | null;
  medianAlertsPerMonth: number | null;
  p90SignalDroughtDays: number | null;
  p95SignalDroughtDays: number | null;
  maxSignalDroughtDays: number | null;
  symbolBreadth: number;
  regimeBreadth: number;
  signalsBySymbol: Record<string, number>;
  signalsByRegime: Record<string, number>;
  positiveMonthRatio: number | null;
}

export function calculateYieldMetrics(trades: ValidationTrade[], start: number, end: number): YieldMetrics {
  const bounded = trades.filter((trade) => trade.entryTime >= start && trade.entryTime <= end);
  const calendarDays = Math.max(1, (end - start + 1) / 86_400_000);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const calendarMonths = Math.max(1, (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth() + 1);
  const monthCounts = new Map<string, number>();
  const monthNetR = new Map<string, number>();
  const symbols = new Set<string>();
  const regimes = new Set<string>();
  const signalsBySymbol: Record<string, number> = {};
  const signalsByRegime: Record<string, number> = {};
  for (const trade of bounded) {
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
    monthNetR.set(month, (monthNetR.get(month) ?? 0) + finiteOrZero(trade.rMultiple));
    symbols.add(trade.symbol);
    signalsBySymbol[trade.symbol] = (signalsBySymbol[trade.symbol] ?? 0) + 1;
    if (trade.marketRegime) {
      regimes.add(trade.marketRegime);
      signalsByRegime[trade.marketRegime] = (signalsByRegime[trade.marketRegime] ?? 0) + 1;
    }
  }
  const monthly = [...monthCounts.values()].sort((left, right) => left - right);
  const timestamps = bounded.map((trade) => trade.entryTime).sort((left, right) => left - right);
  const droughts = timestamps.length === 0
    ? [calendarDays]
    : [
      (timestamps[0] - start) / 86_400_000,
      ...timestamps.slice(1).map((timestamp, index) => (timestamp - timestamps[index]) / 86_400_000),
      (end - timestamps[timestamps.length - 1]) / 86_400_000,
    ];
  const sortedDroughts = droughts.map((value) => Math.max(0, value)).sort((left, right) => left - right);
  const positiveMonths = [...monthNetR.values()].filter((value) => value > 0).length;
  return {
    calendarDays,
    calendarMonths,
    alertsPerDay: bounded.length / calendarDays,
    alertsPerWeek: bounded.length / calendarDays * 7,
    alertsPerMonth: bounded.length / calendarDays * 30.4375,
    activeMonthRatio: calendarMonths > 0 ? monthCounts.size / calendarMonths : null,
    medianAlertsPerMonth: monthly.length === 0 ? null : percentile(monthly, 0.5),
    p90SignalDroughtDays: percentile(sortedDroughts, 0.9),
    p95SignalDroughtDays: percentile(sortedDroughts, 0.95),
    maxSignalDroughtDays: sortedDroughts.at(-1) ?? null,
    symbolBreadth: symbols.size,
    regimeBreadth: regimes.size,
    signalsBySymbol,
    signalsByRegime,
    positiveMonthRatio: monthNetR.size > 0 ? positiveMonths / monthNetR.size : null,
  };
}

export function passesProvisionalYieldGate(yieldMetrics: YieldMetrics | null): boolean {
  return yieldMetrics !== null
    && yieldMetrics.alertsPerMonth >= 2
    && (yieldMetrics.activeMonthRatio ?? 0) >= 0.65
    && (yieldMetrics.medianAlertsPerMonth ?? 0) >= 1
    && (yieldMetrics.p95SignalDroughtDays ?? Number.POSITIVE_INFINITY) <= 45
    && (yieldMetrics.maxSignalDroughtDays ?? Number.POSITIVE_INFINITY) <= 60;
}

export function calculateCvar95(trades: ValidationTrade[]): number | null {
  const values = trades.map((trade) => trade.rMultiple).filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) return null;
  const tailCount = Math.max(1, Math.ceil(values.length * 0.05));
  return values.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount;
}

export function detectIndependentSignal(frame: FeatureFrame, candles: Candle[], definition: V561CandidateDefinition): boolean {
  const index = frame.index;
  if (index < Math.max(100, definition.parameters.breakoutLookback + 4) || index >= candles.length - 1) return false;
  if (frame.atr <= 0 || frame.emaFast === null || frame.emaSlow === null) return false;
  if (!benchmarkAndBreadthAligned(frame, definition.side)) return false;
  switch (definition.family) {
    case "FAILED_BREAKOUT_REVERSAL":
      return failedBreakoutReversalSignal(frame, candles, definition.parameters);
    case "BREAKDOWN_RETEST_CONTINUATION_V2":
      return breakdownRetestContinuationSignal(frame, candles, definition.parameters);
    case "VOLATILITY_COMPRESSION_BREAKDOWN":
      return volatilityCompressionBreakdownSignal(frame, candles, definition.parameters);
    case "TREND_PULLBACK_SHORT_V2":
      return trendPullbackShortV2Signal(frame, candles, definition.parameters);
    case "INDEPENDENT_LONG_LIQUIDITY_RECLAIM":
      return independentLongLiquidityReclaimSignal(frame, candles, definition.parameters);
    default:
      return false;
  }
}

export interface NextBarOpenReference {
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN";
}

export function nextBarOpenReference(candles: Candle[], signalIndex: number): NextBarOpenReference | null {
  const signal = candles[signalIndex];
  const next = candles[signalIndex + 1];
  if (!signal || !next || next.openTime !== signal.closeTime + 1 || !Number.isFinite(next.open)) return null;
  return {
    signalCandleCloseTime: signal.closeTime,
    executionCandleOpenTime: next.openTime,
    executionReferencePrice: next.open,
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
  };
}

function benchmarkAndBreadthAligned(frame: FeatureFrame, side: Side): boolean {
  const expected = side === "LONG" ? "BULL" : "BEAR";
  const benchmarkRegimes = [frame.btcRegime, frame.ethRegime].filter((regime) => regime !== "UNKNOWN");
  const benchmarkPass = benchmarkRegimes.length === 0 || benchmarkRegimes.every((regime) => regime === expected);
  const breadthPass = frame.breadth === null || (side === "LONG" ? frame.breadth >= 0.35 : frame.breadth <= 0.65);
  return benchmarkPass && breadthPass;
}

function failedBreakoutReversalSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const level = rollingHigh(candles, index - 2, p.breakoutLookback);
  if (level === null || index < 5) return false;
  const attempted = candles[index - 2].high > level && candles[index - 2].close > level;
  const firstFailure = candles[index - 1].close < level;
  const secondFailure = frame.close < level;
  const lowerHigh = candles[index - 1].high < candles[index - 2].high && frame.high < candles[index - 1].high;
  const regimePass = frame.marketRegime === "RANGE" || frame.marketRegime === "BULL" || frame.oneHourRegime === "RANGE";
  return attempted
    && firstFailure
    && secondFailure
    && lowerHigh
    && regimePass
    && frame.close < frame.open
    && (frame.rsi === null || frame.rsi < 58)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR
    && frame.momentumAcceleration !== null
    && frame.momentumAcceleration < 0.5;
}

function breakdownRetestContinuationSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const support = rollingLow(candles, index - 2, p.breakoutLookback);
  if (support === null || index < 4) return false;
  const breakdown = candles[index - 2];
  const retest = candles[index - 1];
  const continuation = candles[index];
  const boundedRetest = retest.high >= support - frame.atr * p.retestDistanceATR
    && retest.high <= support + frame.atr * 0.25
    && retest.close < support;
  return breakdown.close < support
    && breakdown.low < support
    && boundedRetest
    && continuation.close < retest.low
    && continuation.close < continuation.open
    && (frame.marketRegime === "BEAR" || frame.marketRegime === "RANGE" || frame.oneHourRegime === "BEAR")
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function volatilityCompressionBreakdownSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const priorFloor = rollingLow(candles, index - 1, p.breakoutLookback);
  const priorWindow = candles.slice(Math.max(0, index - p.compressionBarsMin), index);
  if (priorFloor === null || priorWindow.length < p.compressionBarsMin) return false;
  const priorRange = Math.max(...priorWindow.map((candle) => candle.high)) - Math.min(...priorWindow.map((candle) => candle.low));
  const current = candles[index];
  const currentRange = current.high - current.low;
  return frame.compressionBars >= p.compressionBarsMin
    && frame.compressionRangeATR !== null
    && frame.compressionRangeATR <= p.compressionRangeMaxATR
    && current.close < priorFloor
    && current.close < current.open
    && currentRange >= Math.max(frame.atr * 1.15, priorRange / Math.max(2, p.compressionBarsMin) * 1.5)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.expansionVolumeMin)
    && (frame.volatilityExpansion === null || frame.volatilityExpansion >= p.expansionVolatilityMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function trendPullbackShortV2Signal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const recent = candles.slice(Math.max(0, index - 8), index);
  if (recent.length < 6) return false;
  const reboundHigh = Math.max(...recent.map((candle) => candle.high));
  const reboundLow = Math.min(...recent.map((candle) => candle.low));
  const valueRebound = frame.emaFast !== null && reboundHigh >= frame.emaFast + frame.atr * p.pullbackMinATR;
  const bounded = frame.emaFast !== null
    && (reboundHigh - reboundLow) / frame.atr <= p.pullbackMaxATR + 1
    && frame.close <= frame.emaFast + frame.atr * 0.15;
  const trend = frame.marketRegime === "BEAR" && (frame.oneHourRegime === "BEAR" || frame.fourHourRegime === "BEAR")
    && frame.bearTrendAge >= p.trendAgeMinBars;
  return trend
    && valueRebound
    && bounded
    && frame.close < frame.open
    && frame.close < candles[index - 1].low
    && (frame.rsi === null || frame.rsi < 55)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function independentLongLiquidityReclaimSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const recent = candles.slice(Math.max(0, index - 8), index);
  if (recent.length < 6) return false;
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const trend = frame.marketRegime === "BULL" && (frame.oneHourRegime === "BULL" || frame.fourHourRegime === "BULL")
    && frame.bullTrendAge >= p.trendAgeMinBars;
  const sweep = frame.emaFast !== null && recentLow <= frame.emaFast - frame.atr * p.pullbackMinATR;
  return trend
    && sweep
    && frame.close > frame.open
    && frame.close > candles[index - 1].high
    && frame.close > recentHigh - frame.atr * 0.25
    && (frame.rsi === null || frame.rsi > 42)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.longEntryExtensionATR !== null
    && frame.longEntryExtensionATR <= p.maxExtensionATR;
}

export interface IndependentRunOptions {
  startTime: number;
  endTime: number;
  delayBars?: number;
  takerFeeRate: number;
  slippageBps: number;
  riskPerTradeUsdt: number;
  cooldownHours: number;
}

export function runIndependentCandidate(
  dataset: HistoricalDataset,
  frames: FeatureFrame[],
  definition: V561CandidateDefinition,
  options: IndependentRunOptions,
): V561Trade[] {
  const candles = dataset.candles["15m"];
  const delayBars = Math.max(0, Math.floor(options.delayBars ?? 0));
  const maxHoldBars = Math.max(1, Math.floor(definition.expectedHoldingHorizonHours * 4));
  const trades: V561Trade[] = [];
  let lastEntryTime = Number.NEGATIVE_INFINITY;
  let lastExitTime = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (frame.signalTimestamp < options.startTime || frame.signalTimestamp > options.endTime) continue;
    if (!detectIndependentSignal(frame, candles, definition)) continue;
    const entryIndex = frame.index + 1 + delayBars;
    const signalCandle = candles[frame.index];
    const nextReference = nextBarOpenReference(candles, frame.index);
    const entry = candles[entryIndex];
    const executionCandle = candles[entryIndex - 1];
    if (!signalCandle || !nextReference || !entry || !executionCandle || entry.openTime !== executionCandle.closeTime + 1) continue;
    if (entry.openTime < lastEntryTime + options.cooldownHours * 3_600_000 || entry.openTime < lastExitTime) continue;
    if (entry.openTime < options.startTime || entry.openTime > options.endTime) continue;
    const plan = buildStructuralPlan(candles, frame, entry, asStructuralDefinition(definition));
    if (!plan || plan.riskPrice <= 0 || !Number.isFinite(plan.riskPrice)) continue;
    const trade = simulateIndependentTrade(dataset, candles, frame, entryIndex, plan, definition, options, maxHoldBars, delayBars);
    if (!trade) continue;
    trades.push(trade);
    lastEntryTime = entry.openTime;
    lastExitTime = trade.exitTime ?? entry.closeTime;
  }
  return trades;
}

function asStructuralDefinition(definition: V561CandidateDefinition): StructuralCandidateDefinition {
  return {
    id: definition.id,
    side: definition.side,
    family: definition.side === "LONG" ? "TREND_PULLBACK_LONG" : "FAILED_BREAKOUT_SHORT",
    variant: definition.variant,
    hypothesis: definition.hypothesis,
    marketMechanism: definition.marketMechanism,
    expectedRegime: definition.expectedRegime,
    entryLogic: definition.entryLogic,
    invalidationLogic: definition.invalidationLogic,
    expectedHoldingHorizonHours: definition.expectedHoldingHorizonHours,
    expectedFailureMode: definition.expectedFailureMode,
    parameters: definition.parameters,
    stopStyle: definition.stopStyle,
    rewardRisk: definition.rewardRisk,
  };
}

function simulateIndependentTrade(
  dataset: HistoricalDataset,
  candles: Candle[],
  frame: FeatureFrame,
  entryIndex: number,
  plan: StructuralPlan,
  definition: V561CandidateDefinition,
  options: IndependentRunOptions,
  maxHoldBars: number,
  delayBars: number,
): V561Trade | null {
  const entry = candles[entryIndex];
  if (!entry) return null;
  const direction = definition.side === "LONG" ? 1 : -1;
  const quantity = options.riskPerTradeUsdt / plan.riskPrice;
  const slippageRate = options.slippageBps / 10_000;
  const entryFill = entry.open * (1 + direction * slippageRate);
  const endIndex = Math.min(candles.length - 1, entryIndex + maxHoldBars);
  let exit = candles[endIndex];
  let rawExitPrice = exit.close;
  let exitReason: V561Trade["exitReason"] = exit.closeTime >= options.endTime ? "TIME_LIMIT" : "DATA_END";
  let mfeR = 0;
  let maeR = 0;
  let timeToMfeHours: number | null = null;
  let timeToMaeHours: number | null = null;
  for (let index = entryIndex; index <= endIndex; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > options.endTime) break;
    const favorablePrice = definition.side === "LONG" ? candle.high : candle.low;
    const adversePrice = definition.side === "LONG" ? candle.low : candle.high;
    const favorable = Math.max(0, (favorablePrice - entry.open) * direction / plan.riskPrice);
    const adverse = Math.max(0, (entry.open - adversePrice) * direction / plan.riskPrice);
    if (favorable > mfeR) {
      mfeR = favorable;
      timeToMfeHours = (candle.closeTime - entry.openTime) / 3_600_000;
    }
    if (adverse > maeR) {
      maeR = adverse;
      timeToMaeHours = (candle.closeTime - entry.openTime) / 3_600_000;
    }
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
    if (index === endIndex || candle.closeTime >= options.endTime) {
      exit = candle;
      rawExitPrice = candle.close;
      exitReason = candle.closeTime >= options.endTime ? "TIME_LIMIT" : "DATA_END";
    }
  }
  if (!exit || !Number.isFinite(rawExitPrice)) return null;
  const exitFill = rawExitPrice * (1 - direction * slippageRate);
  const grossPnlUsdt = (exitFill - entryFill) * direction * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * options.takerFeeRate;
  const fundingUsdt = calculateFunding(dataset, entry.openTime, exit.closeTime, entryFill * quantity, direction);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    symbol: dataset.symbol,
    side: definition.side,
    entryTime: entry.openTime,
    exitTime: exit.closeTime,
    rMultiple: netPnlUsdt / options.riskPerTradeUsdt,
    netPnlUsdt,
    pnlUsdt: netPnlUsdt,
    theoreticalRiskUsdt: options.riskPerTradeUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt: Math.abs(entry.open - entryFill) * quantity + Math.abs(rawExitPrice - exitFill) * quantity,
    marketRegime: frame.marketRegime,
    candidateId: definition.id,
    strategyIdentity: definition.id,
    family: definition.family,
    entryPrice: entryFill,
    exitPrice: exitFill,
    stopPrice: plan.stopPrice,
    targetPrice: plan.targetPrice,
    riskPrice: plan.riskPrice,
    mfeR,
    maeR,
    timeToMfeHours,
    timeToMaeHours,
    exitReason,
    delayedEntryBars: delayBars,
    signalCandleCloseTime: frame.signalTimestamp,
    executionCandleOpenTime: entry.openTime,
    executionReferencePrice: entry.open,
    executionReferenceSource: delayBars === 0 ? "BINANCE_15M_NEXT_BAR_OPEN" : "BINANCE_15M_DELAYED_BAR_OPEN",
  };
}

function calculateFunding(dataset: HistoricalDataset, entryTime: number, exitTime: number, notional: number, direction: number): number {
  return (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function rollingLow(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.min(...window.map((candle) => candle.low));
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil((values.length - 1) * probability)));
  return values[index] ?? null;
}
