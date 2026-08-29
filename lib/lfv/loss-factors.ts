export const LFV_BASELINE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
export const LFV_LIVE_OBSERVATION_CUTOFF = Date.UTC(2026, 7, 1);
export const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

export const LFV_HYPOTHESES = {
  H1_SESSION: "SESSION_18_23_SGT_BLOCK",
  H2_HIGH_VOLATILITY: "HIGH_VOL_Q4_BLOCK",
  H3_ENTRY_DELAY: "DELAY_30M",
  H4_COOLDOWN: "STOP_COOLDOWN_12H",
} as const;

export const LFV_COMBINED_PRIMARY = [
  LFV_HYPOTHESES.H1_SESSION,
  LFV_HYPOTHESES.H2_HIGH_VOLATILITY,
  LFV_HYPOTHESES.H3_ENTRY_DELAY,
  LFV_HYPOTHESES.H4_COOLDOWN,
] as const;

export const LFV_SYSTEM_BOUNDARY = {
  mode: "SIGNAL + SMTP ONLY",
  privateBinanceApi: false,
  accountBalances: false,
  positions: false,
  orderPlacement: false,
  automaticEntry: false,
  automaticExit: false,
  autoTrading: false,
  liveSignalEmail: false,
} as const;

export interface LfvCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LfvSignal {
  id: string;
  symbol: string;
  strategyVersion: "rules-profit-oriented-v4" | "trend-rejection-short-v1";
  signalTime: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  score: number;
  theoreticalRiskUsdt: number;
}

export interface LfvSettledTrade extends LfvSignal {
  entryTime: number;
  exitTime: number;
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "MAX_HOLD" | "CANCELLED";
  rMultiple: number;
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  slippageUsdt: number;
}

export interface FundingObservation {
  calc_time: number;
  funding_interval_hours: number;
  last_funding_rate: number;
}

export interface DelayedEntry {
  status: "EXECUTED";
  entryTime: number;
  entryPrice: number;
  candle: LfvCandle;
}

export interface DelayedEntryUnavailable {
  status: "UNAVAILABLE";
  reason: "NO_LATER_COMPLETE_CANDLE";
}

export interface DelayedEntryExpired {
  status: "EXPIRED_BEFORE_ENTRY";
  reason: "STOP_TRIGGERED" | "TAKE_PROFIT_TRIGGERED";
  triggerTime: number;
}

export type DelayedEntryResolution = DelayedEntry | DelayedEntryUnavailable | DelayedEntryExpired;

export interface FactorDecision {
  sessionBlocked: boolean;
  highVolBlocked: boolean;
  delay: DelayedEntryResolution;
  cooldownBlocked: boolean;
  combinedBlocked: boolean;
}

export interface LfvMetrics {
  trades: number;
  wins: number;
  losses: number;
  netR: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownR: number;
  positiveFoldRatio: number;
  medianFoldNetR: number;
  plus5bpsNetR: number;
  plus10bpsNetR: number;
}

export interface ReplayParityRecord {
  side: string;
  strategyVersion: string;
  score: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
}

export interface ReplayParityComparison {
  matches: boolean;
  scoreDelta: number;
  entryRelativeError: number;
  stopRelativeError: number;
  takeProfitRelativeError: number;
}

export interface CostAttribution {
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  slippageUsdt: number;
  netPnlUsdt: number;
}

export function isSession18To23Sgt(timestamp: number): boolean {
  const sgtHour = new Date(timestamp + SGT_OFFSET_MS).getUTCHours();
  return sgtHour >= 18 && sgtHour <= 23;
}

