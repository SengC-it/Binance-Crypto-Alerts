import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidateCache, runPortfolioBacktest, selectPortfolioTrades, type BacktestOptions } from "@/lib/backtest/engine";
import type { BacktestTrade, DynamicExitPolicy, HistoricalDataset } from "@/lib/backtest/types";
import { BinancePublicClient } from "@/lib/binance/public-client";
import { fitScoreCalibration, type ScoreCalibrationFitOptions, type ScoreCalibrationModel } from "@/lib/core/scoring";
import {
  expectedNetR,
  fitCostAwareScoreModel,
  type CostAwareScoreModel,
  type MarketStateFilter,
} from "@/lib/core/opportunity-policy";
import { DEFAULT_STRATEGY_PARAMS, type EntryMode, type StrategyParams } from "@/lib/core/strategies";
import type { Instrument } from "@/lib/core/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_VALIDATION_CANDIDATES = 100;
const MAX_HOLD_HOURS = 72;
const INITIAL_CAPITAL_USDT = 10_000;
const DEFAULT_SYMBOL_COUNT = 50;

interface Variant {
  id: string;
  description: string;
  params: StrategyParams;
  options: BacktestOptions;
  calibration?: ScoreCalibrationFitOptions;
}

interface Metrics {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgScore: number;
  avgRiskUsdt: number;
  avgPnlUsdt: number;
  netR: number;
  netPnlUsdt: number;
  pricePnlBeforeExecutionCostsUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  finalEquityUsdt: number;
}

interface DiagnosticRow {
  key: string;
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlUsdt: number;
  avgPnlUsdt: number;
}

interface TradeDiagnostics {
  byExitReason: DiagnosticRow[];
  byMarketRegime: DiagnosticRow[];
  byStrategyFamily: DiagnosticRow[];
  byMonth: DiagnosticRow[];
  bySymbol: DiagnosticRow[];
}

