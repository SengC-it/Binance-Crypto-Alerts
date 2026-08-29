import type { ServerConfig } from "../config";
import {
  buildProductionOpportunity,
  type ProductionSignalPolicy,
} from "./production-signal";
import type { MarketSnapshot, ScoredCandidate, TradePlan } from "./types";
import type { StrategyParams } from "./strategies";

export type ProductionOpportunity = {
  snapshot: MarketSnapshot;
  candidate: ScoredCandidate;
  plan: TradePlan;
};

export function buildProductionSignalPolicy(
  strategyParams: StrategyParams,
  config: ServerConfig,
): ProductionSignalPolicy {
  return {
    strategyParams,
    minimumScore: config.CS_MIN_SIGNAL_SCORE,
    sideFilter: config.CS_SIGNAL_SIDE_FILTER === "BOTH" ? undefined : config.CS_SIGNAL_SIDE_FILTER,
    strategyFamily: config.CS_SIGNAL_STRATEGY_FAMILY === "ALL" ? undefined : config.CS_SIGNAL_STRATEGY_FAMILY,
    requireRegimeAlignment: config.CS_REQUIRE_REGIME_ALIGNMENT,
    entryIntervalHours: config.CS_ENTRY_INTERVAL_HOURS,
    takerFeeRate: config.CS_PAPER_TAKER_FEE_RATE,
    slippageBps: config.CS_PAPER_SLIPPAGE_BPS,
    maxExecutionCostRiskFraction: config.CS_MAX_EXECUTION_COST_RISK_FRACTION,
    marginUsdt: config.CS_MARGIN_USDT,
    leverage: config.CS_ASSUMED_LEVERAGE,
    singleSignalRiskCapUsdt: config.CS_PER_SIGNAL_RISK_CAP_USDT,
    dailyRiskBudgetUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
    maxHoldHours: config.CS_MAX_HOLD_HOURS,
    rewardRisk: config.CS_REWARD_RISK,
    riskPerTradeUsdt: config.CS_RISK_PER_TRADE_USDT,
    maxPositionNotionalUsdt: config.CS_MAX_POSITION_NOTIONAL_USDT,
  };
}

export function buildOpportunity(
  snapshot: MarketSnapshot,
  strategyParams: StrategyParams,
  config: ServerConfig,
): ProductionOpportunity | undefined {
  return buildProductionOpportunity(snapshot, buildProductionSignalPolicy(strategyParams, config));
}
