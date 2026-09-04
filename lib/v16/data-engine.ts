import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  expectedV16ArchiveSlots,
  V16_END,
  V16_START,
  V16_SYMBOLS,
  v16Months,
  type V16ArchiveSlot,
  type V16Symbol,
} from "./data-gate";

export const V16_DATA_ROOT = resolve("data/raw/v16-aggtrade-absorption");
export const V16_CACHE_MANIFEST = resolve(V16_DATA_ROOT, "manifest.json");
export const V16_OFFICIAL_INVENTORY = resolve(V16_DATA_ROOT, "official-inventory.json");
export const V16_PARSER_REPORT = resolve(V16_DATA_ROOT, "parser-report.json");
export const V16_OFFICIAL_S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
export const V16_PUBLIC_BASE = "https://data.binance.vision/data/futures/um/monthly";

export type OfficialAvailability = "AVAILABLE" | "OFFICIAL_UNAVAILABLE" | "CHECKSUM_UNAVAILABLE";
export type MaterializationStatus = "OFFICIAL_UNAVAILABLE" | "CHECKSUM_UNAVAILABLE" | "CHECKSUM_VERIFIED" | "MATERIALIZATION_FAILED";

export interface OfficialListingObject {
  key: string;
  lastModified: string;
  bytes: number;
}

export interface OfficialArchiveRecord extends V16ArchiveSlot {
  checksumUrl: string;
  availability: OfficialAvailability;
  remoteBytes: number | null;
  remoteLastModified: string | null;
  checksumListed: boolean;
}

export interface ArchiveMaterializationRecord extends OfficialArchiveRecord {
  status: MaterializationStatus;
  checksumVerified: boolean;
  expectedSha256: string | null;
  actualSha256: string | null;
  bytes: number | null;
  checksumTextSha256: string | null;
  materializedAt: string | null;
  error: string | null;
}

export interface OfficialInventory {
  schema: "v16-official-inventory-v1";
  generatedAt: string;
  provider: "Binance Data Vision";
  officialOnly: true;
  publicBase: string;
  listingEndpoint: string;
  start: string;
  end: string;
  expectedSlots: number;
  officialAvailableSlots: number;
  officialUnavailableSlots: number;
  checksumUnavailableSlots: number;
  enumerationComplete: boolean;
  enumerationSha256: string;
  listings: Record<string, { prefix: string; objects: OfficialListingObject[]; sha256: string }>;
  records: OfficialArchiveRecord[];
}

export interface CacheManifest {
  schema: "v16-cache-manifest-v2";
  createdAt: string;
  updatedAt: string;
  sealed: boolean;
  enumerationSha256: string;
  inventorySha256: string;
  records: ArchiveMaterializationRecord[];
}

export interface AggTradeMonthReport {
  dataset: "aggTrades";
  symbol: V16Symbol;
  month: string;
  rows: number;
  validRows: number;
  firstAggregateTradeId: number | null;
  lastAggregateTradeId: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  maxTimestampGapMs: number | null;
  timestampMonotonic: boolean;
  idMonotonic: boolean;
  duplicateAggregateTradeIds: number;
  duplicateTradeRows: number;
  invalidPriceQuantity: number;
  invalidBuyerMaker: number;
  parseErrors: number;
}

export interface KlineMonthReport {
  dataset: "klines-1m" | "klines-5m" | "markPriceKlines";
  symbol: V16Symbol;
  month: string;
  intervalMs: number;
  rows: number;
  validRows: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  duplicateRows: number;
  invalidRows: number;
  openTimeMonotonic: boolean;
  cadenceValid: boolean;
  closeTimeValid: boolean;
}

export interface FundingMonthReport {
  dataset: "fundingRate";
  symbol: V16Symbol;
  month: string;
  rows: number;
  validRows: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  invalidRows: number;
  timestampMonotonic: boolean;
}

export interface SymbolParserSummary {
  aggTradeMonths: number;
  aggTradeRows: number;
  aggTradeValidRows: number;
  aggTradeFirstTimestamp: number | null;
  aggTradeLastTimestamp: number | null;
  aggTradeTimestampMonotonic: boolean;
  aggTradeIdMonotonic: boolean;
  aggTradeFieldValidity: boolean;
  aggTradeDuplicateAggregateTradeIds: number;
  aggTradeDuplicateRows: number;
  kline1mMonths: number;
  kline1mRows: number;
  kline1mValidRows: number;
  kline1mExpectedRows: number;
  kline5mMonths: number;
  kline5mRows: number;
  kline5mValidRows: number;
  kline5mExpectedRows: number;
  kline5mTimestampMonotonic: boolean;
  kline5mCadenceValid: boolean;
  kline5mCloseTimeValid: boolean;
  fundingMonths: number;
  fundingRows: number;
  fundingValidRows: number;
  fundingInvalidRows: number;
  markMonths: number;
  markRows: number;
  markValidRows: number;
}

