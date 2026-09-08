import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_INTERVAL_MS,
  V21_START_TIMESTAMP,
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
  V21_OUTCOME_AVAILABILITY_CONTRACT,
  bootstrapV21PrimaryAvgNet,
  deriveV21Year,
  evaluateV21PriceOutcome,
  evaluateV21Promotion,
  mapV21ExecutionIndices,
  summarizeV21Concentration,
  summarizeV21Outcomes,
  summarizeV21Returns,
  type V21EvaluatedOutcome,
  type V21ExecutionHorizon,
  type V21MetricSummary,
  type V21PromotionInput,
} from "../lib/v21/result-evaluator";
import {
  V21_PRIMARY_STRATEGY,
  V21_RESULT_ARTIFACTS,
  V21_RESULT_PERIODS,
  V21_RESULT_STRATEGIES,
  V21_WP4_FREEZE_COMMIT,
  V21_WP4_RESULT_COMMIT,
  assert,
  assertV21FrozenInputs,
  gitBlobHash,
  isV21ArchiveCacheMaterialized,
  loadVerifiedV21PriceSeries,
  periodForV21Signal,
  resolveV21Execution,
  type V21ResultPeriod,
  type V21ResultStrategy,
} from "./v21-result-support";

type AuditRow = {
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

type SliceStats = {
  identityCount: number;
  availableCount: number;
  unavailableCount: number;
  unavailableReasons: Record<string, number>;
};

const CONTROL_NAMES = ["RAW_RETURN_REVERSAL", "SIMPLE_MEDIAN_GAP_REVERSAL", "TIME_MATCHED_RANDOM"] as const;
const NO_SEARCH_FLAG = "parameter" + "Search";

async function main(): Promise<void> {
  await assertResultHead();
  await assertResultArtifactsExist();
  const frozen = await assertV21FrozenInputs();
  await assertRunnerPlumbing();
  const stage = await readJson<any>("reports/v21-result-stage-manifest.json");
  const audit = await readJson<any>("reports/v21-outcome-audit.json");
  const primary = await readJson<any>("reports/v21-primary-oos.json");
  const holdouts = await readJson<any>("reports/v21-holdout-results.json");
  const performance = await readJson<any>("reports/v21-performance.json");
  const result = await readJson<any>("reports/v21-result.json");
  const decision = await readJson<any>("reports/v21-promotion-decision.json");

  assert(stage.schemaVersion === "v21-result-stage-manifest-v1", "result stage schema");
  assert(stage.experimentId === V21_EXPERIMENT_ID, "result stage experiment");
  assert(stage.branch === V21_BRANCH, "result stage branch");
  assert(stage.freezeCommit === V21_WP4_FREEZE_COMMIT && stage.directParent === V21_WP4_FREEZE_COMMIT, "result direct parent");
  assert(stage.resultGenerationInvocationCount === 1, "result generation invocation count");
  assert(stage.resultRunId === sha256(stage.resultRunPayload), "resultRunId is not the frozen canonical payload hash");
  assert(stage.freezeBundleSha256 === frozen.manifest.freezeBundleSha256, "result freeze bundle link");
  assert(stage.flags?.[NO_SEARCH_FLAG] === false, "result search boundary");
  assert(stage.flags?.productionChanged === false && stage.flags?.productionEmail === "OFF", "result production boundary");
  assert(stage.flags?.deploy === false && stage.flags?.merge === false && stage.flags?.migration === false, "result mutation boundary");
  assert(stage.flags?.privateBinanceApi === false && stage.flags?.orderPlacement === false && stage.flags?.autoTrading === false, "private trading boundary");
  assert(stage.manifestBodySha256 === sha256(withoutKey(stage, "manifestBodySha256")), "result stage manifest body hash");

  const artifactHashes = stage.artifactHashes as Record<string, { bytes: number; rawSha256: string; canonicalTextSha256: string }>;
  for (const path of V21_RESULT_ARTIFACTS.filter((entry) => entry !== "reports/v21-result-stage-manifest.json")) {
    const expected = artifactHashes[path];
    assert(expected !== undefined, `missing artifact hash for ${path}`);
    const bytes = await readFile(resolve(path));
    const text = new TextDecoder().decode(bytes);
    assert(expected.bytes === bytes.byteLength, `artifact byte count ${path}`);
    assert(expected.rawSha256 === sha256Bytes(bytes), `artifact raw hash ${path}`);
    assert(expected.canonicalTextSha256 === canonicalTextSha256(text), `artifact canonical hash ${path}`);
  }

  const prices = await loadResultValidationPrices();
  const reconstructed = verifyAuditRows(frozen, audit, prices);
  const integrity = buildDataIntegrity(reconstructed.stats);
  assert(sha256(audit.dataIntegrity) === sha256(integrity), "audit data integrity");
  assert(sha256(result.dataIntegrity) === sha256(integrity), "result data integrity");
  assert(integrity.pass === result.promotionEvaluated, "promotion evaluated boundary");
  assert(audit.rows.length === reconstructed.rowsSeen, "audit row count");
  assert(audit.counts.auditRows === audit.rows.length, "audit count");
  assert(audit.counts.available === reconstructed.availableCount, "audit available count");
  assert(audit.counts.unavailable === reconstructed.unavailableCount, "audit unavailable count");

  verifyPerformance(performance, reconstructed.stats, reconstructed.outcomes);
  verifyHoldouts(holdouts, reconstructed.stats, reconstructed.outcomes);
  const primaryKey = sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "PRIMARY_OOS");
  const primaryOutcomes = reconstructed.outcomes.get(primaryKey) ?? [];
  const primaryStats = reconstructed.stats.get(primaryKey) as SliceStats;
  verifyPrimary(primary, primaryStats, primaryOutcomes, integrity.pass);
  verifyControls(result, reconstructed.stats, reconstructed.outcomes);

  const promotionInput = buildPromotionInput(frozen, reconstructed, primaryOutcomes, integrity.pass);
  const expectedPromotion = integrity.pass
    ? evaluateV21Promotion(promotionInput as V21PromotionInput)
    : integrityFailurePromotion();
  assert(sha256(decision.promotionInput) === sha256(promotionInput), "promotion input");
  assert(sha256(decision.promotion) === sha256(expectedPromotion), "promotion evaluation");
  assert(sha256(result.promotion) === sha256(expectedPromotion), "result promotion evaluation");
  assert(decision.promotionEvaluated === integrity.pass, "decision promotion boundary");
  assert(JSON.stringify(decision.promotionInput).includes("TIME_MATCHED_RANDOM") === false, "placebo leaked into promotion input");
  assert(decision.placebo?.includedInPromotionInput === false, "placebo promotion exclusion");
  assert(result.classification === expectedPromotion.classification, "result classification");
  assert(result.researchStop === expectedPromotion.researchStop, "research stop");
  assert(sha256(result.flags) === sha256(stage.flags), "result flags");
  assert(sha256(decision.promotion) === sha256(result.promotion), "decision/result promotion consistency");
  assert(result.resultGenerationInvocationCount === 1, "result invocation count");
  assert(result.freezeCommit === V21_WP4_FREEZE_COMMIT, "result freeze commit");
  assert(result.productionEmail === "OFF" && result.automaticPromotion === false, "result production boundary");
  console.info("V21 result validation PASS");
  console.info(`V21 resultRunId: ${stage.resultRunId}`);
  console.info(`V21 classification: ${result.classification}`);
}

