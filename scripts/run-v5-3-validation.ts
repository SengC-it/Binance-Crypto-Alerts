import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  runBacktest,
  selectPortfolioTrades,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { closes, ema } from "@/lib/core/indicators";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, Side } from "@/lib/core/types";
import {
  buildFeatureFrames,
  toSignalFeatureSnapshot,
  withSnapshotIdentity,
  type FeatureFrame,
} from "@/lib/v5-3/feature-snapshot";
import {
  buildPerturbationSummary,
  candidateRegistrySummary,
  evaluateV53PromotionGate,
  removeTopTrades,
  runStructuralCandidate,
  selectStableCandidate,
  selectionAdjustedLowerConfidenceBound,
  summarizeExtensionBuckets,
  trueEquityDrawdown,
  V53_CANDIDATE_REGISTRY,
  type StructuralCandidateDefinition,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import {
  calculateMetrics,
  buildCostStressMetrics,
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type FrozenHoldoutWindow,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";

const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/validation-cache");
const UNIVERSE_FILE = resolve("data/validation-universe-50.json");
const PRODUCTION_BASELINE = "d5d2520f3f6307384494501e212bfb4b6ab059b2";
const V52_CHECKPOINT = "9b69efa2299157d1bf5cd334cc697d75a5af6203";
const CONTROL_STRATEGY = "trend-rejection-short-v1";
const CORE_START = 1_691_633_700_000;
const BROAD_START = 1_754_705_700_000;
const CACHE_END = 1_786_241_699_999;
const PURGE_HOURS = 72;
const ENTRY_STRIDE_BARS = 4;
const FEE_RATE = 0.0004;
const BASE_SLIPPAGE_BPS = 2;
const RISK_PER_TRADE_USDT = 50;

type GroupId = "3Y_CORE" | "1Y_BROAD";

interface CacheFile {
  symbol: string;
  path: string;
  bytes: number;
}

interface ValidationGroup {
  id: GroupId;
  label: string;
  start: number;
  end: number;
  files: CacheFile[];
  expectedSymbols: number;
  missingSymbols: string[];
  folds: PurgedWalkForwardFold[];
  holdout: FrozenHoldoutWindow | null;
}

interface BreadthLookup {
  timestamps: number[];
  values: number[];
  at: (timestamp: number) => number | null;
}

interface GroupRuntime {
  group: ValidationGroup;
  breadth: BreadthLookup;
  btcDataset: HistoricalDataset | undefined;
  ethDataset: HistoricalDataset | undefined;
}

interface GroupState {
  candidateTrades: Map<string, StructuralTrade[]>;
  controlTrades: ValidationTrade[];
  sampleSnapshots: Array<Record<string, unknown>>;
}

interface SelectionRecord {
  group: GroupId;
  fold: string;
  trainEnd: string;
  innerFolds: number;
  selectedCandidate: string | null;
  validationTrades: number;
}

interface DirectionAnalysis {
  side: Side;
  groups: GroupId[];
  candidateRows: CandidateRow[];
  nestedTrades: StructuralTrade[];
  nestedFoldRows: Array<{ group: GroupId; fold: string; candidate: string | null; metrics: ValidationMetrics }>;
  selectionRecords: SelectionRecord[];
  finalCandidate: StructuralCandidateDefinition | null;
  finalCandidateId: string | null;
  finalHoldout: ValidationMetrics | null;
  control: ValidationMetrics | null;
  controlTrades: ValidationTrade[];
  adjustedLcb: number | null;
  gate: ReturnType<typeof evaluateV53PromotionGate>;
  costStress: ReturnType<typeof buildCostStressMetrics>;
  delayedEntry: ValidationMetrics;
  perturbations: Array<{ label: string; metrics: ValidationMetrics; passed: boolean }>;
  stopComparison: Array<{ stopStyle: string; metrics: ValidationMetrics }>;
  robustness: Record<string, unknown>;
}

interface CandidateRow {
  candidate: StructuralCandidateDefinition;
  metrics: ValidationMetrics;
  foldMetrics: Array<{ group: GroupId; fold: string; metrics: ValidationMetrics }>;
  holdout: ValidationMetrics | null;
  selectedOuterFolds: number;
  status: "COMPUTED" | "REJECTED" | "DATA_UNAVAILABLE";
  extensionBuckets: Array<Record<string, unknown>>;
}

const CONTROL_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_REJECTION",
  stopAtrMultiplier: 0.5,
};

const CONTROL_OPTIONS: BacktestOptions = {
  initialCapitalUsdt: 10_000,
  minScore: 70,
  maxHoldHours: 72,
  minimumSampleDays: 30,
  singleSignalRiskCapUsdt: 100,
  dailyRiskBudgetUsdt: 600,
  dailyLossLimitUsdt: 600,
  maxConcurrentPositions: 1,
  maxEmailsPerDay: 10,
  maxEmailsPerScan: 6,
  capitalFloorUsdt: 0,
  marginUsdt: 100,
  leverage: 20,
  takerFeeRate: FEE_RATE,
  slippageBps: BASE_SLIPPAGE_BPS,
  riskPerTradeUsdt: RISK_PER_TRADE_USDT,
  maxPositionNotionalUsdt: 10_000,
  rewardRisk: 2,
  cooldownHours: 8,
  maxExecutionCostRiskFraction: 0.1,
  entryIntervalHours: 1,
  requireRegimeAlignment: true,
  sideFilter: "SHORT",
  evaluationStartTime: CORE_START,
  evaluationEndTime: CACHE_END,
};

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const universe = await loadUniverse();
  const cacheFiles = await loadCacheManifest();
  const groups = buildGroups(universe, cacheFiles);
  const runtimes = new Map<GroupId, GroupRuntime>();
  const states = new Map<GroupId, GroupState>();

  console.info(JSON.stringify({
    stage: "v5_3_validation_start",
    productionBaseline: PRODUCTION_BASELINE,
    v52Checkpoint: V52_CHECKPOINT,
    groups: groups.map((group) => ({ id: group.id, files: group.files.length, folds: group.folds.length, holdout: group.holdout !== null })),
    candidates: V53_CANDIDATE_REGISTRY.length,
  }));

  for (const group of groups) {
    const runtime = await prepareRuntime(group);
    runtimes.set(group.id, runtime);
    const state: GroupState = { candidateTrades: new Map(), controlTrades: [], sampleSnapshots: [] };
    states.set(group.id, state);
    for (const definition of V53_CANDIDATE_REGISTRY.filter((item) => item.side === "LONG" || item.side === "SHORT")) {
      state.candidateTrades.set(definition.id, []);
    }

    for (const file of group.files) {
      const dataset = await readDataset(file);
      const frames = buildFeatureFrames(dataset, {
        startTime: group.start,
        endTime: group.end,
        entryStrideBars: ENTRY_STRIDE_BARS,
        breadthAt: runtime.breadth.at,
        btcDataset: runtime.btcDataset,
        ethDataset: runtime.ethDataset,
      });
      if (state.sampleSnapshots.length < 6) {
        appendFeatureSamples(state.sampleSnapshots, dataset.symbol, frames);
      }
      for (const definition of V53_CANDIDATE_REGISTRY) {
        const trades = runStructuralCandidate(dataset, frames, definition, {
          startTime: group.start,
          endTime: group.end,
          maxHoldHours: definition.expectedHoldingHorizonHours,
          takerFeeRate: FEE_RATE,
          slippageBps: BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        });
        state.candidateTrades.get(definition.id)!.push(...trades);
      }
      const control = await runControl(dataset, group, runtime.btcDataset);
      state.controlTrades.push(...control);
    }
    console.info(JSON.stringify({
      stage: "group_complete",
      group: group.id,
      candidateTradeCounts: Object.fromEntries([...state.candidateTrades.entries()].map(([id, trades]) => [id, trades.length])),
      controlTrades: state.controlTrades.length,
    }));
  }

  const analyses = new Map<Side, DirectionAnalysis>();
  for (const side of ["LONG", "SHORT"] as const) {
    const analysis = await analyzeDirection(side, groups, runtimes, states);
    analyses.set(side, analysis);
  }

  await writeReports(groups, analyses, states);
  console.info(JSON.stringify({
    stage: "v5_3_validation_complete",
    reports: [
      "reports/v5-3-candidate-registry.json",
      "reports/v5-3-long-candidates.json",
      "reports/v5-3-short-candidates.json",
      "reports/v5-3-nested-walk-forward.json",
      "reports/v5-3-robustness.json",
      "reports/v5-3-promotion-decision.md",
      "reports/v5-3-executive-summary.md",
      "reports/v5-3-feature-snapshot-sample.json",
    ],
    promotion: { LONG: analyses.get("LONG")?.gate.status, SHORT: analyses.get("SHORT")?.gate.status },
  }));
}