async function main() {
  const focus = process.env.CS_VALIDATION_FOCUS ?? "calibrated-trend-selected";
  const validationYears = focus === "multi-year-quarterly-walk-forward-regime" ? 3 : 1;
  const configuredWindowEnd = timestampEnv("CS_VALIDATION_END_TIME");
  const currentBucketOpen = configuredWindowEnd === undefined
    ? Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES
    : configuredWindowEnd + 1;
  const windowStart = currentBucketOpen - validationYears * 365 * DAY;
  const windowEnd = currentBucketOpen - 1;
  const warmupStart = windowStart - 14 * DAY;
  const minimumValidationCandles15m = validationYears * 365 * 24 * 4;
  const splitTime = addMonths(windowStart, 9);
  const trainEnd = splitTime - MAX_HOLD_HOURS * HOUR;
  const oosStart = splitTime;
  const minScore = numberEnv("CS_VALIDATION_MIN_SCORE", 60);
  const feeRate = numberEnv("CS_VALIDATION_FEE_RATE", 0.0004);
  const slippageBps = numberEnv("CS_VALIDATION_SLIPPAGE_BPS", 2);
  const concurrency = Math.max(1, Math.min(4, Math.floor(numberEnv("CS_VALIDATION_CONCURRENCY", 1))));
  const interSymbolDelayMs = Math.max(0, Math.floor(numberEnv("CS_VALIDATION_INTER_SYMBOL_DELAY_MS", 2_000)));
  const validationSymbolCount = Math.max(
    50,
    Math.min(100, Math.floor(numberEnv("CS_VALIDATION_SYMBOL_COUNT", DEFAULT_SYMBOL_COUNT))),
  );
  const directSymbols = parseSymbols(process.env.CS_VALIDATION_SYMBOLS);
  const manifestSymbols = await loadUniverseSymbols(process.env.CS_VALIDATION_UNIVERSE_FILE);
  const requestedSymbols = directSymbols.length > 0 ? directSymbols : manifestSymbols;
  const targetSymbolCount = requestedSymbols.length > 0 ? requestedSymbols.length : validationSymbolCount;
  const client = new BinancePublicClient(process.env.BINANCE_API_BASE_URL);
  const universe = await client.getUniverse();
  const selectedInstruments = selectInstruments(universe, requestedSymbols, validationSymbolCount);
  const candidateInstruments = focus === "multi-year-quarterly-walk-forward-regime"
    ? selectedInstruments.filter((instrument) => instrument.onboardDate === undefined || instrument.onboardDate <= warmupStart)
    : selectedInstruments;

  console.info(JSON.stringify({
    stage: "fetching_validation_history",
    symbols: candidateInstruments.map((instrument) => instrument.symbol),
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    trainEnd: new Date(trainEnd).toISOString(),
    oosStart: new Date(oosStart).toISOString(),
    concurrency,
    interSymbolDelayMs,
    candidateSymbolCount: candidateInstruments.length,
    requestedSymbolCount: selectedInstruments.length,
    validationYears,
  }));

  const cacheDir = resolve("data/validation-cache");
  await mkdir(cacheDir, { recursive: true });
  const datasets: HistoricalDataset[] = [];
  for (const instrument of candidateInstruments) {
    if (datasets.length >= targetSymbolCount) break;
    const cachePath = resolve(cacheDir, `${instrument.symbol}-${windowStart}-${windowEnd}.json`);
    let dataset: HistoricalDataset | null = null;
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as HistoricalDataset;
      console.info(JSON.stringify({ stage: "loaded_validation_cache", symbol: instrument.symbol }));
      if (!hasFullValidationHistory(cached, windowStart, windowEnd, minimumValidationCandles15m)) {
        console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
        continue;
      } else {
        dataset = cached;
      }
    } catch {
      const fallback = await loadLatestPriorCache(cacheDir, instrument.symbol, windowEnd);
      if (fallback) {
        console.info(JSON.stringify({ stage: "loaded_prior_validation_cache", symbol: instrument.symbol }));
        if (!hasFullValidationHistory(fallback, windowStart, windowEnd, minimumValidationCandles15m)) {
          console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
          if (validationYears === 1) continue;
        } else {
          dataset = fallback;
        }
      }
    }
    if (!dataset) {
      const [candles15m, candles1h, candles4h, fundingRates] = await Promise.all([
        client.getCandlesRange(instrument.symbol, "15m", warmupStart, windowEnd),
        client.getCandlesRange(instrument.symbol, "1h", warmupStart, windowEnd),
        client.getCandlesRange(instrument.symbol, "4h", warmupStart, windowEnd),
        client.getFundingRatesRange(instrument.symbol, windowStart, windowEnd),
      ]);
      console.info(JSON.stringify({
        stage: "downloaded",
        symbol: instrument.symbol,
        candles15m: candles15m.length,
        candles1h: candles1h.length,
        candles4h: candles4h.length,
        fundingRates: fundingRates.length,
      }));
      const downloaded = {
        symbol: instrument.symbol,
        instrument,
        candles: { "15m": candles15m, "1h": candles1h, "4h": candles4h },
        fundingRates,
      } satisfies HistoricalDataset;
      if (candles15m.length < 80 || candles1h.length < 80 || candles4h.length < 80 || !hasFullValidationHistory(downloaded, windowStart, windowEnd, minimumValidationCandles15m)) {
        console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
        continue;
      }
      await writeFile(cachePath, JSON.stringify(downloaded), "utf8");
      dataset = downloaded;
    }
    datasets.push(dataset);
    if (interSymbolDelayMs > 0) await delay(interSymbolDelayMs);
  }
  const requiredDatasetCount = validationYears === 1 ? targetSymbolCount : candidateInstruments.length;
  if (datasets.length < requiredDatasetCount) {
    throw new Error(`Only ${datasets.length} of ${requiredDatasetCount} eligible symbols have at least ${validationYears} year(s) of complete history`);
  }
  const instruments = datasets.map((dataset) => dataset.instrument);

  if (focus === "entry-edge-redesign") {
    await writeEntryEdgeRedesignReport({
      datasets,
      windowStart,
      windowEnd,
      oosStart,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      fixedPolicyId: process.env.CS_ENTRY_POLICY_ID,
    });
    return;
  }

  if (focus === "multi-year-quarterly-walk-forward-regime") {
    await writeQuarterlyWalkForwardRegimeReport({
      datasets,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      fixedPolicyIds: parseOrderedIds(process.env.CS_ROLLING_POLICY_IDS),
      initialTrainingMonths: 12,
      foldCount: 8,
      reportFocus: "multi-year-quarterly-walk-forward-regime",
      requestedSymbolCount: selectedInstruments.length,
    });
    return;
  }

  if (focus === "quarterly-walk-forward-regime") {
    await writeQuarterlyWalkForwardRegimeReport({
      datasets,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      fixedPolicyIds: parseOrderedIds(process.env.CS_ROLLING_POLICY_IDS),
      initialTrainingMonths: 3,
      foldCount: 3,
      reportFocus: "quarterly-walk-forward-regime",
      requestedSymbolCount: selectedInstruments.length,
    });
    return;
  }

  if (focus === "dynamic-exit-path") {
    await writeDynamicExitPathReport({
      datasets,
      windowStart,
      windowEnd,
      trainEnd,
      oosStart,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      fixedPolicyId: process.env.CS_DYNAMIC_EXIT_POLICY_ID,
    });
    return;
  }

  if (focus === "market-funding-ev") {
    await writeMarketFundingExpectedValueReport({
      datasets,
      windowStart,
      windowEnd,
      trainEnd,
      oosStart,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }

  let allVariants = createVariants(minScore, feeRate, slippageBps, focus);
  if (focus === "profit-oriented-train-symbol-filter") {
    const baseVariant = createVariants(minScore, feeRate, slippageBps, "profit-oriented-selected")[0];
    const trainBase = runValidationSlice(datasets, baseVariant, windowStart, trainEnd);
    const excludedSymbols = summarizeDiagnostics(trainBase.trades).bySymbol
      .filter((row) => row.signals >= 10 && row.netPnlUsdt < 0)
      .map((row) => row.key);
    allVariants = [
      baseVariant,
      {
        ...baseVariant,
        id: `${baseVariant.id}-train-symbol-filter`,
        description: `${baseVariant.description}; exclude symbols with >=10 train signals and negative train net PnL`,
        options: {
          ...baseVariant.options,
          excludedSymbols,
        },
      },
    ];
  }
  const requestedVariantIds = parseVariantIds(process.env.CS_VALIDATION_VARIANT_IDS);
  const variants = requestedVariantIds.length === 0
    ? allVariants
    : allVariants.filter((variant) => requestedVariantIds.includes(variant.id));
  if (variants.length === 0) {
    throw new Error("CS_VALIDATION_VARIANT_IDS did not match any configured variants");
  }
  if (focus === "profit-oriented-capacity-rolling") {
    await writeCapacityRollingValidationReport({
      datasets,
      variants,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  if (focus === "calibrated-rolling" || focus === "cost-frequency-rolling" || focus === "improved-directional-rolling" || focus === "profit-oriented-concurrency-rolling" || focus === "profit-oriented-exits-rolling") {
    await writeRollingValidationReport({
      datasets,
      variant: variants[0],
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      reportFileName: validationReportFileName(
        focus === "cost-frequency-rolling"
          ? `${variants[0].id}-rolling`
          : focus === "improved-directional-rolling"
            ? "improved-directional-rolling"
            : focus === "profit-oriented-concurrency-rolling"
              ? "profit-oriented-concurrency-rolling"
              : focus === "profit-oriented-exits-rolling"
                ? "profit-oriented-exits-rolling"
              : "calibrated-rolling",
        feeRate,
        slippageBps,
      ),
    });
    return;
  }
  if (focus === "score-calibrated") {
    await writeScoreCalibrationReport({
      datasets,
      variant: variants[0],
      windowStart,
      windowEnd,
      trainEnd,
      oosStart,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  if (focus === "score-calibrated-rolling") {
    await writeScoreCalibratedRollingReport({
      datasets,
      variant: variants[0],
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  const results = variants.map((variant) => {
    const full = runValidationSlice(datasets, variant, windowStart, windowEnd);
    const train = runValidationSlice(datasets, variant, windowStart, trainEnd);
    const outOfSample = runValidationSlice(datasets, variant, oosStart, windowEnd);
    return {
      id: variant.id,
      description: variant.description,
      params: variant.params,
      options: variant.options,
      rawFullSignals: full.rawSignals,
      fullSignalCandidates: full.rawSignals,
      fullAcceptedPaperTrades: full.metrics.signals,
      rawTrainSignals: train.rawSignals,
      trainSignalCandidates: train.rawSignals,
      trainAcceptedPaperTrades: train.metrics.signals,
      rawOutOfSampleSignals: outOfSample.rawSignals,
      outOfSampleSignalCandidates: outOfSample.rawSignals,
      outOfSampleAcceptedPaperTrades: outOfSample.metrics.signals,
      rawFull: full.rawMetrics,
      rawTrain: train.rawMetrics,
      rawOutOfSample: outOfSample.rawMetrics,
      fullRejections: full.rejectionCounts,
      trainRejections: train.rejectionCounts,
      outOfSampleRejections: outOfSample.rejectionCounts,
      fullDiagnostics: summarizeDiagnostics(full.trades),
      trainDiagnostics: summarizeDiagnostics(train.trades),
      outOfSampleDiagnostics: summarizeDiagnostics(outOfSample.trades),
      full: full.metrics,
      train: train.metrics,
      outOfSample: outOfSample.metrics,
      passesSuggestedGate: passesSuggestedGate(outOfSample.metrics),
    };
  });

  results.sort((left, right) => rankResult(right) - rankResult(left));
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "P0-P1 experimental validation; no production strategy changed",
    focus,
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
      warmupStart: new Date(warmupStart).toISOString(),
      train: {
        start: new Date(windowStart).toISOString(),
        end: new Date(trainEnd).toISOString(),
      },
      outOfSample: {
        start: new Date(oosStart).toISOString(),
        end: new Date(windowEnd).toISOString(),
      },
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h", "4h"],
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      maxHoldHours: MAX_HOLD_HOURS,
      takeProfitRewardRisk: 2,
      takerFeeRate: feeRate,
      slippageBps,
      intrabarModel: "stop-first when both levels are inside one candle",
      entryModel: "entry at just-closed 15m close; exits begin from next candle",
      note: "The suggested gate is a research threshold, not a profit guarantee.",
    },
    universe: {
      symbols: instruments.map((instrument) => instrument.symbol),
      selection: requestedSymbols.length > 0
        ? "explicit frozen symbol manifest"
        : `top ${candidateInstruments.length} USDT-M perpetual candidates by 24h quote volume, retaining ${instruments.length} with at least one year of history`,
      note: "Set CS_VALIDATION_SYMBOL_COUNT to 100 for the full top-100 candidate run, or CS_VALIDATION_SYMBOLS for an explicit reproducible list.",
    },
    variants: results,
    data: datasets.map((dataset) => ({
      symbol: dataset.symbol,
      candles15m: dataset.candles["15m"].length,
      candles1h: dataset.candles["1h"]?.length ?? 0,
      candles4h: dataset.candles["4h"]?.length ?? 0,
      fundingRates: dataset.fundingRates?.length ?? 0,
    })),
  };

  const reportPath = resolve("reports", validationReportFileName(focus, feeRate, slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    variants: results.map((result) => ({
      id: result.id,
      rawFullSignals: result.rawFullSignals,
      fullSignals: result.full.signals,
      fullNetPnlUsdt: result.full.netPnlUsdt,
      fullPF: result.full.profitFactor,
      rawTrainSignals: result.rawTrainSignals,
      trainSignals: result.train.signals,
      trainNetPnlUsdt: result.train.netPnlUsdt,
      trainPF: result.train.profitFactor,
      rawOosSignals: result.rawOutOfSampleSignals,
      oosSignals: result.outOfSample.signals,
      oosNetPnlUsdt: result.outOfSample.netPnlUsdt,
      oosPF: result.outOfSample.profitFactor,
      oosDD: result.outOfSample.maxDrawdownPercent,
      passesSuggestedGate: result.passesSuggestedGate,
    })),
  }, null, 2));
}

function createVariants(minScore: number, feeRate: number, slippageBps: number, focus: string): Variant[] {
  const common = {
    initialCapitalUsdt: INITIAL_CAPITAL_USDT,
    minScore,
    maxHoldHours: MAX_HOLD_HOURS,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    dailyLossLimitUsdt: 600,
    maxConcurrentPositions: 6,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    capitalFloorUsdt: 0,
    marginUsdt: 100,
    leverage: 20,
    takerFeeRate: feeRate,
    slippageBps,
  } satisfies BacktestOptions;

  const fixedRisk = (stopAtrMultiplier: number, extras: Partial<BacktestOptions> = {}, variantMinScore = minScore): Variant => ({
    id: "risk50-stop" + stopAtrMultiplier.toString().replace(".", "-") + variantSuffix(extras, variantMinScore, minScore),
    description: "50U fixed-risk sizing, " + stopAtrMultiplier + " ATR stop" + (extras.requireRegimeAlignment ? ", strict regime alignment" : "") + (variantMinScore === minScore ? "" : ", score >= " + variantMinScore),
    params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier },
    options: {
      ...common,
      ...extras,
      minScore: variantMinScore,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
    },
  });

  if (focus === "short-score") {
    return [65, 70, 75, 80, 85, 90].map((variantMinScore) => fixedRisk(0.75, {
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
    }, variantMinScore));
  }

  if (focus === "cost-frequency") {
    const costFrequencyVariant = (variantMinScore: number, cooldownHours: number, maxCostRisk: number): Variant => ({
      id: `costfreq-score${variantMinScore}-cooldown${cooldownHours}-cost${Math.round(maxCostRisk * 100)}`,
      description: `Default entry, short-only strict regime, score >= ${variantMinScore}, ${cooldownHours}h cooldown, execution cost <= ${Math.round(maxCostRisk * 100)}% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours,
        maxExecutionCostRiskFraction: maxCostRisk,
      },
    });
    const variants = [
      ...[75, 80, 85, 90].flatMap((variantMinScore) => [0, 8].map((cooldownHours) => costFrequencyVariant(variantMinScore, cooldownHours, 0.15))),
      costFrequencyVariant(80, 8, 0.1),
      costFrequencyVariant(80, 8, 0.2),
      costFrequencyVariant(80, 24, 0.15),
      costFrequencyVariant(85, 24, 0.15),
    ];
    return variants;
  }

  if (focus === "cost-frequency-cost10") {
    return [75, 80, 85, 90].map((variantMinScore) => ({
      id: `costfreq-score${variantMinScore}-cooldown8-cost10`,
      description: `Default entry, short-only strict regime, score >= ${variantMinScore}, 8h cooldown, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "cost-frequency-confirm") {
    return [{
      id: "costfreq-score80-cooldown8-cost10",
      description: "Default entry, short-only strict regime, score >= 80, 8h cooldown, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 80,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "improved-cost-aware") {
    return [1, 4].map((entryIntervalHours) => ({
      id: `improved-cost-aware-trend-short-score80-interval${entryIntervalHours}h`,
      description: `Improved policy: TREND short-only, score >= 80, 50U fixed risk, 0.75 ATR stop, 8h cooldown, entry every ${entryIntervalHours}h, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 80,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
        cooldownHours: 8,
        entryIntervalHours,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "improved-regime-aware") {
    return [70, 80].map((variantMinScore) => ({
      id: `improved-regime-aware-trend-score${variantMinScore}-interval1h`,
      description: `Improved policy: TREND direction follows BULL/BEAR regime, score >= ${variantMinScore}, 50U fixed risk, 0.75 ATR stop, 8h cooldown, 1h entry interval, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "improved-directional") {
    return (["LONG", "SHORT"] as const).map((sideFilter) => ({
      id: `improved-directional-${sideFilter.toLowerCase()}-trend-score70-interval1h`,
      description: `Improved diagnostic: ${sideFilter} TREND only, score >= 70, 50U fixed risk, 0.75 ATR stop, 8h cooldown, 1h entry interval, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter,
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "improved-directional-rolling") {
    return [{
      id: "improved-directional-short-trend-score70-interval1h",
      description: "Rolling check: SHORT TREND only, score >= 70, 50U fixed risk, 0.75 ATR stop, 8h cooldown, 1h entry interval, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "profit-oriented-concurrency") {
    return [1, 2, 3, 4].map((maxConcurrentPositions) => ({
      id: `profit-oriented-short-trend-score70-concurrency${maxConcurrentPositions}`,
      description: `Profit-oriented diagnostic: SHORT TREND only, score >= 70, 50U fixed risk, 0.75 ATR stop, 8h cooldown, 1h entry interval, max ${maxConcurrentPositions} concurrent positions, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "profit-oriented-concurrency-rolling") {
    return [{
      id: "profit-oriented-short-trend-score70-concurrency1",
      description: "Rolling check: SHORT TREND only, score >= 70, 50U fixed risk, 0.75 ATR stop, 8h cooldown, 1h entry interval, max 1 concurrent position, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "profit-oriented-exits") {
    return [0.5, 0.75, 1].flatMap((stopAtrMultiplier) => [1.5, 2].map((rewardRisk) => ({
      id: `profit-oriented-short-trend-stop${stopAtrMultiplier.toString().replace(".", "-")}-rr${rewardRisk}`,
      description: `Profit-oriented diagnostic: SHORT TREND only, score >= 70, 50U fixed risk, ${stopAtrMultiplier} ATR stop, ${rewardRisk}R target, 8h cooldown, 1h entry interval, max 1 concurrent position, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    })));
  }

  if (focus === "profit-oriented-exits-rolling") {
    return [{
      id: "profit-oriented-short-trend-stop0-5-rr2",
      description: "Rolling check: SHORT TREND only, score >= 70, 50U fixed risk, 0.5 ATR stop, 2R target, 8h cooldown, 1h entry interval, max 1 concurrent position, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.5,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "profit-oriented-score-grid") {
    return [65, 70, 75, 80].map((variantMinScore) => ({
      id: `profit-oriented-short-trend-stop0-5-rr2-score${variantMinScore}`,
      description: `Profit-oriented diagnostic: SHORT TREND only, score >= ${variantMinScore}, 50U fixed risk, 0.5 ATR stop, 2R target, 8h cooldown, 1h entry interval, max 1 concurrent position, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.5,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "profit-oriented-selected") {
    return [{
      id: "profit-oriented-short-trend-stop0-5-rr2-score70",
      description: "Selected profit-oriented policy: SHORT TREND only, score >= 70, 50U fixed risk, 0.5 ATR stop, 2R target, 8h cooldown, 1h entry interval, max 1 concurrent position, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.5,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "production-aligned-selected") {
    return [{
      id: "production-aligned-short-trend-stop0-5-rr2-score70",
      description: "Production-aligned policy: selected SHORT TREND rules with a hard 100U margin x 20 leverage ceiling",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.5,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 2_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 1,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "profit-oriented-capacity" || focus === "profit-oriented-capacity-rolling") {
    return [1, 3, 6].map((maxConcurrentPositions) => ({
      id: `profit-oriented-short-trend-stop0-5-rr2-score70-capacity${maxConcurrentPositions}`,
      description: `Capacity comparison: SHORT TREND only, score >= 70, 50U fixed risk, 0.5 ATR stop, 2R target, 8h cooldown, 1h entry interval, max ${maxConcurrentPositions} concurrent positions, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.5,
      },
      options: {
        ...common,
        minScore: 70,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions,
        cooldownHours: 8,
        entryIntervalHours: 1,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "exit-grid") {
    const variants: Variant[] = [];
    for (const entryMode of ["DEFAULT", "BREAKOUT_RETEST"] as EntryMode[]) {
      for (const stopAtrMultiplier of [0.5, 0.75, 1]) {
        for (const rewardRisk of [1.5, 2, 2.5]) {
          for (const maxHoldHours of [48, 72]) {
            const family = entryMode === "DEFAULT" ? ["BREAKOUT"] as const : undefined;
            variants.push({
              id: `exitgrid-${entryMode.toLowerCase()}-stop${stopAtrMultiplier}-rr${rewardRisk}-hold${maxHoldHours}`,
              description: `${entryMode} short-only strict-regime breakout candidate, score >= 70, stop ${stopAtrMultiplier} ATR, target ${rewardRisk}R, max hold ${maxHoldHours}h, cooldown 8h, cost <= 10% of risk`,
              params: {
                ...DEFAULT_STRATEGY_PARAMS,
                entryMode,
                stopAtrMultiplier,
              },
              options: {
                ...common,
                minScore: 70,
                maxHoldHours,
                riskPerTradeUsdt: 50,
                maxPositionNotionalUsdt: 10_000,
                singleSignalRiskCapUsdt: 50,
                rewardRisk,
                requireRegimeAlignment: true,
                sideFilter: "SHORT",
                strategyFamilies: family ? [...family] : undefined,
                cooldownHours: 8,
                maxExecutionCostRiskFraction: 0.1,
              },
            });
          }
        }
      }
    }
    return variants;
  }

  if (focus === "score-calibrated" || focus === "score-calibrated-rolling") {
    const bucketSize = numberEnv("CS_VALIDATION_CALIBRATION_BUCKET_SIZE", 5);
    const minimumSamples = numberEnv("CS_VALIDATION_CALIBRATION_MIN_SAMPLES", 40);
    const minimumExpectedNetR = numberEnv("CS_VALIDATION_CALIBRATION_MIN_NET_R", 0.02);
    const priorWeight = numberEnv("CS_VALIDATION_CALIBRATION_PRIOR_WEIGHT", 20);
    const groupByStrategyFamily = process.env.CS_VALIDATION_CALIBRATION_GROUP_FAMILY !== "false";
    return [{
      id: `score-calibrated-short-${groupByStrategyFamily ? "family-" : ""}b${bucketSize}-n${minimumSamples}-r${minimumExpectedNetR}`,
      description: `Empirical score calibration fitted on train only; short-only strict regime, 8h cooldown, execution cost <= 10% of risk, ${groupByStrategyFamily ? "family-specific, " : ""}bucket ${bucketSize}, minimum ${minimumSamples} samples, expected net R >= ${minimumExpectedNetR}`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 0,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
      calibration: {
        bucketSize,
        groupByStrategyFamily,
        minimumSamples,
        minimumExpectedNetR,
        priorWeight,
      },
    }];
  }

  if (focus === "cost-frequency-rolling") {
    const rollingScore = numberEnv("CS_VALIDATION_ROLLING_SCORE", 90);
    const rollingCooldown = numberEnv("CS_VALIDATION_ROLLING_COOLDOWN_HOURS", 8);
    const rollingCost = numberEnv("CS_VALIDATION_ROLLING_COST_RISK", 0.1);
    const rollingEntryInterval = numberEnv("CS_VALIDATION_ROLLING_ENTRY_INTERVAL_HOURS", 0);
    const rollingEntryMode = (process.env.CS_VALIDATION_ROLLING_ENTRY_MODE ?? "DEFAULT") as EntryMode;
    const rollingSide = process.env.CS_VALIDATION_ROLLING_SIDE === "LONG"
      || process.env.CS_VALIDATION_ROLLING_SIDE === "SHORT"
      ? process.env.CS_VALIDATION_ROLLING_SIDE
      : undefined;
    return [{
      id: `costfreq-${rollingEntryMode.toLowerCase()}-${rollingSide?.toLowerCase() ?? "adaptive"}-score${rollingScore}-cooldown${rollingCooldown}-cost${Math.round(rollingCost * 100)}-interval${rollingEntryInterval}`,
      description: `Fixed rolling policy: ${rollingEntryMode} entry, ${rollingSide?.toLowerCase() ?? "adaptive"} strict regime, score >= ${rollingScore}, ${rollingCooldown}h cooldown, entry every ${rollingEntryInterval || "15m"}, execution cost <= ${Math.round(rollingCost * 100)}% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: rollingEntryMode,
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: rollingScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: rollingSide,
        cooldownHours: rollingCooldown,
        maxExecutionCostRiskFraction: rollingCost,
        entryIntervalHours: rollingEntryInterval > 0 ? rollingEntryInterval : undefined,
      },
    }];
  }

  if (focus === "new-entries") {
    return (["TREND_PULLBACK", "BREAKOUT_RETEST", "RANGE_RECLAIM"] as EntryMode[]).map((entryMode) => ({
      id: "new-entry-" + entryMode.toLowerCase(),
      description: entryMode + ", 50U fixed-risk sizing, 0.75 ATR stop, strict regime alignment",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode,
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
      },
    }));
  }

  if (focus === "calibrated") {
    return [60, 65, 70, 75].map((variantMinScore) => ({
      id: "calibrated-short-score" + variantMinScore,
      description: "Calibrated short-only policy, score >= " + variantMinScore + ", fixed 100U margin, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
      },
    }));
  }

  if (focus === "calibrated-selected") {
    return [70].map((variantMinScore) => ({
      id: "calibrated-short-score" + variantMinScore,
      description: "Selected calibrated short-only policy, score >= " + variantMinScore + ", fixed 100U margin, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
      },
    }));
  }

  if (focus === "calibrated-risk50") {
    return [65, 70, 75].map((variantMinScore) => ({
      id: "calibrated-risk50-short-score" + variantMinScore,
      description: "Calibrated short-only policy, score >= " + variantMinScore + ", 50U fixed risk, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
      },
    }));
  }

  if (focus === "calibrated-conservative") {
    return [2, 3, 4].map((maxConcurrentPositions) => ({
      id: "calibrated-short-score70-max" + maxConcurrentPositions,
      description: "Calibrated short-only policy, score >= 70, max " + maxConcurrentPositions + " simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        maxConcurrentPositions,
      },
    }));
  }

  if (focus === "calibrated-selected-max3") {
    return [{
      id: "calibrated-short-score70-max3",
      description: "Selected calibrated short-only policy, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        maxConcurrentPositions: 3,
      },
    }];
  }

  if (focus === "calibrated-grid") {
    const makeVariant = (
      id: string,
      description: string,
      variantMinScore: number,
      stopAtrMultiplier = DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
      strategyFamilies?: Array<"TREND" | "BREAKOUT" | "MEAN_REVERSION">,
    ): Variant => ({
      id,
      description,
      params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
        maxConcurrentPositions: 3,
        strategyFamilies,
      },
    });
    return [
      ...[65, 70, 75].map((variantMinScore) => makeVariant(
        "grid-short-score" + variantMinScore,
        "Short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
      )),
      ...[60, 65, 70].map((variantMinScore) => makeVariant(
        "grid-breakout-short-score" + variantMinScore,
        "Breakout short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
        DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
        ["BREAKOUT"],
      )),
      ...[65, 70, 75].map((variantMinScore) => makeVariant(
        "grid-trend-short-score" + variantMinScore,
        "Trend short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
        DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
        ["TREND"],
      )),
      makeVariant("grid-short-stop0-5-score70", "Short-only score >= 70, 0.5 ATR stop, max 3 positions", 70, 0.5),
      makeVariant("grid-short-stop0-75-score70", "Short-only score >= 70, 0.75 ATR stop, max 3 positions", 70, 0.75),
    ];
  }

  if (focus === "calibrated-trend-selected") {
    return [{
      id: "calibrated-trend-short-score70-max3",
      description: "Selected calibrated TREND short-only policy, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
      },
    }];
  }

  if (focus === "calibrated-rolling") {
    return [{
      id: "calibrated-trend-short-score70-max3",
      description: "Fixed rolling-validation policy: TREND short-only, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
      },
    }];
  }

  return [
    {
      id: "baseline-fixed-margin-stop0-25",
      description: "Original fixed 100U margin x20, 0.25 ATR stop",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: common,
    },
    fixedRisk(0.5),
    fixedRisk(0.75),
    fixedRisk(1),
    fixedRisk(0.75, { requireRegimeAlignment: true }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "LONG" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "SHORT" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["TREND"] }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["BREAKOUT"] }),
    {
      id: "risk25-stop0-75-regime",
      description: "25U fixed-risk sizing, 0.75 ATR stop, strict regime alignment",
      params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier: 0.75 },
      options: {
        ...common,
        riskPerTradeUsdt: 25,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 25,
        requireRegimeAlignment: true,
      },
    },
  ];
}

interface EntryEdgeCandidate {
  id: string;
  description: string;
  params: StrategyParams;
  options: BacktestOptions;
}

async function writeEntryEdgeRedesignReport(input: {
  datasets: HistoricalDataset[];
  windowStart: number;
  windowEnd: number;
  oosStart: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
  fixedPolicyId?: string;
}) {
  const baseVariant = createVariants(70, input.feeRate, input.slippageBps, "production-aligned-selected")[0];
  const allCandidates: EntryEdgeCandidate[] = [
    { id: "baseline-default-trend", description: "Existing continuous trend-alignment entry", params: baseVariant.params, options: baseVariant.options },
    { id: "trend-pullback", description: "Three-timeframe EMA pullback followed by candle confirmation", params: { ...baseVariant.params, entryMode: "TREND_PULLBACK" }, options: baseVariant.options },
    { id: "trend-rejection", description: "EMA-zone pullback followed by a volume-confirmed rejection break", params: { ...baseVariant.params, entryMode: "TREND_REJECTION" }, options: baseVariant.options },
    {
      id: "breakout-retest",
      description: "Volume breakout followed by an immediate level retest",
      params: { ...baseVariant.params, entryMode: "BREAKOUT_RETEST" },
      options: { ...baseVariant.options, strategyFamilies: ["BREAKOUT"] },
    },
    {
      id: "compression-breakout",
      description: "Twelve-candle volatility compression followed by a trend-aligned volume breakout",
      params: { ...baseVariant.params, entryMode: "COMPRESSION_BREAKOUT" },
      options: { ...baseVariant.options, strategyFamilies: ["BREAKOUT"] },
    },
  ];
  const candidates = input.fixedPolicyId
    ? allCandidates.filter((candidate) => candidate.id === "baseline-default-trend" || candidate.id === input.fixedPolicyId)
    : allCandidates;
  if (input.fixedPolicyId && candidates.length !== 2 && input.fixedPolicyId !== "baseline-default-trend") {
    throw new Error(`Unknown CS_ENTRY_POLICY_ID: ${input.fixedPolicyId}`);
  }
  const benchmarkDataset = input.datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  if (!benchmarkDataset) throw new Error("BTCUSDT is required for entry-edge market attribution");
  const context = { benchmarkDataset, marketStateCache: new Map() };
  const fullRuns = new Map<string, ReturnType<typeof runPortfolioBacktest>>();
  for (const candidate of candidates) {
    const candidateCaches = input.datasets.map((dataset) => buildCandidateCache(
      dataset,
      candidate.params,
      input.windowEnd,
      candidate.options.entryIntervalHours,
    ));
    fullRuns.set(candidate.id, runPortfolioBacktest(input.datasets, candidate.params, {
      ...candidate.options,
      candidateCaches,
      evaluationStartTime: input.windowStart,
      evaluationEndTime: input.windowEnd,
    }, context));
  }
  const trainEnd = input.oosStart - (MAX_HOLD_HOURS + 8) * HOUR;
  const trainMidpoint = input.windowStart + Math.floor((trainEnd - input.windowStart) / 2);
  const selectionResults = candidates.map((candidate) => {
    const trades = fullRuns.get(candidate.id)!.trades;
    const trainTrades = tradesInWindow(trades, input.windowStart, trainEnd);
    return {
      candidate,
      full: summarize(trades),
      train: summarize(trainTrades),
      outOfSample: summarize(tradesInWindow(trades, input.oosStart, input.windowEnd)),
      firstHalf: summarize(tradesInWindow(trainTrades, input.windowStart, trainMidpoint - (MAX_HOLD_HOURS + 8) * HOUR)),
      secondHalf: summarize(tradesInWindow(trainTrades, trainMidpoint, trainEnd)),
    };
  });
  const baselineTrain = selectionResults.find((result) => result.candidate.id === "baseline-default-trend")!;
  const ranked = selectionResults.map((result) => {
    const eligible = result.candidate.id !== "baseline-default-trend"
      && result.train.signals >= 60
      && result.train.netPnlUsdt > baselineTrain.train.netPnlUsdt
      && result.train.netPnlUsdt > 0
      && result.train.profitFactor >= 1.05
      && result.train.maxDrawdownUsdt <= baselineTrain.train.maxDrawdownUsdt * 1.25
      && result.firstHalf.netPnlUsdt > 0
      && result.secondHalf.netPnlUsdt > 0;
    const rejectionReasons = result.candidate.id === "baseline-default-trend"
      ? []
      : [
          result.train.signals < 60 ? "fewer than 60 training trades" : null,
          result.train.netPnlUsdt <= baselineTrain.train.netPnlUsdt ? "training PnL did not beat baseline" : null,
          result.train.netPnlUsdt <= 0 ? "training PnL was not positive" : null,
          result.train.profitFactor < 1.05 ? "training profit factor below 1.05" : null,
          result.train.maxDrawdownUsdt > baselineTrain.train.maxDrawdownUsdt * 1.25 ? "training drawdown exceeded limit" : null,
          result.firstHalf.netPnlUsdt <= 0 ? "first training half was not profitable" : null,
          result.secondHalf.netPnlUsdt <= 0 ? "second training half was not profitable" : null,
        ].filter((reason): reason is string => Boolean(reason));
    return {
      ...result,
      eligible,
      rejectionReasons,
      selectionScore: eligible
        ? result.train.netPnlUsdt - result.train.maxDrawdownUsdt * 0.25
        : Number.NEGATIVE_INFINITY,
    };
  }).sort((left, right) => right.selectionScore - left.selectionScore);
  const selected = input.fixedPolicyId
    ? ranked.find((result) => result.candidate.id === input.fixedPolicyId)!
    : ranked.find((result) => result.eligible)
      ?? ranked.find((result) => result.candidate.id === "baseline-default-trend")!;
  const baselineFullTrades = fullRuns.get("baseline-default-trend")!.trades;
  const selectedFullTrades = fullRuns.get(selected.candidate.id)!.trades;
  const baselineOosTrades = tradesInWindow(baselineFullTrades, input.oosStart, input.windowEnd);
  const selectedOosTrades = tradesInWindow(selectedFullTrades, input.oosStart, input.windowEnd);
  const baselineOos = summarize(baselineOosTrades);
  const selectedOos = summarize(selectedOosTrades);
  const passesOosGate = selected.candidate.id !== "baseline-default-trend"
    && selected.eligible
    && selectedOos.signals >= 20
    && selectedOos.netPnlUsdt > baselineOos.netPnlUsdt
    && selectedOos.netPnlUsdt > 0
    && selectedOos.profitFactor >= 1.05
    && selectedOos.maxDrawdownUsdt <= baselineOos.maxDrawdownUsdt * 1.1;
  const productionCandidate = passesOosGate ? selected.candidate : allCandidates[0];
  const productionFullTrades = fullRuns.get(productionCandidate.id)?.trades ?? baselineFullTrades;
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Train-selected entry-edge redesign with fixed risk and exit policy followed by isolated OOS validation",
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      trainEnd: new Date(trainEnd).toISOString(),
      outOfSampleStart: new Date(input.oosStart).toISOString(),
      embargoHours: MAX_HOLD_HOURS + 8,
    },
    assumptions: {
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      frozenRiskAndExit: "100U margin ceiling, 20x leverage ceiling, 50U risk target, 0.5 ATR stop padding, 2R take profit, 72h maximum hold",
      changedDimension: "entry signal generation only",
      selectionRule: "at least 60 train trades, profitable with PF >= 1.05, beats train baseline, acceptable drawdown, and positive train halves",
      deploymentRule: "at least 20 OOS trades, positive with PF >= 1.05, beats OOS baseline, and drawdown <= 110% of baseline",
      selectionMode: input.fixedPolicyId ? `fixed policy stress test: ${input.fixedPolicyId}` : "train-only entry selection",
    },
    selectedTrainPolicy: { id: selected.candidate.id, description: selected.candidate.description },
    passesOosGate,
    productionPolicy: { id: productionCandidate.id, description: productionCandidate.description },
    selectionResults: ranked.map(({ candidate, full, train, outOfSample, firstHalf, secondHalf, eligible, rejectionReasons, selectionScore }) => ({
      candidate: { id: candidate.id, description: candidate.description, entryMode: candidate.params.entryMode },
      full,
      train,
      outOfSample,
      stability: { firstHalf, secondHalf },
      eligible,
      rejectionReasons,
      selectionScore: Number.isFinite(selectionScore) ? selectionScore : null,
    })),
    results: {
      priorPublishedBaseline: { signals: 584, netPnlUsdt: 364.425, profitFactor: 1.0252, maxDrawdownPercent: 7.3036 },
      baselineFull: summarize(baselineFullTrades),
      selectedFullDiagnostic: summarize(selectedFullTrades),
      productionFull: summarize(productionFullTrades),
      baselineOutOfSample: baselineOos,
      selectedOutOfSample: selectedOos,
      differenceOutOfSample: {
        signals: selectedOos.signals - baselineOos.signals,
        netPnlUsdt: round(selectedOos.netPnlUsdt - baselineOos.netPnlUsdt, 4),
        profitFactor: round(selectedOos.profitFactor - baselineOos.profitFactor, 4),
        maxDrawdownPercent: round(selectedOos.maxDrawdownPercent - baselineOos.maxDrawdownPercent, 4),
      },
    },
    attribution: {
      baselineByMarketStage: summarizeAttribution(baselineOosTrades, (trade) => trade.policyFeatures?.marketState ?? "UNKNOWN"),
      selectedByMarketStage: summarizeAttribution(selectedOosTrades, (trade) => trade.policyFeatures?.marketState ?? "UNKNOWN"),
      baselineByMonth: summarizeAttribution(baselineOosTrades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 7)),
      selectedByMonth: summarizeAttribution(selectedOosTrades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 7)),
    },
    universe: { symbols: input.symbols, selection: "explicit frozen 50-symbol manifest" },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("entry-edge-redesign", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    selectedTrainPolicy: report.selectedTrainPolicy,
    passesOosGate,
    productionPolicy: report.productionPolicy,
    selectionResults: report.selectionResults,
    results: report.results,
    attribution: report.attribution,
  }, null, 2));
}

interface DynamicExitCandidate {
  id: string;
  description: string;
  policy?: DynamicExitPolicy;
}

function dynamicExitCandidates(): DynamicExitCandidate[] {
  return [
    { id: "baseline", description: "Fixed stop, 2R take profit, 72h maximum hold" },
    { id: "breakeven-1r", description: "Move stop to entry after a closed candle reaches 1R", policy: { breakevenTriggerR: 1 } },
    { id: "breakeven-1_25r", description: "Move stop to entry after a closed candle reaches 1.25R", policy: { breakevenTriggerR: 1.25 } },
    { id: "lock-1_25-0_25r", description: "Lock 0.25R after a closed candle reaches 1.25R", policy: { profitLockTriggerR: 1.25, profitLockR: 0.25 } },
    { id: "lock-1_5-0_5r", description: "Lock 0.5R after a closed candle reaches 1.5R", policy: { profitLockTriggerR: 1.5, profitLockR: 0.5 } },
    { id: "trail-1-0_75r", description: "Trail 0.75R behind MFE after reaching 1R", policy: { trailingActivationR: 1, trailingDistanceR: 0.75 } },
    { id: "trail-1_25-0_75r", description: "Trail 0.75R behind MFE after reaching 1.25R", policy: { trailingActivationR: 1.25, trailingDistanceR: 0.75 } },
    { id: "time-24h-0r", description: "From 24h onward, exit on the first close below 0R", policy: { timeStopHours: 24, minimumProgressR: 0 } },
    { id: "time-36h-0r", description: "From 36h onward, exit on the first close below 0R", policy: { timeStopHours: 36, minimumProgressR: 0 } },
    { id: "time-36h-0_25r", description: "From 36h onward, exit on the first close below 0.25R", policy: { timeStopHours: 36, minimumProgressR: 0.25 } },
    { id: "lock-1_25-0_25r-time36", description: "Lock 0.25R at 1.25R and exit stalled trades from 36h onward", policy: { profitLockTriggerR: 1.25, profitLockR: 0.25, timeStopHours: 36, minimumProgressR: 0 } },
  ];
}

async function writeQuarterlyWalkForwardRegimeReport(input: {
  datasets: HistoricalDataset[];
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
  fixedPolicyIds: string[];
  initialTrainingMonths: number;
  foldCount: number;
  reportFocus: string;
  requestedSymbolCount: number;
}) {
  const embargoHours = MAX_HOLD_HOURS + 8;
  const baseVariant = createVariants(70, input.feeRate, input.slippageBps, "production-aligned-selected")[0];
  const benchmarkDataset = input.datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  if (!benchmarkDataset) throw new Error("BTCUSDT is required for quarterly market-stage attribution");
  const allCandidates = dynamicExitCandidates();
  if (input.fixedPolicyIds.length > 0 && input.fixedPolicyIds.length !== input.foldCount) {
    throw new Error(`CS_ROLLING_POLICY_IDS must contain exactly ${input.foldCount} policy ids`);
  }
  const unknownFixedIds = input.fixedPolicyIds.filter((id) => !allCandidates.some((candidate) => candidate.id === id));
  if (unknownFixedIds.length > 0) throw new Error(`Unknown CS_ROLLING_POLICY_IDS: ${unknownFixedIds.join(", ")}`);
  const requiredCandidates = input.fixedPolicyIds.length > 0
    ? allCandidates.filter((candidate) => candidate.id === "baseline" || input.fixedPolicyIds.includes(candidate.id))
    : allCandidates;
  const candidateCaches = input.datasets.map((dataset) => buildCandidateCache(
    dataset,
    baseVariant.params,
    input.windowEnd,
    baseVariant.options.entryIntervalHours,
  ));
  const context = { benchmarkDataset, marketStateCache: new Map() };
  const fullRuns = new Map(requiredCandidates.map((candidate) => [
    candidate.id,
    runPortfolioBacktest(input.datasets, baseVariant.params, {
      ...baseVariant.options,
      candidateCaches,
      dynamicExitPolicy: candidate.policy,
      evaluationStartTime: input.windowStart,
      evaluationEndTime: input.windowEnd,
    }, context),
  ]));
  const folds = Array.from({ length: input.foldCount }, (_, index) => {
    const testStart = addMonths(input.windowStart, input.initialTrainingMonths + index * 3);
    const testEnd = index === input.foldCount - 1
      ? input.windowEnd
      : addMonths(input.windowStart, input.initialTrainingMonths + (index + 1) * 3) - 1;
    const trainEnd = testStart - embargoHours * HOUR;
    const trainMidpoint = input.windowStart + Math.floor((trainEnd - input.windowStart) / 2);
    const foldCandidates = requiredCandidates.map((candidate) => {
      const trades = fullRuns.get(candidate.id)!.trades;
      const trainTrades = tradesInWindow(trades, input.windowStart, trainEnd);
      return {
        candidate,
        trainTrades,
        train: summarize(trainTrades),
        firstHalf: summarize(tradesInWindow(trainTrades, input.windowStart, trainMidpoint - embargoHours * HOUR)),
        secondHalf: summarize(tradesInWindow(trainTrades, trainMidpoint, trainEnd)),
      };
    });
    const baseline = foldCandidates.find((result) => result.candidate.id === "baseline")!;
    const minimumSignals = Math.max(80, Math.floor(baseline.train.signals * 0.7));
    const ranked = foldCandidates.map((result) => {
      const eligible = result.candidate.id !== "baseline"
        && result.train.signals >= minimumSignals
        && result.train.netPnlUsdt > baseline.train.netPnlUsdt
        && result.train.netPnlUsdt > 0
        && result.train.profitFactor >= 1.05
        && result.train.maxDrawdownUsdt <= baseline.train.maxDrawdownUsdt * 1.25
        && result.firstHalf.netPnlUsdt > 0
        && result.secondHalf.netPnlUsdt > 0;
      return {
        ...result,
        eligible,
        selectionScore: eligible
          ? result.train.netPnlUsdt - result.train.maxDrawdownUsdt * 0.25
          : Number.NEGATIVE_INFINITY,
      };
    }).sort((left, right) => right.selectionScore - left.selectionScore);
    const fixedId = input.fixedPolicyIds[index];
    const selected = fixedId
      ? ranked.find((result) => result.candidate.id === fixedId)!
      : ranked.find((result) => result.eligible)
        ?? ranked.find((result) => result.candidate.id === "baseline")!;
    const baselineTestTrades = tradesInWindow(fullRuns.get("baseline")!.trades, testStart, testEnd);
    const selectedTestTrades = tradesInWindow(fullRuns.get(selected.candidate.id)!.trades, testStart, testEnd);
    return {
      id: `fold-${index + 1}`,
      trainStart: input.windowStart,
      trainEnd,
      testStart,
      testEnd,
      minimumSignals,
      selectedPolicy: selected.candidate,
      selectionWasEligible: selected.eligible,
      selectionResults: ranked.map(({ candidate, train, firstHalf, secondHalf, eligible, selectionScore }) => ({
        candidate,
        train,
        stability: { firstHalf, secondHalf },
        eligible,
        selectionScore: Number.isFinite(selectionScore) ? selectionScore : null,
      })),
      baselineTestTrades,
      selectedTestTrades,
      baselineTest: summarize(baselineTestTrades),
      selectedTest: summarize(selectedTestTrades),
    };
  });
  const baselineWalkForwardTrades = folds.flatMap((fold) => fold.baselineTestTrades).sort(byPolicyPriority);
  const selectedWalkForwardTrades = folds.flatMap((fold) => fold.selectedTestTrades).sort(byPolicyPriority);
  const baselineWalkForward = summarize(baselineWalkForwardTrades);
  const selectedWalkForward = summarize(selectedWalkForwardTrades);
  const positiveSelectedFolds = folds.filter((fold) => fold.selectedTest.netPnlUsdt > 0).length;
  const foldsBeatingBaseline = folds.filter((fold) => fold.selectedTest.netPnlUsdt > fold.baselineTest.netPnlUsdt).length;
  const validationYearCount = Math.max(1, Math.round((input.windowEnd - input.windowStart + 1) / (365 * DAY)));
  const baselineFullTrades = fullRuns.get("baseline")!.trades;
  const baselineByValidationYear = Array.from({ length: validationYearCount }, (_, index) => {
    const start = input.windowStart + index * 365 * DAY;
    const end = index === validationYearCount - 1 ? input.windowEnd : start + 365 * DAY - 1;
    return { year: index + 1, start, end, metrics: summarize(tradesInWindow(baselineFullTrades, start, end)) };
  });
  const rollingTestYearCount = Math.ceil(input.foldCount / 4);
  const rollingByTestYear = Array.from({ length: rollingTestYearCount }, (_, index) => {
    const includedFolds = folds.slice(index * 4, Math.min((index + 1) * 4, folds.length));
    const baselineTrades = includedFolds.flatMap((fold) => fold.baselineTestTrades).sort(byPolicyPriority);
    const selectedTrades = includedFolds.flatMap((fold) => fold.selectedTestTrades).sort(byPolicyPriority);
    return {
      testYear: index + 1,
      foldIds: includedFolds.map((fold) => fold.id),
      baseline: summarize(baselineTrades),
      selected: summarize(selectedTrades),
    };
  });
  const passesRollingGate = selectedWalkForward.netPnlUsdt > baselineWalkForward.netPnlUsdt
    && selectedWalkForward.netPnlUsdt > 0
    && selectedWalkForward.profitFactor >= 1.05
    && selectedWalkForward.maxDrawdownUsdt <= baselineWalkForward.maxDrawdownUsdt * 1.1
    && positiveSelectedFolds >= 2
    && foldsBeatingBaseline >= 2;
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: `${input.foldCount}-fold expanding quarterly walk-forward validation with BTC market-stage attribution`,
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
      embargoHours,
    },
    assumptions: {
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      selection: "Each fold uses only data before its test quarter; dynamic exits are activated from the next candle only",
      trainGate: "candidate beats train baseline, is profitable with PF >= 1.05, has enough signals, acceptable drawdown, and positive train halves; otherwise baseline",
      aggregateGate: "positive aggregate with PF >= 1.05, beats baseline, drawdown <= 110% of baseline, and at least two profitable/beating folds",
      selectionMode: input.fixedPolicyIds.length > 0
        ? `fixed default-cost fold policies: ${input.fixedPolicyIds.join(",")}`
        : "quarterly train-only reselection",
      marketStage: "BTC 4h regime plus BTC 1h EMA50/RSI state at signal time",
      initialTrainingMonths: input.initialTrainingMonths,
    },
    selectedPolicyIds: folds.map((fold) => fold.selectedPolicy.id),
    passesRollingGate,
    recommendation: passesRollingGate ? "QUARTERLY_RESELECTION_CANDIDATE" : "KEEP_BASELINE",
    results: {
      priorPublishedFullYearBaseline: { signals: 584, netPnlUsdt: 364.425, profitFactor: 1.0252, maxDrawdownPercent: 7.3036 },
      fullWindowBaseline: summarize(baselineFullTrades),
      baselineByValidationYear,
      rollingOutOfSampleBaseline: baselineWalkForward,
      rollingOutOfSampleSelected: selectedWalkForward,
      rollingByTestYear,
      difference: {
        signals: selectedWalkForward.signals - baselineWalkForward.signals,
        netPnlUsdt: round(selectedWalkForward.netPnlUsdt - baselineWalkForward.netPnlUsdt, 4),
        profitFactor: round(selectedWalkForward.profitFactor - baselineWalkForward.profitFactor, 4),
        maxDrawdownPercent: round(selectedWalkForward.maxDrawdownPercent - baselineWalkForward.maxDrawdownPercent, 4),
      },
      positiveSelectedFolds,
      foldsBeatingBaseline,
    },
    folds: folds.map(({ baselineTestTrades, selectedTestTrades, ...fold }) => fold),
    attribution: {
      baselineByMarketStage: summarizeAttribution(baselineWalkForwardTrades, (trade) => trade.policyFeatures?.marketState ?? "UNKNOWN"),
      selectedByMarketStage: summarizeAttribution(selectedWalkForwardTrades, (trade) => trade.policyFeatures?.marketState ?? "UNKNOWN"),
      baselineByTestQuarter: summarizeAttribution(baselineWalkForwardTrades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 7)),
      selectedByTestQuarter: summarizeAttribution(selectedWalkForwardTrades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 7)),
    },
    universe: {
      symbols: input.symbols,
      selectedSymbolCount: input.symbols.length,
      requestedSymbolCount: input.requestedSymbolCount,
      selection: "symbols from the explicit frozen manifest with complete history for the full window",
      survivorshipWarning: "The frozen manifest is based on currently trading contracts; delisted contracts are not represented.",
    },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName(input.reportFocus, input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    selectedPolicyIds: report.selectedPolicyIds,
    passesRollingGate,
    recommendation: report.recommendation,
    results: report.results,
    folds: report.folds.map((fold) => ({
      id: fold.id,
      selectedPolicy: fold.selectedPolicy.id,
      baselineTest: fold.baselineTest,
      selectedTest: fold.selectedTest,
    })),
    attribution: report.attribution,
  }, null, 2));
}

function summarizeAttribution(trades: BacktestTrade[], keyOf: (trade: BacktestTrade) => string) {
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...summarize(group) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

async function writeDynamicExitPathReport(input: {
  datasets: HistoricalDataset[];
  windowStart: number;
  windowEnd: number;
  trainEnd: number;
  oosStart: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
  fixedPolicyId?: string;
}) {
  const baseVariant = createVariants(70, input.feeRate, input.slippageBps, "production-aligned-selected")[0];
  const candidateCaches = input.datasets.map((dataset) => buildCandidateCache(
    dataset,
    baseVariant.params,
    input.windowEnd,
    baseVariant.options.entryIntervalHours,
  ));
  const allCandidates = dynamicExitCandidates();
  const candidates = input.fixedPolicyId
    ? allCandidates.filter((candidate) => candidate.id === "baseline" || candidate.id === input.fixedPolicyId)
    : allCandidates;
  const run = (candidate: DynamicExitCandidate, start: number, end: number) => runPortfolioBacktest(
    input.datasets,
    baseVariant.params,
    {
      ...baseVariant.options,
      candidateCaches,
      dynamicExitPolicy: candidate.policy,
      evaluationStartTime: start,
      evaluationEndTime: end,
    },
  );
  const trainMidpoint = input.windowStart + Math.floor((input.trainEnd - input.windowStart) / 2);
  const selectionResults = candidates.map((candidate) => {
    const result = run(candidate, input.windowStart, input.trainEnd);
    return {
      candidate,
      run: result,
      metrics: summarize(result.trades),
      firstHalf: summarize(tradesInWindow(result.trades, input.windowStart, trainMidpoint - MAX_HOLD_HOURS * HOUR)),
      secondHalf: summarize(tradesInWindow(result.trades, trainMidpoint, input.trainEnd)),
    };
  });
  const baselineTrain = selectionResults.find((result) => result.candidate.id === "baseline")!;
  const scoredSelection = selectionResults.map((result) => {
    const eligible = result.candidate.id !== "baseline"
      && result.metrics.signals >= 300
      && result.metrics.netPnlUsdt > baselineTrain.metrics.netPnlUsdt
      && result.metrics.profitFactor >= 1.05
      && result.metrics.maxDrawdownUsdt <= baselineTrain.metrics.maxDrawdownUsdt * 1.1
      && result.firstHalf.netPnlUsdt > 0
      && result.secondHalf.netPnlUsdt > 0;
    return {
      ...result,
      eligible,
      selectionScore: eligible
        ? result.metrics.netPnlUsdt - result.metrics.maxDrawdownUsdt * 0.25
        : Number.NEGATIVE_INFINITY,
    };
  }).sort((left, right) => right.selectionScore - left.selectionScore);
  const fixedSelection = input.fixedPolicyId
    ? scoredSelection.find((result) => result.candidate.id === input.fixedPolicyId)
    : undefined;
  if (input.fixedPolicyId && !fixedSelection) throw new Error(`Unknown CS_DYNAMIC_EXIT_POLICY_ID: ${input.fixedPolicyId}`);
  const selected = fixedSelection
    ?? scoredSelection.find((result) => result.eligible)
    ?? scoredSelection.find((result) => result.candidate.id === "baseline")!;
  const baselineCandidate = candidates[0];
  const baselineOosRun = run(baselineCandidate, input.oosStart, input.windowEnd);
  const selectedOosRun = selected.candidate.id === "baseline"
    ? baselineOosRun
    : run(selected.candidate, input.oosStart, input.windowEnd);
  const baselineOos = summarize(baselineOosRun.trades);
  const selectedOos = summarize(selectedOosRun.trades);
  const passesOosGate = selected.candidate.id !== "baseline"
    && selected.eligible
    && selectedOos.signals >= 80
    && selectedOos.netPnlUsdt > baselineOos.netPnlUsdt
    && selectedOos.profitFactor >= 1.05
    && selectedOos.maxDrawdownUsdt <= baselineOos.maxDrawdownUsdt * 1.1;
  const productionCandidate = passesOosGate ? selected.candidate : baselineCandidate;
  const baselineFullRun = run(baselineCandidate, input.windowStart, input.windowEnd);
  const selectedFullRun = selected.candidate.id === "baseline"
    ? baselineFullRun
    : run(selected.candidate, input.windowStart, input.windowEnd);
  const productionFullRun = productionCandidate.id === "baseline"
    ? baselineFullRun
    : selectedFullRun;
  const productionOosRun = productionCandidate.id === "baseline" ? baselineOosRun : selectedOosRun;
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Leakage-controlled post-entry path analysis and dynamic-exit validation",
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      trainEnd: new Date(input.trainEnd).toISOString(),
      outOfSampleStart: new Date(input.oosStart).toISOString(),
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      intrabarModel: "hard or previously-active dynamic stop first, then fixed take profit",
      dynamicStopActivation: "a stop tightened from candle high/low becomes active only on the next candle",
      selectionRule: "at least 300 train trades, train net PnL above baseline, PF >= 1.05, drawdown <= 110% of baseline, and positive PnL in both train halves",
      deploymentRule: "selected rule must also beat baseline OOS net PnL with PF >= 1.05, at least 80 OOS trades, and drawdown <= 110% of baseline",
      selectionMode: input.fixedPolicyId ? `fixed policy stress test: ${input.fixedPolicyId}` : "train-only candidate selection",
    },
    selectedTrainPolicy: selected.candidate,
    passesOosGate,
    productionPolicy: productionCandidate,
    selectionResults: scoredSelection.map(({ candidate, metrics, firstHalf, secondHalf, eligible, selectionScore }) => ({
      candidate,
      metrics,
      stability: { firstHalf, secondHalf },
      eligible,
      selectionScore: Number.isFinite(selectionScore) ? selectionScore : null,
    })),
    results: {
      priorPublishedBaseline: { signals: 584, netPnlUsdt: 364.425, profitFactor: 1.0252, maxDrawdownPercent: 7.3036 },
      baselineFull: summarize(baselineFullRun.trades),
      selectedFullDiagnostic: summarize(selectedFullRun.trades),
      productionFull: summarize(productionFullRun.trades),
      baselineOutOfSample: baselineOos,
      selectedOutOfSample: selectedOos,
      productionOutOfSample: summarize(productionOosRun.trades),
    },
    pathAnalysis: {
      baselineFull: summarizeTradePaths(baselineFullRun.trades),
      selectedFullDiagnostic: summarizeTradePaths(selectedFullRun.trades),
    },
    universe: { symbols: input.symbols, selection: "explicit frozen symbol manifest" },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("dynamic-exit-path", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    selectedTrainPolicy: report.selectedTrainPolicy,
    passesOosGate,
    productionPolicy: report.productionPolicy,
    results: report.results,
    pathAnalysis: report.pathAnalysis,
  }, null, 2));
}

function summarizeTradePaths(trades: BacktestTrade[]) {
  const withPath = trades.filter((trade) => trade.path !== undefined);
  const values = (of: (trade: BacktestTrade) => number) => withPath.map(of).sort((left, right) => left - right);
  const average = (items: number[]) => items.length === 0 ? 0 : items.reduce((sum, value) => sum + value, 0) / items.length;
  const median = (items: number[]) => items.length === 0
    ? 0
    : items.length % 2 === 1
      ? items[Math.floor(items.length / 2)]
      : (items[items.length / 2 - 1] + items[items.length / 2]) / 2;
  const mfe = values((trade) => trade.path!.maxFavorableR);
  const mae = values((trade) => trade.path!.maxAdverseR);
  const hold = values((trade) => trade.path!.holdingHours);
  const timeToMfe = values((trade) => trade.path!.timeToMaxFavorableHours);
  const giveback = values((trade) => trade.path!.givebackR);
  const reachedOneR = withPath.filter((trade) => trade.path!.maxFavorableR >= 1);
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of withPath) {
    const group = groups.get(trade.exitReason) ?? [];
    group.push(trade);
    groups.set(trade.exitReason, group);
  }
  return {
    trades: withPath.length,
    averageMfeR: round(average(mfe), 4),
    medianMfeR: round(median(mfe), 4),
    averageMaeR: round(average(mae), 4),
    medianMaeR: round(median(mae), 4),
    averageHoldingHours: round(average(hold), 2),
    medianHoldingHours: round(median(hold), 2),
    averageTimeToMfeHours: round(average(timeToMfe), 2),
    averageGivebackR: round(average(giveback), 4),
    reached0_5RPercent: round(withPath.filter((trade) => trade.path!.maxFavorableR >= 0.5).length / Math.max(1, withPath.length) * 100, 2),
    reached1RPercent: round(reachedOneR.length / Math.max(1, withPath.length) * 100, 2),
    reached1_5RPercent: round(withPath.filter((trade) => trade.path!.maxFavorableR >= 1.5).length / Math.max(1, withPath.length) * 100, 2),
    reached1RThenLostPercent: round(reachedOneR.filter((trade) => trade.pnlUsdt < 0).length / Math.max(1, reachedOneR.length) * 100, 2),
    byExitReason: [...groups.entries()].map(([exitReason, group]) => ({
      exitReason,
      trades: group.length,
      netPnlUsdt: round(group.reduce((sum, trade) => sum + trade.pnlUsdt, 0), 4),
      averageMfeR: round(average(group.map((trade) => trade.path!.maxFavorableR)), 4),
      averageGivebackR: round(average(group.map((trade) => trade.path!.givebackR)), 4),
      averageHoldingHours: round(average(group.map((trade) => trade.path!.holdingHours)), 2),
    })).sort((left, right) => left.exitReason.localeCompare(right.exitReason)),
  };
}

interface MarketFundingPolicyCandidate {
  id: string;
  marketStateFilter: MarketStateFilter;
  maxFundingCostRiskFraction: number;
  minimumExpectedNetR: number;
  useExpectedValue: boolean;
}

async function writeMarketFundingExpectedValueReport(input: {
  datasets: HistoricalDataset[];
  windowStart: number;
  windowEnd: number;
  trainEnd: number;
  oosStart: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const baseVariant = createVariants(70, input.feeRate, input.slippageBps, "production-aligned-selected")[0];
  const benchmarkDataset = input.datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  if (!benchmarkDataset) throw new Error("BTCUSDT is required as the market-state benchmark");
  const fullRun = runPortfolioBacktest(input.datasets, baseVariant.params, {
    ...baseVariant.options,
    evaluationStartTime: input.windowStart,
    evaluationEndTime: input.windowEnd,
  }, { benchmarkDataset, marketStateCache: new Map() });
  const rawTrades = fullRun.rawTrades;
  const calibrationEnd = addMonths(input.windowStart, 6) - MAX_HOLD_HOURS * HOUR;
  const selectionStart = addMonths(input.windowStart, 6);
  const calibrationTrades = tradesInWindow(rawTrades, input.windowStart, calibrationEnd);
  const selectionTrades = tradesInWindow(rawTrades, selectionStart, input.trainEnd);
  const oosTrades = tradesInWindow(rawTrades, input.oosStart, input.windowEnd);
  const earlyTrades = tradesInWindow(rawTrades, input.windowStart, calibrationEnd);
  const modelFromSixMonths = fitCostAwareModelFromTrades(calibrationTrades);
  const selectionMidpoint = selectionStart + Math.floor((input.trainEnd - selectionStart) / 2);
  const candidates: MarketFundingPolicyCandidate[] = [
    { id: "baseline", marketStateFilter: "NONE", maxFundingCostRiskFraction: 1, minimumExpectedNetR: 0, useExpectedValue: false },
    { id: "btc4h-bear-only", marketStateFilter: "BTC_4H_BEAR", maxFundingCostRiskFraction: 1, minimumExpectedNetR: 0, useExpectedValue: false },
    { id: "btc-weak-only", marketStateFilter: "BTC_4H_BEAR_1H_WEAK", maxFundingCostRiskFraction: 1, minimumExpectedNetR: 0, useExpectedValue: false },
    { id: "funding2-only", marketStateFilter: "NONE", maxFundingCostRiskFraction: 0.02, minimumExpectedNetR: 0, useExpectedValue: false },
    { id: "ev0-only", marketStateFilter: "NONE", maxFundingCostRiskFraction: 1, minimumExpectedNetR: 0, useExpectedValue: true },
    { id: "btc-weak-funding2-ev0", marketStateFilter: "BTC_4H_BEAR_1H_WEAK", maxFundingCostRiskFraction: 0.02, minimumExpectedNetR: 0, useExpectedValue: true },
  ];
  const selectionResults = candidates.map((policy) => {
    const trades = applyMarketFundingPolicy(selectionTrades, modelFromSixMonths, policy);
    const run = selectPortfolioTrades(trades, baseVariant.params, {
      ...baseVariant.options,
      evaluationStartTime: selectionStart,
      evaluationEndTime: input.trainEnd,
    });
    const metrics = summarize(run.trades);
    const firstHalfMetrics = summarize(run.trades.filter((trade) => trade.entryTime < selectionMidpoint));
    const secondHalfMetrics = summarize(run.trades.filter((trade) => trade.entryTime >= selectionMidpoint));
    const eligible = policy.id !== "baseline"
      && metrics.signals >= 30
      && metrics.netPnlUsdt > 0
      && metrics.profitFactor >= 1.05
      && firstHalfMetrics.netPnlUsdt > 0
      && secondHalfMetrics.netPnlUsdt > 0;
    return {
      policy,
      candidates: trades.length,
      metrics,
      stability: { firstHalf: firstHalfMetrics, secondHalf: secondHalfMetrics },
      eligible,
      selectionScore: eligible
        ? metrics.netPnlUsdt - metrics.maxDrawdownUsdt * 0.25
        : Number.NEGATIVE_INFINITY,
    };
  });
  selectionResults.sort((left, right) => right.selectionScore - left.selectionScore);
  const selected = selectionResults.find((result) => result.eligible)
    ?? selectionResults.find((result) => result.policy.id === "baseline")!;
  const modelFromNineMonths = fitCostAwareModelFromTrades(
    tradesInWindow(rawTrades, input.windowStart, input.trainEnd),
    selected.policy.useExpectedValue ? selected.policy.minimumExpectedNetR : 0,
  );
  const selectedOosCandidates = applyMarketFundingPolicy(oosTrades, modelFromNineMonths, selected.policy);
  const selectedOosRun = selectPortfolioTrades(selectedOosCandidates, baseVariant.params, {
    ...baseVariant.options,
    evaluationStartTime: input.oosStart,
    evaluationEndTime: input.windowEnd,
  });
  const walkForwardCandidates = [
    ...earlyTrades,
    ...applyMarketFundingPolicy(selectionTrades, modelFromSixMonths, selected.policy),
    ...selectedOosCandidates,
  ].sort(byPolicyPriority);
  const comparableBaselineCandidates = [
    ...earlyTrades,
    ...selectionTrades,
    ...oosTrades,
  ].sort(byPolicyPriority);
  const walkForwardRun = selectPortfolioTrades(walkForwardCandidates, baseVariant.params, {
    ...baseVariant.options,
    evaluationStartTime: input.windowStart,
    evaluationEndTime: input.windowEnd,
  });
  const comparableBaselineRun = selectPortfolioTrades(comparableBaselineCandidates, baseVariant.params, {
    ...baseVariant.options,
    evaluationStartTime: input.windowStart,
    evaluationEndTime: input.windowEnd,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Leakage-controlled BTC market-state, projected-funding-cost and cost-aware expected-net-R validation",
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      calibrationEnd: new Date(calibrationEnd).toISOString(),
      selectionStart: new Date(selectionStart).toISOString(),
      trainEnd: new Date(input.trainEnd).toISOString(),
      oosStart: new Date(input.oosStart).toISOString(),
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      benchmark: "BTCUSDT",
      fundingForecast: "mean of the last 3 known funding rates projected over a 24h expected hold",
      selectionRule: "highest selection net PnL minus 25% of selection max drawdown among non-baseline policies with at least 30 trades, positive net PnL, PF >= 1.05, and positive PnL in both halves; otherwise fall back to baseline",
      note: "The final OOS window supplies no labels or policy choices. The annual walk-forward simulation uses baseline policy during the first six-month calibration period.",
    },
    selectedPolicy: selected.policy,
    modelFromSixMonths,
    modelFromNineMonths,
    selectionResults: selectionResults.map(({ policy, candidates: count, metrics, stability, eligible, selectionScore }) => ({
      policy,
      candidates: count,
      metrics,
      stability,
      eligible,
      selectionScore: Number.isFinite(selectionScore) ? selectionScore : null,
    })),
    results: {
      priorPublishedBaseline: {
        netPnlUsdt: 364.425,
        profitFactor: 1.0252,
        maxDrawdownPercent: 7.3036,
        signals: 584,
      },
      comparableBaseline: summarize(comparableBaselineRun.trades),
      walkForwardAnnual: summarize(walkForwardRun.trades),
      outOfSample: summarize(selectedOosRun.trades),
      outOfSampleCandidates: selectedOosCandidates.length,
    },
    universe: { symbols: input.symbols, selection: "explicit frozen symbol manifest" },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("market-funding-ev", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    selectedPolicy: report.selectedPolicy,
    comparableBaseline: report.results.comparableBaseline,
    walkForwardAnnual: report.results.walkForwardAnnual,
    outOfSample: report.results.outOfSample,
  }, null, 2));
}

function fitCostAwareModelFromTrades(trades: BacktestTrade[], minimumExpectedNetR = 0): CostAwareScoreModel {
  return fitCostAwareScoreModel(trades.flatMap((trade) => trade.policyFeatures ? [{
    score: trade.score,
    netR: trade.rMultiple,
    ...trade.policyFeatures,
  }] : []), {
    bucketSize: 5,
    minimumSamples: 80,
    minimumExpectedNetR,
    priorWeight: 100,
  });
}

function applyMarketFundingPolicy(
  trades: BacktestTrade[],
  model: CostAwareScoreModel,
  policy: MarketFundingPolicyCandidate,
): BacktestTrade[] {
  if (policy.id === "baseline") return [...trades].sort(byPolicyPriority);
  const accepted: BacktestTrade[] = [];
  for (const trade of trades) {
    const features = trade.policyFeatures;
    if (!features) continue;
    const marketAllowed = policy.marketStateFilter === "NONE"
      ? true
      : policy.marketStateFilter === "BTC_4H_BEAR"
        ? features.marketState === "BEAR_WEAK" || features.marketState === "BEAR_REBOUND"
        : features.marketState === "BEAR_WEAK";
    if (!marketAllowed || features.projectedFundingCostRiskFraction > policy.maxFundingCostRiskFraction) continue;
    if (!policy.useExpectedValue) {
      accepted.push({ ...trade, expectedNetR: null });
      continue;
    }
    const prediction = expectedNetR(model, trade.score, features);
    if (prediction === null || prediction < policy.minimumExpectedNetR) continue;
    accepted.push({ ...trade, expectedNetR: prediction });
  }
  return accepted.sort(byPolicyPriority);
}

function tradesInWindow(trades: BacktestTrade[], start: number, end: number): BacktestTrade[] {
  return trades.filter((trade) => trade.entryTime >= start && trade.exitTime <= end);
}

function byPolicyPriority(left: BacktestTrade, right: BacktestTrade): number {
  return left.entryTime - right.entryTime
    || (right.expectedNetR ?? Number.NEGATIVE_INFINITY) - (left.expectedNetR ?? Number.NEGATIVE_INFINITY)
    || right.score - left.score
    || left.symbol.localeCompare(right.symbol);
}

async function writeScoreCalibrationReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  windowStart: number;
  windowEnd: number;
  trainEnd: number;
  oosStart: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const run = (evaluationStartTime: number, evaluationEndTime: number, scoreCalibration?: ScoreCalibrationModel) => runPortfolioBacktest(
    input.datasets,
    input.variant.params,
    {
      ...input.variant.options,
      scoreCalibration,
      evaluationStartTime,
      evaluationEndTime,
    },
  );

  // The model is fitted only from uncalibrated train trades. Portfolio and
  // email caps are intentionally not used as calibration labels because they
  // describe account capacity, not signal edge.
  const trainRawRun = run(input.windowStart, input.trainEnd);
  const model = fitScoreCalibration(
    trainRawRun.rawTrades.map((trade) => ({
      score: trade.score,
      netR: trade.rMultiple,
      strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION",
    })),
    input.variant.calibration,
  );
  const trainCalibratedRun = run(input.windowStart, input.trainEnd, model);
  const oosRawRun = run(input.oosStart, input.windowEnd);
  const oosCalibratedRun = run(input.oosStart, input.windowEnd, model);
  const fullCalibratedRun = run(input.windowStart, input.windowEnd, model);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Train-only empirical score calibration followed by fixed out-of-sample evaluation",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    calibration: {
      fitWindow: {
        start: new Date(input.windowStart).toISOString(),
        end: new Date(input.trainEnd).toISOString(),
      },
      model,
      note: "Each score bucket is accepted only when its shrunk train mean net R meets the pre-registered threshold and its sample count is sufficient. The OOS window never contributes labels.",
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
      trainEnd: new Date(input.trainEnd).toISOString(),
      oosStart: new Date(input.oosStart).toISOString(),
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Raw metrics measure signal edge before portfolio/email caps; calibrated metrics measure the alert account after those caps.",
    },
    universe: {
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    results: {
      fullCalibrated: summarize(fullCalibratedRun.trades),
      train: {
        rawSignals: trainRawRun.rawTrades.length,
        raw: summarize(trainRawRun.rawTrades),
        beforeCalibration: summarize(trainRawRun.trades),
        calibrated: summarize(trainCalibratedRun.trades),
        calibratedRaw: summarize(trainCalibratedRun.rawTrades),
        rejectionCounts: trainCalibratedRun.rejectionCounts,
      },
      outOfSample: {
        rawSignals: oosRawRun.rawTrades.length,
        raw: summarize(oosRawRun.rawTrades),
        beforeCalibration: summarize(oosRawRun.trades),
        calibrated: summarize(oosCalibratedRun.trades),
        calibratedRaw: summarize(oosCalibratedRun.rawTrades),
        rejectionCounts: oosCalibratedRun.rejectionCounts,
        passesSuggestedGate: passesSuggestedGate(summarize(oosCalibratedRun.trades)),
      },
    },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("score-calibrated", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    calibration: {
      samples: trainRawRun.rawTrades.length,
      globalMeanNetR: model.globalMeanNetR,
      acceptedBins: model.bins.filter((bin) => bin.samples >= model.minimumSamples && bin.meanNetR >= model.minimumExpectedNetR),
    },
    train: {
      rawNetPnlUsdt: report.results.train.raw.netPnlUsdt,
      calibratedNetPnlUsdt: report.results.train.calibrated.netPnlUsdt,
      calibratedPF: report.results.train.calibrated.profitFactor,
    },
    outOfSample: {
      rawNetPnlUsdt: report.results.outOfSample.raw.netPnlUsdt,
      calibratedNetPnlUsdt: report.results.outOfSample.calibrated.netPnlUsdt,
      calibratedPF: report.results.outOfSample.calibrated.profitFactor,
      calibratedDD: report.results.outOfSample.calibrated.maxDrawdownPercent,
      passesSuggestedGate: report.results.outOfSample.passesSuggestedGate,
    },
  }, null, 2));
}

async function writeScoreCalibratedRollingReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const run = (evaluationStartTime: number, evaluationEndTime: number, scoreCalibration?: ScoreCalibrationModel) => runPortfolioBacktest(
    input.datasets,
    input.variant.params,
    {
      ...input.variant.options,
      scoreCalibration,
      evaluationStartTime,
      evaluationEndTime,
    },
  );
  const folds = [1, 2, 3].map((index) => {
    const start = input.windowStart + index * quarterLength;
    const end = index === 3
      ? input.windowEnd
      : input.windowStart + (index + 1) * quarterLength - 1;
    const trainEnd = start - MAX_HOLD_HOURS * HOUR;
    const trainRun = run(input.windowStart, trainEnd);
    const model = fitScoreCalibration(
      trainRun.rawTrades.map((trade) => ({
        score: trade.score,
        netR: trade.rMultiple,
        strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION",
      })),
      input.variant.calibration,
    );
    const rawRun = run(start, end);
    const calibratedRun = run(start, end, model);
    return {
      id: `q${index + 1}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      calibrationTrainEnd: new Date(trainEnd).toISOString(),
      calibration: {
        samples: trainRun.rawTrades.length,
        globalMeanNetR: model.globalMeanNetR,
        bins: model.bins,
        acceptedBins: model.bins.filter((bin) => bin.samples >= model.minimumSamples && bin.meanNetR >= model.minimumExpectedNetR),
      },
      raw: summarize(rawRun.trades),
      rawSignals: rawRun.rawTrades.length,
      calibrated: summarize(calibratedRun.trades),
      calibratedRaw: summarize(calibratedRun.rawTrades),
      rejectionCounts: calibratedRun.rejectionCounts,
    };
  });
  const totalNetPnlUsdt = round(folds.reduce((sum, fold) => sum + fold.calibrated.netPnlUsdt, 0), 4);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Expanding-window train-only score calibration followed by independent quarterly OOS folds",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Q1 is reserved as initial calibration history. Each later quarter fits on all prior data with a 72h embargo, then evaluates a fresh 10,000U account. No quarter's outcomes fit its own model.",
    },
    universe: {
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    summary: {
      folds: folds.length,
      profitableFolds: folds.filter((fold) => fold.calibrated.netPnlUsdt > 0).length,
      totalNetPnlUsdt,
      minimumFoldNetPnlUsdt: round(Math.min(...folds.map((fold) => fold.calibrated.netPnlUsdt)), 4),
      maximumFoldDrawdownPercent: round(Math.max(...folds.map((fold) => fold.calibrated.maxDrawdownPercent)), 4),
    },
    folds,
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("score-calibrated-rolling", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    summary: report.summary,
    folds: folds.map((fold) => ({
      id: fold.id,
      calibrationSamples: fold.calibration.samples,
      acceptedBins: fold.calibration.acceptedBins.length,
      rawNetPnlUsdt: fold.raw.netPnlUsdt,
      calibratedNetPnlUsdt: fold.calibrated.netPnlUsdt,
      calibratedPF: fold.calibrated.profitFactor,
      calibratedDD: fold.calibrated.maxDrawdownPercent,
    })),
  }, null, 2));
}

async function writeRollingValidationReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
  reportFileName: string;
}) {
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const folds = Array.from({ length: 4 }, (_, index) => {
    const start = input.windowStart + index * quarterLength;
    const end = index === 3
      ? input.windowEnd
      : input.windowStart + (index + 1) * quarterLength - 1;
    const run = runPortfolioBacktest(input.datasets, input.variant.params, {
      ...input.variant.options,
      evaluationStartTime: start,
      evaluationEndTime: end,
    });
    return {
      id: `q${index + 1}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      metrics: summarize(run.trades),
      rawSignals: run.rawTrades.length,
      rejectionCounts: run.rejectionCounts,
    };
  });
  const netPnlUsdt = round(folds.reduce((sum, fold) => sum + fold.metrics.netPnlUsdt, 0), 4);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Fixed-policy rolling robustness check; no parameter selection uses these folds",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Each fold is evaluated independently with a fresh 10,000U paper capital base; this is a stability check, not a compounded equity curve.",
    },
    universe: {
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    summary: {
      folds: folds.length,
      profitableFolds: folds.filter((fold) => fold.metrics.netPnlUsdt > 0).length,
      totalNetPnlUsdt: netPnlUsdt,
      minimumFoldNetPnlUsdt: round(Math.min(...folds.map((fold) => fold.metrics.netPnlUsdt)), 4),
      maximumFoldDrawdownPercent: round(Math.max(...folds.map((fold) => fold.metrics.maxDrawdownPercent)), 4),
    },
    folds,
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", input.reportFileName);
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    summary: report.summary,
    folds: folds.map((fold) => ({ id: fold.id, signals: fold.metrics.signals, netPnlUsdt: fold.metrics.netPnlUsdt, profitFactor: fold.metrics.profitFactor })),
  }, null, 2));
}

