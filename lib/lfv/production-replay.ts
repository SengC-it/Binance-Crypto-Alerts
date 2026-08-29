import type { ProductionSignalPolicy } from "../core/production-signal";
import { buildProductionOpportunity } from "../core/production-signal";
import type { Candle, FundingRatePoint, MarketSnapshot, TradePlan } from "../core/types";

export interface ReplaySignal {
  symbol: string;
  strategyVersion: string;
  signalTimestamp: number;
  snapshot: MarketSnapshot;
  plan: TradePlan;
  score: number;
  side: "LONG" | "SHORT";
}

export type ReplayBlockReason = "PORTFOLIO_BLOCKED" | "REJECTED_LOWER_SCORE" | "COOLDOWN_BLOCKED";

export interface ReplayDecision {
  signal: ReplaySignal;
  status: "ACCEPTED" | ReplayBlockReason;
  replacedSignalTimestamp?: number;
}

export interface ReplayTrade extends ReplaySignal {
  entryTime: number;
  entryPrice: number;
  entryFillPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  maxHoldUntil: number;
  quantity: number;
  theoreticalRiskUsdt: number;
}

export interface SettledReplayTrade extends ReplayTrade {
  exitTime: number;
  exitPrice: number;
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "MAX_HOLD" | "CANCELLED";
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  slippageUsdt: number;
  netPnlUsdt: number;
  rMultiple: number;
}

export interface ReplaySettlementOptions {
  takerFeeRate: number;
  slippageBps: number;
  fundingBySymbol?: Map<string, FundingRatePoint[]>;
}

export interface ProductionReplayResult {
  decisions: ReplayDecision[];
  accepted: ReplayTrade[];
  blocked: Array<{ signal: ReplaySignal; reason: ReplayBlockReason }>;
  settlements: SettledReplayTrade[];
}

export interface ProductionReplayInput {
  snapshots: MarketSnapshot[];
  strategyVersion: string;
  policy: ProductionSignalPolicy;
  maxConcurrentPositions?: number;
  cooldownHours?: number;
  settlement?: ReplaySettlementOptions;
  /**
   * Future candles are deliberately kept outside MarketSnapshot. They may be
   * used only after a signal has been admitted, for deterministic settlement.
   */
  settlementCandlesBySymbol?: Map<string, Candle[]>;
}

export function closed15mSchedule(start: number, end: number): number[] {
  const interval = 15 * 60 * 1000;
  const first = Math.ceil((start + 1) / interval) * interval - 1;
  const output: number[] = [];
  for (let closeTime = first; closeTime <= end; closeTime += interval) output.push(closeTime);
  return output;
}

export function replayProductionSignals(input: ProductionReplayInput): ProductionReplayResult {
  const decisions: ReplayDecision[] = [];
  const accepted: ReplayTrade[] = [];
  const blocked: Array<{ signal: ReplaySignal; reason: ReplayBlockReason }> = [];
  const settlements: SettledReplayTrade[] = [];
  const active: ReplayTrade[] = [];
  const cooldownUntil = new Map<string, number>();
  const maxConcurrentPositions = input.maxConcurrentPositions ?? 1;
  const cooldownMs = Math.max(0, input.cooldownHours ?? 0) * 60 * 60 * 1000;

  const orderedSnapshots = [...input.snapshots].sort((left, right) => left.sourceTimestamp - right.sourceTimestamp || left.instrument.symbol.localeCompare(right.instrument.symbol));
  for (const snapshot of orderedSnapshots) {
    const opportunity = buildProductionOpportunity(snapshot, input.policy);
    if (!opportunity) continue;
    const signal: ReplaySignal = {
      symbol: snapshot.instrument.symbol,
      strategyVersion: input.strategyVersion,
      signalTimestamp: snapshot.sourceTimestamp,
      snapshot,
      plan: opportunity.plan,
      score: opportunity.candidate.score,
      side: opportunity.candidate.side,
    };
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].plan.validUntil <= signal.signalTimestamp) active.splice(index, 1);
    }

    const sameSymbol = active.find((trade) => trade.symbol === signal.symbol);
    if (sameSymbol) {
      if (signal.score <= sameSymbol.score) {
        const decision = { signal, status: "REJECTED_LOWER_SCORE" as const };
        decisions.push(decision);
        blocked.push({ signal, reason: decision.status });
        continue;
      }
      active.splice(active.indexOf(sameSymbol), 1);
      if (input.settlement) settlements.push(settleCancelledTrade(sameSymbol, signal.signalTimestamp, input.settlement));
      const decision = { signal, status: "ACCEPTED" as const, replacedSignalTimestamp: sameSymbol.signalTimestamp };
      decisions.push(decision);
      const replacementTrade = toReplayTrade(signal);
      accepted.push(replacementTrade);
      active.push(replacementTrade);
      if (input.settlement) {
        const replacementSettlement = settleReplayTrade(
          replacementTrade,
          input.settlementCandlesBySymbol?.get(replacementTrade.symbol) ?? [],
          input.settlement,
        );
        if (replacementSettlement) {
          settlements.push(replacementSettlement);
          active.splice(active.indexOf(replacementTrade), 1);
          if (replacementSettlement.exitReason === "STOP_LOSS" || replacementSettlement.rMultiple <= -0.75) {
            cooldownUntil.set(replacementTrade.symbol, replacementSettlement.exitTime + cooldownMs);
          }
        }
      }
      continue;
    }

    if ((cooldownUntil.get(signal.symbol) ?? 0) > signal.signalTimestamp) {
      const decision = { signal, status: "COOLDOWN_BLOCKED" as const };
      decisions.push(decision);
      blocked.push({ signal, reason: decision.status });
      continue;
    }
    if (active.length >= maxConcurrentPositions) {
      const decision = { signal, status: "PORTFOLIO_BLOCKED" as const };
      decisions.push(decision);
      blocked.push({ signal, reason: decision.status });
      continue;
    }
    const trade = toReplayTrade(signal);
    decisions.push({ signal, status: "ACCEPTED" });
    accepted.push(trade);
    active.push(trade);
    if (input.settlement) {
      const settlement = settleReplayTrade(
        trade,
        input.settlementCandlesBySymbol?.get(trade.symbol) ?? [],
        input.settlement,
      );
      if (settlement) {
        settlements.push(settlement);
        active.splice(active.indexOf(trade), 1);
        if (settlement.exitReason === "STOP_LOSS" || settlement.rMultiple <= -0.75) cooldownUntil.set(trade.symbol, settlement.exitTime + cooldownMs);
      }
    }
  }

  return { decisions, accepted, blocked, settlements };
}

