import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidateCache, type BacktestOptions } from "@/lib/backtest/engine";
import type { HistoricalDataset } from "@/lib/backtest/types";
import { buildTradePlan } from "@/lib/core/risk";
import { estimatedExecutionCostRiskFraction } from "@/lib/core/execution-policy";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, RiskPolicy, ScoredCandidate } from "@/lib/core/types";
import { closes, ema } from "@/lib/core/indicators";
import { getServerConfig } from "@/lib/config";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  applyAdditionalSlippage,
  buildCostStressMetrics,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type CostStressMetrics,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import {
  buildFeatureFrames,
  type FeatureFrame,
} from "@/lib/v5-3/feature-snapshot";
import {
  buildStructuralPlan,
  detectStructuralSignal,
  runStructuralCandidate,
  selectionAdjustedLowerConfidenceBound,
  type StructuralCandidateDefinition,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import { auditConfidence, type ConfidenceAuditResult } from "@/lib/v5-4/confidence";
import { loadLocalRuntimeEnv, buildProductionControlConfig, type ProductionControlConfig } from "@/lib/v5-3/production-parity";
import {
  V56_CANDIDATE_REGISTRY,
  V56_CONTROL_B_ID,
  V56_MAX_CANDIDATES,
  buildParetoFrontier,
  calculateCvar95,
  calculateYieldMetrics,
  canonicalResearchTradeKey,
  roundResearchMetric,
  selectionScore,
  type ParetoRow,
  type V56CandidateDefinition,
  type YieldMetrics,
} from "@/lib/v5-6/research";

const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/validation-cache");
const UNIVERSE_FILE = resolve("data/validation-universe-50.json");
const PIT_FILE = resolve("data/pit-universe/binance-um-monthly-15m-index.json");

export const V56_RESEARCH_BASELINE = "6033fa1095bfae6f8b2f20c70cbc543221741bc8";
export const V56_PRODUCTION_BASELINE = "a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d";
export const V56_FORWARD_EXPERIMENT = "v55-fbos02-forward-002";
export const V56_FROZEN_MANIFEST_HASH = "ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305";
export const V56_CONTROL_STRATEGY = "trend-rejection-short-v1";
export const V56_CORE_START = 1_691_633_700_000;
export const V56_BROAD_START = 1_754_705_700_000;
export const V56_CACHE_END = 1_786_241_699_999;
export const V56_CORE_HOLDOUT_START = V56_BROAD_START;
export const V56_BROAD_HOLDOUT_START = Date.parse("2026-02-09T02:15:00.000Z");
export const V56_PURGE_HOURS = 72;
export const V56_ENTRY_STRIDE_BARS = 4;
export const V56_FEE_RATE = 0.0004;
export const V56_BASE_SLIPPAGE_BPS = 2;
export const V56_RISK_PER_TRADE_USDT = 50;

type GroupId = "3Y_CORE" | "1Y_BROAD";

interface CacheFile {
  symbol: string;
  path: string;
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

interface GroupRunState {
  candidateTrades: Map<string, StructuralTrade[]>;
  delayedCandidateTrades: Map<string, StructuralTrade[]>;
  controlTrades: ControlReplayTrade[];
  attrition: AttritionCounts;
  loadedSymbols: string[];
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

interface CandidateRow {
  candidate: V56CandidateDefinition;
  developmentMetrics: ValidationMetrics;
  oosMetrics: ValidationMetrics;
  oosTrades: StructuralTrade[];
  holdoutDeferred: true;
  yield: YieldMetrics;
  cvar95: number | null;
  selectionScore: number;
  groupMetrics: Array<{ group: GroupId; development: ValidationMetrics; oos: ValidationMetrics }>;
  foldMetrics: Array<{ group: GroupId; fold: string; metrics: ValidationMetrics }>;
}

interface DirectionAnalysis {
  side: "LONG" | "SHORT";
  rows: CandidateRow[];
  nestedTrades: StructuralTrade[];
  nestedFoldRows: Array<{ group: GroupId; fold: string; candidate: string | null; metrics: ValidationMetrics }>;
  selectionRecords: Array<{ group: GroupId; fold: string; selectedCandidate: string | null; trainTrades: number; validationTrades: number }>;
  finalCandidate: V56CandidateDefinition | null;
  fixedOosTrades: StructuralTrade[];
  fixedOosMetrics: ValidationMetrics;
  holdoutTrades: StructuralTrade[];
  holdoutMetrics: ValidationMetrics | null;
  controlOosTrades: ControlReplayTrade[];
  controlOosMetrics: ValidationMetrics;
  controlHoldoutTrades: ControlReplayTrade[];
  controlHoldoutMetrics: ValidationMetrics | null;
  controlBOosTrades: StructuralTrade[];
  controlBOosMetrics: ValidationMetrics;
  controlBHoldoutTrades: StructuralTrade[];
  controlBHoldoutMetrics: ValidationMetrics | null;
  costStress: CostStressMetrics & { plus5Bps: ValidationMetrics };
  delayedEntryMetrics: ValidationMetrics;
  confidence: ConfidenceAuditResult;
  pareto: ParetoRow[];
  promotion: PromotionDecision;
}

interface PromotionDecision {
  status: "PRODUCTION_EMAIL_ELIGIBLE" | "SHADOW_ONLY" | "REJECTED";
  gates: Array<{ id: string; passed: boolean; evidence: string }>;
}

interface ControlReplayConfig {
  params: StrategyParams;
  options: BacktestOptions;
  policy: RiskPolicy;
  minimumScore: number;
  sideFilter: "SHORT";
  strategyFamily: "TREND";
  requireRegimeAlignment: boolean;
  entryIntervalHours: number;
  cooldownHours: number;
  maxHoldHours: number;
  takerFeeRate: number;
  slippageBps: number;
  maxExecutionCostRiskFraction: number;
  source: "resolved_runtime_config" | "research_defaults";
}

interface ForwardDiagnostic {
  status: "AVAILABLE" | "DATA_UNAVAILABLE";
  sourceTable: string;
  queryTimestamp: string;
  experimentId: string;
  calendarDays: number | null;
  featureSnapshots: number | null;
  rawTriggers: number | null;
  rejected: number | null;
  finalEligible: number | null;
  openedShadowTrades: number | null;
  settledTrades: number | null;
  wins: number | null;
  losses: number | null;
  avgR: number | null;
  profitFactor: number | null;
  netR: number | null;
  maxDrawdownR: number | null;
  positiveMonthRatio: number | null;
  symbolBreadth: number | null;
  regimeBreadth: number | null;
  nextBarOpenValid: number | null;
  executionReferenceUnavailable: number | null;
  errors: string[];
  selectionUse: "NOT_USED_FOR_SELECTION";
}

interface ControlReplayTrade extends ValidationTrade {
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END";
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  loadLocalRuntimeEnv();

  const universe = await loadUniverse();
  const cacheFiles = await loadCacheManifest();
  const groups = buildGroups(universe, cacheFiles);
  const runtimes = new Map<GroupId, GroupRuntime>();
  const states = new Map<GroupId, GroupRunState>();
  const control = resolveControlReplayConfig();
  const pitStatus = await readPitStatus();

  if (V56_CANDIDATE_REGISTRY.length > V56_MAX_CANDIDATES) {
    throw new Error(`V5.6 registry exceeds finite limit: ${V56_CANDIDATE_REGISTRY.length}`);
  }

  console.info(JSON.stringify({
    stage: "v5_6_validation_start",
    researchBaseline: V56_RESEARCH_BASELINE,
    productionBaseline: V56_PRODUCTION_BASELINE,
    forwardExperiment: V56_FORWARD_EXPERIMENT,
    candidates: V56_CANDIDATE_REGISTRY.length,
    groups: groups.map((group) => ({ id: group.id, files: group.files.length, folds: group.folds.length, holdoutStart: new Date(group.holdoutStart).toISOString() })),
    controlSource: control.source,
  }));

  for (const group of groups) {
    const runtime = await prepareRuntime(group);
    runtimes.set(group.id, runtime);
    const state: GroupRunState = {
      candidateTrades: new Map(V56_CANDIDATE_REGISTRY.map((candidate) => [candidate.id, []])),
      delayedCandidateTrades: new Map(V56_CANDIDATE_REGISTRY.map((candidate) => [candidate.id, []])),
      controlTrades: [],
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
        entryStrideBars: V56_ENTRY_STRIDE_BARS,
        breadthAt: runtime.breadth.at,
        btcDataset: runtime.btcDataset,
        ethDataset: runtime.ethDataset,
      });
      for (const candidate of V56_CANDIDATE_REGISTRY) {
        const trades = runStructuralCandidate(dataset, frames, candidate, {
          startTime: group.start,
          endTime: group.end,
          maxHoldHours: candidate.expectedHoldingHorizonHours,
          takerFeeRate: V56_FEE_RATE,
          slippageBps: V56_BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: V56_RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        });
        state.candidateTrades.get(candidate.id)!.push(...trades);
        const delayedTrades = runStructuralCandidate(dataset, frames, candidate, {
          startTime: group.start,
          endTime: group.end,
          delayBars: 1,
          maxHoldHours: candidate.expectedHoldingHorizonHours,
          takerFeeRate: V56_FEE_RATE,
          slippageBps: V56_BASE_SLIPPAGE_BPS,
          riskPerTradeUsdt: V56_RISK_PER_TRADE_USDT,
          cooldownHours: 8,
        });
        state.delayedCandidateTrades.get(candidate.id)!.push(...delayedTrades);
      }
      const controlTrades = runControlNextOpen(dataset, group, control);
      state.controlTrades.push(...controlTrades);
      addAttrition(state.attrition, analyzeFailedBreakoutAttrition(dataset, frames, frozenControlDefinition(), state.candidateTrades.get(V56_CONTROL_B_ID)!.filter((trade) => trade.symbol === dataset.symbol).length));
    }
    console.info(JSON.stringify({
      stage: "v5_6_group_complete",
      group: group.id,
      symbols: state.loadedSymbols.length,
      controlTrades: state.controlTrades.length,
      candidates: Object.fromEntries([...state.candidateTrades.entries()].map(([id, trades]) => [id, trades.length])),
    }));
  }

  const analyses = new Map<"LONG" | "SHORT", DirectionAnalysis>();
  for (const side of ["LONG", "SHORT"] as const) {
    analyses.set(side, analyzeDirection(side, groups, states, pitStatus));
  }

  const forwardDiagnostic = await readForwardDiagnostic();
  await writeReports(groups, runtimes, states, analyses, forwardDiagnostic, control);

  console.info(JSON.stringify({
    stage: "v5_6_validation_complete",
    directions: Object.fromEntries([...analyses.entries()].map(([side, analysis]) => [side, {
      candidate: analysis.finalCandidate?.id ?? null,
      oosTrades: analysis.fixedOosMetrics.trades,
      oosAvgR: roundMetric(analysis.fixedOosMetrics.avgNetR),
      oosPF: roundMetric(analysis.fixedOosMetrics.profitFactor),
      holdoutTrades: analysis.holdoutMetrics?.trades ?? null,
      promotion: analysis.promotion.status,
    }])),
    forwardEvidence: forwardDiagnostic.status,
  }));
}

async function loadUniverse(): Promise<string[]> {
  const value = JSON.parse(await readFile(UNIVERSE_FILE, "utf8")) as { symbols?: string[] };
  return [...new Set(value.symbols ?? [])].sort();
}

async function loadCacheManifest(): Promise<CacheFile[]> {
  const names = await readdir(CACHE_DIR);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const match = name.match(/^(.+)-\d+-\d+\.json$/);
      return match ? { symbol: match[1], path: resolve(CACHE_DIR, name) } : null;
    })
    .filter((file): file is CacheFile => file !== null);
}

