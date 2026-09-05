import {
  V19_BASELINE_ROUND_TRIP_BPS,
  V19_INTERVAL_MS,
  V19_PIT_WINDOW_MS,
  V19_SLIPPAGE_BPS_PER_SIDE,
  V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS,
  V19_TAKER_FEE_BPS_PER_SIDE,
  V19_UNDERREACTION_QUANTILE,
} from "./constants";
import { directionalUnderreaction, fitOls, logReturn, nearestRankQuantile, type V19Bar } from "./features";

export interface V19CompactSeries {
  symbol: string;
  openTimes: Float64Array;
  opens: Float64Array;
  closes: Float64Array;
  tradeCounts: Float64Array;
}

export interface V19OutcomeIdentity {
  btcShockTimestamp: string;
  signalTimestamp: string;
  signalOpenTime: number;
  follower: string;
  side: "LONG" | "SHORT";
  nextExecutionOpenTime: number;
  executionReferencePrice: number;
  primaryExitCloseTime: number;
  evaluationWindow: string;
  controlName?: string;
}

export type V19NetField = "baselineNetReturn" | "stress5NetReturn" | "stress10NetReturn" | "stress20NetReturn";

export interface V19Outcome {
  identity: V19OutcomeIdentity;
  status: "SETTLED" | "OUTCOME_DATA_UNAVAILABLE";
  unavailableReason?: string;
  entryPrice?: number;
  exitPrice?: number;
  grossReturn?: number;
  feeCost?: number;
  slippageCost?: number;
  baselineNetReturn?: number;
  stress5NetReturn?: number;
  stress10NetReturn?: number;
  stress20NetReturn?: number;
}

export interface V19MetricSet {
  trades: number;
  distinctClusters: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossReturn: number;
  feeCost: number;
  slippageCost: number;
  netReturn: number;
  averageNetReturn: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  cvar95: number | null;
}

export interface V19BootstrapSummary {
  clusters: number;
  samples: number;
  seed: number;
  mean: number | null;
  ci95: [number, number] | null;
  lcb95: number | null;
}

export function compactSeries(symbol: string, bars: readonly V19Bar[]): V19CompactSeries {
  return {
    symbol,
    openTimes: Float64Array.from(bars, (bar) => bar.openTime),
    opens: Float64Array.from(bars, (bar) => bar.open),
    closes: Float64Array.from(bars, (bar) => bar.close),
    tradeCounts: Float64Array.from(bars, (bar) => bar.tradeCount),
  };
}

export function findExactIndex(openTimes: ArrayLike<number>, timestamp: number): number {
  let left = 0;
  let right = openTimes.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (openTimes[middle] === timestamp) return middle;
    if (openTimes[middle] < timestamp) left = middle + 1;
    else right = middle - 1;
  }
  return -1;
}

export function settleV19Identity(
  identity: V19OutcomeIdentity,
  seriesBySymbol: ReadonlyMap<string, V19CompactSeries>,
): V19Outcome {
  const unavailable = (reason: string): V19Outcome => ({ identity, status: "OUTCOME_DATA_UNAVAILABLE", unavailableReason: reason });
  const series = seriesBySymbol.get(identity.follower);
  if (!series) return unavailable("FOLLOWER_SERIES_UNAVAILABLE");
  const entryIndex = findExactIndex(series.openTimes, identity.nextExecutionOpenTime);
  const exitOpenTime = identity.primaryExitCloseTime - V19_INTERVAL_MS + 1;
  const exitIndex = findExactIndex(series.openTimes, exitOpenTime);
  if (entryIndex < 0 || exitIndex < 0) return unavailable("EXACT_ENTRY_OR_EXIT_MISSING");
  if (series.openTimes[entryIndex] !== identity.nextExecutionOpenTime || series.openTimes[exitIndex] + V19_INTERVAL_MS - 1 !== identity.primaryExitCloseTime) {
    return unavailable("EXACT_ENTRY_OR_EXIT_TIMESTAMP_MISMATCH");
  }
  const entryPrice = series.opens[entryIndex];
  const exitPrice = series.closes[exitIndex];
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return unavailable("INVALID_EXECUTION_PRICE");
  }
  if (entryPrice !== identity.executionReferencePrice) return unavailable("FROZEN_ENTRY_REFERENCE_MISMATCH");
  const grossReturn = identity.side === "LONG" ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1;
  if (!Number.isFinite(grossReturn)) return unavailable("NON_FINITE_GROSS_RETURN");
  const feeCost = 2 * V19_TAKER_FEE_BPS_PER_SIDE / 10_000;
  const slippageCost = 2 * V19_SLIPPAGE_BPS_PER_SIDE / 10_000;
  const baselineNetReturn = grossReturn - V19_BASELINE_ROUND_TRIP_BPS / 10_000;
  return {
    identity,
    status: "SETTLED",
    entryPrice,
    exitPrice,
    grossReturn,
    feeCost,
    slippageCost,
    baselineNetReturn,
    stress5NetReturn: baselineNetReturn - V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS[0] / 10_000,
    stress10NetReturn: baselineNetReturn - V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS[1] / 10_000,
    stress20NetReturn: baselineNetReturn - V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS[2] / 10_000,
  };
}

