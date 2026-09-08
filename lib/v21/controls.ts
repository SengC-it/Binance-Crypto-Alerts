import {
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_INTERVAL_MS,
  V21_SYMBOLS,
  type V21Symbol,
} from "./constants";
import {
  V21_PRIMARY_HORIZON_MS,
  V21_PRIMARY_OOS_START,
  V21_HOLDOUT_A_START,
  V21_HOLDOUT_B_START,
  type V21EventIdentity,
  type V21SynchronizedReturnMatrix,
} from "./events";
import { V21_PIT_OBSERVATION_COUNT } from "./features";
import { V21_Q99_RANK } from "./event-predicate";

export const V21_CONTROL_NAMES = [
  "RAW_RETURN_REVERSAL",
  "SIMPLE_MEDIAN_GAP_REVERSAL",
  "TIME_MATCHED_RANDOM",
] as const;
export type V21ControlName = (typeof V21_CONTROL_NAMES)[number];

export const V21_TIME_MATCHED_RANDOM_SEED = 0x21C0C0DE;
export const V21_TIME_MATCHED_RANDOM_ALGORITHM = "xorshift32 + Fisher-Yates over ascending synchronized 5m timestamps";

export interface V21ControlAuditRow {
  control: "RAW_RETURN_REVERSAL" | "SIMPLE_MEDIAN_GAP_REVERSAL";
  symbol: V21Symbol;
  signalOpenTime: number;
  featureValue: number;
  previousFeatureValue: number;
  q99Threshold: number;
  direction: V21EventIdentity["direction"] | null;
  clusterId: number;
  overlapStatus: "ACCEPTED" | "OVERLAPPING_SIGNAL_EXCLUDED";
}

export interface V21ControlPlaceboAuditRow {
  control: "TIME_MATCHED_RANDOM";
  targetV21Symbol: V21Symbol;
  targetV21SignalOpenTime: number;
  targetDirection: V21EventIdentity["direction"];
  targetYYYYMM: string;
  targetUtcHour: number;
  randomSignalOpenTime: number;
  seed: number;
  derivedSeed: number;
  stratumId: string;
  clusterId: number;
}

export type V21AnyControlAuditRow = V21ControlAuditRow | V21ControlPlaceboAuditRow;

export interface V21ControlResult {
  control: V21ControlName;
  allEvents: V21EventIdentity[];
  primaryOosEvents: V21EventIdentity[];
  holdoutAEvents: V21EventIdentity[];
  holdoutBEvents: V21EventIdentity[];
  auditRows: V21AnyControlAuditRow[];
  diagnostics: {
    rawExtremeCandidates: number;
    firstCrossCandidates: number;
    zeroValueFirstCrossCandidates: number;
    overlapExcluded: number;
  };
}

export interface V21ControlEnumerationResult {
  RAW_RETURN_REVERSAL: V21ControlResult;
  SIMPLE_MEDIAN_GAP_REVERSAL: V21ControlResult;
  TIME_MATCHED_RANDOM: V21ControlResult;
}

interface ControlCandidate {
  audit: V21ControlAuditRow;
  direction: V21EventIdentity["direction"] | null;
}

interface HeapEntry {
  value: number;
  index: number;
}

/**
 * Enumerate all three pre-return controls from the already synchronized PIT
 * return-feature matrix. This module never receives OHLC prices and never
 * evaluates an entry, exit, outcome, or return after a signal.
 */
export function enumerateV21Controls(
  input: V21SynchronizedReturnMatrix,
  primaryEvents: readonly V21EventIdentity[],
): V21ControlEnumerationResult {
  assertSynchronizedMatrix(input);
  const raw = enumerateNumericControl(input, "RAW_RETURN_REVERSAL", input.returnsBySymbol);
  const gapSeries = buildMedianGapSeries(input);
  const gap = enumerateNumericControl(input, "SIMPLE_MEDIAN_GAP_REVERSAL", gapSeries);
  const placebo = enumerateTimeMatchedRandom(input.openTimes, primaryEvents);
  return {
    RAW_RETURN_REVERSAL: raw,
    SIMPLE_MEDIAN_GAP_REVERSAL: gap,
    TIME_MATCHED_RANDOM: placebo,
  };
}

