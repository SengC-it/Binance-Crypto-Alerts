import { createHash } from "node:crypto";
import type { V18Candle, V18Symbol } from "./data";
import { canonicalJson, sha256, V18_END, V18_FREEZE_TIMESTAMP, V18_INTERVAL_MS, V18_START, V18_WINDOW_BARS } from "./data";

export type V18FlowDirection = "BUY_FLOW_ABSORBED" | "SELL_FLOW_ABSORBED";
export type V18Side = "LONG" | "SHORT";

export const V18_EXECUTION_REFERENCE_SOURCE = "BINANCE_USDM_5M_NEXT_BAR_OPEN_ARCHIVE" as const;
export const V18_EXECUTION_REFERENCE_UNAVAILABLE = "DATA_UNAVAILABLE" as const;

export interface V18SignalEvent {
  symbol: V18Symbol;
  signalOpenTime: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number | null;
  executionReferencePrice: number | null;
  executionReferenceSource: typeof V18_EXECUTION_REFERENCE_SOURCE | typeof V18_EXECUTION_REFERENCE_UNAVAILABLE;
  flowDirection: V18FlowDirection;
  side: V18Side;
  flowImbalance: number;
  priorFiQ05: number;
  priorFiQ95: number;
  priorQuoteVolumeQ75: number;
  quoteVolume: number;
  priceResponse: number;
  signedEfficiency: number;
}

export interface V18PointInTimeRules {
  signalBar: "closed_5m_candle";
  priorWindow: "[signal_open_time_minus_30d, signal_open_time)";
  priorWindowBars: number;
  currentBarThresholds: "prior_30d_quantiles_only";
  nextBarUsage: "open_time_and_open_price_only";
  prohibitedNextBarFields: ["high", "low", "close", "volume", "quoteVolume", "tradeCount", "takerBuyBaseVolume", "takerBuyQuoteVolume"];
  noExtraFilters: true;
}

export const V18_POINT_IN_TIME_RULES: V18PointInTimeRules = {
  signalBar: "closed_5m_candle",
  priorWindow: "[signal_open_time_minus_30d, signal_open_time)",
  priorWindowBars: V18_WINDOW_BARS,
  currentBarThresholds: "prior_30d_quantiles_only",
  nextBarUsage: "open_time_and_open_price_only",
  prohibitedNextBarFields: ["high", "low", "close", "volume", "quoteVolume", "tradeCount", "takerBuyBaseVolume", "takerBuyQuoteVolume"],
  noExtraFilters: true,
};

export interface V18SignalEvaluation {
  event: V18SignalEvent | null;
  reason: "NO_HISTORY" | "QUOTE_VOLUME_NON_POSITIVE" | "RANGE_NON_POSITIVE" | "NOT_EXTREME_FLOW" | "NOT_ABSORBED" | "EXECUTION_REFERENCE_UNAVAILABLE" | "SIGNAL";
  flowImbalance: number | null;
  takerSellQuote: number | null;
  priorFiQ05: number | null;
  priorFiQ95: number | null;
  priorQuoteVolumeQ75: number | null;
}

export interface V18SymbolPreReturnCounts {
  bars: number;
  pitEvaluationBars: number;
  fullPriorWindowBars: number;
  quoteVolumeIneligible: number;
  rangeIneligible: number;
  extremeBuyFlow: number;
  extremeSellFlow: number;
  absorbedBuyFlow: number;
  absorbedSellFlow: number;
  rawTriggers: number;
  executionReferenceUnavailable: number;
  overlappingSignalsExcluded: number;
  finalEligibleEvents: number;
  finalEligibleBuyFlowAbsorbed: number;
  finalEligibleSellFlowAbsorbed: number;
}