export function summarizeOutcomes(outcomes: readonly V19Outcome[], field: V19NetField = "baselineNetReturn"): V19MetricSet {
  const rows = outcomes
    .filter((outcome) => outcome.status === "SETTLED" && Number.isFinite(outcome[field]))
    .map((outcome) => ({
      cluster: outcome.identity.btcShockTimestamp,
      signalOpenTime: outcome.identity.signalOpenTime,
      gross: outcome.grossReturn ?? 0,
      fee: outcome.feeCost ?? 0,
      slippage: outcome.slippageCost ?? 0,
      net: outcome[field] as number,
    }));
  return summarizeRows(rows);
}

export function summarizeClusters(outcomes: readonly V19Outcome[], field: V19NetField = "baselineNetReturn"): V19MetricSet {
  const settled = outcomes.filter((outcome) => outcome.status === "SETTLED" && Number.isFinite(outcome[field]));
  const grouped = new Map<string, V19Outcome[]>();
  for (const outcome of settled) {
    const cluster = grouped.get(outcome.identity.btcShockTimestamp) ?? [];
    cluster.push(outcome);
    grouped.set(outcome.identity.btcShockTimestamp, cluster);
  }
  const rows = [...grouped.entries()].map(([cluster, clusterOutcomes]) => ({
    cluster,
    signalOpenTime: Math.min(...clusterOutcomes.map((outcome) => outcome.identity.signalOpenTime)),
    gross: average(clusterOutcomes.map((outcome) => outcome.grossReturn ?? 0)),
    fee: average(clusterOutcomes.map((outcome) => outcome.feeCost ?? 0)),
    slippage: average(clusterOutcomes.map((outcome) => outcome.slippageCost ?? 0)),
    net: average(clusterOutcomes.map((outcome) => outcome[field] as number)),
  }));
  return summarizeRows(rows);
}

export function bootstrapClusterMean(
  outcomes: readonly V19Outcome[],
  field: V19NetField = "baselineNetReturn",
  samples = 10_000,
  seed = 19_019,
): V19BootstrapSummary {
  const grouped = new Map<string, { time: number; values: number[] }>();
  for (const outcome of outcomes) {
    const value = outcome.status === "SETTLED" ? outcome[field] : undefined;
    if (!Number.isFinite(value)) continue;
    const existing = grouped.get(outcome.identity.btcShockTimestamp) ?? { time: outcome.identity.signalOpenTime, values: [] };
    existing.values.push(value as number);
    grouped.set(outcome.identity.btcShockTimestamp, existing);
  }
  const clusterValues = [...grouped.values()]
    .sort((left, right) => left.time - right.time)
    .map((cluster) => average(cluster.values));
  if (clusterValues.length === 0) return { clusters: 0, samples, seed, mean: null, ci95: null, lcb95: null };
  const random = mulberry32(seed);
  const bootstrapMeans = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < clusterValues.length; draw += 1) total += clusterValues[Math.floor(random() * clusterValues.length)];
    bootstrapMeans[sample] = total / clusterValues.length;
  }
  bootstrapMeans.sort((left, right) => left - right);
  const lowerIndex = Math.floor(0.025 * (bootstrapMeans.length - 1));
  const upperIndex = Math.ceil(0.975 * (bootstrapMeans.length - 1));
  return {
    clusters: clusterValues.length,
    samples,
    seed,
    mean: average(clusterValues),
    ci95: [bootstrapMeans[lowerIndex], bootstrapMeans[upperIndex]],
    lcb95: bootstrapMeans[lowerIndex],
  };
}

