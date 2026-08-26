import { describe, expect, it } from "vitest";
import type { Candle, FundingRatePoint } from "@/lib/core/types";
import {
  buildCostStress,
  buildPortfolioSummary,
  buildV6Runs,
  buildV6Signals,
  evaluateValidation,
} from "@/lib/v6/engine";
import {
  V6_BAR_MS,
  V6_CONFIGURATIONS,
  V6_DEV_END,
  V6_RISK_TEMPLATES,
} from "@/lib/v6/registry";
import type { V6Dataset, V6Trade } from "@/lib/v6/types";

function makeDataset(count = 150): V6Dataset {
  const candles: Candle[] = Array.from({ length: count }, (_, index) => {
    const openTime = index * V6_BAR_MS;
    const open = index <= 100 ? 90 + index * 0.095 : 101 + (index - 101) * 0.2;
    const close = open + 0.04;
    return {
      openTime,
      open,
      high: close + 0.01,
      low: open - 0.01,
      close,
      volume: 1_000,
      closeTime: openTime + V6_BAR_MS - 1,
    };
  });
  // Make the first eligible signal's execution reference visibly different
  // from the signal close. Only the next candle's open is used as execution.
  candles[100] = { ...candles[100]!, open: 99.5, high: 100.05, low: 99.45, close: 100 };
  candles[101] = { ...candles[101]!, open: 101, high: 101.2, low: 100.9, close: 101.1 };
  return { symbol: "TESTUSDT", candles4h: candles, fundingRates: [] };
}

function makeTrade(overrides: Partial<V6Trade> = {}): V6Trade {
  return {
    symbol: "TESTUSDT",
    side: "LONG",
    entryTime: 0,
    exitTime: 10,
    rMultiple: 1,
    netPnlUsdt: 50,
    pnlUsdt: 50,
    theoreticalRiskUsdt: 50,
    feesUsdt: 1,
    fundingUsdt: 0,
    slippageUsdt: 0.2,
    marketRegime: "BULL",
    signalId: "test",
    family: "TIME_SERIES_TREND",
    configId: "V6-A-TS-20-10",
    riskTemplateId: "V6-RISK-ATR-1.5R",
    signalTimestamp: 0,
    signalCandleCloseTime: 0,
    executionCandleOpenTime: 1,
    executionReferencePrice: 100,
    executionReferenceSource: "BINANCE_4H_NEXT_BAR_OPEN",
    entryPrice: 100,
    exitPrice: 101,
    stopPrice: 99,
    targetPrice: 101,
    riskPrice: 1,
    exitReason: "TAKE_PROFIT",
    cluster: "BTC_BETA",
    ...overrides,
  };
}

