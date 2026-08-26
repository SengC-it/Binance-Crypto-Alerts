import { describe, expect, it } from "vitest";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { sha256Json } from "@/lib/v5-7/manifest";
import {
  applyRegimeGate,
  buildRegimeLabels,
  evaluateFreshPromotionGate,
  summarizeRegimeTrades,
  V58_BURNED_EXTERNAL_END,
  V58_BURNED_EXTERNAL_START,
  V58_FRESH_END,
  V58_FRESH_START,
  V58_REGIME_GATE_REGISTRY,
  type V58RegimeLabels,
  type V58RegimeTrade,
} from "@/lib/v5-8/regime";

describe("V5.8 regime dependency reconstruction", () => {
  it("keeps the eight-gate registry frozen and bounded", () => {
    expect(V58_REGIME_GATE_REGISTRY).toHaveLength(8);
    expect(sha256Json(V58_REGIME_GATE_REGISTRY)).toBe("185de7195a98bbe573545256798481fed00703a26ba31e60a3af875086776100");
  });

  it("keeps the burned diagnostic window outside fresh validation", () => {
    expect(V58_FRESH_END).toBeLessThan(V58_BURNED_EXTERNAL_START);
    expect(V58_FRESH_START).toBeLessThan(V58_FRESH_END);
    expect(V58_BURNED_EXTERNAL_START).toBeLessThan(V58_BURNED_EXTERNAL_END);
  });

  it("builds fixed regime buckets from closed signal features", () => {
    const frame = { marketRegime: "BULL", btcRegime: "BULL", ethRegime: "BULL", breadth: 0.62, atrPercentile: 0.5, volatilityPercentile: 0.9, fundingPercentile: 0.5, bearTrendAge: 32, volumeRatio: 1.2 } as FeatureFrame;
    const labels = buildRegimeLabels(frame, []);
    expect(labels.btcEthAlignment).toBe("ALIGNED_BULL");
    expect(labels.breadthBucket).toBe("50_75");
    expect(labels.atrPercentileBucket).toBe("MID");
    expect(labels.volatilityPercentileBucket).toBe("HIGH");
    expect(labels.fundingPercentileBucket).toBe("MID");
    expect(labels.trendAgeBucket).toBe("16_47");
    expect(labels.btc24hTrend).toBe("UNKNOWN");
  });

  it("filters only the frozen trade set and does not change plan provenance", () => {
    const original = makeTrade({ rMultiple: 0.75 });
    const filtered = applyRegimeGate([original], V58_REGIME_GATE_REGISTRY[0]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual(original);
    expect(filtered[0].riskPrice).toBe(original.riskPrice);
    expect(filtered[0].stopPrice).toBe(original.stopPrice);
    expect(filtered[0].targetPrice).toBe(original.targetPrice);
    expect(filtered[0].strategyIdentity).toBe("V561-SHORT-FAILED-BREAKOUT-REVERSAL-01");
  });

  it("returns INCONCLUSIVE when the fresh gated sample has fewer than 20 trades", () => {
    const result = evaluateFreshPromotionGate(Array.from({ length: 9 }, (_, index) => makeTrade({ entryTime: Date.UTC(2020, index, 2), rMultiple: 0.5 })), V58_REGIME_GATE_REGISTRY[0]);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.gated.trades).toBe(9);
    expect(result.gate.trades).toBe(false);
  });

  it("reports stop rate, CVaR, and positive periods from the same settled trade series", () => {
    const trades = [
      makeTrade({ entryTime: Date.UTC(2020, 0, 2), rMultiple: -1, exitReason: "STOP" }),
      makeTrade({ entryTime: Date.UTC(2020, 1, 2), rMultiple: 0.8, exitReason: "TAKE_PROFIT" }),
      makeTrade({ entryTime: Date.UTC(2020, 2, 2), rMultiple: 0.4, exitReason: "TAKE_PROFIT" }),
    ];
    const summary = summarizeRegimeTrades(trades);
    expect(summary.trades).toBe(3);
    expect(summary.stopRate).toBeCloseTo(1 / 3);
    expect(summary.cvar95).toBe(-1);
    expect(summary.positivePeriods).toBe(2);
    expect(summary.periods).toBe(3);
  });
});

const matchingLabels: V58RegimeLabels = {
  marketRegime: "BULL",
  btcRegime: "BULL",
  ethRegime: "BULL",
  btcEthAlignment: "ALIGNED_BULL",
  breadthBucket: "50_75",
  atrPercentileBucket: "MID",
  volatilityPercentileBucket: "MID",
  fundingPercentileBucket: "MID",
  trendAgeBucket: "16_47",
  marketWideMomentumBucket: "BULLISH",
  btc24hTrend: "FLAT",
  btc7dTrend: "FLAT",
  crossSectionalDispersionBucket: "MID",
  liquidityVolumeBucket: "NORMAL",
};

function makeTrade(overrides: Partial<V58RegimeTrade> = {}): V58RegimeTrade {
  const rMultiple = overrides.rMultiple ?? 0.5;
  return {
    symbol: "BTCUSDT",
    side: "SHORT",
    entryTime: Date.UTC(2020, 0, 2),
    exitTime: Date.UTC(2020, 0, 2, 1),
    rMultiple,
    netPnlUsdt: rMultiple * 50,
    pnlUsdt: rMultiple * 50,
    theoreticalRiskUsdt: 50,
    feesUsdt: 0,
    fundingUsdt: 0,
    slippageUsdt: 0,
    marketRegime: "BULL",
    candidateId: "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01",
    strategyIdentity: "V561-SHORT-FAILED-BREAKOUT-REVERSAL-01",
    family: "FAILED_BREAKOUT_REVERSAL",
    entryPrice: 100,
    exitPrice: 99,
    stopPrice: 101,
    targetPrice: 98,
    riskPrice: 1,
    mfeR: 1,
    maeR: 0.1,
    timeToMfeHours: 1,
    timeToMaeHours: 0.25,
    exitReason: "TAKE_PROFIT",
    delayedEntryBars: 0,
    signalCandleCloseTime: Date.UTC(2020, 0, 2) - 1,
    executionCandleOpenTime: Date.UTC(2020, 0, 2),
    executionReferencePrice: 100,
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    pool: "FRESH_VALIDATION",
    labels: matchingLabels,
    ...overrides,
  };
}
