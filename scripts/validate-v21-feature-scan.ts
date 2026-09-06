import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_EXPERIMENT_ID,
  V21_FORBIDDEN_PATHS,
  V21_REPORT_FILES,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import {
  V21_PIT_OBSERVATION_COUNT,
  V21_PIT_WINDOW_MS,
} from "../lib/v21/features";

const REPORT_DIR = resolve("reports");
const WP1_COMMIT = "6c17bc2545aff218d4d673f07ccee3a5bf8eb54b";
const WP2_COMMIT = "83fa78849890ac0a59b408b4e0d13f007755977f";
const APPROVED_FEATURE_MANIFEST_SHA = "22b0c2145a8582a9b44c3ba835c2183c9feb51babc4db683c0e559bc40b8431a";
const WP1_HASHES: Record<string, string> = {
  "reports/v21-archive-manifest.json": "5ac81354e12033017f68b08e05a0d1da0c11eb3fc0088af80418232387dcd452",
  "reports/v21-parser-report.json": "ecdf62a144a317658ac04dc9c5d6e1944190ed4158e4bfa01fd37c0464ed307e",
  "reports/v21-data-gate.json": "878f6a3969b9da34d9958e97518686c533740936ece0708941f08b1e2d1b4d6e",
  "reports/v21-data-stage-manifest.json": "a3de9ecada560d2b3beb8c6319751f1144e26c93d03911d26a5c4fca7aa1fb5f",
};
const SCAN_FORBIDDEN_PATHS = [
  ...V21_FORBIDDEN_PATHS,
  "lib/v21/events.ts",
  "scripts/run-v21-signal-stage.ts",
  "reports/v21-event-enumeration.json",
  "reports/v21-signals.json",
  "reports/v21-freeze-manifest.json",
] as const;