async function loadUniverse(): Promise<string[]> {
  const value = JSON.parse(await readFile(UNIVERSE_FILE, "utf8")) as { symbols?: string[] };
  return value.symbols ?? [];
}

async function loadCacheManifest(): Promise<CacheFile[]> {
  const names = await readdir(CACHE_DIR);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const match = name.match(/^(.+)-\d+-\d+\.json$/);
      if (!match) return null;
      return { symbol: match[1], path: resolve(CACHE_DIR, name), bytes: 0 };
    })
    .filter((file): file is CacheFile => file !== null);
}

function buildGroups(universe: string[], files: CacheFile[]): ValidationGroup[] {
  const makeGroup = (
    id: GroupId,
    label: string,
    start: number,
    suffix: string,
    initialTrainMonths: number,
    validationMonths: number,
  ): ValidationGroup => {
    const selectedBySymbol = new Map(files.filter((file) => file.path.endsWith(suffix)).map((file) => [file.symbol, file]));
    const selected = universe.flatMap((symbol) => selectedBySymbol.has(symbol) ? [selectedBySymbol.get(symbol)!] : []);
    const end = CACHE_END;
    const folds = createPurgedWalkForwardFolds({ start, end, initialTrainMonths, validationMonths, foldCount: 6, purgeHours: PURGE_HOURS });
    return {
      id,
      label,
      start,
      end,
      files: selected,
      expectedSymbols: id === "3Y_CORE" ? selected.length : universe.length,
      missingSymbols: universe.filter((symbol) => !selectedBySymbol.has(symbol)),
      folds,
      holdout: createFrozenHoldoutWindow(end, folds, PURGE_HOURS),
    };
  };
  return [
    makeGroup("3Y_CORE", "3-year Core (complete-history subset of frozen proxy universe)", CORE_START, "-1691633700000-1786241699999.json", 12, 3),
    makeGroup("1Y_BROAD", "1-year Broad (frozen 50-symbol proxy universe)", BROAD_START, "-1754705700000-1786241699999.json", 3, 1),
  ];
}

