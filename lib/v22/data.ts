import { createHash } from "node:crypto";
import {
  V22_END_MS,
  V22_INTERVAL_MS,
  V22_OKX_INSTRUMENTS,
  V22_START_MS,
  V22_SYMBOLS,
  type V22Candle,
  type V22Quality,
  type V22Symbol,
  type V22Venue,
} from "@/lib/v22/types";

const FINITE_POSITIVE = (value: number): boolean => Number.isFinite(value) && value > 0;

export interface CandleAudit {
  sourceOrderNonMonotonic: number;
  canonicalNonMonotonic: number;
  transportDuplicateRows: number;
  exactIdenticalDuplicateRows: number;
  conflictingDuplicateRows: number;
  canonicalDuplicateRows: number;
}

export interface OkxParseResult {
  candles: V22Candle[];
  audit: CandleAudit;
}

export function expectedRows(startMs = V22_START_MS, endMs = V22_END_MS): number {
  if (endMs <= startMs || (endMs - startMs) % V22_INTERVAL_MS !== 0) {
    throw new Error("V22 period must be an exact 5m interval");
  }
  return (endMs - startMs) / V22_INTERVAL_MS;
}

export function parseBinanceKlineCsv(text: string, symbol: V22Symbol): V22Candle[] {
  const candles: V22Candle[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("open time")) continue;
    const fields = line.split(",");
    if (fields.length < 7) {
      throw new Error(`Binance row ${index + 1} has fewer than 7 fields`);
    }
    const [openTime, open, high, low, close, volume, closeTime] = fields;
    candles.push({
      venue: "BINANCE_USDM",
      instrument: symbol,
      symbol,
      openTimeUtc: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      closeTimeUtc: Number(closeTime),
      closed: true,
    });
  }
  return candles;
}

function sameCandle(left: V22Candle, right: V22Candle): boolean {
  return (
    left.venue === right.venue &&
    left.instrument === right.instrument &&
    left.symbol === right.symbol &&
    left.openTimeUtc === right.openTimeUtc &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume &&
    left.closeTimeUtc === right.closeTimeUtc &&
    left.closed === right.closed
  );
}

function countSourceOrderNonMonotonic(rows: readonly V22Candle[]): number {
  let count = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.openTimeUtc < rows[index - 1]!.openTimeUtc) count += 1;
  }
  return count;
}

export function canonicalizeCandleRows(rows: readonly V22Candle[]): { candles: V22Candle[]; audit: CandleAudit } {
  const byTimestamp = new Map<number, V22Candle>();
  let transportDuplicateRows = 0;
  let exactIdenticalDuplicateRows = 0;
  let conflictingDuplicateRows = 0;
  for (const row of rows) {
    const prior = byTimestamp.get(row.openTimeUtc);
    if (!prior) {
      byTimestamp.set(row.openTimeUtc, row);
      continue;
    }
    transportDuplicateRows += 1;
    if (sameCandle(prior, row)) exactIdenticalDuplicateRows += 1;
    else conflictingDuplicateRows += 1;
  }
  const candles = [...byTimestamp.values()].sort((left, right) => left.openTimeUtc - right.openTimeUtc);
  return {
    candles,
    audit: {
      sourceOrderNonMonotonic: countSourceOrderNonMonotonic(rows),
      canonicalNonMonotonic: countSourceOrderNonMonotonic(candles),
      transportDuplicateRows,
      exactIdenticalDuplicateRows,
      conflictingDuplicateRows,
      canonicalDuplicateRows: 0,
    },
  };
}

export function parseOkxResponseBodies(
  bodies: readonly string[],
  symbol: V22Symbol,
): OkxParseResult {
  const instrument = V22_OKX_INSTRUMENTS[symbol];
  const rawCandles: V22Candle[] = [];
  for (const [bodyIndex, body] of bodies.entries()) {
    let parsed: { code?: string; data?: string[][]; msg?: string };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error(`OKX response ${bodyIndex + 1} is not JSON`);
    }
    if (parsed.code !== "0" || !Array.isArray(parsed.data)) {
      throw new Error(`OKX response ${bodyIndex + 1} failed: ${parsed.msg ?? "unknown error"}`);
    }
    for (const row of parsed.data) {
      if (row.length < 9) throw new Error(`OKX response ${bodyIndex + 1} has malformed row`);
      const [openTime, open, high, low, close, volume, , , confirmed] = row;
      rawCandles.push({
        venue: "OKX_USDT_SWAP",
        instrument,
        symbol,
        openTimeUtc: Number(openTime),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        closeTimeUtc: Number(openTime) + V22_INTERVAL_MS - 1,
        closed: confirmed === "1",
      });
    }
  }
  return canonicalizeCandleRows(rawCandles);
}

export function validateCandle(candle: V22Candle): boolean {
  return (
    candle.openTimeUtc % V22_INTERVAL_MS === 0 &&
    candle.closeTimeUtc === candle.openTimeUtc + V22_INTERVAL_MS - 1 &&
    candle.closed &&
    FINITE_POSITIVE(candle.open) &&
    FINITE_POSITIVE(candle.high) &&
    FINITE_POSITIVE(candle.low) &&
    FINITE_POSITIVE(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.volume >= 0 &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high)
  );
}

