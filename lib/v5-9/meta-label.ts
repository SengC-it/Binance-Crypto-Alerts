import { closes, ema } from "@/lib/core/indicators";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, FundingRatePoint, MarketRegime, Side } from "@/lib/core/types";
import {
  applyAdditionalSlippage,
  blockBootstrapLowerConfidenceBound,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  type PurgedWalkForwardFold,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan, type StructuralCandidateDefinition, type StructuralParameters } from "@/lib/v5-3/structural";
import { selectionAdjustedLowerConfidenceBound } from "@/lib/v5-3/structural";
import { V561_CANDIDATE_REGISTRY, runIndependentCandidate, type V561Trade } from "@/lib/v5-6-1/research";
import {
  eventFamilyToStructuralFamily,
  V59_BASE_SLIPPAGE_BPS,
  V59_COOLDOWN_HOURS,
  V59_DEV_END,
  V59_DEV_START,
  V59_EVENT_REGISTRY,
  V59_FEE_RATE,
  V59_MODEL_CONFIGS,
  V59_MAX_EVENTS_PER_FAMILY,
  V59_PRIMARY_EDGE_ID,
  V59_PURGE_HOURS,
  V59_RISK_PER_TRADE_USDT,
  V59_RISK_TEMPLATES,
  V59_UNTOUCHED_END,
  V59_UNTOUCHED_START,
  type V59EventFamily,
  type V59ModelConfig,
  type V59RiskTemplate,
} from "@/lib/v5-9/registry";

export interface V59CandidateEvent {
  eventId: string;
  symbol: string;
  side: Side;
  family: V59EventFamily;
  signalTimestamp: number;
  signalIndex: number;
  frame: FeatureFrame;
  features: number[];
}

export interface V59LabeledSample extends ValidationTrade {
  eventId: string;
  symbol: string;
  side: Side;
  family: V59EventFamily;
  templateId: string;
  signalTimestamp: number;
  signalIndex: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
  executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN";
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPrice: number;
  label: "POSITIVE" | "NEGATIVE";
  highQuality: boolean;
  features: number[];
}

export interface V59Prediction {
  sample: V59LabeledSample;
  probability: number;
  alert: boolean;
  outerFold: string | null;
  configId: string;
  templateId: string;
}

export interface V59MetricSummary {
  metrics: ValidationMetrics;
  cvar95: number | null;
  plus10Bps: ValidationMetrics;
  symbolBreadth: number;
  positiveSymbolRatio: number | null;
}

export interface V59YieldSummary {
  calendarDays: number;
  calendarMonths: number;
  alertsPerWeek: number;
  alertsPerMonth: number;
  activeMonthRatio: number | null;
  medianAlertsPerMonth: number | null;
  p95DroughtDays: number | null;
  maxDroughtDays: number | null;
}

export interface V59CalibrationBucket {
  bucket: string;
  lowerBound: number;
  upperBound: number;
  predictions: number;
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  profitFactor: number | null;
}

export interface V59CalibrationResult {
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  buckets: V59CalibrationBucket[];
  monotonicExpectancy: boolean | null;
}

export interface V59ThresholdEvaluation {
  configId: string;
  templateId: string;
  probabilityThreshold: number;
  metrics: V59MetricSummary;
  yield: V59YieldSummary;
  paretoOptimal: boolean;
}

export interface V59NestedResult {
  folds: PurgedWalkForwardFold[];
  predictions: V59Prediction[];
  alerts: V59LabeledSample[];
  metrics: V59MetricSummary;
  plus10Bps: V59MetricSummary;
  positiveFoldRatio: number | null;
  foldMetrics: Array<{ fold: string; configId: string | null; templateId: string | null; metrics: V59MetricSummary }>;
  selectedConfig: V59ModelConfig | null;
  selectedTemplate: V59RiskTemplate | null;
  selectionAdjustedLcb: number | null;
  promotionLcb: number | null;
  thresholdEvaluations: V59ThresholdEvaluation[];
  calibration: V59CalibrationResult;
}

export interface V59UntouchedResult {
  selectedConfig: V59ModelConfig | null;
  selectedTemplate: V59RiskTemplate | null;
  predictions: V59Prediction[];
  alerts: V59LabeledSample[];
  metrics: V59MetricSummary;
  gate: Record<string, boolean>;
  status: "PASS" | "FAIL" | "INCONCLUSIVE" | "DATA_UNAVAILABLE";
  primary: V59MetricSummary;
  comparison: "YES" | "NO" | "INCONCLUSIVE";
}