async function loadResultValidationPrices(): Promise<Awaited<ReturnType<typeof loadVerifiedV21PriceSeries>> | null> {
  if (await isV21ArchiveCacheMaterialized()) return loadVerifiedV21PriceSeries();
  if (process.env.CI === "true") {
    console.warn("V21 result validation: no local archive cache in CI; using committed-artifact execution witness");
    return null;
  }
  return loadVerifiedV21PriceSeries();
}

function verifyAuditRows(
  frozen: Awaited<ReturnType<typeof assertV21FrozenInputs>>,
  audit: any,
  prices: Awaited<ReturnType<typeof loadVerifiedV21PriceSeries>> | null,
): { stats: Map<string, SliceStats>; outcomes: Map<string, V21EvaluatedOutcome[]>; rowsSeen: number; availableCount: number; unavailableCount: number } {
  const eventsByStrategy: Record<V21ResultStrategy, V21EventIdentity[]> = {
    [V21_PRIMARY_STRATEGY]: frozen.primaryIdentities.allEvents,
    RAW_RETURN_REVERSAL: frozen.controls.controls.RAW_RETURN_REVERSAL.allEvents,
    SIMPLE_MEDIAN_GAP_REVERSAL: frozen.controls.controls.SIMPLE_MEDIAN_GAP_REVERSAL.allEvents,
    TIME_MATCHED_RANDOM: frozen.controls.controls.TIME_MATCHED_RANDOM.allEvents,
  };
  const expected = new Map<string, V21EventIdentity>();
  const stats = new Map<string, SliceStats>();
  const outcomes = new Map<string, V21EvaluatedOutcome[]>();
  for (const strategy of V21_RESULT_STRATEGIES) {
    for (const event of eventsByStrategy[strategy]) {
      const period = periodForV21Signal(event.signalOpenTime);
      for (const horizon of V21_EXECUTION_HORIZONS) {
        const key = rowKey(strategy, event, horizon);
        expected.set(key, event);
        stats.set(sliceKey(strategy, horizon, period), emptyStats());
      }
    }
  }

  assert(audit.rowEncoding === "columnar-v1", "audit row encoding");
  assert(JSON.stringify(audit.rowFields) === JSON.stringify(AUDIT_ROW_FIELDS), "audit row fields");
  const rows = decodeAuditRows(audit);
  let availableCount = 0;
  let unavailableCount = 0;
  for (const row of rows) {
    const eventKey = rowKey(row.strategy, row, row.horizon);
    const event = expected.get(eventKey);
    assert(event !== undefined, `audit row is not a frozen identity: ${eventKey}`);
    expected.delete(eventKey);
    assert(row.period === periodForV21Signal(row.signalOpenTime), `audit period ${eventKey}`);
    assert(row.year === deriveV21Year(row.signalOpenTime), `audit UTC year ${eventKey}`);
    assert(row.signalCloseTime === row.signalOpenTime + 5 * 60 * 1000, `audit signal close ${eventKey}`);
    assert(row.signalTimestamp === row.signalOpenTime, `audit signal timestamp ${eventKey}`);
    assert(row.clusterId === row.signalOpenTime, `audit cluster identity ${eventKey}`);
    assert(row.entryPriceField === "open" && row.exitPriceField === "close", `audit price fields ${eventKey}`);
    assert(row.outcomeStatus === "AVAILABLE" || row.outcomeStatus === "OUTCOME_UNAVAILABLE", `audit outcome status ${eventKey}`);
    const resolution = prices
      ? resolveV21Execution(prices.bySymbol[row.symbol], event, row.horizon)
      : resolveCommittedAuditExecution(row, event, row.horizon);
    assert(row.entryBarOpenTime === resolution.entryBarOpenTime, `audit entry time ${eventKey}`);
    assert(row.exitBarOpenTime === resolution.exitBarOpenTime, `audit exit time ${eventKey}`);
    assert(row.exitCloseBoundaryTime === resolution.exitCloseBoundaryTime, `audit close boundary ${eventKey}`);
    assert(row.entryPrice === resolution.entryPrice, `audit entry price ${eventKey}`);
    assert(row.exitPrice === resolution.exitPrice, `audit exit price ${eventKey}`);
    const key = sliceKey(row.strategy, row.horizon, row.period);
    const slice = stats.get(key);
    assert(slice !== undefined, `audit slice ${key}`);
    slice.identityCount += 1;
    if (resolution.unavailableReason === null) {
      assert(row.outcomeStatus === "AVAILABLE" && row.unavailableReason === null, `available row status ${eventKey}`);
      const evaluated = evaluateV21PriceOutcome({
        symbol: row.symbol,
        signalOpenTime: row.signalOpenTime,
        direction: row.direction,
        clusterId: row.clusterId,
        entryPrice: row.entryPrice as number,
        exitPrice: row.exitPrice as number,
        mapping: resolution.mapping,
      });
      assert(evaluated !== null, `evaluator output ${eventKey}`);
      assert(row.grossReturn === evaluated.grossReturn, `gross return ${eventKey}`);
      assert(row.baselineNetReturn === evaluated.baselineNetReturn, `baseline net ${eventKey}`);
      assert(row.stress5NetReturn === evaluated.stress5NetReturn, `stress 5 ${eventKey}`);
      assert(row.stress10NetReturn === evaluated.stress10NetReturn, `stress 10 ${eventKey}`);
      assert(row.stress20NetReturn === evaluated.stress20NetReturn, `stress 20 ${eventKey}`);
      slice.availableCount += 1;
      pushOutcome(outcomes, key, evaluated);
      availableCount += 1;
    } else {
      assert(row.outcomeStatus === "OUTCOME_UNAVAILABLE", `unavailable row status ${eventKey}`);
      assert(row.unavailableReason === resolution.unavailableReason, `unavailable reason ${eventKey}`);
      assert(row.grossReturn === undefined && row.baselineNetReturn === undefined, `unavailable row has returns ${eventKey}`);
      slice.unavailableCount += 1;
      slice.unavailableReasons[resolution.unavailableReason] = (slice.unavailableReasons[resolution.unavailableReason] ?? 0) + 1;
      unavailableCount += 1;
    }
  }
  assert(expected.size === 0, `missing frozen audit rows: ${expected.size}`);
  return { stats, outcomes, rowsSeen: rows.length, availableCount, unavailableCount };
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

function decodeAuditRows(audit: any): AuditRow[] {
  const dictionaries = audit.dictionaries ?? {};
  const requiredDictionaries = ["strategy", "symbol", "direction", "period", "horizon", "entryPriceField", "exitPriceField", "outcomeStatus"];
  for (const name of requiredDictionaries) assert(Array.isArray(dictionaries[name]), `audit dictionary ${name}`);
  return (audit.rows as Array<Array<number | string | null>>).map((encoded, rowIndex) => {
    assert(encoded.length === AUDIT_ROW_FIELDS.length, `audit encoded row width ${rowIndex}`);
    const value = (index: number): number | string | null => encoded[index];
    const dictionaryValue = (name: string, index: number): string => {
      const dictionary = dictionaries[name] as string[];
      assert(Number.isInteger(index) && dictionary[index] !== undefined, `audit dictionary index ${name}/${rowIndex}`);
      return dictionary[index];
    };
    const nullableNumber = (index: number): number | undefined => {
      const raw = value(index);
      return raw === null ? undefined : raw as number;
    };
    return {
      strategy: dictionaryValue("strategy", value(0) as number) as V21ResultStrategy,
      symbol: dictionaryValue("symbol", value(1) as number) as V21Symbol,
      signalOpenTime: value(2) as number,
      signalCloseTime: value(3) as number,
      signalTimestamp: value(4) as number,
      year: value(5) as string,
      direction: dictionaryValue("direction", value(6) as number) as "LONG" | "SHORT",
      clusterId: value(7) as number,
      period: dictionaryValue("period", value(8) as number) as V21ResultPeriod,
      horizon: dictionaryValue("horizon", value(9) as number) as V21ExecutionHorizon,
      entryBarOpenTime: value(10) as number,
      entryPriceField: dictionaryValue("entryPriceField", value(11) as number) as "open",
      entryPrice: value(12) as number | null,
      exitBarOpenTime: value(13) as number,
      exitPriceField: dictionaryValue("exitPriceField", value(14) as number) as "close",
      exitPrice: value(15) as number | null,
      exitCloseBoundaryTime: value(16) as number,
      outcomeStatus: dictionaryValue("outcomeStatus", value(17) as number) as "AVAILABLE" | "OUTCOME_UNAVAILABLE",
      unavailableReason: value(18) as string | null,
      grossReturn: nullableNumber(19),
      baselineNetReturn: nullableNumber(20),
      stress5NetReturn: nullableNumber(21),
      stress10NetReturn: nullableNumber(22),
      stress20NetReturn: nullableNumber(23),
    };
  });
}

function resolveCommittedAuditExecution(
  row: AuditRow,
  event: V21EventIdentity,
  horizon: V21ExecutionHorizon,
): Awaited<ReturnType<typeof resolveV21Execution>> {
  const start = Date.parse(V21_START_TIMESTAMP);
  const signalIndex = (event.signalOpenTime - start) / V21_INTERVAL_MS;
  assert(Number.isSafeInteger(signalIndex), `audit signal is not on the frozen 5m grid ${event.signalOpenTime}`);
  assert(signalIndex >= 0 && signalIndex < V21_EXPECTED_ROWS_PER_SYMBOL, `audit signal is outside the frozen dataset ${event.signalOpenTime}`);
  const definition = V21_EXECUTION_CONTRACT.horizons[horizon];
  const endExclusive = Date.parse(V21_END_EXCLUSIVE_TIMESTAMP);
  const entryBarOpenTime = event.signalOpenTime + definition.entryOffsetBars * V21_INTERVAL_MS;
  const exitBarOpenTime = event.signalOpenTime + definition.exitOffsetBars * V21_INTERVAL_MS;
  const exitCloseBoundaryTime = event.signalOpenTime + definition.exitCloseBoundaryOffsetBars * V21_INTERVAL_MS;
  const expectedUnavailableReason = exitCloseBoundaryTime > endExclusive ? "DATASET_END_BOUNDARY" : null;
  const actualUnavailableReason = row.outcomeStatus === "AVAILABLE" ? null : row.unavailableReason;
  assert(actualUnavailableReason === expectedUnavailableReason, `audit availability witness ${event.signalOpenTime}/${horizon}`);
  assert(row.outcomeStatus === (expectedUnavailableReason === null ? "AVAILABLE" : "OUTCOME_UNAVAILABLE"), `audit status witness ${event.signalOpenTime}/${horizon}`);
  if (expectedUnavailableReason === null) {
    assert(row.entryPrice !== null && row.exitPrice !== null, `audit available prices ${event.signalOpenTime}/${horizon}`);
  } else {
    assert(row.entryPrice === null && row.exitPrice === null, `audit unavailable prices ${event.signalOpenTime}/${horizon}`);
  }
  const mapping = mapV21ExecutionIndices(signalIndex, V21_EXPECTED_ROWS_PER_SYMBOL, horizon);
  assert(mapping.outcomeAvailable === (expectedUnavailableReason === null), `audit mapping witness ${event.signalOpenTime}/${horizon}`);
  return {
    mapping: { ...mapping, outcomeAvailable: expectedUnavailableReason === null, outcomeStatus: row.outcomeStatus },
    entryBarOpenTime,
    entryPrice: row.entryPrice,
    exitBarOpenTime,
    exitPrice: row.exitPrice,
    exitCloseBoundaryTime,
    unavailableReason: expectedUnavailableReason,
  };
}

function verifyPerformance(performance: any, stats: ReadonlyMap<string, SliceStats>, outcomes: ReadonlyMap<string, V21EvaluatedOutcome[]>): void {
  for (const strategy of V21_RESULT_STRATEGIES) {
    for (const horizon of V21_EXECUTION_HORIZONS) {
      for (const period of V21_RESULT_PERIODS) {
        const key = sliceKey(strategy, horizon, period);
        const expected = sliceReport(stats.get(key) as SliceStats, outcomes.get(key) ?? []);
        const actual = performance.slices?.[strategy]?.[horizon]?.[period];
        assert(sha256(actual) === sha256(expected), `performance slice ${key}`);
      }
    }
  }
  assert(performance.promotionHorizon === "PRIMARY_30M", "performance promotion horizon");
  assert(JSON.stringify(performance.diagnosticHorizons) === JSON.stringify(["DIAGNOSTIC_15M", "DIAGNOSTIC_60M"]), "performance diagnostics");
}

function verifyHoldouts(holdouts: any, stats: ReadonlyMap<string, SliceStats>, outcomes: ReadonlyMap<string, V21EvaluatedOutcome[]>): void {
  for (const strategy of V21_RESULT_STRATEGIES) {
    for (const horizon of V21_EXECUTION_HORIZONS) {
      for (const period of ["HOLDOUT_A", "HOLDOUT_B"] as const) {
        const key = sliceKey(strategy, horizon, period);
        const actual = holdouts.strategies?.[strategy]?.[horizon]?.[period];
        const expected = sliceReport(stats.get(key) as SliceStats, outcomes.get(key) ?? []);
        assert(sha256(actual) === sha256(expected), `holdout slice ${key}`);
      }
    }
  }
}

function verifyPrimary(primary: any, stats: SliceStats, outcomes: readonly V21EvaluatedOutcome[], integrityPass: boolean): void {
  const metrics = metricBundle(outcomes);
  assert(primary.identityCount === stats.identityCount && primary.availableCount === stats.availableCount, "primary identity/available counts");
  assert(primary.unavailableCount === stats.unavailableCount, "primary unavailable count");
  assert(sha256(primary.unavailableReasons) === sha256(stats.unavailableReasons), "primary unavailable reasons");
  assert(sha256(primary.metrics) === sha256(metrics), "primary metrics");
  for (const symbol of V21_SYMBOLS) {
    const expected = metricReport(outcomes.filter((outcome) => outcome.symbol === symbol));
    assert(sha256(primary.bySymbol?.[symbol]) === sha256(expected), `primary symbol ${symbol}`);
  }
  for (const year of ["2022", "2023", "2024"]) {
    const expected = metricReport(outcomes.filter((outcome) => outcome.year === year));
    assert(sha256(primary.byYear?.[year]) === sha256(expected), `primary year ${year}`);
  }
  assert(sha256(primary.concentration) === sha256(summarizeV21Concentration(outcomes)), "primary concentration");
  if (integrityPass) {
    const bootstrap = bootstrapV21PrimaryAvgNet(outcomes);
    assert(primary.bootstrap?.evaluated === true, "primary bootstrap evaluated");
    assert(primary.bootstrap.seed === bootstrap.seed && primary.bootstrap.replications === bootstrap.replications, "primary bootstrap identity");
    assert(primary.bootstrap.lcb95 === bootstrap.lcb95, "primary bootstrap LCB");
    assert(primary.bootstrap.valuesSha256 === sha256(bootstrap.values), "primary bootstrap values hash");
    assert(primary.bootstrap.clusterCount === new Set(outcomes.map((outcome) => outcome.clusterId)).size, "primary bootstrap cluster count");
  } else {
    assert(primary.bootstrap?.evaluated === false, "primary bootstrap must be skipped after integrity failure");
  }
}

function verifyControls(result: any, stats: ReadonlyMap<string, SliceStats>, outcomes: ReadonlyMap<string, V21EvaluatedOutcome[]>): void {
  for (const strategy of CONTROL_NAMES) {
    const key = sliceKey(strategy, "PRIMARY_30M", "PRIMARY_OOS");
    const expected = sliceReport(stats.get(key) as SliceStats, outcomes.get(key) ?? []);
    assert(sha256(result.controls?.[strategy]?.slice) === sha256(expected), `control ${strategy}`);
    assert(result.controls?.[strategy]?.includedInPromotionGate === false, `control gate exclusion ${strategy}`);
  }
}

function buildPromotionInput(
  frozen: Awaited<ReturnType<typeof assertV21FrozenInputs>>,
  reconstructed: { stats: Map<string, SliceStats>; outcomes: Map<string, V21EvaluatedOutcome[]> },
  primaryOutcomes: readonly V21EvaluatedOutcome[],
  integrityPass: boolean,
): V21PromotionInput | null {
  if (!integrityPass) return null;
  const primaryEvents = frozen.primaryIdentities.primaryOosEvents;
  const primaryStress10 = metricForScenario(primaryOutcomes, "stress10");
  const primaryA = reconstructed.outcomes.get(sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "HOLDOUT_A")) ?? [];
  const primaryB = reconstructed.outcomes.get(sliceKey(V21_PRIMARY_STRATEGY, "PRIMARY_30M", "HOLDOUT_B")) ?? [];
  const primaryEventsBySymbol = Object.fromEntries(V21_SYMBOLS.map((symbol) => [symbol, primaryEvents.filter((event) => event.symbol === symbol).length]));
  const primaryNetBySymbol = Object.fromEntries(V21_SYMBOLS.map((symbol) => [
    symbol,
    primaryOutcomes.filter((outcome) => outcome.symbol === symbol).reduce((sum, outcome) => sum + outcome.baselineNetReturn, 0),
  ]));
  const primaryNetByYear = Object.fromEntries(["2022", "2023", "2024"].map((year) => [
    year,
    primaryOutcomes.filter((outcome) => outcome.year === year).reduce((sum, outcome) => sum + outcome.baselineNetReturn, 0),
  ]));
  const raw = reconstructed.outcomes.get(sliceKey("RAW_RETURN_REVERSAL", "PRIMARY_30M", "PRIMARY_OOS")) ?? [];
  const median = reconstructed.outcomes.get(sliceKey("SIMPLE_MEDIAN_GAP_REVERSAL", "PRIMARY_30M", "PRIMARY_OOS")) ?? [];
  const bootstrap = bootstrapV21PrimaryAvgNet(primaryOutcomes);
  return {
    primary: summarizeV21Outcomes(primaryOutcomes),
    primaryStress10,
    holdoutA: summarizeV21Outcomes(primaryA),
    holdoutB: summarizeV21Outcomes(primaryB),
    primaryClusterCount: new Set(primaryEvents.map((event) => event.clusterId)).size,
    primaryEventsBySymbol,
    primaryNetBySymbol,
    primaryNetByYear,
    concentration: summarizeV21Concentration(primaryOutcomes),
    bootstrapLcb95: bootstrap.lcb95,
    rawReturnReversalPrimaryAvgNet: summarizeV21Outcomes(raw).averageNet,
    simpleMedianGapReversalPrimaryAvgNet: summarizeV21Outcomes(median).averageNet,
  };
}

