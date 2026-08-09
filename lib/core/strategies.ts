import {
  atr,
  bollinger,
  closes,
  donchian,
  ema,
  latest,
  rsi,
  volumeRatio,
} from "./indicators";
import { classifyRegime } from "./market-regime";
import type {
  Candle,
  MarketSnapshot,
  MarketRegime,
  ScoreComponents,
  Side,
  StrategyCandidate,
  Timeframe,
} from "./types";

export interface StrategyParams {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  atrPeriod: number;
  stopAtrMultiplier: number;
  breakoutPeriod: number;
  breakoutVolumeRatio: number;
  meanReversionRsiLow: number;
  meanReversionRsiHigh: number;
  bollingerPeriod: number;
  bollingerDeviation: number;
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  stopAtrMultiplier: 0.25,
  breakoutPeriod: 20,
  breakoutVolumeRatio: 1.15,
  meanReversionRsiLow: 35,
  meanReversionRsiHigh: 65,
  bollingerPeriod: 20,
  bollingerDeviation: 2,
};

export function generateCandidates(
  snapshot: MarketSnapshot,
  params: StrategyParams = DEFAULT_STRATEGY_PARAMS,
): StrategyCandidate[] {
  const primary = snapshot.candles["15m"];
  if (!primary || primary.length < Math.max(params.emaSlow + 5, 80)) return [];

  const regime = classifyRegime(snapshot.candles["4h"] ?? snapshot.candles["1h"] ?? []);
  const candidates: StrategyCandidate[] = [];
  const trend = trendCandidate(snapshot, primary, regime, params);
  const breakout = breakoutCandidate(snapshot, primary, regime, params);
  const meanReversion = meanReversionCandidate(snapshot, primary, regime, params);

  if (trend) candidates.push(trend);
  if (breakout) candidates.push(breakout);
  if (meanReversion) candidates.push(meanReversion);
  return candidates;
}

function trendCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const values = closes(candles);
  const fast = latest(ema(values, params.emaFast));
  const slow = latest(ema(values, params.emaSlow));
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const oneHour = snapshot.candles["1h"] ?? [];
  const fourHour = snapshot.candles["4h"] ?? [];
  const oneHourFast = latest(ema(closes(oneHour), params.emaFast));
  const fourHourFast = latest(ema(closes(fourHour), params.emaFast));
  const latestClose = values.at(-1);

  if (
    fast === null ||
    slow === null ||
    momentum === null ||
    currentAtr === null ||
    latestClose === undefined
  ) {
    return null;
  }

  const oneHourClose = oneHour.at(-1)?.close;
  const fourHourClose = fourHour.at(-1)?.close;
  const longAlignment = [
    latestClose > fast && fast > slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose > oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose > fourHourFast,
  ].filter(Boolean).length;
  const shortAlignment = [
    latestClose < fast && fast < slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose < oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose < fourHourFast,
  ].filter(Boolean).length;

  if (longAlignment < 2 && shortAlignment < 2) return null;

  const side: Side = longAlignment >= shortAlignment ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 6) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 6) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "TREND",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: latestClose,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "HIGH",
    scoreComponents: trendScore({
      side,
      alignment: Math.max(longAlignment, shortAlignment),
      momentum,
      close: latestClose,
      fast,
      atr: currentAtr,
      regime,
      snapshot,
      sampleCount: candles.length + oneHour.length + fourHour.length,
    }),
    rationale: [
      `${side === "LONG" ? "15m 价格站上" : "15m 价格跌破"} EMA${params.emaFast}/EMA${params.emaSlow}`,
      `多周期趋势一致度 ${Math.max(longAlignment, shortAlignment)}/3`,
      `RSI(${params.rsiPeriod})=${momentum.toFixed(1)}`,
    ],
  };
}

function breakoutCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const channels = donchian(candles, params.breakoutPeriod);
  const ratios = volumeRatio(candles, params.breakoutPeriod);
  const currentChannel = channels.at(-1);
  const currentVolumeRatio = latest(ratios);
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const current = candles.at(-1);
  if (
    !current ||
    !currentChannel ||
    currentChannel.upper === null ||
    currentChannel.lower === null ||
    currentVolumeRatio === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longBreakout = current.close > currentChannel.upper && currentVolumeRatio >= params.breakoutVolumeRatio;
  const shortBreakout = current.close < currentChannel.lower && currentVolumeRatio >= params.breakoutVolumeRatio;
  if (!longBreakout && !shortBreakout) return null;

  const side: Side = longBreakout ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? Math.min(currentChannel.upper, recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier)
    : Math.max(currentChannel.lower, recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier);
  const trendFit = regimeFit(side, regime);

  return {
    strategyFamily: "BREAKOUT",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "MEDIUM",
    scoreComponents: {
      trendAlignment: trendFit,
      momentum: clamp01((currentVolumeRatio - 0.8) / 1.2),
      structure: 0.95,
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: trendFit,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      `${params.breakoutPeriod} 根 K 线通道突破`,
      `成交量约为近期均值 ${currentVolumeRatio.toFixed(2)} 倍`,
      `市场状态 ${regime}`,
    ],
  };
}

function meanReversionCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const values = closes(candles);
  const bands = bollinger(values, params.bollingerPeriod, params.bollingerDeviation).at(-1);
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const current = candles.at(-1);
  if (
    !current ||
    !bands ||
    bands.upper === null ||
    bands.lower === null ||
    momentum === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longReversion = current.close <= bands.lower && momentum <= params.meanReversionRsiLow;
  const shortReversion = current.close >= bands.upper && momentum >= params.meanReversionRsiHigh;
  if (!longReversion && !shortReversion) return null;

  const side: Side = longReversion ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "MEAN_REVERSION",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "LOW",
    scoreComponents: {
      trendAlignment: 0.35,
      momentum: side === "LONG"
        ? clamp01((params.meanReversionRsiLow - momentum) / 25)
        : clamp01((momentum - params.meanReversionRsiHigh) / 25),
      structure: 0.82,
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: regime === "RANGE" || regime === "UNKNOWN" ? 0.9 : 0.55,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      `价格触及布林带${side === "LONG" ? "下轨" : "上轨"}`,
      `RSI(${params.rsiPeriod})=${momentum.toFixed(1)}`,
      "使用反转策略，趋势行情中的失败风险较高",
    ],
  };
}

function trendScore(input: {
  side: Side;
  alignment: number;
  momentum: number;
  close: number;
  fast: number;
  atr: number;
  regime: MarketRegime;
  snapshot: MarketSnapshot;
  sampleCount: number;
}): ScoreComponents {
  const momentumScore = input.side === "LONG"
    ? clamp01((input.momentum - 48) / 32)
    : clamp01((52 - input.momentum) / 32);
  return {
    trendAlignment: input.alignment / 3,
    momentum: momentumScore,
    structure: clamp01(Math.abs(input.close - input.fast) / (input.atr * 2)),
    liquidity: liquidityScore(input.snapshot.instrument.quoteVolume24h),
    volatility: volatilityScore(input.atr / input.close),
    regimeFit: regimeFit(input.side, input.regime),
    dataQuality: dataQuality(input.sampleCount),
  };
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

function regimeFit(side: Side, regime: MarketRegime): number {
  if (regime === "UNKNOWN") return 0.55;
  if (regime === "RANGE") return 0.6;
  if ((side === "LONG" && regime === "BULL") || (side === "SHORT" && regime === "BEAR")) return 1;
  return 0.25;
}

function dataQuality(sampleCount: number): number {
  return clamp01(sampleCount / 700);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
