import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_CATEGORIES,
  EXPECTED_CANONICAL_RESULT_COMMITS,
  WP1_COMMIT,
  WP2_EXPERIMENT_IDS,
  assertNoCrossExperimentRanking,
  assertNumericProvenance,
  classifyAttribution,
  computeDominantFailureMode,
  derivePreExecutionFrictionEdge,
  type MetricContract,
} from "../scripts/build-r1-edge-attribution";
import { SYSTEM_BOUNDARY, assertSystemBoundary } from "../scripts/r1-catalog";

function contractWith(overrides: Partial<MetricContract>): MetricContract {
  return {
    experimentId: "V7_DERIVATIVES_FLOW_ALPHA",
    version: "V7.0",
    alphaFamily: "taker-flow",
    informationSourceClass: "FLOW_DERIVED",
    classification: "REJECTED",
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS.V7_DERIVATIVES_FLOW_ALPHA,
    primaryEvaluationWindow: "primary",
    primaryHorizon: null,
    returnUnit: "USDT",
    primarySample: 10,
    baselineNetMetricName: "net",
    baselineNetTotal: 1,
    baselineNetAverage: null,
    grossMetricName: null,
    grossTotal: 2,
    grossAverage: 0.2,
    preExecutionFrictionEdge: 2,
    feesTotal: 0.5,
    slippageTotal: 0.5,
    fundingCarry: null,
    feeModel: "test",
    slippageModel: "test",
    fundingTreatment: "separate",
    otherCosts: null,
    executionContractIdentifiable: true,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: [],
    numericProvenance: {},
    unavailableReasons: { fundingCarry: "test" },
    ...overrides,
  };
}

describe("R1-WP2 attribution contracts", () => {
  it("classifies a positive pre-friction edge with a negative net as friction dominated", () => {
    expect(classifyAttribution({ preExecutionFrictionEdge: 0.5, baselineNet: -0.1, promotionPass: false })).toBe("EXECUTION_FRICTION_DOMINATED");
  });

  it("classifies a non-positive pre-friction edge without inferring a net cause", () => {
    expect(classifyAttribution({ preExecutionFrictionEdge: -0.001, baselineNet: -0.2, promotionPass: false })).toBe("NO_PRE_FRICTION_EDGE");
  });

  it("classifies positive net with failed promotion as not robust", () => {
    expect(classifyAttribution({ preExecutionFrictionEdge: 0.5, baselineNet: 0.1, promotionPass: false })).toBe("NET_EDGE_NOT_ROBUST");
  });

  it("leaves missing gross or net attribution unresolved", () => {
    expect(classifyAttribution({ preExecutionFrictionEdge: null, baselineNet: 0.1, promotionPass: false })).toBe("ATTRIBUTION_UNRESOLVED");
    expect(classifyAttribution({ preExecutionFrictionEdge: 0.1, baselineNet: null, promotionPass: false })).toBe("ATTRIBUTION_UNRESOLVED");
  });

  it("keeps funding outside execution friction", () => {
    expect(derivePreExecutionFrictionEdge({
      net: 1,
      fees: 0.2,
      slippage: 0.1,
      funding: 0.9,
      unit: "R_MULTIPLE",
      inputUnits: { net: "R_MULTIPLE", fees: "R_MULTIPLE", slippage: "R_MULTIPLE", funding: "R_MULTIPLE" },
    })).toBeCloseTo(1.3);
  });

  it("rejects R and USDT arithmetic", () => {
    expect(() => derivePreExecutionFrictionEdge({
      net: 1,
      fees: 0.2,
      slippage: 0.1,
      unit: "R_MULTIPLE",
      inputUnits: { net: "R_MULTIPLE", fees: "USDT", slippage: "R_MULTIPLE" },
    })).toThrow("UNIT_MISMATCH");
  });

  it("requires provenance for every numeric contract field", () => {
    expect(() => assertNumericProvenance(contractWith({ baselineNetTotal: 1, numericProvenance: {} }))).toThrow("missing provenance");
  });

  it("rejects a numeric ranking field", () => {
    expect(() => assertNoCrossExperimentRanking({ categoryCounts: {}, bestCandidate: 1 })).toThrow("FORBIDDEN_RANKING");
  });

  it("uses the strict dominant-mode threshold and resolved sample rule", () => {
    expect(computeDominantFailureMode(["EXECUTION_FRICTION_DOMINATED", "EXECUTION_FRICTION_DOMINATED", "NO_PRE_FRICTION_EDGE"])).toBe("EXECUTION_FRICTION_DOMINATED");
    expect(computeDominantFailureMode(["EXECUTION_FRICTION_DOMINATED", "NO_PRE_FRICTION_EDGE", "NET_EDGE_NOT_ROBUST", "ROBUST_NET_EDGE"])).toBe("MIXED_FAILURE_MODES");
    expect(computeDominantFailureMode(["ATTRIBUTION_UNRESOLVED", "EXECUTION_FRICTION_DOMINATED", "ATTRIBUTION_UNRESOLVED"])).toBe("INSUFFICIENT_ATTRIBUTION_EVIDENCE");
  });

  it("keeps the fixed five-experiment universe and WP1.1 anchor", () => {
    expect(WP2_EXPERIMENT_IDS).toHaveLength(5);
    expect(ATTRIBUTION_CATEGORIES).toContain("ATTRIBUTION_UNRESOLVED");
    expect(WP1_COMMIT).toBe("3897dfaf3d368ba391684f12580ba3aa12a632d2");
  });

  it("rejects an automatic-trading boundary", () => {
    expect(() => assertSystemBoundary({ ...SYSTEM_BOUNDARY, automaticTrading: true })).toThrow("automaticTrading");
  });
});
