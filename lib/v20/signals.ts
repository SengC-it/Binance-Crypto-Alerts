import { sha256 } from "./canonical";
import {
  V20_INTERVAL_MS,
  V20_PIT_WINDOW_BARS,
  V20_SIGNAL_QUANTILE,
  evaluationWindowFor,
  type V20EvaluationWindow,
  type V20Symbol,
} from "./constants";
import type { V20SynchronizedSeries } from "./sync";

export type V20Side = "LONG" | "SHORT";

export interface V20PrimaryEvent {
  symbol: V20Symbol;
  signalTimestamp: string;
  signalOpenTime: number;
  side: V20Side;
  nextEntryOpenTime: number;
  nextEntryAvailable: boolean;
  evaluationWindow: V20EvaluationWindow;
  clusterId: string;
}

export interface V20EventEnumeration {
  gapDefinition: "LAST_MARK";
  rawExtremeEvents: number;
  rawExtremeByWindow: Record<V20EvaluationWindow, number>;
  firstCrossEvents: number;
  firstCrossByWindow: Record<V20EvaluationWindow, number>;
  executionReferenceUnavailable: number;
  overlapExcluded: number;
  finalEligibleEvents: number;
  eventsBySymbol: Record<V20Symbol, number>;
  eventsBySide: Record<V20Side, number>;
  eventsByWindow: Record<V20EvaluationWindow, number>;
  distinctSignalClusters: number;
  eventDigest: string;
  events: V20PrimaryEvent[];
}

export interface V20ControlEnumeration {
  control: "LAST_INDEX_DISLOCATION" | "EXTREME_LAST_RETURN_REVERSAL" | "TIME_MATCHED_RANDOM";
  eventCount: number;
  eventsBySymbol: Record<V20Symbol, number>;
  eventsBySide: Record<V20Side, number>;
  distinctSignalClusters: number;
  eventDigest: string;
  events: V20ControlEvent[];
}

export interface V20ControlEvent {
  control: V20ControlEnumeration["control"];
  symbol: V20Symbol;
  signalTimestamp: string;
  signalOpenTime: number;
  side: V20Side;
  clusterId: string;
}

export function lastMarkGap(series: V20SynchronizedSeries): number[] {
  return series.lastCloses.map((lastClose, index) => Math.log(lastClose / series.markCloses[index]));
}

export function lastIndexGap(series: V20SynchronizedSeries): number[] {
  return series.lastCloses.map((lastClose, index) => Math.log(lastClose / series.indexCloses[index]));
}

export function lastLogReturns(series: V20SynchronizedSeries): number[] {
  return series.lastCloses.map((close, index) => index === 0 ? Number.NaN : Math.log(close / series.lastCloses[index - 1]));
}

export function enumerateLastMarkEvents(series: V20SynchronizedSeries): V20EventEnumeration {
  return enumerateGapEvents(series, lastMarkGap(series), "LAST_MARK");
}

export function enumerateLastIndexControl(series: V20SynchronizedSeries): V20ControlEnumeration {
  const primaryLike = enumerateGapEvents(series, lastIndexGap(series), "LAST_MARK");
  const events = primaryLike.events.map((event) => ({
    control: "LAST_INDEX_DISLOCATION" as const,
    symbol: event.symbol,
    signalTimestamp: event.signalTimestamp,
    signalOpenTime: event.signalOpenTime,
    side: event.side,
    clusterId: event.clusterId,
  }));
  return controlSummary("LAST_INDEX_DISLOCATION", events);
}

