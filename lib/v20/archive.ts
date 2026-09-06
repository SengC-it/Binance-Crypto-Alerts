import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  V20_END_EXCLUSIVE_TIMESTAMP,
  V20_INTERVAL_MS,
  V20_START_TIMESTAMP,
  monthPeriod,
  type V20Symbol,
} from "./constants";
import { sha256Bytes } from "./canonical";

export const V20_ARCHIVE_EXCHANGE = "BINANCE_DATA_VISION" as const;
export const V20_ARCHIVE_ROOT = resolve("data/raw/v20/archives");
export const V20_DATA_TYPES = ["regular", "mark", "index"] as const;
export type V20DataType = (typeof V20_DATA_TYPES)[number];
export type V20ArchiveSlotStatus = "VERIFIED" | "MISSING" | "ERROR";

export interface V20Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;
}

export interface V20ArchiveSlot {
  exchange: typeof V20_ARCHIVE_EXCHANGE;
  dataType: V20DataType;
  symbol: V20Symbol;
  month: string;
  periodStart: string;
  periodEndExclusive: string;
  interval: "5m";
  url: string;
  checksumUrl: string;
  status: V20ArchiveSlotStatus;
  bytes: number;
  sha256: string | null;
  expectedSha256: string | null;
  checksumVerified: boolean;
  rowCount: number;
  expectedFullMonthRows: number;
  coverage: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  parserErrors: string[];
  cadenceErrors: number;
  error: string | null;
}

export interface V20ArchiveDownload {
  slot: V20ArchiveSlot;
  bars: V20Bar[];
}

