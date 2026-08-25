import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  BINANCE_DATA_VISION_BUCKET,
  BINANCE_UM_MONTHLY_INTERVAL,
  BINANCE_UM_MONTHLY_PREFIX,
  buildFoldUniverse,
  buildPitManifest,
  buildPitSymbolEvidence,
  isPitTradableAt,
  parseS3CommonPrefixes,
  parseS3Keys,
  sha256,
  type PitArchiveSymbolEvidence,
  type PitUniverseManifest,
} from "@/lib/v5-4/pit-universe";
import {
  auditConfidence,
  selectionAdjustedConfidence,
  type ConfidenceObservation,
} from "@/lib/v5-4/confidence";
import { serializeSignalFeatureSnapshotV2 } from "@/lib/v5-4/telemetry";
import type { HistoricalDataset } from "@/lib/backtest/types";
import { closes, ema } from "@/lib/core/indicators";
import {
  buildFeatureFrames,
  type FeatureFrame,
} from "@/lib/v5-3/feature-snapshot";
import {
  buildPerturbationSummary,
  evaluateV53PromotionGate,
  removeTopTrades,
  runStructuralCandidate,
  trueEquityDrawdown,
  V53_CANDIDATE_REGISTRY,
  type StructuralCandidateDefinition,
  type StructuralParameters,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import { deduplicateCanonicalTrades } from "@/lib/v5-3/production-parity";
import {
  buildCostStressMetrics,
  calculateMetrics,
  createFrozenHoldoutWindow,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  roundMetric,
  type ValidationMetrics,
} from "@/lib/v5-2/validation";

const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/validation-cache");
const PIT_FILE = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
const V53_SHORT_REPORT = resolve("reports/v5-3-nested-walk-forward.json");
const UNIVERSE_FILE = resolve("data/validation-universe-50.json");
const CORE_START = 1_691_633_700_000;
const BROAD_START = 1_754_705_700_000;
const CACHE_END = 1_786_241_699_999;
const PURGE_HOURS = 72;
const ENTRY_STRIDE_BARS = 4;
const FEE_RATE = 0.0004;
const BASE_SLIPPAGE_BPS = 2;
const RISK_PER_TRADE_USDT = 50;
const FIXED_CANDIDATE_ID = "SHORT-FAILED_BREAKOUT_SHORT-02";
const BOOTSTRAP_REPETITIONS = 2_000;
const BOOTSTRAP_BLOCK_LENGTH = 5;
const execFileAsync = promisify(execFile);

type GroupId = "3Y_CORE" | "1Y_BROAD";

interface CacheFile {
  symbol: string;
  path: string;
}

interface ValidationGroup {
  id: GroupId;
  label: string;
  start: number;
  end: number;
  files: CacheFile[];
  folds: ReturnType<typeof createPurgedWalkForwardFolds>;
  holdout: ReturnType<typeof createFrozenHoldoutWindow>;
}

interface BreadthLookup {
  timestamps: number[];
  values: number[];
  at: (timestamp: number) => number | null;
}

interface GroupRuntime {
  group: ValidationGroup;
  breadth: BreadthLookup;
  btcDataset?: HistoricalDataset;
  ethDataset?: HistoricalDataset;
}

interface GroupRun {
  group: ValidationGroup;
  base: StructuralTrade[];
  delayed: StructuralTrade[];
  perturbations: Map<string, StructuralTrade[]>;
}

interface SerializedMetrics extends Record<string, unknown> {
  trades: number;
  avgR: number;
  PF: number | null;
  NetR: number;
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(resolve("data/pit-universe"), { recursive: true });
  const symbols = await loadUniverseSymbols();
  const pitManifest = await loadOrFetchPitManifest(symbols);
  const pitBySymbol = new Map(pitManifest.evidenceSymbols.map((record) => [record.symbol, record]));
  const cacheFiles = await loadCacheManifest();
  const groups = buildGroups(symbols, cacheFiles);
  const candidate = getFrozenCandidate();
  const runtimes = new Map<GroupId, GroupRuntime>();
  const groupRuns: GroupRun[] = [];

  for (const group of groups) {
    const runtime = await prepareRuntime(group);
    runtimes.set(group.id, runtime);
    groupRuns.push(await runFixedCandidate(group, runtime, candidate, pitBySymbol));
    console.info(JSON.stringify({
      stage: "v5_4_group_complete",
      group: group.id,
      baseTrades: groupRuns.at(-1)!.base.length,
      pitSymbolsAtStart: buildFoldUniverse(pitManifest.evidenceSymbols, group.start).length,
      folds: group.folds.length,
    }));
  }

  const baseTrades = uniqueOosTrades(groupRuns, "base");
  const delayedTrades = uniqueOosTrades(groupRuns, "delayed");
  const perturbationLabels = ["-20%", "-10%", "+10%", "+20%"];
  const perturbationTrades = new Map<string, StructuralTrade[]>();
  for (const label of perturbationLabels) perturbationTrades.set(label, uniqueOosTrades(groupRuns, "perturbation", label));
  const baseMetrics = metricsWithFold(baseTrades);
  const holdoutTrades = uniqueHoldoutTrades(groupRuns);
  const holdoutMetrics = holdoutTrades.length > 0 ? metricsWithFold(holdoutTrades) : null;
  const costStress = buildCostStressMetrics(baseTrades);
  const delayedMetrics = metricsWithFold(delayedTrades);
  const perturbations = buildPerturbationSummary(
    baseMetrics,
    perturbationLabels.map((label) => ({ label, metrics: metricsWithFold(perturbationTrades.get(label) ?? []) })),
  );
  const removeTop3Metrics = metricsWithFold(removeTopTrades(baseTrades, 3));
  const foldGroups = groups.map((group) => ({
    id: group.id,
    folds: group.folds.map((fold) => {
      const metrics = metricsWithFold(baseTrades.filter((trade) => trade.fold === `${group.id}-${fold.id}`));
      return { netR: metrics.netR, trades: metrics.trades };
    }),
  }));
  const foldRows = foldGroups.flatMap((group) => group.folds);
  const confidence = auditConfidence({
    observations: baseTrades.map((trade) => ({ value: trade.rMultiple, symbol: trade.symbol, fold: trade.fold ?? "DATA_UNAVAILABLE" })),
    candidateSeries: [],
    selectedCandidateId: FIXED_CANDIDATE_ID,
    selectionCandidateCount: V53_CANDIDATE_REGISTRY.length,
    repetitions: BOOTSTRAP_REPETITIONS,
    blockLength: BOOTSTRAP_BLOCK_LENGTH,
    selectionAdjustedLcb: await readFrozenSelectionAdjustedLcb(),
  });
  const promotionLcb = confidence.promotionLcb95;
  const gate = buildPromotionGate({
    baseMetrics,
    holdoutMetrics,
    costStress,
    delayedMetrics,
    removeTop3Metrics,
    perturbations,
    promotionLcb,
    selectionAdjustedLcb: confidence.methods.find((item) => item.method === "selection_adjusted_bootstrap")?.lcb95 ?? null,
    naiveLcb: confidence.methods.find((item) => item.method === "naive_bootstrap")?.lcb95 ?? null,
    regimeMetrics: regimeSlices(baseTrades),
    folds: foldRows,
    foldGroups,
  });
  const robustness = buildRobustness(baseTrades, delayedMetrics, costStress, perturbations, removeTop3Metrics);
  const pitCoverage = buildPitCoverage(groups, pitManifest, symbols, cacheFiles);
  const shortValidation = {
    report: "V5.4 Frozen SHORT Evidence Hardening",
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    strategyTuning: false,
    candidate: {
      id: candidate.id,
      parameters: candidate.parameters,
      parameterHash: sha256(JSON.stringify(candidate.parameters)),
      frozenParameterCheck: isFrozenCandidate(candidate),
    },
    pitUniverse: {
      status: pitManifest.status,
      source: pitManifest.source,
      rootArchiveSymbolCount: pitManifest.rootArchiveSymbolCount,
      evidenceSymbols: pitManifest.evidenceSymbols.length,
      coverage: pitCoverage,
    },
    groups: groups.map((group) => ({
      id: group.id,
      start: new Date(group.start).toISOString(),
      end: new Date(group.end).toISOString(),
      folds: group.folds.map((fold) => ({
        id: fold.id,
        validationStart: new Date(fold.validationStart).toISOString(),
        validationEnd: new Date(fold.validationEnd).toISOString(),
        universe: buildFoldUniverse(pitManifest.evidenceSymbols, fold.validationStart),
        metrics: serializeMetrics(metricsWithFold(baseTrades.filter((trade) => trade.fold === `${group.id}-${fold.id}`))),
      })),
      holdout: group.holdout ? {
        start: new Date(group.holdout.start).toISOString(),
        end: new Date(group.holdout.end).toISOString(),
        metrics: serializeMetrics(metricsWithFold(holdoutTrades.filter((trade) => trade.fold?.startsWith(`${group.id}-`)))),
      } : null,
    })),
    fixedOos: serializeMetrics(baseMetrics),
    holdout: serializeMetrics(holdoutMetrics),
    costStress: {
      base: serializeMetrics(costStress.base),
      plus10Bps: serializeMetrics(costStress.plus10Bps),
      plus15Bps: serializeMetrics(costStress.plus15Bps),
    },
    delayedEntry: serializeMetrics(delayedMetrics),
    removeTop3: serializeMetrics(removeTop3Metrics),
    robustness,
    confidence: {
      promotionLcb95: roundMetric(promotionLcb),
      methods: confidence.methods.map((item) => ({ ...item, lcb95: roundMetric(item.lcb95) })),
    },
    promotion: gate,
  };
  const pitReport = {
    ...pitManifest,
    validationInputSymbols: symbols,
    foldCoverage: pitCoverage,
  };
  const confidenceReport = {
    report: "V5.4 Confidence Audit",
    generatedAt: shortValidation.generatedAt,
    selectedCandidate: FIXED_CANDIDATE_ID,
    candidateCount: V53_CANDIDATE_REGISTRY.length,
    nestedCandidateSelection: true,
    sourceSelectionAdjustedLcb: V53_SHORT_REPORT,
    observations: baseTrades.length,
    confidence: shortValidation.confidence,
    promotionLcb95: roundMetric(promotionLcb),
    promotionMethod: confidence.promotionMethod,
    methodology: [
      "Naive bootstrap is retained as a diagnostic only.",
      "Block bootstrap uses circular block length 5 to address serial correlation and overlapping trades.",
      "Symbol-cluster bootstrap resamples complete symbols; fold-cluster bootstrap resamples complete outer folds.",
      `Selection-adjusted LCB is the frozen nested-selection result over ${V53_CANDIDATE_REGISTRY.length} preregistered candidates; it is not recomputed by selecting a new candidate in V5.4.`,
      "Promotion uses the minimum available LCB across all methods; the prettiest interval cannot be selected.",
    ],
  };
  await writeJson("reports/v5-4-pit-universe.json", pitReport);
  await writeJson("reports/v5-4-confidence-audit.json", confidenceReport);
  await writeJson("reports/v5-4-short-validation.json", shortValidation);
  await writeFile(resolve(REPORT_DIR, "v5-4-pit-universe.md"), renderPitMarkdown(pitReport), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-4-confidence-audit.md"), renderConfidenceMarkdown(confidenceReport), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-4-promotion-decision.md"), renderPromotionMarkdown(shortValidation), "utf8");
  await writeFile(resolve(REPORT_DIR, "v5-4-executive-summary.md"), renderExecutiveMarkdown(shortValidation), "utf8");
  await writeResearchTelemetryDesign();

  console.info(JSON.stringify({
    stage: "v5_4_validation_complete",
    pitUniverse: pitManifest.status,
    candidate: FIXED_CANDIDATE_ID,
    trades: baseMetrics.trades,
    avgR: roundMetric(baseMetrics.avgNetR),
    profitFactor: roundMetric(baseMetrics.profitFactor),
    promotionLcb95: roundMetric(promotionLcb),
    promotion: gate.status,
  }));
}

