import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "@/lib/backtest/types";
import { closes, ema } from "@/lib/core/indicators";
import type { Candle, FundingRatePoint, Instrument, MarketRegime } from "@/lib/core/types";
import {
  applyAdditionalSlippage,
  blockBootstrapLowerConfidenceBound,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type PurgedWalkForwardFold,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import { selectionAdjustedLowerConfidenceBound } from "@/lib/v5-3/structural";
import { calculateYieldMetrics } from "@/lib/v5-6-1/research";
import {
  applyRegimeGate,
  evaluateFreshPromotionGate,
  runFrozenPrimaryPool,
  summarizeRegimeTrades,
  V58_BURNED_EXTERNAL_END,
  V58_BURNED_EXTERNAL_START,
  V58_DEV_START,
  V58_FRESH_END,
  V58_FRESH_MANIFEST_ID,
  V58_FRESH_START,
  V58_FRESH_SYMBOLS,
  V58_LOCAL_DEVELOPMENT_END,
  V58_LOCAL_DEVELOPMENT_START,
  V58_MAX_REGIME_GATES,
  V58_PRIMARY_EDGE_ID,
  V58_REGIME_GATE_REGISTRY,
  type V58MetricSummary,
  type V58RegimeDimension,
  type V58RegimeGateDefinition,
  type V58RegimeTrade,
} from "@/lib/v5-8/regime";
import { hashWithoutField, sha256Json } from "@/lib/v5-7/manifest";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const LOCAL_CACHE_FILE_PATTERN = /-1691633700000-1786241699999\.json$/;
const V57_MANIFEST_PATH = resolve(REPORT_DIR, "v5-7-research-manifest.json");
const V57_VALIDATION_PATH = resolve(REPORT_DIR, "v5-7-validation-summary.json");
const V57_PROMOTION_PATH = resolve(REPORT_DIR, "v5-7-promotion-decision.md");
const V57_EXTERNAL_INVENTORY_PATH = resolve(REPORT_DIR, "v5-7-external-data-inventory.json");
const V58_RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-8-research-manifest.json");
const V58_REGISTRY_PATH = resolve(REPORT_DIR, "v5-8-regime-gate-registry.json");
const V58_FRESH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-8-fresh-validation-manifest.json");
const V58_FRESH_INVENTORY_PATH = resolve(REPORT_DIR, "v5-8-fresh-data-inventory.json");
const EXTERNAL_TIMEFRAMES: readonly V57ExternalTimeframe[] = ["15m", "1h", "4h", "funding"];

const REGIME_DIMENSIONS: readonly V58RegimeDimension[] = [
  "marketRegime",
  "btcRegime",
  "ethRegime",
  "btcEthAlignment",
  "breadthBucket",
  "atrPercentileBucket",
  "volatilityPercentileBucket",
  "fundingPercentileBucket",
  "trendAgeBucket",
  "marketWideMomentumBucket",
  "btc24hTrend",
  "btc7dTrend",
  "crossSectionalDispersionBucket",
  "liquidityVolumeBucket",
];

const DIMENSION_LOGIC: Record<V58RegimeDimension, string> = {
  marketRegime: "Local EMA trend state distinguishes bullish exhaustion/range reversal from confirmed bearish continuation.",
  btcRegime: "BTC trend is a market-wide risk anchor for whether a local reversal has broad follow-through.",
  ethRegime: "ETH trend is a second liquid benchmark and helps identify cross-market confirmation or disagreement.",
  btcEthAlignment: "Benchmark agreement reduces idiosyncratic squeeze risk; conflict is a direct regime-dependence signal.",
  breadthBucket: "The fraction of assets above their 1h trend separates broad participation from isolated moves.",
  atrPercentileBucket: "ATR percentile proxies the executable range available to the frozen structural stop and target.",
  volatilityPercentileBucket: "Realized-volatility percentile distinguishes bounded reversals from shock conditions.",
  fundingPercentileBucket: "Funding percentile is a positioning-crowding proxy around the signal.",
  trendAgeBucket: "Bear-trend age tests whether a short reversal is early, mature, or late in the prevailing move.",
  marketWideMomentumBucket: "The aggregate benchmark direction tests whether local signals are supported by broad momentum.",
  btc24hTrend: "BTC 24h return captures the immediate risk impulse using only already-closed 1h candles.",
  btc7dTrend: "BTC 7d return captures the slower risk backdrop without using future candles.",
  crossSectionalDispersionBucket: "Dispersion tests whether symbols move together or fragment into idiosyncratic outcomes.",
  liquidityVolumeBucket: "Closed-candle volume ratio proxies whether the structural setup has sufficient participation.",
};

interface V57ArchiveRecord {
  timeframe: V57ExternalTimeframe;
  cachePath: string | null;
  status: string;
  sha256: string | null;
  rowCount: number | null;
}

interface V57SymbolRecord {
  symbol: string;
  pitEligible: boolean;
  classification: string;
  records: V57ArchiveRecord[];
}

interface V57Inventory {
  status: string;
  manifestId: string;
  pitEligibleSymbols: string[];
  availableSymbols: string[];
  symbols: V57SymbolRecord[];
}

interface FreshArchiveRecord extends V57ArchiveRecord {
  symbol: string;
  period: string;
}

interface FreshSymbolRecord {
  symbol: string;
  classification: string;
  records: FreshArchiveRecord[];
}

interface FreshInventory {
  status: string;
  manifestId: string;
  manifestHash: string;
  availableSymbols: string[];
  symbolRecords: FreshSymbolRecord[];
}

interface FoldSummary {
  fold: string;
  trades: number;
  netR: number;
  avgR: number;
  profitFactor: number | null;
  positive: boolean;
  selectedGate: string | null;
}

interface GateResult {
  gate: V58RegimeGateDefinition;
  fixedOosTrades: V58RegimeTrade[];
  fixedOos: V58MetricSummary;
  outerFolds: FoldSummary[];
  selectionCount: number;
  selectionAdjustedLcb95: number | null;
}

interface NestedGateAnalysis {
  folds: PurgedWalkForwardFold[];
  gateResults: GateResult[];
  selectedGate: V58RegimeGateDefinition | null;
  selectedGateTraining: { start: number; end: number; trades: number; score: number | null };
  nestedTrades: V58RegimeTrade[];
  nestedMetrics: V58MetricSummary;
  nestedFoldMetrics: FoldSummary[];
  positiveFoldRatio: number | null;
  medianFold: FoldSummary | null;
  worstFold: FoldSummary | null;
  plus10Bps: V58MetricSummary;
  foldLcb95: number | null;
  selectionAdjustedLcb95: number | null;
  promotionLcb95: number | null;
  gateChecks: Record<string, boolean>;
  promotion: "PASS" | "FAIL" | "DATA_UNAVAILABLE";
}

async function main(): Promise<void> {
  const v57Manifest = await readJson<Record<string, unknown>>(V57_MANIFEST_PATH);
  const v57Validation = await readJson<Record<string, unknown>>(V57_VALIDATION_PATH);
  const v58Manifest = await readJson<Record<string, unknown>>(V58_RESEARCH_MANIFEST_PATH);
  const registryReport = await readJson<Record<string, unknown>>(V58_REGISTRY_PATH);
  const freshManifest = await readJson<Record<string, unknown>>(V58_FRESH_MANIFEST_PATH);
  await assertFrozenInputs(v57Manifest, v57Validation, v58Manifest, registryReport, freshManifest);

  const v57Inventory = await readJsonOrNull<V57Inventory>(V57_EXTERNAL_INVENTORY_PATH);
  const freshInventory = await readJsonOrNull<FreshInventory>(V58_FRESH_INVENTORY_PATH);
  const localDatasets = await loadLocalDevelopmentDatasets();
  const burnedReady = await v57ExternalCacheIsReady(v57Inventory);
  const burnedDatasets = burnedReady && v57Inventory ? await loadV57ExternalDatasets(v57Inventory) : [];
  const freshReady = await freshCacheIsReady(freshInventory, freshManifest);
  const freshDatasets = freshReady && freshInventory ? await loadFreshDatasets(freshInventory) : [];
  const localTrades = localDatasets.length > 0
    ? runFrozenPrimaryPool(localDatasets, V58_LOCAL_DEVELOPMENT_START, V58_LOCAL_DEVELOPMENT_END, "DEVELOPMENT")
    : [];
  const burnedTrades = burnedDatasets.length > 0
    ? runFrozenPrimaryPool(burnedDatasets, V58_BURNED_EXTERNAL_START, V58_BURNED_EXTERNAL_END, "BURNED_EXTERNAL")
    : [];
  const developmentTrades = [...burnedTrades, ...localTrades].sort((left, right) => left.entryTime - right.entryTime);
  const devEnd = localDatasets.length > 0 ? V58_LOCAL_DEVELOPMENT_END : burnedDatasets.length > 0 ? V58_BURNED_EXTERNAL_END : V58_LOCAL_DEVELOPMENT_END;
  const folds = createPurgedWalkForwardFolds({ start: V58_DEV_START, end: devEnd, initialTrainMonths: 12, validationMonths: 6, foldCount: 6, purgeHours: 72 });
  const nested = analyzeNestedGates(developmentTrades, folds);
  const attribution = buildAttribution(localTrades, burnedTrades, folds);
  const freshTrades = freshDatasets.length > 0
    ? runFrozenPrimaryPool(freshDatasets, V58_FRESH_START, V58_FRESH_END, "FRESH_VALIDATION")
    : [];
  const freshGate = freshDatasets.length > 0 && nested.selectedGate
    ? evaluateFreshPromotionGate(freshTrades, nested.selectedGate)
    : { status: "DATA_UNAVAILABLE" as const, raw: null, gated: null, gate: null, selectedGate: nested.selectedGate?.id ?? null };
  const report = buildValidationSummary({
    v58Manifest,
    registryReport,
    freshManifest,
    freshInventory,
    burnedReady: burnedReady && burnedDatasets.length > 0,
    localReady: localDatasets.length > 0,
    localTrades,
    burnedTrades,
    developmentTrades,
    nested,
    freshReady: freshReady && freshDatasets.length > 0,
    freshTrades,
    freshGate,
  });
  await writeFile(resolve(REPORT_DIR, "v5-8-regime-attribution.json"), `${JSON.stringify(attribution, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-8-regime-gate-results.json"), `${JSON.stringify(serializeGateResults(nested), null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-8-validation-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-8-promotion-decision.md"), renderPromotionDecision(report), "utf8");
  console.info(JSON.stringify({
    stage: "v5_8_validation_complete",
    manifestId: v58Manifest.manifestId,
    localDatasets: localDatasets.length,
    burnedDatasets: burnedDatasets.length,
    primaryDevelopmentTrades: localTrades.length,
    primaryBurnedExternalTrades: burnedTrades.length,
    selectedGate: nested.selectedGate?.id ?? null,
    nestedPromotion: nested.promotion,
    freshValidationRun: freshGate.status !== "DATA_UNAVAILABLE",
    freshStatus: freshGate.status,
    businessVerdict: "INCONCLUSIVE",
  }));
}

async function assertFrozenInputs(
  v57Manifest: Record<string, unknown>,
  v57Validation: Record<string, unknown>,
  v58Manifest: Record<string, unknown>,
  registryReport: Record<string, unknown>,
  freshManifest: Record<string, unknown>,
): Promise<void> {
  if (v57Manifest.status !== "FROZEN_BEFORE_DATA_READ" || v57Manifest.manifestId !== "v57-second-edge-2021-01-01-2023-07-31") throw new Error("V5.7 frozen identity changed");
  if (typeof v57Manifest.manifestHash !== "string" || hashWithoutField(v57Manifest, "manifestHash") !== v57Manifest.manifestHash) throw new Error("V5.7 manifest integrity check failed");
  if (v57Validation.manifestHash !== v57Manifest.manifestHash) throw new Error("V5.7 validation report no longer matches its frozen manifest");
  const v57Promotion = await readFile(V57_PROMOTION_PATH, "utf8");
  if (!v57Promotion.includes("V5.7") || v57Promotion.length === 0) throw new Error("V5.7 promotion report is unavailable");
  if (v58Manifest.status !== "FROZEN_BEFORE_DATA_READ" || typeof v58Manifest.manifestHash !== "string" || hashWithoutField(v58Manifest, "manifestHash") !== v58Manifest.manifestHash) throw new Error("V5.8 research manifest integrity check failed");
  if (registryReport.status !== "FROZEN_BEFORE_DATA_READ" || registryReport.candidateCount !== V58_MAX_REGIME_GATES || registryReport.registryHash !== sha256Json(V58_REGIME_GATE_REGISTRY)) throw new Error("V5.8 regime registry integrity check failed");
  if (typeof registryReport.reportHash !== "string" || hashWithoutField(registryReport, "reportHash") !== registryReport.reportHash) throw new Error("V5.8 registry report integrity check failed");
  if (freshManifest.status !== "FROZEN_BEFORE_DATA_READ" || freshManifest.manifestId !== V58_FRESH_MANIFEST_ID || typeof freshManifest.manifestHash !== "string" || hashWithoutField(freshManifest, "manifestHash") !== freshManifest.manifestHash) throw new Error("V5.8 fresh manifest integrity check failed");
  const symbols = freshManifest.symbols;
  if (!Array.isArray(symbols) || JSON.stringify(symbols) !== JSON.stringify([...V58_FRESH_SYMBOLS])) throw new Error("V5.8 fresh symbol set changed");
  if (V58_FRESH_END >= V58_BURNED_EXTERNAL_START && V58_FRESH_START <= V58_BURNED_EXTERNAL_END) throw new Error("Fresh and burned diagnostic periods overlap");
  const primary = v58Manifest.primary as Record<string, unknown> | undefined;
  if (primary?.id !== V58_PRIMARY_EDGE_ID || primary.parameterChange !== "NO") throw new Error("V5.8 Primary is not frozen");
}

function analyzeNestedGates(trades: V58RegimeTrade[], folds: PurgedWalkForwardFold[]): NestedGateAnalysis {
  const validationTrades = trades.filter((trade) => folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)));
  const gateResults: GateResult[] = V58_REGIME_GATE_REGISTRY.map((gate) => {
    const fixedOosTrades = applyRegimeGate(validationTrades, gate);
    const outerFolds = folds.map((fold) => foldSummary(fixedOosTrades.filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)), fold.id, null));
    return { gate, fixedOosTrades, fixedOos: summarizeRegimeTrades(fixedOosTrades), outerFolds, selectionCount: 0, selectionAdjustedLcb95: null };
  });
  const nestedTrades: V58RegimeTrade[] = [];
  const nestedFoldMetrics: FoldSummary[] = [];
  for (const fold of folds) {
    const selection = selectGateForTraining(trades, fold.trainStart, fold.trainEnd);
    if (selection) {
      const row = gateResults.find((candidate) => candidate.gate.id === selection.gate.id);
      if (row) row.selectionCount += 1;
    }
    const foldTrades = selection
      ? applyRegimeGate(trades.filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)), selection.gate)
      : [];
    nestedTrades.push(...foldTrades);
    nestedFoldMetrics.push(foldSummary(foldTrades, fold.id, selection?.gate.id ?? null));
  }
  const finalSelection = folds.length > 0
    ? selectGateForTraining(trades, folds.at(-1)!.trainStart, folds.at(-1)!.trainEnd)
    : selectGateForTraining(trades, V58_DEV_START, Number.POSITIVE_INFINITY);
  const series = gateResults.map((row) => ({ candidateId: row.gate.id, values: row.fixedOosTrades.map((trade) => trade.rMultiple) }));
  for (const row of gateResults) {
    row.selectionAdjustedLcb95 = selectionAdjustedLowerConfidenceBound(series, row.gate.id, 2_000, 5);
  }
  const selectionAdjustedLcb95 = finalSelection ? selectionAdjustedLowerConfidenceBound(series, finalSelection.gate.id, 2_000, 5) : null;
  const nestedMetrics = summarizeRegimeTrades(nestedTrades);
  const plus10Bps = summarizeRegimeTrades(applyAdditionalSlippage(nestedTrades, 10));
  const foldLcb95 = blockBootstrapLowerConfidenceBound(nestedFoldMetrics.map((fold) => fold.avgR), 1_000, 2);
  const confidenceCandidates = [
    calculateMetrics(nestedTrades).lowerConfidenceBound95,
    selectionAdjustedLcb95,
    foldLcb95,
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const promotionLcb95 = confidenceCandidates.length > 0 ? Math.min(...confidenceCandidates) : null;
  const positiveFoldRatio = nestedFoldMetrics.length > 0 ? nestedFoldMetrics.filter((fold) => fold.positive).length / nestedFoldMetrics.length : null;
  const medianFold = medianFoldSummary(nestedFoldMetrics);
  const worstFold = nestedFoldMetrics.length > 0 ? [...nestedFoldMetrics].sort((left, right) => left.avgR - right.avgR || left.fold.localeCompare(right.fold))[0] : null;
  const gateChecks: Record<string, boolean> = {
    nestedTrades: nestedMetrics.trades >= 50,
    netR: nestedMetrics.netR > 0,
    avgR: nestedMetrics.avgR > 0,
    profitFactor: nestedMetrics.profitFactor >= 1.3,
    positiveFoldRatio: positiveFoldRatio !== null && positiveFoldRatio >= 0.67,
    medianFoldNetR: medianFold !== null && medianFold.netR > 0,
    plus10BpsNetR: plus10Bps.netR > 0,
    selectionAdjustedLcb95: selectionAdjustedLcb95 !== null && selectionAdjustedLcb95 >= 0,
    promotionLcb95: promotionLcb95 !== null && promotionLcb95 >= 0,
  };
  const hasData = trades.length > 0 && folds.length > 0;
  return {
    folds,
    gateResults,
    selectedGate: finalSelection?.gate ?? null,
    selectedGateTraining: { start: finalSelection?.start ?? (folds.at(-1)?.trainStart ?? V58_DEV_START), end: finalSelection?.end ?? (folds.at(-1)?.trainEnd ?? V58_DEV_START), trades: finalSelection?.trades ?? 0, score: finalSelection?.score ?? null },
    nestedTrades,
    nestedMetrics,
    nestedFoldMetrics,
    positiveFoldRatio,
    medianFold,
    worstFold,
    plus10Bps,
    foldLcb95,
    selectionAdjustedLcb95,
    promotionLcb95,
    gateChecks,
    promotion: !hasData ? "DATA_UNAVAILABLE" : Object.values(gateChecks).every(Boolean) ? "PASS" : "FAIL",
  };
}

