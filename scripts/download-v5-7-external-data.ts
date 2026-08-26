import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  externalArchiveUrl,
  monthKeys,
  parseMonthlyArchive,
  V57_EXTERNAL_TIMEFRAMES,
  type V57ExternalTimeframe,
} from "@/lib/v5-7/external-data";
import { V57_EXTERNAL_END, V57_EXTERNAL_START } from "@/lib/v5-7/research";

const CACHE_DIR = resolve("data/raw/v5-7-external-cache");
const ARCHIVE_DIR = resolve(CACHE_DIR, "archives");
const INVENTORY_PATH = resolve("reports/v5-7-external-data-inventory.json");
const UNIVERSE_PATH = resolve("data/validation-universe-50.json");
const PIT_PATH = resolve("data/pit-universe/binance-um-monthly-15m-index.json");

type ArchiveStatus = "AVAILABLE" | "CACHED" | "ARCHIVE_MISSING" | "DOWNLOAD_FAILED";
type SymbolClassification = "NOT_YET_LISTED" | "DELISTED" | "ARCHIVE_MISSING" | "DOWNLOAD_FAILED" | "AVAILABLE";

interface ArchiveRecord {
  symbol: string;
  timeframe: V57ExternalTimeframe;
  period: string;
  periodStart: string;
  periodEnd: string;
  sourceUrl: string;
  cachePath: string | null;
  status: ArchiveStatus;
  classification: SymbolClassification;
  sizeBytes: number | null;
  sha256: string | null;
  rowCount: number | null;
  error?: string;
}

interface SymbolRecord {
  symbol: string;
  pitEligible: boolean;
  classification: SymbolClassification;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  expectedPeriods: string[];
  availableArchiveCount: number;
  expectedArchiveCount: number;
  records: ArchiveRecord[];
}

interface PitSymbol {
  symbol: string;
  observedMonths?: string[];
  observedFirstMonth?: string;
  observedLastMonth?: string;
  tradableStart?: string | null;
  tradableEnd?: string | null;
}

interface Inventory {
  schema: string;
  status: "AVAILABLE" | "DATA_INCOMPLETE";
  queryTimestamp: string;
  manifestId: string;
  period: { start: string; end: string };
  source: string;
  timeframes: readonly V57ExternalTimeframe[];
  requestedSymbols: number;
  pitEligibleSymbols: string[];
  availableSymbols: string[];
  coveragePercent: number;
  coverageRule: string;
  symbols: SymbolRecord[];
  archives: ArchiveRecord[];
  methodology: string[];
}