export function enumerateLastReturnControl(series: V20SynchronizedSeries): V20ControlEnumeration {
  const values = lastLogReturns(series);
  const state = new RollingQuantileState(values, V20_PIT_WINDOW_BARS, V20_SIGNAL_QUANTILE);
  const candidateEvents: V20ControlEvent[] = [];
  for (let signalIndex = V20_PIT_WINDOW_BARS; signalIndex < values.length; signalIndex += 1) {
    const threshold = state.quantile(signalIndex);
    const current = values[signalIndex];
    const previous = values[signalIndex - 1];
    if (threshold === null || !Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(current) || !Number.isFinite(previous)) {
      state.slide(signalIndex);
      continue;
    }
    if (Math.abs(previous) < threshold && Math.abs(current) >= threshold) {
      const event = controlEventFrom(series, signalIndex, current > 0 ? "SHORT" : "LONG", "EXTREME_LAST_RETURN_REVERSAL");
      if (event) candidateEvents.push(event);
    }
    state.slide(signalIndex);
  }
  const finalEvents = applyControlOverlap(candidateEvents);
  return controlSummary("EXTREME_LAST_RETURN_REVERSAL", finalEvents);
}

export function enumerateTimeMatchedRandom(
  series: V20SynchronizedSeries,
  primaryEvents: readonly V20PrimaryEvent[],
  seed = 20_020,
): V20ControlEnumeration {
  const counts = new Map<string, number>();
  for (const event of primaryEvents) {
    const key = randomGroupKey(event.symbol, event.signalOpenTime, event.side);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const selected: V20ControlEvent[] = [];
  for (const [key, requested] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [symbol, , hour, side] = key.split("|") as [V20Symbol, string, string, V20Side];
    const candidates: Array<{ openTime: number; score: number }> = [];
    for (let index = V20_PIT_WINDOW_BARS; index < series.openTimes.length - 1; index += 1) {
      if (series.symbol !== symbol || utcHour(series.openTimes[index]) !== hour) continue;
      candidates.push({ openTime: series.openTimes[index], score: deterministicScore(seed, key, series.openTimes[index]) });
    }
    candidates.sort((left, right) => left.score - right.score || left.openTime - right.openTime);
    const chosen = candidates.slice(0, Math.min(requested, candidates.length));
    for (const candidate of chosen) {
      const index = findExactIndex(series.openTimes, candidate.openTime);
      if (index < 0) continue;
      selected.push({
        control: "TIME_MATCHED_RANDOM",
        symbol,
        signalTimestamp: new Date(series.closeTimes[index]).toISOString(),
        signalOpenTime: candidate.openTime,
        side,
        clusterId: new Date(series.closeTimes[index]).toISOString(),
      });
    }
  }
  selected.sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  return controlSummary("TIME_MATCHED_RANDOM", selected);
}

export function nearestRankQuantile(values: readonly number[], quantile: number): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0 || !Number.isFinite(quantile) || quantile <= 0 || quantile > 1) return null;
  const rank = Math.max(1, Math.ceil(quantile * finite.length));
  return finite[rank - 1];
}