async function loadUniverseSymbols(): Promise<string[]> {
  const value = JSON.parse(await readFile(UNIVERSE_FILE, "utf8")) as { symbols?: string[] };
  return [...new Set(value.symbols ?? [])].sort();
}

async function loadCacheManifest(): Promise<CacheFile[]> {
  const names = await readdir(CACHE_DIR);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const match = name.match(/^(.+)-\d+-\d+\.json$/);
      return match ? { symbol: match[1], path: resolve(CACHE_DIR, name) } : null;
    })
    .filter((file): file is CacheFile => file !== null);
}

function buildGroups(universe: string[], files: CacheFile[]): ValidationGroup[] {
  const makeGroup = (
    id: GroupId,
    label: string,
    start: number,
    suffix: string,
    initialTrainMonths: number,
    validationMonths: number,
  ): ValidationGroup => {
    const selectedBySymbol = new Map(files.filter((file) => file.path.endsWith(suffix)).map((file) => [file.symbol, file]));
    const selected = universe.flatMap((symbol) => selectedBySymbol.has(symbol) ? [selectedBySymbol.get(symbol)!] : []);
    const folds = createPurgedWalkForwardFolds({ start, end: CACHE_END, initialTrainMonths, validationMonths, foldCount: 6, purgeHours: PURGE_HOURS });
    return {
      id,
      label,
      start,
      end: CACHE_END,
      files: selected,
      folds,
      holdout: createFrozenHoldoutWindow(CACHE_END, folds, PURGE_HOURS),
    };
  };
  return [
    makeGroup("3Y_CORE", "3-year Core (archive-backed conservative PIT subset)", CORE_START, "-1691633700000-1786241699999.json", 12, 3),
    makeGroup("1Y_BROAD", "1-year Broad (archive-backed conservative PIT subset)", BROAD_START, "-1754705700000-1786241699999.json", 3, 1),
  ];
}