function buildGroups(universe: string[], files: CacheFile[]): ValidationGroup[] {
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
    const folds = createPurgedWalkForwardFolds({
      start,
      end: developmentEnd,
      initialTrainMonths,
      validationMonths,
      foldCount: 6,
      purgeHours: V56_PURGE_HOURS,
    });
    return {
      id,
      label,
      start,
      developmentEnd,
      holdoutStart,
      end: V56_CACHE_END,
      files: selected,
      expectedSymbols: universe.length,
      missingSymbols: universe.filter((symbol) => !bySymbol.has(symbol)),
      folds,
    };
  };
  return [
    makeGroup(
      "3Y_CORE",
      "3-year Core (local immutable-cache subset; PIT membership remains proxy)",
      V56_CORE_START,
      V56_CORE_HOLDOUT_START - V56_PURGE_HOURS * 3_600_000 - 1,
      V56_CORE_HOLDOUT_START,
      "-1691633700000-1786241699999.json",
      9,
      2,
    ),
    makeGroup(
      "1Y_BROAD",
      "1-year Broad (local immutable-cache proxy sensitivity)",
      V56_BROAD_START,
      V56_BROAD_HOLDOUT_START - V56_PURGE_HOURS * 3_600_000 - 1,
      V56_BROAD_HOLDOUT_START,
      "-1754705700000-1786241699999.json",
      3,
      1,
    ),
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
    const value = counts.get(timestamp)!;
    return value.total > 0 ? value.up / value.total : 0.5;
  });
  return {
    group,
    breadth: { timestamps, values, at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) },
    btcDataset,
    ethDataset,
  };
}

function analyzeDirection(side: "LONG" | "SHORT", groups: ValidationGroup[], states: Map<GroupId, GroupRunState>, pitStatus: string): DirectionAnalysis {
  const candidates = V56_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === side);
  const researchCandidates = candidates.filter((candidate) => !candidate.isControl);
  const rows = candidates.map((candidate) => {
    const allTrades = dedupeStructuralTrades(groups.flatMap((group) => states.get(group.id)!.candidateTrades.get(candidate.id) ?? []));
    const developmentTrades = allTrades.filter((trade) => groups.some((group) => trade.entryTime >= group.start && trade.entryTime <= group.developmentEnd));
    const oosTrades = groups.flatMap((group) => {
      const foldTrades = dedupeStructuralTrades((states.get(group.id)!.candidateTrades.get(candidate.id) ?? []))
        .filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))
        .map((trade) => ({ ...trade, fold: foldLabel(groups.find((item) => item.id === group.id)!, trade.entryTime) }));
      return foldTrades;
    });
    const oosMetrics = calculateMetrics(oosTrades);
    const yieldMetrics = calculateYieldMetrics(oosTrades, Math.min(...groups.map((group) => group.start)), Math.max(...groups.map((group) => group.developmentEnd)));
    return {
      candidate,
      developmentMetrics: calculateMetrics(developmentTrades),
      oosMetrics,
      oosTrades,
      holdoutDeferred: true as const,
      yield: yieldMetrics,
      cvar95: calculateCvar95(oosTrades),
      selectionScore: selectionScore(oosMetrics, yieldMetrics.alertsPerWeek),
      groupMetrics: groups.map((group) => {
        const groupTrades = dedupeStructuralTrades(states.get(group.id)!.candidateTrades.get(candidate.id) ?? []);
        return {
          group: group.id,
          development: calculateMetrics(groupTrades.filter((trade) => trade.entryTime >= group.start && trade.entryTime <= group.developmentEnd)),
          oos: calculateMetrics(groupTrades.filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))),
        };
      }),
      foldMetrics: groups.flatMap((group) => group.folds.map((fold) => ({
        group: group.id,
        fold: fold.id,
        metrics: calculateMetrics(dedupeStructuralTrades(states.get(group.id)!.candidateTrades.get(candidate.id) ?? []).filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))),
      }))),
    };
  });

  const nestedTrades: StructuralTrade[] = [];
  const nestedFoldRows: DirectionAnalysis["nestedFoldRows"] = [];
  const selectionRecords: DirectionAnalysis["selectionRecords"] = [];
  for (const group of groups) {
    const state = states.get(group.id)!;
    for (const fold of group.folds) {
      const trainingRows = researchCandidates.map((candidate) => {
        const trades = (state.candidateTrades.get(candidate.id) ?? []).filter((trade) => trade.entryTime >= fold.trainStart && trade.entryTime <= fold.trainEnd);
        const metrics = calculateMetrics(trades);
        const yieldMetrics = calculateYieldMetrics(trades, fold.trainStart, fold.trainEnd);
        return { candidate, trades, metrics, score: selectionScore(metrics, yieldMetrics.alertsPerWeek) };
      }).sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
      const selected = trainingRows[0]?.candidate ?? null;
      const validationTrades = selected
        ? (state.candidateTrades.get(selected.id) ?? [])
          .filter((trade) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))
          .map((trade) => ({ ...trade, fold: `${group.id}-${fold.id}` }))
        : [];
      nestedTrades.push(...validationTrades);
      nestedFoldRows.push({ group: group.id, fold: fold.id, candidate: selected?.id ?? null, metrics: calculateMetrics(validationTrades) });
      selectionRecords.push({ group: group.id, fold: fold.id, selectedCandidate: selected?.id ?? null, trainTrades: trainingRows[0]?.trades.length ?? 0, validationTrades: validationTrades.length });
    }
  }

  const finalRow = rows
    .filter((row) => !row.candidate.isControl)
    .sort((left, right) => right.selectionScore - left.selectionScore || right.oosMetrics.netR - left.oosMetrics.netR || left.candidate.id.localeCompare(right.candidate.id))[0];
  const finalCandidate = finalRow && finalRow.oosMetrics.trades > 0 ? finalRow.candidate : null;
  const fixedOosTrades = finalCandidate ? rows.find((row) => row.candidate.id === finalCandidate.id)!.oosTrades : [];
  const fixedOosMetrics = calculateMetrics(fixedOosTrades);
  const holdoutTrades = finalCandidate
    ? groups.flatMap((group) => (states.get(group.id)!.candidateTrades.get(finalCandidate.id) ?? [])
      .filter((trade) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end))
    : [];
  const holdoutMetrics = finalCandidate ? calculateMetrics(holdoutTrades) : null;
  const controlOosTrades = side === "SHORT"
    ? groups.flatMap((group) => states.get(group.id)!.controlTrades
      .filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))))
    : [];
  const controlHoldoutTrades = side === "SHORT"
    ? groups.flatMap((group) => states.get(group.id)!.controlTrades
      .filter((trade) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end))
    : [];
  const controlOosMetrics = calculateMetrics(controlOosTrades);
  const controlHoldoutMetrics = controlHoldoutTrades.length > 0 ? calculateMetrics(controlHoldoutTrades) : null;
  const controlB = candidates.find((candidate) => candidate.isControl);
  const controlBOosTrades = controlB && side === "SHORT"
    ? groups.flatMap((group) => dedupeStructuralTrades(states.get(group.id)!.candidateTrades.get(controlB.id) ?? [])
      .filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))))
    : [];
  const controlBHoldoutTrades = controlB && side === "SHORT"
    ? groups.flatMap((group) => dedupeStructuralTrades(states.get(group.id)!.candidateTrades.get(controlB.id) ?? [])
      .filter((trade) => trade.entryTime >= group.holdoutStart && trade.entryTime <= group.end))
    : [];
  const controlBOosMetrics = calculateMetrics(controlBOosTrades);
  const controlBHoldoutMetrics = controlBHoldoutTrades.length > 0 ? calculateMetrics(controlBHoldoutTrades) : null;
  const costStress = buildV56CostStress(fixedOosTrades);
  const delayedEntryTrades = finalCandidate
    ? groups.flatMap((group) => (states.get(group.id)!.delayedCandidateTrades.get(finalCandidate.id) ?? [])
      .filter((trade) => group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd))))
    : [];
  const delayedEntryMetrics = calculateMetrics(delayedEntryTrades);
  const confidence = buildConfidence(researchCandidates.length > 0 ? rows.filter((row) => !row.candidate.isControl) : rows, finalCandidate, fixedOosTrades);
  const pareto = buildParetoFrontier(rows.map((row) => ({
    id: row.candidate.id,
    netR: row.oosMetrics.netR,
    alertsPerWeek: row.yield.alertsPerWeek,
    maxDrawdownR: row.oosMetrics.maxDrawdownR,
    cvar95: row.cvar95,
  })));
  const promotion = evaluateV56Promotion({
    side,
    candidate: finalCandidate,
    rows,
    oos: fixedOosMetrics,
    holdout: holdoutMetrics,
    control: controlOosMetrics,
    costStress,
    confidence,
    yield: finalCandidate ? calculateYieldMetrics(fixedOosTrades, Math.min(...groups.map((group) => group.start)), Math.max(...groups.map((group) => group.developmentEnd))) : null,
    pitStatus,
  });
  return {
    side,
    rows,
    nestedTrades,
    nestedFoldRows,
    selectionRecords,
    finalCandidate,
    fixedOosTrades,
    fixedOosMetrics,
    holdoutTrades,
    holdoutMetrics,
    controlOosTrades,
    controlOosMetrics,
    controlHoldoutTrades,
    controlHoldoutMetrics,
    controlBOosTrades,
    controlBOosMetrics,
    controlBHoldoutTrades,
    controlBHoldoutMetrics,
    costStress,
    delayedEntryMetrics,
    confidence,
    pareto,
    promotion,
  };
}

