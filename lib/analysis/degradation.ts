import type { Side } from "@/lib/core/types";
import type { StrategyHealthDecision } from "@/lib/core/strategy-health";

export interface DegradationFeatures {
  marketState?: string;
  btcRegime?: string;
  ethRegime?: string;
  breadth?: number;
  score?: number;
  symbol?: string;
  entryExtensionAtr?: number;
  distanceToEma?: number;
  pullbackDepth?: number;
  rsi?: number;
  volumeRatio?: number;
  fundingCost?: number;
  stopDistance?: number;
  setupAge?: number;
  [key: string]: unknown;
}

export interface DegradationForwardEvidence {
  mfe24h?: number | null;
  mae24h?: number | null;
  mfe72h?: number | null;
  mae72h?: number | null;
  halfRBeforeStop?: boolean | null;
  oneRBeforeStop?: boolean | null;
}

export interface DegradationTrade {
  id?: string;
  symbol: string;
  side?: Side;
  strategyVersion?: string;
  status?: string;
  entryTime?: number;
  exitTime?: number;
  exitReason?: string | null;
  rMultiple: number;
  netPnlUsdt?: number | null;
  features?: DegradationFeatures;
  forward?: DegradationForwardEvidence;
}

export interface DegradationPerformance {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgNetR: number;
  profitFactor: number;
  mfe24h: number | null;
  mae24h: number | null;
  mfe72h: number | null;
  mae72h: number | null;
  pHalfRBeforeStop: number | null;
  pOneRBeforeStop: number | null;
  stopRate: number;
}

export interface DegradationBreakdown extends DegradationPerformance {
  dimension: string;
  bucket: string;
}

export interface DegradationAnalysisReport {
  schemaVersion: "production-degradation-analysis.v1";
  strategyVersion: string;
  sourceStatus: "AVAILABLE" | "DATA_UNAVAILABLE" | "EMPTY";
  sampleCaveat: string;
  overall: DegradationPerformance;
  breakdowns: Record<string, DegradationBreakdown[]>;
  rootCauseAssessment: {
    confidence: "LOW" | "MEDIUM" | "HIGH";
    findings: string[];
    topLossBuckets: DegradationBreakdown[];
    symbolBlacklistRecommendation: "NONE";
  };
  source?: {
    kind: "SUPABASE" | "EXPORT" | "NONE";
    location?: string;
    rows: number;
    reason?: string;
  };
  strategyHealth?: StrategyHealthDecision;
}

const DIMENSIONS = [
  "marketState",
  "btcRegime",
  "ethRegime",
  "breadthBucket",
  "scoreBucket",
  "symbol",
  "entryExtensionAtr",
  "distanceToEma",
  "pullbackDepth",
  "rsi",
  "volumeRatio",
  "fundingCost",
  "stopDistance",
  "hourUtc",
  "setupAge",
] as const;

export function analyzeDegradationTrades(
  trades: DegradationTrade[],
  strategyVersion: string,
  sourceStatus: DegradationAnalysisReport["sourceStatus"] = trades.length > 0 ? "AVAILABLE" : "EMPTY",
): DegradationAnalysisReport {
  const settled = trades.filter((trade) => Number.isFinite(trade.rMultiple));
  const breakdowns = Object.fromEntries(DIMENSIONS.map((dimension) => [
    dimension,
    buildBreakdown(settled, dimension),
  ]));
  const allBreakdowns = Object.values(breakdowns).flat();
  const topLossBuckets = allBreakdowns
    .filter((item) => item.losses > 0)
    .sort((left, right) => right.losses - left.losses || left.avgNetR - right.avgNetR)
    .slice(0, 10);
  const findings: string[] = [];
  const overall = summarize(settled);
  if (settled.length < 30) {
    findings.push("Prospective sample is below 30 settled trades; findings are diagnostic, not a permanent rule.");
  }
  if (overall.stopRate >= 0.75) {
    findings.push("Stop-first losses dominate the observed sample; inspect entry location, reversal risk, and stop distance before changing parameters.");
  }
  if (topLossBuckets[0] && topLossBuckets[0].losses / Math.max(1, overall.losses) >= 0.6) {
    findings.push("Losses are concentrated in " + topLossBuckets[0].dimension + "=" + topLossBuckets[0].bucket + ".");
  }
  if (settled.some((trade) => !trade.features || Object.keys(trade.features).length === 0)) {
    findings.push("Some rows lack immutable feature snapshots; those rows are retained under UNKNOWN rather than inferred from future candles.");
  }
  if (findings.length === 0) findings.push("No single feature bucket explains the observed degradation; keep the strategy in prospective health review.");
  return {
    schemaVersion: "production-degradation-analysis.v1",
    strategyVersion,
    sourceStatus,
    sampleCaveat: settled.length < 30
      ? "The current sample is too small for permanent symbol or feature blacklists."
      : "Use rolling prospective evidence; do not convert one-period concentration into a permanent symbol blacklist.",
    overall,
    breakdowns,
    rootCauseAssessment: {
      confidence: settled.length >= 50 ? "HIGH" : settled.length >= 30 ? "MEDIUM" : "LOW",
      findings,
      topLossBuckets,
      symbolBlacklistRecommendation: "NONE",
    },
  };
}

