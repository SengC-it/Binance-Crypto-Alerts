import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Candle, FundingRatePoint } from "@/lib/core/types";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { hashWithoutField } from "@/lib/v5-7/manifest";
import {
  buildPortfolioSummary,
  buildV6Runs,
  configurationsForData,
  evaluateValidation,
  regimeMetrics,
  runNestedFamily,
  summarizeV6Trades,
  summarizeV6Yield,
  yearMetrics,
} from "@/lib/v6/engine";
import {
  V6_BASELINE_COMMIT,
  V6_CONFIGURATIONS,
  V6_DEV_END,
  V6_DEV_START,
  V6_FAMILIES,
  V6_RISK_TEMPLATES,
  V6_VALIDATION_A_CANDIDATES,
  V6_VALIDATION_A_MANIFEST_ID,
  V6_VALIDATION_B_MANIFEST_ID,
} from "@/lib/v6/registry";
import type { V6Dataset, V6FamilyResult, V6MetricSummary, V6Trade, V6ValidationResult } from "@/lib/v6/types";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const DEVELOPMENT_MANIFEST_PATH = resolve(REPORT_DIR, "v6-development-manifest.json");
const VALIDATION_A_MANIFEST_PATH = resolve(REPORT_DIR, "v6-validation-a-manifest.json");
const VALIDATION_B_MANIFEST_PATH = resolve(REPORT_DIR, "v6-validation-b-manifest.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v6-registry.json");
const ARCHIVE_ROOTS = [
  resolve("data/raw/v5-8-fresh-cache/archives"),
  resolve("data/raw/v5-7-external-cache/archives"),
  resolve("data/raw/v5-9-untouched-cache/archives"),
  resolve("data/raw/v5-9-1-untouched-cache/archives"),
];
const TIMEFRAMES: readonly V57ExternalTimeframe[] = ["4h", "funding"];

interface FrozenManifest extends Record<string, unknown> {
  status: string;
  manifestId: string;
  manifestHash: string;
  symbols?: string[];
  candidateSymbols?: string[];
  cacheRecords?: Array<{ symbol: string; path: string; sha256: string }>;
}

interface LocalCacheDataset {
  symbol: string;
  candles: { "4h"?: Candle[] };
  fundingRates?: FundingRatePoint[];
}

async function main(): Promise<void> {
  const registry = await readJson<FrozenManifest>(REGISTRY_PATH);
  const developmentManifest = await readJson<FrozenManifest>(DEVELOPMENT_MANIFEST_PATH);
  const validationAManifest = await readJson<FrozenManifest>(VALIDATION_A_MANIFEST_PATH);
  const validationBManifest = await readJson<FrozenManifest>(VALIDATION_B_MANIFEST_PATH);
  assertFrozenInputs(registry, developmentManifest, validationAManifest, validationBManifest);

  const validationASymbols = new Set(validationAManifest.symbols ?? []);
  const developmentDatasets = await loadDevelopmentDatasets(validationASymbols);
  const validationADatasets = await loadLocalDatasets([...validationASymbols]);
  const validationBDatasets: V6Dataset[] = [];
  const runs = buildV6Runs(developmentDatasets, V6_DEV_START, V6_DEV_END);
  const familyResults = V6_FAMILIES.map((family) => {
    const result = runNestedFamily(runs, family, V6_DEV_START, V6_DEV_END);
    const validationA = evaluateValidation(result.selectedRun, validationADatasets, validationAManifest.status, V6_DEV_START, V6_DEV_END, "A");
    const validationB = evaluateValidation(result.selectedRun, validationBDatasets, validationBManifest.status, V6_DEV_START, V6_DEV_END, "B");
    const familyGate = familyGateWithValidation(result, validationA, validationB);
    return { ...result, validationA, validationB, passed: familyGate.passed };
  });

  const best = selectDiagnosticRepresentative(familyResults);
  const bestTrades = best?.nestedTrades ?? [];
  const stability = {
    years: yearMetrics(bestTrades, [2020, 2021, 2022, 2023, 2024, 2025, 2026]),
    regimes: regimeMetrics(bestTrades),
    positiveYears: [2020, 2021, 2022, 2023, 2024, 2025, 2026].filter((year) => (yearMetrics(bestTrades, [year])[String(year)]?.metrics.netR ?? 0) > 0),
  };
  const bestYearContribution = calculateBestYearContribution(stability.years);
  const portfolio = buildPortfolioSummary(bestTrades);
  const allFamiliesPass = familyResults.some((result) => result.passed);
  const summary = buildSummary({
    registry,
    developmentManifest,
    validationAManifest,
    validationBManifest,
    developmentDatasets,
    validationADatasets,
    familyResults,
    best,
    stability,
    bestYearContribution,
    portfolio,
    allFamiliesPass,
  });
  await writeJson(resolve(REPORT_DIR, "v6-candidate-registry.json"), buildCandidateRegistryReport(runs, developmentDatasets.length));
  await writeJson(resolve(REPORT_DIR, "v6-family-results.json"), familyResults.map(serializeFamilyResult));
  await writeJson(resolve(REPORT_DIR, "v6-stability.json"), serializeStability(stability, bestYearContribution));
  await writeJson(resolve(REPORT_DIR, "v6-portfolio.json"), serializePortfolio(portfolio));
  await writeJson(resolve(REPORT_DIR, "v6-validation-summary.json"), summary);
  await writeFile(resolve(REPORT_DIR, "v6-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({
    stage: "v6_validation_complete",
    baseline: V6_BASELINE_COMMIT,
    developmentSymbols: developmentDatasets.length,
    validationASymbols: validationADatasets.length,
    validationAStatus: validationAManifest.status,
    validationBStatus: validationBManifest.status,
    families: familyResults.map((result) => ({ family: result.family, nestedTrades: result.nested.metrics.trades, validationA: result.validationA.status, validationB: result.validationB.status, pass: result.passed })),
    emailPromotionCandidate: "FAIL",
    researchStop: allFamiliesPass ? "NO" : "YES",
  }));
}

