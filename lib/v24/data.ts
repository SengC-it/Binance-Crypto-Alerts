import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  V24_BOOK_DEPTH_CADENCE_MS,
  V24_BOOK_DEPTH_HEADER,
  V24_COVERAGE_THRESHOLD,
  V24_DECISION_INTERVAL_MS,
  V24_END_MS,
  V24_MAX_PRICE_ANCHOR_LOG_DEVIATION,
  V24_MAX_SNAPSHOT_AGE_MS,
  V24_MAX_UNAVAILABLE_MINUTES,
  V24_PERIODS,
  V24_REQUIRED_BANDS,
  V24_START_MS,
  V24_TARGET_COVERAGE_THRESHOLD,
  V24_SYMBOLS,
  type V24DepthRow,
  type V24Period,
  type V24PeriodQuality,
  type V24RequiredBand,
  type V24SeriesQuality,
  type V24SnapshotAudit,
  type V24Symbol,
  type V24TargetCandle,
} from "./types";

export interface V24ArchiveExtraction {
  name: string;
  contentBytes: Uint8Array;
  content: string;
}

export interface V24DepthAudit {
  snapshots: V24SnapshotAudit[];
  canonicalRows: Map<number, Map<number, V24DepthRow>>;
  canonicalTimestamps: number[];
  validTimestamps: number[];
  transportRows: number;
  transportDuplicateRows: number;
  identicalDuplicateRows: number;
  conflictingDuplicateRows: number;
  canonicalDuplicateRows: number;
  nonMonotonicTimestamps: number;
  negativeRows: number;
  invalidRows: number;
  monotonicityViolations: number;
  priceAnchorCheckedSnapshots: number;
  priceAnchorValidSnapshots: number;
  priceAnchorViolations: number;
  maxContiguousGapMinutes: number;
  cadenceIntervalsSeconds: number[];
  maxIdenticalFingerprintDurationMinutes: number;
  staleIntervals: number;
}

export interface V24FiveMinuteAvailability {
  expectedSlots: number;
  validSlots: number;
  coverage: number;
  maxContiguousUnavailableMinutes: number;
}