function selectGateForTraining(trades: V58RegimeTrade[], start: number, end: number): { gate: V58RegimeGateDefinition; score: number; trades: number; start: number; end: number } | null {
  const training = trades.filter((trade) => trade.entryTime >= start && trade.entryTime <= end);
  const candidates = V58_REGIME_GATE_REGISTRY.map((gate) => {
    const gateTrades = applyRegimeGate(training, gate);
    const metrics = calculateMetrics(gateTrades);
    if (metrics.trades < 10) return null;
    const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 3) : 3;
    const score = metrics.avgNetR * 100 + pf * 5 - Math.min(metrics.maxDrawdownR, 100) * 0.05 + (metrics.positiveMonthRatio ?? 0) * 5;
    return { gate, score, trades: metrics.trades, start, end };
  }).filter((candidate): candidate is { gate: V58RegimeGateDefinition; score: number; trades: number; start: number; end: number } => candidate !== null);
  candidates.sort((left, right) => right.score - left.score || right.trades - left.trades || left.gate.id.localeCompare(right.gate.id));
  return candidates[0] ?? null;
}

function foldSummary(trades: V58RegimeTrade[], fold: string, selectedGate: string | null): FoldSummary {
  const metrics = calculateMetrics(trades);
  return { fold, trades: metrics.trades, netR: metrics.netR, avgR: metrics.avgNetR, profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null, positive: metrics.netR > 0, selectedGate };
}

