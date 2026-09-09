import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { admitV22Family } from "@/lib/v22/admission";
import { passesHardGate } from "@/lib/v22/data";
import { R1_FINAL_GATE_COMMIT, V22_BASE_SHA, V22_BRANCH, V22_END_MS, V22_EXPERIMENT_ID, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);
const REPORT_DIR = resolve("reports");
const ALLOWED_PATHS = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "lib/v22/admission.ts",
  "lib/v22/data.ts",
  "lib/v22/types.ts",
  "scripts/build-v22-wp1.ts",
  "scripts/download-v22-cross-venue-data.ts",
  "scripts/run-v22-data-gate.ts",
  "scripts/run-v22-live-feed.ts",
  "scripts/validate-v22-wp1.ts",
  "tests/v22-data.test.ts",
  "reports/v22-admission.json",
  "reports/v22-data-inventory.json",
  "reports/v22-data-gate.json",
  "reports/v22-live-feed-feasibility.json",
  "reports/v22-wp1-manifest.json",
]);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function jsonFile<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V22 WP1 validation failed: ${message}`);
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
  requireThat((await git(["rev-parse", `${targetHead}^`])) === V22_BASE_SHA, "WP1 must be exactly one commit from the clean base");
  requireThat((await git(["cat-file", "-t", R1_FINAL_GATE_COMMIT])) === "commit", "R1 final gate commit is unavailable");

  const admission = await jsonFile<{
    experimentId: string;
    family: string;
    informationSourceClass: string;
    structuralOrthogonality: string;
    structuralDifferenceDimensions: string[];
    admission: string;
    r1Admission: { verifiedFromCommit: string; dominantHistoricalFailure: string; requiredFutureDirection: string; legacyFamilyRetuningAllowed: boolean; budgetBefore: number; familyBudgetConsumed: boolean; remainingBudget: number };
    noSignalDesigned: boolean;
  }>("v22-admission.json");
  const admissionResult = admitV22Family({ experimentId: admission.experimentId, family: admission.family, informationSourceClass: admission.informationSourceClass });
  requireThat(admissionResult.status === "PASS", admissionResult.reason);
  requireThat(admission.structuralOrthogonality === "STRUCTURALLY_ORTHOGONAL", "admission is not orthogonal");
  exactKeys(admission.structuralDifferenceDimensions, ["cross_venue_structure", "information_source", "causal_timing"], "orthogonality dimensions");
  requireThat(admission.admission === "PASS" && admission.noSignalDesigned, "admission or signal flag drifted");
  requireThat(admission.r1Admission.verifiedFromCommit === R1_FINAL_GATE_COMMIT, "R1 commit drifted");
  requireThat(admission.r1Admission.dominantHistoricalFailure === "EXECUTION_FRICTION_DOMINATED", "R1 failure anchor drifted");
  requireThat(admission.r1Admission.requiredFutureDirection === "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT", "R1 direction anchor drifted");
  requireThat(admission.r1Admission.legacyFamilyRetuningAllowed === false, "legacy family retuning was enabled");
  requireThat(admission.r1Admission.budgetBefore === 3 && admission.r1Admission.familyBudgetConsumed && admission.r1Admission.remainingBudget === 2, "family budget is not 3 -> 2");

  const manifest = await jsonFile<Record<string, unknown>>("v22-wp1-manifest.json");
  requireThat(manifest.experimentId === V22_EXPERIMENT_ID && manifest.baseSha === V22_BASE_SHA && manifest.r1FinalGateCommit === R1_FINAL_GATE_COMMIT, "manifest identity drifted");
  exactKeys(manifest.fixedSymbols as string[], [...V22_SYMBOLS], "fixed symbols");
  requireThat(manifest.period && (manifest.period as { start: string; endExclusive: string }).start === new Date(V22_START_MS).toISOString() && (manifest.period as { start: string; endExclusive: string }).endExclusive === new Date(V22_END_MS).toISOString(), "history period drifted");
  requireThat((manifest.fixedMappings as Record<string, string>).DOGEUSDT === V22_OKX_INSTRUMENTS.DOGEUSDT, "venue mapping drifted");
  for (const flag of ["r1AdmissionVerified", "familyBudgetConsumed", "signalDesigned", "eventDefinitionDesigned", "historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) {
    if (["r1AdmissionVerified", "familyBudgetConsumed"].includes(flag)) requireThat(manifest[flag] === true, `${flag} must be true`);
    else requireThat(manifest[flag] === false, `${flag} must be false`);
  }
  requireThat(manifest.productionEmail === "OFF", "Production Email is not OFF");

  const gate = await jsonFile<{ policy: { requiredCoverage: number; maxContiguousMissingMinutes: number; fixedSymbols: string[]; noSymbolReplacement: boolean; noGapRepair: boolean; synchronizedByExactTimestampIntersection: boolean }; symbols: Record<string, { binanceRows: number; binanceCoverage: number; okxRows: number; okxCoverage: number; synchronizedRows: number; synchronizedCoverage: number; duplicates: number; invalidRows: number; maxContiguousMissingMinutes: number; pass: boolean }>; allSymbolsPass: boolean; classification: string; researchStop: boolean; budgetConsumed: number; remainingBudget: number; noPerformanceAnalysis: boolean }>("v22-data-gate.json");
  exactKeys(gate.policy.fixedSymbols, [...V22_SYMBOLS], "data gate symbols");
  requireThat(gate.policy.requiredCoverage === 0.999 && gate.policy.maxContiguousMissingMinutes === 15 && gate.policy.noSymbolReplacement && gate.policy.noGapRepair && gate.policy.synchronizedByExactTimestampIntersection, "data gate policy drifted");
  for (const symbol of V22_SYMBOLS) {
    const row = gate.symbols[symbol];
    requireThat(row !== undefined, `missing data gate row for ${symbol}`);
    requireThat(row.binanceRows >= 0 && row.okxRows >= 0 && row.synchronizedRows >= 0, `invalid row counts for ${symbol}`);
    requireThat(Number.isFinite(row.binanceCoverage) && Number.isFinite(row.okxCoverage) && Number.isFinite(row.synchronizedCoverage), `invalid coverage for ${symbol}`);
    requireThat(row.pass === (
      row.binanceCoverage >= 0.999 && row.okxCoverage >= 0.999 && row.synchronizedCoverage >= 0.999 && row.duplicates === 0 && row.invalidRows === 0 && row.maxContiguousMissingMinutes <= 15
    ), `non-reproducible gate result for ${symbol}`);
  }
  requireThat(gate.allSymbolsPass === V22_SYMBOLS.every((symbol) => gate.symbols[symbol].pass), "all-symbol gate mismatch");
  requireThat(gate.classification === (gate.allSymbolsPass ? "V22_CROSS_VENUE_DATA_GATE_PASS" : "V22_CROSS_VENUE_DATA_INSUFFICIENT"), "classification mismatch");
  requireThat(gate.researchStop === !gate.allSymbolsPass && gate.budgetConsumed === 1 && gate.remainingBudget === 2 && gate.noPerformanceAnalysis, "stop/budget policy drifted");

  const inventory = await jsonFile<{ sourcePolicy: { thirdPartyData: boolean }; symbols: Record<string, { binance: { primaryCoverage: number; holdoutACoverage: number; holdoutBCoverage: number }; okx: { primaryCoverage: number; holdoutACoverage: number; holdoutBCoverage: number }; exactTimestampIntersectionRows: number; synchronizedCoverageRatio: number; binanceManifest: unknown; okxManifest: unknown }> }>("v22-data-inventory.json");
  requireThat(inventory.sourcePolicy.thirdPartyData === false, "third-party data is present");
  for (const symbol of V22_SYMBOLS) {
    const row = inventory.symbols[symbol];
    requireThat(row && row.binanceManifest && row.okxManifest, `raw source manifests missing for ${symbol}`);
    const binanceManifest = row.binanceManifest as { source?: string; interval?: string; artifacts?: Array<{ url?: string; checksumUrl?: string; byteLength?: number; sha256?: string; officialChecksum?: string }> };
    const okxManifest = row.okxManifest as { source?: string; instrument?: string; interval?: string; responseCount?: number; responses?: Array<{ request?: string; byteLength?: number; sha256?: string }> };
    requireThat(binanceManifest.source?.includes("Binance Data Vision") && binanceManifest.interval === "5m" && binanceManifest.artifacts?.length === 37, `Binance official archive inventory incomplete for ${symbol}`);
    requireThat((binanceManifest.artifacts ?? []).every((artifact) => Number.isInteger(artifact.byteLength) && artifact.byteLength! > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") && artifact.sha256 === artifact.officialChecksum && artifact.url?.includes("data.binance.vision") && artifact.checksumUrl?.endsWith(".CHECKSUM")), `Binance checksum metadata missing for ${symbol}`);
    requireThat(okxManifest.source?.includes("OKX official public") && okxManifest.instrument === V22_OKX_INSTRUMENTS[symbol] && okxManifest.interval === "5m" && okxManifest.responseCount === okxManifest.responses?.length && (okxManifest.responseCount ?? 0) > 0, `OKX response inventory incomplete for ${symbol}`);
    requireThat((okxManifest.responses ?? []).every((response) => Number.isInteger(response.byteLength) && response.byteLength! > 0 && /^[a-f0-9]{64}$/.test(response.sha256 ?? "") && response.request?.startsWith("https://www.okx.com/api/v5/market/history-candles?")), `OKX response hashes missing for ${symbol}`);
    for (const coverage of [row.binance.primaryCoverage, row.binance.holdoutACoverage, row.binance.holdoutBCoverage, row.okx.primaryCoverage, row.okx.holdoutACoverage, row.okx.holdoutBCoverage, row.synchronizedCoverageRatio]) requireThat(Number.isFinite(coverage) && coverage >= 0, `invalid period coverage for ${symbol}`);
    requireThat(Number.isInteger(row.exactTimestampIntersectionRows) && row.exactTimestampIntersectionRows >= 0, `invalid exact intersection for ${symbol}`);
  }

  const live = await jsonFile<{ binancePublicFeed: string; okxPublicFeed: string; results: Array<{ publicAuthenticationRequired: boolean; accountPermissionRequired: boolean; tradingPermissionRequired: boolean; success: boolean; closedRowsObserved: boolean }>; noProductionWrites: boolean; noEmail: boolean; noTradingEndpoints: boolean }>("v22-live-feed-feasibility.json");
  requireThat(["PASS", "FAIL"].includes(live.binancePublicFeed) && ["PASS", "FAIL"].includes(live.okxPublicFeed), "live feed result is malformed");
  requireThat(live.results.length === 10 && live.results.every((result) => !result.publicAuthenticationRequired && !result.accountPermissionRequired && !result.tradingPermissionRequired && result.success && result.closedRowsObserved), "live feed permissions or closed-candle probe drifted");
  requireThat(live.noProductionWrites && live.noEmail && live.noTradingEndpoints, "live feed side effects are not disabled");

  const changed = (await git(["diff", "--name-only", V22_BASE_SHA + ".." + targetHead])).split(/\r?\n/).filter(Boolean);
  const unexpectedPath = changed.find((path) => !ALLOWED_PATHS.has(path));
  requireThat(changed.every((path) => ALLOWED_PATHS.has(path)), "unexpected changed path: " + (unexpectedPath || "unknown"));
  requireThat(!changed.some((path) => path.startsWith("lib/v22/") && /signal|strategy|backtest/i.test(path)), "V22 signal/strategy implementation exists");
  const v22Source = (await Promise.all(["lib/v22/admission.ts", "lib/v22/data.ts", "lib/v22/types.ts", "scripts/build-v22-wp1.ts", "scripts/run-v22-data-gate.ts", "scripts/run-v22-live-feed.ts"].map((path) => readFile(resolve(path), "utf8")))).join("\n");
  requireThat(!/private\/account|api\/v[12]\/order|profitFactor|winRate|futureReturn|strategyReturn/i.test(v22Source), "performance or private trading implementation found");
  const packageJson = await jsonFile<{ scripts?: Record<string, string> }>("../package.json");
  requireThat(packageJson.scripts?.["validate:v22:wp1"] === "tsx scripts/validate-v22-wp1.ts", "package validator script missing");
  console.info(JSON.stringify({ stage: "v22_wp1_validation_pass", branch, targetHead, classification: gate.classification, symbols: V22_SYMBOLS }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
