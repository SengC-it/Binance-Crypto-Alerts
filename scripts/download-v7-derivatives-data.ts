import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { externalArchiveUrl, monthKeys, parseMonthlyArchive, readMonthlyArchive, readZipEntries, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import {
  V7_RESEARCH_END,
  V7_RESEARCH_START,
  V7_UNIVERSE,
} from "@/lib/v7/registry";
import type { Candle } from "@/lib/core/types";
import type { DerivativesMetricsPoint } from "@/lib/v7/types";

const CACHE_ROOT = resolve("data/raw/v7-derivatives-flow-cache");
const METRICS_ROOT = resolve(CACHE_ROOT, "metrics");
const MARKET_ROOT = resolve(CACHE_ROOT, "market");
const NORMALIZED_ROOT = resolve(CACHE_ROOT, "normalized");
const INVENTORY_PATH = resolve("reports/v7-derivatives-data-inventory.json");
const FEASIBILITY_PATH = resolve("reports/v7-data-feasibility.json");
const HOUR_MS = 60 * 60 * 1_000;
const FIVE_MINUTE_MS = 5 * 60 * 1_000;
const REQUIRED_METRIC_FIELDS = [
  "sum_open_interest",
  "sum_taker_long_short_vol_ratio",
  "count_long_short_ratio",
] as const;
const OHLCV_ROOTS = [
  MARKET_ROOT,
  resolve("data/raw/v5-7-external-cache/archives"),
  resolve("data/raw/v5-8-fresh-cache/archives"),
  resolve("data/raw/v5-9-untouched-cache/archives"),
  resolve("data/raw/v5-9-1-untouched-cache/archives"),
];
const MARKET_TIMEFRAMES = ["15m", "1h", "4h", "funding"] as const satisfies readonly V57ExternalTimeframe[];

type ArchiveStatus = "AVAILABLE" | "CACHED" | "MISSING" | "FAILED";

interface MetricArchiveRecord {
  symbol: string;
  period: string;
  frequency: "5m";
  source: "BINANCE_DATA_VISION_PUBLIC";
  sourceUrl: string;
  cachePath: string | null;
  status: ArchiveStatus;
  rowCount: number | null;
  uniqueTimestampCount: number | null;
  duplicateTimestampCount: number | null;
  coreMissingRowCount: number | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error?: string;
}

interface OhlcvArchiveRecord {
  symbol: string;
  timeframe: V57ExternalTimeframe;
  period: string;
  source: "BINANCE_DATA_VISION_PUBLIC";
  sourceUrl: string;
  cachePath: string | null;
  status: ArchiveStatus;
  rowCount: number | null;
  sizeBytes: number | null;
  sha256: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  error?: string;
}

interface SymbolInventory {
  symbol: string;
  expectedDays: number;
  availableDays: number;
  missingDays: number;
  failedDays: number;
  expectedHours: number;
  coveredHours: number;
  coverage: number;
  missingRate: number;
  duplicateRows: number;
  coreMissingRows: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  normalizedPath: string;
  records: MetricArchiveRecord[];
}

interface NormalizedCache {
  schema: "bca-v7-derivatives-hourly-v1";
  symbol: string;
  source: "BINANCE_DATA_VISION_PUBLIC";
  rawFrequency: "5m";
  derivedFrequency: "1h";
  start: string;
  end: string;
  points: DerivativesMetricsPoint[];
  sourceFiles: string[];
}

interface DataSourceFeasibility {
  field: string;
  source: string;
  access: "PUBLIC" | "NOT_USED";
  historicalStart: string | null;
  frequency: string;
  symbolCoverage: string;
  rateLimits: string;
  archiveAvailability: string;
  missingRate: number | null;
  reproducibility: string;
  status: "AVAILABLE" | "NOT_AVAILABLE";
}

interface Inventory {
  schema: "bca-v7-derivatives-data-inventory-v1";
  generatedAt: string;
  researchPeriod: { start: string; end: string };
  source: string;
  symbols: string[];
  rawFrequency: "5m";
  derivedFrequency: "1h";
  immutableCache: string;
  records: MetricArchiveRecord[];
  marketRecords: OhlcvArchiveRecord[];
  symbolsSummary: SymbolInventory[];
  dataSources: DataSourceFeasibility[];
  dataGate: {
    status: "PASS" | "V7_DATA_INSUFFICIENT";
    historyYears: number;
    symbols: number;
    minimumDerivativesCoverage: number;
    minimumOhlcvCoverage: number;
    requirements: {
      minimumYears: number;
      minimumSymbols: number;
      minimumCoverage: number;
      requiredFeatures: string[];
    };
    reasons: string[];
  };
}

interface ParsedMetricDay {
  rowCount: number;
  uniqueTimestampCount: number;
  duplicateTimestampCount: number;
  coreMissingRowCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  hourlyPoints: DerivativesMetricsPoint[];
}

async function main(): Promise<void> {
  const shouldDownload = process.argv.includes("--download");
  await mkdir(METRICS_ROOT, { recursive: true });
  await mkdir(NORMALIZED_ROOT, { recursive: true });
  await mkdir(resolve("reports"), { recursive: true });

  const symbolsSummary: SymbolInventory[] = [];
  const allRecords: MetricArchiveRecord[] = [];
  for (const symbol of V7_UNIVERSE) {
    const summary = await downloadSymbolMetrics(symbol, shouldDownload);
    symbolsSummary.push(summary);
    allRecords.push(...summary.records);
    console.info(JSON.stringify({
      stage: "v7_symbol_metrics",
      symbol,
      download: shouldDownload,
      availableDays: summary.availableDays,
      expectedDays: summary.expectedDays,
      coverage: summary.coverage,
    }));
  }
  const marketRecords = await downloadMarketArchives([...V7_UNIVERSE], shouldDownload);
  console.info(JSON.stringify({ stage: "v7_market_archives", records: marketRecords.length, cached: marketRecords.filter((record) => record.status === "AVAILABLE" || record.status === "CACHED").length }));

  const minimumDerivativesCoverage = Math.min(...symbolsSummary.map((item) => item.coverage));
  const ohlcvCoverageBySymbol = await measureOhlcvCoverage([...V7_UNIVERSE]);
  const minimumOhlcvCoverage = Math.min(...ohlcvCoverageBySymbol.map((item) => item.coverage));
  const first = Math.min(...symbolsSummary.map((item) => Date.parse(item.firstTimestamp ?? "9999-12-31T00:00:00.000Z")));
  const last = Math.max(...symbolsSummary.map((item) => Date.parse(item.lastTimestamp ?? "1970-01-01T00:00:00.000Z")));
  const historyYears = (last - first) / (365.25 * 24 * HOUR_MS);
  const reasons: string[] = [];
  if (historyYears < 2) reasons.push(`derivatives history is ${historyYears.toFixed(2)} years, below 2 years`);
  if (V7_UNIVERSE.length < 20) reasons.push(`only ${V7_UNIVERSE.length} symbols are registered, below 20`);
  if (minimumDerivativesCoverage < 0.9) reasons.push(`minimum derivatives hourly coverage is ${(minimumDerivativesCoverage * 100).toFixed(2)}%`);
  if (minimumOhlcvCoverage < 0.9) reasons.push(`minimum OHLCV hourly coverage is ${(minimumOhlcvCoverage * 100).toFixed(2)}%`);
  const status = reasons.length === 0 ? "PASS" : "V7_DATA_INSUFFICIENT";
  const dataSources = buildDataSources(symbolsSummary, ohlcvCoverageBySymbol);
  const inventory: Inventory = {
    schema: "bca-v7-derivatives-data-inventory-v1",
    generatedAt: new Date().toISOString(),
    researchPeriod: { start: new Date(V7_RESEARCH_START).toISOString(), end: new Date(V7_RESEARCH_END).toISOString() },
    source: "Binance Data Vision public USDⓈ-M Futures daily metrics archive",
    symbols: [...V7_UNIVERSE],
    rawFrequency: "5m",
    derivedFrequency: "1h",
    immutableCache: "Each raw daily metrics ZIP and monthly market archive is stored once under data/raw/v7-derivatives-flow-cache and is never overwritten; normalized hourly points are derived only from the metrics bytes.",
    records: allRecords,
    marketRecords,
    symbolsSummary,
    dataSources,
    dataGate: {
      status,
      historyYears,
      symbols: V7_UNIVERSE.length,
      minimumDerivativesCoverage,
      minimumOhlcvCoverage,
      requirements: {
        minimumYears: 2,
        minimumSymbols: 20,
        minimumCoverage: 0.9,
        requiredFeatures: ["OHLCV", "Open Interest", "Taker buy/sell flow"],
      },
      reasons,
    },
  };
  await writeFile(INVENTORY_PATH, `${JSON.stringify(compactInventory(inventory))}\n`, "utf8");
  await writeFile(FEASIBILITY_PATH, `${JSON.stringify({
    schema: "bca-v7-data-feasibility-v1",
    generatedAt: inventory.generatedAt,
    status: status === "PASS" ? "PASS" : "V7_DATA_INSUFFICIENT",
    requirements: inventory.dataGate.requirements,
    historyYears,
    symbols: V7_UNIVERSE.length,
    minimumDerivativesCoverage,
    minimumOhlcvCoverage,
    sources: dataSources,
    reasons,
    methodology: [
      "Derivatives metrics are read from public Binance Data Vision daily ZIPs; no private endpoint, account data or API secret is used.",
      "Raw 5m observations are deduplicated by source timestamp and reduced to the last valid observation in each UTC hour without forward-looking values.",
      "Coverage is the fraction of expected UTC hourly buckets with all required OI, taker-flow and global long/short fields present.",
      "OHLCV is read from the V7 immutable monthly market cache; pre-existing frozen public archives are copied byte-for-byte into that cache when available.",
      "If the hard gate is not PASS, no V7 strategy search is permitted.",
    ],
  }, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v7_data_feasibility", status, historyYears, symbols: V7_UNIVERSE.length, minimumDerivativesCoverage, minimumOhlcvCoverage, reasons }));
  if (status !== "PASS") process.exitCode = 2;
}

function compactInventory(inventory: Inventory): Record<string, unknown> {
  return {
    ...inventory,
    records: inventory.records.map((record) => ({
      source: record.source,
      symbol: record.symbol,
      period: record.period,
      frequency: record.frequency,
      sourceUrl: record.sourceUrl,
      cachePath: record.cachePath,
      status: record.status,
      rowCount: record.rowCount,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      uniqueTimestampCount: record.uniqueTimestampCount,
      duplicateTimestampCount: record.duplicateTimestampCount,
      coreMissingRowCount: record.coreMissingRowCount,
    })),
    marketRecords: inventory.marketRecords.map((record) => ({
      source: record.source,
      symbol: record.symbol,
      timeframe: record.timeframe,
      period: record.period,
      sourceUrl: record.sourceUrl,
      cachePath: record.cachePath,
      status: record.status,
      rowCount: record.rowCount,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
    })),
  };
}

async function downloadSymbolMetrics(symbol: string, shouldDownload: boolean): Promise<SymbolInventory> {
  const periods = dateKeys(V7_RESEARCH_START, V7_RESEARCH_END);
  const pending = await mapWithConcurrency(periods, 16, (period) => ensureMetricDay(symbol, period, shouldDownload));
  const pointByHour = new Map<number, DerivativesMetricsPoint>();
  for (const item of pending) {
    for (const point of item.hourlyPoints) {
      const existing = pointByHour.get(point.timestamp);
      if (!existing || existing.sourceTimestamp <= point.sourceTimestamp) pointByHour.set(point.timestamp, point);
    }
  }
  const points = [...pointByHour.values()].sort((left, right) => left.timestamp - right.timestamp);
  const normalizedPath = resolve(NORMALIZED_ROOT, `${symbol}.json`);
  const normalized: NormalizedCache = {
    schema: "bca-v7-derivatives-hourly-v1",
    symbol,
    source: "BINANCE_DATA_VISION_PUBLIC",
    rawFrequency: "5m",
    derivedFrequency: "1h",
    start: new Date(V7_RESEARCH_START).toISOString(),
    end: new Date(V7_RESEARCH_END).toISOString(),
    points,
    sourceFiles: pending.filter((item) => item.record.cachePath).map((item) => item.record.cachePath as string),
  };
  await writeImmutableJson(normalizedPath, normalized);
  const expectedHours = expectedBucketCount(V7_RESEARCH_START, V7_RESEARCH_END, HOUR_MS);
  const availableDays = pending.filter((item) => item.record.status === "AVAILABLE" || item.record.status === "CACHED").length;
  const missingDays = pending.filter((item) => item.record.status === "MISSING").length;
  const failedDays = pending.filter((item) => item.record.status === "FAILED").length;
  return {
    symbol,
    expectedDays: periods.length,
    availableDays,
    missingDays,
    failedDays,
    expectedHours,
    coveredHours: points.length,
    coverage: points.length / expectedHours,
    missingRate: 1 - points.length / expectedHours,
    duplicateRows: pending.reduce((sum, item) => sum + (item.record.duplicateTimestampCount ?? 0), 0),
    coreMissingRows: pending.reduce((sum, item) => sum + (item.record.coreMissingRowCount ?? 0), 0),
    firstTimestamp: points.length > 0 ? new Date(points[0].timestamp).toISOString() : null,
    lastTimestamp: points.length > 0 ? new Date(points.at(-1)?.timestamp ?? 0).toISOString() : null,
    normalizedPath: relativePath(normalizedPath),
    records: pending.map((item) => item.record),
  };
}

async function ensureMetricDay(symbol: string, period: string, shouldDownload: boolean): Promise<{ record: MetricArchiveRecord; hourlyPoints: DerivativesMetricsPoint[] }> {
  const sourceUrl = `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${period}.zip`;
  const relative = `data/raw/v7-derivatives-flow-cache/metrics/${symbol}/${period}.zip`;
  const cachePath = resolve(relative);
  try {
    let buffer: Buffer;
    let status: ArchiveStatus;
    try {
      buffer = await readFile(cachePath);
      status = "CACHED";
    } catch {
      if (!shouldDownload) throw new Error("archive is not cached; rerun with --download");
      const response = await fetchWithRetry(sourceUrl);
      if (response.status === 404) {
        return { record: emptyRecord(symbol, period, sourceUrl, "MISSING", "HTTP 404"), hourlyPoints: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(resolve(METRICS_ROOT, symbol), { recursive: true });
      try {
        await stat(cachePath);
        const existing = await readFile(cachePath);
        if (!existing.equals(buffer)) throw new Error("immutable cache collision: existing bytes differ");
      } catch (error) {
        if (error instanceof Error && error.message.includes("immutable cache collision")) throw error;
        await writeFile(cachePath, buffer);
      }
      status = "AVAILABLE";
    }
    const parsed = parseMetricArchive(buffer, symbol);
    const record: MetricArchiveRecord = {
      symbol,
      period,
      frequency: "5m",
      source: "BINANCE_DATA_VISION_PUBLIC",
      sourceUrl,
      cachePath: relative,
      status,
      rowCount: parsed.rowCount,
      uniqueTimestampCount: parsed.uniqueTimestampCount,
      duplicateTimestampCount: parsed.duplicateTimestampCount,
      coreMissingRowCount: parsed.coreMissingRowCount,
      firstTimestamp: parsed.firstTimestamp === null ? null : new Date(parsed.firstTimestamp).toISOString(),
      lastTimestamp: parsed.lastTimestamp === null ? null : new Date(parsed.lastTimestamp).toISOString(),
      sizeBytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
    return { record, hourlyPoints: parsed.hourlyPoints };
  } catch (error) {
    return { record: emptyRecord(symbol, period, sourceUrl, "FAILED", error instanceof Error ? error.message : String(error)), hourlyPoints: [] };
  }
}

async function downloadMarketArchives(symbols: readonly string[], shouldDownload: boolean): Promise<OhlcvArchiveRecord[]> {
  const jobs = symbols.flatMap((symbol) => MARKET_TIMEFRAMES.flatMap((timeframe) => monthKeys(V7_RESEARCH_START, V7_RESEARCH_END).map((period) => ({ symbol, timeframe, period }))));
  return mapWithConcurrency(jobs, 16, (job) => ensureMarketArchive(job.symbol, job.timeframe, job.period, shouldDownload));
}

async function ensureMarketArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string, shouldDownload: boolean): Promise<OhlcvArchiveRecord> {
  const sourceUrl = externalArchiveUrl(symbol, timeframe, period);
  const relative = `data/raw/v7-derivatives-flow-cache/market/${symbol}/${timeframe}/${period}.zip`;
  const cachePath = resolve(relative);
  try {
    let buffer: Buffer;
    let recordPath: string | null = relative;
    let status: ArchiveStatus = "CACHED";
    try {
      buffer = await readFile(cachePath);
    } catch {
      const existingPath = await findExistingMarketArchive(symbol, timeframe, period);
      if (existingPath) {
        buffer = await readFile(existingPath);
        recordPath = shouldDownload ? relative : relativePath(existingPath);
        if (shouldDownload) await writeImmutableBuffer(cachePath, buffer);
        status = "CACHED";
      } else {
        if (!shouldDownload) throw new Error("archive is not cached; rerun with --download");
        const response = await fetchWithRetry(sourceUrl);
        if (response.status === 404) return emptyOhlcvRecord(symbol, timeframe, period, sourceUrl, "MISSING", "HTTP 404");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        buffer = Buffer.from(await response.arrayBuffer());
        await writeImmutableBuffer(cachePath, buffer);
        status = "AVAILABLE";
      }
    }
    const parsed = await readMonthlyArchiveBuffer(buffer, timeframe);
    const timestamps = timeframe === "funding"
      ? (parsed.fundingRates ?? []).map((point) => point.fundingTime)
      : (parsed.candles ?? []).map((candle) => candle.openTime);
    return {
      symbol,
      timeframe,
      period,
      source: "BINANCE_DATA_VISION_PUBLIC",
      sourceUrl,
      cachePath: recordPath,
      status,
      rowCount: parsed.rowCount,
      sizeBytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      firstTimestamp: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null,
      lastTimestamp: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null,
    };
  } catch (error) {
    return emptyOhlcvRecord(symbol, timeframe, period, sourceUrl, "FAILED", error instanceof Error ? error.message : String(error));
  }
}

async function readMonthlyArchiveBuffer(buffer: Buffer, timeframe: V57ExternalTimeframe): Promise<{ candles?: Candle[]; fundingRates?: Array<{ fundingTime: number; fundingRate: number }>; rowCount: number }> {
  return parseMonthlyArchive(buffer, timeframe);
}

function emptyOhlcvRecord(symbol: string, timeframe: V57ExternalTimeframe, period: string, sourceUrl: string, status: "MISSING" | "FAILED", error: string): OhlcvArchiveRecord {
  return { symbol, timeframe, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: null, status, rowCount: null, sizeBytes: null, sha256: null, firstTimestamp: null, lastTimestamp: null, error };
}

async function findExistingMarketArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string): Promise<string | null> {
  for (const root of OHLCV_ROOTS.slice(1)) {
    const candidate = resolve(root, symbol, timeframe, `${period}.zip`);
    try { await stat(candidate); return candidate; } catch { /* try the next immutable source root */ }
  }
  return null;
}

async function writeImmutableBuffer(path: string, buffer: Buffer): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(buffer)) throw new Error(`immutable market cache collision: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("immutable market cache collision")) throw error;
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, buffer);
  }
}