function medianFoldSummary(folds: FoldSummary[]): FoldSummary | null {
  if (folds.length === 0) return null;
  const sorted = [...folds].sort((left, right) => left.avgR - right.avgR || left.fold.localeCompare(right.fold));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function buildAttribution(development: V58RegimeTrade[], burnedExternal: V58RegimeTrade[], folds: PurgedWalkForwardFold[]): Record<string, unknown> {
  const slices: Array<Record<string, unknown>> = [];
  const stablePositiveSlices: Array<Record<string, unknown>> = [];
  const unstableSlices: Array<Record<string, unknown>> = [];
  for (const dimension of REGIME_DIMENSIONS) {
    const buckets = [...new Set([...development, ...burnedExternal].map((trade) => trade.labels[dimension]))].sort();
    for (const bucket of buckets) {
      const developmentTrades = development.filter((trade) => trade.labels[dimension] === bucket);
      const burnedTrades = burnedExternal.filter((trade) => trade.labels[dimension] === bucket);
      const developmentMetrics = summarizeRegimeTrades(developmentTrades);
      const burnedMetrics = summarizeRegimeTrades(burnedTrades);
      const support = { development: foldSupport(developmentTrades, folds), burnedExternal: foldSupport(burnedTrades, folds) };
      const stable = isPositiveSlice(developmentMetrics) && isPositiveSlice(burnedMetrics);
      const unstable = developmentMetrics.trades >= 3 && developmentMetrics.netR > 0 && burnedMetrics.trades >= 3 && burnedMetrics.netR < 0;
      const slice = {
        dimension,
        bucket,
        economicLogic: DIMENSION_LOGIC[dimension],
        development: serializeRegimeMetrics(developmentMetrics),
        burnedExternal: serializeRegimeMetrics(burnedMetrics),
        foldSupport: support,
        classification: stable ? "STABLE_POSITIVE" : unstable ? "UNSTABLE_DEVELOPMENT_POSITIVE_EXTERNAL_NEGATIVE" : "OBSERVATIONAL",
      };
      slices.push(slice);
      if (stable) stablePositiveSlices.push(slice);
      if (unstable) unstableSlices.push(slice);
    }
  }
  return {
    schema: "bca-v5-8-regime-attribution-v1",
    generatedAt: new Date().toISOString(),
    primary: { id: V58_PRIMARY_EDGE_ID, frozen: true, noParameterChange: true },
    dimensions: REGIME_DIMENSIONS,
    methodology: [
      "Every slice uses the frozen Primary and next-bar-open execution path; no signal or trade plan is regenerated by a gate.",
      "Features use the closed signal candle and already-closed higher-timeframe candles only.",
      "Development and BURNED_EXTERNAL are shown side-by-side; the 2021-01-01 through 2023-07-31 pool is not fresh validation.",
      "A stable slice requires at least three trades and positive NetR, AvgR, and PF > 1 in both pools; an unstable slice is development-positive and burned-external-negative with at least three trades in each.",
      "Fold support is descriptive and does not alter the finite registry or the frozen Primary.",
    ],
    stablePositiveSlices,
    unstableDevelopmentPositiveExternalNegative: unstableSlices,
    slices,
  };
}

function foldSupport(trades: V58RegimeTrade[], folds: PurgedWalkForwardFold[]): Record<string, unknown> {
  const matched = folds.map((fold) => ({ fold: fold.id, trades: trades.filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)) })).filter((item) => item.trades.length > 0);
  return { foldsWithTrades: matched.length, positiveFolds: matched.filter((item) => calculateMetrics(item.trades).netR > 0).length, foldIds: matched.map((item) => item.fold) };
}

