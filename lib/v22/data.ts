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

export function parseOkxResponseBodies(
  bodies: readonly string[],
  symbol: V22Symbol,
): V22Candle[] {
  const instrument = V22_OKX_INSTRUMENTS[symbol];
  const candlesByTimestamp = new Map<number, V22Candle>();
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
      const candle: V22Candle = {
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
      };
      const prior = candlesByTimestamp.get(candle.openTimeUtc);
      if (prior) {
        const same = prior.open === candle.open && prior.high === candle.high && prior.low === candle.low && prior.close === candle.close && prior.volume === candle.volume && prior.closed === candle.closed;
        if (!same) throw new Error(`OKX conflicting duplicate timestamp ${candle.openTimeUtc}`);
        continue;
      }
      candlesByTimestamp.set(candle.openTimeUtc, candle);
    }
  }
  return [...candlesByTimestamp.values()];
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
    if (present.has(timestamp)) {
      currentRun = 0;
    } else {
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
): V22Quality {
  const ordered = [...candles].sort((left, right) => left.openTimeUtc - right.openTimeUtc);
  const inRange = candles.filter((candle) => candle.openTimeUtc >= startMs && candle.openTimeUtc < endMs);
  const timestamps = inRange.map((candle) => candle.openTimeUtc);
  const uniqueTimestamps = [...new Set(timestamps)].sort((left, right) => left - right);
  const missingStats = countMissingSlots(uniqueTimestamps, startMs, endMs);
  let nonMonotonic = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].openTimeUtc <= ordered[index - 1].openTimeUtc) nonMonotonic += 1;
  }
  const expected = expectedRows(startMs, endMs);
  return {
    expected5mRows: expected,
    actualRows: uniqueTimestamps.length,
    coverageRatio: uniqueTimestamps.length / expected,
    duplicates: timestamps.length - uniqueTimestamps.length,
    nonMonotonic,
    invalidRows: inRange.filter((candle) => !validateCandle(candle)).length,
    missingRows: missingStats.missing,
    maxContiguousMissingMinutes: missingStats.maxRun * 5,
    firstTimestamp: uniqueTimestamps.length ? new Date(uniqueTimestamps[0]).toISOString() : null,
    lastTimestamp: uniqueTimestamps.length ? new Date(uniqueTimestamps.at(-1)!).toISOString() : null,
    primaryCoverage: coverageForPeriod(timestamps, Date.parse("2023-07-01T00:00:00Z"), Date.parse("2025-01-01T00:00:00Z")),
    holdoutACoverage: coverageForPeriod(timestamps, Date.parse("2025-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z")),
    holdoutBCoverage: coverageForPeriod(timestamps, Date.parse("2026-01-01T00:00:00Z"), endMs),
  };
}

export function intersectTimestampSets(left: readonly V22Candle[], right: readonly V22Candle[]): number[] {
  const rightTimestamps = new Set(right.map((candle) => candle.openTimeUtc));
  return [...new Set(left.map((candle) => candle.openTimeUtc).filter((timestamp) => rightTimestamps.has(timestamp)))]
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

export function passesHardGate(quality: V22Quality): boolean {
  return (
    quality.coverageRatio >= 0.999 &&
    quality.duplicates === 0 &&
    quality.nonMonotonic === 0 &&
    quality.invalidRows === 0 &&
    quality.maxContiguousMissingMinutes <= 15 &&
    (quality.synchronizedCoverageRatio ?? 0) >= 0.999
  );
}