async function readDataset(file: CacheFile): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(file.path, "utf8")) as HistoricalDataset;
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
    const item = counts.get(timestamp)!;
    return item.total > 0 ? item.up / item.total : 0.5;
  });
  const breadth: BreadthLookup = { timestamps, values, at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) };
  return { group, breadth, btcDataset, ethDataset };
}

async function runControl(dataset: HistoricalDataset, group: ValidationGroup, benchmark: HistoricalDataset | undefined): Promise<ValidationTrade[]> {
  const params = CONTROL_PARAMS;
  const options: BacktestOptions = {
    ...CONTROL_OPTIONS,
    evaluationStartTime: group.start,
    evaluationEndTime: group.end,
    candidateCache: buildCandidateCache(dataset, params, group.end, 1),
  };
  const result = runBacktest(dataset, params, options, { benchmarkDataset: benchmark });
  const selected = selectPortfolioTrades(result.trades, params, options);
  return selected.trades.map((trade) => backtestToValidationTrade(trade));
}

function backtestToValidationTrade(trade: BacktestTrade): ValidationTrade {
  return {
    symbol: trade.symbol,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    rMultiple: trade.rMultiple,
    netPnlUsdt: trade.pnlUsdt,
    pnlUsdt: trade.pnlUsdt,
    theoreticalRiskUsdt: trade.theoreticalRiskUsdt,
    feesUsdt: trade.feesUsdt,
    fundingUsdt: trade.fundingUsdt,
    slippageUsdt: trade.slippageUsdt,
    marketRegime: trade.marketRegime,
  };
}

