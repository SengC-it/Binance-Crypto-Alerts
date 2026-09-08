import {
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_INTERVAL_MS,
  V21_SYMBOLS,
  type V21Symbol,
} from "./constants";
import {
  V21_PIT_OBSERVATION_COUNT,
  V21_PIT_WINDOW_MS,
} from "./features";
import { V21_Q99_TAIL_COUNT } from "./event-predicate";

export const V21_PRIMARY_OOS_START = Date.parse("2022-01-01T00:00:00.000Z");
export const V21_HOLDOUT_A_START = Date.parse("2025-01-01T00:00:00.000Z");
export const V21_HOLDOUT_B_START = Date.parse("2026-01-01T00:00:00.000Z");
export const V21_EVENT_END_EXCLUSIVE = Date.parse(V21_END_EXCLUSIVE_TIMESTAMP);
export const V21_PRIMARY_HORIZON_MS = 30 * 60 * 1000;

export type V21ReturnSeries = Readonly<Record<V21Symbol, ArrayLike<number>>>;

export interface V21SynchronizedReturnMatrix {
  openTimes: ArrayLike<number>;
  returnsBySymbol: V21ReturnSeries;
}

export interface V21EventIdentity {
  symbol: V21Symbol;
  signalOpenTime: number;
  direction: "LONG" | "SHORT";
  clusterId: number;
}

export interface V21EventEnumerationDiagnostics {
  synchronizedReturnRows: number;
  featureEvaluations: number;
  eligiblePitFeatures: number;
  ineligiblePitFeatures: number;
  ineligibleByReason: Record<string, number>;
  rawExtremeCandidates: number;
  firstCrossCandidates: number;
  zeroResidualFirstCrossCandidates: number;
  overlapExcluded: number;
  finalEligibleEvents: number;
  residualComparisons: {
    total: number;
    average: number;
    median: number;
    p95: number;
    p99: number;
  };
  earlyExits: number;
  fullWindowScans: number;
  exactThresholdComputations: number;
  eventsBySymbol: Record<V21Symbol, number>;
  eventsByDirection: { LONG: number; SHORT: number };
  eventsByPeriod: {
    primaryOos: number;
    holdoutA: number;
    holdoutB: number;
  };
  yearlyIdentityCounts: Record<string, number>;
  distinctPrimarySignalClusters: number;
}

export interface V21EventEnumerationResult {
  allEvents: V21EventIdentity[];
  primaryOosEvents: V21EventIdentity[];
  holdoutAEvents: V21EventIdentity[];
  holdoutBEvents: V21EventIdentity[];
  diagnostics: V21EventEnumerationDiagnostics;
}

interface RollingStats {
  sumX: number;
  sumY: number;
  sumXX: number;
  sumXY: number;
  invalidObservations: number;
}

interface CandidateEvent {
  symbol: V21Symbol;
  signalOpenTime: number;
  direction: "LONG" | "SHORT";
}