export interface V24FeatureFeasibility {
  bidDepth1Pct: number | null;
  askDepth1Pct: number | null;
  bidNotional1Pct: number | null;
  askNotional1Pct: number | null;
  totalDepth1Pct: number | null;
  depthImbalance1Pct: number | null;
  finite: boolean;
  deterministic: boolean;
  pitAvailable: boolean;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const equalArrays = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function parseFinite(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDepthTimestamp(value: string): number | null {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function rowSignature(row: V24DepthRow): string {
  return `${row.timestampMs}|${row.percentage}|${row.depth}|${row.notional}`;
}

function requiredBand(value: number): value is V24RequiredBand {
  return (V24_REQUIRED_BANDS as readonly number[]).includes(value);
}

function makeDepthRow(fields: readonly string[]): V24DepthRow | null {
  if (fields.length < 4) return null;
  const timestampMs = parseDepthTimestamp(fields[0]!);
  const percentage = parseFinite(fields[1]);
  const depth = parseFinite(fields[2]);
  const notional = parseFinite(fields[3]);
  if (timestampMs === null || percentage === null || depth === null || notional === null) return null;
  if (!Number.isInteger(timestampMs) || timestampMs < V24_START_MS || timestampMs >= V24_END_MS) return null;
  if (!Number.isInteger(percentage)) return null;
  return {
    timestampUtc: new Date(timestampMs).toISOString(),
    timestampMs,
    percentage,
    depth,
    notional,
  };
}

export function parseDepthCsv(text: string): {
  rows: V24DepthRow[];
  invalidRows: number;
  transportRows: number;
  headerValid: boolean;
} {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.split(",") ?? [];
  const headerValid = equalArrays(header, V24_BOOK_DEPTH_HEADER);
  const dataLines = headerValid ? lines.slice(1) : lines;
  const rows: V24DepthRow[] = [];
  let invalidRows = headerValid ? 0 : 1;
  for (const line of dataLines) {
    const row = makeDepthRow(line.split(","));
    if (row) rows.push(row);
    else invalidRows += 1;
  }
  return { rows, invalidRows, transportRows: dataLines.length, headerValid };
}

export function parseTargetKlineCsv(text: string): {
  rows: V24TargetCandle[];
  invalidRows: number;
  transportRows: number;
  headerValid: boolean;
} {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.split(",") ?? [];
  const headerValid = header[0] === "open_time" || header[0] === "openTime";
  const dataLines = headerValid ? lines.slice(1) : lines;
  const rows: V24TargetCandle[] = [];
  let invalidRows = headerValid ? 0 : 1;
  for (const line of dataLines) {
    const fields = line.split(",");
    const openTimeMs = parseFinite(fields[0]);
    const close = parseFinite(fields[4]);
    const closeTimeMs = parseFinite(fields[6]);
    const valid = openTimeMs !== null && close !== null && closeTimeMs !== null && Number.isInteger(openTimeMs) && Number.isInteger(closeTimeMs) && openTimeMs % V24_DECISION_INTERVAL_MS === 0 && openTimeMs >= V24_START_MS && openTimeMs < V24_END_MS && closeTimeMs === openTimeMs + V24_DECISION_INTERVAL_MS - 1 && close > 0;
    if (valid) rows.push({ openTimeMs, closeTimeMs, close });
    else invalidRows += 1;
  }
  return { rows, invalidRows, transportRows: dataLines.length, headerValid };
}

export function expectedDailyDates(startMs = V24_START_MS, endMs = V24_END_MS): string[] {
  const result: string[] = [];
  for (let timestamp = startMs; timestamp < endMs; timestamp += 24 * 60 * 60 * 1000) result.push(new Date(timestamp).toISOString().slice(0, 10));
  return result;
}

export function expectedFiveMinuteTimestamps(startMs = V24_START_MS, endMs = V24_END_MS): number[] {
  if (startMs >= endMs || startMs % V24_DECISION_INTERVAL_MS !== 0 || endMs % V24_DECISION_INTERVAL_MS !== 0) throw new Error("V24 expected 5m range must be positive and aligned");
  const result: number[] = [];
  for (let timestamp = startMs; timestamp < endMs; timestamp += V24_DECISION_INTERVAL_MS) result.push(timestamp);
  return result;
}

export function periodForTimestamp(timestampMs: number): V24Period | null {
  if (timestampMs < V24_START_MS || timestampMs >= V24_END_MS) return null;
  if (timestampMs < Date.parse("2025-01-01T00:00:00.000Z")) return "PRIMARY";
  if (timestampMs < Date.parse("2026-01-01T00:00:00.000Z")) return "HOLDOUT_A";
  return "HOLDOUT_B";
}

export function periodExpectedFiveMinuteTimestamps(period: V24Period): number[] {
  return expectedFiveMinuteTimestamps().filter((timestamp) => periodForTimestamp(timestamp) === period);
}

export function periodExpectedDailyDates(period: V24Period): string[] {
  return expectedDailyDates().filter((date) => periodForTimestamp(Date.parse(`${date}T00:00:00.000Z`)) === period);
}

export function extractZipSingleFile(bytes: Uint8Array): V24ArchiveExtraction {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let centralDirectoryOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      centralDirectoryOffset = view.getUint32(offset + 16, true);
      break;
    }
  }
  if (centralDirectoryOffset < 0 || view.getUint32(centralDirectoryOffset, true) !== 0x02014b50) throw new Error("ZIP central directory missing");
  const nameLength = view.getUint16(centralDirectoryOffset + 28, true);
  const extraLength = view.getUint16(centralDirectoryOffset + 30, true);
  const commentLength = view.getUint16(centralDirectoryOffset + 32, true);
  const name = new TextDecoder().decode(bytes.slice(centralDirectoryOffset + 46, centralDirectoryOffset + 46 + nameLength));
  const method = view.getUint16(centralDirectoryOffset + 10, true);
  const compressedSize = view.getUint32(centralDirectoryOffset + 20, true);
  const localOffset = view.getUint32(centralDirectoryOffset + 42, true);
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP local file header missing");
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.slice(start, start + compressedSize);
  const contentBytes = method === 0 ? compressed : method === 8 ? new Uint8Array(inflateRawSync(compressed)) : (() => { throw new Error(`Unsupported ZIP compression method ${method}`); })();
  void commentLength;
  return { name, contentBytes, content: new TextDecoder().decode(contentBytes) };
}

function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function monotonicityViolations(byBand: ReadonlyMap<number, V24DepthRow>): number {
  let violations = 0;
  for (const side of [[-1, -2, -3, -4, -5], [1, 2, 3, 4, 5]] as const) {
    for (let index = 1; index < side.length; index += 1) {
      const previous = byBand.get(side[index - 1]!);
      const next = byBand.get(side[index]!);
      if (!previous || !next) continue;
      if (previous.depth > next.depth) violations += 1;
      if (previous.notional > next.notional) violations += 1;
    }
  }
  return violations;
}

function snapshotFingerprint(byBand: ReadonlyMap<number, V24DepthRow>): string {
  return V24_REQUIRED_BANDS.map((band) => {
    const row = byBand.get(band);
    return row ? `${band}:${row.depth}:${row.notional}` : `${band}:MISSING`;
  }).join("|");
}

export function findPriorClosed5mPrice(rows: readonly V24TargetCandle[], snapshotTimestampMs: number): number | null {
  let low = 0;
  let high = rows.length - 1;
  let answer: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle]!;
    if (row.closeTimeMs < snapshotTimestampMs) {
      answer = row.close;
      low = middle + 1;
    } else high = middle - 1;
  }
  return answer;
}

