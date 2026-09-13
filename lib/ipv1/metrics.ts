import type { Ipv1ExecutionResult, Ipv1Metrics, Ipv1ReplayDecision } from "./types";

export function summarizeIpv1Replay(decisions: Ipv1ReplayDecision[]): Ipv1Metrics {
  const openedDecisions = decisions.filter((decision) => decision.execution?.opened === true);
  const opened = openedDecisions
    .map((decision) => decision.execution)
    .filter((execution): execution is Ipv1ExecutionResult => execution?.opened === true);
  const closed = openedDecisions
    .filter((decision) => decision.execution?.closed && decision.execution.status === "CLOSED")
    .sort(compareDecisionChronology)
    .map((decision) => decision.execution)
    .filter((execution): execution is Ipv1ExecutionResult => execution !== null);
  const netPnlUsdt = closed.reduce((total, execution) => total + (execution.netPnlUsdt ?? 0), 0);
  const netProfit = closed.reduce((total, execution) => total + Math.max(0, execution.netPnlUsdt ?? 0), 0);
  const netLoss = closed.reduce((total, execution) => total + Math.max(0, -(execution.netPnlUsdt ?? 0)), 0);
  const grossProfit = closed.reduce((total, execution) => total + Math.max(0, execution.grossPnlUsdt ?? 0), 0);
  const largestWinningTrade = closed.reduce((largest, execution) => Math.max(largest, execution.grossPnlUsdt ?? 0), 0);
  const netR = closed.map((execution) => execution.rMultiple ?? 0);
  const maxDrawdownUsdt = maxDrawdown(closed.map((execution) => execution.netPnlUsdt ?? 0));
  const maxDrawdownR = maxDrawdown(netR);
  const entryDays = new Set(
    opened
      .filter((execution) => execution.entryTime !== undefined)
      .map((execution) => new Date(execution.entryTime as number).toISOString().slice(0, 10)),
  );

  return {
    candidateDecisionGroups: decisions.filter((decision) => decision.candidate !== null).length,
    openedTrades: opened.length,
    closedTrades: closed.length,
    notExecutableTrades: decisions.filter((decision) => decision.outcome === "NOT_EXECUTABLE_AT_DECISION").length,
    dataInvalidTrades: decisions.filter((decision) => decision.outcome === "DATA_INVALID").length,
    netPnlUsdt,
    netProfit,
    netLoss,
    netProfitFactor: netLoss === 0 ? (netProfit > 0 ? Number.POSITIVE_INFINITY : 0) : netProfit / netLoss,
    avgNetPnlUsdt: closed.length === 0 ? 0 : netPnlUsdt / closed.length,
    avgR: closed.length === 0 ? 0 : netR.reduce((total, value) => total + value, 0) / closed.length,
    winRate: closed.length === 0 ? 0 : closed.filter((execution) => (execution.netPnlUsdt ?? 0) > 0).length / closed.length,
    maxDrawdownUsdt,
    maxDrawdownR,
    grossProfit,
    largestWinningTrade,
    largestWinningTradeGrossProfitContributionPct: grossProfit === 0 ? 0 : largestWinningTrade / grossProfit * 100,
    distinctUtcEntryDays: entryDays.size,
    feesUsdt: closed.reduce((total, execution) => total + (execution.feesUsdt ?? 0), 0),
    slippageUsdt: closed.reduce((total, execution) => total + (execution.slippageUsdt ?? 0), 0),
    fundingUsdt: closed.reduce((total, execution) => total + (execution.fundingUsdt ?? 0), 0),
    stopLossCount: closed.filter((execution) => execution.exitReason === "STOP_LOSS").length,
    takeProfitCount: closed.filter((execution) => execution.exitReason === "TAKE_PROFIT").length,
    timeLimitCount: closed.filter((execution) => execution.exitReason === "TIME_LIMIT").length,
  };
}

function compareDecisionChronology(left: Ipv1ReplayDecision, right: Ipv1ReplayDecision): number {
  const leftTime = left.execution?.exitTime ?? Number.POSITIVE_INFINITY;
  const rightTime = right.execution?.exitTime ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.scanGroupKey.localeCompare(right.scanGroupKey);
}

function maxDrawdown(values: number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}