export interface V18PreReturnAssessment {
  schema: "v18-pre-return-assessment-v1";
  source: { start: string; end: string; symbols: V18Symbol[]; fixedUniverse: true; noSyntheticData: true; noForwardFill: true };
  pointInTimeRules: V18PointInTimeRules;
  execution: {
    entry: "next_full_5m_candle_open";
    horizonMinutes: 60;
    unavailableNextBar: "DATA_UNAVAILABLE_NO_EVENT";
    oneActivePositionPerSymbol: true;
    overlapDisposition: "OVERLAPPING_SIGNAL_EXCLUDED";
    feeBpsPerSide: 4;
    slippageBpsPerSide: 2;
    baselineRoundTripBps: 12;
    stressAdditionalRoundTripBps: [5, 10, 20];
  };
  bySymbol: Record<V18Symbol, V18SymbolPreReturnCounts>;
  totals: {
    rawTriggers: number;
    executionReferenceAvailable: number;
    executionReferenceUnavailable: number;
    overlappingSignalsExcluded: number;
    finalEligibleEvents: number;
    finalEligibleBuyFlowAbsorbed: number;
    finalEligibleSellFlowAbsorbed: number;
    eventDigestSha256: string;
  };
  outcomeData: "NOT_READ";
  forwardReturnsRead: false;
  oosMetricsRead: false;
  holdoutRead: false;
  generatedAt: string;
}

export interface V18PreReturnResult {
  assessment: V18PreReturnAssessment;
  events: V18SignalEvent[];
}

export function takerSellQuote(candle: V18Candle): number {
  return candle.quoteVolume - candle.takerBuyQuoteVolume;
}

export function flowImbalance(candle: V18Candle): number | null {
  if (candle.quoteVolume <= 0) return null;
  return (candle.takerBuyQuoteVolume - takerSellQuote(candle)) / candle.quoteVolume;
}

export function quantile(values: number[], probability: number): number {
  if (values.length === 0) throw new Error("quantile requires at least one value");
  const ordered = values.slice().sort((left, right) => left - right);
  const position = probability * (ordered.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function binarySearch(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] === target) return middle;
    if (values[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

class Fenwick {
  private readonly values: Int32Array;
  constructor(size: number) { this.values = new Int32Array(size + 1); }
  add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.values.length; cursor += cursor & -cursor) this.values[cursor] += delta;
  }
  total(): number { return this.prefix(this.values.length - 1); }
  private prefix(index: number): number {
    let total = 0;
    for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) total += this.values[cursor];
    return total;
  }
  valueAt(rank: number): number {
    let index = 0;
    let bit = 1;
    while (bit * 2 < this.values.length) bit *= 2;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next < this.values.length && this.values[next] < rank) { index = next; rank -= this.values[next]; }
    }
    return index;
  }
}

function fenwickQuantile(tree: Fenwick, coordinates: number[], probability: number): number {
  const total = tree.total();
  if (total === 0) throw new Error("rolling quantile has no valid observations");
  const position = probability * (total - 1);
  const lowerRank = Math.floor(position) + 1;
  const upperRank = Math.ceil(position) + 1;
  const lower = coordinates[tree.valueAt(lowerRank)];
  const upper = coordinates[tree.valueAt(upperRank)];
  return lower + (upper - lower) * (position - Math.floor(position));
}

function nextExecution(candles: V18Candle[], index: number): { openTime: number; open: number } | null {
  const signal = candles[index];
  const next = candles[index + 1];
  if (!next || next.openTime !== signal.closeTime + 1 || next.openTime !== signal.openTime + V18_INTERVAL_MS) return null;
  return { openTime: next.openTime, open: next.open };
}

