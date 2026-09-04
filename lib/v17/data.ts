import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ProxyAgent, fetch } from "undici";

export const V17_BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
export const V17_BRANCH = "feat/v17-crowding-failed-continuation";
export const V17_START = "2021-01-01T00:00:00.000Z";
export const V17_END = "2026-07-31T23:59:59.999Z";
export const V17_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type V17Symbol = (typeof V17_SYMBOLS)[number];
export const V17_MONTHS = monthKeys(Date.parse(V17_START), Date.parse(V17_END));
export const V17_DATA_ROOT = resolve("data/raw/v17-crowding-failed-continuation");
export const V17_INVENTORY_PATH = resolve(V17_DATA_ROOT, "official-inventory.json");
export const V17_CACHE_MANIFEST_PATH = resolve(V17_DATA_ROOT, "manifest.json");
export const V17_PARSER_REPORT_PATH = resolve(V17_DATA_ROOT, "parser-report.json");
export const V17_OFFICIAL_BASE = "https://data.binance.vision";
const V17_OFFICIAL_S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";

export type V17DatasetKind = "15m" | "1h" | "fundingRate" | "markPriceKlines";
export const V17_DATASETS: V17DatasetKind[] = ["15m", "1h", "fundingRate", "markPriceKlines"];

export interface V17Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface V17FundingPoint {
  timestamp: number;
  fundingRate: number;
}

export interface V17ArchiveRecord {
  dataset: V17DatasetKind;
  symbol: V17Symbol;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  officialStatus: "AVAILABLE" | "OFFICIAL_UNAVAILABLE" | "CHECKSUM_UNAVAILABLE";
  checksumListed: boolean;
  expectedBytes: number | null;
  expectedSha256: string | null;
  actualSha256?: string | null;
  actualBytes?: number | null;
  checksumTextSha256?: string | null;
  rowCount?: number | null;
  validRows?: number | null;
  parseErrors?: number | null;
  firstTimestamp?: number | null;
  lastTimestamp?: number | null;
  status?: "CHECKSUM_VERIFIED" | "PARSED" | "FAILED";
  error?: string | null;
}

export interface V17OfficialInventory {
  schema: "v17-official-inventory-v1";
  provider: "Binance Data Vision";
  officialOnly: true;
  baseline: string;
  branch: string;
  start: string;
  end: string;
  symbols: V17Symbol[];
  datasets: V17DatasetKind[];
  expectedSlots: number;
  records: V17ArchiveRecord[];
  enumerationComplete: boolean;
  generatedAt: string;
}

export interface V17CacheManifest {
  schema: "v17-cache-manifest-v1";
  inventorySha256: string;
  sealed: boolean;
  records: V17ArchiveRecord[];
  verifiedArchiveSlots: number;
  generatedAt: string;
}

export interface V17ParsedDatasets {
  BTCUSDT: { candles15m: V17Candle[]; candles1h: V17Candle[]; marks5m: V17Candle[]; funding: V17FundingPoint[] };
  ETHUSDT: { candles15m: V17Candle[]; candles1h: V17Candle[]; marks5m: V17Candle[]; funding: V17FundingPoint[] };
}

export interface V17ParserSymbolReport {
  candles15m: { expectedRows: number; validRows: number; coverage: number; duplicateOpenTimes: number; nonMonotonicOpenTimes: number; cadencePass: boolean };
  candles1h: { expectedRows: number; validRows: number; coverage: number; duplicateOpenTimes: number; nonMonotonicOpenTimes: number; cadencePass: boolean };
  marks5m: { validRows: number; duplicateOpenTimes: number; nonMonotonicOpenTimes: number; cadencePass: boolean };
  funding: { rows: number; validRows: number; invalidRows: number; timestampMonotonic: boolean; duplicateTimestamps: number; firstTimestamp: number | null; lastTimestamp: number | null };
}

