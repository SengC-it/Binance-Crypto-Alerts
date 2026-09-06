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
const PREDICATE_SOURCE_SHA = "577b53220ab5b1a9bac5a89c65539e81d3331fa07f568ee119c0adead3de0179";
const BENCHMARK_VERSION = "INDEPENDENT_ROLLING_V2" as const;
const BENCHMARK_SEED = 0x21c0ffee;
const BENCHMARK_ROWS = 20000;
const BENCHMARK_FAMILIES = [
  "STATIONARY",
  "HETEROSKEDASTIC",
  "HEAVY_TAIL",
  "AUTOCORRELATED",
] as const;
type BenchmarkFamily = (typeof BENCHMARK_FAMILIES)[number];
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

interface BenchmarkFamilyMetrics {
  family: BenchmarkFamily;
  seed: number;
  benchmarkRows: number;
  benchmarkSymbols: number;
  evaluatedPredicates: number;
  totalResidualComparisons: number;
  averageResidualComparisons: number;
  medianResidualComparisons: number;
  p95ResidualComparisons: number;
  p99ResidualComparisons: number;
  fullWindowScans: number;
  earlyExitCount: number;
  earlyExitRate: number;
  exactThresholdComputations: number;
  exactThresholdRate: number;
  observedExtremeCount: number;
  elapsedMs: number;
  predicatesPerSecond: number;
  observedExtremeRate: number;
  rollingWindowAdvanced: boolean;
  rollingWindowShifts: number;
  currentAndPriorSameProcess: boolean;
  performancePass: boolean;
}

interface BenchmarkSuite {
  benchmarkVersion: typeof BENCHMARK_VERSION;
  benchmarkSeed: number;
  families: BenchmarkFamilyMetrics[];
  stationaryGate: "PASS" | "FAIL";
  robustnessFamiliesPassed: number;
  worstFamilyAverageComparisons: number;
  worstFamilyExactThresholdRate: number;
  worstFamilyThroughput: number;
}

