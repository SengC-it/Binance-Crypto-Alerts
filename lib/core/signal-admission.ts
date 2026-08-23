import {
  expectedDirectionalNetR,
  type OpportunityPolicyFeatures,
} from "./opportunity-policy";
import {
  expectedDirectionalNetR as expectedDirectionalScoreNetR,
  type DirectionalScoreCalibrationModel,
} from "./scoring";
import { isDirectionApproved, type V5Policy } from "./policy-registry";
import type {
  AdmissionRejectionReason,
  ScoredCandidate,
  SignalTier,
  Side,
} from "./types";

export interface PromotionGate {
  minimumTrades: number;
  minimumAverageNetR: number;
  minimumMedianNetR?: number;
  minimumProfitFactor: number;
  maximumDrawdownPercent: number;
  /** Maximum allowed 95% tail-loss magnitude in R, including reference costs. */
  maximumCvar95: number;
  minimumEdgeConfidence: number;
  minimumPositiveFoldsRatio: number;
  minimumPositiveMonthsRatio: number;
  minimumSymbolBreadth: number;
  minimumRegimeBreadth: number;
  maximumTopSymbolProfitShare: number;
  maximumTopThreeSymbolProfitShare: number;
  minimumStressNetR: number;
  requireFrozenHoldout: boolean;
}

export const DEFAULT_PROMOTION_GATE: PromotionGate = {
  minimumTrades: 100,
  minimumAverageNetR: 0,
  minimumProfitFactor: 1.2,
  maximumDrawdownPercent: 30,
  maximumCvar95: 1.25,
  minimumEdgeConfidence: 0.55,
  minimumPositiveFoldsRatio: 0.6,
  minimumPositiveMonthsRatio: 0.55,
  minimumSymbolBreadth: 10,
  minimumRegimeBreadth: 2,
  maximumTopSymbolProfitShare: 0.55,
  maximumTopThreeSymbolProfitShare: 0.9,
  minimumStressNetR: 0,
  requireFrozenHoldout: true,
};

export interface SignalAdmissionEvidence {
  expectedGrossR?: number | null;
  expectedNetR?: number | null;
  stressExpectedNetR?: number | null;
  stressCostAdjustmentR?: number | null;
  winProbability?: number | null;
  edgeConfidence?: number | null;
  /** Legacy input alias; it is interpreted as edgeConfidence, never winProbability. */
  confidence?: number | null;
  calibrationSamples?: number | null;
  policyFeatures?: OpportunityPolicyFeatures;
}

export interface SignalAdmissionDecision {
  tier: SignalTier;
  productionEligible: boolean;
  reasons: AdmissionRejectionReason[];
  policyVersion?: string;
  expectedGrossR: number | null;
  expectedNetR: number | null;
  stressExpectedNetR: number | null;
  winProbability: number | null;
  edgeConfidence: number | null;
  /** Legacy output alias for edgeConfidence. */
  confidence: number | null;
  calibrationSamples: number;
}

