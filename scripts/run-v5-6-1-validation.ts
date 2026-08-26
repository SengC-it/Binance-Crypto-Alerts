import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, MarketRegime } from "@/lib/core/types";
import { closes, ema } from "@/lib/core/indicators";
import { buildFeatureFrames, type FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import {
  buildStructuralPlan,
  detectStructuralSignal,
  runStructuralCandidate,
  selectionAdjustedLowerConfidenceBound,
  type StructuralCandidateDefinition,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import {
  applyAdditionalSlippage,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type CostStressMetrics,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import { auditConfidence, type ConfidenceAuditResult } from "@/lib/v5-4/confidence";
import { V56_CANDIDATE_REGISTRY, V56_CONTROL_B_ID } from "@/lib/v5-6/research";
import {
  calculateCvar95,
  calculateYieldMetrics,
  dedupeResearchTrades,
  passesProvisionalYieldGate,
  runIndependentCandidate,
  V561_CANDIDATE_REGISTRY,
  V561_CONTROL_B_ID,
  V561_MAX_CANDIDATES,
  type DedupeResult,
  type V561CandidateDefinition,
  type V561Trade,
  type V561StrategyFamily,
  type YieldMetrics,
} from "@/lib/v5-6-1/research";

const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/validation-cache");
const UNIVERSE_FILE = resolve("data/validation-universe-50.json");
const PIT_FILE = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
const PRODUCTION_MANIFEST_FILE = resolve("reports/v5-6-1-production-control-manifest.json");
const EXTERNAL_MANIFEST_FILE = resolve("reports/v5-6-1-external-validation-manifest.json");

export const V561_RESEARCH_BASELINE = "c94ad43ab7477a9c4d770ea234137425c174821f";
export const V561_PRODUCTION_BASELINE = "a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d";
export const V561_FORWARD_EXPERIMENT = "v55-fbos02-forward-002";
export const V561_FROZEN_MANIFEST_HASH = "ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305";
export const V561_CONTROL_STRATEGY = "trend-rejection-short-v1";
export const V561_CORE_START = 1_691_633_700_000;
export const V561_BROAD_START = 1_754_705_700_000;
export const V561_CACHE_END = 1_786_241_699_999;
export const V561_CORE_HOLDOUT_START = V561_BROAD_START;
export const V561_BROAD_HOLDOUT_START = Date.parse("2026-02-09T02:15:00.000Z");
export const V561_PURGE_HOURS = 72;
export const V561_ENTRY_STRIDE_BARS = 4;
export const V561_FEE_RATE = 0.0004;
export const V561_BASE_SLIPPAGE_BPS = 2;
export const V561_RISK_PER_TRADE_USDT = 50;

type GroupId = "3Y_CORE" | "1Y_BROAD";

interface CacheFile {
  symbol: string;
  path: string;
}

interface PitEvidenceSymbol {
  symbol: string;
  observedMonths?: string[];
  tradableStart?: string | null;
  tradableEnd?: string | null;
}

interface PitAudit {
  status: "CONSERVATIVE_MONTHLY" | "DATA_UNAVAILABLE";
  sourceManifestStatus: string;
  source: string;
  evidenceSymbols: PitEvidenceSymbol[];
  methodology: string[];
  limitations: string[];
  isEligible: (symbol: string, timestamp: number) => boolean;
  eligibleSymbolsAt: (timestamp: number) => string[];
}

interface ValidationGroup {
  id: GroupId;
  label: string;
  start: number;
  developmentEnd: number;
  holdoutStart: number;
  end: number;
  files: CacheFile[];
  expectedSymbols: number;
  missingSymbols: string[];
  pitEligibleSymbolsAtStart: string[];
  pitCoveragePercent: number | null;
  folds: PurgedWalkForwardFold[];
}

interface BreadthLookup {
  timestamps: number[];
  values: number[];
  at: (timestamp: number) => number | null;
}

interface GroupRuntime {
  group: ValidationGroup;
  breadth: BreadthLookup;
  btcDataset?: HistoricalDataset;
  ethDataset?: HistoricalDataset;
}

interface AttritionCounts {
  eligibleFrames: number;
  attemptedBreakout: number;
  failedClose: number;
  secondFailedClose: number;
  lowerHigh: number;
  marketRegime: number;
  rsi: number;
  volume: number;
  extension: number;
  momentum: number;
  validRiskPlan: number;
  finalEligibleTrades: number;
}

interface GroupRunState {
  candidateTrades: Map<string, V561Trade[]>;
  delayedCandidateTrades: Map<string, V561Trade[]>;
  controlBTrades: V561Trade[];
  legacyV56HoldoutTrades: V561Trade[];
  attrition: AttritionCounts;
  loadedSymbols: string[];
}

interface DedupeCounts {
  rawRows: number;
  uniqueRows: number;
  duplicateRows: number;
}

interface CandidateRow {
  candidate: V561CandidateDefinition;
  allTrades: V561Trade[];
  developmentTrades: V561Trade[];
  developmentMetrics: ValidationMetrics;
  nestedOosTrades: V561Trade[];
  nestedOosMetrics: ValidationMetrics;
  postSelectionDiagnosticTrades: V561Trade[];
  holdoutTrades: V561Trade[];
  holdoutMetrics: ValidationMetrics | null;
  deduplication: {
    all: DedupeCounts;
    nestedOuterOos: DedupeCounts;
    holdout: DedupeCounts;
  };
  yield: YieldMetrics;
  selectionScore: number;
  foldMetrics: Array<{ group: GroupId; fold: string; metrics: ValidationMetrics }>;
}

interface FamilyRow {
  family: V561StrategyFamily;
  candidate: V561CandidateDefinition;
  developmentMetrics: ValidationMetrics;
  nestedOosMetrics: ValidationMetrics;
  externalValidation: "DATA_UNAVAILABLE";
  positiveHistoricalExpectancy: boolean;
  eligibleForEnsemble: boolean;
}

interface ConfidenceSummary {
  rawLcb95: number | null;
  blockBootstrapLcb95: number | null;
  symbolClusterLcb95: number | null;
  foldClusterLcb95: number | null;
  selectionAdjustedLcb95: number | null;
  promotionLcb95: number | null;
  promotionMethod: "minimum_available_robust_lcb95" | "DATA_UNAVAILABLE";
  audit: ConfidenceAuditResult;
}

interface MarginalContribution {
  family: V561StrategyFamily;
  withFamily: ValidationMetrics;
  withoutFamily: ValidationMetrics;
  addedSignals: ValidationMetrics;
  expectancyDelta: number;
  drawdownDelta: number;
  droughtDeltaDays: number | null;
}

interface EnsembleAnalysis {
  componentFamilies: V561StrategyFamily[];
  trades: V561Trade[];
  rawSignals: number;
  uniqueSignals: number;
  duplicateSignals: number;
  metrics: ValidationMetrics;
  yield: YieldMetrics;
  marginalContributions: MarginalContribution[];
}

interface DriftWindow {
  label: "6M" | "12M" | "18M";
  start: string;
  end: string;
  metrics: ValidationMetrics;
}

interface DirectionAnalysis {
  side: "LONG" | "SHORT";
  rows: CandidateRow[];
  familyRows: FamilyRow[];
  finalCandidate: V561CandidateDefinition | null;
  selectedNestedOosTrades: V561Trade[];
  selectedNestedOosMetrics: ValidationMetrics;
  selectedHoldoutTrades: V561Trade[];
  selectedHoldoutMetrics: ValidationMetrics | null;
  controlBTrades: V561Trade[];
  controlBMetrics: ValidationMetrics;
  controlBOosDedupe: DedupeCounts;
  controlBHoldoutTrades: V561Trade[];
  controlBHoldoutMetrics: ValidationMetrics | null;
  controlBHoldoutDedupe: DedupeCounts;
  nestedSelectionRecords: Array<{ group: GroupId; fold: string; selectedCandidate: string | null; trainTrades: number; validationTrades: number }>;
  nestedSelectionTrades: V561Trade[];
  nestedSelectionDedupe: DedupeCounts;
  nestedSelectionDelayedDedupe: DedupeCounts;
  confidence: ConfidenceSummary;
  costStress: CostStressMetrics & { plus5Bps: ValidationMetrics; oneBarDelay: ValidationMetrics };
  delayedEntryMetrics: ValidationMetrics;
  yield: YieldMetrics | null;
  ensemble: EnsembleAnalysis;
  drift: DriftWindow[];
  pareto: Array<{ id: string; netR: number; alertsPerWeek: number; maxDrawdownR: number; cvar95: number | null }>;
  promotion: PromotionDecision;
}

interface PromotionDecision {
  status: "PRODUCTION_EMAIL_ELIGIBLE" | "SHADOW_ONLY" | "REJECTED";
  gates: Array<{ id: string; passed: boolean; evidence: string }>;
}

interface ProductionControlManifest {
  status?: string;
  productionCommit?: string;
  strategyVersion?: string;
  manifestHash?: string;
  nonSensitiveStrategyConfig?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

interface ExternalValidationManifest {
  status?: string;
  manifestId?: string;
  period?: { start?: string; end?: string };
  expectedSymbolCount?: number;
  manifestHash?: string;
  dataReadAfterManifest?: boolean;
}

interface ExternalValidationResult {
  status: "AVAILABLE" | "DATA_UNAVAILABLE";
  manifestFrozenBeforeData: boolean;
  manifestId: string;
  period: { start: string; end: string };
  expectedSymbols: number;
  loadedSymbols: string[];
  coveragePercent: number;
  trades: number | null;
  metrics: ValidationMetrics | null;
  reason: string;
  manifestHash: string | null;
}

interface ForwardDiagnostic {
  status: "DATA_UNAVAILABLE";
  experimentId: string;
  source: string;
  reason: string;
  selectionUse: "NOT_USED_FOR_SELECTION";
}

interface BusinessComparison {
  status: "INCONCLUSIVE";
  reason: string;
  rows: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const universe = await loadUniverse();
  const cacheFiles = await loadCacheManifest();
  const pit = await readPitAudit();
  const groups = buildGroups(universe, cacheFiles, pit);
  const productionManifest = await readProductionManifest();
  const externalManifest = await readExternalManifest();
  const externalValidation = inspectExternalCoverage(externalManifest, cacheFiles);
  const runtimes = new Map<GroupId, GroupRuntime>();
  const states = new Map<GroupId, GroupRunState>();

  if (V561_CANDIDATE_REGISTRY.length > V561_MAX_CANDIDATES) {
    throw new Error(`V5.6.1 registry exceeds finite limit: ${V561_CANDIDATE_REGISTRY.length}`);
  }

  console.info(JSON.stringify({
    stage: "v5_6_1_validation_start",
    researchBaseline: V561_RESEARCH_BASELINE,
    productionBaseline: V561_PRODUCTION_BASELINE,
    candidates: V561_CANDIDATE_REGISTRY.length,
    controlA: productionManifest.status ?? "DATA_UNAVAILABLE",
    externalValidation: externalValidation.status,
    pit: pit.status,
  }));

  for (const group of groups) {
    const runtime = await prepareRuntime(group);
    runtimes.set(group.id, runtime);
    const state: GroupRunState = {
      candidateTrades: new Map(V561_CANDIDATE_REGISTRY.map((candidate) => [candidate.id, []])),
      delayedCandidateTrades: new Map(V561_CANDIDATE_REGISTRY.map((candidate) => [candidate.id, []])),
      controlBTrades: [],
      legacyV56HoldoutTrades: [],
      attrition: emptyAttrition(),
      loadedSymbols: [],
    };
    states.set(group.id, state);

    for (const file of group.files) {
      const dataset = await readDataset(file);
      state.loadedSymbols.push(dataset.symbol);
      const frames = buildFeatureFrames(dataset, {
        startTime: group.start,
        endTime: group.end,
        entryStrideBars: V561_ENTRY_STRIDE_BARS,
        breadthAt: runtime.breadth.at,
        btcDataset: runtime.btcDataset,
        ethDataset: runtime.ethDataset,
      });
      for (const candidate of V561_CANDIDATE_REGISTRY) {
        const runOptions = {
          startTime: group.start,
          endTime: group.end,
          takerFeeRate: V561_FEE_RATE,
          slippageBps: V561_BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: V561_RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        };
        state.candidateTrades.get(candidate.id)!.push(...filterPit(runIndependentCandidate(dataset, frames, candidate, runOptions), pit));
        state.delayedCandidateTrades.get(candidate.id)!.push(...filterPit(runIndependentCandidate(dataset, frames, candidate, { ...runOptions, delayBars: 1 }), pit));
      }

      const frozenControl = frozenControlDefinition();
      const controlTrades = runStructuralCandidate(dataset, frames, frozenControl, {
        startTime: group.start,
        endTime: group.end,
        maxHoldHours: frozenControl.expectedHoldingHorizonHours,
        takerFeeRate: V561_FEE_RATE,
        slippageBps: V561_BASE_SLIPPAGE_BPS,
        riskPerTradeUsdt: V561_RISK_PER_TRADE_USDT,
        cooldownHours: 8,
      });
      state.controlBTrades.push(...filterPit(controlTrades.map((trade) => toV561ControlTrade(trade, V561_CONTROL_B_ID, "FROZEN_CONTROL")), pit));

      const legacyCandidate = V56_CANDIDATE_REGISTRY.find((candidate) => candidate.id === "V56-SHORT-FAILED_BREAKOUT-BALANCED-125");
      if (legacyCandidate) {
        const legacyTrades = runStructuralCandidate(dataset, frames, legacyCandidate, {
          startTime: group.start,
          endTime: group.end,
          maxHoldHours: legacyCandidate.expectedHoldingHorizonHours,
          takerFeeRate: V561_FEE_RATE,
          slippageBps: V561_BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: V561_RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        });
        state.legacyV56HoldoutTrades.push(...filterPit(legacyTrades.map((trade) => toV561ControlTrade(trade, legacyCandidate.id, "FROZEN_CONTROL")), pit));
      }
      addAttrition(state.attrition, analyzeFrozenAttrition(dataset, frames, frozenControl, state.controlBTrades.filter((trade) => trade.symbol === dataset.symbol).length));
    }
    console.info(JSON.stringify({
      stage: "v5_6_1_group_complete",
      group: group.id,
      symbols: state.loadedSymbols.length,
      controlBTrades: state.controlBTrades.length,
      candidates: Object.fromEntries([...state.candidateTrades.entries()].map(([id, trades]) => [id, trades.length])),
    }));
  }

  const oosStart = Math.min(...groups.flatMap((group) => group.folds.map((fold) => fold.validationStart)));
  const oosEnd = Math.max(...groups.flatMap((group) => group.folds.map((fold) => fold.validationEnd)));
  const localPitCoverageComplete = groups.every((group) => states.get(group.id)!.loadedSymbols.length >= group.expectedSymbols);
  const analyses = new Map<"LONG" | "SHORT", DirectionAnalysis>();
  for (const side of ["LONG", "SHORT"] as const) {
    analyses.set(side, analyzeDirection(side, groups, states, oosStart, oosEnd, pit, localPitCoverageComplete, productionManifest, externalValidation));
  }

  const forward = readForwardDiagnostic();
  const holdoutAudit = auditKnownV56Holdout(groups, states);
  await writeReports(groups, runtimes, states, analyses, pit, localPitCoverageComplete, productionManifest, externalValidation, externalManifest, forward, holdoutAudit, oosStart, oosEnd);

  console.info(JSON.stringify({
    stage: "v5_6_1_validation_complete",
    directions: Object.fromEntries([...analyses.entries()].map(([side, analysis]) => [side, {
      candidate: analysis.finalCandidate?.id ?? null,
      nestedOosTrades: analysis.selectedNestedOosMetrics.trades,
      nestedOosAvgR: roundMetric(analysis.selectedNestedOosMetrics.avgNetR),
      nestedOosPF: roundMetric(analysis.selectedNestedOosMetrics.profitFactor),
      ensembleTrades: analysis.ensemble.metrics.trades,
      promotion: analysis.promotion.status,
    }])),
    controlA: productionManifest.status ?? "DATA_UNAVAILABLE",
    externalValidation: externalValidation.status,
  }));
}

async function loadUniverse(): Promise<string[]> {
  const value = JSON.parse(await readFile(UNIVERSE_FILE, "utf8")) as { symbols?: string[] };
  return [...new Set(value.symbols ?? [])].sort();
}

async function loadCacheManifest(): Promise<CacheFile[]> {
  let names: string[];
  try {
    names = await readdir(CACHE_DIR);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      console.warn(JSON.stringify({ stage: "v5_6_1_cache_unavailable", cacheDirectory: "data/validation-cache", status: "DATA_UNAVAILABLE", reason: "No local immutable validation cache is present; no returns are fabricated." }));
      return [];
    }
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const match = name.match(/^(.+)-\d+-\d+\.json$/);
      return match ? { symbol: match[1], path: resolve(CACHE_DIR, name) } : null;
    })
    .filter((file): file is CacheFile => file !== null);
}

async function readDataset(file: CacheFile): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(file.path, "utf8")) as HistoricalDataset;
}

