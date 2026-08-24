import { describe, expect, it } from "vitest";
import {
  applyAdditionalSlippage,
  buildCostStressMetrics,
  calculateMetrics,
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
  evaluatePromotionGate,
  isHoldoutExcludedFromSelection,
  isNoLookahead,
  summarizeAttrition,
  type ValidationTrade,
} from "@/lib/v5-2/validation";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function trade(index: number, rMultiple: number, side: "LONG" | "SHORT" = "LONG"): ValidationTrade {
  return {
    symbol: index % 3 === 0 ? "BTCUSDT" : index % 3 === 1 ? "ETHUSDT" : "SOLUSDT",
    side,
    entryTime: Date.UTC(2024, 0, 1) + index * DAY,
    rMultiple,
    netPnlUsdt: rMultiple * 50,
    theoreticalRiskUsdt: 50,
    feesUsdt: 1,
    slippageUsdt: 0.2,
  };
}

describe("V5.2 validation controls", () => {
  it("creates six purged folds with a 72-hour gap and isolates holdout", () => {
    const start = Date.UTC(2023, 0, 1);
    const end = Date.UTC(2026, 0, 1);
    const folds = createPurgedWalkForwardFolds({
      start,
      end,
      initialTrainMonths: 12,
      validationMonths: 3,
      foldCount: 6,
      purgeHours: 72,
    });
    expect(folds).toHaveLength(6);
    for (const fold of folds) {
      expect(fold.trainEnd).toBeLessThan(fold.purgeStart);
      expect(fold.purgeEnd - fold.purgeStart + 1).toBe(72 * HOUR);
      expect(fold.purgeEnd).toBeLessThan(fold.validationStart);
    }
    const holdout = createFrozenHoldoutWindow(end, folds, 72);
    expect(holdout).not.toBeNull();
    expect(holdout!.start).toBeGreaterThan(folds.at(-1)!.validationEnd);
    expect(isHoldoutExcludedFromSelection(folds[0].trainEnd, holdout!.start)).toBe(true);
  });

  it("calculates true sequential drawdown and confidence metrics", () => {
    const metrics = calculateMetrics([trade(0, 1), trade(1, -2), trade(2, 1)]);
    expect(metrics.netR).toBe(0);
    expect(metrics.maxDrawdownR).toBe(2);
    expect(metrics.maxDrawdownPercent).toBe(2);
    expect(metrics.profitFactor).toBe(1);
    expect(metrics.lowerConfidenceBound95).not.toBeNull();
  });

  it("rejects a feature timestamp that is after the candidate timestamp", () => {
    expect(isNoLookahead(100, 99)).toBe(true);
    expect(isNoLookahead(100, 100)).toBe(true);
    expect(isNoLookahead(100, 101)).toBe(false);
  });

  it("keeps cost stress from improving a result", () => {
    const trades = [trade(0, 1), trade(1, 1), trade(2, -0.5)];
    const stressed = applyAdditionalSlippage(trades, 10);
    expect(stressed.reduce((sum, item) => sum + item.rMultiple, 0))
      .toBeLessThan(trades.reduce((sum, item) => sum + item.rMultiple, 0));
    const stressMetrics = buildCostStressMetrics(trades);
    expect(stressMetrics.plus10Bps.netR).toBeLessThan(stressMetrics.base.netR);
    expect(stressMetrics.plus15Bps.netR).toBeLessThan(stressMetrics.plus10Bps.netR);
  });

  it("accounts for every attrition input and rejection", () => {
    const observations = [
      { side: "LONG" as const, fold: "fold-1", symbol: "BTCUSDT", marketRegime: "BULL", stages: { RAW: true, QUALITY: true, FINAL: true } },
      { side: "LONG" as const, fold: "fold-1", symbol: "ETHUSDT", marketRegime: "BULL", stages: { RAW: true, QUALITY: false, FINAL: false } },
      { side: "SHORT" as const, fold: "fold-1", symbol: "SOLUSDT", marketRegime: "BEAR", stages: { RAW: true, QUALITY: true, FINAL: false } },
    ];
    const rows = summarizeAttrition(observations, ["RAW", "QUALITY", "FINAL"]);
    expect(rows.find((row) => row.side === "LONG" && row.stage === "RAW")).toMatchObject({ input: 2, passed: 2, rejected: 0 });
    expect(rows.find((row) => row.side === "LONG" && row.stage === "QUALITY")).toMatchObject({ input: 2, passed: 1, rejected: 1 });
    expect(rows.find((row) => row.side === "LONG" && row.stage === "FINAL")).toMatchObject({ input: 1, passed: 1, rejected: 0 });
    expect(rows.find((row) => row.side === "SHORT" && row.stage === "FINAL")).toMatchObject({ input: 1, passed: 0, rejected: 1 });
  });

  it("evaluates LONG and SHORT promotion gates independently", () => {
    const goodTrades = Array.from({ length: 120 }, (_, index) => ({
      ...trade(index, index % 4 === 0 ? -0.5 : 1),
      symbol: "S" + index,
    }));
    const weakTrades = Array.from({ length: 120 }, (_, index) => trade(index, -0.5, "SHORT"));
    const good = calculateMetrics(goodTrades);
    const weak = calculateMetrics(weakTrades);
    const goodStress = buildCostStressMetrics(goodTrades);
    const weakStress = buildCostStressMetrics(weakTrades);
    const folds = Array.from({ length: 6 }, () => ({ netR: 10, trades: 20 }));
    const holdout = calculateMetrics(goodTrades.slice(0, 40));
    const longDecision = evaluatePromotionGate({
      metrics: good,
      holdout,
      control: weak,
      costStress: goodStress,
      folds,
      dataQuality: { passed: true, reason: "complete immutable fixture" },
    });
    const shortDecision = evaluatePromotionGate({
      metrics: weak,
      holdout: calculateMetrics(weakTrades.slice(0, 40)),
      control: good,
      costStress: weakStress,
      folds: Array.from({ length: 6 }, () => ({ netR: -10, trades: 20 })),
      dataQuality: { passed: true, reason: "complete immutable fixture" },
    });
    expect(longDecision.status).toBe("PRODUCTION_EMAIL_ELIGIBLE");
    expect(shortDecision.status).toBe("SHADOW_ONLY");
  });

  it("exposes concentration, sample-size, confidence, and regime gate failures", () => {
    const concentratedTrades = Array.from({ length: 120 }, (_, index) => ({
      ...trade(index, index % 4 === 0 ? -0.5 : 1),
      symbol: "ONE_SYMBOL",
    }));
    const concentrated = calculateMetrics(concentratedTrades);
    const stress = buildCostStressMetrics(concentratedTrades);
    const input = {
      metrics: concentrated,
      holdout: calculateMetrics(concentratedTrades.slice(0, 40)),
      control: calculateMetrics(Array.from({ length: 120 }, (_, index) => trade(index, -0.25))),
      costStress: stress,
      folds: Array.from({ length: 6 }, () => ({ netR: 10, trades: 20 })),
      dataQuality: { passed: true, reason: "fixture" },
      regimeMetrics: [{ regime: "BEAR", metrics: calculateMetrics(Array.from({ length: 12 }, (_, index) => trade(index, -0.5, "SHORT"))) }],
    };
    const decision = evaluatePromotionGate(input);
    const gate = (id: string) => decision.gates.find((item) => item.id === id)?.passed;
    expect(gate("concentration")).toBe(false);
    expect(gate("regime_conditional")).toBe(false);
    expect(evaluatePromotionGate({ ...input, metrics: calculateMetrics(concentratedTrades.slice(0, 10)) }).gates.find((item) => item.id === "minimum_sample_size")?.passed).toBe(false);
    expect(evaluatePromotionGate({ ...input, metrics: calculateMetrics(Array.from({ length: 120 }, (_, index) => trade(index, index % 2 === 0 ? -1 : 1))) }).gates.find((item) => item.id === "lower_confidence_bound")?.passed).toBe(false);
  });
});
