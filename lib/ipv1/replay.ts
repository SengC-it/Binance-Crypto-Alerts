import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { stopBandFilterPass } from "@/lib/prc1/stopband";
import type { ScoredCandidate, TradePlan } from "@/lib/core/types";
import { simulateIpv1Execution } from "./execution";
import {
  IPV1_BASELINE_STRATEGY_VERSION,
  IPV1_CHALLENGER_STRATEGY_VERSION,
  IPV1_HYPOTHESIS_FROZEN_AT_UTC,
  IPV1_MAX_OPEN_POSITIONS,
  IPV1_SYMBOL_COOLDOWN_HOURS,
  type Ipv1Candidate,
  type Ipv1CandidateRow,
  type Ipv1ExecutionModel,
  type Ipv1MarketDataProvider,
  type Ipv1ReplayDecision,
  type Ipv1ReplayResult,
  type Ipv1ScanGroup,
  type Ipv1ScanGroupRow,
  type Ipv1PreparedEvidence,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;

export const IPV1_READ_ERROR = {
  MISSING_SUPABASE_CONFIGURATION: "MISSING_SUPABASE_CONFIGURATION",
  SUPABASE_GROUP_READ_FAILED: "SUPABASE_GROUP_READ_FAILED",
  SUPABASE_CANDIDATE_READ_FAILED: "SUPABASE_CANDIDATE_READ_FAILED",
} as const;

export type Ipv1ReadError = typeof IPV1_READ_ERROR[keyof typeof IPV1_READ_ERROR];

export interface Ipv1EvidenceReadResult {
  groups: Ipv1ScanGroupRow[];
  candidates: Ipv1CandidateRow[];
  error: Ipv1ReadError | null;
}

type SupabaseClientFactory = () => SupabaseClient;

export async function readIndependentEvidence(
  asOfUtc: string,
  clientFactory: SupabaseClientFactory = getSupabaseAdmin,
): Promise<Ipv1EvidenceReadResult> {
  if (!Number.isFinite(Date.parse(asOfUtc))) throw new Error("Invalid IPV-1 as-of timestamp");

  let supabase: SupabaseClient;
  try {
    supabase = clientFactory();
  } catch {
    return emptyEvidenceResult(IPV1_READ_ERROR.MISSING_SUPABASE_CONFIGURATION);
  }

  let groupsResult: { data: unknown; error: unknown };
  try {
    groupsResult = await supabase
      .from("bca_scan_groups")
      .select("scan_group_key,status,finished_at")
      .eq("status", "COMPLETED")
      .not("finished_at", "is", null)
      .gte("finished_at", IPV1_HYPOTHESIS_FROZEN_AT_UTC)
      .lt("finished_at", asOfUtc)
      .order("scan_group_key", { ascending: true });
  } catch {
    return emptyEvidenceResult(IPV1_READ_ERROR.SUPABASE_GROUP_READ_FAILED);
  }
  if (groupsResult.error || !Array.isArray(groupsResult.data)) {
    return emptyEvidenceResult(IPV1_READ_ERROR.SUPABASE_GROUP_READ_FAILED, groupsResult.data);
  }

  let candidatesResult: { data: unknown; error: unknown };
  try {
    candidatesResult = await supabase
      .from("bca_shadow_candidates")
      .select("scan_group_key,symbol,source_data_timestamp,score,candidate,trade_plan")
      .gte("source_data_timestamp", IPV1_HYPOTHESIS_FROZEN_AT_UTC)
      .lt("source_data_timestamp", asOfUtc)
      .order("scan_group_key", { ascending: true })
      .order("score", { ascending: false })
      .order("symbol", { ascending: true });
  } catch {
    return emptyEvidenceResult(IPV1_READ_ERROR.SUPABASE_CANDIDATE_READ_FAILED, groupsResult.data);
  }
  if (candidatesResult.error || !Array.isArray(candidatesResult.data)) {
    return emptyEvidenceResult(IPV1_READ_ERROR.SUPABASE_CANDIDATE_READ_FAILED, groupsResult.data);
  }

  return {
    groups: groupsResult.data as Ipv1ScanGroupRow[],
    candidates: candidatesResult.data as Ipv1CandidateRow[],
    error: null,
  };
}

function emptyEvidenceResult(error: Ipv1ReadError, groups: unknown = []): Ipv1EvidenceReadResult {
  return {
    groups: Array.isArray(groups) ? groups as Ipv1ScanGroupRow[] : [],
    candidates: [],
    error,
  };
}

export function prepareIpv1Evidence(
  groupRows: Ipv1ScanGroupRow[],
  candidateRows: Ipv1CandidateRow[],
  freezeUtc = IPV1_HYPOTHESIS_FROZEN_AT_UTC,
  asOfUtc?: string,
): Ipv1PreparedEvidence {
  const freezeMs = Date.parse(freezeUtc);
  if (!Number.isFinite(freezeMs)) throw new Error("Invalid IPV-1 freeze timestamp");
  const asOfMs = asOfUtc === undefined ? Number.POSITIVE_INFINITY : Date.parse(asOfUtc);
  if (asOfUtc !== undefined && !Number.isFinite(asOfMs)) throw new Error("Invalid IPV-1 as-of timestamp");

  const groups: Ipv1ScanGroup[] = [];
  let excludedBeforeFreezeGroupCount = 0;
  let excludedAfterAsOfGroupCount = 0;
  let excludedNonCompletedGroupCount = 0;
  for (const row of groupRows) {
    const key = stringValue(row.scan_group_key);
    const status = stringValue(row.status);
    const finishedAt = timestampValue(row.finished_at);
    if (status !== "COMPLETED" || key === null || finishedAt === null) {
      excludedNonCompletedGroupCount += 1;
      continue;
    }
    if (finishedAt < freezeMs) {
      excludedBeforeFreezeGroupCount += 1;
      continue;
    }
    if (finishedAt >= asOfMs) {
      excludedAfterAsOfGroupCount += 1;
      continue;
    }
    groups.push({ scanGroupKey: key, status, finishedAt });
  }

  const groupKeys = new Set(groups.map((group) => group.scanGroupKey));
  let invalidEvidenceCount = 0;
  let excludedBeforeFreezeCount = 0;
  let excludedAfterAsOfCount = 0;
  const candidates: Ipv1Candidate[] = [];
  for (const row of candidateRows) {
    const sourceTimestamp = timestampValue(row.source_data_timestamp);
    if (sourceTimestamp !== null && sourceTimestamp < freezeMs) {
      excludedBeforeFreezeCount += 1;
      continue;
    }
    if (sourceTimestamp !== null && sourceTimestamp >= asOfMs) {
      excludedAfterAsOfCount += 1;
      continue;
    }
    if (sourceTimestamp === null) {
      invalidEvidenceCount += 1;
      continue;
    }
    const candidate = parseCandidateRow(row, sourceTimestamp);
    if (candidate === null || !groupKeys.has(candidate.scanGroupKey)) {
      invalidEvidenceCount += 1;
      continue;
    }
    candidates.push(candidate);
  }

  groups.sort((left, right) => left.scanGroupKey.localeCompare(right.scanGroupKey));
  candidates.sort(compareCandidateRank);
  return {
    groups,
    candidates,
    invalidEvidenceCount,
    excludedBeforeFreezeCount,
    excludedAfterAsOfCount,
    excludedBeforeFreezeGroupCount,
    excludedAfterAsOfGroupCount,
    excludedNonCompletedGroupCount,
  };
}

export function compareCandidateRank(left: Pick<Ipv1Candidate, "score" | "symbol">, right: Pick<Ipv1Candidate, "score" | "symbol">): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.symbol.localeCompare(right.symbol);
}