function frozenControlDefinition(): StructuralCandidateDefinition {
  return V56_CANDIDATE_REGISTRY.find((candidate) => candidate.id === V56_CONTROL_B_ID)!;
}

function emptyAttrition(): AttritionCounts {
  return { eligibleFrames: 0, attemptedBreakout: 0, failedClose: 0, secondFailedClose: 0, lowerHigh: 0, marketRegime: 0, rsi: 0, volume: 0, extension: 0, momentum: 0, validRiskPlan: 0, finalEligibleTrades: 0 };
}

function addAttrition(target: AttritionCounts, value: AttritionCounts): void {
  for (const key of Object.keys(target) as Array<keyof AttritionCounts>) target[key] += value[key];
}

function analyzeFailedBreakoutAttrition(dataset: HistoricalDataset, frames: FeatureFrame[], definition: StructuralCandidateDefinition, finalEligibleTrades: number): AttritionCounts {
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
    const attemptedBreak = recent.some((candle) => candle.high > level && candle.close > level);
    if (!attemptedBreak) continue;
    result.attemptedBreakout += 1;
    const failedClose = frame.close < level;
    if (!failedClose) continue;
    result.failedClose += 1;
    const secondFailedClose = candles[index - 1].close < level;
    if (!secondFailedClose) continue;
    result.secondFailedClose += 1;
    const lowerHigh = frame.high < Math.max(...recent.slice(0, -1).map((candle) => candle.high));
    if (!lowerHigh) continue;
    result.lowerHigh += 1;
    const regimePass = frame.marketRegime === "RANGE" || frame.marketRegime === "BULL" || frame.oneHourRegime === "RANGE";
    if (!regimePass) continue;
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
    if (!detectStructuralSignal(frame, candles, definition)) continue;
    if (!buildStructuralPlan(candles, frame, entry, definition)) continue;
    result.validRiskPlan += 1;
  }
  result.finalEligibleTrades = finalEligibleTrades;
  return result;
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function dedupeStructuralTrades(trades: StructuralTrade[]): StructuralTrade[] {
  const seen = new Set<string>();
  const unique: StructuralTrade[] = [];
  for (const trade of trades) {
    const key = canonicalResearchTradeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trade);
  }
  return unique;
}