export interface V17ParserReport {
  schema: "v17-parser-report-v1";
  source: { provider: "Binance Data Vision"; officialOnly: true; noSyntheticData: true; noCurrentSurvivorUniverse: true; noForwardFill: true };
  bySymbol: Record<V17Symbol, V17ParserSymbolReport>;
  fundingSettlement: { required: number; covered: number; coverage: number; missing: number };
  pit180dFundingHistory: { eligibleEvents: number; coveredEvents: number; coverage: number };
  preReturn8h: { eligibleEvents: number; coveredEvents: number; coverage: number };
  postFunding30m: { eligibleEvents: number; coveredEvents: number; coverage: number };
  executionPrice: { eligibleEvents: number; coveredEvents: number; coverage: number };
  atr14: { eligibleEvents: number; coveredEvents: number; coverage: number };
  noSyntheticFallback: true;
  archiveSlots: { expected: number; checksumVerified: number; parseComplete: boolean };
  generatedAt: string;
}

export interface V17ParseResult {
  datasets: V17ParsedDatasets;
  cache: V17CacheManifest;
  report: V17ParserReport;
}

export interface ZipEntry { name: string; data: Buffer; }

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

export function expectedCandleRows(month: string, intervalMs: number): number {
  return Math.floor((monthEnd(month) - monthStart(month) + 1) / intervalMs);
}

