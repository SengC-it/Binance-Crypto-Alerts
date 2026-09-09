import { describe, expect, it } from "vitest";
import {
  assertLegacyVariantForbidden,
  assertPromotionIsNotProductionActivation,
  assertStructurallyOrthogonal,
  consumeFamilyBudget,
  remainingFamilyBudget,
  shouldStopAlphaProgram,
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

  it("rejects a family already classified as exhausted", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "failed-breakout",
      informationSourceClass: "PRICE_DERIVED",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["information_source"],
      familyStatus: "EXHAUSTED_DO_NOT_RETUNE",
    })).toThrow("legacy family");
  });

  it("does not lower a data gate to salvage a data-insufficient family", () => {
    expect(() => assertStructurallyOrthogonal({
      family: "data-insufficient-family",
      informationSourceClass: "NEW_SOURCE",
      structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
      structuralDifferenceDimensions: ["information_source"],
      changedDimensions: ["threshold_only"],
      familyStatus: "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE",
    })).toThrow("legacy family");
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
});