async function prepareRuntime(group: ValidationGroup): Promise<GroupRuntime> {
  const counts = new Map<number, { up: number; total: number }>();
  let btcDataset: HistoricalDataset | undefined;
  let ethDataset: HistoricalDataset | undefined;
  for (const file of group.files) {
    const dataset = await readDataset(file);
    if (dataset.symbol === "BTCUSDT") btcDataset = dataset;
    if (dataset.symbol === "ETHUSDT") ethDataset = dataset;
    const candles = dataset.candles["1h"] ?? [];
    const fast = ema(closes(candles), 20);
    const slow = ema(closes(candles), 50);
    for (let index = 50; index < candles.length; index += 1) {
      if (candles[index].closeTime < group.start || candles[index].closeTime > group.end) continue;
      const regime = regimeFromValues(fast, slow, index);
      if (regime === "UNKNOWN") continue;
      const bucket = counts.get(candles[index].closeTime) ?? { up: 0, total: 0 };
      bucket.total += 1;
      if (regime === "BULL") bucket.up += 1;
      counts.set(candles[index].closeTime, bucket);
    }
  }
  const timestamps = [...counts.keys()].sort((left, right) => left - right);
  const values = timestamps.map((timestamp) => {
    const value = counts.get(timestamp)!;
    return value.total > 0 ? value.up / value.total : 0.5;
  });
  return {
    group,
    breadth: { timestamps, values, at: (timestamp) => lookupAtOrBefore(timestamps, values, timestamp) },
    btcDataset,
    ethDataset,
  };
}

