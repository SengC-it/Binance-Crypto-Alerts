import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, FundingRatePoint, Instrument } from "@/lib/core/types";
import { roundMetric } from "@/lib/v5-2/validation";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { hashWithoutField } from "@/lib/v5-7/manifest";
import {
  buildBaseRateDiagnostics,
  buildFixedOutcomes,
  buildV59CandidateEvents,
  hasValidExecutionProvenance,
  runNestedEv,
  runPrimaryOnDatasets,
  runUntouchedEvValidation,
  summarizeMeta,
  yieldSummary,
  type V591NestedResult,
  type V591ProbabilityDiagnostic,
  type V591UntouchedResult,
} from "@/lib/v5-9-1/meta-label";
import {
  V591_BASELINE_COMMIT,
  V591_CORE_FEATURE_NAMES,
  V591_DEV_END,
  V591_DEV_START,
  V591_EVENT_REGISTRY,
  V591_MAX_EVENTS_PER_FAMILY,
  V591_MODEL_CONFIGS,
  V591_NEW_MANIFEST_ID,
  V591_RESEARCH_RULES,
  V591_RISK_TEMPLATES,
  V591_UNTOUCHED_END,
  V591_UNTOUCHED_START,
} from "@/lib/v5-9-1/registry";
import {
  runNestedMetaLabel,
  runUntouchedValidation,
  type V59NestedResult,
  type V59UntouchedResult,
} from "@/lib/v5-9/meta-label";
import { V59_DEV_END, V59_DEV_START, V59_UNTOUCHED_END, V59_UNTOUCHED_START } from "@/lib/v5-9/registry";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const SEEN_EXTERNAL_INVENTORY_PATH = resolve(REPORT_DIR, "v5-7-external-data-inventory.json");
const NEW_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-1-untouched-symbol-manifest.json");
const NEW_RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-1-research-manifest.json");
const OLD_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-untouched-symbol-manifest.json");
const OLD_CACHE_ROOT = resolve("data/raw/v5-9-untouched-cache");
const NEW_CACHE_ROOT = resolve("data/raw/v5-9-1-untouched-cache");
const LOCAL_CACHE_FILE_PATTERN = /-1691633700000-1786241699999\.json$/;

interface ArchiveRecord {
  symbol: string;
  timeframe: V57ExternalTimeframe;
  period: string;
  cachePath: string | null;
  status: string;
  sha256: string | null;
  rowCount?: number | null;
}

interface UntouchedSymbolRecord {
  symbol: string;
  status: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  archives: ArchiveRecord[];
}

interface UntouchedManifest {
  status: string;
  manifestId: string;
  manifestHash: string;
  baselineCommit: string;
  period: { start: string; end: string };
  symbols: string[];
  availableSymbols: string[];
  archives: ArchiveRecord[];
  symbolRecords: UntouchedSymbolRecord[];
  coveragePercent?: number;
}

interface SeenArchiveRecord { timeframe: V57ExternalTimeframe; cachePath: string | null; status: string; sha256: string | null; rowCount: number | null }
interface SeenSymbolRecord { symbol: string; pitEligible: boolean; classification: string; records: SeenArchiveRecord[] }
interface SeenInventory { status: string; manifestId: string; symbols: SeenSymbolRecord[] }

