import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  externalArchiveUrl,
  monthKeys,
  parseMonthlyArchive,
  type V57ExternalTimeframe,
} from "@/lib/v5-7/external-data";
import {
  V58_FRESH_END,
  V58_FRESH_MANIFEST_ID,
  V58_FRESH_START,
  V58_FRESH_SYMBOLS,
  V58_FRESH_SYMBOL_EFFECTIVE_STARTS,
} from "@/lib/v5-8/regime";
import { hashWithoutField } from "@/lib/v5-7/manifest";

const CACHE_DIR = resolve("data/raw/v5-8-fresh-cache");
const ARCHIVE_DIR = resolve(CACHE_DIR, "archives");
const INVENTORY_PATH = resolve("reports/v5-8-fresh-data-inventory.json");
const MANIFEST_PATH = resolve("reports/v5-8-fresh-validation-manifest.json");
const TIMEFRAMES: readonly V57ExternalTimeframe[] = ["15m", "1h", "4h", "funding"];

type ArchiveStatus = "AVAILABLE" | "CACHED" | "ARCHIVE_MISSING" | "DOWNLOAD_FAILED";
type SymbolClassification = "AVAILABLE" | "ARCHIVE_MISSING" | "DOWNLOAD_FAILED";

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
  classification: SymbolClassification;
  expectedPeriods: string[];
  expectedArchiveCount: number;
  availableArchiveCount: number;
  records: ArchiveRecord[];
}

interface FreshInventory {
  schema: string;
  status: "AVAILABLE" | "DATA_INCOMPLETE";
  queryTimestamp: string;
  manifestId: string;
  manifestHash: string;
  period: { start: string; end: string };
  source: string;
  exchange: string;
  timeframes: readonly V57ExternalTimeframe[];
  requestedSymbols: number;
  symbols: string[];
  availableSymbols: string[];
  coveragePercent: number;
  coverageRule: string;
  symbolRecords: SymbolRecord[];
  archives: ArchiveRecord[];
  methodology: string[];
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  if (manifest.manifestId !== V58_FRESH_MANIFEST_ID || manifest.status !== "FROZEN_BEFORE_DATA_READ") throw new Error("V5.8 fresh manifest identity/status is not frozen");
  if (typeof manifest.manifestHash !== "string" || hashWithoutField(manifest, "manifestHash") !== manifest.manifestHash) throw new Error("V5.8 fresh manifest integrity check failed");
  const shouldDownload = process.argv.includes("--download");
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const pending = V58_FRESH_SYMBOLS.flatMap((symbol) => monthKeys(V58_FRESH_SYMBOL_EFFECTIVE_STARTS[symbol], V58_FRESH_END).flatMap((period) => TIMEFRAMES.map((timeframe) => ({ symbol, period, timeframe }))));
  const records = await mapWithConcurrency(pending, 8, (item) => ensureArchive(item.symbol, item.timeframe, item.period, shouldDownload));
  const symbolRecords = V58_FRESH_SYMBOLS.map((symbol) => {
    const symbolRecords = records.filter((record) => record.symbol === symbol);
    const availableArchiveCount = symbolRecords.filter((record) => record.status === "AVAILABLE" || record.status === "CACHED").length;
    const failed = symbolRecords.some((record) => record.status === "DOWNLOAD_FAILED");
    const missing = symbolRecords.some((record) => record.status === "ARCHIVE_MISSING");
    return {
      symbol,
      classification: failed ? "DOWNLOAD_FAILED" : missing ? "ARCHIVE_MISSING" : availableArchiveCount === symbolRecords.length ? "AVAILABLE" : "DOWNLOAD_FAILED",
      expectedPeriods: [...new Set(symbolRecords.map((record) => record.period))].sort(),
      expectedArchiveCount: symbolRecords.length,
      availableArchiveCount,
      records: symbolRecords,
    } satisfies SymbolRecord;
  });
  const availableSymbols = symbolRecords.filter((record) => record.classification === "AVAILABLE").map((record) => record.symbol);
  const coveragePercent = availableSymbols.length / V58_FRESH_SYMBOLS.length * 100;
  const inventory: FreshInventory = {
    schema: "bca-v5-8-fresh-data-inventory-v1",
    status: availableSymbols.length === V58_FRESH_SYMBOLS.length ? "AVAILABLE" : "DATA_INCOMPLETE",
    queryTimestamp: new Date().toISOString(),
    manifestId: V58_FRESH_MANIFEST_ID,
    manifestHash: String(manifest.manifestHash),
    period: { start: new Date(V58_FRESH_START).toISOString(), end: new Date(V58_FRESH_END).toISOString() },
    source: "Binance Data Vision USDT-M Futures monthly archives",
    exchange: "Binance USDT-M Futures",
    timeframes: TIMEFRAMES,
    requestedSymbols: V58_FRESH_SYMBOLS.length,
    symbols: [...V58_FRESH_SYMBOLS],
    availableSymbols,
    coveragePercent,
    coverageRule: "Fresh validation requires every frozen symbol and every 2020 month/timeframe archive; otherwise DATA_UNAVAILABLE and no fresh profitability conclusion.",
    symbolRecords,
    archives: records,
    methodology: [
      "Symbols, period, timeframes, execution reference, and cost assumptions were frozen before any archive response was read.",
      "Each archive is cached under data/raw/v5-8-fresh-cache and recorded with URL, byte size, SHA-256, and parsed row count.",
      "The cache is ignored and never committed; a missing/corrupt archive fail-closes fresh validation.",
      "No fresh return or archive availability result changes the frozen Primary or eight-gate registry.",
    ],
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_8_fresh_data_inventory", download: shouldDownload, status: inventory.status, available: availableSymbols.length, requested: V58_FRESH_SYMBOLS.length, coveragePercent }));
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

async function ensureArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string, shouldDownload: boolean): Promise<ArchiveRecord> {
  const sourceUrl = externalArchiveUrl(symbol, timeframe, period);
  const relativePath = `data/raw/v5-8-fresh-cache/archives/${symbol}/${timeframe}/${period}.zip`;
  const cachePath = resolve(relativePath);
  const base = { symbol, timeframe, period, periodStart: `${period}-01T00:00:00.000Z`, periodEnd: monthEnd(period), sourceUrl };
  try {
    let buffer: Buffer;
    let status: ArchiveStatus;
    try {
      buffer = await readFile(cachePath);
      status = "CACHED";
    } catch {
      if (!shouldDownload) throw new Error("not cached; downloader was run without --download");
      const response = await fetchWithRetry(sourceUrl);
      if (response.status === 404) return { ...base, cachePath: null, status: "ARCHIVE_MISSING", classification: "ARCHIVE_MISSING", sizeBytes: null, sha256: null, rowCount: null, error: "HTTP 404" };
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
    return { ...base, cachePath: relativePath, status, classification: "AVAILABLE", sizeBytes: buffer.byteLength, sha256, rowCount: parsed.rowCount };
  } catch (error) {
    return { ...base, cachePath: null, status: "DOWNLOAD_FAILED", classification: "DOWNLOAD_FAILED", sizeBytes: null, sha256: null, rowCount: null, error: error instanceof Error ? error.message : String(error) };
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