export interface FundingSettlementCoverage {
  required: number;
  covered: number;
  coverage: number;
  uncovered: Array<{ symbol: V16Symbol; timestamp: number }>;
}

export interface ParserReport {
  schema: "v16-parser-report-v1";
  generatedAt: string;
  source: { cacheManifest: string; noSyntheticData: true; noV15Substitute: true };
  months: string[];
  bySymbol: Record<V16Symbol, SymbolParserSummary>;
  aggTrades: AggTradeMonthReport[];
  klines: KlineMonthReport[];
  funding: FundingMonthReport[];
  featureCoverage: Record<V16Symbol, number>;
  executionPriceCoverage: Record<V16Symbol, number>;
  fundingSettlement: FundingSettlementCoverage;
  markSettlement: FundingSettlementCoverage;
  fiveMinuteBarCounts: Record<V16Symbol, number>;
  proofs: {
    timestampMonotonicity: Record<V16Symbol, boolean>;
    aggTradeIdMonotonicity: Record<V16Symbol, boolean>;
    aggTradeFieldValidity: Record<V16Symbol, boolean>;
    fundingFieldValidity: Record<V16Symbol, boolean>;
    duplicateFree: Record<V16Symbol, boolean>;
    klineCadence: Record<V16Symbol, boolean>;
    noSyntheticData: true;
  };
}

export interface MaterializationOptions {
  maxArchives?: number;
  stopOnError?: boolean;
}

interface OfficialResponse {
  status: number;
  ok: boolean;
  body: Readable;
  text: () => Promise<string>;
  complete: () => Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function xmlValue(body: string, tag: string): string | null {
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1]) : null;
}

function parseS3Listing(xml: string): { objects: OfficialListingObject[]; truncated: boolean; nextToken: string | null } {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const body = match[1];
    const key = xmlValue(body, "Key");
    const lastModified = xmlValue(body, "LastModified");
    const size = xmlValue(body, "Size");
    if (key === null || lastModified === null || size === null) throw new Error("Malformed official S3 listing object");
    return { key, lastModified, bytes: Number(size) };
  });
  return {
    objects,
    truncated: xmlValue(xml, "IsTruncated") === "true",
    nextToken: xmlValue(xml, "NextContinuationToken"),
  };
}

async function fetchOfficial(url: string, range?: string, forceProxy = false): Promise<OfficialResponse> {
  const rangeArgs = range === undefined ? [] : ["--range", range];
  const directArgs = url.startsWith("https://data.binance.vision/") && !forceProxy ? ["--noproxy", "*"] : [];
  const child = spawn("curl.exe", ["--ipv4", ...directArgs, "--location", "--fail", "--silent", "--show-error", "--connect-timeout", "30", "--max-time", "120", "--speed-time", "15", "--speed-limit", "1024", ...rangeArgs, url], { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code) => {
      if (code === 0) resolveCompletion();
      else rejectCompletion(new Error(`Official Binance Data Vision request failed (${code}): ${url} ${stderr.trim()}`));
    });
  });
  const body = child.stdout;
  return {
    status: 200,
    ok: true,
    body,
    text: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      await completion;
      return Buffer.concat(chunks).toString("utf8");
    },
    complete: () => completion,
  };
}

export async function listOfficialPrefix(prefix: string): Promise<{ prefix: string; objects: OfficialListingObject[]; sha256: string }> {
  const objects: OfficialListingObject[] = [];
  let token: string | null = null;
  do {
    const params = new URLSearchParams({ "list-type": "2", "max-keys": "1000", prefix });
    if (token !== null) params.set("continuation-token", token);
    const response = await fetchOfficial(`${V16_OFFICIAL_S3}/?${params.toString()}`);
    const parsed = parseS3Listing(await response.text());
    objects.push(...parsed.objects);
    token = parsed.truncated ? parsed.nextToken : null;
    if (parsed.truncated && token === null) throw new Error(`Official S3 listing was truncated without a continuation token: ${prefix}`);
  } while (token !== null);
  const canonical = JSON.stringify({ prefix, objects: objects.sort((left, right) => left.key.localeCompare(right.key)) });
  return { prefix, objects, sha256: sha256(canonical) };
}

function slotKey(slot: Pick<V16ArchiveSlot, "dataset" | "symbol" | "month">): string {
  return `${slot.dataset}|${slot.symbol}|${slot.month}`;
}

function listingPrefix(slot: V16ArchiveSlot): string {
  const marker = "/data/";
  const path = slot.url.slice(slot.url.indexOf(marker) + 1);
  return path.slice(0, path.lastIndexOf("/")) + "/";
}