export function hasValidExecutionProvenance(
  samples: Pick<V59LabeledSample, "signalTimestamp" | "signalCandleCloseTime" | "executionCandleOpenTime" | "executionReferencePrice" | "executionReferenceSource">[],
): boolean {
  return samples.length > 0 && samples.every((sample) => (
    Number.isFinite(sample.signalTimestamp)
      && sample.signalTimestamp === sample.signalCandleCloseTime
      && Number.isFinite(sample.executionCandleOpenTime)
      && sample.executionCandleOpenTime === sample.signalCandleCloseTime + 1
      && Number.isFinite(sample.executionReferencePrice)
      && sample.executionReferencePrice > 0
      && sample.executionReferenceSource === "BINANCE_15M_NEXT_BAR_OPEN"
  ));
}

const BASE_PARAMETERS: StructuralParameters = {
  breakoutLookback: 20,
  volumeRatioMin: 1.05,
  retestDistanceATR: 0.9,
  maxExtensionATR: 1.2,
  pullbackMinATR: 0.1,
  pullbackMaxATR: 4,
  trendAgeMinBars: 8,
  compressionBarsMin: 4,
  compressionRangeMaxATR: 6,
  expansionVolumeMin: 1.05,
  expansionVolatilityMin: 1.02,
  stopATRMultiplier: 1.25,
  structureLookback: 8,
};

export function buildV59CandidateEvents(
  datasets: HistoricalDataset[],
  startTime: number,
  endTime: number,
  contextDatasets: HistoricalDataset[] = datasets,
): V59CandidateEvent[] {
  const breadth = buildBreadthLookup(contextDatasets, startTime, endTime);
  const btcDataset = contextDatasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const ethDataset = contextDatasets.find((dataset) => dataset.symbol === "ETHUSDT");
  const events: V59CandidateEvent[] = [];
  for (const dataset of datasets) {
    const frames = buildFeatureFrames(dataset, {
      startTime,
      endTime,
      entryStrideBars: 4,
      breadthAt: breadth.at,
      btcDataset,
      ethDataset,
    });
    const candles = dataset.candles["15m"];
    for (const frame of frames) {
      for (const definition of V59_EVENT_REGISTRY) {
        const sides: Side[] = definition.side === "BOTH" ? ["LONG", "SHORT"] : [definition.side];
        for (const side of sides) {
          if (!detectEvent(frame, candles, definition.id, side)) continue;
          events.push({
            eventId: [definition.id, dataset.symbol, side, frame.signalTimestamp].join("|"),
            symbol: dataset.symbol,
            side,
            family: definition.id,
            signalTimestamp: frame.signalTimestamp,
            signalIndex: frame.index,
            frame,
            features: featureVector(frame, side),
          });
        }
      }
    }
  }
  const deduped = dedupeEvents(events).sort((left, right) => left.signalTimestamp - right.signalTimestamp || left.symbol.localeCompare(right.symbol) || left.eventId.localeCompare(right.eventId));
  return [...new Set(deduped.map((event) => event.family))].flatMap((family) => {
    const familyEvents = deduped.filter((event) => event.family === family);
    if (familyEvents.length <= V59_MAX_EVENTS_PER_FAMILY) return familyEvents;
    return familyEvents.filter((_, index) => index % Math.ceil(familyEvents.length / V59_MAX_EVENTS_PER_FAMILY) === 0).slice(0, V59_MAX_EVENTS_PER_FAMILY);
  }).sort((left, right) => left.signalTimestamp - right.signalTimestamp || left.symbol.localeCompare(right.symbol) || left.eventId.localeCompare(right.eventId));
}

export function buildFixedOutcomes(events: V59CandidateEvent[], datasets: HistoricalDataset[]): V59LabeledSample[] {
  const bySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));
  const samples: V59LabeledSample[] = [];
  for (const event of events) {
    const dataset = bySymbol.get(event.symbol);
    if (!dataset) continue;
    for (const template of V59_RISK_TEMPLATES) {
      const outcome = simulateEvent(dataset, event, template);
      if (outcome) samples.push(outcome);
    }
  }
  return samples.sort((left, right) => left.signalTimestamp - right.signalTimestamp || left.eventId.localeCompare(right.eventId) || left.templateId.localeCompare(right.templateId));
}

