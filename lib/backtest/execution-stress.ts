import type { Candle, FundingRatePoint, Side } from "@/lib/core/types";

export type ExecutionDelay = "T0" | "T+1m" | "T+5m" | "T+15m";

export interface ExecutionDelayStressResult {
  delay: ExecutionDelay;
  delayMinutes: number;
  entryPrice: number | null;
  exitPrice?: number | null;
  exitReason?: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END";
  entryTimestamp?: number | null;
  exitTimestamp?: number | null;
  netPnlUsdt?: number | null;
  netR?: number | null;
  fundingUsdt?: number;
  proxy: boolean;
  note: string;
}

export interface DelayedReferenceTradeInput {
  side: Side;
  sourceTimestamp: number;
  referenceEntryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  quantity: number;
  theoreticalRiskUsdt: number;
  maxHoldHours: number;
  takerFeeRate: number;
  slippageBps: number;
  fundingRates?: FundingRatePoint[];
}

export interface SlippageStressResult {
  slippageBps: number;
  netPnlUsdt: number;
  netR: number;
}

const DELAYS: Record<ExecutionDelay, number> = {
  T0: 0,
  "T+1m": 1,
  "T+5m": 5,
  "T+15m": 15,
};

/**
 * Legacy entry-price-only view. It is retained for diagnostics and tests, but
 * it must not be used as the promotion metric. Use
 * simulateDelayedReferenceTrade for path re-simulation.
 */
export function evaluateExecutionDelay(
  candles: Candle[],
  sourceTimestamp: number,
  referencePrice: number,
  delay: ExecutionDelay,
): ExecutionDelayStressResult {
  const delayMinutes = DELAYS[delay];
  if (delayMinutes === 0) {
    return {
      delay,
      delayMinutes,
      entryPrice: referencePrice,
      proxy: false,
      note: "entry-price sensitivity only; signal close reference",
    };
  }
  const target = sourceTimestamp + delayMinutes * 60_000;
  const nextCandle = candles.find((candle) => candle.closeTime >= target);
  if (!nextCandle) {
    return { delay, delayMinutes, entryPrice: null, proxy: delay !== "T+15m", note: "insufficient future candles" };
  }
  const exact = nextCandle.closeTime === target;
  return {
    delay,
    delayMinutes,
    entryPrice: nextCandle.close,
    proxy: !exact,
    note: exact ? "entry-price sensitivity only; closed-candle reference" : "entry-price sensitivity only; 15m candle proxy",
  };
}

/**
 * Re-simulate the trade from the delayed entry candle through the original
 * stop/TP path. OHLC ambiguity is handled stop-first, matching the backtest
 * engine. T+1m and T+5m are explicitly labelled proxies when only 15m data is
 * available; T+15m is exact for a closed 15m series.
 */
export function simulateDelayedReferenceTrade(
  candles: Candle[],
  input: DelayedReferenceTradeInput,
  delay: ExecutionDelay,
): ExecutionDelayStressResult {
  const delayMinutes = DELAYS[delay];
  const target = input.sourceTimestamp + delayMinutes * 60_000;
  const entryIndex = candles.findIndex((candle) => candle.closeTime >= target);
  const entryCandle = entryIndex < 0 ? undefined : candles[entryIndex];
  const proxy = Boolean(entryCandle && delayMinutes > 0 && entryCandle.closeTime !== target);
  const entryPrice = delay === "T0" ? input.referenceEntryPrice : entryCandle?.close ?? null;
  if (entryPrice === null || entryCandle === undefined) {
    return {
      delay,
      delayMinutes,
      entryPrice,
      exitPrice: null,
      netPnlUsdt: null,
      netR: null,
      proxy,
      note: "insufficient future candles for delayed path",
    };
  }

  const entryTimestamp = delay === "T0" ? input.sourceTimestamp : entryCandle.closeTime;
  const deadline = entryTimestamp + Math.max(0, input.maxHoldHours) * 3_600_000;
  let exitCandle: Candle | undefined;
  let exitPrice: number | undefined;
  let exitReason: ExecutionDelayStressResult["exitReason"];

  for (let index = entryIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > deadline) break;
    const stopHit = input.side === "LONG" ? candle.low <= input.stopPrice : candle.high >= input.stopPrice;
    const takeProfitHit = input.side === "LONG"
      ? candle.high >= input.takeProfitPrice
      : candle.low <= input.takeProfitPrice;
    exitCandle = candle;
    if (stopHit) {
      exitPrice = input.stopPrice;
      exitReason = "STOP";
      break;
    }
    if (takeProfitHit) {
      exitPrice = input.takeProfitPrice;
      exitReason = "TAKE_PROFIT";
      break;
    }
  }

  if (exitCandle && exitPrice === undefined) {
    exitPrice = exitCandle.close;
    exitReason = exitCandle.closeTime >= deadline ? "TIME_LIMIT" : "DATA_END";
  }

  if (!exitCandle) {
    const lastIndex = lastIndexAtOrBefore(candles, deadline);
    if (lastIndex <= entryIndex) {
      return {
        delay,
        delayMinutes,
        entryPrice,
        exitPrice: null,
        entryTimestamp,
        exitTimestamp: null,
        netPnlUsdt: null,
        netR: null,
        proxy,
        note: "no closed candle after delayed entry",
      };
    }
    exitCandle = candles[lastIndex];
    exitPrice = exitCandle.close;
    exitReason = exitCandle.closeTime >= deadline ? "TIME_LIMIT" : "DATA_END";
  }

  const direction = input.side === "LONG" ? 1 : -1;
  const slippageRate = input.slippageBps / 10_000;
  const entryFill = adverseFill(entryPrice, direction, slippageRate, "entry");
  const exitFill = adverseFill(exitPrice as number, direction, slippageRate, "exit");
  const grossPnlUsdt = (exitFill - entryFill) * direction * input.quantity;
  const feesUsdt = (Math.abs(entryFill * input.quantity) + Math.abs(exitFill * input.quantity)) * input.takerFeeRate;
  const fundingUsdt = (input.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTimestamp && point.fundingTime <= exitCandle.closeTime)
    .reduce((total, point) => total - direction * entryFill * input.quantity * point.fundingRate, 0);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    delay,
    delayMinutes,
    entryPrice,
    exitPrice,
    exitReason,
    entryTimestamp,
    exitTimestamp: exitCandle.closeTime,
    netPnlUsdt,
    netR: input.theoreticalRiskUsdt > 0 ? netPnlUsdt / input.theoreticalRiskUsdt : 0,
    fundingUsdt,
    proxy,
    note: proxy ? "true path re-simulation; 15m candle proxy" : "true closed-candle path re-simulation",
  };
}

export function calculateSlippageStress(
  side: Side,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  theoreticalRiskUsdt: number,
  takerFeeRate: number,
  slippageBps: number,
): SlippageStressResult {
  const direction = side === "LONG" ? 1 : -1;
  const slip = slippageBps / 10_000;
  const entryFill = entryPrice * (1 + direction * slip);
  const exitFill = exitPrice * (1 - direction * slip);
  const gross = (exitFill - entryFill) * direction * quantity;
  const fees = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * takerFeeRate;
  const netPnlUsdt = gross - fees;
  return {
    slippageBps,
    netPnlUsdt,
    netR: theoreticalRiskUsdt > 0 ? netPnlUsdt / theoreticalRiskUsdt : 0,
  };
}

export function allExecutionDelays(): ExecutionDelay[] {
  return ["T0", "T+1m", "T+5m", "T+15m"];
}

function adverseFill(price: number, direction: number, slippageRate: number, phase: "entry" | "exit"): number {
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageRate);
}

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}
