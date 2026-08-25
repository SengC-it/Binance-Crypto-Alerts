import { atr, closes, ema, rsi, volumeRatio } from "@/lib/core/indicators";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, MarketRegime, Side } from "@/lib/core/types";

export const V53_STRATEGY_VERSION = "v5-3-structural-edge";

export type SignalFeatureFamily =
  | "BREAKOUT_RETEST_V2"
  | "TREND_PULLBACK_LONG"
  | "VOLATILITY_EXPANSION_LONG"
  | "BREAKDOWN_RETEST_SHORT"
  | "FAILED_BREAKOUT_SHORT"
  | "TREND_PULLBACK_SHORT";

export interface SignalFeatureSnapshot {
  strategyVersion: string;
  symbol: string;
  side: Side;
  signalTimestamp: number;
  marketRegime: MarketRegime;
  btcRegime: MarketRegime;
  ethRegime: MarketRegime;
  breadth: number | null;
  atr: number;
  atrPercentile: number | null;
  trendSlope: number | null;
  trendAge: number | null;
  breakoutDistance: number | null;
  entryExtensionATR: number | null;
  distanceToEMA: number | null;
  pullbackDepth: number | null;
  retestDepth: number | null;
  retestDuration: number | null;
  rsi: number | null;
  momentumAcceleration: number | null;
  volumeRatio: number | null;
  volatilityPercentile: number | null;
  volatilityExpansion: number | null;
  btcEthAgreement: boolean | null;
  funding: number | null;
  fundingPercentile: number | null;
  setupAge: number | null;
  score: number;
  candidateFamily: SignalFeatureFamily;
}

export interface FeatureFrame {
  index: number;
  signalTimestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  atr: number;
  atrPercentile: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  trendSlope: number | null;
  bullTrendAge: number;
  bearTrendAge: number;
  marketRegime: MarketRegime;
  btcRegime: MarketRegime;
  ethRegime: MarketRegime;
  breadth: number | null;
  btcEthAgreement: boolean | null;
  rsi: number | null;
  previousRsi: number | null;
  momentumAcceleration: number | null;
  volumeRatio: number | null;
  previousVolumeRatio: number | null;
  volatilityPercentile: number | null;
  volatilityExpansion: number | null;
  funding: number | null;
  fundingPercentile: number | null;
  breakoutHigh20: number | null;
  breakoutLow20: number | null;
  compressionBars: number;
  compressionRangeATR: number | null;
  longPullbackDepth: number | null;
  shortPullbackDepth: number | null;
  longEntryExtensionATR: number | null;
  shortEntryExtensionATR: number | null;
  longDistanceToEMA: number | null;
  shortDistanceToEMA: number | null;
  longRetestDepth: number | null;
  shortRetestDepth: number | null;
  longRetestDuration: number | null;
  shortRetestDuration: number | null;
  oneHourRegime: MarketRegime;
  fourHourRegime: MarketRegime;
  oneHourClose: number | null;
  oneHourEmaFast: number | null;
  oneHourEmaSlow: number | null;
  fourHourClose: number | null;
  fourHourEmaFast: number | null;
  fourHourEmaSlow: number | null;
}

export interface FeatureFrameBuildOptions {
  startTime?: number;
  endTime?: number;
  entryStrideBars?: number;
  breadthAt?: (timestamp: number) => number | null;
  btcDataset?: HistoricalDataset;
  ethDataset?: HistoricalDataset;
}

interface TimeframeStats {
  candles: Candle[];
  emaFast: Array<number | null>;
  emaSlow: Array<number | null>;
}