export function rollingMedian(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianAndNearestRankAbsoluteDeviation(
  values: readonly number[],
  quantile = V20_SIGNAL_QUANTILE,
): { median: number; threshold: number } | null {
  const finite = values.filter(Number.isFinite);
  const median = rollingMedian(finite);
  if (median === null) return null;
  const threshold = nearestRankQuantile(finite.map((value) => Math.abs(value - median)), quantile);
  return threshold === null ? null : { median, threshold };
}

function enumerateGapEvents(
  series: V20SynchronizedSeries,
  gaps: readonly number[],
  gapDefinition: "LAST_MARK",
): V20EventEnumeration {
  const state = new RollingGapState(gaps, V20_PIT_WINDOW_BARS, V20_SIGNAL_QUANTILE);
  const rawExtremeByWindow = emptyWindowCounts();
  const firstCrossByWindow = emptyWindowCounts();
  const firstCrossEvents: V20PrimaryEvent[] = [];
  let rawExtremeEvents = 0;
  let firstCrossCount = 0;
  let executionReferenceUnavailable = 0;

  for (let signalIndex = V20_PIT_WINDOW_BARS; signalIndex < gaps.length; signalIndex += 1) {
    const statistics = state.statistics(signalIndex);
    const evaluationWindow = evaluationWindowFor(series.openTimes[signalIndex]);
    const current = gaps[signalIndex];
    const previous = gaps[signalIndex - 1];
    if (statistics && evaluationWindow && Number.isFinite(current) && Number.isFinite(previous)) {
      const currentDeviation = current - statistics.median;
      const previousDeviation = previous - statistics.median;
      if (statistics.threshold > 0 && Math.abs(currentDeviation) >= statistics.threshold) {
        rawExtremeEvents += 1;
        rawExtremeByWindow[evaluationWindow] += 1;
      }
      if (statistics.threshold > 0 && Math.abs(previousDeviation) < statistics.threshold && Math.abs(currentDeviation) >= statistics.threshold) {
        firstCrossCount += 1;
        firstCrossByWindow[evaluationWindow] += 1;
        const side = currentDeviation > 0 ? "SHORT" : currentDeviation < 0 ? "LONG" : null;
        if (side) {
          const nextEntryOpenTime = series.openTimes[signalIndex + 1] ?? -1;
          const nextEntryAvailable = nextEntryOpenTime === series.openTimes[signalIndex] + V20_INTERVAL_MS;
          if (!nextEntryAvailable) executionReferenceUnavailable += 1;
          firstCrossEvents.push({
            symbol: series.symbol,
            signalTimestamp: new Date(series.closeTimes[signalIndex]).toISOString(),
            signalOpenTime: series.openTimes[signalIndex],
            side,
            nextEntryOpenTime,
            nextEntryAvailable,
            evaluationWindow,
            clusterId: new Date(series.closeTimes[signalIndex]).toISOString(),
          });
        }
      }
    }
    state.slide(signalIndex);
  }

  const eligibleForOverlap = firstCrossEvents.filter((event) => event.nextEntryAvailable);
  const finalEvents: V20PrimaryEvent[] = [];
  let overlapExcluded = 0;
  let lastAcceptedSignal: number | null = null;
  for (const event of eligibleForOverlap) {
    if (lastAcceptedSignal !== null && event.signalOpenTime < lastAcceptedSignal + V20_INTERVAL_MS) {
      overlapExcluded += 1;
      continue;
    }
    finalEvents.push(event);
    lastAcceptedSignal = event.signalOpenTime;
  }
  finalEvents.sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  const eventsBySymbol = symbolCounts(finalEvents);
  const eventsBySide = sideCounts(finalEvents);
  const eventsByWindow = windowCounts(finalEvents);
  const clusters = new Set(finalEvents.map((event) => event.clusterId));
  return {
    gapDefinition,
    rawExtremeEvents,
    rawExtremeByWindow,
    firstCrossEvents: firstCrossCount,
    firstCrossByWindow,
    executionReferenceUnavailable,
    overlapExcluded,
    finalEligibleEvents: finalEvents.length,
    eventsBySymbol,
    eventsBySide,
    eventsByWindow,
    distinctSignalClusters: clusters.size,
    eventDigest: sha256(finalEvents),
    events: finalEvents,
  };
}

function controlEventFrom(
  series: V20SynchronizedSeries,
  signalIndex: number,
  side: V20Side,
  control: V20ControlEvent["control"],
): V20ControlEvent | null {
  const evaluation = evaluationWindowFor(series.openTimes[signalIndex]);
  if (!evaluation) return null;
  const timestamp = new Date(series.closeTimes[signalIndex]).toISOString();
  return {
    control,
    symbol: series.symbol,
    signalTimestamp: timestamp,
    signalOpenTime: series.openTimes[signalIndex],
    side,
    clusterId: timestamp,
  };
}

function applyControlOverlap(events: readonly V20ControlEvent[]): V20ControlEvent[] {
  const sorted = [...events].sort((left, right) => left.signalOpenTime - right.signalOpenTime);
  const accepted: V20ControlEvent[] = [];
  let lastAccepted: number | null = null;
  for (const event of sorted) {
    if (lastAccepted !== null && event.signalOpenTime < lastAccepted + V20_INTERVAL_MS) continue;
    accepted.push(event);
    lastAccepted = event.signalOpenTime;
  }
  return accepted;
}

function controlSummary(control: V20ControlEnumeration["control"], events: readonly V20ControlEvent[]): V20ControlEnumeration {
  const sorted = [...events].sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  return {
    control,
    eventCount: sorted.length,
    eventsBySymbol: symbolCounts(sorted),
    eventsBySide: sideCounts(sorted),
    distinctSignalClusters: new Set(sorted.map((event) => event.clusterId)).size,
    eventDigest: sha256(sorted),
    events: sorted,
  };
}

class RollingGapState {
  private readonly ranks: number[];
  private readonly values: number[];
  private readonly tree: FenwickTree;
  private initializedAt: number | null = null;

  constructor(private readonly source: readonly number[], private readonly window: number, private readonly quantile: number) {
    this.values = [...new Set(source.filter(Number.isFinite))].sort((left, right) => left - right);
    this.ranks = source.map((value) => Number.isFinite(value) ? lowerBound(this.values, value) : -1);
    this.tree = new FenwickTree(this.values.length);
  }

  statistics(signalIndex: number): { median: number; threshold: number } | null {
    if (this.initializedAt === null) {
      this.initializedAt = signalIndex;
      for (let index = signalIndex - this.window; index < signalIndex; index += 1) this.add(index, 1);
    }
    if (this.initializedAt !== signalIndex) throw new Error("rolling state was not advanced in order");
    const count = this.window;
    if (this.tree.total !== count) return null;
    const left = this.valueAt(Math.floor(count / 2));
    const right = this.valueAt(Math.floor(count / 2) + 1);
    const median = (left + right) / 2;
    const lowerCount = this.tree.prefixCount(upperBound(this.values, median));
    const upperCount = count - lowerCount;
    const rank = Math.max(1, Math.ceil(this.quantile * count));
    let low = Math.max(0, rank - upperCount);
    let high = Math.min(rank, lowerCount);
    let threshold = Number.NaN;
    while (low <= high) {
      const lowerTake = Math.floor((low + high) / 2);
      const upperTake = rank - lowerTake;
      const lowerLeft = lowerTake === 0 ? Number.NEGATIVE_INFINITY : this.lowerDistance(lowerCount, lowerTake, median);
      const upperLeft = upperTake === 0 ? Number.NEGATIVE_INFINITY : this.upperDistance(lowerCount, upperTake, median);
      const lowerRight = lowerTake === lowerCount ? Number.POSITIVE_INFINITY : this.lowerDistance(lowerCount, lowerTake + 1, median);
      const upperRight = upperTake === upperCount ? Number.POSITIVE_INFINITY : this.upperDistance(lowerCount, upperTake + 1, median);
      if (lowerLeft > upperRight) high = lowerTake - 1;
      else if (upperLeft > lowerRight) low = lowerTake + 1;
      else {
        threshold = Math.max(lowerLeft, upperLeft);
        break;
      }
    }
    return Number.isFinite(threshold) ? { median, threshold } : null;
  }

  slide(signalIndex: number): void {
    if (this.initializedAt !== signalIndex) throw new Error("rolling state slide order mismatch");
    this.add(signalIndex - this.window, -1);
    this.add(signalIndex, 1);
    this.initializedAt = signalIndex + 1;
  }

  private lowerDistance(lowerCount: number, take: number, median: number): number {
    return median - this.valueAt(lowerCount - take + 1);
  }

  private upperDistance(lowerCount: number, take: number, median: number): number {
    return this.valueAt(lowerCount + take) - median;
  }

  private valueAt(rank: number): number {
    return this.values[this.tree.select(rank)];
  }

  private add(sourceIndex: number, delta: number): void {
    const rank = this.ranks[sourceIndex];
    if (rank >= 0) this.tree.add(rank, delta);
  }
}

class RollingQuantileState {
  private readonly values: number[];
  private readonly ranks: number[];
  private readonly tree: FenwickTree;
  private initializedAt: number | null = null;

  constructor(private readonly source: readonly number[], private readonly window: number, private readonly quantileLevel: number) {
    this.values = [...new Set(source.filter(Number.isFinite).map(Math.abs))].sort((left, right) => left - right);
    this.ranks = source.map((value) => Number.isFinite(value) ? lowerBound(this.values, Math.abs(value)) : -1);
    this.tree = new FenwickTree(this.values.length);
  }

  quantile(signalIndex: number): number | null {
    if (this.initializedAt === null) {
      this.initializedAt = signalIndex;
      for (let index = signalIndex - this.window; index < signalIndex; index += 1) this.add(index, 1);
    }
    if (this.tree.total !== this.window) return null;
    const rank = Math.max(1, Math.ceil(this.quantileLevel * this.window));
    return this.values[this.tree.select(rank)];
  }

  slide(signalIndex: number): void {
    if (this.initializedAt !== signalIndex) throw new Error("rolling quantile state slide order mismatch");
    this.add(signalIndex - this.window, -1);
    this.add(signalIndex, 1);
    this.initializedAt = signalIndex + 1;
  }

  private add(sourceIndex: number, delta: number): void {
    const rank = this.ranks[sourceIndex];
    if (rank >= 0) this.tree.add(rank, delta);
  }
}

class FenwickTree {
  private readonly counts: Int32Array;
  total = 0;

  constructor(size: number) {
    this.counts = new Int32Array(size + 1);
  }

  add(index: number, delta: number): void {
    this.total += delta;
    for (let cursor = index + 1; cursor < this.counts.length; cursor += cursor & -cursor) this.counts[cursor] += delta;
  }

  prefixCount(exclusiveIndex: number): number {
    let result = 0;
    for (let cursor = Math.min(exclusiveIndex, this.counts.length - 1); cursor > 0; cursor -= cursor & -cursor) result += this.counts[cursor];
    return result;
  }

  select(rank: number): number {
    if (rank < 1 || rank > this.total) throw new Error(`Fenwick rank out of range: ${rank}/${this.total}`);
    let index = 0;
    let bit = 1;
    while (bit * 2 < this.counts.length) bit *= 2;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next < this.counts.length && this.counts[next] < rank) {
        index = next;
        rank -= this.counts[next];
      }
    }
    return index;
  }
}

