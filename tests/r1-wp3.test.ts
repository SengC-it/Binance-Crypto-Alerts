import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_ALPHA_FAMILIES,
  assertLegacyVariantForbidden,
  assertPromotionIsNotProductionActivation,
  assertStructurallyOrthogonal,
  consumeFamilyBudget,
  normalizeFamilyName,
  remainingFamilyBudget,
  shouldStopAlphaProgram,
  validateLegacyRegistryCompleteness,
} from "../scripts/build-r1-research-direction";

describe("R1-WP3 research direction gate", () => {
  it.each([
    ["parameter-only", ["parameter_only"]],
    ["threshold-only", ["threshold_only"]],
    ["horizon-only", ["horizon_only"]],
    ["universe-only", ["universe_only"]],
  ])("rejects a %s variant", (_label, changedDimensions) => {
    expect(() => assertLegacyVariantForbidden({ changedDimensions })).toThrow("retuning-only variant");
  });

  it("admits a genuinely new information source as a candidate direction", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "liquidation-structure",
      informationSourceClass: "LIQUIDATION_STRUCTURE",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
      familyStatus: "NEW",
    })).not.toThrow();
  });

  it("rejects a legacy family even when caller claims NEW", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "failed breakout",
      informationSourceClass: "PRICE_DERIVED",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
      familyStatus: "NEW",
    })).toThrow("legacy family");
  });

  it("rejects a legacy family alias even when caller claims NEW", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "failed-breakout",
      informationSourceClass: "PRICE_DERIVED",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
      familyStatus: "NEW",
    })).toThrow("RESEARCH_ADMISSION_FAIL");
    expect(normalizeFamilyName("  Failed__Breakout ")).toBe("failed breakout");
  });

  it("rejects a legacy family when familyStatus is omitted", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "spot-perp lead-lag",
      informationSourceClass: "CROSS_MARKET",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
    })).toThrow("legacy family");
  });

  it("rejects a known legacy family despite an asserted structural difference", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "failed breakout",
      informationSourceClass: "NEW_SOURCE",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
    })).toThrow("legacy family");
  });

  it("rejects a caller status that conflicts with the canonical legacy registry", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "failed breakout",
      informationSourceClass: "PRICE_DERIVED",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
      familyStatus: "NEW",
    })).toThrow("canonical");
  });

  it("does not let a caller status salvage an unknown family", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "data-insufficient-family",
      informationSourceClass: "NEW_SOURCE",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["threshold_only"],
      familyStatus: "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE",
    })).toThrow("not authoritative");
  });

  it("decrements budget by family, not version", () => {
    const initial = { totalFamilies: 3, consumedFamilies: [] };
    const afterFirstVersion = consumeFamilyBudget(initial, "family-a");
    expect(remainingFamilyBudget(afterFirstVersion)).toBe(2);
    expect(() => consumeFamilyBudget(afterFirstVersion, "family-a")).toThrow("family already consumed");
    const afterSecondFamily = consumeFamilyBudget(afterFirstVersion, "family-b");
    expect(remainingFamilyBudget(afterSecondFamily)).toBe(1);
  });

  it("stops new alpha research after three failed orthogonal families", () => {
    expect(shouldStopAlphaProgram({ failedOrthogonalFamilies: 3, promotionCandidates: 0, budget: 3 })).toBe(true);
    expect(shouldStopAlphaProgram({ failedOrthogonalFamilies: 2, promotionCandidates: 0, budget: 3 })).toBe(false);
  });

  it("keeps a research promotion candidate separate from Production activation", () => {
    expect(() => assertPromotionIsNotProductionActivation({ promotionCandidate: true, productionEmail: "OFF", productionChanged: false, deploy: false, orderPlacement: false, autoTrading: false })).not.toThrow();
    expect(() => assertPromotionIsNotProductionActivation({ promotionCandidate: true, productionEmail: "ON", productionChanged: false, deploy: false, orderPlacement: false, autoTrading: false })).toThrow("Production");
  });

  it("rejects automatic trading even if research evidence passes", () => {
    expect(() => assertPromotionIsNotProductionActivation({ promotionCandidate: true, productionEmail: "OFF", productionChanged: false, deploy: false, orderPlacement: false, autoTrading: true })).toThrow("Production");
  });

  it("requires exact inventory-to-registry experiment coverage", () => {
    const result = validateLegacyRegistryCompleteness(["A", "B"], [{ experimentIds: ["A"] }, { experimentIds: ["B"] }]);
    expect(result.passes).toBe(true);
    expect(result.inventoryExperimentIds).toEqual(["A", "B"]);
    expect(result.registryExperimentIds).toEqual(["A", "B"]);
  });

  it("fails completeness when an inventory experiment is missing", () => {
    const result = validateLegacyRegistryCompleteness(["A", "B"], [{ experimentIds: ["A"] }]);
    expect(result.passes).toBe(false);
    expect(result.missingIds).toEqual(["B"]);
  });

  it("fails completeness when the registry contains an unknown experiment", () => {
    const result = validateLegacyRegistryCompleteness(["A"], [{ experimentIds: ["A", "UNKNOWN"] }]);
    expect(result.passes).toBe(false);
    expect(result.unknownIds).toEqual(["UNKNOWN"]);
  });

  it("covers every approved inventory experiment in the canonical registry", () => {
    const inventoryIds = [
      "LFV_001_PRODUCTION_LOSS_FACTOR_VALIDATION",
      "V12_MARKET_NEUTRAL_ALPHA",
      "V13_RELATIVE_VALUE_ALPHA",
      "V14_CROSS_SECTIONAL_REVERSAL",
      "V15_SPOT_PERP_LEAD_LAG",
      "V16_AGGTRADE_ABSORPTION_REVERSAL",
      "V17_CROWDING_FAILED_CONTINUATION",
      "V18_TAKER_FLOW_ABSORPTION_REVERSAL",
      "V19_BTC_SHOCK_ALT_CATCHUP",
      "V20_LAST_MARK_DISLOCATION_CONVERGENCE",
      "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL",
      "V5_1_SIGNAL_EDGE",
      "V5_2_PROFITABILITY_VALIDATION",
      "V5_3_STRUCTURAL_EDGE",
      "V5_4_EVIDENCE_HARDENING",
      "V5_5_FORWARD_SHADOW",
      "V5_6_1_EVIDENCE_ENSEMBLE",
      "V5_6_PROFITABLE_SIGNAL_YIELD",
      "V5_7_SECOND_EDGE_DATA_COMPLETION",
      "V5_8_REGIME_RECONSTRUCTION",
      "V5_9_1_EXPECTANCY_CALIBRATION",
      "V5_9_META_LABEL_VALIDATION",
      "V6_STRATEGY_RESET",
      "V7_DERIVATIVES_FLOW_ALPHA",
    ];
    expect(validateLegacyRegistryCompleteness(inventoryIds, EXHAUSTED_ALPHA_FAMILIES).passes).toBe(true);
  });
});