function enumerateNumericControl(
  input: V21SynchronizedReturnMatrix,
  control: "RAW_RETURN_REVERSAL" | "SIMPLE_MEDIAN_GAP_REVERSAL",
  featureSeries: Record<V21Symbol, ArrayLike<number>>,
): V21ControlResult {
  const firstIndex = findFirstIndexAtOrAfter(input.openTimes, V21_PRIMARY_OOS_START);
  if (firstIndex < V21_PIT_OBSERVATION_COUNT) {
    throw new Error("V21 control enumeration lacks the exact 8640-row PIT window");
  }

  const candidates: ControlCandidate[] = [];
  let rawExtremeCandidates = 0;
  let firstCrossCandidates = 0;
  let zeroValueFirstCrossCandidates = 0;

  for (const symbol of V21_SYMBOLS) {
    const series = featureSeries[symbol];
    const tracker = new SlidingNearestRank(series, firstIndex - V21_PIT_OBSERVATION_COUNT);
    for (let currentIndex = firstIndex; currentIndex < input.openTimes.length; currentIndex += 1) {
      const signalOpenTime = input.openTimes[currentIndex];
      if (signalOpenTime >= Date.parse(V21_END_EXCLUSIVE_TIMESTAMP)) break;
      const featureValue = series[currentIndex];
      const previousFeatureValue = series[currentIndex - 1];
      if (!Number.isFinite(featureValue) || !Number.isFinite(previousFeatureValue)) {
        throw new Error(`Non-finite ${control} feature for ${symbol}`);
      }
      const threshold = tracker.value();
      const currentExtreme = Math.abs(featureValue) >= threshold;
      if (currentExtreme) rawExtremeCandidates += 1;
      if (currentExtreme && Math.abs(previousFeatureValue) < threshold) {
        firstCrossCandidates += 1;
        const direction = featureValue > 0 ? "SHORT" : featureValue < 0 ? "LONG" : null;
        if (direction === null) zeroValueFirstCrossCandidates += 1;
        candidates.push({
          direction: direction as V21EventIdentity["direction"],
          audit: {
            control,
            symbol,
            signalOpenTime,
            featureValue,
            previousFeatureValue,
            q99Threshold: threshold,
            direction,
            clusterId: signalOpenTime,
            overlapStatus: "ACCEPTED",
          },
        });
      }
      if (currentIndex + 1 < input.openTimes.length) {
        tracker.advance(currentIndex - V21_PIT_OBSERVATION_COUNT, currentIndex);
      }
    }
  }

  const overlapExcluded = applyControlOverlap(candidates);
  const auditRows = candidates
    .map((candidate) => candidate.audit)
    .sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  const accepted = candidates
    .filter((candidate) => candidate.audit.overlapStatus === "ACCEPTED" && candidate.direction !== null)
    .map((candidate) => ({
      symbol: candidate.audit.symbol,
      signalOpenTime: candidate.audit.signalOpenTime,
      direction: candidate.direction as V21EventIdentity["direction"],
      clusterId: candidate.audit.clusterId,
    }));
  return makeControlResult(
    control,
    accepted,
    auditRows,
    { rawExtremeCandidates, firstCrossCandidates, zeroValueFirstCrossCandidates, overlapExcluded },
  );
}

function buildMedianGapSeries(input: V21SynchronizedReturnMatrix): Record<V21Symbol, Float64Array> {
  const result = {} as Record<V21Symbol, Float64Array>;
  for (const symbol of V21_SYMBOLS) result[symbol] = new Float64Array(input.openTimes.length);
  const sorted = V21_SYMBOLS.map((_, symbolIndex) => ({ value: 0, symbolIndex }));
  const positionBySymbol = new Int8Array(V21_SYMBOLS.length);

  for (let rowIndex = 0; rowIndex < input.openTimes.length; rowIndex += 1) {
    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      const value = input.returnsBySymbol[V21_SYMBOLS[symbolIndex]][rowIndex];
      if (!Number.isFinite(value)) throw new Error("Non-finite synchronized return");
      sorted[symbolIndex].value = value;
      sorted[symbolIndex].symbolIndex = symbolIndex;
    }
    sorted.sort((left, right) => left.value - right.value || left.symbolIndex - right.symbolIndex);
    for (let rank = 0; rank < sorted.length; rank += 1) positionBySymbol[sorted[rank].symbolIndex] = rank;
    for (let targetIndex = 0; targetIndex < V21_SYMBOLS.length; targetIndex += 1) {
      const medianIndex = positionBySymbol[targetIndex] <= 3 ? 4 : 3;
      const medianOther = sorted[medianIndex].value;
      result[V21_SYMBOLS[targetIndex]][rowIndex] = input.returnsBySymbol[V21_SYMBOLS[targetIndex]][rowIndex] - medianOther;
    }
  }
  return result;
}

