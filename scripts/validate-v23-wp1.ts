import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  V23_BASE_SHA,
  V23_BRANCH,
  V23_COVERAGE_THRESHOLD,
  V23_END_MS,
  V23_EXPERIMENT_ID,
  V23_INTERVAL_MS,
  V23_MAX_ALLOWED_GAP_HOURS,
  V23_R1_ADMISSION_SHA,
  V23_REQUIRED_SERIES,
  V23_START_MS,
  V23_TARGET_SYMBOLS,
  V23_UNDERLYINGS,
  V23_V22_TERMINAL_SHA,
} from "@/lib/v23/types";

type JsonObject = Record<string, unknown>;

const REPORTS = [
  "reports/v23-admission.json",
  "reports/v23-data-inventory.json",
  "reports/v23-data-gate.json",
  "reports/v23-roll-audit.json",
  "reports/v23-basis-construction-feasibility.json",
  "reports/v23-live-feed-feasibility.json",
  "reports/v23-wp1-manifest.json",
] as const;
const SOURCES = [
  "lib/v23/types.ts",
  "lib/v23/data.ts",
  "scripts/download-v23-data.ts",
  "scripts/run-v23-data-gate.ts",
  "scripts/validate-v23-wp1.ts",
  "tests/v23-data.test.ts",
] as const;
const ALLOWED_CHANGED_FILES = new Set<string>([
  ".github/workflows/ci.yml",
  "package.json",
  ...SOURCES,
  ...REPORTS,
]);
const EXPECTED_SERIES = [...V23_REQUIRED_SERIES];
const EXPECTED_ROWS = (V23_END_MS - V23_START_MS) / V23_INTERVAL_MS;

