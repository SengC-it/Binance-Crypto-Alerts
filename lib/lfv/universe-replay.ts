import type { LfvBar } from "./archive-data";

export const ROLLING_15M_24H_VOLUME_PROXY = "ROLLING_15M_24H_VOLUME_PROXY" as const;
export const ROLLING_WINDOW_BARS = 96;
export const DEEP_UNIVERSE_LIMIT = 100;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

export interface RollingUniversePoint {
  symbol: string;
  latestClosedBarTime: number;
  rollingQuoteVolume24h: number;
  barsUsed: number;
}

export interface RollingUniverseSnapshot {
  timestamp: number;
  method: typeof ROLLING_15M_24H_VOLUME_PROXY;
  eligible: RollingUniversePoint[];
  deepScan: string[];
  effectiveUniverseSize: number;
  missingSymbols: string[];
}

export interface ObservedUniverseSnapshot {
  timestamp: number;
  rankedSymbols: string[];
  selectedSymbols: string[];
  signalSymbols: string[];
}

export interface UniverseParityComparison {
  timestamp: number;
  top100Overlap: number;
  rankSpearman: number | null;
  signalInclusionRecall: number | null;
  signalCount: number;
}

export interface UniverseParityMetrics {
  method: typeof ROLLING_15M_24H_VOLUME_PROXY;
  snapshotsCompared: number;
  medianTop100Overlap: number | null;
  p10Top100Overlap: number | null;
  rankSpearman: number | null;
  signalInclusionRecall: number | null;
  comparisons: UniverseParityComparison[];
  pass: boolean;
  reasons: string[];
}

export function buildRollingUniverseSnapshot(
  timestamp: number,
  barsBySymbol: Map<string, LfvBar[]>,
  options: { topSymbols?: number; windowBars?: number; requiredSymbols?: string[] } = {},
): RollingUniverseSnapshot {
  const topSymbols = options.topSymbols ?? DEEP_UNIVERSE_LIMIT;
  const windowBars = options.windowBars ?? ROLLING_WINDOW_BARS;
  if (!Number.isFinite(timestamp) || windowBars <= 0 || topSymbols <= 0) {
    throw new Error("Invalid rolling universe options");
  }

  const eligible: RollingUniversePoint[] = [];
  const missingSymbols: string[] = [];
  const symbols = options.requiredSymbols ?? [...barsBySymbol.keys()];
  for (const symbol of symbols) {
    const bars = dedupeBars(barsBySymbol.get(symbol) ?? [])
      .filter((bar) => bar.closeTime < timestamp)
      .sort((left, right) => left.closeTime - right.closeTime);
    const window = bars.slice(-windowBars);
    if (
      window.length < windowBars
      || window.some((bar) => !Number.isFinite(bar.quoteVolume) || bar.quoteVolume < 0)
      || !hasCompleteIntervals(window)
    ) {
      missingSymbols.push(symbol);
      continue;
    }
    const latest = window.at(-1);
    if (!latest) {
      missingSymbols.push(symbol);
      continue;
    }
    const rollingQuoteVolume24h = window.reduce((sum, bar) => sum + bar.quoteVolume, 0);
    if (!Number.isFinite(rollingQuoteVolume24h) || rollingQuoteVolume24h <= 0) continue;
    eligible.push({
      symbol,
      latestClosedBarTime: latest.closeTime,
      rollingQuoteVolume24h,
      barsUsed: window.length,
    });
  }

  eligible.sort((left, right) => (
    right.rollingQuoteVolume24h - left.rollingQuoteVolume24h
    || left.symbol.localeCompare(right.symbol)
  ));
  const deepScan = eligible.slice(0, Math.min(topSymbols, eligible.length)).map((item) => item.symbol);
  return {
    timestamp,
    method: ROLLING_15M_24H_VOLUME_PROXY,
    eligible,
    deepScan,
    effectiveUniverseSize: deepScan.length,
    missingSymbols: missingSymbols.sort(),
  };
}

function hasCompleteIntervals(bars: LfvBar[]): boolean {
  return bars.every((bar, index) => (
    bar.closeTime === bar.openTime + FIFTEEN_MINUTES - 1
    && (index === 0 || bar.openTime === bars[index - 1].openTime + FIFTEEN_MINUTES)
  ));
}