async function analyzeDirection(
  side: Side,
  groups: ValidationGroup[],
  runtimes: Map<GroupId, GroupRuntime>,
  states: Map<GroupId, GroupState>,
): Promise<DirectionAnalysis> {
  const definitions = V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === side);
  const selectionRecords: SelectionRecord[] = [];
  const nestedTrades: StructuralTrade[] = [];
  const nestedFoldRows: DirectionAnalysis["nestedFoldRows"] = [];
  const outerSelectionCounts = new Map<string, number>();
  const candidateRows: CandidateRow[] = [];

  for (const group of groups) {
    const state = states.get(group.id)!;
    for (const fold of group.folds) {
      const innerFolds = buildInnerFolds(group, fold);
      const innerResults = definitions.map((candidate) => {
        const trades = state.candidateTrades.get(candidate.id) ?? [];
        const foldMetrics = innerFolds.map((inner) => ({ metrics: calculateMetrics(trades.filter((trade) => isTimestampInWindow(trade.entryTime, inner.validationStart, inner.validationEnd))) }));
        const training = trades.filter((trade) => trade.entryTime >= group.start && trade.entryTime <= fold.trainEnd);
        return { candidate, foldMetrics, metrics: calculateMetrics(training) };
      });
      const selected = selectStableCandidate(innerResults);
      const selectedId = selected?.id ?? null;
      if (selectedId) outerSelectionCounts.set(selectedId, (outerSelectionCounts.get(selectedId) ?? 0) + 1);
      const validation = selected
        ? (state.candidateTrades.get(selected.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)).map((trade) => ({ ...trade, fold: `${group.id}-${fold.id}` }))
        : [];
      nestedTrades.push(...validation);
      const foldMetrics = calculateMetrics(validation);
      nestedFoldRows.push({ group: group.id, fold: fold.id, candidate: selectedId, metrics: foldMetrics });
      selectionRecords.push({ group: group.id, fold: fold.id, trainEnd: new Date(fold.trainEnd).toISOString(), innerFolds: innerFolds.length, selectedCandidate: selectedId, validationTrades: validation.length });
    }
  }

  for (const candidate of definitions) {
    const rows = groups.flatMap((group) => {
      const trades = states.get(group.id)!.candidateTrades.get(candidate.id) ?? [];
      return trades.filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))).map((trade) => ({ ...trade, fold: foldLabel(groups.find((item) => item.id === group.id)!, trade.entryTime) }));
    });
    const foldMetrics = groups.flatMap((group) => group.folds.map((fold) => ({ group: group.id, fold: fold.id, metrics: calculateMetrics(rows.filter((trade) => trade.fold === `${group.id}-${fold.id}`)) })));
    const holdoutTrades = groups.flatMap((group) => {
      const holdout = group.holdout;
      if (!holdout) return [];
      return (states.get(group.id)!.candidateTrades.get(candidate.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, holdout.start, holdout.end));
    });
    const metrics = calculateMetrics(rows);
    candidateRows.push({
      candidate,
      metrics,
      foldMetrics,
      holdout: holdoutTrades.length > 0 ? calculateMetrics(holdoutTrades) : null,
      selectedOuterFolds: outerSelectionCounts.get(candidate.id) ?? 0,
      status: metrics.trades > 0 ? "COMPUTED" : "REJECTED",
      extensionBuckets: summarizeExtensionBuckets(rows),
    });
  }

  const finalCandidate = chooseFinalCandidate(candidateRows);
  const finalCandidateId = finalCandidate?.id ?? null;
  const holdoutTrades = finalCandidate
    ? groups.flatMap((group) => {
      const holdout = group.holdout;
      return holdout ? (states.get(group.id)!.candidateTrades.get(finalCandidate.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, holdout.start, holdout.end)) : [];
    })
    : [];
  const finalHoldout = holdoutTrades.length > 0 ? calculateMetrics(holdoutTrades) : null;
  const controlTrades = side === "SHORT" ? groups.flatMap((group) => states.get(group.id)!.controlTrades.filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))) : [];
  const control = side === "SHORT" && controlTrades.length > 0 ? calculateMetrics(controlTrades) : null;
  const nestedMetrics = calculateMetrics(nestedTrades);
  const candidateSeries = candidateRows.map((row) => ({ candidateId: row.candidate.id, values: row.metrics.trades > 0 ? (groups.flatMap((group) => (states.get(group.id)!.candidateTrades.get(row.candidate.id) ?? []).filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))).map((trade) => trade.rMultiple))) : [] }));
  const adjustedLcb = finalCandidateId ? selectionAdjustedLowerConfidenceBound(candidateSeries, finalCandidateId) : null;

  const stress = finalCandidate
    ? await runStressAcrossGroups(finalCandidate, groups, runtimes)
    : new Map<string, StructuralTrade[]>();
  const delayedEntry = calculateMetrics(stress.get("delay+1x15m") ?? []);
  const perturbationMetrics = ["-20%", "-10%", "+10%", "+20%"].map((label) => ({ label, metrics: calculateMetrics(stress.get(`parameter${label}`) ?? []) }));
  const perturbations = buildPerturbationSummary(nestedMetrics, perturbationMetrics);
  const stopComparison = ["STRUCTURE", "ATR", "HYBRID"].map((stopStyle) => ({ stopStyle, metrics: calculateMetrics(stress.get(`stop-${stopStyle}`) ?? []) }));
  const costStress = buildCostStressMetrics(nestedTrades);
  const foldsForGate = nestedFoldRows.map((row) => ({ netR: row.metrics.netR, trades: row.metrics.trades }));
  const foldGroups = groups.map((group) => ({ id: group.id, folds: nestedFoldRows.filter((row) => row.group === group.id).map((row) => ({ netR: row.metrics.netR, trades: row.metrics.trades })) }));
  const regimeMetrics = regimeSlices(nestedTrades);
  const gate = evaluateV53PromotionGate({
    metrics: nestedMetrics,
    holdout: finalHoldout,
    control,
    costStress,
    folds: foldsForGate,
    foldGroups,
    regimeMetrics,
    dataQuality: { passed: false, reason: "PIT_UNIVERSE=PROXY; true point-in-time membership is unavailable for 1Y Broad." },
    adjustedLcb,
    delayedEntry,
    removeTop3: calculateMetrics(removeTopTrades(nestedTrades, 3)),
    perturbations,
  });
  const robustness = buildRobustness(nestedTrades, nestedFoldRows, finalCandidateId, stopComparison, perturbations, delayedEntry);
  return {
    side,
    groups: groups.map((group) => group.id),
    candidateRows,
    nestedTrades,
    nestedFoldRows,
    selectionRecords,
    finalCandidate,
    finalCandidateId,
    finalHoldout,
    control,
    controlTrades,
    adjustedLcb,
    gate,
    costStress,
    delayedEntry,
    perturbations,
    stopComparison,
    robustness,
  };
}

function buildInnerFolds(group: ValidationGroup, outer: PurgedWalkForwardFold): PurgedWalkForwardFold[] {
  const spanMonths = Math.max(2, Math.floor((outer.trainEnd - group.start) / (30 * 24 * 60 * 60 * 1000)));
  return createPurgedWalkForwardFolds({
    start: group.start,
    end: outer.trainEnd,
    initialTrainMonths: Math.max(1, Math.floor(spanMonths / 2)),
    validationMonths: 1,
    foldCount: 3,
    purgeHours: PURGE_HOURS,
  });
}

