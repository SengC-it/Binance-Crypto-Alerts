import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, FundingRatePoint, Instrument, MarketRegime } from "@/lib/core/types";
import { closes, ema } from "@/lib/core/indicators";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";
import { selectionAdjustedLowerConfidenceBound } from "@/lib/v5-3/structural";
import {
  applyAdditionalSlippage,
  blockBootstrapLowerConfidenceBound,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import {
  calculateCvar95,
  calculateYieldMetrics,
  runIndependentCandidate,
  V561_CANDIDATE_REGISTRY,
  type V561Trade,
} from "@/lib/v5-6-1/research";
import {
  canonicalEmailSignalKey,
  dedupeV57Trades,
  evaluateSecondEdgeGate,
  runV57SecondCandidate,
  V57_BASE_SLIPPAGE_BPS,
  V57_COOLDOWN_HOURS,
  V57_EXTERNAL_END,
  V57_EXTERNAL_MANIFEST_ID,
  V57_EXTERNAL_START,
  V57_FEE_RATE,
  V57_PRIMARY_EDGE_ID,
  V57_RISK_PER_TRADE_USDT,
  V57_SECOND_EDGE_REGISTRY,
  type V57Trade,
} from "@/lib/v5-7/research";
import { hashWithoutField, sha256Json } from "@/lib/v5-7/manifest";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const EXTERNAL_INVENTORY_FILE = resolve(REPORT_DIR, "v5-7-external-data-inventory.json");
const RESEARCH_MANIFEST_FILE = resolve(REPORT_DIR, "v5-7-research-manifest.json");
const LOCAL_DEVELOPMENT_START = Date.parse("2023-08-10T02:15:00.000Z");
const LOCAL_DEVELOPMENT_END = Date.parse("2026-08-09T02:14:59.999Z");
const CACHE_FILE_PATTERN = /-1691633700000-1786241699999\.json$/;

interface ExternalArchiveRecord {
  symbol: string;
  timeframe: V57ExternalTimeframe;
  period: string;
  sourceUrl: string;
  cachePath: string | null;
  status: string;
  classification: string;
  sizeBytes: number | null;
  sha256: string | null;
  rowCount: number | null;
  error?: string;
}

interface ExternalSymbolRecord {
  symbol: string;
  pitEligible: boolean;
  classification: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  expectedPeriods: string[];
  availableArchiveCount: number;
  expectedArchiveCount: number;
  records: ExternalArchiveRecord[];
}

interface ExternalInventory {
  schema: string;
  status: "AVAILABLE" | "DATA_INCOMPLETE";
  manifestId: string;
  period: { start: string; end: string };
  requestedSymbols: number;
  pitEligibleSymbols: string[];
  availableSymbols: string[];
  coveragePercent: number;
  symbols: ExternalSymbolRecord[];
  archives: ExternalArchiveRecord[];
}

interface FrozenManifest {
  schema: string;
  status: string;
  manifestId: string;
  manifestHash: string;
  researchBaseline: string;
  productionBaseline: string;
  primaryEdge: { id: string; family: string; frozenNestedOos: Record<string, number> };
  externalDataset: { manifestId: string; manifestSha256: string; period: { start: string; end: string }; timeframes: string[] };
  secondEdgeRegistry: { maxCandidates: number; count: number; hash: string; families: string[] };
  productionBoundary: Record<string, boolean>;
}

interface RunOutput {
  datasets: HistoricalDataset[];
  primaryTrades: V561Trade[];
  candidateTrades: Map<string, V57Trade[]>;
  start: number;
  end: number;
  folds: PurgedWalkForwardFold[];
  dataStatus: "AVAILABLE" | "DATA_UNAVAILABLE";
}

interface FoldSummary {
  fold: string;
  trades: number;
  netR: number;
  avgR: number;
  profitFactor: number | null;
  positive: boolean;
}

interface EdgeSummary {
  candidateId: string;
  family: string;
  metrics: ValidationMetrics;
  nestedOosTrades: V57Trade[];
  developmentMetrics: ValidationMetrics;
  foldMetrics: FoldSummary[];
  foldPositiveRatio: number | null;
  worstFold: FoldSummary | null;
  medianFold: FoldSummary | null;
  selectionAdjustedLcb95: number | null;
  promotionLcb95: number | null;
  plus10Bps: ValidationMetrics;
  yield: ReturnType<typeof calculateYieldMetrics>;
  primaryOverlapTrades: number;
  primarySilentTrades: number;
  overlapPercent: number | null;
  incrementalTrades: V57Trade[];
  incrementalMetrics: ValidationMetrics;
  externalMetrics: ValidationMetrics | null;
  gate: ReturnType<typeof evaluateSecondEdgeGate>;
}

async function main(): Promise<void> {
  const manifest = await readFrozenManifest();
  const inventory = await readExternalInventory();
  const localDatasets = await loadLocalDevelopmentDatasets();
  const primaryDefinition = V561_CANDIDATE_REGISTRY.find((candidate) => candidate.id === V57_PRIMARY_EDGE_ID);
  if (!primaryDefinition) throw new Error(`Missing frozen Primary ${V57_PRIMARY_EDGE_ID}`);
  assertFrozenManifest(manifest);

  const development = localDatasets.length > 0
    ? await runDatasetSet(localDatasets, LOCAL_DEVELOPMENT_START, LOCAL_DEVELOPMENT_END, "development", primaryDefinition)
    : emptyRun(LOCAL_DEVELOPMENT_START, LOCAL_DEVELOPMENT_END);
  const externalReady = inventory !== null && await externalCacheIsReady(inventory);
  const external = externalReady && inventory
    ? await runDatasetSet(await loadExternalDatasets(inventory), V57_EXTERNAL_START, V57_EXTERNAL_END, "external", primaryDefinition)
    : emptyRun(V57_EXTERNAL_START, V57_EXTERNAL_END);
  const externalValidationRun = externalReady
    && inventory?.status === "AVAILABLE"
    && (inventory.availableSymbols.length / Math.max(1, inventory.pitEligibleSymbols.length)) >= 0.9
    && external.datasets.length > 0;

  const primaryDevelopment = summarizePrimary(development.primaryTrades, development.folds, development.start, development.end);
  const primaryExternal = externalValidationRun
    ? summarizePrimary(external.primaryTrades, external.folds, external.start, external.end)
    : null;
  const candidateRows = buildCandidateRows(development, externalValidationRun ? external : null);
  const selected = selectSecondCandidate(candidateRows);
  const primaryNested = filterToFolds(development.primaryTrades, development.folds);
  const selectedNested = selected?.nestedOosTrades ?? [];
  const selectedExternal = selected && externalValidationRun
    ? summarizeExternalCandidate(selected.candidateId, external.candidateTrades.get(selected.candidateId) ?? [], external.folds)
    : null;
  const secondGate = selected?.gate ?? null;
  const ensemble = buildEnsembleReport(primaryNested, selectedNested, development.start, development.end, primaryExternal, selectedExternal, externalValidationRun, development.folds, Boolean(secondGate?.passed));
  const businessVerdict = "INCONCLUSIVE" as const;
  const emailPromotion = "FAIL" as const;
  const report = buildValidationSummary({
    manifest,
    inventory,
    externalValidationRun,
    primaryDevelopment,
    primaryExternal,
    candidateRows,
    selected,
    secondGate,
    ensemble,
    businessVerdict,
    emailPromotion,
  });
  await writeFile(resolve(REPORT_DIR, "v5-7-validation-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-7-promotion-decision.md"), renderPromotionDecision(report), "utf8");
  console.info(JSON.stringify({
    stage: "v5_7_validation_complete",
    manifestId: manifest.manifestId,
    externalValidationRun,
    externalCoverage: inventory?.coveragePercent ?? 0,
    developmentDatasets: localDatasets.length,
    primaryNestedTrades: primaryDevelopment.nested.trades,
    selectedSecond: selected?.candidateId ?? null,
    secondEdge: secondGate?.passed ? "PASS" : "NO_VALID_SECOND_EDGE",
    ensemble: ensemble.status,
    businessVerdict,
  }));
}

async function readFrozenManifest(): Promise<FrozenManifest> {
  const value = JSON.parse(await readFile(RESEARCH_MANIFEST_FILE, "utf8")) as FrozenManifest;
  return value;
}

async function readExternalInventory(): Promise<ExternalInventory | null> {
  try {
    return JSON.parse(await readFile(EXTERNAL_INVENTORY_FILE, "utf8")) as ExternalInventory;
  } catch {
    return null;
  }
}

function assertFrozenManifest(manifest: FrozenManifest): void {
  if (manifest.status !== "FROZEN_BEFORE_DATA_READ") throw new Error("V5.7 research manifest is not frozen before data read");
  if (hashWithoutField(manifest as unknown as Record<string, unknown>, "manifestHash") !== manifest.manifestHash) throw new Error("V5.7 research manifest integrity check failed");
  if (manifest.manifestId !== "v57-second-edge-2021-01-01-2023-07-31") throw new Error("Unexpected V5.7 manifest identity");
  if (manifest.externalDataset.manifestId !== V57_EXTERNAL_MANIFEST_ID) throw new Error("Unexpected frozen external manifest identity");
  if (manifest.externalDataset.period.start !== new Date(V57_EXTERNAL_START).toISOString() || manifest.externalDataset.period.end !== new Date(V57_EXTERNAL_END).toISOString()) throw new Error("Frozen external period changed");
  if (manifest.secondEdgeRegistry.count !== V57_SECOND_EDGE_REGISTRY.length || manifest.secondEdgeRegistry.count > manifest.secondEdgeRegistry.maxCandidates) throw new Error("V5.7 registry count changed");
  if (manifest.secondEdgeRegistry.hash !== sha256Json(V57_SECOND_EDGE_REGISTRY)) throw new Error("V5.7 registry integrity check failed");
  if (V57_SECOND_EDGE_REGISTRY.some((candidate) => (candidate.family as string) === "FAILED_BREAKOUT_REVERSAL")) throw new Error("V5.7 registry contains a prohibited failed-breakout family");
}

async function loadLocalDevelopmentDatasets(): Promise<HistoricalDataset[]> {
  let files: string[];
  try {
    files = (await readdir(LOCAL_CACHE_DIR)).filter((name) => CACHE_FILE_PATTERN.test(name));
  } catch {
    return [];
  }
  const datasets: HistoricalDataset[] = [];
  for (const file of files.sort()) {
    try {
      const dataset = JSON.parse(await readFile(resolve(LOCAL_CACHE_DIR, file), "utf8")) as HistoricalDataset;
      if (dataset.candles?.["15m"]?.length > 0) datasets.push(dataset);
    } catch {
      // A corrupt or partial development cache is excluded, never repaired from a different source.
    }
  }
  return datasets;
}

async function externalCacheIsReady(inventory: ExternalInventory | null): Promise<boolean> {
  if (!inventory || inventory.status !== "AVAILABLE") return false;
  if (inventory.availableSymbols.length / Math.max(1, inventory.pitEligibleSymbols.length) < 0.9) return false;
  for (const symbol of inventory.symbols.filter((item) => item.pitEligible && item.classification === "AVAILABLE")) {
    for (const record of symbol.records) {
      if ((record.status !== "AVAILABLE" && record.status !== "CACHED") || !record.cachePath || !record.sha256 || !record.rowCount || record.rowCount <= 0) return false;
      try {
        const bytes = await readFile(resolve(record.cachePath));
        if (sha256Buffer(bytes) !== record.sha256) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

async function loadExternalDatasets(inventory: ExternalInventory): Promise<HistoricalDataset[]> {
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
    for (const timeframe of ["15m", "1h", "4h"] as const) candles[timeframe] = dedupeCandles(candles[timeframe]).filter((candle) => candle.closeTime >= V57_EXTERNAL_START && candle.openTime <= V57_EXTERNAL_END);
    const filteredFunding = dedupeFunding(fundingRates).filter((point) => point.fundingTime >= V57_EXTERNAL_START && point.fundingTime <= V57_EXTERNAL_END);
    if (candles["15m"].length === 0 || candles["1h"].length === 0 || candles["4h"].length === 0) continue;
    result.push({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: filteredFunding });
  }
  return result;
}

function emptyRun(start: number, end: number): RunOutput {
  return { datasets: [], primaryTrades: [], candidateTrades: new Map(V57_SECOND_EDGE_REGISTRY.map((candidate) => [candidate.id, []])), start, end, folds: createFolds(start, end), dataStatus: "DATA_UNAVAILABLE" };
}

async function runDatasetSet(
  datasets: HistoricalDataset[],
  start: number,
  end: number,
  source: "development" | "external",
  primaryDefinition: typeof V561_CANDIDATE_REGISTRY[number],
): Promise<RunOutput> {
  const folds = createFolds(start, end);
  const primaryTrades: V561Trade[] = [];
  const candidateTrades = new Map(V57_SECOND_EDGE_REGISTRY.map((candidate) => [candidate.id, [] as V57Trade[]]));
  const breadth = buildBreadthLookup(datasets, start, end);
  const btcDataset = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const ethDataset = datasets.find((dataset) => dataset.symbol === "ETHUSDT");
  for (const dataset of datasets) {
    const frames = buildFeatureFrames(dataset, { startTime: start, endTime: end, entryStrideBars: 4, breadthAt: breadth.at, btcDataset, ethDataset });
    primaryTrades.push(...runIndependentCandidate(dataset, frames, primaryDefinition, runOptions(start, end)));
    for (const candidate of V57_SECOND_EDGE_REGISTRY) {
      candidateTrades.get(candidate.id)!.push(...runV57SecondCandidate(dataset, frames, candidate, runOptions(start, end)));
    }
  }
  return { datasets, primaryTrades, candidateTrades, start, end, folds, dataStatus: source === "external" ? "AVAILABLE" : datasets.length > 0 ? "AVAILABLE" : "DATA_UNAVAILABLE" };
}

function createFolds(start: number, end: number): PurgedWalkForwardFold[] {
  return createPurgedWalkForwardFolds({ start, end, initialTrainMonths: 12, validationMonths: 3, foldCount: 6, purgeHours: 72 });
}

function runOptions(startTime: number, endTime: number) {
  return { startTime, endTime, takerFeeRate: V57_FEE_RATE, slippageBps: V57_BASE_SLIPPAGE_BPS, riskPerTradeUsdt: V57_RISK_PER_TRADE_USDT, cooldownHours: V57_COOLDOWN_HOURS };
}

function buildCandidateRows(development: RunOutput, external: RunOutput | null): EdgeSummary[] {
  const primaryNested = filterToFolds(development.primaryTrades, development.folds);
  const series = V57_SECOND_EDGE_REGISTRY.map((candidate) => ({ candidateId: candidate.id, values: filterToFolds(development.candidateTrades.get(candidate.id) ?? [], development.folds).map((trade) => trade.rMultiple) }));
  return V57_SECOND_EDGE_REGISTRY.map((candidate) => {
    const allTrades = dedupeV57Trades(development.candidateTrades.get(candidate.id) ?? []).uniqueRows;
    const nestedOosTrades = filterToFolds(allTrades, development.folds);
    const developmentTrades = allTrades.filter((trade) => trade.entryTime >= development.start && trade.entryTime <= (development.folds[0]?.trainEnd ?? development.end));
    const metrics = calculateMetrics(nestedOosTrades);
    const developmentMetrics = calculateMetrics(developmentTrades);
    const foldMetrics = summarizeFolds(nestedOosTrades, development.folds);
    const selectionAdjusted = selectionAdjustedLowerConfidenceBound(series, candidate.id, 2_000, 5);
    const promotionLcb = promotionLowerConfidenceBound(metrics, foldMetrics, selectionAdjusted);
    const plus10Bps = calculateMetrics(applyAdditionalSlippage(nestedOosTrades, 10));
    const yieldMetrics = calculateYieldMetrics(nestedOosTrades, development.start, development.end);
    const primaryKeys = new Set(primaryNested.map(canonicalEmailSignalKey));
    const overlap = nestedOosTrades.filter((trade) => primaryKeys.has(canonicalEmailSignalKey(trade)));
    const incrementalTrades = nestedOosTrades.filter((trade) => !primaryKeys.has(canonicalEmailSignalKey(trade)));
    const gate = evaluateSecondEdgeGate({
      nestedTrades: metrics.trades,
      netR: metrics.netR,
      avgR: metrics.avgNetR,
      profitFactor: metrics.profitFactor,
      plus10BpsNetR: plus10Bps.netR,
      selectionAdjustedLcb95: selectionAdjusted,
      symbolBreadth: new Set(nestedOosTrades.map((trade) => trade.symbol)).size,
      positiveOuterFolds: foldMetrics.filter((fold) => fold.positive).length,
      outerFoldCount: foldMetrics.length,
    });
    const externalMetrics = external ? calculateMetrics(dedupeV57Trades(external.candidateTrades.get(candidate.id) ?? []).uniqueRows) : null;
    return {
      candidateId: candidate.id,
      family: candidate.family,
      metrics,
      nestedOosTrades,
      developmentMetrics,
      foldMetrics,
      foldPositiveRatio: foldMetrics.length > 0 ? foldMetrics.filter((fold) => fold.positive).length / foldMetrics.length : null,
      worstFold: foldMetrics.length > 0 ? [...foldMetrics].sort((a, b) => a.avgR - b.avgR || a.fold.localeCompare(b.fold))[0] : null,
      medianFold: medianFold(foldMetrics),
      selectionAdjustedLcb95: selectionAdjusted,
      promotionLcb95: promotionLcb,
      plus10Bps,
      yield: yieldMetrics,
      primaryOverlapTrades: overlap.length,
      primarySilentTrades: incrementalTrades.length,
      overlapPercent: nestedOosTrades.length > 0 ? overlap.length / nestedOosTrades.length : null,
      incrementalTrades,
      incrementalMetrics: calculateMetrics(incrementalTrades),
      externalMetrics,
      gate,
    };
  });
}

function selectSecondCandidate(rows: EdgeSummary[]): EdgeSummary | null {
  const eligible = rows.filter((row) => row.developmentMetrics.trades > 0);
  eligible.sort((left, right) => selectionScore(right.developmentMetrics) - selectionScore(left.developmentMetrics) || left.candidateId.localeCompare(right.candidateId));
  return eligible[0] ?? null;
}

function selectionScore(metrics: ValidationMetrics): number {
  if (metrics.trades === 0) return Number.NEGATIVE_INFINITY;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 3) : 3;
  return metrics.avgNetR * 100 + pf * 5 + (metrics.positiveMonthRatio ?? 0) * 5 - Math.min(metrics.maxDrawdownR, 100) * 0.05;
}

function summarizePrimary(trades: V561Trade[], folds: PurgedWalkForwardFold[], start: number, end: number) {
  const nestedTrades = filterToFolds(trades, folds);
  const metrics = calculateMetrics(nestedTrades);
  const foldMetrics = summarizeFolds(nestedTrades, folds);
  return {
    nested: metrics,
    nestedTrades,
    all: calculateMetrics(trades),
    foldMetrics,
    foldPositiveRatio: foldMetrics.length > 0 ? foldMetrics.filter((fold) => fold.positive).length / foldMetrics.length : null,
    worstFold: foldMetrics.length > 0 ? [...foldMetrics].sort((a, b) => a.avgR - b.avgR || a.fold.localeCompare(b.fold))[0] : null,
    medianFold: medianFold(foldMetrics),
    selectionAdjustedLcb95: null,
    promotionLcb95: promotionLowerConfidenceBound(metrics, foldMetrics, null),
    yield: calculateYieldMetrics(nestedTrades, start, end),
    plus10Bps: calculateMetrics(applyAdditionalSlippage(nestedTrades, 10)),
  };
}

function summarizeExternalCandidate(candidateId: string, trades: V57Trade[], folds: PurgedWalkForwardFold[]) {
  const unique = dedupeV57Trades(trades).uniqueRows;
  const metrics = calculateMetrics(unique);
  return { candidateId, metrics, trades: unique, folds: summarizeFolds(unique, folds) };
}

function filterToFolds<T extends Pick<ValidationTrade, "entryTime">>(trades: T[], folds: PurgedWalkForwardFold[]): T[] {
  return trades.filter((trade) => folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)));
}

function summarizeFolds(trades: ValidationTrade[], folds: PurgedWalkForwardFold[]): FoldSummary[] {
  return folds.map((fold) => {
    const metrics = calculateMetrics(trades.filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)));
    return { fold: fold.id, trades: metrics.trades, netR: metrics.netR, avgR: metrics.avgNetR, profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null, positive: metrics.netR > 0 };
  });
}

