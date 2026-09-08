import { describe, expect, it } from "vitest";
import { V21_SYMBOLS, type V21Symbol } from "../lib/v21/constants";
import {
  V21_PIT_OBSERVATION_COUNT,
  buildPitFeature,
  leaveOneOutMedian,
  nearestRankQuantile,
  type V21ReturnRow,
} from "../lib/v21/features";
import {
  V21_Q99_RANK,
  V21_Q99_TAIL_COUNT,
  evaluateExactExtremePredicate,
} from "../lib/v21/event-predicate";

const interval = 5 * 60 * 1000;
const FEATURE_CATEGORIES = [
  "normal market",
  "changing beta",
  "changing alpha",
  "large positive residual",
  "large negative residual",
  "near-Q99",
  "exact-Q99",
  "86-greater boundary",
  "87-greater boundary",
  "ties",
  "zero residual",
  "fat-tail",
  "heteroskedastic",
] as const;

describe("V21 exact event predicate", () => {
  it("matches the buildPitFeature oracle for 10,000 synthetic feature cases", { timeout: 180000 }, () => {
    const rows = featureRows(V21_PIT_OBSERVATION_COUNT + 125);
    const categories = new Set<string>();
    let comparisonCases = 0;

    for (let rowIndex = V21_PIT_OBSERVATION_COUNT; rowIndex < rows.length; rowIndex += 1) {
      const category = FEATURE_CATEGORIES[rowIndex % FEATURE_CATEGORIES.length];
      categories.add(category);
      const currentRow = rows[rowIndex];
      const previousRow = rows[rowIndex - 1];
      const priorRows = rows.slice(rowIndex - V21_PIT_OBSERVATION_COUNT, rowIndex);

      for (const symbol of V21_SYMBOLS) {
        const reference = buildPitFeature(symbol, currentRow, previousRow, priorRows);
        expect(reference.eligible).toBe(true);
        const priorResiduals = priorRows.map((row) => (
          row.returns[symbol]
            - (reference.alpha + reference.beta * leaveOneOutMedian(row, symbol))
        ));
        for (const variant of predicateVariants(reference)) {
          const actual = evaluateExactExtremePredicate({
            priorResiduals,
            previousResidual: variant.previousResidual,
            currentResidual: variant.currentResidual,
          });
          const expectedExtreme = Math.abs(variant.currentResidual) >= reference.residualAbsQ99;
          expect(actual.currentExtreme).toBe(expectedExtreme);
          if (expectedExtreme) {
            expect(actual.exactThresholdComputed).toBe(true);
            expect(actual.residualAbsQ99).toBeCloseTo(reference.residualAbsQ99, 12);
            expect(actual.previousInside).toBe(Math.abs(variant.previousResidual) < reference.residualAbsQ99);
            expect(actual.firstCross).toBe(
              Math.abs(variant.previousResidual) < reference.residualAbsQ99
                && expectedExtreme,
            );
          } else {
            expect(actual.exactThresholdComputed).toBe(false);
            expect(actual.residualAbsQ99).toBeNull();
            expect(actual.previousInside).toBeNull();
            expect(actual.firstCross).toBeNull();
          }
          comparisonCases += 1;
        }
      }
    }

    expect(comparisonCases).toBe(10000);
    expect(categories).toEqual(new Set(FEATURE_CATEGORIES));
  });

  it("uses exact Q99 rank and tail constants", () => {
    expect(V21_Q99_RANK).toBe(8554);
    expect(V21_Q99_TAIL_COUNT).toBe(86);
  });

  it("handles exact Q99, 86-greater, 87-greater, ties, and all-equal residuals", () => {
    const exactQ99 = [
      ...Array.from({ length: V21_Q99_RANK }, () => 1),
      ...Array.from({ length: V21_Q99_TAIL_COUNT }, () => 2),
    ];
    const exact = evaluateAndCompare(exactQ99, 0.5, 1);
    expect(exact.currentExtreme).toBe(true);
    expect(exact.residualAbsQ99).toBe(1);
    expect(exact.previousInside).toBe(true);
    expect(exact.firstCross).toBe(true);
    expect(exact.residualComparisons).toBe(V21_PIT_OBSERVATION_COUNT);
    expect(exact.earlyExit).toBe(false);

    const eightySixGreater = [
      ...Array.from({ length: V21_Q99_RANK }, () => 1),
      ...Array.from({ length: V21_Q99_TAIL_COUNT }, () => 2),
    ];
    const boundary86 = evaluateAndCompare(eightySixGreater, 0.5, 1);
    expect(boundary86.currentExtreme).toBe(true);
    expect(boundary86.earlyExit).toBe(false);

    const eightySevenGreater = [
      ...Array.from({ length: V21_Q99_TAIL_COUNT + 1 }, () => 2),
      ...Array.from({ length: V21_Q99_RANK - 1 }, () => 1),
    ];
    const boundary87 = evaluateAndCompare(eightySevenGreater, 0.5, 1);
    expect(boundary87.currentExtreme).toBe(false);
    expect(boundary87.earlyExit).toBe(true);
    expect(boundary87.exactThresholdComputed).toBe(false);
    expect(boundary87.residualComparisons).toBe(V21_Q99_TAIL_COUNT + 1);

    const duplicatedQ99 = [
      ...Array.from({ length: V21_Q99_RANK - 100 }, () => 0.5),
      ...Array.from({ length: 100 }, () => 1),
      ...Array.from({ length: V21_Q99_TAIL_COUNT }, () => 2),
    ];
    expect(evaluateAndCompare(duplicatedQ99, 1, 1).currentExtreme).toBe(true);

    const allEqual = Array.from({ length: V21_PIT_OBSERVATION_COUNT }, () => 0.5);
    const equal = evaluateAndCompare(allEqual, 0.5, 0.5);
    expect(equal.currentExtreme).toBe(true);
    expect(equal.previousInside).toBe(false);
    expect(equal.firstCross).toBe(false);
    expect(equal.residualAbsQ99).toBe(0.5);
    expect(evaluateAndCompare(allEqual, 0.5, 0.4).currentExtreme).toBe(false);
  });

  it("short-circuits non-extreme features and never computes a threshold", () => {
    const prior = [
      ...Array.from({ length: V21_Q99_TAIL_COUNT + 1 }, () => 3),
      ...Array.from({ length: V21_Q99_RANK - 1 }, (_, index) => 0.1 + index / 100000),
    ];
    const result = evaluateExactExtremePredicate({
      priorResiduals: prior,
      previousResidual: 0.2,
      currentResidual: 0.1,
    });
    expect(result.currentExtreme).toBe(false);
    expect(result.residualComparisons).toBe(87);
    expect(result.earlyExit).toBe(true);
    expect(result.exactThresholdComputed).toBe(false);
    expect(result.residualAbsQ99).toBeNull();
    expect(result.previousInside).toBeNull();
    expect(result.firstCross).toBeNull();
  });

  it("computes firstCross with strict previous-inside semantics", () => {
    const prior = Array.from({ length: V21_PIT_OBSERVATION_COUNT }, () => 1);
    const inside = evaluateAndCompare(prior, 0.99, 1);
    const onBoundary = evaluateAndCompare(prior, 1, 1);
    expect(inside.previousInside).toBe(true);
    expect(inside.firstCross).toBe(true);
    expect(onBoundary.previousInside).toBe(false);
    expect(onBoundary.firstCross).toBe(false);
  });

  it("is deterministic and remains an event-predicate-only interface", () => {
    const prior = Array.from({ length: V21_PIT_OBSERVATION_COUNT }, (_, index) => 0.01 + index / 100000);
    const input = { priorResiduals: prior, previousResidual: 0.01, currentResidual: 0.2 };
    expect(evaluateExactExtremePredicate(input)).toEqual(evaluateExactExtremePredicate(input));
  });
});

