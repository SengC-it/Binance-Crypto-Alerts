import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ProxyAgent, fetch } from "undici";

export const V18_BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
export const V18_BRANCH = "feat/v18-taker-flow-absorption-reversal";
export const V18_START = "2021-01-01T00:00:00.000Z";
export const V18_END = "2026-07-31T23:59:59.999Z";
export const V18_FREEZE_TIMESTAMP = "2026-09-05T00:00:00.000Z";
export const V18_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type V18Symbol = (typeof V18_SYMBOLS)[number];
export const V18_INTERVAL_MS = 5 * 60_000;
export const V18_WINDOW_BARS = 30 * 24 * 60 / 5;
export const V18_MONTHS = monthKeys(Date.parse(V18_START), Date.parse(V18_END));
export const V18_DATA_ROOT = resolve("data/raw/v18-taker-flow-absorption-reversal");
export const V18_INVENTORY_PATH = resolve(V18_DATA_ROOT, "official-inventory.json");
export const V18_CACHE_MANIFEST_PATH = resolve(V18_DATA_ROOT, "cache-manifest.json");
export const V18_OFFICIAL_BASE = "https://data.binance.vision";
const V18_OFFICIAL_S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";

export interface V18Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  tradeCount: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface V18ArchiveRecord {
  symbol: V18Symbol;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  officialStatus: "AVAILABLE" | "OFFICIAL_UNAVAILABLE" | "CHECKSUM_UNAVAILABLE";
  checksumListed: boolean;
  expectedBytes: number | null;
  expectedSha256: string | null;
  actualBytes?: number | null;
  actualSha256?: string | null;
  checksumTextSha256?: string | null;
  rowCount?: number | null;
  invalidRows?: number | null;
  firstOpenTime?: number | null;
  lastOpenTime?: number | null;
  status?: "CHECKSUM_VERIFIED" | "PARSED" | "FAILED";
  error?: string | null;
}

export interface V18OfficialInventory {
  schema: "v18-official-inventory-v1";
  provider: "Binance Data Vision";
  officialOnly: true;
  noSyntheticData: true;
  noForwardFill: true;
  fixedSymbols: true;
  baseline: string;
  branch: string;
  start: string;
  end: string;
  symbols: V18Symbol[];
  interval: "5m";
  months: string[];
  expectedSlots: number;
  records: V18ArchiveRecord[];
  enumerationComplete: boolean;
  generatedAt: string;
}

export interface V18ParserSymbolReport {
  expectedRows: number;
  validRows: number;
  coverage: number;
  invalidRows: number;
  duplicateOpenTimes: number;
  nonMonotonicOpenTimes: number;
  cadencePass: boolean;
  timestampRangePass: boolean;
  numericFieldPass: boolean;
  quoteVolumeNonPositiveRows: number;
  takerBuyQuoteAboveQuoteRows: number;
  takerBuyBaseAboveBaseRows: number;
}

export interface V18ParserReport {
  schema: "v18-parser-report-v1";
  source: {
    provider: "Binance Data Vision";
    officialOnly: true;
    dataset: "USD-M Futures monthly 5m klines";
    symbols: V18Symbol[];
    noSyntheticData: true;
    noForwardFill: true;
    noCurrentSurvivorUniverseExpansion: true;
  };
  bySymbol: Record<V18Symbol, V18ParserSymbolReport>;
  archiveSlots: { expected: number; checksumVerified: number; parsed: number; parseComplete: boolean };
  allChecksPassed: boolean;
  generatedAt: string;
}

export interface V18CacheManifest {
  schema: "v18-cache-manifest-v1";
  inventorySha256: string;
  sealed: boolean;
  records: V18ArchiveRecord[];
  verifiedArchiveSlots: number;
  generatedAt: string;
}

export interface V18PreparedData {
  candles: Record<V18Symbol, V18Candle[]>;
  inventory: V18OfficialInventory;
  cache: V18CacheManifest;
  parser: V18ParserReport;
  archiveManifest: { schema: "v18-archive-manifest-v1"; records: V18ArchiveRecord[] };
}

interface ZipEntry { name: string; data: Buffer }

