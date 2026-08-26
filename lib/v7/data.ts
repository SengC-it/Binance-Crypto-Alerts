import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Candle, FundingRatePoint } from "@/lib/core/types";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { V7_RESEARCH_END, V7_RESEARCH_START, V7_UNIVERSE } from "@/lib/v7/registry";
import type { DerivativesMetricsPoint, V7Dataset } from "@/lib/v7/types";

const MARKET_ROOT = resolve("data/raw/v7-derivatives-flow-cache/market");
const NORMALIZED_ROOT = resolve("data/raw/v7-derivatives-flow-cache/normalized");
const ARCHIVE_ROOTS = [
  MARKET_ROOT,
  resolve("data/raw/v5-7-external-cache/archives"),
  resolve("data/raw/v5-8-fresh-cache/archives"),
  resolve("data/raw/v5-9-untouched-cache/archives"),
  resolve("data/raw/v5-9-1-untouched-cache/archives"),
];
const TIMEFRAMES: readonly V57ExternalTimeframe[] = ["15m", "1h", "4h", "funding"];
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface V7DataLoadSummary {
  requestedSymbols: number;
  loadedSymbols: number;
  symbols: Array<{
    symbol: string;
    candles1h: number;
    candles4h: number;
    candles15m: number;
    derivatives: number;
    fundingRates: number;
    firstSignalCandle: string | null;
    lastSignalCandle: string | null;
  }>;
}

export async function loadV7Datasets(symbols: readonly string[] = V7_UNIVERSE): Promise<{ datasets: V7Dataset[]; summary: V7DataLoadSummary }> {
  const datasets: V7Dataset[] = [];
  const summary: V7DataLoadSummary = { requestedSymbols: symbols.length, loadedSymbols: 0, symbols: [] };
  for (const symbol of symbols) {
    const [candles1h, candles4h, candles15m, fundingRates, derivatives] = await Promise.all([
      loadMarketSeries(symbol, "1h", V7_RESEARCH_START - 35 * DAY_MS, V7_RESEARCH_END + HOUR_MS),
      loadMarketSeries(symbol, "4h", V7_RESEARCH_START - 35 * DAY_MS, V7_RESEARCH_END + 4 * HOUR_MS),
      loadMarketSeries(symbol, "15m", V7_RESEARCH_START - HOUR_MS, V7_RESEARCH_END + 15 * 60 * 1_000),
      loadMarketSeries(symbol, "funding", V7_RESEARCH_START - 35 * DAY_MS, V7_RESEARCH_END),
      loadDerivatives(symbol),
    ]);
    const dataset = { symbol, candles1h, candles4h, candles15m, fundingRates, derivatives };
    const valid = candles1h.length > 0 && candles4h.length > 1 && candles15m.length > 1 && derivatives.length > 4;
    if (valid) datasets.push(dataset);
    summary.symbols.push({
      symbol,
      candles1h: candles1h.length,
      candles4h: candles4h.length,
      candles15m: candles15m.length,
      derivatives: derivatives.length,
      fundingRates: fundingRates.length,
      firstSignalCandle: candles1h[0] ? new Date(candles1h[0].openTime).toISOString() : null,
      lastSignalCandle: candles1h.at(-1) ? new Date(candles1h.at(-1)!.openTime).toISOString() : null,
    });
  }
  summary.loadedSymbols = datasets.length;
  return { datasets: datasets.sort((left, right) => left.symbol.localeCompare(right.symbol)), summary };
}

async function loadDerivatives(symbol: string): Promise<DerivativesMetricsPoint[]> {
  try {
    const value = JSON.parse(await readFile(resolve(NORMALIZED_ROOT, `${symbol}.json`), "utf8")) as { points?: DerivativesMetricsPoint[] };
    return (value.points ?? [])
      .filter((point) => point.timestamp <= V7_RESEARCH_END && Number.isFinite(point.openInterest) && Number.isFinite(point.takerLongShortVolumeRatio) && Number.isFinite(point.globalLongShortAccountRatio))
      .sort((left, right) => left.timestamp - right.timestamp);
  } catch {
    return [];
  }
}

async function loadMarketSeries(symbol: string, timeframe: "funding", start: number, end: number): Promise<FundingRatePoint[]>;
async function loadMarketSeries(symbol: string, timeframe: Exclude<V57ExternalTimeframe, "funding">, start: number, end: number): Promise<Candle[]>;
async function loadMarketSeries(symbol: string, timeframe: V57ExternalTimeframe, start: number, end: number): Promise<Candle[] | FundingRatePoint[]> {
  const files = new Map<string, string>();
  for (const root of ARCHIVE_ROOTS) {
    let names: string[];
    try { names = (await readdir(resolve(root, symbol, timeframe))).filter((name) => name.endsWith(".zip")).sort(); } catch { continue; }
    for (const name of names) if (!files.has(name)) files.set(name, resolve(root, symbol, timeframe, name));
  }
  const candles: Candle[] = [];
  const funding: FundingRatePoint[] = [];
  for (const path of files.values()) {
    try {
      const parsed = await readMonthlyArchive(path, timeframe);
      if (timeframe === "funding") funding.push(...(parsed.fundingRates ?? []));
      else candles.push(...(parsed.candles ?? []));
    } catch {
      // The feasibility inventory records unreadable archives as missing; no
      // synthetic bar is introduced here.
    }
  }
  if (timeframe === "funding") return dedupeFunding(funding).filter((point) => point.fundingTime >= start && point.fundingTime <= end);
  return dedupeCandles(candles).filter((candle) => candle.openTime >= start && candle.openTime <= end);
}

function dedupeCandles(candles: readonly Candle[]): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const candle of candles) if (!byOpen.has(candle.openTime)) byOpen.set(candle.openTime, candle);
  return [...byOpen.values()].sort((left, right) => left.openTime - right.openTime);
}

function dedupeFunding(points: readonly FundingRatePoint[]): FundingRatePoint[] {
  const byTime = new Map<number, FundingRatePoint>();
  for (const point of points) if (!byTime.has(point.fundingTime)) byTime.set(point.fundingTime, point);
  return [...byTime.values()].sort((left, right) => left.fundingTime - right.fundingTime);
}