async function writeCapacityRollingValidationReport(input: {
  datasets: HistoricalDataset[];
  variants: Variant[];
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const variantsReport = input.variants.map((variant) => {
    const folds = Array.from({ length: 4 }, (_, index) => {
      const start = input.windowStart + index * quarterLength;
      const end = index === 3
        ? input.windowEnd
        : input.windowStart + (index + 1) * quarterLength - 1;
      const run = runPortfolioBacktest(input.datasets, variant.params, {
        ...variant.options,
        evaluationStartTime: start,
        evaluationEndTime: end,
      });
      return {
        id: `q${index + 1}`,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        signalCandidates: run.rawTrades.length,
        acceptedPaperTrades: run.trades.length,
        metrics: summarize(run.trades),
        rejectionCounts: run.rejectionCounts,
      };
    });
    const netPnlUsdt = round(folds.reduce((sum, fold) => sum + fold.metrics.netPnlUsdt, 0), 4);
    return {
      id: variant.id,
      description: variant.description,
      maxConcurrentPositions: variant.options.maxConcurrentPositions ?? 6,
      summary: {
        folds: folds.length,
        profitableFolds: folds.filter((fold) => fold.metrics.netPnlUsdt > 0).length,
        totalNetPnlUsdt: netPnlUsdt,
        minimumFoldNetPnlUsdt: round(Math.min(...folds.map((fold) => fold.metrics.netPnlUsdt)), 4),
        maximumFoldDrawdownPercent: round(Math.max(...folds.map((fold) => fold.metrics.maxDrawdownPercent)), 4),
      },
      folds,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Fixed-policy quarterly capacity comparison; signal candidates are separated from accepted paper trades",
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Each capacity/fold is evaluated independently with a fresh 10,000U paper capital base; no capacity is used to generate the signal candidate count.",
    },
    universe: {
      symbols: input.symbols,
      selection: "explicit frozen symbol manifest",
    },
    variants: variantsReport,
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("profit-oriented-capacity-rolling", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    variants: variantsReport.map((variant) => ({
      id: variant.id,
      maxConcurrentPositions: variant.maxConcurrentPositions,
      summary: variant.summary,
      folds: variant.folds.map((fold) => ({
        id: fold.id,
        signalCandidates: fold.signalCandidates,
        acceptedPaperTrades: fold.acceptedPaperTrades,
        netPnlUsdt: fold.metrics.netPnlUsdt,
        profitFactor: fold.metrics.profitFactor,
      })),
    })),
  }, null, 2));
}

function variantSuffix(options: Partial<BacktestOptions>, variantMinScore: number, defaultMinScore: number): string {
  const parts = [
    options.requireRegimeAlignment ? "regime" : "",
    options.sideFilter ? options.sideFilter.toLowerCase() : "",
    options.strategyFamilies?.join("-").toLowerCase() ?? "",
  ].filter(Boolean);
  if (variantMinScore !== defaultMinScore) parts.push("score" + variantMinScore);
  return parts.length === 0 ? "" : "-" + parts.join("-");
}

function summarize(trades: BacktestTrade[]): Metrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = INITIAL_CAPITAL_USDT;
  let peak = equity;
  let maxDrawdownUsdt = 0;
  for (const trade of ordered) {
    equity += trade.pnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = trades.filter((trade) => trade.pnlUsdt > 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(trades.filter((trade) => trade.pnlUsdt < 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  return {
    signals: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : round(wins / trades.length * 100, 2),
    avgScore: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.score, 0) / trades.length, 2),
    avgRiskUsdt: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.theoreticalRiskUsdt, 0) / trades.length, 4),
    avgPnlUsdt: trades.length === 0 ? 0 : round(netPnlUsdt / trades.length, 4),
    netR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    pricePnlBeforeExecutionCostsUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt + trade.slippageUsdt, 0), 4),
    totalFeesUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((sum, trade) => sum + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((sum, trade) => sum + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 4),
    maxDrawdownPercent: round(maxDrawdownUsdt / INITIAL_CAPITAL_USDT * 100, 4),
    finalEquityUsdt: round(INITIAL_CAPITAL_USDT + netPnlUsdt, 4),
  };
}