async function runFixedCandidate(
  group: ValidationGroup,
  runtime: GroupRuntime,
  candidate: StructuralCandidateDefinition,
  pitBySymbol: Map<string, PitArchiveSymbolEvidence>,
): Promise<GroupRun> {
  const perturbations = new Map<string, StructuralCandidateDefinition>();
  for (const factor of [-0.2, -0.1, 0.1, 0.2]) perturbations.set(formatFactor(factor), perturbDefinition(candidate, factor));
  const output: GroupRun = { group, base: [], delayed: [], perturbations: new Map([...perturbations.keys()].map((key) => [key, []])) };
  for (const file of group.files) {
    const dataset = await readDataset(file);
    const frames = buildFeatureFrames(dataset, {
      startTime: group.start,
      endTime: group.end,
      entryStrideBars: ENTRY_STRIDE_BARS,
      breadthAt: runtime.breadth.at,
      btcDataset: runtime.btcDataset,
      ethDataset: runtime.ethDataset,
    });
    const configs: Array<{ label: "base" | "delayed" | string; definition: StructuralCandidateDefinition; delayBars: number }> = [
      { label: "base", definition: candidate, delayBars: 0 },
      { label: "delayed", definition: candidate, delayBars: 1 },
      ...[...perturbations.entries()].map(([label, definition]) => ({ label, definition, delayBars: 0 })),
    ];
    for (const config of configs) {
      const generated = runStructuralCandidate(dataset, frames, config.definition, {
        startTime: group.start,
        endTime: group.end,
        delayBars: config.delayBars,
        maxHoldHours: config.definition.expectedHoldingHorizonHours,
        takerFeeRate: FEE_RATE,
        slippageBps: BASE_SLIPPAGE_BPS,
        riskPerTradeUsdt: RISK_PER_TRADE_USDT,
        cooldownHours: 8,
      }).filter((trade) => isPitTradableAt(pitBySymbol.get(trade.symbol) ?? emptyPitRecord(trade.symbol), trade.entryTime));
      if (config.label === "base") output.base.push(...generated);
      else if (config.label === "delayed") output.delayed.push(...generated);
      else output.perturbations.get(config.label)!.push(...generated);
    }
  }
  return output;
}

function uniqueOosTrades(groupRuns: GroupRun[], mode: "base" | "delayed" | "perturbation", label?: string): StructuralTrade[] {
  const rows: StructuralTrade[] = [];
  for (const run of groupRuns) {
    const source = mode === "base" ? run.base : mode === "delayed" ? run.delayed : run.perturbations.get(label ?? "") ?? [];
    rows.push(...source
      .filter((trade) => run.group.folds.some((fold) => isTimestampInWindow(trade.entryTime, fold.validationStart, fold.validationEnd)))
      .map((trade) => ({ ...trade, fold: foldLabel(run.group, trade.entryTime) })));
  }
  return deduplicateCanonicalTrades(rows, FIXED_CANDIDATE_ID).uniqueTrades;
}

function uniqueHoldoutTrades(groupRuns: GroupRun[]): StructuralTrade[] {
  const rows: StructuralTrade[] = [];
  for (const run of groupRuns) {
    if (!run.group.holdout) continue;
    rows.push(...run.base
      .filter((trade) => isTimestampInWindow(trade.entryTime, run.group.holdout!.start, run.group.holdout!.end))
      .map((trade) => ({ ...trade, fold: `${run.group.id}-HOLDOUT` })));
  }
  return deduplicateCanonicalTrades(rows, FIXED_CANDIDATE_ID).uniqueTrades;
}

function metricsWithFold(trades: StructuralTrade[]): ValidationMetrics {
  const foldByTrade = new Map(trades.map((trade) => [trade, trade.fold ?? "DATA_UNAVAILABLE"]));
  return calculateMetrics(trades, { foldByTrade });
}

