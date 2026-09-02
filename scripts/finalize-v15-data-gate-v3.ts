import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V15_ADV_LOOKBACK_BARS,
  V15_ADV_LOOKBACK_MS,
  coverageOrNotApplicable,
  potentialFundingSettlements,
  settlementInputsCover,
} from "@/lib/v15/data-gate";
import { parseKlineArchive, validateKlineIntegrity, type KlineIntegrity } from "@/lib/v15/archive";
import {
  V15_CONSTANTS,
  buildFeatureSnapshot,
  qualifiesPrimarySignal,
  nextExecutableOpen,
  passesCapacity,
  type V15Bar,
  type V15FeatureSnapshot,
} from "@/lib/v15/lead-lag";

const REPORT_DIR = resolve("reports");
const STAGE_B_PATH = resolve(REPORT_DIR, "v15-stage-b-archive-manifest.json");
const STAGE_B_STATE_PATH = resolve(REPORT_DIR, "v15-stage-b-materialization.json");
const COST_PATH = resolve(REPORT_DIR, "v15-cost-input-manifest.json");
const COST_STATE_PATH = resolve(REPORT_DIR, "v15-cost-materialization.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v15-archive-registry.json");
const V2_GATE_PATH = resolve(REPORT_DIR, "v15-data-gate.json");
const V3_GATE_PATH = resolve(REPORT_DIR, "v15-data-gate-v3.json");
const FREEZE_PATH = resolve(REPORT_DIR, "v15-freeze-manifest.json");
const DATA_FREEZE_V2_PATH = resolve(REPORT_DIR, "v15-data-freeze-v2.json");
const DATA_FREEZE_V3_PATH = resolve(REPORT_DIR, "v15-data-freeze-v3.json");

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v15-spot-perp-lead-lag";
const ORIGINAL_FREEZE_COMMIT = "f469138c314454b973c8d5fd764cae662b9c92d4";
const ORIGINAL_FREEZE_SHA256 = "77e1091826c2e443d044645018ee19421cfdb38c1d92e22db2d4";
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const REFERENCE_CAPITAL_USDT = 10_000;
const EXPECTED_FEATURE_HISTORY_POINTS = V15_CONSTANTS.quantileLookbackMs / V15_CONSTANTS.decisionIntervalMs;

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

interface StageRecord {
  exchange: Exchange;
  symbol: string;
  month: string;
  cachePath: string;
  expectedSha256: string | null;
  actualSha256: string | null;
  bytes: number | null;
  integrity: KlineIntegrity | null;
  status: string;
  error: string | null;
}

interface StageState {
  requiredArchiveSlots: number;
  records: StageRecord[];
  complete: boolean;
}

interface StageManifest {
  requiredArchiveSlots: number;
  requiredArchives: Requirement[];
  actualUsedArchives: Array<{ exchange: Exchange; symbol: string; month: string; cachePath: string; sha256: string; bytes: number }>;
  symbolLifecycle?: Record<string, { firstSpotMonth: string | null; firstFuturesMonth: string | null }>;
  [key: string]: any;
}

interface CostRecord {
  symbol: string;
  month: string;
  fundingCachePath?: string;
  fundingExpectedSha256?: string | null;
  fundingActualSha256?: string | null;
  fundingBytes?: number | null;
  markPriceCachePath?: string;
  markPriceExpectedSha256?: string | null;
  markPriceActualSha256?: string | null;
  markPriceBytes?: number | null;
  normalizedPath?: string;
  normalizedSha256?: string | null;
  points?: number;
  status: string;
  error?: string | null;
}

interface CostState {
  requiredSymbolMonths: number;
  records: CostRecord[];
  complete: boolean;
}

interface PairData {
  symbol: string;
  month: string;
  spotBars: V15Bar[];
  futuresBars: V15Bar[];
}

interface SymbolData {
  symbol: string;
  months: string[];
  spotBars: V15Bar[];
  futuresBars: V15Bar[];
  firstSpotTime: number;
  firstFuturesTime: number;
}

interface AdvWindow {
  available: boolean;
  spotQuoteVolume: number;
  futuresQuoteVolume: number;
  spotObservedBars: number;
  futuresObservedBars: number;
}

interface DecisionRow {
  decisionTime: number;
  feature: V15FeatureSnapshot;
  adv: AdvWindow;
}

interface SymbolAudit {
  decisionTimestamps: number;
  featureWindows: number;
  advAvailable: number;
  rawTriggers: number;
  dataUnavailableSignals: number;
  capacityRejected: number;
  candidates: number;
  executionAvailable: number;
  executionMissing: number;
  settlementRequired: number;
  settlementCovered: number;
  settlementNotRequired: number;
  settlementMissing: Array<{ symbol: string; decisionTime: number; entryTime: number; requiredTimestamps: number[] }>;
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

function monthStart(month: string): number {
  return Date.parse(`${month}-01T00:00:00.000Z`);
}

function nextMonthStart(month: string): number {
  const date = new Date(monthStart(month));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.getTime();
}

function monthForTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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
  return Boolean(integrity)
    && integrity!.duplicateOpenTimes === 0
    && integrity!.nonMonotonicOpenTimes === 0
    && integrity!.invalidDurations === 0
    && integrity!.cadenceCoverage >= 0.99;
}