function summarizeDiagnostics(trades: BacktestTrade[]): TradeDiagnostics {
  return {
    byExitReason: diagnosticRows(trades, (trade) => trade.exitReason),
    byMarketRegime: diagnosticRows(trades, (trade) => trade.marketRegime),
    byStrategyFamily: diagnosticRows(trades, (trade) => trade.strategyFamily),
    byMonth: diagnosticRows(trades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 7)),
    bySymbol: diagnosticRows(trades, (trade) => trade.symbol),
  };
}

function diagnosticRows(
  trades: BacktestTrade[],
  keyOf: (trade: BacktestTrade) => string,
): DiagnosticRow[] {
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const netPnlUsdt = group.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
      const wins = group.filter((trade) => trade.pnlUsdt > 0).length;
      return {
        key,
        signals: group.length,
        wins,
        losses: group.filter((trade) => trade.pnlUsdt < 0).length,
        winRate: round(wins / group.length * 100, 2),
        netPnlUsdt: round(netPnlUsdt, 4),
        avgPnlUsdt: round(netPnlUsdt / group.length, 4),
      };
    })
    .sort((left, right) => left.netPnlUsdt - right.netPnlUsdt || left.key.localeCompare(right.key));
}

function runValidationSlice(
  datasets: HistoricalDataset[],
  variant: Variant,
  evaluationStartTime: number,
  evaluationEndTime: number,
): {
  metrics: Metrics;
  rawMetrics: Metrics;
  rawSignals: number;
  rejectionCounts: ReturnType<typeof runPortfolioBacktest>["rejectionCounts"];
  trades: BacktestTrade[];
} {
  const run = runPortfolioBacktest(datasets, variant.params, {
    ...variant.options,
    evaluationStartTime,
    evaluationEndTime,
  });
  return {
    metrics: summarize(run.trades),
    rawMetrics: summarize(run.rawTrades),
    rawSignals: run.rawTrades.length,
    rejectionCounts: run.rejectionCounts,
    trades: run.trades,
  };
}