function createEvent(symbol: V18Symbol, candle: V18Candle, next: { openTime: number; open: number } | null, currentFi: number, q05: number, q95: number, q75: number, priceResponse: number): V18SignalEvent | null {
  const buyFlowAbsorbed = currentFi >= q95 && candle.quoteVolume >= q75 && currentFi > 0 && currentFi * priceResponse <= 0;
  const sellFlowAbsorbed = currentFi <= q05 && candle.quoteVolume >= q75 && currentFi < 0 && currentFi * priceResponse <= 0;
  if (!buyFlowAbsorbed && !sellFlowAbsorbed) return null;
  const flowDirection: V18FlowDirection = buyFlowAbsorbed ? "BUY_FLOW_ABSORBED" : "SELL_FLOW_ABSORBED";
  return { symbol, signalOpenTime: candle.openTime, signalCandleCloseTime: candle.closeTime, executionCandleOpenTime: next?.openTime ?? null, executionReferencePrice: next?.open ?? null, executionReferenceSource: next ? V18_EXECUTION_REFERENCE_SOURCE : V18_EXECUTION_REFERENCE_UNAVAILABLE, flowDirection, side: flowDirection === "BUY_FLOW_ABSORBED" ? "SHORT" : "LONG", flowImbalance: currentFi, priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75, quoteVolume: candle.quoteVolume, priceResponse, signedEfficiency: currentFi * priceResponse };
}

function simpleEvaluation(symbol: V18Symbol, candles: V18Candle[], index: number, windowBars: number): V18SignalEvaluation {
  const candle = candles[index];
  if (index < windowBars || candles[index].openTime - candles[index - windowBars].openTime !== windowBars * V18_INTERVAL_MS) return { event: null, reason: "NO_HISTORY", flowImbalance: null, takerSellQuote: null, priorFiQ05: null, priorFiQ95: null, priorQuoteVolumeQ75: null };
  const currentFi = flowImbalance(candle);
  if (currentFi === null) return { event: null, reason: "QUOTE_VOLUME_NON_POSITIVE", flowImbalance: null, takerSellQuote: takerSellQuote(candle), priorFiQ05: null, priorFiQ95: null, priorQuoteVolumeQ75: null };
  const priorFi: number[] = [];
  const priorVolume: number[] = [];
  for (let cursor = index - windowBars; cursor < index; cursor += 1) {
    const fi = flowImbalance(candles[cursor]);
    if (fi === null) return { event: null, reason: "NO_HISTORY", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: null, priorFiQ95: null, priorQuoteVolumeQ75: null };
    priorFi.push(fi);
    priorVolume.push(candles[cursor].quoteVolume);
  }
  const q05 = quantile(priorFi, 0.05);
  const q95 = quantile(priorFi, 0.95);
  const q75 = quantile(priorVolume, 0.75);
  const range = candle.high - candle.low;
  if (range <= 0) return { event: null, reason: "RANGE_NON_POSITIVE", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75 };
  const priceResponse = (candle.close - candle.open) / range;
  const extreme = (currentFi >= q95 && currentFi > 0 && candle.quoteVolume >= q75) || (currentFi <= q05 && currentFi < 0 && candle.quoteVolume >= q75);
  if (!extreme) return { event: null, reason: "NOT_EXTREME_FLOW", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75 };
  const event = createEvent(symbol, candle, nextExecution(candles, index), currentFi, q05, q95, q75, priceResponse);
  if (!event) return { event: null, reason: "NOT_ABSORBED", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75 };
  if (event.executionReferenceSource === V18_EXECUTION_REFERENCE_UNAVAILABLE) return { event: null, reason: "EXECUTION_REFERENCE_UNAVAILABLE", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75 };
  return { event, reason: "SIGNAL", flowImbalance: currentFi, takerSellQuote: takerSellQuote(candle), priorFiQ05: q05, priorFiQ95: q95, priorQuoteVolumeQ75: q75 };
}

export function evaluateV18SignalAt(symbol: V18Symbol, candles: V18Candle[], index: number, windowBars = V18_WINDOW_BARS): V18SignalEvaluation {
  return simpleEvaluation(symbol, candles, index, windowBars);
}

function emptyCounts(): V18SymbolPreReturnCounts {
  return { bars: 0, pitEvaluationBars: 0, fullPriorWindowBars: 0, quoteVolumeIneligible: 0, rangeIneligible: 0, extremeBuyFlow: 0, extremeSellFlow: 0, absorbedBuyFlow: 0, absorbedSellFlow: 0, rawTriggers: 0, executionReferenceUnavailable: 0, overlappingSignalsExcluded: 0, finalEligibleEvents: 0, finalEligibleBuyFlowAbsorbed: 0, finalEligibleSellFlowAbsorbed: 0 };
}

