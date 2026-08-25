export type ValidationSide = "LONG" | "SHORT";

export interface ValidationTrade {
  symbol: string;
  side?: ValidationSide;
  entryTime: number;
  exitTime?: number;
  rMultiple: number;
  netPnlUsdt?: number;
  pnlUsdt?: number;
  theoreticalRiskUsdt?: number;
  feesUsdt?: number;
  fundingUsdt?: number;
  slippageUsdt?: number;
  marketRegime?: string;
}

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
  purgeStart: number;
  purgeEnd: number;
}

export interface ValidationMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  avgNetR: number;
  profitFactor: number;
  maxDrawdownR: number;
  maxDrawdownPercent: number;
  lowerConfidenceBound95: number | null;
  positiveMonths: number;
  months: number;
  positiveMonthRatio: number | null;
  topSymbolProfitShare: number | null;
  topFoldProfitShare: number | null;
  totalNetPnlUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  monthly: Array<{
    month: string;
    trades: number;
    netR: number;
    profitFactor: number;
    maxDrawdownR: number;
  }>;
}

export interface CostStressMetrics {
  base: ValidationMetrics;
  plus10Bps: ValidationMetrics;
  plus15Bps: ValidationMetrics;
}

export interface PromotionGateResult {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface PromotionGateInput {
  metrics: ValidationMetrics;
  holdout: ValidationMetrics | null;
  control: ValidationMetrics | null;
  costStress: CostStressMetrics;
  folds: Array<{ netR: number; trades: number }>;
  dataQuality: { passed: boolean; reason: string };
  foldGroups?: Array<{ id: string; folds: Array<{ netR: number; trades: number }> }>;
  regimeMetrics?: Array<{ regime: string; metrics: ValidationMetrics }>;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PURGE_HOURS = 72;

export function roundMetric(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

export function createPurgedWalkForwardFolds(input: {
  start: number;
  end: number;
  initialTrainMonths: number;
  validationMonths: number;
  foldCount?: number;
  purgeHours?: number;
}): PurgedWalkForwardFold[] {
  const purgeMs = (input.purgeHours ?? PURGE_HOURS) * HOUR;
  const requestedFolds = input.foldCount ?? 6;
  const folds: PurgedWalkForwardFold[] = [];
  let validationStart = addMonths(input.start, input.initialTrainMonths);

  for (let index = 0; index < requestedFolds; index += 1) {
    const validationEnd = Math.min(input.end, addMonths(validationStart, input.validationMonths) - 1);
    const trainEnd = validationStart - purgeMs - 1;
    const purgeStart = trainEnd + 1;
    const purgeEnd = validationStart - 1;
    if (trainEnd <= input.start || validationStart > validationEnd) break;
    folds.push({
      id: `fold-${index + 1}`,
      trainStart: input.start,
      trainEnd,
      purgeStart,
      purgeEnd,
      validationStart,
      validationEnd,
    });
    validationStart = validationEnd + 1;
    if (validationEnd >= input.end) break;
  }
  return folds;
}

export function createFrozenHoldoutWindow(
  end: number,
  folds: PurgedWalkForwardFold[],
  purgeHours = PURGE_HOURS,
): FrozenHoldoutWindow | null {
  const lastFold = folds.at(-1);
  if (!lastFold) return null;
  const purgeMs = purgeHours * HOUR;
  const purgeStart = lastFold.validationEnd + 1;
  const purgeEnd = purgeStart + purgeMs - 1;
  if (purgeEnd >= end) return null;
  return {
    start: purgeEnd + 1,
    end,
    purgeStart,
    purgeEnd,
  };
}

export function isTimestampInWindow(timestamp: number, start: number, end: number): boolean {
  return timestamp >= start && timestamp <= end;
}

export function isHoldoutExcludedFromSelection(selectionEnd: number, holdoutStart: number): boolean {
  return selectionEnd < holdoutStart;
}

export function isNoLookahead(asOfTime: number, featureTimestamp: number): boolean {
  return featureTimestamp <= asOfTime;
}

export function calculateMetrics(
  trades: ValidationTrade[],
  options: { foldByTrade?: Map<ValidationTrade, string> } = {},
): ValidationMetrics {
  const ordered = [...trades].sort((left, right) => left.entryTime - right.entryTime);
  const wins = ordered.filter((trade) => trade.rMultiple > 0).length;
  const losses = ordered.filter((trade) => trade.rMultiple < 0).length;
  const netR = ordered.reduce((sum, trade) => sum + finiteOrZero(trade.rMultiple), 0);
  const positiveR = ordered.filter((trade) => trade.rMultiple > 0)
    .reduce((sum, trade) => sum + trade.rMultiple, 0);
  const negativeR = ordered.filter((trade) => trade.rMultiple < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.rMultiple), 0);
  const monthResults = new Map<string, number>();
  const monthTrades = new Map<string, ValidationTrade[]>();
  const symbolResults = new Map<string, number>();
  const foldResults = new Map<string, number>();
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const trade of ordered) {
    const r = finiteOrZero(trade.rMultiple);
    equityR += r;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    monthResults.set(month, (monthResults.get(month) ?? 0) + r);
    const monthly = monthTrades.get(month) ?? [];
    monthly.push(trade);
    monthTrades.set(month, monthly);
    symbolResults.set(trade.symbol, (symbolResults.get(trade.symbol) ?? 0) + r);
    const fold = options.foldByTrade?.get(trade);
    if (fold) foldResults.set(fold, (foldResults.get(fold) ?? 0) + r);
  }
  const positiveMonths = [...monthResults.values()].filter((value) => value > 0).length;
  const symbolProfitShares = [...symbolResults.values()]
    .filter((value) => value > 0)
    .sort((left, right) => right - left);
  const foldProfitShares = [...foldResults.values()]
    .filter((value) => value > 0)
    .sort((left, right) => right - left);
  const positiveProfit = Math.max(0, positiveR);
  const initialEquity = 100;
  const riskPercent = 1;
  const maxDrawdownPercent = (maxDrawdownR * riskPercent / initialEquity) * 100;
  return {
    trades: ordered.length,
    wins,
    losses,
    winRate: ordered.length > 0 ? wins / ordered.length : 0,
    netR,
    avgNetR: ordered.length > 0 ? netR / ordered.length : 0,
    profitFactor: negativeR > 0 ? positiveR / negativeR : positiveR > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownR,
    maxDrawdownPercent,
    lowerConfidenceBound95: ordered.length >= 2 ? blockBootstrapLowerConfidenceBound(ordered.map((trade) => trade.rMultiple)) : null,
    positiveMonths,
    months: monthResults.size,
    positiveMonthRatio: monthResults.size > 0 ? positiveMonths / monthResults.size : null,
    topSymbolProfitShare: positiveProfit > 0 && symbolProfitShares.length > 0
      ? symbolProfitShares[0] / positiveProfit
      : null,
    topFoldProfitShare: positiveProfit > 0 && foldProfitShares.length > 0
      ? foldProfitShares[0] / positiveProfit
      : null,
    totalNetPnlUsdt: ordered.reduce((sum, trade) => sum + finiteOrZero(trade.netPnlUsdt ?? trade.pnlUsdt), 0),
    totalFeesUsdt: ordered.reduce((sum, trade) => sum + finiteOrZero(trade.feesUsdt), 0),
    totalFundingUsdt: ordered.reduce((sum, trade) => sum + finiteOrZero(trade.fundingUsdt), 0),
    totalSlippageUsdt: ordered.reduce((sum, trade) => sum + finiteOrZero(trade.slippageUsdt), 0),
    monthly: [...monthTrades.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, rows]) => {
      let equity = 0;
      let peak = 0;
      let maxDd = 0;
      let positive = 0;
      let negative = 0;
      for (const row of rows) {
        const r = finiteOrZero(row.rMultiple);
        equity += r;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
        if (r > 0) positive += r;
        if (r < 0) negative += Math.abs(r);
      }
      return {
        month,
        trades: rows.length,
        netR: rows.reduce((sum, row) => sum + finiteOrZero(row.rMultiple), 0),
        profitFactor: negative > 0 ? positive / negative : positive > 0 ? Number.POSITIVE_INFINITY : 0,
        maxDrawdownR: maxDd,
      };
    }),
  };
}

