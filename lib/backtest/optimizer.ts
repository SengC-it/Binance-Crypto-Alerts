import { runBacktest } from "./engine";
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
): OptimizerResult[] {
  if (datasets.length === 0) return [];
  const split = splitAtNineMonths(datasets);
  return variants
    .map((params) => {
      const trainRuns = split.train.map((dataset) => runBacktest(dataset, params, { minimumSampleDays: 0 }));
      const oosRuns = split.outOfSample.map((dataset) => runBacktest(dataset, params, { minimumSampleDays: 0 }));
      const train = aggregateMetrics(trainRuns.map((run) => run.metrics));
      const outOfSample = aggregateMetrics(oosRuns.map((run) => run.metrics));
      return {
        params,
        train,
        outOfSample,
        datasetCount: datasets.length,
        eligible: datasets.every((dataset) => hasAtLeastOneYear(dataset)) && outOfSample.maxDrawdownPercent <= 30,
      };
    })
    .sort((left, right) => rankOptimizerResult(right) - rankOptimizerResult(left));
}

function splitAtNineMonths(datasets: HistoricalDataset[]) {
  return {
    train: datasets.map((dataset) => sliceDataset(dataset, "train")),
    outOfSample: datasets.map((dataset) => sliceDataset(dataset, "oos")),
  };
}

function sliceDataset(dataset: HistoricalDataset, segment: "train" | "oos"): HistoricalDataset {
  const first = dataset.candles["15m"][0]?.openTime ?? 0;
  const split = addMonths(first, 9);
  const filter = segment === "train"
    ? (timestamp: number) => timestamp <= split
    : (timestamp: number) => timestamp > split;
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
  return {
    sampleDays: Math.min(...metrics.map((metric) => metric.sampleDays)),
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
    maxDrawdownPercent: round(Math.max(...metrics.map((metric) => metric.maxDrawdownPercent)), 4),
    maxDrawdownUsdt: round(metrics.reduce((total, metric) => total + metric.maxDrawdownUsdt, 0), 4),
    finalEquityUsdt: round(metrics.reduce((total, metric) => total + metric.finalEquityUsdt, 0), 4),
    initialCapitalUsdt: metrics.reduce((total, metric) => total + metric.initialCapitalUsdt, 0),
    eligible: metrics.every((metric) => metric.eligible),
  };
}

function hasAtLeastOneYear(dataset: HistoricalDataset): boolean {
  const first = dataset.candles["15m"][0]?.openTime ?? 0;
  const last = dataset.candles["15m"].at(-1)?.closeTime ?? first;
  return last - first >= 365 * 86_400_000;
}

function rankOptimizerResult(result: OptimizerResult): number {
  const oos = result.outOfSample;
  return (result.eligible ? 1_000_000 : 0) + oos.netPnlUsdt - oos.maxDrawdownPercent * 100;
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
