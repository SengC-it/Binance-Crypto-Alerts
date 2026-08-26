import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashWithoutField } from "@/lib/v5-7/manifest";
import { loadV7Datasets, type V7DataLoadSummary } from "@/lib/v7/data";
import {
  buildPortfolioSummary,
  buildV7Runs,
  evaluateSymbolValidation,
  evaluateTemporalValidation,
  familyPasses,
  fundingRegimeMetrics,
  regimeMetrics,
  runNestedFamily,
  stressSummary,
  summarizeV7Trades,
  summarizeV7Yield,
  yearMetrics,
} from "@/lib/v7/engine";
import {
  V7_BASELINE_COMMIT,
  V7_CONFIGURATIONS,
  V7_COST_MODEL,
  V7_DEVELOPMENT_END,
  V7_DEVELOPMENT_SYMBOLS,
  V7_DEVELOPMENT_START,
  V7_EMBARGO_HOURS,
  V7_FEATURE_DEFINITIONS,
  V7_FAMILIES,
  V7_PURGE_HOURS,
  V7_RESEARCH_END,
  V7_RESEARCH_START,
  V7_RISK_TEMPLATES,
  V7_SYMBOL_HOLDOUT,
  V7_TEMPORAL_END,
  V7_TEMPORAL_START,
  V7_UNIVERSE,
} from "@/lib/v7/registry";
import type { V7Family, V7MetricSummary, V7NestedResult, V7RunResult, V7Trade, V7ValidationResult } from "@/lib/v7/types";

const REPORT_DIR = resolve("reports");
const FEASIBILITY_PATH = resolve(REPORT_DIR, "v7-data-feasibility.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v7-registry.json");

interface FrozenRegistry extends Record<string, unknown> {
  status: string;
  baselineCommit: string;
  registryHash: string;
  configurationCount: number;
  riskTemplateCount: number;
  featureCount: number;
  universe: string[];
  symbolHoldout: string[];
  developmentSymbols: string[];
}

interface FamilyEvaluation {
  family: V7Family;
  nested: V7NestedResult;
  temporal: V7ValidationResult;
  symbol: V7ValidationResult;
  passed: boolean;
}

async function main(): Promise<void> {
  const feasibility = await readJson<Record<string, unknown>>(FEASIBILITY_PATH);
  if (feasibility.status !== "PASS") {
    console.error("V7_DATA_INSUFFICIENT");
    process.exitCode = 2;
    return;
  }
  const registry = await readJson<FrozenRegistry>(REGISTRY_PATH);
  assertFrozenRegistry(registry, feasibility);
  if (process.env.CI === "true" || process.env.V7_REPORT_ONLY === "1") {
    verifyCommittedReport(feasibility, registry, await readJson<Record<string, unknown>>(resolve(REPORT_DIR, "v7-validation-summary.json")));
    console.info(JSON.stringify({ stage: "v7_validation_frozen_report_verified", registryHash: registry.registryHash, dataGate: feasibility.status }));
    return;
  }

  const loaded = await loadV7Datasets(V7_UNIVERSE);
  if (loaded.summary.loadedSymbols < V7_UNIVERSE.length) {
    console.error(JSON.stringify({ stage: "v7_dataset_load", status: "V7_DATA_INSUFFICIENT", loadedSymbols: loaded.summary.loadedSymbols, requiredSymbols: V7_UNIVERSE.length }));
    process.exitCode = 2;
    return;
  }
  const runs = buildV7Runs(loaded.datasets, V7_RESEARCH_START, V7_RESEARCH_END);
  const familyResults = V7_FAMILIES.map((family): FamilyEvaluation => {
    const nested = runNestedFamily(runs, family, V7_DEVELOPMENT_START, V7_DEVELOPMENT_END, new Set(V7_DEVELOPMENT_SYMBOLS));
    const temporal = evaluateTemporalValidation(nested.selectedRun, V7_TEMPORAL_START, V7_TEMPORAL_END);
    const symbol = evaluateSymbolValidation(nested.selectedRun, new Set(V7_SYMBOL_HOLDOUT), V7_RESEARCH_START, V7_RESEARCH_END);
    return { family, nested, temporal, symbol, passed: familyPasses(nested, temporal, symbol) };
  });
  const best = selectBestFamily(familyResults);
  const bestTrades = best?.nested.nestedTrades ?? [];
  const stability = buildStability(bestTrades);
  const portfolio = buildPortfolioSummary(bestTrades);
  const allFamiliesPass = familyResults.some((result) => result.passed);
  const summary = buildSummary({ feasibility, registry, loaded: loaded.summary, familyResults, best, stability, portfolio, allFamiliesPass });
  await writeJson(resolve(REPORT_DIR, "v7-candidate-registry.json"), {
    schema: "bca-v7-candidate-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: V7_BASELINE_COMMIT,
    registryHash: registry.registryHash,
    configurations: V7_CONFIGURATIONS.length,
    riskTemplates: V7_RISK_TEMPLATES.length,
    featureCount: V7_FEATURE_DEFINITIONS.length,
    universe: V7_UNIVERSE,
    holdout: V7_SYMBOL_HOLDOUT,
    runs: runs.map(serializeRun),
    selection: "Diagnostic representative is selected only after the preregistered nested protocol; no family enters promotion unless every hard gate passes.",
  });
  await writeJson(resolve(REPORT_DIR, "v7-family-results.json"), familyResults.map(serializeFamilyResult));
  await writeJson(resolve(REPORT_DIR, "v7-stability.json"), stability);
  await writeJson(resolve(REPORT_DIR, "v7-portfolio.json"), serializePortfolio(portfolio));
  await writeJson(resolve(REPORT_DIR, "v7-validation-summary.json"), summary);
  await writeFile(resolve(REPORT_DIR, "v7-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({
    stage: "v7_validation_complete",
    baseline: V7_BASELINE_COMMIT,
    dataGate: feasibility.status,
    symbols: loaded.summary.loadedSymbols,
    runs: runs.length,
    families: familyResults.map((result) => ({ family: result.family, nestedTrades: result.nested.metrics.trades, temporal: result.temporal.status, symbol: result.symbol.status, pass: result.passed })),
    emailPromotionCandidate: summary.EMAIL_PROMOTION_CANDIDATE,
    researchStop: summary.researchStop,
  }));
}

