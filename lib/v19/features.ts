import {
  V19_INTERVAL_MS,
  V19_PIT_WINDOW_MS,
  V19_UNDERREACTION_QUANTILE,
  type V19Side,
} from "./constants";

export interface V19Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  tradeCount: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface V19PriorWindow {
  startOpenTime: number;
  endOpenTimeExclusive: number;
  btcReturns: number[];
  followerReturns: number[];
  tradeCounts: number[];
}

export interface V19OlsFit {
  alpha: number;
  beta: number;
}

export interface V19FollowerFeature {
  alpha: number;
  beta: number;
  currentFollowerReturn: number;
  expectedFollowerReturn: number;
  residual: number;
  directionalUnderreaction: number;
  underreactionQ90: number;
  priorMedianTradeCount: number;
}

export interface V19PrimaryEvent {
  btcShockTimestamp: string;
  signalTimestamp: string;
  signalOpenTime: number;
  follower: string;
  side: V19Side;
  nextExecutionOpenTime: number;
  executionReferencePrice: number;
  primaryExitCloseTime: number;
  evaluationWindow: string;
  liquidityRank: number;
  eligibleFollowerCount: number;
}

export function logReturn(currentClose: number, previousClose: number): number | null {
  if (!Number.isFinite(currentClose) || !Number.isFinite(previousClose) || currentClose <= 0 || previousClose <= 0) {
    return null;
  }
  const result = Math.log(currentClose / previousClose);
  return Number.isFinite(result) ? result : null;
}

export function nearestRankQuantile(values: ArrayLike<number>, quantile: number): number | null {
  if (values.length === 0 || !Number.isFinite(quantile) || quantile < 0 || quantile > 1) return null;
  const finite: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(values[index])) finite.push(values[index]);
  }
  if (finite.length === 0) return null;
  const rank = Math.max(0, Math.min(finite.length - 1, Math.ceil(quantile * finite.length) - 1));
  return selectKth(finite, rank);
}

export function fitOls(followerReturns: ArrayLike<number>, btcReturns: ArrayLike<number>): V19OlsFit | null {
  if (followerReturns.length !== btcReturns.length || followerReturns.length < 2) return null;
  for (let index = 0; index < followerReturns.length; index += 1) {
    if (!Number.isFinite(followerReturns[index]) || !Number.isFinite(btcReturns[index])) return null;
  }
  const btcMean = mean(btcReturns);
  const followerMean = mean(followerReturns);
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < btcReturns.length; index += 1) {
    const centeredBtc = btcReturns[index] - btcMean;
    covariance += centeredBtc * (followerReturns[index] - followerMean);
    variance += centeredBtc * centeredBtc;
  }
  if (!Number.isFinite(variance) || variance <= Number.EPSILON) return null;
  const beta = covariance / variance;
  const alpha = followerMean - beta * btcMean;
  return Number.isFinite(alpha) && Number.isFinite(beta) ? { alpha, beta } : null;
}

export function directionalUnderreaction(btcReturn: number, residual: number): number {
  return -Math.sign(btcReturn) * residual;
}

export function classifyLiquidity(
  medianTradeCounts: ReadonlyMap<string, number>,
): { lowLiquidity: string[]; highLiquidity: string[]; orderedSymbols: string[] } {
  const ordered = [...medianTradeCounts.entries()]
    .sort(([leftSymbol, leftCount], [rightSymbol, rightCount]) => leftCount - rightCount || leftSymbol.localeCompare(rightSymbol))
    .map(([symbol]) => symbol);
  const lowCount = Math.ceil(ordered.length / 2);
  return {
    lowLiquidity: ordered.slice(0, lowCount),
    highLiquidity: ordered.slice(lowCount),
    orderedSymbols: ordered,
  };
}

export function sideForShock(btcReturn: number): V19Side | null {
  if (btcReturn > 0) return "LONG";
  if (btcReturn < 0) return "SHORT";
  return null;
}

export function isPITWindowComplete(
  openTimes: readonly number[],
  signalOpenTime: number,
  windowMs = V19_PIT_WINDOW_MS,
  intervalMs = V19_INTERVAL_MS,
): boolean {
  const expectedStart = signalOpenTime - windowMs;
  const expectedCount = Math.floor(windowMs / intervalMs);
  if (openTimes.length !== expectedCount) return false;
  return openTimes.every((timestamp, index) => timestamp === expectedStart + index * intervalMs);
}

