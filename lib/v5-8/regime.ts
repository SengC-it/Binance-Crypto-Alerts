import type { HistoricalDataset } from "@/lib/backtest/types";
import { closes, ema } from "@/lib/core/indicators";
import type { Candle, MarketRegime } from "@/lib/core/types";
import {
  calculateMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import {
  calculateCvar95,
  runIndependentCandidate,
  V561_CANDIDATE_REGISTRY,
  type V561Trade,
} from "@/lib/v5-6-1/research";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";

export const V58_PRIMARY_EDGE_ID = "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01";
export const V58_PRIMARY_EDGE_FAMILY = "FAILED_BREAKOUT_REVERSAL" as const;
export const V58_DEV_START = Date.parse("2021-01-01T00:00:00.000Z");
export const V58_BURNED_EXTERNAL_START = Date.parse("2021-01-01T00:00:00.000Z");
export const V58_BURNED_EXTERNAL_END = Date.parse("2023-07-31T23:59:59.999Z");
export const V58_LOCAL_DEVELOPMENT_START = Date.parse("2023-08-10T02:15:00.000Z");
export const V58_LOCAL_DEVELOPMENT_END = Date.parse("2026-08-09T02:14:59.999Z");
export const V58_FRESH_START = Date.parse("2020-01-01T00:00:00.000Z");
export const V58_FRESH_END = Date.parse("2020-12-31T23:59:59.999Z");
export const V58_FRESH_MANIFEST_ID = "v58-fresh-binance-2020-01-01-2020-12-31";
export const V58_FEE_RATE = 0.0004;
export const V58_BASE_SLIPPAGE_BPS = 2;
export const V58_RISK_PER_TRADE_USDT = 50;
export const V58_COOLDOWN_HOURS = 8;
export const V58_MAX_REGIME_GATES = 8;
export const V58_FRESH_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "LTCUSDT"] as const;
export const V58_FRESH_SYMBOL_EFFECTIVE_STARTS: Record<typeof V58_FRESH_SYMBOLS[number], number> = {
  BTCUSDT: V58_FRESH_START,
  ETHUSDT: V58_FRESH_START,
  BNBUSDT: Date.parse("2020-02-01T00:00:00.000Z"),
  XRPUSDT: V58_FRESH_START,
  LTCUSDT: V58_FRESH_START,
};

export type V58Pool = "DEVELOPMENT" | "BURNED_EXTERNAL" | "FRESH_VALIDATION";

export type V58RegimeDimension =
  | "marketRegime"
  | "btcRegime"
  | "ethRegime"
  | "btcEthAlignment"
  | "breadthBucket"
  | "atrPercentileBucket"
  | "volatilityPercentileBucket"
  | "fundingPercentileBucket"
  | "trendAgeBucket"
  | "marketWideMomentumBucket"
  | "btc24hTrend"
  | "btc7dTrend"
  | "crossSectionalDispersionBucket"
  | "liquidityVolumeBucket";

export interface V58RegimeLabels {
  marketRegime: MarketRegime;
  btcRegime: MarketRegime;
  ethRegime: MarketRegime;
  btcEthAlignment: "ALIGNED_BULL" | "ALIGNED_BEAR" | "ALIGNED_RANGE" | "CONFLICT" | "UNKNOWN";
  breadthBucket: "LT_25" | "25_50" | "50_75" | "GTE_75" | "UNKNOWN";
  atrPercentileBucket: "LOW" | "MID" | "HIGH" | "UNKNOWN";
  volatilityPercentileBucket: "LOW" | "MID" | "HIGH" | "UNKNOWN";
  fundingPercentileBucket: "LOW" | "MID" | "HIGH" | "UNKNOWN";
  trendAgeBucket: "0_15" | "16_47" | "48_119" | "120_PLUS" | "UNKNOWN";
  marketWideMomentumBucket: "BEARISH" | "NEUTRAL" | "BULLISH" | "UNKNOWN";
  btc24hTrend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  btc7dTrend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  crossSectionalDispersionBucket: "LOW" | "MID" | "HIGH" | "UNKNOWN";
  liquidityVolumeBucket: "LOW" | "NORMAL" | "HIGH" | "UNKNOWN";
}

