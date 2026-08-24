import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  runBacktest,
  selectPortfolioTrades,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import {
  atr,
  closes,
  ema,
  latest,
  rsi,
  volumeRatio,
} from "@/lib/core/indicators";
import { classifyRegime } from "@/lib/core/market-regime";
import { DEFAULT_STRATEGY_PARAMS, type EntryMode, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, Instrument, MarketRegime, ScoredCandidate, Side } from "@/lib/core/types";
import {
  applyAdditionalSlippage,
  buildCostStressMetrics,
  calculateMetrics,
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
  evaluatePromotionGate,
  isHoldoutExcludedFromSelection,
  isTimestampInWindow,
  roundMetric,
  summarizeAttrition,
  type AttritionObservation,
  type CostStressMetrics,
  type FrozenHoldoutWindow,
  type PromotionGateResult,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";

const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/validation-cache");
const UNIVERSE_FILE = resolve("data/validation-universe-50.json");
const CONTROL_EVIDENCE_FILE = resolve(REPORT_DIR, "v5-2-prospective-control.json");
const CORE_START = 1_691_633_700_000;
const BROAD_START = 1_754_705_700_000;
const CACHE_END = 1_786_241_699_999;
const CONTROL_STRATEGY_VERSION = "trend-rejection-short-v1";
const CONTROL_BASE_SHA = "d5d2520f3f6307384494501e212bfb4b6ab059b2";
const PURGE_HOURS = 72;
const MIN_SCORE = 70;
const FEE_RATE = 0.0004;
const BASE_SLIPPAGE_BPS = 2;
const MAX_HOLD_HOURS = 72;
const RISK_PER_TRADE_USDT = 50;
const STAGE_NAMES = [
  "RAW_TRIGGER",
  "ENTRY_LOCATION",
  "SETUP_QUALITY",
  "REVERSAL_RISK",
  "BTC_ETH_CONFIRMATION",
  "MARKET_BREADTH",
  "MOMENTUM_EXHAUSTION",
  "EXPECTED_EDGE",
  "COST_FUNDING",
  "FINAL_ELIGIBLE",
] as const;

type GroupId = "3Y_CORE" | "1Y_BROAD";
type StrategyVariantId = "CONTROL" | "TREND_PULLBACK" | "TREND_REJECTION" | "BREAKOUT_RETEST" | "COMPRESSION_BREAKOUT" | "RANGE_RECLAIM";

interface CacheFile {
  symbol: string;
  path: string;
  sha256: string;
  bytes: number;
  quality: DatasetQuality;
}

interface DatasetQuality {
  duplicateCandles: number;
  missing15mIntervals: number;
  missing1hIntervals: number;
  missing4hIntervals: number;
  timestampMisalignments: number;
  futureLeakage: boolean;
  fundingOutOfRange: number;
  listingDateMismatch: boolean;
  symbolContinuity: boolean;
  first15mCloseTime: number | null;
  last15mCloseTime: number | null;
}

interface ValidationGroup {
  id: GroupId;
  label: string;
  start: number;
  end: number;
  files: CacheFile[];
  expectedSymbols: number;
  universeSymbols: string[];
  missingSymbols: string[];
  folds: PurgedWalkForwardFold[];
  holdout: FrozenHoldoutWindow | null;
}

interface StrategyVariant {
  id: StrategyVariantId;
  mode: EntryMode;
  description: string;
  params: StrategyParams;
  family: "TREND" | "BREAKOUT" | "MEAN_REVERSION";
}

interface GroupVariantRun {
  groupId: GroupId;
  variantId: StrategyVariantId;
  tradesBySide: Record<Side, BacktestTrade[]>;
  rawTradesBySide: Record<Side, BacktestTrade[]>;
  candidateCountBySide: Record<Side, number>;
  candidateObservations?: AttritionObservation[];
}

interface EvaluatedRun {
  groupId: GroupId;
  variantId: StrategyVariantId;
  side: Side;
  development: ValidationMetrics;
  oos: ValidationMetrics;
  oosTrades: ValidationTrade[];
  foldMetrics: Array<{ fold: string; metrics: ValidationMetrics }>;
  holdout: ValidationMetrics | null;
  holdoutTrades: ValidationTrade[];
  costStress: CostStressMetrics;
}

interface ControlEvidence {
  evidence_type: string;
  query_timestamp: string;
  source_table: string;
  strategy_version: string;
  extraction_query: string;
  methodology: string;
  row_count: number;
  first_entry_time: string;
  last_entry_time: string;
  sha256: string;
  summary: {
    wins: number;
    avg_r: number;
    stop_losses: number;
    exit_reasons: Record<string, number>;
    net_pnl_usdt: number;
    profit_factor: number;
    settled_trades: number;
  };
  rows: Array<Record<string, unknown>>;
}

interface SnapshotDiagnostics {
  symbol: string;
  entryTime: string;
  exitTime: string;
  exitReason: string;
  rMultiple: number;
  available: Record<string, number | string | boolean | null>;
  unavailable: string[];
}

interface AttritionPerformance {
  stage: string;
  side: Side;
  passedCandidates: number;
  rejectedCandidates: number;
  passedBacktest: ValidationMetrics | null;
  rejectedBacktest: ValidationMetrics | null;
  status: "COMPUTED" | "DATA_UNAVAILABLE";
}

const BASE_OPTIONS: BacktestOptions = {
  initialCapitalUsdt: 10_000,
  minScore: MIN_SCORE,
  maxHoldHours: MAX_HOLD_HOURS,
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
};

const VARIANTS: StrategyVariant[] = [
  {
    id: "CONTROL",
    mode: "TREND_REJECTION",
    description: "Frozen Production control: trend rejection, SHORT evaluated independently.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION", stopAtrMultiplier: 0.5 },
    family: "TREND",
  },
  {
    id: "TREND_PULLBACK",
    mode: "TREND_PULLBACK",
    description: "V5.2 research candidate: multi-timeframe pullback continuation.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_PULLBACK", stopAtrMultiplier: 0.5 },
    family: "TREND",
  },
  {
    id: "TREND_REJECTION",
    mode: "TREND_REJECTION",
    description: "V5.2 research candidate: independently measured trend rejection.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION", stopAtrMultiplier: 0.5 },
    family: "TREND",
  },
  {
    id: "BREAKOUT_RETEST",
    mode: "BREAKOUT_RETEST",
    description: "V5.2 research candidate: breakout and retest continuation.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "BREAKOUT_RETEST", stopAtrMultiplier: 0.5 },
    family: "BREAKOUT",
  },
  {
    id: "COMPRESSION_BREAKOUT",
    mode: "COMPRESSION_BREAKOUT",
    description: "V5.2 research candidate: compressed range breakout.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "COMPRESSION_BREAKOUT", stopAtrMultiplier: 0.5 },
    family: "BREAKOUT",
  },
  {
    id: "RANGE_RECLAIM",
    mode: "RANGE_RECLAIM",
    description: "V5.2 research candidate: range reclaim / mean-reversion setup.",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "RANGE_RECLAIM", stopAtrMultiplier: 0.5 },
    family: "MEAN_REVERSION",
  },
];

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const universe = await loadUniverse();
  const cacheFiles = await loadCacheFileManifest();
  const groups = buildGroups(universe, cacheFiles);
  console.info(JSON.stringify({
    stage: "v5_2_validation_start",
    productionBase: CONTROL_BASE_SHA,
    controlStrategy: CONTROL_STRATEGY_VERSION,
    groups: groups.map((group) => ({
      id: group.id,
      files: group.files.length,
      expectedSymbols: group.expectedSymbols,
      missingSymbols: group.missingSymbols,
      folds: group.folds.length,
      holdout: group.holdout,
    })),
  }));

  const groupRuns = new Map<string, GroupVariantRun>();
  for (const group of groups) {
    for (const variant of VARIANTS) {
      const run = await runVariantAcrossGroup(group, variant);
      groupRuns.set(runKey(group.id, variant.id), run);
      console.info(JSON.stringify({
        stage: "variant_complete",
        group: group.id,
        variant: variant.id,
        longTrades: run.tradesBySide.LONG.length,
        shortTrades: run.tradesBySide.SHORT.length,
        longCandidates: run.candidateCountBySide.LONG,
        shortCandidates: run.candidateCountBySide.SHORT,
      }));
    }
  }

  const broadGroup = groups.find((group) => group.id === "1Y_BROAD");
  const coreGroup = groups.find((group) => group.id === "3Y_CORE");
  const summary = await buildValidationSummary(groups, groupRuns, broadGroup, coreGroup);
  const attrition = await buildAttritionReport(groups, groupRuns, broadGroup, coreGroup);
  const degradation = await buildDegradationReport(cacheFiles, groups);
  await writeReports(summary, attrition, degradation, groups, cacheFiles);
  console.info(JSON.stringify({ stage: "v5_2_validation_complete", reports: [
    "reports/v5-2-production-degradation.md",
    "reports/v5-2-filter-attrition.json",
    "reports/v5-2-validation-summary.json",
    "reports/v5-2-promotion-decision.md",
  ] }));
}

