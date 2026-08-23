import type { Candle, Instrument } from "./types";

export type UniversePolicyMode = "RESEARCH" | "LIVE_SNAPSHOT";
export type LiquidityWindowLabel = "FULL_HISTORY" | "PERSISTED_ROLLING" | "SHORT_WINDOW_PROXY";

export interface UniversePolicy {
  mode: UniversePolicyMode;
  minimumListingAgeDays: number;
  minimumHistoryDays: number;
  minimumLiveHistoryCandles: number;
  minimumCompleteness: number;
  minimumMedianQuoteVolume: number;
  liquidityLookbackCandles: number;
  liquidityWindowLabel: LiquidityWindowLabel;
  minimumAtrPercent: number;
  maximumAtrPercent: number;
  maximumVolumeSpikeRatio: number;
  staleCandleMinutes: number;
  orderBookAvailability: "UNAVAILABLE" | "PROXY" | "AVAILABLE";
  breadthUniverseSize: number;
}

export const DEFAULT_UNIVERSE_POLICY: UniversePolicy = {
  mode: "RESEARCH",
  minimumListingAgeDays: 90,
  minimumHistoryDays: 365,
  minimumLiveHistoryCandles: 200,
  minimumCompleteness: 0.98,
  minimumMedianQuoteVolume: 0,
  liquidityLookbackCandles: 30 * 24 * 4,
  liquidityWindowLabel: "FULL_HISTORY",
  minimumAtrPercent: 0.0005,
  maximumAtrPercent: 0.25,
  maximumVolumeSpikeRatio: 20,
  staleCandleMinutes: 45,
  orderBookAvailability: "UNAVAILABLE",
  breadthUniverseSize: 50,
};

export const DEFAULT_LIVE_UNIVERSE_POLICY: UniversePolicy = {
  ...DEFAULT_UNIVERSE_POLICY,
  mode: "LIVE_SNAPSHOT",
  minimumHistoryDays: 0,
  minimumLiveHistoryCandles: 200,
  liquidityLookbackCandles: 250,
  liquidityWindowLabel: "SHORT_WINDOW_PROXY",
};

export function normalizeUniversePolicy(input: Partial<UniversePolicy> | undefined): UniversePolicy {
  return {
    ...DEFAULT_UNIVERSE_POLICY,
    ...input,
    mode: input?.mode ?? "RESEARCH",
    minimumLiveHistoryCandles: Math.max(1, Math.floor(input?.minimumLiveHistoryCandles ?? DEFAULT_UNIVERSE_POLICY.minimumLiveHistoryCandles)),
    liquidityLookbackCandles: Math.max(1, Math.floor(input?.liquidityLookbackCandles ?? DEFAULT_UNIVERSE_POLICY.liquidityLookbackCandles)),
    breadthUniverseSize: Math.max(2, Math.floor(input?.breadthUniverseSize ?? DEFAULT_UNIVERSE_POLICY.breadthUniverseSize)),
  };
}

export function liveSnapshotUniversePolicy(input: Partial<UniversePolicy> | undefined): UniversePolicy {
  const normalized = normalizeUniversePolicy(input);
  const snapshotLookback = Math.min(
    normalized.liquidityLookbackCandles,
    normalized.minimumLiveHistoryCandles,
  );
  return {
    ...normalized,
    mode: "LIVE_SNAPSHOT",
    minimumHistoryDays: 0,
    liquidityLookbackCandles: snapshotLookback,
    liquidityWindowLabel: normalized.liquidityWindowLabel === "FULL_HISTORY"
      ? "SHORT_WINDOW_PROXY"
      : normalized.liquidityWindowLabel,
  };
}

export interface UniverseQualityFeatures {
  listingAgeDays: number;
  historicalCoverageDays: number;
  candleCompleteness: number;
  medianQuoteVolume7d: number;
  medianQuoteVolume30d: number;
  atrPercent: number;
  abnormalVolumeSpike: boolean;
  staleCandle: boolean;
  priceSane: boolean;
  orderBookAvailability: UniversePolicy["orderBookAvailability"];
  liquidityWindowLabel: LiquidityWindowLabel;
  liquidityLookbackCandles: number;
}

