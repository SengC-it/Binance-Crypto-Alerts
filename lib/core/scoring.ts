import type { ScoredCandidate, ScoreComponents, Side, StrategyCandidate } from "./types";

export interface ScoreCalibrationPolicy {
  minimumScore?: number;
  sideFilter?: Side;
  strategyFamily?: StrategyCandidate["strategyFamily"];
}

export interface ScoreCalibrationSample {
  score: number;
  netR: number;
  strategyFamily?: StrategyCandidate["strategyFamily"];
}

export interface ScoreCalibrationBin {
  key: string;
  strategyFamily?: StrategyCandidate["strategyFamily"];
  lowerScore: number;
  upperScore: number;
  samples: number;
  rawMeanNetR: number;
  meanNetR: number;
  lowerConfidenceBound: number;
  edgeConfidence: number;
  winProbability: number;
  /** Legacy alias retained for historical reports. */
  winRate: number;
}

export interface ScoreCalibrationModel {
  bucketSize: number;
  groupByStrategyFamily: boolean;
  minimumSamples: number;
  minimumExpectedNetR: number;
  priorWeight: number;
  globalMeanNetR: number;
  bins: ScoreCalibrationBin[];
}

export interface ScoreCalibrationFitOptions {
  bucketSize?: number;
  groupByStrategyFamily?: boolean;
  minimumSamples?: number;
  minimumExpectedNetR?: number;
  priorWeight?: number;
}

export interface DirectionalScoreCalibrationSample extends ScoreCalibrationSample {
  side: Side;
}

export interface DirectionalScoreCalibrationModel {
  byDirection: Record<Side, ScoreCalibrationModel | null>;
  minimumSamples: number;
  minimumExpectedNetR: number;
}

const WEIGHTS: Record<keyof ScoreComponents, number> = {
  trendAlignment: 0.2,
  momentum: 0.16,
  structure: 0.18,
  liquidity: 0.12,
  volatility: 0.12,
  regimeFit: 0.14,
  dataQuality: 0.08,
};

export function scoreCandidate(candidate: StrategyCandidate): ScoredCandidate {
  const weightedScore = Object.entries(WEIGHTS).reduce((total, [key, weight]) => {
    const component = candidate.scoreComponents[key as keyof ScoreComponents];
    return total + clamp01(component) * weight;
  }, 0);

  return {
    ...candidate,
    score: round(weightedScore * 100, 3),
    structuralScore: round(weightedScore * 100, 3),
    scoreComponents: normalizeComponents(candidate.scoreComponents),
  };
}

export function rankCandidates(
  candidates: StrategyCandidate[],
  calibration?: ScoreCalibrationPolicy,
): ScoredCandidate[] {
  return candidates
    .map(scoreCandidate)
    .filter((candidate) => passesScoreCalibration(candidate, calibration))
    .sort((left, right) => right.score - left.score);
}

export function passesScoreCalibration(
  candidate: ScoredCandidate,
  calibration?: ScoreCalibrationPolicy,
): boolean {
  if (!calibration) return true;
  if (calibration.sideFilter && candidate.side !== calibration.sideFilter) return false;
  if (calibration.strategyFamily && candidate.strategyFamily !== calibration.strategyFamily) return false;
  return calibration.minimumScore === undefined || candidate.score >= calibration.minimumScore;
}

/**
 * Fit a cost-aware empirical mapping from the explainable score to realized
 * net R. The caller is responsible for fitting this model on a historical
 * training window only; the backtest engine can then apply it out of sample.
 */
export function fitScoreCalibration(
  samples: ScoreCalibrationSample[],
  options: ScoreCalibrationFitOptions = {},
): ScoreCalibrationModel {
  const bucketSize = clampInteger(options.bucketSize ?? 5, 1, 25);
  const groupByStrategyFamily = options.groupByStrategyFamily ?? false;
  const minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 40));
  const minimumExpectedNetR = options.minimumExpectedNetR ?? 0.02;
  const priorWeight = Math.max(0, options.priorWeight ?? 20);
  const validSamples = samples.filter((sample) => Number.isFinite(sample.score) && Number.isFinite(sample.netR));
  const globalMeanNetR = validSamples.length === 0
    ? 0
    : validSamples.reduce((total, sample) => total + sample.netR, 0) / validSamples.length;
  const grouped = new Map<string, { lowerScore: number; strategyFamily?: StrategyCandidate["strategyFamily"]; samples: ScoreCalibrationSample[] }>();

  for (const sample of validSamples) {
    const lowerScore = scoreBucket(sample.score, bucketSize);
    const strategyFamily = groupByStrategyFamily ? sample.strategyFamily : undefined;
    const key = calibrationKey(lowerScore, strategyFamily, groupByStrategyFamily);
    const bucket = grouped.get(key) ?? { lowerScore, strategyFamily, samples: [] };
    bucket.samples.push(sample);
    grouped.set(key, bucket);
  }

  const bins = [...grouped.entries()]
    .sort(([, left], [, right]) => left.lowerScore - right.lowerScore || (left.strategyFamily ?? "").localeCompare(right.strategyFamily ?? ""))
    .map(([key, bucket]) => {
      const rawMeanNetR = bucket.samples.reduce((total, sample) => total + sample.netR, 0) / bucket.samples.length;
      const meanNetR = (rawMeanNetR * bucket.samples.length + globalMeanNetR * priorWeight)
        / (bucket.samples.length + priorWeight);
      const wins = bucket.samples.filter((sample) => sample.netR > 0).length;
      const variance = bucket.samples.reduce((total, sample) => total + (sample.netR - rawMeanNetR) ** 2, 0) / Math.max(1, bucket.samples.length - 1);
      const standardError = Math.sqrt(variance) / Math.sqrt(bucket.samples.length);
      const lowerConfidenceBound = meanNetR - 1.645 * standardError;
      // The admission layer already hard-rejects bins below minimumSamples.
      // Once that floor is met, edge confidence measures the uncertainty of
      // the net-R estimate rather than double-counting the same sample gate.
      const sampleReliability = Math.min(1, bucket.samples.length / minimumSamples);
      const positiveEdgeReliability = lowerConfidenceBound <= 0
        ? 0
        : 0.5 + 0.5 * clamp01(lowerConfidenceBound / (Math.abs(meanNetR) + 0.5));
      const edgeConfidence = sampleReliability * positiveEdgeReliability;
      const winProbability = (wins + priorWeight * 0.5) / (bucket.samples.length + priorWeight);
      return {
        key,
        strategyFamily: bucket.strategyFamily,
        lowerScore: bucket.lowerScore,
        upperScore: Math.min(100, bucket.lowerScore + bucketSize),
        samples: bucket.samples.length,
        rawMeanNetR: round(rawMeanNetR, 6),
        meanNetR: round(meanNetR, 6),
        lowerConfidenceBound: round(lowerConfidenceBound, 6),
        edgeConfidence: round(edgeConfidence, 6),
        winProbability: round(winProbability, 6),
        winRate: round(wins / bucket.samples.length, 6),
      };
    });

  return {
    bucketSize,
    groupByStrategyFamily,
    minimumSamples,
    minimumExpectedNetR,
    priorWeight,
    globalMeanNetR: round(globalMeanNetR, 6),
    bins,
  };
}

