import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { V19_INTERVAL_MS } from "./constants";
import { sha256Bytes } from "./canonical";
import type { V19Bar } from "./features";

export const V19_ARCHIVE_EXCHANGE = "BINANCE_DATA_VISION" as const;
export const V19_ARCHIVE_ROOT = resolve("data/raw/v19/archives");

export type V19ArchiveSlotStatus = "VERIFIED" | "MISSING" | "ERROR";

export interface V19ArchiveSlot {
  exchange: typeof V19_ARCHIVE_EXCHANGE;
  symbol: string;
  month: string;
  periodStart: string;
  periodEndExclusive: string;
  interval: "5m";
  url: string;
  checksumUrl: string;
  status: V19ArchiveSlotStatus;
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
  error: string | null;
}

export interface V19ArchiveDownload {
  slot: V19ArchiveSlot;
  bars: V19Bar[];
}

export interface V19ArchiveOptions {
  rootDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function v19MonthKeys(): string[] {
  const months: string[] = [];
  for (let year = 2021; year <= 2026; year += 1) {
    const lastMonth = year === 2026 ? 7 : 12;
    const firstMonth = year === 2021 ? 1 : 1;
    for (let month = firstMonth; month <= lastMonth; month += 1) {
      months.push(`${year}-${String(month).padStart(2, "0")}`);
    }
  }
  return months;
}

export function monthPeriod(month: string): { start: number; endExclusive: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid YYYY-MM month: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = Date.UTC(year, monthIndex, 1);
  const endExclusive = Date.UTC(year, monthIndex + 1, 1);
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) throw new Error(`Invalid month: ${month}`);
  return { start, endExclusive };
}

export function v19ArchiveUrl(symbol: string, month: string): string {
  return `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

export function v19ChecksumUrl(symbol: string, month: string): string {
  return `${v19ArchiveUrl(symbol, month)}.CHECKSUM`;
}

export function parseBinanceKlineCsv(text: string, symbol = "UNKNOWN"): { bars: V19Bar[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const errors: string[] = [];
  const bars: V19Bar[] = [];
  const first = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  const hasHeader = first[0] === "open_time" || first[0] === "open time";
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const seen = new Set<number>();

  dataLines.forEach((line, lineIndex) => {
    const values = line.split(",").map((value) => value.trim());
    if (values.length < 11) {
      errors.push(`${symbol}: row ${lineIndex + 1} has ${values.length} columns`);
      return;
    }
    const openTime = Number(values[0]);
    const open = Number(values[1]);
    const high = Number(values[2]);
    const low = Number(values[3]);
    const close = Number(values[4]);
    const volume = Number(values[5]);
    const closeTime = Number(values[6]);
    const quoteVolume = Number(values[7]);
    const tradeCount = Number(values[8]);
    const takerBuyBaseVolume = Number(values[9]);
    const takerBuyQuoteVolume = Number(values[10]);
    const numericValues = [
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      quoteVolume,
      tradeCount,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
    ];
    const validOhlc = open > 0 && high > 0 && low > 0 && close > 0 && high >= Math.max(open, close) && low <= Math.min(open, close);
    const validTime = Number.isSafeInteger(openTime)
      && Number.isSafeInteger(closeTime)
      && openTime % V19_INTERVAL_MS === 0
      && closeTime === openTime + V19_INTERVAL_MS - 1;
    const validTradeCount = Number.isSafeInteger(tradeCount) && tradeCount >= 0;
    if (!numericValues.every(Number.isFinite) || !validOhlc || !validTime || !validTradeCount || seen.has(openTime)) {
      errors.push(`${symbol}: invalid row ${lineIndex + 1}`);
      return;
    }
    seen.add(openTime);
    bars.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      quoteVolume,
      tradeCount,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
    });
  });

  bars.sort((left, right) => left.openTime - right.openTime);
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].openTime !== bars[index - 1].openTime + V19_INTERVAL_MS) {
      errors.push(`${symbol}: non-contiguous openTime at ${bars[index].openTime}`);
      break;
    }
  }
  return { bars, errors };
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

export async function downloadAndParseV19Archive(
  symbol: string,
  month: string,
  options: V19ArchiveOptions = {},
): Promise<V19ArchiveDownload> {
  const rootDir = options.rootDir ?? V19_ARCHIVE_ROOT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const period = monthPeriod(month);
  const url = v19ArchiveUrl(symbol, month);
  const checksumUrl = v19ChecksumUrl(symbol, month);
  const baseName = `${symbol}-5m-${month}`;
  const zipPath = resolve(rootDir, `${baseName}.zip`);
  const checksumPath = resolve(rootDir, `${baseName}.CHECKSUM`);
  const baseSlot = (): V19ArchiveSlot => ({
    exchange: V19_ARCHIVE_EXCHANGE,
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
    expectedFullMonthRows: Math.round((period.endExclusive - period.start) / V19_INTERVAL_MS),
    coverage: 0,
    firstOpenTime: null,
    lastOpenTime: null,
    parserErrors: [],
    error: null,
  });
  const slot = baseSlot();

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
    const parsed = parseBinanceKlineCsv(new TextDecoder().decode(csvBytes), symbol);
    const periodErrors = parsed.bars.some((bar) => bar.openTime < period.start || bar.openTime >= period.endExclusive)
      ? [`${symbol}: openTime outside ${month}`]
      : [];
    slot.parserErrors = [...parsed.errors, ...periodErrors];
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

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  return fetchImpl(url, signal ? { signal } : undefined);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
      return offset;
    }
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
