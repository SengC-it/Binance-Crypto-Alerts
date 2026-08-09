import { buildTradePlan } from "@/lib/core/risk";
import { rankCandidates } from "@/lib/core/scoring";
import { generateCandidates, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, FundingRatePoint, MarketSnapshot, TradePlan } from "@/lib/core/types";
import type { BacktestMetrics, BacktestResult, BacktestTrade, HistoricalDataset } from "./types";

const DEFAULT_TAKER_FEE_RATE = 0.0004;
const DEFAULT_SLIPPAGE_BPS = 2;

export interface BacktestOptions {
  initialCapitalUsdt?: number;
  minScore?: number;
  maxHoldHours?: number;
  minimumSampleDays?: number;
  singleSignalRiskCapUsdt?: number;
  marginUsdt?: number;
  leverage?: number;
  takerFeeRate?: number;
  slippageBps?: number;
  evaluationStartTime?: number;
}

export function runBacktest(
  dataset: HistoricalDataset,
  params: StrategyParams,
  options: BacktestOptions = {},
): BacktestResult {
  const initialCapitalUsdt = options.initialCapitalUsdt ?? 10_000;
  const maxHoldHours = options.maxHoldHours ?? 72;
  const minScore = options.minScore ?? 0;
  const minimumSampleDays = options.minimumSampleDays ?? 365;
  const riskCap = options.singleSignalRiskCapUsdt ?? 100;
  const marginUsdt = options.marginUsdt ?? 100;
  const leverage = options.leverage ?? 20;
  const takerFeeRate = options.takerFeeRate ?? DEFAULT_TAKER_FEE_RATE;
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const candles = dataset.candles["15m"];
  const evaluationStartTime = options.evaluationStartTime ?? candlesStart(candles);
  const trades: BacktestTrade[] = [];
  let equity = initialCapitalUsdt;
  let peakEquity = equity;
  let maxDrawdownUsdt = 0;
  let index = Math.max(params.emaSlow + 5, 80, lowerBound(candles, evaluationStartTime));

  while (index < candles.length - 1) {
    const current = candles[index];
    const snapshot = snapshotAt(dataset, index);
    const candidate = rankCandidates(generateCandidates(snapshot, params))[0];

    if (!candidate || candidate.score < minScore) {
      index += 1;
      continue;
    }

    let plan: TradePlan;
    try {
      plan = buildTradePlan(candidate, dataset.instrument, {
        marginUsdt,
        leverage,
        singleSignalRiskCapUsdt: riskCap,
        dailyRiskBudgetUsdt: 600,
        maxHoldHours,
      }, current.closeTime);
    } catch {
      index += 1;
      continue;
    }

    const trade = evaluateTrade(dataset, index, candidate, plan, {
      maxHoldHours,
      takerFeeRate,
      slippageBps,
    });
    trades.push(trade);
    equity += trade.pnlUsdt;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peakEquity - equity);
    index = findIndexAtOrAfter(candles, trade.exitTime) + 1;
  }

  const metrics = summarizeMetrics(dataset, trades, {
    initialCapitalUsdt,
    minimumSampleDays,
    finalEquityUsdt: equity,
    maxDrawdownUsdt,
    evaluationStartTime,
  });
  return { params, metrics, trades };
}

function snapshotAt(dataset: HistoricalDataset, index: number): MarketSnapshot {
  const primary = dataset.candles["15m"];
  const sourceTimestamp = primary[index].closeTime;
  const asOf = (candles: Candle[] | undefined) => {
    if (!candles || candles.length === 0) return [];
    const end = upperBound(candles, sourceTimestamp);
    return candles.slice(Math.max(0, end - 250), end);
  };

  return {
    instrument: dataset.instrument,
    tickerPrice: primary[index].close,
    candles: {
      "15m": asOf(primary),
      "1h": asOf(dataset.candles["1h"]),
      "4h": asOf(dataset.candles["4h"]),
    },
    sourceTimestamp,
  };
}

function evaluateTrade(
  dataset: HistoricalDataset,
  entryIndex: number,
  candidate: ReturnType<typeof rankCandidates>[number],
  plan: TradePlan,
  options: {
    maxHoldHours: number;
    takerFeeRate: number;
    slippageBps: number;
  },
): BacktestTrade {
  const candles = dataset.candles["15m"];
  const entry = candles[entryIndex];
  const deadline = entry.closeTime + options.maxHoldHours * 60 * 60 * 1000;

  for (let index = entryIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.openTime > deadline) break;

    const stopHit = candidate.side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const takeProfitHit = candidate.side === "LONG"
      ? candle.high >= plan.takeProfitPrice
      : candle.low <= plan.takeProfitPrice;

    // OHLC data does not reveal the intrabar path; stop-first is conservative.
    if (stopHit) {
      return tradeResult(dataset, candidate, plan, entry, candle, plan.stopPrice, "STOP", options);
    }
    if (takeProfitHit) {
      return tradeResult(dataset, candidate, plan, entry, candle, plan.takeProfitPrice, "TAKE_PROFIT", options);
    }
  }

  const lastIndex = Math.min(
    candles.length - 1,
    Math.max(entryIndex + 1, findIndexAtOrAfter(candles, deadline)),
  );
  const exit = candles[lastIndex];
  const reason = exit.closeTime >= deadline ? "TIME_LIMIT" : "DATA_END";
  return tradeResult(dataset, candidate, plan, entry, exit, exit.close, reason, options);
}