function auditSnapshot(timestampMs: number, rows: readonly V24DepthRow[], priorClosedPrice: number | null): V24SnapshotAudit {
  const byBand = new Map<number, V24DepthRow>();
  let invalidRows = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.depth) || !Number.isFinite(row.notional) || row.depth <= 0 || row.notional <= 0) invalidRows += 1;
    if (requiredBand(row.percentage) && !byBand.has(row.percentage)) byBand.set(row.percentage, row);
  }
  const missingBands = V24_REQUIRED_BANDS.filter((band) => !byBand.has(band));
  const violations = monotonicityViolations(byBand);
  let priceAnchorViolations = 0;
  const priceAnchorChecked = priorClosedPrice !== null && Number.isFinite(priorClosedPrice) && priorClosedPrice > 0;
  if (priceAnchorChecked) {
    for (const band of V24_REQUIRED_BANDS) {
      const row = byBand.get(band);
      if (!row || row.depth <= 0 || row.notional <= 0 || Math.abs(Math.log((row.notional / row.depth) / priorClosedPrice)) > V24_MAX_PRICE_ANCHOR_LOG_DEVIATION) priceAnchorViolations += 1;
    }
  }
  const priceAnchorValid = priceAnchorChecked && priceAnchorViolations === 0;
  return {
    timestampUtc: new Date(timestampMs).toISOString(),
    date: new Date(timestampMs).toISOString().slice(0, 10),
    rowCount: rows.length,
    requiredBandsPresent: missingBands.length === 0,
    missingBands: [...missingBands],
    invalidRows,
    monotonicityViolations: violations,
    priceAnchorChecked,
    priceAnchorValid,
    priceAnchorViolations,
    valid: missingBands.length === 0 && invalidRows === 0 && violations === 0 && priceAnchorValid,
    fingerprint: snapshotFingerprint(byBand),
  };
}

