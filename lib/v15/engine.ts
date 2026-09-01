import {
  V15_CONSTANTS,
  blockBootstrapLcb,
  buildFeatureSnapshot,
  buildPitThresholds,
  buildTradePlan,
  nextExecutableOpen,
  passesCapacity,
  qualifiesPrimarySignal,
  simulateAdverseBracket,
  type V15Bar,
  type V15FeatureSnapshot,
  type V15ReturnObservation,
} from "@/lib/v15/lead-lag";
import { calculateV15Cost } from "@/lib/v15/cost";

export interface V15FundingPoint {
  timestamp: number;
  fundingRate: number;
  markPrice: number;
}

export interface V15PairDataset {
  symbol: string;
  spotBars: V15Bar[];
  futuresBars: V15Bar[];
  funding: V15FundingPoint[];
  eligible: boolean;
}

export interface V15EngineOptions {
  startTime: number;
  endTime: number;
  referenceCapitalUsdt: number;
}

export interface V15TradeRecord extends V15ReturnObservation {
  decisionTime: number;
  direction: 1 | -1;
  grossPnl: number;
  entryPrice: number;
  exitPrice: number;
  riskPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  exitReason: "STOP" | "TAKE_PROFIT" | "TIME";
  spotShock: number;
  leadStrength: number;
  spotFlow30: number;
  perpFlow30: number;
  stressNetR: Record<5 | 10 | 20, number>;
}

export interface V15MetricSet {
  trades: number;
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
  winRate: number;
}

export interface V15DelayOutcome {
  delayMinutes: 5 | 15 | 30;
  expiredBeforeEntry: number;
  trades: V15TradeRecord[];
  metrics: V15MetricSet;
}

export interface V15EngineResult {
  signalsEvaluated: number;
  rawTriggers: number;
  rejectedSignals: number;
  trades: V15TradeRecord[];
  featureSnapshots: V15FeatureSnapshot[];
  metrics: V15MetricSet;
  delayOutcomes: V15DelayOutcome[];
  confidence: ReturnType<typeof blockBootstrapLcb>;
}

interface Aggregate15mBar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
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

function lastClosedIndex(bars: V15Bar[], decisionTime: number): number {
  let left = 0;
  let right = bars.length - 1;
  let answer = -1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (bars[middle].closeTime < decisionTime) {
      answer = middle;
      left = middle + 1;
    } else right = middle - 1;
  }
  return answer;
}

function featureAt(dataset: V15PairDataset, decisionTime: number): V15FeatureSnapshot | null {
  const spotIndex = lastClosedIndex(dataset.spotBars, decisionTime);
  const futuresIndex = lastClosedIndex(dataset.futuresBars, decisionTime);
  if (spotIndex < 5 || futuresIndex < 5) return null;
  try {
    return buildFeatureSnapshot(
      dataset.symbol,
      decisionTime,
      dataset.spotBars.slice(spotIndex - 5, spotIndex + 1),
      dataset.futuresBars.slice(futuresIndex - 5, futuresIndex + 1),
    );
  } catch {
    return null;
  }
}

function quoteVolumeBefore(bars: V15Bar[], timestamp: number, lookbackMs: number): { value: number; observedBars: number } {
  const cutoff = timestamp - lookbackMs;
  let value = 0;
  let observedBars = 0;
  for (const bar of bars) {
    if (bar.closeTime >= timestamp) break;
    if (bar.closeTime >= cutoff) {
      value += bar.quoteVolume;
      observedBars += 1;
    }
  }
  return { value, observedBars };
}

function aggregate15m(bars: V15Bar[]): Aggregate15mBar[] {
  const buckets = new Map<number, Aggregate15mBar>();
  for (const bar of bars) {
    const openTime = Math.floor(bar.openTime / V15_CONSTANTS.decisionIntervalMs) * V15_CONSTANTS.decisionIntervalMs;
    const current = buckets.get(openTime);
    if (!current) {
      buckets.set(openTime, { openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, count: 1 });
    } else {
      current.closeTime = Math.max(current.closeTime, bar.closeTime);
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.count += 1;
    }
  }
  return [...buckets.values()].filter((bar) => bar.count === 3).sort((left, right) => left.openTime - right.openTime);
}

