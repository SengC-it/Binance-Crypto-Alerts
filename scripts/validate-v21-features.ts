import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_END_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_FORBIDDEN_PATHS,
  V21_REPORT_FILES,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import {
  V21_PIT_OBSERVATION_COUNT,
  V21_PIT_WINDOW_MS,
} from "../lib/v21/features";

const REPORT_DIR = resolve("reports");
const WP1_COMMIT = "6c17bc2545aff218d4d673f07ccee3a5bf8eb54b";
const APPROVED_WP1_ARTIFACT_HASHES: Record<string, string> = {
  "reports/v21-archive-manifest.json": "5ac81354e12033017f68b08e05a0d1da0c11eb3fc0088af80418232387dcd452",
  "reports/v21-parser-report.json": "ecdf62a144a317658ac04dc9c5d6e1944190ed4158e4bfa01fd37c0464ed307e",
  "reports/v21-data-gate.json": "878f6a3969b9da34d9958e97518686c533740936ece0708941f08b1e2d1b4d6e",
  "reports/v21-data-stage-manifest.json": "a3de9ecada560d2b3beb8c6319751f1144e26c93d03911d26a5c4fca7aa1fb5f",
};
const APPROVED_WP1_FILE_SHA256: Record<string, string> = {
  "reports/v21-archive-manifest.json": APPROVED_WP1_ARTIFACT_HASHES["reports/v21-archive-manifest.json"],
  "reports/v21-parser-report.json": APPROVED_WP1_ARTIFACT_HASHES["reports/v21-parser-report.json"],
  "reports/v21-data-gate.json": APPROVED_WP1_ARTIFACT_HASHES["reports/v21-data-gate.json"],
  "reports/v21-data-stage-manifest.json": "eef1e214ef3481b4a6a10427b6c1c481be47ce1d0c5d6dc94526809d753a9928",
};
const FEATURE_FORBIDDEN_PATHS = [
  ...V21_FORBIDDEN_PATHS,
  "scripts/run-v21-signal-stage.ts",
  "reports/v21-signals.json",
] as const;
const ALLOWED_V21_REPORTS = new Set([
  ...V21_REPORT_FILES.map((path) => path.replace(/^reports\//, "")),
  "v21-feature-stage-manifest.json",
]);

async function main(): Promise<void> {
  const archiveManifest = await readJson("v21-archive-manifest.json");
  const parserReport = await readJson("v21-parser-report.json");
  const dataGate = await readJson("v21-data-gate.json");
  const dataStageManifest = await readJson("v21-data-stage-manifest.json");
  const featureManifest = await readJson("v21-feature-stage-manifest.json");

  assertEqual(featureManifest.schemaVersion, "v21-feature-stage-manifest-v1", "feature manifest schema");
  assertEqual(featureManifest.experimentId, V21_EXPERIMENT_ID, "feature experiment");
  assertEqual(featureManifest.repository, "SengC-it/Binance-Crypto-Alerts", "feature repository");
  assertEqual(featureManifest.baseResearchSha, V21_BASE_SHA, "feature base SHA");
  assertEqual(featureManifest.approvedWp1Commit, WP1_COMMIT, "approved WP1 commit");
  assertArrayEqual(featureManifest.fixedSymbols, V21_SYMBOLS, "feature symbols");

  assertEqual(archiveManifest.experimentId, V21_EXPERIMENT_ID, "WP1 archive identity");
  assertEqual(parserReport.experimentId, V21_EXPERIMENT_ID, "WP1 parser identity");
  assertEqual(dataGate.experimentId, V21_EXPERIMENT_ID, "WP1 gate identity");
  assertEqual(dataStageManifest.experimentId, V21_EXPERIMENT_ID, "WP1 stage identity");
  assertEqual(dataStageManifest.baseSha, V21_BASE_SHA, "WP1 base SHA");
  assertEqual(dataStageManifest.branch, V21_BRANCH, "WP1 branch");
  assertEqual(dataStageManifest.period.start, V21_START_TIMESTAMP, "WP1 period start");
  assertEqual(dataStageManifest.period.endInclusive, V21_END_TIMESTAMP, "WP1 period end");
  assertEqual(dataStageManifest.period.endExclusive, V21_END_EXCLUSIVE_TIMESTAMP, "WP1 exclusive period end");
  assertEqual(dataStageManifest.archiveManifestSha256, APPROVED_WP1_ARTIFACT_HASHES["reports/v21-archive-manifest.json"], "WP1 archive hash");
  assertEqual(dataStageManifest.parserReportSha256, APPROVED_WP1_ARTIFACT_HASHES["reports/v21-parser-report.json"], "WP1 parser hash");
  assertEqual(dataStageManifest.dataGateSha256, APPROVED_WP1_ARTIFACT_HASHES["reports/v21-data-gate.json"], "WP1 data gate hash");
  assertEqual(dataStageManifest.manifestBodySha256, APPROVED_WP1_ARTIFACT_HASHES["reports/v21-data-stage-manifest.json"], "WP1 stage hash");
  assertEqual(featureManifest.approvedWp1ArtifactHashes, APPROVED_WP1_ARTIFACT_HASHES, "approved WP1 artifact hashes");
  assertEqual(featureManifest.approvedWp1FileSha256, APPROVED_WP1_FILE_SHA256, "approved WP1 file hashes");

  const currentWp1FileHashes: Record<string, string> = {};
  for (const [path, approvedHash] of Object.entries(APPROVED_WP1_FILE_SHA256)) {
    const currentHash = canonicalTextSha256(await readFile(resolve(path), "utf8"));
    currentWp1FileHashes[path] = currentHash;
    assertEqual(currentHash, approvedHash, path + " unchanged");
  }
  assertEqual(currentWp1FileHashes["reports/v21-archive-manifest.json"], dataStageManifest.archiveManifestSha256, "archive dependency hash");
  assertEqual(currentWp1FileHashes["reports/v21-parser-report.json"], dataStageManifest.parserReportSha256, "parser dependency hash");
  assertEqual(currentWp1FileHashes["reports/v21-data-gate.json"], dataStageManifest.dataGateSha256, "data gate dependency hash");

  assertEqual(featureManifest.pitObservationCount, V21_PIT_OBSERVATION_COUNT, "PIT observation count");
  assertEqual(featureManifest.pitWindow.calendarDays, 30, "PIT calendar window");
  assertEqual(featureManifest.pitWindow.interval, "5m", "PIT interval");
  assertEqual(featureManifest.pitWindow.durationMs, V21_PIT_WINDOW_MS, "PIT duration");
  assertEqual(featureManifest.returnDefinition, "r_i,t = ln(close_i,t / close_i,t-1); synchronized only when all fixed symbols have exact closes at t and t-1; no forward fill, nearest repair, or synthetic rows.", "return definition");
  assertEqual(featureManifest.marketDefinition, "m_i,t = median of the other seven symbol returns at t; sort seven values and use the fourth value; target symbol is excluded.", "market definition");
  assertEqual(featureManifest.olsDefinition, "OLS with intercept over exactly the prior 8640 PIT rows: beta = sum((x-meanX)*(y-meanY)) / sum((x-meanX)^2), alpha = meanY - beta*meanX; no weights, robust fit, outlier removal, or conditioning.", "OLS definition");
  assertEqual(featureManifest.residualDefinition, "For every prior row j, epsilon_j = r_i,j - (alpha_t + beta_t*m_i,j) using the single current-t alpha_t and beta_t; no rolling refit.", "residual definition");
  assertEqual(featureManifest.q99Definition, "abs residuals sorted ascending; nearest-rank rank = ceil(0.99 * 8640), threshold = sorted[rank - 1]; no interpolation.", "Q99 definition");
  assertEqual(featureManifest.previousResidualDefinition, "previousResidual_i,t = r_i,t-1 - (alpha_t + beta_t*m_i,t-1) using the current-t model; no first-cross decision.", "previous residual definition");

  assertEqual(featureManifest.featureEngineImplemented, true, "feature implementation flag");
  const expectedFlags: Record<string, unknown> = {
    historicalFeatureScanRun: false,
    signalsEnumerated: false,
    firstCrossEnumerated: false,
    directionsAssigned: false,
    executionEvaluated: false,
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
  };
  for (const [key, value] of Object.entries(expectedFlags)) assertEqual(featureManifest[key], value, "feature boundary " + key);
  assertEqual(featureManifest.flags, expectedFlags, "feature boundary flags");

  const sourceHashes = {
    "lib/v21/features.ts": canonicalTextSha256(await readFile(resolve("lib/v21/features.ts"), "utf8")),
    "tests/v21-features.test.ts": canonicalTextSha256(await readFile(resolve("tests/v21-features.test.ts"), "utf8")),
    "scripts/validate-v21-features.ts": canonicalTextSha256(await readFile(resolve("scripts/validate-v21-features.ts"), "utf8")),
  };
  assertEqual(featureManifest.featureEngineSourceSha256, sourceHashes["lib/v21/features.ts"], "feature engine source hash");
  assertEqual(featureManifest.featureTestSha256, sourceHashes["tests/v21-features.test.ts"], "feature test source hash");
  assertEqual(featureManifest.featureValidatorSha256, sourceHashes["scripts/validate-v21-features.ts"], "feature validator source hash");
  const manifestBody = { ...featureManifest };
  delete manifestBody.manifestBodySha256;
  assertEqual(featureManifest.manifestBodySha256, sha256(manifestBody), "feature manifest body hash");

  for (const forbidden of FEATURE_FORBIDDEN_PATHS) assert(!existsSync(resolve(forbidden)), "forbidden V21 artifact exists: " + forbidden);
  const reportNames = await readdir(REPORT_DIR);
  const unexpectedV21Reports = reportNames.filter((name) => name.startsWith("v21-") && !ALLOWED_V21_REPORTS.has(name));
  assertEqual(unexpectedV21Reports.length, 0, "unexpected V21 report artifacts");

  console.info("V21 feature validation PASS (WP2 feature engine only)");
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("V21 feature validation failed: " + message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("V21 feature validation failed: " + message + "; expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function assertArrayEqual(actual: unknown, expected: unknown, message: string): void {
  assert(Array.isArray(actual), message + ": expected array");
  assertEqual(actual, expected, message);
}
