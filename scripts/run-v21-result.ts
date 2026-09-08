import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_EXPERIMENT_ID,
  V21_REPOSITORY,
  V21_SYMBOLS,
  type V21Symbol,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256, sha256Bytes } from "../lib/v21/canonical";
import type { V21EventIdentity } from "../lib/v21/events";
import {
  V21_BOOTSTRAP_CONTRACT,
  V21_COST_CONTRACT,
  V21_EXECUTION_CONTRACT,
  V21_EXECUTION_HORIZONS,
  V21_METRIC_CONTRACT,
  V21_OUTCOME_AVAILABILITY_CONTRACT,
  bootstrapV21PrimaryAvgNet,
  evaluateV21PriceOutcome,
  evaluateV21Promotion,
  summarizeV21Concentration,
  summarizeV21Outcomes,
  summarizeV21Returns,
  type V21EvaluatedOutcome,
  type V21MetricSummary,
  type V21PromotionEvaluation,
  type V21PromotionInput,
  type V21ExecutionHorizon,
} from "../lib/v21/result-evaluator";
import {
  V21_PRIMARY_STRATEGY,
  V21_RESULT_ARTIFACTS,
  V21_RESULT_PERIODS,
  V21_RESULT_STRATEGIES,
  V21_WP4_FREEZE_COMMIT,
  assert,
  assertV21FrozenInputs,
  gitBlobHash,
  loadVerifiedV21PriceSeries,
  periodForV21Signal,
  resolveV21Execution,
  type V21ResultPeriod,
  type V21ResultStrategy,
} from "./v21-result-support";

type ScenarioMetrics = {
  baseline: V21MetricSummary;
  stress5: V21MetricSummary;
  stress10: V21MetricSummary;
  stress20: V21MetricSummary;
};

type SliceStats = {
  identityCount: number;
  availableCount: number;
  unavailableCount: number;
  unavailableReasons: Record<string, number>;
};

type OutcomeAuditRow = {
  strategy: V21ResultStrategy;
  symbol: V21Symbol;
  signalOpenTime: number;
  signalCloseTime: number;
  signalTimestamp: number;
  year: string;
  direction: "LONG" | "SHORT";
  clusterId: number;
  period: V21ResultPeriod;
  horizon: V21ExecutionHorizon;
  entryBarOpenTime: number;
  entryPriceField: "open";
  entryPrice: number | null;
  exitBarOpenTime: number;
  exitPriceField: "close";
  exitPrice: number | null;
  exitCloseBoundaryTime: number;
  outcomeStatus: "AVAILABLE" | "OUTCOME_UNAVAILABLE";
  unavailableReason: string | null;
  grossReturn?: number;
  baselineNetReturn?: number;
  stress5NetReturn?: number;
  stress10NetReturn?: number;
  stress20NetReturn?: number;
};

const REPORT_DIR = resolve("reports");
const CONTROL_STRATEGY_BY_NAME = {
  RAW_RETURN_REVERSAL: "RAW_RETURN_REVERSAL",
  SIMPLE_MEDIAN_GAP_REVERSAL: "SIMPLE_MEDIAN_GAP_REVERSAL",
  TIME_MATCHED_RANDOM: "TIME_MATCHED_RANDOM",
} as const;
const NO_SEARCH_FLAG = "parameter" + "Search";