export function trailingPITQuantile(valuesBeforeSignal: number[], quantile: number): number | null {
  if (valuesBeforeSignal.length === 0 || quantile < 0 || quantile > 1) return null;
  const sorted = valuesBeforeSignal.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function isHighVolatilityQ4(
  currentVolatility: number,
  valuesBeforeSignal: number[],
  minimumHistory = 20,
): boolean {
  if (!Number.isFinite(currentVolatility) || valuesBeforeSignal.length < minimumHistory) return false;
  const threshold = trailingPITQuantile(valuesBeforeSignal, 0.75);
  return threshold !== null && currentVolatility >= threshold;
}

export function resolveDelayedEntry(
  signal: LfvSignal,
  candles: LfvCandle[],
  delayMinutes: number,
): DelayedEntryResolution {
  const ordered = [...candles].sort((left, right) => left.openTime - right.openTime);
  const targetTime = signal.signalTime + delayMinutes * 60 * 1000;
  const entryCandle = ordered.find((candle) => candle.openTime > signal.signalTime && candle.openTime >= targetTime);
  if (!entryCandle) return { status: "UNAVAILABLE", reason: "NO_LATER_COMPLETE_CANDLE" };

  for (const candle of ordered) {
    if (candle.openTime <= signal.signalTime || candle.openTime >= entryCandle.openTime) continue;
    const stopHit = signal.side === "LONG"
      ? candle.low <= signal.stopPrice
      : candle.high >= signal.stopPrice;
    const takeProfitHit = signal.side === "LONG"
      ? candle.high >= signal.takeProfitPrice
      : candle.low <= signal.takeProfitPrice;
    if (stopHit) return { status: "EXPIRED_BEFORE_ENTRY", reason: "STOP_TRIGGERED", triggerTime: candle.openTime };
    if (takeProfitHit) return { status: "EXPIRED_BEFORE_ENTRY", reason: "TAKE_PROFIT_TRIGGERED", triggerTime: candle.openTime };
  }

  return {
    status: "EXECUTED",
    entryTime: entryCandle.openTime,
    entryPrice: entryCandle.open,
    candle: entryCandle,
  };
}

export function applySequentialCooldown<T extends {
  id: string;
  symbol: string;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
  rMultiple: number;
}>(trades: T[], cooldownHours: number): { kept: T[]; suppressed: T[] } {
  const ordered = [...trades].sort((left, right) => left.signalTime - right.signalTime || left.id.localeCompare(right.id));
  const openAccepted: T[] = [];
  const cooldownUntil = new Map<string, number>();
  const kept: T[] = [];
  const suppressed: T[] = [];
  const durationMs = Math.max(0, cooldownHours) * 60 * 60 * 1000;

  for (const trade of ordered) {
    for (let index = openAccepted.length - 1; index >= 0; index -= 1) {
      const prior = openAccepted[index];
      if (prior.exitTime > trade.signalTime) continue;
      openAccepted.splice(index, 1);
      if (prior.exitReason === "STOP_LOSS" || prior.rMultiple <= -0.75) {
        const until = prior.exitTime + durationMs;
        cooldownUntil.set(prior.symbol, Math.max(cooldownUntil.get(prior.symbol) ?? 0, until));
      }
    }

    if ((cooldownUntil.get(trade.symbol) ?? 0) > trade.signalTime) {
      suppressed.push(trade);
      continue;
    }
    kept.push(trade);
    openAccepted.push(trade);
  }

  return { kept, suppressed };
}

export function evaluateFactorDecision(input: {
  signal: LfvSignal;
  currentVolatility: number;
  volatilityHistoryBeforeSignal: number[];
  delayedEntry: DelayedEntryResolution;
  cooldownBlocked: boolean;
}): FactorDecision {
  const sessionBlocked = isSession18To23Sgt(input.signal.signalTime);
  const highVolBlocked = isHighVolatilityQ4(input.currentVolatility, input.volatilityHistoryBeforeSignal);
  const combinedBlocked = sessionBlocked
    || highVolBlocked
    || input.delayedEntry.status !== "EXECUTED"
    || input.cooldownBlocked;
  return {
    sessionBlocked,
    highVolBlocked,
    delay: input.delayedEntry,
    cooldownBlocked: input.cooldownBlocked,
    combinedBlocked,
  };
}

export function calculateActualFundingCost(
  notionalUsdt: number,
  side: "LONG" | "SHORT",
  observations: FundingObservation[],
  entryTime: number,
  exitTime: number,
): number {
  const applicable = observations.filter((observation) => (
    observation.calc_time >= entryTime
    && observation.calc_time <= exitTime
    && Number.isFinite(observation.last_funding_rate)
    && observation.funding_interval_hours > 0
  ));
  return applicable.reduce(
    (sum, observation) => sum + notionalUsdt * observation.last_funding_rate * (side === "LONG" ? 1 : -1),
    0,
  );
}

export function attributeTradeCosts(input: {
  grossPnlUsdt: number;
  notionalUsdt: number;
  fundingUsdt: number;
  slippageBpsPerSide?: number;
  feeBpsPerSide?: number;
}): CostAttribution {
  const feeBps = input.feeBpsPerSide ?? 4;
  const slippageBps = input.slippageBpsPerSide ?? 2;
  const feesUsdt = input.notionalUsdt * feeBps * 2 / 10_000;
  const slippageUsdt = input.notionalUsdt * slippageBps * 2 / 10_000;
  return {
    grossPnlUsdt: input.grossPnlUsdt,
    feesUsdt,
    fundingUsdt: input.fundingUsdt,
    slippageUsdt,
    netPnlUsdt: input.grossPnlUsdt - feesUsdt - input.fundingUsdt - slippageUsdt,
  };
}

export function summarizeLfvTrades(trades: Array<Pick<LfvSettledTrade, "rMultiple">>): LfvMetrics {
  const values = trades.map((trade) => trade.rMultiple);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const netR = values.reduce((sum, value) => sum + value, 0);
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    trades: values.length,
    wins: wins.length,
    losses: losses.length,
    netR,
    avgR: values.length === 0 ? 0 : netR / values.length,
    profitFactor: losses.length === 0
      ? (wins.length > 0 ? Number.POSITIVE_INFINITY : 0)
      : wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)),
    maxDrawdownR,
    positiveFoldRatio: 0,
    medianFoldNetR: median,
    plus5bpsNetR: netR,
    plus10bpsNetR: netR,
  };
}

