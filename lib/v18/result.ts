import { createHash } from "node:crypto";
import type { V18Candle, V18Symbol } from "./data";
import { canonicalJson, V18_END, V18_INTERVAL_MS, V18_START, V18_WINDOW_BARS } from "./data";
import { flowImbalance, type V18SignalEvent } from "./engine";

export const V18_FREEZE_COMMIT = "c8b8c1e728079ce947e4b2314442a44d04d8ed90";
export const V18_FREEZE_MANIFEST_SHA256 = "8c7353680ff085625fbbaad932d7064afb431448e759008bb0a809b4fc6c16d8";
export const V18_BASELINE_ROUND_TRIP_BPS = 12;
export const V18_STRESS_BPS = [5, 10, 20] as const;
export const V18_BOOTSTRAP_ITERATIONS = 10_000;

export interface V18Outcome {
  event: V18SignalEvent;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  grossReturn: number;
}

export interface V18Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossReturn: number;
  fees: number;
  slippage: number;
  netReturn: number;
  averageNetReturnPerTrade: number;
  profitFactor: number | null;
  maxDrawdown: number;
  cvar95: number | null;
}

export interface V18Confidence {
  samples: number;
  confidenceLevel: 0.95;
  meanNetReturn: number;
  lower95: number;
  upper95: number;
  bootstrapLCB95: number;
  seed: number;
}

export interface V18ControlEvent {
  control: "EXTREME_FLOW_ONLY" | "FLOW_CONTINUATION" | "TIME_MATCHED_RANDOM";
  symbol: V18Symbol;
  signalOpenTime: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number | null;
  executionReferencePrice: number | null;
  side: "LONG" | "SHORT";
}

export interface V18OutcomeRead {
  outcomes: V18Outcome[];
  unavailableEventIdentities: Array<{ symbol: V18Symbol; signalOpenTime: number; reason: "NO_60M_EXIT" | "NO_ENTRY" }>;
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function sortedCandleAt(candles: V18Candle[], openTime: number): V18Candle | null {
  const index = lowerBound(candles.map((candle) => candle.openTime), openTime);
  return candles[index]?.openTime === openTime ? candles[index] : null;
}

export function fixedHorizonExitOpenTime(entryTime: number): number {
  return entryTime + 60 * 60_000 - V18_INTERVAL_MS;
}

export function readFixedHorizonOutcome(event: V18SignalEvent, candles: V18Candle[]): V18Outcome | null {
  if (event.executionCandleOpenTime === null || event.executionReferencePrice === null) return null;
  const exitOpenTime = fixedHorizonExitOpenTime(event.executionCandleOpenTime);
  const exitCandle = sortedCandleAt(candles, exitOpenTime);
  if (!exitCandle) return null;
  const grossReturn = event.side === "LONG"
    ? (exitCandle.close - event.executionReferencePrice) / event.executionReferencePrice
    : (event.executionReferencePrice - exitCandle.close) / event.executionReferencePrice;
  return { event, entryPrice: event.executionReferencePrice, exitPrice: exitCandle.close, entryTime: event.executionCandleOpenTime, exitTime: exitCandle.closeTime, grossReturn };
}

export function readFrozenOutcomes(events: V18SignalEvent[], candles: Record<V18Symbol, V18Candle[]>): V18OutcomeRead {
  const outcomes: V18Outcome[] = [];
  const unavailableEventIdentities: V18OutcomeRead["unavailableEventIdentities"] = [];
  for (const event of events) {
    const outcome = readFixedHorizonOutcome(event, candles[event.symbol]);
    if (outcome) outcomes.push(outcome);
    else unavailableEventIdentities.push({ symbol: event.symbol, signalOpenTime: event.signalOpenTime, reason: event.executionCandleOpenTime === null || event.executionReferencePrice === null ? "NO_ENTRY" : "NO_60M_EXIT" });
  }
  return { outcomes: outcomes.sort((left, right) => left.entryTime - right.entryTime || left.event.symbol.localeCompare(right.event.symbol)), unavailableEventIdentities };
}

export function metricsForOutcomes(outcomes: V18Outcome[], additionalRoundTripBps = 0): V18Metrics {
  const feesPerTrade = 8 / 10_000;
  const slippagePerTrade = 4 / 10_000;
  const totalCost = (V18_BASELINE_ROUND_TRIP_BPS + additionalRoundTripBps) / 10_000;
  const returns = outcomes.map((outcome) => outcome.grossReturn - totalCost);
  const grossReturn = outcomes.reduce((total, outcome) => total + outcome.grossReturn, 0);
  const netReturn = returns.reduce((total, value) => total + value, 0);
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  const sorted = returns.slice().sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(sorted.length * 0.05));
  const cvar95 = sorted.length ? sorted.slice(0, tailCount).reduce((total, value) => total + value, 0) / tailCount : null;
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const value of returns) { cumulative += value; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative); }
  const profitFactor = negative.length ? positive.reduce((total, value) => total + value, 0) / Math.abs(negative.reduce((total, value) => total + value, 0)) : positive.length ? null : 0;
  return { trades: returns.length, wins: positive.length, losses: negative.length, winRate: returns.length ? positive.length / returns.length : 0, grossReturn, fees: outcomes.length * feesPerTrade, slippage: outcomes.length * slippagePerTrade, netReturn, averageNetReturnPerTrade: returns.length ? netReturn / returns.length : 0, profitFactor, maxDrawdown, cvar95 };
}

