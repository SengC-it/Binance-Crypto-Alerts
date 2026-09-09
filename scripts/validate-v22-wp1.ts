import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { isFamilyInAuthoritativeRegistry } from "@/lib/v22/admission";
import { R1_FINAL_GATE_COMMIT, V22_BASE_SHA, V22_BRANCH, V22_END_MS, V22_EXPERIMENT_ID, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);
const REPORT_DIR = resolve("reports");
const V22_WP1_SHA = "312f112734a39a024248ce5bbc9d861bf0be816e";
const V22_WP1_1_SHA = "1a223849bd8790521c0c139552969b6bd2cc4b93";
const ALLOWED_PATHS = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "lib/v22/admission.ts",
  "lib/v22/data.ts",
  "lib/v22/provenance.ts",
  "lib/v22/types.ts",
  "lib/v22/signal.ts",
  "scripts/build-v22-wp1.ts",
  "scripts/build-v22-wp2.ts",
  "scripts/download-v22-cross-venue-data.ts",
  "scripts/run-v22-data-gate.ts",
  "scripts/run-v22-live-feed.ts",
  "scripts/validate-v22-wp1.ts",
  "scripts/validate-v22-wp2.ts",
  "tests/v22-data.test.ts",
  "tests/v22-signal.test.ts",
  "reports/v22-admission.json",
  "reports/v22-data-inventory.json",
  "reports/v22-data-gate.json",
  "reports/v22-live-feed-feasibility.json",
  "reports/v22-source-provenance.json",
  "reports/v22-wp1-manifest.json",
  "reports/v22-signal-contract.json",
  "reports/v22-wp2-freeze-manifest.json",
]);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function gitText(commit: string, path: string): Promise<string> {
  return (await execFileAsync("git", ["show", `${commit}:${path}`])).stdout;
}