function updateRollingTree(tree: Fenwick, coordinates: number[], value: number | null, delta: number): void {
  if (value === null) return;
  const index = binarySearch(coordinates, value);
  if (index < 0) throw new Error("rolling coordinate is missing");
  tree.add(index, delta);
}

export function selectNonOverlappingSignals(events: V18SignalEvent[]): { eligible: V18SignalEvent[]; excluded: number } {
  const lastActiveUntil = new Map<V18Symbol, number>();
  const eligible: V18SignalEvent[] = [];
  let excluded = 0;
  for (const event of events.slice().sort((left, right) => (left.executionCandleOpenTime ?? Infinity) - (right.executionCandleOpenTime ?? Infinity))) {
    if (event.executionCandleOpenTime === null) continue;
    const activeUntil = lastActiveUntil.get(event.symbol) ?? -Infinity;
    if (event.executionCandleOpenTime < activeUntil) { excluded += 1; continue; }
    lastActiveUntil.set(event.symbol, event.executionCandleOpenTime + 60 * 60_000);
    eligible.push(event);
  }
  return { eligible, excluded };
}

function rollingSignalEvents(symbol: V18Symbol, candles: V18Candle[], events: V18SignalEvent[], counts: V18SymbolPreReturnCounts): void {
  const fiValues = candles.map(flowImbalance);
  const volumeValues = candles.map((candle) => candle.quoteVolume > 0 ? candle.quoteVolume : null);
  const fiCoordinates = [...new Set(fiValues.filter((value): value is number => value !== null))].sort((left, right) => left - right);
  const volumeCoordinates = [...new Set(volumeValues.filter((value): value is number => value !== null))].sort((left, right) => left - right);
  const fiTree = new Fenwick(fiCoordinates.length);
  const volumeTree = new Fenwick(volumeCoordinates.length);
  const availableEvents: V18SignalEvent[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    counts.bars += 1;
    const candle = candles[index];
    if (index < V18_WINDOW_BARS) continue;
    if (index === V18_WINDOW_BARS) {
      for (let cursor = 0; cursor < V18_WINDOW_BARS; cursor += 1) { updateRollingTree(fiTree, fiCoordinates, fiValues[cursor], 1); updateRollingTree(volumeTree, volumeCoordinates, volumeValues[cursor], 1); }
    } else {
      const removed = index - V18_WINDOW_BARS - 1;
      const added = index - 1;
      updateRollingTree(fiTree, fiCoordinates, fiValues[removed], -1);
      updateRollingTree(volumeTree, volumeCoordinates, volumeValues[removed], -1);
      updateRollingTree(fiTree, fiCoordinates, fiValues[added], 1);
      updateRollingTree(volumeTree, volumeCoordinates, volumeValues[added], 1);
    }
    if (candle.openTime < Date.parse("2022-01-01T00:00:00.000Z") || candle.openTime > Date.parse(V18_END)) continue;
    counts.pitEvaluationBars += 1;
    if (fiTree.total() !== V18_WINDOW_BARS || volumeTree.total() !== V18_WINDOW_BARS) continue;
    counts.fullPriorWindowBars += 1;
    const currentFi = fiValues[index];
    if (currentFi === null) { counts.quoteVolumeIneligible += 1; continue; }
    const range = candle.high - candle.low;
    if (range <= 0) { counts.rangeIneligible += 1; continue; }
    const q05 = fenwickQuantile(fiTree, fiCoordinates, 0.05);
    const q95 = fenwickQuantile(fiTree, fiCoordinates, 0.95);
    const q75 = fenwickQuantile(volumeTree, volumeCoordinates, 0.75);
    const priceResponse = (candle.close - candle.open) / range;
    const buyExtreme = currentFi >= q95 && currentFi > 0 && candle.quoteVolume >= q75;
    const sellExtreme = currentFi <= q05 && currentFi < 0 && candle.quoteVolume >= q75;
    if (buyExtreme) counts.extremeBuyFlow += 1;
    if (sellExtreme) counts.extremeSellFlow += 1;
    if (!buyExtreme && !sellExtreme) continue;
    const event = createEvent(symbol, candle, nextExecution(candles, index), currentFi, q05, q95, q75, priceResponse);
    if (!event) continue;
    if (event.flowDirection === "BUY_FLOW_ABSORBED") counts.absorbedBuyFlow += 1;
    else counts.absorbedSellFlow += 1;
    counts.rawTriggers += 1;
    if (event.executionReferenceSource === V18_EXECUTION_REFERENCE_UNAVAILABLE) { counts.executionReferenceUnavailable += 1; continue; }
    availableEvents.push(event);
  }
  const selected = selectNonOverlappingSignals(availableEvents);
  counts.overlappingSignalsExcluded += selected.excluded;
  counts.finalEligibleEvents += selected.eligible.length;
  counts.finalEligibleBuyFlowAbsorbed += selected.eligible.filter((event) => event.flowDirection === "BUY_FLOW_ABSORBED").length;
  counts.finalEligibleSellFlowAbsorbed += selected.eligible.filter((event) => event.flowDirection === "SELL_FLOW_ABSORBED").length;
  events.push(...selected.eligible);
}