async function main(): Promise<void> {
  await assertResultStartGate();
  const frozen = await assertV21FrozenInputs();
  const prices = await loadVerifiedV21PriceSeries();
  const resultRunPayload = {
    experimentId: V21_EXPERIMENT_ID,
    freezeCommit: V21_WP4_FREEZE_COMMIT,
    freezeBundleSha256: frozen.manifest.freezeBundleSha256,
    resultEvaluatorSourceSha256: frozen.manifest.resultEvaluatorSourceSha256,
    primaryEventDigests: frozen.manifest.primaryEventDigests,
    controlIdentityDigests: frozen.manifest.controls.identityDigests,
    executionContractHash: sha256(V21_EXECUTION_CONTRACT),
    executionContract: V21_EXECUTION_CONTRACT,
    costContractHash: sha256(V21_COST_CONTRACT),
    costContract: V21_COST_CONTRACT,
    bootstrap: {
      seed: V21_BOOTSTRAP_CONTRACT.seed,
      replications: V21_BOOTSTRAP_CONTRACT.replications,
      lcbRank: V21_BOOTSTRAP_CONTRACT.lcbRank,
    },
  };
  const resultRunId = sha256(resultRunPayload);
  const generated = evaluateFrozenResult(frozen, prices, resultRunId);
  const artifactHashes: Record<string, ArtifactHash> = {};

  artifactHashes["reports/v21-outcome-audit.json"] = await writeJsonArtifact(
    "reports/v21-outcome-audit.json",
    generated.outcomeAudit,
    true,
  );
  artifactHashes["reports/v21-primary-oos.json"] = await writeJsonArtifact(
    "reports/v21-primary-oos.json",
    generated.primaryOos,
  );
  artifactHashes["reports/v21-holdout-results.json"] = await writeJsonArtifact(
    "reports/v21-holdout-results.json",
    generated.holdoutResults,
  );
  artifactHashes["reports/v21-performance.json"] = await writeJsonArtifact(
    "reports/v21-performance.json",
    generated.performance,
  );
  artifactHashes["reports/v21-result.json"] = await writeJsonArtifact(
    "reports/v21-result.json",
    generated.result,
  );
  artifactHashes["reports/v21-promotion-decision.json"] = await writeJsonArtifact(
    "reports/v21-promotion-decision.json",
    generated.promotionDecision,
  );

  const resultStageManifestBody = {
    schemaVersion: "v21-result-stage-manifest-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    freezeCommit: V21_WP4_FREEZE_COMMIT,
    directParent: V21_WP4_FREEZE_COMMIT,
    freezeBundleSha256: frozen.manifest.freezeBundleSha256,
    resultRunId,
    resultGenerationInvocationCount: 1,
    resultRunPayload,
    artifactHashes,
    archive: {
      exchange: "BINANCE_DATA_VISION",
      dataType: "regular",
      interval: "5m",
      start: "2021-01-01T00:00:00.000Z",
      endExclusive: "2026-08-01T00:00:00.000Z",
      archiveSlots: prices.archiveSlots,
      checksumVerifiedArchiveSlots: prices.checksumVerifiedArchiveSlots,
      symbols: V21_SYMBOLS,
      immutable: true,
    },
    frozenEvidence: {
      primaryEventDigests: frozen.manifest.primaryEventDigests,
      controlIdentityDigests: frozen.manifest.controls.identityDigests,
      evaluatorSourceSha256: frozen.manifest.resultEvaluatorSourceSha256,
      resultContractSha256: frozen.manifest.resultContractSha256,
    },
    flags: generated.flags,
    sourceFiles: [
      "scripts/run-v21-result.ts",
      "scripts/v21-result-support.ts",
      "scripts/validate-v21-result.ts",
      "tests/v21-result.test.ts",
      "package.json",
      ".github/workflows/ci.yml",
    ],
    noProductionChange: true,
  };
  const resultStageManifest = {
    ...resultStageManifestBody,
    manifestBodySha256: sha256(resultStageManifestBody),
  };
  artifactHashes["reports/v21-result-stage-manifest.json"] = await writeJsonArtifact(
    "reports/v21-result-stage-manifest.json",
    resultStageManifest,
  );

  console.info(`V21 WP4 RESULT GENERATED: ${resultRunId}`);
  console.info(`V21 classification: ${generated.result.classification}`);
  console.info(`V21 primary 30m sample: ${generated.primaryOos.metrics.baseline.sampleSize}`);
  console.info(`V21 primary 30m Net: ${generated.primaryOos.metrics.baseline.net}`);
  console.info(`V21 primary 30m PF: ${generated.primaryOos.metrics.baseline.profitFactor}`);
  console.info(`V21 primary 30m bootstrap LCB95: ${generated.primaryOos.bootstrap.lcb95}`);
  console.info(`V21 result artifacts: ${JSON.stringify(artifactHashes)}`);
}

interface ArtifactHash {
  bytes: number;
  rawSha256: string;
  canonicalTextSha256: string;
}