export function compareReplayParity(
  expected: ReplayParityRecord,
  actual: ReplayParityRecord,
): ReplayParityComparison {
  const relativeError = (left: number, right: number) => Math.abs(left - right) / Math.max(Math.abs(left), 1e-12);
  const comparison = {
    matches: expected.side === actual.side
      && expected.strategyVersion === actual.strategyVersion
      && Math.abs(expected.score - actual.score) <= 0.5
      && relativeError(expected.entryPrice, actual.entryPrice) <= 0.0025
      && relativeError(expected.stopPrice, actual.stopPrice) <= 0.0025
      && relativeError(expected.takeProfitPrice, actual.takeProfitPrice) <= 0.0025,
    scoreDelta: Math.abs(expected.score - actual.score),
    entryRelativeError: relativeError(expected.entryPrice, actual.entryPrice),
    stopRelativeError: relativeError(expected.stopPrice, actual.stopPrice),
    takeProfitRelativeError: relativeError(expected.takeProfitPrice, actual.takeProfitPrice),
  };
  return comparison;
}

export function isLiveObservationOnly(signalTime: number): boolean {
  return signalTime >= LFV_LIVE_OBSERVATION_CUTOFF;
}

export function isWithinWindow(timestamp: number, start: number, end: number): boolean {
  return timestamp >= start && timestamp <= end;
}

export function passesCombinedProfitabilityGate(metrics: LfvMetrics, holdoutA: LfvMetrics, holdoutB: LfvMetrics, lcb: number): boolean {
  return metrics.trades >= 150
    && metrics.netR > 0
    && metrics.avgR >= 0.08
    && metrics.profitFactor >= 1.25
    && metrics.maxDrawdownR <= 8
    && metrics.positiveFoldRatio >= 0.67
    && metrics.medianFoldNetR > 0
    && metrics.plus5bpsNetR > 0
    && metrics.plus10bpsNetR > -Math.abs(metrics.netR)
    && lcb > 0
    && holdoutA.trades >= 40
    && holdoutA.netR > 0
    && holdoutA.profitFactor >= 1.2
    && holdoutA.maxDrawdownR <= 6
    && holdoutB.trades >= 25
    && holdoutB.netR > 0
    && holdoutB.profitFactor >= 1.2
    && holdoutB.maxDrawdownR <= 6;
}

export function matchedPlaceboSample<T>(values: T[], count: number, seed = 130001): T[] {
  const pool = [...values];
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}