async function readPitAudit(): Promise<PitAudit> {
  try {
    const value = JSON.parse(await readFile(PIT_FILE, "utf8")) as {
      status?: string;
      source?: string;
      evidenceSymbols?: PitEvidenceSymbol[];
      methodology?: string[];
      limitations?: string[];
    };
    const evidenceSymbols = value.evidenceSymbols ?? [];
    const isEligible = (symbol: string, timestamp: number): boolean => {
      const record = evidenceSymbols.find((item) => item.symbol === symbol);
      const start = record?.tradableStart ? Date.parse(record.tradableStart) : Number.NaN;
      const end = record?.tradableEnd ? Date.parse(record.tradableEnd) : Number.NaN;
      return Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp <= end;
    };
    return {
      status: evidenceSymbols.length >= 50 ? "CONSERVATIVE_MONTHLY" : "DATA_UNAVAILABLE",
      sourceManifestStatus: value.status ?? "DATA_UNAVAILABLE",
      source: value.source ?? "Binance Data Vision archive",
      evidenceSymbols,
      methodology: value.methodology ?? [],
      limitations: value.limitations ?? [],
      isEligible,
      eligibleSymbolsAt: (timestamp) => evidenceSymbols.filter((item) => isEligible(item.symbol, timestamp)).map((item) => item.symbol).sort(),
    };
  } catch {
    return {
      status: "DATA_UNAVAILABLE",
      sourceManifestStatus: "DATA_UNAVAILABLE",
      source: "DATA_UNAVAILABLE",
      evidenceSymbols: [],
      methodology: [],
      limitations: ["PIT archive manifest unavailable."],
      isEligible: () => false,
      eligibleSymbolsAt: () => [],
    };
  }
}