function assertFrozenInputs(registry: FrozenManifest, development: FrozenManifest, validationA: FrozenManifest, validationB: FrozenManifest): void {
  if (registry.status !== "FROZEN_BEFORE_RETURN_READ" || registry.baselineCommit !== V6_BASELINE_COMMIT || registry.configurationCount !== V6_CONFIGURATIONS.length || typeof registry.registryHash !== "string" || hashWithoutField(registry, "registryHash") !== registry.registryHash) throw new Error("V6 registry is not frozen");
  if (typeof development.manifestHash !== "string" || hashWithoutField(development, "manifestHash") !== development.manifestHash || development.baselineCommit !== V6_BASELINE_COMMIT) throw new Error("V6 development manifest integrity failed");
  if (validationA.manifestId !== V6_VALIDATION_A_MANIFEST_ID || typeof validationA.manifestHash !== "string" || hashWithoutField(validationA, "manifestHash") !== validationA.manifestHash || validationA.baselineCommit !== V6_BASELINE_COMMIT) throw new Error("V6 Validation A manifest integrity failed");
  if (validationB.manifestId !== V6_VALIDATION_B_MANIFEST_ID || typeof validationB.manifestHash !== "string" || hashWithoutField(validationB, "manifestHash") !== validationB.manifestHash || validationB.baselineCommit !== V6_BASELINE_COMMIT) throw new Error("V6 Validation B manifest integrity failed");
  const candidates = new Set(validationA.candidateSymbols ?? []);
  if (candidates.size !== V6_VALIDATION_A_CANDIDATES.length || [...candidates].some((symbol) => !V6_VALIDATION_A_CANDIDATES.includes(symbol as never))) throw new Error("V6 Validation A candidate identity changed");
  if (validationB.status !== "DATA_INSUFFICIENT" || (validationB.symbols ?? []).length !== 0) throw new Error("V6 Validation B must remain unavailable without immutable cross-exchange data");
}

async function loadDevelopmentDatasets(validationASymbols: Set<string>): Promise<V6Dataset[]> {
  const datasets = await loadLocalDatasets([], validationASymbols);
  const roots = await Promise.all(ARCHIVE_ROOTS.map((root) => loadArchiveRoot(root, validationASymbols)));
  return mergeDatasets([...datasets, ...roots.flat()]);
}