function medianFold(folds: FoldSummary[]): FoldSummary | null {
  if (folds.length === 0) return null;
  const sorted = [...folds].sort((a, b) => a.avgR - b.avgR || a.fold.localeCompare(b.fold));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function promotionLowerConfidenceBound(metrics: ValidationMetrics, folds: FoldSummary[], selectionAdjusted: number | null): number | null {
  const foldValues = folds.filter((fold) => fold.trades > 0).map((fold) => fold.avgR);
  const foldLcb = foldValues.length >= 2 ? blockBootstrapLowerConfidenceBound(foldValues, 2_000, 1) : null;
  return finiteMinimum([metrics.lowerConfidenceBound95, foldLcb, selectionAdjusted]);
}

function finiteMinimum(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return usable.length > 0 ? Math.min(...usable) : null;
}

function buildEnsembleReport(
  primaryTrades: V561Trade[],
  secondTrades: V57Trade[],
  start: number,
  end: number,
  primaryExternal: ReturnType<typeof summarizePrimary> | null,
  secondExternal: ReturnType<typeof summarizeExternalCandidate> | null,
  externalValidationRun: boolean,
  folds: PurgedWalkForwardFold[],
  secondEdgePassed: boolean,
) {
  if (!secondEdgePassed) return { status: "NO_VALID_SECOND_EDGE", components: [], trades: [], metrics: calculateMetrics([]), yield: calculateYieldMetrics([], start, end), foldMetrics: [], foldPositiveRatio: null, worstFold: null, medianFold: null, plus10Bps: calculateMetrics([]), cvar95: null, external: null, promotionLcb95: null, promotion: "FAIL" };
  const trades = mergeEnsembleTrades(primaryTrades, secondTrades);
  const metrics = calculateMetrics(trades);
  const foldMetrics = summarizeFolds(trades, folds);
  const promotionLcb95 = promotionLowerConfidenceBound(metrics, foldMetrics, null);
  const external = externalValidationRun && primaryExternal && secondExternal
    ? mergeEnsembleTrades(primaryExternal.nestedTrades, secondExternal.trades)
    : null;
  const externalMetrics = external ? calculateMetrics(external) : null;
  const plus10Bps = calculateMetrics(applyAdditionalSlippage(trades, 10));
  const yieldMetrics = calculateYieldMetrics(trades, start, end);
  const promotion = metrics.netR > 0 && metrics.avgNetR > 0 && metrics.profitFactor >= 1.3 && plus10Bps.netR > 0 && (promotionLcb95 ?? -Infinity) > 0 && externalMetrics !== null && externalMetrics.netR > 0 && externalMetrics.avgNetR > 0 ? "PASS" : "FAIL";
  return { status: "PRIMARY_PLUS_SECOND", components: [V57_PRIMARY_EDGE_ID, secondTrades[0]?.candidateId ?? "DATA_UNAVAILABLE"], trades, metrics, yield: yieldMetrics, foldMetrics, foldPositiveRatio: foldMetrics.length > 0 ? foldMetrics.filter((fold) => fold.positive).length / foldMetrics.length : null, worstFold: foldMetrics.length > 0 ? [...foldMetrics].sort((a, b) => a.avgR - b.avgR || a.fold.localeCompare(b.fold))[0] : null, medianFold: medianFold(foldMetrics), plus10Bps, cvar95: calculateCvar95(trades), external: externalMetrics, promotionLcb95, promotion };
}

function mergeEnsembleTrades(primary: ValidationTrade[], second: ValidationTrade[]): Array<ValidationTrade & { supportingStrategies: string[] }> {
  const byKey = new Map<string, ValidationTrade & { supportingStrategies: string[] }>();
  for (const trade of [...primary, ...second]) {
    const key = canonicalEmailSignalKey(trade);
    const existing = byKey.get(key);
    const identity = "candidateId" in trade && typeof trade.candidateId === "string" ? trade.candidateId : V57_PRIMARY_EDGE_ID;
    if (!existing) {
      byKey.set(key, { ...trade, supportingStrategies: [identity] });
    } else {
      existing.supportingStrategies = [...new Set([...existing.supportingStrategies, identity])].sort();
    }
  }
  return [...byKey.values()].sort((left, right) => left.entryTime - right.entryTime);
}

function buildBreadthLookup(datasets: HistoricalDataset[], start: number, end: number): { at: (timestamp: number) => number | null } {
  const buckets = new Map<number, { bull: number; total: number }>();
  for (const dataset of datasets) {
    const candles = dataset.candles["1h"] ?? [];
    const fast = ema(closes(candles), 20);
    const slow = ema(closes(candles), 50);
    for (let index = 50; index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.closeTime < start || candle.closeTime > end) continue;
      const regime = regimeFromValues(fast, slow, index);
      if (regime === "UNKNOWN") continue;
      const bucket = buckets.get(candle.closeTime) ?? { bull: 0, total: 0 };
      bucket.total += 1;
      if (regime === "BULL") bucket.bull += 1;
      buckets.set(candle.closeTime, bucket);
    }
  }
  const timestamps = [...buckets.keys()].sort((a, b) => a - b);
  const values = timestamps.map((timestamp) => {
    const bucket = buckets.get(timestamp)!;
    return bucket.total > 0 ? bucket.bull / bucket.total : null;
  });
  return { at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) };
}