function buildPromotionGate(input: {
  baseMetrics: ValidationMetrics;
  holdoutMetrics: ValidationMetrics | null;
  costStress: ReturnType<typeof buildCostStressMetrics>;
  delayedMetrics: ValidationMetrics;
  removeTop3Metrics: ValidationMetrics;
  perturbations: Array<{ label: string; metrics: ValidationMetrics; passed: boolean }>;
  promotionLcb: number | null;
  selectionAdjustedLcb: number | null;
  naiveLcb: number | null;
  regimeMetrics: Array<{ regime: string; metrics: ValidationMetrics }>;
  folds: Array<{ netR: number; trades: number }>;
  foldGroups: Array<{ id: string; folds: Array<{ netR: number; trades: number }> }>;
}): ReturnType<typeof evaluateV53PromotionGate> {
  const base = evaluateV53PromotionGate({
    metrics: { ...input.baseMetrics, lowerConfidenceBound95: input.promotionLcb },
    holdout: input.holdoutMetrics,
    control: null,
    costStress: input.costStress,
    folds: input.folds,
    foldGroups: input.foldGroups,
    regimeMetrics: input.regimeMetrics,
    dataQuality: { passed: false, reason: "PIT_UNIVERSE=INCOMPLETE; exact historical listing/delisting and contract status evidence is unavailable." },
    controlComparison: { reliable: false, reason: "No immutable Production control trade export was added by this research-only PR." },
    adjustedLcb: input.promotionLcb,
    delayedEntry: input.delayedMetrics,
    removeTop3: input.removeTop3Metrics,
    perturbations: input.perturbations,
  });
  const gates = base.gates.map((gate) => {
    if (gate.id === "selection_adjusted_lcb") {
      return {
        ...gate,
        passed: input.selectionAdjustedLcb !== null && input.selectionAdjustedLcb > 0,
        evidence: `selection-adjusted LCB95=${format(input.selectionAdjustedLcb)}`,
      };
    }
    if (gate.id === "naive_lcb_reported") {
      return {
        ...gate,
        passed: input.naiveLcb !== null,
        evidence: `naive bootstrap LCB95=${format(input.naiveLcb)}`,
      };
    }
    return gate;
  });
  const promotionGatePass = gates.every((gate) => gate.passed) && input.promotionLcb !== null && input.promotionLcb > 0;
  return {
    status: promotionGatePass ? "PRODUCTION_EMAIL_ELIGIBLE" : input.baseMetrics.trades > 0 ? "SHADOW_ONLY" : "REJECTED",
    gates: [
      ...gates,
      { id: "promotion_lcb95", passed: input.promotionLcb !== null && input.promotionLcb > 0, evidence: `conservative promotion_lcb95=${format(input.promotionLcb)}` },
    ],
  };
}

function buildRobustness(
  baseTrades: StructuralTrade[],
  delayedMetrics: ValidationMetrics,
  costStress: ReturnType<typeof buildCostStressMetrics>,
  perturbations: Array<{ label: string; metrics: ValidationMetrics; passed: boolean }>,
  removeTop3Metrics: ValidationMetrics,
): Record<string, unknown> {
  const symbolRows = [...new Set(baseTrades.map((trade) => trade.symbol))].map((symbol) => {
    const metrics = serializeMetrics(metricsWithFold(baseTrades.filter((trade) => trade.symbol !== symbol)))!;
    return { symbol, metrics };
  }).sort((left, right) => Number(left.metrics.avgR) - Number(right.metrics.avgR));
  const foldRows = [...new Set(baseTrades.map((trade) => trade.fold ?? "DATA_UNAVAILABLE"))].map((fold) => {
    const metrics = serializeMetrics(metricsWithFold(baseTrades.filter((trade) => trade.fold !== fold)))!;
    return { fold, metrics };
  }).sort((left, right) => Number(left.metrics.avgR) - Number(right.metrics.avgR));
  return {
    delayedEntry: serializeMetrics(delayedMetrics),
    costStress: {
      plus10Bps: serializeMetrics(costStress.plus10Bps),
      plus15Bps: serializeMetrics(costStress.plus15Bps),
    },
    removeBestTrade: serializeMetrics(metricsWithFold(removeTopTrades(baseTrades, 1))),
    removeTop3: serializeMetrics(removeTop3Metrics),
    leaveOneSymbolOut: symbolRows,
    worstSymbolExclusion: symbolRows[0] ?? null,
    leaveOneFoldOut: foldRows,
    worstFoldExclusion: foldRows[0] ?? null,
    parameterPerturbation: perturbations.map((item) => ({ label: item.label, metrics: serializeMetrics(item.metrics), passed: item.passed })),
    trueEquityDrawdown: trueEquityDrawdown(baseTrades),
    monthlyStability: metricsWithFold(baseTrades).monthly,
  };
}

function regimeSlices(trades: StructuralTrade[]): Array<{ regime: string; metrics: ValidationMetrics }> {
  const byRegime = new Map<string, StructuralTrade[]>();
  for (const trade of trades) {
    const regime = trade.marketRegime ?? "DATA_UNAVAILABLE";
    byRegime.set(regime, [...(byRegime.get(regime) ?? []), trade]);
  }
  return [...byRegime.entries()].map(([regime, rows]) => ({ regime, metrics: metricsWithFold(rows) }));
}

function buildPitCoverage(
  groups: ValidationGroup[],
  manifest: PitUniverseManifest,
  requestedSymbols: string[],
  cacheFiles: CacheFile[],
): Array<Record<string, unknown>> {
  const localSymbols = new Set(cacheFiles.map((file) => file.symbol));
  return groups.map((group) => ({
    group: group.id,
    localInputSymbols: requestedSymbols.filter((symbol) => localSymbols.has(symbol)),
    folds: group.folds.map((fold) => {
      const archiveSymbols = buildFoldUniverse(manifest.evidenceSymbols, fold.validationStart);
      return {
        fold: fold.id,
        archiveUniverseCount: archiveSymbols.length,
        localReplayUniverse: archiveSymbols.filter((symbol) => localSymbols.has(symbol)),
        noSurvivorLeakage: archiveSymbols.every((symbol) => manifest.rootArchiveSymbols.includes(symbol)),
      };
    }),
  }));
}

