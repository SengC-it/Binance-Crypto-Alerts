import type { TradePlan } from "./types";

export function isEntryIntervalAllowed(sourceTimestamp: number, intervalHours: number): boolean {
  if (intervalHours <= 0) return true;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return (sourceTimestamp + 1) % intervalMs === 0;
}

export function estimatedExecutionCostRiskFraction(
  plan: TradePlan,
  takerFeeRate: number,
  slippageBps: number,
): number {
  if (plan.theoreticalRiskUsdt <= 0) return Number.POSITIVE_INFINITY;
  const slippageRate = slippageBps / 10_000;
  const entryNotional = plan.entryPrice * plan.quantity;
  const targetNotional = plan.takeProfitPrice * plan.quantity;
  const estimatedRoundTripCost = (entryNotional + targetNotional) * (takerFeeRate + slippageRate);
  return estimatedRoundTripCost / plan.theoreticalRiskUsdt;
}