function buildGroups(universe: string[], files: CacheFile[], pit: PitAudit): ValidationGroup[] {
  const makeGroup = (
    id: GroupId,
    label: string,
    start: number,
    developmentEnd: number,
    holdoutStart: number,
    suffix: string,
    initialTrainMonths: number,
    validationMonths: number,
  ): ValidationGroup => {
    const bySymbol = new Map(files.filter((file) => file.path.endsWith(suffix)).map((file) => [file.symbol, file]));
    const selected = universe.flatMap((symbol) => bySymbol.has(symbol) ? [bySymbol.get(symbol)!] : []);
    const pitEligibleSymbolsAtStart = pit.eligibleSymbolsAt(start);
    const folds = createPurgedWalkForwardFolds({
      start,
      end: developmentEnd,
      initialTrainMonths,
      validationMonths,
      foldCount: 6,
      purgeHours: V561_PURGE_HOURS,
    });
    return {
      id,
      label,
      start,
      developmentEnd,
      holdoutStart,
      end: V561_CACHE_END,
      files: selected,
      expectedSymbols: universe.length,
      missingSymbols: universe.filter((symbol) => !bySymbol.has(symbol)),
      pitEligibleSymbolsAtStart,
      pitCoveragePercent: pitEligibleSymbolsAtStart.length > 0 ? selected.filter((file) => pitEligibleSymbolsAtStart.includes(file.symbol)).length / pitEligibleSymbolsAtStart.length * 100 : null,
      folds,
    };
  };
  return [
    makeGroup("3Y_CORE", "3-year Core (conservative monthly PIT membership)", V561_CORE_START, V561_CORE_HOLDOUT_START - V561_PURGE_HOURS * 3_600_000 - 1, V561_CORE_HOLDOUT_START, "-1691633700000-1786241699999.json", 9, 2),
    makeGroup("1Y_BROAD", "1-year Broad (conservative monthly PIT membership)", V561_BROAD_START, V561_BROAD_HOLDOUT_START - V561_PURGE_HOURS * 3_600_000 - 1, V561_BROAD_HOLDOUT_START, "-1754705700000-1786241699999.json", 3, 1),
  ];
}

async function prepareRuntime(group: ValidationGroup): Promise<GroupRuntime> {
  const counts = new Map<number, { up: number; total: number }>();
  let btcDataset: HistoricalDataset | undefined;
  let ethDataset: HistoricalDataset | undefined;
  for (const file of group.files) {
    const dataset = await readDataset(file);
    if (dataset.symbol === "BTCUSDT") btcDataset = dataset;
    if (dataset.symbol === "ETHUSDT") ethDataset = dataset;
    const candles = dataset.candles["1h"] ?? [];
    const fast = ema(closes(candles), 20);
    const slow = ema(closes(candles), 50);
    for (let index = 50; index < candles.length; index += 1) {
      if (candles[index].closeTime < group.start || candles[index].closeTime > group.end) continue;
      const regime = regimeFromValues(fast, slow, index);
      if (regime === "UNKNOWN") continue;
      const bucket = counts.get(candles[index].closeTime) ?? { up: 0, total: 0 };
      bucket.total += 1;
      if (regime === "BULL") bucket.up += 1;
      counts.set(candles[index].closeTime, bucket);
    }
  }
  const timestamps = [...counts.keys()].sort((left, right) => left - right);
  const values = timestamps.map((timestamp) => {
    const value = counts.get(timestamp)!;
    return value.total > 0 ? value.up / value.total : 0.5;
  });
  return { group, breadth: { timestamps, values, at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) }, btcDataset, ethDataset };
}

function analyzeDirection(
  side: "LONG" | "SHORT",
  groups: ValidationGroup[],
  states: Map<GroupId, GroupRunState>,
  oosStart: number,
  oosEnd: number,
  pit: PitAudit,
  localPitCoverageComplete: boolean,
  productionManifest: ProductionControlManifest,
  externalValidation: ExternalValidationResult,
): DirectionAnalysis {
  const candidates = V561_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === side);
  const rows = candidates.map((candidate) => {
    const rawCandidateTrades = groups.flatMap((group) => states.get(group.id)!.candidateTrades.get(candidate.id) ?? []);
    const allDedupe = dedupeResearchTrades(rawCandidateTrades);
    const allTrades = allDedupe.uniqueRows;
    const developmentTrades = allTrades.filter((trade) => groups.some((group) => trade.entryTime >= group.start && trade.entryTime <= group.developmentEnd));
    const nestedOosDedupe = dedupeResearchTrades(rawCandidateTrades.filter((trade) => groups.some((group) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))));
    const nestedOosTrades = nestedOosDedupe.uniqueRows.map((trade) => ({ ...trade, fold: foldLabel(groups, trade.entryTime) }));
    const holdoutDedupe = dedupeResearchTrades(rawCandidateTrades.filter((trade) => groups.some((group) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end)));
    const holdoutTrades = holdoutDedupe.uniqueRows;
    const yieldMetrics = calculateYieldMetrics(nestedOosTrades, oosStart, oosEnd);
    return {
      candidate,
      allTrades,
      developmentTrades,
      developmentMetrics: calculateMetrics(developmentTrades),
      nestedOosTrades,
      nestedOosMetrics: calculateMetrics(nestedOosTrades),
      postSelectionDiagnosticTrades: nestedOosTrades,
      holdoutTrades,
      holdoutMetrics: holdoutTrades.length > 0 ? calculateMetrics(holdoutTrades) : null,
      deduplication: {
        all: dedupeCounts(allDedupe),
        nestedOuterOos: dedupeCounts(nestedOosDedupe),
        holdout: dedupeCounts(holdoutDedupe),
      },
      yield: yieldMetrics,
      selectionScore: developmentSelectionScore(calculateMetrics(developmentTrades)),
      foldMetrics: groups.flatMap((group) => group.folds.map((fold) => ({
        group: group.id,
        fold: fold.id,
        metrics: calculateMetrics(allTrades.filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))),
      }))),
    } satisfies CandidateRow;
  });

  const nestedSelectionRecords: DirectionAnalysis["nestedSelectionRecords"] = [];
  const nestedSelectionTrades: V561Trade[] = [];
  const nestedSelectionDelayedTrades: V561Trade[] = [];
  for (const group of groups) {
    const state = states.get(group.id)!;
    for (const fold of group.folds) {
      const training = candidates.map((candidate) => {
        const trades = dedupeResearchTrades((state.candidateTrades.get(candidate.id) ?? []).filter((trade) => trade.entryTime >= fold.trainStart && trade.entryTime <= fold.trainEnd)).uniqueRows;
        return { candidate, trades, score: developmentSelectionScore(calculateMetrics(trades)) };
      }).sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
      const selected = training[0]?.candidate ?? null;
      const validationTrades = selected
        ? dedupeResearchTrades((state.candidateTrades.get(selected.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))).uniqueRows.map((trade) => ({ ...trade, fold: `${group.id}-${fold.id}` }))
        : [];
      const delayedValidationTrades = selected
        ? dedupeResearchTrades((state.delayedCandidateTrades.get(selected.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))).uniqueRows.map((trade) => ({ ...trade, fold: `${group.id}-${fold.id}` }))
        : [];
      nestedSelectionTrades.push(...validationTrades);
      nestedSelectionDelayedTrades.push(...delayedValidationTrades);
      nestedSelectionRecords.push({ group: group.id, fold: fold.id, selectedCandidate: selected?.id ?? null, trainTrades: training[0]?.trades.length ?? 0, validationTrades: validationTrades.length });
    }
  }

  const nestedSelectionDedupe = dedupeResearchTrades(nestedSelectionTrades);
  const nestedSelectionDelayedDedupe = dedupeResearchTrades(nestedSelectionDelayedTrades);
  const finalRow = [...rows].sort((left, right) => right.selectionScore - left.selectionScore || left.candidate.id.localeCompare(right.candidate.id))[0];
  const finalCandidate = finalRow?.candidate ?? null;
  const selectedNestedOosTrades = nestedSelectionDedupe.uniqueRows;
  const selectedNestedOosMetrics = calculateMetrics(selectedNestedOosTrades);
  const selectedHoldoutTrades = finalRow?.holdoutTrades ?? [];
  const selectedHoldoutMetrics = selectedHoldoutTrades.length > 0 ? calculateMetrics(selectedHoldoutTrades) : null;
  const rawControlBOosTrades = side === "SHORT"
    ? groups.flatMap((group) => states.get(group.id)!.controlBTrades).filter((trade) => groups.some((group) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))).map((trade) => ({ ...trade, strategyIdentity: V561_CONTROL_B_ID }))
    : [];
  const controlBOosDedupe = dedupeResearchTrades(rawControlBOosTrades);
  const controlBTrades = controlBOosDedupe.uniqueRows;
  const rawControlBHoldoutTrades = side === "SHORT"
    ? groups.flatMap((group) => states.get(group.id)!.controlBTrades).filter((trade) => groups.some((group) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end)).map((trade) => ({ ...trade, strategyIdentity: V561_CONTROL_B_ID }))
    : [];
  const controlBHoldoutDedupe = dedupeResearchTrades(rawControlBHoldoutTrades);
  const controlBHoldoutTrades = controlBHoldoutDedupe.uniqueRows;
  const familyRows = candidates.map((candidate) => {
    const row = rows.find((item) => item.candidate.id === candidate.id)!;
    const positiveHistoricalExpectancy = row.nestedOosMetrics.trades > 0 && row.nestedOosMetrics.netR > 0 && row.nestedOosMetrics.avgNetR > 0 && row.nestedOosMetrics.profitFactor > 1;
    return {
      family: candidate.family,
      candidate,
      developmentMetrics: row.developmentMetrics,
      nestedOosMetrics: row.nestedOosMetrics,
      externalValidation: "DATA_UNAVAILABLE" as const,
      positiveHistoricalExpectancy,
      eligibleForEnsemble: positiveHistoricalExpectancy,
    } satisfies FamilyRow;
  });
  const ensemble = buildEnsemble(familyRows, rows, oosStart, oosEnd);
  const confidence = buildConfidence(rows, finalCandidate, selectedNestedOosTrades);
  const delayedEntryMetrics = calculateMetrics(nestedSelectionDelayedDedupe.uniqueRows);
  const costStress = buildCostStress(selectedNestedOosTrades, delayedEntryMetrics);
  const yieldMetrics = finalCandidate ? calculateYieldMetrics(selectedNestedOosTrades, oosStart, oosEnd) : null;
  const drift = buildDrift(finalRow?.allTrades ?? [], V561_CACHE_END);
  const pareto = buildPareto(rows);
  const promotion = evaluatePromotion({ side, candidate: finalCandidate, oos: selectedNestedOosMetrics, confidence, yield: yieldMetrics, familyRows, ensemble, productionManifest, externalValidation, pit, localPitCoverageComplete, controlBMetrics: controlBTrades.length > 0 ? calculateMetrics(controlBTrades) : calculateMetrics([]) });
  return {
    side,
    rows,
    familyRows,
    finalCandidate,
    selectedNestedOosTrades,
    selectedNestedOosMetrics,
    selectedHoldoutTrades,
    selectedHoldoutMetrics,
    controlBTrades,
    controlBMetrics: calculateMetrics(controlBTrades),
    controlBOosDedupe: dedupeCounts(controlBOosDedupe),
    controlBHoldoutTrades,
    controlBHoldoutMetrics: controlBHoldoutTrades.length > 0 ? calculateMetrics(controlBHoldoutTrades) : null,
    controlBHoldoutDedupe: dedupeCounts(controlBHoldoutDedupe),
    nestedSelectionRecords,
    nestedSelectionTrades,
    nestedSelectionDedupe: dedupeCounts(nestedSelectionDedupe),
    nestedSelectionDelayedDedupe: dedupeCounts(nestedSelectionDelayedDedupe),
    confidence,
    costStress,
    delayedEntryMetrics,
    yield: yieldMetrics,
    ensemble,
    drift,
    pareto,
    promotion,
  };
}

