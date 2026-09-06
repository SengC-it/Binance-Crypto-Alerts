import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
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
  nearestRankQuantile,
} from "../lib/v21/features";
import {
  V21_Q99_RANK,
  V21_Q99_TAIL_COUNT,
  evaluateExactExtremePredicate,
} from "../lib/v21/event-predicate";

const REPORT_DIR = resolve("reports");
const WP1_COMMIT = "6c17bc2545aff218d4d673f07ccee3a5bf8eb54b";
const WP2_COMMIT = "83fa78849890ac0a59b408b4e0d13f007755977f";
const WP25_COMMIT = "3eceefd0808ac54d5da8e28edf78ef837bc9cacf";
const APPROVED_FEATURE_MANIFEST_SHA = "22b0c2145a8582a9b44c3ba835c2183c9feb51babc4db683c0e559bc40b8431a";
const APPROVED_SCAN_MANIFEST_BODY_SHA = "124672692191f3173a7c9a2bbf0938ab88ce0b318691793772690df00bf3e51b";
const APPROVED_SCAN_REPORT_SHA = "ad0e964d68f36c379b1072d9b25972c15b56d3b0f498b2976d71877a36a8acf4";
const WP1_HASHES: Record<string, string> = {
  "reports/v21-archive-manifest.json": "5ac81354e12033017f68b08e05a0d1da0c11eb3fc0088af80418232387dcd452",
  "reports/v21-parser-report.json": "ecdf62a144a317658ac04dc9c5d6e1944190ed4158e4bfa01fd37c0464ed307e",
  "reports/v21-data-gate.json": "878f6a3969b9da34d9958e97518686c533740936ece0708941f08b1e2d1b4d6e",
  "reports/v21-data-stage-manifest.json": "a3de9ecada560d2b3beb8c6319751f1144e26c93d03911d26a5c4fca7aa1fb5f",
};
const FORBIDDEN_EVENT_ARTIFACTS = [
  ...V21_FORBIDDEN_PATHS,
  "lib/v21/events.ts",
  "scripts/run-v21-signal-stage.ts",
  "reports/v21-event-enumeration.json",
  "reports/v21-signals.json",
  "reports/v21-freeze-manifest.json",
] as const;

interface BenchmarkMetrics {
  benchmarkRows: number;
  benchmarkSymbols: number;
  evaluatedPredicates: number;
  totalResidualComparisons: number;
  averageResidualComparisonsPerPredicate: number;
  medianResidualComparisons: number;
  p95ResidualComparisons: number;
  fullWindowScans: number;
  earlyExitCount: number;
  earlyExitRate: number;
  exactThresholdComputations: number;
  exactThresholdRate: number;
  elapsedMs: number;
  predicatesPerSecond: number;
  peakMemoryMB: number;
}

