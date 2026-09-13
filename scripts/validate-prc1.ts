import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_EXPERIMENT_ID,
  PRC1_FILTER_RULE,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
  PRC1_MIN_FORWARD_CLOSED_TRADES,
  PRC1_SINGLE_VARIABLE_CHANGE,
  PRC1_STOP_DISTANCE_LOWER_PCT,
  PRC1_STOP_DISTANCE_UPPER_PCT,
} from "@/lib/prc1/contract";

const STARTING_RELEASE_COMMIT = "df98dc47db398c3d4ad0d4d3a853aaad281b74ab";
const EXPECTED_BRANCH = "experiment/profit-recovery-stopband-shadow";

const allowedChangedFiles = new Set([
  ".github/workflows/ci.yml",
  "app/api/scan/route.ts",
  "lib/prc1/contract.ts",
  "lib/prc1/metrics.ts",
  "lib/prc1/stopband.ts",
  "lib/services/paper-trading.ts",
  "package.json",
  "reports/prc1-forward-contract.json",
  "reports/prc1-hypothesis-freeze.json",
  "reports/prc1-implementation-manifest.json",
  "scripts/validate-prc1.ts",
  "tests/prc1.test.ts",
]);

const repoRoot = process.cwd();

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function readRepoFile(file: string): string {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

function readRepoJson(file: string): Record<string, unknown> {
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
  assertEqual(branch, EXPECTED_BRANCH, "PRC-1 branch");

  const head = git(["rev-parse", "HEAD"]);
  git(["cat-file", "-e", `${STARTING_RELEASE_COMMIT}^{commit}`]);
  const commits = git(["rev-list", "--reverse", "--ancestry-path", `${STARTING_RELEASE_COMMIT}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertCondition(commits.length > 0, "PRC-1 branch must contain an implementation commit");
  const firstParents = git(["rev-list", "--parents", "-n", "1", commits[0]]).split(/\s+/).slice(1);
  assertEqual(firstParents.length, 1, "first PRC-1 commit parent count");
  assertEqual(firstParents[0], STARTING_RELEASE_COMMIT, "first PRC-1 commit parent");
  assertEqual(git(["status", "--porcelain"]), "", "PRC-1 worktree status");

  const changedFiles = git(["diff", "--name-only", `${STARTING_RELEASE_COMMIT}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  assertCondition(changedFiles.length > 0, "PRC-1 diff must not be empty");
  for (const file of changedFiles) {
    assertCondition(allowedChangedFiles.has(file), `unexpected PRC-1 file changed: ${file}`);
    assertCondition(!file.startsWith("supabase/migrations/"), `schema migration is not allowed: ${file}`);
  }

  const hypothesis = readRepoJson("reports/prc1-hypothesis-freeze.json");
  assertEqual(hypothesis.experimentId, PRC1_EXPERIMENT_ID, "hypothesis experiment identity");
  assertEqual(hypothesis.evidenceType, "HYPOTHESIS_FORMATION_DATA", "hypothesis evidence type");
  assertEqual(hypothesis.forwardValidation, false, "hypothesis forward validation marker");
  assertEqual(hypothesis.historicalAttributionUsedForHypothesis, true, "hypothesis attribution marker");
  assertEqual(hypothesis.historicalResultsUsedAsForward, false, "hypothesis forward-results marker");
  const rules = hypothesis.rulesProfitOrientedV4 as Record<string, unknown>;
  const rulesAll = rules.all as Record<string, unknown>;
  const rulesFiltered = rules.preEntryPlannedStopDistanceFiltered as Record<string, unknown>;
  assertEqual(rulesAll.trades, 26, "rules all trades");
  assertEqual(rulesAll.netPnl, -64.96, "rules all net PnL");
  assertEqual(rulesAll.profitFactor, 0.899, "rules all profit factor");
  assertEqual(rulesAll.maxDrawdown, 322.89, "rules all drawdown");
  assertEqual(rulesFiltered.trades, 15, "rules filtered trades");
  assertEqual(rulesFiltered.netPnl, 86.14, "rules filtered net PnL");
  assertEqual(rulesFiltered.profitFactor, 1.28, "rules filtered profit factor");
  assertEqual(rulesFiltered.maxDrawdown, 109.62, "rules filtered drawdown");

  const trend = hypothesis.trendRejectionShortV1 as Record<string, unknown>;
  const trendAll = trend.all as Record<string, unknown>;
  const trendFiltered = trend.filtered as Record<string, unknown>;
  const trendBadBand = trend.badBand as Record<string, unknown>;
  assertEqual(trendAll.trades, 37, "trend all trades");
  assertEqual(trendAll.netPnl, -608.54, "trend all net PnL");
  assertEqual(trendAll.profitFactor, 0.511, "trend all profit factor");
  assertEqual(trendAll.maxDrawdown, 703.67, "trend all drawdown");
  assertEqual(trendFiltered.trades, 28, "trend filtered trades");
  assertEqual(trendFiltered.netPnl, -182.82, "trend filtered net PnL");
  assertEqual(trendFiltered.profitFactor, 0.776, "trend filtered profit factor");
  assertEqual(trendFiltered.maxDrawdown, 282.13, "trend filtered drawdown");
  assertEqual(trendBadBand.trades, 9, "trend bad-band trades");
  assertEqual(trendBadBand.netPnl, -425.72, "trend bad-band net PnL");
  assertEqual(trendBadBand.wins, 0, "trend bad-band wins");

  const shadow = hypothesis.defaultTrendShadowV1 as Record<string, unknown>;
  const shadowAll = shadow.all as Record<string, unknown>;
  const shadowFiltered = shadow.filtered as Record<string, unknown>;
  const shadowHalves = shadow.filteredChronologicalHalves as Record<string, unknown>;
  const shadowBadBand = shadow.badBand as Record<string, unknown>;
  assertEqual(shadowAll.closedTrades, 76, "shadow all trades");
  assertEqual(shadowAll.netPnl, -4.33, "shadow all net PnL");
  assertEqual(shadowAll.profitFactor, 0.998, "shadow all profit factor");
  assertEqual(shadowAll.maxDrawdown, 426.74, "shadow all drawdown");
  assertEqual(shadowFiltered.closedTrades, 66, "shadow filtered trades");
  assertEqual(shadowFiltered.netPnl, 213.46, "shadow filtered net PnL");
  assertEqual(shadowFiltered.profitFactor, 1.128, "shadow filtered profit factor");
  assertEqual(shadowFiltered.maxDrawdown, 420.77, "shadow filtered drawdown");
  assertEqual(shadowFiltered.avgR, 0.073, "shadow filtered average R");
  assertEqual(shadowHalves.first33NetPnl, 169.15, "shadow first half net PnL");
  assertEqual(shadowHalves.second33NetPnl, 44.3, "shadow second half net PnL");
  assertEqual(shadowBadBand.trades, 10, "shadow bad-band trades");
  assertEqual(shadowBadBand.netPnl, -217.79, "shadow bad-band net PnL");

  const forwardContract = readRepoJson("reports/prc1-forward-contract.json");
  assertEqual(forwardContract.experimentId, PRC1_EXPERIMENT_ID, "forward contract identity");
  assertEqual(forwardContract.purpose, "PROFIT_RECOVERY", "forward contract purpose");
  assertEqual(forwardContract.hypothesisFrozenAtUtc, PRC1_HYPOTHESIS_FROZEN_AT_UTC, "frozen timestamp");
  assertEqual(forwardContract.forwardOnly, true, "forward-only contract");
  assertEqual(forwardContract.sourceTimestampRule, "sourceTimestamp >= hypothesisFrozenAtUtc", "source timestamp rule");
  assertEqual(forwardContract.backfill, false, "backfill policy");
  assertEqual(forwardContract.historicalResultsUsedAsForward, false, "historical results policy");
  const contractBaseline = forwardContract.baseline as Record<string, unknown>;
  const contractChallenger = forwardContract.challenger as Record<string, unknown>;
  assertEqual(contractBaseline.strategyVersion, PRC1_BASELINE_STRATEGY_VERSION, "contract baseline version");
  assertEqual(contractBaseline.entryMode, "DEFAULT", "contract baseline entry mode");
  assertEqual(contractChallenger.strategyVersion, PRC1_CHALLENGER_STRATEGY_VERSION, "contract challenger version");
  assertEqual(contractChallenger.entryMode, "DEFAULT", "contract challenger entry mode");
  assertEqual(forwardContract.singleVariableChange, PRC1_SINGLE_VARIABLE_CHANGE, "single variable change");
  assertEqual(forwardContract.filterRule, PRC1_FILTER_RULE, "filter rule");
  assertEqual(forwardContract.plannedStopDistanceFormula, "abs(plan.stopPrice - plan.entryPrice) / plan.entryPrice * 100", "filter formula");
  const contractGate = forwardContract.promotionGate as Record<string, unknown>;
  assertEqual(contractGate.minimumChallengerClosedTrades, PRC1_MIN_FORWARD_CLOSED_TRADES, "minimum forward trades");
  assertEqual(contractGate.netPnlUsdtGreaterThan, 0, "net PnL gate");
  assertEqual(contractGate.profitFactorAtLeast, 1.2, "profit factor gate");
  assertEqual(contractGate.avgPnlGreaterThan, 0, "average PnL gate");
  assertEqual(contractGate.largestWinningTradeGrossProfitContributionAtMostPct, 35, "winner concentration gate");

  const manifest = readRepoJson("reports/prc1-implementation-manifest.json");
  assertEqual(manifest.experimentId, PRC1_EXPERIMENT_ID, "implementation manifest identity");
  assertEqual(manifest.purpose, "PROFIT_RECOVERY", "implementation purpose");
  assertEqual(manifest.startingReleaseCommit, STARTING_RELEASE_COMMIT, "implementation starting commit");
  assertEqual(manifest.singleVariableChange, PRC1_SINGLE_VARIABLE_CHANGE, "implementation single variable");
  assertEqual(manifest.forwardOnly, true, "implementation forward-only marker");
  assertEqual(manifest.historicalAttributionUsedForHypothesis, true, "implementation attribution marker");
  assertEqual(manifest.historicalResultsUsedAsForward, false, "implementation forward-results marker");
  assertEqual(manifest.minimumForwardClosedTrades, PRC1_MIN_FORWARD_CLOSED_TRADES, "implementation minimum trades");
  assertEqual(manifest.automaticPromotion, false, "automatic promotion marker");
  assertEqual(manifest.productionStrategyVersion, "trend-rejection-short-v1", "production strategy version");
  assertEqual(manifest.productionEntryMode, "TREND_REJECTION", "production entry mode");
  assertEqual(manifest.productionChanged, false, "production changed marker");
  assertEqual(manifest.signalEmailEnabled, false, "signal email marker");
  assertEqual(manifest.autoTrading, false, "auto trading marker");
  assertEqual(manifest.orderPlacement, false, "order placement marker");
  assertEqual(manifest.migrationApplied, false, "migration marker");
  assertEqual(manifest.deploymentPerformed, false, "deployment marker");

  const contractSource = readRepoFile("lib/prc1/contract.ts");
  const stopbandSource = readRepoFile("lib/prc1/stopband.ts");
  const metricsSource = readRepoFile("lib/prc1/metrics.ts");
  const paperTradingSource = readRepoFile("lib/services/paper-trading.ts");
  const scanRoute = readRepoFile("app/api/scan/route.ts");
  const releasePolicy = readRepoFile("lib/core/release-policy.ts");
  const packageJson = readRepoJson("package.json");
  const scripts = packageJson.scripts as Record<string, unknown>;
  assertEqual(scripts["validate:prc1"], "tsx scripts/validate-prc1.ts", "validator package script");
  assertIncludes(contractSource, `PRC1_HYPOTHESIS_FROZEN_AT_UTC = "${PRC1_HYPOTHESIS_FROZEN_AT_UTC}"`, "frozen timestamp source");
  assertIncludes(stopbandSource, "Math.abs(plan.stopPrice - plan.entryPrice) / plan.entryPrice * 100", "planned stop distance calculation");
  assertIncludes(stopbandSource, "distancePct >= PRC1_STOP_DISTANCE_LOWER_PCT && distancePct < PRC1_STOP_DISTANCE_UPPER_PCT", "strict filter boundaries");
  assertIncludes(stopbandSource, "selectChallengerOpportunity", "independent challenger selection");
  assertIncludes(metricsSource, "bca_shadow_paper_trades", "read-only metrics source");
  assertIncludes(metricsSource, ".gte(\"entry_time\", hypothesisFrozenAtUtc)", "metrics forward timestamp filter");
  assertCondition(!metricsSource.includes(".insert(") && !metricsSource.includes(".update("), "PRC-1 metrics must be read-only");
  assertIncludes(paperTradingSource, ".eq(\"strategy_version\", input.strategyVersion);", "strategy-specific shadow position lookup");
  assertCondition(/\.eq\("strategy_version", input\.strategyVersion\)\s+\.not\("exit_time"/.test(paperTradingSource), "strategy-specific cooldown lookup");
  assertIncludes(paperTradingSource, "return insertPaperTrade(supabase, PRODUCTION_PAPER_TABLE, input, { signal_id: input.signalId });", "production paper trade path");
  assertIncludes(scanRoute, "const shadowOpportunity = finalShadowCandidates[0];", "baseline top-candidate ownership");
  assertIncludes(scanRoute, "const challengerOpportunity = selectChallengerOpportunity(finalShadowCandidates);", "challenger ranked selection");
  assertIncludes(scanRoute, "isPrc1ForwardEligible(challengerOpportunity.sourceTimestamp)", "forward-only challenger guard");
  assertIncludes(scanRoute, "metadata: buildPrc1ChallengerMetadata", "challenger provenance metadata");
  assertIncludes(scanRoute, "strategyVersion: PRC1_CHALLENGER_STRATEGY_VERSION", "challenger strategy identity");
  assertIncludes(scanRoute, "PRODUCTION_SIGNAL_EMAIL_ENABLED && hasEmailConfig && productionHealth.productionAAllowed", "production email gate retained");
  assertIncludes(releasePolicy, "PRODUCTION_SIGNAL_EMAIL_ENABLED = false", "signal email hard kill");
  assertIncludes(releasePolicy, "PRODUCTION_STRATEGY_PROMOTED = false", "promotion hard kill");
  assertIncludes(releasePolicy, "AUTOMATIC_TRADING_ENABLED = false", "automatic trading hard kill");
  assertIncludes(releasePolicy, "ORDER_PLACEMENT_ENABLED = false", "order placement hard kill");
  assertEqual((scanRoute.match(/sendSignalEmail\(/g) ?? []).length, 1, "challenger signal email path");
  assertCondition(!/\b(createOrder|newOrder|cancelOrder)\s*\(/i.test(`${scanRoute}\n${paperTradingSource}`), "PRC-1 runtime contains private trading capability");

  console.log(`PRC-1 validation passed for ${head}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
