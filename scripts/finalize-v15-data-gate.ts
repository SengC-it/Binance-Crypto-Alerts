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

interface Requirement { exchange: Exchange; symbol: string; month: string; cachePath: string; }
interface Actual { exchange: Exchange; symbol: string; month: string; cachePath: string; sha256: string; bytes: number; }
interface StageB { requiredArchiveSlots: number; requiredArchives: Requirement[]; actualUsedArchives: Actual[]; missingMetadataSlots: number; }
interface MaterializationState { complete: boolean; requiredArchiveSlots: number; records: Array<{ exchange: Exchange; symbol: string; month: string; status: string; actualSha256: string | null; bytes: number | null; integrity: KlineIntegrity | null }>; }

function hash(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function stableHash(value: unknown): string { return hash(JSON.stringify(value)); }
function key(row: { exchange: Exchange; symbol: string; month: string }): string { return `${row.exchange}/${row.symbol}/${row.month}`; }
function currentHead(): string { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function fileHash(path: string): Promise<string> { return hash(await readFile(path)); }

function validKline(integrity: KlineIntegrity): boolean {
  return integrity.duplicateOpenTimes === 0 && integrity.nonMonotonicOpenTimes === 0 && integrity.invalidDurations === 0 && integrity.cadenceCoverage >= 0.99;
}

function matchedCount(left: V15Bar[], right: V15Bar[]): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let matched = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex].openTime === right[rightIndex].openTime) { matched += 1; leftIndex += 1; rightIndex += 1; }
    else if (left[leftIndex].openTime < right[rightIndex].openTime) leftIndex += 1;
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
    for (let offset = index - 5; offset < index; offset += 1) if (times[offset + 1] - times[offset] !== 5 * 60_000) consecutive = false;
    if (consecutive) valid += 1;
  }
  return { valid, possible };
}

