import { describe, expect, it } from "vitest";
import {
  R1_EXPERIMENTS,
  SYSTEM_BOUNDARY,
  V18_BRANCH_HEAD_SHA,
  V18_FREEZE_SHA,
  V18_POST_RESULT_VALIDATOR_COMMITS,
  V18_RESULT_SHA,
  V21_FREEZE_SHA,
  V21_RESULT_SHA,
  canonicalJson,
  computeReturnComparisonEligibility,
  isV18CanonicalResult,
  isV18PostResultValidatorCommit,
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
    const v21 = R1_EXPERIMENTS.filter((experiment) => experiment.resultCommit === V21_RESULT_SHA);
    expect(v21).toHaveLength(1);
    expect(v21[0].approvedEvidenceCommit).toBe(V21_RESULT_SHA);
    expect(v21[0].parentCommit).toBe(V21_FREEZE_SHA);
    expect(isV21CanonicalResult(V21_RESULT_SHA, v21[0].resultCommit!)).toBe(true);
    expect(isV21PostResultValidatorCommit("180bfc2b42322eb6e42fb3a90cc2a998e1b2a2ba")).toBe(true);
    expect(isV21PostResultValidatorCommit("0822c099eeff4f36e8d8e4865a4ed1380ae94709")).toBe(true);
    expect(isV21PostResultValidatorCommit(V21_RESULT_SHA)).toBe(false);
  });

  it("promotes fetchable V18 remote evidence to exact local Git-blob provenance", () => {
    const v18 = R1_EXPERIMENTS.find((experiment) => experiment.experimentId === "V18_TAKER_FLOW_ABSORPTION_REVERSAL");
    expect(v18).toBeDefined();
    expect(v18).toMatchObject({
      branchHead: V18_BRANCH_HEAD_SHA,
      approvedEvidenceCommit: V18_RESULT_SHA,
      parentCommit: V18_FREEZE_SHA,
      dataGate: true,
      historicalStrategyOutcomeReturnsRead: true,
      classification: "V18_TAKER_FLOW_ABSORPTION_REJECTED",
      taxonomy: "RESULT_REJECTED",
      returnComparisonEligible: true,
      returnComparisonExclusionReason: null,
    });
    expect(v18!.evidenceSources).toHaveLength(6);
    expect(v18!.evidenceSources.every((source) => source.sourceKind === "git-blob" && !source.path.startsWith("COMMIT_METADATA:"))).toBe(true);
    expect(v18!.evidenceSources.filter((source) => source.commit === V18_FREEZE_SHA)).toHaveLength(2);
    expect(v18!.evidenceSources.filter((source) => source.commit === V18_RESULT_SHA)).toHaveLength(4);
    expect(isV18CanonicalResult(V18_RESULT_SHA, v18!.resultCommit!)).toBe(true);
    expect(V18_POST_RESULT_VALIDATOR_COMMITS.every(isV18PostResultValidatorCommit)).toBe(true);
    expect(isV18PostResultValidatorCommit(V18_RESULT_SHA)).toBe(false);
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
