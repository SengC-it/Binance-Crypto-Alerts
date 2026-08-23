import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidateCache, runPortfolioBacktest, type BacktestContext, type BacktestOptions } from "@/lib/backtest/engine";
import {
  simulateDelayedReferenceTrade,
  calculateSlippageStress,
  type ExecutionDelay,
} from "@/lib/backtest/execution-stress";
import { DEFAULT_VALIDATION_COST_ASSUMPTIONS, validationCostAssumptions, type ValidationCostAssumptions } from "@/lib/backtest/cost-assumptions";
import {
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
  evaluatePromotionGate,
  summarizeDirectionalTrades,
  type DirectionalValidationMetrics,
  type PurgedWalkForwardFold,
} from "@/lib/backtest/validation";
import type { HistoricalDataset, PortfolioBacktestResult } from "@/lib/backtest/types";
import { fitDirectionalCostAwareScoreModel, type DirectionalCostAwareScoreModel } from "@/lib/core/opportunity-policy";
import { fitDirectionalScoreCalibration, type DirectionalScoreCalibrationModel } from "@/lib/core/scoring";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Side } from "@/lib/core/types";

const DAY = 86_400_000;
const DEFAULT_SYMBOL_COUNT = 50;
const PURGE_HOURS = 72;

/**
 * This object is intentionally explicit. It is the acceptance reference for
 * the current production Control and must not inherit research-only defaults.
 */
export const CONTROL_OPTIONS: BacktestOptions = {
  initialCapitalUsdt: 10_000,
  minScore: numberEnv("CS_MIN_SIGNAL_SCORE", 70),
  maxHoldHours: numberEnv("CS_MAX_HOLD_HOURS", 72),
  minimumSampleDays: 0,
  singleSignalRiskCapUsdt: numberEnv("CS_PER_SIGNAL_RISK_CAP_USDT", 100),
  dailyRiskBudgetUsdt: numberEnv("CS_DAILY_RISK_BUDGET_USDT", 600),
  dailyLossLimitUsdt: numberEnv("CS_DAILY_RISK_BUDGET_USDT", 600),
  maxConcurrentPositions: numberEnv("CS_MAX_CONCURRENT_POSITIONS", 1),
  maxEmailsPerDay: numberEnv("CS_NEW_EMAIL_DAILY_CAP", 10),
  maxEmailsPerScan: numberEnv("CS_MAX_EMAILS_PER_SCAN", 6),
  marginUsdt: numberEnv("CS_MARGIN_USDT", 100),
  leverage: numberEnv("CS_ASSUMED_LEVERAGE", 20),
  riskPerTradeUsdt: numberEnv("CS_RISK_PER_TRADE_USDT", 50),
  maxPositionNotionalUsdt: numberEnv("CS_MAX_POSITION_NOTIONAL_USDT", 10_000),
  rewardRisk: numberEnv("CS_REWARD_RISK", 2),
  cooldownHours: numberEnv("CS_COOLDOWN_HOURS", 8),
  entryIntervalHours: numberEnv("CS_ENTRY_INTERVAL_HOURS", 1),
  takerFeeRate: numberEnv("CS_V5_VALIDATION_FEE_RATE", DEFAULT_VALIDATION_COST_ASSUMPTIONS.takerFeeRate),
  slippageBps: numberEnv("CS_V5_VALIDATION_SLIPPAGE_BPS", DEFAULT_VALIDATION_COST_ASSUMPTIONS.baseSlippageBps),
  maxExecutionCostRiskFraction: numberEnv("CS_MAX_EXECUTION_COST_RISK_FRACTION", 0.1),
  requireRegimeAlignment: true,
  strategyFamilies: ["TREND"],
  sideFilter: "SHORT",
  requireFundingData: false,
};

/**
 * Research settings are separate from Control. They preserve both directions,
 * use the V5 entry policy, and require public historical funding data.
 */