export function buildFeatureFrames(
  dataset: HistoricalDataset,
  options: FeatureFrameBuildOptions = {},
): FeatureFrame[] {
  const candles = dataset.candles["15m"];
  const values = closes(candles);
  const fastValues = ema(values, 20);
  const slowValues = ema(values, 50);
  const atrValues = atr(candles, 14);
  const rsiValues = rsi(values, 14);
  const volumeValues = volumeRatio(candles, 20);
  const atrPercentValues = atrValues.map((value, index) => (
    value !== null && values[index] > 0 ? value / values[index] : null
  ));
  const oneHourStats = buildTimeframeStats(dataset.candles["1h"] ?? []);
  const fourHourStats = buildTimeframeStats(dataset.candles["4h"] ?? []);
  const btcStats = options.btcDataset ? buildTimeframeStats(options.btcDataset.candles["4h"] ?? []) : null;
  const ethStats = options.ethDataset ? buildTimeframeStats(options.ethDataset.candles["4h"] ?? []) : null;
  const start = options.startTime ?? candles[0]?.closeTime ?? 0;
  const end = options.endTime ?? candles.at(-1)?.closeTime ?? Number.POSITIVE_INFINITY;
  const stride = Math.max(1, Math.floor(options.entryStrideBars ?? 4));
  const minimumIndex = 100;
  const frames: FeatureFrame[] = [];

  for (let index = minimumIndex; index < candles.length - 1; index += stride) {
    const candle = candles[index];
    if (candle.closeTime < start || candle.closeTime > end) continue;
    const currentAtr = atrValues[index];
    if (currentAtr === null || currentAtr <= 0) continue;
    const currentClose = candle.close;
    const priorAtrPercents = atrPercentValues
      .slice(Math.max(0, index - 100), index)
      .filter((value): value is number => value !== null);
    const currentAtrPercent = atrPercentValues[index];
    const priorAtrAverage = average(priorAtrPercents.slice(-20));
    const fast = fastValues[index];
    const slow = slowValues[index];
    const signalTimestamp = candle.closeTime;
    const oneHourIndex = lastIndexAtOrBefore(oneHourStats.candles, signalTimestamp);
    const fourHourIndex = lastIndexAtOrBefore(fourHourStats.candles, signalTimestamp);
    const btcIndex = btcStats ? lastIndexAtOrBefore(btcStats.candles, signalTimestamp) : -1;
    const ethIndex = ethStats ? lastIndexAtOrBefore(ethStats.candles, signalTimestamp) : -1;
    const oneHourRegime = regimeFromStats(oneHourStats, oneHourIndex);
    const fourHourRegime = regimeFromStats(fourHourStats, fourHourIndex);
    const btcRegime = regimeFromStats(btcStats, btcIndex);
    const ethRegime = regimeFromStats(ethStats, ethIndex);
    const breakoutHigh20 = rollingHigh(candles, index, 20);
    const breakoutLow20 = rollingLow(candles, index, 20);
    const compression = compressionStats(candles, atrValues, index, 12);
    const longPullbackDepth = pullbackDepth(candles, index, currentAtr, "LONG");
    const shortPullbackDepth = pullbackDepth(candles, index, currentAtr, "SHORT");
    const longRetest = retestStats(candles, atrValues, index, "LONG");
    const shortRetest = retestStats(candles, atrValues, index, "SHORT");
    const benchmarkAgreement = btcRegime !== "UNKNOWN" && ethRegime !== "UNKNOWN"
      ? btcRegime === ethRegime
      : null;
    frames.push({
      index,
      signalTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: currentClose,
      atr: currentAtr,
      atrPercentile: percentileRank(priorAtrPercents, currentAtrPercent),
      emaFast: fast,
      emaSlow: slow,
      trendSlope: fast === null || fastValues[index - 5] === null || fast === 0
        ? null
        : (fast - fastValues[index - 5]!) / fast,
      bullTrendAge: consecutiveTrendAge(fastValues, slowValues, index, "BULL"),
      bearTrendAge: consecutiveTrendAge(fastValues, slowValues, index, "BEAR"),
      marketRegime: regimeFromStats({ candles, emaFast: fastValues, emaSlow: slowValues }, index),
      btcRegime,
      ethRegime,
      breadth: options.breadthAt?.(signalTimestamp) ?? null,
      btcEthAgreement: benchmarkAgreement,
      rsi: rsiValues[index],
      previousRsi: rsiValues[index - 1] ?? null,
      momentumAcceleration: momentumAcceleration(values, index, currentAtr),
      volumeRatio: volumeValues[index],
      previousVolumeRatio: volumeValues[index - 1] ?? null,
      volatilityPercentile: percentileRank(priorAtrPercents, currentAtrPercent),
      volatilityExpansion: priorAtrAverage && currentAtrPercent !== null
        ? currentAtrPercent / priorAtrAverage
        : null,
      funding: lastFundingAtOrBefore(dataset, signalTimestamp),
      fundingPercentile: fundingPercentile(dataset, signalTimestamp),
      breakoutHigh20,
      breakoutLow20,
      compressionBars: compression.bars,
      compressionRangeATR: compression.rangeATR,
      longPullbackDepth,
      shortPullbackDepth,
      longEntryExtensionATR: fast === null ? null : (currentClose - fast) / currentAtr,
      shortEntryExtensionATR: fast === null ? null : (fast - currentClose) / currentAtr,
      longDistanceToEMA: fast === null ? null : Math.abs(currentClose - fast) / currentAtr,
      shortDistanceToEMA: fast === null ? null : Math.abs(currentClose - fast) / currentAtr,
      longRetestDepth: longRetest.depth,
      shortRetestDepth: shortRetest.depth,
      longRetestDuration: longRetest.duration,
      shortRetestDuration: shortRetest.duration,
      oneHourRegime,
      fourHourRegime,
      oneHourClose: oneHourIndex >= 0 ? oneHourStats.candles[oneHourIndex].close : null,
      oneHourEmaFast: oneHourIndex >= 0 ? oneHourStats.emaFast[oneHourIndex] : null,
      oneHourEmaSlow: oneHourIndex >= 0 ? oneHourStats.emaSlow[oneHourIndex] : null,
      fourHourClose: fourHourIndex >= 0 ? fourHourStats.candles[fourHourIndex].close : null,
      fourHourEmaFast: fourHourIndex >= 0 ? fourHourStats.emaFast[fourHourIndex] : null,
      fourHourEmaSlow: fourHourIndex >= 0 ? fourHourStats.emaSlow[fourHourIndex] : null,
    });
  }
  return frames;
}