function lookupAtOrBefore(timestamps: number[], values: Array<number | null>, timestamp: number): number | null {
  let low = 0;
  let high = timestamps.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= timestamp) { result = middle; low = middle + 1; } else high = middle - 1;
  }
  return result >= 0 ? values[result] : null;
}

function regimeFromValues(fast: Array<number | null>, slow: Array<number | null>, index: number): MarketRegime {
  if (index < 5 || fast[index] === null || slow[index] === null || fast[index - 5] === null || fast[index] === 0) return "UNKNOWN";
  const slope = (fast[index]! - fast[index - 5]!) / fast[index]!;
  if (fast[index]! > slow[index]! && slope > 0.002) return "BULL";
  if (fast[index]! < slow[index]! && slope < -0.002) return "BEAR";
  return "RANGE";
}

function makeInstrument(symbol: string): Instrument {
  return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "HISTORICAL_DATA_VISION", priceTick: 0, quantityStep: 0 };
}

function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

function dedupeFunding(points: FundingRatePoint[]): FundingRatePoint[] {
  const map = new Map<number, FundingRatePoint>();
  for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point);
  return [...map.values()].sort((a, b) => a.fundingTime - b.fundingTime);
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function serializeMetrics(metrics: ValidationMetrics | null): Record<string, unknown> | null {
  if (!metrics) return null;
  return {
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: roundMetric(metrics.winRate),
    netR: roundMetric(metrics.netR),
    avgR: roundMetric(metrics.avgNetR),
    profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null,
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    lowerConfidenceBound95: roundMetric(metrics.lowerConfidenceBound95),
    positiveMonths: metrics.positiveMonths,
    months: metrics.months,
    positiveMonthRatio: roundMetric(metrics.positiveMonthRatio),
    totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt),
    totalFeesUsdt: roundMetric(metrics.totalFeesUsdt),
    totalFundingUsdt: roundMetric(metrics.totalFundingUsdt),
    totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt),
    monthly: metrics.monthly.map((month) => ({ month: month.month, trades: month.trades, netR: roundMetric(month.netR), profitFactor: Number.isFinite(month.profitFactor) ? roundMetric(month.profitFactor) : null, maxDrawdownR: roundMetric(month.maxDrawdownR) })),
  };
}