export const V5_RESEARCH_OPTIONS: BacktestOptions = {
  initialCapitalUsdt: 10_000,
  minScore: 0,
  maxHoldHours: numberEnv("CS_MAX_HOLD_HOURS", 72),
  minimumSampleDays: 0,
  singleSignalRiskCapUsdt: numberEnv("CS_PER_SIGNAL_RISK_CAP_USDT", 100),
  dailyRiskBudgetUsdt: 600,
  dailyLossLimitUsdt: 600,
  maxConcurrentPositions: 6,
  maxEmailsPerDay: 10,
  maxEmailsPerScan: 6,
  marginUsdt: 100,
  leverage: 20,
  riskPerTradeUsdt: 50,
  maxPositionNotionalUsdt: 10_000,
  rewardRisk: 2,
  cooldownHours: 0,
  entryIntervalHours: 1,
  takerFeeRate: numberEnv("CS_V5_VALIDATION_FEE_RATE", DEFAULT_VALIDATION_COST_ASSUMPTIONS.takerFeeRate),
  slippageBps: numberEnv("CS_V5_VALIDATION_SLIPPAGE_BPS", DEFAULT_VALIDATION_COST_ASSUMPTIONS.baseSlippageBps),
  maxExecutionCostRiskFraction: 0.1,
  requireRegimeAlignment: true,
  strategyFamilies: ["TREND"],
  requireFundingData: true,
};

interface FittedV5Models {
  calibrationModel: DirectionalScoreCalibrationModel;
  costModel: DirectionalCostAwareScoreModel;
  trainingWindow: { start: number; end: number };
  rawTrades: number;
}

interface StrategyRun {
  id: string;
  params: StrategyParams;
  side?: Side;
  run: PortfolioBacktestResult;
  metrics: DirectionalValidationMetrics;
  validation?: DirectionalValidationMetrics;
  validationFolds: Array<{
    id: string;
    metrics: DirectionalValidationMetrics;
    trainingWindow?: { start: string; end: string };
    trainingTrades?: number;
  }>;
  modelTraining?: {
    final: { start: string; end: string; rawTrades: number };
    folds: Array<{ id: string; start: string; end: string; rawTrades: number }>;
  };
  stress: Record<string, number>;
  executionDelay: Record<string, {
    netR: number;
    trades: number;
    proxyTrades: number;
    stopTrades: number;
    takeProfitTrades: number;
    timeLimitTrades: number;
  }>;
  promotion: ReturnType<typeof evaluatePromotionGate>;
  holdoutPromotion: ReturnType<typeof evaluatePromotionGate>;
}

