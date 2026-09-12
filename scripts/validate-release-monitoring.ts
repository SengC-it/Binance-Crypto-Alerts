import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const EXPECTED_BRANCH = "release/monitoring-only-v1";
const RELEASE_BASE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const R1_COMMIT = "6c5c415023683b6d8905aae2444af28d1510d9b6";
const V22_COMMIT = "160cf38780dfd14ed8e6119bcb6c6841fad6fd93";
const V22_TERMINAL_FILE = "reports/v22-pre-return-freeze-manifest.json";
const V23_COMMIT = "c6e9f008b308317f777ff4685575b32673306f15";
const V24_COMMIT = "44442c1b20b90536295d0b1be56d215dc4aba72d";
const EXPECTED_STOP_STATUS = "STOP_NEW_ALPHA_RESEARCH";

const repoRoot = process.cwd();

const allowedReleaseFiles = new Set([
  ".github/workflows/ci.yml",
  "app/api/health/route.ts",
  "app/api/scan/route.ts",
  "app/globals.css",
  "app/page.tsx",
  "lib/core/release-policy.ts",
  "lib/notifications/email.ts",
  "package.json",
  "reports/monitoring-only-release.json",
  "scripts/validate-release-monitoring.ts",
  "tests/release-policy.test.ts",
]);

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function readJsonAt(commit: string, file: string): Record<string, unknown> {
  git(["cat-file", "-e", `${commit}:${file}`]);
  return JSON.parse(git(["show", `${commit}:${file}`])) as Record<string, unknown>;
}

function readRepoFile(file: string): string {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assertCondition(actual === expected, `${label}: expected ${String(expected)}, received ${String(actual)}`);
}