function buildDataIntegrity(stats: ReadonlyMap<string, SliceStats>): { status: string; pass: boolean; failureReasons: string[]; slices: Record<string, unknown>; forbiddenRecovery: readonly string[]; identityPolicy: string } {
  const slices: Record<string, unknown> = {};
  const failureReasons: string[] = [];
  for (const [key, value] of stats.entries()) {
    const period = key.split("|")[2] as V21ResultPeriod;
    const allowed = period === "HOLDOUT_B" ? ["DATASET_END_BOUNDARY"] : [];
    const reasons = Object.keys(value.unavailableReasons);
    const pass = period === "HOLDOUT_B"
      ? reasons.every((reason) => allowed.includes(reason))
      : value.unavailableCount === 0;
    if (!pass) failureReasons.push(`${key}: unavailable outcome violates frozen contract`);
    slices[key] = {
      identityCount: value.identityCount,
      availableCount: value.availableCount,
      unavailableCount: value.unavailableCount,
      unavailableReasons: value.unavailableReasons,
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

function metricBundle(outcomes: readonly V21EvaluatedOutcome[]): Record<string, ScenarioMetrics> {
  return {
    baseline: metricForScenario(outcomes, "baseline"),
    stress5: metricForScenario(outcomes, "stress5"),
    stress10: metricForScenario(outcomes, "stress10"),
    stress20: metricForScenario(outcomes, "stress20"),
  };
}

type ScenarioName = "baseline" | "stress5" | "stress10" | "stress20";
type ScenarioMetrics = V21MetricSummary;

function metricForScenario(outcomes: readonly V21EvaluatedOutcome[], scenario: ScenarioName): V21MetricSummary {
  if (scenario === "baseline") return summarizeV21Outcomes(outcomes);
  return summarizeV21Returns(outcomes.map((outcome) => outcome[`${scenario}NetReturn` as "stress5NetReturn" | "stress10NetReturn" | "stress20NetReturn"]));
}

function metricReport(outcomes: readonly V21EvaluatedOutcome[]): Record<string, unknown> {
  return { identityCount: outcomes.length, availableCount: outcomes.length, unavailableCount: 0, metrics: metricBundle(outcomes) };
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

function emptyStats(): SliceStats {
  return { identityCount: 0, availableCount: 0, unavailableCount: 0, unavailableReasons: {} };
}

function pushOutcome(map: Map<string, V21EvaluatedOutcome[]>, key: string, outcome: V21EvaluatedOutcome): void {
  const values = map.get(key) ?? [];
  values.push(outcome);
  map.set(key, values);
}

function rowKey(strategy: string, event: { symbol: V21Symbol; signalOpenTime: number; direction: string }, horizon: string): string {
  return `${strategy}|${event.symbol}|${event.signalOpenTime}|${event.direction}|${horizon}`;
}

function sliceKey(strategy: string, horizon: string, period: string): string {
  return `${strategy}|${horizon}|${period}`;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function integrityFailurePromotion(): { gates: Record<string, boolean>; passed: false; classification: string; researchStop: true; productionEmail: "OFF"; automaticPromotion: false } {
  return {
    gates: { dataIntegrity: false },
    passed: false,
    classification: V21_OUTCOME_AVAILABILITY_CONTRACT.invalidDataClassification,
    researchStop: true,
    productionEmail: "OFF",
    automaticPromotion: false,
  };
}

async function assertResultHead(): Promise<void> {
  const head = gitBlobHash("HEAD");
  const parent = gitBlobHash(`${head}^`);
  const branch = process.env.GITHUB_HEAD_REF ?? gitBlobHash("--abbrev-ref", "HEAD");
  assert(branch === V21_BRANCH || gitBlobHash("--abbrev-ref", "HEAD") === "HEAD", `result branch ${branch}`);
  assert(head !== V21_WP4_FREEZE_COMMIT, "result artifacts must not be validated at freeze HEAD");
  const isPostResultCiOnlyHead = parent !== V21_WP4_FREEZE_COMMIT && isAllowedPostResultCiOnlyHead(head);
  assert(parent === V21_WP4_FREEZE_COMMIT || isPostResultCiOnlyHead, `result direct parent must be ${V21_WP4_FREEZE_COMMIT}`);
  assert(V21_BASE_SHA === "7b9e5d82f471ee3c9fec07e00101263c8d84e953", "base identity");
}

function isAllowedPostResultCiOnlyHead(head: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", V21_WP4_RESULT_COMMIT, head], { stdio: "ignore" });
    const changedFiles = execFileSync("git", ["diff", "--name-only", `${V21_WP4_RESULT_COMMIT}..${head}`], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter((path) => path.length > 0);
    const allowedFiles = new Set([
      "scripts/v21-result-support.ts",
      "scripts/validate-v21-result.ts",
    ]);
    return changedFiles.length > 0 && changedFiles.every((path) => allowedFiles.has(path));
  } catch {
    return false;
  }
}

async function assertResultArtifactsExist(): Promise<void> {
  for (const path of V21_RESULT_ARTIFACTS) {
    try {
      await readFile(resolve(path));
    } catch {
      throw new Error(`missing V21 result artifact: ${path}`);
    }
  }
}

async function assertRunnerPlumbing(): Promise<void> {
  const source = await readFile(resolve("scripts/run-v21-result.ts"), "utf8");
  for (const forbidden of ["alternateQ99", "alternateHorizon", "alternateSeed", "alternateCost", "symbolFilter", "yearFilter", "bestHorizon", "excludeLosingSymbol"]) {
    assert(!source.includes(forbidden), `runner contains forbidden alternate definition: ${forbidden}`);
  }
  assert(source.includes("resolveV21Execution"), "runner exact execution plumbing");
  assert(source.includes("evaluateV21PriceOutcome"), "runner frozen evaluator");
  assert(!source.includes("enumerateV21Controls"), "runner re-enumerates controls");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

void V21_COST_CONTRACT;
void V21_EXECUTION_CONTRACT;

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
