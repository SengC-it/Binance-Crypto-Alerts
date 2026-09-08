import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_REPOSITORY,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  v21MonthKeys,
} from "../lib/v21/constants";
import {
  V21_ARCHIVE_ROOT,
  downloadAndParseV21Archive,
} from "../lib/v21/archive";
import {
  V21_TIME_MATCHED_RANDOM_SEED,
  V21_TIME_MATCHED_RANDOM_ALGORITHM,
  enumerateV21Controls,
  type V21ControlName,
} from "../lib/v21/controls";
import {
  V21_BOOTSTRAP_CONTRACT,
  V21_CLASSIFICATION_CONTRACT,
  V21_COST_CONTRACT,
  V21_EXECUTION_CONTRACT,
  V21_METRIC_CONTRACT,
  V21_PROMOTION_GATE_DEFINITIONS,
} from "../lib/v21/result-evaluator";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import type { V21EventIdentity, V21SynchronizedReturnMatrix } from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const APPROVED_WP3A1_COMMIT = "39a670aa5a777876ba8cccfc5e8eaed14f061194";
const EXPECTED_PRIMARY_EVENT_DIGESTS = {
  allEvents: "a8435418f6007dd6a25a20d1a292fabd5cdfaa84f7cc7d713a617ed375ebec4b",
  primaryOosEvents: "621607df1f34fbb378ec938a5808ca27de17918dda498433da396e73e02d840c",
  holdoutAEvents: "fda762168a03429660b9805d616cbc88b54ce02f556abaa2bc7148b1e401ec6d",
  holdoutBEvents: "cf46b0ccad40b4ba84300e70c78438d943a96d8d1bc6adcc15bfdf8d85dd7433",
} as const;
const EXPECTED_PRIMARY_COUNTS = {
  allEvents: 29090,
  primaryOosEvents: 19160,
  holdoutAEvents: 6212,
  holdoutBEvents: 3718,
  primaryClusters: 16532,
} as const;
const EXPECTED_EVENT_AUDIT_SHA = "305b0d897e86031e742e9f6c3bddadc363806f35ee4a6cb956698d38cfcfe785";
const EXPECTED_PRIMARY_IDENTITY_ARTIFACT_SHA = "505e5481a66711d974b83b3252429181c4c3b2efcdb73a785edf61fe00c636b8";
const EXPECTED_PRIOR_EVIDENCE_LOCK_SHA = "021aa5bf9a34df978784ef0473272b39a53c9da128a95ff685a3150f41a74872";
const SOURCE_FILES = [
  "lib/v21/controls.ts",
  "lib/v21/result-evaluator.ts",
  "scripts/run-v21-freeze.ts",
  "scripts/validate-v21-freeze.ts",
  "tests/v21-controls.test.ts",
  "tests/v21-result-evaluator.test.ts",
] as const;
const FORBIDDEN_RESULT_ARTIFACTS = [
  "reports/v21-primary-oos.json",
  "reports/v21-holdout-results.json",
  "reports/v21-performance.json",
  "reports/v21-result.json",
  "reports/v21-promotion-decision.json",
  "reports/v21-promotion-decision.md",
] as const;

