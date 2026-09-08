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
import { canonicalTextSha256, sha256, sha256Bytes } from "../lib/v21/canonical";
import {
  enumerateV21PreReturnEvents,
  v21AuditIdentityPayload,
  v21EventIdentityPayload,
  type V21PreReturnAudit,
  type V21SynchronizedReturnMatrix,
} from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const PARENT_COMMIT = "e8721d509d574cc2697e3fff75ba7f5f4b86d99a";
const APPROVED_WP3A_COMMIT = "d36e6fc606e47ab4cb56d4b8ce4adb26abbccbcc";
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
const PRIOR_STAGE_EVIDENCE = [
  {
    stage: "WP1",
    commit: "6c17bc2545aff218d4d673f07ccee3a5bf8eb54b",
    paths: [
      "reports/v21-archive-manifest.json",
      "reports/v21-parser-report.json",
      "reports/v21-data-gate.json",
      "reports/v21-data-stage-manifest.json",
      "lib/v21/archive.ts",
      "lib/v21/canonical.ts",
      "lib/v21/constants.ts",
      "scripts/run-v21-data-stage.ts",
      "scripts/validate-v21-data.ts",
      "tests/v21-data.test.ts",
    ],
  },
  {
    stage: "WP2",
    commit: "83fa78849890ac0a59b408b4e0d13f007755977f",
    paths: [
      "reports/v21-feature-stage-manifest.json",
      "lib/v21/features.ts",
      "tests/v21-features.test.ts",
      "scripts/validate-v21-features.ts",
    ],
  },
  {
    stage: "WP2.5",
    commit: "3eceefd0808ac54d5da8e28edf78ef837bc9cacf",
    paths: [
      "reports/v21-scan-feasibility.json",
      "reports/v21-scan-stage-manifest.json",
      "lib/v21/feature-scan.ts",
      "tests/v21-feature-scan.test.ts",
      "scripts/validate-v21-feature-scan.ts",
    ],
  },
  {
    stage: "WP2.6",
    commit: "56326f0998b76cd78d088d73cb971c5c58ab4739",
    paths: [
      "reports/v21-event-predicate-feasibility.json",
      "reports/v21-event-predicate-stage-manifest.json",
      "lib/v21/event-predicate.ts",
      "tests/v21-event-predicate.test.ts",
      "scripts/validate-v21-event-predicate.ts",
    ],
  },
  {
    stage: "WP2.6b",
    commit: "e8721d509d574cc2697e3fff75ba7f5f4b86d99a",
    paths: [
      "reports/v21-event-predicate-feasibility.json",
      "reports/v21-event-predicate-stage-manifest.json",
      "lib/v21/event-predicate.ts",
      "tests/v21-event-predicate.test.ts",
      "scripts/validate-v21-event-predicate.ts",
    ],
  },
  {
    stage: "WP3A",
    commit: "d36e6fc606e47ab4cb56d4b8ce4adb26abbccbcc",
    paths: [
      "reports/v21-event-enumeration.json",
      "reports/v21-event-identities.json",
      "reports/v21-event-stage-manifest.json",
      "lib/v21/events.ts",
      "scripts/run-v21-event-stage.ts",
      "scripts/validate-v21-events.ts",
      "tests/v21-events.test.ts",
      "package.json",
    ],
  },
] as const;