async function main() {
  const years = Math.max(1, Math.floor(numberEnv("CS_V5_VALIDATION_YEARS", 1)));
  const symbolCount = Math.max(50, Math.floor(numberEnv("CS_V5_VALIDATION_SYMBOL_COUNT", DEFAULT_SYMBOL_COUNT)));
  const datasets = await loadDatasets(symbolCount, years);
  if (datasets.length < 50) throw new Error(`V5 validation requires at least 50 complete symbols; found ${datasets.length}`);

  const costs = validationCostAssumptions({
    takerFeeRate: numberEnv("CS_V5_VALIDATION_FEE_RATE", DEFAULT_VALIDATION_COST_ASSUMPTIONS.takerFeeRate),
    baseSlippageBps: numberEnv("CS_V5_VALIDATION_SLIPPAGE_BPS", DEFAULT_VALIDATION_COST_ASSUMPTIONS.baseSlippageBps),
  });
  const windowEnd = Math.min(...datasets.map((dataset) => dataset.candles["15m"].at(-1)?.closeTime ?? 0));
  const windowStart = windowEnd - years * 365 * DAY;
  const folds = createPurgedWalkForwardFolds({
    start: windowStart,
    end: windowEnd,
    initialTrainMonths: 6,
    validationMonths: 3,
    foldCount: years === 1 ? 1 : years * 4,
    purgeHours: PURGE_HOURS,
  });
  const holdout = createFrozenHoldoutWindow(windowStart, windowEnd, folds, PURGE_HOURS);
  if (!holdout) throw new Error("No frozen holdout window remains after purged walk-forward folds");
  if (folds.length === 0) throw new Error("No purged validation fold could be created");

  const benchmarkDataset = datasets.find((dataset) => dataset.symbol === "BTCUSDT") ?? datasets[0];
  const context: BacktestContext = {
    benchmarkDataset,
    breadthDatasets: datasets,
    breadthUniverseId: `validation-universe-${datasets.length}:${datasets.map((dataset) => dataset.symbol).join(",")}`,
  };
  const currentParams = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION" as const, stopAtrMultiplier: 0.5 };
  const v5Params = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "V5_SIGNAL_EDGE" as const, stopAtrMultiplier: 0.5 };
  const controlCaches = buildCaches(datasets, currentParams, windowEnd, context, windowStart - 14 * DAY);
  const v5Caches = buildCaches(datasets, v5Params, windowEnd, context, windowStart - 14 * DAY);

  const current = await runStrategy({
    id: "CURRENT_PRODUCTION",
    params: currentParams,
    side: "SHORT",
    options: CONTROL_OPTIONS,
    context,
    datasets,
    folds,
    holdout,
    candidateCaches: controlCaches,
    costs,
    modelled: false,
  });
  const researchBaseline = await runStrategy({
    id: "TREND_REJECTION_RESEARCH",
    params: currentParams,
    side: "SHORT",
    options: { ...CONTROL_OPTIONS, minScore: 0 },
    context,
    datasets,
    folds,
    holdout,
    candidateCaches: controlCaches,
    costs,
    modelled: false,
  });
  const v5Short = await runStrategy({
    id: "V5_SHORT",
    params: v5Params,
    side: "SHORT",
    options: V5_RESEARCH_OPTIONS,
    context,
    datasets,
    folds,
    holdout,
    candidateCaches: v5Caches,
    costs,
    modelled: true,
  });
  const v5Long = await runStrategy({
    id: "V5_LONG",
    params: v5Params,
    side: "LONG",
    options: V5_RESEARCH_OPTIONS,
    context,
    datasets,
    folds,
    holdout,
    candidateCaches: v5Caches,
    costs,
    modelled: true,
  });

  const strategies = [current, researchBaseline, v5Short, v5Long];
  const dataFingerprint = fingerprintDatasets(datasets);
  const holdoutUsedForSelection = false;
  const report = {
    schemaVersion: "v5-signal-edge-validation-summary.v2",
    generatedAt: new Date().toISOString(),
    command: "pnpm validate:v5",
    dataFingerprint,
    purpose: "V5 Signal Edge directional research; frozen holdout is evaluated once after policy selection and is never used for tuning",
    baseline: {
      productionBaseSha: "1a6f0663e4dfe71869373cb41863856581713a7c",
      v5BaseSha: "1a6f0663e4dfe71869373cb41863856581713a7c",
      note: "PR parent is the current Production baseline; main is older and is not the comparison baseline",
    },
    history: {
      years,
      symbolCount: datasets.length,
      symbols: datasets.map((dataset) => dataset.symbol),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      purgeHours: PURGE_HOURS,
      folds: folds.map(serializeFold),
      holdout: { start: new Date(holdout.start).toISOString(), end: new Date(holdout.end).toISOString() },
      holdoutUsedForSelection,
    },
    costs: {
      ...costs,
      cvarDefinition: "95% lower-tail mean R; threshold includes reference taker fee and configured slippage",
      delayDefinition: "true path re-simulation from delayed entry through stop/TP/stop-first/funding/max-hold",
    },
    validationProfiles: {
      CONTROL_OPTIONS: serializeOptions(CONTROL_OPTIONS),
      V5_RESEARCH_OPTIONS: serializeOptions(V5_RESEARCH_OPTIONS),
    },
    models: strategies.filter((result) => result.modelTraining).map((result) => ({ id: result.id, ...result.modelTraining })),
    strategies: strategies.map((result) => toReportStrategy(result)),
    productionDecision: {
      LONG: v5Long.promotion.status === "APPROVED" ? "APPROVED" : "NOT APPROVED",
      SHORT: v5Short.promotion.status === "APPROVED" ? "APPROVED" : "NOT APPROVED",
      productionAEmailDirections: strategies
        .filter((result) => (result.id === "V5_LONG" || result.id === "V5_SHORT") && result.promotion.status === "APPROVED")
        .map((result) => result.id),
    },
    limitations: [
      "Reference execution uses closed candles and stop-first intrabar handling.",
      "T+5m is labelled as a 15m candle proxy when 1m data is unavailable; T+15m uses the next closed 15m candle.",
      "Historical funding is included only when the public funding cache has a rate at or before the entry timestamp; missing data rejects V5 research trades.",
      "Historical order-book depth and spread are unavailable.",
    ],
  };

  await mkdir(resolve("reports"), { recursive: true });
  const fullReportPath = resolve("reports", `validation-v5-signal-edge-${years}y.json`);
  const summaryPath = resolve("reports", "validation-v5-signal-edge-summary.json");
  const summary = toCompactSummary(report);
  await writeFile(fullReportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    fullReportPath,
    summaryPath,
    dataFingerprint,
    holdoutUsedForSelection,
    productionDecision: report.productionDecision,
    strategies: report.strategies.map((result) => ({
      id: result.id,
      holdoutTrades: result.frozenHoldout.trades,
      holdoutNetR: result.frozenHoldout.netR,
      promotion: result.promotion.status,
    })),
  }, null, 2));
}