function assertFrozenRegistry(registry: FrozenRegistry, feasibility: Record<string, unknown>): void {
  if (registry.status !== "FROZEN_BEFORE_RETURN_READ" || registry.baselineCommit !== V7_BASELINE_COMMIT || registry.configurationCount !== V7_CONFIGURATIONS.length || registry.riskTemplateCount !== V7_RISK_TEMPLATES.length || registry.featureCount !== V7_FEATURE_DEFINITIONS.length || registry.universe.length !== V7_UNIVERSE.length || registry.symbolHoldout.length !== V7_SYMBOL_HOLDOUT.length || hashWithoutField(registry, "registryHash") !== registry.registryHash) throw new Error("V7 registry integrity or freeze order failed");
  if (feasibility.status !== "PASS" || Number(feasibility.symbols) < 20 || Number(feasibility.historyYears) < 2 || Number(feasibility.minimumDerivativesCoverage) < 0.9 || Number(feasibility.minimumOhlcvCoverage) < 0.9) throw new Error("V7 data feasibility hard gate failed");
}

function verifyCommittedReport(feasibility: Record<string, unknown>, registry: FrozenRegistry, summary: Record<string, unknown>): void {
  if (summary.schema !== "bca-v7-validation-summary-v1" || summary.baseline !== V7_BASELINE_COMMIT || summary.registryHash !== registry.registryHash || summary.researchOnly !== true || feasibility.status !== "PASS") throw new Error("V7 frozen report integrity failed");
  const boundaries = summary.hardBoundaries as Record<string, unknown> | undefined;
  if (!boundaries || Object.values(boundaries).some((value) => value !== false && value !== true) || boundaries.productionChanged !== false || boundaries.deployment !== false || boundaries.merge !== false || boundaries.migration !== false || boundaries.autoTrading !== false) throw new Error("V7 report boundary integrity failed");
}

function selectBestFamily(results: readonly FamilyEvaluation[]): FamilyEvaluation | null {
  return results.slice().sort((left, right) => Number(right.passed) - Number(left.passed) || right.nested.metrics.netR - left.nested.metrics.netR || right.nested.metrics.avgR - left.nested.metrics.avgR || left.family.localeCompare(right.family))[0] ?? null;
}

