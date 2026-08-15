import { afterEach, describe, expect, it, vi } from "vitest";
import { BinancePublicClient, mapWithConcurrency } from "../lib/binance/public-client";
import { atr, donchian, ema, rsi } from "../lib/core/indicators";
import { estimatedExecutionCostRiskFraction, isEntryIntervalAllowed } from "../lib/core/execution-policy";
import {
  PRODUCTION_ENTRY_MODE,
  PRODUCTION_STRATEGY_VERSION,
  SHADOW_ENTRY_MODE,
} from "../lib/core/production-policy";
import {
  assessMarketState,
  expectedNetR,
  fitCostAwareScoreModel,
  passesMarketStateFilter,
  projectedFundingCostRiskFraction,
} from "../lib/core/opportunity-policy";
import {
  fitScoreCalibration,
  passesEmpiricalScoreCalibration,
  rankCandidates,
  scoreCandidate,
} from "../lib/core/scoring";
import { buildTradePlan } from "../lib/core/risk";
import { DEFAULT_STRATEGY_PARAMS } from "../lib/core/strategies";
import { runBacktest } from "../lib/backtest/engine";
import { createParameterGrid } from "../lib/backtest/optimizer";
import type { HistoricalDataset } from "../lib/backtest/types";
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

describe("production strategy policy", () => {
  it("promotes short trend rejection and retains the prior entry as shadow", () => {
    expect(PRODUCTION_STRATEGY_VERSION).toBe("trend-rejection-short-v1");
    expect(PRODUCTION_ENTRY_MODE).toBe("TREND_REJECTION");
    expect(SHADOW_ENTRY_MODE).toBe("DEFAULT");
  });
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

  it("applies the calibrated side, family, and minimum-score policy before ranking", () => {
    const accepted = baseCandidate({
      side: "SHORT",
      strategyFamily: "TREND",
      scoreComponents: {
        trendAlignment: 0.8,
        momentum: 0.8,
        structure: 0.8,
        liquidity: 0.8,
        volatility: 0.8,
        regimeFit: 0.8,
        dataQuality: 0.8,
      },
    });
    const rejectedForSide = baseCandidate({ side: "LONG" });
    const rejectedForFamily = baseCandidate({ strategyFamily: "BREAKOUT" });

    const ranked = rankCandidates([accepted, rejectedForSide, rejectedForFamily], {
      minimumScore: 70,
      sideFilter: "SHORT",
      strategyFamily: "TREND",
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].side).toBe("SHORT");
    expect(ranked[0].strategyFamily).toBe("TREND");
    expect(ranked[0].score).toBe(80);
  });

  it("fits score calibration on net R and rejects unknown or weak score buckets", () => {
    const model = fitScoreCalibration([
      ...Array.from({ length: 4 }, () => ({ score: 82, netR: 0.5 })),
      ...Array.from({ length: 4 }, () => ({ score: 86, netR: -0.25 })),
    ], {
      bucketSize: 5,
      minimumSamples: 4,
      minimumExpectedNetR: 0.05,
      priorWeight: 0,
    });

    expect(passesEmpiricalScoreCalibration(model, 82)).toBe(true);
    expect(passesEmpiricalScoreCalibration(model, 86)).toBe(false);
    expect(passesEmpiricalScoreCalibration(model, 95)).toBe(false);
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

  it("uses an explicit reward-risk multiple when supplied", () => {
    const scored = scoreCandidate(baseCandidate({
      entryPrice: 100,
      stopReferencePrice: 95,
      side: "LONG",
    }));

    const plan = buildTradePlan(scored, instrument, {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
      rewardRisk: 1.5,
    }, 1_700_000_000_000);

    expect(plan.takeProfitPrice).toBe(107.5);
    expect(plan.rewardRisk).toBe(1.5);
  });

  it("never sizes above the configured margin and leverage ceiling", () => {
    const scored = scoreCandidate(baseCandidate({
      entryPrice: 100,
      stopReferencePrice: 99,
      side: "LONG",
    }));

    const plan = buildTradePlan(scored, instrument, {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
    }, 1_700_000_000_000);

    expect(plan.positionNotionalUsdt).toBe(2_000);
    expect(plan.assumedMarginUsdt).toBe(100);
    expect(plan.theoreticalRiskUsdt).toBe(20);
    expect(estimatedExecutionCostRiskFraction(plan, 0.0004, 2)).toBeGreaterThan(0);
    expect(isEntryIntervalAllowed(3_599_999, 1)).toBe(true);
    expect(isEntryIntervalAllowed(899_999, 1)).toBe(false);
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

  it("does not value an exit candle after a short holding-time boundary", () => {
    const candles = Array.from({ length: 100 }, (_, index) => candle(index, 100 + index));
    candles[81].high = candles[81].close + 0.5;
    const candidate = scoreCandidate(baseCandidate({
      entryPrice: candles[80].close,
      stopReferencePrice: candles[80].close - 1,
      atr: 1,
    }));
    const dataset: HistoricalDataset = {
      symbol: "BTCUSDT",
      instrument,
      candles: { "15m": candles, "1h": candles, "4h": candles },
      fundingRates: [],
    };
    const evaluationStartTime = candles[80].closeTime;
    const evaluationEndTime = candles[81].closeTime;
    const shortHold = runBacktest(dataset, { ...DEFAULT_STRATEGY_PARAMS }, {
      initialCapitalUsdt: 10_000,
      minimumSampleDays: 0,
      minScore: 0,
      maxHoldHours: 0.1,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      dailyRiskBudgetUsdt: 600,
      evaluationStartTime,
      evaluationEndTime,
      candidateCache: new Map([[80, [candidate]]]),
    });

    expect(shortHold.trades).toHaveLength(0);
  });

  it("activates a breakeven stop only after the triggering candle closes", () => {
    const candles = Array.from({ length: 100 }, (_, index) => candle(index, 100));
    candles[81] = { ...candles[81], high: 101.1, low: 99.5, close: 100.8 };
    candles[82] = { ...candles[82], high: 101.2, low: 99.9, close: 100.5 };
    const candidate = scoreCandidate(baseCandidate({
      entryPrice: 100,
      stopReferencePrice: 99,
      atr: 1,
    }));
    const dataset: HistoricalDataset = {
      symbol: "BTCUSDT",
      instrument,
      candles: { "15m": candles, "1h": candles, "4h": candles },
      fundingRates: [],
    };

    const result = runBacktest(dataset, { ...DEFAULT_STRATEGY_PARAMS }, {
      initialCapitalUsdt: 10_000,
      minimumSampleDays: 0,
      minScore: 0,
      maxHoldHours: 72,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 2_000,
      singleSignalRiskCapUsdt: 50,
      dailyRiskBudgetUsdt: 600,
      evaluationStartTime: candles[80].closeTime,
      evaluationEndTime: candles[90].closeTime,
      candidateCache: new Map([[80, [candidate]]]),
      dynamicExitPolicy: { breakevenTriggerR: 1 },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("BREAKEVEN");
    expect(result.trades[0].exitTime).toBe(candles[82].closeTime);
    expect(result.trades[0].path?.maxFavorableR).toBeCloseTo(1.1);
    expect(result.trades[0].path?.givebackR).toBeCloseTo(1.1);
  });
});

describe("market, funding, and cost-aware opportunity policy", () => {
  it("classifies a weakening BTC bear regime without using another symbol", () => {
    const descending = Array.from({ length: 100 }, (_, index) => candle(index, 200 - index * 1.5));
    const state = assessMarketState({
      instrument,
      tickerPrice: descending.at(-1)!.close,
      candles: { "1h": descending, "4h": descending },
      sourceTimestamp: descending.at(-1)!.closeTime,
    });

    expect(state.key).toBe("BEAR_WEAK");
    expect(passesMarketStateFilter(state, "BTC_4H_BEAR_1H_WEAK")).toBe(true);
  });

  it("projects only adverse funding known at the signal timestamp", () => {
    const plan = {
      entryPrice: 100,
      stopPrice: 95,
      takeProfitPrice: 110,
      rewardRisk: 2,
      assumedMarginUsdt: 100,
      assumedLeverage: 20,
      positionNotionalUsdt: 2_000,
      quantity: 20,
      theoreticalRiskUsdt: 100,
      riskOverSingleCap: false,
      validUntil: 1,
    };
    const fundingRates = [
      { fundingTime: 1, fundingRate: 0.001 },
      { fundingTime: 2, fundingRate: 0.001 },
      { fundingTime: 3, fundingRate: 0.001 },
      { fundingTime: 5, fundingRate: -0.1 },
    ];

    expect(projectedFundingCostRiskFraction("LONG", plan, fundingRates, 3)).toBeCloseTo(0.06);
    expect(projectedFundingCostRiskFraction("SHORT", plan, fundingRates, 3)).toBe(0);
  });

  it("learns expected net R after costs and rejects unknown buckets", () => {
    const model = fitCostAwareScoreModel([
      ...Array.from({ length: 4 }, () => ({
        score: 82,
        marketState: "BEAR_WEAK" as const,
        projectedFundingCostRiskFraction: 0.01,
        executionCostRiskFraction: 0.02,
        netR: 0.25,
      })),
      ...Array.from({ length: 4 }, () => ({
        score: 87,
        marketState: "BEAR_WEAK" as const,
        projectedFundingCostRiskFraction: 0.01,
        executionCostRiskFraction: 0.02,
        netR: -0.2,
      })),
    ], { minimumSamples: 4, priorWeight: 0, minimumExpectedNetR: 0 });
    const features = {
      marketState: "BEAR_WEAK" as const,
      projectedFundingCostRiskFraction: 0.01,
      executionCostRiskFraction: 0.02,
    };

    expect(expectedNetR(model, 82, features)).toBeCloseTo(0.25);
    expect(expectedNetR(model, 87, features)).toBeCloseTo(-0.2);
    expect(expectedNetR(model, 92, features)).toBeNull();
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