export function buildPreReturnAssessment(candles: Record<V18Symbol, V18Candle[]>): V18PreReturnResult {
  const events: V18SignalEvent[] = [];
  const bySymbol = {} as Record<V18Symbol, V18SymbolPreReturnCounts>;
  for (const symbol of ["BTCUSDT", "ETHUSDT"] as const) { const counts = emptyCounts(); rollingSignalEvents(symbol, candles[symbol], events, counts); bySymbol[symbol] = counts; }
  events.sort((left, right) => left.executionCandleOpenTime! - right.executionCandleOpenTime! || left.symbol.localeCompare(right.symbol));
  const digest = createHash("sha256");
  for (const event of events) digest.update(`${canonicalJson(event)}\n`);
  const totals = { rawTriggers: Object.values(bySymbol).reduce((total, value) => total + value.rawTriggers, 0), executionReferenceAvailable: events.length + Object.values(bySymbol).reduce((total, value) => total + value.overlappingSignalsExcluded, 0), executionReferenceUnavailable: Object.values(bySymbol).reduce((total, value) => total + value.executionReferenceUnavailable, 0), overlappingSignalsExcluded: Object.values(bySymbol).reduce((total, value) => total + value.overlappingSignalsExcluded, 0), finalEligibleEvents: events.length, finalEligibleBuyFlowAbsorbed: Object.values(bySymbol).reduce((total, value) => total + value.finalEligibleBuyFlowAbsorbed, 0), finalEligibleSellFlowAbsorbed: Object.values(bySymbol).reduce((total, value) => total + value.finalEligibleSellFlowAbsorbed, 0), eventDigestSha256: digest.digest("hex") };
  const assessment: V18PreReturnAssessment = { schema: "v18-pre-return-assessment-v1", source: { start: V18_START, end: V18_END, symbols: ["BTCUSDT", "ETHUSDT"], fixedUniverse: true, noSyntheticData: true, noForwardFill: true }, pointInTimeRules: V18_POINT_IN_TIME_RULES, execution: { entry: "next_full_5m_candle_open", horizonMinutes: 60, unavailableNextBar: "DATA_UNAVAILABLE_NO_EVENT", oneActivePositionPerSymbol: true, overlapDisposition: "OVERLAPPING_SIGNAL_EXCLUDED", feeBpsPerSide: 4, slippageBpsPerSide: 2, baselineRoundTripBps: 12, stressAdditionalRoundTripBps: [5, 10, 20] }, bySymbol, totals, outcomeData: "NOT_READ", forwardReturnsRead: false, oosMetricsRead: false, holdoutRead: false, generatedAt: V18_FREEZE_TIMESTAMP };
  return { assessment, events };
}

export function preReturnAssessmentSha256(assessment: V18PreReturnAssessment): string {
  return sha256(canonicalJson(assessment));
}