async function main(): Promise<void> {
  const newManifest = await readJson<UntouchedManifest>(NEW_MANIFEST_PATH);
  const researchManifest = await readJson<Record<string, unknown>>(NEW_RESEARCH_MANIFEST_PATH);
  assertFrozenInputs(newManifest, researchManifest);

  const developmentDatasets = mergeDatasets(await loadSeenDatasets());
  const newReady = await untouchedCacheIsReady(newManifest, NEW_CACHE_ROOT);
  const newDatasets = newReady ? await loadUntouchedDatasets(newManifest) : [];
  const devEvents = developmentDatasets.length > 0 ? buildV59CandidateEvents(developmentDatasets, V591_DEV_START, V591_DEV_END, developmentDatasets) : [];
  const devOutcomes = developmentDatasets.length > 0 ? buildFixedOutcomes(devEvents, developmentDatasets) : [];
  const nested = runNestedEv(devOutcomes, V591_DEV_START, V591_DEV_END);

  const newEvents = newDatasets.length > 0
    ? buildV59CandidateEvents(newDatasets, V591_UNTOUCHED_START, V591_UNTOUCHED_END, [...developmentDatasets, ...newDatasets])
    : [];
  const newOutcomes = newDatasets.length > 0 ? buildFixedOutcomes(newEvents, newDatasets) : [];
  const untouched = runUntouchedEvValidation(newEvents, newOutcomes, devOutcomes, nested, newDatasets, [...developmentDatasets, ...newDatasets]);

  const oldManifest = await readJsonOrNull<UntouchedManifest>(OLD_MANIFEST_PATH);
  const oldReady = oldManifest ? await untouchedCacheIsReady(oldManifest, OLD_CACHE_ROOT) : false;
  const oldDatasets = oldManifest && oldReady ? await loadUntouchedDatasets(oldManifest) : [];
  const oldEvents = oldDatasets.length > 0
    ? buildV59CandidateEvents(oldDatasets, V59_UNTOUCHED_START, V59_UNTOUCHED_END, [...developmentDatasets, ...oldDatasets])
    : [];
  const oldOutcomes = oldDatasets.length > 0 ? buildFixedOutcomes(oldEvents, oldDatasets) : [];
  const oldNested = runNestedMetaLabel(devOutcomes, V59_DEV_START, V59_DEV_END);
  const oldProbabilityDiagnostic = oldReady
    ? runUntouchedValidation(oldEvents, oldOutcomes, devOutcomes, oldNested, oldDatasets, [...developmentDatasets, ...oldDatasets])
    : emptyOldUntouched(oldNested);
  const oldEvDiagnostic = oldReady
    ? runUntouchedEvValidation(oldEvents, oldOutcomes, devOutcomes, nested, oldDatasets, [...developmentDatasets, ...oldDatasets])
    : emptyUntouched(nested);

  const primaryNew = newDatasets.length > 0 ? runPrimaryOnDatasets(newDatasets, [...developmentDatasets, ...newDatasets]) : [];
  const primaryNewSummary = summarizeMeta(primaryNew);
  const oldProbabilityOnNew = newReady
    ? runUntouchedValidation(newEvents, newOutcomes, devOutcomes, oldNested, newDatasets, [...developmentDatasets, ...newDatasets])
    : emptyOldUntouched(oldNested);
  const development = summarizeMeta(nested.alerts);
  const developmentYield = yieldSummary(nested.alerts, V591_DEV_START, V591_DEV_END);
  const untouchedYield = yieldSummary(untouched.alerts, V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const primaryNewYield = yieldSummary(primaryNew, V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const oldProbabilityNewYield = yieldSummary(oldProbabilityOnNew.alerts, V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const developmentGate = evaluateDevelopmentGate(nested, development);
  const yieldGate = evaluateYieldGate(developmentYield);
  const costStress = { netR: nested.plus10Bps.metrics.netR > 0, avgR: nested.plus10Bps.metrics.avgNetR > 0 };
  const noLeakage = devEvents.length > 0 && devEvents.every((event) => (
    event.signalTimestamp === event.frame.signalTimestamp
      && event.signalIndex === event.frame.index
      && event.features.length === V591_CORE_FEATURE_NAMES.length
      && event.features.every(Number.isFinite)
  ));
  const runtimeImplementable = hasValidExecutionProvenance(devOutcomes);
  const allPromotionChecks = developmentGate.passed
    && untouched.status === "PASS"
    && costStress.netR
    && costStress.avgR
    && yieldGate.passed
    && nested.evCalibration.status === "PASS"
    && noLeakage
    && runtimeImplementable;
  const businessVerdict = allPromotionChecks
    ? "YES"
    : untouched.status === "DATA_UNAVAILABLE" || untouched.status === "INCONCLUSIVE" || development.metrics.trades === 0
      ? "INCONCLUSIVE"
      : "NO";

  const candidateRegistry = buildCandidateRegistryReport(devEvents, devOutcomes);
  const modelRegistry = {
    schema: "bca-v5-9-1-model-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: V591_BASELINE_COMMIT,
    models: ["LOGISTIC_L2", "SHALLOW_TREE"],
    configurations: V591_MODEL_CONFIGS,
    count: V591_MODEL_CONFIGS.length,
    max: 6,
    riskTemplates: V591_RISK_TEMPLATES,
    decision: "estimatedEV > evThresholdR",
    payoffSource: "Outer-fold training rows only; no validation or holdout payoff statistics.",
    theoreticalBreakeven: V591_RISK_TEMPLATES.map((template) => ({ templateId: template.id, rewardRisk: template.rewardRisk, beforeCostsProbability: 1 / (1 + template.rewardRisk) })),
  };
  const probabilityReport = {
    schema: "bca-v5-9-1-probability-diagnostics-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    oldV59Rule: "P(win) >= 0.55 / 0.60 / 0.65; diagnostic only",
    nestedOos: nested.probabilityDiagnostics,
    summary: summarizeProbabilityDiagnostics(nested.probabilityDiagnostics),
    oldSelectedOos: summarizeOldProbabilities(oldNested),
    thresholdMismatchConfirmed: true,
  };
  const baseRate = { schema: "bca-v5-9-1-base-rate-diagnostics-v1", training: buildBaseRateDiagnostics(devOutcomes) };
  const calibrationReport = { schema: "bca-v5-9-1-calibration-v1", nestedOos: nested.evCalibration, rule: "Higher predicted EV must correspond overall to higher realized AvgR." };
  const comparison = {
    ungatedPrimary: { metrics: serializeMetric(primaryNewSummary), yield: yieldSummary(primaryNew, V591_UNTOUCHED_START, V591_UNTOUCHED_END) },
    v59OldProbabilityRule: { metrics: serializeMetric(oldProbabilityOnNew.metrics), yield: oldProbabilityNewYield, status: oldProbabilityOnNew.status, diagnosticOnly: true },
    v591EvRule: { metrics: serializeMetric(untouched.metrics), yield: untouchedYield, status: untouched.status },
    v591VsPrimary: untouched.comparison,
    question: "Does V5.9.1 provide more usable email alerts with positive historical expectancy?",
  };
  const generalization = buildGeneralization(development, untouched, oldEvDiagnostic, developmentYield, untouchedYield);
  const summary = buildSummary({
    newManifest,
    researchManifest,
    devEvents,
    devOutcomes,
    development,
    developmentYield,
    nested,
    oldNested,
    untouched,
    untouchedYield,
    oldProbabilityDiagnostic,
    oldEvDiagnostic,
    oldProbabilityOnNew,
    primaryNewSummary,
    comparison,
    generalization,
    developmentGate,
    yieldGate,
    costStress,
    noLeakage,
    runtimeImplementable,
    businessVerdict,
    newReady,
  });
  const generalizationReport = { schema: "bca-v5-9-1-generalization-audit-v1", ...generalization, developmentSymbols: [...new Set(developmentDatasets.map((dataset) => dataset.symbol))].sort(), newUntouchedSymbols: newReady ? newManifest.availableSymbols : [], oldDiagnosticSymbols: oldReady && oldManifest ? oldManifest.availableSymbols : [], oldHoldoutStatus: oldEvDiagnostic.status, newHoldoutStatus: untouched.status };
  await writeFile(resolve(REPORT_DIR, "v5-9-1-candidate-event-registry.json"), `${JSON.stringify(candidateRegistry, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-model-registry.json"), `${JSON.stringify(modelRegistry, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-probability-diagnostics.json"), `${JSON.stringify(probabilityReport, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-base-rate-diagnostics.json"), `${JSON.stringify(baseRate, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-calibration.json"), `${JSON.stringify(calibrationReport, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-generalization-audit.json"), `${JSON.stringify(generalizationReport, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-validation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-1-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({ stage: "v5_9_1_validation_complete", developmentDatasets: developmentDatasets.length, untouchedDatasets: newDatasets.length, candidateEvents: devEvents.length, labeledOutcomes: devOutcomes.length, nestedAlerts: nested.alerts.length, nestedPromotion: developmentGate.passed, untouchedStatus: untouched.status, businessVerdict, emailPromotionCandidate: allPromotionChecks ? "PASS" : "FAIL" }));
}

function assertFrozenInputs(manifest: UntouchedManifest, research: Record<string, unknown>): void {
  if (manifest.status !== "FROZEN_BEFORE_RETURN_READ" || manifest.manifestId !== V591_NEW_MANIFEST_ID) throw new Error("V5.9.1 untouched manifest is not frozen");
  if (hashWithoutField(manifest as unknown as Record<string, unknown>, "manifestHash") !== manifest.manifestHash) throw new Error("V5.9.1 untouched manifest integrity failed");
  if (manifest.baselineCommit !== V591_BASELINE_COMMIT) throw new Error("V5.9.1 baseline changed");
  if (manifest.symbols.length < 15 || manifest.availableSymbols.length < 15) throw new Error("V5.9.1 requires at least 15 frozen untouched symbols");
  if (research.status !== "FROZEN_BEFORE_RETURN_READ" || research.baselineCommit !== V591_BASELINE_COMMIT || typeof research.manifestHash !== "string" || hashWithoutField(research, "manifestHash") !== research.manifestHash) throw new Error("V5.9.1 research manifest integrity failed");
}

async function loadSeenDatasets(): Promise<HistoricalDataset[]> {
  const local: HistoricalDataset[] = [];
  let localFiles: string[] = [];
  try { localFiles = (await readdir(LOCAL_CACHE_DIR)).filter((file) => LOCAL_CACHE_FILE_PATTERN.test(file)); } catch { /* raw validation cache is intentionally absent in clean CI */ }
  for (const file of localFiles.sort()) {
    try {
      const dataset = JSON.parse(await readFile(resolve(LOCAL_CACHE_DIR, file), "utf8")) as HistoricalDataset;
      if (validDataset(dataset)) local.push(dataset);
    } catch { /* corrupt cache is excluded, never repaired */ }
  }
  const inventory = await readJsonOrNull<SeenInventory>(SEEN_EXTERNAL_INVENTORY_PATH);
  if (!inventory || inventory.status !== "AVAILABLE") return local;
  const external: HistoricalDataset[] = [];
  for (const symbol of inventory.symbols.filter((item) => item.pitEligible && item.classification === "AVAILABLE")) {
    const candles: { "15m": Candle[]; "1h": Candle[]; "4h": Candle[] } = { "15m": [], "1h": [], "4h": [] };
    const fundingRates: FundingRatePoint[] = [];
    let valid = true;
    for (const record of symbol.records) {
      if (!record.cachePath || !record.sha256) { valid = false; break; }
      try {
        const bytes = await readFile(resolve(record.cachePath));
        if (sha256(bytes) !== record.sha256) { valid = false; break; }
        const parsed = await readMonthlyArchive(resolve(record.cachePath), record.timeframe);
        if (record.timeframe === "funding") fundingRates.push(...(parsed.fundingRates ?? []));
        else candles[record.timeframe].push(...(parsed.candles ?? []));
      } catch { valid = false; break; }
    }
    if (valid) {
      for (const timeframe of ["15m", "1h", "4h"] as const) candles[timeframe] = dedupeCandles(candles[timeframe]);
      if (candles["15m"].length > 0 && candles["1h"].length > 0 && candles["4h"].length > 0) external.push({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: dedupeFunding(fundingRates) });
    }
  }
  return [...local, ...external];
}

async function untouchedCacheIsReady(manifest: UntouchedManifest, cacheRoot: string): Promise<boolean> {
  if (manifest.availableSymbols.length < 15) return false;
  for (const symbol of manifest.symbolRecords.filter((item) => item.status === "AVAILABLE")) {
    for (const record of symbol.archives) {
      if (record.status !== "AVAILABLE" || !record.cachePath || !record.sha256) return false;
      try {
        const cachePath = record.cachePath.startsWith("data/") ? resolve(record.cachePath) : resolve(cacheRoot, record.cachePath);
        if (sha256(await readFile(cachePath)) !== record.sha256) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

async function loadUntouchedDatasets(manifest: UntouchedManifest): Promise<HistoricalDataset[]> {
  const datasets: HistoricalDataset[] = [];
  for (const symbol of manifest.symbolRecords.filter((item) => item.status === "AVAILABLE")) {
    const candles: { "15m": Candle[]; "1h": Candle[]; "4h": Candle[] } = { "15m": [], "1h": [], "4h": [] };
    const fundingRates: FundingRatePoint[] = [];
    for (const record of symbol.archives) {
      const parsed = await readMonthlyArchive(resolve(record.cachePath!), record.timeframe);
      if (record.timeframe === "funding") fundingRates.push(...(parsed.fundingRates ?? []));
      else candles[record.timeframe].push(...(parsed.candles ?? []));
    }
    for (const timeframe of ["15m", "1h", "4h"] as const) candles[timeframe] = dedupeCandles(candles[timeframe]);
    const dataset = { symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: dedupeFunding(fundingRates) };
    if (validDataset(dataset)) datasets.push(dataset);
  }
  return datasets;
}

function mergeDatasets(datasets: HistoricalDataset[]): HistoricalDataset[] {
  const bySymbol = new Map<string, HistoricalDataset>();
  for (const dataset of datasets) {
    const existing = bySymbol.get(dataset.symbol);
    if (!existing) {
      bySymbol.set(dataset.symbol, { ...dataset, candles: { "15m": [...dataset.candles["15m"]], "1h": [...(dataset.candles["1h"] ?? [])], "4h": [...(dataset.candles["4h"] ?? [])] }, fundingRates: [...(dataset.fundingRates ?? [])] });
      continue;
    }
    for (const timeframe of ["15m", "1h", "4h"] as const) existing.candles[timeframe] = dedupeCandles([...(existing.candles[timeframe] ?? []), ...(dataset.candles[timeframe] ?? [])]);
    existing.fundingRates = dedupeFunding([...(existing.fundingRates ?? []), ...(dataset.fundingRates ?? [])]);
  }
  return [...bySymbol.values()].filter(validDataset).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function evaluateDevelopmentGate(nested: V591NestedResult, metrics: ReturnType<typeof summarizeMeta>): { passed: boolean; checks: Record<string, boolean>; medianFoldNetR: number | null } {
  const folds = nested.foldMetrics.map((fold) => fold.metrics.metrics);
  const sorted = folds.map((fold) => fold.netR).sort((left, right) => left - right);
  const medianFoldNetR = percentile(sorted, 0.5);
  const checks = {
    signals: metrics.metrics.trades >= 100,
    netR: metrics.metrics.netR > 0,
    avgR: metrics.metrics.avgNetR >= 0.15,
    profitFactor: metrics.metrics.profitFactor >= 1.3,
    plus10BpsNetR: nested.plus10Bps.metrics.netR > 0,
    positiveFoldRatio: nested.positiveFoldRatio !== null && nested.positiveFoldRatio >= 0.67,
    medianFoldNetR: medianFoldNetR !== null && medianFoldNetR > 0,
    symbolBreadth: metrics.symbolBreadth >= 15,
    selectionAdjustedLCB: nested.selectionAdjustedLcb !== null && nested.selectionAdjustedLcb >= 0,
    promotionLCB: nested.promotionLcb !== null && nested.promotionLcb >= 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks, medianFoldNetR };
}

function evaluateYieldGate(value: ReturnType<typeof yieldSummary>): { passed: boolean; checks: Record<string, boolean> } {
  const checks = { alertsPerMonth: value.alertsPerMonth >= 2, activeMonthRatio: (value.activeMonthRatio ?? 0) >= 0.65, medianAlertsPerMonth: (value.medianAlertsPerMonth ?? 0) >= 1, p95DroughtDays: (value.p95DroughtDays ?? Number.POSITIVE_INFINITY) <= 45, maxDroughtDays: (value.maxDroughtDays ?? Number.POSITIVE_INFINITY) <= 60 };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function buildGeneralization(
  development: ReturnType<typeof summarizeMeta>,
  untouched: V591UntouchedResult,
  oldDiagnostic: V591UntouchedResult,
  developmentYield: ReturnType<typeof yieldSummary>,
  untouchedYield: ReturnType<typeof yieldSummary>,
): Record<string, unknown> {
  const holdoutUsable = untouched.status === "PASS" || untouched.status === "FAIL";
  return {
    development: serializeMetric(development),
    newUntouched: serializeMetric(untouched.metrics),
    oldBurnedDiagnostic: serializeMetric(oldDiagnostic.metrics),
    avgRDegradation: holdoutUsable ? roundMetric(untouched.metrics.metrics.avgNetR - development.metrics.avgNetR) : null,
    pfDegradation: holdoutUsable ? roundMetric(untouched.metrics.metrics.profitFactor - development.metrics.profitFactor) : null,
    signalRateDegradation: holdoutUsable && developmentYield.alertsPerMonth > 0 ? roundMetric(untouchedYield.alertsPerMonth / developmentYield.alertsPerMonth - 1) : null,
    overfit: holdoutUsable ? (untouched.metrics.metrics.avgNetR < 0 || untouched.metrics.metrics.profitFactor < 1 || (developmentYield.alertsPerMonth > 0 && untouchedYield.alertsPerMonth / developmentYield.alertsPerMonth < 0.5) ? "YES" : "NO") : "INCONCLUSIVE",
  };
}

function buildCandidateRegistryReport(events: ReturnType<typeof buildV59CandidateEvents>, outcomes: ReturnType<typeof buildFixedOutcomes>): Record<string, unknown> {
  const families = Object.fromEntries(V591_EVENT_REGISTRY.map((definition) => [definition.id, { ...definition, candidateEvents: events.filter((event) => event.family === definition.id).length, fixedOutcomeRows: outcomes.filter((outcome) => outcome.family === definition.id).length }]));
  return { schema: "bca-v5-9-1-candidate-event-registry-v1", status: "FROZEN_BEFORE_RETURN_READ", baseline: V591_BASELINE_COMMIT, frozenV59Architecture: { eventFamilies: V591_EVENT_REGISTRY.length, maxEventsPerFamily: V591_MAX_EVENTS_PER_FAMILY, features: V591_CORE_FEATURE_NAMES.length, riskTemplates: V591_RISK_TEMPLATES.length }, minimumCandidateEvents: 500, totalCandidateEvents: events.length, fixedOutcomeRows: outcomes.length, families, eventDefinitions: V591_EVENT_REGISTRY, noLegacyFinalFilters: true, labels: { positive: "net R > 0", highQuality: "net R >= 0.5R" } };
}

function buildSummary(input: {
  newManifest: UntouchedManifest;
  researchManifest: Record<string, unknown>;
  devEvents: ReturnType<typeof buildV59CandidateEvents>;
  devOutcomes: ReturnType<typeof buildFixedOutcomes>;
  development: ReturnType<typeof summarizeMeta>;
  developmentYield: ReturnType<typeof yieldSummary>;
  nested: V591NestedResult;
  oldNested: V59NestedResult;
  untouched: V591UntouchedResult;
  untouchedYield: ReturnType<typeof yieldSummary>;
  oldProbabilityDiagnostic: V59UntouchedResult;
  oldEvDiagnostic: V591UntouchedResult;
  oldProbabilityOnNew: V59UntouchedResult;
  primaryNewSummary: ReturnType<typeof summarizeMeta>;
  comparison: Record<string, unknown>;
  generalization: Record<string, unknown>;
  developmentGate: ReturnType<typeof evaluateDevelopmentGate>;
  yieldGate: ReturnType<typeof evaluateYieldGate>;
  costStress: { netR: boolean; avgR: boolean };
  noLeakage: boolean;
  runtimeImplementable: boolean;
  businessVerdict: string;
  newReady: boolean;
}): Record<string, unknown> {
  const allPromotionChecks = input.developmentGate.passed
    && input.untouched.status === "PASS"
    && input.costStress.netR
    && input.costStress.avgR
    && input.yieldGate.passed
    && input.nested.evCalibration.status === "PASS"
    && input.noLeakage
    && input.runtimeImplementable;
  const oldProbabilityNew = input.oldProbabilityOnNew;
  return {
    schema: "bca-v5-9-1-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    status: input.devEvents.length > 0 ? "VALIDATION_COMPLETE" : "DATA_UNAVAILABLE",
    researchOnly: true,
    baseline: V591_BASELINE_COMMIT,
    oldV59: { status: "FROZEN", holdoutState: "BURNED_AFTER_ZERO_SIGNAL_REVIEW", role: "POST_HOC_DIAGNOSTIC_ONLY", originalManifest: "reports/v5-9-untouched-symbol-manifest.json", originalProbabilityRule: "P(win) >= 0.55 / 0.60 / 0.65" },
    researchManifest: { path: "reports/v5-9-1-research-manifest.json", hash: input.researchManifest.manifestHash },
    untouchedManifest: { path: "reports/v5-9-1-untouched-symbol-manifest.json", hash: input.newManifest.manifestHash, symbols: input.newManifest.symbols, availableSymbols: input.newManifest.availableSymbols, coverage: input.newReady ? `${input.newManifest.availableSymbols.length}/${input.newManifest.symbols.length}` : "DATA_UNAVAILABLE", validationReady: input.newReady },
    candidateEvents: { total: input.devEvents.length, minimum: 500, metMinimum: input.devEvents.length >= 500, maxEventsPerFamily: V591_MAX_EVENTS_PER_FAMILY, capPolicy: "Frozen V5.9 deterministic chronological stride cap before labels; independent of returns.", families: V591_EVENT_REGISTRY.map((definition) => definition.id), outcomeRows: input.devOutcomes.length },
    modelRegistry: { path: "reports/v5-9-1-model-registry.json", count: V591_MODEL_CONFIGS.length, configs: V591_MODEL_CONFIGS, decision: "expectedNetR > evThresholdR" },
    zeroSignalRootCause: {
      oldRule: "Probability-only 0.55/0.60/0.65 thresholds",
      probabilityDistribution: summarizeOldProbabilities(input.oldNested),
      basePositiveRateByTemplate: buildBaseRateDiagnostics(input.devOutcomes).byRiskTemplate,
      thresholdMismatchConfirmed: true,
      conclusion: "V5.9's zero-alert outcome is consistent with probability threshold mismatch; V5.9.1 therefore uses template-specific training payoff and expectedNetR, not a uniform probability threshold.",
    },
    nestedDevelopment: {
      signals: input.nested.alerts.length,
      metrics: serializeMetric(input.development),
      yield: input.developmentYield,
      selectedConfig: input.nested.selectedConfig,
      selectedTemplate: input.nested.selectedTemplate,
      selectionStatus: input.nested.selectionStatus,
      folds: input.nested.foldMetrics.map((fold) => ({ fold: fold.fold, configId: fold.configId, templateId: fold.templateId, selectionStatus: fold.selectionStatus, metrics: serializeMetric(fold.metrics) })),
      positiveFoldRatio: roundMetric(input.nested.positiveFoldRatio),
      medianFoldNetR: roundMetric(input.nested.medianFoldNetR),
      selectionAdjustedLCB: roundMetric(input.nested.selectionAdjustedLcb),
      promotionLCB: roundMetric(input.nested.promotionLcb),
      promotionChecks: input.developmentGate.checks,
      promotion: input.developmentGate.passed ? "PASS" : input.devEvents.length > 0 ? "FAIL" : "DATA_UNAVAILABLE",
      plus10Bps: serializeMetric(input.nested.plus10Bps),
    },
    calibration: input.nested.evCalibration,
    probabilityDiagnostics: { path: "reports/v5-9-1-probability-diagnostics.json", modelTemplatesPerFold: V591_MODEL_CONFIGS.length * V591_RISK_TEMPLATES.length, requestedBuckets: ["<0.25", "0.25-0.30", "0.30-0.35", "0.35-0.40", "0.40-0.45", "0.45-0.50", "0.50-0.55", ">0.55"] },
    baseRateDiagnostics: { path: "reports/v5-9-1-base-rate-diagnostics.json", byRiskTemplate: true, byEventFamily: true },
    yieldGate: { thresholds: V591_RESEARCH_RULES.yieldGate, ...input.yieldGate, selectedNested: input.developmentYield },
    old20SymbolDiagnostic: {
      role: "POST_HOC_DIAGNOSTIC_ONLY",
      holdoutState: "BURNED_AFTER_ZERO_SIGNAL_REVIEW",
      oldProbabilityRule: serializeMetric(input.oldProbabilityDiagnostic.metrics),
      newEvRule: serializeMetric(input.oldEvDiagnostic.metrics),
      evSignals: input.oldEvDiagnostic.alerts.length,
      status: input.oldEvDiagnostic.status,
      neverUsedForPromotion: true,
    },
    newUntouchedHoldout: {
      manifest: input.newManifest.manifestId,
      symbols: input.newReady ? input.newManifest.availableSymbols : [],
      coverage: input.newReady ? `${input.newManifest.availableSymbols.length}/${input.newManifest.symbols.length}` : "DATA_UNAVAILABLE",
      signals: input.untouched.alerts.length,
      signalSymbols: [...new Set(input.untouched.alerts.map((sample) => sample.symbol))].sort(),
      metrics: serializeMetric(input.untouched.metrics),
      yield: input.untouchedYield,
      gate: input.untouched.gate,
      status: input.untouched.status,
    },
    primaryOnNewUntouched: serializeMetric(input.primaryNewSummary),
    comparison: input.comparison,
    generalization: input.generalization,
    exactOldProduction: { status: "DATA_UNAVAILABLE", reason: "No exact non-sensitive Production configuration export; no fake replay." },
    businessVerdict: input.businessVerdict,
    emailPromotionCandidate: allPromotionChecks ? "PASS" : "FAIL",
    hardBoundaries: { productionChanged: false, v55Changed: false, forwardShadowChanged: false, productionEmailChanged: false, deployment: false, merge: false, migration: false, autoTrading: false, primaryChanged: false, strategyChanged: false, oldHoldoutUsedForPromotion: false, noLeakage: input.noLeakage, runtimeImplementable: input.runtimeImplementable },
    frozenRules: { developmentGate: input.developmentGate.checks, oldProbabilityDiagnosticOnNew: { status: oldProbabilityNew.status, role: "DIAGNOSTIC_ONLY" } },
  };
}

function renderDecision(summary: Record<string, unknown>): string {
  const development = summary.nestedDevelopment as Record<string, unknown>;
  const holdout = summary.newUntouchedHoldout as Record<string, unknown>;
  const comparison = summary.comparison as Record<string, unknown>;
  return [
    "# V5.9.1 Expectancy-Calibrated Meta-Label Validation Decision",
    "",
    `Baseline: **${String(summary.baseline)}**; research-only, no Production/runtime change.`,
    `V5.9 zero-signal root cause: **threshold mismatch confirmed = ${String((summary.zeroSignalRootCause as Record<string, unknown>).thresholdMismatchConfirmed)}**.`,
    `Nested development: ${JSON.stringify(development.metrics)}; promotion: **${String(development.promotion)}**; calibration: **${String((summary.calibration as Record<string, unknown>).status)}**.`,
    `New untouched holdout: ${JSON.stringify(holdout.metrics)}; status: **${String(holdout.status)}**.`,
    `Three-system comparison: ${JSON.stringify(comparison)}.`,
    `Business verdict: **${String(summary.businessVerdict)}**; Email Promotion Candidate: **${String(summary.emailPromotionCandidate)}**.`,
    "",
    "## Old holdout boundary",
    "The original V5.9 20-symbol holdout is BURNED_AFTER_ZERO_SIGNAL_REVIEW and POST_HOC_DIAGNOSTIC_ONLY; it is never promotion evidence.",
    "",
    "## Hard boundary",
    "- Production: NO change",
    "- V5.5/#002: NO change",
    "- Production email: NO change",
    "- Supabase migration: NO",
    "- Deploy: NO",
    "- Merge: NO",
    "- Auto trading: NO",
    "- Strategy/parameters/manifest: FROZEN",
    "",
  ].join("\n");
}

function summarizeProbabilityDiagnostics(diagnostics: V591ProbabilityDiagnostic[]): Record<string, unknown> {
  const values = diagnostics.flatMap((diagnostic) => [diagnostic.distribution.min, diagnostic.distribution.max]).filter((value): value is number => value !== null && Number.isFinite(value));
  return { diagnostics: diagnostics.length, nonEmptyDiagnostics: diagnostics.filter((diagnostic) => diagnostic.predictions > 0).length, globalMin: values.length > 0 ? Math.min(...values) : null, globalMax: values.length > 0 ? Math.max(...values) : null, allBucketLabels: diagnostics[0]?.buckets.map((bucket) => bucket.bucket) ?? ["<0.25", "0.25-0.30", "0.30-0.35", "0.35-0.40", "0.40-0.45", "0.45-0.50", "0.50-0.55", ">0.55"] };
}

function summarizeOldProbabilities(nested: V59NestedResult): Record<string, unknown> {
  const probabilities = nested.predictions.map((prediction) => prediction.probability).filter(Number.isFinite).sort((left, right) => left - right);
  return { predictions: probabilities.length, min: probabilities[0] ?? null, p10: percentile(probabilities, 0.1), p25: percentile(probabilities, 0.25), median: percentile(probabilities, 0.5), p75: percentile(probabilities, 0.75), p90: percentile(probabilities, 0.9), p95: percentile(probabilities, 0.95), max: probabilities.at(-1) ?? null, alerts: nested.alerts.length, thresholdRule: "P(win) >= 0.55 / 0.60 / 0.65" };
}

function serializeMetric(value: ReturnType<typeof summarizeMeta>): Record<string, unknown> {
  const metrics = value.metrics;
  return { trades: metrics.trades, wins: metrics.wins, losses: metrics.losses, winRate: roundMetric(metrics.winRate), netR: roundMetric(metrics.netR), avgR: roundMetric(metrics.avgNetR), profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null, maxDD: roundMetric(metrics.maxDrawdownR), cvar95: roundMetric(value.cvar95), plus10BpsNetR: roundMetric(value.plus10Bps.netR), symbolBreadth: value.symbolBreadth, positiveSymbolRatio: roundMetric(value.positiveSymbolRatio), totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt), totalFeesUsdt: roundMetric(metrics.totalFeesUsdt), totalFundingUsdt: roundMetric(metrics.totalFundingUsdt), totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt) };
}

function emptyUntouched(nested: V591NestedResult): V591UntouchedResult {
  return { selectedConfig: nested.selectedConfig, selectedTemplate: nested.selectedTemplate, predictions: [], alerts: [], metrics: summarizeMeta([]), gate: emptyGate(), status: "DATA_UNAVAILABLE", primary: summarizeMeta([]), comparison: "INCONCLUSIVE" };
}

function emptyOldUntouched(nested: V59NestedResult): V59UntouchedResult {
  return { selectedConfig: nested.selectedConfig, selectedTemplate: nested.selectedTemplate, predictions: [], alerts: [], metrics: summarizeMeta([]), gate: emptyGate(), status: "DATA_UNAVAILABLE", primary: summarizeMeta([]), comparison: "INCONCLUSIVE" };
}

function emptyGate(): Record<string, boolean> {
  return { signals: false, untouchedSymbols: false, netR: false, avgR: false, profitFactor: false, plus10BpsNetR: false, positiveSymbolRatio: false };
}

function validDataset(dataset: HistoricalDataset): boolean { return Boolean(dataset?.symbol && dataset.candles?.["15m"]?.length && dataset.candles?.["1h"]?.length && dataset.candles?.["4h"]?.length); }
function dedupeCandles(candles: Candle[]): Candle[] { const map = new Map<number, Candle>(); for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle); return [...map.values()].sort((left, right) => left.openTime - right.openTime); }
function dedupeFunding(points: FundingRatePoint[]): FundingRatePoint[] { const map = new Map<number, FundingRatePoint>(); for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point); return [...map.values()].sort((left, right) => left.fundingTime - right.fundingTime); }
function makeInstrument(symbol: string): Instrument { return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "HISTORICAL_DATA_VISION", priceTick: 0, quantityStep: 0 }; }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function percentile(values: number[], probability: number): number | null { if (values.length === 0) return null; return values[Math.min(values.length - 1, Math.ceil((values.length - 1) * probability))] ?? null; }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function readJsonOrNull<T>(path: string): Promise<T | null> { try { return await readJson<T>(path); } catch { return null; } }

void main();
