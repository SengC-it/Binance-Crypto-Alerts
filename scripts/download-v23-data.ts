import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { V23_END_MS, V23_INTERVAL_MS, V23_START_MS, V23_TARGET_SYMBOLS, V23_UNDERLYINGS, type V23Underlying } from "@/lib/v23/types";
import type { V23ApiEntry, V23ArchiveEntry, V23DownloadManifest } from "@/lib/v23/data";

const RAW_ROOT = resolve("data/raw/v23");
const MANIFEST_PATH = resolve(RAW_ROOT, "v23-download-manifest.json");
const ARCHIVE_BASE = "https://data.binance.vision/data/futures/um/monthly";
const API_BASE = "https://fapi.binance.com";
const MONTH_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit" });

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function monthsInRange(): string[] {
  const result: string[] = [];
  for (let timestamp = V23_START_MS; timestamp < V23_END_MS; timestamp = Date.UTC(new Date(timestamp).getUTCFullYear(), new Date(timestamp).getUTCMonth() + 1, 1)) result.push(MONTH_FORMAT.format(new Date(timestamp)));
  return result;
}

async function saveBytes(relativePath: string, body: Uint8Array): Promise<void> {
  const target = resolve(RAW_ROOT, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

interface FetchResult {
  status: number;
  bytes: Uint8Array;
  error: string | null;
  retrievedAt: string;
}

async function fetchBytes(url: string): Promise<FetchResult> {
  const retrievedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), error: null, retrievedAt };
  } catch (error) {
    return { status: 0, bytes: new Uint8Array(), error: error instanceof Error ? error.message : String(error), retrievedAt };
  }
}

function checksumValue(text: string): string | null {
  return text.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase() ?? null;
}

async function downloadArchive(underlying: V23Underlying, seriesType: "TARGET_USDM_PERPETUAL" | "INDEX_PRICE", month: string): Promise<V23ArchiveEntry> {
  const archiveType = seriesType === "TARGET_USDM_PERPETUAL" ? "klines" : "indexPriceKlines";
  const symbol = V23_TARGET_SYMBOLS[underlying];
  const fileName = `${symbol}-1h-${month}.zip`;
  const sourceUrl = `${ARCHIVE_BASE}/${archiveType}/${symbol}/1h/${fileName}`;
  const checksumUrl = `${sourceUrl}.CHECKSUM`;
  const bodyPath = `archives/${seriesType}/${underlying}/${fileName}`;
  const checksumPath = `${bodyPath}.CHECKSUM`;
  const archiveResponse = await fetchBytes(sourceUrl);
  const checksumResponse = await fetchBytes(checksumUrl);
  await saveBytes(bodyPath, archiveResponse.bytes);
  await saveBytes(checksumPath, checksumResponse.bytes);
  const expectedZipSha256 = checksumResponse.status === 200 ? checksumValue(new TextDecoder().decode(checksumResponse.bytes)) : null;
  return {
    underlying,
    seriesType,
    month,
    bodyPath,
    checksumPath,
    sourceUrl,
    checksumUrl,
    httpStatus: archiveResponse.status,
    responseByteLength: archiveResponse.bytes.byteLength,
    responseSha256: sha256(archiveResponse.bytes),
    expectedZipSha256,
    checksumVerified: archiveResponse.status === 200 && checksumResponse.status === 200 && expectedZipSha256 === sha256(archiveResponse.bytes),
  };
}

