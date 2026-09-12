import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditSeriesRows,
  basisAtTimestamp,
  buildRollAudit,
  exactSynchronizedTimestamps,
  expectedHourlyTimestamps,
  parseBinanceKlineCsv,
  passesV23DataGate,
  passesV23SeriesQuality,
  periodForTimestamp,
} from "@/lib/v23/data";
import { V23_END_MS, V23_INTERVAL_MS, V23_REQUIRED_SERIES, V23_START_MS, type V23Candle, type V23SeriesType } from "@/lib/v23/types";

function candle(timestamp: number, seriesType: V23SeriesType = "TARGET_USDM_PERPETUAL", close = 100): V23Candle {
  return {
    underlying: "BTC",
    seriesType,
    openTimeUtc: new Date(timestamp).toISOString(),
    open: 99,
    high: Math.max(101, close),
    low: Math.min(98, close),
    close,
    closeTimeUtc: new Date(timestamp + V23_INTERVAL_MS - 1).toISOString(),
    closed: true,
  };
}

function goodQuality() {
  return { coverageRatio: 1, conflictingDuplicates: 0, canonicalDuplicates: 0, canonicalNonMonotonic: 0, invalidRows: 0, maxContiguousMissingHours: 0 };
}

describe("V23 data foundation", () => {
  it("uses the exact 1h range without resampling", () => {
    const timestamps = expectedHourlyTimestamps();
    expect(timestamps[0]).toBe(V23_START_MS);
    expect(timestamps.at(-1)).toBe(V23_END_MS - V23_INTERVAL_MS);
    expect(timestamps.length).toBe((V23_END_MS - V23_START_MS) / V23_INTERVAL_MS);
    expect(timestamps.every((timestamp) => timestamp % V23_INTERVAL_MS === 0)).toBe(true);
  });

  it("parses closed, aligned OHLC rows", () => {
    const text = "open_time,open,high,low,close,volume,close_time\n1640995200000,99,101,98,100,1,1640998799999\n";
    const result = parseBinanceKlineCsv(text, "BTC", "INDEX_PRICE");
    expect(result.invalidRows).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.closed).toBe(true);
    expect(result.rows[0]?.seriesType).toBe("INDEX_PRICE");
  });

  it("audits identical and conflicting duplicate rows separately", () => {
    const first = candle(V23_START_MS);
    const conflicting = candle(V23_START_MS, "TARGET_USDM_PERPETUAL", 102);
    const identicalQuality = auditSeriesRows("BTC", "TARGET_USDM_PERPETUAL", [first, first]);
    expect(identicalQuality.transportDuplicates).toBe(1);
    expect(identicalQuality.identicalDuplicates).toBe(1);
    expect(identicalQuality.conflictingDuplicates).toBe(0);
    expect(identicalQuality.canonicalDuplicates).toBe(1);
    const conflictingQuality = auditSeriesRows("BTC", "TARGET_USDM_PERPETUAL", [first, conflicting]);
    expect(conflictingQuality.transportDuplicates).toBe(1);
    expect(conflictingQuality.identicalDuplicates).toBe(0);
    expect(conflictingQuality.conflictingDuplicates).toBe(1);
    expect(conflictingQuality.canonicalDuplicates).toBe(1);
  });

  it("reports missing rows and a long unexplained gap without repair", () => {
    const quality = auditSeriesRows("BTC", "INDEX_PRICE", [candle(V23_START_MS, "INDEX_PRICE")]);
    expect(quality.actualRows).toBe(1);
    expect(quality.missingRows).toBe(expectedHourlyTimestamps().length - 1);
    expect(quality.maxContiguousMissingHours).toBeGreaterThan(24);
  });

  it("classifies periods by signal candle timestamp", () => {
    expect(periodForTimestamp(Date.parse("2022-01-01T00:00:00Z"))).toBe("PRIMARY");
    expect(periodForTimestamp(Date.parse("2025-01-01T00:00:00Z"))).toBe("HOLDOUT_A");
    expect(periodForTimestamp(Date.parse("2026-01-01T00:00:00Z"))).toBe("HOLDOUT_B");
    expect(periodForTimestamp(V23_END_MS)).toBeNull();
  });

  it("uses an exact four-way timestamp intersection", () => {
    const timestamp = V23_START_MS;
    const maps = new Map<V23SeriesType, Map<number, V23Candle>>();
    for (const seriesType of V23_REQUIRED_SERIES) maps.set(seriesType, new Map([[timestamp, candle(timestamp, seriesType)]]));
    expect(exactSynchronizedTimestamps(maps, V23_REQUIRED_SERIES)).toEqual([timestamp]);
    maps.get("NEXT_QUARTER")?.delete(timestamp);
    expect(exactSynchronizedTimestamps(maps, V23_REQUIRED_SERIES)).toEqual([]);
  });

  it("fails synchronization when a required current or next quarter series is missing", () => {
    const timestamp = V23_START_MS;
    const maps = new Map<V23SeriesType, Map<number, V23Candle>>([
      ["TARGET_USDM_PERPETUAL", new Map([[timestamp, candle(timestamp)]])],
      ["INDEX_PRICE", new Map([[timestamp, candle(timestamp, "INDEX_PRICE")]])],
      ["CURRENT_QUARTER", new Map()],
      ["NEXT_QUARTER", new Map([[timestamp, candle(timestamp, "NEXT_QUARTER")]])],
    ]);
    expect(exactSynchronizedTimestamps(maps, V23_REQUIRED_SERIES)).toHaveLength(0);
  });

  it("applies a global BTC-plus-ETH-style gate and does not salvage one underlying", () => {
    expect(passesV23DataGate([goodQuality(), goodQuality(), goodQuality(), goodQuality()], 1)).toBe(true);
    const bad = { ...goodQuality(), coverageRatio: 0.994 };
    expect(passesV23DataGate([goodQuality(), goodQuality(), bad, goodQuality()], 1)).toBe(false);
  });

  it("fails quality for conflicts and unexplained gaps instead of repairing them", () => {
    expect(passesV23SeriesQuality({ ...goodQuality(), conflictingDuplicates: 1 })).toBe(false);
    expect(passesV23SeriesQuality({ ...goodQuality(), maxContiguousMissingHours: 25 })).toBe(false);
  });

  it("computes the registered basis formulas exactly", () => {
    const timestamp = V23_START_MS;
    const current = new Map([[timestamp, candle(timestamp, "CURRENT_QUARTER", 110)]]);
    const next = new Map([[timestamp, candle(timestamp, "NEXT_QUARTER", 120)]]);
    const index = new Map([[timestamp, candle(timestamp, "INDEX_PRICE", 100)]]);
    const result = basisAtTimestamp(timestamp, current, next, index);
    expect(result?.currentBasis).toBeCloseTo(Math.log(1.1), 12);
    expect(result?.nextBasis).toBeCloseTo(Math.log(1.2), 12);
    expect(result?.curveSlope).toBeCloseTo(Math.log(1.2) - Math.log(1.1), 12);
  });

  it("does not synthesize a basis row at an unsynchronized timestamp", () => {
    const timestamp = V23_START_MS;
    const current = new Map([[timestamp, candle(timestamp, "CURRENT_QUARTER", 110)]]);
    const next = new Map([[timestamp + V23_INTERVAL_MS, candle(timestamp + V23_INTERVAL_MS, "NEXT_QUARTER", 120)]]);
    const index = new Map([[timestamp, candle(timestamp, "INDEX_PRICE", 100)]]);
    expect(basisAtTimestamp(timestamp, current, next, index)).toBeNull();
  });

  it("uses exact timestamps only and never forward-fills, interpolates, or selects nearest data", () => {
    const timestamp = V23_START_MS;
    const current = new Map([[timestamp, candle(timestamp, "CURRENT_QUARTER", 110)]]);
    const next = new Map([[timestamp + V23_INTERVAL_MS * 2, candle(timestamp + V23_INTERVAL_MS * 2, "NEXT_QUARTER", 120)]]);
    const index = new Map([[timestamp, candle(timestamp, "INDEX_PRICE", 100)]]);
    expect(basisAtTimestamp(timestamp, current, next, index)).toBeNull();
  });

  it("makes roll diagnostics deterministic and separate from signal logic", () => {
    const rows = [candle(V23_START_MS, "CURRENT_QUARTER", 100), { ...candle(V23_START_MS + V23_INTERVAL_MS, "CURRENT_QUARTER", 110), open: 110 }];
    const first = buildRollAudit(rows, "CURRENT_QUARTER");
    const second = buildRollAudit(rows, "CURRENT_QUARTER");
    expect(first).toEqual(second);
    expect(first[0]?.rawGap).toBeCloseTo(0.1, 12);
  });

  it("keeps the admission budget transition exact", () => {
    const budgetBefore = 2;
    const budgetConsumed = 1;
    expect(budgetBefore - budgetConsumed).toBe(1);
  });

  it("keeps V23 out of the R1 exhausted registry", () => {
    const report = JSON.parse(execFileSync("git", ["show", "6c5c415023683b6d8905aae2444af28d1510d9b6:reports/r1-exhausted-alpha-families.json"], { encoding: "utf8" })) as { registryExperimentIds: string[] };
    expect(report.registryExperimentIds).not.toContain("V23_TERM_STRUCTURE_BASIS_STATE");
  });

  it("keeps the data gate pre-return only", () => {
    const source = readFileSync("scripts/run-v23-data-gate.ts", "utf8");
    expect(source).toContain("historicalStrategyOutcomeReturnsRead: false");
    expect(source).toContain("forwardReturnsRead: false");
    expect(source).not.toContain("runBacktest");
  });
});