async function main(): Promise<void> {
  const shouldDownload = process.argv.includes("--download");
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const universe = JSON.parse(await readFile(UNIVERSE_PATH, "utf8")) as { symbols: string[] };
  const pit = JSON.parse(await readFile(PIT_PATH, "utf8")) as { evidenceSymbols: PitSymbol[] };
  const pitBySymbol = new Map(pit.evidenceSymbols.map((item) => [item.symbol, item]));
  const symbolRecords: SymbolRecord[] = [];
  const pending: Array<{ symbol: string; period: string; timeframe: V57ExternalTimeframe; pitSymbol: PitSymbol | undefined }> = [];
  for (const symbol of universe.symbols) {
    const pitSymbol = pitBySymbol.get(symbol);
    const effective = effectivePeriods(pitSymbol);
    if (!effective.pitEligible) {
      symbolRecords.push({
        symbol,
        pitEligible: false,
        classification: classifyIneligible(pitSymbol),
        effectiveStart: null,
        effectiveEnd: null,
        expectedPeriods: [],
        availableArchiveCount: 0,
        expectedArchiveCount: 0,
        records: [],
      });
      continue;
    }
    for (const period of effective.periods) {
      for (const timeframe of V57_EXTERNAL_TIMEFRAMES) {
        pending.push({ symbol, period, timeframe, pitSymbol });
      }
    }
  }
  const pendingRecords = await mapWithConcurrency(pending, 8, (item) => ensureArchive(item.symbol, item.timeframe, item.period, shouldDownload, item.pitSymbol));
  for (const symbol of universe.symbols) {
    const pitSymbol = pitBySymbol.get(symbol);
    const effective = effectivePeriods(pitSymbol);
    if (!effective.pitEligible) continue;
    const records = pendingRecords.filter((record) => record.symbol === symbol);
    const expectedArchiveCount = records.length;
    const availableArchiveCount = records.filter((record) => record.status === "AVAILABLE" || record.status === "CACHED").length;
    const failed = records.some((record) => record.status === "DOWNLOAD_FAILED");
    const missing = records.some((record) => record.status === "ARCHIVE_MISSING");
    symbolRecords.push({
      symbol,
      pitEligible: true,
      classification: failed ? "DOWNLOAD_FAILED" : missing ? "ARCHIVE_MISSING" : availableArchiveCount === expectedArchiveCount ? "AVAILABLE" : "DOWNLOAD_FAILED",
      effectiveStart: effective.start,
      effectiveEnd: effective.end,
      expectedPeriods: effective.periods,
      availableArchiveCount,
      expectedArchiveCount,
      records,
    });
  }
  const pitEligibleSymbols = symbolRecords.filter((item) => item.pitEligible).map((item) => item.symbol);
  const availableSymbols = symbolRecords.filter((item) => item.pitEligible && item.classification === "AVAILABLE").map((item) => item.symbol);
  const inventory: Inventory = {
    schema: "bca-v5-7-external-data-inventory-v1",
    status: availableSymbols.length / Math.max(1, pitEligibleSymbols.length) >= 0.9 ? "AVAILABLE" : "DATA_INCOMPLETE",
    queryTimestamp: new Date().toISOString(),
    manifestId: "v57-second-edge-2021-01-01-2023-07-31",
    period: { start: new Date(V57_EXTERNAL_START).toISOString(), end: new Date(V57_EXTERNAL_END).toISOString() },
    source: "Binance Data Vision USDT-M Futures monthly archives",
    timeframes: V57_EXTERNAL_TIMEFRAMES,
    requestedSymbols: universe.symbols.length,
    pitEligibleSymbols,
    availableSymbols,
    coveragePercent: availableSymbols.length / Math.max(1, pitEligibleSymbols.length) * 100,
    coverageRule: "External validation is allowed only when every required timeframe is available for >=90% of PIT-eligible symbols; otherwise DATA_INCOMPLETE and no profitability conclusion.",
    symbols: symbolRecords,
    archives: symbolRecords.flatMap((item) => item.records),
    methodology: [
      "PIT membership is derived from the frozen monthly manifest; first and last observed months are excluded through its effective tradableStart/tradableEnd fields.",
      "NOT_YET_LISTED and DELISTED symbols are not counted as missing evidence.",
      "Each archive is cached immutably under data/raw/v5-7-external-cache and recorded with source URL, symbol, timeframe, period, byte size, and SHA-256.",
      "No archive result is used to change the frozen registry or Primary edge.",
    ],
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_7_external_data_inventory", download: shouldDownload, status: inventory.status, pitEligible: pitEligibleSymbols.length, available: availableSymbols.length, coveragePercent: inventory.coveragePercent }));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
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

interface EffectivePeriods {
  pitEligible: boolean;
  start: string | null;
  end: string | null;
  periods: string[];
}

function effectivePeriods(item: PitSymbol | undefined): EffectivePeriods {
  if (!item?.tradableStart || !item.tradableEnd) return { pitEligible: false, start: null, end: null, periods: [] };
  const start = Math.max(V57_EXTERNAL_START, Date.parse(item.tradableStart));
  const end = Math.min(V57_EXTERNAL_END, Date.parse(item.tradableEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { pitEligible: false, start: null, end: null, periods: [] };
  return { pitEligible: true, start: new Date(start).toISOString(), end: new Date(end).toISOString(), periods: monthKeys(start, end) };
}

function classifyIneligible(item: PitSymbol | undefined): SymbolClassification {
  if (!item?.observedFirstMonth) return "ARCHIVE_MISSING";
  if (item.tradableStart && Date.parse(item.tradableStart) > V57_EXTERNAL_END) return "NOT_YET_LISTED";
  if (item.tradableEnd && Date.parse(item.tradableEnd) < V57_EXTERNAL_START) return "DELISTED";
  const first = Date.parse(`${item.observedFirstMonth}-01T00:00:00.000Z`);
  const last = Date.parse(`${item.observedLastMonth ?? item.observedFirstMonth}-01T00:00:00.000Z`);
  if (first > V57_EXTERNAL_END) return "NOT_YET_LISTED";
  if (last < V57_EXTERNAL_START) return "DELISTED";
  return "ARCHIVE_MISSING";
}

async function ensureArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string, shouldDownload: boolean, pitSymbol: PitSymbol | undefined): Promise<ArchiveRecord> {
  const sourceUrl = externalArchiveUrl(symbol, timeframe, period);
  const relativePath = `data/raw/v5-7-external-cache/archives/${symbol}/${timeframe}/${period}.zip`;
  const cachePath = resolve(relativePath);
  const observed = new Set(pitSymbol?.observedMonths ?? []);
  if (!observed.has(period)) {
    return { symbol, timeframe, period, periodStart: `${period}-01T00:00:00.000Z`, periodEnd: new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)) , 0, 23, 59, 59, 999)).toISOString(), sourceUrl, cachePath: null, status: "ARCHIVE_MISSING", classification: "ARCHIVE_MISSING", sizeBytes: null, sha256: null, rowCount: null, error: "PIT manifest has no observed archive for this effective month" };
  }
  try {
    let buffer: Buffer;
    let status: ArchiveStatus;
    try {
      buffer = await readFile(cachePath);
      status = "CACHED";
    } catch {
      if (!shouldDownload) throw new Error("not cached; downloader was run without --download");
      const response = await fetchWithRetry(sourceUrl);
      if (response.status === 404) return { symbol, timeframe, period, periodStart: `${period}-01T00:00:00.000Z`, periodEnd: monthEnd(period), sourceUrl, cachePath: null, status: "ARCHIVE_MISSING", classification: "ARCHIVE_MISSING", sizeBytes: null, sha256: null, rowCount: null, error: "HTTP 404" };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(resolve(ARCHIVE_DIR, symbol, timeframe), { recursive: true });
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
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const parsed = parseMonthlyArchive(buffer, timeframe);
    if (parsed.rowCount <= 0) throw new Error("archive contained no valid rows");
    return { symbol, timeframe, period, periodStart: `${period}-01T00:00:00.000Z`, periodEnd: monthEnd(period), sourceUrl, cachePath: relativePath, status, classification: "AVAILABLE", sizeBytes: buffer.byteLength, sha256, rowCount: parsed.rowCount };
  } catch (error) {
    return { symbol, timeframe, period, periodStart: `${period}-01T00:00:00.000Z`, periodEnd: monthEnd(period), sourceUrl, cachePath: null, status: "DOWNLOAD_FAILED", classification: "DOWNLOAD_FAILED", sizeBytes: null, sha256: null, rowCount: null, error: error instanceof Error ? error.message : String(error) };
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

function monthEnd(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
}

void main();