function buildStability(trades: readonly V7Trade[]): Record<string, unknown> {
  const years = yearMetrics(trades, [2023, 2024, 2025]);
  const positiveYearNetR = Object.values(years).map((value) => value.netR).filter((value) => value > 0);
  const bestYearContribution = positiveYearNetR.length > 0 ? Math.max(...positiveYearNetR) / positiveYearNetR.reduce((sum, value) => sum + value, 0) : null;
  return {
    schema: "bca-v7-stability-v1",
    years: Object.fromEntries(Object.entries(years).map(([year, value]) => [year, serializeMetric(value)])),
    oiRegimes: Object.fromEntries(Object.entries(regimeMetrics(trades)).map(([regime, value]) => [regime, serializeMetric(value)])),
    fundingRegimes: Object.fromEntries(Object.entries(fundingRegimeMetrics(trades)).map(([regime, value]) => [regime, serializeMetric(value)])),
    symbols: Object.fromEntries([...new Set(trades.map((trade) => trade.symbol))].sort().map((symbol) => [symbol, serializeMetric(summarizeV7Trades(trades.filter((trade) => trade.symbol === symbol)))])),
    bestYearContribution,
    bestYearContributionTarget: 0.4,
  };
}

function buildSummary(input: { feasibility: Record<string, unknown>; registry: FrozenRegistry; loaded: V7DataLoadSummary; familyResults: readonly FamilyEvaluation[]; best: FamilyEvaluation | null; stability: Record<string, unknown>; portfolio: ReturnType<typeof buildPortfolioSummary>; allFamiliesPass: boolean }): Record<string, unknown> {
  const bestRun = input.best?.nested.selectedRun;
  const promotion = input.allFamiliesPass ? "PASS" : "FAIL";
  return {
    schema: "bca-v7-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    baseline: V7_BASELINE_COMMIT,
    registryHash: input.registry.registryHash,
    researchOnly: true,
    dataFeasibility: input.feasibility,
    dataLoad: input.loaded,
    registry: { path: "reports/v7-registry.json", hash: input.registry.registryHash, configurationCount: V7_CONFIGURATIONS.length, riskTemplateCount: V7_RISK_TEMPLATES.length, featureCount: V7_FEATURE_DEFINITIONS.length, universe: V7_UNIVERSE, holdout: V7_SYMBOL_HOLDOUT, developmentSymbols: V7_DEVELOPMENT_SYMBOLS, costModel: V7_COST_MODEL, purgeHours: V7_PURGE_HOURS, embargoHours: V7_EMBARGO_HOURS },
    families: input.familyResults.map(serializeFamilyResult),
    bestCandidate: { status: input.allFamiliesPass ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "NO_VALID_V7_STRATEGY", family: input.best?.family ?? null, configuration: bestRun?.configId ?? null, riskTemplate: bestRun?.riskTemplateId ?? null, side: bestRun?.side ?? null, selection: "Diagnostic representative only; no Production promotion is performed in V7 research." },
    nested: input.best ? { metrics: serializeMetric(input.best.nested.metrics), stress: serializeStress(input.best.nested.stress), yield: input.best.nested.yield, positiveFoldRatio: input.best.nested.positiveFoldRatio, medianFoldNetR: input.best.nested.medianFoldNetR, promotionLCB: input.best.nested.promotionLCB, folds: input.best.nested.folds } : null,
    yield: input.best?.nested.yield ?? null,
    stability: input.stability,
    temporalValidation: input.best ? serializeValidation(input.best.temporal) : null,
    symbolValidation: input.best ? serializeValidation(input.best.symbol) : null,
    portfolio: serializePortfolio(input.portfolio),
    EMAIL_PROMOTION_CANDIDATE: promotion,
    researchStop: "YES",
    researchStopReason: input.allFamiliesPass ? "V7 promotion candidate gate passed; stop research before any implementation decision." : "V7_FLOW_ALPHA_REJECTED: no flow family passed every nested, temporal, symbol, stress and yield gate.",
    hardBoundaries: { productionChanged: false, shadowExperimentChanged: false, productionEmailChanged: false, deployment: false, merge: false, migration: false, autoTrading: false, strategyParametersChanged: false, oldV5StrategyTuned: false },
  };
}