async function loadOrFetchPitManifest(requestedSymbols: string[]): Promise<PitUniverseManifest> {
  const refresh = process.env.V54_REFRESH_PIT_UNIVERSE === "1";
  if (!refresh) {
    try {
      return JSON.parse(await readFile(PIT_FILE, "utf8")) as PitUniverseManifest;
    } catch {
      // Generate the first immutable local evidence artifact below.
    }
  }
  const root = await fetchS3Index(BINANCE_UM_MONTHLY_PREFIX, true);
  const rootSymbols = parseS3CommonPrefixes(root.pages.join("\n"))
    .map((prefix) => prefix.match(/\/([^/]+)\/$/)?.[1] ?? "")
    .filter((symbol) => symbol.endsWith("USDT") && !symbol.endsWith("USDTSETTLED"));
  const evidence: PitArchiveSymbolEvidence[] = [];
  const symbolsToFetch = requestedSymbols.filter((symbol) => rootSymbols.includes(symbol));
  for (let offset = 0; offset < symbolsToFetch.length; offset += 8) {
    const batch = symbolsToFetch.slice(offset, offset + 8);
    const rows = await Promise.all(batch.map(async (symbol) => {
      const prefix = `${BINANCE_UM_MONTHLY_PREFIX}${symbol}/${BINANCE_UM_MONTHLY_INTERVAL}/`;
      const index = await fetchS3Index(prefix, false);
      return buildPitSymbolEvidence(symbol, index.keys, index.rawHash, `${BINANCE_DATA_VISION_BUCKET}/${prefix}`);
    }));
    evidence.push(...rows);
  }
  const manifest = buildPitManifest({
    retrievalTimestamp: new Date().toISOString(),
    rootSymbols,
    evidence,
    rootHash: root.rawHash,
  });
  await writeJson("data/pit-universe/binance-um-monthly-15m-index.json", manifest);
  return manifest;
}

async function fetchS3Index(prefix: string, delimiter: boolean): Promise<{ keys: string[]; pages: string[]; rawHash: string }> {
  const pages: string[] = [];
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const url = new URL(BINANCE_DATA_VISION_BUCKET);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", "1000");
    if (delimiter) url.searchParams.set("delimiter", "/");
    if (token) url.searchParams.set("continuation-token", token);
    const xml = await fetchIndexText(url.toString());
    pages.push(xml);
    keys.push(...parseS3Keys(xml));
    const match = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = match?.[1] ? decodeURIComponent(match[1]) : null;
  } while (token);
  return { keys: [...new Set(keys)], pages, rawHash: sha256(pages.join("\n")) };
}

