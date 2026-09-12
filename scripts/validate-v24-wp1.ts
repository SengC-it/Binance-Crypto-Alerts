import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  V24_BASE_SHA,
  V24_END_MS,
  V24_EXPERIMENT_ID,
  V24_R1_ADMISSION_SHA,
  V24_START_MS,
  V24_SYMBOLS,
  V24_V22_TERMINAL_SHA,
  V24_V23_TERMINAL_SHA,
} from "@/lib/v24/types";

const allowedFiles = new Set([
  ".gitignore",
  ".github/workflows/ci.yml",
  "package.json",
  "lib/v24/data.ts",
  "lib/v24/types.ts",
  "scripts/download-v24-data.ts",
  "scripts/run-v24-data-gate.ts",
  "scripts/validate-v24-wp1.ts",
  "tests/v24-data.test.ts",
  "reports/v24-admission.json",
  "reports/v24-data-inventory.json",
  "reports/v24-data-gate.json",
  "reports/v24-depth-anomalies.json",
  "reports/v24-feature-feasibility.json",
  "reports/v24-live-feed-feasibility.json",
  "reports/v24-wp1-manifest.json",
]);

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function jsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function jsonAt(commit: string, path: string): Record<string, unknown> {
  return JSON.parse(execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" })) as Record<string, unknown>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactParentCandidate(): { candidate: string; branch: string } {
  const head = git(["rev-parse", "HEAD"]);
  const parents = git(["rev-list", "--parents", "-n", "1", head]).split(/\s+/).slice(1);
  const isPullRequestCheckout = Boolean(process.env.GITHUB_HEAD_REF);
  const candidate = isPullRequestCheckout && parents.length >= 2 ? parents[1]! : head;
  return { candidate, branch: process.env.GITHUB_HEAD_REF || git(["branch", "--show-current"]) };
}

function validateReports(candidate: string): void {
  const admission = jsonFile("reports/v24-admission.json");
  const inventory = jsonFile("reports/v24-data-inventory.json");
  const gate = jsonFile("reports/v24-data-gate.json");
  const anomalies = jsonFile("reports/v24-depth-anomalies.json");
  const features = jsonFile("reports/v24-feature-feasibility.json");
  const live = jsonFile("reports/v24-live-feed-feasibility.json");
  const manifest = jsonFile("reports/v24-wp1-manifest.json");
  assertCondition(admission.experimentId === V24_EXPERIMENT_ID, "V24 admission experiment drift");
  assertCondition(admission.admissionPass === true && admission.r1AdmissionVerified === true && admission.r1ExhaustedRegistryVerified === true, "V24 admission not verified");
  assertCondition(admission.budgetBefore === 1 && admission.budgetConsumed === 1 && admission.remainingOrthogonalFamilyBudget === 0, "V24 budget transition drift");
  assertCondition(inventory.experimentId === V24_EXPERIMENT_ID && inventory.source === "Binance official Data Vision USD-M daily bookDepth and 5m kline archives", "V24 inventory source drift");
  assertCondition(inventory.start === new Date(V24_START_MS).toISOString() && inventory.endExclusive === new Date(V24_END_MS).toISOString(), "V24 range drift");
  assertCondition(JSON.stringify(inventory.fixedSymbols) === JSON.stringify(V24_SYMBOLS), "V24 fixed symbols drift");
  assertCondition(JSON.stringify(inventory.requiredBands) === JSON.stringify([-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]), "V24 required bands drift");
  assertCondition(gate.experimentId === V24_EXPERIMENT_ID && gate.budgetBefore === 1 && gate.budgetConsumed === 1 && gate.remainingOrthogonalFamilyBudget === 0, "V24 gate identity or budget drift");
  assertCondition(["V24_LIQUIDITY_DATA_GATE_PASS", "V24_LIQUIDITY_DATA_INSUFFICIENT", "V24_LIQUIDITY_DATA_QUALITY_FAIL"].includes(String(gate.classification)), "Unknown V24 classification");
  assertCondition(gate.researchStop === (gate.classification !== "V24_LIQUIDITY_DATA_GATE_PASS"), "V24 research stop mismatch");
  assertCondition(gate.historicalStrategyOutcomeReturnsRead === false && gate.forwardReturnsRead === false && gate.futureOutcomePricesRead === false && gate.backtestRun === false && gate.parameterSearch === false && gate.promotionEvaluated === false, "V24 gate read forbidden outcome data");
  assertCondition(anomalies.strategyOutcomesRead === false && anomalies.noFutureData === true, "V24 anomaly audit outcome boundary drift");
  assertCondition(features.contemporaneousOnly === true && features.noThresholds === true && features.noFutureData === true, "V24 feature feasibility boundary drift");
  assertCondition(live.publicOnly === true && live.noProductionWrites === true && live.noEmail === true && live.noTrading === true, "V24 live feed boundary drift");
  assertCondition(manifest.experimentId === V24_EXPERIMENT_ID && manifest.baseSha === V24_BASE_SHA && manifest.r1AdmissionVerified === true && manifest.v22TerminalVerified === true && manifest.v23TerminalVerified === true, "V24 manifest provenance drift");
  assertCondition(manifest.familyBudgetConsumed === true && manifest.budgetBefore === 1 && manifest.remainingOrthogonalFamilyBudget === 0, "V24 manifest budget drift");
  for (const key of ["signalDesigned", "eventDefinitionDesigned", "historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) assertCondition(manifest[key] === false, `V24 forbidden flag drift: ${key}`);
  assertCondition(manifest.productionEmail === "OFF", "V24 production email drift");
  const artifacts = manifest.artifactSha256 as Record<string, string>;
  for (const path of ["reports/v24-admission.json", "reports/v24-data-inventory.json", "reports/v24-data-gate.json", "reports/v24-depth-anomalies.json", "reports/v24-feature-feasibility.json", "reports/v24-live-feed-feasibility.json"]) assertCondition(artifacts[path] === sha256(path), `V24 artifact hash mismatch: ${path}`);
  assertCondition(typeof manifest.rawManifestSha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.rawManifestSha256), "V24 raw manifest hash missing");
  void candidate;
}

function main(): void {
  const { candidate, branch } = exactParentCandidate();
  assertCondition(branch === "feat/v24-liquidity-withdrawal", `V24 branch mismatch: ${branch}`);
  assertCondition(git(["rev-parse", candidate]) === candidate, "V24 candidate is not a commit");
  assertCondition(git(["rev-parse", `${candidate}^`]) === V24_BASE_SHA, "V24 direct parent is not exact Production base");
  assertCondition(git(["rev-list", "--count", `${V24_BASE_SHA}..${candidate}`]) === "1", "V24 contains more than one Data Stage commit");
  assertCondition(git(["merge-base", candidate, V24_BASE_SHA]) === V24_BASE_SHA, "V24 ancestry does not start at exact base");
  const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", candidate]).split(/\r?\n/).filter(Boolean);
  assertCondition(changed.length > 0 && changed.every((path) => allowedFiles.has(path)), `V24 unexpected changed files: ${changed.filter((path) => !allowedFiles.has(path)).join(", ")}`);
  assertCondition(readFileSync(resolve(".gitignore"), "utf8").includes("data/raw/v24/"), "V24 raw directory is not gitignored");
  const v22 = jsonAt(V24_V22_TERMINAL_SHA, "reports/v22-pre-return-freeze-manifest.json");
  const v23 = jsonAt(V24_V23_TERMINAL_SHA, "reports/v23-data-gate.json");
  const r1 = jsonAt(V24_R1_ADMISSION_SHA, "reports/r1-future-research-admission.json");
  assertCondition(v22.classification === "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT" && v22.researchStop === true && v22.historicalStrategyOutcomeReturnsRead === false, "V22 terminal provenance drift");
  assertCondition(v23.classification === "V23_TERM_STRUCTURE_DATA_INSUFFICIENT" && v23.researchStop === true && v23.historicalStrategyOutcomeReturnsRead === false, "V23 terminal provenance drift");
  assertCondition((r1.structuralOrthogonalityDimensions as string[]).includes("liquidity_mechanism") && (r1.noDataQuery as boolean | undefined) === true && r1.noBacktest === true, "R1 admission provenance drift");
  const source = readFileSync(resolve("scripts/run-v24-data-gate.ts"), "utf8");
  assertCondition(!source.includes("runBacktest") && !source.includes("strategy returns") && !source.includes("PnL"), "V24 data stage contains outcome analysis");
  const downloader = readFileSync(resolve("scripts/download-v24-data.ts"), "utf8");
  assertCondition(downloader.includes("data.binance.vision") && downloader.includes("daily/bookDepth") && downloader.includes("checksumVerified"), "V24 downloader source policy drift");
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const workflowCommands = ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm validate:v5-5", "pnpm validate:v24:wp1"];
  let previous = -1;
  for (const command of workflowCommands) {
    const next = workflow.indexOf(command);
    assertCondition(next > previous, `V24 CI command missing or out of order: ${command}`);
    previous = next;
  }
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  assertCondition(packageJson.scripts?.["validate:v24:wp1"] === "tsx scripts/validate-v24-wp1.ts", "V24 validator package script missing");
  validateReports(candidate);
  console.info(JSON.stringify({ stage: "v24_wp1_validation_pass", branch, candidate, base: V24_BASE_SHA, classification: jsonFile("reports/v24-data-gate.json").classification, historicalStrategyOutcomeReturnsRead: false, forwardReturnsRead: false }));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ stage: "v24_wp1_validation_fail", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