function toCompactSummary(report: {
  schemaVersion: string;
  generatedAt: string;
  command: string;
  dataFingerprint: string;
  baseline: unknown;
  history: unknown;
  costs: unknown;
  validationProfiles: unknown;
  strategies: Array<ReturnType<typeof toReportStrategy>>;
  productionDecision: unknown;
}) {
  return {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    command: report.command,
    dataFingerprint: report.dataFingerprint,
    baseline: report.baseline,
    history: report.history,
    costs: report.costs,
    validationProfiles: report.validationProfiles,
    strategies: report.strategies.map((result) => ({
      id: result.id,
      side: result.side,
      validation: result.validation,
      frozenHoldout: result.frozenHoldout,
      stress: result.stress,
      executionDelay: result.executionDelay,
      promotion: result.promotion,
      holdoutPromotion: result.holdoutPromotion,
    })),
    productionDecision: report.productionDecision,
  };
}

async function runStrategy(input: {
  id: string;
  params: StrategyParams;
  side: Side;
  options: BacktestOptions;
  context: BacktestContext;
  datasets: HistoricalDataset[];
  folds: PurgedWalkForwardFold[];
  holdout: { start: number; end: number };
  candidateCaches: Array<Map<number, import("@/lib/core/types").ScoredCandidate[]>>;
  costs: ValidationCostAssumptions;
  modelled: boolean;
}): Promise<StrategyRun> {
  const validationTrades: PortfolioBacktestResult["trades"] = [];
  const validationFolds: StrategyRun["validationFolds"] = [];
  const modelTraining: StrategyRun["modelTraining"] = input.modelled
    ? { final: { start: "", end: "", rawTrades: 0 }, folds: [] }
    : undefined;

  for (const fold of input.folds) {
    let models: FittedV5Models | undefined;
    if (input.modelled) {
      models = fitV5Models(input, fold.trainStart, fold.trainEnd);
      modelTraining?.folds.push({
        id: fold.id,
        start: new Date(models.trainingWindow.start).toISOString(),
        end: new Date(models.trainingWindow.end).toISOString(),
        rawTrades: models.rawTrades,
      });
    }
    const validationRun = runPortfolioBacktest(input.datasets, input.params, {
      ...input.options,
      sideFilter: input.side,
      evaluationStartTime: fold.validationStart,
      evaluationEndTime: fold.validationEnd,
      candidateCaches: input.candidateCaches,
      scoreCalibration: models?.calibrationModel.byDirection[input.side] ?? undefined,
      directionalScoreCalibration: models?.calibrationModel,
      costAwareScoreModel: undefined,
      directionalCostAwareScoreModel: models?.costModel,
    }, input.context);
    validationTrades.push(...validationRun.trades);
    validationFolds.push({
      id: fold.id,
      metrics: summarizeDirectionalTrades(validationRun.trades, input.side, [], input.costs),
      trainingWindow: models ? {
        start: new Date(models.trainingWindow.start).toISOString(),
        end: new Date(models.trainingWindow.end).toISOString(),
      } : undefined,
      trainingTrades: models?.rawTrades,
    });
  }

  let finalModels: FittedV5Models | undefined;
  if (input.modelled) {
    const finalEnd = input.holdout.start - PURGE_HOURS * 3_600_000 - 1;
    finalModels = fitV5Models(input, input.folds[0]?.trainStart ?? 0, finalEnd);
    if (modelTraining) {
      modelTraining.final = {
        start: new Date(finalModels.trainingWindow.start).toISOString(),
        end: new Date(finalModels.trainingWindow.end).toISOString(),
        rawTrades: finalModels.rawTrades,
      };
    }
  }
  const run = runPortfolioBacktest(input.datasets, input.params, {
    ...input.options,
    sideFilter: input.side,
    evaluationStartTime: input.holdout.start,
    evaluationEndTime: input.holdout.end,
    candidateCaches: input.candidateCaches,
    scoreCalibration: finalModels?.calibrationModel.byDirection[input.side] ?? undefined,
    directionalScoreCalibration: finalModels?.calibrationModel,
    costAwareScoreModel: undefined,
    directionalCostAwareScoreModel: finalModels?.costModel,
  }, input.context);
  const metrics = summarizeDirectionalTrades(run.trades, input.side, [], input.costs);
  const validation = summarizeDirectionalTrades(
    validationTrades,
    input.side,
    validationFolds.map((fold) => fold.metrics),
    input.costs,
  );
  const validationPromotion = evaluatePromotionGate(validation, {
    frozenHoldout: true,
    maximumCvar95: input.costs.maximumCvar95LossR,
  });
  const holdoutPromotion = evaluatePromotionGate(metrics, {
    frozenHoldout: true,
    maximumCvar95: input.costs.maximumCvar95LossR,
    minimumPositiveFoldsRatio: 0,
    minimumPositiveMonthsRatio: 0,
  });
  const promotionReasons = [
    ...validationPromotion.reasons.map((reason) => `validation:${reason}`),
    ...holdoutPromotion.reasons.map((reason) => `holdout:${reason}`),
  ];
  return {
    id: input.id,
    params: input.params,
    side: input.side,
    run,
    metrics,
    validation,
    validationFolds,
    modelTraining,
    stress: stressBySlippage(run.trades, input.costs),
    executionDelay: executionDelayByTrade(run.trades, input.datasets, input.costs),
    promotion: {
      status: promotionReasons.length === 0 ? "APPROVED" : metrics.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
      passed: promotionReasons.length === 0,
      reasons: promotionReasons,
    },
    holdoutPromotion,
  };
}

