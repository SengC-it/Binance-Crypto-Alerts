import { describe, expect, it } from "vitest";
import {
  LFV_BASELINE_SHA,
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_LIVE_OBSERVATION_CUTOFF,
  LFV_SYSTEM_BOUNDARY,
  applySequentialCooldown,
  attributeTradeCosts,
  calculateActualFundingCost,
  compareReplayParity,
  evaluateFactorDecision,
  isHighVolatilityQ4,
  isLiveObservationOnly,
  isSession18To23Sgt,
  isWithinWindow,
  matchedPlaceboSample,
  resolveDelayedEntry,
  summarizeLfvTrades,
  trailingPITQuantile,
} from "../lib/lfv/loss-factors";

function candle(openTime: number, open: number, high = open + 1, low = open - 1) {
  return { openTime, closeTime: openTime + 899_999, open, high, low, close: open };
}

function trade(input: Partial<{
  id: string;
  symbol: string;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
  rMultiple: number;
}>) {
  return {
    id: input.id ?? "trade",
    symbol: input.symbol ?? "BTCUSDT",
    signalTime: input.signalTime ?? 0,
    entryTime: input.entryTime ?? 0,
    exitTime: input.exitTime ?? 0,
    exitReason: input.exitReason ?? "TAKE_PROFIT",
    rMultiple: input.rMultiple ?? 1,
  };
}

