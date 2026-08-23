import type { ScoredCandidate, TradePlan } from "@/lib/core/types";
import type { SignalAdmissionDecision } from "@/lib/core/signal-admission";
import type { V5Policy } from "@/lib/core/policy-registry";
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
  admission?: SignalAdmissionDecision;
}

export interface ClaimResult {
  status: "CREATED" | "REPLACED" | "IDEMPOTENT" | "REJECTED_LOWER_SCORE" | "BUDGET_BLOCKED" | "PORTFOLIO_BLOCKED" | "COOLDOWN_BLOCKED";
  signal_id?: string;
  email_allowed: boolean;
  risk_delta_usdt?: number;
}

export interface StagedOpportunity {
  scanRunId: string;
  scanGroupKey: string;
  symbol: string;
  sourceTimestamp: number;
  candidate: ScoredCandidate;
  plan: TradePlan;
  admission?: SignalAdmissionDecision;
}

export async function loadApprovedPolicy(
  supabase: SupabaseClient,
  requestedVersion?: string,
): Promise<V5Policy | undefined> {
  let query = supabase
    .from("bca_policy_registry")
    .select("*")
    .eq("status", "APPROVED")
    .order("approved_at", { ascending: false })
    .limit(1);
  if (requestedVersion) query = query.eq("policy_version", requestedVersion);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Supabase approved policy lookup failed: ${error.message}`);
  if (!data) return undefined;
  return {
    policyVersion: data.policy_version as string,
    strategyParams: data.strategy_params,
    supportedDirections: data.supported_directions,
    directionApproval: data.direction_approval,
    entryPolicy: data.entry_policy,
    regimePolicy: data.regime_policy,
    noChasePolicy: data.no_chase_policy,
    universePolicy: data.universe_policy,
    calibrationModel: data.calibration_model,
    expectedEdgeModel: data.expected_edge_model,
    costModelVersion: data.cost_model_version as string,
    trainWindow: data.train_window,
    validationWindow: data.validation_window,
    holdoutWindow: data.holdout_window,
    validationMetrics: data.validation_metrics,
    createdAt: data.created_at as string,
    approvedAt: data.approved_at as string | undefined,
    status: data.status,
  };
}

export async function upsertInstruments(supabase: SupabaseClient, instruments: unknown[]) {
  const { error } = await supabase.from("bca_instruments").upsert(instruments, { onConflict: "symbol" });
  if (error) throw new Error(`Supabase instrument upsert failed: ${error.message}`);
}

export async function createScanRun(supabase: SupabaseClient, input: ScanRunInput): Promise<string> {
  const { error: groupError } = await supabase.from("bca_scan_groups").upsert({
    scan_group_key: input.scanGroupKey,
    batch_count: input.batchCount,
  }, { onConflict: "scan_group_key", ignoreDuplicates: true });
  if (groupError) throw new Error(`Supabase scan group creation failed: ${groupError.message}`);

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

export async function stageScanCandidates(
  supabase: SupabaseClient,
  opportunities: StagedOpportunity[],
): Promise<void> {
  if (opportunities.length === 0) return;
  const { error } = await supabase.from("bca_scan_candidates").upsert(opportunities.map((item) => ({
    scan_group_key: item.scanGroupKey,
    scan_run_id: item.scanRunId,
    symbol: item.symbol,
    source_data_timestamp: new Date(item.sourceTimestamp).toISOString(),
    score: item.candidate.score,
    candidate: { ...item.candidate, admission: item.admission },
    trade_plan: item.plan,
  })), { onConflict: "scan_group_key,symbol" });
  if (error) throw new Error(`Supabase candidate staging failed: ${error.message}`);
}

export async function stageShadowCandidates(
  supabase: SupabaseClient,
  opportunities: StagedOpportunity[],
): Promise<void> {
  if (opportunities.length === 0) return;
  const { error } = await supabase.from("bca_shadow_candidates").upsert(opportunities.map((item) => ({
    scan_group_key: item.scanGroupKey,
    scan_run_id: item.scanRunId,
    symbol: item.symbol,
    source_data_timestamp: new Date(item.sourceTimestamp).toISOString(),
    score: item.candidate.score,
    policy_version: item.admission?.policyVersion ?? null,
    signal_tier: item.admission?.tier ?? null,
    expected_net_r: item.admission?.expectedNetR ?? null,
    rejection_reason: item.admission?.reasons[0] ?? null,
    candidate: { ...item.candidate, admission: item.admission },
    trade_plan: item.plan,
  })), { onConflict: "scan_group_key,symbol" });
  if (error) throw new Error(`Supabase shadow candidate staging failed: ${error.message}`);
}

export async function tryStartScanGroupFinalization(
  supabase: SupabaseClient,
  scanGroupKey: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("bca_try_finalize_scan_group", {
    p_scan_group_key: scanGroupKey,
  });
  if (error) throw new Error(`Supabase scan finalization claim failed: ${error.message}`);
  return data === true;
}

export async function listStagedCandidates(
  supabase: SupabaseClient,
  scanGroupKey: string,
): Promise<StagedOpportunity[]> {
  const { data, error } = await supabase
    .from("bca_scan_candidates")
    .select("scan_run_id, scan_group_key, symbol, source_data_timestamp, candidate, trade_plan")
    .eq("scan_group_key", scanGroupKey)
    .order("score", { ascending: false })
    .order("symbol", { ascending: true });
  if (error) throw new Error(`Supabase staged candidate lookup failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    scanRunId: row.scan_run_id as string,
    scanGroupKey: row.scan_group_key as string,
    symbol: row.symbol as string,
    sourceTimestamp: Date.parse(row.source_data_timestamp as string),
    candidate: row.candidate as ScoredCandidate,
    plan: row.trade_plan as TradePlan,
    admission: (row.candidate as { admission?: SignalAdmissionDecision }).admission,
  }));
}