function quantile(values: number[], probability: number): number {
  if (!values.length) throw new Error("quantile requires observations");
  const sorted = values.slice().sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function bootstrapMeanConfidence(outcomes: V18Outcome[], additionalRoundTripBps = 0, iterations = V18_BOOTSTRAP_ITERATIONS, seed = 18_051_805): V18Confidence {
  const values = outcomes.map((outcome) => outcome.grossReturn - (V18_BASELINE_ROUND_TRIP_BPS + additionalRoundTripBps) / 10_000);
  if (!values.length) return { samples: iterations, confidenceLevel: 0.95, meanNetReturn: 0, lower95: 0, upper95: 0, bootstrapLCB95: 0, seed };
  let state = seed >>> 0;
  const means: number[] = [];
  for (let sample = 0; sample < iterations; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; total += values[state % values.length]; }
    means.push(total / values.length);
  }
  return { samples: iterations, confidenceLevel: 0.95, meanNetReturn: values.reduce((total, value) => total + value, 0) / values.length, lower95: quantile(means, 0.025), upper95: quantile(means, 0.975), bootstrapLCB95: quantile(means, 0.025), seed };
}

class Fenwick {
  private readonly values: Int32Array;
  constructor(size: number) { this.values = new Int32Array(size + 1); }
  add(index: number, delta: number): void { for (let cursor = index + 1; cursor < this.values.length; cursor += cursor & -cursor) this.values[cursor] += delta; }
  total(): number { let total = 0; for (let cursor = this.values.length - 1; cursor > 0; cursor -= cursor & -cursor) total += this.values[cursor]; return total; }
  valueAt(rank: number): number { let index = 0; let bit = 1; while (bit * 2 < this.values.length) bit *= 2; for (; bit > 0; bit >>= 1) { const next = index + bit; if (next < this.values.length && this.values[next] < rank) { index = next; rank -= this.values[next]; } } return index; }
}

function coordinateIndex(values: number[], target: number): number {
  const index = lowerBound(values, target);
  if (values[index] !== target) throw new Error("control rolling coordinate missing");
  return index;
}

function addRolling(tree: Fenwick, coordinates: number[], value: number | null, delta: number): void { if (value !== null) tree.add(coordinateIndex(coordinates, value), delta); }

function controlEvent(control: V18ControlEvent["control"], symbol: V18Symbol, candle: V18Candle, next: V18Candle, side: "LONG" | "SHORT"): V18ControlEvent {
  return { control, symbol, signalOpenTime: candle.openTime, signalCandleCloseTime: candle.closeTime, executionCandleOpenTime: next.openTime, executionReferencePrice: next.open, side };
}

