import { describe, expect, it } from "vitest";
import {
  V22_BASELINE_ROUND_TRIP_BPS,
  V22_INFORMATION_DENSITY_FLOOR_BPS,
  V22_INTERVAL_MS,
  V22_MIN_GAP_LOG,
  V22_Q99_INDEX,
  V22_Q99_RANK,
  V22_ROLLING_OBSERVATIONS,
  acceptV22PrimaryOverlap,
  buildV22ExecutionContract,
  crossVenueGap,
  directionFromGap,
  evaluateV22PrimarySignal,
  firstCross,
  logReturn,
  nearestRankQ99,
  referenceDominance,
  rollingGapThreshold,
  type V22PrimaryPosition,
  type V22SynchronizedObservation,
} from "@/lib/v22/signal";

const T = Date.parse("2024-01-01T00:00:00.000Z");

function priorWindow(currentOpenTimeUtc = T, gap = 0): V22SynchronizedObservation[] {
  return Array.from({ length: V22_ROLLING_OBSERVATIONS }, (_, index) => ({
    openTimeUtc: currentOpenTimeUtc - (V22_ROLLING_OBSERVATIONS - index) * V22_INTERVAL_MS,
    binanceClose: 100,
    okxClose: 100,
    binanceReturn: 0,
    okxReturn: 0,
    gap,
  }));
}

function eligibleInput(overrides: Partial<Parameters<typeof evaluateV22PrimarySignal>[0]> = {}) {
  return {
    symbol: "BTCUSDT" as const,
    signalOpenTimeUtc: T,
    signalCloseTimeUtc: T + V22_INTERVAL_MS,
    binanceReturn: 0.0002,
    okxReturn: 0.003,
    previousGap: 0,
    priorObservations: priorWindow(),
    ...overrides,
  };
}

describe("V22 frozen cross-venue signal contract", () => {
  it("uses exactly 8640 prior synchronized observations and excludes current", () => {
    expect(priorWindow()).toHaveLength(8640);
    expect(evaluateV22PrimarySignal(eligibleInput()).eligible).toBe(true);
    expect(evaluateV22PrimarySignal(eligibleInput({ priorObservations: priorWindow().slice(1) })).eligible).toBe(false);
    const contaminated = priorWindow();
    contaminated[contaminated.length - 1] = { ...contaminated[contaminated.length - 1]!, openTimeUtc: T };
    expect(evaluateV22PrimarySignal(eligibleInput({ priorObservations: contaminated })).eligible).toBe(false);
  });

  it("uses nearest-rank Q99 rank 8554 and zero-based index 8553", () => {
    const values = Array.from({ length: V22_ROLLING_OBSERVATIONS }, (_, index) => index + 1);
    expect(V22_Q99_RANK).toBe(8554);
    expect(V22_Q99_INDEX).toBe(8553);
    expect(nearestRankQ99(values)).toBe(values[V22_Q99_INDEX]);
  });

  it("applies the exact 24bps information-density floor", () => {
    expect(V22_BASELINE_ROUND_TRIP_BPS).toBe(12);
    expect(V22_INFORMATION_DENSITY_FLOOR_BPS).toBe(24);
    expect(V22_MIN_GAP_LOG).toBeCloseTo(Math.log1p(0.0024), 15);
    expect(rollingGapThreshold(priorWindow().map(() => 0))).toBe(V22_MIN_GAP_LOG);
    expect(rollingGapThreshold(priorWindow().map(() => 0.01))).toBe(0.01);
  });

  it("enforces first-cross, same direction, OKX dominance, and long/short mapping", () => {
    expect(firstCross(0.003, 0, V22_MIN_GAP_LOG)).toBe(true);
    expect(firstCross(0.003, 0.003, V22_MIN_GAP_LOG)).toBe(false);
    expect(referenceDominance(0.003, 0.0002)).toBe(true);
    expect(directionFromGap(0.003)).toBe("LONG");
    expect(directionFromGap(-0.003)).toBe("SHORT");
    expect(crossVenueGap(0.003, 0.0002)).toBe(0.0028);
    expect(evaluateV22PrimarySignal(eligibleInput()).eligible).toBe(true);
    expect(evaluateV22PrimarySignal(eligibleInput({ okxReturn: -0.003, binanceReturn: -0.0002 })).eligible).toBe(true);
    expect(evaluateV22PrimarySignal(eligibleInput({ okxReturn: 0.0002, binanceReturn: 0.003 })).eligible).toBe(false);
    expect(evaluateV22PrimarySignal(eligibleInput({ okxReturn: 0.003, binanceReturn: -0.0002 })).eligible).toBe(false);
  });

  it("rejects missing synchronized slots and nonfinite observations", () => {
    const missing = priorWindow();
    missing[100] = { ...missing[100]!, openTimeUtc: missing[100]!.openTimeUtc + V22_INTERVAL_MS };
    expect(evaluateV22PrimarySignal(eligibleInput({ priorObservations: missing })).eligible).toBe(false);
    const nonfinite = priorWindow();
    nonfinite[100] = { ...nonfinite[100]!, gap: Number.NaN };
    expect(evaluateV22PrimarySignal(eligibleInput({ priorObservations: nonfinite })).eligible).toBe(false);
    expect(logReturn(101, 100)).toBeCloseTo(Math.log(1.01));
    expect(logReturn(0, 100)).toBe(Number.NaN);
  });

  it("freezes next-bar-open execution and diagnostics without same-bar execution", () => {
    const execution = buildV22ExecutionContract(T);
    expect(execution.entry).toEqual({ openTimeUtc: T + V22_INTERVAL_MS, priceField: "open" });
    expect(execution.primary).toEqual({ exitOpenTimeUtc: T + 3 * V22_INTERVAL_MS, exitPriceField: "close", outcomeBoundaryTimeUtc: T + 4 * V22_INTERVAL_MS, horizonMinutes: 15 });
    expect(execution.diagnostics.fiveMinute.horizonMinutes).toBe(5);
    expect(execution.diagnostics.thirtyMinute.horizonMinutes).toBe(30);
    expect(execution.entry.openTimeUtc).toBeGreaterThan(T);
  });

  it("excludes same-symbol overlap but allows different-symbol concurrency", () => {
    const existing: V22PrimaryPosition[] = [{ symbol: "BTCUSDT", entryOpenTimeUtc: T + V22_INTERVAL_MS, outcomeBoundaryTimeUtc: T + 4 * V22_INTERVAL_MS, accepted: true }];
    expect(acceptV22PrimaryOverlap(existing, { symbol: "BTCUSDT", entryOpenTimeUtc: T + 2 * V22_INTERVAL_MS, outcomeBoundaryTimeUtc: T + 5 * V22_INTERVAL_MS })).toEqual({ accepted: false, reason: "OVERLAP_EXCLUDED" });
    expect(acceptV22PrimaryOverlap(existing, { symbol: "ETHUSDT", entryOpenTimeUtc: T + 2 * V22_INTERVAL_MS, outcomeBoundaryTimeUtc: T + 5 * V22_INTERVAL_MS })).toEqual({ accepted: true, reason: "ACCEPTED" });
  });
});