async function main(): Promise<void> {
  runDependencyValidator("validate:v21:data");
  runDependencyValidator("validate:v21:features");
  runDependencyValidator("validate:v21:feature-scan");

  const measuredBenchmark = runBenchmarkSuite();
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
  assertEqual(report.benchmarkVersion, BENCHMARK_VERSION, "benchmark version");
  assertEqual(report.benchmarkSeed, BENCHMARK_SEED, "benchmark seed");
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

  const predicateSource = await readFile(resolve("lib/v21/event-predicate.ts"), "utf8");
  assertEqual(canonicalTextSha256(predicateSource), PREDICATE_SOURCE_SHA, "WP2.6 predicate source unchanged");
  assert(!predicateSource.includes("buildPitFeature"), "predicate must not call reference implementation");
  runTieChecks();

  const benchmarkSource = [
    runBenchmarkSuite.toString(),
    runFamilyBenchmark.toString(),
    buildFamilySeries.toString(),
    nextUniform.toString(),
    nextNormal.toString(),
  ].join("\n");
  for (const forbidden of [
    "explicitExtremeFrequency",
    "forcedExtremeEveryN",
    "exactThresholdTargetRate",
    "earlyExitTargetRate",
  ]) assert(!benchmarkSource.includes(forbidden), "biased benchmark token: " + forbidden);
  assert(!/rowIndex\s*%/.test(benchmarkSource), "timestamp-modulus benchmark construction");
  assert(!/(timestamp|timeIndex)\s*%/.test(benchmarkSource), "time modulus benchmark construction");
  const validatorSource = await readFile(resolve("scripts/validate-v21-event-predicate.ts"), "utf8");
  assert(validatorSource.includes("residualSeries[symbolIndex].subarray(rowIndex - V21_PIT_OBSERVATION_COUNT, rowIndex)"), "rolling PIT window is not advanced");
  assert(validatorSource.includes("residualSeries[symbolIndex][rowIndex - 1]"), "previous residual is not from generated series");
  assert(validatorSource.includes("residualSeries[symbolIndex][rowIndex]"), "current residual is not from generated series");

  assertEqual(report.benchmarkRows, BENCHMARK_ROWS, "reported benchmark rows");
  assertEqual(report.benchmarkSymbols, V21_SYMBOLS.length, "reported benchmark symbols");
  assertEqual(report.totalEvaluatedPredicates, measuredBenchmark.families[0].evaluatedPredicates * BENCHMARK_FAMILIES.length, "reported total predicates");
  assertEqual(report.families.length, BENCHMARK_FAMILIES.length, "benchmark family count");
  const reportFamilies = BENCHMARK_FAMILIES.map((familyName) => {
    const family = report.families.find((candidate: any) => candidate.family === familyName);
    assert(!!family, "missing benchmark family: " + familyName);
    return family;
  });
  for (const [index, measuredFamily] of measuredBenchmark.families.entries()) {
    const family = reportFamilies[index];
    assertEqual(family.seed, measuredFamily.seed, measuredFamily.family + " seed");
    for (const key of [
      "benchmarkRows",
      "benchmarkSymbols",
      "evaluatedPredicates",
      "totalResidualComparisons",
      "medianResidualComparisons",
      "p95ResidualComparisons",
      "p99ResidualComparisons",
      "fullWindowScans",
      "earlyExitCount",
      "exactThresholdComputations",
      "observedExtremeCount",
      "rollingWindowShifts",
    ] as const) {
      assertEqual(family[key], measuredFamily[key], measuredFamily.family + " " + key);
    }
    for (const key of [
      "averageResidualComparisons",
      "earlyExitRate",
      "exactThresholdRate",
      "observedExtremeRate",
    ] as const) {
      assertClose(family[key], measuredFamily[key], 1e-12, measuredFamily.family + " " + key);
    }
    assert(typeof family.elapsedMs === "number" && family.elapsedMs > 0, measuredFamily.family + " elapsed");
    assert(typeof family.predicatesPerSecond === "number" && family.predicatesPerSecond > 0, measuredFamily.family + " throughput");
    assertEqual(family.rollingWindowAdvanced, true, measuredFamily.family + " rolling window");
    assertEqual(family.currentAndPriorSameProcess, true, measuredFamily.family + " same process");
    assertEqual(family.performancePass, measuredFamily.performancePass, measuredFamily.family + " performance gate");
  }
  assertEqual(report.stationaryDistributionSanity, "PASS", "stationary distribution sanity");
  assert(measuredBenchmark.families[0].observedExtremeRate > 0 && measuredBenchmark.families[0].observedExtremeRate <= 0.1, "stationary observed extreme rate sanity");
  const stationaryPass = measuredBenchmark.families[0].performancePass;
  const robustnessFamiliesPassed = measuredBenchmark.families.slice(1).filter((family) => family.performancePass).length;
  assertEqual(report.stationaryGate, stationaryPass ? "PASS" : "FAIL", "stationary performance gate");
  assertEqual(report.robustnessFamiliesPassed, robustnessFamiliesPassed, "robustness pass count");
  assert(robustnessFamiliesPassed >= 2, "robustness performance gate");
  assertClose(report.worstFamilyAverageComparisons, Math.max(...measuredBenchmark.families.map((family) => family.averageResidualComparisons)), 1e-12, "worst family average comparisons");
  assertClose(report.worstFamilyExactThresholdRate, Math.max(...measuredBenchmark.families.map((family) => family.exactThresholdRate)), 1e-12, "worst family exact threshold rate");
  assertClose(report.worstFamilyThroughput, Math.min(...reportFamilies.map((family: any) => family.predicatesPerSecond)), 1e-9, "worst family throughput");
  const performancePass = stationaryPass && robustnessFamiliesPassed >= 2;
  assertEqual(report.performanceGate, performancePass ? "PASS" : "FAIL", "reported performance gate");
  assertEqual(report.supersededBenchmark.superseded, true, "superseded benchmark marker");
  assertEqual(report.supersededBenchmark.supersededReason, "FIXED_EXTREME_FREQUENCY_BIASED_PERFORMANCE_GATE", "superseded benchmark reason");
  const expectedClassification = performancePass
    ? "V21_EXACT_EVENT_PREDICATE_PASS"
    : "V21_EXACT_EVENT_PREDICATE_NOT_FEASIBLE";
  assertEqual(report.classification, expectedClassification, "predicate classification");
  assertEqual(report.fullHistoryEventEnumerationFeasibility, performancePass ? "PASS" : "FAIL", "event enumeration feasibility");

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
  assertEqual(manifest.benchmarkVersion, BENCHMARK_VERSION, "stage benchmark version");
  assertEqual(manifest.benchmarkSeed, BENCHMARK_SEED, "stage benchmark seed");
  assertEqual(manifest.predicateSourceSha256, PREDICATE_SOURCE_SHA, "stage predicate source");
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

function runBenchmarkSuite(): BenchmarkSuite {
  const families = BENCHMARK_FAMILIES.map((family, familyIndex) => runFamilyBenchmark(family, familyIndex));
  const stationaryGate = families[0].performancePass ? "PASS" : "FAIL";
  const robustnessFamiliesPassed = families.slice(1).filter((family) => family.performancePass).length;
  return {
    benchmarkVersion: BENCHMARK_VERSION,
    benchmarkSeed: BENCHMARK_SEED,
    families,
    stationaryGate,
    robustnessFamiliesPassed,
    worstFamilyAverageComparisons: Math.max(...families.map((family) => family.averageResidualComparisons)),
    worstFamilyExactThresholdRate: Math.max(...families.map((family) => family.exactThresholdRate)),
    worstFamilyThroughput: Math.min(...families.map((family) => family.predicatesPerSecond)),
  };
}

function runFamilyBenchmark(family: BenchmarkFamily, familyIndex: number): BenchmarkFamilyMetrics {
  const startedAt = performance.now();
  const benchmarkSymbols = V21_SYMBOLS.length;
  const residualSeries = V21_SYMBOLS.map((_, symbolIndex) => buildFamilySeries(family, familyIndex, symbolIndex));
  const comparisonCounts: number[] = [];
  let fullWindowScans = 0;
  let earlyExitCount = 0;
  let exactThresholdComputations = 0;
  let observedExtremeCount = 0;
  let rollingWindowShifts = 0;
  const previousWindowStarts: Array<number | null> = Array.from({ length: benchmarkSymbols }, () => null);

  for (let rowIndex = V21_PIT_OBSERVATION_COUNT; rowIndex < BENCHMARK_ROWS; rowIndex += 1) {
    const windowStart = rowIndex - V21_PIT_OBSERVATION_COUNT;
    for (let symbolIndex = 0; symbolIndex < benchmarkSymbols; symbolIndex += 1) {
      const priorResiduals = residualSeries[symbolIndex].subarray(rowIndex - V21_PIT_OBSERVATION_COUNT, rowIndex);
      const result = evaluateExactExtremePredicate({
        priorResiduals,
        previousResidual: residualSeries[symbolIndex][rowIndex - 1],
        currentResidual: residualSeries[symbolIndex][rowIndex],
      });
      comparisonCounts.push(result.residualComparisons);
      if (result.earlyExit) earlyExitCount += 1;
      else fullWindowScans += 1;
      if (result.exactThresholdComputed) exactThresholdComputations += 1;
      if (result.currentExtreme) observedExtremeCount += 1;
      const previousWindowStart = previousWindowStarts[symbolIndex];
      if (previousWindowStart !== null && windowStart === previousWindowStart + 1) rollingWindowShifts += 1;
      previousWindowStarts[symbolIndex] = windowStart;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const sorted = [...comparisonCounts].sort((left, right) => left - right);
  const evaluatedPredicates = comparisonCounts.length;
  const totalResidualComparisons = comparisonCounts.reduce((sum, value) => sum + value, 0);
  const earlyExitRate = earlyExitCount / evaluatedPredicates;
  const exactThresholdRate = exactThresholdComputations / evaluatedPredicates;
  const averageResidualComparisons = totalResidualComparisons / evaluatedPredicates;
  return {
    family,
    seed: deriveFamilySeed(familyIndex),
    benchmarkRows: BENCHMARK_ROWS,
    benchmarkSymbols,
    evaluatedPredicates,
    totalResidualComparisons,
    averageResidualComparisons,
    medianResidualComparisons: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95ResidualComparisons: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99ResidualComparisons: sorted[Math.ceil(sorted.length * 0.99) - 1],
    fullWindowScans,
    earlyExitCount,
    earlyExitRate,
    exactThresholdComputations,
    exactThresholdRate,
    observedExtremeCount,
    observedExtremeRate: observedExtremeCount / evaluatedPredicates,
    elapsedMs,
    predicatesPerSecond: evaluatedPredicates / (elapsedMs / 1000),
    rollingWindowAdvanced: rollingWindowShifts === (BENCHMARK_ROWS - V21_PIT_OBSERVATION_COUNT - 1) * benchmarkSymbols,
    rollingWindowShifts,
    currentAndPriorSameProcess: true,
    performancePass: averageResidualComparisons <= 2000 && earlyExitRate >= 0.95 && exactThresholdRate <= 0.05,
  };
}

function buildFamilySeries(family: BenchmarkFamily, familyIndex: number, symbolIndex: number): Float64Array {
  const random = { state: deriveSymbolSeed(familyIndex, symbolIndex) };
  const series = new Float64Array(BENCHMARK_ROWS);
  let previous = 0;
  for (let timeIndex = 0; timeIndex < BENCHMARK_ROWS; timeIndex += 1) {
    if (family === "STATIONARY") {
      series[timeIndex] = 0.008 * nextNormal(random);
      continue;
    }
    if (family === "HETEROSKEDASTIC") {
      const phase = (timeIndex + (symbolIndex + 1) * 211) / 3000;
      const sigma = 0.006 * (1 + 0.55 * (0.5 + 0.5 * Math.sin(phase)));
      series[timeIndex] = sigma * nextNormal(random);
      continue;
    }
    if (family === "HEAVY_TAIL") {
      const sigma = nextUniform(random) < 0.96 ? 0.007 : 0.04;
      series[timeIndex] = sigma * nextNormal(random);
      continue;
    }
    const innovation = 0.006 * nextNormal(random);
    previous = 0.65 * previous + innovation;
    series[timeIndex] = previous;
  }
  return series;
}

function deriveFamilySeed(familyIndex: number): number {
  return deriveSeed(familyIndex + 1, 0);
}

function deriveSymbolSeed(familyIndex: number, symbolIndex: number): number {
  return deriveSeed(familyIndex + 1, symbolIndex + 1);
}

function deriveSeed(left: number, right: number): number {
  let seed = Math.imul(BENCHMARK_SEED ^ Math.imul(left, 0x9e3779b1), right + 0x85ebca6b);
  seed = (seed ^ (seed >>> 16)) >>> 0;
  return seed === 0 ? 0x6d2b79f5 : seed;
}

function nextUniform(random: { state: number }): number {
  let value = random.state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  random.state = value >>> 0;
  return random.state / 4294967296;
}

function nextNormal(random: { state: number }): number {
  const first = Math.max(nextUniform(random), Number.MIN_VALUE);
  const second = nextUniform(random);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
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
