import type { HistoricalDataset } from "./types";

export const CURRENT_SURVIVOR_UNIVERSE_PROXY = "CURRENT_SURVIVOR_UNIVERSE_PROXY";

export interface PointInTimeUniverseOptions {
  targetSize: number;
  lookbackCandles?: number;
  minimumHistoryCandles?: number;
}

export interface PointInTimeUniverse {
  status: "PROXY";
  methodology: typeof CURRENT_SURVIVOR_UNIVERSE_PROXY;
  targetSize: number;
  lookbackCandles: number;
  minimumHistoryCandles: number;
  universeId: string;
  membershipAt(dataset: HistoricalDataset, sourceTimestamp: number): boolean;
  symbolsAt(sourceTimestamp: number): string[];
}

interface PreparedDataset {
  dataset: HistoricalDataset;
  closeTimes: number[];
  prefixQuoteVolume: number[];
}

export function createPointInTimeUniverse(
  datasets: HistoricalDataset[],
  options: PointInTimeUniverseOptions,
): PointInTimeUniverse {
  const targetSize = Math.max(2, Math.floor(options.targetSize));
  const lookbackCandles = Math.max(1, Math.floor(options.lookbackCandles ?? 30 * 24 * 4));
  const minimumHistoryCandles = Math.max(1, Math.floor(options.minimumHistoryCandles ?? 200));
  const prepared = datasets.map(prepareDataset);
  const preparedBySymbol = new Map(prepared.map((item) => [item.dataset.symbol, item]));
  const symbolsCache = new Map<number, string[]>();
  const universeId = [
    CURRENT_SURVIVOR_UNIVERSE_PROXY,
    String(targetSize),
    datasets.map((dataset) => dataset.symbol).sort().join(","),
  ].join(":");

  function symbolsAt(sourceTimestamp: number): string[] {
    const cacheKey = Math.floor(sourceTimestamp / (15 * 60 * 1000));
    const cached = symbolsCache.get(cacheKey);
    if (cached) return cached;
    const ranked = prepared
      .map((item) => {
        const index = lastIndexAtOrBefore(item.closeTimes, sourceTimestamp);
        if (index < minimumHistoryCandles - 1) return null;
        const start = Math.max(0, index - lookbackCandles + 1);
        const count = index - start + 1;
        const quoteVolume = (item.prefixQuoteVolume[index + 1] - item.prefixQuoteVolume[start]) / Math.max(1, count);
        return { symbol: item.dataset.symbol, quoteVolume };
      })
      .filter((item): item is { symbol: string; quoteVolume: number } => Boolean(item))
      .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
    const anchors = ranked.filter((item) => item.symbol === "BTCUSDT" || item.symbol === "ETHUSDT");
    const selected = [...anchors, ...ranked.filter((item) => item.symbol !== "BTCUSDT" && item.symbol !== "ETHUSDT")]
      .slice(0, Math.min(targetSize, ranked.length))
      .map((item) => item.symbol);
    symbolsCache.set(cacheKey, selected);
    return selected;
  }

  return {
    status: "PROXY",
    methodology: CURRENT_SURVIVOR_UNIVERSE_PROXY,
    targetSize,
    lookbackCandles,
    minimumHistoryCandles,
    universeId,
    membershipAt(dataset, sourceTimestamp) {
      const preparedDataset = preparedBySymbol.get(dataset.symbol);
      if (!preparedDataset) return false;
      return symbolsAt(sourceTimestamp).includes(preparedDataset.dataset.symbol);
    },
    symbolsAt,
  };
}

function prepareDataset(dataset: HistoricalDataset): PreparedDataset {
  const candles = dataset.candles["15m"];
  const prefixQuoteVolume = [0];
  for (const candle of candles) {
    prefixQuoteVolume.push(prefixQuoteVolume.at(-1)! + Math.max(0, candle.volume * candle.close));
  }
  return {
    dataset,
    closeTimes: candles.map((candle) => candle.closeTime),
    prefixQuoteVolume,
  };
}

function lastIndexAtOrBefore(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}
