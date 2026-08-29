import {
  buildRollingUniverseSnapshot,
  compareUniverseSnapshots,
  summarizeUniverseParity,
  type ObservedUniverseSnapshot,
  type UniverseParityMetrics,
} from "./universe-replay";
import type { LfvBar } from "./archive-data";

export interface ObservedUniverseGroupInput {
  scanGroupKey: string;
  scanTimestamp: string;
  selectedForEvaluation: string[];
  observedRankedSymbols: string[];
}

export interface ObservedProxyBarInput {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
}

export interface ObservedProxyResultInput {
  symbol: string;
  bars: ObservedProxyBarInput[];
  error?: string;
}

export interface LiveParitySymbolInput {
  symbol: string;
  scanGroupKey?: string;
  sourceDataTimestamp?: string;
  strategyVersion?: string;
}

export interface ObservedUniverseParityResult {
  metrics: UniverseParityMetrics;
  dataCoverage: {
    observedGroups: number;
    observedSymbols: number;
    completeSymbols: number;
    incompleteSymbols: string[];
    matchedSignalRows: number;
    signalRowsEvaluated: number;
    signalRowsIncluded: number;
    signalRowsMissingArchive: number;
  };
}

export function mergeObservedProxyResults(
  initial: ObservedProxyResultInput[],
  retry: ObservedProxyResultInput[],
): Map<string, ObservedProxyResultInput> {
  const merged = new Map(initial.map((item) => [item.symbol, item]));
  for (const item of retry) {
    const current = merged.get(item.symbol);
    if (!current || item.bars.length > current.bars.length || Boolean(current.error && !item.error)) {
      merged.set(item.symbol, item);
    }
  }
  return merged;
}

export function calculateObservedUniverseParity(input: {
  groups: ObservedUniverseGroupInput[];
  initialResults: ObservedProxyResultInput[];
  retryResults?: ObservedProxyResultInput[];
  liveRows?: LiveParitySymbolInput[];
}): ObservedUniverseParityResult {
  const merged = mergeObservedProxyResults(input.initialResults, input.retryResults ?? []);
  const barsBySymbol = new Map<string, LfvBar[]>();
  const incompleteSymbols: string[] = [];
  for (const [symbol, result] of merged) {
    const bars = result.bars.filter((bar) => (
      Number.isFinite(bar.openTime)
      && Number.isFinite(bar.closeTime)
      && Number.isFinite(bar.quoteVolume)
    )).map((bar) => ({ ...bar }));
    barsBySymbol.set(symbol, bars);
    if (result.error || bars.length < 96) incompleteSymbols.push(symbol);
  }

  const liveRows = input.liveRows ?? [];
  const observedUniverseSymbols = [...new Set(input.groups.flatMap((group) => group.observedRankedSymbols))];
  const comparisons = input.groups.flatMap((group) => {
    const timestamp = Date.parse(group.scanTimestamp);
    if (!Number.isFinite(timestamp)) return [];
    const observed: ObservedUniverseSnapshot = {
      timestamp,
      rankedSymbols: group.observedRankedSymbols,
      selectedSymbols: group.selectedForEvaluation,
      signalSymbols: [...new Set(liveRows
        .filter((row) => row.scanGroupKey === group.scanGroupKey)
        .map((row) => row.symbol))],
    };
    const proxy = buildRollingUniverseSnapshot(timestamp, barsBySymbol, {
      requiredSymbols: group.observedRankedSymbols,
    });
    return [compareUniverseSnapshots(observed, proxy)];
  });
  const metrics = summarizeUniverseParity(comparisons, { requireSignalInclusion: false });
  let signalRowsEvaluated = 0;
  let signalRowsIncluded = 0;
  let signalRowsMissingArchive = 0;
  for (const row of liveRows) {
    const timestamp = Date.parse(row.sourceDataTimestamp ?? "");
    if (!row.symbol || !Number.isFinite(timestamp) || !observedUniverseSymbols.includes(row.symbol)) {
      signalRowsMissingArchive += 1;
      continue;
    }
    const proxy = buildRollingUniverseSnapshot(timestamp, barsBySymbol, {
      requiredSymbols: observedUniverseSymbols,
    });
    if (proxy.missingSymbols.length > 0) {
      signalRowsMissingArchive += 1;
      continue;
    }
    signalRowsEvaluated += 1;
    if (proxy.deepScan.includes(row.symbol)) signalRowsIncluded += 1;
  }
  const signalInclusionRecall = signalRowsEvaluated === 0
    ? null
    : signalRowsIncluded / signalRowsEvaluated;
  metrics.signalInclusionRecall = signalInclusionRecall;
  const signalCoverage = liveRows.length === 0 ? 0 : signalRowsEvaluated / liveRows.length;
  if (signalCoverage < 0.95) {
    metrics.pass = false;
    metrics.reasons = [
      ...metrics.reasons,
      `Frozen live signal archive coverage is below 95% (${signalRowsEvaluated}/${liveRows.length}).`,
    ];
  } else if (signalInclusionRecall === null || signalInclusionRecall < 0.98) {
    metrics.pass = false;
    metrics.reasons = [...metrics.reasons, "Signal-symbol inclusion recall is below 98%."];
  }
  if (incompleteSymbols.length > 0) {
    metrics.pass = false;
    metrics.reasons = [
      ...metrics.reasons,
      `${incompleteSymbols.length} observed symbols lack a complete immutable 96-bar PIT proxy window.`,
    ];
  }
  return {
    metrics,
    dataCoverage: {
      observedGroups: input.groups.length,
      observedSymbols: new Set(input.groups.flatMap((group) => group.observedRankedSymbols)).size,
      completeSymbols: [...merged.values()].filter((item) => !item.error && item.bars.length >= 96).length,
      incompleteSymbols: incompleteSymbols.sort(),
      matchedSignalRows: liveRows.filter((row) => input.groups.some((group) => group.scanGroupKey === row.scanGroupKey)).length,
      signalRowsEvaluated,
      signalRowsIncluded,
      signalRowsMissingArchive,
    },
  };
}
