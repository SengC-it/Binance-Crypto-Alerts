import { inflateRawSync } from "node:zlib";
import {
  V23_END_MS,
  V23_INTERVAL_MS,
  V23_PERIODS,
  V23_START_MS,
  V23_UNDERLYINGS,
  type V23BasisRow,
  type V23Candle,
  type V23Period,
  type V23RollTransition,
  type V23SeriesQuality,
  type V23SeriesType,
  type V23Underlying,
} from "./types";

export interface ParsedRows {
  rows: V23Candle[];
  invalidRows: number;
  transportRows: number;
}

export interface V23ArchiveEntry {
  underlying: V23Underlying;
  seriesType: "TARGET_USDM_PERPETUAL" | "INDEX_PRICE";
  month: string;
  bodyPath: string;
  checksumPath: string;
  sourceUrl: string;
  checksumUrl: string;
  httpStatus: number;
  responseByteLength: number;
  responseSha256: string;
  expectedZipSha256: string | null;
  checksumVerified: boolean;
}

export interface V23ApiEntry {
  underlying: V23Underlying;
  seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER";
  bodyPath: string;
  sourceUrl: string;
  requestParameters: Record<string, string>;
  httpStatus: number;
  responseByteLength: number;
  responseSha256: string;
  rows: number;
  available: boolean;
  error: string | null;
}

export interface V23DownloadManifest {
  schema: "v23-download-manifest-v1";
  source: "Binance official public data archive and public USD-M REST";
  authenticationRequired: false;
  accountPermissionRequired: false;
  tradingPermissionRequired: false;
  start: string;
  endExclusive: string;
  interval: "1h";
  archiveEntries: V23ArchiveEntry[];
  apiEntries: V23ApiEntry[];
}

export function expectedHourlyTimestamps(startMs = V23_START_MS, endMs = V23_END_MS): number[] {
  if (startMs >= endMs || startMs % V23_INTERVAL_MS !== 0 || endMs % V23_INTERVAL_MS !== 0) {
    throw new Error("V23 expected range must be positive and aligned to 1h");
  }
  const result: number[] = [];
  for (let timestamp = startMs; timestamp < endMs; timestamp += V23_INTERVAL_MS) result.push(timestamp);
  return result;
}

export function periodForTimestamp(timestampMs: number): V23Period | null {
  if (timestampMs < V23_START_MS || timestampMs >= V23_END_MS) return null;
  if (timestampMs < Date.parse("2025-01-01T00:00:00.000Z")) return "PRIMARY";
  if (timestampMs < Date.parse("2026-01-01T00:00:00.000Z")) return "HOLDOUT_A";
  return "HOLDOUT_B";
}

export function periodExpectedTimestamps(period: V23Period): number[] {
  const timestamps = expectedHourlyTimestamps();
  return timestamps.filter((timestamp) => periodForTimestamp(timestamp) === period);
}

function parseFinite(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCandle(
  values: readonly (string | number)[],
  underlying: V23Underlying,
  seriesType: V23SeriesType,
): V23Candle | null {
  if (values.length < 7) return null;
  const openTime = parseFinite(values[0]!);
  const open = parseFinite(values[1]!);
  const high = parseFinite(values[2]!);
  const low = parseFinite(values[3]!);
  const close = parseFinite(values[4]!);
  const closeTime = parseFinite(values[6]!);
  if (openTime === null || open === null || high === null || low === null || close === null || closeTime === null) return null;
  if (!Number.isInteger(openTime) || openTime % V23_INTERVAL_MS !== 0 || openTime < V23_START_MS || openTime >= V23_END_MS) return null;
  if (closeTime !== openTime + V23_INTERVAL_MS - 1) return null;
  if (![open, high, low, close].every((value) => value > 0)) return null;
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return {
    underlying,
    seriesType,
    openTimeUtc: new Date(openTime).toISOString(),
    open,
    high,
    low,
    close,
    closeTimeUtc: new Date(closeTime).toISOString(),
    closed: true,
  };
}

export function parseBinanceKlineCsv(text: string, underlying: V23Underlying, seriesType: "TARGET_USDM_PERPETUAL" | "INDEX_PRICE"): ParsedRows {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.length > 0);
  const rows: V23Candle[] = [];
  let invalidRows = 0;
  for (const line of lines) {
    const fields = line.split(",");
    if (fields[0] === "open_time" || fields[0] === "openTime") continue;
    const row = toCandle(fields, underlying, seriesType);
    if (row) rows.push(row);
    else invalidRows += 1;
  }
  return { rows, invalidRows, transportRows: lines.filter((line) => !line.startsWith("open_time,") && !line.startsWith("openTime,")).length };
}