export async function enumerateOfficialArchives(): Promise<OfficialInventory> {
  const slots = expectedV16ArchiveSlots();
  const prefixes = [...new Set(slots.map(listingPrefix))];
  const listings: OfficialInventory["listings"] = {};
  for (const prefix of prefixes) listings[prefix] = await listOfficialPrefix(prefix);
  const records = slots.map((slot): OfficialArchiveRecord => {
    const listing = listings[listingPrefix(slot)].objects;
    const zip = listing.find((item) => item.key.endsWith(`/${slot.url.slice(slot.url.lastIndexOf("/") + 1)}`));
    const checksumKey = zip ? `${zip.key}.CHECKSUM` : `${slot.url.slice(slot.url.indexOf("/data/") + 1)}.CHECKSUM`;
    const checksum = listing.find((item) => item.key === checksumKey);
    const availability: OfficialAvailability = zip === undefined ? "OFFICIAL_UNAVAILABLE" : checksum === undefined ? "CHECKSUM_UNAVAILABLE" : "AVAILABLE";
    return {
      ...slot,
      checksumUrl: `${slot.url}.CHECKSUM`,
      availability,
      remoteBytes: zip?.bytes ?? null,
      remoteLastModified: zip?.lastModified ?? null,
      checksumListed: checksum !== undefined,
    };
  });
  const canonical = JSON.stringify({ records, listings });
  const officialAvailableSlots = records.filter((record) => record.availability === "AVAILABLE").length;
  const officialUnavailableSlots = records.filter((record) => record.availability === "OFFICIAL_UNAVAILABLE").length;
  const checksumUnavailableSlots = records.filter((record) => record.availability === "CHECKSUM_UNAVAILABLE").length;
  return {
    schema: "v16-official-inventory-v1",
    generatedAt: new Date().toISOString(),
    provider: "Binance Data Vision",
    officialOnly: true,
    publicBase: V16_PUBLIC_BASE,
    listingEndpoint: `${V16_OFFICIAL_S3}/?list-type=2`,
    start: V16_START,
    end: V16_END,
    expectedSlots: slots.length,
    officialAvailableSlots,
    officialUnavailableSlots,
    checksumUnavailableSlots,
    enumerationComplete: checksumUnavailableSlots === 0,
    enumerationSha256: sha256(canonical),
    listings,
    records,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function parseExpectedChecksum(text: string, fileName: string): Promise<string> {
  const line = text.trim().split(/\r?\n/).find((item) => item.trim().length > 0);
  const match = line?.match(/\b([a-fA-F0-9]{64})\b/);
  if (!match) throw new Error(`Official checksum is malformed for ${fileName}`);
  const declaredName = line?.slice(line.indexOf(match[1]) + match[1].length).trim();
  if (declaredName && !declaredName.endsWith(fileName)) throw new Error(`Official checksum names ${declaredName}, expected ${fileName}`);
  return match[1].toLowerCase();
}

async function immutableText(url: string, finalPath: string): Promise<{ text: string; sha256: string }> {
  const text = (await (await fetchOfficial(url)).text()).replace(/\r\n/g, "\n");
  const digest = sha256(text);
  if (await fileExists(finalPath)) {
    const existing = (await readFile(finalPath, "utf8")).replace(/\r\n/g, "\n");
    if (existing !== text) throw new Error(`Immutable checksum file differs from official source: ${finalPath}`);
  } else {
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(`${finalPath}.part`, text, "utf8");
    await rename(`${finalPath}.part`, finalPath);
  }
  return { text, sha256: digest };
}

async function downloadRangeToFile(url: string, outputPath: string, range: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(outputPath, { force: true });
    try {
      const response = await fetchOfficial(url, range, attempt >= 3);
      await pipeline(response.body, createWriteStream(outputPath));
      await response.complete();
      return;
    } catch (error) {
      lastError = error;
      await rm(outputPath, { force: true });
      if (attempt < 4) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function appendFileWithHash(outputPath: string, chunkPaths: string[]): Promise<{ bytes: number; sha256: string }> {
  const output = createWriteStream(outputPath);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const chunkPath of chunkPaths) {
    for await (const chunk of createReadStream(chunkPath)) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      hash.update(buffer);
      if (!output.write(buffer)) await once(output, "drain");
    }
  }
  output.end();
  await once(output, "close");
  return { bytes, sha256: hash.digest("hex") };
}

async function parallelRangeDownload(url: string, finalPath: string, expectedBytes: number): Promise<{ bytes: number; sha256: string }> {
  const temporary = `${finalPath}.part`;
  const chunkCount = Math.min(48, Math.max(4, Math.ceil(expectedBytes / (16 * 1024 * 1024))));
  const chunkSize = Math.ceil(expectedBytes / chunkCount);
  const chunkPaths = Array.from({ length: chunkCount }, (_, index) => `${temporary}.${index}`);
  await rm(temporary, { force: true });
  try {
    await Promise.all(chunkPaths.map((chunkPath, index) => {
      const start = index * chunkSize;
      const end = Math.min(expectedBytes - 1, start + chunkSize - 1);
      return downloadRangeToFile(url, chunkPath, `${start}-${end}`).then(async () => {
        const size = (end - start) + 1;
        const actual = await stat(chunkPath);
        if (actual.size !== size) throw new Error(`Official Range returned ${actual.size} bytes, expected ${size}: ${url} ${start}-${end}`);
      });
    }));
    const result = await appendFileWithHash(temporary, chunkPaths);
    await rename(temporary, finalPath);
    return result;
  } finally {
    await Promise.all(chunkPaths.map((chunkPath) => rm(chunkPath, { force: true })));
  }
}

async function streamDownload(url: string, finalPath: string, expectedBytes: number | null): Promise<{ bytes: number; sha256: string }> {
  if (await fileExists(finalPath)) {
    const existing = await stat(finalPath);
    const actualSha256 = await sha256File(finalPath);
    if (expectedBytes !== null && existing.size !== expectedBytes) throw new Error(`Existing archive size differs from official listing: ${finalPath}`);
    return { bytes: existing.size, sha256: actualSha256 };
  }
  if (expectedBytes !== null && expectedBytes >= 20 * 1024 * 1024) return parallelRangeDownload(url, finalPath, expectedBytes);
  const response = await fetchOfficial(url);
  await mkdir(dirname(finalPath), { recursive: true });
  const temporary = `${finalPath}.part`;
  await rm(temporary, { force: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response.body, hashing, createWriteStream(temporary));
  await response.complete();
  const actualSha256 = hash.digest("hex");
  if (expectedBytes !== null && bytes !== expectedBytes) {
    await rm(temporary, { force: true });
    throw new Error(`Downloaded archive size differs from official listing: ${url}`);
  }
  await rename(temporary, finalPath);
  return { bytes, sha256: actualSha256 };
}

async function readExistingManifest(): Promise<CacheManifest | null> {
  if (!(await fileExists(V16_CACHE_MANIFEST))) return null;
  return JSON.parse(await readFile(V16_CACHE_MANIFEST, "utf8")) as CacheManifest;
}

function initialMaterializationRecord(record: OfficialArchiveRecord): ArchiveMaterializationRecord {
  if (record.availability === "OFFICIAL_UNAVAILABLE") {
    return { ...record, status: "OFFICIAL_UNAVAILABLE", checksumVerified: false, expectedSha256: null, actualSha256: null, bytes: null, checksumTextSha256: null, materializedAt: null, error: null };
  }
  if (record.availability === "CHECKSUM_UNAVAILABLE") {
    return { ...record, status: "CHECKSUM_UNAVAILABLE", checksumVerified: false, expectedSha256: null, actualSha256: null, bytes: null, checksumTextSha256: null, materializedAt: null, error: "Official ZIP exists but official .CHECKSUM was not listed" };
  }
  return { ...record, status: "MATERIALIZATION_FAILED", checksumVerified: false, expectedSha256: null, actualSha256: null, bytes: null, checksumTextSha256: null, materializedAt: null, error: null };
}

export async function materializeOfficialArchives(options: MaterializationOptions = {}): Promise<CacheManifest> {
  const existingInventory = await readFile(V16_OFFICIAL_INVENTORY, "utf8").catch(() => null);
  const inventory = existingInventory === null ? await enumerateOfficialArchives() : JSON.parse(existingInventory) as OfficialInventory;
  if (existingInventory !== null && (inventory.schema !== "v16-official-inventory-v1" || inventory.enumerationComplete !== true)) throw new Error("Existing official inventory is not a complete immutable enumeration");
  if (existingInventory === null) await writeJson(V16_OFFICIAL_INVENTORY, inventory);
  const inventorySha256 = sha256(JSON.stringify(inventory));
  const existing = await readExistingManifest();
  if (existing && existing.enumerationSha256 !== inventory.enumerationSha256) throw new Error("Immutable V16 cache manifest enumeration differs from current official listing; refusing to overwrite");
  if (existing?.sealed) {
    let sealedArchivesIntact = true;
    for (const record of existing.records) {
      if (record.availability === "AVAILABLE" && (record.status !== "CHECKSUM_VERIFIED" || !(await fileExists(resolve(record.localPath))))) {
        sealedArchivesIntact = false;
        break;
      }
    }
    if (sealedArchivesIntact) return existing;
  }
  const records = new Map<string, ArchiveMaterializationRecord>((existing?.records ?? []).map((record) => [slotKey(record), record]));
  for (const record of inventory.records) if (!records.has(slotKey(record))) records.set(slotKey(record), initialMaterializationRecord(record));
  const manifest: CacheManifest = {
    schema: "v16-cache-manifest-v2",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sealed: false,
    enumerationSha256: inventory.enumerationSha256,
    inventorySha256,
    records: [...records.values()].sort((left, right) => slotKey(left).localeCompare(slotKey(right))),
  };
  await writeJson(V16_CACHE_MANIFEST, manifest);
  let completed = 0;
  for (const record of manifest.records) {
    if (record.availability !== "AVAILABLE") continue;
    if (record.status === "CHECKSUM_VERIFIED") {
      if (await fileExists(resolve(record.localPath))) continue;
      record.status = "MATERIALIZATION_FAILED";
      record.checksumVerified = false;
      record.expectedSha256 = null;
      record.actualSha256 = null;
      record.bytes = null;
      record.checksumTextSha256 = null;
      record.materializedAt = null;
      record.error = "Local archive is missing; re-materializing from the frozen official URL";
    }
    if (options.maxArchives !== undefined && completed >= options.maxArchives) break;
    try {
      const archiveName = record.url.slice(record.url.lastIndexOf("/") + 1);
      const checksumPath = resolve(record.localPath).replace(/\.zip$/, ".zip.CHECKSUM");
      const checksum = await immutableText(record.checksumUrl, checksumPath);
      const expectedSha256 = await parseExpectedChecksum(checksum.text, archiveName);
      const downloaded = await streamDownload(record.url, resolve(record.localPath), record.remoteBytes);
      if (downloaded.sha256 !== expectedSha256) throw new Error(`SHA256 mismatch for ${record.url}: ${downloaded.sha256} !== ${expectedSha256}`);
      record.status = "CHECKSUM_VERIFIED";
      record.checksumVerified = true;
      record.expectedSha256 = expectedSha256;
      record.actualSha256 = downloaded.sha256;
      record.bytes = downloaded.bytes;
      record.checksumTextSha256 = checksum.sha256;
      record.materializedAt = new Date().toISOString();
      record.error = null;
      completed += 1;
    } catch (error) {
      record.status = "MATERIALIZATION_FAILED";
      record.checksumVerified = false;
      record.error = error instanceof Error ? error.message : String(error);
      await writeJson(V16_CACHE_MANIFEST, manifest);
      if (options.stopOnError !== false) throw error;
    }
    manifest.updatedAt = new Date().toISOString();
    await writeJson(V16_CACHE_MANIFEST, manifest);
  }
  if (manifest.records.filter((record) => record.availability === "AVAILABLE").every((record) => record.status === "CHECKSUM_VERIFIED")) {
    manifest.sealed = true;
    manifest.updatedAt = new Date().toISOString();
    await writeJson(V16_CACHE_MANIFEST, manifest);
  }
  return manifest;
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePositiveNumber(value: string | undefined): number | null {
  const number = parseFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === "0" || value?.toLowerCase() === "false") return false;
  if (value === "1" || value?.toLowerCase() === "true") return true;
  return null;
}

export interface ParsedAggTradeRow {
  aggregateTradeId: number;
  price: number;
  quantity: number;
  firstTradeId: number;
  lastTradeId: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export function parseAggTradeFields(fields: string[]): ParsedAggTradeRow | null {
  const aggregateTradeId = parseFiniteNumber(fields[0]);
  const price = parsePositiveNumber(fields[1]);
  const quantity = parsePositiveNumber(fields[2]);
  const firstTradeId = parseFiniteNumber(fields[3]);
  const lastTradeId = parseFiniteNumber(fields[4]);
  const timestamp = parseFiniteNumber(fields[5]);
  const isBuyerMaker = parseBoolean(fields[6]);
  if (aggregateTradeId === null || price === null || quantity === null || firstTradeId === null || lastTradeId === null || timestamp === null || isBuyerMaker === null) return null;
  return { aggregateTradeId, price, quantity, firstTradeId, lastTradeId, timestamp, isBuyerMaker };
}

async function streamArchiveLines(path: string, onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("tar.exe", ["-xOf", path], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    const input = createInterface({ input: child.stdout });
    input.on("line", onLine);
    input.on("close", () => {
      child.once("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`tar failed for ${path}: ${code} ${stderr.trim()}`));
      });
    });
  });
}

function monthBounds(month: string): { start: number; endExclusive: number } {
  const start = Date.parse(`${month}-01T00:00:00.000Z`);
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, endExclusive: date.getTime() };
}

function expectedKlineRows(month: string, intervalMs: number): number {
  const bounds = monthBounds(month);
  return Math.floor((bounds.endExclusive - bounds.start) / intervalMs);
}

function newSymbolSummary(): SymbolParserSummary {
  return {
    aggTradeMonths: 0, aggTradeRows: 0, aggTradeValidRows: 0, aggTradeFirstTimestamp: null, aggTradeLastTimestamp: null, aggTradeTimestampMonotonic: true, aggTradeIdMonotonic: true, aggTradeDuplicateAggregateTradeIds: 0, aggTradeDuplicateRows: 0,
    aggTradeFieldValidity: true,
    kline1mMonths: 0, kline1mRows: 0, kline1mValidRows: 0, kline1mExpectedRows: 0,
    kline5mMonths: 0, kline5mRows: 0, kline5mValidRows: 0, kline5mExpectedRows: 0, kline5mTimestampMonotonic: true, kline5mCadenceValid: true, kline5mCloseTimeValid: true,
    fundingMonths: 0, fundingRows: 0, fundingValidRows: 0, fundingInvalidRows: 0, markMonths: 0, markRows: 0, markValidRows: 0,
  };
}

function newAggReport(symbol: V16Symbol, month: string): AggTradeMonthReport {
  return { dataset: "aggTrades", symbol, month, rows: 0, validRows: 0, firstAggregateTradeId: null, lastAggregateTradeId: null, firstTimestamp: null, lastTimestamp: null, maxTimestampGapMs: null, timestampMonotonic: true, idMonotonic: true, duplicateAggregateTradeIds: 0, duplicateTradeRows: 0, invalidPriceQuantity: 0, invalidBuyerMaker: 0, parseErrors: 0 };
}

function newKlineReport(dataset: KlineMonthReport["dataset"], symbol: V16Symbol, month: string, intervalMs: number): KlineMonthReport {
  return { dataset, symbol, month, intervalMs, rows: 0, validRows: 0, firstOpenTime: null, lastOpenTime: null, duplicateRows: 0, invalidRows: 0, openTimeMonotonic: true, cadenceValid: true, closeTimeValid: true };
}

function newFundingReport(symbol: V16Symbol, month: string): FundingMonthReport {
  return { dataset: "fundingRate", symbol, month, rows: 0, validRows: 0, firstTimestamp: null, lastTimestamp: null, invalidRows: 0, timestampMonotonic: true };
}

export async function parseMaterializedArchives(manifest: CacheManifest): Promise<ParserReport> {
  const validRecords = manifest.records.filter((record) => record.status === "CHECKSUM_VERIFIED" && record.checksumVerified);
  const bySymbol: Record<V16Symbol, SymbolParserSummary> = { BTCUSDT: newSymbolSummary(), ETHUSDT: newSymbolSummary() };
  const aggTrades: AggTradeMonthReport[] = [];
  const klines: KlineMonthReport[] = [];
  const funding: FundingMonthReport[] = [];
  const aggBins: Record<V16Symbol, Set<number>> = { BTCUSDT: new Set(), ETHUSDT: new Set() };
  const fiveMinuteBars: Record<V16Symbol, Set<number>> = { BTCUSDT: new Set(), ETHUSDT: new Set() };
  const markBars: Record<V16Symbol, Set<number>> = { BTCUSDT: new Set(), ETHUSDT: new Set() };
  const fundingRows: Record<V16Symbol, number[]> = { BTCUSDT: [], ETHUSDT: [] };
  const previousAggId: Record<V16Symbol, number | null> = { BTCUSDT: null, ETHUSDT: null };
  const previousAggTimestamp: Record<V16Symbol, number | null> = { BTCUSDT: null, ETHUSDT: null };

  const ordered = [...validRecords].sort((left, right) => slotKey(left).localeCompare(slotKey(right)));
  for (const record of ordered) {
    const archivePath = resolve(record.localPath);
    if (record.dataset === "aggTrades") {
      const report = newAggReport(record.symbol, record.month);
      let previousId: number | null = null;
      let previousTimestamp: number | null = null;
      let previousLine: string | null = null;
      await streamArchiveLines(archivePath, (line) => {
        if (!line.trim()) return;
        if (line.toLowerCase().startsWith("agg_trade_id")) return;
        report.rows += 1;
        const fields = line.split(",");
        const id = parseFiniteNumber(fields[0]);
        const price = parsePositiveNumber(fields[1]);
        const quantity = parsePositiveNumber(fields[2]);
        const timestamp = parseFiniteNumber(fields[5]);
        const maker = parseBoolean(fields[6]);
        const firstTradeId = parseFiniteNumber(fields[3]);
        const lastTradeId = parseFiniteNumber(fields[4]);
        if (id === null || timestamp === null || price === null || quantity === null || firstTradeId === null || lastTradeId === null) { report.invalidPriceQuantity += 1; report.parseErrors += 1; return; }
        if (maker === null) { report.invalidBuyerMaker += 1; report.parseErrors += 1; return; }
        if (previousId !== null) { if (id < previousId) report.idMonotonic = false; if (id === previousId) report.duplicateAggregateTradeIds += 1; }
        if (previousTimestamp !== null) { if (timestamp < previousTimestamp) report.timestampMonotonic = false; const gap = timestamp - previousTimestamp; report.maxTimestampGapMs = report.maxTimestampGapMs === null ? gap : Math.max(report.maxTimestampGapMs, gap); }
        if (previousLine === line) report.duplicateTradeRows += 1;
        previousId = id; previousTimestamp = timestamp; previousLine = line;
        report.firstAggregateTradeId ??= id; report.lastAggregateTradeId = id; report.firstTimestamp ??= timestamp; report.lastTimestamp = timestamp; report.validRows += 1;
        const bucket = Math.floor(timestamp / 900_000) * 900_000;
        aggBins[record.symbol].add(bucket);
      });
      aggTrades.push(report);
      const summary = bySymbol[record.symbol]; summary.aggTradeMonths += 1; summary.aggTradeRows += report.rows; summary.aggTradeValidRows += report.validRows; summary.aggTradeTimestampMonotonic &&= report.timestampMonotonic; summary.aggTradeIdMonotonic &&= report.idMonotonic; summary.aggTradeFieldValidity &&= report.invalidPriceQuantity === 0 && report.invalidBuyerMaker === 0 && report.parseErrors === 0; summary.aggTradeDuplicateAggregateTradeIds += report.duplicateAggregateTradeIds; summary.aggTradeDuplicateRows += report.duplicateTradeRows; if (previousAggId[record.symbol] !== null && report.firstAggregateTradeId !== null) { if (report.firstAggregateTradeId < previousAggId[record.symbol]!) summary.aggTradeIdMonotonic = false; if (report.firstAggregateTradeId === previousAggId[record.symbol]!) summary.aggTradeDuplicateAggregateTradeIds += 1; } if (previousAggTimestamp[record.symbol] !== null && report.firstTimestamp !== null && report.firstTimestamp < previousAggTimestamp[record.symbol]!) summary.aggTradeTimestampMonotonic = false; if (report.firstAggregateTradeId !== null) previousAggId[record.symbol] = report.lastAggregateTradeId; if (report.firstTimestamp !== null) previousAggTimestamp[record.symbol] = report.lastTimestamp; if (report.firstTimestamp !== null) summary.aggTradeFirstTimestamp = summary.aggTradeFirstTimestamp === null ? report.firstTimestamp : Math.min(summary.aggTradeFirstTimestamp, report.firstTimestamp); if (report.lastTimestamp !== null) summary.aggTradeLastTimestamp = summary.aggTradeLastTimestamp === null ? report.lastTimestamp : Math.max(summary.aggTradeLastTimestamp, report.lastTimestamp);
      continue;
    }
    if (record.dataset === "fundingRate") {
      const report = newFundingReport(record.symbol, record.month);
      let previousTimestamp: number | null = null;
      await streamArchiveLines(archivePath, (line) => {
        if (!line.trim() || line.toLowerCase().startsWith("calc_time")) return;
        report.rows += 1;
        const fields = line.split(","); const timestamp = parseFiniteNumber(fields[0]); const rate = parseFiniteNumber(fields[2]);
        if (timestamp === null || rate === null) { report.invalidRows += 1; return; }
        if (previousTimestamp !== null && timestamp < previousTimestamp) report.timestampMonotonic = false;
        previousTimestamp = timestamp; report.firstTimestamp ??= timestamp; report.lastTimestamp = timestamp; report.validRows += 1; fundingRows[record.symbol].push(timestamp);
      });
      funding.push(report);
      const summary = bySymbol[record.symbol]; summary.fundingMonths += 1; summary.fundingRows += report.rows; summary.fundingValidRows += report.validRows; summary.fundingInvalidRows += report.invalidRows;
      continue;
    }
    const isMark = record.dataset === "markPriceKlines";
    const intervalMs = record.dataset === "klines-1m" ? 60_000 : 300_000;
    const report = newKlineReport(record.dataset, record.symbol, record.month, intervalMs);
    let previousOpen: number | null = null;
    let previousLine: string | null = null;
    await streamArchiveLines(archivePath, (line) => {
      if (!line.trim()) return;
      const fields = line.split(",");
      report.rows += 1;
      const openTime = parseFiniteNumber(fields[0]); const openPrice = parseFiniteNumber(fields[1]); const high = parseFiniteNumber(fields[2]); const low = parseFiniteNumber(fields[3]); const close = parseFiniteNumber(fields[4]); const volume = parseFiniteNumber(fields[5]); const closeTime = parseFiniteNumber(fields[6]); const quoteVolume = parseFiniteNumber(fields[7]);
      const valid = openTime !== null && openPrice !== null && high !== null && low !== null && close !== null && volume !== null && quoteVolume !== null && closeTime !== null && high >= low && high >= openPrice && high >= close && low <= openPrice && low <= close && volume >= 0 && quoteVolume >= 0;
      if (!valid) { report.invalidRows += 1; return; }
      if (previousOpen !== null) { if (openTime < previousOpen) report.openTimeMonotonic = false; if (openTime - previousOpen !== intervalMs) report.cadenceValid = false; }
      if (previousLine === line) report.duplicateRows += 1;
      if (closeTime !== openTime + intervalMs - 1) report.closeTimeValid = false;
      previousOpen = openTime; previousLine = line; report.firstOpenTime ??= openTime; report.lastOpenTime = openTime; report.validRows += 1;
      if (record.dataset === "klines-5m") fiveMinuteBars[record.symbol].add(openTime);
      if (isMark) markBars[record.symbol].add(openTime);
    });
    klines.push(report);
    const summary = bySymbol[record.symbol];
    if (record.dataset === "klines-1m") { summary.kline1mMonths += 1; summary.kline1mRows += report.rows; summary.kline1mValidRows += report.validRows; summary.kline1mExpectedRows += expectedKlineRows(record.month, 60_000); }
    if (record.dataset === "klines-5m") { summary.kline5mMonths += 1; summary.kline5mRows += report.rows; summary.kline5mValidRows += report.validRows; summary.kline5mExpectedRows += expectedKlineRows(record.month, intervalMs); summary.kline5mTimestampMonotonic &&= report.openTimeMonotonic; summary.kline5mCadenceValid &&= report.cadenceValid; summary.kline5mCloseTimeValid &&= report.closeTimeValid; }
    if (isMark) { summary.markMonths += 1; summary.markRows += report.rows; summary.markValidRows += report.validRows; }
  }

  const decisionStart = Date.parse("2022-01-01T00:00:00.000Z");
  const decisionEnd = Date.parse(V16_END);
  const featureCoverage = {} as Record<V16Symbol, number>;
  const executionPriceCoverage = {} as Record<V16Symbol, number>;
  for (const symbol of V16_SYMBOLS) {
    let total = 0; let featureValid = 0; let executionValid = 0;
    for (let timestamp = decisionStart; timestamp <= decisionEnd; timestamp += 900_000) {
      total += 1;
      const barsValid = [1, 2, 3, 4, 5, 6].every((offset) => fiveMinuteBars[symbol].has(timestamp - offset * 300_000));
      const flowValid = aggBins[symbol].has(timestamp - 900_000) || aggBins[symbol].has(timestamp - 1_800_000);
      if (barsValid && flowValid) featureValid += 1;
      if (fiveMinuteBars[symbol].has(timestamp + 300_000)) executionValid += 1;
    }
    featureCoverage[symbol] = total === 0 ? 0 : featureValid / total;
    executionPriceCoverage[symbol] = total === 0 ? 0 : executionValid / total;
  }

  const fundingSettlement: FundingSettlementCoverage = { required: 0, covered: 0, coverage: 0, uncovered: [] };
  const markSettlement: FundingSettlementCoverage = { required: 0, covered: 0, coverage: 0, uncovered: [] };
  for (const symbol of V16_SYMBOLS) for (const timestamp of fundingRows[symbol]) {
    if (timestamp < decisionStart || timestamp > decisionEnd) continue;
    fundingSettlement.required += 1; markSettlement.required += 1;
    const markBar = Math.floor(timestamp / 300_000) * 300_000;
    const covered = markBars[symbol].has(markBar);
    if (covered) { fundingSettlement.covered += 1; markSettlement.covered += 1; }
    else { if (fundingSettlement.uncovered.length < 100) fundingSettlement.uncovered.push({ symbol, timestamp }); if (markSettlement.uncovered.length < 100) markSettlement.uncovered.push({ symbol, timestamp }); }
  }
  fundingSettlement.coverage = fundingSettlement.required === 0 ? 0 : fundingSettlement.covered / fundingSettlement.required;
  markSettlement.coverage = markSettlement.required === 0 ? 0 : markSettlement.covered / markSettlement.required;
  const duplicateFree: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  const klineCadence: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  const timestampMonotonicity: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  const aggTradeIdMonotonicity: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  const aggTradeFieldValidity: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  const fundingFieldValidity: Record<V16Symbol, boolean> = { BTCUSDT: false, ETHUSDT: false };
  for (const symbol of V16_SYMBOLS) {
    const summary = bySymbol[symbol];
    duplicateFree[symbol] = summary.aggTradeDuplicateAggregateTradeIds === 0 && summary.aggTradeDuplicateRows === 0 && klines.filter((item) => item.symbol === symbol).every((item) => item.duplicateRows === 0);
    klineCadence[symbol] = summary.kline5mCadenceValid && summary.kline5mCloseTimeValid;
    timestampMonotonicity[symbol] = summary.aggTradeTimestampMonotonic;
    aggTradeIdMonotonicity[symbol] = summary.aggTradeIdMonotonic;
    aggTradeFieldValidity[symbol] = summary.aggTradeFieldValidity;
    fundingFieldValidity[symbol] = summary.fundingInvalidRows === 0;
  }
  return {
    schema: "v16-parser-report-v1",
    generatedAt: new Date().toISOString(),
    source: { cacheManifest: "data/raw/v16-aggtrade-absorption/manifest.json", noSyntheticData: true, noV15Substitute: true },
    months: v16Months(), bySymbol, aggTrades, klines, funding, featureCoverage, executionPriceCoverage, fundingSettlement, markSettlement,
    fiveMinuteBarCounts: { BTCUSDT: fiveMinuteBars.BTCUSDT.size, ETHUSDT: fiveMinuteBars.ETHUSDT.size },
    proofs: { timestampMonotonicity, aggTradeIdMonotonicity, aggTradeFieldValidity, fundingFieldValidity, duplicateFree, klineCadence, noSyntheticData: true },
  };
}

export async function loadCacheManifest(): Promise<CacheManifest> {
  return JSON.parse(await readFile(V16_CACHE_MANIFEST, "utf8")) as CacheManifest;
}

export async function writeCacheManifest(manifest: CacheManifest): Promise<void> {
  await writeJson(V16_CACHE_MANIFEST, manifest);
}
