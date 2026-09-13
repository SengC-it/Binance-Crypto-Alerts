import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  IPV1_BASELINE_STRATEGY_VERSION,
  IPV1_CHALLENGER_STRATEGY_VERSION,
  IPV1_EMAIL_GATE_MIN_CLOSED_TRADES,
  IPV1_HYPOTHESIS_FROZEN_AT_UTC,
  IPV1_PRIMARY_EXECUTION,
  IPV1_STRESS_EXECUTION,
} from "@/lib/ipv1/types";

const EXPECTED_BRANCH = "experiment/profit-recovery-stopband-shadow";
const STARTING_HEAD = "f759ff9c3737455bee3dc5c411feb6c422fe324c";
const repoRoot = process.cwd();

const allowedChangedFiles = new Set([
  ".github/workflows/ci.yml",
  ".gitignore",
  "lib/ipv1/execution.ts",
  "lib/ipv1/gate.ts",
  "lib/ipv1/metrics.ts",
  "lib/ipv1/replay.ts",
  "lib/ipv1/types.ts",
  "package.json",
  "reports/ipv1-contract.json",
  "scripts/run-ipv1.ts",
  "scripts/validate-ipv1.ts",
  "scripts/validate-prc1.ts",
  "tests/ipv1.test.ts",
]);

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function readRepoFile(file: string): string {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readRepoFile(file)) as Record<string, unknown>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assertCondition(actual === expected, `${label}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertIncludes(source: string, fragment: string, label: string): void {
  assertCondition(source.includes(fragment), `${label}: missing ${fragment}`);
}

function main(): void {
  const branch = process.env.GITHUB_HEAD_REF || git(["branch", "--show-current"]);
  assertEqual(branch, EXPECTED_BRANCH, "IPV-1 branch");
  const head = git(["rev-parse", "HEAD"]);
  assertCondition(git(["status", "--porcelain"]) === "", "IPV-1 worktree must be clean");
  const commits = git(["rev-list", "--reverse", "--ancestry-path", `${STARTING_HEAD}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertEqual(commits.length, 1, "IPV-1 implementation commit count");
  const parents = git(["rev-list", "--parents", "-n", "1", commits[0]]).split(/\s+/).slice(1);
  assertEqual(parents.length, 1, "IPV-1 implementation parent count");
  assertEqual(parents[0], STARTING_HEAD, "IPV-1 implementation parent");

  const changedFiles = git(["diff", "--name-only", `${STARTING_HEAD}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertCondition(changedFiles.length > 0, "IPV-1 diff must not be empty");
  for (const file of changedFiles) {
    assertCondition(allowedChangedFiles.has(file), `unexpected IPV-1 file changed: ${file}`);
    assertCondition(!file.startsWith("supabase/migrations/"), `migration is not allowed: ${file}`);
  }

  const contract = readJson("reports/ipv1-contract.json");
  assertEqual(contract.experimentId, "IPV1_INDEPENDENT_EMAIL_PROFIT_VALIDATION", "experiment identity");
  assertEqual(contract.hypothesisFrozenAtUtc, IPV1_HYPOTHESIS_FROZEN_AT_UTC, "freeze timestamp");
  assertEqual(contract.baselineStrategyVersion, IPV1_BASELINE_STRATEGY_VERSION, "baseline strategy");
  assertEqual(contract.challengerStrategyVersion, IPV1_CHALLENGER_STRATEGY_VERSION, "challenger strategy");
  assertEqual(contract.stopDistanceFormula, "abs(plan.stopPrice - plan.entryPrice) / plan.entryPrice * 100", "stop formula");
  assertEqual(contract.stopBandRule, "REJECT_IF_2_5_LE_X_LT_3_5", "stop band");
  assertEqual(contract.stopDistanceLowerPct, 2.5, "lower boundary");
  assertEqual(contract.stopDistanceUpperPct, 3.5, "upper boundary");
  const candidateEligibility = contract.candidateEligibility as unknown[];
  assertCondition(candidateEligibility.includes("scan_group.status = COMPLETED"), "completed group contract");
  assertCondition(candidateEligibility.includes("score DESC"), "score ordering contract");
  assertCondition(candidateEligibility.includes("symbol ASC"), "symbol ordering contract");
  const execution = contract.execution as Record<string, unknown>;
  assertEqual(execution.primaryHumanDelaySeconds, IPV1_PRIMARY_EXECUTION.humanDelaySeconds, "primary delay");
  assertEqual(execution.primarySlippageBps, IPV1_PRIMARY_EXECUTION.slippageBps, "primary slippage");
  assertEqual(execution.primaryTakerFeeRate, IPV1_PRIMARY_EXECUTION.takerFeeRate, "primary fee");
  assertEqual(execution.stressHumanDelaySeconds, IPV1_STRESS_EXECUTION.humanDelaySeconds, "stress delay");
  assertEqual(execution.stressSlippageBps, IPV1_STRESS_EXECUTION.slippageBps, "stress slippage");
  assertEqual(execution.stressTakerFeeRate, IPV1_STRESS_EXECUTION.takerFeeRate, "stress fee");
  const virtualLedger = contract.virtualLedger as Record<string, unknown>;
  assertEqual(virtualLedger.initialPosition, "FLAT", "initial position");
  assertEqual(virtualLedger.initialCooldowns, "EMPTY", "initial cooldowns");
  assertEqual(virtualLedger.maxOpenPositions, 1, "max open positions");
  assertEqual(virtualLedger.symbolCooldownHours, 8, "cooldown hours");
  assertEqual(virtualLedger.cooldownBlockedDoesNotFallback, true, "cooldown fallback policy");
  const gate = contract.emailPilotGate as Record<string, unknown>;
  assertEqual(gate.minimumChallengerClosedTrades, IPV1_EMAIL_GATE_MIN_CLOSED_TRADES, "pilot gate sample threshold");
  assertEqual(gate.automaticPromotion, false, "automatic promotion");
  assertEqual(gate.signalEmailEnabled, false, "signal email");
  const benchmarkContext = contract.historicalBenchmarksContextOnly as Record<string, unknown>;
  assertEqual(benchmarkContext.usedAsIndependentSample, false, "historical benchmark sample marker");
  assertEqual(contract.productionChanged, false, "production changed");
  assertEqual(contract.migrationApplied, false, "migration applied");
  assertEqual(contract.deploymentPerformed, false, "deployment performed");
  assertEqual(contract.autoTrading, false, "auto trading");
  assertEqual(contract.orderPlacement, false, "order placement");

  const packageJson = readJson("package.json");
  const scripts = packageJson.scripts as Record<string, unknown>;
  assertEqual(scripts["ipv1:run"], "tsx scripts/run-ipv1.ts", "run script");
  assertEqual(scripts["validate:ipv1"], "tsx scripts/validate-ipv1.ts", "validator script");
  const workflow = readRepoFile(".github/workflows/ci.yml");
  assertIncludes(workflow, "- run: pnpm validate:ipv1", "CI IPV-1 validation");
  assertIncludes(readRepoFile(".gitignore"), "artifacts/", "ignored artifacts");

  const sourceFiles = [
    "lib/ipv1/types.ts",
    "lib/ipv1/replay.ts",
    "lib/ipv1/execution.ts",
    "lib/ipv1/metrics.ts",
    "lib/ipv1/gate.ts",
    "scripts/run-ipv1.ts",
  ];
  const source = sourceFiles.map(readRepoFile).join("\n");
  assertCondition(!/\.from\([^)]*\)\s*\.(insert|update|delete|upsert|rpc)\s*\(/.test(source), "IPV-1 must be read-only");
  assertCondition(!/createOrder|newOrder|cancelOrder|positionRisk|account|apiKey|secret/i.test(source), "IPV-1 cannot use private trading APIs");
  assertCondition(!source.includes("Date.now()"), "IPV-1 must use explicit as-of only");
  const forbiddenTable = ["bca", "_shadow", "_paper", "_trades"].join("");
  assertCondition(!source.includes(forbiddenTable), "IPV-1 cannot use historical paper trades as a sample");
  assertIncludes(source, "COMPLETED", "completed group filter");
  assertIncludes(source, "60", "primary delay contract");
  assertIncludes(source, "180", "stress delay contract");
  assertIncludes(source, "0.0004", "fee contract");
  assertIncludes(source, "point.fundingTime > entryCandle.openTime && point.fundingTime <= exit.candle.closeTime", "funding boundaries");
  assertIncludes(source, "IPV1_GATE_COLLECTING", "collecting gate");
  assertIncludes(source, "IPV1_GATE_PASS", "pass gate");
  assertIncludes(source, "IPV1_GATE_FAIL", "fail gate");

  console.log(`IPV-1 validation passed for ${head}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
