import { runBacktest, type BacktestContext } from "./engine";
import type { BacktestMetrics, HistoricalDataset, OptimizerResult } from "./types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";

export function createParameterGrid(): StrategyParams[] {
  const variants: StrategyParams[] = [];
  for (const emaFast of [15, 20, 25]) {
    for (const emaSlow of [40, 50, 60]) {
      for (const stopAtrMultiplier of [0.2, 0.35, 0.5]) {
        for (const breakoutVolumeRatio of [1.1, 1.25]) {
          variants.push({
            ...DEFAULT_STRATEGY_PARAMS,
            entryMode: "V5_SIGNAL_EDGE",
            emaFast,
            emaSlow,
            stopAtrMultiplier,
            breakoutVolumeRatio,
          });
        }
      }
    }
  }
  return variants;
}

export function optimizeDatasets(
  datasets: HistoricalDataset[],
  variants = createParameterGrid(),
  context: BacktestContext = { benchmarkDataset: datasets.find((dataset) => dataset.symbol === "BTCUSDT") ?? datasets[0] },
): OptimizerResult[] {
  if (datasets.length === 0) return [];
  const split = splitAtPurgedWindows(datasets);
  return variants
    .map((params) => {
      const backtestOptions = { minimumSampleDays: 0, entryIntervalHours: 1 };
      const trainRuns = split.train.map((dataset) => runBacktest(dataset, params, backtestOptions, context));
      const validationRuns = split.validation.map((dataset) => runBacktest(dataset, params, backtestOptions, context));
      const holdoutRuns = split.holdout.map((dataset) => runBacktest(dataset, params, backtestOptions, context));
      const train = aggregateMetrics(trainRuns.map((run) => run.metrics));
      const validation = aggregateMetrics(validationRuns.map((run) => run.metrics));
      const outOfSample = aggregateMetrics(holdoutRuns.map((run) => run.metrics));
      return {
        params,
        train,
        validation,
        outOfSample,
        datasetCount: datasets.length,
        eligible: datasets.every((dataset) => hasAtLeastOneYear(dataset)) && validation.maxDrawdownPercent <= 30,
      };
    })
    .sort((left, right) => rankOptimizerResult(right) - rankOptimizerResult(left));
}

function splitAtPurgedWindows(datasets: HistoricalDataset[]) {
  return {
    train: datasets.map((dataset) => sliceDataset(dataset, "train")),
    validation: datasets.map((dataset) => sliceDataset(dataset, "validation")),
    holdout: datasets.map((dataset) => sliceDataset(dataset, "holdout")),
  };
}

function sliceDataset(dataset: HistoricalDataset, segment: "train" | "validation" | "holdout"): HistoricalDataset {
  const first = dataset.candles["15m"][0]?.openTime ?? 0;
  const trainBoundary = addMonths(first, 6);
  const validationBoundary = addMonths(first, 9);
  const purge = 72 * 60 * 60 * 1000;
  const validationStart = trainBoundary + purge;
  const holdoutStart = validationBoundary + purge;
  const filter = segment === "train"
    ? (timestamp: number) => timestamp <= trainBoundary - purge
    : segment === "validation"
      ? (timestamp: number) => timestamp >= validationStart && timestamp < validationBoundary
      : (timestamp: number) => timestamp >= holdoutStart;
  return {
    ...dataset,
    candles: {
      "15m": dataset.candles["15m"].filter((candle) => filter(candle.closeTime)),
      "1h": dataset.candles["1h"]?.filter((candle) => filter(candle.closeTime)),
      "4h": dataset.candles["4h"]?.filter((candle) => filter(candle.closeTime)),
    },
  };
}

function aggregateMetrics(metrics: BacktestMetrics[]): BacktestMetrics {
  const totalTrades = metrics.reduce((total, metric) => total + metric.trades, 0);
  const wins = metrics.reduce((total, metric) => total + metric.wins, 0);
  const losses = metrics.reduce((total, metric) => total + metric.losses, 0);
  const grossProfitUsdt = metrics.reduce((total, metric) => total + metric.grossProfitUsdt, 0);
  const grossLossUsdt = metrics.reduce((total, metric) => total + metric.grossLossUsdt, 0);
  const netPnlUsdt = metrics.reduce((total, metric) => total + metric.netPnlUsdt, 0);
  const totalFeesUsdt = metrics.reduce((total, metric) => total + metric.totalFeesUsdt, 0);
  const totalFundingUsdt = metrics.reduce((total, metric) => total + metric.totalFundingUsdt, 0);
  const totalSlippageUsdt = metrics.reduce((total, metric) => total + metric.totalSlippageUsdt, 0);
  const weighted = (selector: (metric: BacktestMetrics) => number | undefined): number => {
    if (totalTrades === 0) return 0;
    return metrics.reduce((total, metric) => total + (selector(metric) ?? 0) * metric.trades, 0) / totalTrades;
  };
  return {
    sampleDays: metrics.length === 0 ? 0 : Math.min(...metrics.map((metric) => metric.sampleDays)),
    minimumSampleDays: 365,
    trades: totalTrades,
    wins,
    losses,
    winRate: totalTrades === 0 ? 0 : round(wins / totalTrades * 100, 2),
    netR: round(metrics.reduce((total, metric) => total + metric.netR, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    grossProfitUsdt: round(grossProfitUsdt, 4),
    grossLossUsdt: round(grossLossUsdt, 4),
    totalFeesUsdt: round(totalFeesUsdt, 4),
    totalFundingUsdt: round(totalFundingUsdt, 4),
    totalSlippageUsdt: round(totalSlippageUsdt, 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownPercent: metrics.length === 0 ? 0 : round(Math.max(...metrics.map((metric) => metric.maxDrawdownPercent)), 4),
    maxDrawdownUsdt: round(metrics.reduce((total, metric) => total + metric.maxDrawdownUsdt, 0), 4),
    finalEquityUsdt: round(metrics.reduce((total, metric) => total + metric.finalEquityUsdt, 0), 4),
    initialCapitalUsdt: metrics.reduce((total, metric) => total + metric.initialCapitalUsdt, 0),
    eligible: metrics.every((metric) => metric.eligible),
    averageNetR: round(weighted((metric) => metric.averageNetR), 4),
    medianNetR: metrics.length === 0 ? 0 : round(metrics.reduce((total, metric) => total + (metric.medianNetR ?? 0), 0) / metrics.length, 4),
    cvar95: metrics.length === 0 ? 0 : round(Math.min(...metrics.map((metric) => metric.cvar95 ?? 0)), 4),
    averageMfeR: round(weighted((metric) => metric.averageMfeR), 4),
    averageMaeR: round(weighted((metric) => metric.averageMaeR), 4),
    stopFirstRate: round(weighted((metric) => metric.stopFirstRate), 4),
  };
}

function hasAtLeastOneYear(dataset: HistoricalDataset): boolean {
  const first = dataset.candles["15m"][0]?.openTime ?? 0;
  const last = dataset.candles["15m"].at(-1)?.closeTime ?? first;
  return last - first >= 365 * 86_400_000;
}

function rankOptimizerResult(result: OptimizerResult): number {
  const validation = result.validation;
  return (result.eligible ? 1_000_000 : 0) + validation.netPnlUsdt - validation.maxDrawdownPercent * 100;
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
