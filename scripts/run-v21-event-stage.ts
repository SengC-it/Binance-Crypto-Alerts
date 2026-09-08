import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_FORBIDDEN_PATHS,
  V21_INTERVAL_MS,
  V21_REPOSITORY,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  v21MonthKeys,
} from "../lib/v21/constants";
import {
  V21_ARCHIVE_ROOT,
  downloadAndParseV21Archive,
} from "../lib/v21/archive";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import {
  enumerateV21PreReturnEvents,
  v21EventIdentityPayload,
  type V21SynchronizedReturnMatrix,
} from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const PARENT_COMMIT = "e8721d509d574cc2697e3fff75ba7f5f4b86d99a";
const SOURCE_FILES = [
  "lib/v21/constants.ts",
  "lib/v21/canonical.ts",
  "lib/v21/archive.ts",
  "lib/v21/features.ts",
  "lib/v21/feature-scan.ts",
  "lib/v21/event-predicate.ts",
  "lib/v21/events.ts",
  "scripts/run-v21-event-stage.ts",
  "scripts/validate-v21-events.ts",
  "tests/v21-events.test.ts",
  "package.json",
] as const;

async function main(): Promise<void> {
  assertParentCommit();
  await mkdir(REPORT_DIR, { recursive: true });
  const input = await loadCachedSynchronizedInput();
  const result = enumerateV21PreReturnEvents(input);
  const identities = {
    schemaVersion: "v21-event-identities-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    source: "official Binance Data Vision regular 5m immutable archive cache",
    identityFields: ["symbol", "signalOpenTime", "direction", "clusterId"],
    noExecutionFields: true,
    allEvents: v21EventIdentityPayload(result.allEvents),
    primaryOosEvents: v21EventIdentityPayload(result.primaryOosEvents),
    holdoutAEvents: v21EventIdentityPayload(result.holdoutAEvents),
    holdoutBEvents: v21EventIdentityPayload(result.holdoutBEvents),
  };
  await writeJson("v21-event-identities.json", identities);
  const identityHash = canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-event-identities.json"), "utf8"));
  const eventDigests = {
    allEvents: sha256(identities.allEvents),
    primaryOosEvents: sha256(identities.primaryOosEvents),
    holdoutAEvents: sha256(identities.holdoutAEvents),
    holdoutBEvents: sha256(identities.holdoutBEvents),
  };
  const diagnostics = result.diagnostics;
  const primarySampleGate = {
    minimumPrimaryEvents: 1000,
    minimumPrimaryClusters: 500,
    minimumEventsPerFixedSymbol: 75,
    primaryEvents: result.primaryOosEvents.length,
    primaryClusters: diagnostics.distinctPrimarySignalClusters,
    eventsBySymbol: V21_SYMBOLS.reduce((counts, symbol) => {
      counts[symbol] = result.primaryOosEvents.filter((event) => event.symbol === symbol).length;
      return counts;
    }, {} as Record<(typeof V21_SYMBOLS)[number], number>),
  };
  const sampleGatePassed = primarySampleGate.primaryEvents >= primarySampleGate.minimumPrimaryEvents
    && primarySampleGate.primaryClusters >= primarySampleGate.minimumPrimaryClusters
    && Object.values(primarySampleGate.eventsBySymbol).every((count) => count >= primarySampleGate.minimumEventsPerFixedSymbol);
  const eventReport = {
    schemaVersion: "v21-event-enumeration-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    approvedParentCommit: PARENT_COMMIT,
    source: {
      exchange: "BINANCE_DATA_VISION",
      market: "USD-M Futures",
      dataType: "regular",
      interval: "5m",
      immutableArchiveCache: true,
      archiveManifestSha256: await reportHash("v21-archive-manifest.json"),
      parserReportSha256: await reportHash("v21-parser-report.json"),
      dataGateSha256: await reportHash("v21-data-gate.json"),
    },
    fixedSymbols: V21_SYMBOLS,
    period: {
      start: V21_START_TIMESTAMP,
      endExclusive: V21_END_EXCLUSIVE_TIMESTAMP,
      warmup: "2021",
      primaryOos: "2022-01-01T00:00:00.000Z/2025-01-01T00:00:00.000Z",
      holdoutA: "2025-01-01T00:00:00.000Z/2026-01-01T00:00:00.000Z",
      holdoutB: "2026-01-01T00:00:00.000Z/2026-08-01T00:00:00.000Z",
    },
    featureDefinition: {
      pitWindow: "[t - 30d, t)",
      pitObservationCount: 8640,
      market: "leave-one-out median of the other seven synchronized 5m log-return series",
      ols: "current-t intercept and beta fit over exactly the prior 8640 rows",
      residual: "prior and current residuals use the same current-t intercept and beta",
      threshold: "absolute prior residual nearest-rank Q99, rank=8554, no interpolation",
    },
    eventDefinition: {
      extreme: "count abs(priorResidual) > abs(currentResidual), early exit at greaterCount=87; full scan computes exact Q99",
      firstCross: "abs(previousResidual) < threshold and abs(currentResidual) >= threshold",
      direction: "currentResidual > 0 => SHORT; currentResidual < 0 => LONG; zero is ineligible",
      primaryHorizon: "30m timestamp-only",
      overlap: "same symbol excludes later event while prior accepted event is active; different symbols may share a timestamp",
      clusterId: "signalOpenTime",
      identityPayload: ["symbol", "signalOpenTime", "direction", "clusterId"],
    },
    diagnostics,
    eventDigests,
    identityArtifactSha256: identityHash,
    primarySampleGate,
    classification: sampleGatePassed ? "V21_PRE_RETURN_SAMPLE_GATE_PASS" : "V21_PRE_RETURN_SAMPLE_INSUFFICIENT",
    researchStop: !sampleGatePassed,
    controlsEnumerated: false,
    historicalReturnsRead: false,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    oosMetricsRead: false,
    holdoutRead: false,
    parameterSearch: false,
    executionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    migration: false,
    privateBinanceApi: false,
    orderPlacement: false,
    autoTrading: false,
    automaticPromotion: false,
    futureDataRead: false,
    noFutureBarsUsed: true,
  } as const;
  await writeJson("v21-event-enumeration.json", eventReport);

  const stageBody = {
    schemaVersion: "v21-event-stage-manifest-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    approvedParentCommit: PARENT_COMMIT,
    fixedSymbols: V21_SYMBOLS,
    sourceReports: {
      archiveManifestSha256: await reportHash("v21-archive-manifest.json"),
      parserReportSha256: await reportHash("v21-parser-report.json"),
      dataGateSha256: await reportHash("v21-data-gate.json"),
      featureStageManifestSha256: await reportHash("v21-feature-stage-manifest.json"),
      scanStageManifestSha256: await reportHash("v21-scan-stage-manifest.json"),
      eventPredicateStageManifestSha256: await reportHash("v21-event-predicate-stage-manifest.json"),
      eventEnumerationSha256: canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-event-enumeration.json"), "utf8")),
      eventIdentitiesSha256: identityHash,
    },
    eventDigests,
    diagnostics,
    primarySampleGate,
    sourceHashes: await hashSources(),
    classification: eventReport.classification,
    researchStop: eventReport.researchStop,
    flags: {
      realHistoricalDataScanned: true,
      historicalFeatureScanRun: true,
      historicalEventScanRun: true,
      signalsEnumerated: true,
      firstCrossEnumerated: true,
      directionsAssigned: true,
      executionEvaluated: false,
      historicalStrategyOutcomeReturnsRead: false,
      historicalReturnsRead: false,
      forwardReturnsRead: false,
      oosMetricsRead: false,
      holdoutRead: false,
      parameterSearch: false,
      freezeCreated: false,
      resultCommitCreated: false,
      productionChanged: false,
      productionEmail: "OFF",
      deploy: false,
      merge: false,
      migration: false,
      privateBinanceApi: false,
      orderPlacement: false,
      autoTrading: false,
      automaticPromotion: false,
    },
    sourceFiles: SOURCE_FILES,
    forbiddenPaths: V21_FORBIDDEN_PATHS,
  } as const;
  await writeJson("v21-event-stage-manifest.json", {
    ...stageBody,
    manifestBodySha256: sha256(stageBody),
  });
  console.info(`V21 WP3A: ${eventReport.classification}`);
  console.info(`V21 WP3A final eligible events: ${diagnostics.finalEligibleEvents}`);
}

