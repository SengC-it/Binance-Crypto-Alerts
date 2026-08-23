import type { StrategyHealthTrade } from "../../lib/core/strategy-health";

// Regression fixture derived from the second-round Production acceptance totals.
// It intentionally carries no symbol so the gate cannot grow a symbol blacklist.
export const productionHealthAcceptanceSummary = {
  trades: 11,
  takeProfitTrades: 1,
  stopLossTrades: 10,
  averageNetR: -0.8116,
  profitFactor: 0.158,
  stopRate: 0.9091,
  // The source acceptance report supplied this aggregate; raw ordering was not exported.
  reportedMaxDrawdownR: 7.8725,
};

const winningR = 1.67525;
const losingR = -1.060285;

export const productionHealth11Trades: StrategyHealthTrade[] = [
  { entryTime: 1, rMultiple: winningR, exitReason: "TAKE_PROFIT" },
  ...Array.from({ length: 10 }, (_, index) => ({
    entryTime: index + 2,
    rMultiple: losingR,
    exitReason: "STOP_LOSS",
  })),
];
