import type { V21Symbol } from "./constants";

export const V21_EXECUTION_HORIZONS = [
  "PRIMARY_30M",
  "DIAGNOSTIC_15M",
  "DIAGNOSTIC_60M",
] as const;
export type V21ExecutionHorizon = (typeof V21_EXECUTION_HORIZONS)[number];

export const V21_EXECUTION_CONTRACT = {
  signalIdentity: "signalOpenTime is the open timestamp of a fully closed 5m signal candle",
  entryOpenTime: "signalOpenTime + 5m",
  entryReference: "next 5m candle OPEN",
  entryUsesSignalClose: false,
  entryUsesNextClose: false,
  horizons: {
    PRIMARY_30M: {
      entryOffsetBars: 1,
      exitOffsetBars: 6,
      fullBarsHeld: 6,
      exitReference: "exit bar OPEN + CLOSE price",
      exitCloseBoundaryOffsetBars: 7,
      role: "promotion horizon",
    },
    DIAGNOSTIC_15M: {
      entryOffsetBars: 1,
      exitOffsetBars: 3,
      fullBarsHeld: 3,
      exitReference: "exit bar OPEN + CLOSE price",
      exitCloseBoundaryOffsetBars: 4,
      role: "diagnostic only",
    },
    DIAGNOSTIC_60M: {
      entryOffsetBars: 1,
      exitOffsetBars: 12,
      fullBarsHeld: 12,
      exitReference: "exit bar OPEN + CLOSE price",
      exitCloseBoundaryOffsetBars: 13,
      role: "diagnostic only",
    },
  },
  unavailableOutcome: "OUTCOME_UNAVAILABLE; no fill, nearest-bar repair, or shortened horizon",
} as const;

export const V21_COST_CONTRACT = {
  feeBpsPerSide: 4,
  slippageBpsPerSide: 2,
  baselineRoundTripBps: 12,
  stressAdditiveRoundTripBps: {
    STRESS_5_BPS: 5,
    STRESS_10_BPS: 10,
    STRESS_20_BPS: 20,
  },
  totalRoundTripBps: {
    BASELINE: 12,
    STRESS_5_BPS: 17,
    STRESS_10_BPS: 22,
    STRESS_20_BPS: 32,
  },
  application: "fixed additive return deduction; never mutate OHLC prices",
} as const;

export const V21_METRIC_CONTRACT = {
  net: "sum(netReturn)",
  averageNet: "mean(netReturn)",
  profitFactor: "sum(netReturn > 0) / abs(sum(netReturn < 0)); Infinity if no losers; 0 if no winners",
  winRate: "count(netReturn > 0) / N; diagnostic only",
  weighting: "equal notional per event; no compounding or simultaneous-trade portfolio weighting",
} as const;

export const V21_BOOTSTRAP_CONTRACT = {
  scope: "Primary V21 only",
  clusterKey: "signalOpenTime",
  seed: 0x21B0057A,
  replications: 10_000,
  resampling: "sample distinct clusters with replacement; include every trade in each sampled cluster",
  statistic: "pooled mean baseline net return across sampled trades",
  confidence: "nearest-rank 2.5%",
  lcbRank: 250,
  lcbArrayIndex: 249,
} as const;

export const V21_PROMOTION_GATE_DEFINITIONS = {
  sample: [
    "primary final events >= 1000",
    "primary distinct clusters >= 500",
    "each fixed symbol primary events >= 75",
  ],
  performance: [
    "primary Net > 0",
    "primary PF >= 1.20",
    "primary AvgNet > 0",
    "primary cluster-bootstrap LCB95 > 0",
    "holdout A Net > 0",
    "holdout B Net > 0",
    "primary +10bps Net > 0",
  ],
  breadth: [
    "primary baseline Net > 0 symbols >= 5/8",
    "primary baseline Net > 0 years >= 2/3 among 2022, 2023, 2024",
  ],
  concentration: [
    "max single-symbol primary trade share <= 25%",
    "max single-symbol positive gross contribution <= 35%",
    "total positive gross contribution > 0",
  ],
  informationGain: [
    "V21 primary AvgNet > RAW_RETURN_REVERSAL primary AvgNet",
    "V21 primary AvgNet > SIMPLE_MEDIAN_GAP_REVERSAL primary AvgNet",
  ],
  placebo: "TIME_MATCHED_RANDOM is diagnostic only and is not a promotion gate",
} as const;

