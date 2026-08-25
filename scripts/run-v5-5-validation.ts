import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateV55ForwardEvidence, V55_MIN_FORWARD_DAYS, V55_MIN_FORWARD_TRADES, V55_STRONG_FORWARD_DAYS, V55_STRONG_FORWARD_TRADES } from "@/lib/v5-5/evaluator";
import { getFrozenStrategy, V55_FORWARD_EXPERIMENT_ID, V55_STRATEGY_VERSION } from "@/lib/v5-5/manifest";
import { SignalFeatureSnapshotV2Schema } from "@/lib/v5-5/snapshot";

const REPORT_DIR = resolve("reports");
const MIGRATION = "supabase/migrations/20260825090000_v55_forward_shadow_evidence.sql";

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const frozen = getFrozenStrategy();
  const sourceSha = process.env.V55_SOURCE_SHA ?? "PENDING_CODE_COMMIT";
  const forwardGate = evaluateV55ForwardEvidence({
    rows: [],
    experimentId: V55_FORWARD_EXPERIMENT_ID,
    strategyVersion: V55_STRATEGY_VERSION,
    forwardStartTimestamp: Date.parse("2026-08-25T00:00:00.000Z"),
    asOfTimestamp: Date.parse("2026-08-25T00:00:00.000Z"),
    repetitions: 100,
  });
  if (forwardGate.status !== "INSUFFICIENT_FORWARD_EVIDENCE" || forwardGate.automaticPromotionAllowed) {
    throw new Error("V5.5 pre-rollout evaluator must be insufficient and promotion-disabled");
  }
  if (SignalFeatureSnapshotV2Schema.shape.schema.value !== "SignalFeatureSnapshotV2") {
    throw new Error("SignalFeatureSnapshotV2 schema identity drifted");
  }

  await writeJson("v5-5-strategy-manifest.json", {
    ...frozen.manifest,
    manifestHash: frozen.manifestHash,
    parameterDrift: "PASS",
    frozenCandidateId: frozen.definition.id,
    sourceResearchCheckpoint: "V5.4 / 3c66ab1e06642be0a785e59ea6df13b9da65bfdc",
  });
  await writeText("v5-5-evidence-schema.md", evidenceSchemaMarkdown(frozen.manifestHash));
  await writeJson("v5-5-rollout-manifest.json", {
    schemaVersion: "v5.5a-rollout-manifest-v1",
    sourceV55ASha: sourceSha,
    requiredFiles: [
      "app/api/scan/route.ts",
      "lib/binance/public-client.ts",
      "lib/binance/types.ts",
      "lib/config.ts",
      "lib/core/types.ts",
      "lib/v5-5/canonical.ts",
      "lib/v5-5/evaluator.ts",
      "lib/v5-5/manifest.ts",
      "lib/v5-5/repository.ts",
      "lib/v5-5/runtime.ts",
      "lib/v5-5/snapshot.ts",
      "lib/v5-5/universe.ts",
      "lib/v5-3/feature-snapshot.ts",
      "lib/v5-3/structural.ts",
    ],
    requiredMigration: MIGRATION,
    requiredEnvVars: [
      "BCA_V55_SHADOW_ENABLED=false until independent V5.5B approval",
      "BCA_V55_FORWARD_EXPERIMENT_ID",
      "BCA_V55_FORWARD_START_TIMESTAMP",
      "BCA_V55_RUNTIME_COMMIT_SHA",
    ],
    requiredCronChanges: [
      "No new cron route; V5.5B must use the existing protected /api/scan and /api/paper/settle calls.",
    ],
    experimentIdentityImmutable: true,
    universeSnapshotsImmutable: true,
    duplicateCronIdempotent: true,
    featureSnapshotNaturalKey: "experiment_id|strategy_version|symbol|source_data_timestamp",
    forwardStartImmutable: true,
    runtimeShaPolicy: "one experiment ID maps to one approved runtime commit; a runtime commit change requires a new forward experiment version.",
    strategyManifestHash: frozen.manifestHash,
    expectedRuntimeBehavior: {
      shadowOnly: true,
      productionEmailPossible: false,
      productionStrategyAffected: false,
      productionHealthGateAffected: false,
      productionScanFailureOnShadowError: false,
      evidenceWriteOnShadowError: false,
      historicalBackfill: false,
      automaticPromotion: false,
    },
    rollbackProcedure: [
      "Set BCA_V55_SHADOW_ENABLED=false and redeploy the approved runtime.",
      "The existing Production strategy and paper path remain enabled and unchanged.",
      "Do not delete evidence rows; retain them for audit and mark the experiment STOPPED in a later approved operation.",
    ],
  });
  await writeText("v5-5-forward-gate.md", forwardGateMarkdown(forwardGate));
  await writeText("v5-5-executive-summary.md", executiveSummary(frozen.manifestHash, sourceSha, forwardGate.status));

  console.info(JSON.stringify({
    stage: "v5_5_validation_complete",
    strategyVersion: V55_STRATEGY_VERSION,
    manifestHash: frozen.manifestHash,
    parameterDrift: "PASS",
    forwardExperimentId: V55_FORWARD_EXPERIMENT_ID,
    forwardStartTimestamp: null,
    statusBeforeRollout: forwardGate.status,
    productionEmailPossible: false,
    automaticPromotion: false,
  }));
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(name: string, value: string): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), value, "utf8");
}

