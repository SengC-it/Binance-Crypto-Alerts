import type { StrategyHealthStatus } from "./types";

export interface StrategyHealthTrade {
  rMultiple: number;
  exitReason?: string | null;
  entryTime?: number;
}

export interface StrategyHealthPolicy {
  rollingWindowTrades: number;
  minimumRollingTrades: number;
  historicalWindowTrades: number;
  degradedAverageNetR: number;
  failClosedAverageNetR: number;
  degradedProfitFactor: number;
  failClosedProfitFactor: number;
  degradedStopRate: number;
  failClosedStopRate: number;
  degradedMaxDrawdownR: number;
  failClosedMaxDrawdownR: number;
  degradedLowerConfidenceBound: number;
  failClosedLowerConfidenceBound: number;
  degradedRecentDrift: number;
  failClosedRecentDrift: number;
}

export const DEFAULT_STRATEGY_HEALTH_POLICY: StrategyHealthPolicy = {
  rollingWindowTrades: 50,
  minimumRollingTrades: 10,
  historicalWindowTrades: 200,
  degradedAverageNetR: -0.15,
  failClosedAverageNetR: -0.4,
  degradedProfitFactor: 0.85,
  failClosedProfitFactor: 0.6,
  degradedStopRate: 0.75,
  failClosedStopRate: 0.9,
  degradedMaxDrawdownR: 6,
  failClosedMaxDrawdownR: 10,
  degradedLowerConfidenceBound: -0.1,
  failClosedLowerConfidenceBound: -0.3,
  degradedRecentDrift: -0.25,
  failClosedRecentDrift: -0.5,
};

export interface StrategyHealthMetrics {
  rollingTrades: number;
  rollingAverageNetR: number;
  rollingProfitFactor: number;
  rollingStopRate: number;
  rollingMaxDrawdownR: number;
  rollingLowerConfidenceBound: number;
  historicalTrades: number;
  historicalAverageNetR: number | null;
  recentVsHistoricalDrift: number | null;
}

export interface StrategyHealthDecision {
  status: StrategyHealthStatus;
  productionAAllowed: boolean;
  reasons: string[];
  metrics: StrategyHealthMetrics;
  policy: StrategyHealthPolicy;
}

export interface StrategyHealthEvent {
  eventType: "WARNING";
  severity: "CRITICAL" | "WARNING";
  component: "production_signal_health_gate";
  message: string;
  details: StrategyHealthDecision;
}

export function buildStrategyHealthEvent(
  decision: StrategyHealthDecision,
  batchNumber: number,
): StrategyHealthEvent | null {
  if (decision.status === "HEALTHY" || batchNumber !== 0) return null;

  return {
    eventType: "WARNING",
    severity: decision.status === "FAIL_CLOSED" ? "CRITICAL" : "WARNING",
    component: "production_signal_health_gate",
    message: `Production strategy health is ${decision.status}; Production A email is blocked.`,
    details: decision,
  };
}

export function evaluateStrategyHealth(
  rollingTrades: StrategyHealthTrade[],
  historicalTrades: StrategyHealthTrade[] = [],
  policy: StrategyHealthPolicy = DEFAULT_STRATEGY_HEALTH_POLICY,
): StrategyHealthDecision {
  const rolling = cleanTrades(rollingTrades).slice(0, policy.rollingWindowTrades);
  const historical = cleanTrades(historicalTrades).slice(0, policy.historicalWindowTrades);
  const rollingStats = summarizeTrades(rolling);
  const historicalStats = historical.length > 0 ? summarizeTrades(historical) : null;
  const recentVsHistoricalDrift = historicalStats
    ? round(rollingStats.averageNetR - historicalStats.averageNetR)
    : null;
  const metrics: StrategyHealthMetrics = {
    rollingTrades: rolling.length,
    rollingAverageNetR: round(rollingStats.averageNetR),
    rollingProfitFactor: round(rollingStats.profitFactor),
    rollingStopRate: round(rollingStats.stopRate),
    rollingMaxDrawdownR: round(rollingStats.maxDrawdownR),
    rollingLowerConfidenceBound: round(rollingStats.lowerConfidenceBound),
    historicalTrades: historical.length,
    historicalAverageNetR: historicalStats ? round(historicalStats.averageNetR) : null,
    recentVsHistoricalDrift,
  };

  if (rolling.length < policy.minimumRollingTrades) {
    return {
      status: "UNKNOWN",
      productionAAllowed: false,
      reasons: ["insufficient_rolling_sample"],
      metrics,
      policy,
    };
  }

  const failClosedReasons = [
    metrics.rollingAverageNetR <= policy.failClosedAverageNetR ? "rolling_average_net_r" : null,
    metrics.rollingProfitFactor < policy.failClosedProfitFactor ? "rolling_profit_factor" : null,
    metrics.rollingStopRate >= policy.failClosedStopRate ? "rolling_stop_rate" : null,
    metrics.rollingMaxDrawdownR >= policy.failClosedMaxDrawdownR ? "rolling_max_drawdown_r" : null,
    metrics.rollingLowerConfidenceBound <= policy.failClosedLowerConfidenceBound ? "rolling_lower_confidence_bound" : null,
    recentVsHistoricalDrift !== null && recentVsHistoricalDrift <= policy.failClosedRecentDrift
      ? "recent_historical_drift"
      : null,
  ].filter((reason): reason is string => reason !== null);

  if (failClosedReasons.length > 0) {
    return {
      status: "FAIL_CLOSED",
      productionAAllowed: false,
      reasons: failClosedReasons,
      metrics,
      policy,
    };
  }

  const degradedReasons = [
    metrics.rollingAverageNetR <= policy.degradedAverageNetR ? "rolling_average_net_r" : null,
    metrics.rollingProfitFactor < policy.degradedProfitFactor ? "rolling_profit_factor" : null,
    metrics.rollingStopRate >= policy.degradedStopRate ? "rolling_stop_rate" : null,
    metrics.rollingMaxDrawdownR >= policy.degradedMaxDrawdownR ? "rolling_max_drawdown_r" : null,
    metrics.rollingLowerConfidenceBound <= policy.degradedLowerConfidenceBound
      ? "rolling_lower_confidence_bound"
      : null,
    recentVsHistoricalDrift !== null && recentVsHistoricalDrift <= policy.degradedRecentDrift
      ? "recent_historical_drift"
      : null,
  ].filter((reason): reason is string => reason !== null);

  return {
    status: degradedReasons.length > 0 ? "DEGRADED" : "HEALTHY",
    productionAAllowed: degradedReasons.length === 0,
    reasons: degradedReasons,
    metrics,
    policy,
  };
}

function cleanTrades(trades: StrategyHealthTrade[]): StrategyHealthTrade[] {
  return trades
    .filter((trade) => Number.isFinite(trade.rMultiple))
    .sort((left, right) => (right.entryTime ?? 0) - (left.entryTime ?? 0));
}

function summarizeTrades(trades: StrategyHealthTrade[]) {
  const values = trades.map((trade) => trade.rMultiple);
  const averageNetR = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of values.slice().reverse()) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const variance = values.length < 2
    ? 0
    : values.reduce((sum, value) => sum + (value - averageNetR) ** 2, 0) / (values.length - 1);
  const lowerConfidenceBound = averageNetR - 1.645 * Math.sqrt(variance) / Math.sqrt(Math.max(1, values.length));
  return {
    averageNetR,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss,
    stopRate: trades.length === 0 ? 0 : trades.filter((trade) => trade.exitReason === "STOP_LOSS" || trade.exitReason === "STOP").length / trades.length,
    maxDrawdownR,
    lowerConfidenceBound,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