export function applyAdditionalSlippage(
  trades: ValidationTrade[],
  additionalBps: number,
): ValidationTrade[] {
  return trades.map((trade) => {
    const risk = Math.abs(trade.theoreticalRiskUsdt ?? 0);
    const fees = Math.abs(trade.feesUsdt ?? 0);
    const estimatedNotional = fees > 0 ? fees / (2 * 0.0004) : risk > 0 ? risk * 20 : 0;
    const incrementalCostUsdt = estimatedNotional * 2 * (additionalBps / 10_000);
    const incrementalR = risk > 0 ? incrementalCostUsdt / risk : 0;
    return {
      ...trade,
      rMultiple: trade.rMultiple - incrementalR,
      netPnlUsdt: (trade.netPnlUsdt ?? trade.pnlUsdt ?? 0) - incrementalCostUsdt,
      slippageUsdt: (trade.slippageUsdt ?? 0) + incrementalCostUsdt,
    };
  });
}

export function buildCostStressMetrics(trades: ValidationTrade[]): CostStressMetrics {
  return {
    base: calculateMetrics(trades),
    plus10Bps: calculateMetrics(applyAdditionalSlippage(trades, 10)),
    plus15Bps: calculateMetrics(applyAdditionalSlippage(trades, 15)),
  };
}