function nonOverlappingControls(events: V18ControlEvent[]): V18ControlEvent[] {
  const activeUntil = new Map<V18Symbol, number>();
  const selected: V18ControlEvent[] = [];
  for (const event of events.slice().sort((left, right) => (left.executionCandleOpenTime ?? Infinity) - (right.executionCandleOpenTime ?? Infinity))) {
    if (event.executionCandleOpenTime === null || event.executionReferencePrice === null) continue;
    const until = activeUntil.get(event.symbol) ?? -Infinity;
    if (event.executionCandleOpenTime < until) continue;
    activeUntil.set(event.symbol, event.executionCandleOpenTime + 60 * 60_000);
    selected.push(event);
  }
  return selected;
}

function rollingExtremeEvents(symbol: V18Symbol, candles: V18Candle[], control: "EXTREME_FLOW_ONLY" | "FLOW_CONTINUATION"): V18ControlEvent[] {
  const fi = candles.map(flowImbalance);
  const volume = candles.map((candle) => candle.quoteVolume > 0 ? candle.quoteVolume : null);
  const fiCoordinates = [...new Set(fi.filter((value): value is number => value !== null))].sort((left, right) => left - right);
  const volumeCoordinates = [...new Set(volume.filter((value): value is number => value !== null))].sort((left, right) => left - right);
  const fiTree = new Fenwick(fiCoordinates.length);
  const volumeTree = new Fenwick(volumeCoordinates.length);
  const events: V18ControlEvent[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    if (index < V18_WINDOW_BARS) continue;
    if (index === V18_WINDOW_BARS) for (let cursor = 0; cursor < V18_WINDOW_BARS; cursor += 1) { addRolling(fiTree, fiCoordinates, fi[cursor], 1); addRolling(volumeTree, volumeCoordinates, volume[cursor], 1); }
    else { const removed = index - V18_WINDOW_BARS - 1; const added = index - 1; addRolling(fiTree, fiCoordinates, fi[removed], -1); addRolling(volumeTree, volumeCoordinates, volume[removed], -1); addRolling(fiTree, fiCoordinates, fi[added], 1); addRolling(volumeTree, volumeCoordinates, volume[added], 1); }
    const candle = candles[index];
    if (candle.openTime < Date.parse("2022-01-01T00:00:00.000Z") || candle.openTime > Date.parse(V18_END) || candle.high <= candle.low || fiTree.total() !== V18_WINDOW_BARS || volumeTree.total() !== V18_WINDOW_BARS) continue;
    const q05 = fiCoordinates[fiTree.valueAt(Math.floor(fiTree.total() * 0.05) || 1)];
    const q95 = fiCoordinates[fiTree.valueAt(Math.ceil(fiTree.total() * 0.95) || 1)];
    const q75 = volumeCoordinates[volumeTree.valueAt(Math.ceil(volumeTree.total() * 0.75) || 1)];
    const currentFi = fi[index];
    if (currentFi === null) continue;
    const priceResponse = (candle.close - candle.open) / (candle.high - candle.low);
    const buyExtreme = currentFi >= q95 && currentFi > 0 && candle.quoteVolume >= q75;
    const sellExtreme = currentFi <= q05 && currentFi < 0 && candle.quoteVolume >= q75;
    const buyContinuation = buyExtreme && currentFi * priceResponse > 0;
    const sellContinuation = sellExtreme && currentFi * priceResponse > 0;
    const selected = control === "EXTREME_FLOW_ONLY" ? buyExtreme || sellExtreme : buyContinuation || sellContinuation;
    if (!selected) continue;
    const next = candles[index + 1];
    if (!next || next.openTime !== candle.closeTime + 1 || next.openTime !== candle.openTime + V18_INTERVAL_MS) continue;
    const side: "LONG" | "SHORT" = buyExtreme || buyContinuation ? (control === "FLOW_CONTINUATION" ? "LONG" : "SHORT") : control === "FLOW_CONTINUATION" ? "SHORT" : "LONG";
    events.push(controlEvent(control, symbol, candle, next, side));
  }
  return nonOverlappingControls(events);
}

