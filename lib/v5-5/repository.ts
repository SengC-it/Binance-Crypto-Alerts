import type { SupabaseClient } from "@supabase/supabase-js";
import type { V55UniverseSnapshot } from "./universe";
import type { V55RuntimeContext, V55Evaluation } from "./runtime";
import { hashToUuid } from "./canonical";
import { V55_STRATEGY_VERSION } from "./manifest";
import type { V55ForwardTradeRow } from "./evaluator";

export interface V55PersistSummary {
  snapshotsWritten: number;
  shadowTradesWritten: number;
  errors: Array<{ symbol: string; stage: string; message: string }>;
}

export async function persistV55UniverseSnapshot(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  snapshot: V55UniverseSnapshot,
): Promise<void> {
  const { error: experimentError } = await supabase.from("bca_v55_forward_experiments").upsert({
    experiment_id: context.experimentId,
    strategy_version: V55_STRATEGY_VERSION,
    strategy_manifest_hash: context.strategyManifestHash,
    forward_start_timestamp: new Date(context.forwardStartTimestamp).toISOString(),
    runtime_commit_sha: context.runtimeCommitSha,
    status: "ACTIVE",
  }, { onConflict: "experiment_id" });
  if (experimentError) throw new Error(`V5.5 forward experiment write failed: ${experimentError.message}`);
  const { error } = await supabase.from("bca_v55_universe_snapshots").upsert({
    scan_id: context.scanId,
    scan_group_key: context.scanGroupKey,
    experiment_id: context.experimentId,
    scan_timestamp: snapshot.scanTimestamp,
    snapshot_json: snapshot,
    snapshot_hash: snapshot.snapshotHash,
  }, { onConflict: "experiment_id,scan_group_key" });
  if (error) throw new Error(`V5.5 universe snapshot write failed: ${error.message}`);
}

export async function persistV55ShadowEvidence(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  evaluations: V55Evaluation[],
): Promise<V55PersistSummary> {
  const summary: V55PersistSummary = { snapshotsWritten: 0, shadowTradesWritten: 0, errors: [] };
  for (const evaluation of evaluations) {
    const symbol = evaluation.snapshot.instrument.symbol;
    try {
      const snapshotId = await persistSnapshot(supabase, context, evaluation);
      summary.snapshotsWritten += 1;
      if (evaluation.finalEligible && evaluation.tradePlan && evaluation.shadowSignalId) {
        const created = await persistShadowTrade(supabase, context, evaluation, snapshotId);
        if (created) summary.shadowTradesWritten += 1;
      }
    } catch (error) {
      summary.errors.push({ symbol, stage: "v55_shadow_evidence", message: errorMessage(error) });
    }
  }
  return summary;
}

export async function loadV55ForwardRows(
  supabase: SupabaseClient,
  context: Pick<V55RuntimeContext, "experimentId" | "forwardStartTimestamp">,
): Promise<V55ForwardTradeRow[]> {
  const { data, error } = await supabase
    .from("bca_shadow_paper_trades")
    .select("id, strategy_version, forward_experiment_id, source_data_timestamp, entry_time, exit_time, status, symbol, r_multiple, net_pnl_usdt, fees_usdt, funding_usdt, slippage_usdt, metadata")
    .eq("strategy_version", V55_STRATEGY_VERSION)
    .eq("forward_experiment_id", context.experimentId)
    .gte("source_data_timestamp", new Date(context.forwardStartTimestamp).toISOString())
    .order("source_data_timestamp", { ascending: true });
  if (error) throw new Error(`V5.5 forward evidence lookup failed: ${error.message}`);
  return (data ?? []) as V55ForwardTradeRow[];
}