export function blockBootstrapLowerConfidenceBound(
  values: number[],
  repetitions = 1_000,
  blockLength = 5,
): number | null {
  if (values.length < 2) return null;
  const means: number[] = [];
  let state = (values.length * 1_103_515_245 + 12_345) >>> 0;
  const nextRandom = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const blocks = Math.ceil(values.length / Math.max(1, blockLength));
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const sample: number[] = [];
    for (let block = 0; block < blocks && sample.length < values.length; block += 1) {
      const start = Math.floor(nextRandom() * values.length);
      for (let offset = 0; offset < blockLength && sample.length < values.length; offset += 1) {
        sample.push(values[(start + offset) % values.length]);
      }
    }
    means.push(sample.reduce((sum, value) => sum + value, 0) / sample.length);
  }
  means.sort((left, right) => left - right);
  return means[Math.floor((repetitions - 1) * 0.025)] ?? null;
}

export function evaluatePromotionGate(input: PromotionGateInput): {
  status: "PRODUCTION_EMAIL_ELIGIBLE" | "SHADOW_ONLY" | "REJECTED";
  gates: PromotionGateResult[];
} {
  const foldPositive = input.folds.filter((fold) => fold.netR > 0).length;
  const foldGroupsPass = input.foldGroups
    ? input.foldGroups.every((group) => group.folds.length >= 6 && group.folds.filter((fold) => fold.netR > 0).length >= 4)
    : input.folds.length >= 6 && foldPositive >= 4;
  const foldEvidence = input.foldGroups
    ? input.foldGroups.map((group) => `${group.id}: ${group.folds.filter((fold) => fold.netR > 0).length}/${group.folds.length}`).join(", ")
    : `${foldPositive}/${input.folds.length}`;
  const gates: PromotionGateResult[] = [
    {
      id: "data_quality",
      passed: input.dataQuality.passed,
      evidence: input.dataQuality.reason,
    },
    {
      id: "minimum_sample_size",
      passed: input.metrics.trades >= 100,
      evidence: `${input.metrics.trades} trades; requires >= 100`,
    },
    {
      id: "purged_walk_forward",
      passed: foldGroupsPass,
      evidence: `${foldEvidence} positive folds; requires >= 6 folds and >= 4/6 positive per dataset group`,
    },
    {
      id: "net_edge",
      passed: input.metrics.netR > 0 && input.metrics.avgNetR > 0 && input.metrics.profitFactor >= 1.15,
      evidence: `netR=${format(input.metrics.netR)}, avgR=${format(input.metrics.avgNetR)}, PF=${format(input.metrics.profitFactor)}`,
    },
    {
      id: "lower_confidence_bound",
      passed: input.metrics.lowerConfidenceBound95 !== null && input.metrics.lowerConfidenceBound95 > 0,
      evidence: `LCB95=${format(input.metrics.lowerConfidenceBound95)}`,
    },
    {
      id: "cost_stress_plus_10bps",
      passed: input.costStress.plus10Bps.netR > 0 && input.costStress.plus10Bps.avgNetR > 0,
      evidence: `+10bps netR=${format(input.costStress.plus10Bps.netR)}, avgR=${format(input.costStress.plus10Bps.avgNetR)}`,
    },
    {
      id: "frozen_holdout",
      passed: input.holdout !== null
        && input.holdout.trades >= 30
        && input.holdout.netR > 0
        && input.holdout.avgNetR > 0
        && input.holdout.profitFactor >= 1.1,
      evidence: input.holdout
        ? `trades=${input.holdout.trades}, netR=${format(input.holdout.netR)}, PF=${format(input.holdout.profitFactor)}`
        : "holdout unavailable",
    },
    {
      id: "concentration",
      passed: (input.metrics.topSymbolProfitShare === null || input.metrics.topSymbolProfitShare <= 0.25)
        && (input.metrics.topFoldProfitShare === null || input.metrics.topFoldProfitShare <= 0.4),
      evidence: `topSymbol=${formatPercent(input.metrics.topSymbolProfitShare)}, topFold=${formatPercent(input.metrics.topFoldProfitShare)}`,
    },
    {
      id: "time_stability",
      passed: input.metrics.positiveMonthRatio !== null && input.metrics.positiveMonthRatio >= 0.6,
      evidence: `positiveMonths=${formatPercent(input.metrics.positiveMonthRatio)}`,
    },
    {
      id: "control_comparison",
      passed: input.control !== null
        && input.metrics.netR > input.control.netR
        && input.metrics.avgNetR > input.control.avgNetR
        && input.metrics.profitFactor > input.control.profitFactor
        && input.metrics.maxDrawdownR <= input.control.maxDrawdownR * 1.1 + 1e-9,
      evidence: input.control
        ? `candidate netR=${format(input.metrics.netR)} vs control ${format(input.control.netR)}; DD=${format(input.metrics.maxDrawdownR)} vs ${format(input.control.maxDrawdownR)}`
        : "control unavailable",
    },
    {
      id: "regime_conditional",
      passed: (input.regimeMetrics ?? []).every(({ metrics }) => metrics.trades < 10
        || (metrics.avgNetR > 0 && metrics.profitFactor >= 1)),
      evidence: (input.regimeMetrics ?? []).length > 0
        ? (input.regimeMetrics ?? []).map(({ regime, metrics }) => `${regime}: ${metrics.trades} trades, avgR=${format(metrics.avgNetR)}`).join("; ")
        : "regime slices unavailable",
    },
  ];
  const status = gates.every((gate) => gate.passed)
    ? "PRODUCTION_EMAIL_ELIGIBLE"
    : input.metrics.trades > 0
      ? "SHADOW_ONLY"
      : "REJECTED";
  return { status, gates };
}

