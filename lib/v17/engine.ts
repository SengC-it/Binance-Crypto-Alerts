import type { V17Candle, V17FundingPoint, V17ParsedDatasets, V17Symbol } from "./data";

export const V17_PARAMETERS = {
  fundingLookbackDays: 180,
  minimumFundingHistoryDays: 90,
  fundingQuantiles: { long: 0.9, short: 0.1 },
  preReturnHours: 8,
  continuationMinutes: 30,
  continuationQuantile: 0.5,
  atrPeriod: 14,
  stopAtr: 1.5,
  rewardRisk: 2,
  maxHoldHours: 6,
  takerFeeBpsPerSide: 4,
  baseSlippageBpsPerSide: 2,
  stressRoundTripBps: [5, 10, 20] as const,
  manualDelayMinutes: [5, 15, 30] as const,
} as const;

export type CrowdingSide = "CROWDED_LONG" | "CROWDED_SHORT";
export type SignalVariant = "PRIMARY" | "EXTREME_FUNDING_ONLY" | "CONTINUATION_DIRECTION" | "TIME_MATCHED_RANDOM";

export interface V17SignalEvent {
  symbol: V17Symbol;
  fundingTimestamp: number;
  fundingRate: number;
  crowdingSide: CrowdingSide;
  direction: 1 | -1;
  preReturn8h: number;
  priceAtFunding: number;
  decisionTime: number;
  postReturn30m: number;
  continuationResponse: number;
  responseQ50: number | null;
  referenceEligible: boolean;
  priceSource: "USD_M_FUTURES_15M_CLOSED_CLOSE";
  primaryEligible: boolean;
  rejectionReason: string | null;
}

export interface V17Trade {
  symbol: V17Symbol;
  variant: SignalVariant;
  crowdingSide: CrowdingSide;
  direction: 1 | -1;
  fundingTimestamp: number;
  decisionTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  riskPrice: number;
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME" | "DATA_UNAVAILABLE";
  grossR: number;
  feesR: number;
  slippageR: number;
  fundingR: number;
  netR: number;
  netPnl: number;
  stressNetR: Record<5 | 10 | 20, number>;
}

export interface V17Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossR: number;
  feesR: number;
  slippageR: number;
  fundingR: number;
  netR: number;
  netPnl: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownR: number;
  cvar95R: number;
}

export interface V17EngineResult {
  signalsEvaluated: number;
  rawTriggers: number;
  rejectedSignals: number;
  dataUnavailable: number;
  events: V17SignalEvent[];
  trades: V17Trade[];
  metrics: V17Metrics;
}

export interface V17DelayResult {
  delayMinutes: 0 | 5 | 15 | 30;
  expiredBeforeEntry: number;
  trades: V17Trade[];
  metrics: V17Metrics;
}

export function fundingDecisionTime(fundingTimestamp: number): number {
  return fundingTimestamp + V17_PARAMETERS.continuationMinutes * 60_000;
}

