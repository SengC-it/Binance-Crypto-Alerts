import {
  buildRollingUniverseSnapshot,
  type RollingUniverseSnapshot,
} from "./universe-replay";
import type { LfvBar } from "./archive-data";

export const LIVE_SIGNAL_UNIVERSE_RECONSTRUCTION = "ARCHIVE_REGISTRY_PIT_LIFECYCLE_PLUS_OFFICIAL_15M_WINDOW" as const;
export const LIVE_SIGNAL_UNIVERSE_COVERAGE_TARGET = 0.95;
export const LIVE_SIGNAL_UNIVERSE_RECALL_TARGET = 0.98;
export const PIT_MINIMUM_AGE_DAYS = 90;
export const LIVE_SIGNAL_WINDOW_BARS = 96;

export interface LiveSignalUniverseRow {
  symbol: string;
  sourceDataTimestamp: string;
  strategyVersion?: string;
}

export interface PitLifecycleSymbol {
  symbol: string;
  firstObserved: string | null;
  lastObserved: string | null;
}

export interface LiveSignalUniverseSnapshot {
  timestamp: string;
  lifecycleCandidateCount: number;
  activeWindowSymbolCount: number;
  inactiveOrUnqualifiedCount: number;
  unavailableSymbolCount: number;
  deepScan: string[];
  effectiveUniverseSize: number;
  signalRows: number;
  signalRowsEvaluated: number;
  signalRowsIncluded: number;
  signalRowsMissingArchive: number;
  missingSignalSymbols: string[];
}

export interface LiveSignalUniverseParityResult {
  reconstruction: typeof LIVE_SIGNAL_UNIVERSE_RECONSTRUCTION;
  snapshots: LiveSignalUniverseSnapshot[];
  dataCoverage: {
    frozenSignals: number;
    signalRowsEvaluated: number;
    signalRowsIncluded: number;
    signalRowsMissingArchive: number;
    signalCoverage: number;
    signalInclusionRecall: number | null;
    requestDataErrors: string[];
    snapshotsWithCompleteCandidateData: number;
  };
  pass: boolean;
  reasons: string[];
}

