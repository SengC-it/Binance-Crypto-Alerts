import { describe, expect, it } from "vitest";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle } from "@/lib/core/types";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan, runStructuralCandidate, type StructuralCandidateDefinition } from "@/lib/v5-3/structural";
import {
  calculateYieldMetrics,
  canonicalResearchSignalKey,
  dedupeResearchTrades,
  detectIndependentSignal,
  nextBarOpenReference,
  passesProvisionalYieldGate,
  runIndependentCandidate,
  V561_CANDIDATE_REGISTRY,
  type YieldMetrics,
} from "@/lib/v5-6-1/research";

const BAR_MS = 15 * 60 * 1000;

function makeCandle(index: number, overrides: Partial<Candle> = {}): Candle {
  const openTime = index * BAR_MS;
  return {
    openTime,
    open: 100,
    high: 100,
    low: 99,
    close: 100,
    volume: 100,
    closeTime: openTime + BAR_MS - 1,
    ...overrides,
  };
}

function failedBreakoutFixture(): { dataset: HistoricalDataset; candles: Candle[]; frame: FeatureFrame } {
  const candles = Array.from({ length: 112 }, (_, index) => makeCandle(index));
  candles[100] = makeCandle(100, { volume: 150 });
  candles[103] = makeCandle(103, { high: 102, close: 101 });
  candles[104] = makeCandle(104, { high: 100, close: 99 });
  candles[105] = makeCandle(105, { open: 99, high: 99.5, low: 97.5, close: 98 });
  candles[106] = makeCandle(106, { open: 101, high: 101.2, low: 100.5, close: 101 });
  candles[107] = makeCandle(107, { open: 100, high: 100.5, low: 98.9, close: 100 });
  const frame: FeatureFrame = {
    index: 105,
    signalTimestamp: candles[105].closeTime,
    open: 99,
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
  const dataset: HistoricalDataset = {
    symbol: "TESTUSDT",
    instrument: {
      symbol: "TESTUSDT",
      baseAsset: "TEST",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
      status: "TRADING",
      priceTick: 0.01,
      quantityStep: 0.001,
    },
    candles: { "15m": candles },
  };
  return { dataset, candles, frame };
}

function structuralDefinition(): StructuralCandidateDefinition {
  const candidate = V561_CANDIDATE_REGISTRY[0];
  return { ...candidate, family: "FAILED_BREAKOUT_SHORT" };
}

function runOptions(startTime: number, endTime: number) {
  return {
    startTime,
    endTime,
    takerFeeRate: 0.0004,
    slippageBps: 2,
    riskPerTradeUsdt: 50,
    cooldownHours: 0,
  };
}

describe("V5.6.1 evidence correctness", () => {
  it("uses a finite independent family registry", () => {
    expect(V561_CANDIDATE_REGISTRY).toHaveLength(5);
    expect(new Set(V561_CANDIDATE_REGISTRY.map((candidate) => candidate.family)).size).toBe(5);
    expect(V561_CANDIDATE_REGISTRY.every((candidate) => candidate.id !== "V5.5-CONTROL-SHORT-FAILED_BREAKOUT_SHORT-02")).toBe(true);
  });

  it("deduplicates the same strategy signal while retaining distinct strategy identities", () => {
    const { dataset, candles, frame } = failedBreakoutFixture();
    const candidate = V561_CANDIDATE_REGISTRY[0];
    const options = runOptions(candles[105].closeTime, candles[110].closeTime);
    const [trade] = runIndependentCandidate(dataset, [frame], candidate, options);
    expect(trade).toBeDefined();
    const duplicate = { ...trade, exitTime: trade.exitTime! + BAR_MS };
    const supportingStrategy = { ...trade, candidateId: "OTHER", strategyIdentity: "OTHER" };
    const result = dedupeResearchTrades([trade, duplicate, supportingStrategy]);
    expect(canonicalResearchSignalKey(trade)).toBe(canonicalResearchSignalKey(duplicate));
    expect(result).toMatchObject({ rawCount: 3, uniqueCount: 2, duplicateCount: 1 });
  });

  it("includes boundary droughts and applies the strict yield gate", () => {
    const start = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2024, 11, 31, 23, 59, 59, 999);
    const empty = calculateYieldMetrics([], start, end);
    expect(empty.maxSignalDroughtDays).toBeGreaterThan(365);
    expect(passesProvisionalYieldGate(empty)).toBe(false);
    const passing: YieldMetrics = {
      ...empty,
      alertsPerMonth: 2,
      activeMonthRatio: 0.65,
      medianAlertsPerMonth: 1,
      p95SignalDroughtDays: 45,
      maxSignalDroughtDays: 60,
    };
    expect(passesProvisionalYieldGate(passing)).toBe(true);
  });

  it("does not use next-bar high, low, close, or volume for the raw trigger", () => {
    const { candles, frame } = failedBreakoutFixture();
    const candidate = V561_CANDIDATE_REGISTRY[0];
    const baseline = detectIndependentSignal(frame, candles, candidate);
    const mutatedNextBar = candles.map((candle, index) => index === 106
      ? { ...candle, high: 10_000, low: 1, close: 9_000, volume: 1_000_000 }
      : candle);
    expect(baseline).toBe(true);
    expect(detectIndependentSignal(frame, mutatedNextBar, candidate)).toBe(baseline);
  });

  it("matches the historical plan and enters at the real next-bar open", () => {
    const { dataset, candles, frame } = failedBreakoutFixture();
    const candidate = V561_CANDIDATE_REGISTRY[0];
    const definition = structuralDefinition();
    const options = runOptions(candles[105].closeTime, candles[110].closeTime);
    const historical = runStructuralCandidate(dataset, [frame], definition, options);
    const runtime = runIndependentCandidate(dataset, [frame], candidate, options);
    const expectedPlan = buildStructuralPlan(candles, frame, candles[106], definition);
    expect(historical).toHaveLength(1);
    expect(runtime).toHaveLength(1);
    expect(expectedPlan).not.toBeNull();
    expect(runtime[0]).toMatchObject({
      signalCandleCloseTime: candles[105].closeTime,
      executionCandleOpenTime: candles[106].openTime,
      executionReferencePrice: 101,
      executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
      entryTime: candles[106].openTime,
    });
    expect(runtime[0].entryPrice).toBeCloseTo(historical[0].entryPrice, 12);
    expect(runtime[0].exitPrice).toBeCloseTo(historical[0].exitPrice, 12);
    expect(runtime[0].stopPrice).toBeCloseTo(expectedPlan!.stopPrice, 12);
    expect(runtime[0].targetPrice).toBeCloseTo(expectedPlan!.targetPrice, 12);
    expect(runtime[0].riskPrice).toBeCloseTo(expectedPlan!.riskPrice, 12);
    expect(runtime[0].executionReferencePrice).not.toBe(candles[105].close);
    expect(runtime[0].signalCandleCloseTime).toBeLessThan(runtime[0].executionCandleOpenTime);
  });

  it("fails closed without a contiguous next-bar open and creates no trade", () => {
    const { dataset, candles, frame } = failedBreakoutFixture();
    const candidate = V561_CANDIDATE_REGISTRY[0];
    const missingNextBar = candles.map((candle, index) => index === 106 ? { ...candle, openTime: candle.openTime + 1 } : candle);
    expect(nextBarOpenReference(missingNextBar, frame.index)).toBeNull();
    expect(runIndependentCandidate({ ...dataset, candles: { "15m": missingNextBar } }, [frame], candidate, runOptions(frame.signalTimestamp, candles[110].closeTime))).toHaveLength(0);
  });
});
