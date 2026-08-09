import Decimal from "decimal.js";
import type { Instrument, RiskPolicy, ScoredCandidate, Side, TradePlan } from "./types";

export function buildTradePlan(
  candidate: ScoredCandidate,
  instrument: Instrument,
  policy: RiskPolicy,
  sourceTimestamp: number,
): TradePlan {
  const entryPrice = roundToStep(candidate.entryPrice, instrument.priceTick, "nearest");
  const rawStop = candidate.stopReferencePrice;
  const stopPrice = roundToStep(
    rawStop,
    instrument.priceTick,
    candidate.side === "LONG" ? "down" : "up",
  );
  const riskDistance = Math.abs(entryPrice - stopPrice);

  const stopOnCorrectSide = candidate.side === "LONG"
    ? stopPrice < entryPrice
    : stopPrice > entryPrice;
  if (riskDistance <= 0 || !stopOnCorrectSide) {
    throw new Error(`Invalid stop distance or direction for ${instrument.symbol}`);
  }

  const positionNotionalUsdt = new Decimal(policy.marginUsdt).mul(policy.leverage);
  const rawQuantity = positionNotionalUsdt.div(entryPrice);
  const quantity = roundQuantity(rawQuantity.toNumber(), instrument.quantityStep);
  if (quantity <= 0) throw new Error(`Quantity rounds to zero for ${instrument.symbol}`);
  if (instrument.minQuantity !== undefined && quantity < instrument.minQuantity) {
    throw new Error(`Quantity is below Binance minimum for ${instrument.symbol}`);
  }

  const theoreticalRiskUsdt = new Decimal(quantity).mul(riskDistance).toNumber();
  const takeProfitUnrounded =
    candidate.side === "LONG"
      ? entryPrice + riskDistance * 2
      : entryPrice - riskDistance * 2;
  const takeProfitPrice = roundToStep(
    takeProfitUnrounded,
    instrument.priceTick,
    candidate.side === "LONG" ? "down" : "up",
  );
  const takeProfitOnCorrectSide = candidate.side === "LONG"
    ? takeProfitPrice > entryPrice
    : takeProfitPrice < entryPrice;
  if (!takeProfitOnCorrectSide) {
    throw new Error(`Invalid take-profit direction for ${instrument.symbol}`);
  }

  return {
    entryPrice,
    stopPrice,
    takeProfitPrice,
    rewardRisk: 2,
    assumedMarginUsdt: policy.marginUsdt,
    assumedLeverage: policy.leverage,
    positionNotionalUsdt: positionNotionalUsdt.toNumber(),
    quantity,
    theoreticalRiskUsdt,
    riskOverSingleCap: theoreticalRiskUsdt > policy.singleSignalRiskCapUsdt,
    validUntil: sourceTimestamp + policy.maxHoldHours * 60 * 60 * 1000,
  };
}

export function roundToStep(value: number, step: number, mode: "down" | "up" | "nearest"): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    throw new Error("Price and quantity steps must be finite positive numbers");
  }

  const decimalValue = new Decimal(value);
  const decimalStep = new Decimal(step);
  const quotient = decimalValue.div(decimalStep);
  const rounding = mode === "down" ? Decimal.ROUND_FLOOR : mode === "up" ? Decimal.ROUND_CEIL : Decimal.ROUND_HALF_UP;
  return quotient.toDecimalPlaces(0, rounding).mul(decimalStep).toNumber();
}

function roundQuantity(value: number, step: number): number {
  return roundToStep(value, step, "down");
}

export function sideLabel(side: Side): string {
  return side === "LONG" ? "做多" : "做空";
}