export const V21_CLASSIFICATION_CONTRACT = {
  rejected: "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL_REJECTED",
  promotionCandidate: "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL_PROMOTION_CANDIDATE",
  productionEmail: "OFF",
  automaticPromotion: false,
} as const;

export interface V21ExecutionMapping {
  horizon: V21ExecutionHorizon;
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  exitCloseBoundaryIndex: number;
  entryOffsetBars: number;
  exitOffsetBars: number;
  fullBarsHeld: number;
  outcomeAvailable: boolean;
  outcomeStatus: "AVAILABLE" | "OUTCOME_UNAVAILABLE";
}

export interface V21PriceOutcomeInput {
  symbol: V21Symbol;
  signalOpenTime: number;
  direction: "LONG" | "SHORT";
  clusterId: number;
  year: string;
  entryPrice: number;
  exitPrice: number;
  mapping: V21ExecutionMapping;
}

export interface V21EvaluatedOutcome {
  symbol: V21Symbol;
  signalOpenTime: number;
  direction: "LONG" | "SHORT";
  clusterId: number;
  year: string;
  grossReturn: number;
  baselineNetReturn: number;
  stress5NetReturn: number;
  stress10NetReturn: number;
  stress20NetReturn: number;
}

export interface V21MetricSummary {
  sampleSize: number;
  net: number;
  averageNet: number;
  profitFactor: number;
  winRate: number;
}

export interface V21ConcentrationSummary {
  maxSingleSymbolTradeShare: number;
  maxSingleSymbolPositiveGrossContribution: number;
  totalPositiveGrossContribution: number;
  positiveGrossBySymbol: Record<string, number>;
}

export interface V21PromotionInput {
  primary: V21MetricSummary;
  primaryStress10: V21MetricSummary;
  holdoutA: V21MetricSummary;
  holdoutB: V21MetricSummary;
  primaryClusterCount: number;
  primaryEventsBySymbol: Record<string, number>;
  primaryNetBySymbol: Record<string, number>;
  primaryNetByYear: Record<string, number>;
  concentration: V21ConcentrationSummary;
  bootstrapLcb95: number;
  rawReturnReversalPrimaryAvgNet: number;
  simpleMedianGapReversalPrimaryAvgNet: number;
}

export interface V21PromotionEvaluation {
  gates: Record<string, boolean>;
  passed: boolean;
  classification: typeof V21_CLASSIFICATION_CONTRACT[keyof typeof V21_CLASSIFICATION_CONTRACT] | string;
  researchStop: boolean;
  productionEmail: "OFF";
  automaticPromotion: false;
}

export function mapV21ExecutionIndices(
  signalIndex: number,
  totalBars: number,
  horizon: V21ExecutionHorizon = "PRIMARY_30M",
): V21ExecutionMapping {
  if (!Number.isSafeInteger(signalIndex) || !Number.isSafeInteger(totalBars) || totalBars < 0) {
    throw new Error("Execution mapping requires safe integer indices");
  }
  const definition = V21_EXECUTION_CONTRACT.horizons[horizon];
  const entryIndex = signalIndex + definition.entryOffsetBars;
  const exitIndex = signalIndex + definition.exitOffsetBars;
  const outcomeAvailable = signalIndex >= 0
    && entryIndex >= 0
    && exitIndex >= 0
    && entryIndex < totalBars
    && exitIndex < totalBars;
  return {
    horizon,
    signalIndex,
    entryIndex,
    exitIndex,
    exitCloseBoundaryIndex: signalIndex + definition.exitCloseBoundaryOffsetBars,
    entryOffsetBars: definition.entryOffsetBars,
    exitOffsetBars: definition.exitOffsetBars,
    fullBarsHeld: definition.fullBarsHeld,
    outcomeAvailable,
    outcomeStatus: outcomeAvailable ? "AVAILABLE" : "OUTCOME_UNAVAILABLE",
  };
}

export function calculateV21GrossReturn(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error("Entry and exit prices must be positive finite values");
  }
  return direction === "LONG" ? exitPrice / entryPrice - 1 : 1 - exitPrice / entryPrice;
}

export type V21CostScenario = "BASELINE" | "STRESS_5_BPS" | "STRESS_10_BPS" | "STRESS_20_BPS";

