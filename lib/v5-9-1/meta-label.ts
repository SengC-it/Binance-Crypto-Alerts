import type { HistoricalDataset } from "@/lib/backtest/types";
import {
  applyAdditionalSlippage,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  type PurgedWalkForwardFold,
} from "@/lib/v5-2/validation";
import { selectionAdjustedLowerConfidenceBound } from "@/lib/v5-3/structural";
import {
  buildFixedOutcomes,
  buildV59CandidateEvents,
  hasValidExecutionProvenance,
  runPrimaryOnDatasets,
  summarizeMeta,
  yieldSummary,
  type V59CandidateEvent,
  type V59LabeledSample,
  type V59MetricSummary,
  type V59YieldSummary,
} from "@/lib/v5-9/meta-label";
import {
  V591_DEV_END,
  V591_DEV_START,
  V591_EVENT_REGISTRY,
  V591_MODEL_CONFIGS,
  V591_PURGE_HOURS,
  V591_RISK_TEMPLATES,
  V591_UNTOUCHED_END,
  V591_UNTOUCHED_START,
  type V591ModelConfig,
} from "@/lib/v5-9-1/registry";

export { buildFixedOutcomes, buildV59CandidateEvents, hasValidExecutionProvenance, runPrimaryOnDatasets, summarizeMeta, yieldSummary };
export type { V59CandidateEvent, V59LabeledSample, V59MetricSummary, V59YieldSummary };
export type V591MetricSummary = V59MetricSummary;
export type V591YieldSummary = V59YieldSummary;

export interface V591Prediction {
  sample: V59LabeledSample;
  probability: number;
  estimatedEV: number;
  avgWinR: number;
  avgLossR: number;
  alert: boolean;
  outerFold: string | null;
  configId: string;
  templateId: string;
}

export type V591RiskTemplate = typeof V591_RISK_TEMPLATES[number];

export interface V591SelectionResult {
  config: V591ModelConfig;
  template: V591RiskTemplate;
  score: number;
  validationAlerts: number;
  validationMetrics: V591MetricSummary;
  validationYield: V591YieldSummary;
}

export type V591SelectionStatus = "SELECTED" | "NO_ELIGIBLE_MODEL";