describe("V6 frozen strategy reset", () => {
  it("keeps the preregistered configuration and risk budgets bounded", () => {
    expect(V6_CONFIGURATIONS.length).toBeLessThanOrEqual(24);
    expect(V6_CONFIGURATIONS).toHaveLength(12);
    expect(V6_RISK_TEMPLATES).toHaveLength(3);
    expect(V6_CONFIGURATIONS.every((configuration) => !configuration.description.includes("15m"))).toBe(true);
  });

  it("executes a closed 4h signal at the next bar open, not the signal close", () => {
    const dataset = makeDataset();
    const configuration = V6_CONFIGURATIONS.find((candidate) => candidate.id === "V6-A-TS-20-10")!;
    const signals = buildV6Signals([dataset], configuration, 0, V6_DEV_END);
    const signal = signals.find((candidate) => candidate.signalIndex === 100 && candidate.side === "LONG");

    expect(signal).toBeDefined();
    expect(signal!.executionCandleOpenTime).toBe(signal!.signalCandleCloseTime + 1);
    expect(signal!.executionReferencePrice).toBe(101);
    expect(signal!.executionReferencePrice).not.toBe(dataset.candles4h[100]!.close);

    const run = buildV6Runs([dataset], 0, V6_DEV_END).find((candidate) => candidate.id === "V6-A-TS-20-10|V6-RISK-ATR-1.5R|LONG")!;
    const trade = run.trades.find((candidate) => candidate.signalId === signal!.signalId);
    expect(trade).toBeDefined();
    expect(trade!.executionReferencePrice).toBe(101);
    expect(trade!.executionReferencePrice).not.toBe(dataset.candles4h[100]!.close);
  });

  it("does not use next-bar high, low, close, or volume in the signal", () => {
    const base = makeDataset();
    const changedNextBar: V6Dataset = {
      ...base,
      candles4h: base.candles4h.map((candle, index) => index === 101
        ? { ...candle, high: 10_000, low: 0.01, close: 9_000, volume: 99_999_999 }
        : candle),
    };
    const configuration = V6_CONFIGURATIONS.find((candidate) => candidate.id === "V6-A-TS-20-10")!;
    const first = buildV6Signals([base], configuration, 0, V6_DEV_END).find((signal) => signal.signalIndex === 100 && signal.side === "LONG");
    const second = buildV6Signals([changedNextBar], configuration, 0, V6_DEV_END).find((signal) => signal.signalIndex === 100 && signal.side === "LONG");

    expect(second).toEqual(first);
  });

  it("fails closed when the contiguous next execution bar is unavailable", () => {
    const dataset = makeDataset();
    dataset.candles4h[101] = { ...dataset.candles4h[101]!, openTime: dataset.candles4h[101]!.openTime + 1 };
    const configuration = V6_CONFIGURATIONS.find((candidate) => candidate.id === "V6-A-TS-20-10")!;

    expect(buildV6Signals([dataset], configuration, 0, V6_DEV_END).some((signal) => signal.signalIndex === 100)).toBe(false);
  });

  it("does not produce trades from a flat no-volatility dataset", () => {
    const candles: Candle[] = Array.from({ length: 220 }, (_, index) => {
      const openTime = index * V6_BAR_MS;
      return { openTime, open: 6.44, high: 6.44, low: 6.44, close: 6.44, volume: 1_000, closeTime: openTime + V6_BAR_MS - 1 };
    });
    const flat = { symbol: "FLATUSDT", candles4h: candles, fundingRates: [] as FundingRatePoint[] };

    expect(buildV6Runs([flat], 0, V6_DEV_END).every((run) => run.trades.length === 0)).toBe(true);
  });

  it("keeps the validation boundary unavailable rather than promoting empty data", () => {
    const result = evaluateValidation(null, [], "DATA_INSUFFICIENT", 0, V6_DEV_END, "B");

    expect(result.status).toBe("DATA_INSUFFICIENT");
    expect(result.metrics.metrics.trades).toBe(0);
    expect(Object.values(result.gate).every(Boolean)).toBe(false);
  });

  it("applies portfolio capacity and concentration limits independently of email rows", () => {
    const trades = [
      makeTrade({ signalId: "a", entryTime: 1, exitTime: 20, symbol: "AUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "b", entryTime: 2, exitTime: 20, symbol: "BUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "c", entryTime: 3, exitTime: 20, symbol: "CUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "d", entryTime: 4, exitTime: 20, symbol: "DUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "e", entryTime: 5, exitTime: 20, symbol: "EUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "f", entryTime: 6, exitTime: 20, symbol: "FUSDT", cluster: "BTC_BETA" }),
      makeTrade({ signalId: "g", entryTime: 7, exitTime: 20, symbol: "GUSDT", cluster: "BTC_BETA" }),
    ];
    const portfolio = buildPortfolioSummary(trades, 6, 1, 3);

    expect(portfolio.maxConcurrent).toBeLessThanOrEqual(6);
    expect(portfolio.maxClusterConcentration).toBeLessThanOrEqual(3);
    expect(portfolio.rejectedForCapacity + portfolio.rejectedForClusterConcentration).toBeGreaterThan(0);
  });

  it("makes +10bps and +15bps stress no better than the base result", () => {
    const stress = buildCostStress([makeTrade({ rMultiple: 0.5 })]);

    expect(stress.plus10Bps.metrics.netR).toBeLessThan(stress.base.metrics.netR);
    expect(stress.plus15Bps.metrics.netR).toBeLessThan(stress.plus10Bps.metrics.netR);
  });
});