export interface V58RegimeGateCondition {
  dimension: V58RegimeDimension;
  allowedValues: readonly string[];
}

export interface V58RegimeGateDefinition {
  id: string;
  hypothesis: string;
  economicLogic: string;
  conditions: readonly V58RegimeGateCondition[];
}

/**
 * This registry is deliberately finite and frozen. A gate only filters the
 * frozen Primary trade set; it cannot change the detector, plan, or costs.
 */
export const V58_REGIME_GATE_REGISTRY: readonly V58RegimeGateDefinition[] = [
  {
    id: "V58-GATE-BTC-ETH-NON-CONFLICT",
    hypothesis: "The failed-breakout reversal is less exposed when BTC and ETH do not disagree on direction.",
    economicLogic: "Cross-market disagreement increases false reversals and continuation risk; agreement reduces that conflict.",
    conditions: [{ dimension: "btcEthAlignment", allowedValues: ["ALIGNED_BULL", "ALIGNED_BEAR", "ALIGNED_RANGE"] }],
  },
  {
    id: "V58-GATE-BTC-ETH-BEAR-ALIGNMENT",
    hypothesis: "A short reversal is more credible when both benchmark assets are already in a bearish regime.",
    economicLogic: "Broad risk reduction can provide follow-through after a failed upside breakout instead of a single-asset squeeze.",
    conditions: [{ dimension: "btcEthAlignment", allowedValues: ["ALIGNED_BEAR"] }],
  },
  {
    id: "V58-GATE-PRIMARY-CONTEXT-BULL-RANGE",
    hypothesis: "The frozen failed-breakout setup is most specific during local bullish exhaustion or range transition.",
    economicLogic: "The signal requires trapped upside demand; a confirmed bear trend can instead make the setup a late continuation entry.",
    conditions: [{ dimension: "marketRegime", allowedValues: ["BULL", "RANGE"] }],
  },
  {
    id: "V58-GATE-BREADTH-NOT-EXTREME",
    hypothesis: "Moderate breadth avoids both broad capitulation and indiscriminate risk-on conditions.",
    economicLogic: "A balanced cross-section leaves room for a local failed breakout to mean-revert without requiring a market-wide reversal.",
    conditions: [{ dimension: "breadthBucket", allowedValues: ["25_50", "50_75"] }],
  },
  {
    id: "V58-GATE-ATR-MID-RANGE",
    hypothesis: "Mid-range ATR percentile avoids fragile signals in both compressed and shock-volatility conditions.",
    economicLogic: "Moderate range expansion supports executable stops while reducing noise and gap-like stop risk.",
    conditions: [{ dimension: "atrPercentileBucket", allowedValues: ["MID"] }],
  },
  {
    id: "V58-GATE-VOLATILITY-NOT-EXTREME",
    hypothesis: "Non-extreme realized volatility makes the frozen structural plan less sensitive to immediate shock moves.",
    economicLogic: "The plan assumes a bounded reversal; volatility shocks can invalidate both stop distance and follow-through assumptions.",
    conditions: [{ dimension: "volatilityPercentileBucket", allowedValues: ["LOW", "MID"] }],
  },
  {
    id: "V58-GATE-FUNDING-NOT-EXTREME",
    hypothesis: "Avoiding extreme funding regimes reduces forced-positioning distortions around the reversal.",
    economicLogic: "Moderate funding is a proxy for less crowded positioning and fewer liquidation-driven false signals.",
    conditions: [{ dimension: "fundingPercentileBucket", allowedValues: ["MID"] }],
  },
  {
    id: "V58-GATE-COMBINED-MARKET-STATE",
    hypothesis: "A fixed combination of agreement, moderate breadth, volatility, and funding captures the full structural context.",
    economicLogic: "The combined gate requires a non-conflicting market, executable breadth, and non-extreme positioning without altering the signal itself.",
    conditions: [
      { dimension: "btcEthAlignment", allowedValues: ["ALIGNED_BULL", "ALIGNED_BEAR", "ALIGNED_RANGE"] },
      { dimension: "breadthBucket", allowedValues: ["25_50", "50_75"] },
      { dimension: "volatilityPercentileBucket", allowedValues: ["LOW", "MID"] },
      { dimension: "fundingPercentileBucket", allowedValues: ["MID"] },
    ],
  },
];