export function enumerateV21PreReturnEvents(
  input: V21SynchronizedReturnMatrix,
): V21EventEnumerationResult {
  assertMatrix(input);
  const rowCount = input.openTimes.length;
  const marketBySymbol = buildLeaveOneOutMarketMatrix(input.returnsBySymbol, rowCount);
  const stats = V21_SYMBOLS.map(() => emptyStats());
  const comparisonHistogram = new Uint32Array(V21_PIT_OBSERVATION_COUNT + 1);
  const ineligibleByReason: Record<string, number> = {};
  const candidates: CandidateEvent[] = [];
  let featureEvaluations = 0;
  let eligiblePitFeatures = 0;
  let ineligiblePitFeatures = 0;
  let rawExtremeCandidates = 0;
  let firstCrossCandidates = 0;
  let zeroResidualFirstCrossCandidates = 0;
  let earlyExits = 0;
  let fullWindowScans = 0;
  let exactThresholdComputations = 0;

  for (let rowIndex = 0; rowIndex < Math.min(V21_PIT_OBSERVATION_COUNT, rowCount); rowIndex += 1) {
    updateStats(stats, marketBySymbol, input.returnsBySymbol, rowIndex, 1);
  }

  for (let currentIndex = V21_PIT_OBSERVATION_COUNT; currentIndex < rowCount; currentIndex += 1) {
    const currentOpenTime = input.openTimes[currentIndex];
    const previousOpenTime = input.openTimes[currentIndex - 1];
    const inEnumerationWindow = currentOpenTime >= V21_PRIMARY_OOS_START
      && currentOpenTime < V21_EVENT_END_EXCLUSIVE;

    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      const symbol = V21_SYMBOLS[symbolIndex];
      featureEvaluations += 1;
      const reason = validateFeatureInput(
        input,
        marketBySymbol,
        stats[symbolIndex],
        currentIndex,
        previousOpenTime,
        currentOpenTime,
        symbolIndex,
      );
      if (reason !== null) {
        ineligiblePitFeatures += 1;
        ineligibleByReason[reason] = (ineligibleByReason[reason] ?? 0) + 1;
        continue;
      }

      eligiblePitFeatures += 1;
      const series = input.returnsBySymbol[symbol];
      const marketSeries = marketBySymbol[symbolIndex];
      const meanX = stats[symbolIndex].sumX / V21_PIT_OBSERVATION_COUNT;
      const meanY = stats[symbolIndex].sumY / V21_PIT_OBSERVATION_COUNT;
      const denominator = stats[symbolIndex].sumXX - stats[symbolIndex].sumX * meanX;
      const beta = (stats[symbolIndex].sumXY - stats[symbolIndex].sumX * meanY) / denominator;
      const alpha = meanY - beta * meanX;
      const previousResidual = series[currentIndex - 1]
        - (alpha + beta * marketSeries[currentIndex - 1]);
      const currentResidualExact = series[currentIndex]
        - (alpha + beta * marketSeries[currentIndex]);
      const currentAbs = Math.abs(currentResidualExact);
      let greaterCount = 0;
      let comparisons = 0;
      let earlyExit = false;

      for (let priorIndex = currentIndex - V21_PIT_OBSERVATION_COUNT; priorIndex < currentIndex; priorIndex += 1) {
        comparisons += 1;
        const priorResidual = series[priorIndex] - (alpha + beta * marketSeries[priorIndex]);
        if (Math.abs(priorResidual) > currentAbs) {
          greaterCount += 1;
          if (greaterCount > V21_Q99_TAIL_COUNT) {
            earlyExit = true;
            break;
          }
        }
      }
      comparisonHistogram[comparisons] += 1;
      if (earlyExit) {
        earlyExits += 1;
      } else {
        fullWindowScans += 1;
        exactThresholdComputations += 1;
        const absoluteResiduals = new Float64Array(V21_PIT_OBSERVATION_COUNT);
        for (let offset = 0; offset < V21_PIT_OBSERVATION_COUNT; offset += 1) {
          const priorIndex = currentIndex - V21_PIT_OBSERVATION_COUNT + offset;
          absoluteResiduals[offset] = Math.abs(series[priorIndex] - (alpha + beta * marketSeries[priorIndex]));
        }
        const threshold = selectKth(absoluteResiduals, Math.ceil(0.99 * V21_PIT_OBSERVATION_COUNT) - 1);
        if (inEnumerationWindow) {
          rawExtremeCandidates += 1;
          if (Math.abs(previousResidual) < threshold && currentAbs >= threshold) {
            firstCrossCandidates += 1;
            if (currentResidualExact === 0) {
              zeroResidualFirstCrossCandidates += 1;
            } else {
              candidates.push({
                symbol,
                signalOpenTime: currentOpenTime,
                direction: currentResidualExact > 0 ? "SHORT" : "LONG",
              });
            }
          }
        }
      }
    }

    updateStats(stats, marketBySymbol, input.returnsBySymbol, currentIndex - V21_PIT_OBSERVATION_COUNT, -1);
    updateStats(stats, marketBySymbol, input.returnsBySymbol, currentIndex, 1);
  }

  const overlapResult = applyV21TimestampOverlap(candidates);
  const allEvents = overlapResult.accepted;
  const primaryOosEvents = allEvents.filter((event) => event.signalOpenTime >= V21_PRIMARY_OOS_START && event.signalOpenTime < V21_HOLDOUT_A_START);
  const holdoutAEvents = allEvents.filter((event) => event.signalOpenTime >= V21_HOLDOUT_A_START && event.signalOpenTime < V21_HOLDOUT_B_START);
  const holdoutBEvents = allEvents.filter((event) => event.signalOpenTime >= V21_HOLDOUT_B_START && event.signalOpenTime < V21_EVENT_END_EXCLUSIVE);
  const eventsBySymbol = Object.fromEntries(V21_SYMBOLS.map((symbol) => [
    symbol,
    allEvents.filter((event) => event.symbol === symbol).length,
  ])) as Record<V21Symbol, number>;
  const eventsByDirection = {
    LONG: allEvents.filter((event) => event.direction === "LONG").length,
    SHORT: allEvents.filter((event) => event.direction === "SHORT").length,
  };
  const eventsByPeriod = {
    primaryOos: primaryOosEvents.length,
    holdoutA: holdoutAEvents.length,
    holdoutB: holdoutBEvents.length,
  };
  const yearlyIdentityCounts: Record<string, number> = {};
  for (const event of allEvents) {
    const year = String(new Date(event.signalOpenTime).getUTCFullYear());
    yearlyIdentityCounts[year] = (yearlyIdentityCounts[year] ?? 0) + 1;
  }
  const distinctPrimarySignalClusters = new Set(primaryOosEvents.map((event) => event.clusterId)).size;
  const comparisonObservations = histogramCount(comparisonHistogram);
  const totalComparisons = histogramWeightedTotal(comparisonHistogram);
  return {
    allEvents,
    primaryOosEvents,
    holdoutAEvents,
    holdoutBEvents,
    diagnostics: {
      synchronizedReturnRows: rowCount,
      featureEvaluations,
      eligiblePitFeatures,
      ineligiblePitFeatures,
      ineligibleByReason,
      rawExtremeCandidates,
      firstCrossCandidates,
      zeroResidualFirstCrossCandidates,
      overlapExcluded: overlapResult.excluded,
      finalEligibleEvents: allEvents.length,
      residualComparisons: {
        total: totalComparisons,
        average: totalComparisons / Math.max(1, featureEvaluations),
        median: histogramQuantile(comparisonHistogram, comparisonObservations, 0.5),
        p95: histogramQuantile(comparisonHistogram, comparisonObservations, 0.95),
        p99: histogramQuantile(comparisonHistogram, comparisonObservations, 0.99),
      },
      earlyExits,
      fullWindowScans,
      exactThresholdComputations,
      eventsBySymbol,
      eventsByDirection,
      eventsByPeriod,
      yearlyIdentityCounts,
      distinctPrimarySignalClusters,
    },
  };
}