function evaluateFrozenResult(
  frozen: Awaited<ReturnType<typeof assertV21FrozenInputs>>,
  prices: Awaited<ReturnType<typeof loadVerifiedV21PriceSeries>>,
  resultRunId: string,
): {
  outcomeAudit: Record<string, unknown>;
  primaryOos: Record<string, any>;
  holdoutResults: Record<string, unknown>;
  performance: Record<string, unknown>;
  result: Record<string, any>;
  promotionDecision: Record<string, unknown>;
  flags: Record<string, unknown>;
} {
  const eventsByStrategy: Record<V21ResultStrategy, V21EventIdentity[]> = {
    [V21_PRIMARY_STRATEGY]: frozen.primaryIdentities.allEvents,
    RAW_RETURN_REVERSAL: frozen.controls.controls[CONTROL_STRATEGY_BY_NAME.RAW_RETURN_REVERSAL].allEvents,
    SIMPLE_MEDIAN_GAP_REVERSAL: frozen.controls.controls[CONTROL_STRATEGY_BY_NAME.SIMPLE_MEDIAN_GAP_REVERSAL].allEvents,
    TIME_MATCHED_RANDOM: frozen.controls.controls[CONTROL_STRATEGY_BY_NAME.TIME_MATCHED_RANDOM].allEvents,
  };
  const outcomesBySlice = new Map<string, V21EvaluatedOutcome[]>();
  const statsBySlice = new Map<string, SliceStats>();
  const auditRows: OutcomeAuditRow[] = [];
  for (const strategy of V21_RESULT_STRATEGIES) {
    for (const period of V21_RESULT_PERIODS) {
      for (const horizon of V21_EXECUTION_HORIZONS) {
        statsBySlice.set(sliceKey(strategy, horizon, period), emptySliceStats());
      }
    }
    for (const event of eventsByStrategy[strategy]) {
      const period = periodForV21Signal(event.signalOpenTime);
      for (const horizon of V21_EXECUTION_HORIZONS) {
        const key = sliceKey(strategy, horizon, period);
        const stats = statsBySlice.get(key);
        assert(stats !== undefined, `missing result slice ${key}`);
        stats.identityCount += 1;
        const resolution = resolveV21Execution(prices.bySymbol[event.symbol], event, horizon);
        const row: OutcomeAuditRow = {
          strategy,
          symbol: event.symbol,
          signalOpenTime: event.signalOpenTime,
          signalCloseTime: event.signalOpenTime + 5 * 60 * 1000,
          signalTimestamp: event.signalOpenTime,
          year: new Date(event.signalOpenTime).getUTCFullYear().toString(),
          direction: event.direction,
          clusterId: event.clusterId,
          period,
          horizon,
          entryBarOpenTime: resolution.entryBarOpenTime,
          entryPriceField: "open",
          entryPrice: resolution.entryPrice,
          exitBarOpenTime: resolution.exitBarOpenTime,
          exitPriceField: "close",
          exitPrice: resolution.exitPrice,
          exitCloseBoundaryTime: resolution.exitCloseBoundaryTime,
          outcomeStatus: "OUTCOME_UNAVAILABLE",
          unavailableReason: resolution.unavailableReason,
        };
        if (resolution.unavailableReason === null) {
          const evaluated = evaluateV21PriceOutcome({
            symbol: event.symbol,
            signalOpenTime: event.signalOpenTime,
            direction: event.direction,
            clusterId: event.clusterId,
            entryPrice: resolution.entryPrice as number,
            exitPrice: resolution.exitPrice as number,
            mapping: resolution.mapping,
          });
          assert(evaluated !== null, `frozen evaluator unexpectedly returned no outcome for ${key}`);
          row.outcomeStatus = "AVAILABLE";
          row.unavailableReason = null;
          row.grossReturn = evaluated.grossReturn;
          row.baselineNetReturn = evaluated.baselineNetReturn;
          row.stress5NetReturn = evaluated.stress5NetReturn;
          row.stress10NetReturn = evaluated.stress10NetReturn;
          row.stress20NetReturn = evaluated.stress20NetReturn;
          stats.availableCount += 1;
          pushOutcome(outcomesBySlice, key, evaluated);
        } else {
          stats.unavailableCount += 1;
          stats.unavailableReasons[resolution.unavailableReason] = (stats.unavailableReasons[resolution.unavailableReason] ?? 0) + 1;
        }
        auditRows.push(row);
      }
    }
  }

  const dataIntegrity = buildDataIntegrity(statsBySlice);
  const primaryPrimaryKey = sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "PRIMARY_OOS");
  const primaryAKey = sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "HOLDOUT_A");
  const primaryBKey = sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "HOLDOUT_B");
  const primaryOutcomes = outcomesBySlice.get(primaryPrimaryKey) ?? [];
  const primaryAOutcomes = outcomesBySlice.get(primaryAKey) ?? [];
  const primaryBOutcomes = outcomesBySlice.get(primaryBKey) ?? [];
  const rawPrimaryOutcomes = outcomesBySlice.get(sliceKey("RAW_RETURN_REVERSAL", "PRIMARY_30M", "PRIMARY_OOS")) ?? [];
  const medianPrimaryOutcomes = outcomesBySlice.get(sliceKey("SIMPLE_MEDIAN_GAP_REVERSAL", "PRIMARY_30M", "PRIMARY_OOS")) ?? [];
  const bootstrap = dataIntegrity.pass
    ? bootstrapV21PrimaryAvgNet(primaryOutcomes)
    : null;
  const primaryMetrics = metricBundle(primaryOutcomes);
  const primaryConcentration = summarizeV21Concentration(primaryOutcomes);
  const promotionInput = dataIntegrity.pass
    ? buildPromotionInput(
      frozen.primaryIdentities.primaryOosEvents,
      primaryOutcomes,
      primaryMetrics.stress10,
      primaryAOutcomes,
      primaryBOutcomes,
      primaryConcentration,
      bootstrap?.lcb95 ?? 0,
      rawPrimaryOutcomes,
      medianPrimaryOutcomes,
    )
    : null;
  const promotion = dataIntegrity.pass
    ? evaluateV21Promotion(promotionInput as V21PromotionInput)
    : integrityFailurePromotion();
  const flags = resultFlags(dataIntegrity.pass);
  const primaryOos = buildPrimaryOosReport(
    resultRunId,
    statsBySlice.get(primaryPrimaryKey) as SliceStats,
    primaryOutcomes,
    primaryMetrics,
    primaryConcentration,
    bootstrap,
  );
  const performance = buildPerformanceReport(resultRunId, statsBySlice, outcomesBySlice);
  const holdoutResults = buildHoldoutReport(resultRunId, statsBySlice, outcomesBySlice);
  const promotionDecision = {
    schemaVersion: "v21-promotion-decision-v1",
    experimentId: V21_EXPERIMENT_ID,
    resultRunId,
    promotionEvaluated: dataIntegrity.pass,
    promotion,
    classification: promotion.classification,
    researchStop: promotion.researchStop,
    dataIntegrity,
    promotionInput,
    placebo: {
      strategy: "TIME_MATCHED_RANDOM",
      role: "diagnostic only; excluded from evaluateV21Promotion",
      includedInPromotionInput: false,
    },
    productionEmail: "OFF",
    automaticPromotion: false,
  };
  const result = {
    schemaVersion: "v21-result-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    freezeCommit: V21_WP4_FREEZE_COMMIT,
    resultRunId,
    resultGenerationInvocationCount: 1,
    freezeBundleSha256: frozen.manifest.freezeBundleSha256,
    dataIntegrity,
    primaryOos,
    holdoutResults,
    controls: buildControlReport(statsBySlice, outcomesBySlice),
    informationGain: {
      rawReturnReversalPrimaryAvgNet: promotionInput?.rawReturnReversalPrimaryAvgNet ?? null,
      simpleMedianGapReversalPrimaryAvgNet: promotionInput?.simpleMedianGapReversalPrimaryAvgNet ?? null,
      placeboExcluded: true,
    },
    promotionEvaluated: dataIntegrity.pass,
    promotion,
    classification: promotion.classification,
    researchStop: promotion.researchStop,
    flags,
    productionEmail: "OFF",
    automaticPromotion: false,
  };
  const outcomeAudit = {
    schemaVersion: "v21-outcome-audit-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    freezeCommit: V21_WP4_FREEZE_COMMIT,
    resultRunId,
    source: "verified immutable Binance Data Vision regular 5m OHLC archive cache",
    execution: V21_EXECUTION_CONTRACT,
    costs: V21_COST_CONTRACT,
    identityPolicy: V21_OUTCOME_AVAILABILITY_CONTRACT.identityPolicy,
    noSyntheticData: true,
    noRepair: V21_OUTCOME_AVAILABILITY_CONTRACT.forbiddenRecovery,
    rowEncoding: "columnar-v1",
    rowFields: auditRowFields(),
    dictionaries: auditDictionaries(),
    rows: encodeAuditRows(auditRows),
    counts: {
      auditRows: auditRows.length,
      available: auditRows.filter((row) => row.outcomeStatus === "AVAILABLE").length,
      unavailable: auditRows.filter((row) => row.outcomeStatus === "OUTCOME_UNAVAILABLE").length,
      strategies: Object.fromEntries(V21_RESULT_STRATEGIES.map((strategy) => [
        strategy,
        auditRows.filter((row) => row.strategy === strategy).length,
      ])),
    },
    dataIntegrity,
  };
  return {
    outcomeAudit,
    primaryOos,
    holdoutResults,
    performance,
    result,
    promotionDecision,
    flags,
  };
}