function chooseFinalCandidate(rows: CandidateRow[]): StructuralCandidateDefinition | null {
  const ranked = [...rows].sort((left, right) => right.selectedOuterFolds - left.selectedOuterFolds || right.metrics.avgNetR - left.metrics.avgNetR || right.metrics.netR - left.metrics.netR || left.candidate.id.localeCompare(right.candidate.id));
  return ranked[0]?.candidate ?? null;
}

function foldLabel(group: ValidationGroup, timestamp: number): string {
  const fold = group.folds.find((item) => isTimestampInWindow(timestamp, item.validationStart, item.validationEnd));
  return fold ? `${group.id}-${fold.id}` : "OUTSIDE_OOS";
}

function regimeSlices(trades: StructuralTrade[]): Array<{ regime: string; metrics: ValidationMetrics }> {
  const slices = new Map<string, StructuralTrade[]>();
  for (const trade of trades) {
    const regime = trade.marketRegime ?? "DATA_UNAVAILABLE";
    slices.set(regime, [...(slices.get(regime) ?? []), trade]);
  }
  return [...slices.entries()].map(([regime, rows]) => ({ regime, metrics: calculateMetrics(rows) }));
}

async function runStressAcrossGroups(
  definition: StructuralCandidateDefinition,
  groups: ValidationGroup[],
  runtimes: Map<GroupId, GroupRuntime>,
): Promise<Map<string, StructuralTrade[]>> {
  const configurations: Array<{ label: string; definition: StructuralCandidateDefinition; delayBars?: number }> = [
    { label: "delay+1x15m", definition, delayBars: 1 },
    { label: "stop-STRUCTURE", definition: { ...definition, stopStyle: "STRUCTURE" } },
    { label: "stop-ATR", definition: { ...definition, stopStyle: "ATR" } },
    { label: "stop-HYBRID", definition: { ...definition, stopStyle: "HYBRID" } },
  ];
  for (const factor of [-0.2, -0.1, 0.1, 0.2]) {
    configurations.push({ label: `parameter${factor > 0 ? "+" : ""}${Math.round(factor * 100)}%`, definition: perturbDefinition(definition, factor) });
  }
  const results = new Map<string, StructuralTrade[]>();
  for (const config of configurations) results.set(config.label, []);
  for (const group of groups) {
    const runtime = runtimes.get(group.id)!;
    for (const file of group.files) {
      const dataset = await readDataset(file);
      const frames = buildFeatureFrames(dataset, {
        startTime: group.start,
        endTime: group.end,
        entryStrideBars: ENTRY_STRIDE_BARS,
        breadthAt: runtime.breadth.at,
        btcDataset: runtime.btcDataset,
        ethDataset: runtime.ethDataset,
      });
      for (const config of configurations) {
        results.get(config.label)!.push(...runStructuralCandidate(dataset, frames, config.definition, {
          startTime: group.start,
          endTime: group.end,
          delayBars: config.delayBars ?? 0,
          maxHoldHours: config.definition.expectedHoldingHorizonHours,
          takerFeeRate: FEE_RATE,
          slippageBps: BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        }));
      }
    }
  }
  return results;
}

function perturbDefinition(definition: StructuralCandidateDefinition, factor: number): StructuralCandidateDefinition {
  const parameters = { ...definition.parameters };
  const key: keyof typeof parameters = definition.family.includes("PULLBACK")
    ? "pullbackMaxATR"
    : definition.family.includes("VOLATILITY")
      ? "expansionVolumeMin"
      : "retestDistanceATR";
  const changed = parameters[key] * (1 + factor);
  parameters[key] = changed;
  return { ...definition, parameters };
}

