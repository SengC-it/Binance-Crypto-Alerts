import { afterEach, describe, expect, it, vi } from "vitest";
import { BinancePublicClient, mapWithConcurrency } from "../lib/binance/public-client";
import { atr, donchian, ema, rsi } from "../lib/core/indicators";
import { scoreCandidate } from "../lib/core/scoring";
import { buildTradePlan } from "../lib/core/risk";
import { createParameterGrid } from "../lib/backtest/optimizer";
import type { Candle, Instrument, StrategyCandidate } from "../lib/core/types";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.1,
  quantityStep: 0.001,
  minQuantity: 0.001,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("indicator primitives", () => {
  it("does not use the current candle in the Donchian channel", () => {
    const candles = Array.from({ length: 4 }, (_, index) => candle(index, 100 + index));
    candles[3].high = 999;

    const current = donchian(candles, 3).at(-1);

    expect(current).toEqual({ upper: 103, lower: 99 });
  });

  it("returns warm-up nulls and finite indicator values", () => {
    const candles = Array.from({ length: 40 }, (_, index) => candle(index, 100 + index * 0.25));
    const closes = candles.map((item) => item.close);

    expect(ema(closes, 10).slice(0, 9).every((value) => value === null)).toBe(true);
    expect(atr(candles, 14).at(-1)).toBeTypeOf("number");
    expect(rsi(closes, 14).at(-1)).toBeTypeOf("number");
  });
});

describe("score and risk plan", () => {
  it("keeps the weighted score explainable and bounded", () => {
    const candidate = baseCandidate({
      scoreComponents: {
        trendAlignment: 1,
        momentum: 1,
        structure: 1,
        liquidity: 1,
        volatility: 1,
        regimeFit: 1,
        dataQuality: 1,
      },
    });

    const scored = scoreCandidate(candidate);

    expect(scored.score).toBe(100);
    expect(scored.scoreComponents).toEqual(candidate.scoreComponents);
  });

  it("rounds a long plan safely and calculates theoretical stop risk", () => {
    const scored = scoreCandidate(baseCandidate({
      entryPrice: 100,
      stopReferencePrice: 95,
      side: "LONG",
      scoreComponents: {
        trendAlignment: 0.8,
        momentum: 0.8,
        structure: 0.8,
        liquidity: 0.8,
        volatility: 0.8,
        regimeFit: 0.8,
        dataQuality: 0.8,
      },
    }));

    const plan = buildTradePlan(scored, instrument, {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
    }, 1_700_000_000_000);

    expect(plan.entryPrice).toBe(100);
    expect(plan.stopPrice).toBe(95);
    expect(plan.takeProfitPrice).toBe(110);
    expect(plan.quantity).toBe(20);
    expect(plan.theoreticalRiskUsdt).toBe(100);
    expect(plan.rewardRisk).toBe(2);
    expect(plan.validUntil).toBe(1_700_259_200_000);
  });

  it("rejects a stop on the wrong side of the entry", () => {
    const scored = scoreCandidate(baseCandidate({
      entryPrice: 100,
      stopReferencePrice: 101,
      side: "LONG",
    }));

    expect(() => buildTradePlan(scored, instrument, {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
    }, Date.now())).toThrow(/Invalid stop/);
  });
});

describe("Binance public client", () => {
  it("uses the latest closed 15m candle for signal identity", async () => {
    const rowsByInterval: Record<string, unknown[][]> = {
      "15m": [rawKline(1_000_000, 100)],
      "1h": [rawKline(2_000_000, 101)],
      "4h": [rawKline(3_000_000, 102)],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const interval = url.searchParams.get("interval") ?? "15m";
      return new Response(JSON.stringify(rowsByInterval[interval]), { status: 200 });
    }));

    const snapshot = await new BinancePublicClient("https://fapi.binance.com").getSnapshot(
      instrument,
      ["1h", "4h"],
      10,
    );

    expect(Object.keys(snapshot.candles)).toEqual(["15m", "1h", "4h"]);
    expect(snapshot.tickerPrice).toBe(100);
    expect(snapshot.sourceTimestamp).toBe(1_000_000);
  });

  it("limits concurrent work to the requested worker count", async () => {
    let active = 0;
    let maximum = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBeLessThanOrEqual(2);
  });
});

describe("optimizer", () => {
  it("creates the configured parameter variants", () => {
    expect(createParameterGrid()).toHaveLength(54);
  });
});

function candle(index: number, close: number): Candle {
  return {
    openTime: index * 900_000,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index,
    closeTime: (index + 1) * 900_000 - 1,
  };
}

function rawKline(closeTime: number, close: number): unknown[] {
  return [closeTime - 900_000 + 1, String(close - 1), String(close + 1), String(close - 2), String(close), "100", closeTime];
}

function baseCandidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    strategyFamily: "TREND",
    side: "LONG",
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: 100,
    stopReferencePrice: 95,
    atr: 2,
    scoreComponents: {
      trendAlignment: 0.5,
      momentum: 0.5,
      structure: 0.5,
      liquidity: 0.5,
      volatility: 0.5,
      regimeFit: 0.5,
      dataQuality: 0.5,
    },
    marketRegime: "BULL",
    regimeDependency: "HIGH",
    rationale: ["unit test candidate"],
    ...overrides,
  };
}
