import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_ARCHIVE_ROOT,
  downloadAndParseV21Archive,
  type V21Bar,
} from "../lib/v21/archive";
import {
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_INTERVAL_MS,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  V21_REPORT_FILES,
  v21MonthKeys,
  type V21Symbol,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";
import {
  V21_BOOTSTRAP_CONTRACT,
  V21_CLASSIFICATION_CONTRACT,
  V21_COST_CONTRACT,
  V21_EXECUTION_CONTRACT,
  V21_METRIC_CONTRACT,
  V21_OUTCOME_AVAILABILITY_CONTRACT,
  V21_PROMOTION_GATE_DEFINITIONS,
  mapV21ExecutionIndices,
  type V21ExecutionHorizon,
  type V21ExecutionMapping,
} from "../lib/v21/result-evaluator";
import type { V21EventIdentity } from "../lib/v21/events";

export const V21_WP4_FREEZE_COMMIT = "22f4229302d62104d3285e4b6b1b943bf9affbf2" as const;
export const V21_RESULT_ARTIFACTS = [
  "reports/v21-outcome-audit.json",
  "reports/v21-primary-oos.json",
  "reports/v21-holdout-results.json",
  "reports/v21-performance.json",
  "reports/v21-result.json",
  "reports/v21-promotion-decision.json",
  "reports/v21-result-stage-manifest.json",
] as const;

const FROZEN_REPORT_PATHS = V21_REPORT_FILES;

export interface V21FrozenInputs {
  manifest: any;
  resultContract: any;
  primaryIdentities: {
    allEvents: V21EventIdentity[];
    primaryOosEvents: V21EventIdentity[];
    holdoutAEvents: V21EventIdentity[];
    holdoutBEvents: V21EventIdentity[];
  };
  controls: any;
}

export const V21_RESULT_PERIODS = ["PRIMARY_OOS", "HOLDOUT_A", "HOLDOUT_B"] as const;
export type V21ResultPeriod = (typeof V21_RESULT_PERIODS)[number];

export const V21_RESULT_STRATEGIES = [
  "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL",
  "RAW_RETURN_REVERSAL",
  "SIMPLE_MEDIAN_GAP_REVERSAL",
  "TIME_MATCHED_RANDOM",
] as const;
export type V21ResultStrategy = (typeof V21_RESULT_STRATEGIES)[number];

export const V21_PRIMARY_STRATEGY = V21_RESULT_STRATEGIES[0];

export interface V21PriceSeries {
  symbol: V21Symbol;
  start: number;
  endExclusive: number;
  interval: number;
  opens: Float64Array;
  closes: Float64Array;
  present: Uint8Array;
}

export interface V21ArchiveSeriesLoad {
  bySymbol: Record<V21Symbol, V21PriceSeries>;
  archiveSlots: number;
  checksumVerifiedArchiveSlots: number;
}

export interface V21ExecutionResolution {
  mapping: V21ExecutionMapping;
  entryBarOpenTime: number;
  entryPrice: number | null;
  exitBarOpenTime: number;
  exitPrice: number | null;
  exitCloseBoundaryTime: number;
  unavailableReason: "DATASET_END_BOUNDARY" | "INTERNAL_GAP" | "MISSING_BAR" | null;
}

export function periodForV21Signal(signalOpenTime: number): V21ResultPeriod {
  const year = new Date(signalOpenTime).getUTCFullYear();
  if (year >= 2022 && year <= 2024) return "PRIMARY_OOS";
  if (year === 2025) return "HOLDOUT_A";
  if (year === 2026) return "HOLDOUT_B";
  throw new Error(`V21 signal is outside the frozen result periods: ${signalOpenTime}`);
}

export function resolveV21Execution(
  series: V21PriceSeries,
  event: V21EventIdentity,
  horizon: V21ExecutionHorizon,
): V21ExecutionResolution {
  const signalIndex = exactIndex(series, event.signalOpenTime);
  const mapping = mapV21ExecutionIndices(signalIndex, series.opens.length, horizon);
  const definition = V21_EXECUTION_CONTRACT.horizons[horizon];
  const entryBarOpenTime = event.signalOpenTime + definition.entryOffsetBars * V21_INTERVAL_MS;
  const exitBarOpenTime = event.signalOpenTime + definition.exitOffsetBars * V21_INTERVAL_MS;
  const exitCloseBoundaryTime = event.signalOpenTime + definition.exitCloseBoundaryOffsetBars * V21_INTERVAL_MS;
  const required = [mapping.signalIndex, mapping.entryIndex, mapping.exitIndex];

  if (required.some((index) => index < 0 || index >= series.present.length)) {
    return {
      mapping: { ...mapping, outcomeAvailable: false, outcomeStatus: "OUTCOME_UNAVAILABLE" },
      entryBarOpenTime,
      entryPrice: null,
      exitBarOpenTime,
      exitPrice: null,
      exitCloseBoundaryTime,
      unavailableReason: "DATASET_END_BOUNDARY",
    };
  }
  if (required.some((index) => series.present[index] !== 1)) {
    return {
      mapping: { ...mapping, outcomeAvailable: false, outcomeStatus: "OUTCOME_UNAVAILABLE" },
      entryBarOpenTime,
      entryPrice: null,
      exitBarOpenTime,
      exitPrice: null,
      exitCloseBoundaryTime,
      unavailableReason: "INTERNAL_GAP",
    };
  }

  return {
    mapping: { ...mapping, outcomeAvailable: true, outcomeStatus: "AVAILABLE" },
    entryBarOpenTime,
    entryPrice: series.opens[mapping.entryIndex],
    exitBarOpenTime,
    exitPrice: series.closes[mapping.exitIndex],
    exitCloseBoundaryTime,
    unavailableReason: null,
  };
}

export function exactIndex(series: V21PriceSeries, openTime: number): number {
  const offset = (openTime - series.start) / series.interval;
  if (!Number.isSafeInteger(offset)) throw new Error(`V21 timestamp is not aligned to the verified 5m grid: ${openTime}`);
  return offset;
}

export async function isV21ArchiveCacheMaterialized(): Promise<boolean> {
  try {
    const entries = await readdir(V21_ARCHIVE_ROOT);
    return entries.some((entry) => entry.endsWith(".zip"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadVerifiedV21PriceSeries(): Promise<V21ArchiveSeriesLoad> {
  const start = Date.parse(V21_START_TIMESTAMP);
  const endExclusive = Date.parse(V21_END_EXCLUSIVE_TIMESTAMP);
  const bySymbol = {} as Record<V21Symbol, V21PriceSeries>;
  let archiveSlots = 0;
  let checksumVerifiedArchiveSlots = 0;

  for (const symbol of V21_SYMBOLS) {
    const opens = new Float64Array(V21_EXPECTED_ROWS_PER_SYMBOL);
    const closes = new Float64Array(V21_EXPECTED_ROWS_PER_SYMBOL);
    const present = new Uint8Array(V21_EXPECTED_ROWS_PER_SYMBOL);
    for (const month of v21MonthKeys()) {
      const result = await downloadAndParseV21Archive(symbol, month, {
        rootDir: V21_ARCHIVE_ROOT,
        fetchImpl: noNetworkFetch,
      });
      if (result.slot.status !== "VERIFIED"
        || !result.slot.checksumVerified
        || result.bars.length !== result.slot.expectedMonthRows) {
        throw new Error(`Immutable V21 archive cache is not verified for ${symbol}/${month}`);
      }
      archiveSlots += 1;
      checksumVerifiedArchiveSlots += 1;
      for (const bar of result.bars) assignBar(bar, start, opens, closes, present);
    }
    if (present.some((value) => value !== 1)) throw new Error(`Incomplete immutable OHLC cache for ${symbol}`);
    bySymbol[symbol] = { symbol, start, endExclusive, interval: V21_INTERVAL_MS, opens, closes, present };
    console.info(`Loaded verified V21 execution OHLC: ${symbol} (${present.length} bars)`);
  }
  return { bySymbol, archiveSlots, checksumVerifiedArchiveSlots };
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

export async function assertV21FrozenInputs(): Promise<V21FrozenInputs> {
  const manifest = await readJsonFile<any>("reports/v21-freeze-manifest.json");
  const resultContract = await readJsonFile<any>("reports/v21-result-contract.json");
  const eventIdentities = await readJsonFile<any>("reports/v21-event-identities.json");
  const eventEnumeration = await readJsonFile<any>("reports/v21-event-enumeration.json");
  const eventAudit = await readJsonFile<any>("reports/v21-event-audit.json");
  const controlIdentities = await readJsonFile<any>("reports/v21-control-identities.json");
  const controlAudit = await readJsonFile<any>("reports/v21-control-audit.json");

  assert(manifest.schemaVersion === "v21-freeze-manifest-v2", "freeze manifest schema drift");
  assert(manifest.experimentId === "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL", "freeze experiment drift");
  assert(manifest.branch === "feat/v21-idiosyncratic-jump-reversal", "freeze branch drift");
  assert(manifest.baseResearchSha === "7b9e5d82f471ee3c9fec07e00101263c8d84e953", "freeze base drift");
  assert(manifest.fixedSymbols.join("|") === V21_SYMBOLS.join("|"), "freeze symbol drift");
  assert(sha256(manifest.execution) === sha256(V21_EXECUTION_CONTRACT), "execution contract drift");
  assert(sha256(manifest.outcomeAvailabilityContract) === sha256(V21_OUTCOME_AVAILABILITY_CONTRACT), "availability contract drift");
  assert(sha256(manifest.costs) === sha256(V21_COST_CONTRACT), "cost contract drift");
  assert(sha256(manifest.metrics) === sha256(V21_METRIC_CONTRACT), "metric contract drift");
  assert(sha256(manifest.bootstrap) === sha256(V21_BOOTSTRAP_CONTRACT), "bootstrap contract drift");
  assert(sha256(manifest.promotionGates) === sha256(V21_PROMOTION_GATE_DEFINITIONS), "promotion gate drift");
  assert(sha256(manifest.classification) === sha256(V21_CLASSIFICATION_CONTRACT), "classification contract drift");

  for (const path of FROZEN_REPORT_PATHS) {
    const revisionBlob = gitBlobHash(`${V21_WP4_FREEZE_COMMIT}:${path}`);
    const currentBlob = currentGitBlobHash(path);
    assert(revisionBlob === currentBlob, `frozen Git blob drift: ${path}`);
  }
  for (const [path, expected] of Object.entries(manifest.sourceHashes as Record<string, string>)) {
    const text = await readFile(resolve(path), "utf8");
    assert(canonicalTextSha256(text) === expected, `frozen source hash drift: ${path}`);
    assert(gitBlobHash(`${V21_WP4_FREEZE_COMMIT}:${path}`) === currentGitBlobHash(path), `frozen source blob drift: ${path}`);
  }

  const expectedBundle = {
    primaryEventDigests: manifest.primaryEventDigests,
    primaryEventAuditSha256: manifest.primaryEventAuditSha256,
    priorEvidenceLockSha256: manifest.priorStageEvidenceLockSha256,
    controlIdentityDigests: manifest.controls.identityDigests,
    controlAuditSha256: manifest.controls.auditSha256,
    resultContractSha256: manifest.resultContractSha256,
    entryPriceField: manifest.entryPriceField,
    exitPriceField: manifest.exitPriceField,
    execution: V21_EXECUTION_CONTRACT,
    outcomeAvailabilityContract: V21_OUTCOME_AVAILABILITY_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: manifest.resultEvaluatorSourceSha256,
    resultEvaluatorTestsSha256: manifest.resultEvaluatorTestsSha256,
    freezeValidatorSha256: manifest.freezeValidatorSha256,
    contractClosureSourceSha256: manifest.contractClosureSourceSha256,
    bootstrapSeedCallerOverrideAllowed: manifest.bootstrapSeedCallerOverrideAllowed,
    clusterIdentityMutable: manifest.clusterIdentityMutable,
    yearDerivedFromSignalTimestamp: manifest.yearDerivedFromSignalTimestamp,
  };
  assert(sha256(manifest.freezeBundle) === sha256(expectedBundle), "freeze bundle contents drift");
  assert(manifest.freezeBundleSha256 === sha256(expectedBundle), "freeze bundle hash drift");
  const manifestBody = { ...manifest };
  delete manifestBody.manifestBodySha256;
  assert(manifest.manifestBodySha256 === sha256(manifestBody), "freeze manifest body hash drift");
  assert(resultContract.contractOnly === true && resultContract.realOutcomeEvaluationPerformed === false, "result contract boundary drift");
  assert(sha256(resultContract.execution) === sha256(V21_EXECUTION_CONTRACT), "result contract execution drift");
  assert(sha256(resultContract.outcomeAvailabilityContract) === sha256(V21_OUTCOME_AVAILABILITY_CONTRACT), "result contract availability drift");
  assert(sha256(resultContract.costs) === sha256(V21_COST_CONTRACT), "result contract costs drift");
  assert(sha256(resultContract.metrics) === sha256(V21_METRIC_CONTRACT), "result contract metrics drift");
  assert(sha256(resultContract.bootstrap) === sha256(V21_BOOTSTRAP_CONTRACT), "result contract bootstrap drift");
  assert(sha256(resultContract.promotionGates) === sha256(V21_PROMOTION_GATE_DEFINITIONS), "result contract gates drift");
  assert(sha256(resultContract.classification) === sha256(V21_CLASSIFICATION_CONTRACT), "result contract classification drift");
  assert(eventAudit.noOutcomeFields === true && controlAudit.noOutcomeFields === true, "pre-result audit contains outcomes");
  assert(eventEnumeration.historicalStrategyOutcomeReturnsRead === false, "event enumeration outcome boundary drift");
  assert(eventEnumeration.forwardReturnsRead === false && eventEnumeration.executionEvaluated === false, "event enumeration execution boundary drift");

  const primaryEventDigests = {
    allEvents: sha256(eventIdentities.allEvents),
    primaryOosEvents: sha256(eventIdentities.primaryOosEvents),
    holdoutAEvents: sha256(eventIdentities.holdoutAEvents),
    holdoutBEvents: sha256(eventIdentities.holdoutBEvents),
  };
  assert(JSON.stringify(primaryEventDigests) === JSON.stringify(manifest.primaryEventDigests), "primary identity digest drift");
  for (const name of ["RAW_RETURN_REVERSAL", "SIMPLE_MEDIAN_GAP_REVERSAL", "TIME_MATCHED_RANDOM"] as const) {
    const control = controlIdentities.controls[name];
    for (const key of ["allEvents", "primaryOosEvents", "holdoutAEvents", "holdoutBEvents"] as const) {
      assert(sha256(control[key]) === manifest.controls.identityDigests[name][key], `control identity digest drift: ${name}/${key}`);
    }
  }
  assert(eventIdentities.allEvents.length === manifest.primaryCounts.allEvents, "primary all identity count drift");
  assert(eventIdentities.primaryOosEvents.length === manifest.primaryCounts.primaryOosEvents, "primary OOS identity count drift");
  assert(eventIdentities.holdoutAEvents.length === manifest.primaryCounts.holdoutAEvents, "primary holdout A identity count drift");
  assert(eventIdentities.holdoutBEvents.length === manifest.primaryCounts.holdoutBEvents, "primary holdout B identity count drift");
  assert(new Set(eventIdentities.primaryOosEvents.map((event: V21EventIdentity) => event.clusterId)).size === manifest.primaryCounts.primaryClusters, "primary cluster count drift");

  return {
    manifest,
    resultContract,
    primaryIdentities: {
      allEvents: eventIdentities.allEvents,
      primaryOosEvents: eventIdentities.primaryOosEvents,
      holdoutAEvents: eventIdentities.holdoutAEvents,
      holdoutBEvents: eventIdentities.holdoutBEvents,
    },
    controls: controlIdentities,
  };
}

export function gitBlobHash(...revision: string[]): string {
  return execFileSync("git", ["rev-parse", ...revision], { encoding: "utf8" }).trim();
}

export function currentGitBlobHash(path: string): string {
  return execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`V21 WP4 validation failed: ${message}`);
}

const noNetworkFetch: typeof fetch = async () => {
  throw new Error("V21 WP4 forbids archive/API backfill; required immutable cache is missing");
};

function assignBar(
  bar: V21Bar,
  start: number,
  opens: Float64Array,
  closes: Float64Array,
  present: Uint8Array,
): void {
  const index = (bar.openTime - start) / V21_INTERVAL_MS;
  if (!Number.isSafeInteger(index) || index < 0 || index >= present.length || present[index] === 1) {
    throw new Error(`Invalid immutable OHLC identity at ${bar.symbol}/${bar.openTime}`);
  }
  opens[index] = bar.open;
  closes[index] = bar.close;
  present[index] = 1;
}
