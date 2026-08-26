import { describe, expect, it } from "vitest";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle } from "@/lib/core/types";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan } from "@/lib/v5-3/structural";
import {
  canonicalEmailSignalKey,
  canonicalV57SignalKey,
  dedupeV57Trades,
  detectV57SecondSignal,
  evaluateSecondEdgeGate,
  nextBarOpenReference,
  runV57SecondCandidate,
  V57_SECOND_EDGE_REGISTRY,
  type V57CandidateDefinition,
} from "@/lib/v5-7/research";

const BAR_MS = 15 * 60 * 1000;

function makeCandle(index: number, overrides: Partial<Candle> = {}): Candle {
  const openTime = index * BAR_MS;
  return { openTime, open: 100, high: 100, low: 99, close: 100, volume: 100, closeTime: openTime + BAR_MS - 1, ...overrides };
}

function liquiditySweepFixture(): { dataset: HistoricalDataset; candles: Candle[]; frame: FeatureFrame; candidate: V57CandidateDefinition } {
  const candles = Array.from({ length: 112 }, (_, index) => makeCandle(index));
  candles[104] = makeCandle(104, { open: 100.5, high: 101.5, low: 99, close: 99.2, volume: 180 });
  candles[105] = makeCandle(105, { open: 99.2, high: 99.5, low: 97.5, close: 98, volume: 150 });
  candles[106] = makeCandle(106, { open: 101, high: 101.2, low: 100.5, close: 101, volume: 100 });
  candles[107] = makeCandle(107, { open: 100, high: 100.5, low: 98.9, close: 100, volume: 100 });
  const frame: FeatureFrame = {
    index: 105,
    signalTimestamp: candles[105].closeTime,
    open: 99.2,
    high: 99.5,
    low: 97.5,
    close: 98,
    atr: 1,
    atrPercentile: 0.5,
    emaFast: 100,
    emaSlow: 101,
    trendSlope: 0,
    bullTrendAge: 0,
    bearTrendAge: 0,
    marketRegime: "RANGE",
    btcRegime: "UNKNOWN",
    ethRegime: "UNKNOWN",
    breadth: null,
    btcEthAgreement: null,
    rsi: 50,
    previousRsi: 50,
    momentumAcceleration: 0,
    volumeRatio: 1.5,
    previousVolumeRatio: 1,
    volatilityPercentile: 0.5,
    volatilityExpansion: 1,
    funding: null,
    fundingPercentile: null,
    breakoutHigh20: 100,
    breakoutLow20: 99,
    compressionBars: 0,
    compressionRangeATR: null,
    longPullbackDepth: null,
    shortPullbackDepth: null,
    longEntryExtensionATR: null,
    shortEntryExtensionATR: 0.3,
    longDistanceToEMA: null,
    shortDistanceToEMA: 0.3,
    longRetestDepth: null,
    shortRetestDepth: null,
    longRetestDuration: null,
    shortRetestDuration: null,
    oneHourRegime: "RANGE",
    fourHourRegime: "UNKNOWN",
    oneHourClose: null,
    oneHourEmaFast: null,
    oneHourEmaSlow: null,
    fourHourClose: null,
    fourHourEmaFast: null,
    fourHourEmaSlow: null,
  };
  const candidate = V57_SECOND_EDGE_REGISTRY.find((item) => item.id === "V57-SHORT-LIQUIDITY-SWEEP-01")!;
  const dataset: HistoricalDataset = {
    symbol: "TESTUSDT",
    instrument: { symbol: "TESTUSDT", baseAsset: "TEST", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", priceTick: 0.01, quantityStep: 0.001 },
    candles: { "15m": candles },
  };
  return { dataset, candles, frame, candidate };
}

function runOptions(startTime: number, endTime: number) {
  return { startTime, endTime, takerFeeRate: 0.0004, slippageBps: 2, riskPerTradeUsdt: 50, cooldownHours: 0 };
}

describe("V5.7 independent second-edge research", () => {
  it("uses a frozen finite registry of independent mechanisms", () => {
    expect(V57_SECOND_EDGE_REGISTRY.length).toBe(8);
    expect(V57_SECOND_EDGE_REGISTRY.length).toBeLessThanOrEqual(12);
    expect(new Set(V57_SECOND_EDGE_REGISTRY.map((candidate) => candidate.family))).toEqual(new Set([
      "BEAR_TREND_CONTINUATION",
      "RANGE_BREAKDOWN",
      "LIQUIDITY_SWEEP_SHORT",
      "MOMENTUM_CASCADE",
    ]));
    expect(V57_SECOND_EDGE_REGISTRY.every((candidate) => !candidate.id.includes("FAILED-BREAKOUT"))).toBe(true);
  });

  it("uses the contiguous next-bar open and preserves execution provenance", () => {
    const { dataset, candles, frame, candidate } = liquiditySweepFixture();
    expect(detectV57SecondSignal(frame, candles, candidate)).toBe(true);
    const reference = nextBarOpenReference(candles, frame.index);
    expect(reference).toEqual({
      signalCandleCloseTime: candles[105].closeTime,
      executionCandleOpenTime: candles[106].openTime,
      executionReferencePrice: 101,
      executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    });
    const trades = runV57SecondCandidate(dataset, [frame], candidate, runOptions(frame.signalTimestamp, candles[110].closeTime));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      entryTime: candles[106].openTime,
      signalCandleCloseTime: candles[105].closeTime,
      executionCandleOpenTime: candles[106].openTime,
      executionReferencePrice: 101,
      executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    });
    expect(trades[0].executionReferencePrice).not.toBe(candles[105].close);
    expect(trades[0].signalCandleCloseTime).toBeLessThan(trades[0].executionCandleOpenTime);
  });

  it("does not use next-bar high, low, close, or volume for the raw trigger", () => {
    const { candles, frame, candidate } = liquiditySweepFixture();
    const baseline = detectV57SecondSignal(frame, candles, candidate);
    const mutated = candles.map((candle, index) => index === 106
      ? { ...candle, high: 10_000, low: 1, close: 9_000, volume: 1_000_000 }
      : candle);
    expect(baseline).toBe(true);
    expect(detectV57SecondSignal(frame, mutated, candidate)).toBe(baseline);
  });

  it("fails closed without a real next-bar open and never falls back to signal close", () => {
    const { dataset, candles, frame, candidate } = liquiditySweepFixture();
    const missing = candles.map((candle, index) => index === 106 ? { ...candle, openTime: candle.openTime + 1 } : candle);
    expect(nextBarOpenReference(missing, frame.index)).toBeNull();
    expect(runV57SecondCandidate({ ...dataset, candles: { "15m": missing } }, [frame], candidate, runOptions(frame.signalTimestamp, candles[110].closeTime))).toHaveLength(0);
  });

  it("uses the shared structural plan at the next open", () => {
    const { candles, frame, candidate } = liquiditySweepFixture();
    const planDefinition = { ...candidate, family: "BREAKDOWN_RETEST_SHORT" as const };
    const plan = buildStructuralPlan(candles, frame, candles[106], planDefinition);
    expect(plan).not.toBeNull();
    expect(plan?.riskPrice).toBeGreaterThan(0);
    expect(plan?.targetPrice).toBeLessThan(101);
    expect(candles[105].close).not.toBe(candles[106].open);
  });

  it("deduplicates a strategy identity without collapsing distinct strategy support", () => {
    const { dataset, frame, candidate } = liquiditySweepFixture();
    const [trade] = runV57SecondCandidate(dataset, [frame], candidate, runOptions(frame.signalTimestamp, dataset.candles["15m"][110].closeTime));
    expect(trade).toBeDefined();
    const duplicate = { ...trade, exitTime: trade.exitTime! + BAR_MS };
    const distinct = { ...trade, candidateId: "OTHER", strategyIdentity: "OTHER" };
    expect(canonicalV57SignalKey(trade)).toBe(canonicalV57SignalKey(duplicate));
    expect(canonicalEmailSignalKey(trade)).toBe(canonicalEmailSignalKey(distinct));
    expect(dedupeV57Trades([trade, duplicate, distinct])).toMatchObject({ rawCount: 3, uniqueCount: 2, duplicateCount: 1 });
  });

  it("keeps the second-edge gate fail-closed until every hard condition passes", () => {
    expect(evaluateSecondEdgeGate({ nestedTrades: 30, netR: 1, avgR: 0.1, profitFactor: 1.25, plus10BpsNetR: 0.5, selectionAdjustedLcb95: 0, symbolBreadth: 10, positiveOuterFolds: 2, outerFoldCount: 2 }).passed).toBe(true);
    expect(evaluateSecondEdgeGate({ nestedTrades: 29, netR: 1, avgR: 0.1, profitFactor: 1.25, plus10BpsNetR: 0.5, selectionAdjustedLcb95: 0, symbolBreadth: 10, positiveOuterFolds: 2, outerFoldCount: 2 }).passed).toBe(false);
  });
});