function passesSuggestedGate(metrics: Metrics): boolean {
  return metrics.signals >= 100
    && metrics.netPnlUsdt > 0
    && metrics.profitFactor >= 1.1
    && metrics.maxDrawdownPercent <= 30;
}

function rankResult(result: {
  outOfSample: Metrics;
  passesSuggestedGate: boolean;
}): number {
  return (result.passesSuggestedGate ? 1_000_000 : 0)
    + result.outOfSample.netPnlUsdt
    - result.outOfSample.maxDrawdownUsdt;
}

function selectInstruments(universe: Instrument[], symbols: string[], symbolCount: number): Instrument[] {
  const bySymbol = new Map(universe.map((instrument) => [instrument.symbol, instrument]));
  if (symbols.length === 0) {
    const candidateCount = Math.min(MAX_VALIDATION_CANDIDATES, symbolCount + 25);
    return universe.slice(0, candidateCount);
  }
  const missing = symbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length > 0) throw new Error("Symbols are not currently trading USDT-M perpetuals: " + missing.join(", "));
  return symbols.map((symbol) => bySymbol.get(symbol) as Instrument);
}

function parseSymbols(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return symbols.length === 0 ? [] : [...new Set(symbols)];
}

async function loadUniverseSymbols(path: string | undefined): Promise<string[]> {
  if (!path?.trim()) return [];
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as string[] | { symbols?: string[] };
  const symbols = Array.isArray(raw) ? raw : raw.symbols ?? [];
  return parseSymbols(symbols.join(","));
}

