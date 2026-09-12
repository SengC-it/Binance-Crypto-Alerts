import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditDepthRows,
  featureFeasibility,
  findPriorClosed5mPrice,
  fiveMinutePITAvailability,
  parseDepthCsv,
  parseTargetKlineCsv,
  passesV24SeriesGate,
  sha256,
  summarizeCadence,
} from "@/lib/v24/data";
import {
  V24_BASE_SHA,
  V24_BOOK_DEPTH_CADENCE_MS,
  V24_END_MS,
  V24_REQUIRED_BANDS,
  V24_START_MS,
  V24_SYMBOLS,
  type V24DepthRow,
  type V24SeriesQuality,
} from "@/lib/v24/types";

function depthRows(timestampMs = V24_START_MS, overrides: Partial<Record<number, Partial<Pick<V24DepthRow, "depth" | "notional">>>> = {}): V24DepthRow[] {
  return V24_REQUIRED_BANDS.map((percentage, index) => {
    const depth = percentage < 0 ? Math.abs(percentage) : percentage;
    const values = overrides[percentage] ?? {};
    return {
      timestampUtc: new Date(timestampMs).toISOString(),
      timestampMs,
      percentage,
      depth: values.depth ?? depth,
      notional: values.notional ?? depth * 100,
    };
  });
}

function quality(overrides: Partial<V24SeriesQuality> = {}): V24SeriesQuality {
  return {
    symbol: "BTCUSDT",
    expectedDays: 1,
    archivePresenceDays: 1,
    archivePresenceRatio: 1,
    checksumVerifiedArchives: 1,
    checksumVerifiedRatio: 1,
    totalTransportRows: 10,
    totalCanonicalSnapshots: 1,
    validSnapshots: 1,
    requiredBandValidityRatio: 1,
    negativeRows: 0,
    invalidRows: 0,
    missingBandSnapshots: 0,
    monotonicityViolations: 0,
    priceAnchorCheckedSnapshots: 1,
    priceAnchorValidSnapshots: 1,
    priceAnchorValidityRatio: 1,
    transportDuplicateRows: 0,
    identicalDuplicateRows: 0,
    conflictingDuplicateRows: 0,
    canonicalDuplicateRows: 0,
    nonMonotonicTimestamps: 0,
    medianIntervalSeconds: 30,
    p5IntervalSeconds: 30,
    p95IntervalSeconds: 30,
    maximumIntervalSeconds: 30,
    maxContiguousGapMinutes: 0,
    maxIdenticalFingerprintDurationMinutes: 0,
    staleIntervals: 0,
    expected5mSlots: 1,
    valid5mSlots: 1,
    valid5mCoverage: 1,
    maxContiguousUnavailableMinutes: 0,
    targetExpected5mSlots: 1,
    targetRows: 1,
    targetCoverage: 1,
    primary: {} as V24SeriesQuality["primary"],
    holdoutA: {} as V24SeriesQuality["holdoutA"],
    holdoutB: {} as V24SeriesQuality["holdoutB"],
    firstTimestamp: new Date(V24_START_MS).toISOString(),
    lastTimestamp: new Date(V24_START_MS).toISOString(),
    ...overrides,
  };
}