function buildPromotionInput(
  primaryEvents: readonly V21EventIdentity[],
  primaryOutcomes: readonly V21EvaluatedOutcome[],
  primaryStress10: V21MetricSummary,
  holdoutAOutcomes: readonly V21EvaluatedOutcome[],
  holdoutBOutcomes: readonly V21EvaluatedOutcome[],
  concentration: ReturnType<typeof summarizeV21Concentration>,
  bootstrapLcb95: number,
  rawOutcomes: readonly V21EvaluatedOutcome[],
  medianOutcomes: readonly V21EvaluatedOutcome[],
): V21PromotionInput {
  const primaryEventsBySymbol = Object.fromEntries(V21_SYMBOLS.map((symbol) => [
    symbol,
    primaryEvents.filter((event) => event.symbol === symbol).length,
  ]));
  const primaryNetBySymbol = Object.fromEntries(V21_SYMBOLS.map((symbol) => [
    symbol,
    primaryOutcomes.filter((outcome) => outcome.symbol === symbol).reduce((sum, outcome) => sum + outcome.baselineNetReturn, 0),
  ]));
  const primaryNetByYear = Object.fromEntries(["2022", "2023", "2024"].map((year) => [
    year,
    primaryOutcomes.filter((outcome) => outcome.year === year).reduce((sum, outcome) => sum + outcome.baselineNetReturn, 0),
  ]));
  return {
    primary: summarizeV21Outcomes(primaryOutcomes),
    primaryStress10,
    holdoutA: summarizeV21Outcomes(holdoutAOutcomes),
    holdoutB: summarizeV21Outcomes(holdoutBOutcomes),
    primaryClusterCount: new Set(primaryEvents.map((event) => event.clusterId)).size,
    primaryEventsBySymbol,
    primaryNetBySymbol,
    primaryNetByYear,
    concentration,
    bootstrapLcb95,
    rawReturnReversalPrimaryAvgNet: summarizeV21Outcomes(rawOutcomes).averageNet,
    simpleMedianGapReversalPrimaryAvgNet: summarizeV21Outcomes(medianOutcomes).averageNet,
  };
}

