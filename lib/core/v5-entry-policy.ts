import {
  atr,
  closes,
  ema,
  latest,
  rsi,
  volumeRatio,
} from "./indicators";
import type {
  AdmissionRejectionReason,
  Candle,
  MarketSnapshot,
  NoChaseAssessment,
  NoChaseFeatures,
  ScoredCandidate,
  SetupType,
  Side,
  StrategyCandidate,
} from "./types";
import type { StrategyParams } from "./strategies";

export type NoChasePolicyVariant = "CONSERVATIVE" | "BALANCED" | "PERMISSIVE";

export interface NoChasePolicy {
  maxDistanceToFastEmaAtr: number;
  maxDistanceToSlowEmaAtr: number;
  maxDistanceToStructureAtr: number;
  maxRecentMoveAtr: number;
  maxCandleBodyAtr: number;
  maxRangeExpansionAtr: number;
  longRsiMax: number;
  shortRsiMin: number;
  maxVolumeRatio: number;
  minPullbackDepth: number;
  maxPullbackDepth: number;
  maxBreakoutExtensionAtr: number;
}

export const NO_CHASE_POLICIES: Record<NoChasePolicyVariant, NoChasePolicy> = {
  CONSERVATIVE: {
    maxDistanceToFastEmaAtr: 1.35,
    maxDistanceToSlowEmaAtr: 2.5,
    maxDistanceToStructureAtr: 1.5,
    maxRecentMoveAtr: 2.5,
    maxCandleBodyAtr: 1.35,
    maxRangeExpansionAtr: 2.25,
    longRsiMax: 70,
    shortRsiMin: 30,
    maxVolumeRatio: 2.25,
    minPullbackDepth: 0.1,
    maxPullbackDepth: 1.5,
    maxBreakoutExtensionAtr: 0.6,
  },
  BALANCED: {
    maxDistanceToFastEmaAtr: 1.8,
    maxDistanceToSlowEmaAtr: 3.25,
    maxDistanceToStructureAtr: 2,
    maxRecentMoveAtr: 3.25,
    maxCandleBodyAtr: 1.8,
    maxRangeExpansionAtr: 3,
    longRsiMax: 74,
    shortRsiMin: 26,
    maxVolumeRatio: 3,
    minPullbackDepth: 0.05,
    maxPullbackDepth: 2,
    maxBreakoutExtensionAtr: 0.9,
  },
  PERMISSIVE: {
    maxDistanceToFastEmaAtr: 2.35,
    maxDistanceToSlowEmaAtr: 4.25,
    maxDistanceToStructureAtr: 2.75,
    maxRecentMoveAtr: 4.25,
    maxCandleBodyAtr: 2.5,
    maxRangeExpansionAtr: 4,
    longRsiMax: 78,
    shortRsiMin: 22,
    maxVolumeRatio: 4,
    minPullbackDepth: 0,
    maxPullbackDepth: 2.75,
    maxBreakoutExtensionAtr: 1.25,
  },
};

export const DEFAULT_NO_CHASE_POLICY = NO_CHASE_POLICIES.BALANCED;

export function evaluateNoChase(
  side: Side,
  features: NoChaseFeatures,
  policy: NoChasePolicy = DEFAULT_NO_CHASE_POLICY,
): NoChaseAssessment {
  const reasons: AdmissionRejectionReason[] = [];
  const values = Object.values(features);
  if (values.some((value) => !Number.isFinite(value))) {
    return { passed: false, reasons: ["INVALID_STRUCTURE"], features };
  }

  if (features.distanceToFastEmaAtr > policy.maxDistanceToFastEmaAtr
    || features.distanceToSlowEmaAtr > policy.maxDistanceToSlowEmaAtr
    || features.distanceToStructureAtr > policy.maxDistanceToStructureAtr
    || features.recentMoveAtr > policy.maxRecentMoveAtr
    || features.candleBodyAtr > policy.maxCandleBodyAtr
    || features.rangeExpansionAtr > policy.maxRangeExpansionAtr
    || features.volumeRatio > policy.maxVolumeRatio
    || features.breakoutExtensionAtr > policy.maxBreakoutExtensionAtr
    || features.pullbackDepth < policy.minPullbackDepth
    || features.pullbackDepth > policy.maxPullbackDepth
  ) {
    reasons.push("CHASE");
  }
  if (side === "LONG" && features.rsi > policy.longRsiMax) reasons.push("CHASE");
  if (side === "SHORT" && features.rsi < policy.shortRsiMin) reasons.push("CHASE");

  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], features };
}

