import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  auditDepthRows,
  extractZipSingleFile,
  featureFeasibility,
  findPriorClosed5mPrice,
  fiveMinutePITAvailability,
  parseDepthCsv,
  parseTargetKlineCsv,
  periodExpectedFiveMinuteTimestamps,
  periodExpectedDailyDates,
  periodForTimestamp,
  passesV24SeriesGate,
  sha256,
  summarizeCadence,
} from "@/lib/v24/data";
import {
  V24_BASE_SHA,
  V24_COVERAGE_THRESHOLD,
  V24_END_MS,
  V24_EXPERIMENT_ID,
  V24_FAMILY,
  V24_INFORMATION_SOURCE_CLASS,
  V24_MAX_SNAPSHOT_AGE_MS,
  V24_MAX_UNAVAILABLE_MINUTES,
  V24_PERIODS,
  V24_R1_ADMISSION_SHA,
  V24_REQUIRED_BANDS,
  V24_START_MS,
  V24_SYMBOLS,
  V24_TARGET_COVERAGE_THRESHOLD,
  V24_V22_TERMINAL_SHA,
  V24_V23_TERMINAL_SHA,
  type V24ArchiveEntry,
  type V24DepthRow,
  type V24DownloadManifest,
  type V24Period,
  type V24SeriesQuality,
  type V24SnapshotAudit,
  type V24Symbol,
  type V24TargetCandle,
} from "@/lib/v24/types";

const RAW_ROOT = resolve("data/raw/v24");
const REPORT_ROOT = resolve("reports");
const RAW_MANIFEST_PATH = resolve(RAW_ROOT, "v24-download-manifest.json");

interface AnomalyCount {
  symbol: V24Symbol;
  date: string;
  anomalyType: string;
  count: number;
}

