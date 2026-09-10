import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { V22_BASE_SHA, V22_BRANCH, V22_END_MS, V22_EXPERIMENT_ID, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";
import { V22_BASELINE_ROUND_TRIP_BPS, V22_FEE_BPS_PER_SIDE, V22_INFORMATION_DENSITY_FLOOR_BPS, V22_MIN_GAP_LOG, V22_Q99_INDEX, V22_Q99_RANK, V22_Q99_QUANTILE, V22_ROLLING_OBSERVATIONS, V22_SLIPPAGE_BPS_PER_SIDE, V22_WINDOW_MS } from "@/lib/v22/signal";

const execFileAsync = promisify(execFile);
const WP1_SHA = "1a223849bd8790521c0c139552969b6bd2cc4b93";
const WP2_ORIGINAL_SHA = "9dd7705466a49c82bcfa7e4851747d92bb46bd63";
const WP1_MANIFEST_SHA = "a3272cd83b0ed661587ea86723aa8e04b764749e49605566cede05721b7e290a";
const REPORT_DIR = resolve("reports");
const ALLOWED_PATHS = new Set([
  "lib/v22/signal.ts",
  "scripts/build-v22-wp2.ts",
  "scripts/validate-v22-wp1.ts",
  "scripts/validate-v22-wp2.ts",
  "tests/v22-signal.test.ts",
  "reports/v22-signal-contract.json",
  "reports/v22-wp2-freeze-manifest.json",
]);
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function jsonFile<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V22 WP2 validation failed: ${message}`);
}

function exactKeys(actual: readonly string[], expected: readonly string[], label: string): void {
  requireThat(actual.length === expected.length && actual.every((value, index) => value === expected[index]), `${label} is not exact`);
}

async function main(): Promise<void> {
  const branch = process.env.GITHUB_HEAD_REF || await git(["branch", "--show-current"]);
  requireThat(branch === V22_BRANCH, `branch must be ${V22_BRANCH}, got ${branch}`);
  requireThat((await git(["status", "--porcelain"])) === "", "working tree is dirty");
  const target = process.env.GITHUB_HEAD_REF ? `origin/${process.env.GITHUB_HEAD_REF}` : "HEAD";
  const targetHead = await git(["rev-parse", target]);
  requireThat((await git(["merge-base", targetHead, V22_BASE_SHA])) === V22_BASE_SHA, "base ancestry drifted");
  requireThat((await git(["merge-base", targetHead, WP1_SHA])) === WP1_SHA, "WP1.1 is not an ancestor");
  requireThat((await git(["merge-base", targetHead, WP2_ORIGINAL_SHA])) === WP2_ORIGINAL_SHA, "WP2 original commit is not an ancestor");
  requireThat((await git(["rev-parse", `${targetHead}^`])) === WP2_ORIGINAL_SHA, "WP2.1 must be exactly one corrective commit after WP2");
  requireThat((await git(["rev-parse", `${WP2_ORIGINAL_SHA}^`])) === WP1_SHA, "WP2 original direct parent drifted");

  const wp1Text = await execFileAsync("git", ["show", `${WP1_SHA}:reports/v22-wp1-manifest.json`]).then((result) => result.stdout);
  requireThat(sha256(wp1Text) === WP1_MANIFEST_SHA, "WP1.1 manifest hash drifted");
  const gate = await jsonFile<{ classification: string; allSymbolsPass: boolean; researchStop: boolean; remainingResearchBudget: number; noPerformanceAnalysis: boolean; policy: { fixedSymbols: string[]; exactFrozenRange: { startMs: number; endExclusiveMs: number }; synchronizedByExactTimestampIntersection: boolean; noSymbolReplacement: boolean; noGapRepair: boolean } }>("v22-data-gate.json");
  requireThat(gate.classification === "V22_CROSS_VENUE_DATA_GATE_PASS" && gate.allSymbolsPass && !gate.researchStop && gate.remainingResearchBudget === 2 && gate.noPerformanceAnalysis, "WP1.1 data gate or budget drifted");
  exactKeys(gate.policy.fixedSymbols, [...V22_SYMBOLS], "data gate symbols");
  requireThat(gate.policy.exactFrozenRange.startMs === V22_START_MS && gate.policy.exactFrozenRange.endExclusiveMs === V22_END_MS && gate.policy.synchronizedByExactTimestampIntersection && gate.policy.noSymbolReplacement && gate.policy.noGapRepair, "WP1.1 data policy drifted");

  const contract = await jsonFile<{ experimentId: string; targetVenue: string; referenceVenue: string; fixedSymbols: string[]; fixedMappings: Record<string, string>; formulas: { rollingWindow: { durationCalendarDays: number; durationMs: number; exactPriorObservations: number; currentExcluded: boolean }; nearestRankQ99: { quantile: number; sampleSize: number; rank: number; zeroBasedIndex: number }; threshold: { floorRoundTripBps: number; floorLog: number; formula: string; alternatives: unknown[] }; firstCross: { current: string; previous: string; previousGapSource: string; singleSourceOfTruth: boolean; previousThreshold: string }; }; previousGapSource: string; singleSourceOfTruth: boolean; firstCrossPreviousThreshold: string; primaryCandidate: { conditions: string[]; forbiddenFilters: string[] }; direction: { positiveGap: string; negativeGap: string; reversal: boolean }; execution: { entry: { timestamp: string; field: string }; primary: { exitCandleOpen: string; exitField: string; outcomeBoundary: string; horizonMinutes: number }; sameWindowExecution: boolean }; costs: { feeBpsPerSide: number; slippageBpsPerSide: number; baselineRoundTripBps: number; stressBps: number[] }; overlap: { sameSymbol: string; differentSymbolsConcurrent: boolean }; controls: { C: { seedHex: string; seedDecimal: number; generatedOnce: boolean } }; wp3aSampleGate: { primaryEventsMinimum: number; distinctSignalClustersMinimum: number; perFixedSymbolMinimum: number; failureClassification: string }; flags: Record<string, boolean> }>("v22-signal-contract.json");
  requireThat(contract.experimentId === V22_EXPERIMENT_ID && contract.targetVenue === "BINANCE_USDM_PERPETUAL" && contract.referenceVenue === "OKX_USDT_SWAP", "contract identity drifted");
  exactKeys(contract.fixedSymbols, [...V22_SYMBOLS], "contract symbols");
  requireThat(contract.fixedMappings.DOGEUSDT === V22_OKX_INSTRUMENTS.DOGEUSDT, "contract mapping drifted");
  requireThat(contract.formulas.rollingWindow.durationCalendarDays === 30 && contract.formulas.rollingWindow.durationMs === V22_WINDOW_MS && contract.formulas.rollingWindow.exactPriorObservations === V22_ROLLING_OBSERVATIONS && contract.formulas.rollingWindow.currentExcluded, "rolling window drifted");
  requireThat(contract.formulas.nearestRankQ99.quantile === V22_Q99_QUANTILE && contract.formulas.nearestRankQ99.sampleSize === V22_ROLLING_OBSERVATIONS && contract.formulas.nearestRankQ99.rank === V22_Q99_RANK && contract.formulas.nearestRankQ99.zeroBasedIndex === V22_Q99_INDEX, "Q99 semantics drifted");
  requireThat(contract.formulas.threshold.floorRoundTripBps === V22_INFORMATION_DENSITY_FLOOR_BPS && contract.formulas.threshold.floorLog === V22_MIN_GAP_LOG && contract.formulas.threshold.formula === "max(Q99(abs(g_j)), ln(1+0.0024))" && contract.formulas.threshold.alternatives.length === 0, "threshold contract drifted");
  requireThat(contract.formulas.firstCross.current === "abs(g_t) >= threshold" && contract.formulas.firstCross.previous === "abs(g_t-1) < threshold" && contract.formulas.firstCross.previousGapSource === "last observation of exact frozen [t-30d,t) PIT window" && contract.formulas.firstCross.singleSourceOfTruth && contract.formulas.firstCross.previousThreshold === "same current-t threshold" && contract.previousGapSource === contract.formulas.firstCross.previousGapSource && contract.singleSourceOfTruth && contract.firstCrossPreviousThreshold === "same current-t threshold", "first-cross source of truth drifted");
  requireThat(contract.primaryCandidate.conditions.length === 7 && contract.primaryCandidate.forbiddenFilters.length === 10, "candidate predicate drifted");
  requireThat(contract.direction.positiveGap === "LONG BINANCE" && contract.direction.negativeGap === "SHORT BINANCE" && contract.direction.reversal === false, "direction drifted");
  requireThat(contract.execution.entry.timestamp === "T+5m" && contract.execution.entry.field === "open" && contract.execution.primary.exitCandleOpen === "T+15m" && contract.execution.primary.exitField === "close" && contract.execution.primary.outcomeBoundary === "T+20m" && contract.execution.primary.horizonMinutes === 15 && contract.execution.sameWindowExecution === false, "execution contract drifted");
  requireThat(contract.costs.feeBpsPerSide === V22_FEE_BPS_PER_SIDE && contract.costs.slippageBpsPerSide === V22_SLIPPAGE_BPS_PER_SIDE && contract.costs.baselineRoundTripBps === V22_BASELINE_ROUND_TRIP_BPS && JSON.stringify(contract.costs.stressBps) === JSON.stringify([17, 22, 32]), "cost contract drifted");
  requireThat(contract.overlap.differentSymbolsConcurrent && contract.overlap.sameSymbol.includes("OVERLAP_EXCLUDED"), "overlap contract drifted");
  requireThat(contract.controls.C.seedHex === "0x22C0C0DE" && contract.controls.C.seedDecimal === 583057630 && contract.controls.C.generatedOnce, "control seed drifted");
  requireThat(contract.wp3aSampleGate.primaryEventsMinimum === 500 && contract.wp3aSampleGate.distinctSignalClustersMinimum === 250 && contract.wp3aSampleGate.perFixedSymbolMinimum === 50 && contract.wp3aSampleGate.failureClassification === "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT", "WP3A gate drifted");
  for (const flag of ["historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "eventEnumerationRun", "backtestRun", "parameterSearch", "promotionEvaluated"]) requireThat(contract.flags[flag] === false, `${flag} must be false`);

  const manifest = await jsonFile<Record<string, unknown>>("v22-wp2-freeze-manifest.json");
  requireThat(manifest.schema === "v22-wp2-freeze-manifest-v1" && manifest.experimentId === V22_EXPERIMENT_ID && manifest.branch === V22_BRANCH && manifest.baseSha === V22_BASE_SHA && manifest.directParent === WP2_ORIGINAL_SHA && manifest.wp1_1AcceptedCommit === WP1_SHA && manifest.wp1_1ManifestSha256 === WP1_MANIFEST_SHA && manifest.wp2OriginalCommit === WP2_ORIGINAL_SHA && manifest.correctiveType === "FIRST_CROSS_INTEGRITY_ONLY" && manifest.researchSemanticsChanged === false, "freeze manifest identity or corrective metadata drifted");
  requireThat(manifest.signalContractSha256 === sha256(await readFile(resolve(REPORT_DIR, "v22-signal-contract.json"))), "signal contract hash drifted");
  exactKeys(manifest.fixedSymbols as string[], [...V22_SYMBOLS], "manifest symbols");
  const period = manifest.period as { start?: string; endExclusive?: string; interval?: string; closedCandlesOnly?: boolean };
  requireThat(period.start === new Date(V22_START_MS).toISOString() && period.endExclusive === new Date(V22_END_MS).toISOString() && period.interval === "5m" && period.closedCandlesOnly === true, "manifest period drifted");
  const flags = ["historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "eventEnumerationRun", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"];
  for (const flag of flags) requireThat(manifest[flag] === false, `${flag} must be false`);
  requireThat(manifest.productionEmail === "OFF", "Production Email is not OFF");
  const sourceHashes = manifest.sourceFileSha256 as Record<string, string>;
  for (const path of ["lib/v22/signal.ts", "lib/v22/types.ts", "lib/v22/data.ts", "tests/v22-signal.test.ts", "scripts/build-v22-wp2.ts", "scripts/validate-v22-wp1.ts"]) requireThat(sourceHashes[path] === sha256(await readFile(resolve(path))), `source hash mismatch for ${path}`);

  const changed = (await git(["diff", "--name-only", `${WP2_ORIGINAL_SHA}..${targetHead}`])).split(/\r?\n/).filter(Boolean);
  requireThat(changed.every((path) => ALLOWED_PATHS.has(path)), `unexpected changed path: ${changed.find((path) => !ALLOWED_PATHS.has(path)) ?? "unknown"}`);
  requireThat(!changed.some((path) => /result|return|performance|holdout|pnl/i.test(path)), "result/performance artifact changed");
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  requireThat(packageJson.scripts?.["validate:v22:wp2"] === "tsx scripts/validate-v22-wp2.ts", "WP2 validator script missing");
  const implementation = await readFile(resolve("lib/v22/signal.ts"), "utf8");
  requireThat(!/profitFactor|winRate|futureReturn|strategyReturn|backtest|parameterSearch|promotion|private\/account|api\/v[12]\/order/i.test(implementation), "outcome, tuning, or private trading implementation found");
  const inputSection = implementation.match(/export interface V22SignalEvaluationInput \{([\s\S]*?)\}/)?.[1] ?? "";
  requireThat(!/previousGap/.test(inputSection) && !/input\.previousGap/.test(implementation), "independent previousGap input path remains");
  console.info(JSON.stringify({ stage: "v22_wp2_validation_pass", branch, targetHead, remainingResearchBudget: 2, historicalStrategyOutcomeReturnsRead: false, eventEnumerationRun: false }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
