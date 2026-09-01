export interface V15Bar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  takerBuyQuoteVolume: number;
}

export interface V15FeatureSnapshot {
  decisionTime: number;
  symbol: string;
  direction: 1 | -1;
  spotReturn30: number;
  perpReturn30: number;
  spotFlow30: number;
  perpFlow30: number;
  spotQuoteVolume30: number;
  perpQuoteVolume30: number;
  spotTakerBuyQuote30: number;
  perpTakerBuyQuote30: number;
  spotShock: number;
  leadStrength: number;
  spotDirectionalFlow: number;
  perpDirectionalFlow: number;
}

export interface V15Thresholds {
  spotShockQ90: number;
  absoluteSpotFlowQ75: number;
  positiveLeadStrengthQ80: number;
}

export interface V15TradePlan {
  direction: 1 | -1;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  riskPrice: number;
  maxHoldMs: number;
}

export interface V15ReturnObservation {
  netR: number;
  netPnl: number;
  grossR: number;
  feesR: number;
  slippageR: number;
  fundingR: number;
  entryTime: number;
  exitTime: number;
  symbol: string;
  direction: 1 | -1;
}

export const V15_CONSTANTS = {
  decisionIntervalMs: 15 * 60_000,
  featureWindowMs: 30 * 60_000,
  quantileLookbackMs: 60 * 24 * 60 * 60_000,
  minimumAgeMs: 90 * 24 * 60 * 60_000,
  atrMultiple: 1.5,
  takeProfitR: 2,
  maxHoldMs: 4 * 60 * 60_000,
  takerFeeBpsPerSide: 4,
  baseSlippageBpsPerSide: 2,
  liquidityParticipationLimit: 0.0001,
} as const;

/** Binance Spot switched from millisecond to microsecond archive timestamps in 2025. */
export function normalizeBinanceTimestamp(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(numeric) || numeric < 0) return Number.NaN;
  if (numeric >= 1_000_000_000_000_000) return numeric / 1_000;
  if (numeric >= 1_000_000_000_000) return numeric;
  if (numeric >= 1_000_000_000) return numeric * 1_000;
  return numeric * 1_000;
}

export function isClosedBefore(bar: V15Bar, decisionTime: number): boolean {
  return Number.isFinite(bar.closeTime) && bar.closeTime < decisionTime;
}