function isPositiveSlice(metrics: V58MetricSummary): boolean {
  return metrics.trades >= 3 && metrics.netR > 0 && metrics.avgR > 0 && metrics.profitFactor > 1;
}

function serializeGateResults(nested: NestedGateAnalysis): Record<string, unknown> {
  return {
    schema: "bca-v5-8-regime-gate-results-v1",
    selectedGateForFresh: nested.selectedGate?.id ?? null,
    selectedGateTraining: { ...nested.selectedGateTraining, start: new Date(nested.selectedGateTraining.start).toISOString(), end: new Date(nested.selectedGateTraining.end).toISOString() },
    nestedSelection: {
      method: "Each outer fold selects from training data only; validation is evaluated with that fold's selected fixed gate.",
      trades: nested.nestedMetrics.trades,
      metrics: serializeRegimeMetrics(nested.nestedMetrics),
      outerFolds: nested.nestedFoldMetrics.map(serializeFold),
      positiveFoldRatio: roundMetric(nested.positiveFoldRatio),
      medianFold: nested.medianFold ? serializeFold(nested.medianFold) : null,
      worstFold: nested.worstFold ? serializeFold(nested.worstFold) : null,
      plus10Bps: serializeRegimeMetrics(nested.plus10Bps),
      foldLcb95: roundMetric(nested.foldLcb95),
      selectionAdjustedLcb95: roundMetric(nested.selectionAdjustedLcb95),
      promotionLcb95: roundMetric(nested.promotionLcb95),
      gateChecks: nested.gateChecks,
      promotion: nested.promotion,
    },
    candidates: nested.gateResults.map((row) => ({
      id: row.gate.id,
      hypothesis: row.gate.hypothesis,
      economicLogic: row.gate.economicLogic,
      conditions: row.gate.conditions,
      selectionCount: row.selectionCount,
      fixedNestedOos: serializeRegimeMetrics(row.fixedOos),
      selectionAdjustedLcb95: roundMetric(row.selectionAdjustedLcb95),
      outerFolds: row.outerFolds.map(serializeFold),
    })),
  };
}