async function main(): Promise<void> {
  assertPreFreezeHead();
  await mkdir(REPORT_DIR, { recursive: true });
  for (const path of FORBIDDEN_RESULT_ARTIFACTS) {
    if (await exists(resolve(path))) throw new Error(`WP3B forbids existing result artifact: ${path}`);
  }

  const primaryReport = await readJson("v21-event-enumeration.json");
  const primaryIdentities = await readJson("v21-event-identities.json") as {
    allEvents: V21EventIdentity[];
    primaryOosEvents: V21EventIdentity[];
    holdoutAEvents: V21EventIdentity[];
    holdoutBEvents: V21EventIdentity[];
  };
  assertPrimaryIdentityLock(primaryReport, primaryIdentities);

  const input = await loadVerifiedPITInput();
  const controls = enumerateV21Controls(input, primaryIdentities.allEvents);
  const controlIdentityDigests = {} as Record<V21ControlName, Record<string, string>>;
  const controlIdentityPayload = {} as Record<V21ControlName, Record<string, unknown>>;
  for (const name of ["RAW_RETURN_REVERSAL", "SIMPLE_MEDIAN_GAP_REVERSAL", "TIME_MATCHED_RANDOM"] as const) {
    const result = controls[name];
    const allEvents = result.allEvents;
    const primaryOosEvents = result.primaryOosEvents;
    const holdoutAEvents = result.holdoutAEvents;
    const holdoutBEvents = result.holdoutBEvents;
    const digests = {
      allEvents: sha256(allEvents),
      primaryOosEvents: sha256(primaryOosEvents),
      holdoutAEvents: sha256(holdoutAEvents),
      holdoutBEvents: sha256(holdoutBEvents),
    };
    controlIdentityDigests[name] = digests;
    controlIdentityPayload[name] = {
      allEvents,
      primaryOosEvents,
      holdoutAEvents,
      holdoutBEvents,
      digests,
      counts: {
        all: allEvents.length,
        primary: primaryOosEvents.length,
        holdoutA: holdoutAEvents.length,
        holdoutB: holdoutBEvents.length,
      },
    };
  }

  const controlIdentities = {
    schemaVersion: "v21-control-identities-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    approvedWp3a1Commit: APPROVED_WP3A1_COMMIT,
    source: "verified synchronized 5m return-feature timeline; identity payload only",
    identityFields: ["symbol", "signalOpenTime", "direction", "clusterId"],
    noOutcomeFields: true,
    ordering: "signalOpenTime ascending, symbol alphabetical",
    controls: controlIdentityPayload,
  };
  await writeJson("v21-control-identities.json", controlIdentities);

  const controlAudit = {
    schemaVersion: "v21-control-audit-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    approvedWp3a1Commit: APPROVED_WP3A1_COMMIT,
    source: "pre-return control predicates only; no entry, exit, future price, or outcome reads",
    noOutcomeFields: true,
    controls: Object.fromEntries(Object.entries(controls).map(([name, result]) => [name, {
      auditRows: result.auditRows,
      counts: {
        auditRows: result.auditRows.length,
        acceptedEvents: result.allEvents.length,
        primary: result.primaryOosEvents.length,
        holdoutA: result.holdoutAEvents.length,
        holdoutB: result.holdoutBEvents.length,
      },
      diagnostics: result.diagnostics,
      identityDigests: controlIdentityDigests[name as V21ControlName],
    }])),
  };
  await writeJson("v21-control-audit.json", controlAudit);
  const controlAuditSha256 = await reportHash("v21-control-audit.json");
  const controlIdentitySha256 = await reportHash("v21-control-identities.json");

  const controlEnumeration = {
    schemaVersion: "v21-control-enumeration-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    approvedWp3a1Commit: APPROVED_WP3A1_COMMIT,
    source: {
      exchange: "BINANCE_DATA_VISION",
      immutableArchiveCache: true,
      synchronizedReturnRows: input.openTimes.length,
      featureInput: "r_i,t = ln(close_i,t / close_i,t-1); current and prior PIT feature values only",
    },
    controlsEnumeratedAtWp3A: false,
    controlsEnumerated: true,
    definitions: controlDefinitions(),
    timeMatchedRandom: {
      seed: V21_TIME_MATCHED_RANDOM_SEED,
    algorithm: `derive seed from seed + symbol|YYYY-MM|UTC-hour|direction; ${V21_TIME_MATCHED_RANDOM_ALGORITHM}`,
      oneToOneTargetMatching: true,
      matchFields: ["symbol", "calendar YYYY-MM", "UTC hour", "direction"],
      excludesV21SameSymbolTimestamp: true,
      duplicateFree: true,
      sameSymbol30mNonOverlap: true,
    },
    diagnostics: Object.fromEntries(Object.entries(controls).map(([name, result]) => [name, result.diagnostics])),
    identityDigests: controlIdentityDigests,
    controlIdentitiesSha256: controlIdentitySha256,
    controlAuditSha256,
    historicalSignalFeatureReturnsRead: true,
    historicalStrategyOutcomeReturnsRead: false,
    realOutcomePricesRead: false,
    forwardReturnsRead: false,
    nextBarOpenRead: false,
    futurePriceRead: false,
    executionEvaluated: false,
    promotionEvaluated: false,
  };
  await writeJson("v21-control-enumeration.json", controlEnumeration);

  const resultContract = {
    schemaVersion: "v21-result-contract-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    approvedWp3a1Commit: APPROVED_WP3A1_COMMIT,
    contractOnly: true,
    realOutcomeEvaluationPerformed: false,
    execution: V21_EXECUTION_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    evaluator: {
      source: "lib/v21/result-evaluator.ts",
      pureDeterministic: true,
      network: false,
      productionDependencies: false,
      realV21PricesCalledInWp3B: false,
    },
  };
  await writeJson("v21-result-contract.json", resultContract);
  const resultContractSha256 = await reportHash("v21-result-contract.json");

  const sourceHashes = await hashSources();
  const freezeBundle = {
    primaryEventDigests: EXPECTED_PRIMARY_EVENT_DIGESTS,
    primaryEventAuditSha256: EXPECTED_EVENT_AUDIT_SHA,
    priorEvidenceLockSha256: EXPECTED_PRIOR_EVIDENCE_LOCK_SHA,
    controlIdentityDigests,
    controlAuditSha256,
    execution: V21_EXECUTION_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: sourceHashes["lib/v21/result-evaluator.ts"],
  };
  const freezeBundleSha256 = sha256(freezeBundle);
  const flags = {
    historicalSignalFeatureReturnsRead: true,
    controlsEnumerated: true,
    controlsEnumeratedAtWp3A: false,
    historicalStrategyOutcomeReturnsRead: false,
    realOutcomePricesRead: false,
    nextBarOpenRead: false,
    futurePriceRead: false,
    forwardReturnsRead: false,
    executionEvaluated: false,
    oosMetricsRead: false,
    holdoutOutcomeRead: false,
    holdoutRead: false,
    promotionEvaluated: false,
    parameterSearch: false,
    freezeCreated: true,
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
  } as const;
  const freezeManifestBody = {
    schemaVersion: "v21-freeze-manifest-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    approvedWp3a1Commit: APPROVED_WP3A1_COMMIT,
    approvedWp3a1DirectParent: "d36e6fc606e47ab4cb56d4b8ce4adb26abbccbcc",
    fixedSymbols: V21_SYMBOLS,
    period: {
      start: V21_START_TIMESTAMP,
      endExclusive: V21_END_EXCLUSIVE_TIMESTAMP,
    },
    primaryEventDigests: EXPECTED_PRIMARY_EVENT_DIGESTS,
    primaryCounts: EXPECTED_PRIMARY_COUNTS,
    primaryEventAuditSha256: EXPECTED_EVENT_AUDIT_SHA,
    priorStageEvidenceLockSha256: EXPECTED_PRIOR_EVIDENCE_LOCK_SHA,
    controls: {
      definitions: controlDefinitions(),
      identityDigests: controlIdentityDigests,
      identityArtifactSha256: controlIdentitySha256,
      auditSha256: controlAuditSha256,
      enumerationArtifactSha256: await reportHash("v21-control-enumeration.json"),
    },
    resultContractSha256,
    execution: V21_EXECUTION_CONTRACT,
    horizons: V21_EXECUTION_CONTRACT.horizons,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: sourceHashes["lib/v21/result-evaluator.ts"],
    resultEvaluatorTestsSha256: sourceHashes["tests/v21-result-evaluator.test.ts"],
    freezeValidatorSha256: sourceHashes["scripts/validate-v21-freeze.ts"],
    sourceHashes,
    flags,
    ...flags,
    freezeBundle,
    freezeBundleSha256,
  };
  await writeJson("v21-freeze-manifest.json", {
    ...freezeManifestBody,
    manifestBodySha256: sha256(freezeManifestBody),
  });

  console.info("V21 WP3B pre-return freeze artifacts written");
  console.info(`V21 WP3B freeze bundle: ${freezeBundleSha256}`);
}