function emptyWindowCounts(): Record<V20EvaluationWindow, number> {
  return { WARMUP: 0, PRIMARY_OOS: 0, HOLDOUT_A: 0, HOLDOUT_B: 0 };
}

function symbolCounts(events: readonly { symbol: V20Symbol }[]): Record<V20Symbol, number> {
  const counts = { BTCUSDT: 0, ETHUSDT: 0, BNBUSDT: 0, DOGEUSDT: 0 } satisfies Record<V20Symbol, number>;
  for (const event of events) counts[event.symbol] += 1;
  return counts;
}

function sideCounts(events: readonly { side: V20Side }[]): Record<V20Side, number> {
  const counts = { LONG: 0, SHORT: 0 };
  for (const event of events) counts[event.side] += 1;
  return counts;
}

function windowCounts(events: readonly { evaluationWindow?: V20EvaluationWindow }[]): Record<V20EvaluationWindow, number> {
  const counts = emptyWindowCounts();
  for (const event of events) if (event.evaluationWindow) counts[event.evaluationWindow] += 1;
  return counts;
}

function findExactIndex(values: readonly number[], value: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] === value) return middle;
    if (values[middle] < value) left = middle + 1;
    else right = middle - 1;
  }
  return -1;
}

function lowerBound(values: readonly number[], value: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < value) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound(values: readonly number[], value: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] <= value) left = middle + 1;
    else right = middle;
  }
  return left;
}

function randomGroupKey(symbol: V20Symbol, timestamp: number, side: V20Side): string {
  const date = new Date(timestamp);
  return `${symbol}|${date.toISOString().slice(0, 7)}|${String(date.getUTCHours()).padStart(2, "0")}|${side}`;
}

function utcHour(timestamp: number): string {
  return String(new Date(timestamp).getUTCHours()).padStart(2, "0");
}

function deterministicScore(seed: number, key: string, timestamp: number): number {
  let value = seed >>> 0;
  for (const character of `${key}|${timestamp}`) value = Math.imul(value ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return value / 4_294_967_296;
}
