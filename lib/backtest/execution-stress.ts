import type { Candle, Side } from "@/lib/core/types";

export type ExecutionDelay = "T0" | "T+1m" | "T+5m" | "T+15m";

export interface ExecutionDelayStressResult {
  delay: ExecutionDelay;
  delayMinutes: number;
  entryPrice: number | null;
  proxy: boolean;
  note: string;
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

export function evaluateExecutionDelay(
  candles: Candle[],
  sourceTimestamp: number,
  referencePrice: number,
  delay: ExecutionDelay,
): ExecutionDelayStressResult {
  const delayMinutes = DELAYS[delay];
  if (delayMinutes === 0) return { delay, delayMinutes, entryPrice: referencePrice, proxy: false, note: "signal close reference" };
  const target = sourceTimestamp + delayMinutes * 60_000;
  const nextCandle = candles.find((candle) => candle.closeTime >= target);
  if (!nextCandle) return { delay, delayMinutes, entryPrice: null, proxy: true, note: "insufficient future candles" };
  const exact = nextCandle.closeTime === target || delay === "T+15m";
  return {
    delay,
    delayMinutes,
    entryPrice: nextCandle.close,
    proxy: !exact,
    note: exact ? "closed-candle reference" : "15m candle proxy; fine-grained data unavailable",
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