export interface V20ArchiveOptions {
  rootDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function v20ArchiveUrl(dataType: V20DataType, symbol: V20Symbol, month: string): string {
  const directory = dataType === "regular" ? "klines" : `${dataType}PriceKlines`;
  return `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

export function v20ChecksumUrl(dataType: V20DataType, symbol: V20Symbol, month: string): string {
  return `${v20ArchiveUrl(dataType, symbol, month)}.CHECKSUM`;
}

export function parseBinanceKlineCsv(
  text: string,
  symbol: V20Symbol,
  dataType: V20DataType,
  period: { start: number; endExclusive: number },
): { bars: V20Bar[]; errors: string[]; cadenceErrors: number } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const errors: string[] = [];
  const bars: V20Bar[] = [];
  const first = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  const hasHeader = first[0] === "open_time" || first[0] === "open time";
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const seen = new Set<number>();
  let previousOpenTime: number | null = null;

  dataLines.forEach((line, lineIndex) => {
    const values = line.split(",").map((value) => value.trim());
    if (values.length < 7) {
      errors.push(`${symbol}/${dataType}: row ${lineIndex + 1} has ${values.length} columns`);
      return;
    }
    const openTime = Number(values[0]);
    const open = Number(values[1]);
    const high = Number(values[2]);
    const low = Number(values[3]);
    const close = Number(values[4]);
    const closeTime = Number(values[6]);
    const validOhlc = open > 0 && high > 0 && low > 0 && close > 0
      && high >= Math.max(open, close)
      && low <= Math.min(open, close);
    const validTime = Number.isSafeInteger(openTime)
      && Number.isSafeInteger(closeTime)
      && openTime % V20_INTERVAL_MS === 0
      && closeTime === openTime + V20_INTERVAL_MS - 1
      && openTime >= period.start
      && openTime < period.endExclusive;
    const monotonic = previousOpenTime === null || openTime > previousOpenTime;
    if (![openTime, open, high, low, close, closeTime].every(Number.isFinite) || !validOhlc || !validTime || !monotonic || seen.has(openTime)) {
      errors.push(`${symbol}/${dataType}: invalid row ${lineIndex + 1}`);
      return;
    }
    previousOpenTime = openTime;
    seen.add(openTime);
    bars.push({ openTime, open, high, low, close, closeTime });
  });

  let cadenceErrors = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].openTime !== bars[index - 1].openTime + V20_INTERVAL_MS) cadenceErrors += 1;
  }
  return { bars, errors, cadenceErrors };
}

export function extractFirstZipFile(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new Error("ZIP end-of-central-directory record not found");
  const entryCount = readU16(view, eocdOffset + 10);
  const centralDirectoryOffset = readU32(view, eocdOffset + 16);
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(view, cursor) !== 0x02014b50) throw new Error("ZIP central-directory entry not found");
    const compression = readU16(view, cursor + 10);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localHeaderOffset = readU32(view, cursor + 42);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || name.toLowerCase().endsWith(".txt")) continue;
    if (readU32(view, localHeaderOffset) !== 0x04034b50) throw new Error("ZIP local-file header not found");
    const localNameLength = readU16(view, localHeaderOffset + 26);
    const localExtraLength = readU16(view, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let result: Uint8Array;
    if (compression === 0) result = compressed.slice();
    else if (compression === 8) result = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method ${compression}`);
    if (result.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`);
    return result;
  }
  throw new Error("ZIP contains no data file");
}

export async function downloadAndParseV20Archive(
  dataType: V20DataType,
  symbol: V20Symbol,
  month: string,
  options: V20ArchiveOptions = {},
): Promise<V20ArchiveDownload> {
  const rootDir = options.rootDir ?? V20_ARCHIVE_ROOT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const period = monthPeriod(month);
  const url = v20ArchiveUrl(dataType, symbol, month);
  const checksumUrl = v20ChecksumUrl(dataType, symbol, month);
  const baseName = `${dataType}-${symbol}-5m-${month}`;
  const zipPath = resolve(rootDir, `${baseName}.zip`);
  const checksumPath = resolve(rootDir, `${baseName}.CHECKSUM`);
  const slot: V20ArchiveSlot = {
    exchange: V20_ARCHIVE_EXCHANGE,
    dataType,
    symbol,
    month,
    periodStart: new Date(period.start).toISOString(),
    periodEndExclusive: new Date(period.endExclusive).toISOString(),
    interval: "5m",
    url,
    checksumUrl,
    status: "ERROR",
    bytes: 0,
    sha256: null,
    expectedSha256: null,
    checksumVerified: false,
    rowCount: 0,
    expectedFullMonthRows: Math.round((period.endExclusive - period.start) / V20_INTERVAL_MS),
    coverage: 0,
    firstOpenTime: null,
    lastOpenTime: null,
    parserErrors: [],
    cadenceErrors: 0,
    error: null,
  };

  try {
    await mkdir(rootDir, { recursive: true });
    let zipBytes: Uint8Array;
    try {
      zipBytes = new Uint8Array(await readFile(zipPath));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      if (response.status === 404) {
        slot.status = "MISSING";
        slot.error = "OFFICIAL_ARCHIVE_404";
        return { slot, bars: [] };
      }
      if (!response.ok) throw new Error(`archive HTTP ${response.status}`);
      zipBytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(zipPath, zipBytes, { flag: "wx" });
    }
    slot.bytes = zipBytes.byteLength;
    slot.sha256 = sha256Bytes(zipBytes);

    let checksumText: string;
    try {
      checksumText = await readFile(checksumPath, "utf8");
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      const response = await fetchWithTimeout(fetchImpl, checksumUrl, timeoutMs);
      if (!response.ok) throw new Error(`checksum HTTP ${response.status}`);
      checksumText = await response.text();
      await writeFile(checksumPath, checksumText, { flag: "wx" });
    }
    slot.expectedSha256 = parseChecksum(checksumText);
    slot.checksumVerified = slot.expectedSha256 === slot.sha256;
    if (!slot.checksumVerified) {
      slot.error = "ARCHIVE_SHA256_MISMATCH";
      return { slot, bars: [] };
    }

    const csvBytes = extractFirstZipFile(zipBytes);
    const parsed = parseBinanceKlineCsv(new TextDecoder().decode(csvBytes), symbol, dataType, period);
    slot.parserErrors = parsed.errors;
    slot.cadenceErrors = parsed.cadenceErrors;
    slot.rowCount = parsed.bars.length;
    slot.firstOpenTime = parsed.bars[0]?.openTime ?? null;
    slot.lastOpenTime = parsed.bars.at(-1)?.openTime ?? null;
    slot.coverage = slot.expectedFullMonthRows === 0 ? 0 : slot.rowCount / slot.expectedFullMonthRows;
    slot.status = slot.parserErrors.length === 0 && parsed.bars.length > 0 ? "VERIFIED" : "ERROR";
    if (slot.status === "ERROR") slot.error = "PARSER_VALIDATION_FAILED";
    return { slot, bars: parsed.bars };
  } catch (error) {
    slot.error = error instanceof Error ? error.message : String(error);
    slot.status = "ERROR";
    return { slot, bars: [] };
  }
}

export function parseChecksum(value: string): string | null {
  const match = /\b([a-f0-9]{64})\b/i.exec(value);
  return match?.[1].toLowerCase() ?? null;
}

export function expectedPeriodBoundaries(): { start: string; endExclusive: string } {
  return { start: V20_START_TIMESTAMP, endExclusive: V20_END_EXCLUSIVE_TIMESTAMP };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  return fetchImpl(url, signal ? { signal } : undefined);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  return -1;
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error("ZIP header out of bounds");
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error("ZIP header out of bounds");
  return view.getUint32(offset, true);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