describe("LFV-001 frozen loss-factor rules", () => {
  it("keeps the requested baseline, combined definition, and signal-only boundary", () => {
    expect(LFV_BASELINE_SHA).toBe("7b9e5d82f471ee3c9fec07e00101263c8d84e953");
    expect(LFV_COMBINED_PRIMARY).toEqual([
      "SESSION_18_23_SGT_BLOCK",
      "HIGH_VOL_Q4_BLOCK",
      "DELAY_30M",
      "STOP_COOLDOWN_12H",
    ]);
    expect(LFV_HYPOTHESES.H1_SESSION).toBe("SESSION_18_23_SGT_BLOCK");
    expect(LFV_SYSTEM_BOUNDARY).toMatchObject({ mode: "SIGNAL + SMTP ONLY", privateBinanceApi: false, autoTrading: false });
  });

  it("converts session boundaries in UTC+8 without moving the 18:00 boundary", () => {
    expect(isSession18To23Sgt(Date.UTC(2026, 0, 1, 9, 59, 59, 999))).toBe(false);
    expect(isSession18To23Sgt(Date.UTC(2026, 0, 1, 10, 0, 0))).toBe(true);
    expect(isSession18To23Sgt(Date.UTC(2026, 0, 1, 15, 59, 59, 999))).toBe(true);
    expect(isSession18To23Sgt(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe(false);
  });

  it("uses only trailing volatility observations and excludes the current signal from the percentile", () => {
    expect(trailingPITQuantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(isHighVolatilityQ4(20, Array.from({ length: 20 }, (_, index) => index + 1))).toBe(true);
    expect(isHighVolatilityQ4(20, [20])).toBe(false);
  });

  it("uses the actual later candle open for delayed execution", () => {
    const signal = {
      id: "s1",
      symbol: "BTCUSDT",
      strategyVersion: "trend-rejection-short-v1" as const,
      signalTime: 899_999,
      side: "SHORT" as const,
      entryPrice: 100,
      stopPrice: 105,
      takeProfitPrice: 90,
      score: 70,
      theoreticalRiskUsdt: 100,
    };
    const result = resolveDelayedEntry(signal, [candle(900_001, 101), candle(1_800_001, 102), candle(2_700_001, 103)], 30);
    expect(result).toMatchObject({ status: "EXECUTED", entryTime: 2_700_001, entryPrice: 103 });
    expect(result.status === "EXECUTED" && result.entryPrice).not.toBe(signal.entryPrice);
  });

  it("expires before delayed entry when the original stop or target is touched", () => {
    const signal = {
      id: "s2",
      symbol: "ETHUSDT",
      strategyVersion: "rules-profit-oriented-v4" as const,
      signalTime: 899_999,
      side: "LONG" as const,
      entryPrice: 100,
      stopPrice: 95,
      takeProfitPrice: 110,
      score: 70,
      theoreticalRiskUsdt: 100,
    };
    expect(resolveDelayedEntry(signal, [candle(900_001, 96, 98, 94), candle(2_700_001, 103)], 30)).toMatchObject({
      status: "EXPIRED_BEFORE_ENTRY",
      reason: "STOP_TRIGGERED",
    });
  });

  it("fails closed when no later complete candle is available", () => {
    const signal = {
      id: "s3",
      symbol: "BTCUSDT",
      strategyVersion: "trend-rejection-short-v1" as const,
      signalTime: 899_999,
      side: "SHORT" as const,
      entryPrice: 100,
      stopPrice: 105,
      takeProfitPrice: 90,
      score: 70,
      theoreticalRiskUsdt: 100,
    };
    expect(resolveDelayedEntry(signal, [candle(900_001, 101)], 30)).toEqual({ status: "UNAVAILABLE", reason: "NO_LATER_COMPLETE_CANDLE" });
  });

  it("applies cooldown sequentially only after an earlier loss is settled", () => {
    const result = applySequentialCooldown([
      trade({ id: "first", signalTime: 0, entryTime: 0, exitTime: 1_000, exitReason: "STOP_LOSS", rMultiple: -1 }),
      trade({ id: "blocked", signalTime: 2_000, entryTime: 2_000, exitTime: 3_000 }),
      trade({ id: "allowed", signalTime: 12 * 60 * 60 * 1000 + 1_001, entryTime: 12 * 60 * 60 * 1000 + 1_001, exitTime: 12 * 60 * 60 * 1000 + 2_000 }),
    ], 12);
    expect(result.kept.map((item) => item.id)).toEqual(["first", "allowed"]);
    expect(result.suppressed.map((item) => item.id)).toEqual(["blocked"]);
  });

  it("accounts for two-sided fees, slippage, and actual funding without a missing-data penalty", () => {
    const costs = attributeTradeCosts({ grossPnlUsdt: 100, notionalUsdt: 1_000, fundingUsdt: 2 });
    expect(costs.feesUsdt).toBeCloseTo(0.8);
    expect(costs.slippageUsdt).toBeCloseTo(0.4);
    expect(costs.netPnlUsdt).toBeCloseTo(96.8);
    expect(calculateActualFundingCost(1_000, "LONG", [{ calc_time: 100, funding_interval_hours: 8, last_funding_rate: 0.0001 }], 0, 200)).toBeCloseTo(0.1);
  });

  it("compares parity with the frozen tolerances", () => {
    const record = { side: "SHORT", strategyVersion: "trend-rejection-short-v1", score: 70, entryPrice: 100, stopPrice: 105, takeProfitPrice: 90 };
    expect(compareReplayParity(record, record).matches).toBe(true);
    expect(compareReplayParity(record, { ...record, score: 70.6 }).matches).toBe(false);
    expect(compareReplayParity(record, { ...record, entryPrice: 100.3 }).matches).toBe(false);
  });

  it("keeps August live observations outside every training window", () => {
    expect(isLiveObservationOnly(LFV_LIVE_OBSERVATION_CUTOFF)).toBe(true);
    expect(isLiveObservationOnly(LFV_LIVE_OBSERVATION_CUTOFF - 1)).toBe(false);
    expect(isWithinWindow(Date.UTC(2025, 6, 1), Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31, 23, 59, 59, 999))).toBe(true);
    expect(isWithinWindow(LFV_LIVE_OBSERVATION_CUTOFF, Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toBe(false);
  });

  it("makes placebo removal deterministic and size-matched", () => {
    const values = Array.from({ length: 100 }, (_, index) => index);
    expect(matchedPlaceboSample(values, 25, 130001)).toEqual(matchedPlaceboSample(values, 25, 130001));
    expect(matchedPlaceboSample(values, 25, 130001)).toHaveLength(25);
  });

  it("summarizes the immutable trade outcomes without changing exits", () => {
    const metrics = summarizeLfvTrades([{ rMultiple: 1 }, { rMultiple: -0.5 }, { rMultiple: 1 }]);
    expect(metrics).toMatchObject({ trades: 3, wins: 2, losses: 1, netR: 1.5, avgR: 0.5, maxDrawdownR: 0.5 });
  });

  it("marks a signal blocked when any combined gate component blocks it", () => {
    const signal = {
      id: "s4",
      symbol: "BTCUSDT",
      strategyVersion: "trend-rejection-short-v1" as const,
      signalTime: Date.UTC(2026, 0, 1, 10),
      side: "SHORT" as const,
      entryPrice: 100,
      stopPrice: 105,
      takeProfitPrice: 90,
      score: 70,
      theoreticalRiskUsdt: 100,
    };
    const result = evaluateFactorDecision({ signal, currentVolatility: 1, volatilityHistoryBeforeSignal: [], delayedEntry: { status: "UNAVAILABLE", reason: "NO_LATER_COMPLETE_CANDLE" }, cooldownBlocked: false });
    expect(result.sessionBlocked).toBe(true);
    expect(result.combinedBlocked).toBe(true);
  });
});