function deterministicRandomSide(event: V18SignalEvent): "LONG" | "SHORT" {
  const digest = createHash("sha256").update(`${event.symbol}|${event.signalOpenTime}|TIME_MATCHED_RANDOM`).digest();
  return (digest[0] & 1) === 0 ? "LONG" : "SHORT";
}

export function buildControlEvents(candles: Record<V18Symbol, V18Candle[]>, absorptionEvents: V18SignalEvent[]): Record<V18ControlEvent["control"], V18ControlEvent[]> {
  return { EXTREME_FLOW_ONLY: nonOverlappingControls([...rollingExtremeEvents("BTCUSDT", candles.BTCUSDT, "EXTREME_FLOW_ONLY"), ...rollingExtremeEvents("ETHUSDT", candles.ETHUSDT, "EXTREME_FLOW_ONLY")]), FLOW_CONTINUATION: nonOverlappingControls([...rollingExtremeEvents("BTCUSDT", candles.BTCUSDT, "FLOW_CONTINUATION"), ...rollingExtremeEvents("ETHUSDT", candles.ETHUSDT, "FLOW_CONTINUATION")]), TIME_MATCHED_RANDOM: absorptionEvents.map((event) => ({ control: "TIME_MATCHED_RANDOM", symbol: event.symbol, signalOpenTime: event.signalOpenTime, signalCandleCloseTime: event.signalCandleCloseTime, executionCandleOpenTime: event.executionCandleOpenTime, executionReferencePrice: event.executionReferencePrice, side: deterministicRandomSide(event) })) };
}

export function readControlOutcome(event: V18ControlEvent, candles: V18Candle[]): V18Outcome | null {
  if (event.executionCandleOpenTime === null || event.executionReferencePrice === null) return null;
  const exitCandle = sortedCandleAt(candles, fixedHorizonExitOpenTime(event.executionCandleOpenTime));
  if (!exitCandle) return null;
  const grossReturn = event.side === "LONG" ? (exitCandle.close - event.executionReferencePrice) / event.executionReferencePrice : (event.executionReferencePrice - exitCandle.close) / event.executionReferencePrice;
  const signal = { symbol: event.symbol, signalOpenTime: event.signalOpenTime, signalCandleCloseTime: event.signalCandleCloseTime, executionCandleOpenTime: event.executionCandleOpenTime, executionReferencePrice: event.executionReferencePrice, executionReferenceSource: "BINANCE_USDM_5M_NEXT_BAR_OPEN_ARCHIVE" as const, flowDirection: "BUY_FLOW_ABSORBED" as const, side: event.side, flowImbalance: 0, priorFiQ05: 0, priorFiQ95: 0, priorQuoteVolumeQ75: 0, quoteVolume: 0, priceResponse: 0, signedEfficiency: 0 };
  return { event: signal, entryPrice: event.executionReferencePrice, exitPrice: exitCandle.close, entryTime: event.executionCandleOpenTime, exitTime: exitCandle.closeTime, grossReturn };
}

export function controlIdentityDigest(events: V18ControlEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events.slice().sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol))) hash.update(`${canonicalJson(event)}\n`);
  return hash.digest("hex");
}

export function resultMetricColumns(): string[] {
  return ["trades", "wins", "losses", "winRate", "grossReturn", "fees", "slippage", "netReturn", "averageNetReturnPerTrade", "profitFactor", "maxDrawdown", "cvar95"];
}

export const V18_RESULT_BOUNDARIES = { historicalReturnsRead: true, parameterSearch: false, productionChanged: false, productionEmail: "OFF", deploy: false, merge: false, migration: false, privateBinanceApi: false, orderPlacement: false, autoTrading: false, automaticPromotion: false } as const;

export const V18_RESULT_WINDOWS = { primaryOos: { start: "2022-01-01T00:00:00.000Z", end: "2024-12-31T23:59:59.999Z" }, holdoutA: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z" }, holdoutB: { start: "2026-01-01T00:00:00.000Z", end: V18_END }, dataStart: V18_START } as const;

export function inWindow(timestamp: number, start: string, end: string): boolean { return timestamp >= Date.parse(start) && timestamp <= Date.parse(end); }