export function toSignalFeatureSnapshot(
  frame: FeatureFrame,
  side: Side,
  candidateFamily: SignalFeatureFamily,
  score: number,
): SignalFeatureSnapshot {
  const long = side === "LONG";
  return {
    strategyVersion: V53_STRATEGY_VERSION,
    symbol: "",
    side,
    signalTimestamp: frame.signalTimestamp,
    marketRegime: frame.marketRegime,
    btcRegime: frame.btcRegime,
    ethRegime: frame.ethRegime,
    breadth: frame.breadth,
    atr: frame.atr,
    atrPercentile: frame.atrPercentile,
    trendSlope: frame.trendSlope,
    trendAge: long ? frame.bullTrendAge : frame.bearTrendAge,
    breakoutDistance: long
      ? relativeDistance(frame.close, frame.breakoutHigh20, frame.atr)
      : relativeDistance(frame.breakoutLow20, frame.close, frame.atr),
    entryExtensionATR: long ? frame.longEntryExtensionATR : frame.shortEntryExtensionATR,
    distanceToEMA: long ? frame.longDistanceToEMA : frame.shortDistanceToEMA,
    pullbackDepth: long ? frame.longPullbackDepth : frame.shortPullbackDepth,
    retestDepth: long ? frame.longRetestDepth : frame.shortRetestDepth,
    retestDuration: long ? frame.longRetestDuration : frame.shortRetestDuration,
    rsi: frame.rsi,
    momentumAcceleration: frame.momentumAcceleration,
    volumeRatio: frame.volumeRatio,
    volatilityPercentile: frame.volatilityPercentile,
    volatilityExpansion: frame.volatilityExpansion,
    btcEthAgreement: frame.btcEthAgreement,
    funding: frame.funding,
    fundingPercentile: frame.fundingPercentile,
    setupAge: frame.compressionBars > 0 ? frame.compressionBars : (long ? frame.bullTrendAge : frame.bearTrendAge),
    score,
    candidateFamily,
  };
}

export function serializeSignalFeatureSnapshot(snapshot: SignalFeatureSnapshot): SignalFeatureSnapshot {
  return { ...snapshot };
}

export function withSnapshotIdentity(
  snapshot: SignalFeatureSnapshot,
  symbol: string,
): SignalFeatureSnapshot {
  return { ...snapshot, symbol };
}

function buildTimeframeStats(candles: Candle[]): TimeframeStats {
  return {
    candles,
    emaFast: ema(closes(candles), 20),
    emaSlow: ema(closes(candles), 50),
  };
}

function regimeFromStats(
  stats: TimeframeStats | null,
  index: number,
): MarketRegime {
  if (!stats || index < 5 || index >= stats.candles.length) return "UNKNOWN";
  const fast = stats.emaFast[index];
  const slow = stats.emaSlow[index];
  const previous = stats.emaFast[index - 5];
  if (fast === null || slow === null || previous === null || fast === 0) return "UNKNOWN";
  const slope = (fast - previous) / fast;
  if (fast > slow && slope > 0.002) return "BULL";
  if (fast < slow && slope < -0.002) return "BEAR";
  return "RANGE";
}