function serializeFamilyResult(result: FamilyEvaluation): Record<string, unknown> {
  return { family: result.family, selectedRun: serializeRun(result.nested.selectedRun), nested: { metrics: serializeMetric(result.nested.metrics), stress: serializeStress(result.nested.stress), yield: result.nested.yield, positiveFoldRatio: result.nested.positiveFoldRatio, medianFoldNetR: result.nested.medianFoldNetR, promotionLCB: result.nested.promotionLCB, folds: result.nested.folds }, temporalValidation: serializeValidation(result.temporal), symbolValidation: serializeValidation(result.symbol), pass: result.passed };
}

function serializeRun(run: V7RunResult): Record<string, unknown> {
  return { runId: run.runId, family: run.family, configId: run.configId, riskTemplateId: run.riskTemplateId, side: run.side, trades: run.metrics.trades, metrics: serializeMetric(run.metrics), stress: serializeStress(run.stress), yield: run.yield, pareto: run.pareto, selectionScore: finiteOrNull(run.selectionScore) };
}

function serializeValidation(value: V7ValidationResult): Record<string, unknown> {
  return { status: value.status, metrics: serializeMetric(value.metrics), stress: serializeStress(value.stress), symbols: value.symbols, gate: value.gate };
}

function serializeStress(value: { base: V7MetricSummary; plus5Bps: V7MetricSummary; plus10Bps: V7MetricSummary; plus15Bps: V7MetricSummary }): Record<string, unknown> {
  return { base: serializeMetric(value.base), plus5Bps: serializeMetric(value.plus5Bps), plus10Bps: serializeMetric(value.plus10Bps), plus15Bps: serializeMetric(value.plus15Bps) };
}

function serializeMetric(value: V7MetricSummary): Record<string, unknown> {
  return { trades: value.trades, wins: value.wins, losses: value.losses, winRate: round(value.winRate), netR: round(value.netR), avgR: round(value.avgR), profitFactor: finiteOrNull(value.profitFactor), maxDD: round(value.maxDD), cvar95: value.cvar95 === null ? null : round(value.cvar95), positiveMonthRatio: value.positiveMonthRatio === null ? null : round(value.positiveMonthRatio), symbolBreadth: value.symbolBreadth, positiveSymbolRatio: value.positiveSymbolRatio === null ? null : round(value.positiveSymbolRatio), totalNetPnlUsdt: round(value.totalNetPnlUsdt), totalFeesUsdt: round(value.totalFeesUsdt), totalFundingUsdt: round(value.totalFundingUsdt), totalSlippageUsdt: round(value.totalSlippageUsdt) };
}

function serializePortfolio(value: ReturnType<typeof buildPortfolioSummary>): Record<string, unknown> {
  return { metrics: serializeMetric(value.metrics), maxConcurrent: value.maxConcurrent, maxSymbolConcentration: value.maxSymbolConcentration, maxClusterConcentration: value.maxClusterConcentration, rejectedForCapacity: value.rejectedForCapacity, rejectedForSymbolConcentration: value.rejectedForSymbolConcentration, rejectedForClusterConcentration: value.rejectedForClusterConcentration, concentrationProxy: value.concentrationProxy };
}

function renderDecision(summary: Record<string, unknown>): string {
  const best = summary.bestCandidate as Record<string, unknown>;
  return [
    "# V7.0 Derivatives Flow Alpha Reset",
    "",
    `Baseline: **${V7_BASELINE_COMMIT}**; registry: **${String(summary.registryHash)}**; research-only.`,
    `Data feasibility: **${(summary.dataFeasibility as Record<string, unknown>).status}**.`,
    `Best diagnostic representative: **${String(best.family ?? "NONE")} / ${String(best.configuration ?? "NONE")} / ${String(best.side ?? "NONE")}**.`,
    `EMAIL_PROMOTION_CANDIDATE: **${String(summary.EMAIL_PROMOTION_CANDIDATE)}**.`,
    `Research stop: **${String(summary.researchStop)}** — ${String(summary.researchStopReason)}.`,
    "",
    "No V5/V5.5 strategy, manifest, Production environment, email path, database schema, or trading behavior is changed by this research branch.",
    "",
  ].join("\n");
}

function finiteOrNull(value: number): number | null { return Number.isFinite(value) ? round(value) : null; }
function round(value: number | null): number | null { return value === null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000; }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