export function archiveUrl(dataset: V17DatasetKind, symbol: V17Symbol, month: string): string {
  if (dataset === "15m" || dataset === "1h") return `${V17_OFFICIAL_BASE}/data/futures/um/monthly/klines/${symbol}/${dataset}/${symbol}-${dataset}-${month}.zip`;
  if (dataset === "fundingRate") return `${V17_OFFICIAL_BASE}/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`;
  return `${V17_OFFICIAL_BASE}/data/futures/um/monthly/markPriceKlines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

export function archiveCachePath(dataset: V17DatasetKind, symbol: V17Symbol, month: string): string {
  return `data/raw/v17-crowding-failed-continuation/${dataset}/${symbol}/${month}.zip`;
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
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
  if (!entries.length) throw new Error("ZIP archive contained no local file entries");
  return entries;
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

function rows(buffer: Buffer): string[][] {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("ZIP archive contained no data file");
  return entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map(splitCsv);
}

function numberAt(fields: string[], index: number): number | null {
  const value = Number(fields[index]);
  return Number.isFinite(value) ? value : null;
}

export function parseKlineArchive(buffer: Buffer, intervalMs: number): { rows: V17Candle[]; invalidRows: number } {
  const parsed: V17Candle[] = [];
  let invalidRows = 0;
  for (const fields of rows(buffer)) {
    const openTime = numberAt(fields, 0);
    const open = numberAt(fields, 1);
    const high = numberAt(fields, 2);
    const low = numberAt(fields, 3);
    const close = numberAt(fields, 4);
    const volume = numberAt(fields, 5);
    const closeTime = numberAt(fields, 6);
    if (openTime === null || open === null || high === null || low === null || close === null || volume === null || closeTime === null || openTime >= closeTime || closeTime - openTime >= intervalMs || Math.min(open, high, low, close) <= 0 || volume < 0) {
      if (numberAt(fields, 0) !== null) invalidRows += 1;
      continue;
    }
    parsed.push({ openTime, open, high, low, close, volume, closeTime });
  }
  return { rows: parsed, invalidRows };
}

export function parseFundingArchive(buffer: Buffer): { rows: V17FundingPoint[]; invalidRows: number } {
  const parsed: V17FundingPoint[] = [];
  let invalidRows = 0;
  for (const fields of rows(buffer)) {
    if (fields[0]?.trim().toLowerCase() === "calc_time") continue;
    const timestamp = numberAt(fields, 0);
    const fundingRate = numberAt(fields, 2);
    if (timestamp === null || fundingRate === null || timestamp <= 0) {
      invalidRows += 1;
      continue;
    }
    parsed.push({ timestamp, fundingRate });
  }
  return { rows: parsed, invalidRows };
}

export function parseArchive(buffer: Buffer, dataset: V17DatasetKind): { candles?: V17Candle[]; funding?: V17FundingPoint[]; invalidRows: number } {
  if (dataset === "fundingRate") {
    const result = parseFundingArchive(buffer);
    return { funding: result.rows, invalidRows: result.invalidRows };
  }
  const result = parseKlineArchive(buffer, dataset === "15m" ? 15 * 60_000 : dataset === "1h" ? 60 * 60_000 : 5 * 60_000);
  return { candles: result.rows, invalidRows: result.invalidRows };
}

const V17_DISPATCHER = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;

function proxy(): ProxyAgent | undefined {
  return V17_DISPATCHER;
}

async function request(url: string, method: "GET" | "HEAD", as: "text" | "bytes"): Promise<{ status: number; value: string | Buffer | null; bytes: number | null }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { method, ...(proxy() ? { dispatcher: proxy() } : {}), headers: { "user-agent": "binance-crypto-alerts-v17-data/1.0" }, signal: AbortSignal.timeout(45_000) });
      if (method === "HEAD") return { status: response.status, value: null, bytes: Number(response.headers.get("content-length")) || null };
      const value = as === "text" ? await response.text() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, value, bytes: Buffer.isBuffer(value) ? value.length : null };
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function checksumValue(text: string): string {
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error("official checksum response did not contain a SHA-256 digest");
  return match[0].toLowerCase();
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function listKeys(xml: string): Map<string, number> {
  const objects = new Map<string, number>();
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = match[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = match[1].match(/<Size>([\s\S]*?)<\/Size>/)?.[1];
    if (key === undefined || size === undefined) throw new Error("Malformed official S3 listing object");
    objects.set(decodeXml(key), Number(size));
  }
  return objects;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
  return results;
}

export async function enumerateOfficialArchives(): Promise<V17OfficialInventory> {
  const slots = V17_SYMBOLS.flatMap((symbol) => V17_MONTHS.flatMap((month) => V17_DATASETS.map((dataset) => ({ dataset, symbol, month }))));
  const prefixes = [...new Set(slots.map(({ dataset, symbol }) => {
    const sample = archiveUrl(dataset, symbol, V17_MONTHS[0]);
    return sample.slice(sample.indexOf("/data/") + 1, sample.lastIndexOf("/")) + "/";
  }))];
  const listings = new Map<string, Map<string, number>>();
  await mapLimit(prefixes, 8, async (prefix) => {
    const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000", prefix });
    const response = await request(`${V17_OFFICIAL_S3}/?${query.toString()}`, "GET", "text");
    if (response.status < 200 || response.status >= 300 || typeof response.value !== "string") throw new Error(`official listing failed for ${prefix}: HTTP ${response.status}`);
    listings.set(prefix, listKeys(response.value));
  });
  const records = slots.map(({ dataset, symbol, month }): V17ArchiveRecord => {
    const sourceUrl = archiveUrl(dataset, symbol, month);
    const checksumUrl = `${sourceUrl}.CHECKSUM`;
    const prefix = sourceUrl.slice(sourceUrl.indexOf("/data/") + 1, sourceUrl.lastIndexOf("/")) + "/";
    const key = `${prefix}${sourceUrl.slice(sourceUrl.lastIndexOf("/") + 1)}`;
    const listing = listings.get(prefix);
    const expectedBytes = listing?.get(key) ?? null;
    const checksumListed = listing?.has(`${key}.CHECKSUM`) ?? false;
    return { dataset, symbol, month, sourceUrl, checksumUrl, cachePath: archiveCachePath(dataset, symbol, month), officialStatus: expectedBytes === null ? "OFFICIAL_UNAVAILABLE" : checksumListed ? "AVAILABLE" : "CHECKSUM_UNAVAILABLE", checksumListed, expectedBytes, expectedSha256: null };
  });
  await mapLimit(records.filter((record) => record.officialStatus === "AVAILABLE"), 32, async (record) => {
    const checksum = await request(record.checksumUrl, "GET", "text");
    if (checksum.status < 200 || checksum.status >= 300 || typeof checksum.value !== "string") throw new Error(`checksum enumeration failed for ${record.checksumUrl}: HTTP ${checksum.status}`);
    record.expectedSha256 = checksumValue(checksum.value);
  });
  return { schema: "v17-official-inventory-v1", provider: "Binance Data Vision", officialOnly: true, baseline: V17_BASELINE, branch: V17_BRANCH, start: V17_START, end: V17_END, symbols: [...V17_SYMBOLS], datasets: [...V17_DATASETS], expectedSlots: slots.length, records, enumerationComplete: records.every((record) => record.officialStatus === "AVAILABLE" && record.checksumListed && record.expectedSha256 !== null), generatedAt: new Date().toISOString() };
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.part`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

async function materializeRecord(record: V17ArchiveRecord): Promise<V17ArchiveRecord> {
  if (record.officialStatus !== "AVAILABLE" || record.expectedSha256 === null) return { ...record, status: "FAILED", error: "archive is not officially available with a checksum" };
  const path = resolve(record.cachePath);
  let payload: Buffer;
  try {
    payload = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const downloaded = await request(record.sourceUrl, "GET", "bytes");
    if (downloaded.status < 200 || downloaded.status >= 300 || !Buffer.isBuffer(downloaded.value)) return { ...record, status: "FAILED", error: `archive download failed: HTTP ${downloaded.status}` };
    payload = downloaded.value;
  }
  const actualSha256 = sha256(payload);
  if (actualSha256 !== record.expectedSha256) return { ...record, actualSha256, actualBytes: payload.length, status: "FAILED", error: `archive checksum mismatch: ${actualSha256} !== ${record.expectedSha256}` };
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(path, payload);
  }
  const checksum = await request(record.checksumUrl, "GET", "text");
  if (checksum.status < 200 || checksum.status >= 300 || typeof checksum.value !== "string" || checksumValue(checksum.value) !== record.expectedSha256) return { ...record, actualSha256, actualBytes: payload.length, status: "FAILED", error: "official checksum sidecar could not be revalidated" };
  const checksumPath = `${path}.CHECKSUM`;
  try {
    const existing = await readFile(checksumPath, "utf8");
    if (checksumValue(existing) !== record.expectedSha256) return { ...record, actualSha256, actualBytes: payload.length, status: "FAILED", error: "immutable checksum sidecar collision" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(checksumPath, Buffer.from(checksum.value, "utf8"));
  }
  return { ...record, actualSha256, actualBytes: payload.length, checksumTextSha256: sha256(checksum.value), status: "CHECKSUM_VERIFIED", error: null };
}

export async function materializeOfficialArchives(inventory: V17OfficialInventory, inventorySha256: string): Promise<V17CacheManifest> {
  const existing = await mapLimit(inventory.records, 12, materializeRecord);
  return { schema: "v17-cache-manifest-v1", inventorySha256, sealed: existing.every((record) => record.status === "CHECKSUM_VERIFIED"), records: existing, verifiedArchiveSlots: existing.filter((record) => record.status === "CHECKSUM_VERIFIED").length, generatedAt: new Date().toISOString() };
}

function upperBoundBy<T>(values: T[], target: number, get: (value: T) => number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (get(values[middle]) <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function sortedIntegrity(candles: V17Candle[], intervalMs: number): { duplicateOpenTimes: number; nonMonotonicOpenTimes: number; cadencePass: boolean } {
  const ordered = candles.slice().sort((left, right) => left.openTime - right.openTime);
  const duplicateOpenTimes = ordered.slice(1).filter((candle, index) => candle.openTime === ordered[index].openTime).length;
  const nonMonotonicOpenTimes = candles.slice(1).filter((candle, index) => candle.openTime <= candles[index].openTime).length;
  const cadencePairs = ordered.slice(1).filter((candle, index) => candle.openTime - ordered[index].openTime === intervalMs).length;
  return { duplicateOpenTimes, nonMonotonicOpenTimes, cadencePass: ordered.length > 1 && cadencePairs / (ordered.length - 1) >= 0.995 };
}

function markAt(marks: V17Candle[], timestamp: number): V17Candle | null {
  const index = upperBoundBy(marks, timestamp, (bar) => bar.openTime) - 1;
  const bar = index >= 0 ? marks[index] : null;
  return bar && timestamp <= bar.closeTime ? bar : null;
}

function consecutiveAfter(candles: V17Candle[], timestamp: number, count: number): boolean {
  const index = candles.findIndex((candle) => candle.openTime >= timestamp);
  if (index < 0 || index + count > candles.length) return false;
  for (let offset = 1; offset < count; offset += 1) if (candles[index + offset].openTime !== candles[index].openTime + offset * 15 * 60_000) return false;
  return candles[index + count - 1].closeTime < timestamp + 30 * 60_000;
}

function eventCoverage(datasets: V17ParsedDatasets, selector: (symbol: V17Symbol, funding: V17FundingPoint, data: V17ParsedDatasets[V17Symbol]) => boolean): { eligible: number; covered: number } {
  let eligible = 0;
  let covered = 0;
  for (const symbol of V17_SYMBOLS) {
    const data = datasets[symbol];
    for (const funding of data.funding) {
      if (funding.timestamp < Date.parse(V17_START) || funding.timestamp > Date.parse(V17_END)) continue;
      eligible += 1;
      if (selector(symbol, funding, data)) covered += 1;
    }
  }
  return { eligible, covered };
}

export async function parseMaterializedArchives(manifest: V17CacheManifest): Promise<V17ParseResult> {
  const datasets: V17ParsedDatasets = { BTCUSDT: { candles15m: [], candles1h: [], marks5m: [], funding: [] }, ETHUSDT: { candles15m: [], candles1h: [], marks5m: [], funding: [] } };
  const bySymbol = {} as Record<V17Symbol, V17ParserSymbolReport>;
  for (const symbol of V17_SYMBOLS) bySymbol[symbol] = { candles15m: { expectedRows: 0, validRows: 0, coverage: 0, duplicateOpenTimes: 0, nonMonotonicOpenTimes: 0, cadencePass: true }, candles1h: { expectedRows: 0, validRows: 0, coverage: 0, duplicateOpenTimes: 0, nonMonotonicOpenTimes: 0, cadencePass: true }, marks5m: { validRows: 0, duplicateOpenTimes: 0, nonMonotonicOpenTimes: 0, cadencePass: true }, funding: { rows: 0, validRows: 0, invalidRows: 0, timestampMonotonic: true, duplicateTimestamps: 0, firstTimestamp: null, lastTimestamp: null } };
  for (const record of manifest.records) {
    if (record.status !== "CHECKSUM_VERIFIED" && record.status !== "PARSED") continue;
    const parsed = parseArchive(await readFile(resolve(record.cachePath)), record.dataset);
    const data = datasets[record.symbol];
    if (record.dataset === "fundingRate") data.funding.push(...(parsed.funding ?? []));
    else if (record.dataset === "15m") data.candles15m.push(...(parsed.candles ?? []));
    else if (record.dataset === "1h") data.candles1h.push(...(parsed.candles ?? []));
    else data.marks5m.push(...(parsed.candles ?? []));
    record.rowCount = parsed.funding?.length ?? parsed.candles?.length ?? 0;
    record.validRows = record.rowCount;
    record.parseErrors = parsed.invalidRows;
    record.firstTimestamp = parsed.funding?.[0]?.timestamp ?? parsed.candles?.[0]?.openTime ?? null;
    record.lastTimestamp = parsed.funding?.at(-1)?.timestamp ?? parsed.candles?.at(-1)?.closeTime ?? null;
    record.status = parsed.invalidRows === 0 ? "PARSED" : "FAILED";
    if (parsed.invalidRows > 0) record.error = `${parsed.invalidRows} invalid rows`;
  }
  for (const symbol of V17_SYMBOLS) {
    const data = datasets[symbol];
    data.candles15m.sort((left, right) => left.openTime - right.openTime);
    data.candles1h.sort((left, right) => left.openTime - right.openTime);
    data.marks5m.sort((left, right) => left.openTime - right.openTime);
    data.funding.sort((left, right) => left.timestamp - right.timestamp);
    const i15 = sortedIntegrity(data.candles15m, 15 * 60_000);
    const i1h = sortedIntegrity(data.candles1h, 60 * 60_000);
    const im = sortedIntegrity(data.marks5m, 5 * 60_000);
    const fundingDuplicateTimestamps = data.funding.slice(1).filter((point, index) => point.timestamp === data.funding[index].timestamp).length;
    const fundingMonotonic = data.funding.slice(1).every((point, index) => point.timestamp > data.funding[index].timestamp);
    bySymbol[symbol] = {
      candles15m: { expectedRows: V17_MONTHS.reduce((sum, month) => sum + expectedCandleRows(month, 15 * 60_000), 0), validRows: data.candles15m.length, coverage: data.candles15m.length / V17_MONTHS.reduce((sum, month) => sum + expectedCandleRows(month, 15 * 60_000), 0), ...i15 },
      candles1h: { expectedRows: V17_MONTHS.reduce((sum, month) => sum + expectedCandleRows(month, 60 * 60_000), 0), validRows: data.candles1h.length, coverage: data.candles1h.length / V17_MONTHS.reduce((sum, month) => sum + expectedCandleRows(month, 60 * 60_000), 0), ...i1h },
      marks5m: { validRows: data.marks5m.length, ...im },
      funding: { rows: data.funding.length, validRows: data.funding.length, invalidRows: manifest.records.filter((record) => record.symbol === symbol && record.dataset === "fundingRate").reduce((sum, record) => sum + (record.parseErrors ?? 0), 0), timestampMonotonic: fundingMonotonic, duplicateTimestamps: fundingDuplicateTimestamps, firstTimestamp: data.funding[0]?.timestamp ?? null, lastTimestamp: data.funding.at(-1)?.timestamp ?? null },
    };
  }
  const fundingSettlement = eventCoverage(datasets, (_symbol, funding, data) => markAt(data.marks5m, funding.timestamp) !== null);
  const pit180dFundingHistory = eventCoverage(datasets, (_symbol, funding, data) => data.funding.some((point) => point.timestamp <= funding.timestamp - 180 * 86_400_000));
  const preReturn8h = eventCoverage(datasets, (_symbol, funding, data) => {
    const before = data.candles15m.filter((candle) => candle.closeTime < funding.timestamp);
    return before.length > 0 && before.some((candle) => candle.closeTime <= funding.timestamp - 8 * 3_600_000);
  });
  const postFunding30m = eventCoverage(datasets, (_symbol, funding, data) => consecutiveAfter(data.candles15m, Math.floor(funding.timestamp / (15 * 60_000)) * (15 * 60_000), 2));
  const executionPrice = eventCoverage(datasets, (_symbol, funding, data) => data.candles15m.some((candle) => candle.openTime >= funding.timestamp + 30 * 60_000));
  const atr14 = eventCoverage(datasets, (_symbol, funding, data) => {
    const entry = data.candles15m.findIndex((candle) => candle.openTime >= funding.timestamp + 30 * 60_000);
    return entry >= 15;
  });
  const coverage = (value: { eligible: number; covered: number }): number => value.eligible === 0 ? 0 : value.covered / value.eligible;
  const report: V17ParserReport = { schema: "v17-parser-report-v1", source: { provider: "Binance Data Vision", officialOnly: true, noSyntheticData: true, noCurrentSurvivorUniverse: true, noForwardFill: true }, bySymbol, fundingSettlement: { required: fundingSettlement.eligible, covered: fundingSettlement.covered, coverage: coverage(fundingSettlement), missing: fundingSettlement.eligible - fundingSettlement.covered }, pit180dFundingHistory: { eligibleEvents: pit180dFundingHistory.eligible, coveredEvents: pit180dFundingHistory.covered, coverage: coverage(pit180dFundingHistory) }, preReturn8h: { eligibleEvents: preReturn8h.eligible, coveredEvents: preReturn8h.covered, coverage: coverage(preReturn8h) }, postFunding30m: { eligibleEvents: postFunding30m.eligible, coveredEvents: postFunding30m.covered, coverage: coverage(postFunding30m) }, executionPrice: { eligibleEvents: executionPrice.eligible, coveredEvents: executionPrice.covered, coverage: coverage(executionPrice) }, atr14: { eligibleEvents: atr14.eligible, coveredEvents: atr14.covered, coverage: coverage(atr14) }, noSyntheticFallback: true, archiveSlots: { expected: manifest.records.length, checksumVerified: manifest.verifiedArchiveSlots, parseComplete: manifest.records.every((record) => record.status === "PARSED") }, generatedAt: new Date().toISOString() };
  return { datasets, cache: manifest, report };
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