function atr15mAt(bars: V15Bar[], entryTime: number): number | null {
  const completed = aggregate15m(bars).filter((bar) => bar.closeTime < entryTime);
  if (completed.length < 15) return null;
  const window = completed.slice(-15);
  const trueRanges: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const current = window[index];
    const previous = window[index - 1];
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  if (trueRanges.length < 14) return null;
  const value = trueRanges.slice(-14).reduce((sum, item) => sum + item, 0) / 14;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function fundingR(riskPrice: number, direction: 1 | -1, entryTime: number, exitTime: number, funding: V15FundingPoint[]): number {
  if (!Number.isFinite(riskPrice) || riskPrice <= 0) return Number.NaN;
  const points = funding.filter((point) => point.timestamp > entryTime && point.timestamp <= exitTime);
  if (points.some((point) => !Number.isFinite(point.markPrice) || point.markPrice <= 0)) return Number.NaN;
  return points
    .reduce((sum, point) => {
      return sum - direction * point.fundingRate * point.markPrice / riskPrice;
    }, 0);
}

function grossR(direction: 1 | -1, entryPrice: number, exitPrice: number, riskPrice: number): number {
  return direction * (exitPrice - entryPrice) / riskPrice;
}

function firstBracketExitBefore(plan: ReturnType<typeof buildTradePlan>, bars: V15Bar[], beforeTime: number): boolean {
  return bars.some((bar) => bar.openTime >= plan.entryTime && bar.openTime < beforeTime && (
    plan.direction === 1
      ? bar.low <= plan.stopPrice || bar.high >= plan.takeProfitPrice
      : bar.high >= plan.stopPrice || bar.low <= plan.takeProfitPrice
  ));
}

function nextOpenAtOrAfter(bars: V15Bar[], timestamp: number): V15Bar | null {
  const aligned = Math.ceil(timestamp / (5 * 60_000)) * (5 * 60_000);
  return nextExecutableOpen(bars, aligned);
}

function metricSet(trades: Array<Pick<V15TradeRecord, "grossR" | "feesR" | "slippageR" | "fundingR" | "netR" | "netPnl">>): V15MetricSet {
  const grossRValue = trades.reduce((sum, trade) => sum + trade.grossR, 0);
  const feesR = trades.reduce((sum, trade) => sum + trade.feesR, 0);
  const slippageR = trades.reduce((sum, trade) => sum + trade.slippageR, 0);
  const fundingRValue = trades.reduce((sum, trade) => sum + trade.fundingR, 0);
  const netR = trades.reduce((sum, trade) => sum + trade.netR, 0);
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const wins = trades.filter((trade) => trade.netR > 0).map((trade) => trade.netR);
  const losses = trades.filter((trade) => trade.netR < 0).map((trade) => trade.netR);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of trades) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const sortedLosses = losses.slice().sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(Math.max(sortedLosses.length, 1) * 0.05));
  const cvar95R = sortedLosses.length ? sortedLosses.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount : 0;
  const grossWins = wins.reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    trades: trades.length,
    grossR: grossRValue,
    feesR,
    slippageR,
    fundingR: fundingRValue,
    netR,
    netPnl,
    avgR: trades.length ? netR / trades.length : 0,
    profitFactor: grossLosses ? grossWins / grossLosses : (grossWins ? Number.POSITIVE_INFINITY : 0),
    maxDrawdownR,
    cvar95R,
    winRate: trades.length ? wins.length / trades.length : 0,
  };
}

