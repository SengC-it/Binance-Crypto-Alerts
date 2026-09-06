import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  monthPeriod,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_INTERVAL_MS,
  V21_MONTH_COUNT,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  type V21Symbol,
} from "./constants";
import { sha256Bytes } from "./canonical";

export const V21_ARCHIVE_EXCHANGE = "BINANCE_DATA_VISION" as const;
export const V21_ARCHIVE_ROOT = resolve("data/raw/v21/archives");
export const V21_DATA_TYPE = "regular" as const;

export type V21ArchiveSlotStatus = "VERIFIED" | "MISSING" | "ERROR";

export interface V21Bar {
  symbol: V21Symbol;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;
}

export interface V21ArchiveSlot {
  exchange: typeof V21_ARCHIVE_EXCHANGE;
  dataType: typeof V21_DATA_TYPE;
  symbol: V21Symbol;
  month: string;
  periodStart: string;
  periodEndExclusive: string;
  interval: "5m";
  url: string;
  checksumUrl: string;
  status: V21ArchiveSlotStatus;
  bytes: number;
  sha256: string | null;
  expectedSha256: string | null;
  checksumVerified: boolean;
  rowCount: number;
  expectedMonthRows: number;
  coverage: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  parserErrors: string[];
  duplicateOpenTimes: number;
  cadenceErrors: number;
  monotonicOpenTime: boolean;
  error: string | null;
}

export interface V21ArchiveDownload {
  slot: V21ArchiveSlot;
  bars: V21Bar[];
}