async function jsonFile<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V22 WP1.1 validation failed: ${message}`);
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
  requireThat((await git(["merge-base", targetHead, V22_WP1_SHA])) === V22_WP1_SHA, "WP1.1 is not based on WP1");
  requireThat((await git(["merge-base", targetHead, V22_WP1_1_SHA])) === V22_WP1_1_SHA, "WP1.1 accepted commit is not an ancestor");
  requireThat((await git(["rev-parse", `${V22_WP1_1_SHA}^`])) === V22_WP1_SHA, "WP1.1 corrective commit lineage drifted");

  const r1Text = await gitText(R1_FINAL_GATE_COMMIT, "reports/r1-exhausted-alpha-families.json");
  const r1 = JSON.parse(r1Text) as { families?: Array<{ family?: string }>; registryCompleteness?: { exactSetEquality?: boolean }; retuningForbidden?: boolean };
  const authoritativeFamilies = (r1.families ?? []).map((family) => family.family ?? "");
  requireThat(r1.registryCompleteness?.exactSetEquality === true && r1.retuningForbidden === true, "R1 authoritative registry is not exact/frozen");
  requireThat(!isFamilyInAuthoritativeRegistry("cross-venue same-instrument price discovery", authoritativeFamilies), "V22 family is already present in R1 authoritative registry");

  const admission = await jsonFile<{
    experimentId: string;
    family: string;
    informationSourceClass: string;
    structuralOrthogonality: string;
    structuralDifferenceDimensions: string[];
    admission: string;
    r1Admission: { verifiedFromCommit: string; dominantHistoricalFailure: string; requiredFutureDirection: string; legacyFamilyRetuningAllowed: boolean; authoritativeRegistry: { sourceCommit: string; sourcePath: string; registrySha256: string; familyPresent: boolean; registryExactSetEquality: boolean }; budgetBefore: number; familyBudgetConsumed: boolean; remainingBudget: number };
    noSignalDesigned: boolean;
  }>("v22-admission.json");
  requireThat(admission.experimentId === V22_EXPERIMENT_ID && admission.family === "cross-venue same-instrument price discovery" && admission.informationSourceClass === "CROSS_EXCHANGE_PRICE_DISCOVERY", "admission identity drifted");
  requireThat(admission.structuralOrthogonality === "STRUCTURALLY_ORTHOGONAL", "admission is not orthogonal");
  exactKeys(admission.structuralDifferenceDimensions, ["cross_venue_structure", "information_source", "causal_timing"], "orthogonality dimensions");
  requireThat(admission.admission === "PASS" && admission.noSignalDesigned, "admission or no-signal flag drifted");
  requireThat(admission.r1Admission.verifiedFromCommit === R1_FINAL_GATE_COMMIT && admission.r1Admission.dominantHistoricalFailure === "EXECUTION_FRICTION_DOMINATED" && admission.r1Admission.requiredFutureDirection === "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT" && admission.r1Admission.legacyFamilyRetuningAllowed === false, "R1 admission anchors drifted");
  requireThat(admission.r1Admission.authoritativeRegistry.sourceCommit === R1_FINAL_GATE_COMMIT && admission.r1Admission.authoritativeRegistry.sourcePath === "reports/r1-exhausted-alpha-families.json" && admission.r1Admission.authoritativeRegistry.registrySha256 === sha256(r1Text) && admission.r1Admission.authoritativeRegistry.familyPresent === false && admission.r1Admission.authoritativeRegistry.registryExactSetEquality, "R1 authoritative evidence is not exact");
  requireThat(admission.r1Admission.budgetBefore === 3 && admission.r1Admission.familyBudgetConsumed && admission.r1Admission.remainingBudget === 2, "family budget is not 3 -> 2");

  const manifest = await jsonFile<Record<string, unknown>>("v22-wp1-manifest.json");
  requireThat(manifest.experimentId === V22_EXPERIMENT_ID && manifest.baseSha === V22_BASE_SHA && manifest.r1FinalGateCommit === R1_FINAL_GATE_COMMIT, "manifest identity drifted");
  exactKeys(manifest.fixedSymbols as string[], [...V22_SYMBOLS], "fixed symbols");
  const period = manifest.period as { start?: string; endExclusive?: string };
  requireThat(period.start === new Date(V22_START_MS).toISOString() && period.endExclusive === new Date(V22_END_MS).toISOString(), "history period drifted");
  requireThat((manifest.fixedMappings as Record<string, string>).DOGEUSDT === V22_OKX_INSTRUMENTS.DOGEUSDT, "venue mapping drifted");
  requireThat((manifest.remainingResearchBudget ?? manifest.remainingOrthogonalFamilyBudget) === 2, "remaining research budget drifted");
  for (const flag of ["r1AdmissionVerified", "familyBudgetConsumed", "signalDesigned", "eventDefinitionDesigned", "historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) {
    if (["r1AdmissionVerified", "familyBudgetConsumed"].includes(flag)) requireThat(manifest[flag] === true, `${flag} must be true`);
    else requireThat(manifest[flag] === false, `${flag} must be false`);
  }
  requireThat(manifest.productionEmail === "OFF", "Production Email is not OFF");

  const gate = await jsonFile<{
    policy: { requiredCoverage: number; maxContiguousMissingMinutes: number; expectedRows: number; fixedSymbols: string[]; noSymbolReplacement: boolean; noGapRepair: boolean; exactFrozenRange: { startMs: number; endExclusiveMs: number }; synchronizedByExactTimestampIntersection: boolean; noInsecureTransport: boolean };
    symbols: Record<string, { binanceRows: number; binanceCoverage: number; binanceDuplicates: number; binanceExactIdenticalDuplicateRows: number; binanceConflictingDuplicateRows: number; binanceCanonicalDuplicateRows: number; binanceNonMonotonic: number; binanceSourceOrderNonMonotonic: number; binanceInvalidRows: number; binanceMaxGap: number; okxRows: number; okxCoverage: number; okxTransportDuplicateRows: number; okxExactIdenticalDuplicateRows: number; okxConflictingDuplicateRows: number; okxCanonicalDuplicateRows: number; okxSourceOrderNonMonotonic: number; okxCanonicalNonMonotonic: number; okxInvalidRows: number; okxMaxGap: number; synchronizedRows: number; synchronizedCoverage: number; primaryCoverage: { binance: number; okx: number }; holdoutACoverage: { binance: number; okx: number }; holdoutBCoverage: { binance: number; okx: number }; provenancePass: boolean; pass: boolean }>;
    allSymbolsPass: boolean;
    classification: string;
    researchStop: boolean;
    budgetBefore: number;
    budgetConsumed: number;
    remainingResearchBudget: number;
    noPerformanceAnalysis: boolean;
  }>("v22-data-gate.json");
  exactKeys(gate.policy.fixedSymbols, [...V22_SYMBOLS], "data gate symbols");
  requireThat(gate.policy.requiredCoverage === 0.999 && gate.policy.maxContiguousMissingMinutes === 15 && gate.policy.expectedRows === 324576 && gate.policy.exactFrozenRange.startMs === V22_START_MS && gate.policy.exactFrozenRange.endExclusiveMs === V22_END_MS && gate.policy.noSymbolReplacement && gate.policy.noGapRepair && gate.policy.synchronizedByExactTimestampIntersection && gate.policy.noInsecureTransport, "data gate policy drifted");
  for (const symbol of V22_SYMBOLS) {
    const row = gate.symbols[symbol];
    requireThat(row !== undefined, `missing data gate row for ${symbol}`);
    requireThat(row.binanceRows === 324576 && row.okxRows === 324576 && row.synchronizedRows === 324576, `expected exact rows missing for ${symbol}`);
    requireThat(row.binanceCoverage >= 0.999 && row.okxCoverage >= 0.999 && row.synchronizedCoverage >= 0.999, `coverage gate failed for ${symbol}`);
    requireThat(row.binanceExactIdenticalDuplicateRows === row.binanceDuplicates && row.binanceConflictingDuplicateRows === 0 && row.binanceCanonicalDuplicateRows === 0 && row.binanceNonMonotonic === 0 && row.binanceInvalidRows === 0 && row.binanceMaxGap <= 15, `Binance quality failed for ${symbol}`);
    requireThat(row.okxConflictingDuplicateRows === 0 && row.okxCanonicalDuplicateRows === 0 && row.okxCanonicalNonMonotonic === 0 && row.okxInvalidRows === 0 && row.okxMaxGap <= 15, `OKX canonical quality failed for ${symbol}`);
    requireThat(row.provenancePass && row.pass, `provenance or gate failed for ${symbol}`);
    for (const coverage of [row.primaryCoverage.binance, row.primaryCoverage.okx, row.holdoutACoverage.binance, row.holdoutACoverage.okx, row.holdoutBCoverage.binance, row.holdoutBCoverage.okx]) requireThat(Number.isFinite(coverage) && coverage >= 0, `invalid period coverage for ${symbol}`);
  }
  requireThat(gate.allSymbolsPass && gate.classification === "V22_CROSS_VENUE_DATA_GATE_PASS" && !gate.researchStop && gate.budgetBefore === 3 && gate.budgetConsumed === 1 && gate.remainingResearchBudget === 2 && gate.noPerformanceAnalysis, "data gate result or budget drifted");

  const provenance = await jsonFile<{ symbols: Record<string, { binance: Array<{ checksumVerified: boolean; archiveEntryName: string | null; extractedCsvSha256: string; extractedCsvByteLength: number; freshExtractionSha256: string | null; extractedCsvVerifiedAgainstZip: boolean; pass: boolean }>; okx: { lineCount: number; responseCount: number; allResponseHashesVerified: boolean; lines: Array<{ request: string; manifestByteLength: number; actualByteLength: number; manifestSha256: string; actualSha256: string; byteHashVerified: boolean; responseCode: string | null; rows: number; rowsValid: boolean; pass: boolean }>; secureHistoricalRevalidation: { attempted: number; succeeded: number; failed: number; parsedRowsEqual: number; mismatches: unknown[]; pass: boolean } } }> }>("v22-source-provenance.json");
  for (const symbol of V22_SYMBOLS) {
    const row = provenance.symbols[symbol];
    requireThat(row !== undefined && row.binance.length === 37 && row.binance.every((artifact) => artifact.checksumVerified && !!artifact.archiveEntryName && /^[a-f0-9]{64}$/.test(artifact.extractedCsvSha256) && artifact.extractedCsvByteLength > 0 && artifact.freshExtractionSha256 === artifact.extractedCsvSha256 && artifact.extractedCsvVerifiedAgainstZip && artifact.pass), `Binance source chain incomplete for ${symbol}`);
    requireThat(row.okx.lineCount === 1084 && row.okx.responseCount === 1084 && row.okx.allResponseHashesVerified && row.okx.lines.length === row.okx.responseCount && row.okx.lines.every((line) => line.request.startsWith("https://www.okx.com/api/v5/market/history-candles?") && line.manifestByteLength === line.actualByteLength && line.manifestSha256 === line.actualSha256 && line.byteHashVerified && line.responseCode === "0" && line.rows > 0 && line.rowsValid && line.pass), `OKX frozen source chain incomplete for ${symbol}`);
    requireThat(row.okx.secureHistoricalRevalidation.attempted === 1084 && row.okx.secureHistoricalRevalidation.succeeded === 1084 && row.okx.secureHistoricalRevalidation.failed === 0 && row.okx.secureHistoricalRevalidation.parsedRowsEqual === 1084 && row.okx.secureHistoricalRevalidation.mismatches.length === 0 && row.okx.secureHistoricalRevalidation.pass, `OKX secure historical revalidation incomplete for ${symbol}`);
  }

  const sourceProvenanceText = await readFile(resolve(REPORT_DIR, "v22-source-provenance.json"));
  const artifactHashes = manifest.artifactSha256 as Record<string, string>;
  for (const path of ["v22-admission.json", "v22-data-inventory.json", "v22-data-gate.json", "v22-live-feed-feasibility.json", "v22-source-provenance.json"]) requireThat(artifactHashes[`reports/${path}`] === sha256(path === "v22-source-provenance.json" ? sourceProvenanceText : await readFile(resolve(REPORT_DIR, path))), `artifact hash mismatch for ${path}`);
  const live = await jsonFile<{ binancePublicFeed: string; okxPublicFeed: string; results: Array<{ publicAuthenticationRequired: boolean; accountPermissionRequired: boolean; tradingPermissionRequired: boolean; success: boolean; closedRowsObserved: boolean }>; noProductionWrites: boolean; noEmail: boolean; noTradingEndpoints: boolean }>("v22-live-feed-feasibility.json");
  requireThat(live.binancePublicFeed === "PASS" && live.okxPublicFeed === "PASS" && live.results.length === 10 && live.results.every((result) => !result.publicAuthenticationRequired && !result.accountPermissionRequired && !result.tradingPermissionRequired && result.success && result.closedRowsObserved) && live.noProductionWrites && live.noEmail && live.noTradingEndpoints, "live-feed safety evidence drifted");

  const changed = (await git(["diff", "--name-only", V22_BASE_SHA + ".." + targetHead])).split(/\r?\n/).filter(Boolean);
  requireThat(changed.every((path) => ALLOWED_PATHS.has(path)), `unexpected changed path: ${changed.find((path) => !ALLOWED_PATHS.has(path)) ?? "unknown"}`);
  const implementationPaths = [
    "lib/v22/data.ts",
    "lib/v22/provenance.ts",
    "lib/v22/types.ts",
    "scripts/download-v22-cross-venue-data.ts",
    "scripts/run-v22-data-gate.ts",
    "scripts/run-v22-live-feed.ts",
  ];
  const sourceFiles = await Promise.all(implementationPaths.map((path) => readFile(resolve(path), "utf8")));
  const source = sourceFiles.join("\n");
  requireThat(!/curl(?:\.exe)?[^\n]*(?:-k|--insecure)|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|private\/account|api\/v[12]\/order|profitFactor|winRate|futureReturn|strategyReturn|backtest|lead.?lag/i.test(source), "insecure transport or performance/trading implementation found");
  requireThat(!changed.some((path) => path.startsWith("reports/") && /result|return|performance|holdout|pnl/i.test(path)), "result/performance artifact was added");
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  requireThat(packageJson.scripts?.["validate:v22:wp1"] === "tsx scripts/validate-v22-wp1.ts", "package validator script missing");
  console.info(JSON.stringify({ stage: "v22_wp1_1_validation_pass", branch, targetHead, classification: gate.classification, symbols: V22_SYMBOLS, remainingResearchBudget: 2 }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