export function applyV21TimestampOverlap(
  candidates: readonly CandidateEvent[],
): { accepted: V21EventIdentity[]; excluded: number } {
  const sorted = [...candidates].sort((left, right) => (
    left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol)
  ));
  const lastAcceptedBySymbol = new Map<V21Symbol, number>();
  const accepted: V21EventIdentity[] = [];
  let excluded = 0;
  for (const candidate of sorted) {
    const lastAccepted = lastAcceptedBySymbol.get(candidate.symbol);
    if (lastAccepted !== undefined && candidate.signalOpenTime < lastAccepted + V21_PRIMARY_HORIZON_MS) {
      excluded += 1;
      continue;
    }
    const event: V21EventIdentity = {
      symbol: candidate.symbol,
      signalOpenTime: candidate.signalOpenTime,
      direction: candidate.direction,
      clusterId: candidate.signalOpenTime,
    };
    accepted.push(event);
    lastAcceptedBySymbol.set(candidate.symbol, candidate.signalOpenTime);
  }
  return { accepted, excluded };
}

export function v21EventIdentityPayload(events: readonly V21EventIdentity[]): V21EventIdentity[] {
  return [...events]
    .sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol))
    .map((event) => ({
      symbol: event.symbol,
      signalOpenTime: event.signalOpenTime,
      direction: event.direction,
      clusterId: event.clusterId,
    }));
}

function assertMatrix(input: V21SynchronizedReturnMatrix): void {
  if (input.openTimes.length === 0) throw new Error("V21 synchronized input is empty");
  for (const symbol of V21_SYMBOLS) {
    if (input.returnsBySymbol[symbol].length !== input.openTimes.length) {
      throw new Error(`V21 synchronized length mismatch for ${symbol}`);
    }
  }
  for (let index = 0; index < input.openTimes.length; index += 1) {
    const openTime = input.openTimes[index];
    if (!Number.isSafeInteger(openTime) || openTime % V21_INTERVAL_MS !== 0) throw new Error("Invalid V21 synchronized timestamp");
    if (index > 0 && openTime !== input.openTimes[index - 1] + V21_INTERVAL_MS) throw new Error("V21 synchronized timestamps contain a gap");
    for (const symbol of V21_SYMBOLS) {
      if (!Number.isFinite(input.returnsBySymbol[symbol][index])) throw new Error(`Non-finite V21 synchronized value for ${symbol}`);
    }
  }
}