export interface UniverseQualityResult {
  eligible: boolean;
  reasons: Array<"NOT_TRADING" | "LISTING_AGE" | "HISTORY" | "INCOMPLETE_HISTORY" | "LIQUIDITY" | "VOLATILITY" | "ABNORMAL_VOLUME" | "STALE_DATA" | "PRICE_SANITY">;
  features: UniverseQualityFeatures;
}

export function evaluateUniverseQuality(
  instrument: Instrument,
  candles: Candle[],
  now = Date.now(),
  policyInput: Partial<UniversePolicy> = DEFAULT_UNIVERSE_POLICY,
): UniverseQualityResult {
  const policy = normalizeUniversePolicy(policyInput);
  const firstOpen = candles[0]?.openTime ?? now;
  const lastClose = candles.at(-1)?.closeTime ?? 0;
  const expectedInterval = 15 * 60 * 1000;
  const expectedCandles = Math.max(1, Math.floor(Math.max(0, lastClose - firstOpen) / expectedInterval) + 1);
  const candleCompleteness = candles.length / expectedCandles;
  const historicalCoverageDays = Math.max(0, (lastClose - firstOpen) / 86_400_000);
  const listingAgeDays = instrument.onboardDate === undefined
    ? 0
    : Math.max(0, (now - instrument.onboardDate) / 86_400_000);
  const closes = candles.map((candle) => candle.close).filter((value) => Number.isFinite(value) && value > 0);
  const lastPrice = closes.at(-1) ?? 0;
  const trueRangePercents = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    if (previousClose <= 0) return Number.NaN;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    return trueRange / previousClose;
  }).filter(Number.isFinite);
  const atrWindow = trueRangePercents.slice(-14);
  const atrPercent = atrWindow.length === 0
    ? 0
    : atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
  const quoteVolumes = candles
    .map((candle) => candle.volume * candle.close)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const recentMedian = median(quoteVolumes.slice(-policy.liquidityLookbackCandles));
  const maximumVolume = quoteVolumes.length === 0 ? 0 : Math.max(...quoteVolumes);
  const abnormalVolumeSpike = recentMedian > 0 && maximumVolume / recentMedian > policy.maximumVolumeSpikeRatio;
  const staleCandle = lastClose <= 0 || now - lastClose > policy.staleCandleMinutes * 60_000;
  const priceSane = lastPrice > 0 && candles.every((candle) => candle.low >= 0 && candle.high >= candle.low && candle.close > 0);
  const features: UniverseQualityFeatures = {
    listingAgeDays,
    historicalCoverageDays,
    candleCompleteness,
    medianQuoteVolume7d: median(quoteVolumes.slice(-7 * 24 * 4)),
    medianQuoteVolume30d: recentMedian,
    atrPercent,
    abnormalVolumeSpike,
    staleCandle,
    priceSane,
    orderBookAvailability: policy.orderBookAvailability,
    liquidityWindowLabel: policy.liquidityWindowLabel,
    liquidityLookbackCandles: policy.liquidityLookbackCandles,
  };
  const reasons: UniverseQualityResult["reasons"] = [];
  if (instrument.status !== "TRADING") reasons.push("NOT_TRADING");
  if (listingAgeDays < policy.minimumListingAgeDays) reasons.push("LISTING_AGE");
  if (policy.mode === "RESEARCH" && historicalCoverageDays < policy.minimumHistoryDays) reasons.push("HISTORY");
  if (policy.mode === "LIVE_SNAPSHOT" && candles.length < policy.minimumLiveHistoryCandles) reasons.push("HISTORY");
  if (candleCompleteness < policy.minimumCompleteness) reasons.push("INCOMPLETE_HISTORY");
  if (features.medianQuoteVolume30d < policy.minimumMedianQuoteVolume) reasons.push("LIQUIDITY");
  if (atrPercent < policy.minimumAtrPercent || atrPercent > policy.maximumAtrPercent) reasons.push("VOLATILITY");
  if (abnormalVolumeSpike) reasons.push("ABNORMAL_VOLUME");
  if (staleCandle) reasons.push("STALE_DATA");
  if (!priceSane) reasons.push("PRICE_SANITY");
  return { eligible: reasons.length === 0, reasons, features };
}

export function closedCandleOnly(candles: Candle[], asOf: number): Candle[] {
  return candles.filter((candle) => candle.closeTime <= asOf).sort((left, right) => left.closeTime - right.closeTime);
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
