import { describe, expect, it } from "vitest";
import {
  R1_EXPERIMENTS,
  SYSTEM_BOUNDARY,
  canonicalJson,
  computeReturnComparisonEligibility,
  isV21CanonicalResult,
  isV21PostResultValidatorCommit,
  selectCanonicalFreezeCandidate,
  sha256,
  sortInventory,
  assertSystemBoundary,
} from "../scripts/r1-catalog";

describe("R1-WP1 evidence contracts", () => {
  it("keeps data-insufficient evidence out of the return comparison pool", () => {
    expect(computeReturnComparisonEligibility({
      dataGate: false,
      historicalStrategyOutcomeReturnsRead: true,
      resultCommit: "result",
      executionCostContractIdentifiable: true,
    })).toEqual({ eligible: false, reason: "DATA_GATE_NOT_PROVEN_PASS" });
  });

  it("allows a formal rejected result when every comparison prerequisite is proven", () => {
    expect(computeReturnComparisonEligibility({
      dataGate: true,
      historicalStrategyOutcomeReturnsRead: true,
      resultCommit: "result",
      executionCostContractIdentifiable: true,
    })).toEqual({ eligible: true, reason: null });
  });

  it("rejects a missing result, superseded result, and known-invalid result", () => {
    expect(computeReturnComparisonEligibility({
      dataGate: true,
      historicalStrategyOutcomeReturnsRead: true,
      resultCommit: null,
      executionCostContractIdentifiable: true,
    }).eligible).toBe(false);
    expect(computeReturnComparisonEligibility({
      dataGate: true,
      historicalStrategyOutcomeReturnsRead: true,
      resultCommit: "result",
      executionCostContractIdentifiable: true,
      superseded: true,
    })).toEqual({ eligible: false, reason: "RESULT_SUPERSEDED" });
    expect(computeReturnComparisonEligibility({
      dataGate: true,
      historicalStrategyOutcomeReturnsRead: true,
      resultCommit: "result",
      executionCostContractIdentifiable: true,
      knownInvalid: true,
    })).toEqual({ eligible: false, reason: "RESULT_KNOWN_INVALID" });
  });

  it("fails closed when freeze candidates are ambiguous", () => {
    expect(() => selectCanonicalFreezeCandidate(["freeze-a", "freeze-b"])).toThrow("FREEZE_CANDIDATE_AMBIGUOUS");
    expect(selectCanonicalFreezeCandidate(["freeze-a", "freeze-a"])).toBe("freeze-a");
  });

  it("recognizes the V21 canonical result exactly once and excludes post-result validator commits", () => {
    const v21 = R1_EXPERIMENTS.filter((experiment) => experiment.resultCommit === "54698f7a139cec978243cab55eb4edbd7f7ca439");
    expect(v21).toHaveLength(1);
    expect(isV21CanonicalResult("54698f7a139cec978243cab55eb4edbd7f7ca439", v21[0].resultCommit!)).toBe(true);
    expect(isV21PostResultValidatorCommit("180bfc2b42322eb6e42fb3a90cc2a998e1b2a2ba")).toBe(true);
    expect(isV21PostResultValidatorCommit("0822c099eeff4f36e8d8e4865a4ed1380ae94709")).toBe(true);
    expect(isV21PostResultValidatorCommit("54698f7a139cec978243cab55eb4edbd7f7ca439")).toBe(false);
  });

  it("rejects an automatic-trading boundary", () => {
    expect(() => assertSystemBoundary({ ...SYSTEM_BOUNDARY, automaticTrading: true })).toThrow("automaticTrading");
  });

  it("keeps canonical text stable across LF and CRLF while content changes alter the hash", () => {
    const report = { alpha: "V21", status: "REJECTED" };
    const lf = `${JSON.stringify(report, null, 2)}\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const canonicalHash = (value: string) => sha256(canonicalJson(JSON.parse(value.replace(/\r\n/g, "\n"))));
    expect(canonicalHash(lf)).toBe(canonicalHash(crlf));
    expect(sha256(lf)).not.toBe(sha256(crlf));
    expect(canonicalHash(lf)).not.toBe(canonicalHash(lf.replace("REJECTED", "PASS")));
    expect(sha256(lf)).not.toBe(sha256(lf.replace("REJECTED", "PASS")));
  });

  it("keeps inventory ordering and manifest hashes deterministic", () => {
    const reversed = [...R1_EXPERIMENTS].reverse();
    const sorted = sortInventory(reversed);
    expect(sorted.map((experiment) => experiment.experimentId)).toEqual([...sorted.map((experiment) => experiment.experimentId)].sort((left, right) => left.localeCompare(right)));
    const manifest = { z: 1, nested: { b: 2, a: 1 }, a: ["x", "y"] };
    expect(sha256(canonicalJson(manifest))).toBe(sha256(canonicalJson({ a: ["x", "y"], nested: { a: 1, b: 2 }, z: 1 })));
  });

  it("contains the fixed canonical inventory size without result aggregates", () => {
    expect(R1_EXPERIMENTS).toHaveLength(24);
    expect(R1_EXPERIMENTS.every((experiment) => computeReturnComparisonEligibility({
      dataGate: experiment.dataGate,
      historicalStrategyOutcomeReturnsRead: experiment.historicalStrategyOutcomeReturnsRead,
      resultCommit: experiment.resultCommit,
      executionCostContractIdentifiable: experiment.resultCommit !== null,
      superseded: experiment.superseded,
      knownInvalid: experiment.knownInvalid,
    }).eligible === experiment.returnComparisonEligible)).toBe(true);
  });
});