function tradeResult(
  dataset: HistoricalDataset,
  candidate: ReturnType<typeof rankCandidates>[number],
  plan: TradePlan,
  entry: Candle,
  exit: Candle,
  rawExitPrice: number,
  exitReason: BacktestTrade["exitReason"],
  options: {
    takerFeeRate: number;
    slippageBps: number;
  },
): BacktestTrade {
  const direction = candidate.side === "LONG" ? 1 : -1;
  const slippageRate = options.slippageBps / 10_000;
  const entryFillPrice = adverseFill(entry.close, direction, slippageRate, "entry");
  const exitFillPrice = adverseFill(rawExitPrice, direction, slippageRate, "exit");
  const quantity = plan.quantity;
  const grossPnlUsdt = (exitFillPrice - entryFillPrice) * direction * quantity;
  const feesUsdt = (Math.abs(entryFillPrice * quantity) + Math.abs(exitFillPrice * quantity)) * options.takerFeeRate;
  const fundingUsdt = calculateFunding(
    dataset.fundingRates ?? [],
    entry.closeTime,
    exit.closeTime,
    entryFillPrice * quantity,
    direction,
  );
  const rawGrossPnlUsdt = (rawExitPrice - entry.close) * direction * quantity;
  const slippageUsdt = Math.max(0, rawGrossPnlUsdt - grossPnlUsdt);
  const pnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  const rMultiple = plan.theoreticalRiskUsdt === 0 ? 0 : pnlUsdt / plan.theoreticalRiskUsdt;

  return {
    symbol: dataset.symbol,
    side: candidate.side,
    strategyFamily: candidate.strategyFamily,
    entryTime: entry.closeTime,
    exitTime: exit.closeTime,
    score: candidate.score,
    entryPrice: entryFillPrice,
    exitPrice: exitFillPrice,
    rMultiple,
    pnlUsdt,
    grossPnlUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt,
    theoreticalRiskUsdt: plan.theoreticalRiskUsdt,
    exitReason,
  };
}

function adverseFill(
  price: number,
  direction: number,
  slippageRate: number,
  phase: "entry" | "exit",
): number {
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageRate);
}

function calculateFunding(
  fundingRates: FundingRatePoint[],
  entryTime: number,
  exitTime: number,
  notionalUsdt: number,
  direction: number,
): number {
  return fundingRates
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notionalUsdt * point.fundingRate, 0);
}

function summarizeMetrics(
  dataset: HistoricalDataset,
  trades: BacktestTrade[],
  input: {
    initialCapitalUsdt: number;
    minimumSampleDays: number;
    finalEquityUsdt: number;
    maxDrawdownUsdt: number;
    evaluationStartTime?: number;
  },
): BacktestMetrics {
  const first = input.evaluationStartTime ?? dataset.candles["15m"][0]?.openTime ?? 0;
  const last = dataset.candles["15m"].at(-1)?.closeTime ?? first;
  const sampleDays = Math.max(0, (last - first) / 86_400_000);
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = trades.filter((trade) => trade.pnlUsdt > 0).reduce((total, trade) => total + trade.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(trades.filter((trade) => trade.pnlUsdt < 0).reduce((total, trade) => total + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((total, trade) => total + trade.pnlUsdt, 0);
  const maxDrawdownPercent = input.initialCapitalUsdt === 0 ? 0 : input.maxDrawdownUsdt / input.initialCapitalUsdt * 100;

  return {
    sampleDays: round(sampleDays, 2),
    minimumSampleDays: input.minimumSampleDays,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : round(wins / trades.length * 100, 2),
    netR: round(trades.reduce((total, trade) => total + trade.rMultiple, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    grossProfitUsdt: round(grossProfitUsdt, 4),
    grossLossUsdt: round(grossLossUsdt, 4),
    totalFeesUsdt: round(trades.reduce((total, trade) => total + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((total, trade) => total + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((total, trade) => total + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownPercent: round(maxDrawdownPercent, 4),
    maxDrawdownUsdt: round(input.maxDrawdownUsdt, 4),
    finalEquityUsdt: round(input.finalEquityUsdt, 4),
    initialCapitalUsdt: input.initialCapitalUsdt,
    eligible: sampleDays >= input.minimumSampleDays && maxDrawdownPercent <= 30,
  };
}

function upperBound(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= closeTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBound(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime < closeTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function candlesStart(candles: Candle[]): number {
  return candles[0]?.openTime ?? 0;
}

function findIndexAtOrAfter(candles: HistoricalDataset["candles"]["15m"], timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime < timestamp) low = middle + 1;
    else high = middle;
  }
  return low >= candles.length ? candles.length - 1 : low;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
