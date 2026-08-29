import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createLfvDataFreezeV2,
  type DataGateV2,
} from "./run-lfv-001-data-pipeline";
import {
  LFV_BASELINE_SHA,
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_LIVE_OBSERVATION_CUTOFF,
  LFV_SYSTEM_BOUNDARY,
} from "@/lib/lfv/loss-factors";
import { LFV_V4_PROVENANCE, LFV_TREND_PROVENANCE, LFV_LIVE_PARITY_THRESHOLDS } from "@/lib/lfv/provenance";
import {
  calculateObservedUniverseParity,
  type LiveParitySymbolInput,
  type ObservedProxyResultInput,
} from "@/lib/lfv/observed-parity";
import { sha256Text, stableStringify } from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = resolve("../../data/raw");
const ORIGINAL_FREEZE_COMMIT = "d68737cbd27c38e8fb09812ab225cfaaec56f037";
const ORIGINAL_FREEZE_SHA256 = "1bd06d9317203488eef599180f52dd66ecc1d15c87b6dca4ef382daf2dc901f9";
const REPLAY_FREEZE_NAME = "lfv-001-replay-freeze-v3.json";
const REQUIRED_REPORTS = [
  "lfv-001-freeze-manifest.json",
  "lfv-001-data-freeze-v2.json",
  "lfv-001-archive-registry.json",
  "lfv-001-pit-universe.json",
  "lfv-001-data-gate.json",
  REPLAY_FREEZE_NAME,
  "lfv-001-observed-universe-evidence-v1.json",
  "lfv-001-live-parity-input-v1.json",
  "lfv-001-universe-parity.json",
  "lfv-001-live-parity.json",
  "lfv-001-replay-parity.json",
  "lfv-001-factor-results.json",
  "lfv-001-combined-results.json",
  "lfv-001-holdouts.json",
  "lfv-001-decision.json",
  "lfv-001-decision.md",
];

type JsonObject = Record<string, unknown>;
type StopCode = "LFV_DATA_INSUFFICIENT_FINAL" | "LFV_UNIVERSE_PARITY_FAIL" | "V4_REPLAY_PROVENANCE_FAIL" | "LFV_REPLAY_PARITY_FAIL";

interface ProxyCacheFile {
  schema?: string;
  source?: string;
  interval?: string;
  capturedAt?: string;
  results?: ObservedProxyResultInput[];
}

