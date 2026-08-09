import type { ScoredCandidate, ScoreComponents, StrategyCandidate } from "./types";

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
    scoreComponents: normalizeComponents(candidate.scoreComponents),
  };
}

export function rankCandidates(candidates: StrategyCandidate[]): ScoredCandidate[] {
  return candidates.map(scoreCandidate).sort((left, right) => right.score - left.score);
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

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