function fail(message: string): never {
  throw new Error(`V23 WP1 validation failed: ${message}`);
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function record(value: unknown, label: string): JsonObject {
  requireThat(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  requireThat(Array.isArray(value), `${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  requireThat(typeof value === "string", `${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  requireThat(typeof value === "number" && Number.isFinite(value), `${label} must be finite`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  requireThat(typeof value === "boolean", `${label} must be boolean`);
  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitJson(spec: string): JsonObject {
  return record(JSON.parse(execFileSync("git", ["show", spec], { encoding: "utf8" })), spec);
}

function jsonFile(path: string): JsonObject {
  return record(JSON.parse(readFileSync(resolve(path), "utf8")), path);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function candidateCommit(): string {
  const headRef = process.env.GITHUB_HEAD_REF?.trim();
  if (!headRef) return git(["rev-parse", "HEAD"]);
  const parents = git(["show", "-s", "--format=%P", "HEAD"]).split(/\s+/).filter(Boolean);
  if (parents.length >= 2) return parents[1]!;
  try {
    return git(["rev-parse", `origin/${headRef}`]);
  } catch {
    return git(["rev-parse", "HEAD"]);
  }
}

function validateChangedFiles(candidate: string): void {
  const lines = git(["diff", "--name-status", V23_BASE_SHA, candidate]).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    requireThat(!/^[DR]/.test(status), `deletion/rename is not allowed: ${line}`);
    for (const path of fields.slice(1)) requireThat(ALLOWED_CHANGED_FILES.has(path), `unexpected changed file: ${path}`);
  }
  const v23Reports = readdirSync(resolve("reports")).filter((name) => name.startsWith("v23-"));
  requireThat(v23Reports.every((name) => REPORTS.some((path) => path === `reports/${name}`)), "unexpected V23 report artifact");
}

function validateAdmission(): void {
  const exhausted = gitJson(`${V23_R1_ADMISSION_SHA}:reports/r1-exhausted-alpha-families.json`);
  const registryIds = array(exhausted.registryExperimentIds, "R1 registryExperimentIds");
  requireThat(!registryIds.includes(V23_EXPERIMENT_ID), "V23 is already in exhausted registry");
  const completeness = record(exhausted.registryCompleteness, "R1 registryCompleteness");
  requireThat(completeness.exactSetEquality === true, "R1 registry is not exact");
  const admission = gitJson(`${V23_R1_ADMISSION_SHA}:reports/r1-future-research-admission.json`);
  const dimensions = array(admission.structuralOrthogonalityDimensions, "R1 dimensions");
  for (const dimension of ["information_source", "derivative_state", "economic_mechanism"]) requireThat(dimensions.includes(dimension), `R1 dimension missing: ${dimension}`);
  requireThat(admission.structuralOrthogonalityRule === "STRUCTURALLY_ORTHOGONAL", "R1 orthogonality rule drifted");
  requireThat(admission.noSpecificStrategyDesign === true && admission.noThresholdsOrParameters === true, "R1 admission permits strategy design or thresholds");
}

function validateQuality(inventory: JsonObject, gate: JsonObject): void {
  const inventoryByUnderlying = record(inventory.byUnderlying, "inventory.byUnderlying");
  const gateByUnderlying = record(gate.byUnderlying, "gate.byUnderlying");
  for (const underlying of V23_UNDERLYINGS) {
    const inventoryEntry = record(inventoryByUnderlying[underlying], `${underlying} inventory`);
    requireThat(inventoryEntry.targetSymbol === V23_TARGET_SYMBOLS[underlying], `${underlying} target symbol drifted`);
    requireThat(number(inventoryEntry.expected1hRows, `${underlying} expected rows`) === EXPECTED_ROWS, `${underlying} expected row calculation drifted`);
    const series = record(inventoryEntry.series, `${underlying} series`);
    const gateEntry = record(gateByUnderlying[underlying], `${underlying} gate`);
    requireThat(gateEntry.synchronizedRows === inventoryEntry.synchronizedRows && gateEntry.synchronizedCoverage === inventoryEntry.synchronizedCoverage, `${underlying} synchronization report mismatch`);
    requireThat(number(inventoryEntry.synchronizedRows, `${underlying} synchronized rows`) / EXPECTED_ROWS === number(inventoryEntry.synchronizedCoverage, `${underlying} synchronized coverage`), `${underlying} synchronization coverage is not reproducible`);
    for (const seriesType of EXPECTED_SERIES) {
      const quality = record(series[seriesType], `${underlying} ${seriesType}`);
      requireThat(number(quality.expectedRows, `${underlying} ${seriesType} expected`) === EXPECTED_ROWS, `${underlying} ${seriesType} expected rows drifted`);
      const actualRows = number(quality.actualRows, `${underlying} ${seriesType} actual`);
      requireThat(number(quality.coverageRatio, `${underlying} ${seriesType} coverage`) === actualRows / EXPECTED_ROWS, `${underlying} ${seriesType} coverage is not reproducible`);
      requireThat(number(quality.missingRows, `${underlying} ${seriesType} missing`) === EXPECTED_ROWS - actualRows, `${underlying} ${seriesType} missing row count mismatch`);
      for (const field of ["transportDuplicates", "identicalDuplicates", "conflictingDuplicates", "canonicalDuplicates", "canonicalNonMonotonic", "invalidRows", "maxContiguousMissingHours", "primary", "holdoutA", "holdoutB"]) requireThat(field in quality, `${underlying} ${seriesType} missing quality field ${field}`);
      for (const period of ["primary", "holdoutA", "holdoutB"]) {
        const periodQuality = record(quality[period], `${underlying} ${seriesType} ${period}`);
        requireThat(number(periodQuality.actualRows, `${underlying} ${seriesType} ${period} actual`) <= number(periodQuality.expectedRows, `${underlying} ${seriesType} ${period} expected`), `${underlying} ${seriesType} ${period} has excess rows`);
      }
      const gateMaxGap = record(gateEntry.maxGapHours, `${underlying} max gap`);
      requireThat(gateMaxGap[seriesType] === quality.maxContiguousMissingHours, `${underlying} ${seriesType} max gap mismatch`);
    }
  }
  requireThat(gate.requiredSeriesPass === false || gate.requiredSeriesPass === undefined, "unexpected global gate shape");
}

function validateArtifacts(): void {
  for (const path of REPORTS) requireThat(existsSync(resolve(path)), `missing report ${path}`);
  const admission = jsonFile("reports/v23-admission.json");
  const inventory = jsonFile("reports/v23-data-inventory.json");
  const gate = jsonFile("reports/v23-data-gate.json");
  const roll = jsonFile("reports/v23-roll-audit.json");
  const basis = jsonFile("reports/v23-basis-construction-feasibility.json");
  const live = jsonFile("reports/v23-live-feed-feasibility.json");
  const manifest = jsonFile("reports/v23-wp1-manifest.json");

  requireThat(admission.experimentId === V23_EXPERIMENT_ID && admission.structuralAdmissionPass === true, "admission artifact drifted");
  requireThat(inventory.experimentId === V23_EXPERIMENT_ID && inventory.interval === "1h" && inventory.start === new Date(V23_START_MS).toISOString() && inventory.endExclusive === new Date(V23_END_MS).toISOString(), "inventory range/source contract drifted");
  requireThat(inventory.noNearestTimestamp === true && inventory.noForwardFill === true && inventory.noBackfill === true && inventory.noInterpolation === true, "inventory permits data repair");
  validateQuality(inventory, gate);
  requireThat(gate.experimentId === V23_EXPERIMENT_ID && gate.coverageThreshold === V23_COVERAGE_THRESHOLD && gate.maximumAllowedGapHours === V23_MAX_ALLOWED_GAP_HOURS, "data gate policy drifted");
  requireThat(JSON.stringify(gate.requiredSeries) === JSON.stringify(EXPECTED_SERIES), "required series drifted");
  requireThat(gate.classification === "V23_TERM_STRUCTURE_DATA_INSUFFICIENT" && gate.dataGatePass === false && gate.researchStop === true && gate.remainingBudget === 1, "data gate classification drifted");
  for (const flag of ["historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) requireThat(gate[flag] === false, `data gate forbidden flag is not false: ${flag}`);
  requireThat(gate.productionEmail === "OFF", "data gate production email is not OFF");
  requireThat(roll.experimentId === V23_EXPERIMENT_ID && roll.diagnosticOnly === true && roll.noFutureReturns === true && roll.noSignalThreshold === true, "roll audit is not diagnostic-only");
  const rollByUnderlying = record(roll.byUnderlying, "roll.byUnderlying");
  for (const underlying of V23_UNDERLYINGS) requireThat(underlying in rollByUnderlying, `roll audit missing ${underlying}`);
  requireThat(basis.experimentId === V23_EXPERIMENT_ID && basis.noThreshold === true && basis.noPrediction === true && basis.noFutureReturns === true, "basis feasibility is not pre-return only");
  const basisByUnderlying = record(basis.byUnderlying, "basis.byUnderlying");
  for (const underlying of V23_UNDERLYINGS) {
    const entry = record(basisByUnderlying[underlying], `${underlying} basis feasibility`);
    for (const field of ["currentBasisFeasible", "nextBasisFeasible", "curveSlopeFeasible", "PITFeasible"]) requireThat(typeof entry[field] === "boolean", `${underlying} basis field missing ${field}`);
  }
  requireThat(live.authenticationRequired === false && live.tradingPermissionRequired === false && live.productionSupabaseWrites === false && live.emailSent === false, "live feed has unsafe capability");
  const probes = array(live.probes, "live probes");
  requireThat(probes.length === V23_UNDERLYINGS.length * EXPECTED_SERIES.length, "live feed probe set drifted");

  requireThat(manifest.schema === "v23-wp1-manifest-v1" && manifest.experimentId === V23_EXPERIMENT_ID && manifest.branch === V23_BRANCH && manifest.baseSha === V23_BASE_SHA && manifest.directParent === V23_BASE_SHA, "manifest identity drifted");
  requireThat(JSON.stringify(manifest.fixedUnderlyings) === JSON.stringify([...V23_UNDERLYINGS]), "manifest underlying set drifted");
  requireThat(JSON.stringify(manifest.fixedTargetSymbols) === JSON.stringify(Object.values(V23_TARGET_SYMBOLS)), "manifest target symbol set drifted");
  requireThat(manifest.interval === "1h" && manifest.start === new Date(V23_START_MS).toISOString() && manifest.endExclusive === new Date(V23_END_MS).toISOString(), "manifest range drifted");
  requireThat(manifest.r1AdmissionVerified === true && manifest.familyBudgetConsumed === true && manifest.budgetBefore === 2 && manifest.remainingOrthogonalFamilyBudget === 1, "admission budget drifted");
  for (const flag of ["signalDesigned", "eventDefinitionDesigned", "historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) requireThat(manifest[flag] === false, `manifest forbidden flag is not false: ${flag}`);
  requireThat(manifest.productionEmail === "OFF" && manifest.dataGateClassification === "V23_TERM_STRUCTURE_DATA_INSUFFICIENT" && manifest.researchStop === true && manifest.noRepair === true && manifest.noThirdPartyData === true, "manifest safety/classification drifted");
  requireThat(manifest.historicalBasisEndpointEligible === false && manifest.historicalBasisEndpointWindow === "latest 30 days only", "historical basis shortcut was not excluded");

  const reportHashes = record(manifest.reportSha256, "manifest.reportSha256");
  for (const path of REPORTS.slice(0, -1)) requireThat(reportHashes[path] === sha256(path), `report hash mismatch: ${path}`);
  const sourceHashes = record(manifest.sourceFileSha256, "manifest.sourceFileSha256");
  for (const path of SOURCES) requireThat(sourceHashes[path] === sha256(path), `source hash mismatch: ${path}`);
}

function validateWorkflow(): void {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const commands = ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm validate:v5-5", "pnpm validate:v23:wp1"];
  let previous = -1;
  for (const command of commands) {
    const index = workflow.indexOf(command);
    requireThat(index > previous, `CI command missing or out of order: ${command}`);
    previous = index;
  }
  requireThat(readFileSync(resolve("package.json"), "utf8").includes('"validate:v23:wp1"'), "package script missing");
}

function main(): void {
  const branch = process.env.GITHUB_HEAD_REF?.trim() || git(["branch", "--show-current"]);
  requireThat(branch === V23_BRANCH, `branch mismatch: ${branch}`);
  const candidate = candidateCommit();
  requireThat(git(["cat-file", "-e", `${V23_BASE_SHA}^{commit}`]) === "", "exact base commit is unavailable");
  requireThat(git(["merge-base", candidate, V23_BASE_SHA]) === V23_BASE_SHA, "merge base is not the exact Production base");
  requireThat(git(["rev-parse", `${candidate}^`]) === V23_BASE_SHA, "WP1 commit is not directly based on exact base");
  requireThat(git(["rev-list", "--count", `${V23_BASE_SHA}..${candidate}`]) === "1", "more than one WP1 commit exists");
  validateChangedFiles(candidate);
  validateAdmission();
  const v22Terminal = gitJson(`${V23_V22_TERMINAL_SHA}:reports/v22-event-enumeration.json`);
  requireThat(v22Terminal.classification === "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT" && v22Terminal.researchStop === true, "V22 terminal state drifted");
  validateArtifacts();
  validateWorkflow();
  console.info(JSON.stringify({ stage: "v23_wp1_validation_pass", branch, candidate, classification: "V23_TERM_STRUCTURE_DATA_INSUFFICIENT", historicalStrategyOutcomeReturnsRead: false, forwardReturnsRead: false }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