export interface V58RegimeTrade extends V561Trade {
  pool: V58Pool;
  labels: V58RegimeLabels;
}

export interface V58MetricSummary {
  trades: number;
  wins: number;
  losses: number;
  netR: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownR: number;
  cvar95: number | null;
  stopRate: number | null;
  positivePeriods: number;
  periods: number;
  positivePeriodRatio: number | null;
  totalNetPnlUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
}

export function runFrozenPrimaryPool(
  datasets: HistoricalDataset[],
  startTime: number,
  endTime: number,
  pool: V58Pool,
): V58RegimeTrade[] {
  const definition = V561_CANDIDATE_REGISTRY.find((candidate) => candidate.id === V58_PRIMARY_EDGE_ID);
  if (!definition) throw new Error(`Missing frozen Primary ${V58_PRIMARY_EDGE_ID}`);
  const breadth = buildBreadthLookup(datasets, startTime, endTime);
  const btcDataset = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const ethDataset = datasets.find((dataset) => dataset.symbol === "ETHUSDT");
  const trades: V58RegimeTrade[] = [];
  for (const dataset of datasets) {
    const frames = buildFeatureFrames(dataset, {
      startTime,
      endTime,
      entryStrideBars: 4,
      breadthAt: breadth.at,
      btcDataset,
      ethDataset,
    });
    const frameBySignalTime = new Map(frames.map((frame) => [frame.signalTimestamp, frame]));
    const primaryTrades = runIndependentCandidate(dataset, frames, definition, {
      startTime,
      endTime,
      takerFeeRate: V58_FEE_RATE,
      slippageBps: V58_BASE_SLIPPAGE_BPS,
      riskPerTradeUsdt: V58_RISK_PER_TRADE_USDT,
      cooldownHours: V58_COOLDOWN_HOURS,
    });
    for (const trade of primaryTrades) {
      const frame = frameBySignalTime.get(trade.signalCandleCloseTime);
      if (!frame) continue;
      trades.push({ ...trade, pool, labels: buildRegimeLabels(frame, datasets) });
    }
  }
  return trades.sort((left, right) => left.entryTime - right.entryTime || left.symbol.localeCompare(right.symbol));
}

export function buildRegimeLabels(frame: FeatureFrame, datasets: HistoricalDataset[]): V58RegimeLabels {
  return {
    marketRegime: frame.marketRegime,
    btcRegime: frame.btcRegime,
    ethRegime: frame.ethRegime,
    btcEthAlignment: alignment(frame.btcRegime, frame.ethRegime),
    breadthBucket: bucketBreadth(frame.breadth),
    atrPercentileBucket: bucketPercentile(frame.atrPercentile, 0.2, 0.8),
    volatilityPercentileBucket: bucketPercentile(frame.volatilityPercentile, 0.2, 0.8),
    fundingPercentileBucket: bucketPercentile(frame.fundingPercentile, 0.1, 0.9),
    trendAgeBucket: bucketTrendAge(frame.bearTrendAge),
    marketWideMomentumBucket: marketWideMomentum([frame.marketRegime, frame.btcRegime, frame.ethRegime]),
    btc24hTrend: benchmarkTrend(datasets.find((dataset) => dataset.symbol === "BTCUSDT"), frame.signalTimestamp, 24, 0.02),
    btc7dTrend: benchmarkTrend(datasets.find((dataset) => dataset.symbol === "BTCUSDT"), frame.signalTimestamp, 24 * 7, 0.05),
    crossSectionalDispersionBucket: crossSectionalDispersion(datasets, frame.signalTimestamp),
    liquidityVolumeBucket: bucketVolume(frame.volumeRatio),
  };
}

