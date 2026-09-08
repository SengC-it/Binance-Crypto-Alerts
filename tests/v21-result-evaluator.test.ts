import { describe, expect, it } from "vitest";
import {
  V21_BOOTSTRAP_CONTRACT,
  V21_CLASSIFICATION_CONTRACT,
  V21_COST_CONTRACT,
  V21_EXECUTION_CONTRACT,
  applyV21Cost,
  bootstrapV21PrimaryAvgNet,
  calculateV21GrossReturn,
  evaluateV21PriceOutcome,
  evaluateV21Promotion,
  mapV21ExecutionIndices,
  sliceV21OutcomesBySymbol,
  sliceV21OutcomesByYear,
  summarizeV21Concentration,
  summarizeV21Outcomes,
  summarizeV21Returns,
  type V21EvaluatedOutcome,
  type V21PromotionInput,
} from "../lib/v21/result-evaluator";

describe("V21 frozen result evaluator", () => {
  it("uses directional gross formulas", () => {
    expect(calculateV21GrossReturn("LONG", 100, 110)).toBeCloseTo(0.1, 12);
    expect(calculateV21GrossReturn("SHORT", 100, 90)).toBeCloseTo(0.1, 12);
  });

  it("maps entry to the next bar open and uses exact horizon indices", () => {
    const primary = mapV21ExecutionIndices(10, 30, "PRIMARY_30M");
    expect(primary.entryIndex).toBe(11);
    expect(primary.exitIndex).toBe(16);
    expect(primary.exitCloseBoundaryIndex).toBe(17);
    expect(primary.fullBarsHeld).toBe(6);
    expect(primary.entryIndex).not.toBe(primary.signalIndex);

    const shortDiagnostic = mapV21ExecutionIndices(10, 30, "DIAGNOSTIC_15M");
    expect(shortDiagnostic.exitIndex).toBe(13);
    expect(shortDiagnostic.exitCloseBoundaryIndex).toBe(14);
    const longDiagnostic = mapV21ExecutionIndices(10, 30, "DIAGNOSTIC_60M");
    expect(longDiagnostic.exitIndex).toBe(22);
    expect(longDiagnostic.exitCloseBoundaryIndex).toBe(23);
  });

  it("fails closed at the dataset boundary without repairing or shortening", () => {
    const unavailable = mapV21ExecutionIndices(25, 30, "PRIMARY_30M");
    expect(unavailable.outcomeAvailable).toBe(false);
    expect(unavailable.outcomeStatus).toBe("OUTCOME_UNAVAILABLE");
    expect(evaluateV21PriceOutcome({
      symbol: "BTCUSDT",
      signalOpenTime: 25,
      direction: "LONG",
      clusterId: 25,
      entryPrice: 100,
      exitPrice: 101,
      mapping: unavailable,
    })).toBeNull();
  });

  it("freezes baseline and additive stress costs", () => {
    expect(V21_COST_CONTRACT.totalRoundTripBps).toEqual({
      BASELINE: 12,
      STRESS_5_BPS: 17,
      STRESS_10_BPS: 22,
      STRESS_20_BPS: 32,
    });
    expect(applyV21Cost(0.01, "BASELINE")).toBeCloseTo(0.0088, 12);
    expect(applyV21Cost(0.01, "STRESS_5_BPS")).toBeCloseTo(0.0083, 12);
    expect(applyV21Cost(0.01, "STRESS_10_BPS")).toBeCloseTo(0.0078, 12);
    expect(applyV21Cost(0.01, "STRESS_20_BPS")).toBeCloseTo(0.0068, 12);
  });

  it("uses sum, mean, and the frozen profit-factor edge cases", () => {
    const summary = summarizeV21Returns([0.02, -0.01, 0.03]);
    expect(summary.net).toBeCloseTo(0.04, 12);
    expect(summary.averageNet).toBeCloseTo(0.04 / 3, 12);
    expect(summary.profitFactor).toBeCloseTo(5, 12);
    expect(summary.winRate).toBeCloseTo(2 / 3, 12);
    expect(summarizeV21Returns([-0.01, -0.02]).profitFactor).toBe(0);
    expect(summarizeV21Returns([0.01, 0.02]).profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it("supports year/symbol slices and positive-gross concentration", () => {
    const outcomes = [
      outcome("BTCUSDT", "2022", 1, 0.1),
      outcome("BTCUSDT", "2023", 2, -0.02),
      outcome("ETHUSDT", "2024", 3, 0.03),
    ];
    expect(sliceV21OutcomesByYear(outcomes, "2022")).toHaveLength(1);
    expect(sliceV21OutcomesBySymbol(outcomes, "ETHUSDT")).toHaveLength(1);
    const concentration = summarizeV21Concentration(outcomes);
    expect(concentration.maxSingleSymbolTradeShare).toBeCloseTo(2 / 3, 12);
    expect(concentration.totalPositiveGrossContribution).toBeCloseTo(0.1324, 12);
    expect(concentration.maxSingleSymbolPositiveGrossContribution).toBeCloseTo(0.1012 / 0.1324, 12);
  });

  it("keeps all same-cluster trades together and bootstraps exactly 10000 times", () => {
    const outcomes = [
      outcome("BTCUSDT", "2022", 1, 0.01),
      outcome("ETHUSDT", "2022", 1, 0.02),
      outcome("BNBUSDT", "2023", 2, -0.01),
    ];
    const first = bootstrapV21PrimaryAvgNet(outcomes);
    const second = bootstrapV21PrimaryAvgNet(outcomes);
    expect(first.values).toHaveLength(10_000);
    expect(first.values).toEqual(second.values);
    expect(first.seed).toBe(V21_BOOTSTRAP_CONTRACT.seed);
    expect(first.replications).toBe(10_000);
    expect(first.lcbRank).toBe(250);
    expect(first.lcb95).toBe([...first.values].sort((a, b) => a - b)[249]);
    expect(() => bootstrapV21PrimaryAvgNet(outcomes, V21_BOOTSTRAP_CONTRACT.seed + 1)).toThrow(/seed is frozen/);
    expect(() => bootstrapV21PrimaryAvgNet(outcomes, V21_BOOTSTRAP_CONTRACT.seed, 9_999)).toThrow(/replication count is frozen/);
    expect(new Set(outcomes.slice(0, 2).map((entry) => entry.clusterId)).size).toBe(1);
    expect(() => bootstrapV21PrimaryAvgNet([{ ...outcomes[0], clusterId: outcomes[0].signalOpenTime + 1 }])).toThrow(/cluster identity is immutable/);
    expect(() => bootstrapV21PrimaryAvgNet([{ ...outcomes[0], year: "2023" }])).toThrow(/year must be derived/);
  });

  it("keeps TIME_MATCHED_RANDOM outside the promotion gate", () => {
    const passing = passingPromotionInput();
    const pass = evaluateV21Promotion(passing);
    expect(pass.passed).toBe(true);
    expect(pass.classification).toBe(V21_CLASSIFICATION_CONTRACT.promotionCandidate);
    expect(pass.productionEmail).toBe("OFF");
    expect(pass.automaticPromotion).toBe(false);
    expect(Object.keys(pass.gates).join(" ")).not.toContain("TIME_MATCHED_RANDOM");

    const failed = evaluateV21Promotion({
      ...passing,
      primary: { ...passing.primary, net: 0 },
    });
    expect(failed.passed).toBe(false);
    expect(failed.classification).toBe(V21_CLASSIFICATION_CONTRACT.rejected);
    expect(failed.researchStop).toBe(true);
  });

  it("evaluates a synthetic price outcome without changing the frozen entry contract", () => {
    const mapping = mapV21ExecutionIndices(10, 30, "PRIMARY_30M");
    const signalOpenTime = Date.parse("2022-01-01T00:00:00.000Z");
    const evaluated = evaluateV21PriceOutcome({
      symbol: "BTCUSDT",
      signalOpenTime,
      direction: "LONG",
      clusterId: signalOpenTime,
      entryPrice: 100,
      exitPrice: 110,
      mapping,
    });
    expect(evaluated?.grossReturn).toBeCloseTo(0.1, 12);
    expect(evaluated?.baselineNetReturn).toBeCloseTo(0.0988, 12);
    expect(evaluated?.year).toBe("2022");
    expect(V21_EXECUTION_CONTRACT.entryUsesSignalClose).toBe(false);
    expect(V21_EXECUTION_CONTRACT.entryPriceField).toBe("open");
    expect(V21_EXECUTION_CONTRACT.exitPriceField).toBe("close");
    expect(() => evaluateV21PriceOutcome({
      symbol: "BTCUSDT",
      signalOpenTime,
      direction: "LONG",
      clusterId: signalOpenTime + 1,
      entryPrice: 100,
      exitPrice: 110,
      mapping,
    })).toThrow(/cluster identity is immutable/);
  });
});

function outcome(
  symbol: "BTCUSDT" | "ETHUSDT" | "BNBUSDT",
  year: string,
  signalOpenTimeOffset: number,
  baselineNetReturn: number,
): V21EvaluatedOutcome {
  const signalOpenTime = Date.parse(`${year}-01-01T00:00:00.000Z`) + signalOpenTimeOffset * 5 * 60 * 1000;
  return {
    symbol,
    signalOpenTime,
    direction: "LONG",
    clusterId: signalOpenTime,
    year: new Date(signalOpenTime).getUTCFullYear().toString(),
    grossReturn: baselineNetReturn + 0.0012,
    baselineNetReturn,
    stress5NetReturn: baselineNetReturn - 0.0005,
    stress10NetReturn: baselineNetReturn - 0.001,
    stress20NetReturn: baselineNetReturn - 0.002,
  };
}

function passingPromotionInput(): V21PromotionInput {
  const primaryEventsBySymbol = Object.fromEntries([
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "ADAUSDT",
    "BCHUSDT",
    "DOGEUSDT",
    "LINKUSDT",
    "DOTUSDT",
  ].map((symbol) => [symbol, 150]));
  const primaryNetBySymbol = Object.fromEntries(Object.keys(primaryEventsBySymbol).map((symbol) => [symbol, 1]));
  const positiveGrossBySymbol = Object.fromEntries(Object.keys(primaryEventsBySymbol).map((symbol) => [symbol, 1]));
  return {
    primary: { sampleSize: 1200, net: 12, averageNet: 0.01, profitFactor: 2, winRate: 0.6 },
    primaryStress10: { sampleSize: 1200, net: 1, averageNet: 0.0008, profitFactor: 1.3, winRate: 0.55 },
    holdoutA: { sampleSize: 300, net: 1, averageNet: 0.003, profitFactor: 1.4, winRate: 0.55 },
    holdoutB: { sampleSize: 300, net: 1, averageNet: 0.003, profitFactor: 1.4, winRate: 0.55 },
    primaryClusterCount: 600,
    primaryEventsBySymbol,
    primaryNetBySymbol,
    primaryNetByYear: { "2022": 1, "2023": 1, "2024": 1 },
    concentration: {
      maxSingleSymbolTradeShare: 0.2,
      maxSingleSymbolPositiveGrossContribution: 0.2,
      totalPositiveGrossContribution: 8,
      positiveGrossBySymbol,
    },
    bootstrapLcb95: 0.001,
    rawReturnReversalPrimaryAvgNet: -0.001,
    simpleMedianGapReversalPrimaryAvgNet: -0.002,
  };
}