function hasFullValidationHistory(
  dataset: HistoricalDataset,
  windowStart: number,
  windowEnd: number,
  minimumCandles15m = 365 * 24 * 4,
): boolean {
  const candles15m = dataset.candles["15m"];
  const firstOpenTime = candles15m[0]?.openTime ?? Number.POSITIVE_INFINITY;
  const lastCloseTime = candles15m.at(-1)?.closeTime ?? 0;
  return candles15m.length >= minimumCandles15m
    && firstOpenTime <= windowStart
    && lastCloseTime >= windowEnd - 15 * 60 * 1000;
}

function parseVariantIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseOrderedIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function validationReportFileName(focus: string, feeRate: number, slippageBps: number): string {
  const isDefaultCost = feeRate === 0.0004 && slippageBps === 2;
  const suffix = isDefaultCost
    ? "latest"
    : `fee${Math.round(feeRate * 10_000)}bps-slip${slippageBps}bps`;
  return focus === "full"
    ? `validation-${suffix}.json`
    : `validation-${focus}-${suffix}.json`;
}

function timestampEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value?.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function loadLatestPriorCache(
  cacheDir: string,
  symbol: string,
  requestedEndTime: number,
): Promise<HistoricalDataset | null> {
  const names = await readdir(cacheDir);
  const candidates = names
    .filter((name) => name.startsWith(symbol + "-") && name.endsWith(".json"))
    .map((name) => resolve(cacheDir, name));
  const datasets: HistoricalDataset[] = [];
  for (const path of candidates) {
    try {
      const dataset = JSON.parse(await readFile(path, "utf8")) as HistoricalDataset;
      const lastCloseTime = dataset.candles["15m"].at(-1)?.closeTime ?? 0;
      if (lastCloseTime <= requestedEndTime) datasets.push(dataset);
    } catch {
      // Ignore an incomplete cache file and continue with the remaining candidates.
    }
  }
  datasets.sort((left, right) => (right.candles["15m"].at(-1)?.closeTime ?? 0) - (left.candles["15m"].at(-1)?.closeTime ?? 0));
  return datasets[0] ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