function monthKeys(start: number, end: number): string[] {
  const values: string[] = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  while (cursor.getTime() <= end) {
    values.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return values;
}

export function monthStart(month: string): number {
  return Date.parse(`${month}-01T00:00:00.000Z`);
}

export function monthEnd(month: string): number {
  const start = new Date(monthStart(month));
  start.setUTCMonth(start.getUTCMonth() + 1);
  return start.getTime() - 1;
}

export function expectedCandleRows(month: string): number {
  return Math.floor((monthEnd(month) - monthStart(month) + 1) / V18_INTERVAL_MS);
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalTextSha256(value: string): string {
  return sha256(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

export function archiveUrl(symbol: V18Symbol, month: string): string {
  return `${V18_OFFICIAL_BASE}/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

export function archiveCachePath(symbol: V18Symbol, month: string): string {
  return `data/raw/v18-taker-flow-absorption-reversal/5m/${symbol}/${month}.zip`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function splitCsv(line: string): string[] {
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

function zipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("ZIP entry exceeds archive length");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP method ${method}`); })();
    entries.push({ name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"), data });
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("ZIP archive contained no local file entries");
  return entries;
}

function numberAt(fields: string[], index: number): number | null {
  const value = Number(fields[index]);
  return Number.isFinite(value) ? value : null;
}

export function parseKlineArchive(buffer: Buffer, expectedMonth: string): { rows: V18Candle[]; invalidRows: number } {
  const dataEntry = zipEntries(buffer).find((entry) => !entry.name.endsWith("/"));
  if (!dataEntry) throw new Error("ZIP archive contained no data file");
  const rows: V18Candle[] = [];
  let invalidRows = 0;
  for (const line of dataEntry.data.toString("utf8").split(/\r?\n/).filter((value) => value.trim())) {
    const fields = splitCsv(line);
    const openTime = numberAt(fields, 0);
    if (openTime === null) continue;
    const open = numberAt(fields, 1);
    const high = numberAt(fields, 2);
    const low = numberAt(fields, 3);
    const close = numberAt(fields, 4);
    const volume = numberAt(fields, 5);
    const closeTime = numberAt(fields, 6);
    const quoteVolume = numberAt(fields, 7);
    const tradeCount = numberAt(fields, 8);
    const takerBuyBaseVolume = numberAt(fields, 9);
    const takerBuyQuoteVolume = numberAt(fields, 10);
    if (fields.length < 11 || open === null || high === null || low === null || close === null || volume === null || closeTime === null || quoteVolume === null || tradeCount === null || takerBuyBaseVolume === null || takerBuyQuoteVolume === null) { invalidRows += 1; continue; }
    const valid = Number.isInteger(openTime)
      && Number.isInteger(closeTime)
      && openTime >= monthStart(expectedMonth)
      && openTime <= monthEnd(expectedMonth)
      && openTime % V18_INTERVAL_MS === 0
      && closeTime >= openTime
      && closeTime < openTime + V18_INTERVAL_MS
      && Math.min(open, high, low, close) > 0
      && high >= Math.max(open, close, low)
      && low <= Math.min(open, close, high)
      && volume >= 0
      && quoteVolume >= 0
      && Number.isInteger(tradeCount) && tradeCount >= 0
      && takerBuyBaseVolume >= 0 && takerBuyBaseVolume <= volume
      && takerBuyQuoteVolume >= 0 && takerBuyQuoteVolume <= quoteVolume;
    if (!valid) { invalidRows += 1; continue; }
    rows.push({ openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount, takerBuyBaseVolume, takerBuyQuoteVolume });
  }
  return { rows, invalidRows };
}

const dispatcher = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;

async function request(url: string, as: "text" | "bytes"): Promise<{ status: number; value: string | Buffer }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { ...(dispatcher ? { dispatcher } : {}), headers: { "user-agent": "binance-crypto-alerts-v18-freeze/1.0" }, signal: AbortSignal.timeout(60_000) });
      const value = as === "text" ? await response.text() : Buffer.from(await response.arrayBuffer());
      if (response.ok) return { status: response.status, value };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function checksumValue(text: string): string {
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error("official checksum response did not contain SHA-256");
  return match[0].toLowerCase();
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function listingObjects(xml: string): Map<string, number> {
  const objects = new Map<string, number>();
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = match[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = match[1].match(/<Size>([\s\S]*?)<\/Size>/)?.[1];
    if (key !== undefined && size !== undefined) objects.set(decodeXml(key), Number(size));
  }
  return objects;
}

async function listOfficialObjects(prefix: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", "max-keys": "1000", prefix });
    if (continuationToken) params.set("continuation-token", continuationToken);
    const response = await request(`${V18_OFFICIAL_S3}/?${params.toString()}`, "text");
    const xml = String(response.value);
    for (const [key, size] of listingObjects(xml)) objects.set(key, size);
    continuationToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    if (xml.match(/<IsTruncated>true<\/IsTruncated>/) && !continuationToken) throw new Error(`truncated S3 listing without continuation token: ${prefix}`);
  } while (continuationToken);
  return objects;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
}

function inventorySlots(): Array<{ symbol: V18Symbol; month: string }> {
  return V18_SYMBOLS.flatMap((symbol) => V18_MONTHS.map((month) => ({ symbol, month })));
}

function inventoryPrefix(symbol: V18Symbol): string {
  return `data/futures/um/monthly/klines/${symbol}/5m/`;
}

export async function enumerateOfficialArchives(): Promise<V18OfficialInventory> {
  if (await fileExists(V18_INVENTORY_PATH)) {
    const existing = JSON.parse(await readFile(V18_INVENTORY_PATH, "utf8")) as V18OfficialInventory;
    if (existing.schema !== "v18-official-inventory-v1" || existing.baseline !== V18_BASELINE || existing.start !== V18_START || existing.end !== V18_END) throw new Error("existing V18 inventory does not match the frozen request");
    return existing;
  }
  console.log(`[V18] enumerating ${V18_SYMBOLS.length} fixed symbols across ${V18_MONTHS.length} official months`);
  const listings = new Map<V18Symbol, Map<string, number>>();
  await mapLimit([...V18_SYMBOLS], 2, async (symbol) => { listings.set(symbol, await listOfficialObjects(inventoryPrefix(symbol))); });
  const records = await Promise.all(inventorySlots().map(async ({ symbol, month }): Promise<V18ArchiveRecord> => {
    const sourceUrl = archiveUrl(symbol, month);
    const fileName = sourceUrl.slice(sourceUrl.lastIndexOf("/") + 1);
    const key = `${inventoryPrefix(symbol)}${fileName}`;
    const listing = listings.get(symbol);
    const expectedBytes = listing?.get(key) ?? null;
    const checksumListed = listing?.has(`${key}.CHECKSUM`) ?? false;
    let expectedSha256: string | null = null;
    if (expectedBytes !== null && checksumListed) {
      const checksum = await request(`${sourceUrl}.CHECKSUM`, "text");
      expectedSha256 = checksumValue(String(checksum.value));
    }
    return { symbol, month, sourceUrl, checksumUrl: `${sourceUrl}.CHECKSUM`, cachePath: archiveCachePath(symbol, month), officialStatus: expectedBytes === null ? "OFFICIAL_UNAVAILABLE" : checksumListed ? "AVAILABLE" : "CHECKSUM_UNAVAILABLE", checksumListed, expectedBytes, expectedSha256 };
  }));
  const inventory: V18OfficialInventory = { schema: "v18-official-inventory-v1", provider: "Binance Data Vision", officialOnly: true, noSyntheticData: true, noForwardFill: true, fixedSymbols: true, baseline: V18_BASELINE, branch: V18_BRANCH, start: V18_START, end: V18_END, symbols: [...V18_SYMBOLS], interval: "5m", months: [...V18_MONTHS], expectedSlots: records.length, records, enumerationComplete: records.every((record) => record.officialStatus === "AVAILABLE" && record.expectedSha256 !== null), generatedAt: new Date().toISOString() };
  await writeJson(V18_INVENTORY_PATH, inventory);
  return inventory;
}

async function atomicWrite(path: string, value: Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.part-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { flag: "wx" });
  await rename(temporary, path);
}

async function materializeRecord(record: V18ArchiveRecord): Promise<V18ArchiveRecord> {
  if (record.officialStatus !== "AVAILABLE" || record.expectedSha256 === null) return { ...record, status: "FAILED", error: "official archive or checksum unavailable" };
  const path = resolve(record.cachePath);
  let payload: Buffer;
  try {
    payload = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    payload = Buffer.from((await request(record.sourceUrl, "bytes")).value as Buffer);
    await atomicWrite(path, payload);
  }
  const actualSha256 = sha256(payload);
  if (actualSha256 !== record.expectedSha256 || (record.expectedBytes !== null && payload.length !== record.expectedBytes)) return { ...record, actualBytes: payload.length, actualSha256, status: "FAILED", error: `archive bytes do not match official provenance (${actualSha256}, ${payload.length})` };
  const checksumPath = `${path}.CHECKSUM`;
  let checksumText: string;
  try {
    checksumText = await readFile(checksumPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    checksumText = String((await request(record.checksumUrl, "text")).value);
    await atomicWrite(checksumPath, Buffer.from(checksumText, "utf8"));
  }
  if (checksumValue(checksumText) !== record.expectedSha256) return { ...record, actualBytes: payload.length, actualSha256, status: "FAILED", error: "local checksum sidecar does not match official checksum" };
  return { ...record, actualBytes: payload.length, actualSha256, checksumTextSha256: sha256(checksumText), status: "CHECKSUM_VERIFIED", error: null };
}

export async function materializeOfficialArchives(inventory: V18OfficialInventory): Promise<V18CacheManifest> {
  if (await fileExists(V18_CACHE_MANIFEST_PATH)) {
    const existing = JSON.parse(await readFile(V18_CACHE_MANIFEST_PATH, "utf8")) as V18CacheManifest;
    if (existing.schema !== "v18-cache-manifest-v1" || existing.inventorySha256 !== sha256(canonicalJson(inventory)) || !existing.sealed) throw new Error("existing V18 cache manifest is not a sealed match");
    return existing;
  }
  const records = inventory.records.map((record) => ({ ...record }));
  let completed = 0;
  await mapLimit(records, 6, async (record) => {
    Object.assign(record, await materializeRecord(record));
    completed += 1;
    if (completed % 5 === 0 || completed === records.length) console.log(`[V18] verified archives ${completed}/${records.length}`);
  });
  const cache: V18CacheManifest = { schema: "v18-cache-manifest-v1", inventorySha256: sha256(canonicalJson(inventory)), sealed: records.every((record) => record.status === "CHECKSUM_VERIFIED"), records, verifiedArchiveSlots: records.filter((record) => record.status === "CHECKSUM_VERIFIED").length, generatedAt: new Date().toISOString() };
  await writeJson(V18_CACHE_MANIFEST_PATH, cache);
  return cache;
}

function integrity(candles: V18Candle[]): Omit<V18ParserSymbolReport, "expectedRows" | "validRows" | "coverage" | "invalidRows"> {
  const ordered = candles.slice().sort((left, right) => left.openTime - right.openTime);
  let duplicateOpenTimes = 0;
  let nonMonotonicOpenTimes = 0;
  let cadencePairs = 0;
  let timestampRangePass = true;
  let numericFieldPass = true;
  let quoteVolumeNonPositiveRows = 0;
  let takerBuyQuoteAboveQuoteRows = 0;
  let takerBuyBaseAboveBaseRows = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const candle = ordered[index];
    if (index > 0) {
      if (candle.openTime === ordered[index - 1].openTime) duplicateOpenTimes += 1;
      if (candle.openTime <= ordered[index - 1].openTime) nonMonotonicOpenTimes += 1;
      if (candle.openTime - ordered[index - 1].openTime === V18_INTERVAL_MS) cadencePairs += 1;
    }
    if (candle.openTime < Date.parse(V18_START) || candle.openTime > Date.parse(V18_END)) timestampRangePass = false;
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume, candle.quoteVolume, candle.closeTime, candle.tradeCount, candle.takerBuyBaseVolume, candle.takerBuyQuoteVolume].every(Number.isFinite)) numericFieldPass = false;
    if (candle.quoteVolume <= 0) quoteVolumeNonPositiveRows += 1;
    if (candle.takerBuyQuoteVolume > candle.quoteVolume) takerBuyQuoteAboveQuoteRows += 1;
    if (candle.takerBuyBaseVolume > candle.volume) takerBuyBaseAboveBaseRows += 1;
  }
  return { duplicateOpenTimes, nonMonotonicOpenTimes, cadencePass: ordered.length > 1 && cadencePairs === ordered.length - 1, timestampRangePass, numericFieldPass, quoteVolumeNonPositiveRows, takerBuyQuoteAboveQuoteRows, takerBuyBaseAboveBaseRows };
}