function fitV5Models(
  input: {
    params: StrategyParams;
    options: BacktestOptions;
    context: BacktestContext;
    datasets: HistoricalDataset[];
    candidateCaches: Array<Map<number, import("@/lib/core/types").ScoredCandidate[]>>;
  },
  start: number,
  end: number,
): FittedV5Models {
  const trainRun = runPortfolioBacktest(input.datasets, input.params, {
    ...input.options,
    sideFilter: undefined,
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCaches: input.candidateCaches,
    scoreCalibration: undefined,
    directionalScoreCalibration: undefined,
    costAwareScoreModel: undefined,
    directionalCostAwareScoreModel: undefined,
  }, input.context);
  const samples = trainRun.rawTrades.map((trade) => ({
    side: trade.side,
    score: trade.score,
    netR: trade.rMultiple,
    strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION",
  }));
  const calibrationModel = fitDirectionalScoreCalibration(samples, {
    bucketSize: 5,
    minimumSamples: 40,
    minimumExpectedNetR: 0.02,
    priorWeight: 20,
  });
  const costModel = fitDirectionalCostAwareScoreModel(
    trainRun.rawTrades.flatMap((trade) => trade.policyFeatures
      ? [{ side: trade.side, score: trade.score, netR: trade.rMultiple, ...trade.policyFeatures }]
      : []),
    { bucketSize: 5, minimumSamples: 40, minimumExpectedNetR: 0.02, priorWeight: 20 },
  );
  return { calibrationModel, costModel, trainingWindow: { start, end }, rawTrades: trainRun.rawTrades.length };
}