function controlDefinitions(): Record<string, unknown> {
  return {
    RAW_RETURN_REVERSAL: {
      feature: "x_i,t = r_i,t = ln(close_i,t / close_i,t-1)",
      pitWindow: "[t-30d,t)",
      pitObservations: 8640,
      threshold: "nearest-rank Q99 of abs(prior raw returns)",
      q99Rank: 8554,
      firstCross: "abs(previous) < current-t threshold AND abs(current) >= current-t threshold",
      direction: "positive SHORT; negative LONG; zero ineligible",
      overlap: "same-symbol timestamp-only 30m; different symbols may be simultaneous",
    },
    SIMPLE_MEDIAN_GAP_REVERSAL: {
      feature: "g_i,t = r_i,t - median(other seven returns at t)",
      pitWindow: "[t-30d,t)",
      pitObservations: 8640,
      threshold: "nearest-rank Q99 of abs(prior median gaps)",
      q99Rank: 8554,
      firstCross: "abs(previous) < current-t threshold AND abs(current) >= current-t threshold",
      direction: "positive SHORT; negative LONG; zero ineligible",
      ols: false,
      overlap: "same-symbol timestamp-only 30m; different symbols may be simultaneous",
    },
    TIME_MATCHED_RANDOM: {
      role: "placebo diagnostic only; not a promotion gate",
      seed: V21_TIME_MATCHED_RANDOM_SEED,
      matching: "one placebo per accepted V21 event by symbol, YYYY-MM, UTC hour, and direction",
      candidateTimeline: "synchronized historical 5m open timestamps from 2022-01-01 inclusive to 2026-08-01 exclusive",
      selection: V21_TIME_MATCHED_RANDOM_ALGORITHM,
      exclusions: ["same-symbol V21 accepted timestamp", "duplicate symbol/timestamp", "same-symbol 30m overlap"],
    },
  };
}