async function loadLocalDatasets(requestedSymbols: string[], excludedSymbols = new Set<string>()): Promise<V6Dataset[]> {
  let files: string[] = [];
  try { files = await readdir(LOCAL_CACHE_DIR); } catch { return []; }
  const grouped = new Map<string, string[]>();
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    const symbol = file.slice(0, file.indexOf("-"));
    if (excludedSymbols.has(symbol)) continue;
    if (requestedSymbols.length > 0 && !requestedSymbols.includes(symbol)) continue;
    const group = grouped.get(symbol) ?? [];
    group.push(file);
    grouped.set(symbol, group);
  }
  const datasets: V6Dataset[] = [];
  for (const [symbol, names] of grouped) {
    const selected = names.sort((left, right) => parseStart(right) - parseStart(left))[0];
    if (!selected) continue;
    try {
      const raw = JSON.parse(await readFile(resolve(LOCAL_CACHE_DIR, selected), "utf8")) as LocalCacheDataset;
      const candles = dedupeCandles(raw.candles?.["4h"] ?? []);
      if (candles.length > 0) datasets.push({ symbol, candles4h: candles, fundingRates: dedupeFunding(raw.fundingRates ?? []) });
    } catch {
      // A corrupt cache is excluded from research; it is never repaired or
      // replaced with a different data source.
    }
  }
  return datasets;
}