function buildValidationSummary(input: {
  v58Manifest: Record<string, unknown>;
  registryReport: Record<string, unknown>;
  freshManifest: Record<string, unknown>;
  freshInventory: FreshInventory | null;
  burnedReady: boolean;
  localReady: boolean;
  localTrades: V58RegimeTrade[];
  burnedTrades: V58RegimeTrade[];
  developmentTrades: V58RegimeTrade[];
  nested: NestedGateAnalysis;
  freshReady: boolean;
  freshTrades: V58RegimeTrade[];
  freshGate: { status: "PASS" | "FAIL" | "INCONCLUSIVE" | "DATA_UNAVAILABLE"; raw: V58MetricSummary | null; gated: V58MetricSummary | null; gate: Record<string, boolean> | null; selectedGate: string | null };
}): Record<string, unknown> {
  const primaryDevelopment = summarizeRegimeTrades(input.localTrades);
  const primaryBurnedExternal = summarizeRegimeTrades(input.burnedTrades);
  const primaryCombined = summarizeRegimeTrades(input.developmentTrades);
  const primaryYield = calculateYieldMetrics(input.developmentTrades, V58_DEV_START, V58_LOCAL_DEVELOPMENT_END);
  const gatedYield = calculateYieldMetrics(input.nested.nestedTrades, V58_DEV_START, V58_LOCAL_DEVELOPMENT_END);
  const freshStatus = input.freshReady ? input.freshGate.status : "DATA_UNAVAILABLE";
  return {
    schema: "bca-v5-8-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    status: input.localReady || input.burnedReady ? "VALIDATION_COMPLETE" : "DATA_UNAVAILABLE",
    researchOnly: true,
    manifestId: input.v58Manifest.manifestId,
    manifestHash: input.v58Manifest.manifestHash,
    baseline: "cc5d31e4e9984edafb7b077ef334e07a3f7391d4",
    priorV57: { branch: "feat/v5-7-second-edge-data-completion", head: "cc5d31e4e9984edafb7b077ef334e07a3f7391d4", reportsUnchanged: true, burnedExternalDiagnostic: true },
    primaryUngated: {
      id: V58_PRIMARY_EDGE_ID,
      family: "FAILED_BREAKOUT_REVERSAL",
      frozen: true,
      parameterChange: "NO",
      development: serializeRegimeMetrics(primaryDevelopment),
      burnedExternal: input.burnedReady ? serializeRegimeMetrics(primaryBurnedExternal) : "DATA_UNAVAILABLE",
      combinedDevelopment: serializeRegimeMetrics(primaryCombined),
      yield: serializeYield(primaryYield),
    },
    regimeDiagnosis: {
      attributionReport: "reports/v5-8-regime-attribution.json",
      dimensions: REGIME_DIMENSIONS,
      stablePositiveSliceCount: "SEE_ATTRIBUTION_REPORT",
      unstableSliceCount: "SEE_ATTRIBUTION_REPORT",
      registrySelectionPolicy: "Diagnosis is descriptive; only the pre-registered finite eight-gate registry may be evaluated.",
    },
    regimeGateRegistry: {
      report: "reports/v5-8-regime-gate-registry.json",
      count: V58_REGIME_GATE_REGISTRY.length,
      maxCandidates: V58_MAX_REGIME_GATES,
      hash: input.registryReport.registryHash,
      noCartesianSearch: true,
    },
    bestRegimeGatedPrimary: {
      gate: input.nested.selectedGate?.id ?? null,
      selection: input.nested.selectedGate ? "Final gate selected from development training window only; nested OOS uses per-fold inner selections." : "DATA_UNAVAILABLE",
      selectedTraining: { ...input.nested.selectedGateTraining, start: new Date(input.nested.selectedGateTraining.start).toISOString(), end: new Date(input.nested.selectedGateTraining.end).toISOString() },
      nestedOos: serializeRegimeMetrics(input.nested.nestedMetrics),
      outerFolds: input.nested.nestedFoldMetrics.map(serializeFold),
      positiveFoldRatio: roundMetric(input.nested.positiveFoldRatio),
      medianFold: input.nested.medianFold ? serializeFold(input.nested.medianFold) : null,
      worstFold: input.nested.worstFold ? serializeFold(input.nested.worstFold) : null,
      plus10Bps: serializeRegimeMetrics(input.nested.plus10Bps),
      foldLcb95: roundMetric(input.nested.foldLcb95),
      selectionAdjustedLcb95: roundMetric(input.nested.selectionAdjustedLcb95),
      promotionLcb95: roundMetric(input.nested.promotionLcb95),
      gateChecks: input.nested.gateChecks,
      promotion: input.nested.promotion,
      yield: serializeYield(gatedYield),
    },
    yieldGate: {
      thresholds: { alertsPerMonth: ">= 2", activeMonthRatio: ">= 0.65", medianAlertsPerMonth: ">= 1", p95DroughtDays: "<= 45", maxDroughtDays: "<= 60" },
      primary: serializeYield(primaryYield),
      nestedGatedPrimary: serializeYield(gatedYield),
      primaryPassed: passesYieldGate(primaryYield),
      nestedGatedPrimaryPassed: passesYieldGate(gatedYield),
    },
    freshValidation: {
      status: freshStatus,
      manifestId: input.freshManifest.manifestId,
      manifestHash: input.freshManifest.manifestHash,
      source: "BINANCE_USDT_M_FUTURES_DATA_VISION",
      exchange: "Binance USDT-M Futures",
      period: input.freshManifest.period,
      symbols: input.freshManifest.symbols,
      inventoryStatus: input.freshInventory?.status ?? "DATA_UNAVAILABLE",
      coveragePercent: input.freshInventory?.availableSymbols ? roundMetric(input.freshInventory.availableSymbols.length / V58_FRESH_SYMBOLS.length * 100) : 0,
      validationRun: input.freshReady,
      selectedGate: input.freshGate.selectedGate,
      rawPrimary: input.freshGate.raw ? serializeRegimeMetrics(input.freshGate.raw) : null,
      gatedPrimary: input.freshGate.gated ? serializeRegimeMetrics(input.freshGate.gated) : null,
      gate: input.freshGate.gate,
      unavailableReason: input.freshReady ? null : "No complete local immutable fresh cache is available; fresh profitability is DATA_UNAVAILABLE rather than zero-row evidence.",
    },
    exactOldProduction: { status: "DATA_UNAVAILABLE", metrics: null, reason: "No independent exact Production configuration export is available; no replay or promotion claim is made." },
    businessVerdict: "INCONCLUSIVE",
    emailPromotion: "FAIL",
    boundaries: {
      productionChanged: false,
      v55Changed: false,
      productionEmailChanged: false,
      environmentChanged: false,
      migrationApplied: false,
      deployment: false,
      merge: false,
      autoTrading: false,
      primaryTuned: false,
      strategyChanged: false,
    },
  };
}