async function main(): Promise<void> {
  assertParentCommit();
  await mkdir(REPORT_DIR, { recursive: true });
  const frozenIdentityText = await readFile(resolve(REPORT_DIR, "v21-event-identities.json"), "utf8");
  const frozenIdentities = JSON.parse(frozenIdentityText) as Record<string, unknown>;
  const input = await loadCachedSynchronizedInput();
  const result = enumerateV21PreReturnEvents(input);
  const generatedIdentities = {
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
  assertJsonEqual(generatedIdentities, frozenIdentities, "WP3A event identities are frozen");
  const identities = frozenIdentities as typeof generatedIdentities;
  const identityHash = canonicalTextSha256(frozenIdentityText);
  const eventDigests = {
    allEvents: sha256(identities.allEvents),
    primaryOosEvents: sha256(identities.primaryOosEvents),
    holdoutAEvents: sha256(identities.holdoutAEvents),
    holdoutBEvents: sha256(identities.holdoutBEvents),
  };
  assertJsonEqual(eventDigests, {
    allEvents: "a8435418f6007dd6a25a20d1a292fabd5cdfaa84f7cc7d713a617ed375ebec4b",
    primaryOosEvents: "621607df1f34fbb378ec938a5808ca27de17918dda498433da396e73e02d840c",
    holdoutAEvents: "fda762168a03429660b9805d616cbc88b54ce02f556abaa2bc7148b1e401ec6d",
    holdoutBEvents: "cf46b0ccad40b4ba84300e70c78438d943a96d8d1bc6adcc15bfdf8d85dd7433",
  }, "WP3A event digests are frozen");
  assertJsonEqual(result.diagnostics, {
    synchronizedReturnRows: 586943,
    featureEvaluations: 4626424,
    eligiblePitFeatures: 4626424,
    ineligiblePitFeatures: 0,
    ineligibleByReason: {},
    rawExtremeCandidates: 44574,
    firstCrossCandidates: 36566,
    zeroResidualFirstCrossCandidates: 0,
    overlapExcluded: 7476,
    finalEligibleEvents: 29090,
    residualComparisons: {
      total: 2704712009,
      average: 584.6225959834204,
      median: 165,
      p95: 2645,
      p99: 8640,
    },
    earlyExits: 4573748,
    fullWindowScans: 52676,
    exactThresholdComputations: 52676,
    eventsBySymbol: {
      BTCUSDT: 3675,
      ETHUSDT: 3647,
      BNBUSDT: 3676,
      ADAUSDT: 3680,
      BCHUSDT: 3535,
      DOGEUSDT: 3447,
      LINKUSDT: 3745,
      DOTUSDT: 3685,
    },
    eventsByDirection: { LONG: 12167, SHORT: 16923 },
    eventsByPeriod: { primaryOos: 19160, holdoutA: 6212, holdoutB: 3718 },
    yearlyIdentityCounts: { "2022": 6381, "2023": 6297, "2024": 6482, "2025": 6212, "2026": 3718 },
    distinctPrimarySignalClusters: 16532,
  }, "WP3A diagnostics are frozen");
  const auditRows = result.auditCandidates;
  const auditIdentityProjection = v21AuditIdentityPayload(auditRows);
  assertJsonEqual(auditIdentityProjection, identities.allEvents, "audit identity projection");
  const priorStageEvidenceLock = await buildPriorStageEvidenceLock();
  await writeJson("v21-prior-stage-evidence-lock.json", priorStageEvidenceLock);
  await writeJson("v21-event-audit.json", {
    schemaVersion: "v21-event-audit-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    approvedParentCommit: PARENT_COMMIT,
    source: "official Binance Data Vision regular 5m immutable archive cache; pre-return audit only",
    identityFields: ["symbol", "signalOpenTime", "direction", "clusterId"],
    noOutcomeFields: true,
    auditRows,
    counts: {
      auditRows: auditRows.length,
      accepted: auditRows.filter((row) => row.overlapStatus === "ACCEPTED" && row.eligibilityStatus === "ELIGIBLE").length,
      overlapExcluded: auditRows.filter((row) => row.overlapStatus === "OVERLAPPING_SIGNAL_EXCLUDED").length,
      zeroResidualIneligible: auditRows.filter((row) => row.eligibilityStatus === "ZERO_RESIDUAL_INELIGIBLE").length,
    },
    projectedIdentityDigests: eventDigests,
  });
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
    historicalSignalFeatureReturnsRead: true,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    executionEvaluated: false,
    nextBarOpenRead: false,
    futurePriceRead: false,
    holdoutOutcomeRead: false,
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
      eventAuditSha256: canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-event-audit.json"), "utf8")),
      priorStageEvidenceLockSha256: canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-prior-stage-evidence-lock.json"), "utf8")),
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
      historicalSignalFeatureReturnsRead: true,
      historicalStrategyOutcomeReturnsRead: false,
      forwardReturnsRead: false,
      nextBarOpenRead: false,
      futurePriceRead: false,
      holdoutOutcomeRead: false,
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
  if (branch !== V21_BRANCH) throw new Error(`V21 WP3A.1 requires ${V21_BRANCH}, got ${branch}`);
  if (head !== APPROVED_WP3A_COMMIT) throw new Error(`V21 WP3A.1 must run from approved WP3A commit ${APPROVED_WP3A_COMMIT}, got ${head}`);
}

async function buildPriorStageEvidenceLock(): Promise<Record<string, unknown>> {
  const stages = PRIOR_STAGE_EVIDENCE.map(({ stage, commit, paths }) => ({
    stage,
    commit,
    files: paths.map((path) => {
      const revision = `${commit}:${path}`;
      const gitBlobSha = execFileSync("git", ["rev-parse", revision], { encoding: "utf8" }).trim();
      const bytes = execFileSync("git", ["cat-file", "blob", gitBlobSha], { maxBuffer: 64 * 1024 * 1024 });
      return {
        path,
        gitBlobSha,
        rawSha256: sha256Bytes(bytes),
        canonicalTextSha256: canonicalTextSha256(new TextDecoder().decode(bytes)),
      };
    }),
  }));
  return {
    schemaVersion: "v21-prior-stage-evidence-lock-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    source: "git cat-file blob of approved commit:path; no working-tree evidence substitution",
    stages,
  };
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

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`V21 WP3A.1 audit assertion failed: ${message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