async function loadUniverse(): Promise<string[]> {
  const raw = JSON.parse(await readFile(UNIVERSE_FILE, "utf8")) as { symbols?: string[] };
  return raw.symbols ?? [];
}

async function loadCacheFileManifest(): Promise<CacheFile[]> {
  const names = (await readdir(CACHE_DIR)).filter((name) => name.endsWith(".json"));
  const files: CacheFile[] = [];
  for (const name of names) {
    const match = name.match(/^(.+)-\d+-\d+\.json$/);
    if (!match) continue;
    const path = resolve(CACHE_DIR, name);
    const content = await readFile(path);
    const dataset = JSON.parse(content.toString()) as HistoricalDataset;
    files.push({
      symbol: match[1],
      path,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      quality: inspectDatasetQuality(dataset),
    });
  }
  return files;
}

function inspectDatasetQuality(dataset: HistoricalDataset): DatasetQuality {
  const fifteen = inspectCandleSeries(dataset.candles["15m"], 15 * 60 * 1000);
  const oneHour = inspectCandleSeries(dataset.candles["1h"] ?? [], 60 * 60 * 1000);
  const fourHour = inspectCandleSeries(dataset.candles["4h"] ?? [], 4 * 60 * 60 * 1000);
  const firstOpenTime = dataset.candles["15m"][0]?.openTime ?? null;
  const lastCloseTime = dataset.candles["15m"].at(-1)?.closeTime ?? null;
  const fundingOutOfRange = (dataset.fundingRates ?? []).filter((point) => (
    firstOpenTime !== null
    && lastCloseTime !== null
    && (point.fundingTime < firstOpenTime - 8 * 60 * 60 * 1000 || point.fundingTime > lastCloseTime + 8 * 60 * 60 * 1000)
  )).length;
  const listingDateMismatch = dataset.instrument.onboardDate !== undefined
    && firstOpenTime !== null
    && firstOpenTime < dataset.instrument.onboardDate - 15 * 60 * 1000;
  return {
    duplicateCandles: fifteen.duplicates + oneHour.duplicates + fourHour.duplicates,
    missing15mIntervals: fifteen.missing,
    missing1hIntervals: oneHour.missing,
    missing4hIntervals: fourHour.missing,
    timestampMisalignments: fifteen.misaligned + oneHour.misaligned + fourHour.misaligned,
    futureLeakage: lastCloseTime !== null && lastCloseTime > CACHE_END + 15 * 60 * 1000,
    fundingOutOfRange,
    listingDateMismatch,
    symbolContinuity: fifteen.duplicates === 0 && fifteen.misaligned === 0 && listingDateMismatch === false,
    first15mCloseTime: firstOpenTime === null ? null : firstOpenTime + 15 * 60 * 1000 - 1,
    last15mCloseTime: lastCloseTime,
  };
}

function inspectCandleSeries(candles: Candle[], interval: number): { duplicates: number; missing: number; misaligned: number } {
  const sorted = [...candles].sort((left, right) => left.openTime - right.openTime);
  const seen = new Set<number>();
  let duplicates = 0;
  let missing = 0;
  let misaligned = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const candle = sorted[index];
    if (seen.has(candle.openTime)) duplicates += 1;
    seen.add(candle.openTime);
    if (candle.closeTime - candle.openTime !== interval - 1) misaligned += 1;
    const previous = sorted[index - 1];
    if (previous) {
      const gap = candle.openTime - previous.openTime;
      if (gap > interval) missing += Math.floor(gap / interval) - 1;
    }
  }
  return { duplicates, missing, misaligned };
}

function buildGroups(universeSymbols: string[], files: CacheFile[]): ValidationGroup[] {
  const makeGroup = (id: GroupId, label: string, start: number, suffix: string, initialTrainMonths: number, validationMonths: number) => {
    const available = new Map(files
      .filter((file) => file.path.endsWith(suffix))
      .map((file) => [file.symbol, file]));
    const selected = universeSymbols.flatMap((symbol) => {
      const file = available.get(symbol);
      return file ? [file] : [];
    });
    const missingSymbols = universeSymbols.filter((symbol) => !available.has(symbol));
    const expectedSymbols = id === "3Y_CORE" ? selected.length : universeSymbols.length;
    const end = suffix.includes(`${CACHE_END}`) ? CACHE_END : 1_786_240_799_999;
    const folds = createPurgedWalkForwardFolds({
      start,
      end,
      initialTrainMonths,
      validationMonths,
      foldCount: 6,
      purgeHours: PURGE_HOURS,
    });
    return {
      id,
      label,
      start,
      end,
      files: selected,
      expectedSymbols,
      universeSymbols,
      missingSymbols,
      folds,
      holdout: createFrozenHoldoutWindow(end, folds, PURGE_HOURS),
    } satisfies ValidationGroup;
  };
  return [
    makeGroup("3Y_CORE", "3-year Core (complete-history subset of frozen proxy universe)", CORE_START, "-1691633700000-1786241699999.json", 12, 3),
    makeGroup("1Y_BROAD", "1-year Broad (frozen 50-symbol proxy universe)", BROAD_START, "-1754705700000-1786241699999.json", 3, 1),
  ];
}

function runKey(groupId: GroupId, variantId: StrategyVariantId): string {
  return `${groupId}:${variantId}`;
}

async function readDataset(file: CacheFile): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(file.path, "utf8")) as HistoricalDataset;
}

