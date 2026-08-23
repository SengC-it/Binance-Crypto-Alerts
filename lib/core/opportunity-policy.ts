import { closes, ema, latest, rsi } from "./indicators";
import { classifyRegime } from "./market-regime";
import type { FundingDataStatus, FundingRatePoint, MarketSnapshot, ScoredCandidate, Side, TradePlan, MarketStateKey as CoreMarketStateKey } from "./types";

export type MarketStateFilter = "NONE" | "BTC_4H_BEAR" | "BTC_4H_BEAR_1H_WEAK" | "GLOBAL_BEAR_STRONG" | "GLOBAL_BEAR_REBOUND";
export type MarketStateKey = CoreMarketStateKey;
export type FundingCostBucket = "FAVORABLE" | "NEUTRAL" | "COSTLY" | "UNKNOWN";

export interface MarketStateAssessment {
  key: MarketStateKey;
  fourHourRegime: ReturnType<typeof classifyRegime>;
  oneHourBelowEma50: boolean | null;
  oneHourRsi: number | null;
  sourceTimestamp?: number;
}

export interface OpportunityPolicyFeatures {
  marketState: MarketStateKey;
  projectedFundingCostRiskFraction: number;
  executionCostRiskFraction: number;
  fundingDataStatus?: FundingDataStatus;
}

export interface CostAwareSample extends OpportunityPolicyFeatures {
  score: number;
  netR: number;
  side?: Side;
}

export interface CostAwareScoreBin {
  key: string;
  lowerScore: number;
  marketState: MarketStateKey;
  fundingBucket: FundingCostBucket;
  samples: number;
  rawMeanNetR: number;
  expectedNetR: number;
}

export interface CostAwareScoreModel {
  bucketSize: number;
  minimumSamples: number;
  minimumExpectedNetR: number;
  priorWeight: number;
  globalMeanNetR: number;
  bins: CostAwareScoreBin[];
}

export interface DirectionalCostAwareScoreModel {
  byDirection: Record<Side, CostAwareScoreModel | null>;
  minimumSamples: number;
  minimumExpectedNetR: number;
}

export function assessMarketState(snapshot: MarketSnapshot): MarketStateAssessment {
  const fourHour = snapshot.candles["4h"] ?? [];
  const oneHour = snapshot.candles["1h"] ?? [];
  const fourHourRegime = classifyRegime(fourHour);
  const oneHourCloses = closes(oneHour);
  const oneHourClose = oneHourCloses.at(-1);
  const oneHourEma50 = latest(ema(oneHourCloses, 50));
  const oneHourRsi = latest(rsi(oneHourCloses, 14));
  const oneHourBelowEma50 = oneHourClose === undefined || oneHourEma50 === null
    ? null
    : oneHourClose < oneHourEma50;
  const key: MarketStateKey = fourHourRegime === "UNKNOWN" || oneHourBelowEma50 === null
    ? "UNKNOWN"
    : fourHourRegime !== "BEAR"
      ? "OTHER"
      : oneHourBelowEma50 && (oneHourRsi === null || oneHourRsi <= 55)
        ? "BEAR_WEAK"
        : "BEAR_REBOUND";
  return { key, fourHourRegime, oneHourBelowEma50, oneHourRsi };
}

export function passesMarketStateFilter(
  state: MarketStateAssessment,
  filter: MarketStateFilter,
): boolean {
  if (filter === "NONE") return true;
  if (filter === "BTC_4H_BEAR") return state.fourHourRegime === "BEAR";
  if (filter === "GLOBAL_BEAR_STRONG") return state.key === "BEAR_STRONG";
  if (filter === "GLOBAL_BEAR_REBOUND") return state.key === "BEAR_REBOUND";
  return state.key === "BEAR_WEAK";
}

export function projectedFundingCostRiskFraction(
  side: Side,
  plan: TradePlan,
  fundingRates: FundingRatePoint[],
  sourceTimestamp: number,
  expectedHoldHours = 24,
  lookbackPeriods = 3,
): number {
  if (plan.theoreticalRiskUsdt <= 0) return Number.POSITIVE_INFINITY;
  const recent = fundingRates
    .filter((point) => point.fundingTime <= sourceTimestamp)
    .slice(-Math.max(1, lookbackPeriods));
  if (recent.length === 0) return Number.POSITIVE_INFINITY;
  const averageRate = recent.reduce((sum, point) => sum + point.fundingRate, 0) / recent.length;
  const direction = side === "LONG" ? 1 : -1;
  const expectedPayments = Math.max(1, expectedHoldHours / 8);
  const projectedCostUsdt = Math.max(0, direction * plan.positionNotionalUsdt * averageRate * expectedPayments);
  return projectedCostUsdt / plan.theoreticalRiskUsdt;
}