function toReportStrategy(result: StrategyRun) {
  return {
    id: result.id,
    side: result.side,
    params: result.params,
    validation: result.validation,
    validationFolds: result.validationFolds,
    frozenHoldout: result.metrics,
    stress: result.stress,
    executionDelay: result.executionDelay,
    promotion: result.promotion,
    holdoutPromotion: result.holdoutPromotion,
    portfolio: {
      trades: result.run.trades.length,
      rawTrades: result.run.rawTrades.length,
      rejectionCounts: result.run.rejectionCounts,
    },
    modelTraining: result.modelTraining,
  };
}

function buildCaches(
  datasets: HistoricalDataset[],
  params: StrategyParams,
  end: number,
  context: BacktestContext,
  start: number,
): Array<Map<number, import("@/lib/core/types").ScoredCandidate[]>> {
  return datasets.map((dataset) => buildCandidateCache(dataset, params, end, 1, context, start));
}

function stressBySlippage(
  trades: PortfolioBacktestResult["trades"],
  costs: ValidationCostAssumptions,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const bps of costs.stressSlippageBps) {
    const netR = trades.reduce((sum, trade) => {
      const entry = trade.referenceEntryPrice ?? trade.entryPrice;
      const exit = trade.referenceExitPrice ?? trade.exitPrice;
      const quantity = trade.quantity ?? 0;
      const stress = calculateSlippageStress(
        trade.side,
        entry,
        exit,
        quantity,
        trade.theoreticalRiskUsdt,
        costs.takerFeeRate,
        bps,
      );
      return sum + stress.netR + trade.fundingUsdt / Math.max(trade.theoreticalRiskUsdt, 1e-9);
    }, 0);
    result[`${bps}bps`] = round(netR);
  }
  return result;
}

function executionDelayByTrade(
  trades: PortfolioBacktestResult["trades"],
  datasets: HistoricalDataset[],
  costs: ValidationCostAssumptions,
): Record<string, {
  netR: number;
  trades: number;
  proxyTrades: number;
  stopTrades: number;
  takeProfitTrades: number;
  timeLimitTrades: number;
}> {
  const datasetsBySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));
  return Object.fromEntries(costs.delayScenarios.map((delay: ExecutionDelay) => {
    let netR = 0;
    let count = 0;
    let proxyTrades = 0;
    let stopTrades = 0;
    let takeProfitTrades = 0;
    let timeLimitTrades = 0;
    for (const trade of trades) {
      const dataset = datasetsBySymbol.get(trade.symbol);
      if (!dataset || !trade.quantity) continue;
      const result = simulateDelayedReferenceTrade(dataset.candles["15m"], {
        side: trade.side,
        sourceTimestamp: trade.entryTime,
        referenceEntryPrice: trade.referenceEntryPrice ?? trade.entryPrice,
        stopPrice: trade.stopPrice,
        takeProfitPrice: trade.takeProfitPrice,
        quantity: trade.quantity,
        theoreticalRiskUsdt: trade.theoreticalRiskUsdt,
        maxHoldHours: trade.maxHoldHours,
        takerFeeRate: costs.takerFeeRate,
        slippageBps: costs.baseSlippageBps,
        fundingRates: dataset.fundingRates,
      }, delay);
      if (result.netR === null || result.netR === undefined) continue;
      netR += result.netR;
      count += 1;
      if (result.proxy) proxyTrades += 1;
      if (result.exitReason === "STOP") stopTrades += 1;
      if (result.exitReason === "TAKE_PROFIT") takeProfitTrades += 1;
      if (result.exitReason === "TIME_LIMIT") timeLimitTrades += 1;
    }
    return [delay, {
      netR: round(netR),
      trades: count,
      proxyTrades,
      stopTrades,
      takeProfitTrades,
      timeLimitTrades,
    }];
  }));
}