export function applyV21Cost(grossReturn: number, scenario: V21CostScenario = "BASELINE"): number {
  if (!Number.isFinite(grossReturn)) throw new Error("Gross return must be finite");
  const bps = V21_COST_CONTRACT.totalRoundTripBps[scenario];
  return grossReturn - bps / 10_000;
}

export function evaluateV21PriceOutcome(input: V21PriceOutcomeInput): V21EvaluatedOutcome | null {
  if (!input.mapping.outcomeAvailable) return null;
  const grossReturn = calculateV21GrossReturn(input.direction, input.entryPrice, input.exitPrice);
  return {
    symbol: input.symbol,
    signalOpenTime: input.signalOpenTime,
    direction: input.direction,
    clusterId: input.clusterId,
    year: input.year,
    grossReturn,
    baselineNetReturn: applyV21Cost(grossReturn, "BASELINE"),
    stress5NetReturn: applyV21Cost(grossReturn, "STRESS_5_BPS"),
    stress10NetReturn: applyV21Cost(grossReturn, "STRESS_10_BPS"),
    stress20NetReturn: applyV21Cost(grossReturn, "STRESS_20_BPS"),
  };
}

export function summarizeV21Outcomes(outcomes: readonly V21EvaluatedOutcome[]): V21MetricSummary {
  const returns = outcomes.map((outcome) => outcome.baselineNetReturn);
  return summarizeReturns(returns);
}

export function summarizeV21Stress10(outcomes: readonly V21EvaluatedOutcome[]): V21MetricSummary {
  return summarizeReturns(outcomes.map((outcome) => outcome.stress10NetReturn));
}

export function summarizeV21Returns(values: readonly number[]): V21MetricSummary {
  return summarizeReturns(values);
}

export function sliceV21OutcomesByYear(
  outcomes: readonly V21EvaluatedOutcome[],
  year: string,
): V21EvaluatedOutcome[] {
  return outcomes.filter((outcome) => outcome.year === year);
}

export function sliceV21OutcomesBySymbol(
  outcomes: readonly V21EvaluatedOutcome[],
  symbol: V21Symbol,
): V21EvaluatedOutcome[] {
  return outcomes.filter((outcome) => outcome.symbol === symbol);
}

export function summarizeV21Concentration(
  outcomes: readonly V21EvaluatedOutcome[],
): V21ConcentrationSummary {
  const tradeCounts: Record<string, number> = {};
  const positiveGrossBySymbol: Record<string, number> = {};
  let totalPositiveGrossContribution = 0;
  for (const outcome of outcomes) {
    tradeCounts[outcome.symbol] = (tradeCounts[outcome.symbol] ?? 0) + 1;
    const positiveGross = Math.max(outcome.grossReturn, 0);
    positiveGrossBySymbol[outcome.symbol] = (positiveGrossBySymbol[outcome.symbol] ?? 0) + positiveGross;
    totalPositiveGrossContribution += positiveGross;
  }
  const sampleSize = outcomes.length;
  const maxSingleSymbolTradeShare = sampleSize === 0
    ? 0
    : Math.max(...Object.values(tradeCounts).map((count) => count / sampleSize));
  const maxSingleSymbolPositiveGrossContribution = totalPositiveGrossContribution === 0
    ? 0
    : Math.max(...Object.values(positiveGrossBySymbol).map((value) => value / totalPositiveGrossContribution));
  return {
    maxSingleSymbolTradeShare,
    maxSingleSymbolPositiveGrossContribution,
    totalPositiveGrossContribution,
    positiveGrossBySymbol,
  };
}

export function groupV21OutcomesByCluster(
  outcomes: readonly V21EvaluatedOutcome[],
): Map<number, V21EvaluatedOutcome[]> {
  const groups = new Map<number, V21EvaluatedOutcome[]>();
  for (const outcome of outcomes) {
    const group = groups.get(outcome.clusterId) ?? [];
    group.push(outcome);
    groups.set(outcome.clusterId, group);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left - right));
}

export interface V21BootstrapResult {
  values: number[];
  lcb95: number;
  seed: number;
  replications: number;
  lcbRank: number;
}