function evaluateAndCompare(
  priorResiduals: number[],
  previousResidual: number,
  currentResidual: number,
) {
  const threshold = nearestRankQuantile(priorResiduals.map((value) => Math.abs(value)), 0.99);
  const expectedExtreme = Math.abs(currentResidual) >= threshold;
  const actual = evaluateExactExtremePredicate({ priorResiduals, previousResidual, currentResidual });
  expect(actual.currentExtreme).toBe(expectedExtreme);
  if (expectedExtreme) {
    expect(actual.residualAbsQ99).toBeCloseTo(threshold, 12);
    expect(actual.previousInside).toBe(Math.abs(previousResidual) < threshold);
    expect(actual.firstCross).toBe(Math.abs(previousResidual) < threshold && expectedExtreme);
  } else {
    expect(actual.residualAbsQ99).toBeNull();
    expect(actual.previousInside).toBeNull();
    expect(actual.firstCross).toBeNull();
  }
  return actual;
}

function predicateVariants(reference: V21PitFeatureLike): Array<{ previousResidual: number; currentResidual: number }> {
  const threshold = reference.residualAbsQ99;
  return [
    { previousResidual: reference.previousResidual, currentResidual: reference.currentResidual },
    { previousResidual: threshold * 0.5, currentResidual: 0 },
    { previousResidual: threshold * 0.5, currentResidual: threshold * 0.999999 },
    { previousResidual: threshold * 0.5, currentResidual: threshold },
    { previousResidual: threshold * 0.5, currentResidual: -threshold },
    { previousResidual: threshold * 0.5, currentResidual: threshold * 1.000001 },
    { previousResidual: threshold * 0.5, currentResidual: -threshold * 1.000001 },
    { previousResidual: threshold, currentResidual: threshold },
    { previousResidual: threshold * 0.25, currentResidual: threshold * 3 },
    { previousResidual: threshold * 0.25, currentResidual: -threshold * 3 },
  ];
}

