import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_FORBIDDEN_PATHS,
  V21_INTERVAL_MS,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256, sha256Bytes } from "../lib/v21/canonical";
import {
  V21_EVENT_END_EXCLUSIVE,
  V21_HOLDOUT_A_START,
  V21_HOLDOUT_B_START,
  V21_PRIMARY_HORIZON_MS,
  V21_PRIMARY_OOS_START,
  v21AuditIdentityPayload,
  v21EventIdentityPayload,
  type V21EventIdentity,
  type V21PreReturnAudit,
} from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const PARENT_COMMIT = "e8721d509d574cc2697e3fff75ba7f5f4b86d99a";
const REQUIRED_REPORTS = [
  "v21-event-enumeration.json",
  "v21-event-identities.json",
  "v21-event-stage-manifest.json",
  "v21-event-audit.json",
  "v21-prior-stage-evidence-lock.json",
] as const;
const REQUIRED_SOURCE_FILES = [
  "lib/v21/events.ts",
  "scripts/run-v21-event-stage.ts",
  "scripts/validate-v21-events.ts",
  "tests/v21-events.test.ts",
  "package.json",
] as const;
const EVENT_SCANNER_FILES = [
  "lib/v21/events.ts",
  "scripts/run-v21-event-stage.ts",
] as const;
const EXPECTED_DIAGNOSTICS = {
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
} as const;
const EXPECTED_EVENT_DIGESTS = {
  allEvents: "a8435418f6007dd6a25a20d1a292fabd5cdfaa84f7cc7d713a617ed375ebec4b",
  primaryOosEvents: "621607df1f34fbb378ec938a5808ca27de17918dda498433da396e73e02d840c",
  holdoutAEvents: "fda762168a03429660b9805d616cbc88b54ce02f556abaa2bc7148b1e401ec6d",
  holdoutBEvents: "cf46b0ccad40b4ba84300e70c78438d943a96d8d1bc6adcc15bfdf8d85dd7433",
} as const;
const EXPECTED_PRIOR_STAGE_EVIDENCE = [
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
const FORBIDDEN_RESULT_KEYS = new Set([
  "grossreturn",
  "netreturn",
  "pnl",
  "win",
  "loss",
  "winrate",
  "profitfactor",
  "pf",
  "avgr",
  "avgnetr",
  "maxdd",
  "cvar",
  "fee",
  "slippage",
  "stress",
  "bootstrap",
  "lcb",
  "promotiondecision",
  "controlreturns",
]);

async function main(): Promise<void> {
  runDependencyValidators();
  for (const name of REQUIRED_REPORTS) assert(existsSync(resolve(REPORT_DIR, name)), `missing ${name}`);
  const report = await readJson("v21-event-enumeration.json");
  const identities = await readJson("v21-event-identities.json");
  const manifest = await readJson("v21-event-stage-manifest.json");
  const audit = await readJson("v21-event-audit.json");
  const priorEvidenceLock = await readJson("v21-prior-stage-evidence-lock.json");

  assertEqual(report.schemaVersion, "v21-event-enumeration-v1", "report schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "report experiment");
  assertEqual(report.repository, "SengC-it/Binance-Crypto-Alerts", "report repository");
  assertEqual(report.branch, V21_BRANCH, "report branch");
  assertEqual(report.baseResearchSha, V21_BASE_SHA, "report base");
  assertEqual(report.approvedParentCommit, PARENT_COMMIT, "report parent");
  assertEqual(report.source.exchange, "BINANCE_DATA_VISION", "report exchange");
  assertEqual(report.source.immutableArchiveCache, true, "immutable archive cache");
  assertEqual(report.source.dataGateSha256, await reportHash("v21-data-gate.json"), "data gate hash");
  assertEqual(report.period.endExclusive, V21_END_EXCLUSIVE_TIMESTAMP, "period end");
  assertEqual(report.fixedSymbols, V21_SYMBOLS, "fixed symbols");
  assertEqual(report.featureDefinition.pitObservationCount, 8640, "PIT observation count");
  assertEqual(report.eventDefinition.primaryHorizon, "30m timestamp-only", "primary horizon");
  assertEqual(report.eventDefinition.clusterId, "signalOpenTime", "cluster identity");
  assertEqual(report.controlsEnumerated, false, "controls not enumerated");
  assertEqual(report.historicalSignalFeatureReturnsRead, true, "signal feature return boundary");
  assertEqual(report.historicalReturnsRead, undefined, "ambiguous historical return boundary removed");
  assertEqual(report.historicalStrategyOutcomeReturnsRead, false, "strategy outcome boundary");
  assertEqual(report.forwardReturnsRead, false, "forward data boundary");
  assertEqual(report.nextBarOpenRead, false, "next-bar boundary");
  assertEqual(report.futurePriceRead, false, "future price boundary");
  assertEqual(report.holdoutOutcomeRead, false, "holdout outcome boundary");
  assertEqual(report.oosMetricsRead, false, "OOS metrics boundary");
  assertEqual(report.holdoutRead, false, "holdout metrics boundary");
  assertEqual(report.parameterSearch, false, "parameter search boundary");
  assertEqual(report.executionEvaluated, false, "execution boundary");
  assertEqual(report.freezeCreated, false, "freeze boundary");
  assertEqual(report.resultCommitCreated, false, "result boundary");
  assertEqual(report.futureDataRead, false, "future data boundary");
  assertEqual(report.noFutureBarsUsed, true, "future-bar firewall");
  assertEqual(report.productionChanged, false, "production boundary");
  assertEqual(report.productionEmail, "OFF", "email boundary");
  assertEqual(report.deploy, false, "deploy boundary");
  assertEqual(report.merge, false, "merge boundary");
  assertEqual(report.migration, false, "migration boundary");
  assertEqual(report.autoTrading, false, "trading boundary");
  assertEqual(report.diagnostics, EXPECTED_DIAGNOSTICS, "WP3A diagnostics unchanged");
  assertEqual(report.eventDigests, EXPECTED_EVENT_DIGESTS, "WP3A event digests unchanged");

  assertEqual(identities.schemaVersion, "v21-event-identities-v1", "identity schema");
  assertEqual(identities.experimentId, V21_EXPERIMENT_ID, "identity experiment");
  assertEqual(identities.fixedSymbols === undefined, true, "identity payload has no extra data");
  for (const name of ["allEvents", "primaryOosEvents", "holdoutAEvents", "holdoutBEvents"] as const) {
    assertIdentityPayload(identities[name], name);
    assertEqual(report.eventDigests[name], sha256(identities[name]), name + " digest");
  }
  assertEqual(report.identityArtifactSha256, await reportHash("v21-event-identities.json"), "identity artifact hash");
  assertEqual(report.diagnostics.finalEligibleEvents, identities.allEvents.length, "final event count");
  assertEqual(report.diagnostics.eventsByPeriod.primaryOos, identities.primaryOosEvents.length, "primary count");
  assertEqual(report.diagnostics.eventsByPeriod.holdoutA, identities.holdoutAEvents.length, "holdout A count");
  assertEqual(report.diagnostics.eventsByPeriod.holdoutB, identities.holdoutBEvents.length, "holdout B count");
  assertEqual(report.diagnostics.distinctPrimarySignalClusters, new Set(identities.primaryOosEvents.map((event: V21EventIdentity) => event.clusterId)).size, "primary cluster count");
  assertOverlap(identities.allEvents);
  assertEqual(identities.allEvents.length, identities.primaryOosEvents.length + identities.holdoutAEvents.length + identities.holdoutBEvents.length, "period partition");
  assertSampleGate(report);
  assertNoResultKeys(report, "report");
  assertNoResultKeys(identities, "identities");
  assertAudit(audit, identities, report);
  assertNoResultKeys(audit, "audit");
  assertPriorStageEvidenceLock(priorEvidenceLock);
  assertNoResultKeys(priorEvidenceLock, "prior evidence lock");
  await assertEventScannerFirewall();

  assertEqual(manifest.schemaVersion, "v21-event-stage-manifest-v1", "manifest schema");
  assertEqual(manifest.experimentId, V21_EXPERIMENT_ID, "manifest experiment");
  assertEqual(manifest.repository, "SengC-it/Binance-Crypto-Alerts", "manifest repository");
  assertEqual(manifest.branch, V21_BRANCH, "manifest branch");
  assertEqual(manifest.baseResearchSha, V21_BASE_SHA, "manifest base");
  assertEqual(manifest.approvedParentCommit, PARENT_COMMIT, "manifest parent");
  assertEqual(manifest.fixedSymbols, V21_SYMBOLS, "manifest symbols");
  assertEqual(manifest.sourceReports.eventEnumerationSha256, await reportHash("v21-event-enumeration.json"), "event report hash");
  assertEqual(manifest.sourceReports.eventIdentitiesSha256, await reportHash("v21-event-identities.json"), "identity report hash");
  assertEqual(manifest.sourceReports.eventAuditSha256, await reportHash("v21-event-audit.json"), "event audit hash");
  assertEqual(manifest.sourceReports.priorStageEvidenceLockSha256, await reportHash("v21-prior-stage-evidence-lock.json"), "prior evidence lock hash");
  assertEqual(manifest.eventDigests, report.eventDigests, "manifest digests");
  assertEqual(manifest.classification, report.classification, "manifest classification");
  assertEqual(manifest.researchStop, report.researchStop, "manifest stop status");
  assertEqual(manifest.flags.realHistoricalDataScanned, true, "real scan flag");
  assertEqual(manifest.flags.historicalEventScanRun, true, "event scan flag");
  assertEqual(manifest.flags.signalsEnumerated, true, "signal identity flag");
  assertEqual(manifest.flags.firstCrossEnumerated, true, "first cross flag");
  assertEqual(manifest.flags.directionsAssigned, true, "direction flag");
  for (const key of [
    "executionEvaluated",
    "historicalStrategyOutcomeReturnsRead",
    "forwardReturnsRead",
    "nextBarOpenRead",
    "futurePriceRead",
    "holdoutOutcomeRead",
    "oosMetricsRead",
    "holdoutRead",
    "parameterSearch",
    "freezeCreated",
    "resultCommitCreated",
    "productionChanged",
    "deploy",
    "merge",
    "migration",
    "privateBinanceApi",
    "orderPlacement",
    "autoTrading",
    "automaticPromotion",
  ]) assertEqual(manifest.flags[key], false, "manifest boundary " + key);
  assertEqual(manifest.flags.historicalSignalFeatureReturnsRead, true, "manifest signal feature return boundary");
  assertEqual(manifest.flags.historicalReturnsRead, undefined, "manifest ambiguous return boundary removed");
  assertEqual(manifest.flags.productionEmail, "OFF", "manifest email boundary");
  assertEqual(manifest.manifestBodySha256, sha256(withoutKey(manifest, "manifestBodySha256")), "manifest body hash");
  for (const source of REQUIRED_SOURCE_FILES) {
    assertEqual(manifest.sourceHashes[source], await fileHash(source), source + " source hash");
  }

  const reportNames = await readdir(REPORT_DIR);
  const allowedV21Reports = new Set([
    "v21-archive-manifest.json",
    "v21-parser-report.json",
    "v21-data-gate.json",
    "v21-data-stage-manifest.json",
    "v21-feature-stage-manifest.json",
    "v21-scan-feasibility.json",
    "v21-scan-stage-manifest.json",
    "v21-event-predicate-feasibility.json",
    "v21-event-predicate-stage-manifest.json",
    ...REQUIRED_REPORTS,
  ]);
  const unexpected = reportNames.filter((name) => name.startsWith("v21-") && !allowedV21Reports.has(name));
  assertEqual(unexpected, [], "unexpected V21 report artifacts");
  for (const forbidden of V21_FORBIDDEN_PATHS) assert(!existsSync(resolve(forbidden)), "forbidden result artifact: " + forbidden);
  console.info("V21 WP3A event validation PASS");
}

function runDependencyValidators(): void {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const scriptName of [
    "validate:v21:data",
    "validate:v21:features",
    "validate:v21:feature-scan",
    "validate:v21:event-predicate",
  ]) {
    try {
      execFileSync(executable, [scriptName], {
        shell: process.platform === "win32",
        stdio: "inherit",
      });
    } catch (error) {
      throw new Error(`V21 WP3A dependency validation failed: ${scriptName}: ${String(error)}`);
    }
  }
}

function assertAudit(audit: any, identities: any, report: any): void {
  assertEqual(audit.schemaVersion, "v21-event-audit-v1", "audit schema");
  assertEqual(audit.experimentId, V21_EXPERIMENT_ID, "audit experiment");
  assertEqual(audit.repository, "SengC-it/Binance-Crypto-Alerts", "audit repository");
  assertEqual(audit.branch, V21_BRANCH, "audit branch");
  assertEqual(audit.baseResearchSha, V21_BASE_SHA, "audit base");
  assertEqual(audit.approvedParentCommit, PARENT_COMMIT, "audit parent");
  assertEqual(audit.identityFields, ["symbol", "signalOpenTime", "direction", "clusterId"], "audit identity fields");
  assertEqual(audit.noOutcomeFields, true, "audit outcome boundary");
  assert(Array.isArray(audit.auditRows), "audit rows must be an array");
  const rows = audit.auditRows as V21PreReturnAudit[];
  const expectedKeys = [
    "symbol",
    "signalOpenTime",
    "signalCloseTime",
    "signalTimestamp",
    "direction",
    "assetReturn",
    "marketReturn",
    "alpha",
    "beta",
    "previousResidual",
    "currentResidual",
    "residualAbsQ99",
    "clusterId",
    "eligibilityStatus",
    "overlapStatus",
  ];
  let previousSortKey: [number, string] | null = null;
  for (const row of rows) {
    assert(row && typeof row === "object", "audit row object");
    assertEqual(Object.keys(row), expectedKeys, "audit row fields");
    assert((V21_SYMBOLS as readonly string[]).includes(row.symbol), "audit symbol");
    assert(Number.isSafeInteger(row.signalOpenTime), "audit signal timestamp");
    assertEqual(row.signalCloseTime, row.signalOpenTime + V21_INTERVAL_MS, "audit signal close");
    assertEqual(row.signalTimestamp, row.signalCloseTime, "audit signal timestamp semantics");
    assert(Number.isSafeInteger(row.clusterId), "audit cluster");
    assertEqual(row.clusterId, row.signalOpenTime, "audit cluster identity");
    for (const key of [
      "assetReturn",
      "marketReturn",
      "alpha",
      "beta",
      "previousResidual",
      "currentResidual",
      "residualAbsQ99",
    ] as const) assert(Number.isFinite(row[key]), `audit finite ${key}`);
    assert(row.residualAbsQ99 >= 0, "audit Q99 non-negative");
    assert(row.overlapStatus === "ACCEPTED" || row.overlapStatus === "OVERLAPPING_SIGNAL_EXCLUDED", "audit overlap status");
    if (row.currentResidual === 0) {
      assertEqual(row.direction, null, "zero residual direction");
      assertEqual(row.eligibilityStatus, "ZERO_RESIDUAL_INELIGIBLE", "zero residual marker");
    } else {
      assert(row.direction === "LONG" || row.direction === "SHORT", "audit direction");
      assertEqual(row.eligibilityStatus, "ELIGIBLE", "audit eligibility");
      assertEqual(row.direction, row.currentResidual > 0 ? "SHORT" : "LONG", "audit direction sign");
    }
    const sortKey: [number, string] = [row.signalOpenTime, row.symbol];
    if (previousSortKey !== null) {
      assert(sortKey[0] > previousSortKey[0]
        || (sortKey[0] === previousSortKey[0] && sortKey[1] >= previousSortKey[1]), "audit ordering");
    }
    previousSortKey = sortKey;
  }

  const accepted = rows.filter((row) => row.overlapStatus === "ACCEPTED" && row.eligibilityStatus === "ELIGIBLE");
  const overlapExcluded = rows.filter((row) => row.overlapStatus === "OVERLAPPING_SIGNAL_EXCLUDED");
  const zeroResidual = rows.filter((row) => row.eligibilityStatus === "ZERO_RESIDUAL_INELIGIBLE");
  assertEqual(rows.length, report.diagnostics.firstCrossCandidates, "audit candidate count");
  assertEqual(accepted.length, report.diagnostics.finalEligibleEvents, "audit accepted count");
  assertEqual(overlapExcluded.length, report.diagnostics.overlapExcluded, "audit overlap count");
  assertEqual(zeroResidual.length, report.diagnostics.zeroResidualFirstCrossCandidates, "audit zero count");
  assertEqual(audit.counts, {
    auditRows: rows.length,
    accepted: accepted.length,
    overlapExcluded: overlapExcluded.length,
    zeroResidualIneligible: zeroResidual.length,
  }, "audit counts");

  const projected = v21EventIdentityPayload(accepted.map((row) => ({
    symbol: row.symbol,
    signalOpenTime: row.signalOpenTime,
    direction: row.direction as V21EventIdentity["direction"],
    clusterId: row.clusterId,
  })));
  assertEqual(projected, identities.allEvents, "audit to identity projection");
  assertEqual(v21AuditIdentityPayload(rows), identities.allEvents, "audit helper projection");
  assertEqual(audit.projectedIdentityDigests, report.eventDigests, "audit projected digests");
}

function assertPriorStageEvidenceLock(lock: any): void {
  assertEqual(lock.schemaVersion, "v21-prior-stage-evidence-lock-v1", "prior evidence lock schema");
  assertEqual(lock.experimentId, V21_EXPERIMENT_ID, "prior evidence lock experiment");
  assertEqual(lock.repository, "SengC-it/Binance-Crypto-Alerts", "prior evidence lock repository");
  assert(Array.isArray(lock.stages), "prior evidence lock stages");
  assertEqual(lock.stages.length, EXPECTED_PRIOR_STAGE_EVIDENCE.length, "prior evidence lock stage count");
  for (let stageIndex = 0; stageIndex < EXPECTED_PRIOR_STAGE_EVIDENCE.length; stageIndex += 1) {
    const expected = EXPECTED_PRIOR_STAGE_EVIDENCE[stageIndex];
    const actual = lock.stages[stageIndex];
    assertEqual(actual.stage, expected.stage, `${expected.stage} lock stage`);
    assertEqual(actual.commit, expected.commit, `${expected.stage} lock commit`);
    assertEqual(actual.files.map((file: { path: string }) => file.path), expected.paths, `${expected.stage} lock paths`);
    for (const file of actual.files as Array<Record<string, string>>) {
      const revision = `${actual.commit}:${file.path}`;
      const gitBlobSha = execFileSync("git", ["rev-parse", revision], { encoding: "utf8" }).trim();
      assertEqual(file.gitBlobSha, gitBlobSha, `${revision} Git blob`);
      const bytes = execFileSync("git", ["cat-file", "blob", gitBlobSha], { maxBuffer: 64 * 1024 * 1024 });
      assertEqual(file.rawSha256, sha256Bytes(bytes), `${revision} raw hash`);
      assertEqual(file.canonicalTextSha256, canonicalTextSha256(new TextDecoder().decode(bytes)), `${revision} canonical hash`);
    }
  }
}

async function assertEventScannerFirewall(): Promise<void> {
  for (const file of EVENT_SCANNER_FILES) {
    const source = await readFile(resolve(file), "utf8");
    assert(!/currentIndex\s*\+\s*1/.test(source), `${file} reads future index`);
    assert(!/\b(?:entryOpen|entryClose|exitClose|futureHigh|futureLow|grossReturn|netReturn|PnL)\b/.test(source), `${file} contains future/outcome field`);
  }
  const eventSource = await readFile(resolve("lib/v21/events.ts"), "utf8");
  assert(eventSource.includes("currentIndex - 1"), "event scanner must use current and prior row");
  assert(eventSource.includes("currentIndex - V21_PIT_OBSERVATION_COUNT"), "event scanner prior PIT window");
}

function assertIdentityPayload(value: unknown, name: string): asserts value is V21EventIdentity[] {
  assert(Array.isArray(value), name + " must be an array");
  for (const event of value) {
    assert(event && typeof event === "object", name + " event must be an object");
    assertEqual(Object.keys(event), ["symbol", "signalOpenTime", "direction", "clusterId"], name + " identity fields");
    assert((V21_SYMBOLS as readonly string[]).includes((event as V21EventIdentity).symbol), name + " symbol");
    assert(Number.isSafeInteger((event as V21EventIdentity).signalOpenTime), name + " timestamp");
    assert((event as V21EventIdentity).direction === "LONG" || (event as V21EventIdentity).direction === "SHORT", name + " direction");
    assertEqual((event as V21EventIdentity).clusterId, (event as V21EventIdentity).signalOpenTime, name + " cluster");
  }
  const sorted = v21EventIdentityPayload(value);
  assertEqual(value, sorted, name + " ordering");
}

function assertOverlap(events: readonly V21EventIdentity[]): void {
  const lastBySymbol = new Map<string, number>();
  for (const event of events) {
    const last = lastBySymbol.get(event.symbol);
    if (last !== undefined) assert(event.signalOpenTime >= last + V21_PRIMARY_HORIZON_MS, "same-symbol overlap");
    lastBySymbol.set(event.symbol, event.signalOpenTime);
  }
}

function assertSampleGate(report: any): void {
  const gate = report.primarySampleGate;
  const passed = gate.primaryEvents >= gate.minimumPrimaryEvents
    && gate.primaryClusters >= gate.minimumPrimaryClusters
    && Object.values(gate.eventsBySymbol).every((count) => Number(count) >= gate.minimumEventsPerFixedSymbol);
  assertEqual(report.classification, passed ? "V21_PRE_RETURN_SAMPLE_GATE_PASS" : "V21_PRE_RETURN_SAMPLE_INSUFFICIENT", "sample classification");
  assertEqual(report.researchStop, !passed, "sample stop status");
}

function assertNoResultKeys(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    assert(!FORBIDDEN_RESULT_KEYS.has(normalized), `${path}.${key} is outside WP3A`);
    assertNoResultKeys(nested, `${path}.${key}`);
  }
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

async function reportHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function fileHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(name), "utf8"));
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("V21 WP3A event validation failed: " + message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("V21 WP3A event validation failed: " + message + "; expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

void V21_EVENT_END_EXCLUSIVE;
void V21_HOLDOUT_A_START;
void V21_HOLDOUT_B_START;
void V21_PRIMARY_OOS_START;

void main();
