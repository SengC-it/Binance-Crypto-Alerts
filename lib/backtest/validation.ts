import type { BacktestTrade } from "./types";
import { calculateSlippageStress } from "./execution-stress";
import type { Side } from "@/lib/core/types";
import { DEFAULT_PROMOTION_GATE, type PromotionGate } from "@/lib/core/signal-admission";

export interface PurgedWalkForwardFold {
  id: string;
  trainStart: number;
  trainEnd: number;
  purgeStart: number;
  purgeEnd: number;
  validationStart: number;
  validationEnd: number;
}

export interface FrozenHoldoutWindow {
  start: number;
  end: number;
}

export interface DirectionalValidationMetrics {
  direction: Side | "COMBINED";
  trades: number;
  winRate: number;
  grossR: number;
  netR: number;
  averageNetR: number;
  medianNetR: number;
  profitFactor: number;
  maxDrawdownR: number;
  maxDrawdownPercent: number;
  cvar95: number;
  positiveMonths: number;
  positiveFolds: number;
  monthsObserved: number;
  foldsEvaluated: number;
  symbolBreadth: number;
  regimeBreadth: number;
  topSymbolProfitShare: number;
  topThreeSymbolProfitShare: number;
  profitConcentrationHhi: number;
  averageMFE: number;
  averageMAE: number;
  stopFirstRate: number;
  grossEdge: number;
  costs: number;
  netEdge: number;
  stressNetR: number;
  rFirst: {
    halfRBeforeStop: number;
    oneRBeforeStop: number;
    twoRBeforeStop: number;
  };
}

export interface PromotionDecision {
  status: "APPROVED" | "SHADOW_ONLY" | "REJECTED";
  passed: boolean;
  reasons: string[];
}

export interface PromotionGateOptions extends Partial<PromotionGate> {
  frozenHoldout?: boolean;
}

export function createPurgedWalkForwardFolds(input: {
  start: number;
  end: number;
  initialTrainMonths?: number;
  validationMonths?: number;
  foldCount?: number;
  purgeHours?: number;
}): PurgedWalkForwardFold[] {
  const initialTrainMonths = Math.max(1, Math.floor(input.initialTrainMonths ?? 12));
  const validationMonths = Math.max(1, Math.floor(input.validationMonths ?? 3));
  const foldCount = Math.max(1, Math.floor(input.foldCount ?? 4));
  const purgeMs = Math.max(0, input.purgeHours ?? 72) * 3_600_000;
  const folds: PurgedWalkForwardFold[] = [];
  let validationBoundary = addMonths(input.start, initialTrainMonths);
  for (let index = 0; index < foldCount; index += 1) {
    const purgeStart = Math.max(input.start, validationBoundary - purgeMs);
    const validationStart = validationBoundary + purgeMs;
    const validationEnd = Math.min(input.end, addMonths(validationStart, validationMonths) - 1);
    if (validationStart > input.end || validationStart > validationEnd) break;
    folds.push({
      id: `fold-${index + 1}`,
      trainStart: input.start,
      trainEnd: purgeStart - 1,
      purgeStart,
      purgeEnd: validationStart - 1,
      validationStart,
      validationEnd,
    });
    validationBoundary = validationEnd + 1;
  }
  return folds;
}

export function createFrozenHoldoutWindow(
  start: number,
  end: number,
  folds: PurgedWalkForwardFold[],
  purgeHours = 72,
): FrozenHoldoutWindow | null {
  const lastValidationEnd = folds.at(-1)?.validationEnd;
  if (lastValidationEnd === undefined) return null;
  const holdoutStart = lastValidationEnd + Math.max(0, purgeHours) * 3_600_000 + 1;
  return holdoutStart > end ? null : { start: Math.max(start, holdoutStart), end };
}

export function chooseValidationPolicy<T extends { validation: { netPnlUsdt: number; maxDrawdownPercent: number } }>(results: T[]): T | undefined {
  return [...results].sort((left, right) => {
    const leftRank = left.validation.netPnlUsdt - left.validation.maxDrawdownPercent * 100;
    const rightRank = right.validation.netPnlUsdt - right.validation.maxDrawdownPercent * 100;
    return rightRank - leftRank;
  })[0];
}

