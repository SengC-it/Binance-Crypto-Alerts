import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, FundingRatePoint, Instrument } from "@/lib/core/types";
import { roundMetric } from "@/lib/v5-2/validation";
import { readMonthlyArchive, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { hashWithoutField } from "@/lib/v5-7/manifest";
import {
  buildFixedOutcomes,
  buildV59CandidateEvents,
  hasValidExecutionProvenance,
  runNestedMetaLabel,
  runPrimaryOnDatasets,
  runUntouchedValidation,
  summarizeMeta,
  yieldSummary,
  type V59CandidateEvent,
  type V59LabeledSample,
  type V59MetricSummary,
  type V59NestedResult,
  type V59UntouchedResult,
} from "@/lib/v5-9/meta-label";
import {
  V59_BASELINE_COMMIT,
  V59_DEV_END,
  V59_DEV_START,
  V59_EVENT_REGISTRY,
  V59_MAX_EVENTS_PER_FAMILY,
  V59_MODEL_CONFIGS,
  V59_RISK_TEMPLATES,
  V59_UNTOUCHED_END,
  V59_UNTOUCHED_START,
  V59_UNTOUCHED_SYMBOLS,
  V59_CORE_FEATURE_NAMES,
  V59_RESEARCH_RULES,
} from "@/lib/v5-9/registry";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const SEEN_EXTERNAL_INVENTORY_PATH = resolve(REPORT_DIR, "v5-7-external-data-inventory.json");
const UNTouched_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-untouched-symbol-manifest.json");
const RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-research-manifest.json");
const UNTouched_CACHE_ROOT = resolve("data/raw/v5-9-untouched-cache");
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
}

interface SeenArchiveRecord { timeframe: V57ExternalTimeframe; cachePath: string | null; status: string; sha256: string | null; rowCount: number | null }
interface SeenSymbolRecord { symbol: string; pitEligible: boolean; classification: string; records: SeenArchiveRecord[] }
interface SeenInventory { status: string; manifestId: string; symbols: SeenSymbolRecord[] }