async function main(): Promise<void> {
  runDependencyValidator("validate:v21:data");
  runDependencyValidator("validate:v21:features");
  runDependencyValidator("validate:v21:feature-scan");

  const measuredBenchmark = runBenchmark();
  if (process.argv.includes("--print-benchmark")) {
    console.info(JSON.stringify(measuredBenchmark, null, 2));
    return;
  }

  const featureManifest = await readJson("v21-feature-stage-manifest.json");
  const scanManifest = await readJson("v21-scan-stage-manifest.json");
  const report = await readJson("v21-event-predicate-feasibility.json");
  const manifest = await readJson("v21-event-predicate-stage-manifest.json");

  assertEqual(featureManifest.approvedWp1Commit, WP1_COMMIT, "feature WP1 identity");
  const featureManifestBody = { ...featureManifest };
  delete featureManifestBody.manifestBodySha256;
  assertEqual(sha256(featureManifestBody), APPROVED_FEATURE_MANIFEST_SHA, "approved feature manifest hash");
  assertEqual(scanManifest.approvedWp2Commit, WP2_COMMIT, "approved scan WP2 identity");
  assertEqual(scanManifest.manifestBodySha256, APPROVED_SCAN_MANIFEST_BODY_SHA, "approved scan manifest hash");
  assertEqual(report.schemaVersion, "v21-event-predicate-feasibility-v1", "predicate report schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "predicate report experiment");
  assertEqual(report.referenceImplementation, "lib/v21/features.ts::buildPitFeature + nearestRankQuantile", "predicate reference");
  assertEqual(report.optimizedImplementation, "lib/v21/event-predicate.ts::evaluateExactExtremePredicate", "predicate implementation");
  assertEqual(report.exactSemantics, true, "exact semantics");
  assertEqual(report.approximationUsed, false, "approximation");
  assertEqual(report.observationCount, V21_PIT_OBSERVATION_COUNT, "observation count");
  assertEqual(report.q99Rank, V21_Q99_RANK, "Q99 rank");
  assertEqual(report.tailCount, V21_Q99_TAIL_COUNT, "Q99 tail count");
  assertEqual(report.syntheticComparisonCases, 10000, "synthetic comparison cases");
  assertEqual(report.semanticMismatchCount, 0, "semantic mismatches");
  assertEqual(report.currentExtremeMismatchCount, 0, "current extreme mismatches");
  assertEqual(report.firstCrossMismatchCount, 0, "first-cross mismatches");
  assert(typeof report.maxThresholdError === "number" && report.maxThresholdError <= 1e-12, "threshold tolerance");
  assertEqual(report.tieSemantics.covered, true, "tie coverage");
  assertEqual(report.tieSemantics.currentExactlyQ99, true, "exact Q99 tie coverage");
  assertEqual(report.tieSemantics.valuesGreater86, true, "86-greater tie coverage");
  assertEqual(report.tieSemantics.valuesGreater87, true, "87-greater tie coverage");
  assertEqual(report.tieSemantics.duplicatedQ99, true, "duplicated Q99 coverage");
  assertEqual(report.tieSemantics.allEqual, true, "all-equal coverage");
  assertEqual(report.deterministic, true, "determinism");

  const benchmark = measuredBenchmark;
  assertEqual(benchmark.benchmarkRows, 20000, "benchmark rows");
  assertEqual(benchmark.benchmarkSymbols, V21_SYMBOLS.length, "benchmark symbols");
  assertEqual(benchmark.evaluatedPredicates, (20000 - V21_PIT_OBSERVATION_COUNT) * V21_SYMBOLS.length, "benchmark predicates");
  assertEqual(report.benchmarkRows, benchmark.benchmarkRows, "reported benchmark rows");
  assertEqual(report.benchmarkSymbols, benchmark.benchmarkSymbols, "reported benchmark symbols");
  for (const key of [
    "evaluatedPredicates",
    "totalResidualComparisons",
    "medianResidualComparisons",
    "p95ResidualComparisons",
    "fullWindowScans",
    "earlyExitCount",
    "exactThresholdComputations",
  ] as const) {
    assertEqual(report[key], benchmark[key], "reported benchmark " + key);
  }
  assertClose(report.averageResidualComparisonsPerPredicate, benchmark.averageResidualComparisonsPerPredicate, 1e-9, "reported average comparisons");
  assertClose(report.earlyExitRate, benchmark.earlyExitRate, 1e-12, "reported early exit rate");
  assertClose(report.exactThresholdRate, benchmark.exactThresholdRate, 1e-12, "reported exact threshold rate");
  assert(benchmark.averageResidualComparisonsPerPredicate <= 2000, "average comparison performance gate");
  assert(benchmark.earlyExitRate >= 0.95, "early exit performance gate");
  assert(benchmark.exactThresholdRate <= 0.05, "exact threshold performance gate");
  assertEqual(report.performanceGate, "PASS", "reported performance gate");
  assertEqual(report.fullHistoryEventEnumerationFeasibility, "PASS", "event enumeration feasibility");
  assertEqual(report.classification, "V21_EXACT_EVENT_PREDICATE_PASS", "predicate classification");

  runTieChecks();
  const predicateSource = await readFile(resolve("lib/v21/event-predicate.ts"), "utf8");
  assert(!predicateSource.includes("buildPitFeature"), "predicate must not call reference implementation");

  assertEqual(manifest.schemaVersion, "v21-event-predicate-stage-manifest-v1", "stage schema");
  assertEqual(manifest.experimentId, V21_EXPERIMENT_ID, "stage experiment");
  assertEqual(manifest.repository, "SengC-it/Binance-Crypto-Alerts", "stage repository");
  assertEqual(manifest.branch, V21_BRANCH, "stage branch");
  assertEqual(manifest.baseResearchSha, V21_BASE_SHA, "stage base SHA");
  assertEqual(manifest.approvedWp1Commit, WP1_COMMIT, "stage WP1 identity");
  assertEqual(manifest.approvedWp2Commit, WP2_COMMIT, "stage WP2 identity");
  assertEqual(manifest.approvedWp25Commit, WP25_COMMIT, "stage WP2.5 identity");
  assertEqual(manifest.approvedFeatureManifestSha256, APPROVED_FEATURE_MANIFEST_SHA, "stage feature manifest");
  assertEqual(manifest.approvedScanManifestBodySha256, APPROVED_SCAN_MANIFEST_BODY_SHA, "stage scan manifest");
  assertEqual(manifest.approvedScanReportSha256, APPROVED_SCAN_REPORT_SHA, "stage scan report");
  assertEqual(manifest.wp1ArtifactHashes, WP1_HASHES, "stage WP1 hashes");
  assertEqual(manifest.fixedSymbols, V21_SYMBOLS, "stage symbols");
  assertEqual(manifest.observationCount, V21_PIT_OBSERVATION_COUNT, "stage observation count");
  assertEqual(manifest.q99Rank, V21_Q99_RANK, "stage Q99 rank");
  assertEqual(manifest.tailCount, V21_Q99_TAIL_COUNT, "stage tail count");
  assertEqual(manifest.exactSemanticsRequired, true, "stage exact semantics");
  assertEqual(manifest.approximationUsed, false, "stage approximation");
  assertEqual(manifest.feasibilityReportSha256, canonicalTextSha256(await readFile(resolve("reports/v21-event-predicate-feasibility.json"), "utf8")), "feasibility report hash");

  const sourceHashes = {
    "lib/v21/event-predicate.ts": canonicalTextSha256(await readFile(resolve("lib/v21/event-predicate.ts"), "utf8")),
    "tests/v21-event-predicate.test.ts": canonicalTextSha256(await readFile(resolve("tests/v21-event-predicate.test.ts"), "utf8")),
    "scripts/validate-v21-event-predicate.ts": canonicalTextSha256(await readFile(resolve("scripts/validate-v21-event-predicate.ts"), "utf8")),
  };
  assertEqual(manifest.eventPredicateEngineSha256, sourceHashes["lib/v21/event-predicate.ts"], "predicate source hash");
  assertEqual(manifest.eventPredicateTestsSha256, sourceHashes["tests/v21-event-predicate.test.ts"], "predicate test hash");
  assertEqual(manifest.eventPredicateValidatorSha256, sourceHashes["scripts/validate-v21-event-predicate.ts"], "predicate validator hash");

  const expectedFlags: Record<string, unknown> = {
    realHistoricalDataScanned: false,
    historicalEventScanRun: false,
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

  for (const forbidden of FORBIDDEN_EVENT_ARTIFACTS) assert(!existsSync(resolve(forbidden)), "forbidden event artifact exists: " + forbidden);
  const reportNames = await readdir(REPORT_DIR);
  const allowed = new Set(V21_REPORT_FILES.map((path) => path.replace(/^reports\//, "")));
  const unexpected = reportNames.filter((name) => name.startsWith("v21-") && !allowed.has(name));
  assertEqual(unexpected.length, 0, "unexpected V21 report artifacts");

  console.info("V21 exact event predicate validation PASS");
}

function runBenchmark(): BenchmarkMetrics {
  const benchmarkRows = 20000;
  const benchmarkSymbols = V21_SYMBOLS.length;
  const priorResiduals = V21_SYMBOLS.map((_, symbolIndex) => buildNonDegeneratePrior(symbolIndex));
  const comparisonCounts: number[] = [];
  let fullWindowScans = 0;
  let earlyExitCount = 0;
  let exactThresholdComputations = 0;
  const startedAt = performance.now();

  for (let rowIndex = V21_PIT_OBSERVATION_COUNT; rowIndex < benchmarkRows; rowIndex += 1) {
    for (let symbolIndex = 0; symbolIndex < benchmarkSymbols; symbolIndex += 1) {
      const result = evaluateExactExtremePredicate({
        priorResiduals: priorResiduals[symbolIndex],
        previousResidual: benchmarkResidual(symbolIndex, rowIndex - 1),
        currentResidual: benchmarkResidual(symbolIndex, rowIndex),
      });
      comparisonCounts.push(result.residualComparisons);
      if (result.earlyExit) earlyExitCount += 1;
      else fullWindowScans += 1;
      if (result.exactThresholdComputed) exactThresholdComputations += 1;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const sorted = [...comparisonCounts].sort((left, right) => left - right);
  const evaluatedPredicates = comparisonCounts.length;
  const totalResidualComparisons = comparisonCounts.reduce((sum, value) => sum + value, 0);
  const earlyExitRate = earlyExitCount / evaluatedPredicates;
  const exactThresholdRate = exactThresholdComputations / evaluatedPredicates;
  return {
    benchmarkRows,
    benchmarkSymbols,
    evaluatedPredicates,
    totalResidualComparisons,
    averageResidualComparisonsPerPredicate: totalResidualComparisons / evaluatedPredicates,
    medianResidualComparisons: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95ResidualComparisons: sorted[Math.ceil(sorted.length * 0.95) - 1],
    fullWindowScans,
    earlyExitCount,
    earlyExitRate,
    exactThresholdComputations,
    exactThresholdRate,
    elapsedMs,
    predicatesPerSecond: evaluatedPredicates / (elapsedMs / 1000),
    peakMemoryMB: process.resourceUsage().maxRSS / 1024,
  };
}

function buildNonDegeneratePrior(symbolIndex: number): Float64Array {
  const prior = new Float64Array(V21_PIT_OBSERVATION_COUNT);
  for (let index = 0; index < prior.length; index += 1) {
    if (index < 100) {
      prior[index] = (symbolIndex % 2 === 0 ? 1 : -1) * (0.1 + index * 0.0001 + symbolIndex * 0.00001);
    } else {
      prior[index] = 0.0001
        + 0.00004 * Math.sin(index / (9 + symbolIndex))
        + 0.00003 * Math.cos(index / (17 + symbolIndex))
        + symbolIndex * 0.000001;
    }
  }
  return prior;
}

function benchmarkResidual(symbolIndex: number, rowIndex: number): number {
  if (rowIndex % 25 === 0) {
    return (symbolIndex % 2 === 0 ? 1 : -1) * (0.2 + symbolIndex * 0.001);
  }
  return 0.0005
    + symbolIndex * 0.00001
    + 0.0001 * Math.sin(rowIndex / (13 + symbolIndex))
    + 0.00007 * Math.cos(rowIndex / (23 + symbolIndex));
}

function runTieChecks(): void {
  const exact = [
    ...Array.from({ length: V21_Q99_RANK }, () => 1),
    ...Array.from({ length: V21_Q99_TAIL_COUNT }, () => 2),
  ];
  const exactResult = evaluateExactExtremePredicate({ priorResiduals: exact, previousResidual: 0.5, currentResidual: 1 });
  assertEqual(exactResult.currentExtreme, true, "exact Q99 predicate");
  assertEqual(exactResult.residualAbsQ99, nearestRankQuantile(exact, 0.99), "exact Q99 threshold");

  const greater87 = [
    ...Array.from({ length: V21_Q99_TAIL_COUNT + 1 }, () => 2),
    ...Array.from({ length: V21_Q99_RANK - 1 }, () => 1),
  ];
  const greater87Result = evaluateExactExtremePredicate({ priorResiduals: greater87, previousResidual: 0.5, currentResidual: 1 });
  assertEqual(greater87Result.currentExtreme, false, "87-greater predicate");
  assertEqual(greater87Result.earlyExit, true, "87-greater early exit");
  assertEqual(greater87Result.residualComparisons, 87, "87-greater comparisons");

  const allEqual = Array.from({ length: V21_PIT_OBSERVATION_COUNT }, () => 0.5);
  const allEqualResult = evaluateExactExtremePredicate({ priorResiduals: allEqual, previousResidual: 0.5, currentResidual: 0.5 });
  assertEqual(allEqualResult.currentExtreme, true, "all-equal predicate");
  assertEqual(allEqualResult.previousInside, false, "all-equal previous boundary");
}

function runDependencyValidator(scriptName: string): void {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, [scriptName], {
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  assert(!result.error, scriptName + " dependency validation process: " + (result.error?.message ?? "unknown error"));
  assert(result.status === 0, scriptName + " dependency validation");
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("V21 event-predicate validation failed: " + message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("V21 event-predicate validation failed: " + message + "; expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function assertClose(actual: unknown, expected: unknown, tolerance: number, message: string): void {
  assert(typeof actual === "number" && typeof expected === "number", message + ": expected numbers");
  assert(Math.abs(actual - expected) <= tolerance, message + ": expected " + expected + ", got " + actual);
}

void main();