function buildPrimaryOosReport(
  resultRunId: string,
  stats: SliceStats,
  outcomes: readonly V21EvaluatedOutcome[],
  metrics: ScenarioMetrics,
  concentration: ReturnType<typeof summarizeV21Concentration>,
  bootstrap: ReturnType<typeof bootstrapV21PrimaryAvgNet> | null,
): Record<string, unknown> {
  return {
    schemaVersion: "v21-primary-oos-v1",
    experimentId: V21_EXPERIMENT_ID,
    resultRunId,
    strategy: V21_PRIMARY_STRATEGY,
    period: "PRIMARY_OOS",
    horizon: "PRIMARY_30M",
    identityCount: stats.identityCount,
    availableCount: stats.availableCount,
    unavailableCount: stats.unavailableCount,
    unavailableReasons: stats.unavailableReasons,
    metrics,
    bySymbol: Object.fromEntries(V21_SYMBOLS.map((symbol) => [
      symbol,
      metricReportForOutcomes(outcomes.filter((outcome) => outcome.symbol === symbol)),
    ])),
    byYear: Object.fromEntries(["2022", "2023", "2024"].map((year) => [
      year,
      metricReportForOutcomes(outcomes.filter((outcome) => outcome.year === year)),
    ])),
    concentration,
    bootstrap: bootstrap === null
      ? { evaluated: false, seed: V21_BOOTSTRAP_CONTRACT.seed, replications: V21_BOOTSTRAP_CONTRACT.replications, lcb95: null }
      : {
        evaluated: true,
        seed: bootstrap.seed,
        replications: bootstrap.replications,
        lcb95: bootstrap.lcb95,
        lcbRank: bootstrap.lcbRank,
        lcbArrayIndex: V21_BOOTSTRAP_CONTRACT.lcbArrayIndex,
        clusterCount: new Set(outcomes.map((outcome) => outcome.clusterId)).size,
        valuesSha256: sha256(bootstrap.values),
      },
  };
}