function frozenControlDefinition(): StructuralCandidateDefinition {
  const candidate = V56_CANDIDATE_REGISTRY.find((item) => item.id === V56_CONTROL_B_ID);
  if (!candidate) throw new Error(`Missing frozen Control B ${V56_CONTROL_B_ID}`);
  return candidate;
}

function toV561ControlTrade(trade: StructuralTrade, identity: string, family: "FROZEN_CONTROL"): V561Trade {
  return {
    ...trade,
    candidateId: identity,
    strategyIdentity: identity,
    family,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    signalCandleCloseTime: trade.entryTime - 1,
    executionCandleOpenTime: trade.entryTime,
    executionReferencePrice: trade.entryPrice,
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
  };
}

function filterPit<T extends Pick<V561Trade, "symbol" | "entryTime">>(trades: T[], pit: PitAudit): T[] {
  return pit.status === "CONSERVATIVE_MONTHLY" ? trades.filter((trade) => pit.isEligible(trade.symbol, trade.entryTime)) : [];
}

function emptyAttrition(): AttritionCounts {
  return { eligibleFrames: 0, attemptedBreakout: 0, failedClose: 0, secondFailedClose: 0, lowerHigh: 0, marketRegime: 0, rsi: 0, volume: 0, extension: 0, momentum: 0, validRiskPlan: 0, finalEligibleTrades: 0 };
}

function addAttrition(target: AttritionCounts, value: AttritionCounts): void {
  for (const key of Object.keys(target) as Array<keyof AttritionCounts>) target[key] += value[key];
}

function analyzeFrozenAttrition(dataset: HistoricalDataset, frames: FeatureFrame[], definition: StructuralCandidateDefinition, finalEligibleTrades: number): AttritionCounts {
  const candles = dataset.candles["15m"];
  const p = definition.parameters;
  const result = emptyAttrition();
  for (const frame of frames) {
    const index = frame.index;
    if (index < Math.max(100, p.breakoutLookback + 3) || index >= candles.length - 1) continue;
    result.eligibleFrames += 1;
    const level = rollingHigh(candles, index - 2, p.breakoutLookback);
    if (level === null) continue;
    const recent = candles.slice(Math.max(0, index - 5), index);
    if (!recent.some((candle) => candle.high > level && candle.close > level)) continue;
    result.attemptedBreakout += 1;
    if (frame.close >= level) continue;
    result.failedClose += 1;
    if (candles[index - 1].close >= level) continue;
    result.secondFailedClose += 1;
    if (frame.high >= Math.max(...recent.slice(0, -1).map((candle) => candle.high))) continue;
    result.lowerHigh += 1;
    if (!(frame.marketRegime === "RANGE" || frame.marketRegime === "BULL" || frame.oneHourRegime === "RANGE")) continue;
    result.marketRegime += 1;
    if (frame.rsi !== null && frame.rsi >= 58) continue;
    result.rsi += 1;
    if (frame.volumeRatio !== null && frame.volumeRatio < p.volumeRatioMin) continue;
    result.volume += 1;
    if (frame.shortEntryExtensionATR === null || frame.shortEntryExtensionATR > p.maxExtensionATR) continue;
    result.extension += 1;
    if (frame.momentumAcceleration === null || frame.momentumAcceleration >= 0.5) continue;
    result.momentum += 1;
    const entry = candles[index + 1];
    if (!detectStructuralSignal(frame, candles, definition) || !buildStructuralPlan(candles, frame, entry, definition)) continue;
    result.validRiskPlan += 1;
  }
  result.finalEligibleTrades = finalEligibleTrades;
  return result;
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function regimeFromValues(fast: Array<number | null>, slow: Array<number | null>, index: number): MarketRegime {
  if (index < 5 || fast[index] === null || slow[index] === null || fast[index - 5] === null || fast[index] === 0) return "UNKNOWN";
  const slope = (fast[index]! - fast[index - 5]!) / fast[index]!;
  if (fast[index]! > slow[index]! && slope > 0.002) return "BULL";
  if (fast[index]! < slow[index]! && slope < -0.002) return "BEAR";
  return "RANGE";
}

function lookupAtOrBefore(timestamps: number[], values: number[], timestamp: number): number | null {
  let low = 0;
  let high = timestamps.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= timestamp) {
      result = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result >= 0 ? values[result] : null;
}

function foldLabel(groups: ValidationGroup[], timestamp: number): string {
  for (const group of groups) {
    const fold = group.folds.find((item) => isTimestampInWindow(timestamp, item.validationStart, item.validationEnd));
    if (fold) return `${group.id}-${fold.id}`;
  }
  return "OUTSIDE_OOS";
}

function developmentSelectionScore(metrics: ValidationMetrics): number {
  if (metrics.trades === 0) return Number.NEGATIVE_INFINITY;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 3) : 3;
  return metrics.avgNetR * 100 + pf * 5 + (metrics.positiveMonthRatio ?? 0) * 5 - Math.min(metrics.maxDrawdownR, 100) * 0.05;
}

function buildConfidence(rows: CandidateRow[], selected: V561CandidateDefinition | null, trades: V561Trade[]): ConfidenceSummary {
  const candidateSeries = rows.map((row) => ({ candidateId: row.candidate.id, values: row.nestedOosTrades.map((trade) => trade.rMultiple) }));
  const selectionAdjustedLcb = selected
    ? selectionAdjustedLowerConfidenceBound(candidateSeries, selected.id, 2_000, 5)
    : null;
  const audit = auditConfidence({
    observations: trades.map((trade) => ({ value: trade.rMultiple, symbol: trade.symbol, fold: trade.fold ?? "OUTSIDE_OOS" })),
    candidateSeries,
    selectedCandidateId: selected?.id ?? "DATA_UNAVAILABLE",
    selectionCandidateCount: rows.length,
    repetitions: 2_000,
    blockLength: 5,
    selectionAdjustedLcb,
  });
  const find = (method: string): number | null => audit.methods.find((item) => item.method === method)?.lcb95 ?? null;
  const robust = [find("block_bootstrap"), find("symbol_cluster_bootstrap"), find("fold_cluster_bootstrap"), find("selection_adjusted_bootstrap")].filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    rawLcb95: find("naive_bootstrap"),
    blockBootstrapLcb95: find("block_bootstrap"),
    symbolClusterLcb95: find("symbol_cluster_bootstrap"),
    foldClusterLcb95: find("fold_cluster_bootstrap"),
    selectionAdjustedLcb95: find("selection_adjusted_bootstrap"),
    promotionLcb95: robust.length > 0 ? Math.min(...robust) : null,
    promotionMethod: robust.length > 0 ? "minimum_available_robust_lcb95" : "DATA_UNAVAILABLE",
    audit,
  };
}

function buildCostStress(trades: V561Trade[], delayedEntryMetrics: ValidationMetrics): CostStressMetrics & { plus5Bps: ValidationMetrics; oneBarDelay: ValidationMetrics } {
  return {
    base: calculateMetrics(trades),
    plus5Bps: calculateMetrics(applyAdditionalSlippage(trades, 5)),
    plus10Bps: calculateMetrics(applyAdditionalSlippage(trades, 10)),
    plus15Bps: calculateMetrics(applyAdditionalSlippage(trades, 15)),
    oneBarDelay: delayedEntryMetrics,
  };
}

