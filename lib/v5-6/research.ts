import type { ValidationMetrics, ValidationTrade } from "@/lib/v5-2/validation";
import {
  V53_CANDIDATE_REGISTRY,
  type StructuralCandidateDefinition,
} from "@/lib/v5-3/structural";

export const V56_MAX_CANDIDATES = 30;
export const V56_CONTROL_B_ID = "V5.5-CONTROL-SHORT-FAILED_BREAKOUT_SHORT-02";

export interface V56CandidateDefinition extends StructuralCandidateDefinition {
  researchFamily: "FAILED_BREAKOUT_BALANCED" | "WICK_REJECTION" | "BREAKDOWN_CONTINUATION" | "REGIME_ENSEMBLE" | "INDEPENDENT_LONG" | "FROZEN_CONTROL";
  sourceCandidateId: string;
  isControl: boolean;
  preregisteredHypothesis: string;
}

function sourceCandidate(id: string): StructuralCandidateDefinition {
  const source = V53_CANDIDATE_REGISTRY.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`Missing V5.6 source candidate ${id}`);
  return source;
}

function makeCandidate(input: {
  id: string;
  sourceId: string;
  researchFamily: V56CandidateDefinition["researchFamily"];
  variant: number;
  preregisteredHypothesis: string;
  parameters?: Partial<StructuralCandidateDefinition["parameters"]>;
  isControl?: boolean;
}): V56CandidateDefinition {
  const source = sourceCandidate(input.sourceId);
  return {
    ...source,
    id: input.id,
    variant: input.variant,
    parameters: { ...source.parameters, ...input.parameters },
    researchFamily: input.researchFamily,
    sourceCandidateId: input.sourceId,
    isControl: input.isControl ?? false,
    preregisteredHypothesis: input.preregisteredHypothesis,
  };
}

/**
 * Finite V5.6 registry. The registry is the experiment boundary: candidates
 * are declared here before replay and every declared candidate is retained in
 * the reports, including zero-trade and rejected candidates.
 */
