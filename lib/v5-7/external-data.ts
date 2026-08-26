import { inflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import type { Candle, FundingRatePoint } from "@/lib/core/types";

export type V57ExternalTimeframe = "15m" | "1h" | "4h" | "funding";

export const V57_EXTERNAL_TIMEFRAMES: readonly V57ExternalTimeframe[] = ["15m", "1h", "4h", "funding"];
export const V57_DATA_VISION_ROOT = "https://data.binance.vision/data/futures/um/monthly";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ExternalMonthlyData {
  candles?: Candle[];
  fundingRates?: FundingRatePoint[];
  rowCount: number;
}

export function monthKeys(start: number, end: number): string[] {
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const last = new Date(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1));
  const months: string[] = [];
  while (cursor <= last) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function monthlyKlineUrl(symbol: string, timeframe: Exclude<V57ExternalTimeframe, "funding">, period: string): string {
  return `${V57_DATA_VISION_ROOT}/klines/${symbol}/${timeframe}/${symbol}-${timeframe}-${period}.zip`;
}

export function monthlyFundingUrl(symbol: string, period: string): string {
  return `${V57_DATA_VISION_ROOT}/fundingRate/${symbol}/${symbol}-fundingRate-${period}.zip`;
}

export function externalArchiveUrl(symbol: string, timeframe: V57ExternalTimeframe, period: string): string {
  return timeframe === "funding" ? monthlyFundingUrl(symbol, period) : monthlyKlineUrl(symbol, timeframe, period);
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const dataStart = fileNameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("ZIP entry exceeds archive length");
    const name = buffer.subarray(fileNameStart, dataStart).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`Unsupported ZIP compression method ${method}`); })();
    entries.push({ name, data });
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("ZIP archive contained no local file entries");
  return entries;
}

export function parseMonthlyArchive(buffer: Buffer, timeframe: V57ExternalTimeframe): ExternalMonthlyData {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("ZIP archive contained no data file");
  const lines = entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { rowCount: 0 };
  const firstFields = splitCsvLine(lines[0]);
  const hasHeader = firstFields.length > 0 && !Number.isFinite(Number(firstFields[0]));
  const rows = (hasHeader ? lines.slice(1) : lines).map(splitCsvLine);
  if (timeframe === "funding") {
    const fundingRates = rows.map(parseFundingRow).filter((value): value is FundingRatePoint => value !== null);
    return { fundingRates, rowCount: fundingRates.length };
  }
  const candles = rows.map(parseCandleRow).filter((value): value is Candle => value !== null);
  return { candles, rowCount: candles.length };
}

export async function readMonthlyArchive(path: string, timeframe: V57ExternalTimeframe): Promise<ExternalMonthlyData> {
  return parseMonthlyArchive(await readFile(path), timeframe);
}

function parseCandleRow(fields: string[]): Candle | null {
  if (fields.length < 7) return null;
  const openTime = parseTimestamp(fields[0]);
  const open = Number(fields[1]);
  const high = Number(fields[2]);
  const low = Number(fields[3]);
  const close = Number(fields[4]);
  const volume = Number(fields[5]);
  const closeTime = parseTimestamp(fields[6]);
  if (![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite)) return null;
  return { openTime, open, high, low, close, volume, closeTime };
}

function parseFundingRow(fields: string[]): FundingRatePoint | null {
  if (fields.length < 2) return null;
  const timeField = fields[0].toLowerCase().includes("time") ? fields[0] : fields[0];
  const fundingTime = parseTimestamp(timeField);
  const fundingRate = Number(fields.at(-1));
  if (!Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)) return null;
  return { fundingTime, fundingRate };
}

function parseTimestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}
