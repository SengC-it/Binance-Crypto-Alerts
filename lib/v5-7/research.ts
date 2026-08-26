import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, Side } from "@/lib/core/types";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import {
  buildStructuralPlan,
  type StopStyle,
  type StructuralCandidateDefinition,
  type StructuralParameters,
  type StructuralPlan,
} from "@/lib/v5-3/structural";
import type { ValidationTrade } from "@/lib/v5-2/validation";

export const V57_MAX_SECOND_CANDIDATES = 12;
export const V57_PRIMARY_EDGE_ID = "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01";
export const V57_PRIMARY_EDGE_FAMILY = "FAILED_BREAKOUT_REVERSAL" as const;
export const V57_PRIMARY_ROLE = "PRIMARY_EDGE_CONTROL" as const;
export const V57_EXTERNAL_MANIFEST_ID = "v561-external-2021-01-01-2023-07-31";
export const V57_EXTERNAL_START = Date.parse("2021-01-01T00:00:00.000Z");
export const V57_EXTERNAL_END = Date.parse("2023-07-31T23:59:59.999Z");
export const V57_FEE_RATE = 0.0004;
export const V57_BASE_SLIPPAGE_BPS = 2;
export const V57_RISK_PER_TRADE_USDT = 50;
export const V57_COOLDOWN_HOURS = 8;

export type V57SecondEdgeFamily =
  | "BEAR_TREND_CONTINUATION"
  | "RANGE_BREAKDOWN"
  | "LIQUIDITY_SWEEP_SHORT"
  | "MOMENTUM_CASCADE";