function emptyRecord(symbol: string, period: string, sourceUrl: string, status: "MISSING" | "FAILED", error: string): MetricArchiveRecord {
  return { symbol, period, frequency: "5m", source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: null, status, rowCount: null, uniqueTimestampCount: null, duplicateTimestampCount: null, coreMissingRowCount: null, firstTimestamp: null, lastTimestamp: null, sizeBytes: null, sha256: null, error };
}

function parseMetricArchive(buffer: Buffer, symbol: string): ParsedMetricDay {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("metrics ZIP has no data entry");
  const lines = entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("metrics CSV has no data rows");
  const header = splitCsvLine(lines[0]);
  const index = new Map(header.map((name, position) => [name.trim(), position]));
  const timeIndex = index.get("create_time");
  const symbolIndex = index.get("symbol");
  if (timeIndex === undefined || symbolIndex === undefined) throw new Error("metrics CSV schema missing create_time or symbol");
  const fieldIndexes = REQUIRED_METRIC_FIELDS.map((field) => {
    const position = index.get(field);
    if (position === undefined) throw new Error(`metrics CSV schema missing ${field}`);
    return position;
  });
  const seen = new Set<number>();
  const byHour = new Map<number, DerivativesMetricsPoint>();
  let duplicateTimestampCount = 0;
  let coreMissingRowCount = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let rowCount = 0;
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields[symbolIndex] !== symbol) continue;
    rowCount += 1;
    const timestamp = parseTimestamp(fields[timeIndex]);
    if (!Number.isFinite(timestamp)) {
      coreMissingRowCount += 1;
      continue;
    }
    if (seen.has(timestamp)) duplicateTimestampCount += 1;
    seen.add(timestamp);
    firstTimestamp = firstTimestamp === null ? timestamp : Math.min(firstTimestamp, timestamp);
    lastTimestamp = lastTimestamp === null ? timestamp : Math.max(lastTimestamp, timestamp);
    const values = fieldIndexes.map((position) => Number(fields[position]));
    if (!values.every(Number.isFinite)) {
      coreMissingRowCount += 1;
      continue;
    }
    const [openInterest, takerLongShortVolumeRatio, globalLongShortAccountRatio] = [values[0], values[1], values[2]];
    const openInterestValue = Number(fields[index.get("sum_open_interest_value") ?? -1]);
    if (!Number.isFinite(openInterestValue)) {
      coreMissingRowCount += 1;
      continue;
    }
    const point: DerivativesMetricsPoint = {
      timestamp: Math.floor(timestamp / HOUR_MS) * HOUR_MS,
      sourceTimestamp: timestamp,
      openInterest,
      openInterestValue,
      takerLongShortVolumeRatio,
      globalLongShortAccountRatio,
    };
    const existing = byHour.get(point.timestamp);
    if (!existing || existing.sourceTimestamp <= point.sourceTimestamp) byHour.set(point.timestamp, point);
  }
  return { rowCount, uniqueTimestampCount: seen.size, duplicateTimestampCount, coreMissingRowCount, firstTimestamp, lastTimestamp, hourlyPoints: [...byHour.values()].sort((left, right) => left.timestamp - right.timestamp) };
}