export function auditDepthRows(rows: readonly V24DepthRow[], priorClosedPrice: (timestampMs: number) => number | null): V24DepthAudit {
  const grouped = new Map<number, V24DepthRow[]>();
  let nonMonotonicTimestamps = 0;
  let previousTimestamp: number | null = null;
  let negativeRows = 0;
  let invalidRows = 0;
  for (const row of rows) {
    if (previousTimestamp !== null && row.timestampMs < previousTimestamp) nonMonotonicTimestamps += 1;
    previousTimestamp = row.timestampMs;
    if (!Number.isFinite(row.depth) || !Number.isFinite(row.notional) || row.depth <= 0 || row.notional <= 0) invalidRows += 1;
    if (row.depth <= 0 || row.notional <= 0) negativeRows += 1;
    const bucket = grouped.get(row.timestampMs) ?? [];
    bucket.push(row);
    grouped.set(row.timestampMs, bucket);
  }
  const canonicalRows = new Map<number, Map<number, V24DepthRow>>();
  let transportDuplicateRows = 0;
  let identicalDuplicateRows = 0;
  let conflictingDuplicateRows = 0;
  const snapshots: V24SnapshotAudit[] = [];
  for (const timestampMs of [...grouped.keys()].sort((left, right) => left - right)) {
    const bucket = grouped.get(timestampMs)!;
    const byBand = new Map<number, V24DepthRow>();
    const duplicateBuckets = new Map<number, V24DepthRow[]>();
    for (const row of bucket) {
      if (!requiredBand(row.percentage)) continue;
      const duplicateBucket = duplicateBuckets.get(row.percentage) ?? [];
      duplicateBucket.push(row);
      duplicateBuckets.set(row.percentage, duplicateBucket);
      if (!byBand.has(row.percentage)) byBand.set(row.percentage, row);
    }
    for (const duplicateBucket of duplicateBuckets.values()) {
      if (duplicateBucket.length <= 1) continue;
      transportDuplicateRows += duplicateBucket.length - 1;
      const signatures = new Set(duplicateBucket.map(rowSignature));
      if (signatures.size === 1) identicalDuplicateRows += duplicateBucket.length - 1;
      else conflictingDuplicateRows += duplicateBucket.length - 1;
    }
    canonicalRows.set(timestampMs, byBand);
    snapshots.push(auditSnapshot(timestampMs, bucket, priorClosedPrice(timestampMs)));
  }
  const canonicalTimestamps = [...canonicalRows.keys()].sort((left, right) => left - right);
  const validTimestamps = snapshots.filter((snapshot) => snapshot.valid).map((snapshot) => Date.parse(snapshot.timestampUtc));
  const cadenceIntervalsSeconds: number[] = [];
  let maxContiguousGapMinutes = 0;
  for (let index = 1; index < canonicalTimestamps.length; index += 1) {
    const intervalMs = canonicalTimestamps[index]! - canonicalTimestamps[index - 1]!;
    if (intervalMs > 0) {
      cadenceIntervalsSeconds.push(intervalMs / 1000);
      maxContiguousGapMinutes = Math.max(maxContiguousGapMinutes, Math.max(0, intervalMs - V24_BOOK_DEPTH_CADENCE_MS) / 60_000);
    }
  }
  let maxIdenticalFingerprintDurationMinutes = 0;
  let staleIntervals = 0;
  let fingerprintStart: number | null = null;
  let fingerprintLast: number | null = null;
  let fingerprint: string | null = null;
  let staleReported = false;
  for (const snapshot of snapshots) {
    const timestampMs = Date.parse(snapshot.timestampUtc);
    const continuous = fingerprint === snapshot.fingerprint && fingerprintLast !== null && timestampMs - fingerprintLast <= V24_BOOK_DEPTH_CADENCE_MS * 2;
    if (!continuous) {
      fingerprintStart = timestampMs;
      fingerprint = snapshot.fingerprint;
      staleReported = false;
    }
    fingerprintLast = timestampMs;
    const durationMinutes = fingerprintStart === null ? 0 : (timestampMs - fingerprintStart) / 60_000;
    maxIdenticalFingerprintDurationMinutes = Math.max(maxIdenticalFingerprintDurationMinutes, durationMinutes);
    if (durationMinutes > V24_MAX_UNAVAILABLE_MINUTES && !staleReported) {
      staleIntervals += 1;
      staleReported = true;
    }
  }
  const priceAnchorCheckedSnapshots = snapshots.filter((snapshot) => snapshot.priceAnchorChecked).length;
  const priceAnchorValidSnapshots = snapshots.filter((snapshot) => snapshot.priceAnchorValid).length;
  return {
    snapshots,
    canonicalRows,
    canonicalTimestamps,
    validTimestamps,
    transportRows: rows.length,
    transportDuplicateRows,
    identicalDuplicateRows,
    conflictingDuplicateRows,
    canonicalDuplicateRows: 0,
    nonMonotonicTimestamps,
    negativeRows,
    invalidRows,
    monotonicityViolations: snapshots.reduce((total, snapshot) => total + snapshot.monotonicityViolations, 0),
    priceAnchorCheckedSnapshots,
    priceAnchorValidSnapshots,
    priceAnchorViolations: snapshots.reduce((total, snapshot) => total + snapshot.priceAnchorViolations, 0),
    maxContiguousGapMinutes,
    cadenceIntervalsSeconds,
    maxIdenticalFingerprintDurationMinutes,
    staleIntervals,
  };
}

