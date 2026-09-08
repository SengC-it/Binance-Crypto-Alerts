import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { V21_SYMBOLS, type V21Symbol } from "../lib/v21/constants";
import {
  V21_PIT_OBSERVATION_COUNT,
  buildPitFeature,
  type V21PitFeature,
  type V21ReturnRow,
} from "../lib/v21/features";
import { scanV21Features } from "../lib/v21/feature-scan";

const interval = 5 * 60 * 1000;

describe("V21 exact historical feature scan feasibility", () => {
  it("matches the reference for 500 timestamps and all eight symbols", { timeout: 120000 }, () => {
    const rows = changingRows(V21_PIT_OBSERVATION_COUNT + 500);
    const optimized = scanV21Features(rows);
    expect(optimized.features).toHaveLength(500 * V21_SYMBOLS.length);
    expect(optimized.diagnostics).toEqual({
      inputRows: V21_PIT_OBSERVATION_COUNT + 500,
      evaluatedFeatures: 500 * V21_SYMBOLS.length,
      eligibleFeatures: 500 * V21_SYMBOLS.length,
      ineligibleFeatures: 0,
    });

    let comparisonIndex = 0;
    for (let rowIndex = V21_PIT_OBSERVATION_COUNT; rowIndex < rows.length; rowIndex += 1) {
      const priorRows = rows.slice(rowIndex - V21_PIT_OBSERVATION_COUNT, rowIndex);
      for (const symbol of V21_SYMBOLS) {
        const reference = buildPitFeature(symbol, rows[rowIndex], rows[rowIndex - 1], priorRows);
        const actual = optimized.features[comparisonIndex];
        expectFeatureEquivalent(actual, reference);
        comparisonIndex += 1;
      }
    }
  });

  it("handles normal changing market, changing beta, and changing alpha", () => {
    const rows = changingRows(V21_PIT_OBSERVATION_COUNT + 2);
    const result = scanV21Features(rows);
    expect(result.features.every((feature) => feature.eligible)).toBe(true);
    expect(result.features.some((feature) => Math.abs(feature.beta - 1) > 0.001)).toBe(true);
    expect(new Set(result.features.map((feature) => feature.alpha.toFixed(10))).size).toBeGreaterThan(1);
  });

  it("preserves positive and negative idiosyncratic jumps as feature values", () => {
    const positiveRows = changingRows(V21_PIT_OBSERVATION_COUNT + 1, { currentJump: 0.25 });
    const negativeRows = changingRows(V21_PIT_OBSERVATION_COUNT + 1, { currentJump: -0.25 });
    const positive = scanV21Features(positiveRows).features.find((feature) => feature.symbol === "BTCUSDT");
    const negative = scanV21Features(negativeRows).features.find((feature) => feature.symbol === "BTCUSDT");
    expect(positive?.currentResidual).toBeGreaterThan(positive?.residualAbsQ99 ?? 0);
    expect(negative?.currentResidual).toBeLessThan(-(negative?.residualAbsQ99 ?? 0));
  });

  it("keeps a single large jump in the current residual without enumerating an event", () => {
    const rows = changingRows(V21_PIT_OBSERVATION_COUNT + 1, { currentJump: 1 });
    const feature = scanV21Features(rows).features.find((candidate) => candidate.symbol === "BTCUSDT");
    expect(feature?.currentResidual).toBeGreaterThan(0.5);
    expect("event" in (feature ?? {})).toBe(false);
    expect("direction" in (feature ?? {})).toBe(false);
  });

  it("uses exact threshold ties and the nearest-rank Q99 boundary", () => {
    const rows = identityRows(V21_PIT_OBSERVATION_COUNT + 1);
    const result = scanV21Features(rows);
    expect(result.features).toHaveLength(V21_SYMBOLS.length);
    expect(result.features.every((feature) => feature.eligible)).toBe(true);
    expect(result.features.every((feature) => feature.residualAbsQ99 === 0)).toBe(true);
    expect(result.features.every((feature) => feature.currentResidual === 0)).toBe(true);
  });

  it("returns INELIGIBLE for zero market variance", () => {
    const rows = identityRows(V21_PIT_OBSERVATION_COUNT + 1, 5);
    const result = scanV21Features(rows);
    expect(result.features).toHaveLength(V21_SYMBOLS.length);
    expect(result.features.every((feature) => feature.eligible === false)).toBe(true);
    expect(result.features.every((feature) => feature.ineligibleReason === "ZERO_MARKET_VARIANCE")).toBe(true);
  });

  it("fails closed for a missing or non-exact PIT row", () => {
    const rows = changingRows(V21_PIT_OBSERVATION_COUNT + 1);
    rows[100].openTime += interval;
    const result = scanV21Features(rows);
    expect(result.features).toHaveLength(V21_SYMBOLS.length);
    expect(result.features.every((feature) => feature.eligible === false)).toBe(true);
    expect(result.features.every((feature) => feature.ineligibleReason === "PIT_WINDOW_NOT_EXACT")).toBe(true);
  });

  it("keeps multiple symbols and V21 scope free of result artifacts", () => {
    const rows = changingRows(V21_PIT_OBSERVATION_COUNT + 1);
    const result = scanV21Features(rows);
    expect(new Set(result.features.map((feature) => feature.symbol))).toEqual(new Set(V21_SYMBOLS));
    expect(existsSync("lib/v21/signals.ts")).toBe(false);
    expect(existsSync("reports/v21-result.json")).toBe(false);
  });
});

