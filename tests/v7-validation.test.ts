import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/core/types";
import {
  buildSignals,
  buildV7Runs,
  familyPasses,
  runNestedFamily,
  stressSummary,
  summarizeV7Trades,
} from "@/lib/v7/engine";
import {
  V7_CONFIGURATIONS,
  V7_FEATURE_DEFINITIONS,
  V7_FAMILIES,
  V7_RISK_TEMPLATES,
} from "@/lib/v7/registry";
import type { DerivativesMetricsPoint, V7Dataset, V7Trade } from "@/lib/v7/types";

const HOUR_MS = 60 * 60 * 1_000;
const QUARTER_MS = 15 * 60 * 1_000;
const START = Date.UTC(2023, 0, 1);

function makeDataset(): V7Dataset {
  const candles1h: Candle[] = Array.from({ length: 180 }, (_, index) => {
    const openTime = START + index * HOUR_MS;
    const close = 100 + index * 0.08 + (index === 40 ? 4 : 0);
    return { openTime, open: close - 0.2, high: close + 0.4, low: close - 0.4, close, volume: 1_000, closeTime: openTime + HOUR_MS - 1 };
  });
  const candles4h: Candle[] = Array.from({ length: 46 }, (_, index) => {
    const openTime = START + index * 4 * HOUR_MS;
    const close = 100 + index * 0.5;
    return { openTime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 4_000, closeTime: openTime + 4 * HOUR_MS - 1 };
  });
  const candles15m: Candle[] = Array.from({ length: 180 * 4 + 4 }, (_, index) => {
    const openTime = START + index * QUARTER_MS;
    const hourIndex = Math.floor(index / 4);
    const open = index % 4 === 0 && hourIndex === 41 ? 101 : 100 + hourIndex * 0.08;
    return { openTime, open, high: open + 0.3, low: open - 0.3, close: open + 0.02, volume: 100, closeTime: openTime + QUARTER_MS - 1 };
  });
  const derivatives: DerivativesMetricsPoint[] = candles1h.map((candle, index) => ({
    timestamp: candle.openTime,
    sourceTimestamp: candle.closeTime - 1_000,
    openInterest: 1_000 + index,
    openInterestValue: 100_000,
    takerLongShortVolumeRatio: 1,
    globalLongShortAccountRatio: 1,
  }));
  derivatives[40] = { ...derivatives[40]!, openInterest: 1_100 };
  return { symbol: "TESTUSDT", candles1h, candles4h, candles15m, derivatives, fundingRates: [] };
}

function targetConfiguration() {
  return V7_CONFIGURATIONS.find((configuration) => configuration.id === "V7-A-NEW-LONG")!;
}

function makeTrade(overrides: Partial<V7Trade> = {}): V7Trade {
  return {
    family: "OI_PRICE_DIVERGENCE",
    configurationId: "V7-A-NEW-LONG",
    symbol: "TESTUSDT",
    side: "LONG",
    signalTimestamp: START,
    executionTimestamp: START + HOUR_MS,
    entryPrice: 100,
    exitTimestamp: START + 2 * HOUR_MS,
    exitPrice: 101,
    exitReason: "TARGET",
    stopPrice: 99,
    targetPrice: 101,
    riskPrice: 1,
    rewardRisk: 1,
    quantity: 50,
    grossR: 1,
    netR: 0.9,
    feesR: 0.08,
    slippageR: 0.02,
    fundingR: 0,
    costStressBps: 0,
    oiRegime: "RISING",
    fundingRegime: "NEUTRAL",
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    ...overrides,
  };
}