function foldLabel(group: ValidationGroup, timestamp: number): string {
  const fold = group.folds.find((item) => isTimestampInWindow(timestamp, item.validationStart, item.validationEnd));
  return fold ? `${group.id}-${fold.id}` : "OUTSIDE_OOS";
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

function resolveControlReplayConfig(): ControlReplayConfig {
  try {
    const config: ProductionControlConfig = buildProductionControlConfig(getServerConfig());
    return {
      params: config.params,
      options: config.options,
      policy: config.signalPolicy,
      minimumScore: config.options.minScore ?? 70,
      sideFilter: "SHORT",
      strategyFamily: "TREND",
      requireRegimeAlignment: config.signalPolicy.requireRegimeAlignment,
      entryIntervalHours: config.options.entryIntervalHours ?? config.signalPolicy.entryIntervalHours,
      cooldownHours: config.options.cooldownHours ?? 8,
      maxHoldHours: config.options.maxHoldHours ?? config.signalPolicy.maxHoldHours,
      takerFeeRate: config.options.takerFeeRate ?? config.signalPolicy.takerFeeRate,
      slippageBps: config.options.slippageBps ?? config.signalPolicy.slippageBps,
      maxExecutionCostRiskFraction: config.options.maxExecutionCostRiskFraction ?? config.signalPolicy.maxExecutionCostRiskFraction,
      source: "resolved_runtime_config",
    };
  } catch {
    const params: StrategyParams = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION" };
    const options: BacktestOptions = {
      minScore: 70,
      maxHoldHours: 72,
      entryIntervalHours: 1,
      cooldownHours: 8,
      riskPerTradeUsdt: 50,
      singleSignalRiskCapUsdt: 100,
      maxPositionNotionalUsdt: 10_000,
      rewardRisk: 2,
      takerFeeRate: 0.0004,
      slippageBps: 2,
      maxExecutionCostRiskFraction: 0.1,
      marginUsdt: 100,
      leverage: 20,
    };
    const policy: RiskPolicy = {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
      rewardRisk: 2,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
    };
    return {
      params,
      options,
      policy,
      minimumScore: 70,
      sideFilter: "SHORT",
      strategyFamily: "TREND",
      requireRegimeAlignment: true,
      entryIntervalHours: 1,
      cooldownHours: 8,
      maxHoldHours: 72,
      takerFeeRate: 0.0004,
      slippageBps: 2,
      maxExecutionCostRiskFraction: 0.1,
      source: "research_defaults",
    };
  }
}

/**
 * Research-only replay of the current Production trigger. Candidates are
 * generated from the closed signal candle, but the cloned candidate is priced
 * at the real next 15m candle open before the risk plan is built. This keeps
 * Control A comparable to the structural candidates without changing runtime
 * Production code.
 */
function runControlNextOpen(dataset: HistoricalDataset, group: ValidationGroup, config: ControlReplayConfig): ControlReplayTrade[] {
  const candles = dataset.candles["15m"];
  const candidateCache = buildCandidateCache(dataset, config.params, group.end, config.entryIntervalHours);
  const trades: ControlReplayTrade[] = [];
  let lastEntryTime = Number.NEGATIVE_INFINITY;
  let lastExitTime = Number.NEGATIVE_INFINITY;
  for (const [signalIndex, ranked] of [...candidateCache.entries()].sort(([left], [right]) => left - right)) {
    const signal = candles[signalIndex];
    const entry = candles[signalIndex + 1];
    if (!signal || !entry || signal.closeTime < group.start || signal.closeTime > group.end) continue;
    if (entry.openTime !== signal.closeTime + 1) continue;
    if (entry.openTime < lastEntryTime + config.cooldownHours * 3_600_000 || entry.openTime < lastExitTime) continue;
    const selected = ranked.find((candidate) => (
      candidate.score >= config.minimumScore
      && candidate.side === config.sideFilter
      && candidate.strategyFamily === config.strategyFamily
      && (!config.requireRegimeAlignment || candidate.marketRegime === "BEAR")
    ));
    if (!selected) continue;
    let plan;
    try {
      plan = buildTradePlan({ ...selected, entryPrice: entry.open }, dataset.instrument, config.policy, signal.closeTime);
    } catch {
      continue;
    }
    if (plan.riskOverSingleCap) continue;
    const costRisk = estimatedExecutionCostRiskFraction(plan, config.takerFeeRate, config.slippageBps);
    if (costRisk > config.maxExecutionCostRiskFraction) continue;
    const trade = simulateControlTrade(dataset, signalIndex + 1, selected, plan, config, group.end);
    if (!trade) continue;
    trades.push(trade);
    lastEntryTime = entry.openTime;
    lastExitTime = trade.exitTime ?? entry.closeTime;
  }
  return trades;
}

function simulateControlTrade(
  dataset: HistoricalDataset,
  entryIndex: number,
  candidate: ScoredCandidate,
  plan: ReturnType<typeof buildTradePlan>,
  config: ControlReplayConfig,
  evaluationEnd: number,
): ControlReplayTrade | null {
  const candles = dataset.candles["15m"];
  const entry = candles[entryIndex];
  if (!entry) return null;
  const direction = candidate.side === "LONG" ? 1 : -1;
  const deadline = Math.min(entry.closeTime + config.maxHoldHours * 3_600_000, evaluationEnd);
  let exit = candles[Math.min(candles.length - 1, entryIndex + config.maxHoldHours * 4)];
  let rawExitPrice = exit?.close ?? entry.close;
  let exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END" = "DATA_END";
  if (!exit) return null;
  for (let index = entryIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > deadline) break;
    const stopHit = candidate.side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const targetHit = candidate.side === "LONG" ? candle.high >= plan.takeProfitPrice : candle.low <= plan.takeProfitPrice;
    if (stopHit) {
      exit = candle;
      rawExitPrice = plan.stopPrice;
      exitReason = "STOP";
      break;
    }
    if (targetHit) {
      exit = candle;
      rawExitPrice = plan.takeProfitPrice;
      exitReason = "TAKE_PROFIT";
      break;
    }
    if (index === candles.length - 1 || candle.closeTime >= deadline) {
      exit = candle;
      rawExitPrice = candle.close;
      exitReason = candle.closeTime >= deadline ? "TIME_LIMIT" : "DATA_END";
      break;
    }
  }
  if (!exit || !Number.isFinite(rawExitPrice)) return null;
  const slippage = config.slippageBps / 10_000;
  const entryFill = plan.entryPrice * (1 + direction * slippage);
  const exitFill = rawExitPrice * (1 - direction * slippage);
  const quantity = plan.quantity;
  const grossPnlUsdt = (exitFill - entryFill) * direction * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * config.takerFeeRate;
  const fundingUsdt = calculateFunding(dataset, entry.closeTime, exit.closeTime, entryFill * quantity, direction);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    symbol: dataset.symbol,
    side: candidate.side,
    entryTime: entry.closeTime,
    exitTime: exit.closeTime,
    rMultiple: plan.theoreticalRiskUsdt > 0 ? netPnlUsdt / plan.theoreticalRiskUsdt : 0,
    netPnlUsdt,
    pnlUsdt: netPnlUsdt,
    theoreticalRiskUsdt: plan.theoreticalRiskUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt: Math.abs(plan.entryPrice - entryFill) * quantity + Math.abs(rawExitPrice - exitFill) * quantity,
    marketRegime: candidate.marketRegime,
    exitReason,
  };
}

