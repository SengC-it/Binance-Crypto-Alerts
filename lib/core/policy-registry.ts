import type {
  DirectionApprovalStatus,
  GlobalMarketState,
  PolicyStatus,
  Side,
} from "./types";
import type { DirectionalCostAwareScoreModel } from "./opportunity-policy";
import type { DirectionalScoreCalibrationModel } from "./scoring";
import { DEFAULT_NO_CHASE_POLICY, type NoChasePolicy } from "./v5-entry-policy";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "./strategies";

export const V5_POLICY_VERSION = "v5-signal-edge-1";
export const CURRENT_PRODUCTION_CONTROL_VERSION = "current-production-control";

export interface DirectionApproval {
  LONG: DirectionApprovalStatus;
  SHORT: DirectionApprovalStatus;
}

export interface PolicyValidationMetrics {
  trades: number;
  averageNetR: number;
  medianNetR: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  cvar95: number;
  positiveFoldsRatio: number;
  positiveMonthsRatio: number;
  symbolBreadth: number;
  regimeBreadth: number;
  topSymbolProfitShare?: number;
  topThreeSymbolProfitShare?: number;
  profitConcentrationHhi?: number;
  stressExpectedNetR: number;
  frozenHoldout: boolean;
}

export interface V5Policy {
  policyVersion: string;
  strategyParams: StrategyParams;
  supportedDirections: Side[];
  directionApproval: DirectionApproval;
  entryPolicy: {
    setup: "PULLBACK_RETEST_REBREAK";
    trigger: "REJECTION_REBREAK";
    timeframe: "15m";
  };
  regimePolicy: {
    long: string[];
    short: string[];
    unknown: "FAIL_CLOSED";
  };
  noChasePolicy: NoChasePolicy;
  universePolicy: {
    minimumListingAgeDays: number;
    minimumHistoryDays: number;
    minimumCompleteness: number;
    volumeLookbackDays: number;
    staleCandleMinutes: number;
    orderBookAvailability: "UNAVAILABLE" | "PROXY" | "AVAILABLE";
  };
  calibrationModel: DirectionalScoreCalibrationModel | null;
  expectedEdgeModel: DirectionalCostAwareScoreModel | null;
  costModelVersion: string;
  trainWindow: { start: string; end: string };
  validationWindow: { start: string; end: string };
  holdoutWindow: { start: string; end: string };
  validationMetrics: Partial<Record<Side | "COMBINED", PolicyValidationMetrics>>;
  createdAt: string;
  approvedAt?: string;
  status: PolicyStatus;
}

export const DEFAULT_V5_POLICY: V5Policy = {
  policyVersion: V5_POLICY_VERSION,
  strategyParams: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "V5_SIGNAL_EDGE" },
  supportedDirections: ["LONG", "SHORT"],
  directionApproval: { LONG: "SHADOW_ONLY", SHORT: "SHADOW_ONLY" },
  entryPolicy: {
    setup: "PULLBACK_RETEST_REBREAK",
    trigger: "REJECTION_REBREAK",
    timeframe: "15m",
  },
  regimePolicy: {
    long: ["BULL_STRONG", "BULL_PULLBACK", "BULL_WEAK"],
    short: ["BEAR_STRONG", "BEAR_WEAK"],
    unknown: "FAIL_CLOSED",
  },
  noChasePolicy: DEFAULT_NO_CHASE_POLICY,
  universePolicy: {
    minimumListingAgeDays: 90,
    minimumHistoryDays: 365,
    minimumCompleteness: 0.98,
    volumeLookbackDays: 30,
    staleCandleMinutes: 45,
    orderBookAvailability: "UNAVAILABLE",
  },
  calibrationModel: null,
  expectedEdgeModel: null,
  costModelVersion: "reference-fee-slippage-funding-v1",
  trainWindow: { start: "", end: "" },
  validationWindow: { start: "", end: "" },
  holdoutWindow: { start: "", end: "" },
  validationMetrics: {},
  createdAt: new Date(0).toISOString(),
  status: "SHADOW",
};

export function selectApprovedPolicy(
  policies: V5Policy[],
  requestedVersion?: string,
): V5Policy | undefined {
  return policies.find((policy) => policy.status === "APPROVED"
    && (!requestedVersion || policy.policyVersion === requestedVersion));
}

export function isDirectionApproved(policy: V5Policy | undefined, side: Side): boolean {
  return Boolean(
    policy
    && policy.status === "APPROVED"
    && policy.supportedDirections.includes(side)
    && policy.directionApproval[side] === "APPROVED",
  );
}

export function directionApproval(policy: V5Policy | undefined, side: Side): DirectionApprovalStatus {
  return policy?.directionApproval[side] ?? "REJECTED";
}

export function policySnapshot(policy: V5Policy): Record<string, unknown> {
  return {
    policyVersion: policy.policyVersion,
    status: policy.status,
    directionApproval: policy.directionApproval,
    entryPolicy: policy.entryPolicy,
    regimePolicy: policy.regimePolicy,
    noChasePolicy: policy.noChasePolicy,
    universePolicy: policy.universePolicy,
    costModelVersion: policy.costModelVersion,
    trainWindow: policy.trainWindow,
    validationWindow: policy.validationWindow,
    holdoutWindow: policy.holdoutWindow,
    approvedAt: policy.approvedAt,
  };
}

export function globalStateIsKnown(state: GlobalMarketState | undefined): boolean {
  return Boolean(state && state.key !== "UNKNOWN");
}