describe("V7 derivatives-flow research protocol", () => {
  it("keeps families, configurations, features and risk templates within the preregistered budget", () => {
    expect(V7_FAMILIES).toHaveLength(3);
    expect(V7_CONFIGURATIONS).toHaveLength(12);
    expect(V7_CONFIGURATIONS.length).toBeLessThanOrEqual(24);
    expect(V7_FEATURE_DEFINITIONS.length).toBeLessThanOrEqual(16);
    expect(V7_RISK_TEMPLATES).toHaveLength(3);
    expect(V7_FAMILIES.includes("LIQUIDATION_STRESS" as never)).toBe(false);
  });

  it("uses the next 15m open as execution and preserves historical trade-plan inputs", () => {
    const dataset = makeDataset();
    const signal = buildSignals(dataset, targetConfiguration(), START, START + 120 * HOUR_MS).find((candidate) => candidate.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1);
    expect(signal).toBeDefined();
    expect(signal!.executionTimestamp).toBe(signal!.signalCandleCloseTime + 1);
    expect(signal!.executionReferencePrice).toBe(101);
    expect(signal!.executionReferencePrice).not.toBe(dataset.candles1h[40]!.close);

    const run = buildV7Runs(dataset ? [dataset] : [], START, START + 120 * HOUR_MS).find((candidate) => candidate.runId === "V7-A-NEW-LONG|V7-RISK-ATR-1.5R");
    const trade = run?.trades.find((candidate) => candidate.signalTimestamp === signal!.signalTimestamp);
    expect(trade).toBeDefined();
    expect(trade!.entryPrice).toBe(101);
    expect(trade!.executionReferenceSource).toBe("BINANCE_15M_NEXT_BAR_OPEN");
  });

  it("does not use next-bar high, low, close or volume in a signal", () => {
    const base = makeDataset();
    const changed: V7Dataset = { ...base, candles15m: base.candles15m.map((candle) => candle.openTime === START + 40 * HOUR_MS ? { ...candle, high: 10_000, low: 0.01, close: 9_000, volume: 99_999_999 } : candle) };
    const first = buildSignals(base, targetConfiguration(), START, START + 120 * HOUR_MS).find((signal) => signal.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1);
    const second = buildSignals(changed, targetConfiguration(), START, START + 120 * HOUR_MS).find((signal) => signal.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1);
    expect(second).toEqual(first);
  });

  it("fails closed when the contiguous next execution bar is missing", () => {
    const base = makeDataset();
    const missing: V7Dataset = { ...base, candles15m: base.candles15m.filter((candle) => candle.openTime !== START + 41 * HOUR_MS) };
    expect(buildSignals(missing, targetConfiguration(), START, START + 120 * HOUR_MS).some((signal) => signal.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1)).toBe(false);
  });

  it("does not use future derivative observations for a past signal", () => {
    const base = makeDataset();
    const changed: V7Dataset = { ...base, derivatives: base.derivatives.map((point) => point.timestamp > START + 40 * HOUR_MS ? { ...point, openInterest: point.openInterest * 100 } : point) };
    const first = buildSignals(base, targetConfiguration(), START, START + 120 * HOUR_MS).find((signal) => signal.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1);
    const second = buildSignals(changed, targetConfiguration(), START, START + 120 * HOUR_MS).find((signal) => signal.signalTimestamp === START + 40 * HOUR_MS + HOUR_MS - 1);
    expect(second).toEqual(first);
  });

  it("applies cost stress monotonically and exposes risk provenance", () => {
    const base = [makeTrade()];
    const stress = stressSummary(base);
    expect(stress.plus5Bps.netR).toBeLessThan(stress.base.netR);
    expect(stress.plus10Bps.netR).toBeLessThan(stress.plus5Bps.netR);
    expect(stress.plus15Bps.netR).toBeLessThan(stress.plus10Bps.netR);
    expect(summarizeV7Trades(base).totalNetPnlUsdt).toBeGreaterThan(0);
  });

  it("requires all validation gates and never treats an empty family as promoted", () => {
    const empty = summarizeV7Trades([]);
    const nested = runNestedFamily([], "OI_PRICE_DIVERGENCE", START, START + HOUR_MS, new Set());
    const validation = { status: "DATA_INSUFFICIENT" as const, metrics: empty, stress: stressSummary([]), symbols: 0, gate: {} };
    expect(familyPasses(nested, validation, validation)).toBe(false);
  });
});