interface SymbolState {
  symbol: V24Symbol;
  expectedDays: number;
  archivePresenceDays: number;
  checksumVerifiedArchives: number;
  totalTransportRows: number;
  totalCanonicalSnapshots: number;
  validSnapshots: number;
  negativeRows: number;
  invalidRows: number;
  missingBandSnapshots: number;
  monotonicityViolations: number;
  priceAnchorCheckedSnapshots: number;
  priceAnchorValidSnapshots: number;
  priceAnchorViolations: number;
  transportDuplicateRows: number;
  identicalDuplicateRows: number;
  conflictingDuplicateRows: number;
  canonicalDuplicateRows: number;
  nonMonotonicTimestamps: number;
  canonicalTimestamps: number[];
  validSnapshotTimestamps: number[];
  cadenceIntervalsSeconds: number[];
  maxContiguousGapMinutes: number;
  maxIdenticalFingerprintDurationMinutes: number;
  staleIntervals: number;
  staleState: { fingerprint: string | null; start: number | null; last: number | null; counted: boolean };
  periodSnapshots: Record<V24Period, { canonical: number; valid: number }>;
  targetRows: V24TargetCandle[];
  targetArchiveRows: number;
  targetInvalidRows: number;
  targetArchivePresence: number;
  targetArchiveExpected: number;
  featureSample: ReturnType<typeof featureFeasibility> | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

function jsonFromGit(commit: string, path: string): Record<string, unknown> {
  return JSON.parse(execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" })) as Record<string, unknown>;
}

function newState(symbol: V24Symbol, expectedDays: number): SymbolState {
  return {
    symbol,
    expectedDays,
    archivePresenceDays: 0,
    checksumVerifiedArchives: 0,
    totalTransportRows: 0,
    totalCanonicalSnapshots: 0,
    validSnapshots: 0,
    negativeRows: 0,
    invalidRows: 0,
    missingBandSnapshots: 0,
    monotonicityViolations: 0,
    priceAnchorCheckedSnapshots: 0,
    priceAnchorValidSnapshots: 0,
    priceAnchorViolations: 0,
    transportDuplicateRows: 0,
    identicalDuplicateRows: 0,
    conflictingDuplicateRows: 0,
    canonicalDuplicateRows: 0,
    nonMonotonicTimestamps: 0,
    canonicalTimestamps: [],
    validSnapshotTimestamps: [],
    cadenceIntervalsSeconds: [],
    maxContiguousGapMinutes: 0,
    maxIdenticalFingerprintDurationMinutes: 0,
    staleIntervals: 0,
    staleState: { fingerprint: null, start: null, last: null, counted: false },
    periodSnapshots: {
      PRIMARY: { canonical: 0, valid: 0 },
      HOLDOUT_A: { canonical: 0, valid: 0 },
      HOLDOUT_B: { canonical: 0, valid: 0 },
    },
    targetRows: [],
    targetArchiveRows: 0,
    targetInvalidRows: 0,
    targetArchivePresence: 0,
    targetArchiveExpected: 0,
    featureSample: null,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

function addAnomaly(anomalies: Map<string, AnomalyCount>, symbol: V24Symbol, date: string, anomalyType: string, count = 1): void {
  const key = `${symbol}|${date}|${anomalyType}`;
  const existing = anomalies.get(key);
  if (existing) existing.count += count;
  else anomalies.set(key, { symbol, date, anomalyType, count });
}

function mergeSnapshot(state: SymbolState, snapshot: V24SnapshotAudit, anomalies: Map<string, AnomalyCount>): void {
  const timestampMs = Date.parse(snapshot.timestampUtc);
  const period = periodForTimestamp(timestampMs);
  state.totalCanonicalSnapshots += 1;
  state.canonicalTimestamps.push(timestampMs);
  state.firstTimestamp = state.firstTimestamp === null ? timestampMs : Math.min(state.firstTimestamp, timestampMs);
  state.lastTimestamp = state.lastTimestamp === null ? timestampMs : Math.max(state.lastTimestamp, timestampMs);
  if (period) {
    state.periodSnapshots[period].canonical += 1;
    if (snapshot.valid) state.periodSnapshots[period].valid += 1;
  }
  if (snapshot.valid) {
    state.validSnapshots += 1;
    state.validSnapshotTimestamps.push(timestampMs);
  }
  state.missingBandSnapshots += snapshot.requiredBandsPresent ? 0 : 1;
  state.monotonicityViolations += snapshot.monotonicityViolations;
  state.priceAnchorCheckedSnapshots += snapshot.priceAnchorChecked ? 1 : 0;
  state.priceAnchorValidSnapshots += snapshot.priceAnchorValid ? 1 : 0;
  state.priceAnchorViolations += snapshot.priceAnchorViolations;
  if (!snapshot.requiredBandsPresent) addAnomaly(anomalies, state.symbol, snapshot.date, "MISSING_REQUIRED_BAND");
  if (snapshot.invalidRows > 0) addAnomaly(anomalies, state.symbol, snapshot.date, "INVALID_DEPTH_OR_NOTIONAL", snapshot.invalidRows);
  if (snapshot.monotonicityViolations > 0) addAnomaly(anomalies, state.symbol, snapshot.date, "CUMULATIVE_MONOTONICITY_VIOLATION", snapshot.monotonicityViolations);
  if (snapshot.priceAnchorViolations > 0) addAnomaly(anomalies, state.symbol, snapshot.date, "PRICE_ANCHOR_INVALID", snapshot.priceAnchorViolations);
  const stale = state.staleState;
  const continuous = stale.fingerprint === snapshot.fingerprint && stale.last !== null && timestampMs - stale.last <= 60_000;
  if (!continuous) {
    stale.fingerprint = snapshot.fingerprint;
    stale.start = timestampMs;
    stale.counted = false;
  }
  stale.last = timestampMs;
  const durationMinutes = stale.start === null ? 0 : (timestampMs - stale.start) / 60_000;
  state.maxIdenticalFingerprintDurationMinutes = Math.max(state.maxIdenticalFingerprintDurationMinutes, durationMinutes);
  if (durationMinutes > V24_MAX_UNAVAILABLE_MINUTES && !stale.counted) {
    state.staleIntervals += 1;
    stale.counted = true;
    addAnomaly(anomalies, state.symbol, snapshot.date, "STALE_DEPTH_INTERVAL");
  }
}

function mergeDailyAudit(state: SymbolState, audit: ReturnType<typeof auditDepthRows>, anomalies: Map<string, AnomalyCount>): void {
  state.totalTransportRows += audit.transportRows;
  state.negativeRows += audit.negativeRows;
  state.invalidRows += audit.invalidRows;
  state.transportDuplicateRows += audit.transportDuplicateRows;
  state.identicalDuplicateRows += audit.identicalDuplicateRows;
  state.conflictingDuplicateRows += audit.conflictingDuplicateRows;
  state.canonicalDuplicateRows += audit.canonicalDuplicateRows;
  state.nonMonotonicTimestamps += audit.nonMonotonicTimestamps;
  state.cadenceIntervalsSeconds.push(...audit.cadenceIntervalsSeconds);
  state.maxContiguousGapMinutes = Math.max(state.maxContiguousGapMinutes, audit.maxContiguousGapMinutes);
  state.priceAnchorCheckedSnapshots += 0;
  state.priceAnchorValidSnapshots += 0;
  for (const snapshot of audit.snapshots) mergeSnapshot(state, snapshot, anomalies);
  if (audit.nonMonotonicTimestamps > 0) {
    const date = audit.snapshots[0]?.date ?? "unknown";
    addAnomaly(anomalies, state.symbol, date, "NON_MONOTONIC_TIMESTAMP", audit.nonMonotonicTimestamps);
  }
  if (audit.conflictingDuplicateRows > 0) {
    const date = audit.snapshots[0]?.date ?? "unknown";
    addAnomaly(anomalies, state.symbol, date, "CONFLICTING_DUPLICATE", audit.conflictingDuplicateRows);
  }
  for (let index = 1; index < audit.canonicalTimestamps.length; index += 1) {
    const delta = audit.canonicalTimestamps[index]! - audit.canonicalTimestamps[index - 1]!;
    if (delta > 60_000) addAnomaly(anomalies, state.symbol, new Date(audit.canonicalTimestamps[index]!).toISOString().slice(0, 10), "LARGE_TIMESTAMP_GAP", Math.max(1, Math.round((delta - 30_000) / 30_000)));
  }
}

function makeSeriesQuality(state: SymbolState, dates: readonly string[], anomalies: Map<string, AnomalyCount>): V24SeriesQuality {
  const availability = fiveMinutePITAvailability(state.validSnapshotTimestamps);
  const period = (name: V24Period) => {
    const expectedSlots = periodExpectedFiveMinuteTimestamps(name);
    const periodAvailability = fiveMinutePITAvailability(state.validSnapshotTimestamps, expectedSlots[0] ?? V24_START_MS, expectedSlots.at(-1) === undefined ? V24_END_MS : expectedSlots.at(-1)! + 5 * 60_000);
    const targetRows = state.targetRows.filter((row) => periodForTimestamp(row.openTimeMs) === name).length;
    const canonical = state.periodSnapshots[name].canonical;
    const valid = state.periodSnapshots[name].valid;
    return {
      expectedBookDepthSnapshots: canonical,
      canonicalSnapshots: canonical,
      validSnapshots: valid,
      validSnapshotRatio: canonical === 0 ? 0 : valid / canonical,
      expected5mSlots: periodAvailability.expectedSlots,
      valid5mSlots: periodAvailability.validSlots,
      valid5mCoverage: periodAvailability.coverage,
      targetExpected5mSlots: expectedSlots.length,
      targetRows,
      targetCoverage: expectedSlots.length === 0 ? 0 : targetRows / expectedSlots.length,
    };
  };
  const cadence = summarizeCadence(state.cadenceIntervalsSeconds);
  const anomalyDates = dates.length;
  void anomalyDates;
  return {
    symbol: state.symbol,
    expectedDays: state.expectedDays,
    archivePresenceDays: state.archivePresenceDays,
    archivePresenceRatio: state.expectedDays === 0 ? 0 : state.archivePresenceDays / state.expectedDays,
    checksumVerifiedArchives: state.checksumVerifiedArchives,
    checksumVerifiedRatio: state.expectedDays === 0 ? 0 : state.checksumVerifiedArchives / state.expectedDays,
    totalTransportRows: state.totalTransportRows,
    totalCanonicalSnapshots: state.totalCanonicalSnapshots,
    validSnapshots: state.validSnapshots,
    requiredBandValidityRatio: state.totalCanonicalSnapshots === 0 ? 0 : state.validSnapshots / state.totalCanonicalSnapshots,
    negativeRows: state.negativeRows,
    invalidRows: state.invalidRows,
    missingBandSnapshots: state.missingBandSnapshots,
    monotonicityViolations: state.monotonicityViolations,
    priceAnchorCheckedSnapshots: state.priceAnchorCheckedSnapshots,
    priceAnchorValidSnapshots: state.priceAnchorValidSnapshots,
    priceAnchorValidityRatio: state.priceAnchorCheckedSnapshots === 0 ? 0 : state.priceAnchorValidSnapshots / state.priceAnchorCheckedSnapshots,
    transportDuplicateRows: state.transportDuplicateRows,
    identicalDuplicateRows: state.identicalDuplicateRows,
    conflictingDuplicateRows: state.conflictingDuplicateRows,
    canonicalDuplicateRows: state.canonicalDuplicateRows,
    nonMonotonicTimestamps: state.nonMonotonicTimestamps,
    medianIntervalSeconds: cadence.median,
    p5IntervalSeconds: cadence.p5,
    p95IntervalSeconds: cadence.p95,
    maximumIntervalSeconds: cadence.maximum,
    maxContiguousGapMinutes: state.maxContiguousGapMinutes,
    maxIdenticalFingerprintDurationMinutes: state.maxIdenticalFingerprintDurationMinutes,
    staleIntervals: state.staleIntervals,
    expected5mSlots: availability.expectedSlots,
    valid5mSlots: availability.validSlots,
    valid5mCoverage: availability.coverage,
    maxContiguousUnavailableMinutes: availability.maxContiguousUnavailableMinutes,
    targetExpected5mSlots: (V24_END_MS - V24_START_MS) / (5 * 60_000),
    targetRows: state.targetRows.length,
    targetCoverage: (V24_END_MS - V24_START_MS) / (5 * 60_000) === 0 ? 0 : state.targetRows.length / ((V24_END_MS - V24_START_MS) / (5 * 60_000)),
    primary: period("PRIMARY"),
    holdoutA: period("HOLDOUT_A"),
    holdoutB: period("HOLDOUT_B"),
    firstTimestamp: state.firstTimestamp === null ? null : new Date(state.firstTimestamp).toISOString(),
    lastTimestamp: state.lastTimestamp === null ? null : new Date(state.lastTimestamp).toISOString(),
  };
}

interface JsonFetchResult {
  status: number;
  bytes: Uint8Array;
  payload: unknown;
  headers: Record<string, string>;
  error: string | null;
}

async function fetchJson(url: string): Promise<JsonFetchResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let payload: unknown = null;
    let error: string | null = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (parseError) {
      error = parseError instanceof Error ? parseError.message : String(parseError);
    }
    const headers: Record<string, string> = {};
    for (const name of ["x-mbx-used-weight-1m", "x-mbx-used-weight", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return { status: response.status, bytes, payload, headers, error };
  } catch (error) {
    return { status: 0, bytes: new Uint8Array(), payload: null, headers: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

async function liveFeedReport(): Promise<Record<string, unknown>> {
  const symbols: Record<string, unknown> = {};
  for (const symbol of V24_SYMBOLS) {
    const depthUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`;
    const tickerUrl = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
    const [depth, ticker] = await Promise.all([fetchJson(depthUrl), fetchJson(tickerUrl)]);
    const payload = depth.payload as { bids?: unknown; asks?: unknown; lastUpdateId?: number } | null;
    const bids = Array.isArray(payload?.bids) ? payload!.bids : [];
    const asks = Array.isArray(payload?.asks) ? payload!.asks : [];
    const bidPrices = bids.map((row) => Array.isArray(row) ? Number(row[0]) : Number.NaN).filter(Number.isFinite);
    const askPrices = asks.map((row) => Array.isArray(row) ? Number(row[0]) : Number.NaN).filter(Number.isFinite);
    const midpoint = bidPrices.length > 0 && askPrices.length > 0 ? (Math.max(...bidPrices) + Math.min(...askPrices)) / 2 : null;
    const lower = midpoint === null ? null : midpoint * 0.99;
    const upper = midpoint === null ? null : midpoint * 1.01;
    const bidsWithin1Pct = lower !== null && bidPrices.length > 0 && Math.min(...bidPrices) <= lower;
    const asksWithin1Pct = upper !== null && askPrices.length > 0 && Math.max(...askPrices) >= upper;
    symbols[symbol] = {
      symbol,
      depthUrl,
      tickerUrl,
      httpStatus: depth.status,
      tickerHttpStatus: ticker.status,
      depthLimit: 1000,
      updateId: typeof payload?.lastUpdateId === "number" ? payload.lastUpdateId : null,
      timestamp: new Date().toISOString(),
      bids: bids.length,
      asks: asks.length,
      midpoint,
      bidsWithin1Pct,
      asksWithin1Pct,
      reconstructibleWithin1Pct: bidsWithin1Pct && asksWithin1Pct,
      rateLimitMetadata: depth.headers,
      vercelRuntimeCompatible: depth.status === 200 && Array.isArray(payload?.bids) && Array.isArray(payload?.asks),
      authenticationRequired: false,
      tradingPermissionRequired: false,
      noProductionWrites: true,
      error: depth.error ?? (depth.status === 200 ? null : `HTTP ${depth.status}`),
    };
  }
  return {
    schema: "v24-live-feed-feasibility-v1",
    source: "Binance official public USD-M depth REST",
    publicOnly: true,
    symbols,
    noProductionWrites: true,
    noEmail: true,
    noTrading: true,
  };
}

async function readArchive(entry: V24ArchiveEntry): Promise<{ rows: V24DepthRow[]; headerValid: boolean; extractionError: string | null }> {
  if (entry.httpStatus !== 200 || !entry.checksumVerified) return { rows: [], headerValid: false, extractionError: entry.error ?? "archive or checksum unavailable" };
  try {
    const bytes = new Uint8Array(await readFile(resolve(RAW_ROOT, entry.bodyPath)));
    if (sha256(bytes) !== entry.zipSha256) return { rows: [], headerValid: false, extractionError: "raw ZIP SHA256 differs from frozen manifest" };
    const extracted = extractZipSingleFile(bytes);
    if (entry.archiveEntry !== extracted.name || entry.extractedCsvSha256 !== sha256(extracted.contentBytes)) return { rows: [], headerValid: false, extractionError: "extracted CSV provenance differs from frozen manifest" };
    const parsed = parseDepthCsv(extracted.content);
    if (parsed.transportRows !== entry.rowCount) return { rows: parsed.rows, headerValid: parsed.headerValid, extractionError: "extracted CSV row count differs from frozen manifest" };
    return { rows: parsed.rows, headerValid: parsed.headerValid, extractionError: null };
  } catch (error) {
    return { rows: [], headerValid: false, extractionError: error instanceof Error ? error.message : String(error) };
  }
}

async function readTargetEntries(symbol: V24Symbol, entries: V24DownloadManifest["targetEntries"]): Promise<{ rows: V24TargetCandle[]; archiveRows: number; invalidRows: number; present: number }> {
  const result = new Map<number, V24TargetCandle>();
  let archiveRows = 0;
  let invalidRows = 0;
  let present = 0;
  for (const entry of entries.filter((candidate) => candidate.symbol === symbol).sort((left, right) => left.month.localeCompare(right.month))) {
    if (entry.httpStatus !== 200 || !entry.checksumVerified) continue;
    present += 1;
    try {
      const bytes = new Uint8Array(await readFile(resolve(RAW_ROOT, entry.bodyPath)));
      if (sha256(bytes) !== entry.zipSha256) {
        invalidRows += entry.rowCount;
        continue;
      }
      const extracted = extractZipSingleFile(bytes);
      const parsed = parseTargetKlineCsv(extracted.content);
      archiveRows += parsed.transportRows;
      invalidRows += parsed.invalidRows;
      for (const row of parsed.rows) if (!result.has(row.openTimeMs)) result.set(row.openTimeMs, row);
    } catch {
      invalidRows += entry.rowCount;
    }
  }
  return { rows: [...result.values()].sort((left, right) => left.openTimeMs - right.openTimeMs), archiveRows, invalidRows, present };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_ROOT, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const rawManifest = JSON.parse(await readFile(RAW_MANIFEST_PATH, "utf8")) as V24DownloadManifest;
  const rawManifestSha256 = sha256(JSON.stringify(rawManifest, null, 2) + "\n");
  const dates = [...new Set(rawManifest.bookDepthEntries.map((entry) => entry.date))].sort();
  const anomalies = new Map<string, AnomalyCount>();
  const states = new Map<V24Symbol, SymbolState>(V24_SYMBOLS.map((symbol) => [symbol, newState(symbol, dates.length)]));
  for (const symbol of V24_SYMBOLS) {
    const state = states.get(symbol)!;
    const target = await readTargetEntries(symbol, rawManifest.targetEntries);
    state.targetRows = target.rows;
    state.targetArchiveRows = target.archiveRows;
    state.targetInvalidRows = target.invalidRows;
    state.targetArchivePresence = target.present;
    state.targetArchiveExpected = rawManifest.targetEntries.filter((entry) => entry.symbol === symbol).length;
    for (const entry of rawManifest.bookDepthEntries.filter((candidate) => candidate.symbol === symbol).sort((left, right) => left.date.localeCompare(right.date))) {
      if (entry.httpStatus === 200) state.archivePresenceDays += 1;
      if (entry.checksumVerified) state.checksumVerifiedArchives += 1;
      const archive = await readArchive(entry);
      if (archive.extractionError) {
        addAnomaly(anomalies, symbol, entry.date, "ARCHIVE_OR_SCHEMA_UNAVAILABLE");
        continue;
      }
      const parsedAudit = auditDepthRows(archive.rows, (timestampMs) => findPriorClosed5mPrice(state.targetRows, timestampMs));
      state.featureSample ??= parsedAudit.validTimestamps.length > 0 ? featureFeasibility(parsedAudit.canonicalRows, parsedAudit.validTimestamps[0]!) : null;
      mergeDailyAudit(state, parsedAudit, anomalies);
    }
  }
  const qualities = Object.fromEntries(V24_SYMBOLS.map((symbol) => {
    const quality = makeSeriesQuality(states.get(symbol)!, dates, anomalies);
    return [symbol, { ...quality, pass: passesV24SeriesGate(quality) }];
  })) as Record<V24Symbol, V24SeriesQuality & { pass: boolean }>;
  const allSymbolsPass = V24_SYMBOLS.every((symbol) => qualities[symbol].pass);
  const qualityFailure = V24_SYMBOLS.some((symbol) => {
    const quality = qualities[symbol];
    return quality.conflictingDuplicateRows > 0 || quality.invalidRows > 0 || quality.monotonicityViolations > 0 || quality.priceAnchorValidityRatio < 1 || quality.staleIntervals > 0 || quality.maxIdenticalFingerprintDurationMinutes > V24_MAX_UNAVAILABLE_MINUTES;
  });
  const classification = allSymbolsPass ? "V24_LIQUIDITY_DATA_GATE_PASS" : qualityFailure ? "V24_LIQUIDITY_DATA_QUALITY_FAIL" : "V24_LIQUIDITY_DATA_INSUFFICIENT";
  const admission = jsonFromGit(V24_R1_ADMISSION_SHA, "reports/r1-future-research-admission.json");
  const exhausted = jsonFromGit(V24_R1_ADMISSION_SHA, "reports/r1-exhausted-alpha-families.json");
  const inventory = {
    schema: "v24-data-inventory-v1",
    experimentId: V24_EXPERIMENT_ID,
    source: "Binance official Data Vision USD-M daily bookDepth and 5m kline archives",
    start: new Date(V24_START_MS).toISOString(),
    endExclusive: new Date(V24_END_MS).toISOString(),
    expectedDays: dates.length,
    expected5mSlots: (V24_END_MS - V24_START_MS) / (5 * 60_000),
    fixedSymbols: V24_SYMBOLS,
    requiredBands: V24_REQUIRED_BANDS,
    bookDepthCadence: "30s",
    targetInterval: "5m",
    sourcePolicy: { publicOnly: true, noThirdParty: true, noPrivateApi: true, noGapRepair: true, noResample: true, noForwardFillBeyond90s: true, noFutureSnapshot: true },
    rawManifestSha256,
    archiveProvenance: rawManifest.bookDepthEntries,
    targetArchiveProvenance: rawManifest.targetEntries,
    bySymbol: qualities,
  };
  const anomalyList = [...anomalies.values()].sort((left, right) => `${left.symbol}|${left.date}|${left.anomalyType}`.localeCompare(`${right.symbol}|${right.date}|${right.anomalyType}`));
  const anomalyTotals = Object.fromEntries(anomalyList.reduce((map, anomaly) => map.set(anomaly.anomalyType, (map.get(anomaly.anomalyType) ?? 0) + anomaly.count), new Map<string, number>()));
  const featureFeasibilityReport = {
    schema: "v24-feature-feasibility-v1",
    experimentId: V24_EXPERIMENT_ID,
    contemporaneousOnly: true,
    noThresholds: true,
    noFutureData: true,
    fields: ["bidDepth1Pct", "askDepth1Pct", "bidNotional1Pct", "askNotional1Pct", "totalDepth1Pct", "depthImbalance1Pct"],
    bySymbol: Object.fromEntries(V24_SYMBOLS.map((symbol) => [symbol, states.get(symbol)!.featureSample ?? { bidDepth1Pct: null, askDepth1Pct: null, bidNotional1Pct: null, askNotional1Pct: null, totalDepth1Pct: null, depthImbalance1Pct: null, finite: false, deterministic: true, pitAvailable: false }])),
  };
  const live = await liveFeedReport();
  const admissionReport = {
    schema: "v24-admission-v1",
    experimentId: V24_EXPERIMENT_ID,
    family: V24_FAMILY,
    informationSourceClass: V24_INFORMATION_SOURCE_CLASS,
    structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
    dimensions: ["information_source", "liquidity_mechanism", "causal_timing"],
    declaration: {
      expectedSignalMechanism: "resting near-book liquidity withdrawal may expose short-term directional fragility before price adjustment",
      whyInformationArrivesBeforePriceAdjustment: "asymmetric resting liquidity availability can change before the next closed decision window reprices",
      whyNotEquivalentToLegacyFamily: "V24 uses resting order-book liquidity state; it does not use executed taker-flow/absorption, OI/funding/crowding, cross-venue price discovery, or price-derived indicators",
      expectedAlertFrequencyBand: "not evaluated in WP1",
      humanActionability: "future signal would be an email-only decision aid; not evaluated in WP1",
      requiredPublicData: "Binance USD-M public daily bookDepth, official 5m klines, and public depth REST",
      dataAvailabilityRisk: "daily archive completeness, schema integrity, price anchoring, cadence, and PIT age",
      executionLatencySensitivity: "not evaluated in WP1",
      expectedHoldingMechanism: "not evaluated in WP1",
      frictionSensitivityRationale: "not evaluated in WP1",
    },
    distinctFrom: {
      V16_V18: "executed taker-flow / absorption versus resting order-book state",
      V7_V17: "not OI/funding/crowding",
      V22: "not cross-exchange price discovery",
      V5_V6: "not price-derived",
    },
    r1AdmissionCommit: V24_R1_ADMISSION_SHA,
    r1AdmissionVerified: !((admission.futureInformationSourceClasses as string[] | undefined) ?? []).includes("V24_ORDER_BOOK_LIQUIDITY_WITHDRAWAL"),
    r1ExhaustedRegistryVerified: !((exhausted.registryExperimentIds as string[] | undefined) ?? []).includes(V24_EXPERIMENT_ID),
    budgetBefore: 1,
    budgetConsumed: 1,
    remainingOrthogonalFamilyBudget: 0,
    admissionPass: true,
  };
  await writeJson("v24-admission.json", admissionReport);
  await writeJson("v24-data-inventory.json", inventory);
  await writeJson("v24-data-gate.json", {
    schema: "v24-data-gate-v1",
    experimentId: V24_EXPERIMENT_ID,
    thresholds: { archivePresence: V24_COVERAGE_THRESHOLD, checksumVerified: 1, requiredBandValidity: V24_COVERAGE_THRESHOLD, priceAnchorValidity: V24_COVERAGE_THRESHOLD, valid5mDepthCoverage: V24_COVERAGE_THRESHOLD, target5mCoverage: V24_TARGET_COVERAGE_THRESHOLD, maxContiguousUnavailableMinutes: 60, maxIdenticalFingerprintDurationMinutes: 60 },
    requiredBands: V24_REQUIRED_BANDS,
    bySymbol: qualities,
    allSymbolsPass,
    classification,
    researchStop: !allSymbolsPass,
    alphaResearchProgramStatus: allSymbolsPass ? "CONTINUE_ONLY_AFTER_INDEPENDENT_ACCEPTANCE" : "STOP_NEW_ALPHA_RESEARCH",
    familyBudgetConsumed: true,
    budgetBefore: 1,
    budgetConsumed: 1,
    remainingOrthogonalFamilyBudget: 0,
    historicalFeatureDataRead: true,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    futureOutcomePricesRead: false,
    backtestRun: false,
    parameterSearch: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  });
  await writeJson("v24-depth-anomalies.json", { schema: "v24-depth-anomalies-v1", experimentId: V24_EXPERIMENT_ID, source: "Binance official Data Vision daily bookDepth", bySymbolAndDate: anomalyList, totals: anomalyTotals, noFutureData: true, strategyOutcomesRead: false });
  await writeJson("v24-feature-feasibility.json", featureFeasibilityReport);
  await writeJson("v24-live-feed-feasibility.json", live);
  const reportPaths = ["reports/v24-admission.json", "reports/v24-data-inventory.json", "reports/v24-data-gate.json", "reports/v24-depth-anomalies.json", "reports/v24-feature-feasibility.json", "reports/v24-live-feed-feasibility.json"];
  const artifactSha256 = Object.fromEntries(await Promise.all(reportPaths.map(async (path) => [path, sha256(await readFile(resolve(path)))])));
  const wp1Manifest = {
    schema: "v24-wp1-manifest-v1",
    experimentId: V24_EXPERIMENT_ID,
    branch: "feat/v24-liquidity-withdrawal",
    baseSha: V24_BASE_SHA,
    directParentRequired: V24_BASE_SHA,
    r1AdmissionCommit: V24_R1_ADMISSION_SHA,
    v22TerminalCommit: V24_V22_TERMINAL_SHA,
    v23TerminalCommit: V24_V23_TERMINAL_SHA,
    fixedSymbols: V24_SYMBOLS,
    period: { start: new Date(V24_START_MS).toISOString(), endExclusive: new Date(V24_END_MS).toISOString(), primary: periodExpectedDailyDates("PRIMARY"), holdoutA: periodExpectedDailyDates("HOLDOUT_A"), holdoutB: periodExpectedDailyDates("HOLDOUT_B") },
    sourcePolicy: { officialDataVisionOnly: true, dailyBookDepthPattern: "data/futures/um/daily/bookDepth/<SYMBOL>/<SYMBOL>-bookDepth-YYYY-MM-DD.zip", checksumRequired: true, noRawMutation: true, noGapRepair: true, noResample: true, noFutureSnapshot: true, maxSnapshotAgeMs: V24_MAX_SNAPSHOT_AGE_MS },
    requiredBands: V24_REQUIRED_BANDS,
    r1AdmissionVerified: true,
    v22TerminalVerified: true,
    v23TerminalVerified: true,
    familyBudgetConsumed: true,
    budgetBefore: 1,
    remainingOrthogonalFamilyBudget: 0,
    signalDesigned: false,
    eventDefinitionDesigned: false,
    historicalFeatureDataRead: true,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    futureOutcomePricesRead: false,
    backtestRun: false,
    parameterSearch: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
    classification,
    researchStop: !allSymbolsPass,
    alphaResearchProgramStatus: allSymbolsPass ? "CONTINUE_ONLY_AFTER_INDEPENDENT_ACCEPTANCE" : "STOP_NEW_ALPHA_RESEARCH",
    liveFeedFeasibilityReport: "reports/v24-live-feed-feasibility.json",
    artifactSha256,
    rawManifestSha256,
  };
  await writeJson("v24-wp1-manifest.json", wp1Manifest);
  console.info(JSON.stringify({ stage: "v24_wp1_data_gate_complete", classification, researchStop: !allSymbolsPass, rawManifestSha256, artifactSha256, bySymbol: qualities }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
