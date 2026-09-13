import {
  IPV1_EMAIL_GATE_MIN_CLOSED_TRADES,
  IPV1_DATA_INVALID,
  IPV1_GATE_COLLECTING,
  IPV1_GATE_FAIL,
  IPV1_GATE_PASS,
  type Ipv1GateCriterion,
  type Ipv1GateEvaluation,
  type Ipv1Metrics,
} from "./types";

export function evaluateIpv1EmailPilotGate(
  baselinePrimary: Ipv1Metrics,
  challengerPrimary: Ipv1Metrics,
  challengerStress: Ipv1Metrics,
  dataInvalid = false,
): Ipv1GateEvaluation {
  const criteria = buildCriteria(baselinePrimary, challengerPrimary, challengerStress);
  const invalidData = dataInvalid || !metricsValid(baselinePrimary) || !metricsValid(challengerPrimary) || !metricsValid(challengerStress);
  if (invalidData) return result(IPV1_DATA_INVALID, criteria, true, false, false);
  if (challengerPrimary.closedTrades < IPV1_EMAIL_GATE_MIN_CLOSED_TRADES) {
    return result(IPV1_GATE_COLLECTING, criteria, false, false, false);
  }
  const passes = Object.values(criteria).every((criterion) => criterion.pass);
  return result(passes ? IPV1_GATE_PASS : IPV1_GATE_FAIL, criteria, false, passes, true);
}

function buildCriteria(
  baseline: Ipv1Metrics,
  challenger: Ipv1Metrics,
  stress: Ipv1Metrics,
): Ipv1GateEvaluation["criteria"] {
  return {
    challengerNetPnlUsdt: criterion(challenger.netPnlUsdt > 0, challenger.netPnlUsdt, ">", 0),
    challengerNetProfitFactor: criterion(challenger.netProfitFactor >= 1.1, challenger.netProfitFactor, ">=", 1.1),
    challengerAvgR: criterion(challenger.avgR > 0, challenger.avgR, ">", 0),
    challengerBeatsBaselineNetPnl: criterion(challenger.netPnlUsdt > baseline.netPnlUsdt, challenger.netPnlUsdt, "> baseline.netPnlUsdt", undefined, baseline.netPnlUsdt),
    challengerBeatsBaselineProfitFactor: criterion(challenger.netProfitFactor > baseline.netProfitFactor, challenger.netProfitFactor, "> baseline.netProfitFactor", undefined, baseline.netProfitFactor),
    challengerDrawdownRBelowBaseline: criterion(challenger.maxDrawdownR < baseline.maxDrawdownR, challenger.maxDrawdownR, "< baseline.maxDrawdownR", undefined, baseline.maxDrawdownR),
    challengerWinnerConcentration: criterion(challenger.largestWinningTradeGrossProfitContributionPct <= 35, challenger.largestWinningTradeGrossProfitContributionPct, "<=", 35),
    challengerDistinctUtcEntryDays: criterion(challenger.distinctUtcEntryDays >= 3, challenger.distinctUtcEntryDays, ">=", 3),
    stressNetPnlUsdt: criterion(stress.netPnlUsdt >= 0, stress.netPnlUsdt, ">=", 0),
    stressProfitFactor: criterion(stress.netProfitFactor >= 1, stress.netProfitFactor, ">=", 1),
  };
}

function criterion(
  pass: boolean,
  actual: number,
  comparator: string,
  threshold?: number,
  reference?: number,
): Ipv1GateCriterion {
  return { pass, actual, comparator, ...(threshold === undefined ? {} : { threshold }), ...(reference === undefined ? {} : { reference }) };
}

function result(
  status: typeof IPV1_DATA_INVALID | typeof IPV1_GATE_COLLECTING | typeof IPV1_GATE_PASS | typeof IPV1_GATE_FAIL,
  criteria: Ipv1GateEvaluation["criteria"],
  invalidData: boolean,
  eligibleForEmailPilotReview: boolean,
  strategyGateEvaluated: boolean,
): Ipv1GateEvaluation {
  return {
    status,
    classification: status === IPV1_DATA_INVALID ? null : status,
    criteria,
    invalidData,
    strategyGateEvaluated,
    eligibleForEmailPilotReview,
    automaticPromotion: false,
    signalEmailEnabled: false,
  };
}

function metricsValid(metrics: Ipv1Metrics): boolean {
  const finite = [
    metrics.netPnlUsdt,
    metrics.netProfit,
    metrics.netLoss,
    metrics.avgNetPnlUsdt,
    metrics.avgR,
    metrics.winRate,
    metrics.maxDrawdownUsdt,
    metrics.maxDrawdownR,
    metrics.grossProfit,
    metrics.largestWinningTrade,
    metrics.largestWinningTradeGrossProfitContributionPct,
    metrics.feesUsdt,
    metrics.slippageUsdt,
    metrics.fundingUsdt,
  ];
  return Number.isInteger(metrics.closedTrades)
    && metrics.closedTrades >= 0
    && finite.every(Number.isFinite)
    && (Number.isFinite(metrics.netProfitFactor) || metrics.netProfitFactor === Number.POSITIVE_INFINITY)
    && metrics.netProfit >= 0
    && metrics.netLoss >= 0;
}