async function downloadContinuousSeries(underlying: V23Underlying, seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER"): Promise<V23ApiEntry[]> {
  const pair = V23_TARGET_SYMBOLS[underlying];
  const entries: V23ApiEntry[] = [];
  let startTime = V23_START_MS;
  let chunkIndex = 0;
  while (startTime < V23_END_MS && chunkIndex < 100) {
    const parameters = { pair, contractType: seriesType, interval: "1h", startTime: String(startTime), endTime: String(V23_END_MS - 1), limit: "1500" };
    const query = new URLSearchParams(parameters);
    const sourceUrl = `${API_BASE}/fapi/v1/continuousKlines?${query.toString()}`;
    const response = await fetchBytes(sourceUrl);
    const bodyPath = `api/${seriesType}/${underlying}/chunk-${String(chunkIndex).padStart(3, "0")}.json`;
    await saveBytes(bodyPath, response.bytes);
    let parsedRows: unknown[] = [];
    let error: string | null = response.error;
    if (response.status === 200) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
        if (!Array.isArray(parsed)) error = "continuous endpoint response was not an array";
        else parsedRows = parsed;
      } catch (parseError) {
        error = parseError instanceof Error ? parseError.message : String(parseError);
      }
    } else if (!error) error = `HTTP ${response.status}`;
    entries.push({ underlying, seriesType, bodyPath, sourceUrl, requestParameters: parameters, httpStatus: response.status, responseByteLength: response.bytes.byteLength, responseSha256: sha256(response.bytes), rows: parsedRows.length, available: response.status === 200 && parsedRows.length > 0, error });
    if (response.status !== 200 || parsedRows.length === 0) break;
    const lastRow = parsedRows[parsedRows.length - 1];
    const lastOpen = Array.isArray(lastRow) ? Number(lastRow[0]) : Number.NaN;
    if (!Number.isFinite(lastOpen) || lastOpen < startTime) break;
    const nextStart = lastOpen + V23_INTERVAL_MS;
    if (nextStart <= startTime) break;
    startTime = nextStart;
    chunkIndex += 1;
  }
  return entries;
}

async function main(): Promise<void> {
  await mkdir(RAW_ROOT, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as V23DownloadManifest;
    if (existing.schema === "v23-download-manifest-v1" && existing.start === new Date(V23_START_MS).toISOString() && existing.endExclusive === new Date(V23_END_MS).toISOString()) {
      console.info(JSON.stringify({ stage: "v23_data_reuse_frozen_manifest", archiveEntries: existing.archiveEntries.length, apiEntries: existing.apiEntries.length }));
      return;
    }
    throw new Error("Existing V23 raw manifest has a different identity; refusing to overwrite frozen data");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      if (error instanceof SyntaxError) throw new Error("Existing V23 raw manifest is not valid JSON; refusing to overwrite frozen data");
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }
  const months = monthsInRange();
  const archiveTasks: Array<() => Promise<V23ArchiveEntry>> = [];
  for (const underlying of V23_UNDERLYINGS) for (const seriesType of ["TARGET_USDM_PERPETUAL", "INDEX_PRICE"] as const) for (const month of months) archiveTasks.push(() => downloadArchive(underlying, seriesType, month));
  const archiveEntries: V23ArchiveEntry[] = [];
  for (let index = 0; index < archiveTasks.length; index += 4) archiveEntries.push(...await Promise.all(archiveTasks.slice(index, index + 4).map((task) => task())));
  const apiEntries: V23ApiEntry[] = [];
  for (const underlying of V23_UNDERLYINGS) for (const seriesType of ["CURRENT_QUARTER", "NEXT_QUARTER"] as const) apiEntries.push(...await downloadContinuousSeries(underlying, seriesType));
  const manifest: V23DownloadManifest = {
    schema: "v23-download-manifest-v1",
    source: "Binance official public data archive and public USD-M REST",
    authenticationRequired: false,
    accountPermissionRequired: false,
    tradingPermissionRequired: false,
    start: new Date(V23_START_MS).toISOString(),
    endExclusive: new Date(V23_END_MS).toISOString(),
    interval: "1h",
    archiveEntries,
    apiEntries,
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v23_data_download_complete", months: months.length, archiveEntries: archiveEntries.length, archiveVerified: archiveEntries.filter((entry) => entry.checksumVerified).length, apiEntries: apiEntries.length, apiAvailable: apiEntries.filter((entry) => entry.available).length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
