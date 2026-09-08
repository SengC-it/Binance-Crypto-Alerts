import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_FORBIDDEN_PATHS,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import {
  V21_EVENT_END_EXCLUSIVE,
  V21_HOLDOUT_A_START,
  V21_HOLDOUT_B_START,
  V21_PRIMARY_HORIZON_MS,
  V21_PRIMARY_OOS_START,
  v21EventIdentityPayload,
  type V21EventIdentity,
} from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const PARENT_COMMIT = "e8721d509d574cc2697e3fff75ba7f5f4b86d99a";
const REQUIRED_REPORTS = [
  "v21-event-enumeration.json",
  "v21-event-identities.json",
  "v21-event-stage-manifest.json",
] as const;
const REQUIRED_SOURCE_FILES = [
  "lib/v21/events.ts",
  "scripts/run-v21-event-stage.ts",
  "scripts/validate-v21-events.ts",
  "tests/v21-events.test.ts",
  "package.json",
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
  for (const name of REQUIRED_REPORTS) assert(existsSync(resolve(REPORT_DIR, name)), `missing ${name}`);
  const report = await readJson("v21-event-enumeration.json");
  const identities = await readJson("v21-event-identities.json");
  const manifest = await readJson("v21-event-stage-manifest.json");

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
  assertEqual(report.historicalReturnsRead, false, "historical outcome data boundary");
  assertEqual(report.historicalStrategyOutcomeReturnsRead, false, "strategy outcome boundary");
  assertEqual(report.forwardReturnsRead, false, "forward data boundary");
  assertEqual(report.oosMetricsRead, false, "OOS metrics boundary");
  assertEqual(report.holdoutRead, false, "holdout metrics boundary");
  assertEqual(report.parameterSearch, false, "parameter search boundary");
  assertEqual(report.executionEvaluated, false, "execution boundary");
  assertEqual(report.futureDataRead, false, "future data boundary");
  assertEqual(report.noFutureBarsUsed, true, "future-bar firewall");
  assertEqual(report.productionChanged, false, "production boundary");
  assertEqual(report.productionEmail, "OFF", "email boundary");
  assertEqual(report.deploy, false, "deploy boundary");
  assertEqual(report.merge, false, "merge boundary");
  assertEqual(report.migration, false, "migration boundary");
  assertEqual(report.autoTrading, false, "trading boundary");

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

  assertEqual(manifest.schemaVersion, "v21-event-stage-manifest-v1", "manifest schema");
  assertEqual(manifest.experimentId, V21_EXPERIMENT_ID, "manifest experiment");
  assertEqual(manifest.repository, "SengC-it/Binance-Crypto-Alerts", "manifest repository");
  assertEqual(manifest.branch, V21_BRANCH, "manifest branch");
  assertEqual(manifest.baseResearchSha, V21_BASE_SHA, "manifest base");
  assertEqual(manifest.approvedParentCommit, PARENT_COMMIT, "manifest parent");
  assertEqual(manifest.fixedSymbols, V21_SYMBOLS, "manifest symbols");
  assertEqual(manifest.sourceReports.eventEnumerationSha256, await reportHash("v21-event-enumeration.json"), "event report hash");
  assertEqual(manifest.sourceReports.eventIdentitiesSha256, await reportHash("v21-event-identities.json"), "identity report hash");
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
    "historicalReturnsRead",
    "forwardReturnsRead",
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
