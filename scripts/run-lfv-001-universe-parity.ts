import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Text } from "@/lib/lfv/archive-data";
import { calculateObservedUniverseParity, type ObservedProxyResultInput } from "@/lib/lfv/observed-parity";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = resolve("../../data/raw");
const INITIAL_CACHE = resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m.json");
const RETRY_CACHE = resolve(DATA_ROOT, "lfv-001-cache/observed-universe-rest/2026-08-25_to_2026-08-27_15m_retry.json");

interface ObservedEvidence {
  groups: Parameters<typeof calculateObservedUniverseParity>[0]["groups"];
}

interface LiveEvidence {
  rows: Array<{ symbol: string; scanGroupKey?: string; sourceDataTimestamp?: string; strategyVersion?: string }>;
}

interface CacheFile {
  schema: string;
  source: string;
  interval: string;
  capturedAt: string;
  results: ObservedProxyResultInput[];
}

async function readCache(path: string): Promise<{ cache: CacheFile | null; evidence: Record<string, unknown> }> {
  try {
    const content = await readFile(path, "utf8");
    const metadata = await stat(path);
    const cache = JSON.parse(content) as CacheFile;
    return {
      cache,
      evidence: {
        path: path.replace(`${DATA_ROOT}\\`, "data/raw/").replaceAll("\\", "/"),
        bytes: metadata.size,
        sha256: sha256Text(content),
        schema: cache.schema,
        source: cache.source,
        interval: cache.interval,
        capturedAt: cache.capturedAt,
        resultCount: cache.results.length,
      },
    };
  } catch {
    return {
      cache: null,
      evidence: {
        path: path.replace(`${DATA_ROOT}\\`, "data/raw/").replaceAll("\\", "/"),
        status: "NOT_AVAILABLE",
      },
    };
  }
}

async function main(): Promise<void> {
  const observed = JSON.parse(await readFile(resolve(REPORT_DIR, "lfv-001-observed-universe-evidence-v1.json"), "utf8")) as ObservedEvidence;
  const live = JSON.parse(await readFile(resolve(REPORT_DIR, "lfv-001-live-parity-input-v1.json"), "utf8")) as LiveEvidence;
  const initial = await readCache(INITIAL_CACHE);
  const retry = await readCache(RETRY_CACHE);
  if (!initial.cache) throw new Error("Initial immutable observed-universe cache is unavailable");
  const result = calculateObservedUniverseParity({
    groups: observed.groups,
    initialResults: initial.cache.results,
    retryResults: retry.cache?.results,
    liveRows: live.rows,
  });
  const report = {
    schema: "bca-lfv-001-universe-parity-v1",
    generatedAt: new Date().toISOString(),
    status: result.metrics.pass ? "PASS" : "FAIL",
    code: result.metrics.pass
      ? null
      : result.dataCoverage.signalRowsEvaluated / live.rows.length < 0.95
        ? "LFV_UNIVERSE_PARITY_INSUFFICIENT"
        : "LFV_UNIVERSE_PARITY_FAIL",
    treatment: "OBSERVED_PRODUCTION_UNIVERSE_COMPARED_WITH_PIT_ROLLING_VOLUME_PROXY_ONLY",
    method: result.metrics.method,
    rules: {
      windowBars: 96,
      closedBarBoundary: "bar.closeTime < observed scan timestamp",
      selection: "rolling quote volume descending, symbol ascending; top min(100,N)",
      noCurrentTicker: true,
      noFutureData: true,
      noDailySnapshotSubstitution: true,
      noCurrentSurvivorFilter: true,
    },
    thresholds: {
      medianTop100Overlap: 0.95,
      p10Top100Overlap: 0.9,
      signalInclusionRecall: 0.98,
    },
    dataCoverage: result.dataCoverage,
    metrics: result.metrics,
    caches: {
      initial: initial.evidence,
      retry: retry.evidence,
    },
    sourceReports: {
      observed: { path: "reports/lfv-001-observed-universe-evidence-v1.json", sha256: sha256Text(await readFile(resolve(REPORT_DIR, "lfv-001-observed-universe-evidence-v1.json"), "utf8")) },
      live: { path: "reports/lfv-001-live-parity-input-v1.json", sha256: sha256Text(await readFile(resolve(REPORT_DIR, "lfv-001-live-parity-input-v1.json"), "utf8")) },
    },
  };
  await writeFile(resolve(REPORT_DIR, "lfv-001-universe-parity.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ status: report.status, code: report.code, metrics: result.metrics, coverage: result.dataCoverage }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