export function bootstrapV21PrimaryAvgNet(
  outcomes: readonly V21EvaluatedOutcome[],
  seed = V21_BOOTSTRAP_CONTRACT.seed,
  replications = V21_BOOTSTRAP_CONTRACT.replications,
): V21BootstrapResult {
  if (outcomes.length === 0) throw new Error("Cluster bootstrap requires outcomes");
  if (replications !== V21_BOOTSTRAP_CONTRACT.replications) throw new Error("V21 bootstrap replication count is frozen at 10000");
  const clusters = [...groupV21OutcomesByCluster(outcomes).values()];
  if (clusters.length === 0) throw new Error("Cluster bootstrap requires clusters");
  const values: number[] = [];
  let state = seed >>> 0;
  for (let replication = 0; replication < replications; replication += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      state = xorshift32(state);
      const cluster = clusters[state % clusters.length];
      for (const outcome of cluster) {
        sum += outcome.baselineNetReturn;
        count += 1;
      }
    }
    values.push(sum / count);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    values,
    lcb95: sorted[V21_BOOTSTRAP_CONTRACT.lcbArrayIndex],
    seed,
    replications,
    lcbRank: V21_BOOTSTRAP_CONTRACT.lcbRank,
  };
}

export function evaluateV21Promotion(input: V21PromotionInput): V21PromotionEvaluation {
  const fixedSymbols = Object.keys(input.primaryEventsBySymbol);
  const years = ["2022", "2023", "2024"];
  const positiveSymbols = Object.keys(input.primaryNetBySymbol).filter((symbol) => input.primaryNetBySymbol[symbol] > 0).length;
  const positiveYears = years.filter((year) => (input.primaryNetByYear[year] ?? 0) > 0).length;
  const gates: Record<string, boolean> = {
    primaryEventsMinimum: input.primary.sampleSize >= 1000,
    primaryClustersMinimum: input.primaryClusterCount >= 500,
    eachFixedSymbolMinimum: fixedSymbols.length === 8 && fixedSymbols.every((symbol) => input.primaryEventsBySymbol[symbol] >= 75),
    primaryNetPositive: input.primary.net > 0,
    primaryProfitFactorMinimum: input.primary.profitFactor >= 1.2,
    primaryAverageNetPositive: input.primary.averageNet > 0,
    primaryClusterBootstrapLcbPositive: input.bootstrapLcb95 > 0,
    holdoutANetPositive: input.holdoutA.net > 0,
    holdoutBNetPositive: input.holdoutB.net > 0,
    primaryStress10NetPositive: input.primaryStress10.net > 0,
    primaryPositiveSymbolsMinimum: positiveSymbols >= 5,
    primaryPositiveYearsMinimum: positiveYears >= 2,
    maxSingleSymbolTradeShare: input.concentration.maxSingleSymbolTradeShare <= 0.25,
    maxSingleSymbolPositiveGrossContribution: input.concentration.maxSingleSymbolPositiveGrossContribution <= 0.35,
    totalPositiveGrossContribution: input.concentration.totalPositiveGrossContribution > 0,
    informationGainVsRawReturn: input.primary.averageNet > input.rawReturnReversalPrimaryAvgNet,
    informationGainVsMedianGap: input.primary.averageNet > input.simpleMedianGapReversalPrimaryAvgNet,
  };
  const passed = Object.values(gates).every(Boolean);
  return {
    gates,
    passed,
    classification: passed
      ? V21_CLASSIFICATION_CONTRACT.promotionCandidate
      : V21_CLASSIFICATION_CONTRACT.rejected,
    researchStop: !passed,
    productionEmail: "OFF",
    automaticPromotion: false,
  };
}

function summarizeReturns(values: readonly number[]): V21MetricSummary {
  const net = values.reduce((sum, value) => sum + value, 0);
  const winners = values.filter((value) => value > 0);
  const losers = values.filter((value) => value < 0);
  const winningSum = winners.reduce((sum, value) => sum + value, 0);
  const losingSum = losers.reduce((sum, value) => sum + value, 0);
  return {
    sampleSize: values.length,
    net,
    averageNet: values.length === 0 ? 0 : net / values.length,
    profitFactor: losers.length === 0 ? (winners.length === 0 ? 0 : Number.POSITIVE_INFINITY) : winningSum / Math.abs(losingSum),
    winRate: values.length === 0 ? 0 : winners.length / values.length,
  };
}

function xorshift32(state: number): number {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}