function buildLeaveOneOutMarketMatrix(
  returnsBySymbol: V21ReturnSeries,
  rowCount: number,
): Float64Array[] {
  const marketBySymbol = V21_SYMBOLS.map(() => new Float64Array(rowCount));
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let targetIndex = 0; targetIndex < V21_SYMBOLS.length; targetIndex += 1) {
      const values: number[] = [];
      for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
        if (symbolIndex !== targetIndex) values.push(returnsBySymbol[V21_SYMBOLS[symbolIndex]][rowIndex]);
      }
      values.sort((left, right) => left - right);
      marketBySymbol[targetIndex][rowIndex] = values[3];
    }
  }
  return marketBySymbol;
}

function validateFeatureInput(
  input: V21SynchronizedReturnMatrix,
  marketBySymbol: readonly Float64Array[],
  stats: RollingStats,
  currentIndex: number,
  previousOpenTime: number,
  currentOpenTime: number,
  symbolIndex: number,
): string | null {
  if (!Number.isSafeInteger(currentOpenTime) || currentOpenTime % V21_INTERVAL_MS !== 0) return "CURRENT_TIMESTAMP_INVALID";
  if (previousOpenTime !== currentOpenTime - V21_INTERVAL_MS) return "PREVIOUS_RETURN_NOT_ADJACENT";
  if (stats.invalidObservations > 0) return "NON_FINITE_OBSERVATION";
  if (currentIndex < V21_PIT_OBSERVATION_COUNT) return "PIT_OBSERVATION_COUNT_MISMATCH";
  if (input.openTimes[currentIndex] - input.openTimes[currentIndex - V21_PIT_OBSERVATION_COUNT] !== V21_PIT_WINDOW_MS) {
    return "PIT_WINDOW_NOT_EXACT";
  }
  const denominator = stats.sumXX - stats.sumX * (stats.sumX / V21_PIT_OBSERVATION_COUNT);
  if (!Number.isFinite(denominator) || denominator <= 0 || !Number.isFinite(marketBySymbol[symbolIndex][currentIndex])) return "ZERO_MARKET_VARIANCE";
  return null;
}

function emptyStats(): RollingStats {
  return { sumX: 0, sumY: 0, sumXX: 0, sumXY: 0, invalidObservations: 0 };
}

function updateStats(
  stats: RollingStats[],
  marketBySymbol: readonly Float64Array[],
  returnsBySymbol: V21ReturnSeries,
  rowIndex: number,
  direction: 1 | -1,
): void {
  for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
    const x = marketBySymbol[symbolIndex][rowIndex];
    const y = returnsBySymbol[V21_SYMBOLS[symbolIndex]][rowIndex];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      stats[symbolIndex].invalidObservations += direction;
      continue;
    }
    stats[symbolIndex].sumX += direction * x;
    stats[symbolIndex].sumY += direction * y;
    stats[symbolIndex].sumXX += direction * x * x;
    stats[symbolIndex].sumXY += direction * x * y;
  }
}

function selectKth(values: Float64Array, targetIndex: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    let low = left;
    let high = right;
    const pivot = values[Math.floor((left + right) / 2)];
    while (low <= high) {
      while (values[low] < pivot) low += 1;
      while (values[high] > pivot) high -= 1;
      if (low <= high) {
        const value = values[low];
        values[low] = values[high];
        values[high] = value;
        low += 1;
        high -= 1;
      }
    }
    if (targetIndex <= high) right = high;
    else if (targetIndex >= low) left = low;
    else return values[targetIndex];
  }
  return values[left];
}

function histogramCount(histogram: Uint32Array): number {
  let total = 0;
  for (const count of histogram) total += count;
  return total;
}

function histogramWeightedTotal(histogram: Uint32Array): number {
  let total = 0;
  for (let value = 0; value < histogram.length; value += 1) total += value * histogram[value];
  return total;
}

function histogramQuantile(histogram: Uint32Array, total: number, quantile: number): number {
  if (total === 0) return 0;
  const rank = Math.max(1, Math.ceil(total * quantile));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value];
    if (cumulative >= rank) return value;
  }
  return histogram.length - 1;
}