async function main(): Promise<void> {
  const stageB = await readJson<StageB>(STAGE_B_PATH);
  const costs = await readJson<JsonRecord>(COST_PATH);
  const stageState = await readJson<MaterializationState>(STAGE_B_STATE_PATH);
  const costState = await readJson<JsonRecord>(COST_STATE_PATH);
  if (!stageState.complete || stageState.records.length !== stageB.requiredArchiveSlots || stageState.records.some((record) => record.status !== "PASS")) throw new Error("Stage B materialization state is not complete and PASS");
  if (stageB.actualUsedArchives.length !== stageB.requiredArchiveSlots) throw new Error("Stage B manifest does not contain every materialized archive");
  if (costState.complete !== true || costs.funding.coverage < 1 || costs.markPrice.coverage < 1) throw new Error("cost input materialization is not complete and PASS");

  const actual = new Map(stageB.actualUsedArchives.map((row) => [key(row), row]));
  const pairs = [...new Set(stageB.requiredArchives.map((row) => `${row.symbol}/${row.month}`))].map((value) => {
    const [symbol, month] = value.split("/");
    return { symbol, month };
  }).sort((left, right) => `${left.symbol}/${left.month}`.localeCompare(`${right.symbol}/${right.month}`));
  let matched = 0;
  let comparable = 0;
  let featureValid = 0;
  let featurePossible = 0;
  let advPass = 0;
  const integrityFailures: string[] = [];
  for (const pair of pairs) {
    const spot = actual.get(`spot/${pair.symbol}/${pair.month}`);
    const futures = actual.get(`futuresUm/${pair.symbol}/${pair.month}`);
    if (!spot || !futures) throw new Error(`missing materialized pair ${pair.symbol}/${pair.month}`);
    const spotBars = parseKlineArchive(await readFile(resolve(spot.cachePath)));
    const futuresBars = parseKlineArchive(await readFile(resolve(futures.cachePath)));
    const spotIntegrity = validateKlineIntegrity(spotBars);
    const futuresIntegrity = validateKlineIntegrity(futuresBars);
    if (!validKline(spotIntegrity) || !validKline(futuresIntegrity)) integrityFailures.push(`${pair.symbol}/${pair.month}`);
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
  }
  const matchedCoverage = comparable ? matched / comparable : 0;
  const featureCoverage = featurePossible ? featureValid / featurePossible : 0;
  const advCoverage = pairs.length ? advPass / pairs.length : 0;
  const reasons = [
    ...(integrityFailures.length ? ["ARCHIVE_INTEGRITY_BELOW_REQUIRED_COVERAGE"] : []),
    ...(matchedCoverage < 0.99 ? ["MATCHED_BAR_COVERAGE_BELOW_99_PERCENT"] : []),
    ...(featureCoverage < 0.98 ? ["TRAILING_FEATURE_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(advCoverage < 0.98 ? ["ADV_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(costs.funding.coverage < 1 ? ["ACTUAL_FUNDING_ARCHIVE_NOT_MATERIALIZED"] : []),
    ...(costs.markPrice.coverage < 1 ? ["MARK_PRICE_SETTLEMENT_ARCHIVE_NOT_MATERIALIZED"] : []),
  ];
  const gate = await readJson<JsonRecord>(GATE_PATH);
  gate.generatedAt = new Date().toISOString();
  gate.stageB = { ...gate.stageB, requiredArchiveSlots: stageB.requiredArchiveSlots, materializedArchiveSlots: stageB.actualUsedArchives.length, checksumCoverage: stageB.actualUsedArchives.length / stageB.requiredArchiveSlots, missingMetadataSlots: 0 };
  gate.immutableArchives = { ...gate.immutableArchives, requiredArchiveSlots: stageB.requiredArchiveSlots, materializedArchiveSlots: stageB.actualUsedArchives.length, fullArchiveCoverage: 1, checksumCoverage: 1, cachePolicy: "Verified ZIP and official .CHECKSUM are written once; existing paths are digest-checked before reuse." };
  gate.completeness = { matchedBarCoverage: matchedCoverage, trailingFeatureCoverage: featureCoverage, liquidityAdvCoverage: advCoverage, audit: { pairMonths: pairs.length, comparableBars: comparable, matchedBars: matched, validFeatureWindows: featureValid, possibleFeatureWindows: featurePossible, advPassingPairMonths: advPass }, note: "Coverage is measured from the complete immutable Stage B pair-month set; feature windows use only matched consecutive closed 5m bars and ADV requires positive quote volume on both legs." };
  gate.costInputs = { ...gate.costInputs, fundingCoverage: costs.funding.coverage, markPriceCoverage: costs.markPrice.coverage, noFallback: true };
  gate.requirements = { ...gate.requirements, archiveChecksumCoverage: 1, matchedBarCoverage: 0.99, trailingFeatureCoverage: 0.98, fundingCoverage: 1, markPriceCoverage: 1 };
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
  dataFreeze.materialization = { stageBState: { path: "reports/v15-stage-b-materialization.json", sha256: await fileHash(STAGE_B_STATE_PATH) }, costState: { path: "reports/v15-cost-materialization.json", sha256: await fileHash(COST_STATE_PATH) }, coverage: gate.completeness };
  dataFreeze.codeHashes = {
    timestampParser: await fileHash(resolve("lib/v15/lead-lag.ts")),
    featureEngine: await fileHash(resolve("lib/v15/lead-lag.ts")),
    executionEngine: await fileHash(resolve("lib/v15/engine.ts")),
    costEngine: await fileHash(resolve("lib/v15/cost.ts")),
    archiveParser: await fileHash(resolve("lib/v15/archive.ts")),
  };
  dataFreeze.historicalReturnsRead = false;
  await writeJson(DATA_FREEZE_PATH, { ...dataFreeze, manifestSha256: stableHash(dataFreeze) });
  console.info(JSON.stringify({ phase: "finalize-gate", status: gate.status, reasons, pairs: pairs.length, matchedCoverage, featureCoverage, advCoverage }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