export function generateV5Candidate(
  snapshot: MarketSnapshot,
  params: StrategyParams,
  noChasePolicy: NoChasePolicy = params.noChasePolicy ?? DEFAULT_NO_CHASE_POLICY,
): StrategyCandidate | null {
  const candles = closedCandles(snapshot);
  if (candles.length < Math.max(params.emaSlow + 8, 90)) return null;
  const marketState = snapshot.globalMarketState?.key ?? "UNKNOWN";
  if (marketState === "UNKNOWN") return null;

  const values = closes(candles);
  const fastValues = ema(values, params.emaFast);
  const slowValues = ema(values, params.emaSlow);
  const atrValues = atr(candles, params.atrPeriod);
  const rsiValues = rsi(values, params.rsiPeriod);
  const volumeValues = volumeRatio(candles, params.breakoutPeriod);
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const fast = latest(fastValues);
  const slow = latest(slowValues);
  const currentAtr = latest(atrValues);
  const momentum = latest(rsiValues);
  const currentVolumeRatio = latest(volumeValues);
  if (!current || !previous || fast === null || slow === null || currentAtr === null || momentum === null || currentVolumeRatio === null || currentAtr <= 0) {
    return null;
  }

  const localTrend = trendDirection(fastValues, slowValues, current.close);
  const higherTimeframeTrend = higherTimeframeAlignment(snapshot, params);
  const previousHigh = Math.max(...candles.slice(-4, -1).map((candle) => candle.high));
  const previousLow = Math.min(...candles.slice(-4, -1).map((candle) => candle.low));
  const longPullback = findPullback(candles, fastValues, slowValues, atrValues, "LONG", params);
  const shortPullback = findPullback(candles, fastValues, slowValues, atrValues, "SHORT", params);
  const longTrigger = localTrend === "LONG"
    && higherTimeframeTrend === "LONG"
    && isLongState(marketState)
    && longPullback.depth !== null
    && bullishRejectionRebreak(current, previous, previousHigh, fast, currentAtr);
  const shortTrigger = localTrend === "SHORT"
    && higherTimeframeTrend === "SHORT"
    && isShortState(marketState)
    && shortPullback.depth !== null
    && bearishRejectionRebreak(current, previous, previousLow, fast, currentAtr);
  if (!longTrigger && !shortTrigger) return null;

  const side: Side = longTrigger ? "LONG" : "SHORT";
  const structureLevel = side === "LONG" ? previousHigh : previousLow;
  const pullback = side === "LONG" ? longPullback : shortPullback;
  const features = buildNoChaseFeatures({
    side,
    current,
    candles,
    fast,
    slow,
    atr: currentAtr,
    structureLevel,
    rsi: momentum,
    volumeRatio: currentVolumeRatio,
    pullbackDepth: pullback.depth ?? Number.NaN,
  });
  const noChase = evaluateNoChase(side, features, noChasePolicy);
  const entryQuality = entryQualityScore(side, features, noChase);
  const marketRegime = marketState.startsWith("BULL") ? "BULL" : marketState.startsWith("BEAR") ? "BEAR" : "UNKNOWN";
  const regimeFit = side === "LONG"
    ? marketState === "BULL_STRONG" ? 1 : marketState === "BULL_PULLBACK" ? 0.95 : 0.65
    : marketState === "BEAR_STRONG" ? 1 : marketState === "BEAR_WEAK" ? 0.9 : 0.25;
  const stopReferencePrice = side === "LONG"
    ? Math.min(structureLevel, recentLow(candles, 6) - currentAtr * params.stopAtrMultiplier)
    : Math.max(structureLevel, recentHigh(candles, 6) + currentAtr * params.stopAtrMultiplier);

  return {
    strategyFamily: "TREND",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime,
    regimeDependency: "HIGH",
    marketState,
    setupType: "TREND_PULLBACK" satisfies SetupType,
    entryTrigger: "REJECTION_REBREAK",
    entryQuality,
    noChase,
    scoreComponents: {
      trendAlignment: 1,
      momentum: side === "LONG" ? clamp01((momentum - 45) / 30) : clamp01((55 - momentum) / 30),
      structure: entryQuality,
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit,
      dataQuality: dataQuality(candles.length + (snapshot.candles["1h"]?.length ?? 0) + (snapshot.candles["4h"]?.length ?? 0)),
    },
    rationale: [
      `${side} trend setup is aligned with global ${marketState} market state`,
      side === "LONG" ? "Pullback retested EMA/structure support" : "Rebound retested EMA/structure resistance",
      "Closed candle rejected the retest and re-broke the prior local structure",
      noChase.passed ? "No-chase filter passed" : `No-chase filter failed: ${noChase.reasons.join(",")}`,
    ],
  };
}

