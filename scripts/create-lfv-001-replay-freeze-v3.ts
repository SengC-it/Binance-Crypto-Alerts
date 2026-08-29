import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_SYSTEM_BOUNDARY,
} from "@/lib/lfv/loss-factors";
import { LFV_V4_PROVENANCE, LFV_TREND_PROVENANCE } from "@/lib/lfv/provenance";
import { sha256Text, stableStringify } from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = resolve("../../data/raw");
const OUTPUT = resolve(REPORT_DIR, "lfv-001-replay-freeze-v3.json");
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
  "lib/lfv/universe-replay.ts",
];

async function fileHash(path: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const content = await readFile(path, "utf8");
  return { path, bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
}

async function optionalDataCacheHash(path: string): Promise<Record<string, unknown>> {
  try {
    const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      path: path.replace(`${DATA_ROOT}\\`, "data/raw/").replaceAll("\\", "/"),
      bytes: metadata.size,
      sha256: sha256Text(content),
      capturedAt: parsed.capturedAt ?? null,
      resultCount: Array.isArray(parsed.results) ? parsed.results.length : null,
      errorCount: Array.isArray(parsed.results) ? parsed.results.filter((item) => Boolean((item as Record<string, unknown>).error)).length : null,
    };
  } catch {
    return { path: path.replace(`${DATA_ROOT}\\`, "data/raw/").replaceAll("\\", "/"), status: "NOT_AVAILABLE" };
  }
}

async function main(): Promise<void> {
  const original = JSON.parse(await readFile(resolve(REPORT_DIR, "lfv-001-freeze-manifest.json"), "utf8")) as Record<string, unknown>;
  const dataFreeze = JSON.parse(await readFile(resolve(REPORT_DIR, "lfv-001-data-freeze-v2.json"), "utf8")) as Record<string, unknown>;
  const observed = await fileHash(resolve(REPORT_DIR, "lfv-001-observed-universe-evidence-v1.json"));
  const liveParity = await fileHash(resolve(REPORT_DIR, "lfv-001-live-parity-input-v1.json"));
  const code = await Promise.all(CODE_FILES.map((path) => fileHash(resolve(path))));
  const core = {
    schema: "bca-lfv-001-replay-freeze-v3",
    status: "FROZEN_BEFORE_RETURN_READ",
    originalFreezeCommit: ORIGINAL_FREEZE_COMMIT,
    originalFreezeSHA256: ORIGINAL_FREEZE_SHA256,
    dataFreezeV2: {
      fileSha256: sha256Text(await readFile(resolve(REPORT_DIR, "lfv-001-data-freeze-v2.json"), "utf8")),
      freezeSha256: dataFreeze.freezeSha256,
      archiveRegistryHash: dataFreeze.archiveRegistryHash,
      pitUniverseRuleHash: dataFreeze.pitUniverseRuleHash,
      gateDefinitionHash: dataFreeze.gateDefinitionHash,
      hypothesisHashes: dataFreeze.hypothesisHashes,
      combinedDefinitionHash: dataFreeze.combinedDefinitionHash,
      returnsRead: false,
    },
    hypotheses: LFV_HYPOTHESES,
    combinedDefinition: LFV_COMBINED_PRIMARY,
    universeReplay: {
      observedEvidence: observed,
      method: "ROLLING_15M_24H_VOLUME_PROXY",
      windowBars: 96,
      signalTimestampRule: "only bars with closeTime < signal timestamp; no current ticker, future candle, daily snapshot, or survivor backfill",
      selection: "eligible symbols ranked by rolling quote volume descending, symbol ascending; top min(100,N)",
      parityGate: {
        medianTop100Overlap: ">=0.95",
        p10Top100Overlap: ">=0.90",
        signalInclusionRecall: ">=0.98",
      },
      rawCache: await optionalDataCacheHash(resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m.json")),
      retryCache: await optionalDataCacheHash(resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m_retry.json")),
    },
    productionReplay: {
      cadence: "15m closed-candle schedule",
      signalInputs: "15m/1h/4h candles closed at or before signal timestamp",
      executionReference: "Production baseline just-closed 15m reference; no same-window execution",
      sharedCore: "lib/core/build-opportunity.ts -> lib/core/production-signal.ts",
      settlement: "stop-first OHLC, take-profit, max-hold, signal replacement/cancellation, sequential cooldown, two-sided fee/slippage and actual funding observations",
      liveParityInput: liveParity,
      v4: LFV_V4_PROVENANCE,
      trend: LFV_TREND_PROVENANCE,
    },
    codeFiles: code,
    returnsRead: false,
    productionBoundary: LFV_SYSTEM_BOUNDARY,
  };
  const freeze = {
    ...core,
    generatedAt: new Date().toISOString(),
    freezeSha256: sha256Text(stableStringify(core)),
  };
  await (await import("node:fs/promises")).writeFile(OUTPUT, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ output: OUTPUT, freezeSha256: freeze.freezeSha256, returnsRead: false }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