export function expectedNetRForScore(
  model: ScoreCalibrationModel,
  score: number,
  strategyFamily?: StrategyCandidate["strategyFamily"],
): number | null {
  const bin = findCalibrationBin(model, score, strategyFamily);
  return bin?.meanNetR ?? null;
}

export function passesEmpiricalScoreCalibration(
  model: ScoreCalibrationModel,
  score: number,
  strategyFamily?: StrategyCandidate["strategyFamily"],
): boolean {
  const bin = findCalibrationBin(model, score, strategyFamily);
  return Boolean(
    bin
    && bin.samples >= model.minimumSamples
    && bin.meanNetR >= model.minimumExpectedNetR,
  );
}

export function fitDirectionalScoreCalibration(
  samples: DirectionalScoreCalibrationSample[],
  options: ScoreCalibrationFitOptions = {},
): DirectionalScoreCalibrationModel {
  const byDirection: Record<Side, ScoreCalibrationModel | null> = {
    LONG: null,
    SHORT: null,
  };
  for (const side of ["LONG", "SHORT"] as const) {
    const sideSamples = samples.filter((sample) => sample.side === side);
    byDirection[side] = sideSamples.length === 0 ? null : fitScoreCalibration(sideSamples, options);
  }
  return {
    byDirection,
    minimumSamples: Math.max(1, Math.floor(options.minimumSamples ?? 40)),
    minimumExpectedNetR: options.minimumExpectedNetR ?? 0.02,
  };
}

export function expectedDirectionalNetR(
  model: DirectionalScoreCalibrationModel,
  side: Side,
  score: number,
  strategyFamily?: StrategyCandidate["strategyFamily"],
): number | null {
  const sideModel = model.byDirection[side];
  return sideModel ? expectedNetRForScore(sideModel, score, strategyFamily) : null;
}

export function passesDirectionalEmpiricalScoreCalibration(
  model: DirectionalScoreCalibrationModel,
  side: Side,
  score: number,
  strategyFamily?: StrategyCandidate["strategyFamily"],
): boolean {
  const sideModel = model.byDirection[side];
  return Boolean(sideModel && passesEmpiricalScoreCalibration(sideModel, score, strategyFamily));
}

function normalizeComponents(components: ScoreComponents): ScoreComponents {
  return {
    trendAlignment: round(clamp01(components.trendAlignment), 4),
    momentum: round(clamp01(components.momentum), 4),
    structure: round(clamp01(components.structure), 4),
    liquidity: round(clamp01(components.liquidity), 4),
    volatility: round(clamp01(components.volatility), 4),
    regimeFit: round(clamp01(components.regimeFit), 4),
    dataQuality: round(clamp01(components.dataQuality), 4),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function scoreBucket(score: number, bucketSize: number): number {
  return Math.min(100, Math.max(0, Math.floor(score / bucketSize) * bucketSize));
}

function findCalibrationBin(
  model: ScoreCalibrationModel,
  score: number,
  strategyFamily?: StrategyCandidate["strategyFamily"],
): ScoreCalibrationBin | undefined {
  if (!Number.isFinite(score)) return undefined;
  const lowerScore = scoreBucket(score, model.bucketSize);
  const key = calibrationKey(lowerScore, strategyFamily, model.groupByStrategyFamily);
  return model.bins.find((bin) => bin.key === key);
}

function calibrationKey(
  lowerScore: number,
  strategyFamily: StrategyCandidate["strategyFamily"] | undefined,
  groupByStrategyFamily: boolean,
): string {
  return groupByStrategyFamily ? `${strategyFamily ?? "UNKNOWN"}:${lowerScore}` : String(lowerScore);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