function buildEnsemble(familyRows: FamilyRow[], rows: CandidateRow[], start: number, end: number): EnsembleAnalysis {
  const components = familyRows.filter((row) => row.eligibleForEnsemble).map((row) => row.family);
  const componentIds = new Set(familyRows.filter((row) => row.eligibleForEnsemble).map((row) => row.candidate.id));
  const sourceTrades = rows.filter((row) => componentIds.has(row.candidate.id)).flatMap((row) => row.nestedOosTrades);
  const trades = dedupeEnsembleTrades(sourceTrades);
  const metrics = calculateMetrics(trades);
  const yieldMetrics = calculateYieldMetrics(trades, start, end);
  const marginalContributions = components.map((family) => {
    const withoutTrades = dedupeEnsembleTrades(rows.filter((row) => componentIds.has(row.candidate.id) && row.candidate.family !== family).flatMap((row) => row.nestedOosTrades));
    const withTrades = trades;
    const withoutKeys = new Set(withoutTrades.map(canonicalEmailSignalKey));
    const added = withTrades.filter((trade) => !withoutKeys.has(canonicalEmailSignalKey(trade)));
    const withYield = calculateYieldMetrics(withTrades, start, end);
    const withoutYield = calculateYieldMetrics(withoutTrades, start, end);
    return {
      family,
      withFamily: calculateMetrics(withTrades),
      withoutFamily: calculateMetrics(withoutTrades),
      addedSignals: calculateMetrics(added),
      expectancyDelta: calculateMetrics(withTrades).avgNetR - calculateMetrics(withoutTrades).avgNetR,
      drawdownDelta: calculateMetrics(withTrades).maxDrawdownR - calculateMetrics(withoutTrades).maxDrawdownR,
      droughtDeltaDays: withYield.maxSignalDroughtDays !== null && withoutYield.maxSignalDroughtDays !== null ? withYield.maxSignalDroughtDays - withoutYield.maxSignalDroughtDays : null,
    } satisfies MarginalContribution;
  });
  return { componentFamilies: components, trades, rawSignals: sourceTrades.length, uniqueSignals: trades.length, duplicateSignals: sourceTrades.length - trades.length, metrics, yield: yieldMetrics, marginalContributions };
}

function dedupeEnsembleTrades(trades: V561Trade[]): V561Trade[] {
  const seen = new Map<string, V561Trade>();
  for (const trade of trades) {
    const key = canonicalEmailSignalKey(trade);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, trade);
      continue;
    }
    const currentSupport = (existing as V561Trade & { supportingStrategies?: string[] }).supportingStrategies ?? [existing.candidateId];
    const nextSupport = (trade as V561Trade & { supportingStrategies?: string[] }).supportingStrategies ?? [trade.candidateId];
    (existing as V561Trade & { supportingStrategies?: string[] }).supportingStrategies = [...new Set([...currentSupport, ...nextSupport])].sort();
  }
  return [...seen.values()].sort((left, right) => left.entryTime - right.entryTime || left.candidateId.localeCompare(right.candidateId));
}

function canonicalEmailSignalKey(trade: Pick<V561Trade, "symbol" | "side" | "entryTime">): string {
  return [trade.symbol, trade.side ?? "UNKNOWN", trade.entryTime].join("|");
}

function buildDrift(trades: V561Trade[], end: number): DriftWindow[] {
  return ([6, 12, 18] as const).map((months) => {
    const startDate = new Date(end);
    startDate.setUTCMonth(startDate.getUTCMonth() - months);
    const start = startDate.getTime();
    const selected = trades.filter((trade) => trade.entryTime >= start && trade.entryTime <= end);
    return { label: `${months}M` as "6M" | "12M" | "18M", start: startDate.toISOString(), end: new Date(end).toISOString(), metrics: calculateMetrics(selected) };
  });
}

function buildPareto(rows: CandidateRow[]): DirectionAnalysis["pareto"] {
  return rows.filter((row, index) => !rows.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const noWorse = other.nestedOosMetrics.netR >= row.nestedOosMetrics.netR
      && other.yield.alertsPerWeek >= row.yield.alertsPerWeek
      && other.nestedOosMetrics.maxDrawdownR <= row.nestedOosMetrics.maxDrawdownR;
    const better = other.nestedOosMetrics.netR > row.nestedOosMetrics.netR
      || other.yield.alertsPerWeek > row.yield.alertsPerWeek
      || other.nestedOosMetrics.maxDrawdownR < row.nestedOosMetrics.maxDrawdownR;
    return noWorse && better;
  })).map((row) => ({ id: row.candidate.id, netR: row.nestedOosMetrics.netR, alertsPerWeek: row.yield.alertsPerWeek, maxDrawdownR: row.nestedOosMetrics.maxDrawdownR, cvar95: calculateCvar95(row.nestedOosTrades) }));
}

function evaluatePromotion(input: {
  side: "LONG" | "SHORT";
  candidate: V561CandidateDefinition | null;
  oos: ValidationMetrics;
  confidence: ConfidenceSummary;
  yield: YieldMetrics | null;
  familyRows: FamilyRow[];
  ensemble: EnsembleAnalysis;
  productionManifest: ProductionControlManifest;
  externalValidation: ExternalValidationResult;
  pit: PitAudit;
  localPitCoverageComplete: boolean;
  controlBMetrics: ValidationMetrics;
}): PromotionDecision {
  const gates = [
    { id: "finite_preregistered_registry", passed: V561_CANDIDATE_REGISTRY.length > 0 && V561_CANDIDATE_REGISTRY.length <= V561_MAX_CANDIDATES, evidence: `${V561_CANDIDATE_REGISTRY.length} candidates; maximum ${V561_MAX_CANDIDATES}` },
    { id: "exact_production_control_provenance", passed: input.productionManifest.status === "AVAILABLE", evidence: input.productionManifest.status === "AVAILABLE" ? "Independent current Production manifest available" : "DATA_UNAVAILABLE; no exact replay or exact Production claim" },
    { id: "conservative_pit_universe", passed: input.pit.status === "CONSERVATIVE_MONTHLY", evidence: `PIT=${input.pit.status}; monthly first/last observed boundary exclusion` },
    { id: "local_pit_cache_coverage", passed: input.localPitCoverageComplete, evidence: input.localPitCoverageComplete ? "All requested symbols have local immutable cache coverage" : "INCOMPLETE; local cache does not cover the full requested group universe" },
    { id: "nested_outer_oos_quality", passed: input.oos.trades >= 100 && input.oos.netR > 0 && input.oos.avgNetR > 0 && input.oos.profitFactor >= 1.15, evidence: `nested OOS trades=${input.oos.trades}, NetR=${formatMetric(input.oos.netR)}, AvgR=${formatMetric(input.oos.avgNetR)}, PF=${formatMetric(input.oos.profitFactor)}` },
    { id: "external_validation", passed: input.externalValidation.status === "AVAILABLE", evidence: input.externalValidation.status === "AVAILABLE" ? `${input.externalValidation.trades} trades` : "DATA_UNAVAILABLE; frozen external interval has no complete local evidence" },
    { id: "confidence", passed: input.confidence.promotionLcb95 !== null && input.confidence.promotionLcb95 > 0, evidence: `promotion LCB95=${formatMetric(input.confidence.promotionLcb95)}; selection-adjusted=${formatMetric(input.confidence.selectionAdjustedLcb95)}` },
    { id: "useful_email_yield", passed: passesProvisionalYieldGate(input.yield), evidence: input.yield ? `${formatMetric(input.yield.alertsPerWeek)}/week, ${formatMetric(input.yield.alertsPerMonth)}/month, active=${formatMetric(input.yield.activeMonthRatio)}, median=${formatMetric(input.yield.medianAlertsPerMonth)}, p95 drought=${formatMetric(input.yield.p95SignalDroughtDays)}, max=${formatMetric(input.yield.maxSignalDroughtDays)}` : "DATA_UNAVAILABLE" },
    { id: "independent_family_edge", passed: input.familyRows.some((row) => row.positiveHistoricalExpectancy), evidence: input.familyRows.map((row) => `${row.family}=${row.positiveHistoricalExpectancy ? "PASS" : "FAIL"}`).join(", ") },
    { id: "ensemble_marginal_contribution", passed: input.ensemble.componentFamilies.length > 0 && input.ensemble.marginalContributions.every((row) => row.addedSignals.trades === 0 || row.addedSignals.avgNetR > 0), evidence: input.ensemble.componentFamilies.length > 0 ? `${input.ensemble.componentFamilies.length} component families; each added-signal AvgR is positive or zero` : "No eligible family" },
    { id: "control_comparison", passed: false, evidence: input.productionManifest.status === "AVAILABLE" ? "Exact Control A comparison not evaluated in this run" : "INCONCLUSIVE because exact Control A configuration is unavailable" },
    { id: "no_leakage_or_backfill", passed: true, evidence: "closed-candle features only; next candle is execution reference; no backfill or future returns used" },
    { id: "prospective_confirmation", passed: false, evidence: "Forward #002 is not used for tuning or promotion; current read-only diagnostic is DATA_UNAVAILABLE" },
  ];
  return {
    status: gates.every((gate) => gate.passed) ? "PRODUCTION_EMAIL_ELIGIBLE" : input.oos.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
    gates,
  };
}

function readForwardDiagnostic(): ForwardDiagnostic {
  return {
    status: "DATA_UNAVAILABLE",
    experimentId: V561_FORWARD_EXPERIMENT,
    source: "public.bca_v55_signal_feature_snapshots + public.bca_shadow_paper_trades",
    reason: "No independent Production/Supabase export or credential is available in the research workspace; no fabricated zero-row result was used.",
    selectionUse: "NOT_USED_FOR_SELECTION",
  };
}

async function readProductionManifest(): Promise<ProductionControlManifest> {
  try {
    const value = JSON.parse(await readFile(PRODUCTION_MANIFEST_FILE, "utf8")) as ProductionControlManifest;
    const expected = hashWithoutManifestHash(value);
    return value.manifestHash === expected ? value : { ...value, status: "DATA_UNAVAILABLE", provenance: { ...value.provenance, manifestIntegrity: "FAIL" } };
  } catch {
    return { status: "DATA_UNAVAILABLE" };
  }
}

async function readExternalManifest(): Promise<ExternalValidationManifest> {
  try {
    const value = JSON.parse(await readFile(EXTERNAL_MANIFEST_FILE, "utf8")) as ExternalValidationManifest;
    const expected = hashWithoutManifestHash(value);
    return value.manifestHash === expected ? value : { ...value, status: "MANIFEST_INTEGRITY_FAIL", dataReadAfterManifest: false };
  } catch {
    return { status: "MANIFEST_UNAVAILABLE", dataReadAfterManifest: false };
  }
}

