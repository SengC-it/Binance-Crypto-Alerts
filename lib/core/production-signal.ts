import { estimatedExecutionCostRiskFraction, isEntryIntervalAllowed } from "./execution-policy";
import { buildTradePlan } from "./risk";
import { rankCandidates } from "./scoring";
import { generateCandidates, type StrategyParams } from "./strategies";
import type { MarketSnapshot, RiskPolicy, ScoredCandidate, Side, StrategyCandidate, TradePlan } from "./types";

export interface ProductionSignalPolicy extends RiskPolicy {
  strategyParams: StrategyParams;
  minimumScore: number;
  sideFilter?: Side;
  strategyFamily?: StrategyCandidate["strategyFamily"];
  requireRegimeAlignment: boolean;
  entryIntervalHours: number;
  takerFeeRate: number;
  slippageBps: number;
  maxExecutionCostRiskFraction: number;
}

export type ProductionSignalEvaluationStatus =
  | "ADMITTED"
  | "NO_SIGNAL_CANDIDATE"
  | "NO_REGIME_ELIGIBLE_CANDIDATE"
  | "ENTRY_INTERVAL_BLOCKED"
  | "RISK_PLAN_ERROR"
  | "SINGLE_RISK_CAP"
  | "EXECUTION_COST_BLOCKED";

export type ProductionSignalStageStatus = "PASS" | "FAIL";

export interface ProductionSignalStageTrace {
  rawStrategyTrigger: ProductionSignalStageStatus;
  score: ProductionSignalStageStatus;
  sideFamilyFilter: ProductionSignalStageStatus;
  regime: ProductionSignalStageStatus;
  entryInterval: ProductionSignalStageStatus;
  riskAdmission: ProductionSignalStageStatus;
}

export interface ProductionSignalEvaluation {
  status: ProductionSignalEvaluationStatus;
  reason?: string;
  rawCandidates: StrategyCandidate[];
  scoredCandidates: ScoredCandidate[];
  scoreEligibleCandidates: ScoredCandidate[];
  sideFamilyEligibleCandidates: ScoredCandidate[];
  rankedCandidates: ScoredCandidate[];
  regimeEligibleCandidate: ScoredCandidate | null;
  candidate: ScoredCandidate | null;
  plan: TradePlan | null;
  entryIntervalAllowed: boolean | null;
  executionCostRiskFraction: number | null;
  stages: ProductionSignalStageTrace;
}

export function evaluateProductionSignal(
  snapshot: MarketSnapshot,
  policy: ProductionSignalPolicy,
): ProductionSignalEvaluation {
  const rawCandidates = generateCandidates(snapshot, policy.strategyParams);
  const scoredCandidates = rankCandidates(rawCandidates);
  const scoreEligibleCandidates = scoredCandidates.filter((candidate) => (
    policy.minimumScore === undefined || candidate.score >= policy.minimumScore
  ));
  const sideFamilyEligibleCandidates = scoreEligibleCandidates.filter((candidate) => (
    (!policy.sideFilter || candidate.side === policy.sideFilter)
    && (!policy.strategyFamily || candidate.strategyFamily === policy.strategyFamily)
  ));
  const rankedCandidates = sideFamilyEligibleCandidates;
  const stages: ProductionSignalStageTrace = {
    rawStrategyTrigger: rawCandidates.length > 0 ? "PASS" : "FAIL",
    score: scoreEligibleCandidates.length > 0 ? "PASS" : "FAIL",
    sideFamilyFilter: sideFamilyEligibleCandidates.length > 0 ? "PASS" : "FAIL",
    regime: "FAIL",
    entryInterval: "FAIL",
    riskAdmission: "FAIL",
  };
  if (rankedCandidates.length === 0) {
    return {
      status: "NO_SIGNAL_CANDIDATE",
      reason: rawCandidates.length === 0
        ? "No raw candidate passed the Production strategy trigger."
        : scoreEligibleCandidates.length === 0
          ? "Raw strategy candidates did not satisfy the Production score threshold."
          : "Scored candidates did not satisfy the Production side or family filter.",
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate: null,
      candidate: null,
      plan: null,
      entryIntervalAllowed: null,
      executionCostRiskFraction: null,
      stages,
    };
  }

  const regimeEligibleCandidate = rankedCandidates.find((item) => isRegimeAllowed(item, policy.requireRegimeAlignment)) ?? null;
  if (!regimeEligibleCandidate) {
    return {
      status: "NO_REGIME_ELIGIBLE_CANDIDATE",
      reason: "Ranked candidates did not satisfy Production regime alignment.",
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate: null,
      candidate: null,
      plan: null,
      entryIntervalAllowed: null,
      executionCostRiskFraction: null,
      stages,
    };
  }
  stages.regime = "PASS";

  const entryIntervalAllowed = isEntryIntervalAllowed(snapshot.sourceTimestamp, policy.entryIntervalHours);
  if (!entryIntervalAllowed) {
    return {
      status: "ENTRY_INTERVAL_BLOCKED",
      reason: "The Production entry interval rejected the source timestamp.",
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan: null,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
      stages,
    };
  }
  stages.entryInterval = "PASS";

  let plan: TradePlan;
  try {
    plan = buildTradePlan(regimeEligibleCandidate, snapshot.instrument, policy, snapshot.sourceTimestamp);
  } catch (error) {
    return {
      status: "RISK_PLAN_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan: null,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
      stages,
    };
  }

  if (plan.riskOverSingleCap) {
    return {
      status: "SINGLE_RISK_CAP",
      reason: "The Production risk plan exceeded the single-signal risk cap.",
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
      stages,
    };
  }

  const executionCostRiskFraction = estimatedExecutionCostRiskFraction(plan, policy.takerFeeRate, policy.slippageBps);
  if (executionCostRiskFraction > policy.maxExecutionCostRiskFraction) {
    return {
      status: "EXECUTION_COST_BLOCKED",
      reason: "The Production execution-cost risk fraction exceeded its configured limit.",
      rawCandidates,
      scoredCandidates,
      scoreEligibleCandidates,
      sideFamilyEligibleCandidates,
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan,
      entryIntervalAllowed,
      executionCostRiskFraction,
      stages,
    };
  }

  stages.riskAdmission = "PASS";
  return {
    status: "ADMITTED",
    rankedCandidates,
    rawCandidates,
    scoredCandidates,
    scoreEligibleCandidates,
    sideFamilyEligibleCandidates,
    regimeEligibleCandidate,
    candidate: regimeEligibleCandidate,
    plan,
    entryIntervalAllowed,
    executionCostRiskFraction,
    stages,
  };
}

export function buildProductionOpportunity(
  snapshot: MarketSnapshot,
  policy: ProductionSignalPolicy,
): { snapshot: MarketSnapshot; candidate: ScoredCandidate; plan: TradePlan } | undefined {
  const evaluation = evaluateProductionSignal(snapshot, policy);
  if (evaluation.status === "RISK_PLAN_ERROR") {
    throw new Error(evaluation.reason ?? "Production risk-plan replay failed");
  }
  if (evaluation.status !== "ADMITTED" || !evaluation.candidate || !evaluation.plan) return undefined;
  return { snapshot, candidate: evaluation.candidate, plan: evaluation.plan };
}

export function isRegimeAllowed(candidate: ScoredCandidate, required: boolean): boolean {
  if (!required) return true;
  if (candidate.strategyFamily === "MEAN_REVERSION") {
    return candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN";
  }
  return candidate.side === "LONG"
    ? candidate.marketRegime === "BULL"
    : candidate.marketRegime === "BEAR";
}