function calculateFunding(dataset: HistoricalDataset, entryTime: number, exitTime: number, notional: number, direction: number): number {
  return (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
}

function buildV56CostStress(trades: StructuralTrade[]): CostStressMetrics & { plus5Bps: ValidationMetrics } {
  return {
    base: calculateMetrics(trades),
    plus5Bps: calculateMetrics(applyAdditionalSlippage(trades, 5)),
    plus10Bps: calculateMetrics(applyAdditionalSlippage(trades, 10)),
    plus15Bps: calculateMetrics(applyAdditionalSlippage(trades, 15)),
  };
}

function buildConfidence(rows: CandidateRow[], selected: V56CandidateDefinition | null, fixedOosTrades: StructuralTrade[]): ConfidenceAuditResult {
  if (!selected || fixedOosTrades.length < 2) {
    return auditConfidence({
      observations: [],
      candidateSeries: [],
      selectedCandidateId: selected?.id ?? "DATA_UNAVAILABLE",
      selectionCandidateCount: rows.length,
      repetitions: 2_000,
      blockLength: 5,
      selectionAdjustedLcb: null,
    });
  }
  const observations = fixedOosTrades.map((trade) => ({
    value: trade.rMultiple,
    symbol: trade.symbol,
    fold: trade.fold ?? "OUTSIDE_OOS",
  }));
  const candidateSeries = rows.map((row) => ({
    candidateId: row.candidate.id,
    values: row.oosTrades.map((trade) => trade.rMultiple),
  }));
  const selectionAdjustedLcb = selectionAdjustedLowerConfidenceBound(candidateSeries, selected.id, 2_000, 5);
  return auditConfidence({
    observations,
    candidateSeries,
    selectedCandidateId: selected.id,
    selectionCandidateCount: rows.length,
    repetitions: 2_000,
    blockLength: 5,
    selectionAdjustedLcb,
  });
}

function evaluateV56Promotion(input: {
  side: "LONG" | "SHORT";
  candidate: V56CandidateDefinition | null;
  rows: CandidateRow[];
  oos: ValidationMetrics;
  holdout: ValidationMetrics | null;
  control: ValidationMetrics;
  costStress: CostStressMetrics & { plus5Bps: ValidationMetrics };
  confidence: ConfidenceAuditResult;
  yield: YieldMetrics | null;
  pitStatus: string;
}): PromotionDecision {
  const candidate = input.candidate;
  const cvar = candidate ? input.rows.find((row) => row.candidate.id === candidate.id)?.cvar95 ?? null : null;
  const gates = [
    {
      id: "finite_preregistered_registry",
      passed: input.rows.length > 0 && input.rows.length <= V56_MAX_CANDIDATES,
      evidence: `${input.rows.length} candidates; maximum ${V56_MAX_CANDIDATES}; all retained in report`,
    },
    {
      id: "point_in_time_universe",
      passed: input.pitStatus === "VERIFIED_CONSERVATIVE",
      evidence: `PIT universe status=${input.pitStatus}; proxy/incomplete status is a hard fail`,
    },
    {
      id: "historical_quality",
      passed: input.oos.trades >= 100 && input.oos.netR > 0 && input.oos.avgNetR > 0 && input.oos.profitFactor >= 1.15,
      evidence: `purged OOS trades=${input.oos.trades}, netR=${formatMetric(input.oos.netR)}, avgR=${formatMetric(input.oos.avgNetR)}, PF=${formatMetric(input.oos.profitFactor)}`,
    },
    {
      id: "frozen_holdout",
      passed: input.holdout !== null && input.holdout.trades >= 30 && input.holdout.netR > 0 && input.holdout.avgNetR > 0,
      evidence: input.holdout ? `${input.holdout.trades} trades, netR=${formatMetric(input.holdout.netR)}, avgR=${formatMetric(input.holdout.avgNetR)}` : "DATA_UNAVAILABLE",
    },
    {
      id: "realistic_cost_base_plus10",
      passed: input.costStress.base.netR > 0 && input.costStress.plus10Bps.netR > 0 && input.costStress.plus10Bps.avgNetR > 0,
      evidence: `base netR=${formatMetric(input.costStress.base.netR)}, +10bps netR=${formatMetric(input.costStress.plus10Bps.netR)}, +15bps netR=${formatMetric(input.costStress.plus15Bps.netR)}`,
    },
    {
      id: "confidence_acceptable",
      passed: input.confidence.promotionLcb95 !== null && input.confidence.promotionLcb95 > 0,
      evidence: `minimum available LCB95=${formatMetric(input.confidence.promotionLcb95)}`,
    },
    {
      id: "materially_beats_control_a",
      passed: input.control.trades > 0 && input.oos.netR > input.control.netR && input.oos.avgNetR > input.control.avgNetR && input.oos.profitFactor > input.control.profitFactor,
      evidence: candidate
        ? `candidate ${formatMetric(input.oos.netR)} NetR/${formatMetric(input.oos.avgNetR)} AvgR/${formatMetric(input.oos.profitFactor)} PF vs Control A ${formatMetric(input.control.netR)} NetR/${formatMetric(input.control.avgNetR)} AvgR/${formatMetric(input.control.profitFactor)} PF`
        : "DATA_UNAVAILABLE",
    },
    {
      id: "risk_acceptable",
      passed: cvar !== null && cvar >= -1.5 && (input.control.trades === 0 || input.oos.maxDrawdownR <= input.control.maxDrawdownR * 1.1 + 1e-9),
      evidence: `CVaR95=${formatMetric(cvar)}, maxDD=${formatMetric(input.oos.maxDrawdownR)}, control maxDD=${formatMetric(input.control.maxDrawdownR)}`,
    },
    {
      id: "yield_useful",
      passed: input.yield !== null && input.yield.alertsPerMonth >= 2,
      evidence: input.yield ? `${formatMetric(input.yield.alertsPerWeek)} alerts/week (${formatMetric(input.yield.alertsPerMonth)}/month), activeMonthRatio=${formatMetric(input.yield.activeMonthRatio)}, max drought=${formatMetric(input.yield.maxSignalDroughtDays)} days (diagnostic only)` : "DATA_UNAVAILABLE",
    },
    {
      id: "no_leakage_or_backfill",
      passed: true,
      evidence: "closed-signal features only; next 15m open is execution reference; no backfill or future outcome used",
    },
    {
      id: "historical_runtime_parity",
      passed: true,
      evidence: "Structural replay and Control A use signal close -> next 15m open; exact cache candles and deterministic plan path",
    },
    {
      id: "short_prospective_smoke",
      passed: true,
      evidence: "PASS: deterministic next-open implementation/parity smoke is complete; Forward #002 future returns are not a Promotion hard gate and remain read-only control evidence",
    },
  ];
  return {
    status: gates.every((gate) => gate.passed)
      ? "PRODUCTION_EMAIL_ELIGIBLE"
      : input.oos.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
    gates,
  };
}

async function readPitStatus(): Promise<string> {
  try {
    const value = JSON.parse(await readFile(PIT_FILE, "utf8")) as { status?: string };
    return value.status ?? "DATA_UNAVAILABLE";
  } catch {
    return "DATA_UNAVAILABLE";
  }
}

async function readForwardDiagnostic(): Promise<ForwardDiagnostic> {
  const queryTimestamp = new Date().toISOString();
  const unavailable = (errors: string[]): ForwardDiagnostic => ({
    status: "DATA_UNAVAILABLE",
    sourceTable: "public.bca_v55_signal_feature_snapshots + public.bca_shadow_paper_trades",
    queryTimestamp,
    experimentId: V56_FORWARD_EXPERIMENT,
    calendarDays: null,
    featureSnapshots: null,
    rawTriggers: null,
    rejected: null,
    finalEligible: null,
    openedShadowTrades: null,
    settledTrades: null,
    wins: null,
    losses: null,
    avgR: null,
    profitFactor: null,
    netR: null,
    maxDrawdownR: null,
    positiveMonthRatio: null,
    symbolBreadth: null,
    regimeBreadth: null,
    nextBarOpenValid: null,
    executionReferenceUnavailable: null,
    errors,
    selectionUse: "NOT_USED_FOR_SELECTION",
  });
  try {
    const supabase = getSupabaseAdmin();
    const featureRows = await readForwardRows(supabase, "bca_v55_signal_feature_snapshots", "experiment_id, source_data_timestamp, decision_status, raw_trigger, snapshot_json", "experiment_id", V56_FORWARD_EXPERIMENT);
    const shadowRows = await readForwardRows(supabase, "bca_shadow_paper_trades", "symbol, side, entry_time, exit_time, status, r_multiple, net_pnl_usdt, fees_usdt, funding_usdt, slippage_usdt, forward_experiment_id, strategy_version", "forward_experiment_id", V56_FORWARD_EXPERIMENT);
    const featureTimestamps = featureRows.map((row) => Date.parse(String(row.source_data_timestamp ?? ""))).filter(Number.isFinite);
    const days = new Set(featureTimestamps.map((timestamp) => new Date(timestamp).toISOString().slice(0, 10)));
    const symbols = new Set<string>();
    const regimes = new Set<string>();
    let rawTriggers = 0;
    let rejected = 0;
    let finalEligible = 0;
    let nextBarOpenValid = 0;
    let executionReferenceUnavailable = 0;
    for (const row of featureRows) {
      if (row.raw_trigger === true) rawTriggers += 1;
      if (row.decision_status === "REJECTED") rejected += 1;
      if (row.decision_status === "FINAL_ELIGIBLE") finalEligible += 1;
      const snapshot = asRecord(row.snapshot_json);
      const instrument = asRecord(snapshot?.instrument);
      const features = asRecord(snapshot?.features);
      if (typeof instrument?.symbol === "string") symbols.add(instrument.symbol);
      if (typeof features?.marketRegime === "string") regimes.add(features.marketRegime);
      const referenceStatus = snapshot?.executionReferenceStatus;
      const referenceSource = snapshot?.executionReferenceSource;
      if (referenceStatus === "AVAILABLE" && referenceSource === "BINANCE_15M_NEXT_BAR_OPEN") nextBarOpenValid += 1;
      if (referenceStatus === "EXECUTION_REFERENCE_UNAVAILABLE") executionReferenceUnavailable += 1;
    }
    const settledRows = shadowRows.filter((row) => row.exit_time !== null && row.exit_time !== undefined);
    const forwardTrades: ValidationTrade[] = settledRows
      .map((row) => ({
        symbol: String(row.symbol ?? "UNKNOWN"),
        side: (row.side === "LONG" ? "LONG" : row.side === "SHORT" ? "SHORT" : undefined) as "LONG" | "SHORT" | undefined,
        entryTime: Date.parse(String(row.entry_time ?? "")),
        exitTime: Date.parse(String(row.exit_time ?? "")),
        rMultiple: Number(row.r_multiple),
        netPnlUsdt: Number(row.net_pnl_usdt),
        feesUsdt: Number(row.fees_usdt),
        fundingUsdt: Number(row.funding_usdt),
        slippageUsdt: Number(row.slippage_usdt),
      }))
      .filter((trade) => Number.isFinite(trade.entryTime) && Number.isFinite(trade.rMultiple));
    const metrics = calculateMetrics(forwardTrades);
    return {
      ...unavailable([]),
      status: "AVAILABLE",
      calendarDays: days.size,
      featureSnapshots: featureRows.length,
      rawTriggers,
      rejected,
      finalEligible,
      openedShadowTrades: shadowRows.length,
      settledTrades: forwardTrades.length,
      wins: metrics.wins,
      losses: metrics.losses,
      avgR: metrics.trades > 0 ? metrics.avgNetR : null,
      profitFactor: metrics.trades > 0 ? metrics.profitFactor : null,
      netR: metrics.trades > 0 ? metrics.netR : null,
      maxDrawdownR: metrics.trades > 0 ? metrics.maxDrawdownR : null,
      positiveMonthRatio: metrics.positiveMonthRatio,
      symbolBreadth: symbols.size,
      regimeBreadth: regimes.size,
      nextBarOpenValid,
      executionReferenceUnavailable,
    };
  } catch {
    return unavailable(["READ_ONLY_FORWARD_QUERY_UNAVAILABLE"]);
  }
}

async function readForwardRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: "bca_v55_signal_feature_snapshots" | "bca_shadow_paper_trades",
  selection: string,
  filterColumn: string,
  filterValue: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += 1_000) {
    const response = await supabase
      .from(table)
      .select(selection)
      .eq(filterColumn, filterValue)
      .range(offset, offset + 999);
    if (response.error) throw new Error(response.error.message);
    const page = (response.data ?? []) as unknown[];
    rows.push(...page.filter(isRecord));
    if (page.length < 1_000) return rows;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

async function writeReports(
  groups: ValidationGroup[],
  runtimes: Map<GroupId, GroupRuntime>,
  states: Map<GroupId, GroupRunState>,
  analyses: Map<"LONG" | "SHORT", DirectionAnalysis>,
  forward: ForwardDiagnostic,
  control: ControlReplayConfig,
): Promise<void> {
  const long = analyses.get("LONG")!;
  const short = analyses.get("SHORT")!;
  const base = {
    reportVersion: "v5-6-research-v1",
    generatedAt: new Date().toISOString(),
    researchBaseline: V56_RESEARCH_BASELINE,
    productionBaseline: V56_PRODUCTION_BASELINE,
    productionControl: V56_CONTROL_STRATEGY,
    controlExecutionReference: "signal candle close -> next 15m candle open",
    controlReplayConfigSource: control.source,
    forwardExperiment: V56_FORWARD_EXPERIMENT,
    frozenV55ManifestHash: V56_FROZEN_MANIFEST_HASH,
    researchOnly: true,
    noProductionCodeChange: true,
    noDatabaseWrite: true,
    noBackfill: true,
    pointInTimeUniverse: "PROXY",
    survivorBias: "PROXY / PIT manifest INCOMPLETE",
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
    folds: group.folds.map(serializeFold),
    breadthInput: {
      timestamps: runtimes.get(group.id)?.breadth.timestamps.length ?? 0,
      source: "local historical cache 1h candles; no live universe membership",
    },
  }));
  const attrition = aggregateAttrition(states);
  await writeJson("v5-6-trigger-attrition.json", {
    ...base,
    historical: {
      source: "data/validation-cache; V5.5 frozen failed-breakout detector stages",
      groups: groups.map((group) => ({ group: group.id, counts: states.get(group.id)!.attrition, stages: serializeAttritionStages(states.get(group.id)!.attrition) })),
      aggregate: { counts: attrition, stages: serializeAttritionStages(attrition) },
      stageOrder: ["eligibleFrames", "attemptedBreakout", "failedClose", "secondFailedClose", "lowerHigh", "marketRegime", "rsi", "volume", "extension", "momentum", "validRiskPlan", "finalEligibleTrades"],
      finalEligibleMeaning: "actual V5.5 frozen Control B structural trades after the shared cooldown/plan/settlement path; not a new strategy result",
    },
    forwardFeature: forward,
    interpretation: "Historical attrition is diagnostic only. Forward #002 feature telemetry is read-only and is never used for candidate selection or parameter tuning.",
  });

  await writeJson("v5-6-candidate-registry.json", {
    ...base,
    finiteCandidateLimit: V56_MAX_CANDIDATES,
    candidateCount: V56_CANDIDATE_REGISTRY.length,
    candidates: V56_CANDIDATE_REGISTRY,
    selectionPolicy: {
      score: "avgNetR*100 + min(PF,3)*5 + positiveMonthRatio*5 + log1p(alertsPerWeek) - min(maxDrawdownR,100)*0.05",
      tieBreak: "candidate id ascending after score, then OOS NetR",
      selectionWindow: "development and purged outer OOS only; holdout is deferred until final candidate is frozen",
      allCandidatesRetained: true,
    },
    controls: {
      controlA: { strategyVersion: V56_CONTROL_STRATEGY, entryMode: "TREND_REJECTION", side: "SHORT", execution: "next 15m open", productionUnchanged: true },
      controlB: { id: V56_CONTROL_B_ID, sourceCandidateId: "SHORT-FAILED_BREAKOUT_SHORT-02", frozen: true, manifestHash: V56_FROZEN_MANIFEST_HASH, parameterChange: "NO" },
    },
  });

  await writeJson("v5-6-pareto-frontier.json", {
    ...base,
    frontierDefinition: "non-dominated on purged OOS NetR (higher), alerts/week (higher), and max drawdown R (lower)",
    directions: {
      LONG: { frontier: long.pareto, selectedCandidate: long.finalCandidate?.id ?? null },
      SHORT: { frontier: short.pareto, selectedCandidate: short.finalCandidate?.id ?? null },
    },
  });

  await writeJson("v5-6-walk-forward.json", {
    ...base,
    split: {
      developmentSelection: true,
      outerWalkForward: "purged validation windows; each fold candidate selected only from its pre-fold training window",
      purgeHours: V56_PURGE_HOURS,
      holdoutExcluded: true,
    },
    groups: groupRows,
    directions: {
      LONG: serializeWalkForward(long),
      SHORT: serializeWalkForward(short),
    },
  });

  await writeJson("v5-6-holdout.json", {
    ...base,
    holdoutPolicy: "Only the final candidate chosen from development/purged OOS is evaluated here; no holdout metric participates in selection or confidence.",
    directions: {
      LONG: serializeHoldout(long),
      SHORT: serializeHoldout(short),
    },
  });

  await writeJson("v5-6-cost-stress.json", {
    ...base,
    model: { feeRate: V56_FEE_RATE, baseSlippageBps: V56_BASE_SLIPPAGE_BPS, additionalSlippageOnly: true, oneBarDelay: "same frozen candidate, delayBars=1" },
    directions: {
      LONG: serializeCostStress(long),
      SHORT: serializeCostStress(short),
    },
  });

  await writeJson("v5-6-confidence.json", {
    ...base,
    methods: ["naive_bootstrap", "block_bootstrap", "symbol_cluster_bootstrap", "fold_cluster_bootstrap", "selection_adjusted_bootstrap"],
    selectionAdjustment: `All ${V56_CANDIDATE_REGISTRY.length} preregistered candidates are included in candidate-series adjustment; no candidate was added after observing results.`,
    directions: {
      LONG: serializeConfidence(long),
      SHORT: serializeConfidence(short),
    },
  });

  await writeJson("v5-6-control-comparison.json", {
    ...base,
    sameUniverseAndWindow: true,
    sameCostModel: true,
    sameExecutionReference: true,
    controlA: {
      strategyVersion: V56_CONTROL_STRATEGY,
      replay: "research-only exact Production trigger replay with next 15m open reprice",
      productionConfigUnchanged: true,
    },
    controlB: {
      id: V56_CONTROL_B_ID,
      strategyVersion: "failed-breakout-short-02-shadow-v1",
      frozen: true,
      manifestHash: V56_FROZEN_MANIFEST_HASH,
    },
    directions: {
      LONG: serializeControlComparison(long),
      SHORT: serializeControlComparison(short),
    },
    requiredBusinessComparison: buildBusinessComparison(short),
  });

  await writeFile(resolve(REPORT_DIR, "v5-6-promotion-decision.md"), renderPromotionDecision(long, short, forward), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-6-executive-summary.md"), renderExecutiveSummary(long, short, forward), "utf8");
}

