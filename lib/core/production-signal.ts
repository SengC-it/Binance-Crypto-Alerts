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

export interface ProductionSignalEvaluation {
  status: ProductionSignalEvaluationStatus;
  reason?: string;
  rankedCandidates: ScoredCandidate[];
  regimeEligibleCandidate: ScoredCandidate | null;
  candidate: ScoredCandidate | null;
  plan: TradePlan | null;
  entryIntervalAllowed: boolean | null;
  executionCostRiskFraction: number | null;
}

export function evaluateProductionSignal(
  snapshot: MarketSnapshot,
  policy: ProductionSignalPolicy,
): ProductionSignalEvaluation {
  const rankedCandidates = rankCandidates(generateCandidates(snapshot, policy.strategyParams), {
    minimumScore: policy.minimumScore,
    sideFilter: policy.sideFilter,
    strategyFamily: policy.strategyFamily,
  });
  if (rankedCandidates.length === 0) {
    return {
      status: "NO_SIGNAL_CANDIDATE",
      reason: "No candidate passed the Production strategy trigger, score, side, or family filter.",
      rankedCandidates,
      regimeEligibleCandidate: null,
      candidate: null,
      plan: null,
      entryIntervalAllowed: null,
      executionCostRiskFraction: null,
    };
  }

  const regimeEligibleCandidate = rankedCandidates.find((item) => isRegimeAllowed(item, policy.requireRegimeAlignment)) ?? null;
  if (!regimeEligibleCandidate) {
    return {
      status: "NO_REGIME_ELIGIBLE_CANDIDATE",
      reason: "Ranked candidates did not satisfy Production regime alignment.",
      rankedCandidates,
      regimeEligibleCandidate: null,
      candidate: null,
      plan: null,
      entryIntervalAllowed: null,
      executionCostRiskFraction: null,
    };
  }

  const entryIntervalAllowed = isEntryIntervalAllowed(snapshot.sourceTimestamp, policy.entryIntervalHours);
  if (!entryIntervalAllowed) {
    return {
      status: "ENTRY_INTERVAL_BLOCKED",
      reason: "The Production entry interval rejected the source timestamp.",
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan: null,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
    };
  }

  let plan: TradePlan;
  try {
    plan = buildTradePlan(regimeEligibleCandidate, snapshot.instrument, policy, snapshot.sourceTimestamp);
  } catch (error) {
    return {
      status: "RISK_PLAN_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan: null,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
    };
  }

  if (plan.riskOverSingleCap) {
    return {
      status: "SINGLE_RISK_CAP",
      reason: "The Production risk plan exceeded the single-signal risk cap.",
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan,
      entryIntervalAllowed,
      executionCostRiskFraction: null,
    };
  }

  const executionCostRiskFraction = estimatedExecutionCostRiskFraction(plan, policy.takerFeeRate, policy.slippageBps);
  if (executionCostRiskFraction > policy.maxExecutionCostRiskFraction) {
    return {
      status: "EXECUTION_COST_BLOCKED",
      reason: "The Production execution-cost risk fraction exceeded its configured limit.",
      rankedCandidates,
      regimeEligibleCandidate,
      candidate: null,
      plan,
      entryIntervalAllowed,
      executionCostRiskFraction,
    };
  }

  return {
    status: "ADMITTED",
    rankedCandidates,
    regimeEligibleCandidate,
    candidate: regimeEligibleCandidate,
    plan,
    entryIntervalAllowed,
    executionCostRiskFraction,
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