async function runVariantAcrossGroup(
  group: ValidationGroup,
  variant: StrategyVariant,
): Promise<GroupVariantRun> {
  const rawTradesBySide: Record<Side, BacktestTrade[]> = { LONG: [], SHORT: [] };
  const candidateCountBySide: Record<Side, number> = { LONG: 0, SHORT: 0 };
  const candidateObservations: AttritionObservation[] = [];
  let benchmark: HistoricalDataset | undefined;
  const orderedFiles = [...group.files].sort((left, right) => (left.symbol === "BTCUSDT" ? -1 : right.symbol === "BTCUSDT" ? 1 : left.symbol.localeCompare(right.symbol)));

  for (const file of orderedFiles) {
    const dataset = await readDataset(file);
    if (file.symbol === "BTCUSDT") benchmark = dataset;
    const cache = buildCandidateCache(dataset, variant.params, group.end, 1);
    if (variant.id !== "CONTROL" && group.id === "1Y_BROAD") {
      collectAttritionObservations(candidateObservations, cache, dataset, group, benchmark);
    }
    for (const side of ["LONG", "SHORT"] as const) {
      const sideOptions: BacktestOptions = {
        ...BASE_OPTIONS,
        sideFilter: side,
        strategyFamilies: [variant.family],
        evaluationStartTime: group.start,
        evaluationEndTime: group.end,
        candidateCache: cache,
      };
      const result = runBacktest(dataset, variant.params, sideOptions, { benchmarkDataset: benchmark });
      rawTradesBySide[side].push(...result.trades);
      candidateCountBySide[side] += [...cache.values()]
        .flat()
        .filter((candidate) => candidate.side === side && candidate.strategyFamily === variant.family).length;
    }
  }

  const tradesBySide: Record<Side, BacktestTrade[]> = { LONG: [], SHORT: [] };
  for (const side of ["LONG", "SHORT"] as const) {
    const selected = selectPortfolioTrades(rawTradesBySide[side], variant.params, {
      ...BASE_OPTIONS,
      sideFilter: side,
      strategyFamilies: [variant.family],
      evaluationStartTime: group.start,
      evaluationEndTime: group.end,
    });
    tradesBySide[side] = selected.trades;
  }
  return {
    groupId: group.id,
    variantId: variant.id,
    tradesBySide,
    rawTradesBySide,
    candidateCountBySide,
    candidateObservations: candidateObservations.length > 0 ? candidateObservations : undefined,
  };
}

function evaluateGroupRun(
  group: ValidationGroup,
  run: GroupVariantRun,
  side: Side,
): EvaluatedRun {
  const trades = run.tradesBySide[side] as ValidationTrade[];
  const firstFold = group.folds[0];
  const development = calculateMetrics(firstFold
    ? trades.filter((trade) => trade.entryTime <= firstFold.trainEnd)
    : []);
  const oosTrades = trades.filter((trade) => group.folds.some((fold) => (
    isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)
  )));
  const foldMetrics = group.folds.map((fold) => ({
    fold: fold.id,
    metrics: calculateMetrics(trades.filter((trade) => isTimestampInWindow(
      trade.entryTime,
      fold.validationStart,
      fold.validationEnd,
    ))),
  }));
  const holdoutTrades = group.holdout
    ? trades.filter((trade) => isTimestampInWindow(trade.entryTime, group.holdout!.start, group.holdout!.end))
    : [];
  const foldByTrade = new Map<ValidationTrade, string>();
  for (const trade of oosTrades) {
    const fold = group.folds.find((item) => isTimestampInWindow(trade.entryTime, item.validationStart, item.validationEnd));
    if (fold) foldByTrade.set(trade, fold.id);
  }
  return {
    groupId: group.id,
    variantId: run.variantId,
    side,
    development,
    oos: calculateMetrics(oosTrades, { foldByTrade }),
    oosTrades,
    foldMetrics,
    holdout: group.holdout ? calculateMetrics(holdoutTrades) : null,
    holdoutTrades,
    costStress: buildCostStressMetrics(oosTrades),
  };
}

function chooseVariant(
  groupRuns: Map<string, GroupVariantRun>,
  group: ValidationGroup | undefined,
  side: Side,
): StrategyVariant | null {
  if (!group) return null;
  const candidates = VARIANTS
    .filter((variant) => variant.id !== "CONTROL")
    .map((variant) => {
      const run = groupRuns.get(runKey(group.id, variant.id));
      if (!run) return null;
      const evaluated = evaluateGroupRun(group, run, side);
      return { variant, evaluated };
    })
    .filter((item): item is { variant: StrategyVariant; evaluated: EvaluatedRun } => item !== null);
  candidates.sort((left, right) => (
    right.evaluated.development.avgNetR - left.evaluated.development.avgNetR
    || right.evaluated.development.netR - left.evaluated.development.netR
    || right.evaluated.development.trades - left.evaluated.development.trades
  ));
  return candidates[0]?.variant ?? null;
}

function aggregateEvaluations(
  evaluations: EvaluatedRun[],
): {
  oosTrades: ValidationTrade[];
  holdoutTrades: ValidationTrade[];
  metrics: ValidationMetrics;
  holdout: ValidationMetrics | null;
  costStress: CostStressMetrics;
  folds: Array<{ fold: string; netR: number; trades: number; metrics: ValidationMetrics }>;
  regimeMetrics: Array<{ regime: string; metrics: ValidationMetrics }>;
} {
  const oosTrades = evaluations.flatMap((evaluation) => evaluation.oosTrades);
  const holdoutTrades = evaluations.flatMap((evaluation) => evaluation.holdoutTrades);
  const foldByTrade = new Map<ValidationTrade, string>();
  const folds = evaluations.flatMap((evaluation) => evaluation.foldMetrics.map((fold) => ({
    fold: `${evaluation.groupId}-${fold.fold}`,
    netR: fold.metrics.netR,
    trades: fold.metrics.trades,
    metrics: fold.metrics,
  })));
  // The fold-level map is reconstructed from timestamps below. Keeping this
  // explicit prevents holdout rows from entering the OOS confidence sample.
  for (const evaluation of evaluations) {
    const group = evaluationGroupLookup(evaluation.groupId);
    for (const trade of evaluation.oosTrades) {
      const fold = group?.folds.find((item) => isTimestampInWindow(trade.entryTime, item.validationStart, item.validationEnd));
      if (fold) foldByTrade.set(trade, `${evaluation.groupId}-${fold.id}`);
    }
  }
  const regimeValues = new Map<string, ValidationTrade[]>();
  for (const trade of oosTrades) {
    const regime = trade.marketRegime ?? "DATA_UNAVAILABLE";
    const rows = regimeValues.get(regime) ?? [];
    rows.push(trade);
    regimeValues.set(regime, rows);
  }
  return {
    oosTrades,
    holdoutTrades,
    metrics: calculateMetrics(oosTrades, { foldByTrade }),
    holdout: holdoutTrades.length > 0 ? calculateMetrics(holdoutTrades) : null,
    costStress: buildCostStressMetrics(oosTrades),
    folds,
    regimeMetrics: [...regimeValues.entries()].map(([regime, trades]) => ({
      regime,
      metrics: calculateMetrics(trades),
    })),
  };
}

// This lookup is populated by buildValidationSummary for the duration of the
// pure aggregation call. It avoids passing mutable group state through every
// aggregate metric helper.
let currentGroups = new Map<GroupId, ValidationGroup>();

function evaluationGroupLookup(groupId: GroupId): ValidationGroup | undefined {
  return currentGroups.get(groupId);
}

