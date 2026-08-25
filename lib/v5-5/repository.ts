import type { SupabaseClient } from "@supabase/supabase-js";
import type { V55UniverseSnapshot } from "./universe";
import type { V55RuntimeContext, V55Evaluation } from "./runtime";
import { hashToUuid } from "./canonical";
import { V55_STRATEGY_VERSION } from "./manifest";
import type { V55ForwardTradeRow } from "./evaluator";

export interface V55PersistSummary {
  snapshotsWritten: number;
  idempotentSnapshots: number;
  shadowTradesWritten: number;
  errors: Array<{ symbol: string; stage: string; message: string }>;
}

export type V55PersistenceStatus = "CREATED" | "IDEMPOTENT_EXISTING";

export interface V55UniversePersistResult {
  snapshotId: string;
  status: V55PersistenceStatus;
}

export interface V55SnapshotPersistResult {
  snapshotId: string;
  status: V55PersistenceStatus;
}

interface V55ForwardExperimentRow {
  experiment_id: string;
  strategy_version: string;
  strategy_manifest_hash: string;
  forward_start_timestamp: string;
  runtime_commit_sha: string;
  status: "PLANNED" | "ACTIVE" | "STOPPED";
}

export async function persistV55UniverseSnapshot(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  snapshot: V55UniverseSnapshot,
): Promise<V55UniversePersistResult> {
  await ensureV55ForwardExperiment(supabase, context);
  const payload = {
    scan_id: context.scanId,
    scan_group_key: context.scanGroupKey,
    experiment_id: context.experimentId,
    scan_timestamp: snapshot.scanTimestamp,
    snapshot_json: snapshot,
    snapshot_hash: snapshot.snapshotHash,
  };
  const inserted = await supabase
    .from("bca_v55_universe_snapshots")
    .insert(payload)
    .select("snapshot_id, snapshot_hash")
    .maybeSingle();
  if (!inserted.error && inserted.data?.snapshot_id) {
    return { snapshotId: String(inserted.data.snapshot_id), status: "CREATED" };
  }
  if (inserted.error?.code === "23505") {
    const existing = await supabase
      .from("bca_v55_universe_snapshots")
      .select("snapshot_id, snapshot_hash")
      .eq("experiment_id", context.experimentId)
      .eq("scan_id", context.scanId)
      .maybeSingle();
    if (existing.error) throw new Error(`V5.5 universe idempotency lookup failed: ${existing.error.message}`);
    if (existing.data?.snapshot_id) {
      if (existing.data.snapshot_hash !== snapshot.snapshotHash) {
        throw new Error("V5.5 universe snapshot identity collision has different content");
      }
      return { snapshotId: String(existing.data.snapshot_id), status: "IDEMPOTENT_EXISTING" };
    }
  }
  throw new Error(`V5.5 universe snapshot write failed: ${inserted.error?.message ?? "empty response"}`);
}