export function parseBinanceKlineJson(payload: unknown, underlying: V23Underlying, seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER" | "PERPETUAL"): ParsedRows {
  if (!Array.isArray(payload)) return { rows: [], invalidRows: 1, transportRows: 0 };
  const rows: V23Candle[] = [];
  let invalidRows = 0;
  for (const value of payload) {
    const row = Array.isArray(value) ? toCandle(value, underlying, seriesType) : null;
    if (row) rows.push(row);
    else invalidRows += 1;
  }
  return { rows, invalidRows, transportRows: payload.length };
}

function candleSignature(row: V23Candle): string {
  return [row.openTimeUtc, row.open, row.high, row.low, row.close, row.closeTimeUtc, row.closed].join("|");
}

function qualityFor(actualRows: number, expectedRows: number): { expectedRows: number; actualRows: number; coverageRatio: number } {
  return { expectedRows, actualRows, coverageRatio: expectedRows === 0 ? 0 : actualRows / expectedRows };
}

function periodQuality(openTimes: Set<number>, period: V23Period): { expectedRows: number; actualRows: number; coverageRatio: number } {
  const expected = periodExpectedTimestamps(period);
  return qualityFor(expected.filter((timestamp) => openTimes.has(timestamp)).length, expected.length);
}

export function auditSeriesRows(
  underlying: V23Underlying,
  seriesType: V23SeriesType,
  rows: readonly V23Candle[],
  invalidRows = 0,
): V23SeriesQuality {
  const openTimes = new Map<number, V23Candle[]>();
  let canonicalNonMonotonic = 0;
  let previousTimestamp: number | null = null;
  for (const row of rows) {
    const timestamp = Date.parse(row.openTimeUtc);
    if (previousTimestamp !== null && timestamp < previousTimestamp) canonicalNonMonotonic += 1;
    previousTimestamp = timestamp;
    const bucket = openTimes.get(timestamp) ?? [];
    bucket.push(row);
    openTimes.set(timestamp, bucket);
  }
  let identicalDuplicates = 0;
  let conflictingDuplicates = 0;
  let transportDuplicates = 0;
  for (const bucket of openTimes.values()) {
    if (bucket.length <= 1) continue;
    transportDuplicates += bucket.length - 1;
    const signatures = new Set(bucket.map(candleSignature));
    if (signatures.size === 1) identicalDuplicates += bucket.length - 1;
    else conflictingDuplicates += bucket.length - 1;
  }
  const expected = expectedHourlyTimestamps();
  const actual = expected.filter((timestamp) => openTimes.has(timestamp));
  let maxGap = 0;
  let currentGap = 0;
  for (const timestamp of expected) {
    if (openTimes.has(timestamp)) currentGap = 0;
    else {
      currentGap += 1;
      maxGap = Math.max(maxGap, currentGap);
    }
  }
  const uniqueTimestamps = new Set(openTimes.keys());
  return {
    underlying,
    seriesType,
    ...qualityFor(actual.length, expected.length),
    transportDuplicates,
    identicalDuplicates,
    conflictingDuplicates,
    canonicalDuplicates: transportDuplicates,
    canonicalNonMonotonic,
    invalidRows,
    missingRows: expected.length - actual.length,
    maxContiguousMissingHours: maxGap,
    firstTimestamp: uniqueTimestamps.size === 0 ? null : new Date(Math.min(...uniqueTimestamps)).toISOString(),
    lastTimestamp: uniqueTimestamps.size === 0 ? null : new Date(Math.max(...uniqueTimestamps)).toISOString(),
    primary: periodQuality(uniqueTimestamps, "PRIMARY"),
    holdoutA: periodQuality(uniqueTimestamps, "HOLDOUT_A"),
    holdoutB: periodQuality(uniqueTimestamps, "HOLDOUT_B"),
  };
}

export function openTimeMap(rows: readonly V23Candle[]): Map<number, V23Candle> {
  const result = new Map<number, V23Candle>();
  for (const row of rows) {
    const timestamp = Date.parse(row.openTimeUtc);
    if (!result.has(timestamp)) result.set(timestamp, row);
  }
  return result;
}