export function evaluateFollowerFeatureAt(
  leader: V19CompactSeries,
  follower: V19CompactSeries,
  signalOpenTime: number,
  priorMedianTradeCount: number,
): { beta: number; directionalUnderreaction: number; underreactionQ90: number } | null {
  const leaderSignalIndex = findExactIndex(leader.openTimes, signalOpenTime);
  const followerSignalIndex = findExactIndex(follower.openTimes, signalOpenTime);
  const priorStart = signalOpenTime - V19_PIT_WINDOW_MS;
  const leaderPriorStart = findExactIndex(leader.openTimes, priorStart);
  const followerPriorStart = findExactIndex(follower.openTimes, priorStart);
  const count = Math.floor(V19_PIT_WINDOW_MS / V19_INTERVAL_MS);
  if (leaderSignalIndex < 1 || followerSignalIndex < 1 || leaderPriorStart < 1 || followerPriorStart < 1 || !Number.isFinite(priorMedianTradeCount)) return null;
  const btcReturns = new Float64Array(count);
  const followerReturns = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const expectedOpenTime = priorStart + index * V19_INTERVAL_MS;
    const leaderIndex = leaderPriorStart + index;
    const followerIndex = followerPriorStart + index;
    if (leader.openTimes[leaderIndex] !== expectedOpenTime || follower.openTimes[followerIndex] !== expectedOpenTime) return null;
    const btcReturn = logReturn(leader.closes[leaderIndex], leader.closes[leaderIndex - 1]);
    const followerReturn = logReturn(follower.closes[followerIndex], follower.closes[followerIndex - 1]);
    if (btcReturn === null || followerReturn === null) return null;
    btcReturns[index] = btcReturn;
    followerReturns[index] = followerReturn;
  }
  const fit = fitOls(followerReturns, btcReturns);
  const currentBtcReturn = logReturn(leader.closes[leaderSignalIndex], leader.closes[leaderSignalIndex - 1]);
  const currentFollowerReturn = logReturn(follower.closes[followerSignalIndex], follower.closes[followerSignalIndex - 1]);
  if (!fit || currentBtcReturn === null || currentFollowerReturn === null) return null;
  const currentResidual = currentFollowerReturn - (fit.alpha + fit.beta * currentBtcReturn);
  const priorUnderreaction = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const residual = followerReturns[index] - (fit.alpha + fit.beta * btcReturns[index]);
    priorUnderreaction[index] = directionalUnderreaction(btcReturns[index], residual);
  }
  const underreactionQ90 = nearestRankQuantile(priorUnderreaction, V19_UNDERREACTION_QUANTILE);
  if (underreactionQ90 === null) return null;
  return {
    beta: fit.beta,
    directionalUnderreaction: directionalUnderreaction(currentBtcReturn, currentResidual),
    underreactionQ90,
  };
}

export function rollingMedianTradeCounts(series: V19CompactSeries, windowBars: number): Float64Array {
  const result = new Float64Array(series.openTimes.length);
  result.fill(Number.NaN);
  for (let index = windowBars; index < series.openTimes.length; index += 1) {
    const values = Array.from(series.tradeCounts.slice(index - windowBars, index));
    values.sort((left, right) => left - right);
    result[index] = values.length % 2 === 0
      ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
      : values[Math.floor(values.length / 2)];
  }
  return result;
}

function summarizeRows(rows: readonly { cluster: string; signalOpenTime: number; gross: number; fee: number; slippage: number; net: number }[]): V19MetricSet {
  const ordered = [...rows].sort((left, right) => left.signalOpenTime - right.signalOpenTime);
  const netValues = ordered.map((row) => row.net);
  const positive = netValues.filter((value) => value > 0);
  const negative = netValues.filter((value) => value < 0);
  return {
    trades: ordered.length,
    distinctClusters: new Set(ordered.map((row) => row.cluster)).size,
    wins: positive.length,
    losses: negative.length,
    winRate: ordered.length === 0 ? null : positive.length / ordered.length,
    grossReturn: ordered.reduce((total, row) => total + row.gross, 0),
    feeCost: ordered.reduce((total, row) => total + row.fee, 0),
    slippageCost: ordered.reduce((total, row) => total + row.slippage, 0),
    netReturn: netValues.reduce((total, value) => total + value, 0),
    averageNetReturn: ordered.length === 0 ? null : netValues.reduce((total, value) => total + value, 0) / ordered.length,
    profitFactor: negative.length === 0 ? (positive.length > 0 ? null : null) : positive.reduce((total, value) => total + value, 0) / Math.abs(negative.reduce((total, value) => total + value, 0)),
    maxDrawdown: maxDrawdown(netValues),
    cvar95: netValues.length === 0 ? null : average([...netValues].sort((left, right) => left - right).slice(0, Math.max(1, Math.ceil(netValues.length * 0.05)))),
  };
}

function maxDrawdown(values: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
