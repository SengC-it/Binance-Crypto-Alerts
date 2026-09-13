import type { Candle, FundingRatePoint } from "@/lib/core/types";
import type {
  Ipv1Candidate,
  Ipv1ExecutionModel,
  Ipv1ExecutionResult,
  Ipv1MarketDataProvider,
} from "./types";

const MINUTE_MS = 60 * 1000;

export function ceilToNextMinute(timestamp: number): number {
  if (!Number.isFinite(timestamp)) throw new Error("Invalid execution timestamp");
  return Math.ceil(timestamp / MINUTE_MS) * MINUTE_MS;
}

export async function simulateIpv1Execution(input: {
  candidate: Ipv1Candidate;
  decisionTime: number;
  asOfMs: number;
  executionModel: Ipv1ExecutionModel;
  provider: Ipv1MarketDataProvider;
}): Promise<Ipv1ExecutionResult> {
  const { candidate, decisionTime, asOfMs, executionModel, provider } = input;
  if (!Number.isFinite(decisionTime) || !Number.isFinite(asOfMs) || decisionTime >= asOfMs) {
    return invalid("INVALID_DECISION_WINDOW");
  }
  const validationError = validateCandidate(candidate, decisionTime, executionModel);
  if (validationError) return invalid(validationError);

  const rawExecutionTime = decisionTime + executionModel.humanDelaySeconds * 1000;
  const actualExecutionTimestamp = ceilToNextMinute(rawExecutionTime);
  if (actualExecutionTimestamp >= asOfMs) return invalid("ENTRY_AFTER_AS_OF");

  const endTime = Math.min(candidate.plan.validUntil, asOfMs);
  let candles: Candle[];
  try {
    candles = await provider.getMinuteCandles(candidate.symbol, actualExecutionTimestamp, endTime);
  } catch {
    return invalid("MARKET_CANDLE_QUERY_FAILED");
  }
  const normalizedCandles = validateCandles(candles, asOfMs);
  if (normalizedCandles === null || normalizedCandles.length === 0) return invalid("ENTRY_CANDLE_UNAVAILABLE");

  const entryCandle = normalizedCandles.find((candle) => candle.openTime >= actualExecutionTimestamp);
  if (!entryCandle) return invalid("ENTRY_CANDLE_UNAVAILABLE");
  const entryReferencePrice = entryCandle.open;
  if (!Number.isFinite(entryReferencePrice) || entryReferencePrice <= 0) return invalid("INVALID_ENTRY_REFERENCE");
  if (alreadyCrossedPlan(candidate, entryReferencePrice)) {
    return {
      status: "NOT_EXECUTABLE_AT_DECISION",
      opened: false,
      closed: false,
      dataInvalid: false,
      reason: "ENTRY_ALREADY_CROSSED_STOP_OR_TAKE_PROFIT",
      rawExecutionTime,
      actualEntryTimestamp: actualExecutionTimestamp,
      entryTime: entryCandle.openTime,
      entryReferencePrice,
    };
  }

  let exit: { candle: Candle; rawExitPrice: number; reason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_LIMIT" } | undefined;
  for (const candle of normalizedCandles.filter((value) => value.openTime >= entryCandle.openTime)) {
    const stopHit = candidate.candidate.side === "LONG"
      ? candle.low <= candidate.plan.stopPrice
      : candle.high >= candidate.plan.stopPrice;
    const takeProfitHit = candidate.candidate.side === "LONG"
      ? candle.high >= candidate.plan.takeProfitPrice
      : candle.low <= candidate.plan.takeProfitPrice;
    if (stopHit) {
      exit = { candle, rawExitPrice: candidate.plan.stopPrice, reason: "STOP_LOSS" };
      break;
    }
    if (takeProfitHit) {
      exit = { candle, rawExitPrice: candidate.plan.takeProfitPrice, reason: "TAKE_PROFIT" };
      break;
    }
    if (candle.closeTime >= candidate.plan.validUntil) {
      exit = { candle, rawExitPrice: candle.close, reason: "TIME_LIMIT" };
      break;
    }
  }

  if (!exit) {
    if (asOfMs >= candidate.plan.validUntil) return invalid("MISSING_CANDLE_THROUGH_VALID_UNTIL");
    return {
      status: "OPEN",
      opened: true,
      closed: false,
      dataInvalid: false,
      rawExecutionTime,
      actualEntryTimestamp: actualExecutionTimestamp,
      entryTime: entryCandle.openTime,
      entryReferencePrice,
      entryFillPrice: adverseFill(entryReferencePrice, candidate.candidate.side, executionModel.slippageBps, "entry"),
      theoreticalRiskUsdt: candidate.plan.theoreticalRiskUsdt,
    };
  }

  const entryFillPrice = adverseFill(entryReferencePrice, candidate.candidate.side, executionModel.slippageBps, "entry");
  const exitFillPrice = adverseFill(exit.rawExitPrice, candidate.candidate.side, executionModel.slippageBps, "exit");
  if (![entryFillPrice, exitFillPrice, exit.rawExitPrice, candidate.plan.quantity].every(Number.isFinite)) {
    return invalid("NONFINITE_EXECUTION_PRICE");
  }

  let fundingRates: FundingRatePoint[];
  try {
    fundingRates = await provider.getFundingRates(candidate.symbol, entryCandle.openTime, exit.candle.closeTime);
  } catch {
    return invalid("FUNDING_QUERY_FAILED");
  }
  if (!Array.isArray(fundingRates) || fundingRates.some((point) => !Number.isFinite(point.fundingTime) || !Number.isFinite(point.fundingRate))) {
    return invalid("INVALID_FUNDING_DATA");
  }

  const direction = candidate.candidate.side === "LONG" ? 1 : -1;
  const notional = Math.abs(entryFillPrice * candidate.plan.quantity);
  const grossPnlUsdt = (exitFillPrice - entryFillPrice) * direction * candidate.plan.quantity;
  const feesUsdt = (Math.abs(entryFillPrice * candidate.plan.quantity) + Math.abs(exitFillPrice * candidate.plan.quantity)) * executionModel.takerFeeRate;
  const fundingUsdt = fundingRates
    .filter((point) => point.fundingTime > entryCandle.openTime && point.fundingTime <= exit.candle.closeTime)
    .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
  const rawGrossPnlUsdt = (exit.rawExitPrice - entryReferencePrice) * direction * candidate.plan.quantity;
  const slippageUsdt = rawGrossPnlUsdt - grossPnlUsdt;
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  const rMultiple = candidate.plan.theoreticalRiskUsdt === 0
    ? 0
    : netPnlUsdt / candidate.plan.theoreticalRiskUsdt;
  const values = [notional, grossPnlUsdt, feesUsdt, fundingUsdt, slippageUsdt, netPnlUsdt, rMultiple];
  if (values.some((value) => !Number.isFinite(value))) return invalid("NONFINITE_PNL");

  return {
    status: "CLOSED",
    opened: true,
    closed: true,
    dataInvalid: false,
    rawExecutionTime,
    actualEntryTimestamp: actualExecutionTimestamp,
    entryTime: entryCandle.openTime,
    entryReferencePrice,
    entryFillPrice,
    exitTime: exit.candle.closeTime,
    rawExitPrice: exit.rawExitPrice,
    exitFillPrice,
    exitReason: exit.reason,
    grossPnlUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt,
    netPnlUsdt,
    rMultiple,
    theoreticalRiskUsdt: candidate.plan.theoreticalRiskUsdt,
  };
}

function validateCandidate(candidate: Ipv1Candidate, decisionTime: number, model: Ipv1ExecutionModel): string | null {
  const candidateValues = [
    candidate.sourceDataTimestamp,
    candidate.score,
    candidate.plan.entryPrice,
    candidate.plan.stopPrice,
    candidate.plan.takeProfitPrice,
    candidate.plan.quantity,
    candidate.plan.theoreticalRiskUsdt,
    candidate.plan.validUntil,
    model.humanDelaySeconds,
    model.slippageBps,
    model.takerFeeRate,
  ];
  if (!candidate.symbol || !candidate.candidate || !candidate.plan || candidateValues.some((value) => !Number.isFinite(value))) {
    return "INVALID_CANDIDATE_OR_PLAN";
  }
  if (candidate.plan.entryPrice <= 0 || candidate.plan.quantity <= 0 || candidate.plan.theoreticalRiskUsdt <= 0 || candidate.plan.validUntil <= decisionTime) {
    return "INVALID_CANDIDATE_OR_PLAN";
  }
  const correctPlanDirection = candidate.candidate.side === "LONG"
    ? candidate.plan.stopPrice < candidate.plan.entryPrice && candidate.plan.takeProfitPrice > candidate.plan.entryPrice
    : candidate.plan.stopPrice > candidate.plan.entryPrice && candidate.plan.takeProfitPrice < candidate.plan.entryPrice;
  if (!correctPlanDirection) return "INVALID_CANDIDATE_OR_PLAN";
  if (model.humanDelaySeconds < 0 || model.slippageBps < 0 || model.takerFeeRate < 0) return "INVALID_EXECUTION_MODEL";
  if (candidate.candidate.side !== "LONG" && candidate.candidate.side !== "SHORT") return "INVALID_SIDE";
  return null;
}

function validateCandles(candles: Candle[], asOfMs: number): Candle[] | null {
  if (!Array.isArray(candles)) return null;
  const ordered = [...candles].sort((left, right) => left.openTime - right.openTime);
  if (ordered.some((candle) => ![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.closeTime].every(Number.isFinite)
    || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0
    || candle.closeTime < candle.openTime || candle.closeTime > asOfMs
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)
    || candle.high < candle.low)) return null;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].openTime - ordered[index - 1].openTime !== MINUTE_MS) return null;
  }
  return ordered;
}

function alreadyCrossedPlan(candidate: Ipv1Candidate, entryReferencePrice: number): boolean {
  return candidate.candidate.side === "LONG"
    ? entryReferencePrice <= candidate.plan.stopPrice || entryReferencePrice >= candidate.plan.takeProfitPrice
    : entryReferencePrice >= candidate.plan.stopPrice || entryReferencePrice <= candidate.plan.takeProfitPrice;
}

function adverseFill(price: number, side: "LONG" | "SHORT", slippageBps: number, phase: "entry" | "exit"): number {
  const direction = side === "LONG" ? 1 : -1;
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageBps / 10_000);
}

function invalid(reason: string): Ipv1ExecutionResult {
  return { status: "DATA_INVALID", opened: false, closed: false, dataInvalid: true, reason };
}