export function runNestedMetaLabel(samples: V59LabeledSample[], startTime = V59_DEV_START, endTime = V59_DEV_END): V59NestedResult {
  const bounded = samples.filter((sample) => sample.signalTimestamp >= startTime && sample.signalTimestamp <= endTime);
  const folds = createPurgedWalkForwardFolds({ start: startTime, end: endTime, initialTrainMonths: 12, validationMonths: 6, foldCount: 8, purgeHours: V59_PURGE_HOURS });
  const predictions: V59Prediction[] = [];
  const foldMetrics: V59NestedResult["foldMetrics"] = [];
  const series = new Map<string, number[]>();
  for (const fold of folds) {
    const train = bounded.filter((sample) => sample.signalTimestamp >= fold.trainStart && sample.signalTimestamp <= fold.trainEnd);
    const validation = bounded.filter((sample) => isTimestampInWindow(sample.signalTimestamp, fold.validationStart, fold.validationEnd));
    const selection = selectBestConfig(train);
    if (!selection) {
      foldMetrics.push({ fold: fold.id, configId: null, templateId: null, metrics: summarizeMeta([]) });
      continue;
    }
    const model = fitModel(train.filter((sample) => sample.templateId === selection.template.id), selection.config);
    const foldPredictions: V59Prediction[] = [];
    for (const sample of validation.filter((candidate) => candidate.templateId === selection.template.id)) {
      const probability = predictModel(model, sample.features);
      const prediction = { sample, probability, alert: probability >= selection.config.probabilityThreshold, outerFold: fold.id, configId: selection.config.id, templateId: selection.template.id };
      foldPredictions.push(prediction);
      predictions.push(prediction);
    }
    const foldAlerts = foldPredictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
    foldMetrics.push({ fold: fold.id, configId: selection.config.id, templateId: selection.template.id, metrics: summarizeMeta(foldAlerts) });

    for (const config of V59_MODEL_CONFIGS) {
      for (const template of V59_RISK_TEMPLATES) {
        const key = `${config.id}|${template.id}`;
        const fixedModel = fitModel(train.filter((sample) => sample.templateId === template.id), config);
        const fixedAlerts = validation.filter((sample) => sample.templateId === template.id)
          .filter((sample) => predictModel(fixedModel, sample.features) >= config.probabilityThreshold)
          .map((sample) => sample.rMultiple);
        series.set(key, [...(series.get(key) ?? []), ...fixedAlerts]);
      }
    }
  }
  const alerts = predictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
  const metrics = summarizeMeta(alerts);
  const plus10Bps = summarizeMeta(applyAdditionalSlippage(alerts, 10));
  const positiveFoldRatio = foldMetrics.length > 0 ? foldMetrics.filter((fold) => fold.metrics.metrics.netR > 0).length / foldMetrics.length : null;
  const selected = selectBestConfig(bounded);
  const selectedKey = selected ? `${selected.config.id}|${selected.template.id}` : null;
  const selectionAdjustedLcb = selectedKey ? selectionAdjustedLowerConfidenceBound([...series.entries()].map(([candidateId, values]) => ({ candidateId, values })), selectedKey, 1_000, 5) : null;
  const promotionLcb = lcbMinimum([metrics.metrics.lowerConfidenceBound95, plus10Bps.metrics.lowerConfidenceBound95, selectionAdjustedLcb]);
  const thresholdEvaluations = buildThresholdEvaluations(predictions, selected);
  const calibration = assessCalibration(predictions);
  return {
    folds,
    predictions,
    alerts,
    metrics,
    plus10Bps,
    positiveFoldRatio,
    foldMetrics,
    selectedConfig: selected?.config ?? null,
    selectedTemplate: selected?.template ?? null,
    selectionAdjustedLcb,
    promotionLcb,
    thresholdEvaluations,
    calibration,
  };
}