function inspectExternalCoverage(manifest: ExternalValidationManifest, files: CacheFile[]): ExternalValidationResult {
  const start = manifest.period?.start ?? "2021-01-01T00:00:00.000Z";
  const end = manifest.period?.end ?? "2023-07-31T23:59:59.999Z";
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  const loadedSymbols = files.filter((file) => {
    const match = file.path.match(/-(\d+)-(\d+)\.json$/);
    if (!match) return false;
    return Number(match[1]) <= startTime && Number(match[2]) >= endTime;
  }).map((file) => file.symbol).sort();
  const expectedSymbols = manifest.expectedSymbolCount ?? 50;
  const manifestFrozenBeforeData = manifest.status === "FROZEN_BEFORE_DATA_READ" && manifest.dataReadAfterManifest === true;
  const status = manifestFrozenBeforeData && loadedSymbols.length >= expectedSymbols ? "AVAILABLE" : "DATA_UNAVAILABLE";
  return {
    status,
    manifestFrozenBeforeData,
    manifestId: manifest.manifestId ?? "DATA_UNAVAILABLE",
    period: { start, end },
    expectedSymbols,
    loadedSymbols,
    coveragePercent: expectedSymbols > 0 ? loadedSymbols.length / expectedSymbols * 100 : 0,
    trades: null,
    metrics: null,
    reason: status === "AVAILABLE" ? "Complete local immutable cache coverage" : "No complete local immutable cache covers the frozen external interval; no returns were fabricated.",
    manifestHash: manifest.manifestHash ?? null,
  };
}