async function buildValidationSummary(
  groups: ValidationGroup[],
  groupRuns: Map<string, GroupVariantRun>,
  broadGroup: ValidationGroup | undefined,
  coreGroup: ValidationGroup | undefined,
): Promise<Record<string, unknown>> {
  currentGroups = new Map(groups.map((group) => [group.id, group]));
  const controlEvidence = JSON.parse(await readFile(CONTROL_EVIDENCE_FILE, "utf8")) as ControlEvidence;
  const directions: Record<Side, Record<string, unknown>> = { LONG: {}, SHORT: {} };
  for (const side of ["LONG", "SHORT"] as const) {
    const selectedVariant = chooseVariant(groupRuns, broadGroup, side);
    const variantId = selectedVariant?.id ?? null;
    const selectedEvaluations = selectedVariant
      ? groups.flatMap((group) => {
        const run = groupRuns.get(runKey(group.id, selectedVariant.id));
        return run ? [evaluateGroupRun(group, run, side)] : [];
      })
      : [];
    const controlEvaluations = side === "SHORT"
      ? groups.flatMap((group) => {
        const run = groupRuns.get(runKey(group.id, "CONTROL"));
        return run ? [evaluateGroupRun(group, run, side)] : [];
      })
      : [];
    const selected = aggregateEvaluations(selectedEvaluations);
    const control = side === "SHORT" ? aggregateEvaluations(controlEvaluations) : null;
    const dataQuality = validationDataQuality(groups);
    const gate = evaluatePromotionGate({
      metrics: selected.metrics,
      holdout: selected.holdout,
      control: control?.metrics ?? null,
      costStress: selected.costStress,
      folds: selected.folds,
      dataQuality,
      foldGroups: selectedEvaluations.map((evaluation) => ({
        id: evaluation.groupId,
        folds: evaluation.foldMetrics.map((fold) => ({ netR: fold.metrics.netR, trades: fold.metrics.trades })),
      })),
      regimeMetrics: selected.regimeMetrics,
    });
    directions[side] = {
      side,
      selectedVariant: variantId,
      selectionRule: "Selected on 1Y Broad initial training window only; validation and frozen holdout are untouched.",
      selectedStrategyDescription: selectedVariant?.description ?? "DATA_UNAVAILABLE",
      datasets: selectedEvaluations.map((evaluation) => serializeEvaluation(evaluation)),
      aggregate: {
        oos: serializeMetrics(selected.metrics),
        holdout: serializeMetrics(selected.holdout),
        costStress: serializeCostStress(selected.costStress),
        folds: selected.folds.map((fold) => ({
          fold: fold.fold,
          trades: fold.trades,
          netR: roundMetric(fold.netR),
          metrics: serializeMetrics(fold.metrics),
        })),
        regimeConditional: selected.regimeMetrics.map((item) => ({
          regime: item.regime,
          metrics: serializeMetrics(item.metrics),
        })),
      },
      control: {
        strategyVersion: CONTROL_STRATEGY_VERSION,
        oos: serializeMetrics(control?.metrics ?? null),
        holdout: serializeMetrics(control?.holdout ?? null),
        costStress: control ? serializeCostStress(control.costStress) : null,
      },
      promotion: {
        status: gate.status,
        gates: gate.gates,
      },
      researchBoundary: {
        productionEmailEnabled: false,
        productionStrategyChanged: false,
        automaticSwitch: false,
        automaticTrading: false,
        productionDeployment: false,
        supabaseMigration: false,
      },
    };
  }
  return {
    report: "V5.2 Profitability Validation",
    generatedAt: new Date().toISOString(),
    productionBase: CONTROL_BASE_SHA,
    controlStrategy: CONTROL_STRATEGY_VERSION,
    datasetSource: "Binance official public historical cache",
    pointInTimeUniverse: "PROXY",
    survivorBias: "PROXY",
    drawdownDefinition: {
      maxDrawdownR: "Sequential peak-to-trough R using ordered trades",
      referenceEquity: "100 units, fixed 1% reference risk per trade; research metric only",
      referenceEquityMaxDrawdownPercent: "Equity peak-to-trough percentage under the fixed reference risk assumption",
    },
    immutableProspectiveControlEvidence: {
      file: "reports/v5-2-prospective-control.json",
      sha256: controlEvidence.sha256,
      settledTrades: controlEvidence.summary.settled_trades,
      avgR: controlEvidence.summary.avg_r,
      profitFactor: controlEvidence.summary.profit_factor,
      netPnlUsdt: controlEvidence.summary.net_pnl_usdt,
    },
    groups: groups.map(serializeGroup),
    directions,
    overallDecision: "NO_PRODUCTION_PROMOTION",
    notes: [
      "This is research-only validation. Production remains on trend-rejection-short-v1.",
      "Missing point-in-time universe membership is marked PROXY and blocks Production Email promotion.",
      "Unavailable historical snapshot fields are not inferred from current state.",
      "Read-only supporting-evidence query for default-trend-shadow-v1 and trend-rejection-shadow-v1 returned zero settled rows; see reports/v5-2-shadow-supporting-evidence.json. Shadow evidence is DATA_UNAVAILABLE and cannot replace historical OOS or holdout evidence.",
    ],
  };
}

function validationDataQuality(groups: ValidationGroup[]): { passed: boolean; reason: string } {
  const broad = groups.find((group) => group.id === "1Y_BROAD");
  const core = groups.find((group) => group.id === "3Y_CORE");
  const issues: string[] = ["PIT_UNIVERSE=PROXY"];
  if (!broad || broad.files.length < broad.expectedSymbols) {
    issues.push(`1Y Broad coverage ${broad?.files.length ?? 0}/${broad?.expectedSymbols ?? 50}`);
  }
  if (!core || core.files.length === 0) issues.push("3Y Core unavailable");
  if (!broad?.holdout || !core?.holdout) issues.push("frozen holdout unavailable");
  for (const group of groups) {
    const quality = group.files.reduce((result, file) => {
      result.duplicateCandles += file.quality.duplicateCandles;
      result.timestampMisalignments += file.quality.timestampMisalignments;
      result.futureLeakage += file.quality.futureLeakage ? 1 : 0;
      result.listingDateMismatch += file.quality.listingDateMismatch ? 1 : 0;
      return result;
    }, { duplicateCandles: 0, timestampMisalignments: 0, futureLeakage: 0, listingDateMismatch: 0 });
    if (quality.duplicateCandles > 0) issues.push(group.id + " duplicate candles=" + quality.duplicateCandles);
    if (quality.timestampMisalignments > 0) issues.push(group.id + " timestamp misalignments=" + quality.timestampMisalignments);
    if (quality.futureLeakage > 0) issues.push(group.id + " future leakage files=" + quality.futureLeakage);
    if (quality.listingDateMismatch > 0) issues.push(group.id + " listing-date mismatches=" + quality.listingDateMismatch);
  }
  return { passed: false, reason: issues.join("; ") };
}