interface V21PitFeatureLike {
  previousResidual: number;
  currentResidual: number;
  residualAbsQ99: number;
}

function featureRows(length: number): V21ReturnRow[] {
  return Array.from({ length }, (_, index) => {
    const category = FEATURE_CATEGORIES[index % FEATURE_CATEGORIES.length];
    const market = 0.0015 * Math.sin(index / 17)
      + 0.0008 * Math.cos(index / 31)
      + (index % 19) * 0.00001;
    const returns = {} as Record<V21Symbol, number>;
    V21_SYMBOLS.forEach((symbol, symbolIndex) => {
      const beta = category === "changing beta"
        ? 0.8 + 0.4 * Math.sin(index / (23 + symbolIndex))
        : 1 + 0.05 * Math.sin(index / (41 + symbolIndex));
      const alpha = category === "changing alpha"
        ? 0.0004 * Math.cos(index / (29 + symbolIndex))
        : 0.0001 * Math.cos(index / (53 + symbolIndex));
      const residualScale = category === "heteroskedastic"
        ? (index % 2 === 0 ? 0.0005 : 0.002)
        : 0.0006;
      let residual = residualScale * Math.sin(index / (11 + symbolIndex))
        + 0.0002 * Math.cos(index / (7 + symbolIndex));
      if (category === "large positive residual") residual += symbolIndex === 0 ? 0.03 : 0.002;
      if (category === "large negative residual") residual -= symbolIndex === 0 ? 0.03 : 0.002;
      if (category === "near-Q99") residual += symbolIndex === 0 ? 0.004 : 0.0005;
      if (category === "exact-Q99") residual += symbolIndex === 0 ? 0.003 : 0.0004;
      if (category === "fat-tail" && index % 29 === 0) residual += (symbolIndex - 3.5) * 0.01;
      if (category === "ties") residual = (symbolIndex % 2 === 0 ? 1 : -1) * 0.0003;
      if (category === "zero residual") residual = 0;
      if (category === "86-greater boundary") residual += symbolIndex === 0 ? 0.002 : 0;
      if (category === "87-greater boundary") residual -= symbolIndex === 0 ? 0.002 : 0;
      returns[symbol] = alpha + beta * market + residual + (symbolIndex - 3.5) * 0.00003;
    });
    return { openTime: index * interval, returns };
  });
}