async function main(): Promise<void> {
  runDependencyValidator("validate:v21:data");
  runDependencyValidator("validate:v21:features");

  const featureManifest = await readJson("v21-feature-stage-manifest.json");
  const report = await readJson("v21-scan-feasibility.json");
  const manifest = await readJson("v21-scan-stage-manifest.json");

  assertEqual(featureManifest.approvedWp1Commit, WP1_COMMIT, "feature WP1 identity");
  const featureManifestBody = { ...featureManifest };
  delete featureManifestBody.manifestBodySha256;
  assertEqual(sha256(featureManifestBody), APPROVED_FEATURE_MANIFEST_SHA, "approved feature manifest hash");

  assertEqual(report.schemaVersion, "v21-scan-feasibility-v1", "scan report schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "scan report experiment");
  assertEqual(report.referenceImplementation, "lib/v21/features.ts::buildPitFeature", "reference implementation");
  assertEqual(report.optimizedImplementation, "lib/v21/feature-scan.ts::scanV21Features", "optimized implementation");
  assertEqual(report.exactSemantics, true, "exact semantics");
  assertEqual(report.approximationUsed, false, "approximation");
  assertEqual(report.referenceComparisonCases, 4000, "comparison cases");
  assertEqual(report.comparisonMismatchCount, 0, "comparison mismatches");
  assertEqual(report.q99RankIdentity, true, "Q99 rank identity");
  for (const key of [
    "maxAlphaError",
    "maxBetaError",
    "maxCurrentResidualError",
    "maxPreviousResidualError",
    "maxQ99Error",
  ]) {
    assert(typeof report[key] === "number" && Number.isFinite(report[key]) && report[key] <= 1e-12, key + " tolerance");
  }
  assert(typeof report.referenceDigest === "string" && report.referenceDigest.length === 64, "reference digest");
  assertEqual(report.referenceDigest, report.optimizedDigest, "normalized digest equality");
  assertEqual(report.benchmarkRows, 20_000, "benchmark rows");
  assertEqual(report.benchmarkSymbols, V21_SYMBOLS.length, "benchmark symbols");
  assertEqual(report.evaluatedFeatures, (20_000 - V21_PIT_OBSERVATION_COUNT) * V21_SYMBOLS.length, "benchmark feature count");
  assert(typeof report.elapsedMs === "number" && report.elapsedMs > 0, "benchmark elapsed time");
  assert(typeof report.featuresPerSecond === "number" && report.featuresPerSecond > 0, "benchmark throughput");
  assertEqual(report.fullHistoryFeasibility, "FAIL", "full-history feasibility");
  assertEqual(report.status, "FAIL", "scan status");
  assertEqual(report.classification, "V21_EXACT_SCAN_ENGINE_NOT_FEASIBLE", "scan classification");

  assertEqual(manifest.schemaVersion, "v21-scan-stage-manifest-v1", "stage schema");
  assertEqual(manifest.experimentId, V21_EXPERIMENT_ID, "stage experiment");
  assertEqual(manifest.repository, "SengC-it/Binance-Crypto-Alerts", "stage repository");
  assertEqual(manifest.branch, V21_BRANCH, "stage branch");
  assertEqual(manifest.baseResearchSha, V21_BASE_SHA, "stage base SHA");
  assertEqual(manifest.approvedWp1Commit, WP1_COMMIT, "stage WP1 identity");
  assertEqual(manifest.approvedWp2Commit, WP2_COMMIT, "stage WP2 identity");
  assertEqual(manifest.approvedFeatureManifestSha256, APPROVED_FEATURE_MANIFEST_SHA, "stage feature manifest identity");
  assertEqual(manifest.wp1ArtifactHashes, WP1_HASHES, "stage WP1 hashes");
  assertEqual(manifest.fixedSymbols, V21_SYMBOLS, "stage symbols");
  assertEqual(manifest.pitObservationCount, V21_PIT_OBSERVATION_COUNT, "stage PIT count");
  assertEqual(manifest.pitWindow.durationMs, V21_PIT_WINDOW_MS, "stage PIT duration");
  assertEqual(manifest.exactSemanticsRequired, true, "exact semantics required");
  assertEqual(manifest.approximationUsed, false, "stage approximation");
  assertEqual(manifest.feasibilityReportSha256, canonicalTextSha256(await readFile(resolve("reports/v21-scan-feasibility.json"), "utf8")), "feasibility report hash");

  const sourceHashes = {
    "lib/v21/features.ts": canonicalTextSha256(await readFile(resolve("lib/v21/features.ts"), "utf8")),
    "lib/v21/feature-scan.ts": canonicalTextSha256(await readFile(resolve("lib/v21/feature-scan.ts"), "utf8")),
    "tests/v21-feature-scan.test.ts": canonicalTextSha256(await readFile(resolve("tests/v21-feature-scan.test.ts"), "utf8")),
    "scripts/validate-v21-feature-scan.ts": canonicalTextSha256(await readFile(resolve("scripts/validate-v21-feature-scan.ts"), "utf8")),
  };
  assertEqual(manifest.featureEngineSha256, sourceHashes["lib/v21/features.ts"], "feature source hash");
  assertEqual(manifest.scanEngineSha256, sourceHashes["lib/v21/feature-scan.ts"], "scan source hash");
  assertEqual(manifest.scanTestsSha256, sourceHashes["tests/v21-feature-scan.test.ts"], "scan test hash");
  assertEqual(manifest.scanValidatorSha256, sourceHashes["scripts/validate-v21-feature-scan.ts"], "scan validator hash");

  const expectedFlags: Record<string, unknown> = {
    historicalFeatureScanRun: false,
    realHistoricalDataScanned: false,
    signalsEnumerated: false,
    firstCrossEnumerated: false,
    directionsAssigned: false,
    executionEvaluated: false,
    historicalStrategyOutcomeReturnsRead: false,
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
  };
  for (const [key, value] of Object.entries(expectedFlags)) assertEqual(manifest[key], value, "boundary " + key);
  assertEqual(manifest.flags, expectedFlags, "boundary flags");
  const manifestBody = { ...manifest };
  delete manifestBody.manifestBodySha256;
  assertEqual(manifest.manifestBodySha256, sha256(manifestBody), "stage manifest body hash");

  for (const forbidden of SCAN_FORBIDDEN_PATHS) assert(!existsSync(resolve(forbidden)), "forbidden artifact exists: " + forbidden);
  const reportNames = await readdir(REPORT_DIR);
  const allowed = new Set(V21_REPORT_FILES.map((path) => path.replace(/^reports\//, "")));
  const unexpected = reportNames.filter((name) => name.startsWith("v21-") && !allowed.has(name));
  assertEqual(unexpected.length, 0, "unexpected V21 report artifacts");

  console.info("V21 exact feature scan validation PASS (WP2.5 feasibility)");
}

function runDependencyValidator(scriptName: string): void {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, [scriptName], { stdio: "inherit" });
  assert(result.status === 0, scriptName + " dependency validation");
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("V21 feature-scan validation failed: " + message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("V21 feature-scan validation failed: " + message + "; expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}