function serializeGroup(group: ValidationGroup): Record<string, unknown> {
  const manifestHash = createHash("sha256")
    .update(group.files.map((file) => file.symbol + ":" + file.sha256).sort().join("\n"))
    .digest("hex");
  return {
    id: group.id,
    label: group.label,
    evaluationStart: new Date(group.start).toISOString(),
    evaluationEnd: new Date(group.end).toISOString(),
    expectedSymbols: group.expectedSymbols,
    loadedSymbols: group.files.length,
    missingSymbols: group.missingSymbols,
    coverage: group.expectedSymbols > 0 ? group.files.length / group.expectedSymbols : null,
    manifestSha256: manifestHash,
    dataQuality: group.files.reduce((result, file) => {
      result.duplicateCandles += file.quality.duplicateCandles;
      result.missing15mIntervals += file.quality.missing15mIntervals;
      result.missing1hIntervals += file.quality.missing1hIntervals;
      result.missing4hIntervals += file.quality.missing4hIntervals;
      result.timestampMisalignments += file.quality.timestampMisalignments;
      result.futureLeakage += file.quality.futureLeakage ? 1 : 0;
      result.fundingOutOfRange += file.quality.fundingOutOfRange;
      result.listingDateMismatch += file.quality.listingDateMismatch ? 1 : 0;
      return result;
    }, {
      duplicateCandles: 0,
      missing15mIntervals: 0,
      missing1hIntervals: 0,
      missing4hIntervals: 0,
      timestampMisalignments: 0,
      futureLeakage: 0,
      fundingOutOfRange: 0,
      listingDateMismatch: 0,
    }),
    folds: group.folds.map((fold) => ({
      id: fold.id,
      trainStart: new Date(fold.trainStart).toISOString(),
      trainEnd: new Date(fold.trainEnd).toISOString(),
      purgeStart: new Date(fold.purgeStart).toISOString(),
      purgeEnd: new Date(fold.purgeEnd).toISOString(),
      validationStart: new Date(fold.validationStart).toISOString(),
      validationEnd: new Date(fold.validationEnd).toISOString(),
    })),
    holdout: group.holdout
      ? {
        start: new Date(group.holdout.start).toISOString(),
        end: new Date(group.holdout.end).toISOString(),
        purgeStart: new Date(group.holdout.purgeStart).toISOString(),
        purgeEnd: new Date(group.holdout.purgeEnd).toISOString(),
      }
      : null,
    datasetManifest: group.files.map((file) => ({
      symbol: file.symbol,
      bytes: file.bytes,
      sha256: file.sha256,
      quality: file.quality,
    })),
  };
}

function serializeMetrics(metrics: ValidationMetrics | null): Record<string, unknown> | null {
  if (!metrics) return null;
  return {
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: roundMetric(metrics.winRate),
    netR: roundMetric(metrics.netR),
    avgNetR: roundMetric(metrics.avgNetR),
    profitFactor: finiteMetric(metrics.profitFactor),
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    maxDrawdownPercent: roundMetric(metrics.maxDrawdownPercent),
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
    monthly: metrics.monthly.map((month) => ({
      month: month.month,
      trades: month.trades,
      netR: roundMetric(month.netR),
      profitFactor: finiteMetric(month.profitFactor),
      maxDrawdownR: roundMetric(month.maxDrawdownR),
    })),
  };
}

function finiteMetric(value: number): number | null {
  return Number.isFinite(value) ? roundMetric(value) : null;
}

function serializeCostStress(stress: CostStressMetrics): Record<string, unknown> {
  return {
    base: serializeMetrics(stress.base),
    plus10Bps: serializeMetrics(stress.plus10Bps),
    plus15Bps: serializeMetrics(stress.plus15Bps),
  };
}

function serializeEvaluation(evaluation: EvaluatedRun): Record<string, unknown> {
  const group = evaluationGroupLookup(evaluation.groupId);
  return {
    group: evaluation.groupId,
    variant: evaluation.variantId,
    side: evaluation.side,
    development: serializeMetrics(evaluation.development),
    oos: serializeMetrics(evaluation.oos),
    holdout: serializeMetrics(evaluation.holdout),
    costStress: serializeCostStress(evaluation.costStress),
    folds: evaluation.foldMetrics.map((fold) => ({
      fold: fold.fold,
      metrics: serializeMetrics(fold.metrics),
    })),
    holdoutExcludedFromSelection: group?.holdout
      ? isHoldoutExcludedFromSelection(group.folds[0]?.trainEnd ?? group.start, group.holdout.start)
      : true,
  };
}

function collectAttritionObservations(
  target: AttritionObservation[],
  cache: Map<number, ScoredCandidate[]>,
  dataset: HistoricalDataset,
  group: ValidationGroup,
  benchmark: HistoricalDataset | undefined,
): void {
  for (const [index, candidates] of cache.entries()) {
    const candle = dataset.candles["15m"][index];
    if (!candle) continue;
    const fold = foldLabel(group, candle.closeTime);
    for (const candidate of candidates) {
      const side = candidate.side;
      const entryDistanceAtr = candidate.atr > 0
        ? Math.abs(candidate.entryPrice - candidate.stopReferencePrice) / candidate.atr
        : Number.POSITIVE_INFINITY;
      const benchmarkRegime = benchmark ? regimeAt(benchmark, candle.closeTime) : "DATA_UNAVAILABLE";
      const aligned = candidate.strategyFamily === "MEAN_REVERSION"
        ? candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN"
        : side === "LONG" ? candidate.marketRegime === "BULL" : candidate.marketRegime === "BEAR";
      const btcEthConfirmation = benchmarkRegime === "DATA_UNAVAILABLE"
        ? true
        : side === "LONG" ? benchmarkRegime === "BULL" : benchmarkRegime === "BEAR";
      const fundingAvailable = (dataset.fundingRates ?? []).some((point) => point.fundingTime <= candle.closeTime);
      const stages: Record<string, boolean> = {
        RAW_TRIGGER: true,
        ENTRY_LOCATION: Number.isFinite(entryDistanceAtr) && entryDistanceAtr > 0 && entryDistanceAtr <= 3,
        SETUP_QUALITY: candidate.score >= MIN_SCORE,
        REVERSAL_RISK: aligned,
        BTC_ETH_CONFIRMATION: btcEthConfirmation,
        // Breadth and true expected edge require point-in-time cross-sectional
        // labels/training outcomes that are not in the immutable cache.
        MARKET_BREADTH: true,
        MOMENTUM_EXHAUSTION: candidate.scoreComponents.momentum >= 0.25
          && candidate.scoreComponents.momentum <= 0.9,
        EXPECTED_EDGE: true,
        COST_FUNDING: fundingAvailable,
        FINAL_ELIGIBLE: false,
      };
      stages.FINAL_ELIGIBLE = STAGE_NAMES
        .filter((stage) => stage !== "FINAL_ELIGIBLE")
        .every((stage) => stages[stage]);
      const rejectionReasons: Record<string, string> = {
        RAW_TRIGGER: "none",
        ENTRY_LOCATION: stages.ENTRY_LOCATION ? "passed" : "risk_distance_atr_out_of_range",
        SETUP_QUALITY: stages.SETUP_QUALITY ? "passed" : "score_below_minimum",
        REVERSAL_RISK: stages.REVERSAL_RISK ? "passed" : "regime_not_aligned",
        BTC_ETH_CONFIRMATION: stages.BTC_ETH_CONFIRMATION ? "passed" : "benchmark_regime_not_aligned_or_unavailable",
        MARKET_BREADTH: "DATA_UNAVAILABLE_PASS_THROUGH",
        MOMENTUM_EXHAUSTION: stages.MOMENTUM_EXHAUSTION ? "passed" : "momentum_component_outside_fixed_range",
        EXPECTED_EDGE: "DATA_UNAVAILABLE_PASS_THROUGH",
        COST_FUNDING: stages.COST_FUNDING ? "passed" : "funding_history_unavailable",
        FINAL_ELIGIBLE: stages.FINAL_ELIGIBLE ? "passed" : "prior_stage_rejected",
      };
      target.push({
        side,
        fold,
        symbol: dataset.symbol,
        marketRegime: candidate.marketRegime,
        entryTime: candle.closeTime,
        stages,
        rejectionReasons,
      });
    }
  }
}

function foldLabel(group: ValidationGroup, entryTime: number): string {
  const fold = group.folds.find((item) => isTimestampInWindow(entryTime, item.validationStart, item.validationEnd));
  if (fold) return fold.id;
  if (group.holdout && isTimestampInWindow(entryTime, group.holdout.start, group.holdout.end)) return "HOLDOUT";
  return "DEVELOPMENT";
}