async function main(): Promise<void> {
  const untouchedManifest = await readJson<UntouchedManifest>(UNTouched_MANIFEST_PATH);
  const researchManifest = await readJson<Record<string, unknown>>(RESEARCH_MANIFEST_PATH);
  assertFrozenInputs(untouchedManifest, researchManifest);

  const seenDatasets = await loadSeenDatasets();
  const developmentDatasets = mergeDatasets(seenDatasets);
  const untouchedReady = await untouchedCacheIsReady(untouchedManifest);
  const untouchedDatasets = untouchedReady ? await loadUntouchedDatasets(untouchedManifest) : [];
  const devEvents = developmentDatasets.length > 0 ? buildV59CandidateEvents(developmentDatasets, V59_DEV_START, V59_DEV_END, developmentDatasets) : [];
  const devOutcomes = developmentDatasets.length > 0 ? buildFixedOutcomes(devEvents, developmentDatasets) : [];
  const nested = runNestedMetaLabel(devOutcomes, V59_DEV_START, V59_DEV_END);
  const holdoutEvents = untouchedDatasets.length > 0
    ? buildV59CandidateEvents(untouchedDatasets, V59_UNTOUCHED_START, V59_UNTOUCHED_END, [...developmentDatasets, ...untouchedDatasets])
    : [];
  const holdoutOutcomes = untouchedDatasets.length > 0 ? buildFixedOutcomes(holdoutEvents, untouchedDatasets) : [];
  const untouched = runUntouchedValidation(holdoutEvents, holdoutOutcomes, devOutcomes, nested, untouchedDatasets, [...developmentDatasets, ...untouchedDatasets]);
  const development = summarizeMeta(nested.alerts);
  const developmentYield = yieldSummary(nested.alerts, V59_DEV_START, V59_DEV_END);
  const untouchedYield = yieldSummary(untouched.alerts, V59_UNTOUCHED_START, V59_UNTOUCHED_END);
  const developmentGate = evaluateDevelopmentGate(nested, development);
  const yieldGate = evaluateYieldGate(developmentYield);
  const costStress = { netR: nested.plus10Bps.metrics.netR > 0, avgR: nested.plus10Bps.metrics.avgNetR > 0 };
  const noLeakage = devEvents.length > 0 && devEvents.every((event) => (
    event.signalTimestamp === event.frame.signalTimestamp
      && event.signalIndex === event.frame.index
      && event.features.length === V59_CORE_FEATURE_NAMES.length
      && event.features.every(Number.isFinite)
  ));
  const runtimeImplementable = hasValidExecutionProvenance(devOutcomes);
  const allPromotionChecks = developmentGate.passed && untouched.status === "PASS" && costStress.netR && costStress.avgR && yieldGate.passed && nested.calibration.status === "PASS" && noLeakage && runtimeImplementable;
  const businessVerdict = allPromotionChecks ? "YES" : untouched.status === "DATA_UNAVAILABLE" || untouched.status === "INCONCLUSIVE" || development.metrics.trades === 0 ? "INCONCLUSIVE" : "NO";
  const generalization = buildGeneralization(development, untouched, developmentYield, untouchedYield);

  const candidateRegistry = buildCandidateRegistryReport(devEvents, devOutcomes);
  const modelRegistry = { schema: "bca-v5-9-model-registry-v1", status: "FROZEN_BEFORE_RETURN_READ", models: ["LOGISTIC_L2", "SHALLOW_TREE"], configurations: V59_MODEL_CONFIGS, count: V59_MODEL_CONFIGS.length, max: 12, riskTemplates: V59_RISK_TEMPLATES };
  const calibrationReport = { schema: "bca-v5-9-calibration-v1", nestedOos: nested.calibration };
  const generalizationReport = { schema: "bca-v5-9-generalization-audit-v1", ...generalization, seenSymbols: [...new Set(developmentDatasets.map((dataset) => dataset.symbol))].sort(), untouchedSymbols: untouchedReady ? untouchedManifest.availableSymbols : [], holdoutStatus: untouched.status };
  const summary = buildSummary({ untouchedManifest, researchManifest, devEvents, devOutcomes, development, developmentYield, nested, untouched, untouchedYield, generalization, yieldGate, costStress, noLeakage, runtimeImplementable, businessVerdict, untouchedReady });
  await writeFile(resolve(REPORT_DIR, "v5-9-candidate-event-registry.json"), `${JSON.stringify(candidateRegistry, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-model-registry.json"), `${JSON.stringify(modelRegistry, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-calibration.json"), `${JSON.stringify(calibrationReport, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-generalization-audit.json"), `${JSON.stringify(generalizationReport, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-validation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-9-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({ stage: "v5_9_validation_complete", developmentDatasets: developmentDatasets.length, untouchedDatasets: untouchedDatasets.length, candidateEvents: devEvents.length, labeledOutcomes: devOutcomes.length, nestedAlerts: nested.alerts.length, nestedPromotion: developmentGate.passed, untouchedStatus: untouched.status, businessVerdict, emailPromotionCandidate: allPromotionChecks }));
}

function assertFrozenInputs(manifest: UntouchedManifest, research: Record<string, unknown>): void {
  if (manifest.status !== "FROZEN_BEFORE_RETURN_READ" || manifest.manifestId !== "v59-binance-untouched-symbols-2023-01-01-2026-07-31") throw new Error("V5.9 untouched manifest is not frozen");
  if (hashWithoutField(manifest as unknown as Record<string, unknown>, "manifestHash") !== manifest.manifestHash) throw new Error("V5.9 untouched manifest integrity failed");
  if (manifest.baselineCommit !== V59_BASELINE_COMMIT) throw new Error("V5.9 baseline changed");
  if (manifest.symbols.length < 15 || manifest.symbols.some((symbol) => !V59_UNTOUCHED_SYMBOLS.includes(symbol as typeof V59_UNTOUCHED_SYMBOLS[number]))) throw new Error("V5.9 untouched symbol registry changed");
  if (research.status !== "FROZEN_BEFORE_RETURN_READ" || research.baselineCommit !== V59_BASELINE_COMMIT || typeof research.manifestHash !== "string" || hashWithoutField(research, "manifestHash") !== research.manifestHash) throw new Error("V5.9 research manifest integrity failed");
}

async function loadSeenDatasets(): Promise<HistoricalDataset[]> {
  const local: HistoricalDataset[] = [];
  let localFiles: string[] = [];
  try { localFiles = (await readdir(LOCAL_CACHE_DIR)).filter((file) => LOCAL_CACHE_FILE_PATTERN.test(file)); } catch { /* no local cache in clean CI */ }
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

async function untouchedCacheIsReady(manifest: UntouchedManifest): Promise<boolean> {
  if (manifest.availableSymbols.length < 10) return false;
  for (const symbol of manifest.symbolRecords.filter((item) => item.status === "AVAILABLE")) {
    for (const record of symbol.archives) {
      if (record.status !== "AVAILABLE" || !record.cachePath || !record.sha256) return false;
      try {
        if (sha256(await readFile(resolve(record.cachePath))) !== record.sha256) return false;
      } catch { return false; }
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
    if (validDataset({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates })) datasets.push({ symbol: symbol.symbol, instrument: makeInstrument(symbol.symbol), candles, fundingRates: dedupeFunding(fundingRates) });
  }
  return datasets;
}

function mergeDatasets(datasets: HistoricalDataset[]): HistoricalDataset[] {
  const bySymbol = new Map<string, HistoricalDataset>();
  for (const dataset of datasets) {
    const existing = bySymbol.get(dataset.symbol);
    if (!existing) { bySymbol.set(dataset.symbol, { ...dataset, candles: { "15m": [...dataset.candles["15m"]], "1h": [...(dataset.candles["1h"] ?? [])], "4h": [...(dataset.candles["4h"] ?? [])] }, fundingRates: [...(dataset.fundingRates ?? [])] }); continue; }
    for (const timeframe of ["15m", "1h", "4h"] as const) existing.candles[timeframe] = dedupeCandles([...(existing.candles[timeframe] ?? []), ...(dataset.candles[timeframe] ?? [])]);
    existing.fundingRates = dedupeFunding([...(existing.fundingRates ?? []), ...(dataset.fundingRates ?? [])]);
  }
  return [...bySymbol.values()].filter(validDataset).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function evaluateDevelopmentGate(nested: V59NestedResult, metrics: V59MetricSummary): { passed: boolean; checks: Record<string, boolean>; medianFoldNetR: number | null; symbolBreadth: number } {
  const folds = nested.foldMetrics.map((fold) => fold.metrics.metrics).filter((fold) => fold.trades > 0).sort((left, right) => left.netR - right.netR);
  const medianFoldNetR = folds.length > 0 ? folds[Math.floor((folds.length - 1) / 2)].netR : null;
  const checks = {
    signals: metrics.metrics.trades >= 100,
    netR: metrics.metrics.netR > 0,
    avgR: metrics.metrics.avgNetR >= 0.15,
    profitFactor: metrics.metrics.profitFactor >= 1.3,
    positiveFoldRatio: nested.positiveFoldRatio !== null && nested.positiveFoldRatio >= 0.67,
    medianFoldNetR: medianFoldNetR !== null && medianFoldNetR > 0,
    plus10BpsNetR: nested.plus10Bps.metrics.netR > 0,
    symbolBreadth: metrics.symbolBreadth >= 15,
    selectionAdjustedLCB: nested.selectionAdjustedLcb !== null && nested.selectionAdjustedLcb >= 0,
    promotionLCB: nested.promotionLcb !== null && nested.promotionLcb >= 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks, medianFoldNetR, symbolBreadth: metrics.symbolBreadth };
}

function evaluateYieldGate(value: ReturnType<typeof yieldSummary>): { passed: boolean; checks: Record<string, boolean> } {
  const checks = { alertsPerMonth: value.alertsPerMonth >= 2, activeMonthRatio: (value.activeMonthRatio ?? 0) >= 0.65, medianAlertsPerMonth: (value.medianAlertsPerMonth ?? 0) >= 1, p95DroughtDays: (value.p95DroughtDays ?? Number.POSITIVE_INFINITY) <= 45, maxDroughtDays: (value.maxDroughtDays ?? Number.POSITIVE_INFINITY) <= 60 };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function buildGeneralization(development: V59MetricSummary, untouched: V59UntouchedResult, developmentYield: ReturnType<typeof yieldSummary>, untouchedYield: ReturnType<typeof yieldSummary>): Record<string, unknown> {
  const holdoutUsable = untouched.status === "PASS" || untouched.status === "FAIL";
  return {
    development: serializeMetric(development),
    untouched: serializeMetric(untouched.metrics),
    avgRDegradation: holdoutUsable ? roundMetric(untouched.metrics.metrics.avgNetR - development.metrics.avgNetR) : null,
    pfDegradation: holdoutUsable ? roundMetric(untouched.metrics.metrics.profitFactor - development.metrics.profitFactor) : null,
    signalRateDegradation: holdoutUsable && developmentYield.alertsPerMonth > 0 ? roundMetric(untouchedYield.alertsPerMonth / developmentYield.alertsPerMonth - 1) : null,
    overfit: holdoutUsable ? (untouched.metrics.metrics.avgNetR < 0 || untouched.metrics.metrics.profitFactor < 1 || (developmentYield.alertsPerMonth > 0 && untouchedYield.alertsPerMonth / developmentYield.alertsPerMonth < 0.5) ? "YES" : "NO") : "INCONCLUSIVE",
  };
}

function buildCandidateRegistryReport(events: V59CandidateEvent[], outcomes: V59LabeledSample[]): Record<string, unknown> {
  const families = Object.fromEntries(V59_EVENT_REGISTRY.map((definition) => [definition.id, { ...definition, candidateEvents: events.filter((event) => event.family === definition.id).length, fixedOutcomeRows: outcomes.filter((outcome) => outcome.family === definition.id).length }]));
  return { schema: "bca-v5-9-candidate-event-registry-v1", status: "FROZEN_BEFORE_RETURN_READ", minimumCandidateEvents: 500, totalCandidateEvents: events.length, fixedOutcomeRows: outcomes.length, familyCount: V59_EVENT_REGISTRY.length, families, eventDefinitions: V59_EVENT_REGISTRY, noLegacyFinalFilters: true, labels: { positive: "net R > 0", highQuality: "net R >= 0.5R" } };
}

function buildSummary(input: { untouchedManifest: UntouchedManifest; researchManifest: Record<string, unknown>; devEvents: V59CandidateEvent[]; devOutcomes: V59LabeledSample[]; development: V59MetricSummary; developmentYield: ReturnType<typeof yieldSummary>; nested: V59NestedResult; untouched: V59UntouchedResult; untouchedYield: ReturnType<typeof yieldSummary>; generalization: Record<string, unknown>; yieldGate: { passed: boolean; checks: Record<string, boolean> }; costStress: { netR: boolean; avgR: boolean }; noLeakage: boolean; runtimeImplementable: boolean; businessVerdict: string; untouchedReady: boolean }): Record<string, unknown> {
  const devGate = evaluateDevelopmentGate(input.nested, input.development);
  const allPromotionChecks = devGate.passed && input.untouched.status === "PASS" && input.costStress.netR && input.costStress.avgR && input.yieldGate.passed && input.nested.calibration.status === "PASS" && input.noLeakage && input.runtimeImplementable;
  return {
    schema: "bca-v5-9-validation-summary-v1",
    generatedAt: new Date().toISOString(),
    status: input.devEvents.length > 0 ? "VALIDATION_COMPLETE" : "DATA_UNAVAILABLE",
    researchOnly: true,
    baseline: V59_BASELINE_COMMIT,
    researchManifest: { path: "reports/v5-9-research-manifest.json", hash: input.researchManifest.manifestHash },
    untouchedManifest: { path: "reports/v5-9-untouched-symbol-manifest.json", hash: input.untouchedManifest.manifestHash, symbols: input.untouchedManifest.symbols, availableSymbols: input.untouchedManifest.availableSymbols, validationReady: input.untouchedReady },
    candidateEvents: { total: input.devEvents.length, minimum: 500, metMinimum: input.devEvents.length >= 500, maxEventsPerFamily: V59_MAX_EVENTS_PER_FAMILY, capPolicy: "Deterministic chronological stride cap before outcome labels; independent of returns.", families: V59_EVENT_REGISTRY.map((definition) => definition.id), outcomeRows: input.devOutcomes.length },
    modelRegistry: { path: "reports/v5-9-model-registry.json", count: V59_MODEL_CONFIGS.length, max: 12, models: ["LOGISTIC_L2", "SHALLOW_TREE"] },
    nestedDevelopment: {
      signals: input.nested.alerts.length,
      metrics: serializeMetric(input.development),
      yield: input.developmentYield,
      selectedConfig: input.nested.selectedConfig,
      selectedTemplate: input.nested.selectedTemplate,
      folds: input.nested.foldMetrics.map((fold) => ({ fold: fold.fold, configId: fold.configId, templateId: fold.templateId, metrics: serializeMetric(fold.metrics) })),
      positiveFoldRatio: roundMetric(input.nested.positiveFoldRatio),
      selectionAdjustedLCB: roundMetric(input.nested.selectionAdjustedLcb),
      promotionLCB: roundMetric(input.nested.promotionLcb),
      promotionChecks: devGate.checks,
      promotion: devGate.passed ? "PASS" : input.devEvents.length > 0 ? "FAIL" : "DATA_UNAVAILABLE",
      plus10Bps: serializeMetric(input.nested.plus10Bps),
    },
    calibration: input.nested.calibration,
    emailThresholdEvaluation: input.nested.thresholdEvaluations.map((row) => ({ ...row, metrics: serializeMetric(row.metrics), yield: row.yield })),
    yieldGate: { thresholds: V59_RESEARCH_RULES.yieldGate, ...input.yieldGate, selectedNested: input.developmentYield },
    untouchedHoldout: {
      manifest: input.untouchedManifest.manifestId,
      symbols: input.untouchedManifest.availableSymbols,
      coverage: input.untouchedReady ? `${input.untouchedManifest.availableSymbols.length}/${input.untouchedManifest.symbols.length}` : "DATA_UNAVAILABLE",
      signals: input.untouched.alerts.length,
      metrics: serializeMetric(input.untouched.metrics),
      primary: serializeMetric(input.untouched.primary),
      yield: input.untouchedYield,
      gate: input.untouched.gate,
      status: input.untouched.status,
    },
    generalization: input.generalization,
    comparison: { v59VsUngatedPrimary: input.untouched.comparison, basis: "Same untouched symbols, closed-candle event features, next-bar-open execution, fixed costs." },
    exactOldProduction: { status: "DATA_UNAVAILABLE", reason: "No exact non-sensitive Production configuration export; no fake replay." },
    businessVerdict: input.businessVerdict,
    emailPromotionCandidate: allPromotionChecks ? "PASS" : "FAIL",
    hardBoundaries: { productionChanged: false, v55Changed: false, productionEmailChanged: false, deployment: false, merge: false, migration: false, autoTrading: false, primaryChanged: false, strategyChanged: false, noLeakage: input.noLeakage, runtimeImplementable: input.runtimeImplementable },
  };
}

function renderDecision(summary: Record<string, unknown>): string {
  const development = summary.nestedDevelopment as Record<string, unknown>;
  const untouched = summary.untouchedHoldout as Record<string, unknown>;
  return [
    "# V5.9 Purged Meta-Label Signal Engine — Validation Decision",
    "",
    `Baseline: **${String(summary.baseline)}**; research-only, no Production/runtime change.`,
    `Candidate events: **${String((summary.candidateEvents as Record<string, unknown>).total)}** across five fixed event families; target >=500.`,
    `Nested development: ${JSON.stringify(development.metrics)}; promotion: **${String(development.promotion)}**.`,
    `Selected development model/template: ${JSON.stringify(development.selectedConfig)} / ${JSON.stringify(development.selectedTemplate)}.`,
    `Calibration: **${String((summary.calibration as Record<string, unknown>).status)}**.`,
    `Untouched-symbol holdout: ${JSON.stringify(untouched.metrics)}; status: **${String(untouched.status)}**.`,
    `Generalization audit: ${JSON.stringify(summary.generalization)}.`,
    `V5.9 vs ungated Primary on untouched symbols: **${String((summary.comparison as Record<string, unknown>).v59VsUngatedPrimary)}**.`,
    `Business verdict: **${String(summary.businessVerdict)}**; Email Promotion Candidate: **${String(summary.emailPromotionCandidate)}**.`,
    "",
    "## Hard boundary",
    "- Production: NO change",
    "- V5.5/#002: NO change",
    "- Production email: NO change",
    "- Supabase migration: NO",
    "- Deploy: NO",
    "- Merge: NO",
    "- Auto trading: NO",
    "- Primary strategy/parameters: FROZEN",
    "",
  ].join("\n");
}

function serializeMetric(value: V59MetricSummary): Record<string, unknown> {
  const metrics = value.metrics;
  return { trades: metrics.trades, wins: metrics.wins, losses: metrics.losses, winRate: roundMetric(metrics.winRate), netR: roundMetric(metrics.netR), avgR: roundMetric(metrics.avgNetR), profitFactor: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null, maxDD: roundMetric(metrics.maxDrawdownR), cvar95: roundMetric(value.cvar95), plus10BpsNetR: roundMetric(value.plus10Bps.netR), symbolBreadth: value.symbolBreadth, positiveSymbolRatio: roundMetric(value.positiveSymbolRatio), totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt), totalFeesUsdt: roundMetric(metrics.totalFeesUsdt), totalFundingUsdt: roundMetric(metrics.totalFundingUsdt), totalSlippageUsdt: roundMetric(metrics.totalSlippageUsdt) };
}

function validDataset(dataset: HistoricalDataset): boolean { return Boolean(dataset?.symbol && dataset.candles?.["15m"]?.length && dataset.candles?.["1h"]?.length && dataset.candles?.["4h"]?.length); }
function dedupeCandles(candles: Candle[]): Candle[] { const map = new Map<number, Candle>(); for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle); return [...map.values()].sort((left, right) => left.openTime - right.openTime); }
function dedupeFunding(points: FundingRatePoint[]): FundingRatePoint[] { const map = new Map<number, FundingRatePoint>(); for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point); return [...map.values()].sort((left, right) => left.fundingTime - right.fundingTime); }
function makeInstrument(symbol: string): Instrument { return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "HISTORICAL_DATA_VISION", priceTick: 0, quantityStep: 0 }; }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function readJsonOrNull<T>(path: string): Promise<T | null> { try { return await readJson<T>(path); } catch { return null; } }

void main();
