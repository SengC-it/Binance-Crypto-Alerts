import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidateCache, runPortfolioBacktest, type BacktestContext, type BacktestOptions } from "@/lib/backtest/engine";
import { calculateSlippageStress, evaluateExecutionDelay, type ExecutionDelay } from "@/lib/backtest/execution-stress";
import { createFrozenHoldoutWindow, createPurgedWalkForwardFolds, evaluatePromotionGate, holdoutWasExcludedFromSelection, summarizeDirectionalTrades, type DirectionalValidationMetrics, type PurgedWalkForwardFold } from "@/lib/backtest/validation";
import type { HistoricalDataset, PortfolioBacktestResult } from "@/lib/backtest/types";
import { fitDirectionalCostAwareScoreModel, type DirectionalCostAwareScoreModel } from "@/lib/core/opportunity-policy";
import { fitDirectionalScoreCalibration, type DirectionalScoreCalibrationModel } from "@/lib/core/scoring";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Side } from "@/lib/core/types";

const DAY = 86_400_000;
const DEFAULT_SYMBOL_COUNT = 50;

interface StrategyRun {
  id: string;
  params: StrategyParams;
  side?: Side;
  run: PortfolioBacktestResult;
  metrics: DirectionalValidationMetrics;
  validation?: DirectionalValidationMetrics;
  stress: Record<string, number>;
  executionDelay: Record<string, { netR: number; trades: number; proxyTrades: number }>;
  promotion: ReturnType<typeof evaluatePromotionGate>;
  holdoutPromotion: ReturnType<typeof evaluatePromotionGate>;
}