async function loadCachedSynchronizedInput(): Promise<V21SynchronizedReturnMatrix> {
  const expectedCloseRows = V21_EXPECTED_ROWS_PER_SYMBOL;
  const returnRows = expectedCloseRows - 1;
  const start = Date.parse(V21_START_TIMESTAMP);
  const openTimes = new Float64Array(returnRows);
  for (let index = 0; index < returnRows; index += 1) openTimes[index] = start + (index + 1) * V21_INTERVAL_MS;
  const returnsBySymbol = {} as Record<(typeof V21_SYMBOLS)[number], Float64Array>;
  const months = v21MonthKeys();

  for (const symbol of V21_SYMBOLS) {
    const closes = new Float64Array(expectedCloseRows);
    let filled = 0;
    for (const month of months) {
      const result = await downloadAndParseV21Archive(symbol, month, {
        rootDir: V21_ARCHIVE_ROOT,
        fetchImpl: noNetworkFetch,
      });
      if (result.slot.status !== "VERIFIED" || !result.slot.checksumVerified || result.bars.length !== result.slot.expectedMonthRows) {
        throw new Error(`Immutable V21 archive cache is not verified for ${symbol}/${month}`);
      }
      for (const bar of result.bars) {
        const offset = (bar.openTime - start) / V21_INTERVAL_MS;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= expectedCloseRows || closes[offset] !== 0) {
          throw new Error(`Invalid synchronized cache identity for ${symbol}/${month}`);
        }
        closes[offset] = bar.close;
        filled += 1;
      }
    }
    if (filled !== expectedCloseRows || closes.some((value) => value <= 0 || !Number.isFinite(value))) {
      throw new Error(`Incomplete immutable close cache for ${symbol}`);
    }
    const values = new Float64Array(returnRows);
    for (let index = 1; index < closes.length; index += 1) {
      values[index - 1] = Math.log(closes[index] / closes[index - 1]);
    }
    returnsBySymbol[symbol] = values;
    console.info(`Loaded verified PIT input: ${symbol} (${filled} closed bars)`);
  }
  return { openTimes, returnsBySymbol };
}

const noNetworkFetch: typeof fetch = async () => {
  throw new Error("V21 WP3A forbids archive/API backfill; required cache file is missing");
};

function assertParentCommit(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== V21_BRANCH) throw new Error(`V21 WP3A requires ${V21_BRANCH}, got ${branch}`);
  if (head !== PARENT_COMMIT) throw new Error(`V21 WP3A must run from approved parent ${PARENT_COMMIT}, got ${head}`);
}

async function reportHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function hashSources(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const source of SOURCE_FILES) hashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  return hashes;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