export function exactSynchronizedTimestamps(series: ReadonlyMap<V23SeriesType, ReadonlyMap<number, V23Candle>>, required: readonly V23SeriesType[]): number[] {
  const first = series.get(required[0]!);
  if (!first) return [];
  return [...first.keys()].filter((timestamp) => required.every((seriesType) => series.get(seriesType)?.has(timestamp) === true)).sort((a, b) => a - b);
}

export function basisAtTimestamp(
  timestamp: number,
  current: ReadonlyMap<number, V23Candle>,
  next: ReadonlyMap<number, V23Candle>,
  index: ReadonlyMap<number, V23Candle>,
  perpetual?: ReadonlyMap<number, V23Candle>,
): V23BasisRow | null {
  const currentRow = current.get(timestamp);
  const nextRow = next.get(timestamp);
  const indexRow = index.get(timestamp);
  if (!currentRow || !nextRow || !indexRow) return null;
  const currentBasis = Math.log(currentRow.close / indexRow.close);
  const nextBasis = Math.log(nextRow.close / indexRow.close);
  const perpetualRow = perpetual?.get(timestamp);
  const perpetualBasis = perpetualRow ? Math.log(perpetualRow.close / indexRow.close) : undefined;
  const values = [currentBasis, nextBasis, nextBasis - currentBasis, perpetualBasis].filter((value): value is number => value !== undefined);
  if (!values.every(Number.isFinite)) return null;
  return { timestampUtc: new Date(timestamp).toISOString(), currentBasis, nextBasis, curveSlope: nextBasis - currentBasis, ...(perpetualBasis === undefined ? {} : { perpetualBasis }) };
}

export function buildRollAudit(rows: readonly V23Candle[], seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER"): V23RollTransition[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.openTimeUtc) - Date.parse(b.openTimeUtc));
  const transitions: V23RollTransition[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const before = sorted[index - 1]!;
    const after = sorted[index]!;
    const rawGap = after.open / before.close - 1;
    if (Math.abs(rawGap) >= 0.05) transitions.push({ transitionTimestamp: after.openTimeUtc, seriesType, preClose: before.close, postOpen: after.open, postClose: after.close, rawGap });
  }
  return transitions;
}

export function extractZipSingleFile(bytes: Uint8Array): { name: string; content: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record missing");
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSignature = 0x02014b50;
  if (view.getUint32(centralOffset, true) !== centralSignature) throw new Error("ZIP central directory missing");
  const nameLength = view.getUint16(centralOffset + 28, true);
  const extraLength = view.getUint16(centralOffset + 30, true);
  const commentLength = view.getUint16(centralOffset + 32, true);
  const decoder = new TextDecoder();
  const name = decoder.decode(bytes.slice(centralOffset + 46, centralOffset + 46 + nameLength));
  const method = view.getUint16(centralOffset + 10, true);
  const compressedSize = view.getUint32(centralOffset + 20, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP local file header missing");
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const compressed = bytes.slice(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
  const contentBytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`Unsupported ZIP compression method ${method}`); })();
  void extraLength;
  void commentLength;
  return { name, content: new TextDecoder().decode(contentBytes) };
}

export function emptySeriesQuality(underlying: V23Underlying, seriesType: V23SeriesType): V23SeriesQuality {
  return auditSeriesRows(underlying, seriesType, [], 0);
}

export function passesV23SeriesQuality(quality: Pick<V23SeriesQuality, "coverageRatio" | "conflictingDuplicates" | "canonicalDuplicates" | "canonicalNonMonotonic" | "invalidRows" | "maxContiguousMissingHours">): boolean {
  return quality.coverageRatio >= 0.995 && quality.conflictingDuplicates === 0 && quality.canonicalDuplicates === 0 && quality.canonicalNonMonotonic === 0 && quality.invalidRows === 0 && quality.maxContiguousMissingHours <= 24;
}

export function passesV23DataGate(qualities: readonly (Pick<V23SeriesQuality, "coverageRatio" | "conflictingDuplicates" | "canonicalDuplicates" | "canonicalNonMonotonic" | "invalidRows" | "maxContiguousMissingHours">)[], synchronizedCoverage: number): boolean {
  return qualities.length === 4 && qualities.every(passesV23SeriesQuality) && synchronizedCoverage >= 0.995;
}

export function assertFixedUnderlyings(values: readonly string[]): asserts values is readonly V23Underlying[] {
  if (values.length !== V23_UNDERLYINGS.length || values.some((value) => !(V23_UNDERLYINGS as readonly string[]).includes(value))) throw new Error("V23 underlying set drifted");
}

export { V23_PERIODS };
