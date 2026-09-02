import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseKlineArchive, validateKlineIntegrity, type KlineIntegrity } from "@/lib/v15/archive";
import type { V15Bar } from "@/lib/v15/lead-lag";

const REPORT_DIR = resolve("reports");
const STAGE_B_PATH = resolve(REPORT_DIR, "v15-stage-b-archive-manifest.json");
const COST_PATH = resolve(REPORT_DIR, "v15-cost-input-manifest.json");
const STAGE_B_STATE_PATH = resolve(REPORT_DIR, "v15-stage-b-materialization.json");
const COST_STATE_PATH = resolve(REPORT_DIR, "v15-cost-materialization.json");
const GATE_PATH = resolve(REPORT_DIR, "v15-data-gate.json");
const FREEZE_PATH = resolve(REPORT_DIR, "v15-freeze-manifest.json");
const DATA_FREEZE_PATH = resolve(REPORT_DIR, "v15-data-freeze-v2.json");

type Exchange = "spot" | "futuresUm";
type JsonRecord = Record<string, any>;

interface Requirement {
  exchange: Exchange;
  symbol: string;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  expectedBytes: number | null;
}

interface Actual {
  exchange: Exchange;
  symbol: string;
  month: string;
  cachePath: string;
  sha256: string;
  bytes: number;
}

interface StageB {
  requiredArchiveSlots: number;
  requiredArchives: Requirement[];
  actualUsedArchives: Actual[];
  missingMetadataSlots: number;
  [key: string]: any;
}

interface StageRecord {
  exchange: Exchange;
  symbol: string;
  month: string;
  cachePath: string;
  expectedBytes: number | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  bytes: number | null;
  rowCount: number | null;
  integrity: KlineIntegrity | null;
  status: "PASS" | "FAIL" | string;
  error: string | null;
}

interface MaterializationState {
  complete: boolean;
  requiredArchiveSlots: number;
  records: StageRecord[];
  [key: string]: any;
}

interface CostRecord {
  symbol: string;
  month: string;
  fundingCachePath: string;
  fundingExpectedSha256: string | null;
  fundingActualSha256: string | null;
  fundingBytes: number | null;
  markPriceCachePath: string;
  markPriceExpectedSha256: string | null;
  markPriceActualSha256: string | null;
  markPriceBytes: number | null;
  normalizedPath: string;
  normalizedSha256: string | null;
  points: number;
  status: "PASS" | "FAIL" | string;
  error: string | null;
  [key: string]: any;
}

interface CostState {
  complete: boolean;
  requiredSymbolMonths: number;
  records: CostRecord[];
  [key: string]: any;
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return hash(JSON.stringify(value));
}

function archiveKey(row: { exchange: Exchange; symbol: string; month: string }): string {
  return `${row.exchange}/${row.symbol}/${row.month}`;
}

function pairKey(row: { symbol: string; month: string }): string {
  return `${row.symbol}/${row.month}`;
}

function currentHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileHash(path: string): Promise<string> {
  return hash(await readFile(path));
}

function validKline(integrity: KlineIntegrity | null): boolean {
  return Boolean(integrity) && integrity!.duplicateOpenTimes === 0 && integrity!.nonMonotonicOpenTimes === 0 && integrity!.invalidDurations === 0 && integrity!.cadenceCoverage >= 0.99;
}

function matchedCount(left: V15Bar[], right: V15Bar[]): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let matched = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex].openTime === right[rightIndex].openTime) {
      matched += 1;
      leftIndex += 1;
      rightIndex += 1;
    } else if (left[leftIndex].openTime < right[rightIndex].openTime) leftIndex += 1;
    else rightIndex += 1;
  }
  return matched;
}

function validFeatureWindows(times: number[]): { valid: number; possible: number } {
  if (times.length < 6) return { valid: 0, possible: 0 };
  let valid = 0;
  let possible = 0;
  for (let index = 5; index < times.length; index += 1) {
    possible += 1;
    let consecutive = true;
    for (let offset = index - 5; offset < index; offset += 1) {
      if (times[offset + 1] - times[offset] !== 5 * 60_000) consecutive = false;
    }
    if (consecutive) valid += 1;
  }
  return { valid, possible };
}