export function matchesRegimeGate(labels: V58RegimeLabels, gate: V58RegimeGateDefinition): boolean {
  return gate.conditions.every((condition) => condition.allowedValues.includes(labels[condition.dimension]));
}

export function applyRegimeGate<T extends { labels: V58RegimeLabels }>(trades: T[], gate: V58RegimeGateDefinition): T[] {
  return trades.filter((trade) => matchesRegimeGate(trade.labels, gate));
}

export function summarizeRegimeTrades(trades: ValidationTrade[]): V58MetricSummary {
  const metrics = calculateMetrics(trades);
  const stopCount = trades.filter((trade) => "exitReason" in trade && trade.exitReason === "STOP").length;
  return {
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    netR: metrics.netR,
    avgR: metrics.avgNetR,
    profitFactor: metrics.profitFactor,
    maxDrawdownR: metrics.maxDrawdownR,
    cvar95: calculateCvar95(trades),
    stopRate: metrics.trades > 0 ? stopCount / metrics.trades : null,
    positivePeriods: metrics.positiveMonths,
    periods: metrics.months,
    positivePeriodRatio: metrics.positiveMonthRatio,
    totalNetPnlUsdt: metrics.totalNetPnlUsdt,
    totalFeesUsdt: metrics.totalFeesUsdt,
    totalFundingUsdt: metrics.totalFundingUsdt,
    totalSlippageUsdt: metrics.totalSlippageUsdt,
  };
}

export interface V58FreshGateResult {
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  raw: V58MetricSummary;
  gated: V58MetricSummary;
  gate: Record<string, boolean>;
  selectedGate: string;
}

export function evaluateFreshPromotionGate(trades: V58RegimeTrade[], gate: V58RegimeGateDefinition): V58FreshGateResult {
  const gatedTrades = applyRegimeGate(trades, gate);
  const raw = summarizeRegimeTrades(trades);
  const gated = summarizeRegimeTrades(gatedTrades);
  const gateChecks = {
    trades: gated.trades >= 20,
    netR: gated.netR > 0,
    avgR: gated.avgR > 0,
    profitFactor: gated.profitFactor > 1,
  };
  return {
    status: gated.trades < 20 ? "INCONCLUSIVE" : Object.values(gateChecks).every(Boolean) ? "PASS" : "FAIL",
    raw,
    gated,
    gate: gateChecks,
    selectedGate: gate.id,
  };
}

function buildBreadthLookup(datasets: HistoricalDataset[], start: number, end: number): { at: (timestamp: number) => number | null } {
  const buckets = new Map<number, { bull: number; total: number }>();
  for (const dataset of datasets) {
    const candles = dataset.candles["1h"] ?? [];
    const fast = ema(closes(candles), 20);
    const slow = ema(closes(candles), 50);
    for (let index = 50; index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.closeTime < start || candle.closeTime > end) continue;
      const regime = regimeFromValues(fast, slow, index);
      if (regime === "UNKNOWN") continue;
      const bucket = buckets.get(candle.closeTime) ?? { bull: 0, total: 0 };
      bucket.total += 1;
      if (regime === "BULL") bucket.bull += 1;
      buckets.set(candle.closeTime, bucket);
    }
  }
  const timestamps = [...buckets.keys()].sort((left, right) => left - right);
  const values = timestamps.map((timestamp) => {
    const value = buckets.get(timestamp)!;
    return value.total > 0 ? value.bull / value.total : null;
  });
  return { at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) };
}