function buildTrade(dataset: V15PairDataset, feature: V15FeatureSnapshot, decisionTime: number, entryBar: V15Bar, atr: number, options: V15EngineOptions): V15TradeRecord | null {
  const plan = buildTradePlan(feature.direction, entryBar, atr);
  const exit = simulateAdverseBracket(plan, dataset.futuresBars);
  const funding = fundingR(plan.riskPrice, plan.direction, plan.entryTime, exit.exitTime, dataset.funding);
  if (!Number.isFinite(funding)) return null;
  const gross = grossR(plan.direction, plan.entryPrice, exit.exitPrice, plan.riskPrice);
  const cost = calculateV15Cost(plan.entryPrice, plan.riskPrice, gross, funding);
  const fees = cost.feesR;
  const slippage = cost.slippageR;
  const baseNet = cost.netR;
  const notional = options.referenceCapitalUsdt;
  const stressNet = (stressBps: 5 | 10 | 20): number => calculateV15Cost(plan.entryPrice, plan.riskPrice, gross, funding, stressBps).netR;
  return {
    symbol: dataset.symbol,
    direction: plan.direction,
    decisionTime,
    entryTime: plan.entryTime,
    exitTime: exit.exitTime,
    entryPrice: plan.entryPrice,
    exitPrice: exit.exitPrice,
    riskPrice: plan.riskPrice,
    stopPrice: plan.stopPrice,
    takeProfitPrice: plan.takeProfitPrice,
    grossPnl: gross * notional * plan.riskPrice / plan.entryPrice,
    grossR: gross,
    feesR: fees,
    slippageR: slippage,
    fundingR: funding,
    netR: baseNet,
    netPnl: baseNet * notional * plan.riskPrice / plan.entryPrice,
    stressNetR: { 5: stressNet(5), 10: stressNet(10), 20: stressNet(20) },
    exitReason: exit.reason,
    spotShock: feature.spotShock,
    leadStrength: feature.leadStrength,
    spotFlow30: feature.spotFlow30,
    perpFlow30: feature.perpFlow30,
  };
}

function delayedTrades(dataset: V15PairDataset, primaryTrades: V15TradeRecord[], delayMinutes: 5 | 15 | 30, options: V15EngineOptions): { trades: V15TradeRecord[]; expired: number } {
  const trades: V15TradeRecord[] = [];
  let expired = 0;
  for (const primary of primaryTrades) {
    const zeroEntry = nextExecutableOpen(dataset.futuresBars, primary.decisionTime);
    if (!zeroEntry) {
      expired += 1;
      continue;
    }
    const zeroPlan = buildTradePlan(primary.direction, zeroEntry, primary.riskPrice / V15_CONSTANTS.atrMultiple);
    const delayedAt = primary.decisionTime + delayMinutes * 60_000;
    if (firstBracketExitBefore(zeroPlan, dataset.futuresBars, delayedAt)) {
      expired += 1;
      continue;
    }
    const delayedEntry = nextOpenAtOrAfter(dataset.futuresBars, delayedAt);
    if (!delayedEntry) {
      expired += 1;
      continue;
    }
    const atr = primary.riskPrice / V15_CONSTANTS.atrMultiple;
    const trade = buildTrade(dataset, { decisionTime: primary.decisionTime, symbol: primary.symbol, direction: primary.direction, spotReturn30: 0, perpReturn30: 0, spotFlow30: primary.spotFlow30, perpFlow30: primary.perpFlow30, spotQuoteVolume30: 1, perpQuoteVolume30: 1, spotTakerBuyQuote30: 1, perpTakerBuyQuote30: 1, spotShock: primary.spotShock, leadStrength: primary.leadStrength, spotDirectionalFlow: primary.direction * primary.spotFlow30, perpDirectionalFlow: primary.direction * primary.perpFlow30 }, primary.decisionTime, delayedEntry, atr, options);
    if (trade) trades.push(trade);
  }
  return { trades, expired };
}