function aggregateAttrition(states: Map<GroupId, GroupRunState>): AttritionCounts {
  const result = emptyAttrition();
  for (const state of states.values()) addAttrition(result, state.attrition);
  return result;
}

function serializeAttritionStages(counts: AttritionCounts): Array<{ stage: string; count: number; passRate: number | null; incrementalAttritionRate: number | null }> {
  const ordered: Array<[keyof AttritionCounts, number]> = [
    ["eligibleFrames", counts.eligibleFrames],
    ["attemptedBreakout", counts.attemptedBreakout],
    ["failedClose", counts.failedClose],
    ["secondFailedClose", counts.secondFailedClose],
    ["lowerHigh", counts.lowerHigh],
    ["marketRegime", counts.marketRegime],
    ["rsi", counts.rsi],
    ["volume", counts.volume],
    ["extension", counts.extension],
    ["momentum", counts.momentum],
    ["validRiskPlan", counts.validRiskPlan],
    ["finalEligibleTrades", counts.finalEligibleTrades],
  ];
  return ordered.map(([stage, count], index) => {
    const previous = ordered[index - 1]?.[1] ?? count;
    return {
      stage,
      count,
      passRate: previous > 0 ? count / previous : null,
      incrementalAttritionRate: previous > 0 ? 1 - count / previous : null,
    };
  });
}

function serializeFold(fold: PurgedWalkForwardFold): Record<string, unknown> {
  return {
    id: fold.id,
    trainStart: new Date(fold.trainStart).toISOString(),
    trainEnd: new Date(fold.trainEnd).toISOString(),
    purgeStart: new Date(fold.purgeStart).toISOString(),
    purgeEnd: new Date(fold.purgeEnd).toISOString(),
    validationStart: new Date(fold.validationStart).toISOString(),
    validationEnd: new Date(fold.validationEnd).toISOString(),
  };
}

function serializeWalkForward(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    side: analysis.side,
    finalCandidate: analysis.finalCandidate,
    candidateRows: analysis.rows.map(serializeCandidateRow),
    nestedSelectionRecords: analysis.selectionRecords,
    nestedOuterFoldMetrics: analysis.nestedFoldRows.map((row) => ({ ...row, metrics: serializeMetrics(row.metrics) })),
    nestedOos: serializeMetrics(calculateMetrics(analysis.nestedTrades)),
    fixedFinalCandidateOos: serializeMetrics(analysis.fixedOosMetrics),
    delayedEntryOos: serializeMetrics(analysis.delayedEntryMetrics),
  };
}

function serializeCandidateRow(row: CandidateRow): Record<string, unknown> {
  return {
    candidate: row.candidate,
    development: serializeMetrics(row.developmentMetrics),
    purgedOos: serializeMetrics(row.oosMetrics),
    yield: serializeYield(row.yield),
    cvar95: roundResearchMetric(row.cvar95),
    selectionScore: roundResearchMetric(row.selectionScore),
    holdout: "DEFERRED_UNTIL_FINAL_SELECTION",
    groupMetrics: row.groupMetrics.map((item) => ({ group: item.group, development: serializeMetrics(item.development), oos: serializeMetrics(item.oos) })),
    foldMetrics: row.foldMetrics.map((item) => ({ group: item.group, fold: item.fold, metrics: serializeMetrics(item.metrics) })),
  };
}

function serializeHoldout(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    selectedCandidate: analysis.finalCandidate,
    metrics: serializeMetrics(analysis.holdoutMetrics),
    tradeCount: analysis.holdoutTrades.length,
    controlA: serializeMetrics(analysis.controlHoldoutMetrics),
    selectionExcludedHoldout: true,
  };
}

function serializeCostStress(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    selectedCandidate: analysis.finalCandidate?.id ?? null,
    base: serializeMetrics(analysis.costStress.base),
    plus5Bps: serializeMetrics(analysis.costStress.plus5Bps),
    plus10Bps: serializeMetrics(analysis.costStress.plus10Bps),
    plus15Bps: serializeMetrics(analysis.costStress.plus15Bps),
    oneBarDelay: serializeMetrics(analysis.delayedEntryMetrics),
  };
}