function countMissingSlots(timestamps: readonly number[], startMs: number, endMs: number): {
  missing: number;
  maxRun: number;
} {
  const present = new Set(timestamps);
  let missing = 0;
  let currentRun = 0;
  let maxRun = 0;
  for (let timestamp = startMs; timestamp < endMs; timestamp += V22_INTERVAL_MS) {
    if (present.has(timestamp)) currentRun = 0;
    else {
      missing += 1;
      currentRun += 1;
      maxRun = Math.max(maxRun, currentRun);
    }
  }
  return { missing, maxRun };
}

function coverageForPeriod(timestamps: readonly number[], startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  const expected = expectedRows(startMs, endMs);
  const present = new Set(timestamps.filter((timestamp) => timestamp >= startMs && timestamp < endMs));
  return present.size / expected;
}

export function analyzeQuality(
  candles: readonly V22Candle[],
  startMs = V22_START_MS,
  endMs = V22_END_MS,
  suppliedAudit?: CandleAudit,
): V22Quality {
  const canonicalized = suppliedAudit ? { candles: [...candles], audit: suppliedAudit } : canonicalizeCandleRows(candles);
  const canonical = canonicalized.candles;
  const audit = canonicalized.audit;
  const inRange = canonical.filter((candle) => candle.openTimeUtc >= startMs && candle.openTimeUtc < endMs);
  const timestamps = inRange.map((candle) => candle.openTimeUtc);
  const missingStats = countMissingSlots(timestamps, startMs, endMs);
  const expected = expectedRows(startMs, endMs);
  return {
    expected5mRows: expected,
    actualRows: new Set(timestamps).size,
    coverageRatio: new Set(timestamps).size / expected,
    duplicates: audit.transportDuplicateRows,
    nonMonotonic: audit.canonicalNonMonotonic,
    sourceOrderNonMonotonic: audit.sourceOrderNonMonotonic,
    canonicalNonMonotonic: audit.canonicalNonMonotonic,
    transportDuplicateRows: audit.transportDuplicateRows,
    exactIdenticalDuplicateRows: audit.exactIdenticalDuplicateRows,
    conflictingDuplicateRows: audit.conflictingDuplicateRows,
    canonicalDuplicateRows: audit.canonicalDuplicateRows,
    invalidRows: inRange.filter((candle) => !validateCandle(candle)).length,
    missingRows: missingStats.missing,
    maxContiguousMissingMinutes: missingStats.maxRun * 5,
    firstTimestamp: timestamps.length ? new Date(timestamps[0]!).toISOString() : null,
    lastTimestamp: timestamps.length ? new Date(timestamps[timestamps.length - 1]!).toISOString() : null,
    primaryCoverage: coverageForPeriod(timestamps, Date.parse("2023-07-01T00:00:00Z"), Date.parse("2025-01-01T00:00:00Z")),
    holdoutACoverage: coverageForPeriod(timestamps, Date.parse("2025-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z")),
    holdoutBCoverage: coverageForPeriod(timestamps, Date.parse("2026-01-01T00:00:00Z"), endMs),
  };
}

export function intersectTimestampSets(
  left: readonly V22Candle[],
  right: readonly V22Candle[],
  startMs = V22_START_MS,
  endMs = V22_END_MS,
): number[] {
  const rightTimestamps = new Set(right.map((candle) => candle.openTimeUtc).filter((timestamp) => timestamp >= startMs && timestamp < endMs));
  return [...new Set(left.map((candle) => candle.openTimeUtc).filter((timestamp) => timestamp >= startMs && timestamp < endMs && rightTimestamps.has(timestamp)))]
    .sort((a, b) => a - b);
}

export function addSynchronizationQuality(
  quality: V22Quality,
  intersectionRows: number,
  startMs = V22_START_MS,
  endMs = V22_END_MS,
): V22Quality {
  return {
    ...quality,
    exactTimestampIntersectionRows: intersectionRows,
    synchronizedCoverageRatio: intersectionRows / expectedRows(startMs, endMs),
  };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function maxGapMinutes(timestamps: readonly number[], startMs = V22_START_MS, endMs = V22_END_MS): number {
  return countMissingSlots([...new Set(timestamps)].sort((a, b) => a - b), startMs, endMs).maxRun * 5;
}

export function venueFor(candle: V22Candle): V22Venue {
  return candle.venue;
}

export function isV22Symbol(value: string): value is V22Symbol {
  return (V22_SYMBOLS as readonly string[]).includes(value);
}

export function passesHardGate(quality: V22Quality, allowExactIdenticalTransportOverlap = false): boolean {
  return (
    quality.coverageRatio >= 0.999 &&
    (allowExactIdenticalTransportOverlap || quality.duplicates === 0) &&
    quality.conflictingDuplicateRows === 0 &&
    quality.canonicalDuplicateRows === 0 &&
    quality.canonicalNonMonotonic === 0 &&
    quality.invalidRows === 0 &&
    quality.maxContiguousMissingMinutes <= 15 &&
    (quality.synchronizedCoverageRatio ?? 0) >= 0.999
  );
}