function renderPromotionDecision(report: Record<string, unknown>): string {
  const primary = report.primaryUngated as Record<string, unknown>;
  const gated = report.bestRegimeGatedPrimary as Record<string, unknown>;
  const fresh = report.freshValidation as Record<string, unknown>;
  return [
    "# V5.8 Regime Dependency Reconstruction — Promotion Decision",
    "",
    `Manifest: **${String(report.manifestId)}**; all manifests and the eight-gate registry were frozen before fresh return data was read.`,
    `Primary: **${String(primary.id)}** / FAILED_BREAKOUT_REVERSAL; parameter change: NO.`,
    `Development ungated: ${JSON.stringify(primary.development)}.`,
    `BURNED_EXTERNAL diagnostic (not fresh validation): ${JSON.stringify(primary.burnedExternal)}.`,
    "",
    "## Regime-gated Primary",
    `- Selected gate for fresh validation: **${String(gated.gate ?? "DATA_UNAVAILABLE")}**.`,
    `- Nested OOS: ${JSON.stringify(gated.nestedOos)}; folds: ${JSON.stringify(gated.outerFolds)}.`,
    `- Promotion checks: ${JSON.stringify(gated.gateChecks)}; status: **${String(gated.promotion)}**.`,
    "",
    "## Fresh validation",
    `- Status: **${String(fresh.status)}**; source: Binance USDT-M Futures Data Vision; period: ${JSON.stringify(fresh.period)}.`,
    `- Metrics: ${JSON.stringify(fresh.gatedPrimary)}.`,
    "",
    "## Decision",
    `- Business verdict: **${String(report.businessVerdict)}**; Email Promotion: **${String(report.emailPromotion)}**.`,
    "- Exact current Production replay: DATA_UNAVAILABLE; no replacement or email eligibility is authorized.",
    "",
    "## Hard boundary",
    "- Production change: NO",
    "- V5.5 #002 change: NO",
    "- Strategy tuning/manifest change: NO",
    "- Supabase migration: NO",
    "- Deploy: NO",
    "- Merge: NO",
    "- Auto trading: NO",
    "",
  ].join("\n");
}