function regimeAt(dataset: HistoricalDataset, timestamp: number): MarketRegime {
  const candles = dataset.candles["4h"] ?? [];
  const usable = candles.filter((candle) => candle.closeTime <= timestamp).slice(-250);
  return classifyRegime(usable);
}

async function buildAttritionReport(
  groups: ValidationGroup[],
  groupRuns: Map<string, GroupVariantRun>,
  broadGroup: ValidationGroup | undefined,
  coreGroup: ValidationGroup | undefined,
): Promise<Record<string, unknown>> {
  const selectedBySide: Record<Side, Record<string, unknown>> = { LONG: {}, SHORT: {} };
  const allPerformance: AttritionPerformance[] = [];
  for (const side of ["LONG", "SHORT"] as const) {
    const variant = chooseVariant(groupRuns, broadGroup, side);
    const run = variant && broadGroup ? groupRuns.get(runKey(broadGroup.id, variant.id)) : undefined;
    const observations = run?.candidateObservations ?? [];
    const summaries = summarizeAttrition(observations, [...STAGE_NAMES]);
    const performance = stagePerformance(observations, run?.tradesBySide[side] ?? [], side, summaries);
    allPerformance.push(...performance);
    selectedBySide[side] = {
      selectedVariant: variant?.id ?? null,
      sourceGroup: broadGroup?.id ?? null,
      candidateObservations: observations.length,
      stages: summaries.filter((summary) => summary.side === side),
      breakdown: buildAttritionBreakdown(observations.filter((observation) => observation.side === side), [...STAGE_NAMES]),
      performance: performance.filter((item) => item.side === side),
      fieldAvailability: {
        marketBreadth: "DATA_UNAVAILABLE: no immutable point-in-time cross-sectional breadth export",
        expectedEdge: "DATA_UNAVAILABLE: no frozen train-only edge model was persisted",
        setupAge: "DATA_UNAVAILABLE: not persisted in candidate or paper-trade evidence",
        btcEth: "BTC proxy evaluated where available; ETH and exact cross-sectional join are DATA_UNAVAILABLE",
      },
    };
  }
  return {
    report: "V5.2 filter attrition",
    generatedAt: new Date().toISOString(),
    stages: STAGE_NAMES,
    accounting: "For each side, input at stage N equals passed output at stage N-1; no rejected candidate is silently counted as passed.",
    datasets: groups.map((group) => ({ id: group.id, files: group.files.length })),
    directions: selectedBySide,
    performanceRows: allPerformance,
    decision: "ATTRITION_RESEARCH_ONLY",
  };
}

function stagePerformance(
  observations: AttritionObservation[],
  trades: BacktestTrade[],
  side: Side,
  summaries: ReturnType<typeof summarizeAttrition>,
): AttritionPerformance[] {
  return STAGE_NAMES.map((stage, stageIndex) => {
    const reached = (observation: AttritionObservation) => STAGE_NAMES
      .slice(0, stageIndex)
      .every((prior) => observation.stages[prior]);
    const passedKeys = new Set(observations
      .filter((observation) => observation.side === side && reached(observation) && observation.stages[stage])
      .map(observationKey));
    const rejectedKeys = new Set(observations
      .filter((observation) => observation.side === side && reached(observation) && !observation.stages[stage])
      .map(observationKey));
    const passedTrades = trades.filter((trade) => passedKeys.has(tradeKey(trade)));
    const rejectedTrades = trades.filter((trade) => rejectedKeys.has(tradeKey(trade)));
    const summary = summaries.find((item) => item.side === side && item.stage === stage);
    const exactJoin = passedTrades.length + rejectedTrades.length > 0 || (summary?.passed ?? 0) === 0;
    return {
      stage,
      side,
      passedCandidates: summary?.passed ?? 0,
      rejectedCandidates: summary?.rejected ?? 0,
      passedBacktest: exactJoin ? calculateMetrics(passedTrades) : null,
      rejectedBacktest: exactJoin ? calculateMetrics(rejectedTrades) : null,
      status: exactJoin ? "COMPUTED" : "DATA_UNAVAILABLE",
    } satisfies AttritionPerformance;
  });
}

function buildAttritionBreakdown(
  observations: AttritionObservation[],
  stages: string[],
): Array<Record<string, unknown>> {
  const rows = new Map<string, { stage: string; side: Side; fold: string; symbol: string; marketRegime: string; input: number; passed: number; rejected: number; reasons: Record<string, number> }>();
  observations.forEach((observation) => {
    stages.forEach((stage, stageIndex) => {
      const reached = stages.slice(0, stageIndex).every((prior) => observation.stages[prior]);
      if (!reached) return;
      const key = [stage, observation.side, observation.fold, observation.symbol, observation.marketRegime].join("|");
      const row = rows.get(key) ?? {
        stage,
        side: observation.side,
        fold: observation.fold,
        symbol: observation.symbol,
        marketRegime: observation.marketRegime,
        input: 0,
        passed: 0,
        rejected: 0,
        reasons: {},
      };
      row.input += 1;
      if (observation.stages[stage]) row.passed += 1;
      else {
        row.rejected += 1;
        const reason = observation.rejectionReasons?.[stage] ?? "DATA_UNAVAILABLE";
        row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
      }
      rows.set(key, row);
    });
  });
  return [...rows.values()].map((row) => ({
    ...row,
    retention: row.input > 0 ? row.passed / row.input : null,
  }));
}

function observationKey(observation: AttritionObservation): string {
  return `${observation.symbol}:${observation.entryTime ?? "DATA_UNAVAILABLE"}`;
}