function main(): void {
  const branch = process.env.GITHUB_HEAD_REF || git(["branch", "--show-current"]);
  assertEqual(branch, EXPECTED_BRANCH, "release branch");

  const head = git(["rev-parse", "HEAD"]);
  const releaseCommits = git(["rev-list", "--reverse", "--ancestry-path", `${RELEASE_BASE}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertCondition(releaseCommits.length > 0, "release branch must contain a release commit");
  const firstReleaseParents = git(["rev-list", "--parents", "-n", "1", releaseCommits[0]]).split(/\s+/).slice(1);
  assertEqual(firstReleaseParents.length, 1, "first release commit parent count");
  assertEqual(firstReleaseParents[0], RELEASE_BASE, "first release commit direct parent");
  assertEqual(git(["status", "--porcelain"]), "", "release worktree status");

  const changedFiles = git(["diff", "--name-only", `${RELEASE_BASE}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertCondition(changedFiles.length > 0, "release diff must not be empty");
  for (const file of changedFiles) {
    assertCondition(allowedReleaseFiles.has(file), `unexpected release file changed: ${file}`);
    assertCondition(!/(^|[\\/])v(22|23|24|25)([\\/.-]|$)/i.test(file), `research implementation added: ${file}`);
  }

  const r1 = readJsonAt(R1_COMMIT, "reports/r1-wp3-decision.json");
  const r1StopRule = r1.programStopRule as Record<string, unknown> | undefined;
  assertEqual(r1StopRule?.alphaResearchProgramStatus, EXPECTED_STOP_STATUS, "R1 stop status");

  const v22 = readJsonAt(V22_COMMIT, V22_TERMINAL_FILE);
  assertEqual(v22.experimentId, "V22_CROSS_VENUE_PRICE_DISCOVERY", "V22 experiment identity");
  const v22Enumeration = v22.primaryEnumeration as Record<string, unknown> | undefined;
  assertEqual(v22Enumeration?.acceptedPrimaryOos, 48, "V22 accepted primary OOS events");
  const v22SampleGate = v22Enumeration?.sampleGate as Record<string, unknown> | undefined;
  assertEqual(v22SampleGate?.primaryOosDistinctClusters, 32, "V22 primary OOS clusters");
  assertEqual(v22SampleGate?.pass, false, "V22 sample gate");
  assertEqual(v22.classification, "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT", "V22 terminal classification");
  assertEqual(v22.researchStop, true, "V22 research stop");
  assertEqual(v22.historicalStrategyOutcomeReturnsRead, false, "V22 historical outcome returns read");
  assertEqual(v22.executionOutcomePricesRead, false, "V22 execution outcome prices read");
  assertEqual(v22.backtestRun, false, "V22 backtest run");
  assertEqual(v22.promotionEvaluated, false, "V22 promotion evaluated");

  const v23 = readJsonAt(V23_COMMIT, "reports/v23-data-gate.json");
  assertEqual(v23.classification, "V23_TERM_STRUCTURE_DATA_INSUFFICIENT", "V23 terminal classification");

  const v24 = readJsonAt(V24_COMMIT, "reports/v24-data-gate.json");
  assertEqual(v24.classification, "V24_LIQUIDITY_DATA_QUALITY_FAIL", "V24 terminal classification");
  assertEqual(v24.remainingOrthogonalFamilyBudget, 0, "remaining orthogonal family budget");
  assertEqual(v24.alphaResearchProgramStatus, EXPECTED_STOP_STATUS, "V24 stop status");

  const manifest = JSON.parse(readRepoFile("reports/monitoring-only-release.json")) as Record<string, unknown>;
  const terminalResearchEvidence = manifest.terminalResearchEvidence as Record<string, unknown> | undefined;
  const v22Evidence = terminalResearchEvidence?.v22 as Record<string, unknown> | undefined;
  assertEqual(v22Evidence?.commit, V22_COMMIT, "release V22 evidence commit");
  assertEqual(v22Evidence?.source, V22_TERMINAL_FILE, "release V22 evidence source");
  assertEqual(v22Evidence?.status, "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT", "release V22 evidence status");
  const v23Evidence = terminalResearchEvidence?.v23 as Record<string, unknown> | undefined;
  assertEqual(v23Evidence?.source, "reports/v23-data-gate.json", "release V23 evidence source");
  assertEqual(v23Evidence?.status, "V23_TERM_STRUCTURE_DATA_INSUFFICIENT", "release V23 evidence status");
  const v24Evidence = terminalResearchEvidence?.v24 as Record<string, unknown> | undefined;
  assertEqual(v24Evidence?.source, "reports/v24-data-gate.json", "release V24 evidence source");
  assertEqual(v24Evidence?.status, "V24_LIQUIDITY_DATA_QUALITY_FAIL", "release V24 evidence status");
  assertEqual(manifest.releaseMode, "MONITORING_ONLY", "release mode");
  assertEqual(manifest.releaseBaseCommit, RELEASE_BASE, "manifest release base");
  assertEqual(manifest.alphaResearchProgramStatus, EXPECTED_STOP_STATUS, "manifest research status");
  assertEqual(manifest.remainingResearchBudget, 0, "manifest research budget");
  assertEqual(manifest.productionStrategyVersion, "trend-rejection-short-v1", "production strategy version");
  assertEqual(manifest.productionStrategyPromoted, false, "production strategy promotion");
  assertEqual(manifest.signalEmailEnabled, false, "manifest signal email policy");
  assertEqual(manifest.systemAlertEmailAllowed, true, "system alert policy");
  assertEqual(manifest.paperTradingAllowed, true, "paper trading policy");
  assertEqual(manifest.shadowTradingAllowed, true, "shadow trading policy");
  assertEqual(manifest.automaticTrading, false, "automatic trading policy");
  assertEqual(manifest.orderPlacement, false, "order placement policy");
  assertEqual(manifest.previousLiveDeploymentSourceResolvable, false, "previous deployment provenance");
  assertEqual(manifest.productionDeployAuthorized, false, "production deploy authorization");
  assertEqual(manifest.productionChanged, false, "production change marker");
  assertEqual(manifest.migrationApplied, false, "migration marker");
  assertEqual(manifest.mergePerformed, false, "merge marker");

  const releasePolicy = readRepoFile("lib/core/release-policy.ts");
  assertCondition(/PRODUCTION_SIGNAL_EMAIL_ENABLED\s*=\s*false\b/.test(releasePolicy), "signal email must be code-level false");
  assertCondition(/PRODUCTION_STRATEGY_PROMOTED\s*=\s*false\b/.test(releasePolicy), "promotion must be code-level false");
  assertCondition(/AUTOMATIC_TRADING_ENABLED\s*=\s*false\b/.test(releasePolicy), "automatic trading must be code-level false");
  assertCondition(/ORDER_PLACEMENT_ENABLED\s*=\s*false\b/.test(releasePolicy), "order placement must be code-level false");

  const scanRoute = readRepoFile("app/api/scan/route.ts");
  assertCondition(
    scanRoute.includes("PRODUCTION_SIGNAL_EMAIL_ENABLED && hasEmailConfig && productionHealth.productionAAllowed"),
    "scan route must gate email with release policy, SMTP config, and health gate",
  );

  const emailRuntime = readRepoFile("lib/notifications/email.ts");
  assertCondition(emailRuntime.includes("if (!PRODUCTION_SIGNAL_EMAIL_ENABLED)"), "signal email defense-in-depth guard missing");
  assertCondition(emailRuntime.includes('reason: "RELEASE_POLICY_SIGNAL_EMAIL_DISABLED"'), "signal email policy reason missing");
  assertCondition(emailRuntime.includes("export async function sendSystemAlertEmail"), "system alert email path missing");
  assertCondition(emailRuntime.includes("return sendWithConfig(config, { subject, text, html });"), "system alert email must retain SMTP path");

  const runtimeSources = [
    "app/api/health/route.ts",
    "app/api/scan/route.ts",
    "app/page.tsx",
    "lib/core/release-policy.ts",
    "lib/notifications/email.ts",
  ].map(readRepoFile).join("\n");
  assertCondition(!runtimeSources.includes("BCA_SIGNAL_EMAIL_ENABLED"), "environment variable must not override signal email policy");
  assertCondition(
    !/\b(createOrder|newOrder|cancelOrder)\s*\(|\/(?:fapi|dapi|api)\/v\d+\/(?:account|order|positionRisk|leverage)\b/i.test(runtimeSources),
    "runtime contains private trading or order capability",
  );
  assertCondition(!/V25/i.test(runtimeSources), "V25 implementation detected in runtime");

  console.log(`Monitoring-only release validation passed for ${head}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