function enumerateTimeMatchedRandom(
  openTimes: ArrayLike<number>,
  primaryEvents: readonly V21EventIdentity[],
): V21ControlResult {
  const endExclusive = Date.parse(V21_END_EXCLUSIVE_TIMESTAMP);
  const candidatesByStratum = new Map<string, number[]>();
  for (let index = 0; index < openTimes.length; index += 1) {
    const timestamp = openTimes[index];
    if (timestamp < V21_PRIMARY_OOS_START || timestamp >= endExclusive) continue;
    const month = utcMonth(timestamp);
    const hour = new Date(timestamp).getUTCHours();
    for (const direction of ["LONG", "SHORT"] as const) {
      for (const symbol of V21_SYMBOLS) {
        const key = `${symbol}|${month}|${hour}|${direction}`;
        const list = candidatesByStratum.get(key) ?? [];
        list.push(timestamp);
        candidatesByStratum.set(key, list);
      }
    }
  }

  const acceptedTimestampBySymbol = new Map<V21Symbol, Set<number>>();
  const selectedBySymbol = new Map<V21Symbol, number[]>();
  for (const symbol of V21_SYMBOLS) {
    acceptedTimestampBySymbol.set(symbol, new Set());
    selectedBySymbol.set(symbol, []);
  }
  for (const event of primaryEvents) acceptedTimestampBySymbol.get(event.symbol)?.add(event.signalOpenTime);

  const shuffledByStratum = new Map<string, number[]>();
  const audits: V21ControlPlaceboAuditRow[] = [];
  const randomEvents: V21EventIdentity[] = [];
  const sortedTargets = [...primaryEvents].sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  for (const target of sortedTargets) {
    const targetMonth = utcMonth(target.signalOpenTime);
    const targetHour = new Date(target.signalOpenTime).getUTCHours();
    const stratumId = `${target.symbol}|${targetMonth}|${targetHour}|${target.direction}`;
    const sourceCandidates = candidatesByStratum.get(stratumId);
    if (!sourceCandidates || sourceCandidates.length === 0) throw new Error(`No placebo candidates for ${stratumId}`);
    let shuffled = shuffledByStratum.get(stratumId);
    if (!shuffled) {
      shuffled = deterministicShuffle(sourceCandidates, deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, stratumId));
      shuffledByStratum.set(stratumId, shuffled);
    }
    const selected = selectedBySymbol.get(target.symbol) as number[];
    const acceptedTimestamps = acceptedTimestampBySymbol.get(target.symbol) as Set<number>;
    const randomSignalOpenTime = shuffled.find((timestamp) => (
      !acceptedTimestamps.has(timestamp)
      && !selected.includes(timestamp)
      && selected.every((used) => Math.abs(used - timestamp) >= V21_PRIMARY_HORIZON_MS)
    ));
    if (randomSignalOpenTime === undefined) throw new Error(`Placebo stratum cannot satisfy one-to-one non-overlap: ${stratumId}`);
    selected.push(randomSignalOpenTime);
    const derivedSeed = deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, stratumId);
    audits.push({
      control: "TIME_MATCHED_RANDOM",
      targetV21Symbol: target.symbol,
      targetV21SignalOpenTime: target.signalOpenTime,
      targetDirection: target.direction,
      targetYYYYMM: targetMonth,
      targetUtcHour: targetHour,
      randomSignalOpenTime,
      seed: V21_TIME_MATCHED_RANDOM_SEED,
      derivedSeed,
      stratumId,
      clusterId: randomSignalOpenTime,
    });
    randomEvents.push({
      symbol: target.symbol,
      signalOpenTime: randomSignalOpenTime,
      direction: target.direction,
      clusterId: randomSignalOpenTime,
    });
  }
  audits.sort((left, right) => left.targetV21SignalOpenTime - right.targetV21SignalOpenTime || left.targetV21Symbol.localeCompare(right.targetV21Symbol));
  return makeControlResult("TIME_MATCHED_RANDOM", randomEvents, audits, {
    rawExtremeCandidates: 0,
    firstCrossCandidates: randomEvents.length,
    zeroValueFirstCrossCandidates: 0,
    overlapExcluded: 0,
  });
}