async function main() {
  const years = Math.max(1, Math.floor(numberEnv("CS_V5_VALIDATION_YEARS", 1)));
  const symbolCount = Math.max(50, Math.floor(numberEnv("CS_V5_VALIDATION_SYMBOL_COUNT", DEFAULT_SYMBOL_COUNT)));
  const datasets = await loadDatasets(symbolCount, years);
  if (datasets.length < 50) throw new Error(`V5 validation requires at least 50 complete symbols; found ${datasets.length}`);

  const windowEnd = Math.min(...datasets.map((dataset) => dataset.candles["15m"].at(-1)?.closeTime ?? 0));
  const windowStart = windowEnd - years * 365 * DAY;
  const folds = createPurgedWalkForwardFolds({ start: windowStart, end: windowEnd, initialTrainMonths: 6, validationMonths: 3, foldCount: years === 1 ? 1 : years * 4, purgeHours: 72 });
  const holdout = createFrozenHoldoutWindow(windowStart, windowEnd, folds, 72);
  if (!holdout) throw new Error("No frozen holdout window remains after purged walk-forward folds");
  const firstFold = folds[0];
  if (!firstFold) throw new Error("No purged validation fold could be created");
  const benchmarkDataset = datasets.find((dataset) => dataset.symbol === "BTCUSDT") ?? datasets[0];
  const context: BacktestContext = { benchmarkDataset };
  const commonOptions: BacktestOptions = {
    initialCapitalUsdt: 10_000,
    minScore: 0,
    maxHoldHours: 72,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    dailyLossLimitUsdt: 600,
    maxConcurrentPositions: 6,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    marginUsdt: 100,
    leverage: 20,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
    entryIntervalHours: 1,
    takerFeeRate: numberEnv("CS_V5_VALIDATION_FEE_RATE", 0.0004),
    slippageBps: numberEnv("CS_V5_VALIDATION_SLIPPAGE_BPS", 2),
    requireRegimeAlignment: true,
  };

  const currentParams = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION" as const, stopAtrMultiplier: 0.5 };
  const v5Params = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "V5_SIGNAL_EDGE" as const, stopAtrMultiplier: 0.5 };
  const current = await runStrategy("CURRENT_PRODUCTION", currentParams, "SHORT", commonOptions, context, datasets, holdout);
  const existingRejection = await runStrategy("TREND_REJECTION_EXISTING", currentParams, "SHORT", { ...commonOptions, minScore: 0 }, context, datasets, holdout);

  const v5Cache = buildCaches(datasets, v5Params, windowEnd, context, windowStart - 14 * DAY);
  const v5Train = runPortfolioBacktest(datasets, v5Params, {
    ...commonOptions,
    evaluationStartTime: firstFold.trainStart,
    evaluationEndTime: firstFold.trainEnd,
    candidateCaches: v5Cache,
  }, context);
  const calibrationModel = fitDirectionalScoreCalibration(
    v5Train.rawTrades.map((trade) => ({ side: trade.side, score: trade.score, netR: trade.rMultiple, strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION" })),
    { bucketSize: 5, minimumSamples: 40, minimumExpectedNetR: 0.02, priorWeight: 20 },
  );
  const costModel = fitDirectionalCostAwareScoreModel(
    v5Train.rawTrades
      .flatMap((trade) => trade.policyFeatures
        ? [{ side: trade.side, score: trade.score, netR: trade.rMultiple, ...trade.policyFeatures }]
        : []),
    { bucketSize: 5, minimumSamples: 40, minimumExpectedNetR: 0.02, priorWeight: 20 },
  );
  const calibratedOptions = { ...commonOptions, directionalScoreCalibration: calibrationModel, directionalCostAwareScoreModel: costModel, candidateCaches: v5Cache };
  const v5Short = await runStrategy("V5_SHORT", v5Params, "SHORT", calibratedOptions, context, datasets, holdout, folds);
  const v5Long = await runStrategy("V5_LONG", v5Params, "LONG", calibratedOptions, context, datasets, holdout, folds);
  const v5Combined = await runStrategy("V5_COMBINED_APPROVED_DIRECTIONS", v5Params, undefined, calibratedOptions, context, datasets, holdout, folds);

  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "V5 Signal Edge directional research; frozen holdout is evaluated after policy selection and is not used for tuning",
    history: {
      years,
      symbols: datasets.map((dataset) => dataset.symbol),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      train: { start: new Date(firstFold.trainStart).toISOString(), end: new Date(firstFold.trainEnd).toISOString() },
      validation: { start: new Date(firstFold.validationStart).toISOString(), end: new Date(firstFold.validationEnd).toISOString() },
      frozenHoldout: { start: new Date(holdout.start).toISOString(), end: new Date(holdout.end).toISOString() },
      folds: folds.map((fold) => ({ ...fold, trainStart: new Date(fold.trainStart).toISOString(), trainEnd: new Date(fold.trainEnd).toISOString(), purgeStart: new Date(fold.purgeStart).toISOString(), purgeEnd: new Date(fold.purgeEnd).toISOString(), validationStart: new Date(fold.validationStart).toISOString(), validationEnd: new Date(fold.validationEnd).toISOString() })),
      purgeHours: 72,
    },
    models: {
      calibrationByDirection: calibrationModel,
      expectedEdgeByDirection: costModel,
      holdoutUsedForSelection: !holdoutWasExcludedFromSelection(folds.map((fold) => ({ end: fold.validationEnd })), holdout),
      orderBookHistory: "UNAVAILABLE; no historical order-book data was used",
    },
    strategies: [current, existingRejection, v5Short, v5Long, v5Combined].map(toReportStrategy),
    productionDecision: {
      LONG: v5Long.promotion.status === "APPROVED" ? "APPROVED" : "NOT APPROVED",
      SHORT: v5Short.promotion.status === "APPROVED" ? "APPROVED" : "NOT APPROVED",
      productionAEmailDirections: [v5Long, v5Short].filter((result) => result.promotion.status === "APPROVED").map((result) => result.id),
    },
    limitations: [
      "Reference execution uses closed candles and stop-first intrabar handling.",
      "T+1m/T+5m delay uses a 15m candle proxy when 1m data is unavailable.",
      "Funding is included when cached funding history exists; historical spread/depth is unavailable.",
    ],
  };
  const reportPath = resolve("reports", `validation-v5-signal-edge-${years}y.json`);
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({ ok: true, reportPath, productionDecision: report.productionDecision, strategies: report.strategies.map((result) => ({ id: result.id, holdoutTrades: result.frozenHoldout.trades, holdoutNetR: result.frozenHoldout.netR, promotion: result.promotion.status })) }, null, 2));
}