function changingRows(length: number, options: { currentJump?: number } = {}): V21ReturnRow[] {
  return Array.from({ length }, (_, index) => {
    const common = 0.002 * Math.sin(index / 19) + 0.0007 * Math.cos(index / 7) + (index % 23) * 0.00001;
    const returns = {} as Record<V21Symbol, number>;
    V21_SYMBOLS.forEach((symbol, symbolIndex) => {
      returns[symbol] = common
        + (symbolIndex - 3.5) * 0.00003
        + 0.00002 * Math.sin(index / (11 + symbolIndex));
    });
    const otherValues = V21_SYMBOLS
      .filter((symbol) => symbol !== "BTCUSDT")
      .map((symbol) => returns[symbol])
      .sort((left, right) => left - right);
    const btcMarket = otherValues[3];
    const beta = 1.1 + 0.08 * Math.sin(index / 43);
    const alpha = 0.0002 * Math.cos(index / 31);
    const jump = index === length - 1 ? options.currentJump ?? 0 : 0;
    returns.BTCUSDT = alpha + beta * btcMarket + jump;
    return { openTime: index * interval, returns };
  });
}

function identityRows(length: number, value?: number): V21ReturnRow[] {
  return Array.from({ length }, (_, index) => {
    const market = value ?? ((index % 17) + 1);
    const returns = {} as Record<V21Symbol, number>;
    V21_SYMBOLS.forEach((symbol) => {
      returns[symbol] = market;
    });
    return { openTime: index * interval, returns };
  });
}

function expectFeatureEquivalent(actual: V21PitFeature, reference: V21PitFeature): void {
  expect(actual.symbol).toBe(reference.symbol);
  expect(actual.openTime).toBe(reference.openTime);
  expect(actual.priorObservationCount).toBe(reference.priorObservationCount);
  expect(actual.eligible).toBe(reference.eligible);
  expect(actual.ineligibleReason).toBe(reference.ineligibleReason);
  for (const key of [
    "assetReturn",
    "marketReturn",
    "alpha",
    "beta",
    "previousResidual",
    "currentResidual",
    "residualAbsQ99",
  ] as const) {
    expect(Math.abs(actual[key] - reference[key])).toBeLessThanOrEqual(1e-12);
  }
}