export function fiveMinutePITAvailability(validSnapshotTimestamps: readonly number[], startMs = V24_START_MS, endMs = V24_END_MS): V24FiveMinuteAvailability {
  const expected = expectedFiveMinuteTimestamps(startMs, endMs);
  const sorted = [...validSnapshotTimestamps].sort((left, right) => left - right);
  let pointer = -1;
  let validSlots = 0;
  let currentUnavailable = 0;
  let maxContiguousUnavailableMinutes = 0;
  for (const decisionTime of expected) {
    while (pointer + 1 < sorted.length && sorted[pointer + 1]! < decisionTime) pointer += 1;
    const latest = pointer >= 0 ? sorted[pointer]! : null;
    const valid = latest !== null && decisionTime - latest <= V24_MAX_SNAPSHOT_AGE_MS;
    if (valid) {
      validSlots += 1;
      currentUnavailable = 0;
    } else {
      currentUnavailable += 1;
      maxContiguousUnavailableMinutes = Math.max(maxContiguousUnavailableMinutes, currentUnavailable * (V24_DECISION_INTERVAL_MS / 60_000));
    }
  }
  return { expectedSlots: expected.length, validSlots, coverage: expected.length === 0 ? 0 : validSlots / expected.length, maxContiguousUnavailableMinutes };
}

export function periodQuality(
  period: V24Period,
  snapshots: readonly V24SnapshotAudit[],
  targetRows: readonly V24TargetCandle[],
  validFiveMinuteTimes: readonly number[],
): V24PeriodQuality {
  const expectedFiveMinute = periodExpectedFiveMinuteTimestamps(period);
  const periodSnapshots = snapshots.filter((snapshot) => periodForTimestamp(Date.parse(snapshot.timestampUtc)) === period);
  const periodValidTimes = validFiveMinuteTimes.filter((timestamp) => periodForTimestamp(timestamp) === period);
  const availability = fiveMinutePITAvailability(periodValidTimes, expectedFiveMinute[0] ?? V24_START_MS, expectedFiveMinute.at(-1) === undefined ? V24_END_MS : expectedFiveMinute.at(-1)! + V24_DECISION_INTERVAL_MS);
  const expectedTargetRows = expectedFiveMinute.length;
  const actualTargetRows = targetRows.filter((row) => periodForTimestamp(row.openTimeMs) === period).length;
  return {
    expectedBookDepthSnapshots: periodSnapshots.length,
    canonicalSnapshots: periodSnapshots.length,
    validSnapshots: periodSnapshots.filter((snapshot) => snapshot.valid).length,
    validSnapshotRatio: periodSnapshots.length === 0 ? 0 : periodSnapshots.filter((snapshot) => snapshot.valid).length / periodSnapshots.length,
    expected5mSlots: availability.expectedSlots,
    valid5mSlots: availability.validSlots,
    valid5mCoverage: availability.coverage,
    targetExpected5mSlots: expectedTargetRows,
    targetRows: actualTargetRows,
    targetCoverage: expectedTargetRows === 0 ? 0 : actualTargetRows / expectedTargetRows,
  };
}

export function featureFeasibility(canonicalRows: ReadonlyMap<number, ReadonlyMap<number, V24DepthRow>>, timestampMs: number): V24FeatureFeasibility {
  const snapshot = canonicalRows.get(timestampMs);
  const bid = snapshot?.get(-1);
  const ask = snapshot?.get(1);
  const totalDepth1Pct = bid && ask ? bid.notional + ask.notional : null;
  const depthImbalance1Pct = totalDepth1Pct !== null && totalDepth1Pct > 0 ? (bid!.notional - ask!.notional) / totalDepth1Pct : null;
  const values = [bid?.depth, ask?.depth, bid?.notional, ask?.notional, totalDepth1Pct, depthImbalance1Pct];
  return {
    bidDepth1Pct: bid?.depth ?? null,
    askDepth1Pct: ask?.depth ?? null,
    bidNotional1Pct: bid?.notional ?? null,
    askNotional1Pct: ask?.notional ?? null,
    totalDepth1Pct,
    depthImbalance1Pct,
    finite: values.every((value) => value === null || Number.isFinite(value)),
    deterministic: true,
    pitAvailable: snapshot !== undefined,
  };
}