async function fetchIndexText(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) return response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  } catch (fetchError) {
    const command = process.platform === "win32" ? "curl.exe" : "curl";
    try {
      const result = await execFileAsync(command, ["--location", "--fail", "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "20", url], { maxBuffer: 32 * 1024 * 1024 });
      return result.stdout;
    } catch (curlError) {
      throw new Error(`Binance Data Vision index unavailable via fetch and curl: fetch=${fetchError instanceof Error ? fetchError.message : String(fetchError)}; curl=${curlError instanceof Error ? curlError.message : String(curlError)}`);
    }
  }
}

async function writeResearchTelemetryDesign(): Promise<void> {
  const sample = serializeSignalFeatureSnapshotV2({
    schema: "SignalFeatureSnapshotV2",
    signalId: "research-design-placeholder",
    strategyVersion: "trend-rejection-short-v1",
    candidateFamily: "TREND",
    timestamp: "1970-01-01T00:00:00.000Z",
    instrument: { quoteVolume24h: null, tickSize: null, stepSize: null, pricePrecision: null, quantityPrecision: null },
    snapshot: {
      candleCount15m: 0,
      candleCount1h: 0,
      candleCount4h: 0,
      lastCandleTimestamp15m: null,
      lastCandleTimestamp1h: null,
      lastCandleTimestamp4h: null,
    },
    features: {
      atr: null,
      ema: null,
      rsi: null,
      volumeRatio: null,
      marketRegime: null,
      score: null,
      scoreComponents: {},
    },
    policy: {
      entryMode: "TREND_REJECTION",
      scoreThreshold: 70,
      sideFilter: "SHORT",
      strategyFamily: "TREND",
      regimeAlignment: "REQUIRED",
      stopATR: 0.5,
      RR: 2,
    },
    sourceHashes: { candle15m: "DATA_UNAVAILABLE", candle1h: "DATA_UNAVAILABLE", candle4h: "DATA_UNAVAILABLE", features: "DATA_UNAVAILABLE", policy: "DATA_UNAVAILABLE" },
    version: { schemaVersion: "2", producerVersion: "research-design", featureCodeVersion: "v5.4" },
  });
  await writeJson("reports/v5-4-telemetry-schema-sample.json", sample);
}

function getFrozenCandidate(): StructuralCandidateDefinition {
  const candidate = V53_CANDIDATE_REGISTRY.find((item) => item.id === FIXED_CANDIDATE_ID);
  if (!candidate) throw new Error(`Frozen candidate not found: ${FIXED_CANDIDATE_ID}`);
  if (!isFrozenCandidate(candidate)) throw new Error("Frozen SHORT candidate parameters drifted");
  return candidate;
}

function isFrozenCandidate(candidate: StructuralCandidateDefinition): boolean {
  const expected: StructuralParameters = {
    breakoutLookback: 20,
    volumeRatioMin: 1.35,
    retestDistanceATR: 0.6,
    maxExtensionATR: 0.8,
    pullbackMinATR: 0.35,
    pullbackMaxATR: 1.6,
    trendAgeMinBars: 16,
    compressionBarsMin: 8,
    compressionRangeMaxATR: 4.5,
    expansionVolumeMin: 1.25,
    expansionVolatilityMin: 1.15,
    stopATRMultiplier: 1.25,
    structureLookback: 8,
  };
  return candidate.id === FIXED_CANDIDATE_ID && JSON.stringify(candidate.parameters) === JSON.stringify(expected)
    && candidate.rewardRisk === 1.8 && candidate.stopStyle === "STRUCTURE";
}

function perturbDefinition(definition: StructuralCandidateDefinition, factor: number): StructuralCandidateDefinition {
  const parameters = { ...definition.parameters };
  const key: keyof StructuralParameters = "retestDistanceATR";
  parameters[key] *= 1 + factor;
  return { ...definition, parameters };
}

function formatFactor(factor: number): string {
  return `${factor > 0 ? "+" : ""}${Math.round(factor * 100)}%`;
}

function foldLabel(group: ValidationGroup, timestamp: number): string {
  const fold = group.folds.find((item) => isTimestampInWindow(timestamp, item.validationStart, item.validationEnd));
  return fold ? `${group.id}-${fold.id}` : "OUTSIDE_OOS";
}

function regimeFromValues(fast: Array<number | null>, slow: Array<number | null>, index: number): "BULL" | "BEAR" | "RANGE" | "UNKNOWN" {
  if (index < 5 || fast[index] === null || slow[index] === null || fast[index - 5] === null || fast[index] === 0) return "UNKNOWN";
  const slope = (fast[index]! - fast[index - 5]!) / fast[index]!;
  if (fast[index]! > slow[index]! && slope > 0.002) return "BULL";
  if (fast[index]! < slow[index]! && slope < -0.002) return "BEAR";
  return "RANGE";
}

function lookupAtOrBefore(timestamps: number[], values: number[], timestamp: number): number | null {
  let low = 0;
  let high = timestamps.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= timestamp) {
      result = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result >= 0 ? values[result] : null;
}

async function readDataset(file: CacheFile): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(file.path, "utf8")) as HistoricalDataset;
}

async function readFrozenSelectionAdjustedLcb(): Promise<number | null> {
  try {
    const report = JSON.parse(await readFile(V53_SHORT_REPORT, "utf8")) as { directions?: { SHORT?: { selectionAdjustedLCB?: number } } };
    return report.directions?.SHORT?.selectionAdjustedLCB ?? null;
  } catch {
    return null;
  }
}

function serializeMetrics(metrics: ValidationMetrics | null): SerializedMetrics | null {
  if (!metrics) return null;
  return {
    trades: metrics.trades,
    avgR: roundMetric(metrics.avgNetR) ?? 0,
    PF: Number.isFinite(metrics.profitFactor) ? roundMetric(metrics.profitFactor) : null,
    NetR: roundMetric(metrics.netR) ?? 0,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: roundMetric(metrics.winRate),
    maxDrawdownR: roundMetric(metrics.maxDrawdownR),
    lowerConfidenceBound95: roundMetric(metrics.lowerConfidenceBound95),
    positiveMonths: metrics.positiveMonths,
    months: metrics.months,
    positiveMonthRatio: roundMetric(metrics.positiveMonthRatio),
    topSymbolProfitShare: roundMetric(metrics.topSymbolProfitShare),
    topFoldProfitShare: roundMetric(metrics.topFoldProfitShare),
    totalNetPnlUsdt: roundMetric(metrics.totalNetPnlUsdt),
  };
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "DATA_UNAVAILABLE" : value.toFixed(4);
}

function emptyPitRecord(symbol: string): PitArchiveSymbolEvidence {
  return {
    symbol,
    interval: BINANCE_UM_MONTHLY_INTERVAL,
    objectCount: 0,
    observedMonths: [],
    observedFirstMonth: null,
    observedLastMonth: null,
    listingDate: null,
    delistingDate: null,
    tradableStart: null,
    tradableEnd: null,
    contractStatus: "HISTORICAL_STATUS_UNAVAILABLE",
    boundaryPrecision: "MONTH",
    source: "DATA_UNAVAILABLE",
    rawHash: "DATA_UNAVAILABLE",
  };
}