async function loadVerifiedPITInput(): Promise<V21SynchronizedReturnMatrix> {
  const expectedCloseRows = V21_EXPECTED_ROWS_PER_SYMBOL;
  const returnRows = expectedCloseRows - 1;
  const start = Date.parse(V21_START_TIMESTAMP);
  const openTimes = new Float64Array(returnRows);
  for (let index = 0; index < returnRows; index += 1) openTimes[index] = start + (index + 1) * 5 * 60 * 1000;
  const returnsBySymbol = {} as Record<(typeof V21_SYMBOLS)[number], Float64Array>;
  for (const symbol of V21_SYMBOLS) {
    const closes = new Float64Array(expectedCloseRows);
    let filled = 0;
    for (const month of v21MonthKeys()) {
      const result = await downloadAndParseV21Archive(symbol, month, {
        rootDir: V21_ARCHIVE_ROOT,
        fetchImpl: noNetworkFetch,
      });
      if (result.slot.status !== "VERIFIED" || !result.slot.checksumVerified || result.bars.length !== result.slot.expectedMonthRows) {
        throw new Error(`Immutable V21 archive cache is not verified for ${symbol}/${month}`);
      }
      for (const bar of result.bars) {
        const offset = (bar.openTime - start) / (5 * 60 * 1000);
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
    for (let index = 1; index < closes.length; index += 1) values[index - 1] = Math.log(closes[index] / closes[index - 1]);
    returnsBySymbol[symbol] = values;
    console.info(`Loaded verified pre-return PIT input: ${symbol} (${filled} closed bars)`);
  }
  return { openTimes, returnsBySymbol };
}

const noNetworkFetch: typeof fetch = async () => {
  throw new Error("V21 WP3B forbids archive/API backfill; required immutable cache file is missing");
};

function assertPrimaryIdentityLock(
  report: any,
  identities: {
    allEvents: V21EventIdentity[];
    primaryOosEvents: V21EventIdentity[];
    holdoutAEvents: V21EventIdentity[];
    holdoutBEvents: V21EventIdentity[];
  },
): void {
  assertEqual(report.eventDigests, EXPECTED_PRIMARY_EVENT_DIGESTS, "WP3A event digests");
  assertEqual(report.diagnostics.finalEligibleEvents, EXPECTED_PRIMARY_COUNTS.allEvents, "WP3A final count");
  assertEqual(report.diagnostics.eventsByPeriod.primaryOos, EXPECTED_PRIMARY_COUNTS.primaryOosEvents, "WP3A primary count");
  assertEqual(report.diagnostics.eventsByPeriod.holdoutA, EXPECTED_PRIMARY_COUNTS.holdoutAEvents, "WP3A holdout A count");
  assertEqual(report.diagnostics.eventsByPeriod.holdoutB, EXPECTED_PRIMARY_COUNTS.holdoutBEvents, "WP3A holdout B count");
  assertEqual(new Set(identities.primaryOosEvents.map((event) => event.clusterId)).size, EXPECTED_PRIMARY_COUNTS.primaryClusters, "WP3A cluster count");
  assertEqual(identities.allEvents.length, EXPECTED_PRIMARY_COUNTS.allEvents, "identity all count");
  assertEqual(identities.primaryOosEvents.length, EXPECTED_PRIMARY_COUNTS.primaryOosEvents, "identity primary count");
  assertEqual(identities.holdoutAEvents.length, EXPECTED_PRIMARY_COUNTS.holdoutAEvents, "identity holdout A count");
  assertEqual(identities.holdoutBEvents.length, EXPECTED_PRIMARY_COUNTS.holdoutBEvents, "identity holdout B count");
  assertEqual(report.identityArtifactSha256, EXPECTED_PRIMARY_IDENTITY_ARTIFACT_SHA, "WP3A identity artifact hash");
  assert(report.historicalSignalFeatureReturnsRead === true, "WP3A signal feature boundary");
  assert(report.historicalStrategyOutcomeReturnsRead === false, "WP3A outcome boundary");
  assert(report.forwardReturnsRead === false, "WP3A forward boundary");
  assert(report.nextBarOpenRead === false, "WP3A entry boundary");
  assert(report.futurePriceRead === false, "WP3A future price boundary");
  assert(report.holdoutOutcomeRead === false, "WP3A holdout boundary");
  assert(report.executionEvaluated === false, "WP3A execution boundary");
  assert(report.oosMetricsRead === false, "WP3A OOS boundary");
  assert(report.parameterSearch === false, "WP3A search boundary");
  assert(report.controlsEnumerated === false, "WP3A control boundary");
}

function assertPreFreezeHead(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== V21_BRANCH) throw new Error(`V21 WP3B requires ${V21_BRANCH}, got ${branch}`);
  if (head !== APPROVED_WP3A1_COMMIT) throw new Error(`V21 WP3B requires exact WP3A.1 ${APPROVED_WP3A1_COMMIT}, got ${head}`);
}

async function hashSources(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const source of SOURCE_FILES) hashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  return hashes;
}

async function reportHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`V21 WP3B freeze failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`V21 WP3B freeze failed: ${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