function auditKnownV56Holdout(groups: ValidationGroup[], states: Map<GroupId, GroupRunState>): DedupeResult<V561Trade> & { reportedTradeCount: number; status: string } {
  const raw = groups.flatMap((group) => states.get(group.id)!.legacyV56HoldoutTrades.filter((trade) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end));
  const dedupe = dedupeResearchTrades(raw);
  return { ...dedupe, reportedTradeCount: 147, status: "V56_HOLDOUT_BURNED_AFTER_RESEARCH_REVIEW / KNOWN_VALIDATION_DIAGNOSTIC" };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashWithoutManifestHash(value: object): string {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.manifestHash;
  return createHash("sha256").update(stableJson(copy)).digest("hex");
}

function writeJson(name: string, value: unknown): Promise<void> {
  return writeFile(resolve(REPORT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeReports(
  groups: ValidationGroup[],
  runtimes: Map<GroupId, GroupRuntime>,
  states: Map<GroupId, GroupRunState>,
  analyses: Map<"LONG" | "SHORT", DirectionAnalysis>,
  pit: PitAudit,
  localPitCoverageComplete: boolean,
  productionManifest: ProductionControlManifest,
  externalValidation: ExternalValidationResult,
  externalManifest: ExternalValidationManifest,
  forward: ForwardDiagnostic,
  holdoutAudit: DedupeResult<V561Trade> & { reportedTradeCount: number; status: string },
  oosStart: number,
  oosEnd: number,
): Promise<void> {
  const long = analyses.get("LONG")!;
  const short = analyses.get("SHORT")!;
  const base = {
    reportVersion: "v5-6-1-research-v1",
    generatedAt: new Date().toISOString(),
    researchBaseline: V561_RESEARCH_BASELINE,
    productionBaseline: V561_PRODUCTION_BASELINE,
    controlStrategy: V561_CONTROL_STRATEGY,
    forwardExperiment: V561_FORWARD_EXPERIMENT,
    frozenV55ManifestHash: V561_FROZEN_MANIFEST_HASH,
    researchOnly: true,
    noProductionCodeChange: true,
    noProductionEmailChange: true,
    noProductionEnvironmentChange: true,
    noDatabaseWrite: true,
    noBackfill: true,
    noMerge: true,
    noDeployment: true,
    localPitCoverageComplete,
  };
  const groupRows = groups.map((group) => ({
    id: group.id,
    label: group.label,
    start: new Date(group.start).toISOString(),
    developmentEnd: new Date(group.developmentEnd).toISOString(),
    holdoutStart: new Date(group.holdoutStart).toISOString(),
    end: new Date(group.end).toISOString(),
    expectedSymbols: group.expectedSymbols,
    loadedSymbols: states.get(group.id)!.loadedSymbols.length,
    missingSymbols: group.missingSymbols,
    pitEligibleSymbolsAtStart: group.pitEligibleSymbolsAtStart,
    pitEligibleSymbolCount: group.pitEligibleSymbolsAtStart.length,
    localLoadedCoveragePercent: roundResearch(group.expectedSymbols > 0 ? states.get(group.id)!.loadedSymbols.length / group.expectedSymbols * 100 : null),
    localPitEligibleCoveragePercent: roundResearch(group.pitCoveragePercent),
    folds: group.folds.map((fold) => ({ ...fold, trainStart: new Date(fold.trainStart).toISOString(), trainEnd: new Date(fold.trainEnd).toISOString(), purgeStart: new Date(fold.purgeStart).toISOString(), purgeEnd: new Date(fold.purgeEnd).toISOString(), validationStart: new Date(fold.validationStart).toISOString(), validationEnd: new Date(fold.validationEnd).toISOString() })),
    breadthInput: { timestamps: runtimes.get(group.id)?.breadth.timestamps.length ?? 0, source: "local historical cache 1h candles" },
  }));
  const attrition = aggregateAttrition(states);
  await writeJson("v5-6-1-trigger-attrition.json", {
    ...base,
    historical: {
      source: "data/validation-cache; V5.5 frozen Control B attrition audit",
      groups: groups.map((group) => ({ group: group.id, counts: states.get(group.id)!.attrition, stages: serializeAttritionStages(states.get(group.id)!.attrition) })),
      aggregate: { counts: attrition, stages: serializeAttritionStages(attrition) },
      stageOrder: Object.keys(emptyAttrition()),
      interpretation: "Attrition is diagnostic; V5.6.1 independent family results are not represented as threshold relaxation of this detector.",
    },
    forwardDiagnostic: forward,
  });
  await writeJson("v5-6-1-candidate-registry.json", {
    ...base,
    finiteCandidateLimit: V561_MAX_CANDIDATES,
    candidateCount: V561_CANDIDATE_REGISTRY.length,
    independentDetectors: true,
    candidates: V561_CANDIDATE_REGISTRY,
    families: [...new Set(V561_CANDIDATE_REGISTRY.map((candidate) => candidate.family))],
    controls: { controlA: { strategyVersion: V561_CONTROL_STRATEGY, status: productionManifest.status ?? "DATA_UNAVAILABLE", manifestHash: productionManifest.manifestHash ?? null }, controlB: { id: V561_CONTROL_B_ID, frozen: true, manifestHash: V561_FROZEN_MANIFEST_HASH } },
    selectionPolicy: "Candidate selection is based on development/inner data. Nested outer OOS is not used to choose the final candidate. No candidate is added after results.",
  });
  await writeJson("v5-6-1-pit-universe.json", {
    ...base,
    status: pit.status,
    sourceManifestStatus: pit.sourceManifestStatus,
    source: pit.source,
    methodology: pit.methodology,
    limitations: pit.limitations,
    groups: groupRows.map((group) => ({ group: group.id, expectedSymbols: group.expectedSymbols, loadedSymbols: group.loadedSymbols, pitEligibleSymbolsAtStart: group.pitEligibleSymbolsAtStart, coveragePercent: group.localLoadedCoveragePercent, pitEligibleCoveragePercent: group.localPitEligibleCoveragePercent })),
    evidenceSymbolCount: pit.evidenceSymbols.length,
  });
  await writeJson("v5-6-1-external-validation.json", { ...base, manifest: externalManifest, result: externalValidation, dataReadAfterManifest: externalValidation.manifestFrozenBeforeData });
  await writeJson("v5-6-1-pareto-frontier.json", { ...base, definition: "non-dominated on nested outer OOS NetR, signal yield, and max drawdown", directions: { LONG: { selectedCandidate: long.finalCandidate?.id ?? null, frontier: long.pareto }, SHORT: { selectedCandidate: short.finalCandidate?.id ?? null, frontier: short.pareto } } });
  await writeJson("v5-6-1-walk-forward.json", {
    ...base,
    split: { developmentInnerSelection: true, nestedOuterOos: true, externalValidation: externalValidation.status, oosStart: new Date(oosStart).toISOString(), oosEnd: new Date(oosEnd).toISOString(), purgeHours: V561_PURGE_HOURS, holdoutExcluded: true },
    groups: groupRows,
    directions: { LONG: serializeWalkForward(long), SHORT: serializeWalkForward(short) },
  });
  await writeJson("v5-6-1-holdout.json", {
    ...base,
    status: "V56_HOLDOUT_BURNED_AFTER_RESEARCH_REVIEW",
    usage: "KNOWN_VALIDATION_DIAGNOSTIC only; not a new independent holdout and not used for selection or promotion",
    directions: { LONG: serializeHoldout(long), SHORT: serializeHoldout(short) },
    auditOfV56Report11Holdout: { reportedTradeCount: holdoutAudit.reportedTradeCount, rawRows: holdoutAudit.rawCount, uniqueRows: holdoutAudit.uniqueCount, duplicateRows: holdoutAudit.duplicateCount, duplicateKeys: holdoutAudit.duplicateKeys, metricsOnUniqueRows: serializeMetrics(calculateMetrics(holdoutAudit.uniqueRows)), status: holdoutAudit.status },
  });
  await writeJson("v5-6-1-cost-stress.json", { ...base, model: { feeRate: V561_FEE_RATE, baseSlippageBps: V561_BASE_SLIPPAGE_BPS, additionalSlippageOnly: true }, directions: { LONG: serializeCostStress(long), SHORT: serializeCostStress(short) } });
  await writeJson("v5-6-1-confidence.json", { ...base, distinction: "raw, block, symbol-cluster, fold-cluster, selection-adjusted and promotion LCB are separate fields", directions: { LONG: serializeConfidence(long), SHORT: serializeConfidence(short) } });
  const businessComparison = buildBusinessComparison(short, productionManifest, oosStart, oosEnd);
  await writeJson("v5-6-1-control-comparison.json", { ...base, controlA: { status: productionManifest.status ?? "DATA_UNAVAILABLE", manifestHash: productionManifest.manifestHash ?? null, exactReplay: productionManifest.status === "AVAILABLE", deduplication: "DATA_UNAVAILABLE because exact Production evidence is unavailable" }, controlB: { id: V561_CONTROL_B_ID, frozen: true, metrics: serializeMetrics(short.controlBMetrics), holdout: serializeMetrics(short.controlBHoldoutMetrics), dedupe: dedupeReport(states, "controlB"), nestedOuterOosDedupe: short.controlBOosDedupe, holdoutDedupe: short.controlBHoldoutDedupe }, directions: { LONG: serializeDirectionComparison(long), SHORT: serializeDirectionComparison(short) }, businessComparison, knownHoldout: { reportedTradeCount: holdoutAudit.reportedTradeCount, rawRows: holdoutAudit.rawCount, uniqueRows: holdoutAudit.uniqueCount, duplicateRows: holdoutAudit.duplicateCount, metricsOnUniqueRows: serializeMetrics(calculateMetrics(holdoutAudit.uniqueRows)) } });
  await writeFile(resolve(REPORT_DIR, "v5-6-1-promotion-decision.md"), renderPromotionDecision(long, short, productionManifest, externalValidation, pit, forward, businessComparison), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-6-1-executive-summary.md"), renderExecutiveSummary(long, short, productionManifest, externalValidation, pit), "utf8");
}

function serializeWalkForward(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    selectedCandidate: analysis.finalCandidate,
    candidateRows: analysis.rows.map((row) => ({ candidate: row.candidate, development: serializeMetrics(row.developmentMetrics), nestedOuterOos: serializeMetrics(row.nestedOosMetrics), postSelectionDiagnosticOos: serializeMetrics(calculateMetrics(row.postSelectionDiagnosticTrades)), deduplication: row.deduplication, yield: serializeYield(row.yield), holdout: "KNOWN_VALIDATION_DIAGNOSTIC", foldMetrics: row.foldMetrics.map((item) => ({ ...item, metrics: serializeMetrics(item.metrics) })) })),
    nestedSelectionRecords: analysis.nestedSelectionRecords,
    nestedSelectionDedupe: analysis.nestedSelectionDedupe,
    nestedSelectionAggregate: serializeMetrics(analysis.selectedNestedOosMetrics),
    selectedNestedOuterOos: serializeMetrics(analysis.selectedNestedOosMetrics),
    drift: analysis.drift.map((row) => ({ ...row, metrics: serializeMetrics(row.metrics) })),
    familyRows: analysis.familyRows.map((row) => {
      const candidateRow = analysis.rows.find((item) => item.candidate.id === row.candidate.id);
      const nestedTrades = candidateRow?.nestedOosTrades ?? [];
      return {
        ...row,
        developmentMetrics: serializeMetrics(row.developmentMetrics),
        nestedOosMetrics: serializeMetrics(row.nestedOosMetrics),
        nestedOosDedupe: candidateRow?.deduplication.nestedOuterOos ?? { rawRows: 0, uniqueRows: 0, duplicateRows: 0 },
        nestedOosYield: candidateRow ? serializeYield(candidateRow.yield) : null,
        nestedOosCvar95: roundResearch(calculateCvar95(nestedTrades)),
        nestedOosPlus10Bps: serializeMetrics(calculateMetrics(applyAdditionalSlippage(nestedTrades, 10))),
        nestedOosPlus15Bps: serializeMetrics(calculateMetrics(applyAdditionalSlippage(nestedTrades, 15))),
        symbolBreadth: candidateRow?.yield.symbolBreadth ?? 0,
        regimeBreadth: candidateRow?.yield.regimeBreadth ?? 0,
      };
    }),
  };
}

function serializeHoldout(analysis: DirectionAnalysis): Record<string, unknown> {
  return { selectedCandidate: analysis.finalCandidate, status: "V56_HOLDOUT_BURNED_AFTER_RESEARCH_REVIEW", usage: "KNOWN_VALIDATION_DIAGNOSTIC", rawRows: analysis.selectedHoldoutTrades.length, uniqueRows: analysis.selectedHoldoutTrades.length, metrics: serializeMetrics(analysis.selectedHoldoutMetrics) };
}

function serializeCostStress(analysis: DirectionAnalysis): Record<string, unknown> {
  return { selectedCandidate: analysis.finalCandidate?.id ?? null, primaryEvidence: "NESTED_OUTER_OOS", base: serializeMetrics(analysis.costStress.base), plus5Bps: serializeMetrics(analysis.costStress.plus5Bps), plus10Bps: serializeMetrics(analysis.costStress.plus10Bps), plus15Bps: serializeMetrics(analysis.costStress.plus15Bps), oneBarDelay: serializeMetrics(analysis.costStress.oneBarDelay), oneBarDelayDedupe: analysis.nestedSelectionDelayedDedupe };
}

function serializeConfidence(analysis: DirectionAnalysis): Record<string, unknown> {
  return { selectedCandidate: analysis.finalCandidate?.id ?? null, rawLcb95: roundResearch(analysis.confidence.rawLcb95), blockBootstrapLcb95: roundResearch(analysis.confidence.blockBootstrapLcb95), symbolClusterLcb95: roundResearch(analysis.confidence.symbolClusterLcb95), foldClusterLcb95: roundResearch(analysis.confidence.foldClusterLcb95), selectionAdjustedLcb95: roundResearch(analysis.confidence.selectionAdjustedLcb95), promotionLcb95: roundResearch(analysis.confidence.promotionLcb95), promotionMethod: analysis.confidence.promotionMethod, methods: analysis.confidence.audit.methods.map((method) => ({ ...method, lcb95: roundResearch(method.lcb95) })) };
}

function serializeDirectionComparison(analysis: DirectionAnalysis): Record<string, unknown> {
  return { selectedCandidate: analysis.finalCandidate?.id ?? null, nestedOos: serializeMetrics(analysis.selectedNestedOosMetrics), nestedSelectionDedupe: analysis.nestedSelectionDedupe, bestEnsemble: { componentFamilies: analysis.ensemble.componentFamilies, rawSignals: analysis.ensemble.rawSignals, uniqueSignals: analysis.ensemble.uniqueSignals, duplicateSignals: analysis.ensemble.duplicateSignals, metrics: serializeMetrics(analysis.ensemble.metrics), yield: serializeYield(analysis.ensemble.yield), marginalContributions: analysis.ensemble.marginalContributions.map((row) => ({ ...row, withFamily: serializeMetrics(row.withFamily), withoutFamily: serializeMetrics(row.withoutFamily), addedSignals: serializeMetrics(row.addedSignals) })) }, controlB: serializeMetrics(analysis.controlBMetrics), controlBOosDedupe: analysis.controlBOosDedupe, controlBHoldout: serializeMetrics(analysis.controlBHoldoutMetrics), controlBHoldoutDedupe: analysis.controlBHoldoutDedupe, drift: analysis.drift.map((row) => ({ ...row, metrics: serializeMetrics(row.metrics) })), promotion: analysis.promotion };
}

function buildBusinessComparison(short: DirectionAnalysis, productionManifest: ProductionControlManifest, start: number, end: number): BusinessComparison {
  const old = businessRow("Exact Old Production Control A", null, null, start, end, "DATA_UNAVAILABLE");
  const controlB = businessRow("V5.5 frozen Control B", short.controlBTrades, short.controlBMetrics, start, end, "AVAILABLE");
  const single = businessRow("V5.6.1 best single", short.selectedNestedOosTrades, short.selectedNestedOosMetrics, start, end, "NESTED_OUTER_OOS");
  const ensemble = businessRow("V5.6.1 best ensemble", short.ensemble.trades, short.ensemble.metrics, start, end, "NESTED_OUTER_OOS");
  return { status: "INCONCLUSIVE", reason: productionManifest.status === "AVAILABLE" ? "Exact Control A replay was not completed in this research run." : "Exact current Production configuration unavailable; research_defaults and older parity reports are not an exact replay substitute.", rows: [old, controlB, single, ensemble] };
}

function businessRow(label: string, trades: V561Trade[] | null, metrics: ValidationMetrics | null, start: number, end: number, evidenceStatus: string): Record<string, unknown> {
  const yieldMetrics = trades && metrics ? calculateYieldMetrics(trades, start, end) : null;
  const plus10 = trades && metrics ? calculateMetrics(applyAdditionalSlippage(trades, 10)) : null;
  const plus15 = trades && metrics ? calculateMetrics(applyAdditionalSlippage(trades, 15)) : null;
  return { label, evidenceStatus, trades: metrics?.trades ?? null, tradesPerYear: metrics ? metrics.trades / Math.max(1, (end - start + 1) / 86_400_000) * 365.25 : null, alertsPerWeek: yieldMetrics?.alertsPerWeek ?? null, activeMonthRatio: yieldMetrics?.activeMonthRatio ?? null, medianAlertsPerMonth: yieldMetrics?.medianAlertsPerMonth ?? null, p95SignalDroughtDays: yieldMetrics?.p95SignalDroughtDays ?? null, maxSignalDroughtDays: yieldMetrics?.maxSignalDroughtDays ?? null, annualizedNetR: metrics ? metrics.netR / Math.max(1, (end - start + 1) / 86_400_000) * 365.25 : null, avgR: metrics?.avgNetR ?? null, profitFactor: metrics?.profitFactor ?? null, maxDrawdownR: metrics?.maxDrawdownR ?? null, cvar95: trades ? calculateCvar95(trades) : null, stopRate: trades ? calculateStopRate(trades) : null, positiveMonths: metrics?.positiveMonths ?? null, plus10BpsNetR: plus10?.netR ?? null, plus15BpsNetR: plus15?.netR ?? null, nestedOos: evidenceStatus === "NESTED_OUTER_OOS", externalValidation: "DATA_UNAVAILABLE", promotionLcb95: null };
}

function calculateStopRate(trades: V561Trade[]): number | null {
  if (trades.length === 0) return null;
  return trades.filter((trade) => trade.exitReason === "STOP").length / trades.length;
}

function dedupeReport(states: Map<GroupId, GroupRunState>, type: "controlB"): Record<string, unknown> {
  const raw = [...states.values()].flatMap((state) => state[type === "controlB" ? "controlBTrades" : "controlBTrades"]);
  const dedupe = dedupeResearchTrades(raw);
  return { rawRows: dedupe.rawCount, uniqueRows: dedupe.uniqueCount, duplicateRows: dedupe.duplicateCount, duplicateKeys: dedupe.duplicateKeys };
}

function dedupeCounts<T extends V561Trade>(result: DedupeResult<T>): DedupeCounts {
  return { rawRows: result.rawCount, uniqueRows: result.uniqueCount, duplicateRows: result.duplicateCount };
}

function serializeMetrics(metrics: ValidationMetrics | null): Record<string, unknown> | null {
  if (!metrics) return null;
  return { trades: metrics.trades, wins: metrics.wins, losses: metrics.losses, winRate: roundMetric(metrics.winRate), netR: roundMetric(metrics.netR), avgR: roundMetric(metrics.avgNetR), profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null, maxDrawdownR: roundMetric(metrics.maxDrawdownR), lowerConfidenceBound95: roundMetric(metrics.lowerConfidenceBound95), positiveMonths: metrics.positiveMonths, months: metrics.months, positiveMonthRatio: roundMetric(metrics.positiveMonthRatio), topSymbolProfitShare: roundMetric(metrics.topSymbolProfitShare), topFoldProfitShare: roundMetric(metrics.topFoldProfitShare), totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt), totalFeesUsdt: roundMetric(metrics.totalFeesUsdt), totalFundingUsdt: roundMetric(metrics.totalFundingUsdt), totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt), monthly: metrics.monthly.map((month) => ({ ...month, netR: roundMetric(month.netR), profitFactor: Number.isFinite(month.profitFactor) ? roundMetric(month.profitFactor) : null, maxDrawdownR: roundMetric(month.maxDrawdownR) })) };
}

function serializeYield(value: YieldMetrics): Record<string, unknown> {
  return { calendarDays: roundResearch(value.calendarDays), calendarMonths: value.calendarMonths, alertsPerDay: roundResearch(value.alertsPerDay), alertsPerWeek: roundResearch(value.alertsPerWeek), alertsPerMonth: roundResearch(value.alertsPerMonth), activeMonthRatio: roundResearch(value.activeMonthRatio), medianAlertsPerMonth: roundResearch(value.medianAlertsPerMonth), p90SignalDroughtDays: roundResearch(value.p90SignalDroughtDays), p95SignalDroughtDays: roundResearch(value.p95SignalDroughtDays), maxSignalDroughtDays: roundResearch(value.maxSignalDroughtDays), symbolBreadth: value.symbolBreadth, regimeBreadth: value.regimeBreadth, signalsBySymbol: value.signalsBySymbol, signalsByRegime: value.signalsByRegime, positiveMonthRatio: roundResearch(value.positiveMonthRatio) };
}

function serializeAttritionStages(counts: AttritionCounts): Array<{ stage: string; count: number; passRate: number | null; incrementalAttritionRate: number | null }> {
  const ordered = Object.entries(counts) as Array<[keyof AttritionCounts, number]>;
  return ordered.map(([stage, count], index) => {
    const previous = index === 0 ? count : ordered[index - 1][1];
    return { stage, count, passRate: previous > 0 ? count / previous : null, incrementalAttritionRate: previous > 0 ? 1 - count / previous : null };
  });
}

function aggregateAttrition(states: Map<GroupId, GroupRunState>): AttritionCounts {
  const result = emptyAttrition();
  for (const state of states.values()) addAttrition(result, state.attrition);
  return result;
}

function roundResearch(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000;
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function renderPromotionDecision(long: DirectionAnalysis, short: DirectionAnalysis, production: ProductionControlManifest, external: ExternalValidationResult, pit: PitAudit, forward: ForwardDiagnostic, comparison: BusinessComparison): string {
  const render = (analysis: DirectionAnalysis): string[] => [
    `### ${analysis.side}`,
    `- Best single selected from development/inner data: **${analysis.finalCandidate?.id ?? "DATA_UNAVAILABLE"}**`,
    `- Nested outer OOS: ${analysis.selectedNestedOosMetrics.trades} trades, NetR ${formatMetric(analysis.selectedNestedOosMetrics.netR)}, AvgR ${formatMetric(analysis.selectedNestedOosMetrics.avgNetR)}, PF ${formatMetric(analysis.selectedNestedOosMetrics.profitFactor)}`,
    `- Confidence: raw ${formatMetric(analysis.confidence.rawLcb95)}, block ${formatMetric(analysis.confidence.blockBootstrapLcb95)}, symbol ${formatMetric(analysis.confidence.symbolClusterLcb95)}, fold ${formatMetric(analysis.confidence.foldClusterLcb95)}, selection-adjusted ${formatMetric(analysis.confidence.selectionAdjustedLcb95)}, promotion ${formatMetric(analysis.confidence.promotionLcb95)}`,
    `- Yield: ${analysis.yield ? `${formatMetric(analysis.yield.alertsPerWeek)}/week, ${formatMetric(analysis.yield.alertsPerMonth)}/month, active ${formatMetric(analysis.yield.activeMonthRatio)}, median ${formatMetric(analysis.yield.medianAlertsPerMonth)}, p95 drought ${formatMetric(analysis.yield.p95SignalDroughtDays)}, max ${formatMetric(analysis.yield.maxSignalDroughtDays)}` : "DATA_UNAVAILABLE"}`,
    `- Family edge: ${analysis.familyRows.map((row) => `${row.family}=${row.positiveHistoricalExpectancy ? "PASS" : "FAIL"}`).join(", ")}`,
    `- Ensemble: ${analysis.ensemble.componentFamilies.join(", ") || "DATA_UNAVAILABLE"}; ${analysis.ensemble.metrics.trades} canonical signals, NetR ${formatMetric(analysis.ensemble.metrics.netR)}`,
    `- Decision: **${analysis.promotion.status}**; gates: ${analysis.promotion.gates.map((gate) => `${gate.id}=${gate.passed ? "PASS" : "FAIL"}`).join(", ")}`,
  ];
  return [
    "# V5.6.1 Evidence Correctness + Multi-Edge Email Ensemble — Promotion Decision",
    "",
    `Research baseline: \`${V561_RESEARCH_BASELINE}\`; Production baseline: \`${V561_PRODUCTION_BASELINE}\``,
    `Control A manifest: ${production.status ?? "DATA_UNAVAILABLE"}; exact replay is not claimed when unavailable.`,
    `PIT: ${pit.status}; external validation: ${external.status} (${external.reason})`,
    `Forward #002: ${forward.status}; ${forward.reason}`,
    "",
    "## Evidence semantics",
    "A = development/inner selection. B = nested outer OOS used for the primary promotion estimate. C = external validation, frozen before reading results. The previously reviewed V5.6 holdout is burned and remains diagnostic only.",
    "",
    ...render(long),
    "",
    ...render(short),
    "",
    "## Business comparison",
    `- Verdict: **${comparison.status}**`,
    `- Reason: ${comparison.reason}`,
    `- Exact Old Production: ${String(comparison.rows[0]?.evidenceStatus ?? "DATA_UNAVAILABLE")}`,
    `- V5.5 Control B: ${String(comparison.rows[1]?.netR ?? "DATA_UNAVAILABLE")} NetR`,
    `- Best V5.6.1 single: ${String(comparison.rows[2]?.netR ?? "DATA_UNAVAILABLE")} NetR`,
    `- Best V5.6.1 ensemble: ${String(comparison.rows[3]?.netR ?? "DATA_UNAVAILABLE")} NetR`,
    "",
    "## Hard boundary",
    "- Production Email promotion: NO",
    "- Production strategy/env/code change: NO",
    "- V5.5 Forward #002 change: NO",
    "- Supabase migration/write/backfill: NO",
    "- Deployment/merge: NO",
  ].join("\n");
}

function renderExecutiveSummary(long: DirectionAnalysis, short: DirectionAnalysis, production: ProductionControlManifest, external: ExternalValidationResult, pit: PitAudit): string {
  return [
    "# V5.6.1 Evidence Correctness + Multi-Edge Email Ensemble — Executive Summary",
    "",
    `Control A provenance: ${production.status ?? "DATA_UNAVAILABLE"}; PIT: ${pit.status}; external validation: ${external.status}.`,
    `LONG: ${long.finalCandidate?.id ?? "DATA_UNAVAILABLE"}; nested OOS=${long.selectedNestedOosMetrics.trades}; decision=${long.promotion.status}.`,
    `SHORT: ${short.finalCandidate?.id ?? "DATA_UNAVAILABLE"}; nested OOS=${short.selectedNestedOosMetrics.trades}; decision=${short.promotion.status}.`,
    "",
    "The primary estimate is nested outer OOS. The prior V5.6 holdout is explicitly V56_HOLDOUT_BURNED_AFTER_RESEARCH_REVIEW / KNOWN_VALIDATION_DIAGNOSTIC. No Forward #002 future return is used for tuning or promotion.",
    "",
    "V5.6.1 remains research-only / SHADOW_ONLY. No Production Email promotion, strategy switch, migration, deployment, or merge is authorized.",
  ].join("\n");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
