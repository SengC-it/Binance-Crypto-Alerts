import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LFV_COMBINED_PRIMARY, LFV_HYPOTHESES, LFV_SYSTEM_BOUNDARY } from "@/lib/lfv/loss-factors";
import { LFV_LIVE_PARITY_THRESHOLDS, LFV_TREND_PROVENANCE, LFV_V4_PROVENANCE } from "@/lib/lfv/provenance";
import { sha256Text, stableStringify } from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const OUTPUT = resolve(REPORT_DIR, "lfv-001-replay-freeze-v4.json");
const ORIGINAL_FREEZE_COMMIT = "d68737cbd27c38e8fb09812ab225cfaaec56f037";
const ORIGINAL_FREEZE_SHA256 = "1bd06d9317203488eef599180f52dd66ecc1d15c87b6dca4ef382daf2dc901f9";

const CODE_FILES = [
  "app/api/scan/route.ts",
  "lib/config.ts",
  "lib/core/build-opportunity.ts",
  "lib/core/execution-policy.ts",
  "lib/core/production-policy.ts",
  "lib/core/production-signal.ts",
  "lib/core/risk.ts",
  "lib/core/scoring.ts",
  "lib/core/strategies.ts",
  "lib/core/types.ts",
  "lib/lfv/loss-factors.ts",
  "lib/lfv/production-replay.ts",
  "lib/lfv/provenance.ts",
  "lib/lfv/observed-parity.ts",
  "lib/lfv/universe-replay.ts",
  "scripts/create-lfv-001-replay-freeze-v3.ts",
  "scripts/create-lfv-001-replay-freeze-v4.ts",
  "scripts/run-lfv-001-data-pipeline.ts",
  "scripts/run-lfv-001-validation.ts",
  "scripts/run-lfv-001-universe-parity.ts",
  "scripts/validate-lfv-001-artifact.ts",
  "tests/lfv-001-replay.test.ts",
];

async function fileHash(relativePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const content = await readFile(resolve(relativePath), "utf8");
  return { path: relativePath.replaceAll("\\", "/"), bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
}

async function cacheHash(relativePath: string): Promise<Record<string, unknown>> {
  const path = resolve(relativePath);
  try {
    const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      path: relativePath.replaceAll("\\", "/"),
      bytes: metadata.size,
      sha256: sha256Text(content),
      capturedAt: parsed.capturedAt ?? null,
      resultCount: Array.isArray(parsed.results) ? parsed.results.length : null,
      errorCount: Array.isArray(parsed.results) ? parsed.results.filter((item) => Boolean((item as Record<string, unknown>).error)).length : null,
    };
  } catch {
    return { path: relativePath.replaceAll("\\", "/"), status: "NOT_AVAILABLE" };
  }
}