export async function persistV55ShadowEvidence(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  evaluations: V55Evaluation[],
): Promise<V55PersistSummary> {
  const summary: V55PersistSummary = { snapshotsWritten: 0, idempotentSnapshots: 0, shadowTradesWritten: 0, errors: [] };
  for (const evaluation of evaluations) {
    const symbol = evaluation.snapshot.instrument.symbol;
    try {
      const persistedSnapshot = await persistV55Snapshot(supabase, context, evaluation);
      if (persistedSnapshot.status === "CREATED") summary.snapshotsWritten += 1;
      else summary.idempotentSnapshots += 1;
      if (evaluation.finalEligible && evaluation.tradePlan && evaluation.shadowSignalId) {
        const created = await persistShadowTrade(supabase, context, evaluation, persistedSnapshot.snapshotId);
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

export async function persistV55Snapshot(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
  evaluation: V55Evaluation,
): Promise<V55SnapshotPersistResult> {
  const snapshot = evaluation.snapshot;
  if (!context.universeSnapshotId) {
    throw new Error("V5.5 universe snapshot reference is required before feature evidence write");
  }
  if (snapshot.provenance.universeSnapshotHash !== context.universeSnapshotHash) {
    throw new Error("V5.5 universe snapshot reference hash does not match feature provenance");
  }
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
    universe_snapshot_id: context.universeSnapshotId,
    universe_snapshot_hash: snapshot.provenance.universeSnapshotHash,
    source_data_timestamp: snapshot.sourceDataTimestamp,
    decision_status: snapshot.decision.finalEligible ? "FINAL_ELIGIBLE" : snapshot.decision.rawTrigger ? "REJECTED" : "RAW_TRIGGER_FALSE",
    raw_trigger: snapshot.decision.rawTrigger,
    snapshot_json: snapshot,
    snapshot_hash: snapshot.provenance.snapshotHash,
  }).select("snapshot_id").maybeSingle();
  if (!error && data?.snapshot_id) return { snapshotId: String(data.snapshot_id), status: "CREATED" };
  if (error?.code === "23505") {
    const existing = await supabase
      .from("bca_v55_signal_feature_snapshots")
      .select("snapshot_id")
      .eq("snapshot_id", snapshot.snapshotId)
      .eq("experiment_id", context.experimentId)
      .eq("strategy_version", snapshot.strategy.strategyVersion)
      .eq("symbol", snapshot.instrument.symbol)
      .eq("source_data_timestamp", snapshot.sourceDataTimestamp)
      .maybeSingle();
    if (!existing.error && existing.data?.snapshot_id) {
      return { snapshotId: String(existing.data.snapshot_id), status: "IDEMPOTENT_EXISTING" };
    }
    const naturalExisting = await supabase
      .from("bca_v55_signal_feature_snapshots")
      .select("snapshot_id")
      .eq("experiment_id", context.experimentId)
      .eq("strategy_version", snapshot.strategy.strategyVersion)
      .eq("symbol", snapshot.instrument.symbol)
      .eq("source_data_timestamp", snapshot.sourceDataTimestamp)
      .maybeSingle();
    if (naturalExisting.error) throw new Error(`V5.5 snapshot natural-key lookup failed: ${naturalExisting.error.message}`);
    if (naturalExisting.data?.snapshot_id) {
      return { snapshotId: String(naturalExisting.data.snapshot_id), status: "IDEMPOTENT_EXISTING" };
    }
  }
  throw new Error(`V5.5 snapshot write failed: ${error?.message ?? "empty response"}`);
}

async function ensureV55ForwardExperiment(
  supabase: SupabaseClient,
  context: V55RuntimeContext,
): Promise<V55ForwardExperimentRow> {
  const payload = {
    experiment_id: context.experimentId,
    strategy_version: V55_STRATEGY_VERSION,
    strategy_manifest_hash: context.strategyManifestHash,
    forward_start_timestamp: new Date(context.forwardStartTimestamp).toISOString(),
    runtime_commit_sha: context.runtimeCommitSha,
    status: "ACTIVE" as const,
  };
  const inserted = await supabase
    .from("bca_v55_forward_experiments")
    .insert(payload)
    .select("experiment_id, strategy_version, strategy_manifest_hash, forward_start_timestamp, runtime_commit_sha, status")
    .maybeSingle();
  if (!inserted.error && inserted.data?.experiment_id) return inserted.data as V55ForwardExperimentRow;
  if (inserted.error?.code !== "23505") {
    throw new Error(`V5.5 forward experiment write failed: ${inserted.error?.message ?? "empty response"}`);
  }

  const existing = await supabase
    .from("bca_v55_forward_experiments")
    .select("experiment_id, strategy_version, strategy_manifest_hash, forward_start_timestamp, runtime_commit_sha, status")
    .eq("experiment_id", context.experimentId)
    .maybeSingle();
  if (existing.error) throw new Error(`V5.5 forward experiment lookup failed: ${existing.error.message}`);
  if (!existing.data?.experiment_id) throw new Error("V5.5 forward experiment conflict could not be resolved");
  const row = existing.data as V55ForwardExperimentRow;
  const identityMatches = row.experiment_id === context.experimentId
    && row.strategy_version === V55_STRATEGY_VERSION
    && row.strategy_manifest_hash === context.strategyManifestHash
    && Date.parse(row.forward_start_timestamp) === context.forwardStartTimestamp
    && row.runtime_commit_sha === context.runtimeCommitSha;
  if (!identityMatches) throw new Error("V5.5 forward experiment identity mismatch; evidence write failed closed");
  if (row.status === "STOPPED") throw new Error("V5.5 forward experiment is STOPPED; evidence write failed closed");
  return row;
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