export function runUntouchedValidation(
  events: V59CandidateEvent[],
  outcomes: V59LabeledSample[],
  developmentSamples: V59LabeledSample[],
  nested: V59NestedResult,
  datasets: HistoricalDataset[],
  contextDatasets: HistoricalDataset[],
): V59UntouchedResult {
  if (!nested.selectedConfig || !nested.selectedTemplate || events.length === 0 || outcomes.length === 0) {
    return { selectedConfig: nested.selectedConfig, selectedTemplate: nested.selectedTemplate, predictions: [], alerts: [], metrics: summarizeMeta([]), gate: emptyUntouchedGate(), status: "DATA_UNAVAILABLE", primary: summarizeMeta([]), comparison: "INCONCLUSIVE" };
  }
  const training = developmentSamples.filter((sample) => sample.templateId === nested.selectedTemplate!.id);
  const model = fitModel(training, nested.selectedConfig);
  const holdoutOutcomes = outcomes.filter((sample) => sample.signalTimestamp >= V59_UNTOUCHED_START && sample.signalTimestamp <= V59_UNTOUCHED_END);
  const predictions = holdoutOutcomes.map((sample) => {
    const probability = predictModel(model, sample.features);
    return { sample, probability, alert: probability >= nested.selectedConfig!.probabilityThreshold, outerFold: null, configId: nested.selectedConfig!.id, templateId: nested.selectedTemplate!.id };
  });
  const alerts = predictions.filter((prediction) => prediction.alert).map((prediction) => prediction.sample);
  const metrics = summarizeMeta(alerts);
  const positiveSymbols = new Set(alerts.filter((sample) => sample.rMultiple > 0).map((sample) => sample.symbol));
  const allSymbols = new Set(alerts.map((sample) => sample.symbol));
  const positiveSymbolRatio = allSymbols.size > 0 ? positiveSymbols.size / allSymbols.size : null;
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
  const metaYield = yieldSummary(alerts, V59_UNTOUCHED_START, V59_UNTOUCHED_END);
  const primaryYield = yieldSummary(primary, V59_UNTOUCHED_START, V59_UNTOUCHED_END);
  const comparison = alerts.length < 20 || primary.length < 20
    ? "INCONCLUSIVE"
    : metrics.metrics.avgNetR >= primarySummary.metrics.avgNetR
      && Number.isFinite(metrics.metrics.profitFactor)
      && metrics.metrics.profitFactor >= primarySummary.metrics.profitFactor
      && metaYield.alertsPerMonth >= primaryYield.alertsPerMonth
      ? "YES"
      : "NO";
  return { selectedConfig: nested.selectedConfig, selectedTemplate: nested.selectedTemplate, predictions, alerts, metrics: { ...metrics, positiveSymbolRatio }, gate, status, primary: primarySummary, comparison };
}

export function runPrimaryOnDatasets(datasets: HistoricalDataset[], contextDatasets: HistoricalDataset[] = datasets): V561Trade[] {
  const definition = V561_CANDIDATE_REGISTRY.find((candidate) => candidate.id === V59_PRIMARY_EDGE_ID);
  if (!definition) throw new Error(`Missing frozen Primary ${V59_PRIMARY_EDGE_ID}`);
  const breadth = buildBreadthLookup(contextDatasets, V59_UNTOUCHED_START, V59_UNTOUCHED_END);
  const btcDataset = contextDatasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const ethDataset = contextDatasets.find((dataset) => dataset.symbol === "ETHUSDT");
  const trades: V561Trade[] = [];
  for (const dataset of datasets) {
    const frames = buildFeatureFrames(dataset, { startTime: V59_UNTOUCHED_START, endTime: V59_UNTOUCHED_END, entryStrideBars: 4, breadthAt: breadth.at, btcDataset, ethDataset });
    trades.push(...runIndependentCandidate(dataset, frames, definition, { startTime: V59_UNTOUCHED_START, endTime: V59_UNTOUCHED_END, takerFeeRate: V59_FEE_RATE, slippageBps: V59_BASE_SLIPPAGE_BPS, riskPerTradeUsdt: V59_RISK_PER_TRADE_USDT, cooldownHours: V59_COOLDOWN_HOURS }));
  }
  return trades.sort((left, right) => left.entryTime - right.entryTime || left.symbol.localeCompare(right.symbol));
}

export function summarizeMeta(trades: ValidationTrade[]): V59MetricSummary {
  const metrics = calculateMetrics(trades);
  const positiveSymbols = new Set(trades.filter((trade) => trade.rMultiple > 0).map((trade) => trade.symbol));
  const symbols = new Set(trades.map((trade) => trade.symbol));
  return { metrics, cvar95: calculateCvar95(trades), plus10Bps: calculateMetrics(applyAdditionalSlippage(trades, 10)), symbolBreadth: symbols.size, positiveSymbolRatio: symbols.size > 0 ? positiveSymbols.size / symbols.size : null };
}