export function deriveV21PlaceboSeed(seed: number, stratumId: string): number {
  let state = seed >>> 0;
  for (let index = 0; index < stratumId.length; index += 1) {
    state = Math.imul(state ^ stratumId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return state === 0 ? 0x6D2B79F5 : state;
}

function deterministicShuffle(values: readonly number[], seed: number): number[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = xorshift32(state);
    const swapIndex = state % (index + 1);
    const value = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = value;
  }
  return result;
}

function xorshift32(state: number): number {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function makeControlResult(
  control: V21ControlName,
  events: readonly V21EventIdentity[],
  auditRows: readonly V21AnyControlAuditRow[],
  diagnostics: V21ControlResult["diagnostics"],
): V21ControlResult {
  const allEvents = eventsFromIdentityPayload(events);
  return {
    control,
    allEvents,
    primaryOosEvents: allEvents.filter((event) => event.signalOpenTime >= V21_PRIMARY_OOS_START && event.signalOpenTime < V21_HOLDOUT_A_START),
    holdoutAEvents: allEvents.filter((event) => event.signalOpenTime >= V21_HOLDOUT_A_START && event.signalOpenTime < V21_HOLDOUT_B_START),
    holdoutBEvents: allEvents.filter((event) => event.signalOpenTime >= V21_HOLDOUT_B_START && event.signalOpenTime < Date.parse(V21_END_EXCLUSIVE_TIMESTAMP)),
    auditRows: [...auditRows],
    diagnostics,
  };
}

function eventsFromIdentityPayload(events: readonly V21EventIdentity[]): V21EventIdentity[] {
  return [...events]
    .sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol))
    .map((event) => ({
      symbol: event.symbol,
      signalOpenTime: event.signalOpenTime,
      direction: event.direction,
      clusterId: event.clusterId,
    }));
}

function applyControlOverlap(candidates: readonly ControlCandidate[]): number {
  const sorted = [...candidates].sort((left, right) => left.audit.signalOpenTime - right.audit.signalOpenTime || left.audit.symbol.localeCompare(right.audit.symbol));
  const lastAcceptedBySymbol = new Map<V21Symbol, number>();
  let excluded = 0;
  for (const candidate of sorted) {
    if (candidate.direction === null) continue;
    const lastAccepted = lastAcceptedBySymbol.get(candidate.audit.symbol);
    if (lastAccepted !== undefined && candidate.audit.signalOpenTime < lastAccepted + V21_PRIMARY_HORIZON_MS) {
      candidate.audit.overlapStatus = "OVERLAPPING_SIGNAL_EXCLUDED";
      excluded += 1;
      continue;
    }
    lastAcceptedBySymbol.set(candidate.audit.symbol, candidate.audit.signalOpenTime);
  }
  return excluded;
}

function findFirstIndexAtOrAfter(openTimes: ArrayLike<number>, timestamp: number): number {
  for (let index = 0; index < openTimes.length; index += 1) if (openTimes[index] >= timestamp) return index;
  return openTimes.length;
}