export function buildSynchronizedPriorWindow(
  btcByOpenTime: ReadonlyMap<number, V19Bar>,
  followerByOpenTime: ReadonlyMap<number, V19Bar>,
  signalOpenTime: number,
  windowMs = V19_PIT_WINDOW_MS,
  intervalMs = V19_INTERVAL_MS,
): V19PriorWindow | null {
  const start = signalOpenTime - windowMs;
  const count = Math.floor(windowMs / intervalMs);
  const btcReturns: number[] = [];
  const followerReturns: number[] = [];
  const tradeCounts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = start + index * intervalMs;
    const previousTimestamp = timestamp - intervalMs;
    const btc = btcByOpenTime.get(timestamp);
    const btcPrevious = btcByOpenTime.get(previousTimestamp);
    const follower = followerByOpenTime.get(timestamp);
    const followerPrevious = followerByOpenTime.get(previousTimestamp);
    if (!btc || !btcPrevious || !follower || !followerPrevious) return null;
    const btcReturn = logReturn(btc.close, btcPrevious.close);
    const followerReturn = logReturn(follower.close, followerPrevious.close);
    if (btcReturn === null || followerReturn === null || !Number.isFinite(follower.tradeCount)) return null;
    btcReturns.push(btcReturn);
    followerReturns.push(followerReturn);
    tradeCounts.push(follower.tradeCount);
  }
  return {
    startOpenTime: start,
    endOpenTimeExclusive: signalOpenTime,
    btcReturns,
    followerReturns,
    tradeCounts,
  };
}

export function buildFollowerFeature(
  prior: V19PriorWindow,
  currentBtcReturn: number,
  currentFollowerReturn: number,
  priorMedianTradeCount: number,
): V19FollowerFeature | null {
  const fit = fitOls(prior.followerReturns, prior.btcReturns);
  if (!fit || !Number.isFinite(currentBtcReturn) || !Number.isFinite(currentFollowerReturn)) return null;
  const expectedFollowerReturn = fit.alpha + fit.beta * currentBtcReturn;
  const residual = currentFollowerReturn - expectedFollowerReturn;
  const underreactionValues = prior.btcReturns.map((btcReturn, index) => (
    directionalUnderreaction(btcReturn, prior.followerReturns[index] - (fit.alpha + fit.beta * btcReturn))
  ));
  const underreactionQ90 = nearestRankQuantile(underreactionValues, V19_UNDERREACTION_QUANTILE);
  if (underreactionQ90 === null || !Number.isFinite(priorMedianTradeCount)) return null;
  return {
    alpha: fit.alpha,
    beta: fit.beta,
    currentFollowerReturn,
    expectedFollowerReturn,
    residual,
    directionalUnderreaction: directionalUnderreaction(currentBtcReturn, residual),
    underreactionQ90,
    priorMedianTradeCount,
  };
}

export function rollingMedianTradeCount(bars: readonly V19Bar[], windowBars: number): Map<number, number> {
  const result = new Map<number, number>();
  if (windowBars < 1) return result;
  const window = new RollingMedian();
  for (let index = 0; index < bars.length; index += 1) {
    if (index > 0) window.add(bars[index - 1].tradeCount, index - 1);
    if (index > windowBars) window.remove(index - windowBars - 1);
    if (index >= windowBars && window.size === windowBars) {
      const median = window.median();
      if (median !== null) result.set(bars[index].openTime, median);
    }
  }
  return result;
}

export function rollingMedianTradeCountSeries(
  openTimes: ArrayLike<number>,
  tradeCounts: ArrayLike<number>,
  windowBars: number,
): Float64Array {
  const result = new Float64Array(openTimes.length);
  result.fill(Number.NaN);
  if (windowBars < 1 || openTimes.length !== tradeCounts.length) return result;
  const window = new RollingMedian();
  for (let index = 0; index < openTimes.length; index += 1) {
    if (index > 0) window.add(tradeCounts[index - 1], index - 1);
    if (index > windowBars) window.remove(index - windowBars - 1);
    if (index >= windowBars && window.size === windowBars) {
      const median = window.median();
      if (median !== null) result[index] = median;
    }
  }
  return result;
}