async function writeJson(relativePath: string, value: unknown): Promise<void> {
  await writeFile(resolve(relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderPitMarkdown(report: PitUniverseManifest & { validationInputSymbols: string[]; foldCoverage: Array<Record<string, unknown>> }): string {
  return [
    "# V5.4 Point-in-Time Universe Audit",
    "",
    `- Status: **${report.status}**`,
    `- Source: ${report.source}`,
    `- Retrieved: ${report.retrievalTimestamp}`,
    `- Root archive USDT-M symbols: ${report.rootArchiveSymbolCount}`,
    `- Local validation symbols with 15m monthly evidence: ${report.evidenceSymbols.length}/${report.validationInputSymbols.length}`,
    "",
    "## Method",
    ...report.methodology.map((item) => `- ${item}`),
    "",
    "## Limitations",
    ...report.limitations.map((item) => `- ${item}`),
    "",
    "## Boundary rule",
    "The first and last observed archive months are excluded from effective membership. Exact listing_date, delisting_date and historical contractStatus remain unavailable, so this report is not a Promotion verification.",
    "",
  ].join("\n");
}

function renderConfidenceMarkdown(report: { candidateCount: number; selectedCandidate: string; observations: number; confidence: { methods: Array<{ method: string; lcb95: number | null; notes: string }> }; promotionLcb95: number | null; promotionMethod: string }): string {
  return [
    "# V5.4 Confidence Audit",
    "",
    `- Candidate: **${report.selectedCandidate}**`,
    `- Preregistered candidates considered by frozen selection audit: **${report.candidateCount}**`,
    `- OOS observations: **${report.observations}**`,
    "",
    "| Method | LCB95 |",
    "|---|---:|",
    ...report.confidence.methods.map((item) => `| ${item.method} | ${item.lcb95 === null ? "DATA_UNAVAILABLE" : item.lcb95.toFixed(4)} |`),
    "",
    `- Promotion method: **${report.promotionMethod}**`,
    `- promotion_lcb95: **${report.promotionLcb95 === null ? "DATA_UNAVAILABLE" : report.promotionLcb95.toFixed(4)}**`,
    "",
    "Promotion uses the minimum available interval across naive, block, symbol-cluster, fold-cluster and selection-adjusted methods. No interval was selected for appearance.",
    "",
  ].join("\n");
}

function renderPromotionMarkdown(report: any): string {
  const fixed = report.fixedOos as SerializedMetrics;
  const holdout = report.holdout as SerializedMetrics | null;
  const cost = report.costStress;
  const gate = report.promotion as { status: string; gates: Array<{ id: string; passed: boolean; evidence: string }> };
  return [
    "# V5.4 Promotion Decision",
    "",
    "This is a research-only decision. V5.3 parameters remain frozen and no Production promotion is authorized.",
    "",
    `- PIT universe: **${report.pitUniverse.status}**`,
    `- Candidate: **${report.candidate.id}**`,
    `- Promotion status: **${gate.status}**`,
    "",
    `- OOS: ${fixed.trades} trades, AvgR ${fixed.avgR}, PF ${fixed.PF ?? "DATA_UNAVAILABLE"}, NetR ${fixed.NetR}`,
    `- promotion_lcb95: ${report.confidence.promotionLcb95 ?? "DATA_UNAVAILABLE"}`,
    `- Holdout: ${holdout ? `${holdout.trades} trades, AvgR ${holdout.avgR}, PF ${holdout.PF ?? "DATA_UNAVAILABLE"}, NetR ${holdout.NetR}` : "DATA_UNAVAILABLE"}`,
    `- +10bps: ${cost.plus10Bps.NetR} NetR`,
    `- +15bps: ${cost.plus15Bps.NetR} NetR`,
    `- Delay: ${report.delayedEntry.avgR} AvgR / ${report.delayedEntry.NetR} NetR`,
    `- Remove top3: ${report.removeTop3.NetR} NetR`,
    "",
    "## Gates",
    "| Gate | Result | Evidence |",
    "|---|---|---|",
    ...gate.gates.map((item) => `| ${item.id} | ${item.passed ? "PASS" : "FAIL"} | ${item.evidence} |`),
    "",
    "SHORT: **SHADOW_ONLY**",
    "LONG: **SHADOW_ONLY (not optimized in V5.4)**",
    "",
  ].join("\n");
}

function renderExecutiveMarkdown(report: any): string {
  return [
    "# V5.4 Evidence Hardening — Executive Summary",
    "",
    `- Frozen candidate: **${report.candidate.id}**`,
    `- PIT universe: **${report.pitUniverse.status}**`,
    `- OOS: ${report.fixedOos.trades} trades / AvgR ${report.fixedOos.avgR} / PF ${report.fixedOos.PF ?? "DATA_UNAVAILABLE"} / NetR ${report.fixedOos.NetR}`,
    `- promotion_lcb95: **${report.confidence.promotionLcb95 ?? "DATA_UNAVAILABLE"}**`,
    `- Promotion: **${report.promotion.status}**`,
    "",
    "The official public archive removes the current-universe-only proxy and supplies historical symbol/object evidence, but it does not supply exact historical contract-status snapshots or daily listing/delisting boundaries. Therefore PIT remains INCOMPLETE and no Promotion is permitted.",
    "",
    "No strategy parameters, candidates, Production configuration, Supabase schema, or Production deployment were changed.",
    "",
  ].join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