async function loadArchiveRoot(root: string, excludedSymbols: Set<string>): Promise<V6Dataset[]> {
  let symbolDirectories: string[] = [];
  try { symbolDirectories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  const datasets: V6Dataset[] = [];
  for (const symbol of symbolDirectories) {
    if (excludedSymbols.has(symbol)) continue;
    const candles: Candle[] = [];
    const funding: FundingRatePoint[] = [];
    for (const timeframe of TIMEFRAMES) {
      let files: string[] = [];
      try { files = (await readdir(resolve(root, symbol, timeframe))).filter((file) => file.endsWith(".zip")).sort(); } catch { continue; }
      for (const file of files) {
        try {
          const parsed = await readMonthlyArchive(resolve(root, symbol, timeframe, file), timeframe);
          if (timeframe === "funding") funding.push(...(parsed.fundingRates ?? []));
          else candles.push(...(parsed.candles ?? []));
        } catch {
          // Individual archive corruption is represented by missing coverage;
          // no synthetic bar is introduced.
        }
      }
    }
    const merged = { symbol, candles4h: dedupeCandles(candles), fundingRates: dedupeFunding(funding) };
    if (merged.candles4h.length > 0) datasets.push(merged);
  }
  return datasets;
}

function mergeDatasets(datasets: V6Dataset[]): V6Dataset[] {
  const bySymbol = new Map<string, V6Dataset>();
  for (const dataset of datasets) {
    const current = bySymbol.get(dataset.symbol);
    if (!current) {
      bySymbol.set(dataset.symbol, { symbol: dataset.symbol, candles4h: [...dataset.candles4h], fundingRates: [...dataset.fundingRates] });
      continue;
    }
    current.candles4h = dedupeCandles([...current.candles4h, ...dataset.candles4h]);
    current.fundingRates = dedupeFunding([...current.fundingRates, ...dataset.fundingRates]);
  }
  return [...bySymbol.values()].filter((dataset) => dataset.candles4h.length >= 200).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function familyGateWithValidation(result: V6FamilyResult, validationA: V6ValidationResult, validationB: V6ValidationResult): { passed: boolean } {
  const nestedGate = result.nested.metrics.trades >= 100
    && result.nested.metrics.netR > 0
    && result.nested.metrics.avgNetR >= 0.1
    && result.nested.metrics.profitFactor >= 1.25
    && (result.positiveFoldRatio ?? 0) >= 0.67
    && (result.medianFoldNetR ?? Number.NEGATIVE_INFINITY) > 0
    && result.stress.plus10Bps.metrics.netR > 0
    && (result.promotionLCB ?? Number.NEGATIVE_INFINITY) >= 0
    && result.nested.symbolBreadth >= 15;
  return { passed: nestedGate && validationA.status === "PASS" && validationB.status === "PASS" };
}

function selectDiagnosticRepresentative(results: V6FamilyResult[]): V6FamilyResult | null {
  return [...results].sort((left, right) => representativeScore(right) - representativeScore(left) || left.family.localeCompare(right.family))[0] ?? null;
}

function representativeScore(result: V6FamilyResult): number {
  const selected = result.selectedRun ? result.configurations.find((candidate) => candidate.runId === result.selectedRun?.id) : null;
  return (selected?.selectionScore ?? Number.NEGATIVE_INFINITY)
    + result.nested.metrics.avgNetR * 10
    - result.nested.metrics.maxDrawdownR * 0.05;
}

function calculateBestYearContribution(years: Record<string, V6MetricSummary>): number | null {
  const positive = Object.values(years).map((summary) => summary.metrics.netR).filter((value) => value > 0);
  if (positive.length === 0) return null;
  return Math.max(...positive) / positive.reduce((sum, value) => sum + value, 0);
}

function buildSummary(input: {
  registry: FrozenManifest;
  developmentManifest: FrozenManifest;
  validationAManifest: FrozenManifest;
  validationBManifest: FrozenManifest;
  developmentDatasets: V6Dataset[];
  validationADatasets: V6Dataset[];
  familyResults: V6FamilyResult[];
  best: V6FamilyResult | null;
  stability: { years: Record<string, V6MetricSummary>; regimes: Record<string, V6MetricSummary>; positiveYears: number[] };
  bestYearContribution: number | null;
  portfolio: ReturnType<typeof buildPortfolioSummary>;
  allFamiliesPass: boolean;
}): Record<string, unknown> {
  const best = input.best;
  const bestRun = best?.selectedRun;
  const bestEvaluation = best && bestRun ? best.configurations.find((candidate) => candidate.runId === bestRun.id) : null;
  return {
    schema: "bca-v6-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    baseline: V6_BASELINE_COMMIT,
    researchOnly: true,
    data: {
      developmentSymbols: input.developmentDatasets.length,
      pitUniverse: input.developmentManifest.pitUniverse ?? null,
      validationA: { manifest: input.validationAManifest.manifestId, status: input.validationAManifest.status, candidateSymbols: input.validationAManifest.candidateSymbols, symbols: input.validationADatasets.map((dataset) => dataset.symbol), coverage: input.validationAManifest.coverage },
      validationB: { manifest: input.validationBManifest.manifestId, status: input.validationBManifest.status, exchange: input.validationBManifest.exchange, symbols: [] },
    },
    registry: { path: "reports/v6-registry.json", hash: input.registry.registryHash, configurations: configurationsForData(), riskTemplates: V6_RISK_TEMPLATES },
    families: input.familyResults.map((result) => serializeFamilyResult(result)),
    bestCandidate: {
      status: input.allFamiliesPass ? "VALID" : "NO_VALID_V6_STRATEGY",
      family: best?.family ?? null,
      configuration: bestRun?.config.id ?? null,
      riskTemplate: bestRun?.riskTemplate.id ?? null,
      direction: bestRun?.side ?? null,
      selection: "Diagnostic Pareto representative only; no promotion because every family must pass both validations.",
      developmentEvaluation: bestEvaluation ? serializeCandidateEvaluation(bestEvaluation) : null,
    },
    nested: best ? { trades: best.nested.metrics.trades, metrics: serializeMetricSummary(best.nested), stress: serializeStress(best.stress), positiveFoldRatio: best.positiveFoldRatio, promotionLCB: best.promotionLCB, yield: best.yield, folds: best.folds } : null,
    yield: best?.yield ?? null,
    stability: serializeStability(input.stability, input.bestYearContribution),
    validationA: best ? serializeValidation(best.validationA) : serializeValidation(undefined),
    validationB: best ? serializeValidation(best.validationB) : serializeValidation(undefined),
    portfolio: serializePortfolio(input.portfolio),
    EMAIL_PROMOTION_CANDIDATE: "FAIL",
    researchStop: input.allFamiliesPass ? "NO" : "YES",
    researchStopReason: input.allFamiliesPass ? null : "V6_STRATEGY_RESEARCH_STOP: no family passed Nested OOS + Validation A + Validation B.",
    oldProduction: { status: "DATA_UNAVAILABLE", exactReplay: false, reason: "Exact old Production configuration is not available; no fake replay." },
    hardBoundaries: { productionChanged: false, v55Changed: false, shadowExperimentChanged: false, productionEmailChanged: false, deployment: false, merge: false, migration: false, autoTrading: false, strategyParametersChanged: false, v59Frozen: true, v591Frozen: true },
  };
}

function buildCandidateRegistryReport(runs: ReturnType<typeof buildV6Runs>, developmentSymbols: number): Record<string, unknown> {
  return {
    schema: "bca-v6-candidate-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: V6_BASELINE_COMMIT,
    configurationCount: V6_CONFIGURATIONS.length,
    riskTemplateCount: V6_RISK_TEMPLATES.length,
    developmentSymbols,
    runs: runs.map((run) => ({
      id: run.id,
      family: run.family,
      configId: run.config.id,
      side: run.side,
      riskTemplateId: run.riskTemplate.id,
      signals: run.signals.length,
      trades: run.trades.length,
      minimumRiskPrice: run.trades.length > 0 ? Math.min(...run.trades.map((trade) => trade.riskPrice)) : null,
      maximumAbsoluteR: run.trades.length > 0 ? Math.max(...run.trades.map((trade) => Math.abs(trade.rMultiple))) : null,
      extremeTrades: [...run.trades]
        .sort((left, right) => Math.abs(right.rMultiple) - Math.abs(left.rMultiple))
        .slice(0, 3)
        .map((trade) => ({ symbol: trade.symbol, side: trade.side, signalTimestamp: trade.signalTimestamp, entryPrice: trade.entryPrice, riskPrice: trade.riskPrice, rMultiple: trade.rMultiple })),
    })),
    selection: "Inner purged walk-forward Pareto frontier over profitability, risk, robustness, signal frequency and breadth; highest NetR alone is not selected.",
  };
}

function serializeFamilyResult(result: V6FamilyResult): Record<string, unknown> {
  return {
    family: result.family,
    configurations: result.configurations.map(serializeCandidateEvaluation),
    folds: result.folds,
    nested: serializeMetricSummary(result.nested),
    stress: serializeStress(result.stress),
    yield: result.yield,
    positiveFoldRatio: result.positiveFoldRatio,
    medianFoldNetR: result.medianFoldNetR,
    promotionLCB: result.promotionLCB,
    selectedRun: result.selectedRun ? { id: result.selectedRun.id, config: result.selectedRun.config.id, riskTemplate: result.selectedRun.riskTemplate.id, side: result.selectedRun.side } : null,
    validationA: serializeValidation(result.validationA),
    validationB: serializeValidation(result.validationB),
    pass: result.passed,
  };
}

function serializeCandidateEvaluation(value: V6FamilyResult["configurations"][number]): Record<string, unknown> {
  return { ...value, metrics: serializeMetricSummary(value.metrics), stress: serializeStress(value.stress) };
}

function serializeMetricSummary(value: V6MetricSummary | undefined): Record<string, unknown> {
  if (!value) return emptyMetric();
  const metrics = value.metrics;
  return { trades: metrics.trades, wins: metrics.wins, losses: metrics.losses, winRate: round(metrics.winRate), netR: round(metrics.netR), avgR: round(metrics.avgNetR), profitFactor: finiteOrNull(metrics.profitFactor), maxDD: round(metrics.maxDrawdownR), cvar95: round(value.cvar95), positiveMonthRatio: round(metrics.positiveMonthRatio), symbolBreadth: value.symbolBreadth, positiveSymbolRatio: round(value.positiveSymbolRatio), totalNetPnlUsdt: round(metrics.totalNetPnlUsdt), totalFeesUsdt: round(metrics.totalFeesUsdt), totalFundingUsdt: round(metrics.totalFundingUsdt), totalSlippageUsdt: round(metrics.totalSlippageUsdt) };
}

function serializeStress(value: V6FamilyResult["stress"] | undefined): Record<string, unknown> {
  if (!value) return { base: emptyMetric(), plus5Bps: emptyMetric(), plus10Bps: emptyMetric(), plus15Bps: emptyMetric() };
  return { base: serializeMetricSummary(value.base), plus5Bps: serializeMetricSummary(value.plus5Bps), plus10Bps: serializeMetricSummary(value.plus10Bps), plus15Bps: serializeMetricSummary(value.plus15Bps) };
}

function serializeValidation(value: V6ValidationResult | undefined): Record<string, unknown> {
  if (!value) return { status: "DATA_INSUFFICIENT", metrics: emptyMetric(), stress: serializeStress(undefined), yield: null, gate: {}, symbols: 0, dataStatus: "DATA_INSUFFICIENT" };
  return { status: value.status, metrics: serializeMetricSummary(value.metrics), stress: serializeStress(value.stress), yield: value.yield, gate: value.gate, symbols: value.symbols, dataStatus: value.dataStatus };
}

function serializeStability(stability: { years: Record<string, V6MetricSummary>; regimes: Record<string, V6MetricSummary>; positiveYears: number[] }, bestYearContribution: number | null): Record<string, unknown> {
  return { years: Object.fromEntries(Object.entries(stability.years).map(([year, value]) => [year, serializeMetricSummary(value)])), regimes: Object.fromEntries(Object.entries(stability.regimes).map(([regime, value]) => [regime, serializeMetricSummary(value)])), positiveYears: stability.positiveYears, worstYear: findWorstYear(stability.years), bestYearContribution: round(bestYearContribution) };
}

function serializePortfolio(value: ReturnType<typeof buildPortfolioSummary>): Record<string, unknown> {
  return { metrics: serializeMetricSummary(value.metrics), maxConcurrent: value.maxConcurrent, maxSymbolConcentration: value.maxSymbolConcentration, maxClusterConcentration: value.maxClusterConcentration, rejectedForCapacity: value.rejectedForCapacity, rejectedForSymbolConcentration: value.rejectedForSymbolConcentration, rejectedForClusterConcentration: value.rejectedForClusterConcentration, concentrationProxy: value.concentrationProxy };
}

function renderDecision(summary: Record<string, unknown>): string {
  const best = summary.bestCandidate as Record<string, unknown>;
  return [
    "# V6.0 Strategy Reset & Final Robustness Bake-off",
    "",
    `Baseline: **${String(summary.baseline)}**; research-only; V5.5 through V5.9.1 frozen.`,
    `Best diagnostic Pareto representative: **${String(best.family ?? "NONE")} / ${String(best.configuration ?? "NONE")} / ${String(best.direction ?? "NONE")}**.`,
    `EMAIL_PROMOTION_CANDIDATE: **${String(summary.EMAIL_PROMOTION_CANDIDATE)}**.`,
    `Research stop: **${String(summary.researchStop)}**.`,
    "",
    "## Validation boundary",
    "Validation A and Validation B are independent manifests. DATA_INSUFFICIENT is not converted into a pass and old V5 holdouts are not reused.",
    "",
    "## Hard boundary",
    "- Production: NO change",
    "- #002: NO change",
    "- Production email: NO change",
    "- Deployment: NO",
    "- Merge: NO",
    "- Migration: NO",
    "- Auto trading: NO",
    "- V5.5-V5.9.1: FROZEN",
    "",
  ].join("\n");
}

function findWorstYear(years: Record<string, V6MetricSummary>): string | null {
  const entries = Object.entries(years);
  if (entries.length === 0) return null;
  return entries.sort(([, left], [, right]) => left.metrics.netR - right.metrics.netR)[0]?.[0] ?? null;
}

function emptyMetric(): Record<string, unknown> {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, netR: 0, avgR: 0, profitFactor: 0, maxDD: 0, cvar95: null, symbolBreadth: 0, positiveSymbolRatio: null };
}

function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle);
  return [...map.values()].sort((left, right) => left.openTime - right.openTime);
}

function dedupeFunding(points: FundingRatePoint[]): FundingRatePoint[] {
  const map = new Map<number, FundingRatePoint>();
  for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point);
  return [...map.values()].sort((left, right) => left.fundingTime - right.fundingTime);
}

function parseStart(name: string): number {
  const value = Number(name.replace(/\.json$/i, "").split("-").at(-2));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? round(value) : null;
}

function round(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