function serializeYield(value: ReturnType<typeof calculateYieldMetrics>) {
  return {
    calendarDays: roundMetric(value.calendarDays),
    calendarMonths: value.calendarMonths,
    alertsPerDay: roundMetric(value.alertsPerDay),
    alertsPerWeek: roundMetric(value.alertsPerWeek),
    alertsPerMonth: roundMetric(value.alertsPerMonth),
    activeMonthRatio: roundMetric(value.activeMonthRatio),
    medianAlertsPerMonth: roundMetric(value.medianAlertsPerMonth),
    p95SignalDroughtDays: roundMetric(value.p95SignalDroughtDays),
    maxSignalDroughtDays: roundMetric(value.maxSignalDroughtDays),
    symbolBreadth: value.symbolBreadth,
    regimeBreadth: value.regimeBreadth,
    positiveMonthRatio: roundMetric(value.positiveMonthRatio),
  };
}

function serializeFolds(folds: FoldSummary[]) {
  return folds.map((fold) => ({ fold: fold.fold, trades: fold.trades, netR: roundMetric(fold.netR), avgR: roundMetric(fold.avgR), profitFactor: roundMetric(fold.profitFactor), positive: fold.positive }));
}

function edgeReport(row: EdgeSummary): Record<string, unknown> {
  return {
    candidate: row.candidateId,
    family: row.family,
    nestedOos: serializeMetrics(row.metrics),
    development: serializeMetrics(row.developmentMetrics),
    outerFolds: serializeFolds(row.foldMetrics),
    foldPositiveRatio: roundMetric(row.foldPositiveRatio),
    worstFold: row.worstFold ? serializeFolds([row.worstFold])[0] : null,
    medianFold: row.medianFold ? serializeFolds([row.medianFold])[0] : null,
    selectionAdjustedLcb95: roundMetric(row.selectionAdjustedLcb95),
    promotionLcb95: roundMetric(row.promotionLcb95),
    plus10Bps: serializeMetrics(row.plus10Bps),
    yield: serializeYield(row.yield),
    signalsWhenPrimaryFires: row.primaryOverlapTrades,
    signalsWhenPrimarySilent: row.primarySilentTrades,
    overlapPercent: roundMetric(row.overlapPercent),
    incremental: serializeMetrics(row.incrementalMetrics),
    external: serializeMetrics(row.externalMetrics),
    gate: row.gate,
  };
}