export function rollingNearestRankQuantileSeries(
  values: ArrayLike<number>,
  windowSize: number,
  quantile: number,
): Float64Array {
  const result = new Float64Array(values.length);
  result.fill(Number.NaN);
  if (windowSize < 1 || !Number.isInteger(windowSize) || !Number.isFinite(quantile) || quantile < 0 || quantile > 1) return result;
  for (let index = 1; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return result;
  }
  const rank = Math.max(0, Math.min(windowSize - 1, Math.ceil(quantile * windowSize) - 1));
  const order = new RollingOrderStatistic(rank + 1);
  for (let signalIndex = windowSize + 1; signalIndex < values.length; signalIndex += 1) {
    if (signalIndex === windowSize + 1) {
      for (let returnIndex = 1; returnIndex <= windowSize; returnIndex += 1) {
        order.add(values[returnIndex], returnIndex);
      }
    } else {
      order.add(values[signalIndex - 1], signalIndex - 1);
      order.remove(signalIndex - windowSize - 1);
    }
    if (order.size === windowSize) {
      const value = order.value();
      if (value !== null) result[signalIndex] = value;
    }
  }
  return result;
}

export function hasOverlap(lastSignalOpenTime: number | null, currentSignalOpenTime: number, activeMinutes = 15): boolean {
  return lastSignalOpenTime !== null && currentSignalOpenTime - lastSignalOpenTime < activeMinutes * 60 * 1000;
}

export function resolveNextExecutionReference(
  openTimes: ArrayLike<number>,
  opens: ArrayLike<number>,
  signalOpenTime: number,
  intervalMs = V19_INTERVAL_MS,
): { openTime: number; price: number } | null {
  const expectedOpenTime = signalOpenTime + intervalMs;
  for (let index = 0; index < openTimes.length; index += 1) {
    if (openTimes[index] !== expectedOpenTime) continue;
    const price = opens[index];
    return Number.isFinite(price) && price > 0 ? { openTime: expectedOpenTime, price } : null;
  }
  return null;
}

export function exactPrimaryExitCloseTime(entryOpenTime: number, horizonMinutes = 15): number {
  return entryOpenTime + horizonMinutes * 60 * 1000 - 1;
}

export function hasExactPrimaryExit(
  openTimes: ArrayLike<number>,
  entryOpenTime: number,
  horizonMinutes = 15,
  intervalMs = V19_INTERVAL_MS,
): boolean {
  const exitOpenTime = entryOpenTime + horizonMinutes * 60 * 1000 - intervalMs;
  for (let index = 0; index < openTimes.length; index += 1) {
    if (openTimes[index] === exitOpenTime) return openTimes[index] + intervalMs - 1 === exactPrimaryExitCloseTime(entryOpenTime, horizonMinutes);
  }
  return false;
}

function mean(values: ArrayLike<number>): number {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) total += values[index];
  return total / values.length;
}

function selectKth(values: number[], target: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)];
    let lower = left;
    let cursor = left;
    let upper = right;
    while (cursor <= upper) {
      if (values[cursor] < pivot) {
        [values[lower], values[cursor]] = [values[cursor], values[lower]];
        lower += 1;
        cursor += 1;
      } else if (values[cursor] > pivot) {
        [values[cursor], values[upper]] = [values[upper], values[cursor]];
        upper -= 1;
      } else {
        cursor += 1;
      }
    }
    if (target < lower) right = lower - 1;
    else if (target > upper) left = upper + 1;
    else return values[target];
  }
  return values[left];
}

class RollingMedian {
  private readonly lower: HeapItem[] = [];
  private readonly upper: HeapItem[] = [];
  private readonly locations = new Map<number, "lower" | "upper">();
  private readonly removed = new Set<number>();
  private lowerSize = 0;
  private upperSize = 0;

  get size(): number {
    return this.lowerSize + this.upperSize;
  }

  add(value: number, index: number): void {
    if (this.lower.length === 0 || value <= this.lower[0].value) {
      pushHeap(this.lower, { value, index }, (a, b) => b.value - a.value || b.index - a.index);
      this.locations.set(index, "lower");
      this.lowerSize += 1;
    } else {
      pushHeap(this.upper, { value, index }, (a, b) => a.value - b.value || a.index - b.index);
      this.locations.set(index, "upper");
      this.upperSize += 1;
    }
    this.rebalance();
  }

  remove(index: number): void {
    const location = this.locations.get(index);
    if (!location) return;
    this.locations.delete(index);
    this.removed.add(index);
    if (location === "lower") this.lowerSize -= 1;
    else this.upperSize -= 1;
    this.rebalance();
  }

  median(): number | null {
    this.prune(this.lower);
    this.prune(this.upper);
    if (this.size === 0) return null;
    if (this.lowerSize === this.upperSize) return (this.lower[0].value + this.upper[0].value) / 2;
    return this.lower[0].value;
  }