export function compareUniverseSnapshots(
  observed: ObservedUniverseSnapshot,
  proxy: RollingUniverseSnapshot,
): UniverseParityComparison {
  const observedTop = observed.selectedSymbols.length > 0
    ? observed.selectedSymbols.slice(0, DEEP_UNIVERSE_LIMIT)
    : observed.rankedSymbols.slice(0, DEEP_UNIVERSE_LIMIT);
  const proxyTop = proxy.deepScan.slice(0, DEEP_UNIVERSE_LIMIT);
  const observedSet = new Set(observedTop);
  const proxySet = new Set(proxyTop);
  const intersection = [...observedSet].filter((symbol) => proxySet.has(symbol)).length;
  const signalSymbols = [...new Set(observed.signalSymbols)];
  const signalMatches = signalSymbols.filter((symbol) => proxySet.has(symbol)).length;
  return {
    timestamp: observed.timestamp,
    top100Overlap: observedTop.length === 0 ? 0 : intersection / observedTop.length,
    rankSpearman: spearmanRank(observed.rankedSymbols, proxy.eligible.map((item) => item.symbol)),
    signalInclusionRecall: signalSymbols.length === 0 ? null : signalMatches / signalSymbols.length,
    signalCount: signalSymbols.length,
  };
}

export function summarizeUniverseParity(
  comparisons: UniverseParityComparison[],
  options: { requireSignalInclusion?: boolean } = {},
): UniverseParityMetrics {
  const requireSignalInclusion = options.requireSignalInclusion ?? true;
  const overlaps = comparisons.map((item) => item.top100Overlap).filter(Number.isFinite);
  const correlations = comparisons.map((item) => item.rankSpearman).filter((item): item is number => item !== null && Number.isFinite(item));
  const recalls = comparisons.map((item) => item.signalInclusionRecall).filter((item): item is number => item !== null && Number.isFinite(item));
  const medianTop100Overlap = quantile(overlaps, 0.5);
  const p10Top100Overlap = quantile(overlaps, 0.1);
  const rankSpearman = correlations.length === 0 ? null : correlations.reduce((sum, value) => sum + value, 0) / correlations.length;
  const signalInclusionRecall = recalls.length === 0 ? null : Math.min(...recalls);
  const reasons: string[] = [];
  if (comparisons.length === 0) reasons.push("No observed V5.5 universe snapshots had a complete 96-bar PIT proxy.");
  if (medianTop100Overlap === null || medianTop100Overlap < 0.95) reasons.push("Median Top100 membership overlap is below 95%.");
  if (p10Top100Overlap === null || p10Top100Overlap < 0.90) reasons.push("P10 Top100 membership overlap is below 90%.");
  if (requireSignalInclusion && (signalInclusionRecall === null || signalInclusionRecall < 0.98)) {
    reasons.push("Signal-symbol inclusion recall is below 98%.");
  }
  return {
    method: ROLLING_15M_24H_VOLUME_PROXY,
    snapshotsCompared: comparisons.length,
    medianTop100Overlap,
    p10Top100Overlap,
    rankSpearman,
    signalInclusionRecall,
    comparisons,
    pass: reasons.length === 0,
    reasons,
  };
}

function dedupeBars(bars: LfvBar[]): LfvBar[] {
  return [...new Map(bars.map((bar) => [bar.openTime, bar])).values()];
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function spearmanRank(left: string[], right: string[]): number | null {
  const rightRanks = new Map(right.map((symbol, index) => [symbol, index + 1]));
  const common = left.filter((symbol, index) => rightRanks.has(symbol) && left.indexOf(symbol) === index);
  if (common.length < 2) return null;
  const leftRanks = new Map(common.map((symbol, index) => [symbol, index + 1]));
  const rightValues = common.map((symbol) => rightRanks.get(symbol)!);
  const leftValues = common.map((symbol) => leftRanks.get(symbol)!);
  const leftMean = mean(leftValues);
  const rightMean = mean(rightValues);
  const numerator = leftValues.reduce((sum, value, index) => sum + (value - leftMean) * (rightValues[index] - rightMean), 0);
  const leftDenominator = Math.sqrt(leftValues.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightDenominator = Math.sqrt(rightValues.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftDenominator === 0 || rightDenominator === 0 ? null : numerator / (leftDenominator * rightDenominator);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