export function runFrozenV15(datasets: V15PairDataset[], options: V15EngineOptions): V15EngineResult {
  const allTrades: V15TradeRecord[] = [];
  const snapshots: V15FeatureSnapshot[] = [];
  let signalsEvaluated = 0;
  let rawTriggers = 0;
  let rejectedSignals = 0;
  const delayTrades: Record<5 | 15 | 30, V15TradeRecord[]> = { 5: [], 15: [], 30: [] };
  const delayExpired: Record<5 | 15 | 30, number> = { 5: 0, 15: 0, 30: 0 };
  for (const dataset of datasets.filter((item) => item.eligible)) {
    const spotBars = dataset.spotBars.slice().sort((left, right) => left.openTime - right.openTime);
    const futuresBars = dataset.futuresBars.slice().sort((left, right) => left.openTime - right.openTime);
    const normalizedDataset = { ...dataset, spotBars, futuresBars };
    const history: V15FeatureSnapshot[] = [];
    let lastExitTime = -Infinity;
    for (let decisionTime = options.startTime; decisionTime <= options.endTime; decisionTime += V15_CONSTANTS.decisionIntervalMs) {
      signalsEvaluated += 1;
      const feature = featureAt(normalizedDataset, decisionTime);
      if (!feature) {
        rejectedSignals += 1;
        continue;
      }
      snapshots.push(feature);
      const cutoff = decisionTime - V15_CONSTANTS.quantileLookbackMs;
      while (history.length && history[0].decisionTime < cutoff) history.shift();
      const thresholds = buildPitThresholds(history);
      const primary = history.length > 0 && qualifiesPrimarySignal(feature, thresholds);
      if (!primary) {
        rejectedSignals += 1;
        history.push(feature);
        continue;
      }
      rawTriggers += 1;
      const spotAdv = quoteVolumeBefore(spotBars, decisionTime, 30 * 24 * 60 * 60_000);
      const futuresAdv = quoteVolumeBefore(futuresBars, decisionTime, 30 * 24 * 60 * 60_000);
      if (!passesCapacity(options.referenceCapitalUsdt, spotAdv.value / 30, futuresAdv.value / 30)) {
        rejectedSignals += 1;
        history.push(feature);
        continue;
      }
      const entry = nextExecutableOpen(futuresBars, decisionTime);
      const atr = entry ? atr15mAt(futuresBars, entry.openTime) : null;
      if (!entry || !atr || entry.openTime <= lastExitTime) {
        rejectedSignals += 1;
        history.push(feature);
        continue;
      }
      const trade = buildTrade(normalizedDataset, feature, decisionTime, entry, atr, options);
      if (!trade) {
        rejectedSignals += 1;
        history.push(feature);
        continue;
      }
      allTrades.push(trade);
      lastExitTime = trade.exitTime;
      history.push(feature);
    }
    for (const delay of [5, 15, 30] as const) {
      const delayed = delayedTrades(normalizedDataset, allTrades.filter((trade) => trade.symbol === dataset.symbol), delay, options);
      delayTrades[delay].push(...delayed.trades);
      delayExpired[delay] += delayed.expired;
    }
  }
  return {
    signalsEvaluated,
    rawTriggers,
    rejectedSignals,
    trades: allTrades,
    featureSnapshots: snapshots,
    metrics: metricSet(allTrades),
    delayOutcomes: ([5, 15, 30] as const).map((delayMinutes) => ({ delayMinutes, expiredBeforeEntry: delayExpired[delayMinutes], trades: delayTrades[delayMinutes], metrics: metricSet(delayTrades[delayMinutes]) })),
    confidence: blockBootstrapLcb(allTrades.map((trade) => trade.netR)),
  };
}

export function metricsAtStress(trades: V15TradeRecord[], stressBps: 0 | 5 | 10 | 20): V15MetricSet {
  if (stressBps === 0) return metricSet(trades);
  return metricSet(trades.map((trade) => {
    const stressed = trade.stressNetR[stressBps];
    return { ...trade, netR: stressed, netPnl: stressed * (trade.netPnl / trade.netR || 0) };
  }));
}

export function metricsForHorizon(trades: V15TradeRecord[], horizonMs: number): V15MetricSet {
  return metricSet(trades.filter((trade) => trade.exitTime - trade.entryTime <= horizonMs));
}

export function metricsForSymbols(trades: V15TradeRecord[]): Record<string, V15MetricSet> {
  const symbols = [...new Set(trades.map((trade) => trade.symbol))].sort();
  return Object.fromEntries(symbols.map((symbol) => [symbol, metricSet(trades.filter((trade) => trade.symbol === symbol))]));
}

export function confidenceForTrades(trades: V15TradeRecord[]): ReturnType<typeof blockBootstrapLcb> {
  return blockBootstrapLcb(trades.map((trade) => trade.netR));
}