export interface V21ArchiveOptions {
  rootDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface V21SymbolCoverage {
  symbol: V21Symbol;
  expectedArchiveSlots: number;
  archiveSlots: number;
  checksumVerifiedArchiveSlots: number;
  expectedRows: number;
  combinedRows: number;
  coverage: number;
  parserErrors: number;
  duplicateOpenTimes: number;
  internalGaps: number;
  monotonic: boolean;
  pass: boolean;
}

export function v21ArchiveUrl(symbol: V21Symbol, month: string): string {
  return `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

export function v21ChecksumUrl(symbol: V21Symbol, month: string): string {
  return `${v21ArchiveUrl(symbol, month)}.CHECKSUM`;
}

export function parseBinanceKlineCsv(
  text: string,
  symbol: V21Symbol,
  period: { start: number; endExclusive: number },
): {
  bars: V21Bar[];
  errors: string[];
  duplicateOpenTimes: number;
  cadenceErrors: number;
  monotonicOpenTime: boolean;
} {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const firstValues = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  const hasHeader = firstValues[0] === "open_time" || firstValues[0] === "open time";
  const errors: string[] = [];
  const bars: V21Bar[] = [];
  const seen = new Set<number>();
  let previousOpenTime: number | null = null;
  let monotonicOpenTime = true;
  let duplicateOpenTimes = 0;

  lines.slice(hasHeader ? 1 : 0).forEach((line, lineIndex) => {
    const values = line.split(",").map((value) => value.trim());
    if (values.length < 7) {
      errors.push(`row ${lineIndex + 1}: expected at least 7 columns, got ${values.length}`);
      return;
    }

    const openTime = Number(values[0]);
    const open = Number(values[1]);
    const high = Number(values[2]);
    const low = Number(values[3]);
    const close = Number(values[4]);
    const closeTime = Number(values[6]);
    const safeTimes = Number.isSafeInteger(openTime) && Number.isSafeInteger(closeTime);
    if (safeTimes) {
      if (previousOpenTime !== null && openTime <= previousOpenTime) monotonicOpenTime = false;
      if (seen.has(openTime)) duplicateOpenTimes += 1;
      seen.add(openTime);
      previousOpenTime = openTime;
    }

    const validOhlc = [open, high, low, close].every((value) => Number.isFinite(value) && value > 0)
      && high >= Math.max(open, close)
      && low <= Math.min(open, close);
    const validTime = safeTimes
      && openTime % V21_INTERVAL_MS === 0
      && closeTime === openTime + V21_INTERVAL_MS - 1
      && openTime >= period.start
      && openTime < period.endExclusive;
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || !validOhlc || !validTime || !monotonicRow(bars, openTime)) {
      errors.push(`row ${lineIndex + 1}: invalid timestamp or OHLC`);
      return;
    }
    bars.push({ symbol, openTime, open, high, low, close, closeTime });
  });

  let cadenceErrors = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].openTime !== bars[index - 1].openTime + V21_INTERVAL_MS) cadenceErrors += 1;
  }

  return { bars, errors, duplicateOpenTimes, cadenceErrors, monotonicOpenTime };
}

export function parseChecksum(value: string): string | null {
  return /\b([a-f0-9]{64})\b/i.exec(value)?.[1].toLowerCase() ?? null;
}

export function evaluateV21SymbolCoverage(
  symbol: V21Symbol,
  slots: readonly V21ArchiveSlot[],
): V21SymbolCoverage {
  const symbolSlots = slots.filter((slot) => slot.symbol === symbol);
  const combinedRows = symbolSlots.reduce((sum, slot) => sum + slot.rowCount, 0);
  const parserErrors = symbolSlots.reduce((sum, slot) => sum + slot.parserErrors.length, 0);
  const duplicateOpenTimes = symbolSlots.reduce((sum, slot) => sum + slot.duplicateOpenTimes, 0);
  const internalGaps = symbolSlots.reduce((sum, slot) => sum + slot.cadenceErrors, 0);
  const monotonic = symbolSlots.every((slot) => slot.monotonicOpenTime);
  const checksumVerifiedArchiveSlots = symbolSlots.filter((slot) => slot.checksumVerified).length;
  return {
    symbol,
    expectedArchiveSlots: V21_MONTH_COUNT,
    archiveSlots: symbolSlots.length,
    checksumVerifiedArchiveSlots,
    expectedRows: V21_EXPECTED_ROWS_PER_SYMBOL,
    combinedRows,
    coverage: V21_EXPECTED_ROWS_PER_SYMBOL === 0 ? 0 : combinedRows / V21_EXPECTED_ROWS_PER_SYMBOL,
    parserErrors,
    duplicateOpenTimes,
    internalGaps,
    monotonic,
    pass: symbolSlots.length === V21_MONTH_COUNT
      && checksumVerifiedArchiveSlots === V21_MONTH_COUNT
      && combinedRows === V21_EXPECTED_ROWS_PER_SYMBOL
      && parserErrors === 0
      && duplicateOpenTimes === 0
      && internalGaps === 0
      && monotonic,
  };
}

export async function downloadAndParseV21Archive(
  symbol: V21Symbol,
  month: string,
  options: V21ArchiveOptions = {},
): Promise<V21ArchiveDownload> {
  const rootDir = options.rootDir ?? V21_ARCHIVE_ROOT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const period = monthPeriod(month);
  const url = v21ArchiveUrl(symbol, month);
  const checksumUrl = v21ChecksumUrl(symbol, month);
  const baseName = `${symbol}-5m-${month}`;
  const zipPath = resolve(rootDir, `${baseName}.zip`);
  const checksumPath = resolve(rootDir, `${baseName}.CHECKSUM`);
  const slot: V21ArchiveSlot = {
    exchange: V21_ARCHIVE_EXCHANGE,
    dataType: V21_DATA_TYPE,
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
    expectedMonthRows: Math.round((period.endExclusive - period.start) / V21_INTERVAL_MS),
    coverage: 0,
    firstOpenTime: null,
    lastOpenTime: null,
    parserErrors: [],
    duplicateOpenTimes: 0,
    cadenceErrors: 0,
    monotonicOpenTime: true,
    error: null,
  };

  try {
    await mkdir(rootDir, { recursive: true });
    const zipBytes = await readOrFetchBytes(zipPath, url, fetchImpl, timeoutMs, slot);
    if (!zipBytes) return { slot, bars: [] };
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
    slot.checksumVerified = slot.expectedSha256 !== null && slot.expectedSha256 === slot.sha256;
    if (!slot.checksumVerified) {
      slot.error = "ARCHIVE_SHA256_MISMATCH_OR_INVALID_CHECKSUM";
      return { slot, bars: [] };
    }

    const csvBytes = extractFirstZipFile(zipBytes);
    const parsed = parseBinanceKlineCsv(new TextDecoder().decode(csvBytes), symbol, period);
    slot.parserErrors = parsed.errors;
    slot.duplicateOpenTimes = parsed.duplicateOpenTimes;
    slot.cadenceErrors = parsed.cadenceErrors;
    slot.monotonicOpenTime = parsed.monotonicOpenTime;
    slot.rowCount = parsed.bars.length;
    slot.firstOpenTime = parsed.bars[0]?.openTime ?? null;
    slot.lastOpenTime = parsed.bars.at(-1)?.openTime ?? null;
    slot.coverage = slot.expectedMonthRows === 0 ? 0 : slot.rowCount / slot.expectedMonthRows;
    slot.status = slot.parserErrors.length === 0
      && slot.duplicateOpenTimes === 0
      && slot.cadenceErrors === 0
      && slot.monotonicOpenTime
      && slot.rowCount === slot.expectedMonthRows
      ? "VERIFIED"
      : "ERROR";
    if (slot.status === "ERROR") slot.error = "PARSER_VALIDATION_FAILED";
    return { slot, bars: parsed.bars };
  } catch (error) {
    slot.error = error instanceof Error ? error.message : String(error);
    slot.status = "ERROR";
    return { slot, bars: [] };
  }
}

async function readOrFetchBytes(
  path: string,
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  slot: V21ArchiveSlot,
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    if (response.status === 404) {
      slot.status = "MISSING";
      slot.error = "OFFICIAL_ARCHIVE_404";
      return null;
    }
    if (!response.ok) throw new Error(`archive HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes, { flag: "wx" });
    return bytes;
  }
}

function monotonicRow(bars: readonly V21Bar[], openTime: number): boolean {
  return bars.length === 0 || openTime > bars[bars.length - 1].openTime;
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
    if (name.endsWith("/")) continue;
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

function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
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