export function buildEmptySeriesQuality(symbol: V24Symbol): V24SeriesQuality {
  const emptyPeriod: V24PeriodQuality = {
    expectedBookDepthSnapshots: 0,
    canonicalSnapshots: 0,
    validSnapshots: 0,
    validSnapshotRatio: 0,
    expected5mSlots: 0,
    valid5mSlots: 0,
    valid5mCoverage: 0,
    targetExpected5mSlots: 0,
    targetRows: 0,
    targetCoverage: 0,
  };
  return {
    symbol,
    expectedDays: 0,
    archivePresenceDays: 0,
    archivePresenceRatio: 0,
    checksumVerifiedArchives: 0,
    checksumVerifiedRatio: 0,
    totalTransportRows: 0,
    totalCanonicalSnapshots: 0,
    validSnapshots: 0,
    requiredBandValidityRatio: 0,
    negativeRows: 0,
    invalidRows: 0,
    missingBandSnapshots: 0,
    monotonicityViolations: 0,
    priceAnchorCheckedSnapshots: 0,
    priceAnchorValidSnapshots: 0,
    priceAnchorValidityRatio: 0,
    transportDuplicateRows: 0,
    identicalDuplicateRows: 0,
    conflictingDuplicateRows: 0,
    canonicalDuplicateRows: 0,
    nonMonotonicTimestamps: 0,
    medianIntervalSeconds: null,
    p5IntervalSeconds: null,
    p95IntervalSeconds: null,
    maximumIntervalSeconds: null,
    maxContiguousGapMinutes: 0,
    maxIdenticalFingerprintDurationMinutes: 0,
    staleIntervals: 0,
    expected5mSlots: 0,
    valid5mSlots: 0,
    valid5mCoverage: 0,
    maxContiguousUnavailableMinutes: 0,
    targetExpected5mSlots: 0,
    targetRows: 0,
    targetCoverage: 0,
    primary: emptyPeriod,
    holdoutA: emptyPeriod,
    holdoutB: emptyPeriod,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

export function summarizeCadence(intervalsSeconds: readonly number[]): { median: number | null; p5: number | null; p95: number | null; maximum: number | null } {
  return { median: quantile(intervalsSeconds, 0.5), p5: quantile(intervalsSeconds, 0.05), p95: quantile(intervalsSeconds, 0.95), maximum: intervalsSeconds.length === 0 ? null : intervalsSeconds.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY) };
}

export function passesV24SeriesGate(quality: Pick<V24SeriesQuality, "archivePresenceRatio" | "checksumVerifiedRatio" | "requiredBandValidityRatio" | "priceAnchorValidityRatio" | "valid5mCoverage" | "targetCoverage" | "conflictingDuplicateRows" | "canonicalDuplicateRows" | "maxContiguousUnavailableMinutes" | "maxIdenticalFingerprintDurationMinutes">): boolean {
  return quality.archivePresenceRatio >= V24_COVERAGE_THRESHOLD && quality.checksumVerifiedRatio === 1 && quality.conflictingDuplicateRows === 0 && quality.canonicalDuplicateRows === 0 && quality.requiredBandValidityRatio >= V24_COVERAGE_THRESHOLD && quality.priceAnchorValidityRatio >= V24_COVERAGE_THRESHOLD && quality.valid5mCoverage >= V24_COVERAGE_THRESHOLD && quality.targetCoverage >= V24_TARGET_COVERAGE_THRESHOLD && quality.maxContiguousUnavailableMinutes <= V24_MAX_UNAVAILABLE_MINUTES && quality.maxIdenticalFingerprintDurationMinutes <= V24_MAX_UNAVAILABLE_MINUTES;
}

export function assertV24Symbols(values: readonly string[]): asserts values is readonly V24Symbol[] {
  if (values.length !== V24_SYMBOLS.length || values.some((value) => !(V24_SYMBOLS as readonly string[]).includes(value))) throw new Error("V24 fixed symbol set drifted");
}

export { V24_PERIODS, V24_REQUIRED_BANDS };