function tradeKey(trade: BacktestTrade): string {
  return `${trade.symbol}:${trade.entryTime}`;
}
async function buildDegradationReport(
  cacheFiles: CacheFile[],
  groups: ValidationGroup[],
): Promise<string> {
  const evidence = JSON.parse(await readFile(CONTROL_EVIDENCE_FILE, "utf8")) as ControlEvidence;
  const preferredFiles = [
    ...cacheFiles.filter((file) => file.path.endsWith("-1754705700000-1786241699999.json")),
    ...cacheFiles.filter((file) => file.path.endsWith("-1691633700000-1786241699999.json")),
  ];
  const bySymbol = new Map<string, CacheFile>();
  for (const file of preferredFiles) if (!bySymbol.has(file.symbol)) bySymbol.set(file.symbol, file);
  const datasetCache = new Map<string, HistoricalDataset | null>();
  const diagnostics: SnapshotDiagnostics[] = [];
  for (const row of evidence.rows) {
    const symbol = text(row.symbol);
    let dataset = datasetCache.get(symbol);
    if (dataset === undefined) {
      const file = bySymbol.get(symbol);
      dataset = file ? await readDataset(file) : null;
      datasetCache.set(symbol, dataset);
    }
    diagnostics.push(diagnoseControlRow(row, dataset));
  }
  const winners = diagnostics.filter((row) => row.rMultiple > 0);
  const losers = diagnostics.filter((row) => row.rMultiple < 0);
  const winnerAvgR = winners.length > 0 ? winners.reduce((sum, row) => sum + row.rMultiple, 0) / winners.length : null;
  const loserAvgR = losers.length > 0 ? losers.reduce((sum, row) => sum + row.rMultiple, 0) / losers.length : null;
  const commonUnavailable = [...new Set(diagnostics.flatMap((row) => row.unavailable))].sort();
  const byExitReason = countBy(diagnostics, (row) => row.exitReason);
  const bySymbolCounts = countBy(diagnostics, (row) => row.symbol);
  const groupCoverage = groups.map((group) => ({ id: group.id, loadedSymbols: group.files.length, expectedSymbols: group.expectedSymbols }));
  const lines = [
    "# V5.2 Production Degradation Analysis",
    "",
    "- Control strategy: " + evidence.strategy_version,
    "- Production validation base: " + CONTROL_BASE_SHA,
    "- Evidence query timestamp: " + evidence.query_timestamp,
    "- Evidence SHA256: " + evidence.sha256,
    "- Source: " + evidence.source_table + " (read-only immutable export)",
    "- Database mutation: NONE",
    "",
    "## Control result",
    "",
    "- Settled prospective trades: **" + evidence.summary.settled_trades + "**",
    "- Wins / stop losses: **" + evidence.summary.wins + " / " + evidence.summary.stop_losses + "**",
    "- Avg R: **" + evidence.summary.avg_r.toFixed(4) + "**",
    "- Profit factor: **" + evidence.summary.profit_factor.toFixed(4) + "**",
    "- Net PnL: **" + evidence.summary.net_pnl_usdt.toFixed(4) + " USDT**",
    "- Winner average R / loser average R: **" + formatAvailable(winnerAvgR) + " / " + formatAvailable(loserAvgR) + "**",
    "- Stop-loss share: **" + (evidence.summary.stop_losses / evidence.summary.settled_trades * 100).toFixed(1) + "%**",
    "",
    "## What can be reconstructed",
    "",
    "The immutable Paper-trade export contains entry/exit, side, symbol, stop/take-profit, R, fees, funding, slippage and strategy metadata. Frozen public candle caches were joined only by symbol and entry timestamp where an exact candle was present.",
    "",
    "| Symbol | Entry | Exit | Exit reason | R | Regime | ATR | RSI | MFE 1h | MFE 4h | MFE 24h | MFE 72h | MAE 1h | MAE 4h | MAE 24h | MAE 72h |",
    "|---|---:|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...diagnostics.map((row) => "| " + row.symbol + " | " + row.entryTime + " | " + row.exitTime + " | " + row.exitReason + " | " + row.rMultiple.toFixed(4) + " | " + formatAvailable(row.available.regime4h) + " | " + formatAvailable(row.available.atr) + " | " + formatAvailable(row.available.rsi) + " | " + formatAvailable(row.available.mfe1hR) + " | " + formatAvailable(row.available.mfe4hR) + " | " + formatAvailable(row.available.mfe24hR) + " | " + formatAvailable(row.available.mfe72hR) + " | " + formatAvailable(row.available.mae1hR) + " | " + formatAvailable(row.available.mae4hR) + " | " + formatAvailable(row.available.mae24hR) + " | " + formatAvailable(row.available.mae72hR) + " |"),
    "",
    "| Symbol | Entry price | Stop price | Theoretical risk USDT | Net PnL USDT | Funding USDT | Slippage USDT | Entry model |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...diagnostics.map((row) => "| " + row.symbol + " | " + formatAvailable(row.available.entryPrice) + " | " + formatAvailable(row.available.stopPrice) + " | " + formatAvailable(row.available.theoreticalRiskUsdt) + " | " + formatAvailable(row.available.netPnlUsdt) + " | " + formatAvailable(row.available.fundingUsdt) + " | " + formatAvailable(row.available.slippageUsdt) + " | " + formatAvailable(row.available.entryModel) + " |"),
    "",
    "| Symbol | Time to stop (h) | Time to TP (h) | +0.5R before stop | +1R before stop |",
    "|---|---:|---:|---|---|",
    ...diagnostics.map((row) => "| " + row.symbol + " | " + formatAvailable(row.available.timeToStopHours) + " | " + formatAvailable(row.available.timeToTakeProfitHours) + " | " + formatAvailable(row.available.hitHalfRBeforeStop) + " | " + formatAvailable(row.available.hitOneRBeforeStop) + " |"),
    "",
    "| Symbol | UTC hour | Entry extension ATR | Distance to EMA ATR | Volume ratio | ATR / price | Funding at entry |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...diagnostics.map((row) => "| " + row.symbol + " | " + formatAvailable(row.available.entryHourUtc) + " | " + formatAvailable(row.available.entryExtensionAtr) + " | " + formatAvailable(row.available.distanceToEmaAtr) + " | " + formatAvailable(row.available.volumeRatio) + " | " + formatAvailable(row.available.volatilityAtrPercent) + " | " + formatAvailable(row.available.fundingAtEntry) + " |"),
    "",
    "## Degradation pattern",
    "",
    "- Winners reconstructed: **" + winners.length + "**; losing rows: **" + losers.length + "**.",
    "- Exit-reason counts: " + JSON.stringify(byExitReason) + ".",
    "- Symbol counts: " + JSON.stringify(bySymbolCounts) + ".",
    "- The observed sample is too small for a symbol blacklist or a permanent market/regime conclusion.",
    "- The report does not claim that unavailable entry-time fields caused the losses.",
    "",
    "## DATA_UNAVAILABLE fields",
    "",
    ...commonUnavailable.map((field) => "- " + field),
    "",
    "Unavailable fields are not guessed from current market state. In particular, exact setup age, immutable point-in-time breadth, and a persisted ETH/BTC cross-sectional join are not available in the Paper-trade rows. The next run requires a real immutable prospective export with those fields or an auditable reconstruction dataset.",
    "",
    "## Validation dataset coverage",
    "",
    ...groupCoverage.map((item) => "- " + item.id + ": " + item.loadedSymbols + "/" + item.expectedSymbols + " symbols loaded; point-in-time universe status remains PROXY."),
    "",
    "Decision: **RESEARCH_ONLY / NO_PRODUCTION_PROMOTION**.",
  ];
  return lines.join("\n");
}