function stateRecordIsValid(record: StageRecord | undefined): boolean {
  return Boolean(record)
    && record!.status === "PASS"
    && typeof record!.actualSha256 === "string"
    && Number.isFinite(record!.bytes)
    && validKline(record!.integrity);
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

class FenwickQuantile {
  private readonly values: number[];
  private readonly indexByValue: Map<number, number>;
  private readonly tree: number[];
  private total = 0;

  constructor(values: number[]) {
    this.values = [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
    this.indexByValue = new Map(this.values.map((value, index) => [value, index + 1]));
    this.tree = Array.from({ length: this.values.length + 1 }, () => 0);
  }

  add(value: number, delta: number): void {
    const position = this.indexByValue.get(value);
    if (!position) return;
    this.total += delta;
    for (let index = position; index < this.tree.length; index += index & -index) this.tree[index] += delta;
  }

  quantile(probability: number): number {
    if (!this.total || !this.values.length) return Number.NaN;
    const position = (this.total - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const lowerValue = this.kth(lower);
    const upperValue = this.kth(upper);
    return lowerValue + (upperValue - lowerValue) * (position - lower);
  }

  private kth(order: number): number {
    let target = order + 1;
    let index = 0;
    let step = 1;
    while (step * 2 < this.tree.length) step *= 2;
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next < this.tree.length && this.tree[next] < target) {
        index = next;
        target -= this.tree[next];
      }
    }
    return this.values[index];
  }
}

interface BarIndex {
  bars: V15Bar[];
  closeTimes: number[];
  openTimes: number[];
  prefixQuoteVolume: number[];
  gapPrefix: number[];
}

function indexBars(bars: V15Bar[]): BarIndex {
  const sorted = bars.slice().sort((left, right) => left.openTime - right.openTime);
  const prefixQuoteVolume = [0];
  const gapPrefix = [0];
  for (let index = 0; index < sorted.length; index += 1) {
    prefixQuoteVolume.push(prefixQuoteVolume[index] + sorted[index].quoteVolume);
    gapPrefix.push(gapPrefix[index] + (index > 0 && sorted[index].openTime - sorted[index - 1].openTime !== 5 * 60_000 ? 1 : 0));
  }
  return { bars: sorted, closeTimes: sorted.map((bar) => bar.closeTime), openTimes: sorted.map((bar) => bar.openTime), prefixQuoteVolume, gapPrefix };
}

function lastClosedIndex(index: BarIndex, decisionTime: number): number {
  return lowerBound(index.closeTimes, decisionTime) - 1;
}

function trailingAdv(index: BarIndex, timestamp: number): { available: boolean; quoteVolume: number; observedBars: number } {
  const start = lowerBound(index.closeTimes, timestamp - V15_ADV_LOOKBACK_MS);
  const end = lowerBound(index.closeTimes, timestamp);
  const observedBars = end - start;
  const internalGaps = observedBars > 1 ? index.gapPrefix[end - 1] - index.gapPrefix[start] : 0;
  return {
    available: observedBars === V15_ADV_LOOKBACK_BARS && internalGaps === 0,
    quoteVolume: index.prefixQuoteVolume[end] - index.prefixQuoteVolume[start],
    observedBars,
  };
}

function featureAt(symbol: string, decisionTime: number, spot: BarIndex, futures: BarIndex): V15FeatureSnapshot | null {
  const spotEnd = lastClosedIndex(spot, decisionTime);
  const futuresEnd = lastClosedIndex(futures, decisionTime);
  if (spotEnd < 5 || futuresEnd < 5) return null;
  try {
    return buildFeatureSnapshot(symbol, decisionTime, spot.bars.slice(spotEnd - 5, spotEnd + 1), futures.bars.slice(futuresEnd - 5, futuresEnd + 1));
  } catch {
    return null;
  }
}

function archiveBars(record: StageRecord, requirement: Requirement): Promise<V15Bar[]> {
  return readFile(resolve(record.cachePath)).then((bytes) => {
    if (bytes.byteLength !== record.bytes) throw new Error(`cache byte count changed for ${archiveKey(requirement)}`);
    const bars = parseKlineArchive(bytes);
    const integrity = validateKlineIntegrity(bars);
    if (!bars.length || !validKline(integrity)) throw new Error(`archive integrity failed for ${archiveKey(requirement)}`);
    return bars;
  });
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

function firstExecutableOpen(index: BarIndex, timestamp: number): V15Bar | null {
  const position = lowerBound(index.openTimes, timestamp);
  return nextExecutableOpen(index.bars.slice(position, position + 1), timestamp);
}

function firstLifecycleTime(value: string | null | undefined, fallback: number): number {
  const parsed = value ? monthStart(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadValidPairs(
  stageB: StageManifest,
  stageState: StageState,
  onSymbol: (data: SymbolData) => Promise<void>,
): Promise<{ symbolCount: number; invalidPairMonths: string[]; validArchiveKeys: Set<string>; matched: number; comparable: number; validPairMonths: number }> {
  const records = new Map(stageState.records.map((record) => [archiveKey(record), record]));
  const requirementsByPair = new Map<string, { spot?: Requirement; futures?: Requirement }>();
  for (const requirement of stageB.requiredArchives) {
    const pair = requirementsByPair.get(pairKey(requirement)) ?? {};
    if (requirement.exchange === "spot") pair.spot = requirement;
    else pair.futures = requirement;
    requirementsByPair.set(pairKey(requirement), pair);
  }
  const pairNames = [...requirementsByPair.keys()].sort();
  const invalidPairMonths: string[] = [];
  const validArchiveKeys = new Set<string>();
  let matched = 0;
  let comparable = 0;
  let validPairMonths = 0;
  let symbolCount = 0;
  let current: SymbolData | null = null;

  async function flushCurrent(): Promise<void> {
    if (!current) return;
    await onSymbol(current);
    symbolCount += 1;
    current = null;
  }

  for (let index = 0; index < pairNames.length; index += 1) {
    const [symbol, month] = pairNames[index].split("/");
    if (current && current.symbol !== symbol) await flushCurrent();
    const pairRequirements = requirementsByPair.get(pairNames[index]);
    const spotRequirement = pairRequirements?.spot;
    const futuresRequirement = pairRequirements?.futures;
    const spotRecord = spotRequirement ? records.get(archiveKey(spotRequirement)) : undefined;
    const futuresRecord = futuresRequirement ? records.get(archiveKey(futuresRequirement)) : undefined;
    if (!spotRequirement || !futuresRequirement || !stateRecordIsValid(spotRecord) || !stateRecordIsValid(futuresRecord)) {
      invalidPairMonths.push(pairNames[index]);
      continue;
    }
    try {
      const [spotBars, futuresBars] = await Promise.all([archiveBars(spotRecord!, spotRequirement), archiveBars(futuresRecord!, futuresRequirement)]);
      validArchiveKeys.add(archiveKey(spotRequirement));
      validArchiveKeys.add(archiveKey(futuresRequirement));
      matched += matchedCount(spotBars, futuresBars);
      comparable += Math.max(spotBars.length, futuresBars.length);
      current ??= { symbol, months: [], spotBars: [], futuresBars: [], firstSpotTime: Number.POSITIVE_INFINITY, firstFuturesTime: Number.POSITIVE_INFINITY };
      current.months.push(month);
      current.spotBars.push(...spotBars);
      current.futuresBars.push(...futuresBars);
      current.firstSpotTime = Math.min(current.firstSpotTime, spotBars[0]?.openTime ?? Number.POSITIVE_INFINITY);
      current.firstFuturesTime = Math.min(current.firstFuturesTime, futuresBars[0]?.openTime ?? Number.POSITIVE_INFINITY);
      validPairMonths += 1;
    } catch {
      invalidPairMonths.push(pairNames[index]);
    }
    if ((index + 1) % 25 === 0 || index + 1 === pairNames.length) console.info(JSON.stringify({ phase: "v3-load", pairMonthsProcessed: index + 1, pairMonthsTotal: pairNames.length }));
  }
  await flushCurrent();
  return { symbolCount, invalidPairMonths: [...new Set(invalidPairMonths)].sort(), validArchiveKeys, matched, comparable, validPairMonths };
}

async function processSymbol(
  data: SymbolData,
  lifecycle: { firstSpotMonth: string | null; firstFuturesMonth: string | null } | undefined,
  costRecords: Map<string, CostRecord>,
  fundingCache: Map<string, Map<number, number> | null>,
): Promise<SymbolAudit> {
  const spot = indexBars(data.spotBars);
  const futures = indexBars(data.futuresBars);
  const months = [...new Set(data.months)].sort();
  const firstSpotTime = firstLifecycleTime(lifecycle?.firstSpotMonth, data.firstSpotTime);
  const firstFuturesTime = firstLifecycleTime(lifecycle?.firstFuturesMonth, data.firstFuturesTime);
  const minimumActionTime = Math.max(firstSpotTime, firstFuturesTime) + V15_CONSTANTS.minimumAgeMs;
  const rows: DecisionRow[] = [];
  let decisionTimestamps = 0;
  for (const month of months) {
    const start = Math.max(START, monthStart(month));
    const end = Math.min(END + V15_CONSTANTS.decisionIntervalMs, nextMonthStart(month));
    for (let decisionTime = start; decisionTime < end && decisionTime <= END; decisionTime += V15_CONSTANTS.decisionIntervalMs) {
      if (decisionTime < minimumActionTime) continue;
      decisionTimestamps += 1;
      const feature = featureAt(data.symbol, decisionTime, spot, futures);
      if (!feature) continue;
      const spotAdv = trailingAdv(spot, decisionTime);
      const futuresAdv = trailingAdv(futures, decisionTime);
      rows.push({ decisionTime, feature, adv: { available: spotAdv.available && futuresAdv.available, spotQuoteVolume: spotAdv.quoteVolume, futuresQuoteVolume: futuresAdv.quoteVolume, spotObservedBars: spotAdv.observedBars, futuresObservedBars: futuresAdv.observedBars } });
    }
  }

  const shockQuantile = new FenwickQuantile(rows.map((row) => row.feature.spotShock));
  const flowQuantile = new FenwickQuantile(rows.map((row) => Math.abs(row.feature.spotFlow30)));
  const leadQuantile = new FenwickQuantile(rows.map((row) => row.feature.leadStrength).filter((value) => value > 0));
  let historyStart = 0;
  const audit: SymbolAudit = {
    decisionTimestamps,
    featureWindows: rows.length,
    advAvailable: rows.filter((row) => row.adv.available).length,
    rawTriggers: 0,
    dataUnavailableSignals: 0,
    capacityRejected: 0,
    candidates: 0,
    executionAvailable: 0,
    executionMissing: 0,
    settlementRequired: 0,
    settlementCovered: 0,
    settlementNotRequired: 0,
    settlementMissing: [],
  };

  async function settlementCoveredFor(entryTime: number, decisionTime: number): Promise<boolean> {
    const required = potentialFundingSettlements(entryTime, entryTime + V15_CONSTANTS.maxHoldMs);
    if (!required.length) {
      audit.settlementNotRequired += 1;
      return true;
    }
    audit.settlementRequired += 1;
    const available = new Map<number, number>();
    for (const timestamp of required) {
      const month = monthForTimestamp(timestamp);
      const key = `${data.symbol}/${month}`;
      if (!fundingCache.has(key)) {
        const record = costRecords.get(key);
        if (!record || record.status !== "PASS" || !record.normalizedPath || !record.normalizedSha256) fundingCache.set(key, null);
        else {
          try {
            const payload = JSON.parse(await readFile(resolve(record.normalizedPath), "utf8")) as { symbol?: string; points?: Array<{ timestamp: number; markPrice: number }> };
            const points = new Map((payload.points ?? []).filter((point) => payload.symbol === data.symbol && Number.isFinite(point.timestamp) && Number.isFinite(point.markPrice) && point.markPrice > 0).map((point) => [point.timestamp, point.markPrice]));
            fundingCache.set(key, points);
          } catch {
            fundingCache.set(key, null);
          }
        }
      }
      const points = fundingCache.get(key);
      const markPrice = points?.get(timestamp);
      if (Number.isFinite(markPrice) && (markPrice as number) > 0) available.set(timestamp, markPrice as number);
    }
    const covered = settlementInputsCover(required, available);
    if (covered) audit.settlementCovered += 1;
    else audit.settlementMissing.push({ symbol: data.symbol, decisionTime, entryTime, requiredTimestamps: required });
    return covered;
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cutoff = row.decisionTime - V15_CONSTANTS.quantileLookbackMs;
    while (historyStart < index && rows[historyStart].decisionTime < cutoff) {
      shockQuantile.add(rows[historyStart].feature.spotShock, -1);
      flowQuantile.add(Math.abs(rows[historyStart].feature.spotFlow30), -1);
      if (rows[historyStart].feature.leadStrength > 0) leadQuantile.add(rows[historyStart].feature.leadStrength, -1);
      historyStart += 1;
    }
    const historyCount = index - historyStart;
    const fullFeatureHistory = historyCount >= EXPECTED_FEATURE_HISTORY_POINTS
      && rows[historyStart]?.decisionTime === row.decisionTime - V15_CONSTANTS.quantileLookbackMs
      && rows[index - 1]?.decisionTime === row.decisionTime - V15_CONSTANTS.decisionIntervalMs;
    const qualifies = historyCount > 0 && qualifiesPrimarySignal(row.feature, {
      spotShockQ90: shockQuantile.quantile(0.9),
      absoluteSpotFlowQ75: flowQuantile.quantile(0.75),
      positiveLeadStrengthQ80: leadQuantile.quantile(0.8),
    });
    if (qualifies) {
      audit.rawTriggers += 1;
      if (!fullFeatureHistory || !row.adv.available) audit.dataUnavailableSignals += 1;
      else if (!passesCapacity(REFERENCE_CAPITAL_USDT, row.adv.spotQuoteVolume / 30, row.adv.futuresQuoteVolume / 30)) audit.capacityRejected += 1;
      else {
        audit.candidates += 1;
        const entry = firstExecutableOpen(futures, row.decisionTime);
        if (!entry) audit.executionMissing += 1;
        else {
          audit.executionAvailable += 1;
          await settlementCoveredFor(entry.openTime, row.decisionTime);
        }
      }
    }
    shockQuantile.add(row.feature.spotShock, 1);
    flowQuantile.add(Math.abs(row.feature.spotFlow30), 1);
    if (row.feature.leadStrength > 0) leadQuantile.add(row.feature.leadStrength, 1);
  }
  return audit;
}

function sumAudits(audits: SymbolAudit[]): SymbolAudit {
  return audits.reduce((total, current) => ({
    decisionTimestamps: total.decisionTimestamps + current.decisionTimestamps,
    featureWindows: total.featureWindows + current.featureWindows,
    advAvailable: total.advAvailable + current.advAvailable,
    rawTriggers: total.rawTriggers + current.rawTriggers,
    dataUnavailableSignals: total.dataUnavailableSignals + current.dataUnavailableSignals,
    capacityRejected: total.capacityRejected + current.capacityRejected,
    candidates: total.candidates + current.candidates,
    executionAvailable: total.executionAvailable + current.executionAvailable,
    executionMissing: total.executionMissing + current.executionMissing,
    settlementRequired: total.settlementRequired + current.settlementRequired,
    settlementCovered: total.settlementCovered + current.settlementCovered,
    settlementNotRequired: total.settlementNotRequired + current.settlementNotRequired,
    settlementMissing: [...total.settlementMissing, ...current.settlementMissing],
  }), {
    decisionTimestamps: 0,
    featureWindows: 0,
    advAvailable: 0,
    rawTriggers: 0,
    dataUnavailableSignals: 0,
    capacityRejected: 0,
    candidates: 0,
    executionAvailable: 0,
    executionMissing: 0,
    settlementRequired: 0,
    settlementCovered: 0,
    settlementNotRequired: 0,
    settlementMissing: [],
  });
}

async function writeNoResultArtifacts(gate: JsonRecord, freeze: JsonRecord, dataFreezeV2: JsonRecord, dataFreezeV3: JsonRecord): Promise<void> {
  const reason = `DATA_GATE_V3_FAIL: ${gate.reasons.join(", ")}`;
  const notRun = { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
  for (const name of ["v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json"]) await writeJson(resolve(REPORT_DIR, name), notRun);
  await writeJson(resolve(REPORT_DIR, "v15-validation-summary.json"), {
    schema: "v15-validation-summary-v1",
    baseline: BASELINE,
    branch: BRANCH,
    freezeCommit: currentHead(),
    freezeSha256: freeze.manifestSha256,
    dataFreezeV2Sha256: dataFreezeV2.manifestSha256,
    dataFreezeV3Sha256: dataFreezeV3.manifestSha256,
    dataGate: gate.status,
    dataGateV3: gate.status,
    historicalReturnsRead: false,
    result: "V15_DATA_INSUFFICIENT_FINAL",
    emailPromotionCandidate: "FAIL",
    researchStop: "YES",
    reason,
    reasons: gate.reasons,
    primaryOos: null,
    years: { 2022: null, 2023: null, 2024: null },
    holdoutA: null,
    holdoutB: null,
    long: null,
    short: null,
    placebos: null,
    cost: null,
    manualDelay: null,
    confidence: null,
    emailUtility: null,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, autoTrading: false, migration: false, privateBinanceApi: false, orderPlacement: false },
  });
  await writeJson(resolve(REPORT_DIR, "v15-promotion-decision.json"), {
    schema: "v15-promotion-decision-v1",
    classification: "V15_DATA_INSUFFICIENT_FINAL",
    dataGateV3: gate.status,
    dataGateReasons: gate.reasons,
    emailPromotionCandidate: "FAIL",
    researchStop: "YES",
    reason,
    historicalReturnsRead: false,
  });
  await writeFile(resolve(REPORT_DIR, "v15-promotion-decision.md"), [
    "# V15 Promotion Decision",
    "",
    "- Classification: **V15_DATA_INSUFFICIENT_FINAL**",
    "- Data Gate V3: **FAIL**",
    `- Reasons: **${gate.reasons.join(", ")}**`,
    "- Strategy returns: **NOT READ**",
    "- Email promotion: **FAIL**",
    "- Research stop: **YES**",
    "- Production changed: **NO**",
    "",
  ].join("\n"), "utf8");
  const artifactNames = ["v15-data-gate.json", "v15-data-gate-v3.json", "v15-archive-registry.json", "v15-stage-b-archive-manifest.json", "v15-cost-input-manifest.json", "v15-freeze-manifest.json", "v15-data-freeze-v2.json", "v15-data-freeze-v3.json", "v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-validation-summary.json", "v15-promotion-decision.json", "v15-promotion-decision.md"];
  const hashes: Record<string, string> = {};
  for (const name of artifactNames) hashes[name] = await fileHash(resolve(REPORT_DIR, name));
  await writeJson(resolve(REPORT_DIR, "v15-evidence-manifest.json"), {
    schema: "v15-evidence-manifest-v3",
    baseline: BASELINE,
    branch: BRANCH,
    freezeSha256: freeze.manifestSha256,
    dataFreezeV2Sha256: dataFreezeV2.manifestSha256,
    dataFreezeV3Sha256: dataFreezeV3.manifestSha256,
    dataGateV3Sha256: await fileHash(V3_GATE_PATH),
    resultCommit: null,
    historicalReturnsRead: false,
    artifacts: hashes,
  });
}

async function main(): Promise<void> {
  const stageB = await readJson<StageManifest>(STAGE_B_PATH);
  const stageState = await readJson<StageState>(STAGE_B_STATE_PATH);
  const costState = await readJson<CostState>(COST_STATE_PATH);
  const previousGate = await readJson<JsonRecord>(V2_GATE_PATH);
  const registry = await readJson<JsonRecord>(REGISTRY_PATH);
  const freeze = await readJson<JsonRecord>(FREEZE_PATH);
  const dataFreezeV2 = await readJson<JsonRecord>(DATA_FREEZE_V2_PATH);

  const requiredArchiveKeys = new Set(stageB.requiredArchives.map(archiveKey));
  const stageKeyAudit = new Set<string>();
  const stageDuplicates: string[] = [];
  for (const record of stageState.records) {
    const key = archiveKey(record);
    if (stageKeyAudit.has(key)) stageDuplicates.push(key);
    stageKeyAudit.add(key);
  }
  const missingStageKeys = [...requiredArchiveKeys].filter((key) => !stageKeyAudit.has(key));
  const extraStageKeys = [...stageKeyAudit].filter((key) => !requiredArchiveKeys.has(key));
  const stageInventoryComplete = stageState.records.length === stageB.requiredArchiveSlots && missingStageKeys.length === 0 && extraStageKeys.length === 0 && stageDuplicates.length === 0;

  const costRecords = new Map(costState.records.map((record) => [pairKey(record), record]));
  const audits: SymbolAudit[] = [];
  let symbolsProcessed = 0;
  const loaded = await loadValidPairs(stageB, stageState, async (symbol) => {
    audits.push(await processSymbol(symbol, stageB.symbolLifecycle?.[symbol.symbol], costRecords, new Map()));
    symbolsProcessed += 1;
    console.info(JSON.stringify({ phase: "v3-events", symbolsProcessed, symbolsTotal: null }));
  });
  const invalidPairMonths = loaded.invalidPairMonths;
  const invalidArchiveKeys = stageB.requiredArchives.filter((requirement) => invalidPairMonths.includes(pairKey(requirement))).map(archiveKey).sort();
  const validArchiveSlots = stageB.requiredArchives.length - invalidArchiveKeys.length;
  const usedArchiveSlots = loaded.validArchiveKeys.size;
  const stageRecordByKey = new Map(stageState.records.map((record) => [archiveKey(record), record]));
  const usedChecksumCoverage = usedArchiveSlots ? [...loaded.validArchiveKeys].filter((key) => {
    const record = stageRecordByKey.get(key);
    return Boolean(record?.actualSha256 && Number.isFinite(record.bytes));
  }).length / usedArchiveSlots : 0;
  const usedIntegrityCoverage = usedArchiveSlots ? 1 : 0;
  const matchedCoverage = loaded.comparable ? loaded.matched / loaded.comparable : 0;

  const requiredCostKeys = new Set([...new Set(stageB.requiredArchives.map(pairKey))]);
  const costKeys = new Set(costState.records.map(pairKey));
  const missingCostKeys = [...requiredCostKeys].filter((key) => !costKeys.has(key));
  const extraCostKeys = [...costKeys].filter((key) => !requiredCostKeys.has(key));
  const costDuplicates = costState.records.length - costKeys.size;
  const costInventoryComplete = costState.records.length === requiredCostKeys.size && missingCostKeys.length === 0 && extraCostKeys.length === 0 && costDuplicates === 0;
  const fundingArchiveAvailable = costState.records.filter((record) => Boolean(record.fundingActualSha256 && Number.isFinite(record.fundingBytes))).length;
  const markArchiveAvailable = costState.records.filter((record) => Boolean(record.markPriceActualSha256 && Number.isFinite(record.markPriceBytes))).length;
  const settlementRecordsAvailable = costState.records.filter((record) => record.status === "PASS" && Boolean(record.normalizedSha256) && (record.points ?? 0) > 0).length;
  const globalFundingCoverage = requiredCostKeys.size ? fundingArchiveAvailable / requiredCostKeys.size : 0;
  const globalMarkCoverage = requiredCostKeys.size ? markArchiveAvailable / requiredCostKeys.size : 0;
  const globalSettlementCoverage = requiredCostKeys.size ? settlementRecordsAvailable / requiredCostKeys.size : 0;

  const audit = sumAudits(audits);
  const featureCoverage = audit.decisionTimestamps ? audit.featureWindows / audit.decisionTimestamps : 0;
  const advCoverage = audit.featureWindows ? audit.advAvailable / audit.featureWindows : 0;
  const candidateExecutionCoverage = coverageOrNotApplicable(audit.executionAvailable, audit.candidates);
  const candidateSettlementCoverage = coverageOrNotApplicable(audit.settlementCovered, audit.settlementRequired);
  const timestampNormalizationPass = previousGate.timestampNormalization?.status === "PASS";
  const registryComplete = registry.complete === true;
  const noSurvivorBias = previousGate.lifecycle?.noCurrentSurvivorFilter === true;
  const noFutureLifecycle = previousGate.lifecycle?.noFutureLifecycle === true;
  const noSyntheticFallback = previousGate.costInputs?.noFallback === true;
  const reasons = [
    ...(!registryComplete || !stageInventoryComplete ? ["OFFICIAL_ARCHIVE_INVENTORY_INCOMPLETE"] : []),
    ...(usedChecksumCoverage < 1 ? ["USED_ARCHIVE_CHECKSUM_COVERAGE_BELOW_100_PERCENT"] : []),
    ...(usedIntegrityCoverage < 1 ? ["USED_ARCHIVE_INTEGRITY_COVERAGE_BELOW_100_PERCENT"] : []),
    ...(matchedCoverage < 0.99 ? ["MATCHED_BAR_COVERAGE_BELOW_99_PERCENT"] : []),
    ...(featureCoverage < 0.98 ? ["FEATURE_WINDOW_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(advCoverage < 0.98 ? ["TRAILING_30D_ADV_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(candidateExecutionCoverage !== null && candidateExecutionCoverage < 0.99 ? ["CANDIDATE_EXECUTION_PRICE_COVERAGE_BELOW_99_PERCENT"] : []),
    ...(candidateSettlementCoverage !== null && candidateSettlementCoverage < 1 ? ["CANDIDATE_SETTLEMENT_INPUT_COVERAGE_BELOW_100_PERCENT"] : []),
    ...(!timestampNormalizationPass ? ["TIMESTAMP_NORMALIZATION_NOT_PASS"] : []),
    ...(!noSurvivorBias ? ["CURRENT_SURVIVOR_FILTER_NOT_PROVEN_ABSENT"] : []),
    ...(!noFutureLifecycle ? ["FUTURE_LIFECYCLE_NOT_PROVEN_ABSENT"] : []),
    ...(!noSyntheticFallback ? ["SYNTHETIC_OR_FALLBACK_COST_NOT_PROVEN_ABSENT"] : []),
    ...(!costInventoryComplete ? ["COST_INPUT_INVENTORY_INCOMPLETE"] : []),
  ];

  const invalidArchiveExclusionHash = stableHash(invalidPairMonths);
  const advCoverageDefinition = "For every otherwise-eligible 15m decision timestamp, both Spot and Futures must contain exactly the complete trailing 30 calendar days of closed 5m bars before T; zero quote volume remains observed data and is not treated as missing. ADV value is the observed quote-volume sum divided by 30 days and capacity is evaluated separately against the frozen 0.0001 participation limit.";
  const costAvailabilityDefinition = "Global funding/mark archive availability is descriptive only. A candidate requires real fundingRate and markPrice inputs only for scheduled funding settlements in its potential entry-to-entry-plus-4h hold window; irrelevant missing months do not fail the experiment. No fallback or synthetic value is allowed.";
  const candidateSettlementDefinition = "Candidate settlement coverage is covered execution candidates with every required 8h funding timestamp mapped to a real normalized funding point and positive mark price, divided by execution candidates whose potential 4h window crosses at least one funding settlement; candidates with no required settlement are reported separately and are not penalized.";
  const gate: JsonRecord = {
    schema: "v15-data-gate-v3",
    generatedAt: new Date().toISOString(),
    baseline: BASELINE,
    branch: BRANCH,
    source: previousGate.source,
    archiveInventory: {
      officialRegistryComplete: registryComplete,
      stageInventoryComplete,
      requiredArchiveSlots: stageB.requiredArchiveSlots,
      materializedArchiveSlots: stageState.records.filter((record) => record.actualSha256 && Number.isFinite(record.bytes)).length,
      validArchiveSlots,
      invalidArchiveSlots: invalidArchiveKeys.length,
      usedArchiveSlots,
      usedChecksumCoverage,
      usedIntegrityCoverage,
      invalidPairMonths,
      invalidArchiveKeys,
      invalidArchiveExclusionHash,
    },
    pitUniverse: {
      ...previousGate.pitUniverse,
      eligiblePairMonthsAfterIntegrityExclusion: loaded.validPairMonths,
      invalidPairMonthsExcluded: invalidPairMonths.length,
      rule: "At each decision timestamp require both lifecycle-eligible legs and exclude any pair-month with an official missing or integrity-invalid archive; no current-survivor universe and no future lifecycle information.",
    },
    eligibility: {
      decisionTimestamps: audit.decisionTimestamps,
      featureEligibleTimestamps: audit.featureWindows,
      advEligibleTimestamps: audit.advAvailable,
      invalidPairMonthsExcluded: invalidPairMonths,
      ageRule: "90 calendar days from the earlier official first-availability month of each leg",
      featureRule: "six consecutive closed 5m bars and a complete frozen 60d feature history for a candidate",
      unavailableTimestampsAreExcluded: true,
    },
    timestampNormalization: {
      ...(previousGate.timestampNormalization ?? {}),
      status: timestampNormalizationPass ? "PASS" : "FAIL",
    },
    completeness: {
      matchedBarCoverage: matchedCoverage,
      featureWindowCoverage: featureCoverage,
      trailing30dAdvCoverage: advCoverage,
      audit: {
        pairMonthsRequired: stageB.requiredArchiveSlots / 2,
        pairMonthsUsed: loaded.validPairMonths,
        comparableBars: loaded.comparable,
        matchedBars: loaded.matched,
        decisionTimestamps: audit.decisionTimestamps,
        featureEligibleTimestamps: audit.featureWindows,
        advAvailableTimestamps: audit.advAvailable,
      },
      priorV2Audit: {
        matchedBarCoverage: previousGate.completeness?.matchedBarCoverage ?? null,
        featureCoverage: previousGate.completeness?.trailingFeatureCoverage ?? null,
        advCoverage: previousGate.completeness?.liquidityAdvCoverage ?? null,
      },
    },
    costAvailability: {
      globalPairMonthFundingArchiveCoverage: globalFundingCoverage,
      globalPairMonthMarkArchiveCoverage: globalMarkCoverage,
      globalPairMonthUsableSettlementCoverage: globalSettlementCoverage,
      requiredPairMonths: requiredCostKeys.size,
      fundingArchiveAvailable,
      markArchiveAvailable,
      usableSettlementPairMonths: settlementRecordsAvailable,
      inventoryComplete: costInventoryComplete,
      noFallback: true,
      definition: costAvailabilityDefinition,
      definitionHash: stableHash(costAvailabilityDefinition),
    },
    candidates: {
      rawTriggers: audit.rawTriggers,
      dataUnavailableSignals: audit.dataUnavailableSignals,
      capacityRejected: audit.capacityRejected,
      executionCandidates: audit.candidates,
      executionAvailable: audit.executionAvailable,
      executionMissing: audit.executionMissing,
      executionPriceCoverage: candidateExecutionCoverage,
      settlementRequiredCandidates: audit.settlementRequired,
      settlementCoveredCandidates: audit.settlementCovered,
      settlementNotRequiredCandidates: audit.settlementNotRequired,
      settlementCoverage: candidateSettlementCoverage,
      settlementMissing: audit.settlementMissing,
      settlementDefinition: candidateSettlementDefinition,
      settlementDefinitionHash: stableHash(candidateSettlementDefinition),
    },
    definitions: {
      adv: advCoverageDefinition,
      advCoverageDefinitionHash: stableHash(advCoverageDefinition),
      invalidPairMonthStatus: "DATA_UNAVAILABLE_PAIR_MONTH",
      usedArchiveIntegrity: "Only Spot/Futures archives with checksum-verified PASS integrity enter the eligible dataset; invalid pair-months are excluded, never repaired or forward-filled.",
      noLookahead: "Only closed 5m bars are used for features and trailing ADV; execution uses only the next futures 5m openTime/open price; no exit fields or future outcome are read.",
    },
    gates: {
      officialArchiveInventory: registryComplete && stageInventoryComplete,
      usedChecksumCoverage: usedChecksumCoverage === 1,
      usedArchiveIntegrity: usedIntegrityCoverage === 1,
      matchedBars: matchedCoverage >= 0.99,
      featureWindows: featureCoverage >= 0.98,
      trailing30dAdv: advCoverage >= 0.98,
      candidateExecutionPrice: candidateExecutionCoverage === null || candidateExecutionCoverage >= 0.99,
      candidateSettlementInputs: candidateSettlementCoverage === null || candidateSettlementCoverage === 1,
      timestampNormalization: timestampNormalizationPass,
      noSurvivorBias,
      noFutureLifecycle,
      noSyntheticFallback,
    },
    status: reasons.length ? "FAIL" : "PASS",
    classification: reasons.length ? "V15_DATA_INSUFFICIENT_FINAL" : "PASS",
    reasons,
    historicalReturnsRead: false,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false },
  };

  await writeJson(V3_GATE_PATH, gate);
  await writeJson(V2_GATE_PATH, gate);

  const updatedStageManifest = { ...stageB, actualUsedArchives: stageB.requiredArchives.flatMap((requirement) => {
    const key = archiveKey(requirement);
    const record = stageRecordByKey.get(key);
    return loaded.validArchiveKeys.has(key) && record?.actualSha256 && Number.isFinite(record.bytes)
      ? [{ exchange: requirement.exchange, symbol: requirement.symbol, month: requirement.month, cachePath: requirement.cachePath, sha256: record.actualSha256, bytes: record.bytes as number }]
      : [];
  }) };
  await writeJson(STAGE_B_PATH, updatedStageManifest);

  const updatedFreezeBody: JsonRecord = { ...freeze, dataGateHash: stableHash(gate), historicalReturnsRead: false };
  delete updatedFreezeBody.manifestSha256;
  const updatedFreeze = { ...updatedFreezeBody, manifestSha256: stableHash(updatedFreezeBody) };
  await writeJson(FREEZE_PATH, updatedFreeze);

  const updatedDataFreezeV2Body: JsonRecord = {
    ...dataFreezeV2,
    stageBArchiveManifest: { path: "reports/v15-stage-b-archive-manifest.json", sha256: await fileHash(STAGE_B_PATH) },
    costInputManifest: { path: "reports/v15-cost-input-manifest.json", sha256: await fileHash(COST_PATH) },
    dataGate: { path: "reports/v15-data-gate.json", sha256: await fileHash(V2_GATE_PATH), status: gate.status },
    historicalReturnsRead: false,
  };
  delete updatedDataFreezeV2Body.manifestSha256;
  const updatedDataFreezeV2 = { ...updatedDataFreezeV2Body, manifestSha256: stableHash(updatedDataFreezeV2Body) };
  await writeJson(DATA_FREEZE_V2_PATH, updatedDataFreezeV2);

  const dataFreezeV3Body: JsonRecord = {
    schema: "v15-data-freeze-v3",
    status: "FROZEN_BEFORE_RETURNS",
    sourceHead: currentHead(),
    baseline: BASELINE,
    branch: BRANCH,
    originalFreeze: { commit: ORIGINAL_FREEZE_COMMIT, sha256: ORIGINAL_FREEZE_SHA256 },
    dataFreezeV2Sha256: updatedDataFreezeV2.manifestSha256,
    alphaDefinitionsUnchanged: true,
    alphaDefinitionHashes: {
      fixedAlphaDefinitions: stableHash(dataFreezeV2.fixedAlphaDefinitions),
      thresholds: stableHash(freeze.thresholds),
      trade: stableHash(freeze.trade),
      validation: stableHash(freeze.validation),
    },
    invalidArchiveExclusionHash,
    invalidPairMonths,
    advCoverageDefinitionHash: stableHash(advCoverageDefinition),
    costAvailabilityDefinitionHash: stableHash(costAvailabilityDefinition),
    candidateSettlementCoverageDefinitionHash: stableHash(candidateSettlementDefinition),
    dataGateV3: { path: "reports/v15-data-gate-v3.json", sha256: await fileHash(V3_GATE_PATH), status: gate.status },
    historicalReturnsRead: false,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false },
  };
  const dataFreezeV3 = { ...dataFreezeV3Body, manifestSha256: stableHash(dataFreezeV3Body) };
  await writeJson(DATA_FREEZE_V3_PATH, dataFreezeV3);

  if (gate.status === "FAIL") await writeNoResultArtifacts(gate, updatedFreeze, updatedDataFreezeV2, dataFreezeV3);
  console.info(JSON.stringify({
    phase: "finalize-gate-v3",
    status: gate.status,
    classification: gate.classification,
    reasons,
    requiredArchives: stageB.requiredArchiveSlots,
    validArchives: validArchiveSlots,
    invalidArchives: invalidArchiveKeys.length,
    usedArchives: usedArchiveSlots,
    usedChecksumCoverage,
    usedIntegrityCoverage,
    matchedCoverage,
    featureCoverage,
    advCoverage,
    candidateExecutionCoverage,
    candidateSettlementCoverage,
    rawTriggers: audit.rawTriggers,
    historicalReturnsRead: false,
  }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