export async function parseMaterializedArchives(inventory: V18OfficialInventory, cache: V18CacheManifest): Promise<V18PreparedData> {
  const candles: Record<V18Symbol, V18Candle[]> = { BTCUSDT: [], ETHUSDT: [] };
  const records = cache.records.map((record) => ({ ...record }));
  for (const record of records) {
    if (record.status !== "CHECKSUM_VERIFIED") continue;
    const parsed = parseKlineArchive(await readFile(resolve(record.cachePath)), record.month);
    record.rowCount = parsed.rows.length;
    record.invalidRows = parsed.invalidRows;
    record.firstOpenTime = parsed.rows[0]?.openTime ?? null;
    record.lastOpenTime = parsed.rows.at(-1)?.openTime ?? null;
    record.status = parsed.invalidRows === 0 ? "PARSED" : "FAILED";
    if (parsed.invalidRows > 0) record.error = `${parsed.invalidRows} invalid kline rows`;
    candles[record.symbol].push(...parsed.rows);
  }
  for (const symbol of V18_SYMBOLS) candles[symbol].sort((left, right) => left.openTime - right.openTime);
  const bySymbol = {} as Record<V18Symbol, V18ParserSymbolReport>;
  const expectedRows = V18_MONTHS.reduce((total, month) => total + expectedCandleRows(month), 0);
  for (const symbol of V18_SYMBOLS) {
    const values = candles[symbol];
    const checks = integrity(values);
    bySymbol[symbol] = { expectedRows, validRows: values.length, coverage: values.length / expectedRows, invalidRows: records.filter((record) => record.symbol === symbol).reduce((total, record) => total + (record.invalidRows ?? 0), 0), ...checks };
  }
  const parser: V18ParserReport = { schema: "v18-parser-report-v1", source: { provider: "Binance Data Vision", officialOnly: true, dataset: "USD-M Futures monthly 5m klines", symbols: [...V18_SYMBOLS], noSyntheticData: true, noForwardFill: true, noCurrentSurvivorUniverseExpansion: true }, bySymbol, archiveSlots: { expected: records.length, checksumVerified: records.filter((record) => record.status === "CHECKSUM_VERIFIED" || record.status === "PARSED").length, parsed: records.filter((record) => record.status === "PARSED").length, parseComplete: records.length === V18_MONTHS.length * V18_SYMBOLS.length && records.every((record) => record.status === "PARSED") }, allChecksPassed: records.every((record) => record.status === "PARSED") && V18_SYMBOLS.every((symbol) => bySymbol[symbol].duplicateOpenTimes === 0 && bySymbol[symbol].nonMonotonicOpenTimes === 0 && bySymbol[symbol].cadencePass && bySymbol[symbol].timestampRangePass && bySymbol[symbol].numericFieldPass && bySymbol[symbol].takerBuyQuoteAboveQuoteRows === 0 && bySymbol[symbol].takerBuyBaseAboveBaseRows === 0), generatedAt: new Date().toISOString() };
  return { candles, inventory, cache: { ...cache, records }, parser, archiveManifest: { schema: "v18-archive-manifest-v1", records } };
}

export async function prepareOfficialData(): Promise<V18PreparedData> {
  const inventory = await enumerateOfficialArchives();
  if (!inventory.enumerationComplete) throw new Error("V18 official archive enumeration is incomplete");
  const cache = await materializeOfficialArchives(inventory);
  if (!cache.sealed) throw new Error("V18 official archive cache is not sealed");
  return parseMaterializedArchives(inventory, cache);
}

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