function rollingHigh(candles: Candle[], index: number, period: number): number | null {
  const window = candles.slice(Math.max(0, index - period), index);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function rollingLow(candles: Candle[], index: number, period: number): number | null {
  const window = candles.slice(Math.max(0, index - period), index);
  return window.length < period ? null : Math.min(...window.map((candle) => candle.low));
}

function compressionStats(
  candles: Candle[],
  atrValues: Array<number | null>,
  index: number,
  period: number,
): { bars: number; rangeATR: number | null } {
  const window = candles.slice(Math.max(0, index - period), index);
  const currentAtr = atrValues[index];
  if (window.length < period || currentAtr === null || currentAtr <= 0) return { bars: 0, rangeATR: null };
  const range = Math.max(...window.map((candle) => candle.high)) - Math.min(...window.map((candle) => candle.low));
  let bars = 0;
  for (let cursor = index - 1; cursor >= 0 && bars < period; cursor -= 1) {
    const candleAtr = atrValues[cursor];
    if (candleAtr === null || candles[cursor].high - candles[cursor].low > candleAtr * 1.5) break;
    bars += 1;
  }
  return { bars, rangeATR: range / currentAtr };
}

function pullbackDepth(candles: Candle[], index: number, currentAtr: number, side: Side): number | null {
  const window = candles.slice(Math.max(0, index - 12), index);
  if (window.length < 6 || currentAtr <= 0) return null;
  if (side === "LONG") {
    const priorHigh = Math.max(...window.map((candle) => candle.high));
    return Math.max(0, (priorHigh - Math.min(...window.slice(-6).map((candle) => candle.low))) / currentAtr);
  }
  const priorLow = Math.min(...window.map((candle) => candle.low));
  return Math.max(0, (Math.max(...window.slice(-6).map((candle) => candle.high)) - priorLow) / currentAtr);
}

function retestStats(
  candles: Candle[],
  atrValues: Array<number | null>,
  index: number,
  side: Side,
): { depth: number | null; duration: number | null } {
  if (index < 22) return { depth: null, duration: null };
  const level = side === "LONG" ? rollingHigh(candles, index - 1, 20) : rollingLow(candles, index - 1, 20);
  const currentAtr = atrValues[index];
  if (level === null || currentAtr === null || currentAtr <= 0) return { depth: null, duration: null };
  const current = candles[index];
  const distance = side === "LONG" ? Math.abs(current.low - level) : Math.abs(current.high - level);
  let duration = 0;
  for (let cursor = index; cursor >= Math.max(0, index - 8); cursor -= 1) {
    const candle = candles[cursor];
    const touch = side === "LONG"
      ? Math.abs(candle.low - level) <= currentAtr * 0.75
      : Math.abs(candle.high - level) <= currentAtr * 0.75;
    if (!touch) break;
    duration += 1;
  }
  return { depth: distance / currentAtr, duration };
}

function momentumAcceleration(values: number[], index: number, currentAtr: number): number | null {
  if (index < 6 || currentAtr <= 0) return null;
  const recent = values[index] - values[index - 3];
  const prior = values[index - 3] - values[index - 6];
  return (recent - prior) / currentAtr;
}

function consecutiveTrendAge(
  fastValues: Array<number | null>,
  slowValues: Array<number | null>,
  index: number,
  direction: "BULL" | "BEAR",
): number {
  let age = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const fast = fastValues[cursor];
    const slow = slowValues[cursor];
    const aligned = fast !== null && slow !== null && (direction === "BULL" ? fast > slow : fast < slow);
    if (!aligned) break;
    age += 1;
    if (age >= 500) break;
  }
  return age;
}

function percentileRank(values: number[], current: number | null): number | null {
  if (current === null || values.length < 10) return null;
  return values.filter((value) => value <= current).length / values.length;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function relativeDistance(numerator: number | null, denominator: number | null, atrValue: number): number | null {
  if (numerator === null || denominator === null || atrValue <= 0) return null;
  return (numerator - denominator) / atrValue;
}

function lastFundingAtOrBefore(dataset: HistoricalDataset, timestamp: number): number | null {
  const values = (dataset.fundingRates ?? []).filter((point) => point.fundingTime <= timestamp);
  return values.at(-1)?.fundingRate ?? null;
}

function fundingPercentile(dataset: HistoricalDataset, timestamp: number): number | null {
  const rates = (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime <= timestamp)
    .map((point) => point.fundingRate);
  const current = rates.at(-1) ?? null;
  return percentileRank(rates.slice(-100, -1), current);
}

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}