export function fitCostAwareScoreModel(
  samples: CostAwareSample[],
  options: {
    bucketSize?: number;
    minimumSamples?: number;
    minimumExpectedNetR?: number;
    priorWeight?: number;
  } = {},
): CostAwareScoreModel {
  const bucketSize = Math.max(1, Math.floor(options.bucketSize ?? 5));
  const minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 80));
  const minimumExpectedNetR = options.minimumExpectedNetR ?? 0.01;
  const priorWeight = Math.max(0, options.priorWeight ?? 100);
  const valid = samples.filter((sample) => Number.isFinite(sample.score) && Number.isFinite(sample.netR));
  const globalMeanNetR = valid.length === 0
    ? 0
    : valid.reduce((sum, sample) => sum + sample.netR, 0) / valid.length;
  const groups = new Map<string, CostAwareSample[]>();
  for (const sample of valid) {
    const lowerScore = Math.floor(sample.score / bucketSize) * bucketSize;
    const key = modelBinKey(lowerScore, sample.marketState, fundingBucket(sample.projectedFundingCostRiskFraction, sample.fundingDataStatus));
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  const bins = [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    const lowerScore = Math.floor(first.score / bucketSize) * bucketSize;
    const rawMeanNetR = group.reduce((sum, sample) => sum + sample.netR, 0) / group.length;
    const expectedNetR = (rawMeanNetR * group.length + globalMeanNetR * priorWeight)
      / (group.length + priorWeight);
    return {
      key,
      lowerScore,
      marketState: first.marketState,
      fundingBucket: fundingBucket(first.projectedFundingCostRiskFraction, first.fundingDataStatus),
      samples: group.length,
      rawMeanNetR: round(rawMeanNetR),
      expectedNetR: round(expectedNetR),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
  return {
    bucketSize,
    minimumSamples,
    minimumExpectedNetR,
    priorWeight,
    globalMeanNetR: round(globalMeanNetR),
    bins,
  };
}

export function expectedNetR(
  model: CostAwareScoreModel,
  score: number,
  features: OpportunityPolicyFeatures,
): number | null {
  const lowerScore = Math.floor(score / model.bucketSize) * model.bucketSize;
  const key = modelBinKey(lowerScore, features.marketState, fundingBucket(features.projectedFundingCostRiskFraction, features.fundingDataStatus));
  const bin = model.bins.find((item) => item.key === key);
  return bin && bin.samples >= model.minimumSamples ? bin.expectedNetR : null;
}

export function passesCostAwareExpectedValue(
  model: CostAwareScoreModel,
  candidate: ScoredCandidate,
  features: OpportunityPolicyFeatures,
): boolean {
  const prediction = expectedNetR(model, candidate.score, features);
  return prediction !== null && prediction >= model.minimumExpectedNetR;
}

export function fitDirectionalCostAwareScoreModel(
  samples: Array<CostAwareSample & { side: Side }>,
  options: Parameters<typeof fitCostAwareScoreModel>[1] = {},
): DirectionalCostAwareScoreModel {
  const byDirection: Record<Side, CostAwareScoreModel | null> = { LONG: null, SHORT: null };
  for (const side of ["LONG", "SHORT"] as const) {
    const sideSamples = samples.filter((sample) => sample.side === side);
    byDirection[side] = sideSamples.length === 0 ? null : fitCostAwareScoreModel(sideSamples, options);
  }
  return {
    byDirection,
    minimumSamples: Math.max(1, Math.floor(options.minimumSamples ?? 80)),
    minimumExpectedNetR: options.minimumExpectedNetR ?? 0.01,
  };
}

export function expectedDirectionalNetR(
  model: DirectionalCostAwareScoreModel,
  side: Side,
  score: number,
  features: OpportunityPolicyFeatures,
): number | null {
  const sideModel = model.byDirection[side];
  return sideModel ? expectedNetR(sideModel, score, features) : null;
}

export function passesDirectionalCostAwareExpectedValue(
  model: DirectionalCostAwareScoreModel,
  candidate: ScoredCandidate,
  features: OpportunityPolicyFeatures,
): boolean {
  const sideModel = model.byDirection[candidate.side];
  return Boolean(sideModel && passesCostAwareExpectedValue(sideModel, candidate, features));
}

function fundingBucket(costRiskFraction: number, status?: FundingDataStatus): FundingCostBucket {
  if (status === "UNKNOWN" || !Number.isFinite(costRiskFraction)) return "UNKNOWN";
  if (costRiskFraction <= 0) return "FAVORABLE";
  if (costRiskFraction <= 0.02) return "NEUTRAL";
  return "COSTLY";
}

function modelBinKey(lowerScore: number, marketState: MarketStateKey, funding: FundingCostBucket): string {
  return `${lowerScore}:${marketState}:${funding}`;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
