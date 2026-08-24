import { describe, expect, it } from "vitest";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, Instrument } from "@/lib/core/types";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";
import {
  buildPerturbationSummary,
  candidateFamilies,
  extensionBucket,
  removeTopTrades,
  selectionAdjustedLowerConfidenceBound,
  summarizeExtensionBuckets,
  trueEquityDrawdown,
  V53_CANDIDATE_REGISTRY,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import {
  calculateMetrics,
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
} from "@/lib/v5-2/validation";

function candle(index: number, close: number): Candle {
  const openTime = index * 15 * 60 * 1000;
  return { openTime, closeTime: openTime + 15 * 60 * 1000 - 1, open: close, high: close + 1, low: close - 1, close, volume: 100 + index };
}

function dataset(count = 240): HistoricalDataset {
  const candles = Array.from({ length: count }, (_, index) => candle(index, 100 + Math.sin(index / 8) * 3 + index * 0.02));
  const instrument: Instrument = {
    symbol: "TESTUSDT",
    baseAsset: "TEST",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    priceTick: 0.01,
    quantityStep: 0.001,
  };
  return { symbol: "TESTUSDT", instrument, candles: { "15m": candles } };
}

function trade(index: number, rMultiple: number, symbol = "TESTUSDT"): StructuralTrade {
  return {
    symbol,
    side: "LONG",
    entryTime: index * 60 * 60 * 1000,
    exitTime: (index + 1) * 60 * 60 * 1000,
    rMultiple,
    netPnlUsdt: rMultiple * 50,
    pnlUsdt: rMultiple * 50,
    theoreticalRiskUsdt: 50,
    candidateId: "TEST",
    family: "TREND_PULLBACK_LONG",
    stopStyle: "HYBRID",
    entryPrice: 100,
    exitPrice: 100 + rMultiple,
    entryExtensionATR: 0.2,
    mfeR: Math.max(0, rMultiple),
    maeR: Math.max(0, -rMultiple),
    timeToMfeHours: 1,
    timeToMaeHours: 1,
    hitHalfRBeforeStop: rMultiple > 0.5,
    hitOneRBeforeStop: rMultiple > 1,
    exitReason: rMultiple > 0 ? "TAKE_PROFIT" : "STOP",
    delayedEntryBars: 0,
  };
}

describe("V5.3 registry and isolation", () => {
  it("keeps three families and a finite preregistered search space per direction", () => {
    expect(candidateFamilies("LONG")).toHaveLength(3);
    expect(candidateFamilies("SHORT")).toHaveLength(3);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "LONG")).toHaveLength(9);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "SHORT")).toHaveLength(9);
    for (const family of candidateFamilies("LONG").concat(candidateFamilies("SHORT"))) {
      expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.family === family).length).toBeLessThanOrEqual(5);
    }
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "LONG").every((candidate) => candidate.family.includes("LONG") || candidate.family === "BREAKOUT_RETEST_V2")).toBe(true);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "SHORT").every((candidate) => candidate.family.includes("SHORT") || candidate.family === "FAILED_BREAKOUT_SHORT")).toBe(true);
  });

  it("creates purged outer folds and excludes the frozen holdout from selection", () => {
    const start = Date.UTC(2020, 0, 1);
    const end = Date.UTC(2024, 0, 1);
    const folds = createPurgedWalkForwardFolds({ start, end, initialTrainMonths: 12, validationMonths: 3, foldCount: 6, purgeHours: 72 });
    const holdout = createFrozenHoldoutWindow(end, folds, 72);
    expect(folds).toHaveLength(6);
    expect(folds.every((fold) => fold.purgeEnd - fold.purgeStart + 1 >= 72 * 60 * 60 * 1000)).toBe(true);
    expect(holdout).not.toBeNull();
    expect(folds.every((fold) => fold.validationEnd < (holdout?.start ?? Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe("V5.3 entry-time features", () => {
  it("does not change an earlier feature frame when future candles change", () => {
    const original = dataset();
    const changed = dataset();
    changed.candles["15m"].forEach((row, index) => {
      if (index > 180) row.close += 10_000;
    });
    const first = buildFeatureFrames(original, { entryStrideBars: 4 });
    const second = buildFeatureFrames(changed, { entryStrideBars: 4 });
    const target = first.findIndex((frame) => frame.index < 180);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(second[target].signalTimestamp).toBe(first[target].signalTimestamp);
    expect(second[target].close).toBe(first[target].close);
    expect(second[target].atr).toBe(first[target].atr);
    expect(second[target].longEntryExtensionATR).toBe(first[target].longEntryExtensionATR);
  });
});

describe("V5.3 confidence and robustness", () => {
  it("reports naive and selection-adjusted block-bootstrap confidence", () => {
    const series = [
      { candidateId: "A", values: [0.2, 0.1, 0.3, -0.1, 0.2, 0.1, 0.05] },
      { candidateId: "B", values: [0.3, 0.25, 0.4, -0.2, 0.25, 0.2, 0.1] },
      { candidateId: "C", values: [-0.1, 0.05, 0.01, 0.02, -0.03, 0.04, 0.02] },
    ];
    const adjusted = selectionAdjustedLowerConfidenceBound(series, "B", 200, 3);
    expect(adjusted).not.toBeNull();
    expect(Number.isFinite(adjusted!)).toBe(true);
  });

  it("keeps extension buckets and stop-path evidence without post-hoc deletion", () => {
    const rows = [trade(1, 1), { ...trade(2, -1), entryExtensionATR: 0.8 }, { ...trade(3, 0.2), entryExtensionATR: 1.2 }];
    expect(extensionBucket(0.2)).toBe("<=0.25");
    expect(extensionBucket(0.8)).toBe("0.75-1.0");
    expect(extensionBucket(1.2)).toBe(">1.0");
    expect(summarizeExtensionBuckets(rows)).toHaveLength(6);
    expect(rows).toHaveLength(3);
  });

  it("tests delayed/cost/parameter and top-trade robustness metrics", () => {
    const rows = [trade(1, 1.5), trade(2, 0.4), trade(3, -0.3), trade(4, 0.2), trade(5, 0.1)];
    const base = calculateMetrics(rows);
    const removed = calculateMetrics(removeTopTrades(rows, 3));
    const perturbations = buildPerturbationSummary(base, [
      { label: "-10%", metrics: calculateMetrics(rows.map((row) => ({ ...row, rMultiple: row.rMultiple - 0.01 }))) },
      { label: "+10%", metrics: calculateMetrics(rows.map((row) => ({ ...row, rMultiple: row.rMultiple + 0.01 }))) },
    ]);
    expect(removed.trades).toBe(2);
    expect(perturbations).toHaveLength(2);
    expect(base.trades).toBe(5);
  });

  it("reports true equity drawdown and concentration inputs", () => {
    const rows = [trade(1, 1, "A"), trade(2, -2, "B"), trade(3, 0.5, "C")];
    const drawdown = trueEquityDrawdown(rows);
    expect(drawdown.maxDrawdownUsdt).toBeGreaterThan(0);
    expect(drawdown.finalEquityUsdt).toBeLessThan(10_000);
    expect(calculateMetrics(rows).topSymbolProfitShare).not.toBeNull();
  });
});