function closedCandles(snapshot: MarketSnapshot): Candle[] {
  return (snapshot.candles["15m"] ?? [])
    .filter((candle) => candle.closeTime <= snapshot.sourceTimestamp)
    .sort((left, right) => left.closeTime - right.closeTime);
}

function trendDirection(fastValues: Array<number | null>, slowValues: Array<number | null>, close: number): Side | null {
  const fast = fastValues.at(-1);
  const slow = slowValues.at(-1);
  const previousFast = fastValues.at(-5);
  if (fast === null || slow === null || previousFast === null || fast === undefined || slow === undefined || previousFast === undefined) return null;
  if (fast > slow && fast > previousFast && close > fast) return "LONG";
  if (fast < slow && fast < previousFast && close < fast) return "SHORT";
  return null;
}

function higherTimeframeAlignment(snapshot: MarketSnapshot, params: StrategyParams): Side | null {
  const directions = (["1h", "4h"] as const).map((timeframe) => {
    const candles = snapshot.candles[timeframe] ?? [];
    if (candles.length < params.emaSlow) return null;
    const values = closes(candles);
    const fastValues = ema(values, params.emaFast);
    const slowValues = ema(values, params.emaSlow);
    const fast = latest(fastValues);
    const slow = latest(slowValues);
    const previousFast = fastValues.at(-3);
    const close = candles.at(-1)?.close;
    if (fast === null || slow === null || fast === undefined || slow === undefined || previousFast === null || previousFast === undefined || close === undefined) return null;
    if (fast > slow && fast >= previousFast && close > slow) return "LONG";
    if (fast < slow && fast <= previousFast && close < slow) return "SHORT";
    return null;
  });
  if (directions.every((direction) => direction === "LONG")) return "LONG";
  if (directions.every((direction) => direction === "SHORT")) return "SHORT";
  return null;
}

function findPullback(
  candles: Candle[],
  fastValues: Array<number | null>,
  slowValues: Array<number | null>,
  atrValues: Array<number | null>,
  side: Side,
  params: StrategyParams,
): { depth: number | null } {
  const start = Math.max(params.emaSlow + 2, candles.length - 7);
  let bestDepth: number | null = null;
  for (let index = start; index < candles.length - 1; index += 1) {
    const candle = candles[index];
    const fast = fastValues[index];
    const slow = slowValues[index];
    const currentAtr = atrValues[index];
    if (fast === null || slow === null || currentAtr === null || currentAtr <= 0) continue;
    const distance = side === "LONG"
      ? Math.max(0, (fast - candle.low) / currentAtr)
      : Math.max(0, (candle.high - fast) / currentAtr);
    const touched = side === "LONG"
      ? candle.low <= fast + currentAtr * 0.45 && candle.low >= slow - currentAtr * 1.1
      : candle.high >= fast - currentAtr * 0.45 && candle.high <= slow + currentAtr * 1.1;
    if (touched) bestDepth = bestDepth === null ? distance : Math.max(bestDepth, distance);
  }
  return { depth: bestDepth };
}