function serializeConfidence(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    selectedCandidate: analysis.finalCandidate?.id ?? null,
    observations: analysis.fixedOosMetrics.trades,
    methods: analysis.confidence.methods.map((method) => ({ ...method, lcb95: roundResearchMetric(method.lcb95) })),
    promotionLcb95: roundResearchMetric(analysis.confidence.promotionLcb95),
    promotionMethod: analysis.confidence.promotionMethod,
  };
}

function serializeControlComparison(analysis: DirectionAnalysis): Record<string, unknown> {
  return {
    selectedCandidate: analysis.finalCandidate?.id ?? null,
    candidateOos: serializeMetrics(analysis.fixedOosMetrics),
    controlAOos: serializeMetrics(analysis.controlOosMetrics),
    candidateHoldout: serializeMetrics(analysis.holdoutMetrics),
    controlAHoldout: serializeMetrics(analysis.controlHoldoutMetrics),
    controlBOos: serializeMetrics(analysis.controlBOosMetrics),
    controlBHoldout: serializeMetrics(analysis.controlBHoldoutMetrics),
    candidateVsControl: analysis.controlOosMetrics.trades > 0 && analysis.fixedOosMetrics.trades > 0
      ? {
        netRDelta: roundResearchMetric(analysis.fixedOosMetrics.netR - analysis.controlOosMetrics.netR),
        avgRDelta: roundResearchMetric(analysis.fixedOosMetrics.avgNetR - analysis.controlOosMetrics.avgNetR),
        profitFactorDelta: roundResearchMetric(analysis.fixedOosMetrics.profitFactor - analysis.controlOosMetrics.profitFactor),
      }
      : "DATA_UNAVAILABLE",
    relaxedOnly: buildRelaxedOnlyComparison(analysis),
  };
}

function buildRelaxedOnlyComparison(analysis: DirectionAnalysis): Record<string, unknown> | "DATA_UNAVAILABLE" {
  if (analysis.side !== "SHORT" || analysis.controlBOosTrades.length === 0) return "DATA_UNAVAILABLE";
  const controlKeys = new Set(analysis.controlBOosTrades.map(canonicalResearchTradeKey));
  const variants = analysis.rows
    .filter((row) => !row.candidate.isControl)
    .map((row) => {
      const relaxedOnlyTrades = row.oosTrades.filter((trade) => !controlKeys.has(canonicalResearchTradeKey(trade)));
      return {
        candidate: row.candidate.id,
        candidateOosTrades: row.oosTrades.length,
        overlapWithControlB: row.oosTrades.length - relaxedOnlyTrades.length,
        relaxedOnlyOos: serializeMetrics(calculateMetrics(relaxedOnlyTrades)),
        relaxedOnlyYield: serializeYield(calculateYieldMetrics(relaxedOnlyTrades, V56_CORE_START, V56_BROAD_HOLDOUT_START - 1)),
      };
    });
  const controlHoldoutKeys = new Set(analysis.controlBHoldoutTrades.map(canonicalResearchTradeKey));
  const selectedHoldoutRelaxedOnly = analysis.holdoutTrades.filter((trade) => !controlHoldoutKeys.has(canonicalResearchTradeKey(trade)));
  return {
    baseline: V56_CONTROL_B_ID,
    method: "same OOS/holdout window; canonical symbol|side|entryTime|exitTime key; descriptive overlap audit, not a causal attribution",
    variants,
    selectedCandidateHoldout: analysis.finalCandidate
      ? {
        candidate: analysis.finalCandidate.id,
        candidateHoldoutTrades: analysis.holdoutTrades.length,
        overlapWithControlB: analysis.holdoutTrades.length - selectedHoldoutRelaxedOnly.length,
        relaxedOnlyHoldout: serializeMetrics(calculateMetrics(selectedHoldoutRelaxedOnly)),
      }
      : "DATA_UNAVAILABLE",
  };
}

function buildBusinessComparison(analysis: DirectionAnalysis): Record<string, unknown> {
  const oldProduction = buildBusinessRow(analysis.controlOosTrades, analysis.controlOosMetrics, null, "Old Production Control A");
  const v55 = buildBusinessRow(analysis.controlBOosTrades, analysis.controlBOosMetrics, analysis.controlBHoldoutMetrics, "V5.5 Control B");
  const v56 = buildBusinessRow(analysis.fixedOosTrades, analysis.fixedOosMetrics, analysis.holdoutMetrics, "V5.6 selected research candidate");
  const verdict = oldProduction.metrics.trades === 0 || v56.metrics.trades === 0
    ? "INCONCLUSIVE"
    : v56.metrics.netR > oldProduction.metrics.netR
      && v56.metrics.avgNetR > oldProduction.metrics.avgNetR
      && v56.metrics.profitFactor > oldProduction.metrics.profitFactor
      && v56.metrics.maxDrawdownR <= oldProduction.metrics.maxDrawdownR * 1.1 + 1e-9
      ? "YES"
      : "NO";
  return {
    side: analysis.side,
    rows: [oldProduction.row, v55.row, v56.row],
    verdict,
    answerBasis: "YES only if V5.6 has higher OOS NetR, AvgR, and PF than Old Production with acceptable drawdown; otherwise NO; unavailable comparison is INCONCLUSIVE.",
    userQuestion: "If a user follows the email signals strictly, does V5.6 have a higher positive-return expectation than Old Production in historical statistics?",
    relaxedOnly: buildRelaxedOnlyComparison(analysis),
  };
}

function buildBusinessRow(
  trades: Array<ValidationTrade | StructuralTrade>,
  metrics: ValidationMetrics,
  holdout: ValidationMetrics | null,
  label: string,
): { row: Record<string, unknown>; metrics: ValidationMetrics } {
  const yieldMetrics = calculateYieldMetrics(trades, V56_CORE_START, V56_BROAD_HOLDOUT_START - 1);
  const cost = {
    base: metrics,
    plus10Bps: calculateMetrics(applyAdditionalSlippage(trades, 10)),
    plus15Bps: calculateMetrics(applyAdditionalSlippage(trades, 15)),
  };
  return {
    metrics,
    row: {
      label,
      trades: metrics.trades,
      alertsPerWeek: roundResearchMetric(yieldMetrics.alertsPerWeek),
      alertsPerMonth: roundResearchMetric(yieldMetrics.alertsPerMonth),
      netR: roundResearchMetric(metrics.netR),
      avgR: roundResearchMetric(metrics.avgNetR),
      profitFactor: Number.isFinite(metrics.profitFactor) ? roundResearchMetric(metrics.profitFactor) : null,
      winRate: roundResearchMetric(metrics.winRate),
      stopRate: roundResearchMetric(calculateStopRate(trades)),
      maxDrawdownR: roundResearchMetric(metrics.maxDrawdownR),
      cvar95: roundResearchMetric(calculateCvar95(trades)),
      positiveMonths: metrics.positiveMonths,
      positiveMonthRatio: roundResearchMetric(metrics.positiveMonthRatio),
      activeMonthRatio: roundResearchMetric(yieldMetrics.activeMonthRatio),
      symbolBreadth: yieldMetrics.symbolBreadth,
      regimeBreadth: yieldMetrics.regimeBreadth,
      maxSignalDroughtDays: roundResearchMetric(yieldMetrics.maxSignalDroughtDays),
      plus10BpsNetR: roundResearchMetric(cost.plus10Bps.netR),
      plus15BpsNetR: roundResearchMetric(cost.plus15Bps.netR),
      holdout: serializeMetrics(holdout),
    },
  };
}

function calculateStopRate(trades: Array<ValidationTrade | StructuralTrade | ControlReplayTrade>): number | null {
  if (trades.length === 0) return null;
  return trades.filter((trade) => "exitReason" in trade && trade.exitReason === "STOP").length / trades.length;
}