async function readJson(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as JsonObject;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertOriginalFreeze(manifest: JsonObject): void {
  const { freezeSha256, ...core } = manifest;
  if (freezeSha256 !== ORIGINAL_FREEZE_SHA256 || freezeSha256 !== sha256Text(stableStringify(core))) {
    throw new Error("original LFV freeze manifest hash mismatch");
  }
  const baseline = core.baseline as { sha?: string } | undefined;
  if (baseline?.sha !== LFV_BASELINE_SHA) throw new Error("original LFV baseline mismatch");
}

async function readOriginalFreeze(): Promise<JsonObject> {
  const manifest = await readJson("lfv-001-freeze-manifest.json");
  assertOriginalFreeze(manifest);
  return manifest;
}

async function readDataFreeze(): Promise<JsonObject> {
  const freeze = await readJson("lfv-001-data-freeze-v2.json");
  const { freezeSha256, ...core } = freeze;
  if (freezeSha256 !== sha256Text(stableStringify(core))) throw new Error("LFV data freeze v2 hash mismatch");
  if (freeze.originalFreezeCommit !== ORIGINAL_FREEZE_COMMIT || freeze.originalFreezeSHA256 !== ORIGINAL_FREEZE_SHA256) {
    throw new Error("LFV data freeze v2 original freeze provenance mismatch");
  }
  if (freeze.returnsRead !== false) throw new Error("LFV data freeze v2 was created after returns were read");
  return freeze;
}

async function readFrozenDataGate(dataFreeze: JsonObject): Promise<DataGateV2> {
  const gate = await readJson("lfv-001-data-gate.json") as unknown as DataGateV2;
  if (gate.schema !== "bca-lfv-001-data-gate-v2" || gate.baseline !== LFV_BASELINE_SHA) {
    throw new Error("LFV data gate schema/baseline mismatch");
  }
  if (gate.status !== (gate.pass ? "PASS" : "FAIL") || gate.historicalReturnReplay !== "NOT_RUN") {
    throw new Error("LFV data gate status or returns boundary is inconsistent");
  }
  if (gate.archiveEnumeration.registrySha256 !== dataFreeze.archiveRegistryHash) {
    throw new Error("LFV data gate/archive registry provenance mismatch");
  }
  if (gate.liveObservations.count !== 44 || gate.liveObservations.treatment !== "EXCLUDED_FROM_RETURNS") {
    throw new Error("LFV live-observation boundary changed");
  }
  return gate;
}

async function readReplayFreeze(): Promise<JsonObject> {
  const freeze = await readJson(REPLAY_FREEZE_NAME);
  const freezeSha256 = freeze.freezeSha256;
  const core = Object.fromEntries(Object.entries(freeze).filter(([key]) => key !== "freezeSha256" && key !== "generatedAt"));
  if (freeze.schema !== "bca-lfv-001-replay-freeze-v3" || freeze.status !== "FROZEN_BEFORE_RETURN_READ") {
    throw new Error("LFV replay freeze v3 schema/status mismatch");
  }
  if (freezeSha256 !== sha256Text(stableStringify(core))) throw new Error("LFV replay freeze v3 hash mismatch");
  if (freeze.originalFreezeCommit !== ORIGINAL_FREEZE_COMMIT || freeze.originalFreezeSHA256 !== ORIGINAL_FREEZE_SHA256) {
    throw new Error("LFV replay freeze v3 original freeze provenance mismatch");
  }
  if (freeze.returnsRead !== false || (freeze.dataFreezeV2 as JsonObject | undefined)?.returnsRead !== false) {
    throw new Error("LFV replay freeze v3 returns-read boundary failed");
  }
  return freeze;
}

async function readOptionalCache(path: string, label: string): Promise<{ cache: ProxyCacheFile | null; evidence: JsonObject }> {
  try {
    const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const cache = JSON.parse(content) as ProxyCacheFile;
    if (!Array.isArray(cache.results)) throw new Error("results is not an array");
    return {
      cache,
      evidence: {
        path: label,
        bytes: metadata.size,
        sha256: sha256Text(content),
        schema: cache.schema ?? null,
        source: cache.source ?? null,
        interval: cache.interval ?? null,
        capturedAt: cache.capturedAt ?? null,
        resultCount: cache.results.length,
        errorCount: cache.results.filter((item) => Boolean(item.error)).length,
      },
    };
  } catch (error) {
    return {
      cache: null,
      evidence: {
        path: label,
        status: "NOT_AVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function emptyUniverseMetrics(reason: string): JsonObject {
  return {
    method: "ROLLING_15M_24H_VOLUME_PROXY",
    snapshotsCompared: 0,
    medianTop100Overlap: null,
    p10Top100Overlap: null,
    rankSpearman: null,
    signalInclusionRecall: null,
    comparisons: [],
    pass: false,
    reasons: [reason],
  };
}

async function writeUniverseParityReport(dataGatePass: boolean): Promise<JsonObject> {
  const observedPath = resolve(REPORT_DIR, "lfv-001-observed-universe-evidence-v1.json");
  const livePath = resolve(REPORT_DIR, "lfv-001-live-parity-input-v1.json");
  const observedContent = await readFile(observedPath, "utf8");
  const liveContent = await readFile(livePath, "utf8");
  const observed = JSON.parse(observedContent) as { groups: Parameters<typeof calculateObservedUniverseParity>[0]["groups"] };
  const live = JSON.parse(liveContent) as { rows: LiveParitySymbolInput[] };
  const initial = await readOptionalCache(
    resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m.json"),
    "data/raw/lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m.json",
  );
  const retry = await readOptionalCache(
    resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m_retry.json"),
    "data/raw/lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m_retry.json",
  );

  let status: "PASS" | "FAIL" | "NOT_RUN";
  let code: string | null;
  let reason: string;
  let metrics: JsonObject;
  let dataCoverage: JsonObject;
  if (!dataGatePass) {
    status = "NOT_RUN";
    code = null;
    reason = "Data Gate failed; universe parity was not evaluated and returns remain unread.";
    metrics = emptyUniverseMetrics(reason);
    dataCoverage = { observedGroups: observed.groups.length, observedSymbols: 0, completeSymbols: 0, incompleteSymbols: [], matchedSignalRows: 0 };
  } else if (!initial.cache?.results) {
    status = "FAIL";
    code = "LFV_UNIVERSE_PARITY_FAIL";
    reason = "Immutable observed-universe 15m proxy cache is unavailable or invalid.";
    metrics = emptyUniverseMetrics(reason);
    dataCoverage = { observedGroups: observed.groups.length, observedSymbols: 0, completeSymbols: 0, incompleteSymbols: [], matchedSignalRows: 0 };
  } else {
    const result = calculateObservedUniverseParity({
      groups: observed.groups,
      initialResults: initial.cache.results,
      retryResults: retry.cache?.results,
      liveRows: live.rows,
    });
    status = result.metrics.pass ? "PASS" : "FAIL";
    code = result.metrics.pass ? null : "LFV_UNIVERSE_PARITY_FAIL";
    reason = result.metrics.pass ? "PIT rolling-volume universe parity passed." : result.metrics.reasons.join("; ");
    metrics = { ...result.metrics };
    dataCoverage = result.dataCoverage;
  }
  const report = {
    schema: "bca-lfv-001-universe-parity-v2",
    generatedAt: new Date().toISOString(),
    status,
    code,
    reason,
    treatment: "OBSERVED_PRODUCTION_UNIVERSE_COMPARED_WITH_PIT_ROLLING_VOLUME_PROXY_ONLY",
    method: "ROLLING_15M_24H_VOLUME_PROXY",
    rules: {
      windowBars: 96,
      closedBarBoundary: "bar.closeTime < observed scan timestamp",
      selection: "rolling quote volume descending, symbol ascending; top min(100,N)",
      noCurrentTicker: true,
      noFutureData: true,
      noDailySnapshotSubstitution: true,
      noCurrentSurvivorFilter: true,
    },
    thresholds: { medianTop100Overlap: 0.95, p10Top100Overlap: 0.9, signalInclusionRecall: 0.98 },
    dataCoverage,
    metrics,
    caches: { initial: initial.evidence, retry: retry.evidence },
    sourceReports: {
      observed: { path: "reports/lfv-001-observed-universe-evidence-v1.json", sha256: sha256Text(observedContent) },
      live: { path: "reports/lfv-001-live-parity-input-v1.json", sha256: sha256Text(liveContent) },
    },
  } satisfies JsonObject;
  await writeJson("lfv-001-universe-parity.json", report);
  return report;
}

async function writeLiveParityReport(): Promise<JsonObject> {
  const report = {
    schema: "bca-lfv-001-live-parity-v2",
    generatedAt: new Date().toISOString(),
    status: "NOT_RUN",
    code: "LFV_REPLAY_PARITY_FAIL",
    returnsRead: false,
    observations: { count: 44, cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(), treatment: "LIVE_OBSERVATION_ONLY" },
    thresholds: LFV_LIVE_PARITY_THRESHOLDS,
    v4: LFV_V4_PROVENANCE,
    trend: LFV_TREND_PROVENANCE,
    reason: "Live observations are retained for parity only; historical returns are blocked until universe and runtime replay parity pass.",
  } satisfies JsonObject;
  await writeJson("lfv-001-live-parity.json", report);
  return report;
}

function notRunArtifact(name: string, code: StopCode, reason: string): JsonObject {
  return {
    schema: `bca-lfv-001-${name}-v3`,
    status: "NOT_RUN",
    code,
    reason,
    baseline: LFV_BASELINE_SHA,
    metrics: null,
    returnsRead: false,
    note: "No strategy returns were read after the mandatory data, universe, or provenance gate stopped the run; no missing value was imputed.",
  };
}

function stopReason(dataGate: DataGateV2, universe: JsonObject): { code: StopCode; reason: string } {
  if (!dataGate.pass) {
    return {
      code: "LFV_DATA_INSUFFICIENT_FINAL",
      reason: dataGate.reasons.join("; ") || "official historical archive gate failed",
    };
  }
  if (universe.status !== "PASS") {
    return {
      code: "LFV_UNIVERSE_PARITY_FAIL",
      reason: String(universe.reason ?? "PIT Production universe parity did not pass; historical returns remain unread."),
    };
  }
  if (String(LFV_V4_PROVENANCE.status) !== "RESTORED") {
    return {
      code: "V4_REPLAY_PROVENANCE_FAIL",
      reason: "V4 exact runtime configuration is not recoverable from immutable source/deployment evidence; returns must not be fitted from live trades.",
    };
  }
  return {
    code: "LFV_REPLAY_PARITY_FAIL",
    reason: "Data and provenance gates passed, but an independently frozen Production replay parity result is not available; historical returns remain unread.",
  };
}

async function writeStopArtifacts(
  dataGate: DataGateV2,
  dataFreeze: JsonObject,
  replayFreeze: JsonObject,
  universe: JsonObject,
  liveParity: JsonObject,
): Promise<void> {
  const { code, reason } = stopReason(dataGate, universe);
  const freezeSha256 = String(replayFreeze.freezeSha256);
  const common = { baseline: LFV_BASELINE_SHA, freezeSha256, returnsRead: false };
  await writeJson("lfv-001-replay-parity.json", {
    ...notRunArtifact("replay-parity", code, reason),
    ...common,
    liveObservationDiagnostic: { count: 44, cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(), status: "NOT_USED_FOR_RETURNS" },
    requiredInput: "independent frozen Production replay export for rules-profit-oriented-v4 and trend-rejection-short-v1",
    strategies: { "rules-profit-oriented-v4": "NOT_RUN", "trend-rejection-short-v1": "NOT_RUN" },
  });
  await writeJson("lfv-001-factor-results.json", {
    ...notRunArtifact("factor-results", code, reason),
    ...common,
    hypotheses: LFV_HYPOTHESES,
    classification: "FACTOR_NOT_VALIDATED",
    factors: Object.fromEntries(Object.entries(LFV_HYPOTHESES).map(([key, id]) => [key, { id, status: "NOT_RUN", blockedTradeMetrics: null, placebo: null }])),
  });
  await writeJson("lfv-001-combined-results.json", {
    ...notRunArtifact("combined-results", code, reason),
    ...common,
    definition: LFV_COMBINED_PRIMARY,
    allowedComparisons: ["BASELINE", "H1_ONLY", "H2_ONLY", "H3_PRIMARY", "H4_PRIMARY", "COMBINED_PRIMARY"],
    strategies: { "rules-profit-oriented-v4": null, "trend-rejection-short-v1": null },
  });
  await writeJson("lfv-001-holdouts.json", {
    ...notRunArtifact("holdouts", code, reason),
    ...common,
    holdoutA: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z", metrics: null },
    holdoutB: { start: "2026-01-01T00:00:00.000Z", end: "2026-07-31T23:59:59.999Z", metrics: null },
  });
  const secondaryReasons = [
    universe.status !== "PASS" ? `Universe parity: ${String(universe.reason ?? "FAIL")}` : null,
    String(LFV_V4_PROVENANCE.status) !== "RESTORED" ? "V4 provenance: V4_REPLAY_PROVENANCE_FAIL" : null,
  ].filter((item): item is string => Boolean(item));
  const universeMetrics = universe.metrics as JsonObject;
  const decision = {
    schema: "bca-lfv-001-decision-v3",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    originalFreezeCommit: ORIGINAL_FREEZE_COMMIT,
    originalFreezeSHA256: ORIGINAL_FREEZE_SHA256,
    dataFreezeSha256: dataFreeze.freezeSha256,
    replayFreezeSha256: freezeSha256,
    dataGate: dataGate.status,
    dataGateCode: dataGate.code,
    universeParity: {
      status: universe.status,
      code: universe.code,
      metrics: {
        method: universeMetrics.method,
        snapshotsCompared: universeMetrics.snapshotsCompared,
        medianTop100Overlap: universeMetrics.medianTop100Overlap,
        p10Top100Overlap: universeMetrics.p10Top100Overlap,
        rankSpearman: universeMetrics.rankSpearman,
        signalInclusionRecall: universeMetrics.signalInclusionRecall,
        pass: universeMetrics.pass,
        report: "reports/lfv-001-universe-parity.json",
      },
      dataCoverage: universe.dataCoverage,
    },
    v4Provenance: LFV_V4_PROVENANCE,
    trendProvenance: LFV_TREND_PROVENANCE,
    liveParity,
    status: code,
    finalClassification: code,
    researchStop: true,
    returnsRead: false,
    metrics: null,
    reasons: [reason, ...secondaryReasons],
    unchangedDefinitions: { hypotheses: LFV_HYPOTHESES, combined: LFV_COMBINED_PRIMARY, gateHash: dataFreeze.gateDefinitionHash },
    production: {
      ...LFV_SYSTEM_BOUNDARY,
      changed: false,
      strategyChanged: false,
      email: "OFF",
      deploy: false,
      merge: false,
      migration: false,
      "#002": "STOPPED",
      v14: "UNCHANGED",
    },
    nextStep: "Research stopped fail-closed. Do not read historical returns or tune H1-H4; only a newly authorized LFV project may proceed after restoring the missing immutable evidence.",
  };
  await writeJson("lfv-001-decision.json", decision);
  const markdown = [
    "# LFV-001 Decision",
    "",
    `- Status: **${code}**`,
    "- Research stop: **YES**",
    `- Baseline: \`${LFV_BASELINE_SHA}\``,
    "- Historical returns: **NOT READ**",
    "- August live observations: **EXCLUDED_FROM_RETURNS**",
    "",
    reason,
    "",
    "H1-H4 definitions and the Promotion Gate were not changed. No Production code, strategy, email state, deployment, migration, or trading boundary was changed.",
    "",
    "## Gate evidence",
    `- Data Gate: **${dataGate.status}**`,
    ...dataGate.reasons.map((item) => `- ${item}`),
    `- Universe parity: **${String(universe.status)}**`,
    `- V4 provenance: **${LFV_V4_PROVENANCE.status}**`,
  ].join("\n");
  await writeFile(resolve(REPORT_DIR, "lfv-001-decision.md"), `${markdown}\n`, "utf8");
}

async function writeEvidenceManifest(): Promise<void> {
  const reports = [];
  for (const name of REQUIRED_REPORTS) {
    const content = await readFile(resolve(REPORT_DIR, name));
    reports.push({ path: `reports/${name}`, bytes: content.byteLength, sha256: sha256Text(content.toString("utf8")) });
  }
  await writeJson("lfv-001-evidence-manifest.json", {
    schema: "bca-lfv-001-evidence-manifest-v3",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    rawHistoricalDataCommitted: false,
    returnsRead: false,
    reports,
  });
}

async function validateOriginalFreezeOnly(): Promise<void> {
  await readOriginalFreeze();
  console.info(JSON.stringify({ stage: "freeze", baseline: LFV_BASELINE_SHA, freezeSha256: ORIGINAL_FREEZE_SHA256 }, null, 2));
}

async function runFull(): Promise<void> {
  const dataFreeze = await readDataFreeze();
  const replayFreeze = await readReplayFreeze();
  const dataGate = await readFrozenDataGate(dataFreeze);
  const universe = await writeUniverseParityReport(dataGate.pass);
  const liveParity = await writeLiveParityReport();
  await writeStopArtifacts(dataGate, dataFreeze, replayFreeze, universe, liveParity);
  await writeEvidenceManifest();
  const result = stopReason(dataGate, universe);
  console.info(JSON.stringify({
    stage: "full",
    status: result.code,
    dataGate: dataGate.status,
    universeParity: universe.status,
    v4Provenance: LFV_V4_PROVENANCE.status,
    returnsRead: false,
    reasons: [result.reason],
  }, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--freeze")) {
    await validateOriginalFreezeOnly();
    return;
  }
  if (process.argv.includes("--freeze-v2")) {
    await createLfvDataFreezeV2();
    return;
  }
  if (process.argv.includes("--full")) {
    await runFull();
    return;
  }
  throw new Error("Use --freeze, --freeze-v2, or --full");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