export interface V591DistributionStats {
  min: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

export interface V591ProbabilityBucket {
  bucket: string;
  lowerBound: number | null;
  upperBound: number | null;
  count: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  profitFactor: number | null;
}

export interface V591ProbabilityDiagnostic {
  fold: string;
  configId: string;
  templateId: string;
  predictions: number;
  distribution: V591DistributionStats;
  buckets: V591ProbabilityBucket[];
}

export interface V591EvCalibrationBucket {
  bucket: string;
  lowerBound: number | null;
  upperBound: number | null;
  predictions: number;
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  profitFactor: number | null;
}

export interface V591EvCalibrationResult {
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  failureCode: "EV_CALIBRATION_FAIL" | null;
  buckets: V591EvCalibrationBucket[];
  monotonicExpectancy: boolean | null;
}

export interface V591BaseRateRow {
  scope: "RISK_TEMPLATE" | "EVENT_FAMILY";
  id: string;
  rewardRisk: number | null;
  events: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  profitFactor: number | null;
  netR: number;
}

export interface V591BaseRateDiagnostics {
  byRiskTemplate: V591BaseRateRow[];
  byEventFamily: V591BaseRateRow[];
}

export interface V591FoldMetric {
  fold: string;
  configId: string | null;
  templateId: string | null;
  selectionStatus: V591SelectionStatus;
  metrics: V591MetricSummary;
}

export interface V591NestedResult {
  folds: PurgedWalkForwardFold[];
  predictions: V591Prediction[];
  alerts: V59LabeledSample[];
  metrics: V591MetricSummary;
  plus10Bps: V591MetricSummary;
  positiveFoldRatio: number | null;
  medianFoldNetR: number | null;
  foldMetrics: V591FoldMetric[];
  selectedConfig: V591ModelConfig | null;
  selectedTemplate: V591RiskTemplate | null;
  selectionStatus: V591SelectionStatus;
  selectionAdjustedLcb: number | null;
  promotionLcb: number | null;
  thresholdEvaluations: V591ThresholdEvaluation[];
  probabilityDiagnostics: V591ProbabilityDiagnostic[];
  evCalibration: V591EvCalibrationResult;
}

export interface V591ThresholdEvaluation {
  configId: string;
  templateId: string;
  evThresholdR: number;
  metrics: V591MetricSummary;
  yield: V591YieldSummary;
}

export interface V591UntouchedResult {
  selectedConfig: V591ModelConfig | null;
  selectedTemplate: V591RiskTemplate | null;
  predictions: V591Prediction[];
  alerts: V59LabeledSample[];
  metrics: V591MetricSummary;
  gate: Record<string, boolean>;
  status: "PASS" | "FAIL" | "INCONCLUSIVE" | "DATA_UNAVAILABLE";
  primary: V591MetricSummary;
  comparison: "YES" | "NO" | "INCONCLUSIVE";
}

export interface TrainingPayoff {
  avgWinR: number;
  avgLossR: number;
  wins: number;
  losses: number;
}

/** The EV formula is deliberately independent of validation and holdout rows. */
export function expectedNetR(probability: number, avgWinR: number, avgLossR: number): number {
  return probability * avgWinR + (1 - probability) * avgLossR;
}

/** Payoff calibration is permitted only on the supplied training partition. */
export function deriveTrainingPayoff(samples: V59LabeledSample[], templateId: string): TrainingPayoff | null {
  const scoped = samples.filter((sample) => sample.templateId === templateId);
  const wins = scoped.filter((sample) => sample.rMultiple > 0 && Number.isFinite(sample.rMultiple));
  const losses = scoped.filter((sample) => sample.rMultiple < 0 && Number.isFinite(sample.rMultiple));
  if (wins.length === 0 || losses.length === 0) return null;
  return {
    avgWinR: average(wins.map((sample) => sample.rMultiple)) ?? 0,
    avgLossR: average(losses.map((sample) => sample.rMultiple)) ?? 0,
    wins: wins.length,
    losses: losses.length,
  };
}

/**
 * Selects only configurations with at least one inner-validation alert. A
 * zero-alert configuration is not a weak candidate; it is ineligible.
 */
export function selectBestEvConfig(samples: V59LabeledSample[]): V591SelectionResult | null {
  if (samples.length === 0) return null;
  const candidates: V591SelectionResult[] = [];
  for (const config of V591_MODEL_CONFIGS) {
    for (const template of V591_RISK_TEMPLATES) {
      const scoped = samples.filter((sample) => sample.templateId === template.id);
      if (scoped.length < 10) continue;
      const start = Math.min(...scoped.map((sample) => sample.signalTimestamp));
      const end = Math.max(...scoped.map((sample) => sample.signalTimestamp));
      const folds = createPurgedWalkForwardFolds({
        start,
        end,
        initialTrainMonths: 12,
        validationMonths: 6,
        foldCount: 4,
        purgeHours: V591_PURGE_HOURS,
      });
      const validationAlerts: V59LabeledSample[] = [];
      for (const fold of folds) {
        const train = scoped.filter((sample) => sample.signalTimestamp >= fold.trainStart && sample.signalTimestamp <= fold.trainEnd);
        const validation = scoped.filter((sample) => isTimestampInWindow(sample.signalTimestamp, fold.validationStart, fold.validationEnd));
        const payoff = deriveTrainingPayoff(train, template.id);
        if (train.length < 10 || validation.length === 0 || payoff === null) continue;
        const model = fitModel(train, config);
        validationAlerts.push(...validation.filter((sample) => {
          const probability = predictModel(model, sample.features);
          return expectedNetR(probability, payoff.avgWinR, payoff.avgLossR) > config.evThresholdR;
        }));
      }
      if (validationAlerts.length === 0) continue;
      const metrics = summarizeMeta(validationAlerts);
      const validationYield = yieldSummary(validationAlerts, start, end);
      const boundedPf = Number.isFinite(metrics.metrics.profitFactor) ? Math.min(metrics.metrics.profitFactor, 5) : 5;
      const score = metrics.metrics.avgNetR * 100
        + boundedPf * 4
        + Math.min(validationYield.alertsPerMonth, 5)
        + (metrics.metrics.positiveMonthRatio ?? 0) * 2;
      candidates.push({ config, template, score, validationAlerts: validationAlerts.length, validationMetrics: metrics, validationYield });
    }
  }
  candidates.sort((left, right) => right.score - left.score
    || right.validationAlerts - left.validationAlerts
    || right.template.rewardRisk - left.template.rewardRisk
    || left.config.id.localeCompare(right.config.id));
  return candidates[0] ?? null;
}

export function buildProbabilityDiagnostics(
  rows: Array<{ probability: number; sample: V59LabeledSample }>,
  fold: string,
  configId: string,
  templateId: string,
): V591ProbabilityDiagnostic {
  const definitions = [
    { bucket: "<0.25", lowerBound: null, upperBound: 0.25, matches: (value: number) => value < 0.25 },
    { bucket: "0.25-0.30", lowerBound: 0.25, upperBound: 0.3, matches: (value: number) => value >= 0.25 && value < 0.3 },
    { bucket: "0.30-0.35", lowerBound: 0.3, upperBound: 0.35, matches: (value: number) => value >= 0.3 && value < 0.35 },
    { bucket: "0.35-0.40", lowerBound: 0.35, upperBound: 0.4, matches: (value: number) => value >= 0.35 && value < 0.4 },
    { bucket: "0.40-0.45", lowerBound: 0.4, upperBound: 0.45, matches: (value: number) => value >= 0.4 && value < 0.45 },
    { bucket: "0.45-0.50", lowerBound: 0.45, upperBound: 0.5, matches: (value: number) => value >= 0.45 && value < 0.5 },
    { bucket: "0.50-0.55", lowerBound: 0.5, upperBound: 0.55, matches: (value: number) => value >= 0.5 && value < 0.55 },
    { bucket: ">0.55", lowerBound: 0.55, upperBound: null, matches: (value: number) => value >= 0.55 },
  ] as const;
  const validRows = rows.filter((row) => Number.isFinite(row.probability));
  const probabilities = validRows.map((row) => row.probability).sort((left, right) => left - right);
  const buckets = definitions.map((definition) => {
    const selected = validRows.filter((row) => definition.matches(row.probability));
    const metrics = calculateMetrics(selected.map((row) => row.sample));
    return {
      bucket: definition.bucket,
      lowerBound: definition.lowerBound,
      upperBound: definition.upperBound,
      count: selected.length,
      wins: metrics.wins,
      winRate: selected.length > 0 ? metrics.winRate : null,
      avgR: selected.length > 0 ? metrics.avgNetR : null,
      profitFactor: selected.length > 0 && Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null,
    };
  });
  return {
    fold,
    configId,
    templateId,
    predictions: validRows.length,
    distribution: {
      min: probabilities[0] ?? null,
      p10: percentile(probabilities, 0.1),
      p25: percentile(probabilities, 0.25),
      median: percentile(probabilities, 0.5),
      p75: percentile(probabilities, 0.75),
      p90: percentile(probabilities, 0.9),
      p95: percentile(probabilities, 0.95),
      max: probabilities.at(-1) ?? null,
    },
    buckets,
  };
}

export function buildEvCalibration(predictions: V591Prediction[]): V591EvCalibrationResult {
  const definitions = [
    { bucket: "EV<=0", lowerBound: null, upperBound: 0, matches: (value: number) => value <= 0 },
    { bucket: "0-0.05", lowerBound: 0, upperBound: 0.05, matches: (value: number) => value > 0 && value <= 0.05 },
    { bucket: "0.05-0.10", lowerBound: 0.05, upperBound: 0.1, matches: (value: number) => value > 0.05 && value <= 0.1 },
    { bucket: "0.10-0.20", lowerBound: 0.1, upperBound: 0.2, matches: (value: number) => value > 0.1 && value <= 0.2 },
    { bucket: ">0.20", lowerBound: 0.2, upperBound: null, matches: (value: number) => value > 0.2 },
  ] as const;
  const buckets = definitions.map((definition) => {
    const selected = predictions.filter((prediction) => Number.isFinite(prediction.estimatedEV) && definition.matches(prediction.estimatedEV));
    const metrics = calculateMetrics(selected.map((prediction) => prediction.sample));
    return {
      bucket: definition.bucket,
      lowerBound: definition.lowerBound,
      upperBound: definition.upperBound,
      predictions: selected.length,
      trades: selected.length,
      wins: metrics.wins,
      winRate: selected.length > 0 ? metrics.winRate : null,
      avgR: selected.length > 0 ? metrics.avgNetR : null,
      profitFactor: selected.length > 0 && Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null,
    };
  });
  const populated = buckets.filter((bucket) => bucket.trades >= 5 && bucket.avgR !== null);
  if (populated.length < 2) return { status: "INCONCLUSIVE", failureCode: null, buckets, monotonicExpectancy: null };
  const monotonicExpectancy = populated.every((bucket, index) => index === 0 || bucket.avgR! >= populated[index - 1].avgR!);
  return {
    status: monotonicExpectancy ? "PASS" : "FAIL",
    failureCode: monotonicExpectancy ? null : "EV_CALIBRATION_FAIL",
    buckets,
    monotonicExpectancy,
  };
}

export function buildBaseRateDiagnostics(samples: V59LabeledSample[]): V591BaseRateDiagnostics {
  const byRiskTemplate = V591_RISK_TEMPLATES.map((template) => baseRateRow(
    "RISK_TEMPLATE",
    template.id,
    template.rewardRisk,
    samples.filter((sample) => sample.templateId === template.id),
  ));
  const byEventFamily = V591_EVENT_REGISTRY.map((family) => baseRateRow(
    "EVENT_FAMILY",
    family.id,
    null,
    samples.filter((sample) => sample.family === family.id),
  ));
  return { byRiskTemplate, byEventFamily };
}

export function runNestedEv(
  samples: V59LabeledSample[],
  startTime = V591_DEV_START,
  endTime = V591_DEV_END,
): V591NestedResult {
  const bounded = samples.filter((sample) => sample.signalTimestamp >= startTime && sample.signalTimestamp <= endTime);
  const folds = createPurgedWalkForwardFolds({ start: startTime, end: endTime, initialTrainMonths: 12, validationMonths: 6, foldCount: 8, purgeHours: V591_PURGE_HOURS });
  const predictions: V591Prediction[] = [];
  const foldMetrics: V591FoldMetric[] = [];
  const probabilityDiagnostics: V591ProbabilityDiagnostic[] = [];
  const series = new Map<string, number[]>();

  for (const fold of folds) {
    const train = bounded.filter((sample) => sample.signalTimestamp >= fold.trainStart && sample.signalTimestamp <= fold.trainEnd);
    const validation = bounded.filter((sample) => isTimestampInWindow(sample.signalTimestamp, fold.validationStart, fold.validationEnd));

    for (const config of V591_MODEL_CONFIGS) {
      for (const template of V591_RISK_TEMPLATES) {
        const trainRows = train.filter((sample) => sample.templateId === template.id);
        const validationRows = validation.filter((sample) => sample.templateId === template.id);
        const model = fitModel(trainRows, config);
        probabilityDiagnostics.push(buildProbabilityDiagnostics(
          validationRows.map((sample) => ({ probability: predictModel(model, sample.features), sample })),
          fold.id,
          config.id,
          template.id,
        ));
      }
    }

    const selection = selectBestEvConfig(train);
    if (!selection) {
      foldMetrics.push({ fold: fold.id, configId: null, templateId: null, selectionStatus: "NO_ELIGIBLE_MODEL", metrics: summarizeMeta([]) });
    } else {
      const trainingRows = train.filter((sample) => sample.templateId === selection.template.id);
      const payoff = deriveTrainingPayoff(trainingRows, selection.template.id);
      if (payoff === null) {
        foldMetrics.push({ fold: fold.id, configId: null, templateId: null, selectionStatus: "NO_ELIGIBLE_MODEL", metrics: summarizeMeta([]) });
      } else {
        const model = fitModel(trainingRows, selection.config);
        const foldPredictions = validation
          .filter((sample) => sample.templateId === selection.template.id)
          .map((sample) => {
            const probability = predictModel(model, sample.features);
            const estimatedEV = expectedNetR(probability, payoff.avgWinR, payoff.avgLossR);
            return {
              sample,
              probability,
              estimatedEV,
              avgWinR: payoff.avgWinR,
              avgLossR: payoff.avgLossR,
              alert: estimatedEV > selection.config.evThresholdR,
              outerFold: fold.id,
              configId: selection.config.id,
              templateId: selection.template.id,
            };
          });
        predictions.push(...foldPredictions);
        const alerts = foldPredictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
        foldMetrics.push({ fold: fold.id, configId: selection.config.id, templateId: selection.template.id, selectionStatus: "SELECTED", metrics: summarizeMeta(alerts) });
      }
    }

    for (const config of V591_MODEL_CONFIGS) {
      for (const template of V591_RISK_TEMPLATES) {
        const trainRows = train.filter((sample) => sample.templateId === template.id);
        const payoff = deriveTrainingPayoff(trainRows, template.id);
        if (payoff === null) continue;
        const model = fitModel(trainRows, config);
        const alerts = validation
          .filter((sample) => sample.templateId === template.id)
          .filter((sample) => expectedNetR(predictModel(model, sample.features), payoff.avgWinR, payoff.avgLossR) > config.evThresholdR)
          .map((sample) => sample.rMultiple);
        const key = `${config.id}|${template.id}`;
        series.set(key, [...(series.get(key) ?? []), ...alerts]);
      }
    }
  }

  const alerts = predictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
  const metrics = summarizeMeta(alerts);
  const plus10Bps = summarizeMeta(applyAdditionalSlippage(alerts, 10));
  const positiveFoldRatio = foldMetrics.length > 0 ? foldMetrics.filter((fold) => fold.metrics.metrics.netR > 0).length / foldMetrics.length : null;
  const orderedFoldNetR = foldMetrics.map((fold) => fold.metrics.metrics.netR).sort((left, right) => left - right);
  const medianFoldNetR = percentile(orderedFoldNetR, 0.5);
  const selected = selectBestEvConfig(bounded);
  const selectedKey = selected ? `${selected.config.id}|${selected.template.id}` : null;
  const selectionAdjustedLcb = selectedKey
    ? selectionAdjustedLowerConfidenceBound([...series.entries()].map(([candidateId, values]) => ({ candidateId, values })), selectedKey, 1_000, 5)
    : null;
  const promotionLcb = lcbMinimum([metrics.metrics.lowerConfidenceBound95, plus10Bps.metrics.lowerConfidenceBound95, selectionAdjustedLcb]);
  const thresholdEvaluations = buildThresholdEvaluations(predictions, selected);
  const evCalibration = buildEvCalibration(predictions);
  return {
    folds,
    predictions,
    alerts,
    metrics,
    plus10Bps,
    positiveFoldRatio,
    medianFoldNetR,
    foldMetrics,
    selectedConfig: selected?.config ?? null,
    selectedTemplate: selected?.template ?? null,
    selectionStatus: selected ? "SELECTED" : "NO_ELIGIBLE_MODEL",
    selectionAdjustedLcb,
    promotionLcb,
    thresholdEvaluations,
    probabilityDiagnostics,
    evCalibration,
  };
}

export function runUntouchedEvValidation(
  events: V59CandidateEvent[],
  outcomes: V59LabeledSample[],
  developmentSamples: V59LabeledSample[],
  nested: V591NestedResult,
  datasets: HistoricalDataset[],
  contextDatasets: HistoricalDataset[],
): V591UntouchedResult {
  const empty = (): V591UntouchedResult => ({
    selectedConfig: nested.selectedConfig,
    selectedTemplate: nested.selectedTemplate,
    predictions: [],
    alerts: [],
    metrics: summarizeMeta([]),
    gate: emptyUntouchedGate(),
    status: "DATA_UNAVAILABLE",
    primary: summarizeMeta([]),
    comparison: "INCONCLUSIVE",
  });
  if (!nested.selectedConfig || !nested.selectedTemplate || events.length === 0 || outcomes.length === 0) return empty();
  const training = developmentSamples.filter((sample) => sample.templateId === nested.selectedTemplate!.id);
  const payoff = deriveTrainingPayoff(training, nested.selectedTemplate.id);
  if (payoff === null) return empty();
  const model = fitModel(training, nested.selectedConfig);
  const holdoutOutcomes = outcomes.filter((sample) => sample.signalTimestamp >= V591_UNTOUCHED_START && sample.signalTimestamp <= V591_UNTOUCHED_END);
  const predictions = holdoutOutcomes.map((sample) => {
    const probability = predictModel(model, sample.features);
    const estimatedEV = expectedNetR(probability, payoff.avgWinR, payoff.avgLossR);
    return {
      sample,
      probability,
      estimatedEV,
      avgWinR: payoff.avgWinR,
      avgLossR: payoff.avgLossR,
      alert: estimatedEV > nested.selectedConfig!.evThresholdR,
      outerFold: null,
      configId: nested.selectedConfig!.id,
      templateId: nested.selectedTemplate!.id,
    };
  });
  const alerts = predictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
  const metrics = summarizeMeta(alerts);
  const allSymbols = new Set(alerts.map((sample) => sample.symbol));
  const positiveSymbols = new Set(alerts.filter((sample) => sample.rMultiple > 0).map((sample) => sample.symbol));
  const positiveSymbolRatio = allSymbols.size > 0 ? positiveSymbols.size / allSymbols.size : null;
  const resultMetrics = { ...metrics, positiveSymbolRatio };
  const gate = {
    signals: alerts.length >= 50,
    untouchedSymbols: allSymbols.size >= 10,
    netR: metrics.metrics.netR > 0,
    avgR: metrics.metrics.avgNetR > 0,
    profitFactor: metrics.metrics.profitFactor >= 1.2,
    plus10BpsNetR: metrics.plus10Bps.netR > 0,
    positiveSymbolRatio: positiveSymbolRatio !== null && positiveSymbolRatio >= 0.6,
  };
  const status = alerts.length < 50 ? "INCONCLUSIVE" : Object.values(gate).every(Boolean) ? "PASS" : "FAIL";
  const primary = runPrimaryOnDatasets(datasets, contextDatasets);
  const primarySummary = summarizeMeta(primary);
  const metaYield = yieldSummary(alerts, V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const primaryYield = yieldSummary(primary, V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const comparison = alerts.length < 20 || primary.length < 20
    ? "INCONCLUSIVE"
    : metrics.metrics.avgNetR >= primarySummary.metrics.avgNetR
      && Number.isFinite(metrics.metrics.profitFactor)
      && metrics.metrics.profitFactor >= primarySummary.metrics.profitFactor
      && metaYield.alertsPerMonth >= primaryYield.alertsPerMonth
      ? "YES"
      : "NO";
  return { selectedConfig: nested.selectedConfig, selectedTemplate: nested.selectedTemplate, predictions, alerts, metrics: resultMetrics, gate, status, primary: primarySummary, comparison };
}

function buildThresholdEvaluations(predictions: V591Prediction[], selected: V591SelectionResult | null): V591ThresholdEvaluation[] {
  if (!selected) return [];
  return V591_MODEL_CONFIGS
    .filter((config) => config.family === selected.config.family)
    .map((config) => {
      const alerts = predictions
        .filter((prediction) => prediction.templateId === selected.template.id && prediction.estimatedEV > config.evThresholdR)
        .map((prediction) => prediction.sample);
      return { configId: config.id, templateId: selected.template.id, evThresholdR: config.evThresholdR, metrics: summarizeMeta(alerts), yield: yieldSummary(alerts, V591_DEV_START, V591_DEV_END) };
    });
}

interface FittedModel {
  family: V591ModelConfig["family"];
  means: number[];
  scales: number[];
  weights?: number[];
  intercept?: number;
  splitFeature?: number;
  splitValue?: number;
  leftProbability?: number;
  rightProbability?: number;
  baseProbability: number;
}

function fitModel(samples: V59LabeledSample[], config: V591ModelConfig): FittedModel {
  const width = samples[0]?.features.length ?? 12;
  const means = Array.from({ length: width }, (_, index) => average(samples.map((sample) => sample.features[index])) ?? 0);
  const scales = Array.from({ length: width }, (_, index) => {
    const variance = average(samples.map((sample) => (sample.features[index] - means[index]) ** 2)) ?? 0;
    return Math.sqrt(variance) || 1;
  });
  const labels = samples.map((sample) => sample.label === "POSITIVE" ? 1 : 0);
  const baseProbability = clamp(average(labels) ?? 0.5, 0.01, 0.99);
  if (config.family === "SHALLOW_TREE") return fitShallowTree(samples, means, scales, baseProbability);
  const weights = Array.from({ length: width }, () => 0);
  let intercept = Math.log(baseProbability / (1 - baseProbability));
  const learningRate = 0.08;
  for (let iteration = 0; iteration < 320; iteration += 1) {
    const weightGradient = Array.from({ length: width }, () => 0);
    let interceptGradient = 0;
    samples.forEach((sample, rowIndex) => {
      const normalized = normalize(sample.features, means, scales);
      const probability = sigmoid(intercept + dot(weights, normalized));
      const error = probability - labels[rowIndex];
      interceptGradient += error;
      normalized.forEach((value, featureIndex) => { weightGradient[featureIndex] += error * value; });
    });
    const divisor = Math.max(1, samples.length);
    intercept -= learningRate * interceptGradient / divisor;
    weights.forEach((_, index) => { weights[index] -= learningRate * (weightGradient[index] / divisor + config.l2 * weights[index]); });
  }
  return { family: config.family, means, scales, weights, intercept, baseProbability };
}

function fitShallowTree(samples: V59LabeledSample[], means: number[], scales: number[], baseProbability: number): FittedModel {
  let best: { feature: number; value: number; loss: number; left: number; right: number } | null = null;
  for (let feature = 0; feature < means.length; feature += 1) {
    const values = [...new Set(samples.map((sample) => normalize(sample.features, means, scales)[feature]))].sort((left, right) => left - right);
    for (const value of [values[Math.floor(values.length * 0.25)], values[Math.floor(values.length * 0.5)], values[Math.floor(values.length * 0.75)]]) {
      if (value === undefined) continue;
      const leftRows = samples.filter((sample) => normalize(sample.features, means, scales)[feature] <= value);
      const rightRows = samples.filter((sample) => normalize(sample.features, means, scales)[feature] > value);
      if (leftRows.length < 8 || rightRows.length < 8) continue;
      const left = clamp(average(leftRows.map((sample) => sample.label === "POSITIVE" ? 1 : 0)) ?? baseProbability, 0.01, 0.99);
      const right = clamp(average(rightRows.map((sample) => sample.label === "POSITIVE" ? 1 : 0)) ?? baseProbability, 0.01, 0.99);
      const loss = leftRows.reduce((sum, sample) => sum + logLoss(left, sample.label === "POSITIVE" ? 1 : 0), 0)
        + rightRows.reduce((sum, sample) => sum + logLoss(right, sample.label === "POSITIVE" ? 1 : 0), 0);
      if (!best || loss < best.loss) best = { feature, value, loss, left, right };
    }
  }
  return { family: "SHALLOW_TREE", means, scales, splitFeature: best?.feature, splitValue: best?.value, leftProbability: best?.left, rightProbability: best?.right, baseProbability };
}

function predictModel(model: FittedModel, features: number[]): number {
  if (model.family === "SHALLOW_TREE") {
    if (model.splitFeature === undefined || model.splitValue === undefined) return model.baseProbability;
    return normalize(features, model.means, model.scales)[model.splitFeature] <= model.splitValue ? model.leftProbability ?? model.baseProbability : model.rightProbability ?? model.baseProbability;
  }
  return sigmoid((model.intercept ?? 0) + dot(model.weights ?? [], normalize(features, model.means, model.scales)));
}

function baseRateRow(scope: V591BaseRateRow["scope"], id: string, rewardRisk: number | null, samples: V59LabeledSample[]): V591BaseRateRow {
  const metrics = calculateMetrics(samples);
  return {
    scope,
    id,
    rewardRisk,
    events: samples.length,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: metrics.winRate,
    avgR: metrics.avgNetR,
    profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null,
    netR: metrics.netR,
  };
}

function emptyUntouchedGate(): Record<string, boolean> {
  return { signals: false, untouchedSymbols: false, netR: false, avgR: false, profitFactor: false, plus10BpsNetR: false, positiveSymbolRatio: false };
}

function lcbMinimum(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return usable.length > 0 ? Math.min(...usable) : null;
}

function normalize(values: number[], means: number[], scales: number[]): number[] {
  return values.map((value, index) => (value - (means[index] ?? 0)) / (scales[index] || 1));
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

function logLoss(probability: number, label: number): number {
  return -(label * Math.log(probability) + (1 - label) * Math.log(1 - probability));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil((values.length - 1) * probability))] ?? null;
}