async function main(): Promise<void> {
  const originalContent = await readFile(resolve(REPORT_DIR, "lfv-001-freeze-manifest.json"), "utf8");
  const original = JSON.parse(originalContent) as Record<string, unknown>;
  if (original.freezeSha256 !== ORIGINAL_FREEZE_SHA256 || (original.baseline as Record<string, unknown>)?.sha !== "7b9e5d82f471ee3c9fec07e00101263c8d84e953") {
    throw new Error("original LFV freeze provenance mismatch");
  }

  const dataFreezeContent = await readFile(resolve(REPORT_DIR, "lfv-001-data-freeze-v2.json"), "utf8");
  const dataFreeze = JSON.parse(dataFreezeContent) as Record<string, unknown>;
  const v3Content = await readFile(resolve(REPORT_DIR, "lfv-001-replay-freeze-v3.json"), "utf8");
  const v3 = JSON.parse(v3Content) as Record<string, unknown>;
  if (v3.schema !== "bca-lfv-001-replay-freeze-v3" || v3.status !== "FROZEN_BEFORE_RETURN_READ" || v3.returnsRead !== false) {
    throw new Error("replay freeze v3 is not a valid pre-returns predecessor");
  }
  if (dataFreeze.returnsRead !== false) throw new Error("data freeze v2 returns-read boundary failed");

  const observed = await fileHash("reports/lfv-001-observed-universe-evidence-v1.json");
  const live = await fileHash("reports/lfv-001-live-parity-input-v1.json");
  const code = await Promise.all(CODE_FILES.map((path) => fileHash(path)));
  const core = {
    schema: "bca-lfv-001-replay-freeze-v4",
    status: "FROZEN_BEFORE_RETURN_READ",
    originalFreezeCommit: ORIGINAL_FREEZE_COMMIT,
    originalFreezeSHA256: ORIGINAL_FREEZE_SHA256,
    dataFreezeV2: {
      fileSha256: sha256Text(dataFreezeContent),
      freezeSha256: dataFreeze.freezeSha256,
      archiveRegistryHash: dataFreeze.archiveRegistryHash,
      pitUniverseRuleHash: dataFreeze.pitUniverseRuleHash,
      gateDefinitionHash: dataFreeze.gateDefinitionHash,
      hypothesisHashes: dataFreeze.hypothesisHashes,
      combinedDefinitionHash: dataFreeze.combinedDefinitionHash,
      returnsRead: false,
    },
    replayFreezeV3: {
      reportSha256: sha256Text(v3Content),
      freezeSha256: v3.freezeSha256,
      generatedAt: v3.generatedAt ?? null,
    },
    unchangedDefinitions: {
      hypotheses: LFV_HYPOTHESES,
      hypothesisHashes: dataFreeze.hypothesisHashes,
      combinedDefinition: LFV_COMBINED_PRIMARY,
      combinedDefinitionHash: dataFreeze.combinedDefinitionHash,
      gateDefinitionHash: dataFreeze.gateDefinitionHash,
      originalGateDefinition: (original.gates ?? null),
    },
    universeReplay: {
      observedEvidence: observed,
      method: "ROLLING_15M_24H_VOLUME_PROXY",
      windowBars: 96,
      signalTimestampRule: "for every frozen live row use sourceDataTimestamp; only bars with closeTime < sourceDataTimestamp",
      signalMapping: "sourceDataTimestamp + symbol; scan_group_key is retained only as an observed diagnostic and is not the join key",
      signalCoverageRule: "a row is evaluated only when the complete frozen observed universe has a valid 96-bar PIT window at that timestamp",
      signalInclusionRecall: "signalRowsIncluded / signalRowsEvaluated; signalRowsEvaluated / 44 must be >=0.95 before the >=0.98 recall gate is applied",
      selection: "eligible symbols ranked by rolling quote volume descending, symbol ascending; top min(100,N)",
      parityGate: {
        medianTop100Overlap: ">=0.95",
        p10Top100Overlap: ">=0.90",
        signalArchiveCoverage: ">=0.95",
        signalInclusionRecall: ">=0.98",
      },
      rawCache: await cacheHash("data/raw/lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m.json"),
      retryCache: await cacheHash("data/raw/lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m_retry.json"),
    },
    v4Provenance: LFV_V4_PROVENANCE,
    trendProvenance: LFV_TREND_PROVENANCE,
    liveParity: {
      sourceReport: live,
      thresholds: LFV_LIVE_PARITY_THRESHOLDS,
      v4: "UNAVAILABLE_UNTIL_MATERIAL_RUNTIME_FIELDS_ARE_PROVEN",
      trend: "ELIGIBLE_AFTER_UNIVERSE_GATE",
    },
    eligibleStrategies: ["trend-rejection-short-v1"],
    returnsRead: false,
    codeFiles: code,
    productionBoundary: LFV_SYSTEM_BOUNDARY,
  };
  const serializedCore = JSON.parse(JSON.stringify(core)) as typeof core;
  const freeze = {
    ...serializedCore,
    generatedAt: new Date().toISOString(),
    freezeSha256: sha256Text(stableStringify(serializedCore)),
  };
  await writeFile(OUTPUT, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ output: OUTPUT, freezeSha256: freeze.freezeSha256, eligibleStrategies: freeze.eligibleStrategies, returnsRead: false }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