export function holdoutWasExcludedFromSelection(
  selectionWindows: Array<{ end: number }>,
  holdout: FrozenHoldoutWindow | null,
): boolean {
  if (!holdout) return true;
  return selectionWindows.every((window) => window.end < holdout.start);
}

export function summarizeDirectionalTrades(
  trades: BacktestTrade[],
  direction: Side | "COMBINED" = "COMBINED",
  foldMetrics: Array<DirectionalValidationMetrics> = [],
): DirectionalValidationMetrics {
  const selected = direction === "COMBINED" ? trades : trades.filter((trade) => trade.side === direction);
  const ordered = [...selected].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  const rValues = ordered.map((trade) => trade.rMultiple).sort((left, right) => left - right);
  const grossR = selected.reduce((sum, trade) => sum + (trade.theoreticalRiskUsdt > 0 ? trade.grossPnlUsdt / trade.theoreticalRiskUsdt : 0), 0);
  const netR = selected.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const wins = selected.filter((trade) => trade.rMultiple > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossLoss = Math.abs(selected.filter((trade) => trade.rMultiple < 0).reduce((sum, trade) => sum + trade.rMultiple, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of ordered) {
    equity += trade.rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const maxDrawdownPercent = selected.length === 0 ? 0 : maxDrawdownR / Math.max(1, selected.length) * 100;
  const cvarCount = Math.max(1, Math.ceil(rValues.length * 0.05));
  const cvar95 = rValues.length === 0 ? 0 : rValues.slice(0, cvarCount).reduce((sum, value) => sum + value, 0) / cvarCount;
  const months = new Map<string, number>();
  for (const trade of selected) {
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.rMultiple);
  }
  const paths = selected.map((trade) => trade.path).filter((path): path is NonNullable<BacktestTrade["path"]> => Boolean(path));
  const forwards = selected.map((trade) => trade.forward).filter((forward): forward is NonNullable<BacktestTrade["forward"]> => Boolean(forward));
  const stressNetR = selected.reduce((sum, trade) => {
    const entry = trade.referenceEntryPrice ?? trade.entryPrice;
    const exit = trade.referenceExitPrice ?? trade.exitPrice;
    const quantity = trade.quantity ?? 0;
    return sum + calculateSlippageStress(
      trade.side,
      entry,
      exit,
      quantity,
      trade.theoreticalRiskUsdt,
      0.0004,
      10,
    ).netR;
  }, 0);
  return {
    direction,
    trades: selected.length,
    winRate: selected.length === 0 ? 0 : wins.length / selected.length,
    grossR: round(grossR),
    netR: round(netR),
    averageNetR: selected.length === 0 ? 0 : round(netR / selected.length),
    medianNetR: round(median(rValues)),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : round(grossProfit / grossLoss),
    maxDrawdownR: round(maxDrawdownR),
    maxDrawdownPercent: round(maxDrawdownPercent),
    cvar95: round(cvar95),
    positiveMonths: [...months.values()].filter((value) => value > 0).length,
    positiveFolds: foldMetrics.filter((metric) => metric.netR > 0).length,
    monthsObserved: months.size,
    foldsEvaluated: foldMetrics.length,
    symbolBreadth: new Set(selected.map((trade) => trade.symbol)).size,
    regimeBreadth: new Set(selected.map((trade) => trade.marketState ?? trade.policyFeatures?.marketState ?? trade.marketRegime)).size,
    ...profitConcentration(selected),
    averageMFE: paths.length === 0 ? 0 : round(paths.reduce((sum, path) => sum + path.maxFavorableR, 0) / paths.length),
    averageMAE: paths.length === 0 ? 0 : round(paths.reduce((sum, path) => sum + path.maxAdverseR, 0) / paths.length),
    stopFirstRate: selected.length === 0 ? 0 : round(selected.filter((trade) => trade.exitReason === "STOP").length / selected.length),
    grossEdge: round(grossR),
    costs: round(selected.reduce((sum, trade) => sum + (trade.feesUsdt + trade.slippageUsdt - trade.fundingUsdt) / Math.max(trade.theoreticalRiskUsdt, 1e-9), 0)),
    netEdge: round(netR),
    stressNetR: round(stressNetR),
    rFirst: {
      halfRBeforeStop: forwards.length === 0 ? 0 : round(forwards.filter((metric) => metric.pPositiveHalfRBeforeStop).length / forwards.length),
      oneRBeforeStop: forwards.length === 0 ? 0 : round(forwards.filter((metric) => metric.pPositiveOneRBeforeStop).length / forwards.length),
      twoRBeforeStop: forwards.length === 0 ? 0 : round(forwards.filter((metric) => metric.pPositiveTwoRBeforeStop).length / forwards.length),
    },
  };
}

export function evaluatePromotionGate(
  metrics: DirectionalValidationMetrics,
  options: PromotionGateOptions = {},
): PromotionDecision {
  const gate = { ...DEFAULT_PROMOTION_GATE, ...options };
  const reasons: string[] = [];
  if (gate.requireFrozenHoldout && options.frozenHoldout !== true) reasons.push("holdout_not_frozen");
  if (metrics.trades < gate.minimumTrades) reasons.push("minimum_trades");
  if (metrics.averageNetR <= gate.minimumAverageNetR) reasons.push("average_net_r");
  if (metrics.medianNetR <= gate.minimumMedianNetR) reasons.push("median_net_r");
  if (metrics.profitFactor < gate.minimumProfitFactor) reasons.push("profit_factor");
  if (metrics.maxDrawdownPercent > gate.maximumDrawdownPercent) reasons.push("max_drawdown");
  if (Math.abs(metrics.cvar95) > gate.maximumCvar95) reasons.push("cvar95");
  const foldRatio = metrics.foldsEvaluated === 0 ? 0 : metrics.positiveFolds / metrics.foldsEvaluated;
  const monthRatio = metrics.monthsObserved === 0 ? 0 : metrics.positiveMonths / metrics.monthsObserved;
  if (foldRatio < gate.minimumPositiveFoldsRatio) reasons.push("positive_folds");
  if (monthRatio < gate.minimumPositiveMonthsRatio) reasons.push("positive_months");
  if (metrics.symbolBreadth < gate.minimumSymbolBreadth) reasons.push("symbol_breadth");
  if (metrics.regimeBreadth < gate.minimumRegimeBreadth) reasons.push("regime_breadth");
  if (metrics.topSymbolProfitShare > gate.maximumTopSymbolProfitShare
    || metrics.topThreeSymbolProfitShare > gate.maximumTopThreeSymbolProfitShare) reasons.push("profit_concentration");
  if (metrics.stressNetR <= gate.minimumStressNetR) reasons.push("stress_net_r");
  return {
    status: reasons.length === 0 ? "APPROVED" : metrics.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
    passed: reasons.length === 0,
    reasons,
  };
}

function profitConcentration(trades: BacktestTrade[]): {
  topSymbolProfitShare: number;
  topThreeSymbolProfitShare: number;
  profitConcentrationHhi: number;
} {
  const profits = new Map<string, number>();
  for (const trade of trades) {
    profits.set(trade.symbol, (profits.get(trade.symbol) ?? 0) + Math.max(0, trade.rMultiple));
  }
  const values = [...profits.values()].filter((value) => value > 0).sort((left, right) => right - left);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { topSymbolProfitShare: 0, topThreeSymbolProfitShare: 0, profitConcentrationHhi: 0 };
  const shares = values.map((value) => value / total);
  return {
    topSymbolProfitShare: round(shares[0] ?? 0),
    topThreeSymbolProfitShare: round(shares.slice(0, 3).reduce((sum, value) => sum + value, 0)),
    profitConcentrationHhi: round(shares.reduce((sum, value) => sum + value ** 2, 0)),
  };
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