function evidenceSchemaMarkdown(manifestHash: string): string {
  return `# V5.5A Evidence Schema\n\n- Schema: \`SignalFeatureSnapshotV2\`\n- Strategy manifest hash: \`${manifestHash}\`\n- Snapshot rows are insert-only and carry a deterministic \`snapshotHash\`.\n- Universe snapshots are insert-only per \`(experiment_id, scan_id)\`; \`scan_group_key\` is grouping metadata, not identity.\n- Each feature snapshot stores \`universeSnapshotId\` and \`universeSnapshotHash\`; the database requires the ID/hash pair to resolve to the immutable universe row.\n- The feature natural key is \`(experiment_id, strategy_version, symbol, source_data_timestamp)\`; duplicate cron writes return the existing snapshot.\n- Captured inputs: scan/source timestamps, 15m/1h/4h close times, symbol status, quote volume, exchange filters, candle counts/timestamps/hashes, feature values, raw trigger, rejection reasons, decision flags, trade plan, cost assumptions, runtime SHA, and manifest hash.\n- Snapshot serializer is allow-listed. API secrets, SMTP passwords, Supabase keys, CRON secrets, authorization headers, and private Binance credentials are rejected from the persisted shape.\n- V5.5 shadow trades reuse \`public.bca_shadow_paper_trades\` with additive provenance columns. Entry-side fields are immutable after creation; settlement fields remain mutable only for the existing settlement lifecycle.\n- Legacy shadow rows are not forward evidence.\n`;
}

function forwardGateMarkdown(evidence: ReturnType<typeof evaluateV55ForwardEvidence>): string {
  return `# V5.5A Forward Evidence Gate\n\n- Experiment: \`${evidence.experimentId}\`\n- Strategy: \`${evidence.strategyVersion}\`\n- Forward start: NOT STARTED; no historical row is backfilled.\n- Current status: \`${evidence.status}\`\n- Settled forward trades: \`${evidence.settledTrades}\`\n- Minimum observation target: \`>= ${V55_MIN_FORWARD_TRADES} settled trades and >= ${V55_MIN_FORWARD_DAYS} calendar days\`\n- Strong evidence target: \`>= ${V55_STRONG_FORWARD_TRADES} settled trades and >= ${V55_STRONG_FORWARD_DAYS} calendar days\`\n- Automatic promotion: **NO**. \`PRODUCTION_EMAIL_ELIGIBLE\` is not an allowed V5.5A status.\n- Historical OOS, frozen holdout, legacy shadow, and V5.5 forward shadow must remain separate in all reports.\n`;
}

function executiveSummary(manifestHash: string, sourceSha: string, status: string): string {
  return `# V5.5A Executive Summary\n\n1. Frozen strategy hash: \`${manifestHash}\` for \`${V55_STRATEGY_VERSION}\`.\n2. Production email protection: V5.5A writes only to the isolated Shadow evidence path; it never calls the Production claim/email path and the feature flag defaults to \`false\`.\n3. Forward evidence start: the first approved rollout timestamp, supplied as \`BCA_V55_FORWARD_START_TIMESTAMP\`; current status is **NOT STARTED** and no backfill is allowed.\n4. Point-in-time inputs: universe membership and exclusion reasons, contract status, quote volume, exchange filters, candle counts/timestamps/hashes, features, raw trigger/decision attrition, trade plan, costs, runtime SHA, and manifest hash.\n5. Deterministic replay: yes for the allow-listed snapshot payload and frozen manifest; replay still requires the recorded public candle inputs identified by their hashes.\n6. Missing evidence: no V5.5 prospective rows exist before rollout; at least ${V55_MIN_FORWARD_TRADES} settled trades over ${V55_MIN_FORWARD_DAYS} days are needed for the minimum observation target.\n7. V5.5B minimum rollout: selectively port the listed runtime files, apply the additive migration, set the forward experiment/start timestamp, keep \`BCA_V55_SHADOW_ENABLED=false\` until approval, then enable only through a separately reviewed Production change.\n\nSource code SHA recorded for this report: \`${sourceSha}\`.\nForward evaluator pre-rollout status: \`${status}\`.\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