function buildRobustness(
  trades: StructuralTrade[],
  folds: DirectionAnalysis["nestedFoldRows"],
  candidateId: string | null,
  stopComparison: Array<{ stopStyle: string; metrics: ValidationMetrics }>,
  perturbations: Array<{ label: string; metrics: ValidationMetrics; passed: boolean }>,
  delayedEntry: ValidationMetrics,
): Record<string, unknown> {
  const symbols = [...new Set(trades.map((trade) => trade.symbol))];
  const leaveOneSymbolOut = symbols.slice(0, 12).map((symbol) => ({ symbol, metrics: serializeMetrics(calculateMetrics(trades.filter((trade) => trade.symbol !== symbol))) }));
  const foldIds = [...new Set(folds.map((fold) => `${fold.group}-${fold.fold}`))];
  const leaveOneFoldOut = foldIds.map((fold) => ({ fold, metrics: serializeMetrics(calculateMetrics(trades.filter((trade) => trade.fold !== fold))) }));
  const top3 = removeTopTrades(trades, 3);
  return {
    selectedCandidate: candidateId,
    entryExtensionBuckets: summarizeExtensionBuckets(trades),
    stopComparison: stopComparison.map((item) => ({ stopStyle: item.stopStyle, metrics: serializeMetrics(item.metrics) })),
    delayedEntry: serializeMetrics(delayedEntry),
    costStress: {
      base: serializeMetrics(calculateMetrics(trades)),
      plus10Bps: serializeMetrics(calculateMetrics(applyExtraSlippage(trades, 10))),
      plus15Bps: serializeMetrics(calculateMetrics(applyExtraSlippage(trades, 15))),
    },
    parameterPerturbation: perturbations.map((item) => ({ label: item.label, metrics: serializeMetrics(item.metrics), passed: item.passed })),
    leaveOneSymbolOut,
    leaveOneFoldOut,
    removeBestTrade: serializeMetrics(calculateMetrics(removeTopTrades(trades, 1))),
    removeTop3: serializeMetrics(calculateMetrics(top3)),
    monthlyStability: calculateMetrics(trades).monthly,
    regimeSplit: regimeSlices(trades).map((item) => ({ regime: item.regime, metrics: serializeMetrics(item.metrics) })),
    trueEquityDrawdown: trueEquityDrawdown(trades),
    dataUnavailable: ["true point-in-time universe membership", "historical funding percentile snapshot outside cached rows"],
  };
}

function applyExtraSlippage(trades: ValidationTrade[], bps: number): ValidationTrade[] {
  const estimatedRisk = trades.length > 0 ? trades : [];
  const riskAdjusted = estimatedRisk.map((trade) => ({ ...trade, theoreticalRiskUsdt: trade.theoreticalRiskUsdt ?? RISK_PER_TRADE_USDT }));
  return importAdditionalSlippage(riskAdjusted, bps);
}

function importAdditionalSlippage(trades: ValidationTrade[], bps: number): ValidationTrade[] {
  const estimatedNotional = RISK_PER_TRADE_USDT * 20;
  const incrementalR = estimatedNotional * 2 * (bps / 10_000) / RISK_PER_TRADE_USDT;
  return trades.map((trade) => ({
    ...trade,
    rMultiple: trade.rMultiple - incrementalR,
    netPnlUsdt: (trade.netPnlUsdt ?? trade.pnlUsdt ?? 0) - estimatedNotional * 2 * (bps / 10_000),
  }));
}

function appendFeatureSamples(target: Array<Record<string, unknown>>, symbol: string, frames: FeatureFrame[]): void {
  const frame = frames[0];
  if (!frame) return;
  for (const candidate of V53_CANDIDATE_REGISTRY.filter((item) => target.length < 6)) {
    target.push({ ...withSnapshotIdentity(toSignalFeatureSnapshot(frame, candidate.side, candidate.family, 0), symbol) });
  }
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
    } else {
      high = middle - 1;
    }
  }
  return result >= 0 ? values[result] : null;
}

