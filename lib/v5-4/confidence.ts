import {
  selectionAdjustedLowerConfidenceBound,
  type CandidateValueSeries,
} from "@/lib/v5-3/structural";

export type ConfidenceMethod = "naive_bootstrap" | "block_bootstrap" | "symbol_cluster_bootstrap" | "fold_cluster_bootstrap" | "selection_adjusted_bootstrap";

export interface ConfidenceObservation {
  value: number;
  symbol: string;
  fold: string;
}

export interface ConfidenceResult {
  method: ConfidenceMethod;
  lcb95: number | null;
  repetitions: number;
  blockLength: number | null;
  clusterCount: number | null;
  notes: string;
}

export interface ConfidenceAuditResult {
  methods: ConfidenceResult[];
  promotionLcb95: number | null;
  promotionMethod: "minimum_available_lcb95" | "DATA_UNAVAILABLE";
}

export function auditConfidence(input: {
  observations: ConfidenceObservation[];
  candidateSeries: CandidateValueSeries[];
  selectedCandidateId: string;
  selectionCandidateCount: number;
  repetitions?: number;
  blockLength?: number;
  selectionAdjustedLcb?: number | null;
}): ConfidenceAuditResult {
  const repetitions = input.repetitions ?? 2_000;
  const blockLength = input.blockLength ?? 5;
  const values = input.observations.map((item) => item.value).filter(Number.isFinite);
  const methods: ConfidenceResult[] = [
    bootstrapResult(values, "naive_bootstrap", repetitions, null, null, "IID resampling; does not correct serial or cluster dependence."),
    bootstrapResult(values, "block_bootstrap", repetitions, blockLength, null, "Circular blocks preserve short-range serial correlation and overlapping-trade dependence."),
    clusterBootstrapResult(input.observations, "symbol_cluster_bootstrap", repetitions, "symbol", "Resamples complete symbol clusters with replacement."),
    clusterBootstrapResult(input.observations, "fold_cluster_bootstrap", repetitions, "fold", "Resamples complete outer-fold clusters with replacement."),
    {
      method: "selection_adjusted_bootstrap",
      lcb95: input.selectionAdjustedLcb ?? null,
      repetitions,
      blockLength,
      clusterCount: input.selectionCandidateCount,
      notes: `Nested selection adjustment over ${input.selectionCandidateCount} preregistered candidates; selected=${input.selectedCandidateId}.`,
    },
  ];
  const available = methods.map((item) => item.lcb95).filter((item): item is number => item !== null && Number.isFinite(item));
  return {
    methods,
    promotionLcb95: available.length > 0 ? Math.min(...available) : null,
    promotionMethod: available.length > 0 ? "minimum_available_lcb95" : "DATA_UNAVAILABLE",
  };
}

export function bootstrapLowerConfidenceBound(
  values: number[],
  method: "naive_bootstrap" | "block_bootstrap",
  repetitions = 2_000,
  blockLength = 5,
): number | null {
  return bootstrapResult(values, method, repetitions, method === "block_bootstrap" ? blockLength : null, null, "").lcb95;
}

export function clusterBootstrapLowerConfidenceBound(
  observations: ConfidenceObservation[],
  clusterBy: "symbol" | "fold",
  repetitions = 2_000,
): number | null {
  return clusterBootstrapResult(observations, clusterBy === "symbol" ? "symbol_cluster_bootstrap" : "fold_cluster_bootstrap", repetitions, clusterBy, "").lcb95;
}

export function selectionAdjustedConfidence(
  series: CandidateValueSeries[],
  selectedCandidateId: string,
  repetitions = 1_000,
  blockLength = 5,
): number | null {
  return selectionAdjustedLowerConfidenceBound(series, selectedCandidateId, repetitions, blockLength);
}

function bootstrapResult(
  values: number[],
  method: "naive_bootstrap" | "block_bootstrap",
  repetitions: number,
  blockLength: number | null,
  clusterCount: number | null,
  notes: string,
): ConfidenceResult {
  if (values.length < 2) return { method, lcb95: null, repetitions, blockLength, clusterCount, notes: `${notes} Fewer than two observations.` };
  const means: number[] = [];
  const random = seededRandom(values.length * 31 + (method === "block_bootstrap" ? 17 : 11));
  const effectiveBlockLength = Math.max(1, blockLength ?? 1);
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const sample: number[] = [];
    if (method === "naive_bootstrap") {
      for (let index = 0; index < values.length; index += 1) sample.push(values[Math.floor(random() * values.length)]);
    } else {
      while (sample.length < values.length) {
        const start = Math.floor(random() * values.length);
        for (let offset = 0; offset < effectiveBlockLength && sample.length < values.length; offset += 1) {
          sample.push(values[(start + offset) % values.length]);
        }
      }
    }
    means.push(mean(sample));
  }
  return {
    method,
    lcb95: percentile(means, 0.025),
    repetitions,
    blockLength,
    clusterCount,
    notes,
  };
}

function clusterBootstrapResult(
  observations: ConfidenceObservation[],
  method: "symbol_cluster_bootstrap" | "fold_cluster_bootstrap",
  repetitions: number,
  clusterBy: "symbol" | "fold",
  notes: string,
): ConfidenceResult {
  const clusters = new Map<string, number[]>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.value)) continue;
    const key = observation[clusterBy];
    clusters.set(key, [...(clusters.get(key) ?? []), observation.value]);
  }
  const entries = [...clusters.values()];
  if (entries.length < 2) return { method, lcb95: null, repetitions, blockLength: null, clusterCount: entries.length, notes: `${notes} Fewer than two clusters.` };
  const random = seededRandom(entries.length * 101 + (clusterBy === "symbol" ? 23 : 29));
  const means: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const sample: number[] = [];
    for (let cluster = 0; cluster < entries.length; cluster += 1) {
      sample.push(...entries[Math.floor(random() * entries.length)]);
    }
    means.push(mean(sample));
  }
  return {
    method,
    lcb95: percentile(means, 0.025),
    repetitions,
    blockLength: null,
    clusterCount: entries.length,
    notes,
  };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability)))] ?? null;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