export interface AttritionObservation {
  side: ValidationSide;
  fold: string;
  symbol: string;
  marketRegime: string;
  entryTime?: number;
  stages: Record<string, boolean>;
  rejectionReasons?: Record<string, string>;
}

export interface AttritionStageSummary {
  stage: string;
  side: ValidationSide;
  input: number;
  passed: number;
  rejected: number;
  retention: number | null;
}

export function summarizeAttrition(
  observations: AttritionObservation[],
  stageNames: string[],
): AttritionStageSummary[] {
  const result: AttritionStageSummary[] = [];
  for (const side of ["LONG", "SHORT"] as const) {
    const sideObservations = observations.filter((observation) => observation.side === side);
    let previous: AttritionObservation[] = sideObservations;
    for (const stage of stageNames) {
      const passed = previous.filter((observation) => observation.stages[stage] === true);
      result.push({
        stage,
        side,
        input: previous.length,
        passed: passed.length,
        rejected: previous.length - passed.length,
        retention: previous.length > 0 ? passed.length / previous.length : null,
      });
      previous = passed;
    }
  }
  return result;
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : `${(value * 100).toFixed(1)}%`;
}

export const VALIDATION_PURGE_HOURS = PURGE_HOURS;
export const VALIDATION_DAY_MS = DAY;