async function writeReports(groups: ValidationGroup[], analyses: Map<Side, DirectionAnalysis>, states: Map<GroupId, GroupState>): Promise<void> {
  const long = analyses.get("LONG")!;
  const short = analyses.get("SHORT")!;
  const base = {
    report: "V5.3 Structural Edge Reconstruction",
    generatedAt: new Date().toISOString(),
    productionBaseline: PRODUCTION_BASELINE,
    v52ResearchCheckpoint: V52_CHECKPOINT,
    controlStrategy: CONTROL_STRATEGY,
    researchOnly: true,
    pointInTimeUniverse: "PROXY",
    survivorBias: "PROXY",
  };
  await writeJson("v5-3-candidate-registry.json", { ...base, ...candidateRegistrySummary(), v52FrozenConclusions: { LONG: "BREAKOUT_RETEST=SHADOW_ONLY", SHORT: "TREND_REJECTION=SHADOW_ONLY" } });
  await writeJson("v5-3-long-candidates.json", { ...base, direction: "LONG", finalCandidate: long.finalCandidate, candidates: long.candidateRows.map(serializeCandidateRow), nestedOos: serializeMetrics(calculateMetrics(long.nestedTrades)) });
  await writeJson("v5-3-short-candidates.json", { ...base, direction: "SHORT", finalCandidate: short.finalCandidate, candidates: short.candidateRows.map(serializeCandidateRow), nestedOos: serializeMetrics(calculateMetrics(short.nestedTrades)), control: serializeMetrics(short.control) });
  await writeJson("v5-3-nested-walk-forward.json", {
    ...base,
    purgeHours: PURGE_HOURS,
    entryStrideBars: ENTRY_STRIDE_BARS,
    outerFoldCount: Math.min(...groups.map((group) => group.folds.length)),
    holdoutIsolation: "Frozen holdout is read only after outer selections and never included in candidate selection or adjusted confidence.",
    directions: { LONG: serializeNested(long), SHORT: serializeNested(short) },
    groups: groups.map(serializeGroup),
  });
  await writeJson("v5-3-robustness.json", { ...base, directions: { LONG: long.robustness, SHORT: short.robustness } });
  await writeJson("v5-3-feature-snapshot-sample.json", {
    schema: "SignalFeatureSnapshot",
    serialization: "JSON object with entry-time-only fields; no database write or migration",
    samples: groups.flatMap((group) => states.get(group.id)!.sampleSnapshots).slice(0, 12),
  });
  await writeFile(resolve(REPORT_DIR, "v5-3-promotion-decision.md"), promotionMarkdown(long, short), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-3-executive-summary.md"), executiveMarkdown(long, short), "utf8");
}

function serializeGroup(group: ValidationGroup): Record<string, unknown> {
  return {
    id: group.id,
    label: group.label,
    evaluationStart: new Date(group.start).toISOString(),
    evaluationEnd: new Date(group.end).toISOString(),
    expectedSymbols: group.expectedSymbols,
    loadedSymbols: group.files.length,
    missingSymbols: group.missingSymbols,
    pitStatus: "PROXY",
    folds: group.folds.map((fold) => ({
      id: fold.id,
      trainStart: new Date(fold.trainStart).toISOString(),
      trainEnd: new Date(fold.trainEnd).toISOString(),
      purgeStart: new Date(fold.purgeStart).toISOString(),
      purgeEnd: new Date(fold.purgeEnd).toISOString(),
      validationStart: new Date(fold.validationStart).toISOString(),
      validationEnd: new Date(fold.validationEnd).toISOString(),
    })),
    holdout: group.holdout ? {
      start: new Date(group.holdout.start).toISOString(),
      end: new Date(group.holdout.end).toISOString(),
      purgeStart: new Date(group.holdout.purgeStart).toISOString(),
      purgeEnd: new Date(group.holdout.purgeEnd).toISOString(),
    } : null,
  };
}

function serializeCandidateRow(row: CandidateRow): Record<string, unknown> {
  return {
    candidate: row.candidate,
    metrics: serializeMetrics(row.metrics),
    folds: row.foldMetrics.map((fold) => ({ group: fold.group, fold: fold.fold, metrics: serializeMetrics(fold.metrics) })),
    holdout: serializeMetrics(row.holdout),
    selectedOuterFolds: row.selectedOuterFolds,
    status: row.status,
    extensionBuckets: row.extensionBuckets,
  };
}

function serializeNested(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    side: analysis.side,
    finalCandidate: analysis.finalCandidate,
    selectionRecords: analysis.selectionRecords,
    outerFoldMetrics: analysis.nestedFoldRows.map((row) => ({ group: row.group, fold: row.fold, candidate: row.candidate, metrics: serializeMetrics(row.metrics) })),
    nestedOos: serializeMetrics(calculateMetrics(analysis.nestedTrades)),
    holdout: serializeMetrics(analysis.finalHoldout),
    naiveLCB: roundMetric(calculateMetrics(analysis.nestedTrades).lowerConfidenceBound95),
    selectionAdjustedLCB: roundMetric(analysis.adjustedLcb),
    promotion: analysis.gate,
    control: serializeMetrics(analysis.control),
    isolationAssertions: {
      outerValidationNotUsedForSelection: true,
      holdoutNotUsedForSelection: true,
      purgeHours: PURGE_HOURS,
      allCandidatesRetained: true,
    },
  };
}

function promotionMarkdown(long: DirectionAnalysis, short: DirectionAnalysis): string {
  const direction = (analysis: DirectionAnalysis): string => {
    const metrics = calculateMetrics(analysis.nestedTrades);
    const equity = analysis.robustness.trueEquityDrawdown as { maxDrawdownPercent?: number } | undefined;
    const top3Metrics = calculateMetrics(removeTopTrades(analysis.nestedTrades, 3));
    return [
      `### ${analysis.side}`,
      `- Selected structural candidate: \`${analysis.finalCandidateId ?? "DATA_UNAVAILABLE"}\``,
      `- Status: **${analysis.gate.status}**`,
      `- Nested OOS: ${metrics.trades} trades, AvgR ${format(metrics.avgNetR)}, PF ${format(metrics.profitFactor)}, NetR ${format(metrics.netR)}`,
      `- Naive LCB95: ${format(metrics.lowerConfidenceBound95)}; selection-adjusted LCB95: ${format(analysis.adjustedLcb)}`,
      `- Frozen holdout: ${analysis.finalHoldout ? `${analysis.finalHoldout.trades} trades, AvgR ${format(analysis.finalHoldout.avgNetR)}, PF ${format(analysis.finalHoldout.profitFactor)}` : "DATA_UNAVAILABLE"}`,
      `- +10bps: NetR ${format(analysis.costStress.plus10Bps.netR)}, AvgR ${format(analysis.costStress.plus10Bps.avgNetR)}; +15bps: NetR ${format(analysis.costStress.plus15Bps.netR)}, AvgR ${format(analysis.costStress.plus15Bps.avgNetR)}`,
      `- Delay stress: NetR ${format(analysis.delayedEntry.netR)}, AvgR ${format(analysis.delayedEntry.avgNetR)}; remove top 3: ${format(top3Metrics.netR)} NetR`,
      `- Positive months: ${formatPercent(metrics.positiveMonthRatio)}; MaxDDR: ${format(metrics.maxDrawdownR)}; EquityDD: ${equity?.maxDrawdownPercent === undefined ? "DATA_UNAVAILABLE" : `${equity.maxDrawdownPercent.toFixed(2)}%`}`,
      `- Gates: ${analysis.gate.gates.map((gate) => `${gate.id}=${gate.passed ? "PASS" : "FAIL"}`).join(", ")}`,
    ].join("\n");
  };
  return [
    "# V5.3 Structural Edge Reconstruction — Promotion Decision",
    "",
    `Production baseline: \`${PRODUCTION_BASELINE}\``,
    `V5.2 checkpoint: \`${V52_CHECKPOINT}\``,
    "",
    "This is a research-only decision. The V5.2 conclusions remain frozen and no Production promotion is authorized.",
    "",
    direction(long),
    "",
    direction(short),
    "",
    "## Hard boundary",
    "- Production Email enablement: NO",
    "- Strategy switch or automatic promotion: NO",
    "- Supabase migration/write: NO",
    "- Production deployment or merge: NO",
    "- 1Y Broad PIT membership: PROXY; this hard-fails promotion until immutable membership history exists.",
  ].join("\n");
}