export function latestClosedBars(bars: V15Bar[], decisionTime: number, count: number): V15Bar[] {
  return bars.filter((bar) => isClosedBefore(bar, decisionTime)).slice(-count);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function requireWindow(bars: V15Bar[], decisionTime: number): V15Bar[] {
  const window = latestClosedBars(bars, decisionTime, 6);
  if (window.length !== 6 || window.some((bar, index) => index > 0 && bar.openTime - window[index - 1].openTime !== 5 * 60_000)) {
    throw new Error("V15 requires six consecutive closed 5m bars");
  }
  return window;
}

export function buildFeatureSnapshot(
  symbol: string,
  decisionTime: number,
  spotBars: V15Bar[],
  perpBars: V15Bar[],
): V15FeatureSnapshot {
  const spot = requireWindow(spotBars, decisionTime);
  const perp = requireWindow(perpBars, decisionTime);
  if (spot[0].open <= 0 || perp[0].open <= 0 || spot.at(-1)!.close <= 0 || perp.at(-1)!.close <= 0) {
    throw new Error("V15 feature window contains a non-positive price");
  }
  const spotQuoteVolume30 = sum(spot.map((bar) => bar.quoteVolume));
  const perpQuoteVolume30 = sum(perp.map((bar) => bar.quoteVolume));
  const spotTakerBuyQuote30 = sum(spot.map((bar) => bar.takerBuyQuoteVolume));
  const perpTakerBuyQuote30 = sum(perp.map((bar) => bar.takerBuyQuoteVolume));
  if (spotQuoteVolume30 <= 0 || perpQuoteVolume30 <= 0) throw new Error("V15 feature window has zero quote volume");
  const spotReturn30 = spot.at(-1)!.close / spot[0].open - 1;
  const perpReturn30 = perp.at(-1)!.close / perp[0].open - 1;
  const direction: 1 | -1 = spotReturn30 >= 0 ? 1 : -1;
  const spotFlow30 = 2 * spotTakerBuyQuote30 / spotQuoteVolume30 - 1;
  const perpFlow30 = 2 * perpTakerBuyQuote30 / perpQuoteVolume30 - 1;
  const spotShock = Math.abs(spotReturn30);
  const leadStrength = direction * (spotReturn30 - perpReturn30);
  return {
    decisionTime,
    symbol,
    direction,
    spotReturn30,
    perpReturn30,
    spotFlow30,
    perpFlow30,
    spotQuoteVolume30,
    perpQuoteVolume30,
    spotTakerBuyQuote30,
    perpTakerBuyQuote30,
    spotShock,
    leadStrength,
    spotDirectionalFlow: direction * spotFlow30,
    perpDirectionalFlow: direction * perpFlow30,
  };
}

export function quantile(values: number[], probability: number): number {
  if (!values.length || probability < 0 || probability > 1) return Number.NaN;
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function buildPitThresholds(history: V15FeatureSnapshot[]): V15Thresholds {
  const positiveLeadStrength = history.map((item) => item.leadStrength).filter((value) => value > 0);
  return {
    spotShockQ90: quantile(history.map((item) => item.spotShock), 0.9),
    absoluteSpotFlowQ75: quantile(history.map((item) => Math.abs(item.spotFlow30)), 0.75),
    positiveLeadStrengthQ80: quantile(positiveLeadStrength, 0.8),
  };
}

export function qualifiesPrimarySignal(feature: V15FeatureSnapshot, thresholds: V15Thresholds): boolean {
  return feature.spotShock >= thresholds.spotShockQ90
    && feature.spotDirectionalFlow > 0
    && Math.abs(feature.spotFlow30) >= thresholds.absoluteSpotFlowQ75
    && feature.leadStrength > 0
    && feature.leadStrength >= thresholds.positiveLeadStrengthQ80
    && feature.spotDirectionalFlow > feature.perpDirectionalFlow;
}

export function nextExecutableOpen(bars: V15Bar[], signalTime: number): V15Bar | null {
  return bars.find((bar) => bar.openTime >= signalTime && Number.isFinite(bar.open) && bar.open > 0) ?? null;
}

export function buildTradePlan(direction: 1 | -1, entryBar: V15Bar, atr15m: number): V15TradePlan {
  if (!Number.isFinite(atr15m) || atr15m <= 0 || !Number.isFinite(entryBar.open) || entryBar.open <= 0) {
    throw new Error("V15 trade plan requires a positive entry and ATR");
  }
  const riskPrice = V15_CONSTANTS.atrMultiple * atr15m;
  const stopPrice = entryBar.open - direction * riskPrice;
  const takeProfitPrice = entryBar.open + direction * riskPrice * V15_CONSTANTS.takeProfitR;
  return { direction, entryTime: entryBar.openTime, entryPrice: entryBar.open, stopPrice, takeProfitPrice, riskPrice, maxHoldMs: V15_CONSTANTS.maxHoldMs };
}

export function simulateAdverseBracket(plan: V15TradePlan, bars: V15Bar[]): { exitTime: number; exitPrice: number; reason: "STOP" | "TAKE_PROFIT" | "TIME" } {
  const endTime = plan.entryTime + plan.maxHoldMs;
  for (const bar of bars.filter((item) => item.openTime >= plan.entryTime && item.openTime <= endTime)) {
    if (plan.direction === 1) {
      if (bar.low <= plan.stopPrice) return { exitTime: bar.openTime, exitPrice: plan.stopPrice, reason: "STOP" };
      if (bar.high >= plan.takeProfitPrice) return { exitTime: bar.openTime, exitPrice: plan.takeProfitPrice, reason: "TAKE_PROFIT" };
    } else {
      if (bar.high >= plan.stopPrice) return { exitTime: bar.openTime, exitPrice: plan.stopPrice, reason: "STOP" };
      if (bar.low <= plan.takeProfitPrice) return { exitTime: bar.openTime, exitPrice: plan.takeProfitPrice, reason: "TAKE_PROFIT" };
    }
  }
  const finalBar = bars.filter((item) => item.openTime >= plan.entryTime && item.openTime <= endTime).at(-1);
  if (!finalBar) throw new Error("V15 max-hold window has no executable bar");
  return { exitTime: finalBar.closeTime, exitPrice: finalBar.close, reason: "TIME" };
}

export function netReturnFromGross(grossR: number, fundingR: number, adverseRoundTripBps: number): number {
  const feeR = 2 * V15_CONSTANTS.takerFeeBpsPerSide / 10_000;
  const slippageR = 2 * V15_CONSTANTS.baseSlippageBpsPerSide / 10_000;
  const stressR = adverseRoundTripBps / 10_000;
  return grossR + fundingR - feeR - slippageR - stressR;
}

export function passesCapacity(legNotional: number, spotAdv30: number, perpAdv30: number): boolean {
  return legNotional > 0 && spotAdv30 > 0 && perpAdv30 > 0
    && legNotional / spotAdv30 <= V15_CONSTANTS.liquidityParticipationLimit
    && legNotional / perpAdv30 <= V15_CONSTANTS.liquidityParticipationLimit;
}

export function manualEntryTime(signalTime: number, delayMinutes: number): number {
  return signalTime + delayMinutes * 60_000;
}

export function blockBootstrapLcb(values: number[], blockSize = 5, repetitions = 2_000, seed = 15): { estimate: number; lower95: number; upper95: number } {
  if (!values.length) return { estimate: Number.NaN, lower95: Number.NaN, upper95: Number.NaN };
  const estimate = sum(values) / values.length;
  const blocks: number[][] = [];
  for (let index = 0; index < values.length; index += blockSize) blocks.push(values.slice(index, index + blockSize));
  let state = seed >>> 0;
  const samples: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const draw: number[] = [];
    while (draw.length < values.length) {
      state = (1664525 * state + 1013904223) >>> 0;
      draw.push(...blocks[state % blocks.length]);
    }
    samples.push(sum(draw.slice(0, values.length)) / values.length);
  }
  samples.sort((left, right) => left - right);
  return { estimate, lower95: samples[Math.floor(samples.length * 0.025)], upper95: samples[Math.floor(samples.length * 0.975)] };
}
