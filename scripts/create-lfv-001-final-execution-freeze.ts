import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LFV_COMBINED_PRIMARY, LFV_HYPOTHESES, LFV_LIVE_OBSERVATION_CUTOFF, LFV_SYSTEM_BOUNDARY } from "@/lib/lfv/loss-factors";
import { LFV_LIVE_PARITY_THRESHOLDS, LFV_TREND_PROVENANCE, LFV_V4_PROVENANCE } from "@/lib/lfv/provenance";
import { sha256Text, stableStringify } from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const OUTPUT = resolve(REPORT_DIR, "lfv-001-final-execution-freeze.json");
const ORIGINAL_FREEZE_COMMIT = "d68737cbd27c38e8fb09812ab225cfaaec56f037";
const ORIGINAL_FREEZE_SHA256 = "1bd06d9317203488eef599180f52dd66ecc1d15c87b6dca4ef382daf2dc901f9";
const LFV_BASELINE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const LIVE_SIGNAL_UNIVERSE_NAME = "lfv-001-live-signal-universe-v2.json";

const TREND_RUNTIME_FILES = [
  "lib/config.ts",
  "lib/core/build-opportunity.ts",
  "lib/core/execution-policy.ts",
  "lib/core/production-policy.ts",
  "lib/core/production-signal.ts",
  "lib/core/risk.ts",
  "lib/core/scoring.ts",
  "lib/core/strategies.ts",
  "lib/core/types.ts",
  "lib/lfv/production-replay.ts",
  "lib/lfv/provenance.ts",
  "lib/lfv/universe-replay.ts",
];

const EXECUTION_FILES = [
  "app/api/scan/route.ts",
  ...TREND_RUNTIME_FILES,
  "lib/lfv/loss-factors.ts",
  "lib/lfv/observed-parity.ts",
  "lib/lfv/live-signal-universe.ts",
  "scripts/create-lfv-001-final-execution-freeze.ts",
  "scripts/run-lfv-001-live-signal-universe.ts",
  "scripts/run-lfv-001-validation.ts",
  "scripts/validate-lfv-001-artifact.ts",
  "tests/lfv-001-replay.test.ts",
];

type JsonObject = Record<string, unknown>;

async function readReport(name: string): Promise<{ content: string; report: JsonObject }> {
  const content = await readFile(resolve(REPORT_DIR, name), "utf8");
  return { content, report: JSON.parse(content) as JsonObject };
}