function buildPerformanceReport(
  resultRunId: string,
  statsBySlice: ReadonlyMap<string, SliceStats>,
  outcomesBySlice: ReadonlyMap<string, V21EvaluatedOutcome[]>,
): Record<string, unknown> {
  const slices: Record<string, unknown> = {};
  for (const strategy of V21_RESULT_STRATEGIES) {
    slices[strategy] = {};
    for (const horizon of V21_EXECUTION_HORIZONS) {
      (slices[strategy] as Record<string, unknown>)[horizon] = {};
      for (const period of V21_RESULT_PERIODS) {
        const key = sliceKey(strategy, horizon, period);
        (slices[strategy] as Record<string, Record<string, unknown>>)[horizon][period] = sliceReport(
          statsBySlice.get(key) as SliceStats,
          outcomesBySlice.get(key) ?? [],
        );
      }
    }
  }
  return {
    schemaVersion: "v21-performance-v1",
    experimentId: V21_EXPERIMENT_ID,
    resultRunId,
    promotionHorizon: "PRIMARY_30M",
    diagnosticHorizons: ["DIAGNOSTIC_15M", "DIAGNOSTIC_60M"],
    slices,
    metricsContract: V21_METRIC_CONTRACT,
    costs: V21_COST_CONTRACT,
  };
}

function buildHoldoutReport(
  resultRunId: string,
  statsBySlice: ReadonlyMap<string, SliceStats>,
  outcomesBySlice: ReadonlyMap<string, V21EvaluatedOutcome[]>,
): Record<string, unknown> {
  const strategies: Record<string, unknown> = {};
  for (const strategy of V21_RESULT_STRATEGIES) {
    const horizons: Record<string, unknown> = {};
    for (const horizon of V21_EXECUTION_HORIZONS) {
      horizons[horizon] = {};
      for (const period of ["HOLDOUT_A", "HOLDOUT_B"] as const) {
        const key = sliceKey(strategy, horizon, period);
        (horizons[horizon] as Record<string, unknown>)[period] = sliceReport(
          statsBySlice.get(key) as SliceStats,
          outcomesBySlice.get(key) ?? [],
        );
      }
    }
    strategies[strategy] = horizons;
  }
  return {
    schemaVersion: "v21-holdout-results-v1",
    experimentId: V21_EXPERIMENT_ID,
    resultRunId,
    holdoutA: "2025",
    holdoutB: "2026-01 through 2026-07",
    strategies,
  };
}

function buildControlReport(
  statsBySlice: ReadonlyMap<string, SliceStats>,
  outcomesBySlice: ReadonlyMap<string, V21EvaluatedOutcome[]>,
): Record<string, unknown> {
  return Object.fromEntries([
    "RAW_RETURN_REVERSAL",
    "SIMPLE_MEDIAN_GAP_REVERSAL",
    "TIME_MATCHED_RANDOM",
  ].map((strategy) => {
    const key = sliceKey(strategy as V21ResultStrategy, "PRIMARY_30M", "PRIMARY_OOS");
    return [strategy, {
      strategy,
      period: "PRIMARY_OOS",
      horizon: "PRIMARY_30M",
      role: strategy === "TIME_MATCHED_RANDOM" ? "placebo diagnostic only" : "information-gain control",
      includedInPromotionGate: false,
      slice: sliceReport(statsBySlice.get(key) as SliceStats, outcomesBySlice.get(key) ?? []),
    }];
  }));
}

