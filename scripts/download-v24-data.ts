import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractZipSingleFile, sha256 } from "@/lib/v24/data";
import {
  V24_END_MS,
  V24_START_MS,
  V24_SYMBOLS,
  type V24ArchiveEntry,
  type V24DownloadManifest,
  type V24Symbol,
  type V24TargetArchiveEntry,
} from "@/lib/v24/types";

const RAW_ROOT = resolve("data/raw/v24");
const MANIFEST_PATH = resolve(RAW_ROOT, "v24-download-manifest.json");
const BOOK_DEPTH_BASE = "https://data.binance.vision/data/futures/um/daily/bookDepth";
const TARGET_BASE = "https://data.binance.vision/data/futures/um/monthly/klines";
const CONCURRENCY = 8;

interface FetchResult {
  status: number;
  bytes: Uint8Array;
  retrievedAt: string;
  error: string | null;
}

async function fetchBytes(url: string): Promise<FetchResult> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retrievedAt = new Date().toISOString();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok || response.status === 404) return { status: response.status, bytes, retrievedAt, error: null };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
  }
  return { status: 0, bytes: new Uint8Array(), retrievedAt: new Date().toISOString(), error: lastError ?? "fetch failed" };
}

async function saveFrozen(relativePath: string, bytes: Uint8Array): Promise<void> {
  const target = resolve(RAW_ROOT, relativePath);
  try {
    const existing = new Uint8Array(await readFile(target));
    if (sha256(existing) !== sha256(bytes)) throw new Error(`Refusing to overwrite frozen raw bytes: ${relativePath}`);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function checksumValue(text: string): string | null {
  return text.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase() ?? null;
}

function rowCount(text: string): number {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.length > 0 && !line.startsWith("timestamp,") && !line.startsWith("open_time,") && !line.startsWith("openTime,")).length;
}

async function downloadBookDepth(symbol: V24Symbol, date: string): Promise<V24ArchiveEntry> {
  const fileName = `${symbol}-bookDepth-${date}.zip`;
  const sourceUrl = `${BOOK_DEPTH_BASE}/${symbol}/${fileName}`;
  const checksumUrl = `${sourceUrl}.CHECKSUM`;
  const bodyPath = `bookDepth/${symbol}/${fileName}`;
  const checksumPath = `${bodyPath}.CHECKSUM`;
  const [archive, checksum] = await Promise.all([fetchBytes(sourceUrl), fetchBytes(checksumUrl)]);
  if (archive.bytes.length > 0) await saveFrozen(bodyPath, archive.bytes);
  if (checksum.bytes.length > 0) await saveFrozen(checksumPath, checksum.bytes);
  const zipSha256 = sha256(archive.bytes);
  const officialChecksum = checksum.status === 200 ? checksumValue(new TextDecoder().decode(checksum.bytes)) : null;
  let archiveEntry: string | null = null;
  let extractedCsvSha256: string | null = null;
  let count = 0;
  let error = archive.error ?? checksum.error;
  if (archive.status === 200 && archive.bytes.length > 0) {
    try {
      const extracted = extractZipSingleFile(archive.bytes);
      archiveEntry = extracted.name;
      extractedCsvSha256 = sha256(extracted.contentBytes);
      count = rowCount(extracted.content);
    } catch (extractionError) {
      error = extractionError instanceof Error ? extractionError.message : String(extractionError);
    }
  } else if (!error) error = `HTTP ${archive.status}`;
  return {
    symbol,
    date,
    sourceUrl,
    checksumUrl,
    bodyPath,
    checksumPath,
    httpStatus: archive.status,
    checksumHttpStatus: checksum.status,
    responseByteLength: archive.bytes.byteLength,
    zipSha256,
    officialChecksum,
    checksumVerified: archive.status === 200 && checksum.status === 200 && officialChecksum === zipSha256,
    archiveEntry,
    extractedCsvSha256,
    rowCount: count,
    retrievedAt: archive.retrievedAt,
    error,
  };
}

async function downloadTarget(symbol: V24Symbol, month: string): Promise<V24TargetArchiveEntry> {
  const fileName = `${symbol}-5m-${month}.zip`;
  const sourceUrl = `${TARGET_BASE}/${symbol}/5m/${fileName}`;
  const checksumUrl = `${sourceUrl}.CHECKSUM`;
  const bodyPath = `klines/${symbol}/${fileName}`;
  const checksumPath = `${bodyPath}.CHECKSUM`;
  const [archive, checksum] = await Promise.all([fetchBytes(sourceUrl), fetchBytes(checksumUrl)]);
  if (archive.bytes.length > 0) await saveFrozen(bodyPath, archive.bytes);
  if (checksum.bytes.length > 0) await saveFrozen(checksumPath, checksum.bytes);
  const zipSha256 = sha256(archive.bytes);
  const officialChecksum = checksum.status === 200 ? checksumValue(new TextDecoder().decode(checksum.bytes)) : null;
  let archiveEntry: string | null = null;
  let extractedCsvSha256: string | null = null;
  let count = 0;
  let error = archive.error ?? checksum.error;
  if (archive.status === 200 && archive.bytes.length > 0) {
    try {
      const extracted = extractZipSingleFile(archive.bytes);
      archiveEntry = extracted.name;
      extractedCsvSha256 = sha256(extracted.contentBytes);
      count = rowCount(extracted.content);
    } catch (extractionError) {
      error = extractionError instanceof Error ? extractionError.message : String(extractionError);
    }
  } else if (!error) error = `HTTP ${archive.status}`;
  return {
    symbol,
    month,
    sourceUrl,
    checksumUrl,
    bodyPath,
    checksumPath,
    httpStatus: archive.status,
    checksumHttpStatus: checksum.status,
    responseByteLength: archive.bytes.byteLength,
    zipSha256,
    officialChecksum,
    checksumVerified: archive.status === 200 && checksum.status === 200 && officialChecksum === zipSha256,
    archiveEntry,
    extractedCsvSha256,
    rowCount: count,
    retrievedAt: archive.retrievedAt,
    error,
  };
}

function datesInRange(): string[] {
  const result: string[] = [];
  for (let timestamp = V24_START_MS; timestamp < V24_END_MS; timestamp += 24 * 60 * 60 * 1000) result.push(new Date(timestamp).toISOString().slice(0, 10));
  return result;
}

function monthsInRange(): string[] {
  const result: string[] = [];
  for (let timestamp = V24_START_MS; timestamp < V24_END_MS; timestamp = Date.UTC(new Date(timestamp).getUTCFullYear(), new Date(timestamp).getUTCMonth() + 1, 1)) result.push(new Date(timestamp).toISOString().slice(0, 7));
  return result;
}

async function runPool<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const result = new Array<T>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      result[index] = await tasks[index]!();
      if ((index + 1) % 100 === 0 || index + 1 === tasks.length) console.info(JSON.stringify({ stage: "v24_download_progress", completed: index + 1, total: tasks.length }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
  return result;
}

async function manifestExists(): Promise<boolean> {
  try {
    const existing = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as V24DownloadManifest;
    if (existing.schema !== "v24-download-manifest-v1" || existing.start !== new Date(V24_START_MS).toISOString() || existing.endExclusive !== new Date(V24_END_MS).toISOString() || existing.symbols.join(",") !== V24_SYMBOLS.join(",")) throw new Error("Existing V24 raw manifest has a different identity; refusing to overwrite frozen data");
    console.info(JSON.stringify({ stage: "v24_data_reuse_frozen_manifest", bookDepthEntries: existing.bookDepthEntries.length, targetEntries: existing.targetEntries.length }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    if (error instanceof SyntaxError) throw new Error("Existing V24 raw manifest is not valid JSON; refusing to overwrite frozen data");
    throw error;
  }
}

async function main(): Promise<void> {
  await mkdir(RAW_ROOT, { recursive: true });
  if (await manifestExists()) return;
  const dates = datesInRange();
  const months = monthsInRange();
  const bookTasks: Array<() => Promise<V24ArchiveEntry>> = [];
  for (const symbol of V24_SYMBOLS) for (const date of dates) bookTasks.push(() => downloadBookDepth(symbol, date));
  const targetTasks: Array<() => Promise<V24TargetArchiveEntry>> = [];
  for (const symbol of V24_SYMBOLS) for (const month of months) targetTasks.push(() => downloadTarget(symbol, month));
  const bookDepthEntries = await runPool(bookTasks);
  const targetEntries = await runPool(targetTasks);
  const manifest: V24DownloadManifest = {
    schema: "v24-download-manifest-v1",
    source: "Binance official Data Vision USD-M daily bookDepth and 5m klines",
    authenticationRequired: false,
    accountPermissionRequired: false,
    tradingPermissionRequired: false,
    start: new Date(V24_START_MS).toISOString(),
    endExclusive: new Date(V24_END_MS).toISOString(),
    bookDepthCadence: "30s",
    targetInterval: "5m",
    symbols: V24_SYMBOLS,
    bookDepthEntries,
    targetEntries,
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v24_data_download_complete", dates: dates.length, months: months.length, bookDepthEntries: bookDepthEntries.length, bookDepthVerified: bookDepthEntries.filter((entry) => entry.checksumVerified).length, targetEntries: targetEntries.length, targetVerified: targetEntries.filter((entry) => entry.checksumVerified).length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