export function calculateLiveSignalUniverseParity(input: {
  rows: LiveSignalUniverseRow[];
  lifecycleSymbols: PitLifecycleSymbol[];
  barsBySymbol: Map<string, LfvBar[]>;
  requestDataErrors?: string[];
}): LiveSignalUniverseParityResult {
  const rowsByTimestamp = new Map<number, LiveSignalUniverseRow[]>();
  for (const row of input.rows) {
    const timestamp = Date.parse(row.sourceDataTimestamp);
    if (!Number.isFinite(timestamp)) continue;
    const current = rowsByTimestamp.get(timestamp) ?? [];
    current.push(row);
    rowsByTimestamp.set(timestamp, current);
  }

  const lifecycleSymbols = [...new Map(input.lifecycleSymbols.map((item) => [item.symbol, item])).values()];
  const requestDataErrors = [...new Set(input.requestDataErrors ?? [])].sort();
  const snapshots: LiveSignalUniverseSnapshot[] = [];
  let signalRowsEvaluated = 0;
  let signalRowsIncluded = 0;
  let snapshotsWithCompleteCandidateData = 0;

  for (const [timestamp, rows] of [...rowsByTimestamp.entries()].sort(([left], [right]) => left - right)) {
    const lifecycleCandidates = lifecycleSymbols.filter((item) => isPITLifecycleEligible(item, timestamp));
    const activeSymbols = lifecycleCandidates.filter((item) => hasCompleteWindow(input.barsBySymbol.get(item.symbol) ?? [], timestamp)).map((item) => item.symbol);
    const activeSet = new Set(activeSymbols);
    const snapshot = buildRollingUniverseSnapshot(timestamp, input.barsBySymbol, {
      topSymbols: 100,
      windowBars: LIVE_SIGNAL_WINDOW_BARS,
      requiredSymbols: activeSymbols,
    });
    const candidateDataComplete = snapshot.missingSymbols.length === 0;
    if (candidateDataComplete) snapshotsWithCompleteCandidateData += 1;
    const evaluatedRows = requestDataErrors.length === 0 && candidateDataComplete
      ? rows.filter((row) => activeSet.has(row.symbol))
      : [];
    const includedRows = evaluatedRows.filter((row) => snapshot.deepScan.includes(row.symbol));
    signalRowsEvaluated += evaluatedRows.length;
    signalRowsIncluded += includedRows.length;
    snapshots.push({
      timestamp: new Date(timestamp).toISOString(),
      lifecycleCandidateCount: lifecycleCandidates.length,
      activeWindowSymbolCount: activeSymbols.length,
      inactiveOrUnqualifiedCount: lifecycleCandidates.length - activeSymbols.length,
      unavailableSymbolCount: snapshot.missingSymbols.length,
      deepScan: snapshot.deepScan,
      effectiveUniverseSize: snapshot.effectiveUniverseSize,
      signalRows: rows.length,
      signalRowsEvaluated: evaluatedRows.length,
      signalRowsIncluded: includedRows.length,
      signalRowsMissingArchive: rows.length - evaluatedRows.length,
      missingSignalSymbols: [...new Set(rows.filter((row) => !activeSet.has(row.symbol)).map((row) => row.symbol))].sort(),
    });
  }

  const signalRowsMissingArchive = input.rows.length - signalRowsEvaluated;
  const signalCoverage = input.rows.length === 0 ? 0 : signalRowsEvaluated / input.rows.length;
  const signalInclusionRecall = signalRowsEvaluated === 0 ? null : signalRowsIncluded / signalRowsEvaluated;
  const reasons: string[] = [];
  if (requestDataErrors.length > 0) reasons.push(`Official live-window data errors: ${requestDataErrors.length}.`);
  if (snapshots.length === 0) reasons.push("No valid frozen live signal timestamps were available.");
  if (signalCoverage < LIVE_SIGNAL_UNIVERSE_COVERAGE_TARGET) {
    reasons.push(`Frozen live signal archive coverage is below 95% (${signalRowsEvaluated}/${input.rows.length}).`);
  } else if (signalInclusionRecall === null || signalInclusionRecall < LIVE_SIGNAL_UNIVERSE_RECALL_TARGET) {
    reasons.push(`Signal-symbol inclusion recall is below 98% (${formatRatio(signalInclusionRecall)}).`);
  }
  if (snapshots.some((snapshot) => snapshot.unavailableSymbolCount > 0)) {
    reasons.push("At least one PIT lifecycle candidate did not have a complete 96-bar window and could not be classified as active.");
  }

  return {
    reconstruction: LIVE_SIGNAL_UNIVERSE_RECONSTRUCTION,
    snapshots,
    dataCoverage: {
      frozenSignals: input.rows.length,
      signalRowsEvaluated,
      signalRowsIncluded,
      signalRowsMissingArchive,
      signalCoverage,
      signalInclusionRecall,
      requestDataErrors,
      snapshotsWithCompleteCandidateData,
    },
    pass: reasons.length === 0,
    reasons,
  };
}

function isPITLifecycleEligible(symbol: PitLifecycleSymbol, timestamp: number): boolean {
  if (!symbol.firstObserved) return false;
  const firstObserved = Date.parse(`${symbol.firstObserved}-01T00:00:00.000Z`);
  return Number.isFinite(firstObserved) && firstObserved <= timestamp - PIT_MINIMUM_AGE_DAYS * 86_400_000;
}

function hasCompleteWindow(bars: LfvBar[], timestamp: number): boolean {
  const ordered = [...new Map(bars.map((bar) => [bar.openTime, bar])).values()]
    .filter((bar) => bar.closeTime < timestamp)
    .sort((left, right) => left.openTime - right.openTime);
  const window = ordered.slice(-LIVE_SIGNAL_WINDOW_BARS);
  if (window.length !== LIVE_SIGNAL_WINDOW_BARS) return false;
  return window.every((bar, index) => (
    Number.isFinite(bar.quoteVolume)
    && bar.quoteVolume >= 0
    && bar.closeTime === bar.openTime + 15 * 60 * 1000 - 1
    && (index === 0 || bar.openTime === window[index - 1].openTime + 15 * 60 * 1000)
  ));
}

function formatRatio(value: number | null): string {
  return value === null ? "null" : value.toFixed(4);
}

export function liveSignalUniverseSnapshotToRollingSnapshot(
  snapshot: LiveSignalUniverseSnapshot,
): Pick<RollingUniverseSnapshot, "timestamp" | "deepScan" | "effectiveUniverseSize"> {
  return {
    timestamp: Date.parse(snapshot.timestamp),
    deepScan: snapshot.deepScan,
    effectiveUniverseSize: snapshot.effectiveUniverseSize,
  };
}