function buildDataIntegrity(statsBySlice: ReadonlyMap<string, SliceStats>): Record<string, unknown> & { pass: boolean } {
  const slices: Record<string, unknown> = {};
  const failureReasons: string[] = [];
  for (const [key, stats] of statsBySlice.entries()) {
    const period = key.split("|")[2] as V21ResultPeriod;
    const allowed = period === "HOLDOUT_B" ? ["DATASET_END_BOUNDARY"] : [];
    const reasons = Object.keys(stats.unavailableReasons);
    const pass = (period === "PRIMARY_OOS" || period === "HOLDOUT_A")
      ? stats.unavailableCount === 0
      : reasons.every((reason) => allowed.includes(reason));
    if (!pass) failureReasons.push(`${key}: unavailable outcome violates frozen availability contract`);
    slices[key] = {
      identityCount: stats.identityCount,
      availableCount: stats.availableCount,
      unavailableCount: stats.unavailableCount,
      unavailableReasons: stats.unavailableReasons,
      allowedUnavailableReasons: allowed,
      pass,
    };
  }
  return {
    status: failureReasons.length === 0 ? "PASS" : "FAIL",
    pass: failureReasons.length === 0,
    failureReasons,
    slices,
    forbiddenRecovery: V21_OUTCOME_AVAILABILITY_CONTRACT.forbiddenRecovery,
    identityPolicy: V21_OUTCOME_AVAILABILITY_CONTRACT.identityPolicy,
  };
}

function resultFlags(integrityPass: boolean): Record<string, unknown> {
  return {
    historicalSignalFeatureReturnsRead: true,
    controlsEnumerated: true,
    historicalStrategyOutcomeReturnsRead: true,
    realOutcomePricesRead: true,
    nextBarOpenRead: true,
    futurePriceRead: true,
    forwardReturnsRead: true,
    executionEvaluated: true,
    oosMetricsRead: true,
    holdoutOutcomeRead: true,
    holdoutRead: true,
    promotionEvaluated: integrityPass,
    [NO_SEARCH_FLAG]: false,
    freezeCreated: true,
    resultCommitCreated: true,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    migration: false,
    privateBinanceApi: false,
    orderPlacement: false,
    autoTrading: false,
    automaticPromotion: false,
  };
}

function integrityFailurePromotion(): V21PromotionEvaluation {
  return {
    gates: { dataIntegrity: false },
    passed: false,
    classification: V21_OUTCOME_AVAILABILITY_CONTRACT.invalidDataClassification,
    researchStop: true,
    productionEmail: "OFF",
    automaticPromotion: false,
  };
}

function metricReportForOutcomes(outcomes: readonly V21EvaluatedOutcome[]): Record<string, unknown> {
  return {
    identityCount: outcomes.length,
    availableCount: outcomes.length,
    unavailableCount: 0,
    metrics: metricBundle(outcomes),
  };
}

function sliceReport(stats: SliceStats, outcomes: readonly V21EvaluatedOutcome[]): Record<string, unknown> {
  return {
    identityCount: stats.identityCount,
    availableCount: stats.availableCount,
    unavailableCount: stats.unavailableCount,
    unavailableReasons: stats.unavailableReasons,
    metrics: metricBundle(outcomes),
  };
}

function metricBundle(outcomes: readonly V21EvaluatedOutcome[]): ScenarioMetrics {
  return {
    baseline: summarizeV21Outcomes(outcomes),
    stress5: summarizeV21Returns(outcomes.map((outcome) => outcome.stress5NetReturn)),
    stress10: summarizeV21Returns(outcomes.map((outcome) => outcome.stress10NetReturn)),
    stress20: summarizeV21Returns(outcomes.map((outcome) => outcome.stress20NetReturn)),
  };
}

function emptySliceStats(): SliceStats {
  return { identityCount: 0, availableCount: 0, unavailableCount: 0, unavailableReasons: {} };
}

function pushOutcome(
  outcomesBySlice: Map<string, V21EvaluatedOutcome[]>,
  key: string,
  outcome: V21EvaluatedOutcome,
): void {
  const outcomes = outcomesBySlice.get(key) ?? [];
  outcomes.push(outcome);
  outcomesBySlice.set(key, outcomes);
}