export const V56_CANDIDATE_REGISTRY: readonly V56CandidateDefinition[] = [
  makeCandidate({
    id: V56_CONTROL_B_ID,
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-02",
    researchFamily: "FROZEN_CONTROL",
    variant: 0,
    isControl: true,
    preregisteredHypothesis: "V5.5 frozen SHORT-FAILED_BREAKOUT_SHORT-02; parameters and execution model are held fixed as Control B.",
  }),
  makeCandidate({
    id: "V56-SHORT-FAILED_BREAKOUT-BALANCED-105",
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-02",
    researchFamily: "FAILED_BREAKOUT_BALANCED",
    variant: 105,
    parameters: { volumeRatioMin: 1.05, maxExtensionATR: 0.9 },
    preregisteredHypothesis: "A modestly lower participation requirement may recover valid failed-breakout reversals without removing the two-bar failure constraint.",
  }),
  makeCandidate({
    id: "V56-SHORT-FAILED_BREAKOUT-BALANCED-115",
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-02",
    researchFamily: "FAILED_BREAKOUT_BALANCED",
    variant: 115,
    parameters: { volumeRatioMin: 1.15, maxExtensionATR: 0.9 },
    preregisteredHypothesis: "A middle participation threshold tests whether Control B is unnecessarily selective while preserving bounded extension.",
  }),
  makeCandidate({
    id: "V56-SHORT-FAILED_BREAKOUT-BALANCED-125",
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-02",
    researchFamily: "FAILED_BREAKOUT_BALANCED",
    variant: 125,
    parameters: { volumeRatioMin: 1.25, maxExtensionATR: 0.85 },
    preregisteredHypothesis: "A slightly relaxed extension cap with still-high participation tests entry yield around the failed reclaim.",
  }),
  makeCandidate({
    id: "V56-SHORT-WICK_REJECTION-01",
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-03",
    researchFamily: "WICK_REJECTION",
    variant: 1,
    parameters: { volumeRatioMin: 0.95, maxExtensionATR: 1 },
    preregisteredHypothesis: "A lower-volume rejection with a lower high may capture wick-led supply rejection; this remains a research adapter over the existing failed-breakout detector.",
  }),
  makeCandidate({
    id: "V56-SHORT-BREAKDOWN-CONTINUATION-01",
    sourceId: "SHORT-BREAKDOWN_RETEST_SHORT-01",
    researchFamily: "BREAKDOWN_CONTINUATION",
    variant: 1,
    preregisteredHypothesis: "A support break followed by a bounded retest may improve short entry timing versus late trend rejection.",
  }),
  makeCandidate({
    id: "V56-SHORT-BREAKDOWN-CONTINUATION-02",
    sourceId: "SHORT-BREAKDOWN_RETEST_SHORT-02",
    researchFamily: "BREAKDOWN_CONTINUATION",
    variant: 2,
    preregisteredHypothesis: "A longer-lookback, high-participation breakdown tests whether continuation quality improves at the cost of yield.",
  }),
  makeCandidate({
    id: "V56-SHORT-REGIME-ENSEMBLE-01",
    sourceId: "SHORT-FAILED_BREAKOUT_SHORT-01",
    researchFamily: "REGIME_ENSEMBLE",
    variant: 1,
    preregisteredHypothesis: "A less restrictive failed-breakout variant may be useful only in the range-to-bear transition, which is evaluated by regime slices rather than tuned after results.",
  }),
  makeCandidate({
    id: "V56-SHORT-REGIME-ENSEMBLE-02",
    sourceId: "SHORT-TREND_PULLBACK_SHORT-01",
    researchFamily: "REGIME_ENSEMBLE",
    variant: 2,
    preregisteredHypothesis: "A mature bearish trend pullback is a separate continuation component for a fixed regime ensemble, not a replacement of the Production strategy.",
  }),
  makeCandidate({
    id: "V56-LONG-INDEPENDENT-LIQUIDITY-RECLAIM-01",
    sourceId: "LONG-TREND_PULLBACK_LONG-03",
    researchFamily: "INDEPENDENT_LONG",
    variant: 1,
    parameters: { pullbackMinATR: 0.55, pullbackMaxATR: 1.4, trendAgeMinBars: 20, maxExtensionATR: 0.85, volumeRatioMin: 1.1 },
    preregisteredHypothesis: "Independent LONG hypothesis: a bounded liquidity reclaim after a deeper pullback may yield a positive asymmetric continuation in aligned bull regimes.",
  }),
  makeCandidate({
    id: "V56-LONG-INDEPENDENT-LIQUIDITY-RECLAIM-02",
    sourceId: "LONG-VOLATILITY_EXPANSION_LONG-03",
    researchFamily: "INDEPENDENT_LONG",
    variant: 2,
    parameters: { compressionBarsMin: 10, compressionRangeMaxATR: 4.2, expansionVolumeMin: 1.2, expansionVolatilityMin: 1.1, maxExtensionATR: 0.9 },
    preregisteredHypothesis: "Independent LONG hypothesis: a compressed volatility release with participation confirmation may preserve early continuation yield without changing any Production parameter.",
  }),
  makeCandidate({
    id: "V56-LONG-REGIME-ENSEMBLE-01",
    sourceId: "LONG-TREND_PULLBACK_LONG-01",
    researchFamily: "REGIME_ENSEMBLE",
    variant: 3,
    preregisteredHypothesis: "A mature bull pullback is evaluated as a complementary LONG regime component under the same next-open and cost model.",
  }),
] as const;

export function selectionScore(metrics: ValidationMetrics, alertsPerWeek: number): number {
  if (metrics.trades === 0) return Number.NEGATIVE_INFINITY;
  const profitFactor = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 3) : 3;
  const positiveMonthRatio = metrics.positiveMonthRatio ?? 0;
  const drawdownPenalty = Math.min(metrics.maxDrawdownR, 100) * 0.05;
  return metrics.avgNetR * 100
    + profitFactor * 5
    + positiveMonthRatio * 5
    + Math.log1p(Math.max(0, alertsPerWeek))
    - drawdownPenalty;
}

export function calculateCvar95(trades: ValidationTrade[]): number | null {
  const values = trades.map((trade) => trade.rMultiple).filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) return null;
  const tailCount = Math.max(1, Math.ceil(values.length * 0.05));
  return values.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount;
}

export interface YieldMetrics {
  calendarDays: number;
  alertsPerDay: number;
  alertsPerWeek: number;
  alertsPerMonth: number;
  activeMonthRatio: number | null;
  medianSignalsPerMonth: number | null;
  maxSignalDroughtDays: number | null;
  symbolBreadth: number;
  regimeBreadth: number;
  signalsBySymbol: Record<string, number>;
  signalsByRegime: Record<string, number>;
  positiveMonthRatio: number | null;
}