function serializeRegimeMetrics(metrics: V58MetricSummary | null): Record<string, unknown> | null {
  if (!metrics) return null;
  return {
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    netR: roundMetric(metrics.netR),
    avgR: roundMetric(metrics.avgR),
    profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null,
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    cvar95: roundMetric(metrics.cvar95),
    stopRate: roundMetric(metrics.stopRate),
    positivePeriods: metrics.positivePeriods,
    periods: metrics.periods,
    positivePeriodRatio: roundMetric(metrics.positivePeriodRatio),
    totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt),
    totalFeesUsdt: roundMetric(metrics.totalFeesUsdt),
    totalFundingUsdt: roundMetric(metrics.totalFundingUsdt),
    totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt),
  };
}

function serializeFold(fold: FoldSummary): Record<string, unknown> {
  return { fold: fold.fold, trades: fold.trades, netR: roundMetric(fold.netR), avgR: roundMetric(fold.avgR), profitFactor: roundMetric(fold.profitFactor), positive: fold.positive, selectedGate: fold.selectedGate };
}

function serializeYield(value: ReturnType<typeof calculateYieldMetrics>): Record<string, unknown> {
  return {
    calendarDays: roundMetric(value.calendarDays),
    calendarMonths: value.calendarMonths,
    alertsPerDay: roundMetric(value.alertsPerDay),
    alertsPerWeek: roundMetric(value.alertsPerWeek),
    alertsPerMonth: roundMetric(value.alertsPerMonth),
    activeMonthRatio: roundMetric(value.activeMonthRatio),
    medianAlertsPerMonth: roundMetric(value.medianAlertsPerMonth),
    p90SignalDroughtDays: roundMetric(value.p90SignalDroughtDays),
    p95SignalDroughtDays: roundMetric(value.p95SignalDroughtDays),
    maxSignalDroughtDays: roundMetric(value.maxSignalDroughtDays),
    symbolBreadth: value.symbolBreadth,
    regimeBreadth: value.regimeBreadth,
    positiveMonthRatio: roundMetric(value.positiveMonthRatio),
  };
}

function passesYieldGate(value: ReturnType<typeof calculateYieldMetrics>): boolean {
  return value.alertsPerMonth >= 2
    && (value.activeMonthRatio ?? 0) >= 0.65
    && (value.medianAlertsPerMonth ?? 0) >= 1
    && (value.p95SignalDroughtDays ?? Number.POSITIVE_INFINITY) <= 45
    && (value.maxSignalDroughtDays ?? Number.POSITIVE_INFINITY) <= 60;
}