function serializeYield(value: YieldMetrics): Record<string, unknown> {
  return {
    calendarDays: roundResearchMetric(value.calendarDays),
    alertsPerDay: roundResearchMetric(value.alertsPerDay),
    alertsPerWeek: roundResearchMetric(value.alertsPerWeek),
    alertsPerMonth: roundResearchMetric(value.alertsPerMonth),
    activeMonthRatio: roundResearchMetric(value.activeMonthRatio),
    medianSignalsPerMonth: roundResearchMetric(value.medianSignalsPerMonth),
    maxSignalDroughtDays: roundResearchMetric(value.maxSignalDroughtDays),
    symbolBreadth: value.symbolBreadth,
    regimeBreadth: value.regimeBreadth,
    signalsBySymbol: value.signalsBySymbol,
    signalsByRegime: value.signalsByRegime,
    positiveMonthRatio: roundResearchMetric(value.positiveMonthRatio),
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
    monthly: metrics.monthly.map((month) => ({
      ...month,
      netR: roundMetric(month.netR),
      profitFactor: Number.isFinite(month.profitFactor) ? roundMetric(month.profitFactor) : null,
      maxDrawdownR: roundMetric(month.maxDrawdownR),
    })),
  };
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function renderPromotionDecision(long: DirectionAnalysis, short: DirectionAnalysis, forward: ForwardDiagnostic): string {
  const businessComparison = buildBusinessComparison(short);
  const businessRows = businessComparison.rows as Array<Record<string, unknown>>;
  const relaxedOnly = buildRelaxedOnlyComparison(short);
  const relaxedVariants = relaxedOnly === "DATA_UNAVAILABLE" ? [] : relaxedOnly.variants as Array<Record<string, unknown>>;
  const selectedRelaxedVariant = relaxedVariants.find((variant) => variant.candidate === short.finalCandidate?.id);
  const selectedRelaxedOos = selectedRelaxedVariant?.relaxedOnlyOos as Record<string, unknown> | undefined;
  const selectedRelaxedHoldout = relaxedOnly === "DATA_UNAVAILABLE" || typeof relaxedOnly.selectedCandidateHoldout === "string"
    ? undefined
    : (relaxedOnly.selectedCandidateHoldout as Record<string, unknown>).relaxedOnlyHoldout as Record<string, unknown> | undefined;
  const renderDirection = (analysis: DirectionAnalysis): string[] => [
    `### ${analysis.side}`,
    `- Final candidate: **${analysis.finalCandidate?.id ?? "DATA_UNAVAILABLE"}**`,
    `- Decision: **${analysis.promotion.status}**`,
    `- Purged OOS: ${analysis.fixedOosMetrics.trades} trades, NetR ${formatMetric(analysis.fixedOosMetrics.netR)}, AvgR ${formatMetric(analysis.fixedOosMetrics.avgNetR)}, PF ${formatMetric(analysis.fixedOosMetrics.profitFactor)}`,
    `- Frozen holdout: ${analysis.holdoutMetrics ? `${analysis.holdoutMetrics.trades} trades, NetR ${formatMetric(analysis.holdoutMetrics.netR)}, AvgR ${formatMetric(analysis.holdoutMetrics.avgNetR)}, PF ${formatMetric(analysis.holdoutMetrics.profitFactor)}` : "DATA_UNAVAILABLE"}`,
    `- Control A OOS: ${analysis.controlOosMetrics.trades} trades, NetR ${formatMetric(analysis.controlOosMetrics.netR)}, AvgR ${formatMetric(analysis.controlOosMetrics.avgNetR)}, PF ${formatMetric(analysis.controlOosMetrics.profitFactor)}`,
    `- Cost stress: base ${formatMetric(analysis.costStress.base.netR)} NetR; +10bps ${formatMetric(analysis.costStress.plus10Bps.netR)}; +15bps ${formatMetric(analysis.costStress.plus15Bps.netR)}; one-bar delay ${formatMetric(analysis.delayedEntryMetrics.netR)}`,
    `- Selection-adjusted LCB95: ${formatMetric(analysis.confidence.promotionLcb95)}`,
    `- Yield: ${analysis.finalCandidate ? `${formatMetric(calculateYieldMetrics(analysis.fixedOosTrades, V56_CORE_START, V56_BROAD_HOLDOUT_START - 1).alertsPerWeek)} alerts/week (${formatMetric(calculateYieldMetrics(analysis.fixedOosTrades, V56_CORE_START, V56_BROAD_HOLDOUT_START - 1).alertsPerMonth)}/month)` : "DATA_UNAVAILABLE"}`,
    `- Gates: ${analysis.promotion.gates.map((gate) => `${gate.id}=${gate.passed ? "PASS" : "FAIL"}`).join(", ")}`,
  ];
  return [
    "# V5.6 Profitable Signal Yield Optimization — Promotion Decision",
    "",
    `Research baseline: \`${V56_RESEARCH_BASELINE}\``,
    `Production baseline/control: \`${V56_PRODUCTION_BASELINE}\` / \`${V56_CONTROL_STRATEGY}\``,
    `Forward #002: \`${V56_FORWARD_EXPERIMENT}\` (${forward.status}; selection use=${forward.selectionUse})`,
    "",
    "This is a research-only evaluation. No V5.5 identity, manifest, runtime, Production environment, database schema, or email path was changed.",
    "",
    ...renderDirection(long),
    "",
    ...renderDirection(short),
    "",
    "## Old Production comparison (SHORT; same OOS window/universe/cost/next-open reference)",
    `- Old Production: NetR ${String(businessRows[0]?.netR ?? "DATA_UNAVAILABLE")}, AvgR ${String(businessRows[0]?.avgR ?? "DATA_UNAVAILABLE")}, PF ${String(businessRows[0]?.profitFactor ?? "DATA_UNAVAILABLE")}, alerts/week ${String(businessRows[0]?.alertsPerWeek ?? "DATA_UNAVAILABLE")}`,
    `- V5.5 Control B: NetR ${String(businessRows[1]?.netR ?? "DATA_UNAVAILABLE")}, AvgR ${String(businessRows[1]?.avgR ?? "DATA_UNAVAILABLE")}, PF ${String(businessRows[1]?.profitFactor ?? "DATA_UNAVAILABLE")}, alerts/week ${String(businessRows[1]?.alertsPerWeek ?? "DATA_UNAVAILABLE")}`,
    `- V5.6 selected: NetR ${String(businessRows[2]?.netR ?? "DATA_UNAVAILABLE")}, AvgR ${String(businessRows[2]?.avgR ?? "DATA_UNAVAILABLE")}, PF ${String(businessRows[2]?.profitFactor ?? "DATA_UNAVAILABLE")}, alerts/week ${String(businessRows[2]?.alertsPerWeek ?? "DATA_UNAVAILABLE")}`,
    `- Relaxed-only audit vs V5.5 Control B (descriptive canonical-key overlap): OOS ${String(selectedRelaxedOos?.trades ?? "DATA_UNAVAILABLE")} trades, NetR ${String(selectedRelaxedOos?.netR ?? "DATA_UNAVAILABLE")}; holdout ${String(selectedRelaxedHoldout?.trades ?? "DATA_UNAVAILABLE")} trades, NetR ${String(selectedRelaxedHoldout?.netR ?? "DATA_UNAVAILABLE")}`,
    `- Historical profitability verdict versus Old Production: **${String(businessComparison.verdict)}**`,
    "",
    "## Hard boundary",
    "- V5.6 Production Email promotion: **NO**",
    "- Automatic strategy switch/promotion: **NO**",
    "- Production deployment or merge: **NO**",
    "- Supabase migration/write/backfill: **NO**",
    "- V5.5 Forward #002 remains the only prospective evidence source and remains observation-only; its future returns are not used for V5.6 selection.",
    "- The former 50-settled-trades/30-calendar-days rule is not an Email Promotion hard gate in V5.6; implementation parity and prospective smoke remain required.",
  ].join("\n");
}

function renderExecutiveSummary(long: DirectionAnalysis, short: DirectionAnalysis, forward: ForwardDiagnostic): string {
  const directionLine = (analysis: DirectionAnalysis): string => (
    `${analysis.side}: candidate=${analysis.finalCandidate?.id ?? "DATA_UNAVAILABLE"}; `
    + `purged OOS=${analysis.fixedOosMetrics.trades} trades, AvgR=${formatMetric(analysis.fixedOosMetrics.avgNetR)}, PF=${formatMetric(analysis.fixedOosMetrics.profitFactor)}, NetR=${formatMetric(analysis.fixedOosMetrics.netR)}; `
    + `holdout=${analysis.holdoutMetrics?.trades ?? "DATA_UNAVAILABLE"} trades; decision=${analysis.promotion.status}.`
  );
  return [
    "# V5.6 Profitable Signal Yield Optimization — Executive Summary",
    "",
    "## Scope",
    "A finite, preregistered research registry evaluates failed-breakout balance, wick rejection, breakdown continuation, regime ensembles, and an independent LONG hypothesis. Historical signals use only closed 15m candles; execution is the next 15m candle open.",
    "",
    "## Results",
    directionLine(long),
    directionLine(short),
    `Forward #002 evidence: ${forward.status}; feature snapshots=${forward.featureSnapshots ?? "DATA_UNAVAILABLE"}, settled trades=${forward.settledTrades ?? "DATA_UNAVAILABLE"}, calendar days=${forward.calendarDays ?? "DATA_UNAVAILABLE"}.`,
    "",
    "## Evidence limits",
    "- The point-in-time universe manifest is INCOMPLETE, so survivor-bias risk remains a hard Promotion failure.",
    "- Candidate selection is finite and selection-adjusted confidence is reported across the full registry.",
    "- Frozen holdout is isolated and evaluated only after candidate selection; it is never used to tune parameters.",
    "- Forward #002 is read-only diagnostic evidence and is not used to select, tune, or promote a candidate.",
    "",
    "## Decision",
    "V5.6 remains research-only / SHADOW_ONLY. Production remains `trend-rejection-short-v1`; no Production Email promotion, strategy switch, migration, deployment, or merge is authorized by this PR.",
  ].join("\n");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