export function settleReplayTrade(
  trade: ReplayTrade,
  candles: Candle[],
  options: ReplaySettlementOptions,
): SettledReplayTrade | null {
  const ordered = [...candles]
    .filter((candle) => candle.closeTime > trade.entryTime)
    .sort((left, right) => left.closeTime - right.closeTime);
  const exit = ordered.find((candle) => (
    trade.side === "LONG"
      ? candle.low <= trade.stopPrice || candle.high >= trade.takeProfitPrice || candle.closeTime >= trade.maxHoldUntil
      : candle.high >= trade.stopPrice || candle.low <= trade.takeProfitPrice || candle.closeTime >= trade.maxHoldUntil
  ));
  if (!exit) return null;
  const stopHit = trade.side === "LONG" ? exit.low <= trade.stopPrice : exit.high >= trade.stopPrice;
  const takeProfitHit = trade.side === "LONG" ? exit.high >= trade.takeProfitPrice : exit.low <= trade.takeProfitPrice;
  const exitReason = stopHit ? "STOP_LOSS" : takeProfitHit ? "TAKE_PROFIT" : "MAX_HOLD";
  const rawExitPrice = exitReason === "STOP_LOSS" ? trade.stopPrice : exitReason === "TAKE_PROFIT" ? trade.takeProfitPrice : exit.close;
  return settleTradeAt(trade, exit.closeTime, rawExitPrice, exitReason, options);
}

function settleCancelledTrade(
  trade: ReplayTrade,
  exitTime: number,
  options: ReplaySettlementOptions,
): SettledReplayTrade {
  return settleTradeAt(trade, exitTime, trade.entryPrice, "CANCELLED", options);
}

function settleTradeAt(
  trade: ReplayTrade,
  exitTime: number,
  rawExitPrice: number,
  exitReason: SettledReplayTrade["exitReason"],
  options: ReplaySettlementOptions,
): SettledReplayTrade {
  const direction = trade.side === "LONG" ? 1 : -1;
  const slippageRate = options.slippageBps / 10_000;
  const entryFillPrice = trade.entryPrice * (1 + direction * slippageRate);
  const exitFillPrice = rawExitPrice * (1 - direction * slippageRate);
  const notional = Math.abs(entryFillPrice * trade.quantity);
  const grossPnlUsdt = (exitFillPrice - entryFillPrice) * direction * trade.quantity;
  const feesUsdt = (Math.abs(entryFillPrice * trade.quantity) + Math.abs(exitFillPrice * trade.quantity)) * options.takerFeeRate;
  const fundingUsdt = (options.fundingBySymbol?.get(trade.symbol) ?? [])
    .filter((point) => point.fundingTime > trade.entryTime && point.fundingTime <= exitTime)
    .reduce((sum, point) => sum - direction * notional * point.fundingRate, 0);
  const rawGross = (rawExitPrice - trade.entryPrice) * direction * trade.quantity;
  const slippageUsdt = Math.max(0, rawGross - grossPnlUsdt);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    ...trade,
    exitTime,
    exitPrice: exitFillPrice,
    exitReason,
    grossPnlUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt,
    netPnlUsdt,
    rMultiple: trade.theoreticalRiskUsdt === 0 ? 0 : netPnlUsdt / trade.theoreticalRiskUsdt,
  };
}

function toReplayTrade(signal: ReplaySignal): ReplayTrade {
  return {
    ...signal,
    entryTime: signal.signalTimestamp,
    entryPrice: signal.plan.entryPrice,
    entryFillPrice: signal.plan.entryPrice,
    stopPrice: signal.plan.stopPrice,
    takeProfitPrice: signal.plan.takeProfitPrice,
    maxHoldUntil: signal.plan.validUntil,
    quantity: signal.plan.quantity,
    theoreticalRiskUsdt: signal.plan.theoreticalRiskUsdt,
  };
}