async function loadDatasets(symbolCount: number, years: number): Promise<HistoricalDataset[]> {
  const manifest = JSON.parse(await readFile(resolve("data/validation-universe-50.json"), "utf8")) as { symbols: string[] };
  const requested = manifest.symbols.slice(0, Math.max(50, symbolCount));
  const files = await readdir(resolve("data/validation-cache"));
  const datasets: HistoricalDataset[] = [];
  for (const symbol of requested) {
    const candidates = files.filter((file) => file.startsWith(`${symbol}-`) && file.endsWith(".json"));
    const loaded: HistoricalDataset[] = [];
    for (const file of candidates) {
      try {
        loaded.push(JSON.parse(await readFile(resolve("data/validation-cache", file), "utf8")) as HistoricalDataset);
      } catch {
        // Ignore partial cache files and keep searching for a complete window.
      }
    }
    const requiredDays = years * 365;
    const dataset = loaded
      .filter((item) => ((item.candles["15m"].at(-1)?.closeTime ?? 0) - (item.candles["15m"][0]?.openTime ?? 0)) / DAY >= requiredDays)
      .sort((left, right) => (right.candles["15m"][0]?.openTime ?? 0) - (left.candles["15m"][0]?.openTime ?? 0))[0];
    if (dataset) datasets.push(dataset);
  }
  return datasets;
}

function serializeFold(fold: PurgedWalkForwardFold) {
  return {
    id: fold.id,
    trainStart: new Date(fold.trainStart).toISOString(),
    trainEnd: new Date(fold.trainEnd).toISOString(),
    purgeStart: new Date(fold.purgeStart).toISOString(),
    purgeEnd: new Date(fold.purgeEnd).toISOString(),
    validationStart: new Date(fold.validationStart).toISOString(),
    validationEnd: new Date(fold.validationEnd).toISOString(),
    purgeHours: PURGE_HOURS,
  };
}

function fingerprintDatasets(datasets: HistoricalDataset[]): string {
  const hash = createHash("sha256");
  [...datasets].sort((left, right) => left.symbol.localeCompare(right.symbol)).forEach((dataset) => {
    const candles = dataset.candles["15m"];
    hash.update(JSON.stringify({
      symbol: dataset.symbol,
      firstOpenTime: candles[0]?.openTime ?? null,
      lastCloseTime: candles.at(-1)?.closeTime ?? null,
      candleCount: candles.length,
      fundingCount: dataset.fundingRates?.length ?? 0,
    }));
  });
  return hash.digest("hex");
}

function serializeOptions(options: BacktestOptions) {
  return {
    minScore: options.minScore,
    sideFilter: options.sideFilter ?? "BOTH",
    strategyFamilies: options.strategyFamilies ?? ["ALL"],
    requireRegimeAlignment: options.requireRegimeAlignment ?? false,
    maxHoldHours: options.maxHoldHours,
    maxConcurrentPositions: options.maxConcurrentPositions,
    cooldownHours: options.cooldownHours,
    entryIntervalHours: options.entryIntervalHours,
    maxEmailsPerDay: options.maxEmailsPerDay,
    maxEmailsPerScan: options.maxEmailsPerScan,
    initialCapitalUsdt: options.initialCapitalUsdt,
    singleSignalRiskCapUsdt: options.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: options.dailyRiskBudgetUsdt,
    dailyLossLimitUsdt: options.dailyLossLimitUsdt,
    marginUsdt: options.marginUsdt,
    leverage: options.leverage,
    riskPerTradeUsdt: options.riskPerTradeUsdt,
    maxPositionNotionalUsdt: options.maxPositionNotionalUsdt,
    rewardRisk: options.rewardRisk,
    takerFeeRate: options.takerFeeRate,
    slippageBps: options.slippageBps,
    maxExecutionCostRiskFraction: options.maxExecutionCostRiskFraction,
    requireFundingData: options.requireFundingData ?? false,
  };
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
