import { describe, expect, it } from "vitest";
import { calculateV15Cost } from "@/lib/v15/cost";
import { validateKlineIntegrity } from "@/lib/v15/archive";
import { metricsAtStress, type V15TradeRecord } from "@/lib/v15/engine";
import { V15_CONSTANTS, type V15Bar } from "@/lib/v15/lead-lag";

function bar(openTime: number, open: number, close = open, overrides: Partial<V15Bar> = {}): V15Bar {
  return {
    openTime,
    closeTime: openTime + 299_999,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    quoteVolume: 100,
    takerBuyQuoteVolume: 60,
    ...overrides,
  };
}

function trade(netR: number): V15TradeRecord {
  return {
    symbol: "BTCUSDT",
    direction: 1,
    decisionTime: 1,
    entryTime: 2,
    exitTime: 3,
    entryPrice: 100,
    exitPrice: 100,
    riskPrice: 1,
    stopPrice: 99,
    takeProfitPrice: 102,
    exitReason: "TIME",
    spotShock: 0,
    leadStrength: 0,
    spotFlow30: 0,
    perpFlow30: 0,
    grossPnl: netR,
    grossR: netR,
    feesR: 0,
    slippageR: 0,
    fundingR: 0,
    netR,
    netPnl: netR,
    stressNetR: { 5: netR - 0.001, 10: netR - 0.002, 20: netR - 0.004 },
  };
}

describe("V15 immutable data and result engine", () => {
  it("rejects duplicate, non-monotonic, and invalid-duration bars", () => {
    const result = validateKlineIntegrity([
      bar(0, 100),
      bar(300_000, 100),
      bar(300_000, 100),
      bar(200_000, 100, 100, { closeTime: 100_000 }),
    ]);
    expect(result.duplicateOpenTimes).toBe(1);
    expect(result.nonMonotonicOpenTimes).toBe(2);
    expect(result.invalidDurations).toBe(1);
    expect(result.cadenceCoverage).toBe(0);
  });

  it("calculates base and stress costs from entry/risk without a second slippage charge", () => {
    const cost = calculateV15Cost(100, 2, 1, 0);
    expect(cost.feesR).toBeCloseTo(0.04, 12);
    expect(cost.slippageR).toBeCloseTo(0.02, 12);
    expect(cost.netR).toBeCloseTo(0.94, 12);
    expect(calculateV15Cost(100, 2, 1, 0, 10).netR).toBeCloseTo(0.84, 12);
  });

  it("aggregates exact stress metrics deterministically", () => {
    const metrics = metricsAtStress([trade(1), trade(-0.5)], 10);
    expect(metrics.trades).toBe(2);
    expect(metrics.netR).toBeCloseTo(0.496, 12);
    expect(metrics.profitFactor).toBeGreaterThan(0);
    expect(V15_CONSTANTS.decisionIntervalMs).toBe(15 * 60_000);
  });
});