function utcMonth(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function assertSynchronizedMatrix(input: V21SynchronizedReturnMatrix): void {
  if (input.openTimes.length <= V21_PIT_OBSERVATION_COUNT) throw new Error("V21 synchronized matrix is too short for controls");
  for (const symbol of V21_SYMBOLS) {
    if (input.returnsBySymbol[symbol].length !== input.openTimes.length) throw new Error(`Synchronized length mismatch for ${symbol}`);
  }
  for (let index = 1; index < input.openTimes.length; index += 1) {
    if (input.openTimes[index] !== input.openTimes[index - 1] + V21_INTERVAL_MS) throw new Error("Synchronized timeline contains a gap");
  }
}

class SlidingNearestRank {
  private readonly lower = new BinaryHeap(compareDescending);
  private readonly upper = new BinaryHeap(compareAscending);
  private readonly side: Uint8Array;
  private lowerCount = 0;
  private upperCount = 0;

  constructor(private readonly values: ArrayLike<number>, startIndex: number) {
    this.side = new Uint8Array(values.length);
    for (let index = startIndex; index < startIndex + V21_PIT_OBSERVATION_COUNT; index += 1) {
      const value = values[index];
      if (!Number.isFinite(value)) throw new Error("Sliding Q99 received a non-finite value");
      this.add(index, Math.abs(value));
    }
  }

  value(): number {
    this.prune(this.lower, 1);
    const entry = this.lower.peek();
    if (!entry) throw new Error("Sliding Q99 lower partition is empty");
    return entry.value;
  }

  advance(removeIndex: number, addIndex: number): void {
    this.remove(removeIndex);
    const value = this.values[addIndex];
    if (!Number.isFinite(value)) throw new Error("Sliding Q99 received a non-finite value");
    this.add(addIndex, Math.abs(value));
  }

  private add(index: number, value: number): void {
    const entry = { index, value };
    this.prune(this.lower, 1);
    if (this.lowerCount === 0 || compareAscending(entry, this.lower.peek() as HeapEntry) <= 0) {
      this.lower.push(entry);
      this.side[index] = 1;
      this.lowerCount += 1;
    } else {
      this.upper.push(entry);
      this.side[index] = 2;
      this.upperCount += 1;
    }
    this.rebalance();
  }

  private remove(index: number): void {
    if (this.side[index] === 1) this.lowerCount -= 1;
    else if (this.side[index] === 2) this.upperCount -= 1;
    else throw new Error("Sliding Q99 removed an inactive index");
    this.side[index] = 0;
    this.rebalance();
  }

  private rebalance(): void {
    this.prune(this.lower, 1);
    this.prune(this.upper, 2);
    const desiredLowerCount = Math.min(V21_Q99_RANK, this.lowerCount + this.upperCount);
    while (this.lowerCount < desiredLowerCount) {
      const entry = this.upper.pop();
      if (!entry) throw new Error("Sliding Q99 upper partition underflow");
      if (this.side[entry.index] !== 2) continue;
      this.side[entry.index] = 1;
      this.upperCount -= 1;
      this.lowerCount += 1;
      this.lower.push(entry);
      this.prune(this.upper, 2);
    }
    while (this.lowerCount > desiredLowerCount) {
      const entry = this.lower.pop();
      if (!entry) throw new Error("Sliding Q99 lower partition underflow");
      if (this.side[entry.index] !== 1) continue;
      this.side[entry.index] = 2;
      this.lowerCount -= 1;
      this.upperCount += 1;
      this.upper.push(entry);
      this.prune(this.lower, 1);
    }
  }

  private prune(heap: BinaryHeap, expectedSide: number): void {
    while (true) {
      const entry = heap.peek();
      if (!entry || this.side[entry.index] === expectedSide) return;
      heap.pop();
    }
  }
}

class BinaryHeap {
  private readonly entries: HeapEntry[] = [];

  constructor(private readonly compare: (left: HeapEntry, right: HeapEntry) => number) {}

  push(entry: HeapEntry): void {
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.entries.length === 0) return undefined;
    const result = this.entries[0];
    const last = this.entries.pop() as HeapEntry | undefined;
    if (last && this.entries.length > 0) {
      this.entries[0] = last;
      this.bubbleDown(0);
    }
    return result;
  }

  peek(): HeapEntry | undefined {
    return this.entries[0];
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.entries[current], this.entries[parent]) >= 0) break;
      const value = this.entries[current];
      this.entries[current] = this.entries[parent];
      this.entries[parent] = value;
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let best = current;
      if (left < this.entries.length && this.compare(this.entries[left], this.entries[best]) < 0) best = left;
      if (right < this.entries.length && this.compare(this.entries[right], this.entries[best]) < 0) best = right;
      if (best === current) return;
      const value = this.entries[current];
      this.entries[current] = this.entries[best];
      this.entries[best] = value;
      current = best;
    }
  }
}

function compareAscending(left: HeapEntry, right: HeapEntry): number {
  return left.value - right.value || left.index - right.index;
}

function compareDescending(left: HeapEntry, right: HeapEntry): number {
  return right.value - left.value || right.index - left.index;
}