export interface V57CandidateDefinition {
  id: string;
  side: "SHORT";
  family: V57SecondEdgeFamily;
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

export interface V57Trade extends ValidationTrade {
  candidateId: string;
  strategyIdentity: string;
  family: V57SecondEdgeFamily;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPrice: number;
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

export interface NextBarOpenReference {
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN";
}

export interface DedupeResult<T extends ValidationTrade> {
  rawRows: T[];
  uniqueRows: T[];
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  duplicateKeys: string[];
}

export interface SecondEdgeGateInput {
  nestedTrades: number;
  netR: number;
  avgR: number;
  profitFactor: number;
  plus10BpsNetR: number;
  selectionAdjustedLcb95: number | null;
  symbolBreadth: number;
  positiveOuterFolds: number;
  outerFoldCount: number;
}

export interface SecondEdgeGateResult {
  passed: boolean;
  gates: Array<{ id: string; passed: boolean; evidence: string }>;
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

function defineCandidate(
  input: Omit<V57CandidateDefinition, "parameters"> & { parameters?: Partial<StructuralParameters> },
): V57CandidateDefinition {
  return { ...input, parameters: { ...BASE_PARAMETERS, ...input.parameters } };
}

/**
 * This is the complete V5.7 second-edge registry. It is intentionally small,
 * finite, and frozen before external results are read. None of its families
 * is a failed-breakout variant.
 */
export const V57_SECOND_EDGE_REGISTRY: readonly V57CandidateDefinition[] = [
  defineCandidate({
    id: "V57-SHORT-BEAR-TREND-CONTINUATION-01",
    side: "SHORT",
    family: "BEAR_TREND_CONTINUATION",
    variant: 1,
    hypothesis: "An impulse breakdown followed by a shallow retracement and renewed downside momentum can capture continuation in an established bear regime.",
    marketMechanism: "Counter-trend liquidity is absorbed during a bounded retracement before dominant supply re-accelerates.",
    expectedRegime: "BEAR on 15m, 1h and 4h with mature trend age",
    entryLogic: "Closed impulse and retracement candles only; bearish re-acceleration is confirmed on the signal candle and entered at the next open.",
    invalidationLogic: "A closed reclaim above the retracement value zone invalidates the continuation thesis.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The impulse is capitulation and the retracement becomes a reversal.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { trendAgeMinBars: 24, pullbackMinATR: 0.3, pullbackMaxATR: 1.4, volumeRatioMin: 1.15, maxExtensionATR: 0.85 },
  }),
  defineCandidate({
    id: "V57-SHORT-BEAR-TREND-CONTINUATION-02",
    side: "SHORT",
    family: "BEAR_TREND_CONTINUATION",
    variant: 2,
    hypothesis: "A stricter downside impulse and lower-volume shallow retracement can isolate continuation after a bear-state transition.",
    marketMechanism: "A fresh lower low establishes supply control, while a low-energy retest offers a less extended execution point.",
    expectedRegime: "BEAR on 1h and 4h",
    entryLogic: "Closed lower-low impulse, retracement not exceeding the frozen ATR band, then a closed bearish re-acceleration candle; next-open execution.",
    invalidationLogic: "A closed candle reclaims the impulse midpoint or higher-timeframe bear alignment is absent.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "The apparent continuation is a terminal flush followed by mean reversion.",
    stopStyle: "ATR",
    rewardRisk: 1.7,
    parameters: { trendAgeMinBars: 20, pullbackMinATR: 0.25, pullbackMaxATR: 1.1, volumeRatioMin: 1.25, maxExtensionATR: 0.75, stopATRMultiplier: 1.35 },
  }),
  defineCandidate({
    id: "V57-SHORT-RANGE-BREAKDOWN-01",
    side: "SHORT",
    family: "RANGE_BREAKDOWN",
    variant: 1,
    hypothesis: "A compressed range that confirms a downside break and its first controlled retest can create a separate range-to-bear edge.",
    marketMechanism: "Former range support becomes overhead supply after trapped longs test the broken floor.",
    expectedRegime: "RANGE-to-BEAR or BEAR",
    entryLogic: "Closed range floor, confirmed close below it, bounded first retest and bearish signal close; entry is the next open.",
    invalidationLogic: "A closed reclaim of the range floor invalidates the breakdown.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "The range break is absorbed and rotates back into the range.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.8,
    parameters: { breakoutLookback: 24, compressionBarsMin: 10, compressionRangeMaxATR: 4, retestDistanceATR: 0.65, volumeRatioMin: 1.1, maxExtensionATR: 0.8 },
  }),
  defineCandidate({
    id: "V57-SHORT-RANGE-BREAKDOWN-02",
    side: "SHORT",
    family: "RANGE_BREAKDOWN",
    variant: 2,
    hypothesis: "A longer range and stronger participation requirement may distinguish a true downside state change from ordinary range noise.",
    marketMechanism: "Multi-bar compression stores liquidity around a floor; a high-participation break and failed retest release it lower.",
    expectedRegime: "RANGE-to-BEAR with bearish benchmark agreement",
    entryLogic: "Closed 30-bar floor break, volume-confirmed retest rejection and next-open execution.",
    invalidationLogic: "The broken floor is reclaimed on a closed candle.",
    expectedHoldingHorizonHours: 60,
    expectedFailureMode: "A news-driven break lacks follow-through and returns inside the range.",
    stopStyle: "HYBRID",
    rewardRisk: 2,
    parameters: { breakoutLookback: 30, compressionBarsMin: 12, compressionRangeMaxATR: 3.8, retestDistanceATR: 0.8, volumeRatioMin: 1.3, maxExtensionATR: 0.9 },
  }),
  defineCandidate({
    id: "V57-SHORT-LIQUIDITY-SWEEP-01",
    side: "SHORT",
    family: "LIQUIDITY_SWEEP_SHORT",
    variant: 1,
    hypothesis: "A one-bar sweep above a local high that closes back below the level and displaces lower can monetize trapped breakout buyers.",
    marketMechanism: "Buy-side liquidity is taken above a local high, then supply reasserts itself without requiring the primary two-close failure pattern.",
    expectedRegime: "RANGE or BULL exhaustion",
    entryLogic: "Closed local-high sweep, close back below the level and bearish displacement on the signal candle; next-open entry.",
    invalidationLogic: "A closed reclaim above the swept high invalidates the sweep.",
    expectedHoldingHorizonHours: 36,
    expectedFailureMode: "The sweep is genuine breakout acceptance rather than rejection.",
    stopStyle: "STRUCTURE",
    rewardRisk: 1.7,
    parameters: { breakoutLookback: 16, retestDistanceATR: 0.5, volumeRatioMin: 1.05, maxExtensionATR: 0.8, structureLookback: 6 },
  }),
  defineCandidate({
    id: "V57-SHORT-LIQUIDITY-SWEEP-02",
    side: "SHORT",
    family: "LIQUIDITY_SWEEP_SHORT",
    variant: 2,
    hypothesis: "A wider local liquidity sweep followed by a close below the level and negative momentum can provide a robust rejection setup.",
    marketMechanism: "A deeper wick removes resting buy stops before the close reveals failed acceptance and directional supply.",
    expectedRegime: "RANGE or BULL exhaustion with non-bullish breadth",
    entryLogic: "Closed wick sweep exceeds the local high by a fixed ATR band, closes below the level, and has bearish momentum; next-open execution.",
    invalidationLogic: "A closed acceptance above the swept level.",
    expectedHoldingHorizonHours: 48,
    expectedFailureMode: "A volatile breakout continues after taking liquidity.",
    stopStyle: "HYBRID",
    rewardRisk: 1.8,
    parameters: { breakoutLookback: 20, retestDistanceATR: 0.9, volumeRatioMin: 1.2, maxExtensionATR: 0.9, structureLookback: 8 },
  }),
  defineCandidate({
    id: "V57-SHORT-MOMENTUM-CASCADE-01",
    side: "SHORT",
    family: "MOMENTUM_CASCADE",
    variant: 1,
    hypothesis: "Synchronous BTC, ETH and breadth deterioration can identify cross-market downside cascades before a short signal becomes stale.",
    marketMechanism: "Broad risk reduction reinforces local downside momentum and reduces the probability that a symbol-specific move mean reverts.",
    expectedRegime: "BTC BEAR, ETH BEAR and breadth <= 35%",
    entryLogic: "Closed signal candle only: cross-market bear agreement, negative local acceleration, and participation confirmation; next-open entry.",
    invalidationLogic: "Benchmark agreement breaks or the local signal closes back above its recent value area.",
    expectedHoldingHorizonHours: 24,
    expectedFailureMode: "Cross-market shock is already exhausted when local execution occurs.",
    stopStyle: "ATR",
    rewardRisk: 1.6,
    parameters: { volumeRatioMin: 1.2, expansionVolumeMin: 1.3, expansionVolatilityMin: 1.2, maxExtensionATR: 0.7, stopATRMultiplier: 1.2 },
  }),
  defineCandidate({
    id: "V57-SHORT-MOMENTUM-CASCADE-02",
    side: "SHORT",
    family: "MOMENTUM_CASCADE",
    variant: 2,
    hypothesis: "A stricter synchronous cascade with a fresh local lower low can isolate high-conviction cross-market liquidation pressure.",
    marketMechanism: "Simultaneous benchmark and breadth weakness supplies independent confirmation for a local breakdown.",
    expectedRegime: "BTC BEAR, ETH BEAR, breadth <= 25%",
    entryLogic: "Closed lower-low signal candle, strong negative acceleration and synchronized benchmark/breadth bear state; next-open execution.",
    invalidationLogic: "The local lower low is reclaimed on a closed candle or benchmark agreement disappears.",
    expectedHoldingHorizonHours: 30,
    expectedFailureMode: "The cascade is a short-lived liquidation wick followed by a broad relief rally.",
    stopStyle: "HYBRID",
    rewardRisk: 1.7,
    parameters: { breakoutLookback: 24, volumeRatioMin: 1.35, expansionVolumeMin: 1.45, expansionVolatilityMin: 1.3, maxExtensionATR: 0.8, stopATRMultiplier: 1.25 },
  }),
];

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

export function canonicalV57SignalKey(
  trade: Pick<V57Trade, "symbol" | "side" | "entryTime" | "candidateId" | "strategyIdentity">,
): string {
  return [trade.strategyIdentity || trade.candidateId, trade.symbol, trade.side ?? "UNKNOWN", trade.entryTime].join("|");
}

export function canonicalEmailSignalKey(trade: Pick<ValidationTrade, "symbol" | "side" | "entryTime">): string {
  return [trade.symbol, trade.side ?? "UNKNOWN", trade.entryTime].join("|");
}

export function dedupeV57Trades<T extends V57Trade>(trades: T[]): DedupeResult<T> {
  const seen = new Set<string>();
  const uniqueRows: T[] = [];
  const duplicateKeys: string[] = [];
  for (const trade of trades) {
    const key = canonicalV57SignalKey(trade);
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

export function detectV57SecondSignal(
  frame: FeatureFrame,
  candles: Candle[],
  definition: V57CandidateDefinition,
): boolean {
  const index = frame.index;
  const p = definition.parameters;
  if (index < Math.max(100, p.breakoutLookback + 4) || index >= candles.length - 1) return false;
  if (frame.atr <= 0 || frame.emaFast === null || frame.emaSlow === null) return false;
  if (!bearishBenchmarkAlignment(frame)) return false;
  switch (definition.family) {
    case "BEAR_TREND_CONTINUATION":
      return bearTrendContinuationSignal(frame, candles, p);
    case "RANGE_BREAKDOWN":
      return rangeBreakdownSignal(frame, candles, p);
    case "LIQUIDITY_SWEEP_SHORT":
      return liquiditySweepSignal(frame, candles, p);
    case "MOMENTUM_CASCADE":
      return momentumCascadeSignal(frame, candles, p, definition.variant);
    default:
      return false;
  }
}

export interface V57RunOptions {
  startTime: number;
  endTime: number;
  delayBars?: number;
  takerFeeRate?: number;
  slippageBps?: number;
  riskPerTradeUsdt?: number;
  cooldownHours?: number;
}

export function runV57SecondCandidate(
  dataset: HistoricalDataset,
  frames: FeatureFrame[],
  definition: V57CandidateDefinition,
  options: V57RunOptions,
): V57Trade[] {
  const candles = dataset.candles["15m"];
  const delayBars = Math.max(0, Math.floor(options.delayBars ?? 0));
  const feeRate = options.takerFeeRate ?? V57_FEE_RATE;
  const slippageRate = (options.slippageBps ?? V57_BASE_SLIPPAGE_BPS) / 10_000;
  const riskUsdt = options.riskPerTradeUsdt ?? V57_RISK_PER_TRADE_USDT;
  const cooldownMs = (options.cooldownHours ?? V57_COOLDOWN_HOURS) * 3_600_000;
  const maxHoldBars = Math.max(1, Math.floor(definition.expectedHoldingHorizonHours * 4));
  const trades: V57Trade[] = [];
  let lastEntryTime = Number.NEGATIVE_INFINITY;
  let lastExitTime = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (frame.signalTimestamp < options.startTime || frame.signalTimestamp > options.endTime) continue;
    if (!detectV57SecondSignal(frame, candles, definition)) continue;
    const entryIndex = frame.index + 1 + delayBars;
    const signal = candles[frame.index];
    const entry = candles[entryIndex];
    const execution = nextBarOpenReference(candles, frame.index);
    const priorExecution = candles[entryIndex - 1];
    if (!signal || !entry || !execution || !priorExecution || entry.openTime !== priorExecution.closeTime + 1) continue;
    if (entry.openTime < lastEntryTime + cooldownMs || entry.openTime < lastExitTime) continue;
    if (entry.openTime < options.startTime || entry.openTime > options.endTime) continue;
    const plan = buildStructuralPlan(candles, frame, entry, asStructuralDefinition(definition));
    if (!plan || plan.riskPrice <= 0 || !Number.isFinite(plan.riskPrice)) continue;
    const trade = simulateV57Trade(dataset, candles, frame, entryIndex, plan, definition, {
      delayBars,
      maxHoldBars,
      feeRate,
      slippageRate,
      riskUsdt,
      end: options.endTime,
    });
    if (!trade) continue;
    trades.push(trade);
    lastEntryTime = entry.openTime;
    lastExitTime = trade.exitTime ?? entry.closeTime;
  }
  return trades;
}

export function evaluateSecondEdgeGate(input: SecondEdgeGateInput): SecondEdgeGateResult {
  const gates = [
    { id: "nested_oos_trades", passed: input.nestedTrades >= 30, evidence: `${input.nestedTrades} trades; requires >= 30` },
    { id: "nested_net_r", passed: input.netR > 0, evidence: `NetR=${formatMetric(input.netR)}; requires > 0` },
    { id: "nested_avg_r", passed: input.avgR > 0, evidence: `AvgR=${formatMetric(input.avgR)}; requires > 0` },
    { id: "nested_profit_factor", passed: input.profitFactor >= 1.25, evidence: `PF=${formatMetric(input.profitFactor)}; requires >= 1.25` },
    { id: "plus_10bps_net_r", passed: input.plus10BpsNetR > 0, evidence: `+10bps NetR=${formatMetric(input.plus10BpsNetR)}; requires > 0` },
    { id: "selection_adjusted_lcb95", passed: input.selectionAdjustedLcb95 !== null && input.selectionAdjustedLcb95 >= 0, evidence: `selection-adjusted LCB95=${formatMetric(input.selectionAdjustedLcb95)}; requires >= 0` },
    { id: "symbol_breadth", passed: input.symbolBreadth >= 10, evidence: `${input.symbolBreadth} symbols; requires >= 10` },
    { id: "positive_outer_folds", passed: input.positiveOuterFolds >= 2 && input.outerFoldCount >= 2, evidence: `${input.positiveOuterFolds}/${input.outerFoldCount} positive outer folds; requires >= 2 folds with positive contribution` },
  ];
  return { passed: gates.every((gate) => gate.passed), gates };
}

function bearishBenchmarkAlignment(frame: FeatureFrame): boolean {
  const benchmarkRegimes = [frame.btcRegime, frame.ethRegime].filter((regime) => regime !== "UNKNOWN");
  const benchmarksPass = benchmarkRegimes.length === 0 || benchmarkRegimes.every((regime) => regime === "BEAR");
  return benchmarksPass && (frame.breadth === null || frame.breadth <= 0.65);
}

function bearTrendContinuationSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const impulse = candles[index - 2];
  const retracement = candles[index - 1];
  const signal = candles[index];
  if (!impulse || !retracement || !signal) return false;
  const priorLow = rollingLow(candles, index - 2, p.breakoutLookback);
  if (priorLow === null) return false;
  const bearishTrend = frame.marketRegime === "BEAR"
    && (frame.oneHourRegime === "BEAR" || frame.fourHourRegime === "BEAR")
    && frame.bearTrendAge >= p.trendAgeMinBars;
  const impulseBreak = impulse.close < priorLow && impulse.low < priorLow && impulse.close < impulse.open;
  const shallowRetracement = retracement.high <= impulse.open + frame.atr * p.pullbackMaxATR
    && retracement.high >= impulse.close - frame.atr * p.pullbackMinATR;
  return bearishTrend
    && impulseBreak
    && shallowRetracement
    && signal.close < retracement.low
    && signal.close < signal.open
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function rangeBreakdownSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const floor = rollingLow(candles, index - 2, p.breakoutLookback);
  const compression = candles.slice(Math.max(0, index - p.compressionBarsMin - 2), index - 2);
  const breakdown = candles[index - 2];
  const retest = candles[index - 1];
  const signal = candles[index];
  if (floor === null || compression.length < p.compressionBarsMin || !breakdown || !retest || !signal) return false;
  const range = Math.max(...compression.map((candle) => candle.high)) - Math.min(...compression.map((candle) => candle.low));
  return (frame.marketRegime === "RANGE" || frame.oneHourRegime === "BEAR")
    && range <= frame.atr * p.compressionRangeMaxATR
    && breakdown.close < floor
    && breakdown.low < floor
    && retest.high >= floor - frame.atr * p.retestDistanceATR
    && retest.high <= floor + frame.atr * 0.2
    && retest.close < floor
    && signal.close < retest.low
    && signal.close < signal.open
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function liquiditySweepSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters): boolean {
  const index = frame.index;
  const level = rollingHigh(candles, index - 1, p.breakoutLookback);
  const sweep = candles[index - 1];
  const signal = candles[index];
  if (level === null || !sweep || !signal) return false;
  const regime = frame.marketRegime === "RANGE" || frame.marketRegime === "BULL" || frame.oneHourRegime === "RANGE";
  const swept = sweep.high > level + frame.atr * 0.1;
  const rejected = sweep.close < level && sweep.close < sweep.open;
  const displacement = signal.close < sweep.low && signal.close < signal.open;
  return regime
    && swept
    && rejected
    && displacement
    && (frame.rsi === null || frame.rsi < 60)
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function momentumCascadeSignal(frame: FeatureFrame, candles: Candle[], p: StructuralParameters, variant: number): boolean {
  const current = candles[frame.index];
  const prior = candles[frame.index - 1];
  if (!current || !prior) return false;
  const breadthLimit = variant === 2 ? 0.25 : 0.35;
  return frame.btcRegime === "BEAR"
    && frame.ethRegime === "BEAR"
    && frame.breadth !== null
    && frame.breadth <= breadthLimit
    && frame.marketRegime === "BEAR"
    && frame.momentumAcceleration !== null
    && frame.momentumAcceleration < -0.1
    && current.close < prior.low
    && current.close < current.open
    && (frame.volumeRatio === null || frame.volumeRatio >= p.volumeRatioMin)
    && (frame.volatilityExpansion === null || frame.volatilityExpansion >= p.expansionVolatilityMin)
    && frame.shortEntryExtensionATR !== null
    && frame.shortEntryExtensionATR <= p.maxExtensionATR;
}

function asStructuralDefinition(definition: V57CandidateDefinition): StructuralCandidateDefinition {
  return {
    id: definition.id,
    side: definition.side,
    family: definition.family === "RANGE_BREAKDOWN" || definition.family === "LIQUIDITY_SWEEP_SHORT"
      ? "BREAKDOWN_RETEST_SHORT"
      : "TREND_PULLBACK_SHORT",
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

function simulateV57Trade(
  dataset: HistoricalDataset,
  candles: Candle[],
  frame: FeatureFrame,
  entryIndex: number,
  plan: StructuralPlan,
  definition: V57CandidateDefinition,
  options: { delayBars: number; maxHoldBars: number; feeRate: number; slippageRate: number; riskUsdt: number; end: number },
): V57Trade | null {
  const entry = candles[entryIndex];
  if (!entry) return null;
  const sideSign = -1;
  const quantity = options.riskUsdt / plan.riskPrice;
  const entryFill = entry.open * (1 + sideSign * options.slippageRate);
  const endIndex = Math.min(candles.length - 1, entryIndex + options.maxHoldBars);
  let exit = candles[endIndex];
  let rawExitPrice = exit.close;
  let exitReason: V57Trade["exitReason"] = exit.closeTime >= options.end ? "TIME_LIMIT" : "DATA_END";
  let mfeR = 0;
  let maeR = 0;
  let timeToMfeHours: number | null = null;
  let timeToMaeHours: number | null = null;
  for (let index = entryIndex; index <= endIndex; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > options.end) break;
    const favorablePrice = candle.low;
    const adversePrice = candle.high;
    const favorable = Math.max(0, (favorablePrice - entry.open) * sideSign / plan.riskPrice);
    const adverse = Math.max(0, (entry.open - adversePrice) * sideSign / plan.riskPrice);
    if (favorable > mfeR) {
      mfeR = favorable;
      timeToMfeHours = (candle.closeTime - entry.openTime) / 3_600_000;
    }
    if (adverse > maeR) {
      maeR = adverse;
      timeToMaeHours = (candle.closeTime - entry.openTime) / 3_600_000;
    }
    if (candle.high >= plan.stopPrice) {
      exit = candle;
      rawExitPrice = plan.stopPrice;
      exitReason = "STOP";
      break;
    }
    if (candle.low <= plan.targetPrice) {
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
  if (!exit || !Number.isFinite(rawExitPrice)) return null;
  const exitFill = rawExitPrice * (1 - sideSign * options.slippageRate);
  const grossPnlUsdt = (exitFill - entryFill) * sideSign * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * options.feeRate;
  const fundingUsdt = calculateFunding(dataset, entry.openTime, exit.closeTime, entryFill * quantity, sideSign);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    symbol: dataset.symbol,
    side: "SHORT",
    entryTime: entry.openTime,
    exitTime: exit.closeTime,
    rMultiple: netPnlUsdt / options.riskUsdt,
    netPnlUsdt,
    pnlUsdt: netPnlUsdt,
    theoreticalRiskUsdt: options.riskUsdt,
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
    delayedEntryBars: options.delayBars,
    signalCandleCloseTime: frame.signalTimestamp,
    executionCandleOpenTime: entry.openTime,
    executionReferencePrice: entry.open,
    executionReferenceSource: options.delayBars === 0 ? "BINANCE_15M_NEXT_BAR_OPEN" : "BINANCE_15M_DELAYED_BAR_OPEN",
  };
}

function calculateFunding(dataset: HistoricalDataset, entryTime: number, exitTime: number, notional: number, sideSign: number): number {
  return (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - sideSign * notional * point.fundingRate, 0);
}

function rollingLow(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.min(...window.map((candle) => candle.low));
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}
