import type { ScoredCandidate, TradePlan } from "@/lib/core/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ScanRunInput {
  runKey: string;
  scanGroupKey: string;
  timeframe: string;
  batchNumber: number;
  batchCount: number;
  universeSize: number;
}

export interface SignalClaimInput {
  scanRunId?: string;
  scanGroupKey: string;
  signalKey: string;
  symbol: string;
  candidate: ScoredCandidate;
  plan: TradePlan;
  strategyVersion: string;
  sourceTimestamp: number;
  occurrenceDate: string;
}

export interface ClaimResult {
  status: "CREATED" | "REPLACED" | "IDEMPOTENT" | "REJECTED_LOWER_SCORE" | "BUDGET_BLOCKED";
  signal_id: string;
  email_allowed: boolean;
  risk_delta_usdt?: number;
}

export async function upsertInstruments(supabase: SupabaseClient, instruments: unknown[]) {
  const { error } = await supabase.from("bca_instruments").upsert(instruments, { onConflict: "symbol" });
  if (error) throw new Error(`Supabase instrument upsert failed: ${error.message}`);
}

export async function createScanRun(supabase: SupabaseClient, input: ScanRunInput): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("bca_scan_runs")
    .select("id")
    .eq("run_key", input.runKey)
    .maybeSingle();
  if (existingError) throw new Error(`Supabase scan lookup failed: ${existingError.message}`);
  if (existing?.id) return existing.id as string;

  const { data, error } = await supabase
    .from("bca_scan_runs")
    .insert({
      run_key: input.runKey,
      scan_group_key: input.scanGroupKey,
      timeframe: input.timeframe,
      batch_number: input.batchNumber,
      batch_count: input.batchCount,
      universe_size: input.universeSize,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Supabase scan creation failed: ${error?.message ?? "empty response"}`);
  return data.id as string;
}

export async function completeScanRun(
  supabase: SupabaseClient,
  scanRunId: string,
  patch: {
    scannedSymbols: number;
    candidateCount: number;
    emailedCount: number;
    status: "COMPLETED" | "PARTIAL" | "FAILED";
    errorSummary: unknown[];
  },
) {
  const { error } = await supabase
    .from("bca_scan_runs")
    .update({
      scanned_symbols: patch.scannedSymbols,
      candidate_count: patch.candidateCount,
      emailed_count: patch.emailedCount,
      status: patch.status,
      error_summary: patch.errorSummary,
      finished_at: new Date().toISOString(),
    })
    .eq("id", scanRunId);
  if (error) throw new Error(`Supabase scan completion failed: ${error.message}`);
}

export async function claimSignal(
  supabase: SupabaseClient,
  input: SignalClaimInput,
  policy: {
    dailyDate: string;
    dailyLimitUsdt: number;
    singleRiskCapUsdt: number;
    dailyEmailCap: number;
    scanEmailCap: number;
    shouldEmail: boolean;
  },
): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc("bca_claim_signal", {
    p_signal: {
      scan_run_id: input.scanRunId ?? null,
      signal_key: input.signalKey,
      symbol: input.symbol,
      side: input.candidate.side,
      primary_timeframe: input.candidate.primaryTimeframe,
      confirmation_timeframes: input.candidate.confirmationTimeframes,
      strategy_family: input.candidate.strategyFamily,
      strategy_version: input.strategyVersion,
      score: input.candidate.score,
      score_components: input.candidate.scoreComponents,
      market_regime: input.candidate.marketRegime,
      regime_dependency: input.candidate.regimeDependency,
      entry_price: input.plan.entryPrice,
      stop_price: input.plan.stopPrice,
      take_profit_price: input.plan.takeProfitPrice,
      reward_risk: input.plan.rewardRisk,
      assumed_margin_usdt: input.plan.assumedMarginUsdt,
      assumed_leverage: input.plan.assumedLeverage,
      position_notional_usdt: input.plan.positionNotionalUsdt,
      theoretical_risk_usdt: input.plan.theoreticalRiskUsdt,
      valid_until: new Date(input.plan.validUntil).toISOString(),
      source_data_timestamp: new Date(input.sourceTimestamp).toISOString(),
      occurrence_date: input.occurrenceDate,
    },
    p_budget_date: policy.dailyDate,
    p_daily_limit_usdt: policy.dailyLimitUsdt,
    p_single_risk_cap_usdt: policy.singleRiskCapUsdt,
    p_daily_email_cap: policy.dailyEmailCap,
      p_should_email: policy.shouldEmail,
      p_scan_group_key: input.scanGroupKey,
      p_scan_email_cap: policy.scanEmailCap,
  });
  if (error || !data) throw new Error(`Supabase signal claim failed: ${error?.message ?? "empty response"}`);
  return data as ClaimResult;
}

export async function createNotification(
  supabase: SupabaseClient,
  input: { signalId: string; idempotencyKey: string; recipient: string; subject: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("bca_notifications")
    .insert({
      signal_id: input.signalId,
      idempotency_key: input.idempotencyKey,
      recipient: input.recipient,
      subject: input.subject,
      status: "PENDING",
    })
    .select("id")
    .maybeSingle();

  if (!error) return Boolean(data?.id);
  if (error.code === "23505") return false;
  throw new Error(`Supabase notification creation failed: ${error.message}`);
}

export async function finishNotification(
  supabase: SupabaseClient,
  idempotencyKey: string,
  patch: { status: "SENT" | "FAILED" | "SKIPPED"; providerMessageId?: string; error?: string },
) {
  const { error } = await supabase
    .from("bca_notifications")
    .update({
      status: patch.status,
      provider_message_id: patch.providerMessageId,
      last_error: patch.error,
      sent_at: patch.status === "SENT" ? new Date().toISOString() : null,
      attempts: 1,
    })
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new Error(`Supabase notification update failed: ${error.message}`);
}

export async function recordSystemEvent(
  supabase: SupabaseClient,
  event: {
    eventType: string;
    severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
    component: string;
    message: string;
    details?: unknown;
  },
) {
  const { error } = await supabase.from("bca_system_events").insert({
    event_type: event.eventType,
    severity: event.severity,
    component: event.component,
    message: event.message,
    details: event.details ?? {},
  });
  if (error) throw new Error(`Supabase system event failed: ${error.message}`);
}