export async function listStagedShadowCandidates(
  supabase: SupabaseClient,
  scanGroupKey: string,
): Promise<StagedOpportunity[]> {
  const { data, error } = await supabase
    .from("bca_shadow_candidates")
    .select("scan_run_id, scan_group_key, symbol, source_data_timestamp, candidate, trade_plan")
    .eq("scan_group_key", scanGroupKey)
    .order("score", { ascending: false })
    .order("symbol", { ascending: true });
  if (error) throw new Error(`Supabase shadow candidate lookup failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    scanRunId: row.scan_run_id as string,
    scanGroupKey: row.scan_group_key as string,
    symbol: row.symbol as string,
    sourceTimestamp: Date.parse(row.source_data_timestamp as string),
    candidate: row.candidate as ScoredCandidate,
    plan: row.trade_plan as TradePlan,
    admission: (row.candidate as { admission?: SignalAdmissionDecision }).admission,
  }));
}

export async function finishScanGroup(
  supabase: SupabaseClient,
  scanGroupKey: string,
  status: "COMPLETED" | "FAILED",
  errorSummary: unknown[] = [],
): Promise<void> {
  const { error } = await supabase.from("bca_scan_groups").update({
    status,
    error_summary: errorSummary,
    finished_at: new Date().toISOString(),
  }).eq("scan_group_key", scanGroupKey);
  if (error) throw new Error(`Supabase scan group completion failed: ${error.message}`);
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
    signalStats?: Record<string, number>;
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
      signal_stats: patch.signalStats ?? {},
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
    maxConcurrentPositions: number;
    cooldownHours: number;
    takerFeeRate: number;
    slippageBps: number;
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
      signal_tier: input.admission?.tier ?? null,
      policy_version: input.admission?.policyVersion ?? input.strategyVersion,
      expected_net_r: input.admission?.expectedNetR ?? null,
      confidence: input.admission?.confidence ?? null,
      calibration_samples: input.admission?.calibrationSamples ?? null,
      rejection_reason: input.admission?.reasons[0] ?? null,
      entry_trigger: input.candidate.entryTrigger ?? "NONE",
      setup_type: input.candidate.setupType ?? "NO_SETUP",
      market_state: input.candidate.marketState ?? "UNKNOWN",
    },
    p_budget_date: policy.dailyDate,
    p_daily_limit_usdt: policy.dailyLimitUsdt,
    p_single_risk_cap_usdt: policy.singleRiskCapUsdt,
    p_daily_email_cap: policy.dailyEmailCap,
      p_should_email: policy.shouldEmail,
      p_scan_group_key: input.scanGroupKey,
      p_scan_email_cap: policy.scanEmailCap,
      p_max_concurrent_positions: policy.maxConcurrentPositions,
      p_cooldown_hours: policy.cooldownHours,
      p_taker_fee_rate: policy.takerFeeRate,
      p_slippage_bps: policy.slippageBps,
  });
  if (error || !data) throw new Error(`Supabase signal claim failed: ${error?.message ?? "empty response"}`);
  const result = data as ClaimResult;
  if (result.signal_id && input.admission) {
    const { error: metadataError } = await supabase
      .from("bca_signals")
      .update({
        signal_tier: input.admission.tier,
        policy_version: input.admission.policyVersion ?? input.strategyVersion,
        market_state: input.candidate.marketState ?? "UNKNOWN",
        setup_type: input.candidate.setupType ?? "NO_SETUP",
        entry_trigger: input.candidate.entryTrigger ?? "NONE",
        expected_net_r: input.admission.expectedNetR,
        confidence: input.admission.confidence,
        calibration_samples: input.admission.calibrationSamples,
        rejection_reason: input.admission.reasons[0] ?? null,
      })
      .eq("id", result.signal_id);
    if (metadataError) throw new Error(`Supabase signal metadata update failed: ${metadataError.message}`);
  }
  return result;
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
