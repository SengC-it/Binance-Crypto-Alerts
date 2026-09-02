import { describe, expect, it } from "vitest";
import {
  evaluateV16DataGate,
  expectedV16ArchiveSlots,
  V16_BRANCH,
  V16_GATE_THRESHOLDS,
  V16_SYMBOLS,
  v16Months,
  type V16CoverageInput,
} from "../lib/v16/data-gate";

function completeInput(): V16CoverageInput {
  const archiveSlots = expectedV16ArchiveSlots().length;
  return {
    requiredArchiveSlots: archiveSlots,
    materializedArchiveSlots: archiveSlots,
    usedArchiveSlots: archiveSlots,
    usedZipChecksumCoverage: 1,
    aggTradeCoverage: { BTCUSDT: 1, ETHUSDT: 1 },
    klineCoverage: { BTCUSDT: 1, ETHUSDT: 1 },
    timestampMonotonicity: { BTCUSDT: true, ETHUSDT: true },
    aggTradeIdMonotonicity: { BTCUSDT: true, ETHUSDT: true },
    duplicateCoverage: { BTCUSDT: 1, ETHUSDT: 1 },
    featureCoverage: 1,
    executionPriceCoverage: 1,
    fundingSettlementCoverage: 1,
  };
}

describe("V16 Data Gate", () => {
  it("freezes the fixed two-instrument archive inventory", () => {
    expect(V16_BRANCH).toBe("feat/v16-aggtrade-absorption");
    expect(V16_SYMBOLS).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(v16Months()).toHaveLength(67);
    expect(expectedV16ArchiveSlots()).toHaveLength(67 * 2 * 5);
  });

  it("passes a complete, fully proven pre-returns data fixture", () => {
    const result = evaluateV16DataGate(completeInput());
    expect(result.status).toBe("PASS");
    expect(result.classification).toBe("PASS");
    expect(result.reasons).toEqual([]);
  });

  it("fails closed when the immutable archive cache is absent", () => {
    const input = completeInput();
    input.materializedArchiveSlots = 0;
    input.usedArchiveSlots = 0;
    input.usedZipChecksumCoverage = 0;
    input.aggTradeCoverage = { BTCUSDT: 0, ETHUSDT: 0 };
    input.klineCoverage = { BTCUSDT: 0, ETHUSDT: 0 };
    input.timestampMonotonicity = { BTCUSDT: false, ETHUSDT: false };
    input.aggTradeIdMonotonicity = { BTCUSDT: false, ETHUSDT: false };
    input.duplicateCoverage = { BTCUSDT: 0, ETHUSDT: 0 };
    input.featureCoverage = 0;
    input.executionPriceCoverage = 0;
    input.fundingSettlementCoverage = 0;

    const result = evaluateV16DataGate(input);
    expect(result.status).toBe("FAIL");
    expect(result.classification).toBe("V16_DATA_INSUFFICIENT_FINAL");
    expect(result.reasons).toContain("OFFICIAL_ARCHIVE_INVENTORY_INCOMPLETE");
    expect(result.reasons).toContain("AGGTRADE_COVERAGE_BELOW_99_PERCENT");
    expect(result.reasons).toContain("FUNDING_SETTLEMENT_COVERAGE_BELOW_100_PERCENT");
  });

  it("does not weaken any frozen Data Gate threshold", () => {
    const input = completeInput();
    input.aggTradeCoverage = { BTCUSDT: V16_GATE_THRESHOLDS.aggTradeCoverage - 0.0001, ETHUSDT: 1 };
    expect(evaluateV16DataGate(input).gates.aggTradeCoverage).toBe(false);
    input.aggTradeCoverage = { BTCUSDT: V16_GATE_THRESHOLDS.aggTradeCoverage, ETHUSDT: 1 };
    expect(evaluateV16DataGate(input).gates.aggTradeCoverage).toBe(true);
  });
});
