import type { Candle, FundingRatePoint, ScoredCandidate, TradePlan } from "@/lib/core/types";

export const IPV1_EXPERIMENT_ID = "IPV1_INDEPENDENT_EMAIL_PROFIT_VALIDATION" as const;
export const IPV1_HYPOTHESIS_FROZEN_AT_UTC = "2026-09-12T23:46:20.666Z" as const;
export const IPV1_BASELINE_STRATEGY_VERSION = "default-trend-shadow-v1" as const;
export const IPV1_CHALLENGER_STRATEGY_VERSION = "default-trend-shadow-v2-stopband-filter" as const;
export const IPV1_SYMBOL_COOLDOWN_HOURS = 8 as const;
export const IPV1_MAX_OPEN_POSITIONS = 1 as const;
export const IPV1_EMAIL_GATE_MIN_CLOSED_TRADES = 20 as const;

export const IPV1_PRIMARY_EXECUTION = {
  id: "EMAIL_REALISTIC_60S",
  humanDelaySeconds: 60,
  slippageBps: 2,
  takerFeeRate: 0.0004,
} as const;

export const IPV1_STRESS_EXECUTION = {
  id: "EMAIL_STRESS_180S_5BPS",
  humanDelaySeconds: 180,
  slippageBps: 5,
  takerFeeRate: 0.0004,
} as const;

export interface Ipv1ScanGroup {
  scanGroupKey: string;
  status: string;
  finishedAt: number;
}

export interface Ipv1Candidate {
  scanGroupKey: string;
  symbol: string;
  sourceDataTimestamp: number;
  score: number;
  candidate: ScoredCandidate;
  plan: TradePlan;
}

export interface Ipv1CandidateRow {
  scan_group_key: unknown;
  symbol: unknown;
  source_data_timestamp: unknown;
  score: unknown;
  candidate: unknown;
  trade_plan: unknown;
}

export interface Ipv1ScanGroupRow {
  scan_group_key: unknown;
  status: unknown;
  finished_at: unknown;
}

export interface Ipv1ExecutionModel {
  id: string;
  humanDelaySeconds: number;
  slippageBps: number;
  takerFeeRate: number;
}

export interface Ipv1MarketDataProvider {
  getMinuteCandles(symbol: string, startTime: number, endTime: number): Promise<Candle[]>;
  getFundingRates(symbol: string, startTime: number, endTime: number): Promise<FundingRatePoint[]>;
}

export type Ipv1ExecutionStatus =
  | "CLOSED"
  | "OPEN"
  | "NOT_EXECUTABLE_AT_DECISION"
  | "DATA_INVALID";

export interface Ipv1ExecutionResult {
  status: Ipv1ExecutionStatus;
  opened: boolean;
  closed: boolean;
  dataInvalid: boolean;
  reason?: string;
  rawExecutionTime?: number;
  actualEntryTimestamp?: number;
  entryTime?: number;
  entryReferencePrice?: number;
  entryFillPrice?: number;
  exitTime?: number;
  rawExitPrice?: number;
  exitFillPrice?: number;
  exitReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_LIMIT";
  grossPnlUsdt?: number;
  feesUsdt?: number;
  fundingUsdt?: number;
  slippageUsdt?: number;
  netPnlUsdt?: number;
  rMultiple?: number;
  theoreticalRiskUsdt?: number;
}

export interface Ipv1ReplayDecision {
  scanGroupKey: string;
  decisionTime: number;
  candidate: Ipv1Candidate | null;
  outcome: "NO_CANDIDATE" | "OPEN_POSITION_BLOCKED" | "COOLDOWN_BLOCKED" | Ipv1ExecutionStatus;
  execution: Ipv1ExecutionResult | null;
}

export interface Ipv1ReplayResult {
  decisions: Ipv1ReplayDecision[];
  invalidEvidenceCount: number;
}

export interface Ipv1Metrics {
  candidateDecisionGroups: number;
  openedTrades: number;
  closedTrades: number;
  notExecutableTrades: number;
  dataInvalidTrades: number;
  netPnlUsdt: number;
  netProfit: number;
  netLoss: number;
  netProfitFactor: number;
  avgNetPnlUsdt: number;
  avgR: number;
  winRate: number;
  maxDrawdownUsdt: number;
  maxDrawdownR: number;
  grossProfit: number;
  largestWinningTrade: number;
  largestWinningTradeGrossProfitContributionPct: number;
  distinctUtcEntryDays: number;
  feesUsdt: number;
  slippageUsdt: number;
  fundingUsdt: number;
  stopLossCount: number;
  takeProfitCount: number;
  timeLimitCount: number;
}

export interface Ipv1GateCriterion {
  pass: boolean;
  actual: number;
  comparator: string;
  threshold?: number;
  reference?: number;
}

export const IPV1_GATE_COLLECTING = "COLLECTING_INDEPENDENT_EVIDENCE" as const;
export const IPV1_GATE_PASS = "IPV1_EMAIL_PILOT_GATE_PASS" as const;
export const IPV1_GATE_FAIL = "IPV1_EMAIL_PILOT_GATE_FAIL" as const;

export type Ipv1GateClassification =
  | typeof IPV1_GATE_COLLECTING
  | typeof IPV1_GATE_PASS
  | typeof IPV1_GATE_FAIL;

export interface Ipv1GateEvaluation {
  status: Ipv1GateClassification;
  classification: Ipv1GateClassification;
  criteria: {
    challengerNetPnlUsdt: Ipv1GateCriterion;
    challengerNetProfitFactor: Ipv1GateCriterion;
    challengerAvgR: Ipv1GateCriterion;
    challengerBeatsBaselineNetPnl: Ipv1GateCriterion;
    challengerBeatsBaselineProfitFactor: Ipv1GateCriterion;
    challengerDrawdownRBelowBaseline: Ipv1GateCriterion;
    challengerWinnerConcentration: Ipv1GateCriterion;
    challengerDistinctUtcEntryDays: Ipv1GateCriterion;
    stressNetPnlUsdt: Ipv1GateCriterion;
    stressProfitFactor: Ipv1GateCriterion;
  };
  invalidData: boolean;
  eligibleForEmailPilotReview: boolean;
  automaticPromotion: false;
  signalEmailEnabled: false;
}

export interface Ipv1PreparedEvidence {
  groups: Ipv1ScanGroup[];
  candidates: Ipv1Candidate[];
  invalidEvidenceCount: number;
  excludedBeforeFreezeCount: number;
  excludedNonCompletedGroupCount: number;
}