  private rebalance(): void {
    this.prune(this.lower);
    this.prune(this.upper);
    while (this.lowerSize > this.upperSize + 1) {
      const item = popHeap(this.lower, (a, b) => b.value - a.value || b.index - a.index);
      if (!item) break;
      pushHeap(this.upper, item, (a, b) => a.value - b.value || a.index - b.index);
      this.locations.set(item.index, "upper");
      this.lowerSize -= 1;
      this.upperSize += 1;
      this.prune(this.lower);
    }
    while (this.upperSize > this.lowerSize) {
      const item = popHeap(this.upper, (a, b) => a.value - b.value || a.index - b.index);
      if (!item) break;
      pushHeap(this.lower, item, (a, b) => b.value - a.value || b.index - a.index);
      this.locations.set(item.index, "lower");
      this.upperSize -= 1;
      this.lowerSize += 1;
      this.prune(this.upper);
    }
  }

  private prune(heap: HeapItem[]): void {
    while (heap.length > 0 && this.removed.has(heap[0].index)) {
      const item = popHeap(heap, heap === this.lower
        ? (a, b) => b.value - a.value || b.index - a.index
        : (a, b) => a.value - b.value || a.index - b.index);
      if (item) this.removed.delete(item.index);
    }
  }
}

class RollingOrderStatistic {
  private readonly lower: HeapItem[] = [];
  private readonly upper: HeapItem[] = [];
  private readonly locations = new Map<number, "lower" | "upper">();
  private readonly removed = new Set<number>();
  private lowerSize = 0;
  private upperSize = 0;

  constructor(private readonly targetLowerSize: number) {}

  get size(): number {
    return this.lowerSize + this.upperSize;
  }

  add(value: number, index: number): void {
    this.prune(this.lower);
    if (this.lower.length === 0 || value <= this.lower[0].value) {
      pushHeap(this.lower, { value, index }, (a, b) => b.value - a.value || b.index - a.index);
      this.locations.set(index, "lower");
      this.lowerSize += 1;
    } else {
      pushHeap(this.upper, { value, index }, (a, b) => a.value - b.value || a.index - b.index);
      this.locations.set(index, "upper");
      this.upperSize += 1;
    }
    this.rebalance();
  }

  remove(index: number): void {
    const location = this.locations.get(index);
    if (!location) return;
    this.locations.delete(index);
    this.removed.add(index);
    if (location === "lower") this.lowerSize -= 1;
    else this.upperSize -= 1;
    this.rebalance();
  }

  value(): number | null {
    this.prune(this.lower);
    this.prune(this.upper);
    if (this.size === 0 || this.lowerSize < this.targetLowerSize) return null;
    return this.lower[0]?.value ?? null;
  }

  private rebalance(): void {
    this.prune(this.lower);
    this.prune(this.upper);
    while (this.lowerSize > this.targetLowerSize) {
      const item = popHeap(this.lower, (a, b) => b.value - a.value || b.index - a.index);
      if (!item) break;
      pushHeap(this.upper, item, (a, b) => a.value - b.value || a.index - b.index);
      this.locations.set(item.index, "upper");
      this.lowerSize -= 1;
      this.upperSize += 1;
      this.prune(this.lower);
    }
    while (this.lowerSize < Math.min(this.targetLowerSize, this.size)) {
      const item = popHeap(this.upper, (a, b) => a.value - b.value || a.index - b.index);
      if (!item) break;
      pushHeap(this.lower, item, (a, b) => b.value - a.value || b.index - a.index);
      this.locations.set(item.index, "lower");
      this.upperSize -= 1;
      this.lowerSize += 1;
      this.prune(this.upper);
    }
  }

  private prune(heap: HeapItem[]): void {
    while (heap.length > 0 && this.removed.has(heap[0].index)) {
      const item = popHeap(heap, heap === this.lower
        ? (a, b) => b.value - a.value || b.index - a.index
        : (a, b) => a.value - b.value || a.index - b.index);
      if (item) this.removed.delete(item.index);
    }
  }
}

interface HeapItem {
  value: number;
  index: number;
}

function pushHeap(heap: HeapItem[], item: HeapItem, compare: (a: HeapItem, b: HeapItem) => number): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popHeap(heap: HeapItem[], compare: (a: HeapItem, b: HeapItem) => number): HeapItem | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && compare(heap[smallest], heap[left]) > 0) smallest = left;
      if (right < heap.length && compare(heap[smallest], heap[right]) > 0) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
  return first;
}