function buildValidationSummary(input: {
  manifest: FrozenManifest;
  inventory: ExternalInventory | null;
  externalValidationRun: boolean;
  primaryDevelopment: ReturnType<typeof summarizePrimary>;
  primaryExternal: ReturnType<typeof summarizePrimary> | null;
  candidateRows: EdgeSummary[];
  selected: EdgeSummary | null;
  secondGate: ReturnType<typeof evaluateSecondEdgeGate> | null;
  ensemble: ReturnType<typeof buildEnsembleReport>;
  businessVerdict: "YES" | "NO" | "INCONCLUSIVE";
  emailPromotion: "PASS" | "FAIL";
}): Record<string, unknown> {
  const selected = input.selected;
  const secondStatus = selected && input.secondGate?.passed ? "VALID_SECOND_EDGE" : "NO_VALID_SECOND_EDGE";
  return {
    schema: "bca-v5-7-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    status: input.externalValidationRun ? "VALIDATION_COMPLETE" : "DATA_INCOMPLETE",
    researchOnly: true,
    manifestId: input.manifest.manifestId,
    manifestHash: input.manifest.manifestHash,
    researchBaseline: input.manifest.researchBaseline,
    externalData: {
      manifest: V57_EXTERNAL_MANIFEST_ID,
      period: input.manifest.externalDataset.period,
      pitEligible: input.inventory?.pitEligibleSymbols.length ?? 0,
      available: input.inventory?.availableSymbols.length ?? 0,
      coveragePercent: roundMetric(input.inventory?.coveragePercent ?? 0),
      status: input.inventory?.status ?? "DATA_INCOMPLETE",
      externalValidationRun: input.externalValidationRun,
      unavailableReason: input.externalValidationRun ? null : "No complete local immutable cache is available to the validator; no external profitability conclusion is generated.",
      classifications: input.inventory?.symbols.map((symbol) => ({ symbol: symbol.symbol, pitEligible: symbol.pitEligible, classification: symbol.classification, availableArchiveCount: symbol.availableArchiveCount, expectedArchiveCount: symbol.expectedArchiveCount })) ?? [],
    },
    primaryEdge: {
      role: "PRIMARY_EDGE_CONTROL",
      id: V57_PRIMARY_EDGE_ID,
      family: "FAILED_BREAKOUT_REVERSAL",
      frozenNestedOos: input.manifest.primaryEdge.frozenNestedOos,
      development: serializeEdgeCore(input.primaryDevelopment),
      external: input.primaryExternal ? serializeEdgeCore(input.primaryExternal) : "DATA_UNAVAILABLE",
      parameterChange: "NO",
    },
    secondEdge: {
      status: secondStatus,
      selectedCandidate: selected?.candidateId ?? null,
      selectedFamily: selected?.family ?? null,
      gate: input.secondGate,
      candidates: input.candidateRows.map(edgeReport),
      registry: { count: V57_SECOND_EDGE_REGISTRY.length, max: 12, families: [...new Set(V57_SECOND_EDGE_REGISTRY.map((candidate) => candidate.family))], hash: sha256Json(V57_SECOND_EDGE_REGISTRY) },
    },
    ensemble: {
      status: input.ensemble.status,
      components: input.ensemble.components,
      trades: input.ensemble.metrics.trades,
      incrementalTrades: selected?.incrementalMetrics.trades ?? 0,
      yield: serializeYield(input.ensemble.yield),
      outerFolds: serializeFolds(input.ensemble.foldMetrics),
      foldPositiveRatio: roundMetric(input.ensemble.foldPositiveRatio),
      worstFold: input.ensemble.worstFold ? serializeFolds([input.ensemble.worstFold])[0] : null,
      medianFold: input.ensemble.medianFold ? serializeFolds([input.ensemble.medianFold])[0] : null,
      metrics: serializeMetrics(input.ensemble.metrics),
      maxDD: roundMetric(input.ensemble.metrics.maxDrawdownR),
      cvar95: roundMetric(input.ensemble.cvar95),
      plus10Bps: serializeMetrics(input.ensemble.plus10Bps),
      promotionLcb95: roundMetric(input.ensemble.promotionLcb95),
      external: serializeMetrics(input.ensemble.external),
      promotion: input.ensemble.promotion,
      supportingStrategies: "Same symbol/side/entry timestamp is one canonical signal with supportingStrategies provenance.",
    },
    exactOldProduction: { status: "DATA_UNAVAILABLE", metrics: null, reason: "No independent current Production configuration export is available; no exact replay is claimed." },
    long: { status: "FROZEN_REJECTED", reason: "V5.7 does not spend candidate budget optimizing the frozen rejected LONG." },
    businessVerdict: input.businessVerdict,
    emailPromotion: input.emailPromotion,
    boundaries: {
      productionChanged: false,
      forwardExperimentChanged: false,
      productionEmailChanged: false,
      environmentChanged: false,
      migrationApplied: false,
      deployment: false,
      merge: false,
      autoTrading: false,
      primaryTuned: false,
      longOptimized: false,
    },
  };
}