export function admitSignal(
  candidate: ScoredCandidate,
  policy: V5Policy | undefined,
  evidence: SignalAdmissionEvidence = {},
  gate: Pick<PromotionGate, "minimumTrades" | "minimumAverageNetR" | "minimumStressNetR"> & {
    minimumEdgeConfidence?: number;
    minimumExpectedNetR?: number;
  } = { minimumTrades: 40, minimumAverageNetR: 0, minimumStressNetR: 0, minimumEdgeConfidence: 0.55, minimumExpectedNetR: 0.02 },
): SignalAdmissionDecision {
  const reasons: AdmissionRejectionReason[] = [];
  const marketState = candidate.marketState;
  const expectedFromCalibration = policy?.calibrationModel
    ? expectedDirectionalScoreNetR(policy.calibrationModel, candidate.side, candidate.score, candidate.strategyFamily)
    : null;
  const expectedFromCost = policy?.expectedEdgeModel && evidence.policyFeatures
    ? expectedDirectionalNetR(policy.expectedEdgeModel, candidate.side, candidate.score, evidence.policyFeatures)
    : null;
  const expectedNetR = evidence.expectedNetR
    ?? expectedFromCost
    ?? expectedFromCalibration
    ?? candidate.expectedNetR
    ?? null;
  const expectedGrossR = evidence.expectedGrossR ?? candidate.expectedGrossR ?? null;
  const stressExpectedNetR = evidence.stressExpectedNetR
    ?? (expectedNetR === null
      ? null
      : expectedNetR - Math.max(0, evidence.stressCostAdjustmentR ?? 0));
  const calibrationSamples = evidence.calibrationSamples
    ?? calibrationSamplesFor(policy?.calibrationModel, candidate.side, candidate.score, candidate.strategyFamily)
    ?? 0;
  const edgeConfidence = evidence.edgeConfidence
    ?? evidence.confidence
    ?? candidate.confidence
    ?? calibrationEdgeConfidenceFor(policy?.calibrationModel, candidate.side, candidate.score, candidate.strategyFamily);
  const winProbability = evidence.winProbability
    ?? calibrationWinProbabilityFor(policy?.calibrationModel, candidate.side, candidate.score, candidate.strategyFamily);

  if (!marketState || marketState === "UNKNOWN") reasons.push("UNKNOWN_MARKET_STATE");
  if (marketState && !directionRegimeAligned(candidate.side, marketState)) reasons.push("WRONG_REGIME");
  if (!candidate.setupType || candidate.setupType === "NO_SETUP") reasons.push("INVALID_STRUCTURE");
  if (candidate.entryTrigger !== "REJECTION_REBREAK" && candidate.entryTrigger !== "BREAKOUT_RETEST") reasons.push("NO_TRIGGER");
  if (!candidate.noChase?.passed) reasons.push(candidate.noChase?.reasons.includes("INVALID_STRUCTURE") ? "INVALID_STRUCTURE" : "CHASE");
  if (expectedGrossR !== null && expectedGrossR <= 0) reasons.push("NEGATIVE_EV");
  if (expectedNetR !== null && expectedNetR < (gate.minimumExpectedNetR ?? 0.02)) reasons.push("NEGATIVE_EV");
  if (stressExpectedNetR !== null && stressExpectedNetR < (gate.minimumStressNetR ?? 0)) reasons.push("COST_STRESS_FAIL");
  if (calibrationSamples < gate.minimumTrades) reasons.push("INSUFFICIENT_SAMPLE");
  if (edgeConfidence === null || edgeConfidence < (gate.minimumEdgeConfidence ?? 0.55)) reasons.push("LOW_CONFIDENCE");
  if (evidence.policyFeatures
    && (evidence.policyFeatures.fundingDataStatus === "UNKNOWN" || !Number.isFinite(evidence.policyFeatures.projectedFundingCostRiskFraction))) {
    reasons.push("FUNDING_UNAVAILABLE");
  }
  if (!policy) reasons.push("MISSING_POLICY");
  else if (!isDirectionApproved(policy, candidate.side)) reasons.push("DIRECTION_NOT_APPROVED");
  if (policy && (!policy.calibrationModel || !policy.expectedEdgeModel || expectedNetR === null)) reasons.push("INSUFFICIENT_SAMPLE");

  const uniqueReasons = [...new Set(reasons)];
  const hardReject = uniqueReasons.some((reason) => [
    "CHASE",
    "WRONG_REGIME",
    "NO_TRIGGER",
    "NEGATIVE_EV",
    "COST_STRESS_FAIL",
    "UNKNOWN_MARKET_STATE",
    "INVALID_STRUCTURE",
  ].includes(reason));
  const tier: SignalTier = uniqueReasons.length === 0 ? "A" : hardReject ? "C" : "B";
  return {
    tier,
    productionEligible: tier === "A" && Boolean(policy && isDirectionApproved(policy, candidate.side)),
    reasons: uniqueReasons,
    policyVersion: policy?.policyVersion,
    expectedGrossR,
    expectedNetR,
    stressExpectedNetR,
    winProbability,
    edgeConfidence,
    confidence: edgeConfidence,
    calibrationSamples,
  };
}

export function directionRegimeAligned(side: Side, marketState: string): boolean {
  if (marketState === "UNKNOWN" || marketState === "OTHER") return false;
  if (side === "LONG") return marketState === "BULL_STRONG" || marketState === "BULL_PULLBACK" || marketState === "BULL_WEAK";
  return marketState === "BEAR_STRONG" || marketState === "BEAR_WEAK";
}

function calibrationSamplesFor(
  model: DirectionalScoreCalibrationModel | null | undefined,
  side: Side,
  score: number,
  strategyFamily: ScoredCandidate["strategyFamily"],
): number | null {
  const sideModel = model?.byDirection[side];
  if (!sideModel) return null;
  const lowerScore = Math.min(100, Math.max(0, Math.floor(score / sideModel.bucketSize) * sideModel.bucketSize));
  const key = sideModel.groupByStrategyFamily ? `${strategyFamily}:${lowerScore}` : String(lowerScore);
  return sideModel.bins.find((bin) => bin.key === key)?.samples ?? null;
}

function calibrationEdgeConfidenceFor(
  model: DirectionalScoreCalibrationModel | null | undefined,
  side: Side,
  score: number,
  strategyFamily: ScoredCandidate["strategyFamily"],
): number | null {
  const sideModel = model?.byDirection[side];
  if (!sideModel) return null;
  const lowerScore = Math.min(100, Math.max(0, Math.floor(score / sideModel.bucketSize) * sideModel.bucketSize));
  const key = sideModel.groupByStrategyFamily ? `${strategyFamily}:${lowerScore}` : String(lowerScore);
  const bin = sideModel.bins.find((item) => item.key === key);
  return bin?.edgeConfidence ?? null;
}

function calibrationWinProbabilityFor(
  model: DirectionalScoreCalibrationModel | null | undefined,
  side: Side,
  score: number,
  strategyFamily: ScoredCandidate["strategyFamily"],
): number | null {
  const sideModel = model?.byDirection[side];
  if (!sideModel) return null;
  const lowerScore = Math.min(100, Math.max(0, Math.floor(score / sideModel.bucketSize) * sideModel.bucketSize));
  const key = sideModel.groupByStrategyFamily ? `${strategyFamily}:${lowerScore}` : String(lowerScore);
  const bin = sideModel.bins.find((item) => item.key === key);
  return bin?.winProbability ?? null;
}

export function emptyAdmissionDecision(reason: AdmissionRejectionReason = "MISSING_POLICY"): SignalAdmissionDecision {
  return {
    tier: "B",
    productionEligible: false,
    reasons: [reason],
    expectedGrossR: null,
    expectedNetR: null,
    stressExpectedNetR: null,
    winProbability: null,
    edgeConfidence: null,
    confidence: null,
    calibrationSamples: 0,
  };
}