function bullishRejectionRebreak(current: Candle, previous: Candle, previousHigh: number, fast: number, currentAtr: number): boolean {
  const lowerWick = Math.min(current.open, current.close) - current.low;
  return current.close > current.open
    && current.close > previousHigh
    && current.close > fast
    && lowerWick >= currentAtr * 0.1
    && current.close - current.open <= currentAtr * 1.8
    && previous.low <= fast + currentAtr * 0.8;
}

function bearishRejectionRebreak(current: Candle, previous: Candle, previousLow: number, fast: number, currentAtr: number): boolean {
  const upperWick = current.high - Math.max(current.open, current.close);
  return current.close < current.open
    && current.close < previousLow
    && current.close < fast
    && upperWick >= currentAtr * 0.1
    && current.open - current.close <= currentAtr * 1.8
    && previous.high >= fast - currentAtr * 0.8;
}

function buildNoChaseFeatures(input: {
  side: Side;
  current: Candle;
  candles: Candle[];
  fast: number;
  slow: number;
  atr: number;
  structureLevel: number;
  rsi: number;
  volumeRatio: number;
  pullbackDepth: number;
}): NoChaseFeatures {
  const direction = input.side === "LONG" ? 1 : -1;
  const recentReference = input.candles.at(-5)?.close ?? input.current.close;
  const priorRanges = input.candles.slice(-8, -1).map((candle) => candle.high - candle.low);
  const typicalRange = priorRanges.length === 0 ? input.atr : priorRanges.reduce((sum, range) => sum + range, 0) / priorRanges.length;
  return {
    distanceToFastEmaAtr: Math.abs(input.current.close - input.fast) / input.atr,
    distanceToSlowEmaAtr: Math.abs(input.current.close - input.slow) / input.atr,
    distanceToStructureAtr: Math.abs(input.current.close - input.structureLevel) / input.atr,
    recentMoveAtr: Math.abs(input.current.close - recentReference) / input.atr,
    candleBodyAtr: Math.abs(input.current.close - input.current.open) / input.atr,
    rangeExpansionAtr: (input.current.high - input.current.low) / Math.max(input.atr, typicalRange),
    rsi: input.rsi,
    volumeRatio: input.volumeRatio,
    pullbackDepth: input.pullbackDepth,
    breakoutExtensionAtr: Math.max(0, (input.current.close - input.structureLevel) * direction / input.atr),
  };
}

function entryQualityScore(side: Side, features: NoChaseFeatures, noChase: NoChaseAssessment): number {
  const distanceScore = clamp01(1 - features.distanceToFastEmaAtr / 2);
  const extensionScore = clamp01(1 - features.breakoutExtensionAtr / 1.5);
  const momentumScore = side === "LONG"
    ? clamp01(1 - Math.max(0, features.rsi - 55) / 25)
    : clamp01(1 - Math.max(0, 45 - features.rsi) / 25);
  return clamp01((distanceScore * 0.4) + (extensionScore * 0.35) + (momentumScore * 0.25) - (noChase.passed ? 0 : 0.35));
}

function isLongState(value: string): boolean {
  return value === "BULL_STRONG" || value === "BULL_PULLBACK" || value === "BULL_WEAK";
}

function isShortState(value: string): boolean {
  return value === "BEAR_STRONG" || value === "BEAR_WEAK" || value === "BEAR_REBOUND";
}

function recentLow(candles: Candle[], period: number): number {
  return Math.min(...candles.slice(-period).map((candle) => candle.low));
}

function recentHigh(candles: Candle[], period: number): number {
  return Math.max(...candles.slice(-period).map((candle) => candle.high));
}

function liquidityScore(quoteVolume?: number): number {
  if (!quoteVolume || quoteVolume <= 0) return 0.35;
  return clamp01((Math.log10(quoteVolume) - 5) / 5);
}

function volatilityScore(atrPercent: number): number {
  if (!Number.isFinite(atrPercent)) return 0;
  return clamp01(1 - Math.abs(atrPercent - 0.012) / 0.025);
}

function dataQuality(sampleCount: number): number {
  return clamp01(sampleCount / 700);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function withV5Score(candidate: StrategyCandidate, score: number): ScoredCandidate {
  return { ...candidate, score, structuralScore: score };
}