function countUnique<T>(rows: T[], getKey: (row: T) => string): { unique: Set<string>; duplicates: string[] } {
  const unique = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const value = getKey(row);
    if (unique.has(value)) duplicates.push(value);
    unique.add(value);
  }
  return { unique, duplicates };
}

async function readBars(actual: Actual): Promise<V15Bar[]> {
  const payload = await readFile(resolve(actual.cachePath));
  if (payload.byteLength !== actual.bytes) throw new Error(`cache byte count changed for ${archiveKey(actual)}`);
  return parseKlineArchive(payload);
}

async function main(): Promise<void> {
  const stageB = await readJson<StageB>(STAGE_B_PATH);
  const stageState = await readJson<MaterializationState>(STAGE_B_STATE_PATH);
  const costState = await readJson<CostState>(COST_STATE_PATH);
  const gate = await readJson<JsonRecord>(GATE_PATH);

  const requiredArchiveKeys = new Set(stageB.requiredArchives.map(archiveKey));
  const stageKeyAudit = countUnique(stageState.records, archiveKey);
  const missingStageKeys = [...requiredArchiveKeys].filter((value) => !stageKeyAudit.unique.has(value));
  const extraStageKeys = [...stageKeyAudit.unique].filter((value) => !requiredArchiveKeys.has(value));
  const stageInventoryComplete = stageState.records.length === stageB.requiredArchiveSlots && missingStageKeys.length === 0 && extraStageKeys.length === 0 && stageKeyAudit.duplicates.length === 0;
  const stageRecords = new Map(stageState.records.map((record) => [archiveKey(record), record]));
  const actualUsedArchives = stageB.requiredArchives.flatMap((requirement) => {
    const record = stageRecords.get(archiveKey(requirement));
    if (!record?.actualSha256 || !Number.isFinite(record.bytes)) return [];
    return [{ exchange: requirement.exchange, symbol: requirement.symbol, month: requirement.month, cachePath: record.cachePath, sha256: record.actualSha256, bytes: record.bytes! }];
  });
  const materializedArchiveSlots = actualUsedArchives.length;
  const archiveChecksumCoverage = stageB.requiredArchiveSlots ? materializedArchiveSlots / stageB.requiredArchiveSlots : 0;
  const archiveMetadataMissing = stageB.requiredArchives.filter((requirement) => {
    const record = stageRecords.get(archiveKey(requirement));
    return !record?.actualSha256 || !Number.isFinite(record.bytes);
  }).length;
  const integrityFailures = stageState.records.filter((record) => record.status !== "PASS" || !validKline(record.integrity)).map((record) => ({ key: archiveKey(record), error: record.error, integrity: record.integrity }));

  const updatedStageB: StageB = {
    ...stageB,
    requiredArchives: stageB.requiredArchives.map((requirement) => ({
      ...requirement,
      expectedBytes: stageRecords.get(archiveKey(requirement))?.bytes ?? requirement.expectedBytes,
    })),
    missingMetadataSlots: archiveMetadataMissing,
    expectedBytes: actualUsedArchives.reduce((sum, record) => sum + record.bytes, 0),
    actualUsedArchives,
  };
  await writeJson(STAGE_B_PATH, updatedStageB);

  const pairs = [...new Set(stageB.requiredArchives.map((row) => pairKey(row)))].map((value) => {
    const [symbol, month] = value.split("/");
    return { symbol, month };
  }).sort((left, right) => pairKey(left).localeCompare(pairKey(right)));

  const actual = new Map(actualUsedArchives.map((row) => [archiveKey(row), row]));
  let matched = 0;
  let comparable = 0;
  let featureValid = 0;
  let featurePossible = 0;
  let advPass = 0;
  let comparablePairs = 0;
  const pairReadFailures: Array<{ pair: string; error: string }> = [];
  const pairIntegrityFailures = new Set(integrityFailures.map((failure) => failure.key));

  for (const pair of pairs) {
    const pairName = pairKey(pair);
    const spot = actual.get(`spot/${pairName}`);
    const futures = actual.get(`futuresUm/${pairName}`);
    if (!spot || !futures) {
      pairReadFailures.push({ pair: pairName, error: "one or both required archives were not materialized" });
      continue;
    }
    try {
      const [spotBars, futuresBars] = await Promise.all([readBars(spot), readBars(futures)]);
      const spotIntegrity = validateKlineIntegrity(spotBars);
      const futuresIntegrity = validateKlineIntegrity(futuresBars);
      if (!validKline(spotIntegrity)) pairIntegrityFailures.add(archiveKey(spot));
      if (!validKline(futuresIntegrity)) pairIntegrityFailures.add(archiveKey(futures));
      comparablePairs += 1;
      const count = matchedCount(spotBars, futuresBars);
      matched += count;
      comparable += Math.max(spotBars.length, futuresBars.length);
      const futuresTimes = new Set(futuresBars.map((bar) => bar.openTime));
      const times = spotBars.map((bar) => bar.openTime).filter((time) => futuresTimes.has(time));
      const windows = validFeatureWindows(times);
      featureValid += windows.valid;
      featurePossible += windows.possible;
      const spotVolume = spotBars.reduce((sum, bar) => sum + (bar.quoteVolume > 0 ? bar.quoteVolume : 0), 0);
      const futuresVolume = futuresBars.reduce((sum, bar) => sum + (bar.quoteVolume > 0 ? bar.quoteVolume : 0), 0);
      if (spotVolume > 0 && futuresVolume > 0) advPass += 1;
    } catch (error) {
      pairReadFailures.push({ pair: pairName, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const matchedCoverage = comparable ? matched / comparable : 0;
  const featureCoverage = featurePossible ? featureValid / featurePossible : 0;
  const advCoverage = pairs.length ? advPass / pairs.length : 0;
  const pairCoverage = pairs.length ? comparablePairs / pairs.length : 0;

  const requiredCostKeys = new Set(pairs.map(pairKey));
  const costKeyAudit = countUnique(costState.records, pairKey);
  const missingCostKeys = [...requiredCostKeys].filter((value) => !costKeyAudit.unique.has(value));
  const extraCostKeys = [...costKeyAudit.unique].filter((value) => !requiredCostKeys.has(value));
  const costInventoryComplete = costState.records.length === pairs.length && missingCostKeys.length === 0 && extraCostKeys.length === 0 && costKeyAudit.duplicates.length === 0;
  const costRecords = new Map(costState.records.map((record) => [pairKey(record), record]));
  const fundingArchiveRecords = pairs.map(pairKey).map((value) => costRecords.get(value)).filter((record): record is CostRecord => Boolean(record?.fundingActualSha256 && Number.isFinite(record.fundingBytes)));
  const markArchiveRecords = pairs.map(pairKey).map((value) => costRecords.get(value)).filter((record): record is CostRecord => Boolean(record?.markPriceActualSha256 && Number.isFinite(record.markPriceBytes)));
  const usableCostRecords = pairs.map(pairKey).map((value) => costRecords.get(value)).filter((record): record is CostRecord => Boolean(record?.status === "PASS" && record.normalizedSha256 && record.points > 0));
  const fundingArchiveCoverage = pairs.length ? fundingArchiveRecords.length / pairs.length : 0;
  const markArchiveCoverage = pairs.length ? markArchiveRecords.length / pairs.length : 0;
  const settlementCoverage = pairs.length ? usableCostRecords.length / pairs.length : 0;
  const normalizedFiles = usableCostRecords.map((record) => record.normalizedPath);
  const fundingFiles = fundingArchiveRecords.map((record) => record.fundingCachePath);
  const markFiles = markArchiveRecords.map((record) => record.markPriceCachePath);
  await writeJson(COST_PATH, {
    schema: "v15-cost-input-manifest-v1",
    funding: {
      sourceTemplate: "https://data.binance.vision/data/futures/um/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{month}.zip",
      requiredSymbolMonths: pairs.length,
      materializedSymbolMonths: usableCostRecords.length,
      coverage: settlementCoverage,
      archiveMaterializedSymbolMonths: fundingArchiveRecords.length,
      archiveCoverage: fundingArchiveCoverage,
      actualFiles: normalizedFiles,
      rawArchiveFiles: fundingFiles,
    },
    markPrice: {
      sourceTemplate: "https://data.binance.vision/data/futures/um/monthly/markPriceKlines/{symbol}/5m/{symbol}-5m-{month}.zip",
      requiredArchiveSlots: pairs.length,
      materializedArchiveSlots: markArchiveRecords.length,
      coverage: settlementCoverage,
      archiveCoverage: markArchiveCoverage,
      actualFiles: markFiles,
    },
    settlement: {
      requiredSymbolMonths: pairs.length,
      materializedSymbolMonths: usableCostRecords.length,
      coverage: settlementCoverage,
      noFallback: true,
    },
    noFallback: true,
  });

  const reasons = [
    ...(!stageInventoryComplete ? ["STAGE_B_MATERIALIZATION_INVENTORY_INCOMPLETE"] : []),
    ...(materializedArchiveSlots < stageB.requiredArchiveSlots ? ["IMMUTABLE_FULL_5M_ARCHIVE_SET_NOT_MATERIALIZED"] : []),
    ...(archiveChecksumCoverage < 1 ? ["ARCHIVE_CHECKSUM_COVERAGE_BELOW_100_PERCENT"] : []),
    ...(archiveMetadataMissing > 0 ? ["ARCHIVE_METADATA_INCOMPLETE"] : []),
    ...(pairIntegrityFailures.size ? ["ARCHIVE_INTEGRITY_BELOW_REQUIRED_COVERAGE"] : []),
    ...(pairReadFailures.length ? ["ARCHIVE_READ_FAILURE"] : []),
    ...(matchedCoverage < 0.99 ? ["MATCHED_BAR_COVERAGE_BELOW_99_PERCENT"] : []),
    ...(featureCoverage < 0.98 ? ["TRAILING_FEATURE_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(advCoverage < 0.98 ? ["ADV_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(!costInventoryComplete ? ["COST_INPUT_MATERIALIZATION_INVENTORY_INCOMPLETE"] : []),
    ...(fundingArchiveCoverage < 1 ? ["ACTUAL_FUNDING_ARCHIVE_NOT_MATERIALIZED"] : []),
    ...(markArchiveCoverage < 1 ? ["MARK_PRICE_ARCHIVE_NOT_MATERIALIZED"] : []),
    ...(settlementCoverage < 1 ? ["MARK_PRICE_SETTLEMENT_ARCHIVE_NOT_MATERIALIZED"] : []),
  ];

  gate.generatedAt = new Date().toISOString();
  gate.stageB = {
    ...gate.stageB,
    requiredArchiveSlots: stageB.requiredArchiveSlots,
    materializedArchiveSlots,
    checksumCoverage: archiveChecksumCoverage,
    validArchiveSlots: stageB.requiredArchives.filter((requirement) => stageRecords.get(archiveKey(requirement))?.status === "PASS").length,
    integrityCoverage: stageB.requiredArchiveSlots ? (stageB.requiredArchiveSlots - pairIntegrityFailures.size) / stageB.requiredArchiveSlots : 0,
    missingMetadataSlots: archiveMetadataMissing,
    inventoryComplete: stageInventoryComplete,
  };
  gate.immutableArchives = {
    ...gate.immutableArchives,
    requiredArchiveSlots: stageB.requiredArchiveSlots,
    materializedArchiveSlots,
    fullArchiveCoverage: stageB.requiredArchiveSlots ? materializedArchiveSlots / stageB.requiredArchiveSlots : 0,
    checksumCoverage: archiveChecksumCoverage,
    validIntegrityArchiveSlots: stageB.requiredArchiveSlots - pairIntegrityFailures.size,
    validIntegrityCoverage: stageB.requiredArchiveSlots ? (stageB.requiredArchiveSlots - pairIntegrityFailures.size) / stageB.requiredArchiveSlots : 0,
    cachePolicy: "Verified ZIP and official .CHECKSUM are written once; existing paths are digest-checked before reuse.",
  };
  gate.completeness = {
    matchedBarCoverage: matchedCoverage,
    trailingFeatureCoverage: featureCoverage,
    liquidityAdvCoverage: advCoverage,
    audit: {
      pairMonths: pairs.length,
      comparablePairMonths: comparablePairs,
      pairCoverage,
      comparableBars: comparable,
      matchedBars: matched,
      validFeatureWindows: featureValid,
      possibleFeatureWindows: featurePossible,
      advPassingPairMonths: advPass,
      archiveIntegrityFailures: pairIntegrityFailures.size,
      archiveReadFailures: pairReadFailures.length,
      archiveIntegrityFailureKeys: [...pairIntegrityFailures].sort(),
      archiveReadFailureDetails: pairReadFailures,
    },
    note: "Coverage is measured from the complete immutable Stage B pair-month inventory; feature windows use only matched consecutive closed 5m bars and ADV requires positive quote volume on both legs. Invalid or unreadable archives remain in denominators and fail the gate.",
  };
  gate.costInputs = {
    ...gate.costInputs,
    fundingCoverage: settlementCoverage,
    markPriceCoverage: settlementCoverage,
    fundingArchiveCoverage,
    markPriceArchiveCoverage: markArchiveCoverage,
    fundingSettlementCoverage: settlementCoverage,
    requiredSymbolMonths: pairs.length,
    usableSymbolMonths: usableCostRecords.length,
    failedSymbolMonths: pairs.length - usableCostRecords.length,
    inventoryComplete: costInventoryComplete,
    noFallback: true,
  };
  gate.requirements = {
    ...gate.requirements,
    archiveChecksumCoverage: 1,
    matchedBarCoverage: 0.99,
    trailingFeatureCoverage: 0.98,
    fundingCoverage: 1,
    markPriceCoverage: 1,
  };
  gate.reasons = reasons;
  gate.status = reasons.length ? "FAIL" : "PASS";
  gate.classification = reasons.length ? "V15_DATA_INSUFFICIENT_FINAL" : "PASS";
  gate.historicalReturnsRead = false;
  await writeJson(GATE_PATH, gate);

  const freeze = await readJson<JsonRecord>(FREEZE_PATH);
  delete freeze.manifestSha256;
  freeze.dataGateHash = stableHash(gate);
  await writeJson(FREEZE_PATH, { ...freeze, manifestSha256: stableHash(freeze) });

  const dataFreeze = await readJson<JsonRecord>(DATA_FREEZE_PATH);
  delete dataFreeze.manifestSha256;
  dataFreeze.sourceHead = currentHead();
  dataFreeze.archiveRegistry = { ...dataFreeze.archiveRegistry, sha256: await fileHash(resolve(REPORT_DIR, "v15-archive-registry.json")) };
  dataFreeze.stageBArchiveManifest = { ...dataFreeze.stageBArchiveManifest, sha256: await fileHash(STAGE_B_PATH) };
  dataFreeze.costInputManifest = { ...dataFreeze.costInputManifest, sha256: await fileHash(COST_PATH) };
  dataFreeze.dataGate = { path: "reports/v15-data-gate.json", sha256: await fileHash(GATE_PATH), status: gate.status };
  dataFreeze.materialization = {
    stageBState: { path: "reports/v15-stage-b-materialization.json", sha256: await fileHash(STAGE_B_STATE_PATH) },
    costState: { path: "reports/v15-cost-materialization.json", sha256: await fileHash(COST_STATE_PATH) },
    coverage: gate.completeness,
  };
  dataFreeze.codeHashes = {
    timestampParser: await fileHash(resolve("lib/v15/lead-lag.ts")),
    featureEngine: await fileHash(resolve("lib/v15/lead-lag.ts")),
    executionEngine: await fileHash(resolve("lib/v15/engine.ts")),
    costEngine: await fileHash(resolve("lib/v15/cost.ts")),
    archiveParser: await fileHash(resolve("lib/v15/archive.ts")),
  };
  dataFreeze.historicalReturnsRead = false;
  await writeJson(DATA_FREEZE_PATH, { ...dataFreeze, manifestSha256: stableHash(dataFreeze) });
  console.info(JSON.stringify({
    phase: "finalize-gate",
    status: gate.status,
    classification: gate.classification,
    reasons,
    requiredArchiveSlots: stageB.requiredArchiveSlots,
    materializedArchiveSlots,
    archiveChecksumCoverage,
    integrityFailures: pairIntegrityFailures.size,
    pairs: pairs.length,
    matchedCoverage,
    featureCoverage,
    advCoverage,
    fundingArchiveCoverage,
    markArchiveCoverage,
    settlementCoverage,
    historicalReturnsRead: false,
  }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