async function fileHash(relativePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const content = await readFile(resolve(relativePath), "utf8");
  return { path: relativePath.replaceAll("\\", "/"), bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
}

function freezeIntrinsicHash(report: JsonObject): string {
  const { freezeSha256, generatedAt, ...core } = report;
  void freezeSha256;
  void generatedAt;
  return sha256Text(stableStringify(core));
}

function reportIntrinsicHash(report: JsonObject): string {
  const { reportSha256, ...core } = report;
  void reportSha256;
  return sha256Text(stableStringify(core));
}

async function main(): Promise<void> {
  const original = await readReport("lfv-001-freeze-manifest.json");
  if (original.report.freezeSha256 !== ORIGINAL_FREEZE_SHA256 || freezeIntrinsicHash(original.report) !== ORIGINAL_FREEZE_SHA256) {
    throw new Error("original LFV freeze provenance mismatch");
  }
  if ((original.report.baseline as JsonObject | undefined)?.sha !== LFV_BASELINE_SHA) {
    throw new Error("original LFV baseline mismatch");
  }

  const dataFreeze = await readReport("lfv-001-data-freeze-v2.json");
  if (dataFreeze.report.freezeSha256 !== freezeIntrinsicHash(dataFreeze.report) || dataFreeze.report.returnsRead !== false) {
    throw new Error("LFV data freeze v2 is not a valid pre-returns freeze");
  }
  const replayV3 = await readReport("lfv-001-replay-freeze-v3.json");
  const replayV4 = await readReport("lfv-001-replay-freeze-v4.json");
  if (
    replayV3.report.schema !== "bca-lfv-001-replay-freeze-v3"
    || replayV3.report.status !== "FROZEN_BEFORE_RETURN_READ"
    || replayV3.report.returnsRead !== false
    || replayV3.report.freezeSha256 !== freezeIntrinsicHash(replayV3.report)
  ) {
    throw new Error("LFV replay freeze v3 is not a valid pre-returns freeze");
  }
  if (
    replayV4.report.schema !== "bca-lfv-001-replay-freeze-v4"
    || replayV4.report.status !== "FROZEN_BEFORE_RETURN_READ"
    || replayV4.report.returnsRead !== false
    || replayV4.report.freezeSha256 !== freezeIntrinsicHash(replayV4.report)
  ) {
    throw new Error("LFV replay freeze v4 is not a valid pre-returns freeze");
  }

  const liveUniverse = await readReport(LIVE_SIGNAL_UNIVERSE_NAME);
  if (
    liveUniverse.report.schema !== "bca-lfv-001-live-signal-universe-v2"
    || liveUniverse.report.reportSha256 !== reportIntrinsicHash(liveUniverse.report)
    || liveUniverse.report.status !== "FAIL"
    || (liveUniverse.report.dataCoverage as JsonObject | undefined)?.frozenSignals !== 44
  ) {
    throw new Error("LFV live-signal universe v2 is not a valid frozen result");
  }
  const liveInput = await readReport("lfv-001-live-parity-input-v1.json");
  const liveRows = liveInput.report.rows;
  if (!Array.isArray(liveRows) || liveRows.length !== 44) throw new Error("expected 44 frozen live signal rows");

  const executionCode = await Promise.all(EXECUTION_FILES.map((path) => fileHash(path)));
  const trendCode = executionCode.filter((item) => TREND_RUNTIME_FILES.includes(item.path));
  const trendCodeHash = sha256Text(stableStringify(trendCode));
  const dataFreezeReport = dataFreeze.report;

  const core = {
    schema: "bca-lfv-001-final-execution-freeze-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: LFV_BASELINE_SHA,
    originalFreezeCommit: ORIGINAL_FREEZE_COMMIT,
    originalFreezeSHA256: ORIGINAL_FREEZE_SHA256,
    originalFreeze: {
      fileSha256: sha256Text(original.content),
      freezeSha256: original.report.freezeSha256,
    },
    dataFreezeV2: {
      fileSha256: sha256Text(dataFreeze.content),
      freezeSha256: dataFreeze.report.freezeSha256,
      archiveRegistryHash: dataFreeze.report.archiveRegistryHash,
      pitUniverseRuleHash: dataFreeze.report.pitUniverseRuleHash,
      gateDefinitionHash: dataFreeze.report.gateDefinitionHash,
      hypothesisHashes: dataFreeze.report.hypothesisHashes,
      combinedDefinitionHash: dataFreeze.report.combinedDefinitionHash,
      returnsRead: false,
    },
    replayFreezeV3: {
      fileSha256: sha256Text(replayV3.content),
      freezeSha256: replayV3.report.freezeSha256,
    },
    replayFreezeV4: {
      fileSha256: sha256Text(replayV4.content),
      freezeSha256: replayV4.report.freezeSha256,
    },
    liveSignalUniverse: {
      path: `reports/${LIVE_SIGNAL_UNIVERSE_NAME}`,
      fileSha256: sha256Text(liveUniverse.content),
      reportSha256: liveUniverse.report.reportSha256,
      status: liveUniverse.report.status,
      code: liveUniverse.report.code,
      dataCoverage: liveUniverse.report.dataCoverage,
      reconstruction: liveUniverse.report.reconstruction,
      cacheManifest: (liveUniverse.report.source as JsonObject | undefined)?.cacheManifest ?? null,
    },
    frozenLiveSignals: {
      path: "reports/lfv-001-live-parity-input-v1.json",
      fileSha256: sha256Text(liveInput.content),
      rowCount: liveRows.length,
      rowsSha256: sha256Text(stableStringify(liveRows)),
      cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(),
      treatment: "EXCLUDED_FROM_RETURNS",
    },
    unchangedDefinitions: {
      hypotheses: LFV_HYPOTHESES,
      hypothesisHashes: dataFreezeReport.hypothesisHashes,
      combined: LFV_COMBINED_PRIMARY,
      combinedDefinitionHash: dataFreezeReport.combinedDefinitionHash,
      gateDefinitionHash: dataFreezeReport.gateDefinitionHash,
      replayGate: replayV4.report.unchangedDefinitions,
    },
    trendRuntime: {
      provenance: LFV_TREND_PROVENANCE,
      config: LFV_TREND_PROVENANCE.runtimeConfig,
      codeHash: trendCodeHash,
      codeFiles: trendCode,
    },
    trendCodeHash,
    executionCode,
    reconstructionMethod: {
      source: "official Binance public USDⓈ-M klines plus frozen archive registry",
      lifecycle: "firstObserved month <= signal timestamp - 90 days; no current exchangeInfo or current-survivor filter",
      signalKey: "symbol + source_data_timestamp",
      closedWindow: "96 complete contiguous 15m bars with bar.closeTime < source_data_timestamp",
      ranking: "rolling 24h quote volume descending, symbol ascending; top min(100,N)",
      missingTreatment: "fail closed; no forward-fill, current-universe backfill, or synthetic row",
    },
    v4Provenance: LFV_V4_PROVENANCE,
    liveParityThresholds: LFV_LIVE_PARITY_THRESHOLDS,
    returnsRead: false,
    productionBoundary: LFV_SYSTEM_BOUNDARY,
  };
  const freeze = {
    ...core,
    generatedAt: new Date().toISOString(),
    freezeSha256: sha256Text(stableStringify(core)),
  };
  await writeFile(OUTPUT, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ output: OUTPUT, freezeSha256: freeze.freezeSha256, returnsRead: false, universeStatus: liveUniverse.report.status }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