function buildBreakdown(trades: DegradationTrade[], dimension: string): DegradationBreakdown[] {
  const groups = new Map<string, DegradationTrade[]>();
  for (const trade of trades) {
    const bucket = bucketFor(trade, dimension);
    const group = groups.get(bucket) ?? [];
    group.push(trade);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .map(([bucket, values]) => ({ dimension, bucket, ...summarize(values) }))
    .sort((left, right) => right.trades - left.trades || left.bucket.localeCompare(right.bucket));
}

function summarize(trades: DegradationTrade[]): DegradationPerformance {
  const wins = trades.filter((trade) => trade.rMultiple > 0).length;
  const losses = trades.filter((trade) => trade.rMultiple < 0).length;
  const grossProfit = trades.filter((trade) => trade.rMultiple > 0).reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.rMultiple < 0).reduce((sum, trade) => sum + trade.rMultiple, 0));
  const forward = trades.map((trade) => trade.forward).filter((item): item is DegradationForwardEvidence => Boolean(item));
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: round(trades.length === 0 ? 0 : wins / trades.length),
    avgNetR: round(trades.length === 0 ? 0 : trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : round(grossProfit / grossLoss),
    mfe24h: averageForward(forward, "mfe24h"),
    mae24h: averageForward(forward, "mae24h"),
    mfe72h: averageForward(forward, "mfe72h"),
    mae72h: averageForward(forward, "mae72h"),
    pHalfRBeforeStop: booleanRate(forward, "halfRBeforeStop"),
    pOneRBeforeStop: booleanRate(forward, "oneRBeforeStop"),
    stopRate: trades.length === 0
      ? 0
      : round(trades.filter((trade) => trade.exitReason === "STOP_LOSS" || trade.exitReason === "STOP").length / trades.length),
  };
}

function bucketFor(trade: DegradationTrade, dimension: string): string {
  const features = trade.features ?? {};
  if (dimension === "symbol") return trade.symbol || "UNKNOWN";
  if (dimension === "hourUtc") {
    return trade.entryTime === undefined ? "UNKNOWN" : String(new Date(trade.entryTime).getUTCHours()).padStart(2, "0");
  }
  if (dimension === "breadthBucket") return numericBucket(features.breadth, [0.35, 0.65], ["<0.35", "0.35-0.65", ">0.65"]);
  if (dimension === "scoreBucket") return numericBucket(features.score, [60, 70, 80], ["<60", "60-70", "70-80", ">=80"]);
  if (dimension === "entryExtensionAtr") return numericBucket(features.entryExtensionAtr, [0.25, 0.5, 0.75, 1], ["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1", ">=1"]);
  if (dimension === "distanceToEma") return numericBucket(features.distanceToEma, [0.5, 1, 1.5, 2], ["<0.5", "0.5-1", "1-1.5", "1.5-2", ">=2"]);
  if (dimension === "pullbackDepth") return numericBucket(features.pullbackDepth, [0.25, 0.75, 1.25, 2], ["<0.25", "0.25-0.75", "0.75-1.25", "1.25-2", ">=2"]);
  if (dimension === "rsi") return numericBucket(features.rsi, [30, 40, 50, 60, 70], ["<30", "30-40", "40-50", "50-60", "60-70", ">=70"]);
  if (dimension === "volumeRatio") return numericBucket(features.volumeRatio, [0.75, 1.25, 2, 3], ["<0.75", "0.75-1.25", "1.25-2", "2-3", ">=3"]);
  if (dimension === "fundingCost") return numericBucket(features.fundingCost, [0, 0.01, 0.03, 0.06], ["<=0", "0-0.01", "0.01-0.03", "0.03-0.06", ">=0.06"]);
  if (dimension === "stopDistance") return numericBucket(features.stopDistance, [0.25, 0.5, 0.75, 1], ["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1", ">=1"]);
  if (dimension === "setupAge") return numericBucket(features.setupAge, [2, 4, 8, 16], ["<2", "2-4", "4-8", "8-16", ">=16"]);
  const value = features[dimension];
  return value === undefined || value === null || value === "" ? "UNKNOWN" : String(value);
}

function numericBucket(value: unknown, boundaries: number[], labels: string[]): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "UNKNOWN";
  const index = boundaries.findIndex((boundary) => number < boundary);
  return labels[index < 0 ? labels.length - 1 : index];
}

function averageForward(
  values: DegradationForwardEvidence[],
  key: "mfe24h" | "mae24h" | "mfe72h" | "mae72h",
): number | null {
  const numbers = values.map((item) => item[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length === 0 ? null : round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function booleanRate(
  values: DegradationForwardEvidence[],
  key: "halfRBeforeStop" | "oneRBeforeStop",
): number | null {
  const booleans = values.map((item) => item[key]).filter((value): value is boolean => typeof value === "boolean");
  return booleans.length === 0 ? null : round(booleans.filter(Boolean).length / booleans.length);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