async function measureOhlcvCoverage(symbols: readonly string[]): Promise<Array<{ symbol: string; expectedHours: number; coveredHours: number; coverage: number }>> {
  const expectedHours = expectedBucketCount(V7_RESEARCH_START, V7_RESEARCH_END, HOUR_MS);
  const output: Array<{ symbol: string; expectedHours: number; coveredHours: number; coverage: number }> = [];
  for (const symbol of symbols) {
    const buckets = new Set<number>();
    for (const root of OHLCV_ROOTS) {
      let files: string[];
      try { files = (await readdir(resolve(root, symbol, "1h"))).filter((file) => file.endsWith(".zip")); } catch { continue; }
      for (const file of files) {
        try {
          const parsed = await readMonthlyArchive(resolve(root, symbol, "1h", file), "1h");
          for (const candle of parsed.candles ?? []) {
            if (candle.openTime >= V7_RESEARCH_START && candle.openTime <= V7_RESEARCH_END) buckets.add(candle.openTime);
          }
        } catch {
          // A corrupt/unreadable price archive contributes no coverage.
        }
      }
    }
    output.push({ symbol, expectedHours, coveredHours: buckets.size, coverage: buckets.size / expectedHours });
  }
  return output;
}

function buildDataSources(symbols: readonly SymbolInventory[], ohlcv: ReadonlyArray<{ symbol: string; coverage: number }>): DataSourceFeasibility[] {
  const minDerivatives = Math.min(...symbols.map((item) => item.coverage));
  const minOhlcv = Math.min(...ohlcv.map((item) => item.coverage));
  return [
    { field: "OHLCV", source: "Binance Data Vision public USDⓈ-M Futures monthly kline archives", access: "PUBLIC", historicalStart: new Date(V7_RESEARCH_START).toISOString(), frequency: "1h research bars; 4h context; 15m execution bars", symbolCoverage: `${ohlcv.filter((item) => item.coverage >= 0.9).length}/${ohlcv.length} symbols at >=90%`, rateLimits: "Public object archive; downloader caps concurrency at 16", archiveAvailability: "V7 immutable monthly market ZIP cache plus byte-identical prior archives", missingRate: 1 - minOhlcv, reproducibility: "Exact URL, symbol, timeframe, period, row count, byte size and SHA-256 recorded per file", status: minOhlcv >= 0.9 ? "AVAILABLE" : "NOT_AVAILABLE" },
    { field: "Open Interest", source: "Binance Data Vision data/futures/um/daily/metrics/{SYMBOL}/{SYMBOL}-metrics-YYYY-MM-DD.zip", access: "PUBLIC", historicalStart: "2020-09-01 BTCUSDT; 2021-12-01 for the other registered symbols", frequency: "5m raw, reduced to 1h last-observation", symbolCoverage: `${symbols.length}/${symbols.length} registered symbols`, rateLimits: "Public object archive; no REST weight; downloader caps concurrency at 16", archiveAvailability: "Daily ZIP plus direct URL for every date in the fixed research window", missingRate: 1 - minDerivatives, reproducibility: "Exact URL, local immutable ZIP, row count, byte size and SHA-256 recorded per file", status: minDerivatives >= 0.9 ? "AVAILABLE" : "NOT_AVAILABLE" },
    { field: "Taker buy/sell flow", source: "Binance Data Vision metrics field sum_taker_long_short_vol_ratio", access: "PUBLIC", historicalStart: "2020-09-01 BTCUSDT; 2021-12-01 for the other registered symbols", frequency: "5m raw, reduced to 1h last-observation", symbolCoverage: `${symbols.length}/${symbols.length} registered symbols`, rateLimits: "Same immutable public archive as OI", archiveAvailability: "Present in the same daily metrics CSV", missingRate: 1 - minDerivatives, reproducibility: "Field name and source archive bytes are recorded; no proxy", status: minDerivatives >= 0.9 ? "AVAILABLE" : "NOT_AVAILABLE" },
    { field: "Long/short positioning ratio", source: "Binance Data Vision metrics field count_long_short_ratio", access: "PUBLIC", historicalStart: "2020-09-01 BTCUSDT; 2021-12-01 for the other registered symbols", frequency: "5m raw, reduced to 1h last-observation", symbolCoverage: `${symbols.length}/${symbols.length} registered symbols`, rateLimits: "Same immutable public archive as OI", archiveAvailability: "Present in the same daily metrics CSV", missingRate: 1 - minDerivatives, reproducibility: "Field name and source archive bytes are recorded; no proxy", status: minDerivatives >= 0.9 ? "AVAILABLE" : "NOT_AVAILABLE" },
    { field: "Funding / basis", source: "Binance Data Vision public USDⓈ-M Futures fundingRate monthly archives", access: "PUBLIC", historicalStart: new Date(V7_RESEARCH_START).toISOString(), frequency: "Funding event interval, normally 8h", symbolCoverage: "20/20 registered symbols; optional cost/context feature", rateLimits: "Public object archive; downloader caps concurrency at 16", archiveAvailability: "V7 immutable monthly market ZIP cache", missingRate: null, reproducibility: "Exact URL, symbol, timeframe, period, row count, byte size and SHA-256 recorded per file; no imputation", status: "AVAILABLE" },
    { field: "Liquidation flow", source: "No complete reliable historical liquidation archive is present in the frozen workspace", access: "NOT_USED", historicalStart: null, frequency: "N/A", symbolCoverage: "0", rateLimits: "N/A", archiveAvailability: "Not available; Family D is removed", missingRate: null, reproducibility: "No proxy is substituted", status: "NOT_AVAILABLE" },
    { field: "Order-book imbalance", source: "No complete reliable historical order-book archive is present in the frozen workspace", access: "NOT_USED", historicalStart: null, frequency: "N/A", symbolCoverage: "0", rateLimits: "N/A", archiveAvailability: "Not available; not used", missingRate: null, reproducibility: "No proxy is substituted", status: "NOT_AVAILABLE" },
  ];
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) throw new Error(`immutable normalized cache collision: ${path}`);
    return;
  } catch (error) {
    if (error instanceof Error && error.message.includes("immutable normalized cache collision")) throw error;
    await writeFile(path, bytes, "utf8");
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function dateKeys(start: number, end: number): string[] {
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setUTCHours(0, 0, 0, 0);
  const periods: string[] = [];
  while (cursor <= last) {
    periods.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return periods;
}

function expectedBucketCount(start: number, end: number, interval: number): number {
  return Math.floor((end - start) / interval) + 1;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = Date.parse(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { fields.push(current); current = ""; }
    else current += character;
  }
  fields.push(current);
  return fields;
}

function relativePath(path: string): string {
  return path.replace(`${resolve(".")}\\`, "").replaceAll("\\", "/");
}

void main();