async function persistSnapshot(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  evaluation: V55Evaluation,
): Promise<string> {
  const snapshot = evaluation.snapshot;
  const { data, error } = await supabase.from("bca_v55_signal_feature_snapshots").insert({
    snapshot_id: snapshot.snapshotId,
    scan_id: context.scanId,
    signal_id: snapshot.signalId,
    shadow_signal_id: snapshot.shadowSignalId,
    experiment_id: context.experimentId,
    strategy_version: snapshot.strategy.strategyVersion,
    strategy_manifest_hash: snapshot.strategy.manifestHash,
    symbol: snapshot.instrument.symbol,
    side: snapshot.strategy.side,
    source_data_timestamp: snapshot.sourceDataTimestamp,
    decision_status: snapshot.decision.finalEligible ? "FINAL_ELIGIBLE" : snapshot.decision.rawTrigger ? "REJECTED" : "RAW_TRIGGER_FALSE",
    raw_trigger: snapshot.decision.rawTrigger,
    snapshot_json: snapshot,
    snapshot_hash: snapshot.provenance.snapshotHash,
  }).select("snapshot_id").maybeSingle();
  if (!error && data?.snapshot_id) return data.snapshot_id as string;
  if (error?.code === "23505") {
    const existing = await supabase
      .from("bca_v55_signal_feature_snapshots")
      .select("snapshot_id")
      .eq("snapshot_id", snapshot.snapshotId)
      .maybeSingle();
    if (existing.error) throw new Error(`V5.5 snapshot idempotency lookup failed: ${existing.error.message}`);
    if (existing.data?.snapshot_id) return existing.data.snapshot_id as string;
  }
  throw new Error(`V5.5 snapshot write failed: ${error?.message ?? "empty response"}`);
}

async function persistShadowTrade(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  evaluation: V55Evaluation,
  snapshotId: string,
): Promise<boolean> {
  const snapshot = evaluation.snapshot;
  const plan = evaluation.tradePlan!;
  const idempotencyKey = `${snapshot.strategy.strategyVersion}|${snapshot.instrument.symbol}|${snapshot.sourceDataTimestamp}`;
  const direction = -1;
  const entryFillPrice = plan.entryPrice * (1 + direction * 2 / 10_000);
  const { data, error } = await supabase.from("bca_shadow_paper_trades").insert({
    id: hashToUuid(idempotencyKey),
    symbol: snapshot.instrument.symbol,
    side: "SHORT",
    strategy_family: "FAILED_BREAKOUT_SHORT",
    strategy_version: snapshot.strategy.strategyVersion,
    entry_time: snapshot.sourceDataTimestamp,
    entry_price: plan.entryPrice,
    entry_fill_price: entryFillPrice,
    stop_price: plan.stopPrice,
    take_profit_price: plan.takeProfitPrice,
    max_hold_until: new Date(plan.validUntil).toISOString(),
    quantity: plan.quantity,
    assumed_margin_usdt: plan.assumedMarginUsdt,
    assumed_leverage: plan.assumedLeverage,
    position_notional_usdt: plan.positionNotionalUsdt,
    theoretical_risk_usdt: plan.theoreticalRiskUsdt,
    last_price: entryFillPrice,
    metadata: {
      provenance: "PROSPECTIVE_FORWARD",
      v55: true,
      snapshot_id: snapshotId,
      forward_experiment_id: context.experimentId,
      strategy_manifest_hash: snapshot.strategy.manifestHash,
      source_data_timestamp: snapshot.sourceDataTimestamp,
      runtime_commit_sha: context.runtimeCommitSha,
      universe_snapshot_hash: context.universeSnapshotHash,
      idempotency_key: idempotencyKey,
      entry_evidence_hash: snapshot.provenance.snapshotHash,
    },
    v55_snapshot_id: snapshotId,
    forward_experiment_id: context.experimentId,
    strategy_manifest_hash: snapshot.strategy.manifestHash,
    source_data_timestamp: snapshot.sourceDataTimestamp,
    v55_idempotency_key: idempotencyKey,
  }).select("id").maybeSingle();
  if (error?.code === "23505") return false;
  if (error || !data) throw new Error(`V5.5 shadow trade write failed: ${error?.message ?? "empty response"}`);
  return true;
}

export function v55WarningEvent(summary: V55PersistSummary): {
  eventType: "WARNING";
  severity: "WARNING";
  component: "v5_5_forward_shadow";
  message: string;
  details: V55PersistSummary;
} | null {
  if (summary.errors.length === 0) return null;
  return {
    eventType: "WARNING",
    severity: "WARNING",
    component: "v5_5_forward_shadow",
    message: "V5.5 Shadow evidence was fail-closed for one or more symbols; Production scan continued.",
    details: summary,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