function lowerBound<T>(values: T[], target: number, get: (value: T) => number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (get(values[middle]) < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound<T>(values: T[], target: number, get: (value: T) => number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (get(values[middle]) <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function fundingHistoryBefore(points: V17FundingPoint[], timestamp: number): V17FundingPoint[] {
  return points.filter((point) => point.timestamp < timestamp && point.timestamp >= timestamp - V17_PARAMETERS.fundingLookbackDays * 86_400_000).sort((left, right) => left.timestamp - right.timestamp);
}

export function fundingHistorySpanDays(points: V17FundingPoint[], timestamp: number): number {
  const history = fundingHistoryBefore(points, timestamp);
  return history.length ? (timestamp - history[0].timestamp) / 86_400_000 : 0;
}

export function hasMinimumFundingHistory(points: V17FundingPoint[], timestamp: number): boolean {
  return fundingHistorySpanDays(points, timestamp) >= V17_PARAMETERS.minimumFundingHistoryDays;
}

export function responseQ50FromReferences(references: Array<{ timestamp: number; response: number }>, timestamp: number): number | null {
  return quantile(references.filter((reference) => reference.timestamp < timestamp && reference.timestamp >= timestamp - V17_PARAMETERS.fundingLookbackDays * 86_400_000).map((reference) => reference.response), V17_PARAMETERS.continuationQuantile);
}

function markAt(marks: V17Candle[], timestamp: number): number | null {
  const index = upperBound(marks, timestamp, (bar) => bar.openTime) - 1;
  const bar = index >= 0 ? marks[index] : null;
  return bar && timestamp <= bar.closeTime ? bar.open : null;
}

export function latestClosedCandleBefore(candles: V17Candle[], timestamp: number): V17Candle | null {
  const index = upperBound(candles, timestamp - 1, (bar) => bar.closeTime) - 1;
  return index >= 0 ? candles[index] : null;
}

export function priceAtFunding(candles: V17Candle[], timestamp: number): number | null {
  return latestClosedCandleBefore(candles, timestamp)?.close ?? null;
}

export function preReturn8h(candles: V17Candle[], timestamp: number): number | null {
  const current = latestClosedCandleBefore(candles, timestamp);
  const prior = latestClosedCandleBefore(candles, timestamp - V17_PARAMETERS.preReturnHours * 3_600_000 + 1);
  if (!current || !prior || prior.close <= 0) return null;
  return current.close / prior.close - 1;
}

export function postReturn30m(candles: V17Candle[], fundingTimestamp: number, priceAtFunding: number): number | null {
  const decisionTime = fundingDecisionTime(fundingTimestamp);
  const start = Math.floor(fundingTimestamp / (15 * 60_000)) * (15 * 60_000);
  const first = lowerBound(candles, start, (bar) => bar.openTime);
  const second = candles[first + 1];
  const firstBar = candles[first];
  if (!firstBar || !second || firstBar.openTime !== start || second.openTime !== start + 15 * 60_000 || second.closeTime >= decisionTime || priceAtFunding <= 0) return null;
  return second.close / priceAtFunding - 1;
}

export function buildSignalEvents(datasets: V17ParsedDatasets): V17SignalEvent[] {
  const events: V17SignalEvent[] = [];
  for (const symbol of ["BTCUSDT", "ETHUSDT"] as const) {
    const data = datasets[symbol];
    const referenceResponses: Record<CrowdingSide, Array<{ timestamp: number; response: number }>> = { CROWDED_LONG: [], CROWDED_SHORT: [] };
    for (const funding of data.funding) {
      const history = fundingHistoryBefore(data.funding, funding.timestamp);
      if (!hasMinimumFundingHistory(data.funding, funding.timestamp)) continue;
      const q90 = quantile(history.map((point) => point.fundingRate), V17_PARAMETERS.fundingQuantiles.long);
      const q10 = quantile(history.map((point) => point.fundingRate), V17_PARAMETERS.fundingQuantiles.short);
      const crowdingSide: CrowdingSide | null = q90 !== null && funding.fundingRate >= q90 ? "CROWDED_LONG" : q10 !== null && funding.fundingRate <= q10 ? "CROWDED_SHORT" : null;
      if (!crowdingSide) continue;
      const directionSign = crowdingSide === "CROWDED_LONG" ? 1 : -1;
      const impulse = preReturn8h(data.candles15m, funding.timestamp);
      const price = priceAtFunding(data.candles15m, funding.timestamp);
      const post = price === null ? null : postReturn30m(data.candles15m, funding.timestamp, price);
      const response = post === null ? null : directionSign * post;
      const responseQ50 = responseQ50FromReferences(referenceResponses[crowdingSide], funding.timestamp);
      const referenceEligible = impulse !== null && price !== null && post !== null && response !== null;
      let rejectionReason: string | null = null;
      if (impulse === null) rejectionReason = "PRE_RETURN_8H_UNAVAILABLE";
      else if ((crowdingSide === "CROWDED_LONG" && impulse <= 0) || (crowdingSide === "CROWDED_SHORT" && impulse >= 0)) rejectionReason = "FUNDING_PRICE_DIRECTION_MISMATCH";
      else if (price === null) rejectionReason = "FUNDING_PRICE_UNAVAILABLE";
      else if (post === null || response === null) rejectionReason = "POST_FUNDING_30M_UNAVAILABLE";
      else if (responseQ50 === null) rejectionReason = "CONTINUATION_HISTORY_UNAVAILABLE";
      else if (response > responseQ50) rejectionReason = "CONTINUATION_NOT_FAILED";
      const event: V17SignalEvent = { symbol, fundingTimestamp: funding.timestamp, fundingRate: funding.fundingRate, crowdingSide, direction: crowdingSide === "CROWDED_LONG" ? -1 : 1, preReturn8h: impulse ?? Number.NaN, priceAtFunding: price ?? Number.NaN, decisionTime: fundingDecisionTime(funding.timestamp), postReturn30m: post ?? Number.NaN, continuationResponse: response ?? Number.NaN, responseQ50, referenceEligible, priceSource: "USD_M_FUTURES_15M_CLOSED_CLOSE", primaryEligible: rejectionReason === null, rejectionReason };
      events.push(event);
      if (referenceEligible) referenceResponses[crowdingSide].push({ timestamp: funding.timestamp, response: response as number });
    }
  }
  return events.sort((left, right) => left.fundingTimestamp - right.fundingTimestamp || left.symbol.localeCompare(right.symbol));
}

export function atrAt(candles: V17Candle[], entryIndex: number): number | null {
  if (entryIndex < V17_PARAMETERS.atrPeriod + 1) return null;
  const ranges: number[] = [];
  for (let index = entryIndex - V17_PARAMETERS.atrPeriod; index < entryIndex; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  const value = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function planAt(candles: V17Candle[], requestedTime: number, direction: 1 | -1): { candle: V17Candle; index: number; stop: number; takeProfit: number; riskPrice: number } | null {
  const index = lowerBound(candles, requestedTime, (bar) => bar.openTime);
  const candle = candles[index];
  const atr = atrAt(candles, index);
  if (!candle || atr === null) return null;
  const riskPrice = V17_PARAMETERS.stopAtr * atr;
  return { candle, index, riskPrice, stop: direction === 1 ? candle.open - riskPrice : candle.open + riskPrice, takeProfit: direction === 1 ? candle.open + V17_PARAMETERS.rewardRisk * riskPrice : candle.open - V17_PARAMETERS.rewardRisk * riskPrice };
}

function crossedBeforeEntry(candles: V17Candle[], plan: { index: number; stop: number; takeProfit: number; riskPrice: number; candle: V17Candle }, direction: 1 | -1, until: number): boolean {
  for (let index = plan.index; index < candles.length && candles[index].openTime < until; index += 1) {
    const candle = candles[index];
    if (direction === 1 ? candle.low <= plan.stop || candle.high >= plan.takeProfit : candle.high >= plan.stop || candle.low <= plan.takeProfit) return true;
  }
  return false;
}

function fundingCost(direction: 1 | -1, riskPrice: number, entryTime: number, exitTime: number, funding: V17FundingPoint[], marks: V17Candle[]): number | null {
  let result = 0;
  for (const point of funding) {
    if (point.timestamp <= entryTime || point.timestamp > exitTime) continue;
    const mark = markAt(marks, point.timestamp);
    if (mark === null) return null;
    result -= direction * point.fundingRate * mark / riskPrice;
  }
  return result;
}

function simulateTrade(event: V17SignalEvent, data: V17ParsedDatasets[V17Symbol], variant: SignalVariant, direction: 1 | -1, delayMinutes: 0 | 5 | 15 | 30): V17Trade | null {
  const theoretical = planAt(data.candles15m, event.decisionTime, direction);
  if (!theoretical) return null;
  const theoreticalEntryTime = theoretical.candle.openTime;
  const delayedRequestedTime = theoreticalEntryTime + delayMinutes * 60_000;
  if (delayMinutes > 0 && crossedBeforeEntry(data.candles15m, theoretical, direction, delayedRequestedTime)) return null;
  const plan = planAt(data.candles15m, delayedRequestedTime, direction);
  if (!plan) return null;
  const deadline = plan.candle.openTime + V17_PARAMETERS.maxHoldHours * 3_600_000;
  let exitPrice = plan.candle.close;
  let exitTime = Math.min(plan.candle.closeTime, deadline);
  let exitReason: V17Trade["exitReason"] = "TIME";
  for (let index = plan.index; index < data.candles15m.length && data.candles15m[index].openTime < deadline; index += 1) {
    const candle = data.candles15m[index];
    const stopHit = direction === 1 ? candle.low <= plan.stop : candle.high >= plan.stop;
    const takeProfitHit = direction === 1 ? candle.high >= plan.takeProfit : candle.low <= plan.takeProfit;
    if (stopHit) { exitPrice = plan.stop; exitTime = candle.openTime; exitReason = "STOP"; break; }
    if (takeProfitHit) { exitPrice = plan.takeProfit; exitTime = candle.openTime; exitReason = "TAKE_PROFIT"; break; }
    exitPrice = candle.close;
    exitTime = Math.min(candle.closeTime, deadline);
  }
  const fundingR = fundingCost(direction, plan.riskPrice, plan.candle.openTime, exitTime, data.funding, data.marks5m);
  if (fundingR === null) return { symbol: event.symbol, variant, crowdingSide: event.crowdingSide, direction, fundingTimestamp: event.fundingTimestamp, decisionTime: event.decisionTime, entryTime: plan.candle.openTime, exitTime, entryPrice: plan.candle.open, exitPrice, stopPrice: plan.stop, takeProfitPrice: plan.takeProfit, riskPrice: plan.riskPrice, exitReason: "DATA_UNAVAILABLE", grossR: 0, feesR: 0, slippageR: 0, fundingR: 0, netR: 0, netPnl: 0, stressNetR: { 5: 0, 10: 0, 20: 0 } };
  const grossR = direction * (exitPrice - plan.candle.open) / plan.riskPrice;
  const feesR = plan.candle.open * (V17_PARAMETERS.takerFeeBpsPerSide * 2) / 10_000 / plan.riskPrice;
  const slippageR = plan.candle.open * (V17_PARAMETERS.baseSlippageBpsPerSide * 2) / 10_000 / plan.riskPrice;
  const netR = grossR - feesR - slippageR + fundingR;
  const stressNetR = Object.fromEntries(V17_PARAMETERS.stressRoundTripBps.map((bps) => [bps, netR - plan.candle.open * bps / 10_000 / plan.riskPrice])) as Record<5 | 10 | 20, number>;
  return { symbol: event.symbol, variant, crowdingSide: event.crowdingSide, direction, fundingTimestamp: event.fundingTimestamp, decisionTime: event.decisionTime, entryTime: plan.candle.openTime, exitTime, entryPrice: plan.candle.open, exitPrice, stopPrice: plan.stop, takeProfitPrice: plan.takeProfit, riskPrice: plan.riskPrice, exitReason, grossR, feesR, slippageR, fundingR, netR, netPnl: netR * 100, stressNetR };
}

export function metricsFor(trades: V17Trade[]): V17Metrics {
  const wins = trades.filter((trade) => trade.netR > 0);
  const losses = trades.filter((trade) => trade.netR < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of trades.slice().sort((left, right) => left.exitTime - right.exitTime)) { equity += trade.netR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  const lossValues = losses.map((trade) => trade.netR).sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(lossValues.length * 0.05));
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netR, 0));
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length : 0, grossR: trades.reduce((sum, trade) => sum + trade.grossR, 0), feesR: trades.reduce((sum, trade) => sum + trade.feesR, 0), slippageR: trades.reduce((sum, trade) => sum + trade.slippageR, 0), fundingR: trades.reduce((sum, trade) => sum + trade.fundingR, 0), netR: trades.reduce((sum, trade) => sum + trade.netR, 0), netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0), avgR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0, maxDrawdownR, cvar95R: lossValues.length ? lossValues.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount : 0 };
}

function primaryEvents(events: V17SignalEvent[]): V17SignalEvent[] { return events.filter((event) => event.primaryEligible); }

export function runEngine(datasets: V17ParsedDatasets, variant: SignalVariant = "PRIMARY", delayMinutes: 0 | 5 | 15 | 30 = 0, startTime = Number.NEGATIVE_INFINITY, endTime = Number.POSITIVE_INFINITY): V17EngineResult {
  const events = buildSignalEvents(datasets).filter((event) => event.fundingTimestamp >= startTime && event.fundingTimestamp <= endTime);
  const rawTriggers = events.length;
  const selected = variant === "PRIMARY" || variant === "CONTINUATION_DIRECTION" ? primaryEvents(events) : events;
  const trades: V17Trade[] = [];
  let dataUnavailable = 0;
  for (const event of selected) {
    const data = datasets[event.symbol];
    const direction = variant === "CONTINUATION_DIRECTION" ? (event.direction === 1 ? -1 : 1) as 1 | -1 : event.direction;
    const trade = simulateTrade(event, data, variant, direction, delayMinutes);
    if (!trade) continue;
    if (trade.exitReason === "DATA_UNAVAILABLE") dataUnavailable += 1;
    else trades.push(trade);
  }
  return { signalsEvaluated: events.length, rawTriggers, rejectedSignals: events.filter((event) => !event.primaryEligible).length, dataUnavailable, events, trades, metrics: metricsFor(trades) };
}

export function runDelayMatrix(datasets: V17ParsedDatasets, startTime = Number.NEGATIVE_INFINITY, endTime = Number.POSITIVE_INFINITY): V17DelayResult[] {
  return ([0, 5, 15, 30] as const).map((delayMinutes) => {
    const result = runEngine(datasets, "PRIMARY", delayMinutes, startTime, endTime);
    const candidates = primaryEvents(result.events);
    return { delayMinutes, expiredBeforeEntry: Math.max(0, candidates.length - result.trades.length - result.dataUnavailable), trades: result.trades, metrics: result.metrics };
  });
}