function alignment(btc: MarketRegime, eth: MarketRegime): V58RegimeLabels["btcEthAlignment"] {
  if (btc === "UNKNOWN" || eth === "UNKNOWN") return "UNKNOWN";
  if (btc !== eth) return "CONFLICT";
  if (btc === "BULL") return "ALIGNED_BULL";
  if (btc === "BEAR") return "ALIGNED_BEAR";
  return "ALIGNED_RANGE";
}

function bucketBreadth(value: number | null): V58RegimeLabels["breadthBucket"] {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value < 0.25) return "LT_25";
  if (value < 0.5) return "25_50";
  if (value < 0.75) return "50_75";
  return "GTE_75";
}

function bucketPercentile(value: number | null, low: number, high: number): "LOW" | "MID" | "HIGH" | "UNKNOWN" {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value <= low) return "LOW";
  if (value <= high) return "MID";
  return "HIGH";
}

function bucketTrendAge(value: number): V58RegimeLabels["trendAgeBucket"] {
  if (!Number.isFinite(value) || value < 0) return "UNKNOWN";
  if (value <= 15) return "0_15";
  if (value <= 47) return "16_47";
  if (value <= 119) return "48_119";
  return "120_PLUS";
}

function marketWideMomentum(regimes: MarketRegime[]): V58RegimeLabels["marketWideMomentumBucket"] {
  const known = regimes.filter((regime) => regime !== "UNKNOWN");
  if (known.length === 0) return "UNKNOWN";
  const score = known.reduce((sum, regime) => sum + (regime === "BULL" ? 1 : regime === "BEAR" ? -1 : 0), 0) / known.length;
  if (score > 0.33) return "BULLISH";
  if (score < -0.33) return "BEARISH";
  return "NEUTRAL";
}

function benchmarkTrend(dataset: HistoricalDataset | undefined, timestamp: number, lookbackBars: number, threshold: number): V58RegimeLabels["btc24hTrend"] {
  const candles = dataset?.candles["1h"] ?? [];
  const index = lastIndexAtOrBefore(candles, timestamp);
  if (index < lookbackBars || !Number.isFinite(candles[index]?.close) || !Number.isFinite(candles[index - lookbackBars]?.close) || candles[index - lookbackBars].close <= 0) return "UNKNOWN";
  const change = candles[index].close / candles[index - lookbackBars].close - 1;
  if (change >= threshold) return "UP";
  if (change <= -threshold) return "DOWN";
  return "FLAT";
}

function crossSectionalDispersion(datasets: HistoricalDataset[], timestamp: number): V58RegimeLabels["crossSectionalDispersionBucket"] {
  const returns: number[] = [];
  for (const dataset of datasets) {
    const candles = dataset.candles["1h"] ?? [];
    const index = lastIndexAtOrBefore(candles, timestamp);
    if (index < 24 || candles[index - 24].close <= 0) continue;
    returns.push(candles[index].close / candles[index - 24].close - 1);
  }
  if (returns.length < 3) return "UNKNOWN";
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const standardDeviation = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
  if (standardDeviation < 0.01) return "LOW";
  if (standardDeviation < 0.03) return "MID";
  return "HIGH";
}

function bucketVolume(value: number | null): V58RegimeLabels["liquidityVolumeBucket"] {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value < 1) return "LOW";
  if (value < 1.5) return "NORMAL";
  return "HIGH";
}

function regimeFromValues(fast: Array<number | null>, slow: Array<number | null>, index: number): MarketRegime {
  if (index < 5 || fast[index] === null || slow[index] === null || fast[index - 5] === null || fast[index] === 0) return "UNKNOWN";
  const slope = (fast[index]! - fast[index - 5]!) / fast[index]!;
  if (fast[index]! > slow[index]! && slope > 0.002) return "BULL";
  if (fast[index]! < slow[index]! && slope < -0.002) return "BEAR";
  return "RANGE";
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

function lookupAtOrBefore(timestamps: number[], values: Array<number | null>, timestamp: number): number | null {
  let low = 0;
  let high = timestamps.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result >= 0 ? values[result] : null;
}
