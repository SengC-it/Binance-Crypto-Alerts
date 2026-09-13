import type { Prc1ForwardComparison, Prc1PerformanceMetrics } from "./metrics";
import { PRC1_MIN_FORWARD_CLOSED_TRADES } from "./contract";

export const PRC1_FORWARD_GATE_COLLECTING = "COLLECTING_FORWARD_EVIDENCE" as const;
export const PRC1_FORWARD_GATE_PASS = "PRC1_FORWARD_GATE_PASS" as const;
export const PRC1_FORWARD_GATE_FAIL = "PRC1_FORWARD_GATE_FAIL" as const;
export const PRC1_DATA_INVALID = "DATA_INVALID" as const;

export type Prc1ForwardGateClassification =
  | typeof PRC1_FORWARD_GATE_COLLECTING
  | typeof PRC1_FORWARD_GATE_PASS
  | typeof PRC1_FORWARD_GATE_FAIL;

export interface Prc1GateCriterion {
  pass: boolean;
  actual: number;
  comparator: string;
  threshold?: number;
  reference?: number;
}

export interface Prc1ForwardGateEvaluation {
  status: typeof PRC1_FORWARD_GATE_COLLECTING
    | typeof PRC1_FORWARD_GATE_PASS
    | typeof PRC1_FORWARD_GATE_FAIL
    | typeof PRC1_DATA_INVALID;
  classification: Prc1ForwardGateClassification | null;
  criteria: {
    minimumChallengerClosedTrades: Prc1GateCriterion;
    challengerNetPnlUsdt: Prc1GateCriterion;
    challengerNetProfitFactor: Prc1GateCriterion;
    challengerAvgR: Prc1GateCriterion;
    challengerMaxDrawdown: Prc1GateCriterion;
    challengerNetProfitFactorImprovement: Prc1GateCriterion;
    challengerGrossProfitContributionLargestTradePct: Prc1GateCriterion;
  };
  invalidData: boolean;
  interimDiagnosticEligible: boolean;
  eligibleForHumanPromotionReview: boolean;
  automaticPromotion: false;
  signalEmailEnabled: false;
}

export function evaluatePrc1ForwardGate(
  comparison: Prc1ForwardComparison,
): Prc1ForwardGateEvaluation {
  const criteria = buildCriteria(comparison);
  if (!metricsValid(comparison.baseline) || !metricsValid(comparison.challenger)) {
    return {
      status: PRC1_DATA_INVALID,
      classification: PRC1_FORWARD_GATE_FAIL,
      criteria,
      invalidData: true,
      interimDiagnosticEligible: false,
      eligibleForHumanPromotionReview: false,
      automaticPromotion: false,
      signalEmailEnabled: false,
    };
  }

  if (comparison.challenger.closedTrades < 20) {
    return collecting(criteria, false);
  }
  if (comparison.challenger.closedTrades < PRC1_MIN_FORWARD_CLOSED_TRADES) {
    return collecting(criteria, true);
  }

  const passes = Object.values(criteria).every((criterion) => criterion.pass);
  const classification = passes ? PRC1_FORWARD_GATE_PASS : PRC1_FORWARD_GATE_FAIL;
  return {
    status: classification,
    classification,
    criteria,
    invalidData: false,
    interimDiagnosticEligible: false,
    eligibleForHumanPromotionReview: passes,
    automaticPromotion: false,
    signalEmailEnabled: false,
  };
}

function collecting(
  criteria: Prc1ForwardGateEvaluation["criteria"],
  interimDiagnosticEligible: boolean,
): Prc1ForwardGateEvaluation {
  return {
    status: PRC1_FORWARD_GATE_COLLECTING,
    classification: null,
    criteria,
    invalidData: false,
    interimDiagnosticEligible,
    eligibleForHumanPromotionReview: false,
    automaticPromotion: false,
    signalEmailEnabled: false,
  };
}

function buildCriteria(comparison: Prc1ForwardComparison): Prc1ForwardGateEvaluation["criteria"] {
  const { baseline, challenger } = comparison;
  return {
    minimumChallengerClosedTrades: {
      pass: challenger.closedTrades >= PRC1_MIN_FORWARD_CLOSED_TRADES,
      actual: challenger.closedTrades,
      comparator: ">=",
      threshold: PRC1_MIN_FORWARD_CLOSED_TRADES,
    },
    challengerNetPnlUsdt: {
      pass: challenger.netPnlUsdt > 0,
      actual: challenger.netPnlUsdt,
      comparator: ">",
      threshold: 0,
    },
    challengerNetProfitFactor: {
      pass: challenger.profitFactor >= 1.2,
      actual: challenger.profitFactor,
      comparator: ">=",
      threshold: 1.2,
    },
    challengerAvgR: {
      pass: challenger.avgR > 0,
      actual: challenger.avgR,
      comparator: ">",
      threshold: 0,
    },
    challengerMaxDrawdown: {
      pass: challenger.maxDrawdown < baseline.maxDrawdown,
      actual: challenger.maxDrawdown,
      comparator: "< baseline.maxDrawdown",
      reference: baseline.maxDrawdown,
    },
    challengerNetProfitFactorImprovement: {
      pass: challenger.profitFactor > baseline.profitFactor,
      actual: challenger.profitFactor,
      comparator: "> baseline.profitFactor",
      reference: baseline.profitFactor,
    },
    challengerGrossProfitContributionLargestTradePct: {
      pass: challenger.grossProfitContributionLargestTradePct <= 35,
      actual: challenger.grossProfitContributionLargestTradePct,
      comparator: "<=",
      threshold: 35,
    },
  };
}

function metricsValid(metrics: Prc1PerformanceMetrics): boolean {
  const finiteValues = [
    metrics.netPnlUsdt,
    metrics.netProfit,
    metrics.netLoss,
    metrics.avgPnl,
    metrics.avgR,
    metrics.maxDrawdown,
    metrics.grossProfit,
    metrics.grossLoss,
    metrics.largestWinningTrade,
    metrics.grossProfitContributionLargestTradePct,
  ];
  return Number.isInteger(metrics.closedTrades)
    && metrics.closedTrades >= 0
    && finiteValues.every(Number.isFinite)
    && (Number.isFinite(metrics.profitFactor) || metrics.profitFactor === Number.POSITIVE_INFINITY)
    && metrics.netProfit >= 0
    && metrics.netLoss >= 0;
}