describe("V24 order-book data foundation", () => {
  it("uses the exact fixed range, symbols, cadence, and required bands", () => {
    expect(V24_BASE_SHA).toBe("7b9e5d82f471ee3c9fec07e00101263c8d84e953");
    expect(V24_SYMBOLS).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(V24_END_MS - V24_START_MS).toBeGreaterThan(1_000_000_000);
    expect(V24_BOOK_DEPTH_CADENCE_MS).toBe(30_000);
    expect(V24_REQUIRED_BANDS).toEqual([-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]);
  });

  it("requires the exact bookDepth schema and parses ten valid bands", () => {
    const text = [
      "timestamp,percentage,depth,notional",
      ...depthRows().map((row) => `${row.timestampUtc},${row.percentage},${row.depth},${row.notional}`),
    ].join("\n");
    const parsed = parseDepthCsv(text);
    expect(parsed.headerValid).toBe(true);
    expect(parsed.invalidRows).toBe(0);
    expect(parsed.transportRows).toBe(10);
    expect(parsed.rows).toHaveLength(10);
  });

  it("marks a snapshot missing one required band invalid", () => {
    const audit = auditDepthRows(depthRows().filter((row) => row.percentage !== 5), () => 100);
    expect(audit.snapshots[0]?.missingBands).toEqual([5]);
    expect(audit.validTimestamps).toHaveLength(0);
  });

  it("rejects negative depth and negative notional", () => {
    const negativeDepth = auditDepthRows(depthRows(V24_START_MS, { [-1]: { depth: -1 } }), () => 100);
    const negativeNotional = auditDepthRows(depthRows(V24_START_MS, { [1]: { notional: -1 } }), () => 100);
    expect(negativeDepth.snapshots[0]?.valid).toBe(false);
    expect(negativeNotional.snapshots[0]?.valid).toBe(false);
    expect(negativeDepth.negativeRows).toBe(1);
    expect(negativeNotional.negativeRows).toBe(1);
  });

  it("checks cumulative bid and ask monotonicity without repairing values", () => {
    const bid = auditDepthRows(depthRows(V24_START_MS, { [-2]: { depth: 0.5 } }), () => 100);
    const ask = auditDepthRows(depthRows(V24_START_MS, { [2]: { notional: 50 } }), () => 100);
    expect(bid.monotonicityViolations).toBeGreaterThan(0);
    expect(ask.monotonicityViolations).toBeGreaterThan(0);
    expect(bid.validTimestamps).toHaveLength(0);
    expect(ask.validTimestamps).toHaveLength(0);
  });

  it("audits identical transport duplicates and deterministically collapses them", () => {
    const rows = [...depthRows(), ...depthRows()];
    const audit = auditDepthRows(rows, () => 100);
    expect(audit.transportDuplicateRows).toBe(10);
    expect(audit.identicalDuplicateRows).toBe(10);
    expect(audit.conflictingDuplicateRows).toBe(0);
    expect(audit.canonicalDuplicateRows).toBe(0);
  });

  it("fails on conflicting timestamp-plus-band duplicates", () => {
    const rows = [...depthRows(), ...depthRows(V24_START_MS, { [1]: { notional: 101 } })];
    const audit = auditDepthRows(rows, () => 100);
    expect(audit.conflictingDuplicateRows).toBe(1);
    expect(passesV24SeriesGate(quality({ conflictingDuplicateRows: audit.conflictingDuplicateRows }))).toBe(false);
  });

  it("rejects price anchors beyond the 15 percent log bound", () => {
    const audit = auditDepthRows(depthRows(V24_START_MS, { [1]: { notional: 120 } }), () => 100);
    expect(audit.priceAnchorViolations).toBeGreaterThan(0);
    expect(audit.priceAnchorValidSnapshots).toBe(0);
    expect(audit.validTimestamps).toHaveLength(0);
  });

  it("uses only the immediately prior closed 5m candle for price anchoring", () => {
    const candle = { openTimeMs: V24_START_MS, closeTimeMs: V24_START_MS + 5 * 60_000 - 1, close: 100 };
    expect(findPriorClosed5mPrice([candle], V24_START_MS + 5 * 60_000)).toBe(100);
    expect(findPriorClosed5mPrice([candle], candle.closeTimeMs)).toBeNull();
  });

  it("audits 30-second cadence statistics", () => {
    const intervals = summarizeCadence([30, 30, 60, 30]);
    expect(intervals.median).toBe(30);
    expect(intervals.p5).toBe(30);
    expect(intervals.p95).toBeCloseTo(55.5, 10);
    expect(intervals.maximum).toBe(60);
  });

  it("treats exactly 60 minutes of identical depth as the boundary, not stale", () => {
    const rows = Array.from({ length: 121 }, (_, index) => depthRows(V24_START_MS + index * V24_BOOK_DEPTH_CADENCE_MS)).flat();
    const audit = auditDepthRows(rows, () => 100);
    expect(audit.maxIdenticalFingerprintDurationMinutes).toBe(60);
    expect(audit.staleIntervals).toBe(0);
  });

  it("fails an identical fingerprint interval longer than 60 minutes", () => {
    const rows = Array.from({ length: 123 }, (_, index) => depthRows(V24_START_MS + index * V24_BOOK_DEPTH_CADENCE_MS)).flat();
    const audit = auditDepthRows(rows, () => 100);
    expect(audit.maxIdenticalFingerprintDurationMinutes).toBe(61);
    expect(audit.staleIntervals).toBe(1);
  });

  it("does not satisfy a 5m slot with a future snapshot", () => {
    const availability = fiveMinutePITAvailability([V24_START_MS + 30_000], V24_START_MS, V24_START_MS + 5 * 60_000);
    expect(availability.expectedSlots).toBe(1);
    expect(availability.validSlots).toBe(0);
  });

  it("rejects a snapshot older than 90 seconds for a 5m decision", () => {
    const availability = fiveMinutePITAvailability([V24_START_MS - 91_000], V24_START_MS, V24_START_MS + 5 * 60_000);
    expect(availability.validSlots).toBe(0);
    expect(availability.maxContiguousUnavailableMinutes).toBe(5);
  });

  it("does not forward-fill across an unavailable decision window", () => {
    const availability = fiveMinutePITAvailability([V24_START_MS + 4 * 60_000], V24_START_MS, V24_START_MS + 20 * 60_000);
    expect(availability.coverage).toBeLessThan(1);
    expect(availability.maxContiguousUnavailableMinutes).toBeGreaterThan(0);
  });

  it("computes only contemporaneous finite feature feasibility", () => {
    const rows = new Map([[V24_START_MS, new Map(depthRows().map((row) => [row.percentage, row]))]]);
    const first = featureFeasibility(rows, V24_START_MS);
    const second = featureFeasibility(rows, V24_START_MS);
    expect(first.finite).toBe(true);
    expect(first.deterministic).toBe(true);
    expect(first.pitAvailable).toBe(true);
    expect(first).toEqual(second);
  });

  it("parses only closed, aligned 5m target candles", () => {
    const candle = `${V24_START_MS},99,101,98,100,1,${V24_START_MS + 5 * 60_000 - 1}`;
    const parsed = parseTargetKlineCsv(`open_time,open,high,low,close,volume,close_time\n${candle}\n`);
    expect(parsed.headerValid).toBe(true);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.close).toBe(100);
  });

  it("fails the global gate when checksum or target coverage is below threshold", () => {
    expect(passesV24SeriesGate(quality({ checksumVerifiedRatio: 0.999 }))).toBe(false);
    expect(passesV24SeriesGate(quality({ targetCoverage: 0.998 }))).toBe(false);
  });

  it("fails closed when BTC passes but ETH fails", () => {
    const symbols = [quality({ symbol: "BTCUSDT" }), quality({ symbol: "ETHUSDT", valid5mCoverage: 0.9 })];
    expect(symbols.every((item) => passesV24SeriesGate(item))).toBe(false);
  });

  it("keeps the raw provenance hash byte-sensitive", () => {
    expect(sha256("same")).toBe(sha256("same"));
    expect(sha256("same")).not.toBe(sha256("changed"));
  });

  it("uses no strategy outcome or backtest fields in the data-gate script", () => {
    const source = readFileSync("scripts/run-v24-data-gate.ts", "utf8");
    expect(source).not.toContain("runBacktest");
    expect(source).not.toContain("strategy returns");
    expect(source).toContain("historicalStrategyOutcomeReturnsRead: false");
    expect(source).toContain("promotionEvaluated: false");
  });
});