async function loadLocalDevelopmentDatasets(): Promise<HistoricalDataset[]> {
  let files: string[];
  try {
    files = (await readdir(LOCAL_CACHE_DIR)).filter((file) => LOCAL_CACHE_FILE_PATTERN.test(file));
  } catch {
    return [];
  }
  const datasets: HistoricalDataset[] = [];
  for (const file of files.sort()) {
    try {
      const dataset = JSON.parse(await readFile(resolve(LOCAL_CACHE_DIR, file), "utf8")) as HistoricalDataset;
      if ((dataset.candles?.["15m"]?.length ?? 0) > 0 && (dataset.candles?.["1h"]?.length ?? 0) > 0 && (dataset.candles?.["4h"]?.length ?? 0) > 0) datasets.push(dataset);
    } catch {
      // A corrupt local cache is excluded; this validator never fabricates or repairs evidence.
    }
  }
  return datasets;
}

async function v57ExternalCacheIsReady(inventory: V57Inventory | null): Promise<boolean> {
  if (!inventory || inventory.status !== "AVAILABLE" || inventory.availableSymbols.length / Math.max(1, inventory.pitEligibleSymbols.length) < 0.9) return false;
  for (const symbol of inventory.symbols.filter((item) => item.pitEligible && item.classification === "AVAILABLE")) {
    for (const record of symbol.records) {
      if (!record.cachePath || !record.sha256 || !record.rowCount || record.rowCount <= 0 || (record.status !== "AVAILABLE" && record.status !== "CACHED")) return false;
      try {
        if (sha256Buffer(await readFile(resolve(record.cachePath))) !== record.sha256) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

async function freshCacheIsReady(inventory: FreshInventory | null, manifest: Record<string, unknown>): Promise<boolean> {
  if (!inventory || inventory.status !== "AVAILABLE" || inventory.manifestId !== V58_FRESH_MANIFEST_ID || inventory.manifestHash !== manifest.manifestHash || inventory.availableSymbols.length !== V58_FRESH_SYMBOLS.length) return false;
  for (const symbol of inventory.symbolRecords.filter((item) => item.classification === "AVAILABLE")) {
    const expectedPeriods = new Set(symbol.records.map((record) => record.period));
    if (symbol.records.length !== expectedPeriods.size * EXTERNAL_TIMEFRAMES.length) return false;
    for (const record of symbol.records) {
      if (!record.cachePath || !record.sha256 || !record.rowCount || record.rowCount <= 0 || (record.status !== "AVAILABLE" && record.status !== "CACHED")) return false;
      try {
        if (sha256Buffer(await readFile(resolve(record.cachePath))) !== record.sha256) return false;
      } catch {
        return false;
      }
    }
  }
  return inventory.symbolRecords.filter((item) => item.classification === "AVAILABLE").length === V58_FRESH_SYMBOLS.length;
}

async function loadV57ExternalDatasets(inventory: V57Inventory): Promise<HistoricalDataset[]> {
  const result: HistoricalDataset[] = [];
  for (const symbol of inventory.symbols.filter((item) => item.pitEligible && item.classification === "AVAILABLE")) {
    const candles: { "15m": Candle[]; "1h": Candle[]; "4h": Candle[] } = { "15m": [], "1h": [], "4h": [] };
    const fundingRates: FundingRatePoint[] = [];
    for (const record of symbol.records) {
      if (!record.cachePath) continue;
      const parsed = await readMonthlyArchive(resolve(record.cachePath), record.timeframe);
      if (record.timeframe === "funding") fundingRates.push(...(parsed.fundingRates ?? []));
      else candles[record.timeframe].push(...(parsed.candles ?? []));
    }
    for (const timeframe of ["15m", "1h", "4h"] as const) candles[timeframe] = dedupeCandles(candles[timeframe]).filter((candle) => candle.closeTime >= V58_BURNED_EXTERNAL_START && candle.openTime <= V58_BURNED_EXTERNAL_END);
    const filteredFunding = dedupeFunding(fundingRates).filter((point) => point.fundingTime >= V58_BURNED_EXTERNAL_START && point.fundingTime <= V58_BURNED_EXTERNAL_END);
    if (candles["15m"].length > 0 && candles["1h"].length > 0 && candles["4h"].length > 0) result.push({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: filteredFunding });
  }
  return result;
}

async function loadFreshDatasets(inventory: FreshInventory): Promise<HistoricalDataset[]> {
  const result: HistoricalDataset[] = [];
  for (const symbol of inventory.symbolRecords.filter((item) => item.classification === "AVAILABLE")) {
    const candles: { "15m": Candle[]; "1h": Candle[]; "4h": Candle[] } = { "15m": [], "1h": [], "4h": [] };
    const fundingRates: FundingRatePoint[] = [];
    for (const record of symbol.records) {
      if (!record.cachePath) continue;
      const parsed = await readMonthlyArchive(resolve(record.cachePath), record.timeframe);
      if (record.timeframe === "funding") fundingRates.push(...(parsed.fundingRates ?? []));
      else candles[record.timeframe].push(...(parsed.candles ?? []));
    }
    for (const timeframe of ["15m", "1h", "4h"] as const) candles[timeframe] = dedupeCandles(candles[timeframe]).filter((candle) => candle.closeTime >= V58_FRESH_START && candle.openTime <= V58_FRESH_END);
    const filteredFunding = dedupeFunding(fundingRates).filter((point) => point.fundingTime >= V58_FRESH_START && point.fundingTime <= V58_FRESH_END);
    if (candles["15m"].length > 0 && candles["1h"].length > 0 && candles["4h"].length > 0) result.push({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: filteredFunding });
  }
  return result;
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

function makeInstrument(symbol: string): Instrument {
  return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "HISTORICAL_DATA_VISION", priceTick: 0, quantityStep: 0 };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

void main();