function serializeEdgeCore(edge: ReturnType<typeof summarizePrimary>): Record<string, unknown> {
  return { nestedOos: serializeMetrics(edge.nested), all: serializeMetrics(edge.all), outerFolds: serializeFolds(edge.foldMetrics), foldPositiveRatio: roundMetric(edge.foldPositiveRatio), worstFold: edge.worstFold ? serializeFolds([edge.worstFold])[0] : null, medianFold: edge.medianFold ? serializeFolds([edge.medianFold])[0] : null, selectionAdjustedLcb95: edge.selectionAdjustedLcb95, promotionLcb95: roundMetric(edge.promotionLcb95), plus10Bps: serializeMetrics(edge.plus10Bps), yield: serializeYield(edge.yield) };
}

function renderPromotionDecision(report: Record<string, unknown>): string {
  const external = report.externalData as Record<string, unknown>;
  const primary = report.primaryEdge as Record<string, unknown>;
  const second = report.secondEdge as Record<string, unknown>;
  const ensemble = report.ensemble as Record<string, unknown>;
  return [
    "# V5.7 Data Completion + Independent Second Edge — Promotion Decision",
    "",
    `Manifest: \`${String(report.manifestId)}\`; registry is frozen before results and hash-verified.`,
    `External data: ${String(external.status)}; PIT eligible ${String(external.pitEligible)}; available ${String(external.available)}; coverage ${String(external.coveragePercent)}%; validation run ${external.externalValidationRun ? "YES" : "NO"}.`,
    "",
    "## Primary edge",
    `- Frozen control: **${String(primary.id)}** / FAILED_BREAKOUT_REVERSAL; no parameter changes.`,
    `- Frozen prior nested OOS: ${JSON.stringify(primary.frozenNestedOos)}.`,
    `- Current development nested OOS: ${JSON.stringify(primary.development)}.`,
    `- External: ${typeof primary.external === "string" ? primary.external : JSON.stringify(primary.external)}.`,
    "",
    "## Second edge",
    `- Status: **${String(second.status)}**; selected candidate: ${String(second.selectedCandidate ?? "DATA_UNAVAILABLE")}; family: ${String(second.selectedFamily ?? "DATA_UNAVAILABLE")}.`,
    `- All ${V57_SECOND_EDGE_REGISTRY.length} preregistered candidates are retained in the JSON report; no failed-breakout variant is included.`,
    "- Candidate selection uses development data only; external data is validation-only.",
    "",
    "## Ensemble",
    `- Status: **${String(ensemble.status)}**; components: ${JSON.stringify(ensemble.components)}.`,
    `- Metrics: ${JSON.stringify(ensemble.metrics)}; external: ${JSON.stringify(ensemble.external)}.`,
    `- Promotion gate: **${String(ensemble.promotion)}**.`,
    "",
    "## Exact Old Production",
    "- Status: **DATA_UNAVAILABLE**; no exact current Production configuration export is available.",
    "",
    "## Business verdict",
    `- **${String(report.businessVerdict)}**; the evidence does not authorize Production replacement or email promotion.`,
    `- Email Promotion: **${String(report.emailPromotion)}**.`,
    "",
    "## Hard boundary",
    "- Production change: NO",
    "- V5.5 #002 change: NO",
    "- Production Email: NO",
    "- Environment change: NO",
    "- Supabase migration: NO",
    "- Deploy: NO",
    "- Merge: NO",
    "- Auto trading: NO",
    "",
  ].join("\n");
}

void main();