export function yieldSummary(trades: ValidationTrade[], start: number, end: number): V59YieldSummary {
  const bounded = trades.filter((trade) => trade.entryTime >= start && trade.entryTime <= end);
  const calendarDays = Math.max(1, (end - start + 1) / 86_400_000);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const calendarMonths = Math.max(1, (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth() + 1);
  const counts = new Map<string, number>();
  for (const trade of bounded) {
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  const monthCounts = [...counts.values()].sort((left, right) => left - right);
  const timestamps = bounded.map((trade) => trade.entryTime).sort((left, right) => left - right);
  const droughts = timestamps.length === 0 ? [calendarDays] : [(timestamps[0] - start) / 86_400_000, ...timestamps.slice(1).map((timestamp, index) => (timestamp - timestamps[index]) / 86_400_000), (end - timestamps.at(-1)!) / 86_400_000];
  const sortedDroughts = droughts.map((value) => Math.max(0, value)).sort((left, right) => left - right);
  const activeMonths = counts.size;
  return {
    calendarDays,
    calendarMonths,
    alertsPerWeek: bounded.length / calendarDays * 7,
    alertsPerMonth: bounded.length / calendarMonths,
    activeMonthRatio: activeMonths / calendarMonths,
    medianAlertsPerMonth: monthCounts.length > 0 ? monthCounts[Math.floor((monthCounts.length - 1) / 2)] : 0,
    p95DroughtDays: percentile(sortedDroughts, 0.95),
    maxDroughtDays: sortedDroughts.at(-1) ?? null,
  };
}

export function assessCalibration(predictions: V59Prediction[]): V59CalibrationResult {
  const definitions = [
    { bucket: "0.50-0.55", lowerBound: 0.5, upperBound: 0.55 },
    { bucket: "0.55-0.60", lowerBound: 0.55, upperBound: 0.6 },
    { bucket: "0.60-0.65", lowerBound: 0.6, upperBound: 0.65 },
    { bucket: ">0.65", lowerBound: 0.65, upperBound: 1.01 },
  ];
  const buckets = definitions.map((definition) => {
    const rows = predictions.filter((prediction) => prediction.probability >= definition.lowerBound && prediction.probability < definition.upperBound);
    const metrics = calculateMetrics(rows.map((prediction) => prediction.sample));
    return { ...definition, predictions: rows.length, trades: rows.length, wins: metrics.wins, winRate: rows.length > 0 ? metrics.winRate : null, avgR: rows.length > 0 ? metrics.avgNetR : null, profitFactor: rows.length > 0 ? (Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null) : null };
  });
  const populated = buckets.filter((bucket) => bucket.trades >= 5 && bucket.avgR !== null);
  if (populated.length < 2) return { status: "INCONCLUSIVE", buckets, monotonicExpectancy: null };
  const monotonicExpectancy = populated.every((bucket, index) => index === 0 || bucket.avgR! >= populated[index - 1].avgR!);
  return { status: monotonicExpectancy ? "PASS" : "FAIL", buckets, monotonicExpectancy };
}

function buildThresholdEvaluations(predictions: V59Prediction[], selected: { config: V59ModelConfig; template: V59RiskTemplate } | null): V59ThresholdEvaluation[] {
  if (!selected) return [];
  const rows = V59_MODEL_CONFIGS.filter((config) => config.family === selected.config.family).map((config) => {
    const alerts = predictions.filter((prediction) => prediction.templateId === selected.template.id && prediction.probability >= config.probabilityThreshold).map((prediction) => prediction.sample);
    return { configId: config.id, templateId: selected.template.id, probabilityThreshold: config.probabilityThreshold, metrics: summarizeMeta(alerts), yield: yieldSummary(alerts, V59_DEV_START, V59_DEV_END), paretoOptimal: false };
  });
  return rows.map((row, index) => ({ ...row, paretoOptimal: !rows.some((other, otherIndex) => otherIndex !== index && dominates(other, row)) }));
}

function dominates(left: V59ThresholdEvaluation, right: V59ThresholdEvaluation): boolean {
  const leftValues = [left.metrics.metrics.avgNetR, left.metrics.metrics.profitFactor, left.metrics.metrics.netR, left.yield.alertsPerMonth];
  const rightValues = [right.metrics.metrics.avgNetR, right.metrics.metrics.profitFactor, right.metrics.metrics.netR, right.yield.alertsPerMonth];
  return leftValues.every((value, index) => value >= rightValues[index]) && leftValues.some((value, index) => value > rightValues[index]);
}

function selectBestConfig(samples: V59LabeledSample[]): { config: V59ModelConfig; template: V59RiskTemplate; score: number } | null {
  if (samples.length === 0) return null;
  const candidates: Array<{ config: V59ModelConfig; template: V59RiskTemplate; score: number }> = [];
  for (const config of V59_MODEL_CONFIGS) {
    for (const template of V59_RISK_TEMPLATES) {
      const scoped = samples.filter((sample) => sample.templateId === template.id);
      if (scoped.length < 10) continue;
      const start = Math.min(...scoped.map((sample) => sample.signalTimestamp));
      const end = Math.max(...scoped.map((sample) => sample.signalTimestamp));
      const folds = createPurgedWalkForwardFolds({ start, end, initialTrainMonths: 12, validationMonths: 6, foldCount: 4, purgeHours: V59_PURGE_HOURS });
      const validationRows: V59LabeledSample[] = [];
      for (const fold of folds) {
        const train = scoped.filter((sample) => sample.signalTimestamp >= fold.trainStart && sample.signalTimestamp <= fold.trainEnd);
        const validation = scoped.filter((sample) => isTimestampInWindow(sample.signalTimestamp, fold.validationStart, fold.validationEnd));
        if (train.length < 10 || validation.length === 0) continue;
        const model = fitModel(train, config);
        validationRows.push(...validation.filter((sample) => predictModel(model, sample.features) >= config.probabilityThreshold));
      }
      const metrics = calculateMetrics(validationRows);
      const yieldValue = yieldSummary(validationRows, start, end);
      const score = validationRows.length === 0 ? Number.NEGATIVE_INFINITY : metrics.avgNetR * 100 + Math.min(metrics.profitFactor, 5) * 4 + Math.min(yieldValue.alertsPerMonth, 5) + (metrics.positiveMonthRatio ?? 0) * 2;
      candidates.push({ config, template, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || right.template.rewardRisk - left.template.rewardRisk || left.config.id.localeCompare(right.config.id));
  return candidates[0] ?? null;
}

interface FittedModel {
  family: V59ModelConfig["family"];
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

function fitModel(samples: V59LabeledSample[], config: V59ModelConfig): FittedModel {
  const width = samples[0]?.features.length ?? 12;
  const means = Array.from({ length: width }, (_, index) => average(samples.map((sample) => sample.features[index])) ?? 0);
  const scales = Array.from({ length: width }, (_, index) => {
    const variance = average(samples.map((sample) => (sample.features[index] - means[index]) ** 2)) ?? 0;
    return Math.sqrt(variance) || 1;
  });
  const labels = samples.map((sample) => sample.label === "POSITIVE" ? 1 : 0);
  const baseProbability = clamp((average(labels) ?? 0.5), 0.01, 0.99);
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
      const loss = leftRows.reduce((sum, sample) => sum + logLoss(left, sample.label === "POSITIVE" ? 1 : 0), 0) + rightRows.reduce((sum, sample) => sum + logLoss(right, sample.label === "POSITIVE" ? 1 : 0), 0);
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

function simulateEvent(dataset: HistoricalDataset, event: V59CandidateEvent, template: V59RiskTemplate): V59LabeledSample | null {
  const candles = dataset.candles["15m"];
  const signal = candles[event.signalIndex];
  const entry = candles[event.signalIndex + 1];
  if (!signal || !entry || entry.openTime !== signal.closeTime + 1 || entry.openTime > V59_UNTOUCHED_END || !Number.isFinite(entry.open)) return null;
  const definition: StructuralCandidateDefinition = {
    id: `V59-${event.family}-${event.side}-${template.id}`,
    side: event.side,
    family: eventFamilyToStructuralFamily(event.family, event.side),
    variant: 1,
    hypothesis: "Fixed V5.9 candidate event execution wrapper",
    marketMechanism: "Fixed event generator and execution template",
    expectedRegime: "DATA_DEFINED",
    entryLogic: "Closed signal candle then next contiguous 15m open",
    invalidationLogic: "Fixed stop/target path",
    expectedHoldingHorizonHours: template.maxHoldHours,
    expectedFailureMode: "Fixed simulation horizon",
    parameters: { ...BASE_PARAMETERS, ...template.parameters },
    stopStyle: template.stopStyle,
    rewardRisk: template.rewardRisk,
  };
  const plan = buildStructuralPlan(candles, event.frame, entry, definition);
  if (!plan || plan.riskPrice <= 0 || !Number.isFinite(plan.riskPrice)) return null;
  const direction = event.side === "LONG" ? 1 : -1;
  const riskUsdt = V59_RISK_PER_TRADE_USDT;
  const quantity = riskUsdt / plan.riskPrice;
  const slippageRate = V59_BASE_SLIPPAGE_BPS / 10_000;
  const entryFill = entry.open * (1 + direction * slippageRate);
  const endIndex = Math.min(candles.length - 1, event.signalIndex + 1 + template.maxHoldHours * 4);
  let exit = candles[endIndex];
  let rawExitPrice = exit.close;
  let exitReason: "STOP" | "TAKE_PROFIT" | "TIME_LIMIT" | "DATA_END" = exit.closeTime >= V59_UNTOUCHED_END ? "TIME_LIMIT" : "DATA_END";
  for (let index = event.signalIndex + 1; index <= endIndex; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > V59_UNTOUCHED_END) break;
    const stopHit = event.side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const targetHit = event.side === "LONG" ? candle.high >= plan.targetPrice : candle.low <= plan.targetPrice;
    if (stopHit) { exit = candle; rawExitPrice = plan.stopPrice; exitReason = "STOP"; break; }
    if (targetHit) { exit = candle; rawExitPrice = plan.targetPrice; exitReason = "TAKE_PROFIT"; break; }
    if (index === endIndex || candle.closeTime >= V59_UNTOUCHED_END) { exit = candle; rawExitPrice = candle.close; exitReason = candle.closeTime >= V59_UNTOUCHED_END ? "TIME_LIMIT" : "DATA_END"; }
  }
  if (!exit || !Number.isFinite(rawExitPrice)) return null;
  const exitFill = rawExitPrice * (1 - direction * slippageRate);
  const grossPnlUsdt = (exitFill - entryFill) * direction * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * V59_FEE_RATE;
  const fundingUsdt = calculateFunding(dataset.fundingRates ?? [], entry.openTime, exit.closeTime, entryFill * quantity, direction);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  const rMultiple = netPnlUsdt / riskUsdt;
  return {
    symbol: dataset.symbol,
    side: event.side,
    entryTime: entry.openTime,
    exitTime: exit.closeTime,
    rMultiple,
    netPnlUsdt,
    pnlUsdt: netPnlUsdt,
    theoreticalRiskUsdt: riskUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt: Math.abs(entry.open - entryFill) * quantity + Math.abs(rawExitPrice - exitFill) * quantity,
    marketRegime: event.frame.marketRegime,
    eventId: event.eventId,
    family: event.family,
    templateId: template.id,
    signalTimestamp: event.signalTimestamp,
    signalIndex: event.signalIndex,
    signalCandleCloseTime: signal.closeTime,
    executionCandleOpenTime: entry.openTime,
    executionReferencePrice: entry.open,
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    entryPrice: entryFill,
    exitPrice: exitFill,
    stopPrice: plan.stopPrice,
    targetPrice: plan.targetPrice,
    riskPrice: plan.riskPrice,
    label: rMultiple > 0 ? "POSITIVE" : "NEGATIVE",
    highQuality: rMultiple >= 0.5,
    features: event.features,
  };
}

function detectEvent(frame: FeatureFrame, candles: Candle[], family: V59EventFamily, side: Side): boolean {
  const index = frame.index;
  if (index < 105 || index >= candles.length - 1) return false;
  const current = candles[index];
  const previous = candles[index - 1];
  const levelHigh = rollingHigh(candles, index - 4, 20);
  const levelLow = rollingLow(candles, index - 4, 20);
  if (!current || !previous || levelHigh === null || levelLow === null || frame.atr <= 0) return false;
  if (family === "FAILED_BREAKOUT_LIQUIDITY_REJECTION") {
    const recent = candles.slice(index - 4, index);
    return side === "SHORT"
      ? recent.some((candle) => candle.high > levelHigh && candle.close > levelHigh) && current.close < levelHigh && current.close < current.open
      : recent.some((candle) => candle.low < levelLow && candle.close < levelLow) && current.close > levelLow && current.close > current.open;
  }
  if (family === "SUPPORT_BREAKDOWN_RETEST") {
    return side === "SHORT" && previous.close < levelLow && current.high >= levelLow - frame.atr * 0.9 && current.close < levelLow;
  }
  if (family === "TREND_PULLBACK_CONTINUATION") {
    const trend = side === "LONG" ? frame.marketRegime === "BULL" : frame.marketRegime === "BEAR";
    const age = side === "LONG" ? frame.bullTrendAge : frame.bearTrendAge;
    const depth = side === "LONG" ? frame.longPullbackDepth : frame.shortPullbackDepth;
    return trend && age >= 8 && depth !== null && depth >= 0.1 && depth <= 4 && (side === "LONG" ? current.close > current.open : current.close < current.open);
  }
  if (family === "VOLATILITY_COMPRESSION_EXPANSION") {
    return frame.compressionBars >= 4 && frame.compressionRangeATR !== null && frame.compressionRangeATR <= 6 && frame.volatilityExpansion !== null && frame.volatilityExpansion >= 1.02 && (side === "LONG" ? current.close > current.open : current.close < current.open);
  }
  const benchmarkWeak = frame.btcRegime === "BEAR" || frame.ethRegime === "BEAR";
  return side === "SHORT" && benchmarkWeak && (frame.breadth === null || frame.breadth <= 0.65) && current.close < current.open;
}

function buildBreadthLookup(datasets: HistoricalDataset[], start: number, end: number): { at: (timestamp: number) => number | null } {
  const buckets = new Map<number, { bullish: number; total: number }>();
  for (const dataset of datasets) {
    const candles = dataset.candles["1h"] ?? [];
    const fast = ema(closes(candles), 20);
    const slow = ema(closes(candles), 50);
    for (let index = 50; index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.closeTime < start || candle.closeTime > end) continue;
      const value = fast[index] !== null && slow[index] !== null ? fast[index]! > slow[index]! ? 1 : 0 : null;
      if (value === null) continue;
      const bucket = buckets.get(candle.closeTime) ?? { bullish: 0, total: 0 };
      bucket.total += 1;
      bucket.bullish += value;
      buckets.set(candle.closeTime, bucket);
    }
  }
  const timestamps = [...buckets.keys()].sort((left, right) => left - right);
  return { at: (timestamp) => {
    let low = 0;
    let high = timestamps.length - 1;
    let result = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (timestamps[middle] <= timestamp) { result = middle; low = middle + 1; } else high = middle - 1;
    }
    if (result < 0) return null;
    const bucket = buckets.get(timestamps[result])!;
    return bucket.total > 0 ? bucket.bullish / bucket.total : null;
  } };
}

function featureVector(frame: FeatureFrame, side: Side): number[] {
  return [
    regimeCode(frame.marketRegime),
    regimeCode(frame.btcRegime),
    regimeCode(frame.ethRegime),
    frame.btcEthAgreement === null ? 0 : frame.btcEthAgreement ? 1 : -1,
    frame.breadth ?? 0.5,
    frame.atrPercentile ?? 0.5,
    frame.volatilityPercentile ?? 0.5,
    clamp(frame.volumeRatio ?? 1, 0, 5),
    (frame.rsi ?? 50) / 100,
    Math.min(240, side === "LONG" ? frame.bullTrendAge : frame.bearTrendAge) / 240,
    clamp(side === "LONG" ? frame.longEntryExtensionATR ?? 0 : frame.shortEntryExtensionATR ?? 0, -2, 2),
    frame.fundingPercentile ?? 0.5,
  ];
}

function regimeCode(value: MarketRegime): number {
  return value === "BULL" ? 1 : value === "BEAR" ? -1 : 0;
}

function calculateFunding(points: FundingRatePoint[], entryTime: number, exitTime: number, notional: number, direction: number): number {
  return points.filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime).reduce((total, point) => total - direction * notional * point.fundingRate, 0);
}

function dedupeEvents(events: V59CandidateEvent[]): V59CandidateEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => { if (seen.has(event.eventId)) return false; seen.add(event.eventId); return true; });
}

function calculateCvar95(trades: ValidationTrade[]): number | null {
  if (trades.length === 0) return null;
  const values = trades.map((trade) => trade.rMultiple).sort((left, right) => left - right);
  const count = Math.max(1, Math.ceil(values.length * 0.05));
  return average(values.slice(0, count));
}

function emptyUntouchedGate(): Record<string, boolean> { return { signals: false, untouchedSymbols: false, netR: false, avgR: false, profitFactor: false, plus10BpsNetR: false, positiveSymbolRatio: false }; }
function lcbMinimum(values: Array<number | null>): number | null { const usable = values.filter((value): value is number => value !== null && Number.isFinite(value)); return usable.length > 0 ? Math.min(...usable) : null; }
function normalize(values: number[], means: number[], scales: number[]): number[] { return values.map((value, index) => (value - (means[index] ?? 0)) / (scales[index] || 1)); }
function dot(left: number[], right: number[]): number { return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0); }
function sigmoid(value: number): number { return 1 / (1 + Math.exp(-clamp(value, -30, 30))); }
function logLoss(probability: number, label: number): number { return -(label * Math.log(probability) + (1 - label) * Math.log(1 - probability)); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function average(values: number[]): number | null { return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function percentile(values: number[], probability: number): number | null { if (values.length === 0) return null; return values[Math.min(values.length - 1, Math.ceil((values.length - 1) * probability))] ?? null; }
function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null { const window = candles.slice(Math.max(0, endExclusive - period), endExclusive); return window.length < period ? null : Math.max(...window.map((candle) => candle.high)); }
function rollingLow(candles: Candle[], endExclusive: number, period: number): number | null { const window = candles.slice(Math.max(0, endExclusive - period), endExclusive); return window.length < period ? null : Math.min(...window.map((candle) => candle.low)); }