export function candidatesForGroup(candidates: Ipv1Candidate[], scanGroupKey: string): Ipv1Candidate[] {
  return candidates
    .filter((candidate) => candidate.scanGroupKey === scanGroupKey)
    .sort(compareCandidateRank);
}

export function selectBaselineCandidate(candidates: Ipv1Candidate[]): Ipv1Candidate | undefined {
  return candidates[0];
}

export function selectChallengerCandidate(candidates: Ipv1Candidate[]): Ipv1Candidate | undefined {
  return candidates.find((candidate) => stopBandFilterPass(candidate.plan));
}

export async function runIpv1Replay(
  groups: Ipv1ScanGroup[],
  candidates: Ipv1Candidate[],
  strategyVersion: typeof IPV1_BASELINE_STRATEGY_VERSION | typeof IPV1_CHALLENGER_STRATEGY_VERSION,
  executionModel: Ipv1ExecutionModel,
  asOfMs: number,
  provider: Ipv1MarketDataProvider,
  invalidEvidenceCount = 0,
): Promise<Ipv1ReplayResult> {
  if (!Number.isFinite(asOfMs)) throw new Error("Invalid IPV-1 as-of timestamp");
  const decisions: Ipv1ReplayDecision[] = [];
  const orderedGroups = [...groups].sort((left, right) => left.scanGroupKey.localeCompare(right.scanGroupKey));
  const cooldowns = new Map<string, number>();
  let openExecution: { symbol: string; exitTime?: number; closed: boolean } | null = null;

  for (const group of orderedGroups) {
    if (group.finishedAt >= asOfMs) continue;

    if (openExecution && openExecution.closed && openExecution.exitTime !== undefined && openExecution.exitTime <= group.finishedAt) {
      openExecution = null;
    }
    if (openExecution && IPV1_MAX_OPEN_POSITIONS >= 1) {
      decisions.push({
        scanGroupKey: group.scanGroupKey,
        decisionTime: group.finishedAt,
        candidate: null,
        outcome: "OPEN_POSITION_BLOCKED",
        execution: null,
      });
      continue;
    }

    const ranked = candidatesForGroup(candidates, group.scanGroupKey);
    const selected = strategyVersion === IPV1_BASELINE_STRATEGY_VERSION
      ? selectBaselineCandidate(ranked)
      : selectChallengerCandidate(ranked);
    if (!selected) {
      decisions.push({
        scanGroupKey: group.scanGroupKey,
        decisionTime: group.finishedAt,
        candidate: null,
        outcome: "NO_CANDIDATE",
        execution: null,
      });
      continue;
    }

    const cooldownUntil = cooldowns.get(selected.symbol) ?? 0;
    if (selected.sourceDataTimestamp < cooldownUntil) {
      decisions.push({
        scanGroupKey: group.scanGroupKey,
        decisionTime: group.finishedAt,
        candidate: selected,
        outcome: "COOLDOWN_BLOCKED",
        execution: null,
      });
      continue;
    }

    const execution = await simulateIpv1Execution({
      candidate: selected,
      decisionTime: group.finishedAt,
      asOfMs,
      executionModel,
      provider,
    });
    decisions.push({
      scanGroupKey: group.scanGroupKey,
      decisionTime: group.finishedAt,
      candidate: selected,
      outcome: execution.status,
      execution,
    });
    if (execution.opened) {
      openExecution = {
        symbol: selected.symbol,
        exitTime: execution.exitTime,
        closed: execution.closed,
      };
      if (execution.closed && execution.exitTime !== undefined) {
        cooldowns.set(selected.symbol, execution.exitTime + IPV1_SYMBOL_COOLDOWN_HOURS * HOUR_MS);
      }
    }
  }

  return { decisions, invalidEvidenceCount };
}

function parseCandidateRow(row: Ipv1CandidateRow, sourceTimestamp: number): Ipv1Candidate | null {
  const scanGroupKey = stringValue(row.scan_group_key);
  const symbol = stringValue(row.symbol);
  const score = numberValue(row.score);
  if (scanGroupKey === null || symbol === null || score === null) return null;
  if (!isRecord(row.candidate) || !isRecord(row.trade_plan)) return null;
  const candidate = row.candidate as unknown as ScoredCandidate;
  const plan = row.trade_plan as unknown as TradePlan;
  if (candidate.side !== "LONG" && candidate.side !== "SHORT") return null;
  if (!Number.isFinite(plan.entryPrice) || !Number.isFinite(plan.stopPrice) || !Number.isFinite(plan.takeProfitPrice)) return null;
  return {
    scanGroupKey,
    symbol,
    sourceDataTimestamp: sourceTimestamp,
    score,
    candidate,
    plan,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function numberValue(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
