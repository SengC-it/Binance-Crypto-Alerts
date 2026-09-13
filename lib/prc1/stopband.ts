import type { TradePlan } from "@/lib/core/types";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_EXPERIMENT_ID,
  PRC1_FILTER_RULE,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
  PRC1_STOP_DISTANCE_LOWER_PCT,
  PRC1_STOP_DISTANCE_UPPER_PCT,
} from "./contract";

export function plannedStopDistancePct(plan: Pick<TradePlan, "entryPrice" | "stopPrice">): number {
  if (!Number.isFinite(plan.entryPrice) || plan.entryPrice <= 0 || !Number.isFinite(plan.stopPrice)) {
    throw new Error("Stop-distance filter requires a finite positive entry and stop price");
  }
  return Math.abs(plan.stopPrice - plan.entryPrice) / plan.entryPrice * 100;
}

export function stopBandFilterPass(plan: Pick<TradePlan, "entryPrice" | "stopPrice">): boolean {
  const distancePct = plannedStopDistancePct(plan);
  return !(distancePct >= PRC1_STOP_DISTANCE_LOWER_PCT && distancePct < PRC1_STOP_DISTANCE_UPPER_PCT);
}

export function selectChallengerOpportunity<T extends { plan: TradePlan }>(
  opportunities: T[],
): T | undefined {
  return opportunities.find((opportunity) => stopBandFilterPass(opportunity.plan));
}

export interface Prc1ChallengerMetadataInput {
  plan: TradePlan;
  sourceDataTimestamp: number;
  runtimeCommitSha?: string;
}

export function buildPrc1ChallengerMetadata(input: Prc1ChallengerMetadataInput): Record<string, unknown> {
  return {
    experimentId: PRC1_EXPERIMENT_ID,
    challengerVersion: PRC1_CHALLENGER_STRATEGY_VERSION,
    hypothesisFrozenAtUtc: PRC1_HYPOTHESIS_FROZEN_AT_UTC,
    plannedStopDistancePct: plannedStopDistancePct(input.plan),
    filterRule: PRC1_FILTER_RULE,
    baselineStrategyVersion: PRC1_BASELINE_STRATEGY_VERSION,
    sourceDataTimestamp: new Date(input.sourceDataTimestamp).toISOString(),
    runtimeCommitSha: input.runtimeCommitSha ?? "unknown",
  };
}