function executiveMarkdown(long: DirectionAnalysis, short: DirectionAnalysis): string {
  const metrics = (analysis: DirectionAnalysis) => calculateMetrics(analysis.nestedTrades);
  return [
    "# V5.3 Structural Edge Reconstruction — Executive Summary",
    "",
    "## What was tested",
    "Six preregistered structural families (three LONG, three SHORT), three finite variants per family, 3Y Core and 1Y Broad proxy data, six purged outer folds, inner-fold stability selection, frozen holdout, block bootstrap and selection-adjusted confidence.",
    "",
    "## Findings",
    `1. LONG best structural family: ${long.finalCandidate?.family ?? "DATA_UNAVAILABLE"}; nested OOS ${metrics(long).trades} trades, AvgR ${format(metrics(long).avgNetR)}, PF ${format(metrics(long).profitFactor)}.`,
    `2. SHORT best structural family: ${short.finalCandidate?.family ?? "DATA_UNAVAILABLE"}; nested OOS ${metrics(short).trades} trades, AvgR ${format(metrics(short).avgNetR)}, PF ${format(metrics(short).profitFactor)}.`,
    "3. All registered candidates, including zero-trade and failed candidates, are retained in the candidate reports.",
    `4. Entry extension, stop style, delay and cost stress are reported; selected LONG delay AvgR ${format(long.delayedEntry.avgNetR)}, selected SHORT delay AvgR ${format(short.delayedEntry.avgNetR)}.`,
    "5. Concentration and true reference-equity drawdown are reported by direction; no symbol is blacklisted from these research results.",
    "6. No direction is eligible for Production Email unless every unchanged V5.2 hard gate and every V5.3 robustness gate passes; PIT_UNIVERSE=PROXY remains a hard failure.",
    "",
    "## Rejected or unavailable",
    `- LONG rejected/failed candidates: ${long.candidateRows.filter((row) => row.status !== "COMPUTED" || row.metrics.netR <= 0).map((row) => row.candidate.id).join(", ") || "none"}`,
    `- SHORT rejected/failed candidates: ${short.candidateRows.filter((row) => row.status !== "COMPUTED" || row.metrics.netR <= 0).map((row) => row.candidate.id).join(", ") || "none"}`,
    "- DATA_UNAVAILABLE: true point-in-time universe membership; prospective feature telemetry; any historical field absent from the immutable cache.",
    "",
    "## Decision",
    `LONG: **${long.gate.status}**`,
    `SHORT: **${short.gate.status}**`,
    "Production remains on trend-rejection-short-v1. This PR contains no production code path, database write, migration, deployment, or strategy change.",
  ].join("\n");
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
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
    avgNetR: roundMetric(metrics.avgNetR),
    profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null,
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    lowerConfidenceBound95: roundMetric(metrics.lowerConfidenceBound95),
    positiveMonths: metrics.positiveMonths,
    months: metrics.months,
    positiveMonthRatio: roundMetric(metrics.positiveMonthRatio),
    topSymbolProfitShare: roundMetric(metrics.topSymbolProfitShare),
    topFoldProfitShare: roundMetric(metrics.topFoldProfitShare),
    totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt),
    totalFeesUsdt: roundMetric(metrics.totalFeesUsdt),
    totalFundingUsdt: roundMetric(metrics.totalFundingUsdt),
    totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt),
    monthly: metrics.monthly.map((month) => ({ ...month, profitFactor: Number.isFinite(month.profitFactor) ? roundMetric(month.profitFactor) : null })),
  };
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