export function calculateYieldMetrics(trades: ValidationTrade[], start: number, end: number): YieldMetrics {
  const calendarDays = Math.max(1, (end - start + 1) / 86_400_000);
  const monthCounts = new Map<string, number>();
  const symbols = new Set<string>();
  const regimes = new Set<string>();
  const signalsBySymbol: Record<string, number> = {};
  const signalsByRegime: Record<string, number> = {};
  const timestamps = [...trades].sort((left, right) => left.entryTime - right.entryTime).map((trade) => trade.entryTime);
  for (const trade of trades) {
    monthCounts.set(new Date(trade.entryTime).toISOString().slice(0, 7), (monthCounts.get(new Date(trade.entryTime).toISOString().slice(0, 7)) ?? 0) + 1);
    symbols.add(trade.symbol);
    signalsBySymbol[trade.symbol] = (signalsBySymbol[trade.symbol] ?? 0) + 1;
    if (trade.marketRegime) regimes.add(trade.marketRegime);
    if (trade.marketRegime) signalsByRegime[trade.marketRegime] = (signalsByRegime[trade.marketRegime] ?? 0) + 1;
  }
  const monthlyCounts = [...monthCounts.values()].sort((left, right) => left - right);
  const medianSignalsPerMonth = monthlyCounts.length === 0
    ? null
    : monthlyCounts.length % 2 === 0
      ? (monthlyCounts[monthlyCounts.length / 2 - 1] + monthlyCounts[monthlyCounts.length / 2]) / 2
      : monthlyCounts[Math.floor(monthlyCounts.length / 2)];
  let maxSignalDroughtDays: number | null = null;
  for (let index = 1; index < timestamps.length; index += 1) {
    const gap = (timestamps[index] - timestamps[index - 1]) / 86_400_000;
    maxSignalDroughtDays = maxSignalDroughtDays === null ? gap : Math.max(maxSignalDroughtDays, gap);
  }
  const metrics = calculateMetricsWithoutCircularImport(trades);
  const firstMonth = new Date(start);
  const lastMonth = new Date(end);
  const calendarMonths = Math.max(1, (lastMonth.getUTCFullYear() - firstMonth.getUTCFullYear()) * 12 + lastMonth.getUTCMonth() - firstMonth.getUTCMonth() + 1);
  return {
    calendarDays,
    alertsPerDay: trades.length / calendarDays,
    alertsPerWeek: trades.length / calendarDays * 7,
    alertsPerMonth: trades.length / calendarDays * 30.4375,
    activeMonthRatio: calendarMonths > 0 ? monthCounts.size / calendarMonths : null,
    medianSignalsPerMonth,
    maxSignalDroughtDays,
    symbolBreadth: symbols.size,
    regimeBreadth: regimes.size,
    signalsBySymbol,
    signalsByRegime,
    positiveMonthRatio: metrics.positiveMonthRatio,
  };
}

// Kept local to make this helper usable by report tests without creating a
// dependency cycle through the script's serialization layer.
function calculateMetricsWithoutCircularImport(trades: ValidationTrade[]): Pick<ValidationMetrics, "positiveMonthRatio"> {
  const byMonth = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + trade.rMultiple);
  }
  const months = [...byMonth.values()];
  return { positiveMonthRatio: months.length > 0 ? months.filter((value) => value > 0).length / months.length : null };
}

export interface ParetoRow {
  id: string;
  netR: number;
  alertsPerWeek: number;
  maxDrawdownR: number;
  cvar95: number | null;
}

export function buildParetoFrontier(rows: ParetoRow[]): ParetoRow[] {
  return rows.filter((row, index) => !rows.some((other, otherIndex) => {
    if (otherIndex === index) return false;
    const noWorse = other.netR >= row.netR
      && other.alertsPerWeek >= row.alertsPerWeek
      && other.maxDrawdownR <= row.maxDrawdownR;
    const strictlyBetter = other.netR > row.netR
      || other.alertsPerWeek > row.alertsPerWeek
      || other.maxDrawdownR < row.maxDrawdownR;
    return noWorse && strictlyBetter;
  }));
}

export function canonicalResearchTradeKey(trade: ValidationTrade): string {
  return [trade.symbol, trade.side ?? "UNKNOWN", trade.entryTime, trade.exitTime ?? "OPEN"].join("|");
}

export function roundResearchMetric(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