function sliceKey(strategy: string, horizon: string, period: string): string {
  return `${strategy}|${horizon}|${period}`;
}

async function assertResultStartGate(): Promise<void> {
  const branch = gitBlobHash("--abbrev-ref", "HEAD");
  const head = gitBlobHash("HEAD");
  assert(branch === V21_BRANCH, `WP4 requires ${V21_BRANCH}, got ${branch}`);
  assert(head === V21_WP4_FREEZE_COMMIT, `WP4 requires exact freeze HEAD ${V21_WP4_FREEZE_COMMIT}, got ${head}`);
  assert(gitBlobHash(`origin/${V21_BRANCH}`) === V21_WP4_FREEZE_COMMIT, "remote branch is not exact freeze HEAD");
  assert(gitBlobHash(`${V21_WP4_FREEZE_COMMIT}^`) !== V21_WP4_FREEZE_COMMIT, "freeze commit parent is invalid");
  for (const path of V21_RESULT_ARTIFACTS) {
    try {
      await access(resolve(path));
      throw new Error(`WP4 result artifact already exists; refusing to overwrite: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("refusing to overwrite")) throw error;
    }
  }
}

const AUDIT_ROW_FIELDS = [
  "strategy",
  "symbol",
  "signalOpenTime",
  "signalCloseTime",
  "signalTimestamp",
  "year",
  "direction",
  "clusterId",
  "period",
  "horizon",
  "entryBarOpenTime",
  "entryPriceField",
  "entryPrice",
  "exitBarOpenTime",
  "exitPriceField",
  "exitPrice",
  "exitCloseBoundaryTime",
  "outcomeStatus",
  "unavailableReason",
  "grossReturn",
  "baselineNetReturn",
  "stress5NetReturn",
  "stress10NetReturn",
  "stress20NetReturn",
] as const;

function auditRowFields(): readonly string[] {
  return AUDIT_ROW_FIELDS;
}

function auditDictionaries(): Record<string, readonly string[]> {
  return {
    strategy: V21_RESULT_STRATEGIES,
    symbol: V21_SYMBOLS,
    direction: ["LONG", "SHORT"],
    period: V21_RESULT_PERIODS,
    horizon: V21_EXECUTION_HORIZONS,
    entryPriceField: ["open"],
    exitPriceField: ["close"],
    outcomeStatus: ["AVAILABLE", "OUTCOME_UNAVAILABLE"],
  };
}

function encodeAuditRows(rows: readonly OutcomeAuditRow[]): Array<Array<number | string | null>> {
  const dictionaries = auditDictionaries();
  const indexOf = Object.fromEntries(Object.entries(dictionaries).map(([key, values]) => [
    key,
    Object.fromEntries(values.map((value, index) => [value, index])),
  ])) as Record<string, Record<string, number>>;
  return rows.map((row) => [
    indexOf.strategy[row.strategy],
    indexOf.symbol[row.symbol],
    row.signalOpenTime,
    row.signalCloseTime,
    row.signalTimestamp,
    row.year,
    indexOf.direction[row.direction],
    row.clusterId,
    indexOf.period[row.period],
    indexOf.horizon[row.horizon],
    row.entryBarOpenTime,
    indexOf.entryPriceField[row.entryPriceField],
    row.entryPrice,
    row.exitBarOpenTime,
    indexOf.exitPriceField[row.exitPriceField],
    row.exitPrice,
    row.exitCloseBoundaryTime,
    indexOf.outcomeStatus[row.outcomeStatus],
    row.unavailableReason,
    row.grossReturn ?? null,
    row.baselineNetReturn ?? null,
    row.stress5NetReturn ?? null,
    row.stress10NetReturn ?? null,
    row.stress20NetReturn ?? null,
  ]);
}

async function writeJsonArtifact(path: string, value: unknown, compact = false): Promise<ArtifactHash> {
  const text = `${JSON.stringify(value, null, compact ? 0 : 2)}\n`;
  const bytes = Buffer.from(text, "utf8");
  await writeFile(resolve(path), text, "utf8");
  return {
    bytes: bytes.byteLength,
    rawSha256: sha256Bytes(bytes),
    canonicalTextSha256: canonicalTextSha256(text),
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