async function runStrategy(
  id: string,
  params: StrategyParams,
  side: Side | undefined,
  options: BacktestOptions,
  context: BacktestContext,
  datasets: HistoricalDataset[],
  holdout: { start: number; end: number },
  validationFolds: PurgedWalkForwardFold[] = [],
): Promise<StrategyRun> {
  const caches = options.candidateCaches ?? buildCaches(datasets, params, holdout.end, context, holdout.start - 14 * DAY);
  const run = runPortfolioBacktest(datasets, params, {
    ...options,
    sideFilter: side,
    evaluationStartTime: holdout.start,
    evaluationEndTime: holdout.end,
    candidateCaches: caches,
  }, context);
  const metrics = summarizeDirectionalTrades(run.trades, side ?? "COMBINED");
  const validationTrades: PortfolioBacktestResult["trades"] = [];
  const foldMetrics: DirectionalValidationMetrics[] = [];
  for (const fold of validationFolds) {
    const validationRun = runPortfolioBacktest(datasets, params, {
      ...options,
      sideFilter: side,
      evaluationStartTime: fold.validationStart,
      evaluationEndTime: fold.validationEnd,
      candidateCaches: caches,
    }, context);
    validationTrades.push(...validationRun.trades);
    foldMetrics.push(summarizeDirectionalTrades(validationRun.trades, side ?? "COMBINED"));
  }
  const validation = validationFolds.length > 0
    ? summarizeDirectionalTrades(validationTrades, side ?? "COMBINED", foldMetrics)
    : undefined;
  const validationPromotion = validation
    ? evaluatePromotionGate(validation, { frozenHoldout: true })
    : { status: "APPROVED" as const, passed: true, reasons: [] };
  const holdoutPromotion = evaluatePromotionGate(
    metrics,
    validationFolds.length > 0
      ? { frozenHoldout: true, minimumPositiveFoldsRatio: 0 }
      : { frozenHoldout: true },
  );
  const promotionReasons = [
    ...validationPromotion.reasons.map((reason) => `validation:${reason}`),
    ...holdoutPromotion.reasons.map((reason) => `holdout:${reason}`),
  ];
  return {
    id,
    params,
    side,
    run,
    metrics,
    validation,
    stress: stressBySlippage(run.trades),
    executionDelay: executionDelayByTrade(run.trades, datasets),
    promotion: {
      status: promotionReasons.length === 0 ? "APPROVED" : metrics.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
      passed: promotionReasons.length === 0,
      reasons: promotionReasons,
    },
    holdoutPromotion,
  };
}

function toReportStrategy(result: StrategyRun) {
  return {
    id: result.id,
    params: result.params,
    side: result.side,
    validation: result.validation,
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

function stressBySlippage(trades: PortfolioBacktestResult["trades"]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const bps of [5, 10, 20]) {
    const stress = trades.map((trade) => {
      const entry = trade.referenceEntryPrice ?? trade.entryPrice;
      const exit = trade.referenceExitPrice ?? trade.exitPrice;
      const quantity = trade.quantity ?? 0;
      return calculateSlippageStress(trade.side, entry, exit, quantity, trade.theoreticalRiskUsdt, 0.0004, bps).netR;
    });
    result[`${bps}bps`] = round(stress.length === 0 ? 0 : stress.reduce((sum, value) => sum + value, 0));
  }
  return result;
}

function executionDelayByTrade(
  trades: PortfolioBacktestResult["trades"],
  datasets: HistoricalDataset[],
): Record<string, { netR: number; trades: number; proxyTrades: number }> {
  const candlesBySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset.candles["15m"]]));
  const delays: ExecutionDelay[] = ["T+5m", "T+15m"];
  return Object.fromEntries(delays.map((delay) => {
    let netR = 0;
    let count = 0;
    let proxyTrades = 0;
    for (const trade of trades) {
      const candles = candlesBySymbol.get(trade.symbol) ?? [];
      const entry = evaluateExecutionDelay(candles, trade.entryTime, trade.referenceEntryPrice ?? trade.entryPrice, delay);
      if (entry.entryPrice === null || trade.referenceExitPrice === undefined || !trade.quantity) continue;
      const direction = trade.side === "LONG" ? 1 : -1;
      const rawNet = (trade.referenceExitPrice - entry.entryPrice) * direction * trade.quantity;
      const fees = (Math.abs(entry.entryPrice * trade.quantity) + Math.abs(trade.referenceExitPrice * trade.quantity)) * 0.0004;
      netR += (rawNet - fees) / Math.max(trade.theoreticalRiskUsdt, 1e-9);
      count += 1;
      if (entry.proxy) proxyTrades += 1;
    }
    return [delay, { netR: round(netR), trades: count, proxyTrades }];
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
        // Ignore a partial cache file and keep searching for a complete window.
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