function diagnoseControlRow(row: Record<string, unknown>, dataset: HistoricalDataset | null): SnapshotDiagnostics {
  const symbol = text(row.symbol);
  const entryTimeMs = Date.parse(text(row.entry_time));
  const exitTimeMs = Date.parse(text(row.exit_time));
  const rMultiple = number(row.r_multiple);
  const metadata = row.metadata as Record<string, unknown> | null;
  const result: SnapshotDiagnostics = {
    symbol,
    entryTime: text(row.entry_time),
    exitTime: text(row.exit_time),
    exitReason: text(row.exit_reason) || text(row.status),
    rMultiple,
    available: {
      entryPrice: numberOrNull(row.entry_price),
      stopPrice: numberOrNull(row.stop_price),
      theoreticalRiskUsdt: numberOrNull(row.theoretical_risk_usdt),
      netPnlUsdt: numberOrNull(row.net_pnl_usdt),
      fundingUsdt: numberOrNull(row.funding_usdt),
      slippageUsdt: numberOrNull(row.slippage_usdt),
      entryModel: text(metadata?.entry_model),
      entryHourUtc: Number.isFinite(entryTimeMs) ? new Date(entryTimeMs).getUTCHours() : null,
      regime4h: null,
      atr: null,
      entryExtensionAtr: null,
      distanceToEmaAtr: null,
      rsi: null,
      volumeRatio: null,
      volatilityAtrPercent: null,
      fundingAtEntry: null,
      mfe1hR: null,
      mfe4hR: null,
      mfe24hR: null,
      mfe72hR: null,
      mae1hR: null,
      mae4hR: null,
      mae24hR: null,
      mae72hR: null,
      mfeR: null,
      maeR: null,
      timeToStopHours: null,
      timeToTakeProfitHours: null,
      hitHalfRBeforeStop: null,
      hitOneRBeforeStop: null,
      timeToExitHours: Number.isFinite(entryTimeMs) && Number.isFinite(exitTimeMs)
        ? (exitTimeMs - entryTimeMs) / (60 * 60 * 1000)
        : null,
    },
    unavailable: [
      "setup_age",
      "pullback_depth",
      "entry_extension_atr",
      "market_breadth_at_entry",
      "btc_regime_exact_join",
      "exact_eth_regime_join",
      "volatility_snapshot",
      "historical_signal_snapshot_json",
    ],
  };
  if (!dataset || !Number.isFinite(entryTimeMs)) {
    result.unavailable.push("frozen_symbol_candle_join");
    return result;
  }
  const candles = dataset.candles["15m"];
  const firstCloseTime = candles[0]?.closeTime ?? 0;
  const lastCloseTime = candles.at(-1)?.closeTime ?? 0;
  if (entryTimeMs < firstCloseTime || entryTimeMs > lastCloseTime) {
    result.unavailable.push("frozen_cache_does_not_cover_entry_time");
    return result;
  }
  const index = lastIndexAtOrBefore(candles, entryTimeMs);
  if (index < 80) {
    result.unavailable.push("indicator_warmup_or_entry_candle");
    return result;
  }
  const prefix = candles.slice(0, index + 1);
  const atrValue = latest(atr(prefix));
  const emaValue = latest(ema(closes(prefix), 20));
  const rsiValue = latest(rsi(closes(prefix), 14));
  const volumeValue = latest(volumeRatio(prefix, 20));
  const entryPrice = numberOrNull(row.entry_fill_price) ?? numberOrNull(row.entry_price) ?? candles[index].close;
  const stopPrice = numberOrNull(row.stop_price);
  result.available.regime4h = regimeAt(dataset, entryTimeMs);
  result.available.atr = atrValue;
  result.available.distanceToEmaAtr = atrValue && emaValue
    ? Math.abs(entryPrice - emaValue) / atrValue
    : null;
  result.available.rsi = rsiValue;
  result.available.volumeRatio = volumeValue;
  result.available.volatilityAtrPercent = atrValue && entryPrice ? atrValue / entryPrice : null;
  result.available.fundingAtEntry = lastFundingAtOrBefore(dataset, entryTimeMs);
  if (result.exitReason === "STOP_LOSS") result.available.timeToStopHours = result.available.timeToExitHours;
  if (result.exitReason === "TAKE_PROFIT") result.available.timeToTakeProfitHours = result.available.timeToExitHours;
  if (stopPrice !== null && Math.abs(entryPrice - stopPrice) > 0) {
    const riskDistance = Math.abs(entryPrice - stopPrice);
    const horizons = [1, 4, 24, 72];
    for (const horizon of horizons) {
      const pathEnd = Math.min(exitTimeMs, entryTimeMs + horizon * 60 * 60 * 1000);
      const path = candles.filter((candle) => candle.closeTime > entryTimeMs && candle.closeTime <= pathEnd);
      const mfe = path.length > 0 ? Math.max(...path.map((candle) => (entryPrice - candle.low) / riskDistance)) : null;
      const mae = path.length > 0 ? Math.max(...path.map((candle) => (candle.high - entryPrice) / riskDistance)) : null;
      result.available["mfe" + horizon + "hR"] = mfe;
      result.available["mae" + horizon + "hR"] = mae;
      if (horizon === 72) {
        result.available.mfeR = mfe;
        result.available.maeR = mae;
      }
    }
    if (result.exitReason === "STOP_LOSS") {
      const path = candles.filter((candle) => candle.closeTime > entryTimeMs && candle.closeTime <= exitTimeMs);
      const favorableBeforeStop = path.length > 0
        ? Math.max(...path.map((candle) => (entryPrice - candle.low) / riskDistance))
        : null;
      result.available.hitHalfRBeforeStop = favorableBeforeStop === null ? null : favorableBeforeStop >= 0.5;
      result.available.hitOneRBeforeStop = favorableBeforeStop === null ? null : favorableBeforeStop >= 1;
    }
  } else {
    result.unavailable.push("mfe_mae_without_frozen_stop_distance");
  }
  return result;
}

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function lastFundingAtOrBefore(dataset: HistoricalDataset, timestamp: number): number | null {
  const funding = (dataset.fundingRates ?? []).filter((point) => point.fundingTime <= timestamp);
  return funding.at(-1)?.fundingRate ?? null;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAvailable(value: unknown): string {
  if (value === null || value === undefined || value === "") return "DATA_UNAVAILABLE";
  return typeof value === "number" ? value.toFixed(4) : text(value);
}

async function writeReports(
  summary: Record<string, unknown>,
  attrition: Record<string, unknown>,
  degradation: string,
  groups: ValidationGroup[],
  cacheFiles: CacheFile[],
): Promise<void> {
  await writeFile(resolve(REPORT_DIR, "v5-2-validation-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-2-filter-attrition.json"), JSON.stringify(attrition, null, 2) + "\n", "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-2-production-degradation.md"), degradation + "\n", "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-2-promotion-decision.md"), promotionDecisionMarkdown(summary, groups, cacheFiles) + "\n", "utf8");
}

function promotionDecisionMarkdown(
  summary: Record<string, unknown>,
  groups: ValidationGroup[],
  cacheFiles: CacheFile[],
): string {
  const directions = summary.directions as Record<Side, Record<string, unknown>>;
  const lines = [
    "# V5.2 Promotion Decision",
    "",
    "## Decision",
    "",
    "**NO_PRODUCTION_PROMOTION**",
    "",
    "Validation base: " + CONTROL_BASE_SHA,
    "Control: " + CONTROL_STRATEGY_VERSION,
    "PIT universe: **PROXY** / SURVIVOR_BIAS=PROXY (" + cacheFiles.length + " cache files available; the frozen 50-symbol membership is not an immutable historical membership export).",
    "",
    "The gates below are measured independently for LONG and SHORT. A strategy can only be Production Email eligible if every required gate passes on the same frozen evidence, including 3Y Core, 1Y Broad, purged walk-forward, cost stress and frozen holdout.",
    "",
  ];
  for (const side of ["LONG", "SHORT"] as const) {
    const direction = directions[side] ?? {};
    const promotion = direction.promotion as { status?: string; gates?: PromotionGateResult[] } | undefined;
    lines.push("## " + side);
    lines.push("");
    lines.push("- Selected research variant: **" + text(direction.selectedVariant) + "**");
    lines.push("- Status: **" + (promotion?.status ?? "REJECTED") + "**");
    lines.push("");
    lines.push("| Gate | Result | Evidence |");
    lines.push("|---|---|---|");
    for (const gate of promotion?.gates ?? []) {
      lines.push("| " + gate.id + " | " + (gate.passed ? "PASS" : "FAIL") + " | " + gate.evidence + " |");
    }
    lines.push("");
  }
  lines.push(
    "## Guardrails",
    "",
    "- Production strategy remains trend-rejection-short-v1.",
    "- No Production Email enablement or strategy switch is performed by this validation.",
    "- No Binance private API, order, position, or account action is used.",
    "- No Supabase migration or database mutation is performed.",
    "- PR #1 remains Research / Draft and is not merged or promoted.",
    "- Shadow supporting evidence is DATA_UNAVAILABLE because the read-only query returned zero settled rows; see reports/v5-2-shadow-supporting-evidence.json.",
    "- The 12-trade control sample is evidence of current degradation, not a permanent symbol blacklist.",
    "",
    "Dataset groups: " + groups.map((group) => group.id + "=" + group.files.length + "/" + group.expectedSymbols).join(", ") + ".",
  );
  return lines.join("\n");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
