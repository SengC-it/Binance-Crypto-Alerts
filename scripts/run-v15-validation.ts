import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProxyAgent, fetch } from "undici";
import { normalizeBinanceTimestamp } from "@/lib/v15/lead-lag";
import { parseKlineArchive, readZipEntries, validateKlineIntegrity, type KlineIntegrity } from "@/lib/v15/archive";
import {
  metricsAtStress,
  metricsForHorizon,
  metricsForSymbols,
  runFrozenV15,
  confidenceForTrades,
  type V15EngineResult,
  type V15FundingPoint,
  type V15MetricSet,
  type V15PairDataset,
} from "@/lib/v15/engine";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v15-spot-perp-lead-lag";
const CONTINUATION_HEAD = "86e06307434b27feff7f78d228d419dd7b6fbdd9";
const ORIGINAL_FREEZE_COMMIT = "f469138c314454b973c8d5fd764cae662b9c92d4";
const ORIGINAL_FREEZE_SHA256 = "77e1091826c2e443d044645018ee19421cfdb38c1d92e22db2d4aab090f563b3";
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const MONTHS = monthKeys(START, END);
const DIRECT_ROOT = "https://data.binance.vision";
const S3_ROOT = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision/";
const REPORT_DIR = resolve("reports");
const CACHE_DIR = resolve("data/raw/v15-spot-perp-lead-lag");
const PROXY = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;

type Exchange = "spot" | "futuresUm";

interface ArchiveObject {
  key: string;
  size: number | null;
  month: string;
}

interface ExchangeAvailability {
  exchange: Exchange;
  root: string;
  symbols: string[];
  archives: Record<string, ArchiveObject[]>;
  errors: string[];
}

interface SentinelResult {
  exchange: Exchange;
  symbol: string;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  status: "PASS" | "FAIL" | "UNAVAILABLE";
  expectedSha256: string | null;
  actualSha256: string | null;
  bytes: number | null;
  rowCount: number | null;
  rawFirstOpenTime: number | null;
  normalizedFirstOpenTime: number | null;
  timestampUnit: "milliseconds" | "microseconds" | "seconds" | "unknown";
  integrity: KlineIntegrity | null;
  error: string | null;
}

interface StageBArchiveRequirement {
  exchange: Exchange;
  symbol: string;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  expectedBytes: number | null;
}

interface StageBArchiveManifest {
  schema: "v15-stage-b-archive-manifest-v1";
  selectionRule: string;
  requiredArchiveSlots: number;
  missingMetadataSlots: number;
  expectedBytes: number;
  requiredArchives: StageBArchiveRequirement[];
  actualUsedArchives: Array<{ exchange: Exchange; symbol: string; month: string; cachePath: string; sha256: string; bytes: number }>;
  immutablePolicy: string;
}

interface CostInputManifest {
  schema: "v15-cost-input-manifest-v1";
  funding: { sourceTemplate: string; requiredSymbolMonths: number; materializedSymbolMonths: number; coverage: number; actualFiles: string[] };
  markPrice: { sourceTemplate: string; requiredArchiveSlots: number; materializedArchiveSlots: number; coverage: number; actualFiles: string[] };
  noFallback: true;
}

interface DataGateReport {
  schema: "v15-data-gate-v2";
  generatedAt: string;
  baseline: string;
  branch: string;
  source: {
    provider: "Binance Data Vision";
    spotPath: string;
    futuresPath: string;
    interval: "5m";
    start: string;
    end: string;
    officialOnly: true;
  };
  enumeration: {
    spotSymbols: number;
    futuresSymbols: number;
    sharedSymbols: number;
    spotErrors: string[];
    futuresErrors: string[];
    archiveObjectsFound: number;
  };
  archiveRegistry: { path: string; complete: boolean; records: number; months: number };
  stageB: { path: string; requiredArchiveSlots: number; materializedArchiveSlots: number; checksumCoverage: number; missingMetadataSlots: number };
  pitUniverse: {
    rule: string;
    monthly: Array<{ month: string; eligiblePairs: number; symbols: string[] }>;
    medianEligiblePairs: number;
    minimumEligiblePairs: number;
    maximumEligiblePairs: number;
    formationCoverage: number;
  };
  immutableArchives: {
    requiredArchiveSlots: number;
    materializedArchiveSlots: number;
    fullArchiveCoverage: number;
    checksumCoverage: number;
    sentinelResults: SentinelResult[];
    cachePolicy: string;
  };
  timestampNormalization: {
    status: "PASS" | "FAIL";
    testedArchiveSamples: number;
    rule: string;
    samples: Array<Pick<SentinelResult, "exchange" | "symbol" | "month" | "rawFirstOpenTime" | "normalizedFirstOpenTime" | "timestampUnit">>;
  };
  completeness: {
    matchedBarCoverage: number;
    trailingFeatureCoverage: number;
    liquidityAdvCoverage: number;
    note: string;
  };
  costInputs: { path: string; fundingCoverage: number; markPriceCoverage: number; noFallback: true };
  lifecycle: { noCurrentSurvivorFilter: true; noFutureLifecycle: true };
  requirements: {
    archiveChecksumCoverage: number;
    matchedBarCoverage: number;
    trailingFeatureCoverage: number;
    pitFormationCoverage: number;
    fundingCoverage: number;
    markPriceCoverage: number;
  };
  status: "PASS" | "FAIL";
  classification: "PASS" | "V15_DATA_INSUFFICIENT_FINAL";
 reasons: string[];
  historicalReturnsRead: false;
}

function monthKeys(start: number, end: number): string[] {
  const values: string[] = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  while (cursor.getTime() <= end) {
    values.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return values;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function currentHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function xmlValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1]));
}

function xmlValue(xml: string, tag: string): string | null {
  return xmlValues(xml, tag)[0] ?? null;
}

async function request(url: string, as: "text" | "bytes"): Promise<string | Buffer> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        dispatcher: PROXY,
        headers: { "user-agent": "binance-crypto-alerts-v15-research/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return as === "text" ? await response.text() : Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function listObjects(prefix: string, delimiter?: string): Promise<{ keys: Array<{ key: string; size: number | null }>; prefixes: string[] }> {
  const keys: Array<{ key: string; size: number | null }> = [];
  const prefixes: string[] = [];
  let token: string | null = null;
  do {
    const url = new URL(S3_ROOT);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", "1000");
    if (delimiter) url.searchParams.set("delimiter", delimiter);
    if (token) url.searchParams.set("continuation-token", token);
    const xml = String(await request(url.toString(), "text"));
    for (const block of xmlValues(xml, "Contents")) {
      const key = xmlValue(block, "Key");
      if (key) keys.push({ key, size: Number(xmlValue(block, "Size")) || null });
    }
    prefixes.push(...xmlValues(xml, "CommonPrefixes").map((block) => xmlValue(block, "Prefix")).filter((value): value is string => Boolean(value)));
    token = xmlValue(xml, "NextContinuationToken");
  } while (token);
  return { keys, prefixes };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
  return results;
}

function exchangeRoot(exchange: Exchange): string {
  return exchange === "spot" ? "data/spot/monthly/klines/" : "data/futures/um/monthly/klines/";
}

function symbolFromPrefix(prefix: string, root: string): string | null {
  const value = prefix.slice(root.length).replace(/\/$/, "");
  return /^[A-Z0-9]+USDT$/.test(value) ? value : null;
}

async function enumerateExchange(exchange: Exchange): Promise<ExchangeAvailability> {
  const root = exchangeRoot(exchange);
  const errors: string[] = [];
  let rootListing: { prefixes: string[] };
  try {
    rootListing = await listObjects(root, "/");
  } catch (error) {
    return { exchange, root, symbols: [], archives: {}, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const symbols = rootListing.prefixes.map((prefix) => symbolFromPrefix(prefix, root)).filter((value): value is string => Boolean(value)).sort();
  const rows = await mapLimit(symbols, 64, async (symbol) => {
    try {
      const listing = await listObjects(root + symbol + "/5m/");
      const archives = listing.keys.map((item) => {
        const match = item.key.match(/-(5m)-([0-9]{4}-[0-9]{2})[.]zip$/);
        return match ? { key: item.key, size: item.size, month: match[2] } : null;
      }).filter((value): value is ArchiveObject => value !== null && MONTHS.includes(value.month));
      return { symbol, archives };
    } catch (error) {
      return { symbol, archives: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  const archiveMap: Record<string, ArchiveObject[]> = {};
  for (const row of rows) {
    archiveMap[row.symbol] = row.archives;
    if ("error" in row && row.error) errors.push(`${row.symbol}: ${row.error}`);
  }
  for (const archives of Object.values(archiveMap)) archives.sort((left, right) => left.month.localeCompare(right.month));
  return { exchange, root, symbols, archives: archiveMap, errors };
}

function archiveMap(availability: ExchangeAvailability, symbol: string): Map<string, ArchiveObject> {
  return new Map((availability.archives[symbol] ?? []).map((item) => [item.month, item]));
}

function buildPitUniverse(spot: ExchangeAvailability, futures: ExchangeAvailability): DataGateReport["pitUniverse"] {
  const common = spot.symbols.filter((symbol) => futures.symbols.includes(symbol));
  const monthly = MONTHS.map((month) => {
    const timestamp = Date.parse(`${month}-01T00:00:00.000Z`);
    const symbols = common.filter((symbol) => {
      const spotMap = archiveMap(spot, symbol);
      const futuresMap = archiveMap(futures, symbol);
      if (!spotMap.has(month) || !futuresMap.has(month)) return false;
      const firstSpot = Math.min(...(spot.archives[symbol] ?? []).map((item) => Date.parse(`${item.month}-01T00:00:00.000Z`)));
      const firstFutures = Math.min(...(futures.archives[symbol] ?? []).map((item) => Date.parse(`${item.month}-01T00:00:00.000Z`)));
      return Number.isFinite(firstSpot) && Number.isFinite(firstFutures) && timestamp - Math.max(firstSpot, firstFutures) >= 90 * 24 * 60 * 60_000;
    });
    return { month, eligiblePairs: symbols.length, symbols };
  });
  const counts = monthly.map((row) => row.eligiblePairs);
  const sorted = counts.slice().sort((left, right) => left - right);
  const medianEligiblePairs = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const required = common.length * MONTHS.length;
  const eligible = counts.reduce((sum, value) => sum + value, 0);
  return {
    rule: "At each 15m decision, both Spot SYMBOLUSDT and USD-M perpetual must have complete PIT 5m data, be listed at that time, and have at least 90 days of prior archive history; no current-universe backfill.",
    monthly,
    medianEligiblePairs,
    minimumEligiblePairs: counts.length ? Math.min(...counts) : 0,
    maximumEligiblePairs: counts.length ? Math.max(...counts) : 0,
    formationCoverage: required ? eligible / required : 0,
  };
}

function buildArchiveRegistry(spot: ExchangeAvailability, futures: ExchangeAvailability): Record<string, unknown> {
  const sharedSymbols = spot.symbols.filter((symbol) => futures.symbols.includes(symbol)).sort();
  const records = sharedSymbols.map((symbol) => {
    const spotMonths = (spot.archives[symbol] ?? []).map((item) => item.month);
    const futuresMonths = (futures.archives[symbol] ?? []).map((item) => item.month);
    const sharedMonths = spotMonths.filter((month) => futuresMonths.includes(month));
    return {
      symbol,
      spotFirstMonth: spotMonths[0] ?? null,
      spotLastMonth: spotMonths.at(-1) ?? null,
      futuresFirstMonth: futuresMonths[0] ?? null,
      futuresLastMonth: futuresMonths.at(-1) ?? null,
      spotAvailableMonths: spotMonths,
      futuresAvailableMonths: futuresMonths,
      sharedAvailableMonths: sharedMonths,
    };
  });
  return {
    schema: "v15-archive-registry-v1",
    provider: "Binance Data Vision",
    interval: "5m",
    period: { start: new Date(START).toISOString(), end: new Date(END).toISOString() },
    enumeration: "all shared Spot SYMBOLUSDT and USD-M perpetual SYMBOLUSDT archive keys, including later-delisted symbols",
    noCurrentSurvivorFilter: true,
    complete: spot.errors.length === 0 && futures.errors.length === 0,
    records,
  };
}

function rawFirstTimestamp(buffer: Buffer): number | null {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  const firstLine = entry?.data.toString("utf8").split(/\r?\n/).find((line) => Number.isFinite(Number(line.split(",")[0])));
  const value = firstLine ? Number(firstLine.split(",")[0]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function timestampUnit(value: number | null): SentinelResult["timestampUnit"] {
  if (value === null) return "unknown";
  if (value >= 1_000_000_000_000_000) return "microseconds";
  if (value >= 1_000_000_000_000) return "milliseconds";
  if (value >= 1_000_000_000) return "seconds";
  return "unknown";
}

function directArchiveUrl(exchange: Exchange, symbol: string, month: string): string {
  const root = exchange === "spot" ? "spot" : "futures/um";
  return `${DIRECT_ROOT}/data/${root}/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

function relativeCachePath(exchange: Exchange, symbol: string, month: string): string {
  return `data/raw/v15-spot-perp-lead-lag/${exchange}/${symbol}/${month}.zip`;
}

function buildStageBArchiveManifest(
  spot: ExchangeAvailability,
  futures: ExchangeAvailability,
  pitUniverse: DataGateReport["pitUniverse"],
  sentinels: SentinelResult[],
): StageBArchiveManifest {
  const requiredArchives: StageBArchiveRequirement[] = [];
  for (const month of pitUniverse.monthly) {
    for (const symbol of month.symbols) {
      for (const exchange of ["spot", "futuresUm"] as const) {
        const availability = exchange === "spot" ? spot : futures;
        const object = archiveMap(availability, symbol).get(month.month);
        const sourceUrl = directArchiveUrl(exchange, symbol, month.month);
        requiredArchives.push({
          exchange,
          symbol,
          month: month.month,
          sourceUrl,
          checksumUrl: `${sourceUrl}.CHECKSUM`,
          cachePath: relativeCachePath(exchange, symbol, month.month),
          expectedBytes: object?.size ?? null,
        });
      }
    }
  }
  const actualUsedArchives = sentinels
    .filter((row) => row.status === "PASS" && row.actualSha256 && row.bytes !== null)
    .map((row) => ({
      exchange: row.exchange,
      symbol: row.symbol,
      month: row.month,
      cachePath: relativeCachePath(row.exchange, row.symbol, row.month),
      sha256: row.actualSha256 as string,
      bytes: row.bytes as number,
    }));
  return {
    schema: "v15-stage-b-archive-manifest-v1",
    selectionRule: "Materialize only the PIT monthly Spot/Perp archive slots required by the frozen 15m engine; no blind download and no current-survivor filter.",
    requiredArchiveSlots: requiredArchives.length,
    missingMetadataSlots: requiredArchives.filter((row) => row.expectedBytes === null).length,
    expectedBytes: requiredArchives.reduce((sum, row) => sum + (row.expectedBytes ?? 0), 0),
    requiredArchives,
    actualUsedArchives,
    immutablePolicy: "Every materialized ZIP must be verified against its official .CHECKSUM before first write; an existing cache path with a different digest is a hard failure.",
  };
}

function buildCostInputManifest(pitUniverse: DataGateReport["pitUniverse"]): CostInputManifest {
  const requiredSymbolMonths = pitUniverse.monthly.reduce((sum, row) => sum + row.symbols.length, 0);
  return {
    schema: "v15-cost-input-manifest-v1",
    funding: {
      sourceTemplate: `${DIRECT_ROOT}/data/futures/um/daily/fundingRate/{symbol}/{symbol}-fundingRate-{date}.zip`,
      requiredSymbolMonths,
      materializedSymbolMonths: 0,
      coverage: 0,
      actualFiles: [],
    },
    markPrice: {
      sourceTemplate: `${DIRECT_ROOT}/data/futures/um/monthly/markPriceKlines/{symbol}/5m/{symbol}-5m-{month}.zip`,
      requiredArchiveSlots: requiredSymbolMonths,
      materializedArchiveSlots: 0,
      coverage: 0,
      actualFiles: [],
    },
    noFallback: true,
  };
}

async function materializeSentinels(spot: ExchangeAvailability, futures: ExchangeAvailability): Promise<SentinelResult[]> {
  const results: SentinelResult[] = [];
  for (const exchange of ["spot", "futuresUm"] as const) {
    const availability = exchange === "spot" ? spot : futures;
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      for (const month of ["2021-01", "2025-01"]) {
        const object = archiveMap(availability, symbol).get(month);
        const sourceUrl = directArchiveUrl(exchange, symbol, month);
        const checksumUrl = `${sourceUrl}.CHECKSUM`;
        const result: SentinelResult = {
          exchange, symbol, month, sourceUrl, checksumUrl, status: object ? "FAIL" : "UNAVAILABLE",
          expectedSha256: null, actualSha256: null, bytes: null, rowCount: null, rawFirstOpenTime: null,
          normalizedFirstOpenTime: null, timestampUnit: "unknown", integrity: null, error: null,
        };
        if (!object) {
          result.error = "Archive not present in official listing";
          results.push(result);
          continue;
        }
        try {
          const checksumText = String(await request(checksumUrl, "text"));
          result.expectedSha256 = checksumText.match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase() ?? null;
          if (!result.expectedSha256) throw new Error("CHECKSUM did not contain a SHA-256 digest");
          const bytes = Buffer.from(await request(sourceUrl, "bytes"));
          result.actualSha256 = sha256(bytes);
          result.bytes = bytes.length;
          if (result.actualSha256 !== result.expectedSha256) throw new Error(`SHA-256 mismatch: expected ${result.expectedSha256}, received ${result.actualSha256}`);
          const parsed = parseKlineArchive(bytes);
          result.rowCount = parsed.length;
          result.integrity = validateKlineIntegrity(parsed);
          if (
            result.integrity.duplicateOpenTimes > 0
            || result.integrity.nonMonotonicOpenTimes > 0
            || result.integrity.invalidDurations > 0
            || result.integrity.cadenceCoverage < 0.99
          ) throw new Error(`kline integrity failed: ${JSON.stringify(result.integrity)}`);
          result.rawFirstOpenTime = rawFirstTimestamp(bytes);
          result.normalizedFirstOpenTime = result.rawFirstOpenTime === null ? null : normalizeBinanceTimestamp(result.rawFirstOpenTime);
          result.timestampUnit = timestampUnit(result.rawFirstOpenTime);
          if (result.normalizedFirstOpenTime === null || !Number.isFinite(result.normalizedFirstOpenTime)) throw new Error("timestamp normalization failed");
          const destination = join(CACHE_DIR, exchange, symbol, `${month}.zip`);
          await mkdir(join(CACHE_DIR, exchange, symbol), { recursive: true });
          try {
            const existing = await readFile(destination);
            if (sha256(existing) !== result.actualSha256) throw new Error(`immutable cache collision at ${destination}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") await writeFile(destination, bytes, { flag: "wx" });
            else throw error;
          }
          result.status = "PASS";
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
        results.push(result);
      }
    }
  }
  return results;
}

function buildDataGate(spot: ExchangeAvailability, futures: ExchangeAvailability, sentinels: SentinelResult[], completeness = { matchedBarCoverage: 0, trailingFeatureCoverage: 0, liquidityAdvCoverage: 0 }): DataGateReport {
  const pitUniverse = buildPitUniverse(spot, futures);
  const registry = buildArchiveRegistry(spot, futures);
  const stageB = buildStageBArchiveManifest(spot, futures, pitUniverse, sentinels);
  const costInputs = buildCostInputManifest(pitUniverse);
  const requiredArchiveSlots = stageB.requiredArchiveSlots;
  const materializedArchiveSlots = stageB.actualUsedArchives.length;
  const checksumCoverage = requiredArchiveSlots ? materializedArchiveSlots / requiredArchiveSlots : 0;
  const timestampSamples = sentinels.filter((row) => row.status === "PASS");
  const timestampPass = timestampSamples.length >= 2 && timestampSamples.every((row) => (
    row.normalizedFirstOpenTime !== null
    && row.integrity !== null
    && row.integrity.duplicateOpenTimes === 0
    && row.integrity.nonMonotonicOpenTimes === 0
    && row.integrity.invalidDurations === 0
    && row.integrity.cadenceCoverage >= 0.99
  ));
  const reasons: string[] = [];
  if (!registry.complete) reasons.push("ARCHIVE_ENUMERATION_INCOMPLETE");
  if (stageB.missingMetadataSlots > 0) reasons.push("STAGE_B_ARCHIVE_METADATA_INCOMPLETE");
  if (materializedArchiveSlots < requiredArchiveSlots) reasons.push("IMMUTABLE_FULL_5M_ARCHIVE_SET_NOT_MATERIALIZED");
  if (checksumCoverage < 1) reasons.push("ARCHIVE_CHECKSUM_COVERAGE_BELOW_100_PERCENT");
  if (!timestampPass) reasons.push("TIMESTAMP_NORMALIZATION_NOT_VERIFIED_FOR_REQUIRED_SAMPLES");
  if (completeness.matchedBarCoverage < 0.99) reasons.push("MATCHED_BAR_COVERAGE_BELOW_99_PERCENT");
  if (completeness.trailingFeatureCoverage < 0.98) reasons.push("TRAILING_FEATURE_COVERAGE_BELOW_98_PERCENT");
  if (completeness.liquidityAdvCoverage < 0.98) reasons.push("ADV_COVERAGE_BELOW_98_PERCENT");
  if (costInputs.funding.coverage < 1) reasons.push("ACTUAL_FUNDING_ARCHIVE_NOT_MATERIALIZED");
  if (costInputs.markPrice.coverage < 1) reasons.push("MARK_PRICE_SETTLEMENT_ARCHIVE_NOT_MATERIALIZED");
  return {
    schema: "v15-data-gate-v2",
    generatedAt: new Date().toISOString(), baseline: BASELINE, branch: BRANCH,
    source: {
      provider: "Binance Data Vision", spotPath: "data/spot/monthly/klines/{symbol}/5m", futuresPath: "data/futures/um/monthly/klines/{symbol}/5m",
      interval: "5m", start: new Date(START).toISOString(), end: new Date(END).toISOString(), officialOnly: true,
    },
    enumeration: {
      spotSymbols: spot.symbols.length, futuresSymbols: futures.symbols.length, sharedSymbols: spot.symbols.filter((symbol) => futures.symbols.includes(symbol)).length,
      spotErrors: spot.errors, futuresErrors: futures.errors, archiveObjectsFound: Object.values(spot.archives).flat().length + Object.values(futures.archives).flat().length,
    },
    archiveRegistry: { path: "reports/v15-archive-registry.json", complete: registry.complete === true, records: Array.isArray(registry.records) ? registry.records.length : 0, months: MONTHS.length },
    stageB: {
      path: "reports/v15-stage-b-archive-manifest.json",
      requiredArchiveSlots,
      materializedArchiveSlots,
      checksumCoverage,
      missingMetadataSlots: stageB.missingMetadataSlots,
    },
    pitUniverse,
    immutableArchives: {
      requiredArchiveSlots, materializedArchiveSlots, fullArchiveCoverage: requiredArchiveSlots ? materializedArchiveSlots / requiredArchiveSlots : 0,
      checksumCoverage, sentinelResults: sentinels, cachePolicy: "Verified ZIP and .CHECKSUM are written once; an existing path with a different digest is a hard failure.",
    },
    timestampNormalization: {
      status: timestampPass ? "PASS" : "FAIL", testedArchiveSamples: timestampSamples.length,
      rule: "Normalize source seconds/milliseconds/microseconds to UTC milliseconds; Spot and USD-M Futures are checked independently.",
      samples: timestampSamples.map(({ exchange, symbol, month, rawFirstOpenTime, normalizedFirstOpenTime, timestampUnit }) => ({ exchange, symbol, month, rawFirstOpenTime, normalizedFirstOpenTime, timestampUnit })),
    },
    completeness: {
      matchedBarCoverage: completeness.matchedBarCoverage, trailingFeatureCoverage: completeness.trailingFeatureCoverage, liquidityAdvCoverage: completeness.liquidityAdvCoverage,
      note: completeness.matchedBarCoverage >= 0.99 && completeness.trailingFeatureCoverage >= 0.98 && completeness.liquidityAdvCoverage >= 0.98
        ? "Coverage was measured over the complete immutable Stage B archive set."
        : "Coverage requirements are not met; no returns or strategy metrics were read.",
    },
    costInputs: { path: "reports/v15-cost-input-manifest.json", fundingCoverage: costInputs.funding.coverage, markPriceCoverage: costInputs.markPrice.coverage, noFallback: true },
    lifecycle: { noCurrentSurvivorFilter: true, noFutureLifecycle: true },
    requirements: { archiveChecksumCoverage: 1, matchedBarCoverage: 0.99, trailingFeatureCoverage: 0.98, pitFormationCoverage: 0.98, fundingCoverage: 1, markPriceCoverage: 1 },
    status: reasons.length ? "FAIL" : "PASS", reasons, historicalReturnsRead: false,
    classification: reasons.length ? "V15_DATA_INSUFFICIENT_FINAL" : "PASS",
  };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function freezeManifest(dataGate: DataGateReport): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schema: "v15-freeze-manifest-v1", status: "FROZEN_BEFORE_RETURNS", generatedAt: new Date().toISOString(), baseline: BASELINE, branch: BRANCH,
    data: {
      provider: "Binance Data Vision", period: { start: new Date(START).toISOString(), end: new Date(END).toISOString() }, interval: "5m",
      spot: "official spot klines", perpetual: "official USD-M futures klines", requiredChecksumCoverage: 1, noThirdParty: true,
    },
    pitUniverse: { allEligiblePairs: true, minimumAgeDays: 90, noCurrentUniverseBackfill: true, lifecycleIsPointInTime: true, formationCoverage: 0.98 },
    liquidity: { lookbackDays: 30, referenceCapitalUsdt: 10_000, maxParticipation: 0.0001, bothLegsRequired: true, capacityOnly: true },
    signalClock: { decisionInterval: "15m", sourceBars: "closed 5m only", decisionTimestampRule: "all input bars close before T", execution: "first complete futures 5m open after T", sameWindowExecution: false },
    features: {
      exact: ["spotReturn30", "perpReturn30", "spotQuoteVolume30", "perpQuoteVolume30", "spotTakerBuyQuote30", "perpTakerBuyQuote30", "spotFlow30", "perpFlow30", "direction", "spotShock", "leadStrength", "spotDirectionalFlow", "perpDirectionalFlow"],
      formulas: { spotFlow30: "2 * spotTakerBuyQuote30 / spotQuoteVolume30 - 1", perpFlow30: "2 * perpTakerBuyQuote30 / perpQuoteVolume30 - 1", leadStrength: "direction * (spotReturn30 - perpReturn30)" },
      noLookahead: true,
    },
    thresholds: { perSymbolTrailingDays: 60, spotShock: "Q90", absoluteSpotFlow: "Q75", positiveLeadStrength: "Q80", fixedBeforeReturns: true, noSearch: true },
    trade: { side: "same as spot shock direction", atr15m: 14, emergencyStop: "1.5 * ATR", takeProfit: "2R", maxHold: "4h", noOverlapSameSymbol: true, unfavorableSameBarOrder: "STOP first", diagnosticHorizons: ["30m", "1h", "2h", "4h"] },
    costs: { takerFeeBpsPerSide: 4, baseSlippageBpsPerSide: 2, funding: "actual historical USD-M funding with mark-price settlement", stressRoundTripBps: [5, 10, 20] },
    manualDelays: ["5m", "15m", "30m"],
    validation: { nestedPurgedWalkForward: true, oosYears: [2022, 2023, 2024], warmupYear: 2021, holdoutA: "2025-01-01/2025-12-31", holdoutB: "2026-01-01/2026-07-31", noPostHoldoutTuning: true, placebos: ["reverse direction", "perp-led swap", "time-matched random same symbol/month/hour"] },
    gates: { oosTrades: 200, holdoutATrades: 50, holdoutBTrades: 30, oosNetR: ">0", oosAvgR: ">=0.10", oosPF: ">=1.30", oosMaxDD: "<=8R", positiveFoldRatio: ">=0.67", medianFoldNetR: ">0", baseNetR: ">0", stress5bpsNetR: ">0", stress10bpsNetR: ">0", holdoutNetR: ">0", holdoutAvgR: ">0", holdoutPF: ">=1.20", holdoutMaxDD: "<=6R", confidenceLCB: ">0", emailAvgMonthly: ">=2", emailMedianMonthly: ">=2", emailActiveMonthRatio: ">=0.75", emailMaxDroughtDays: "<=30" },
    boundaries: { signalAndSmtpOnly: true, productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, autoTrading: false, privateBinanceApi: false },
    dataGateHash: stableHash(dataGate), historicalReturnsRead: false,
  };
  return { ...body, manifestSha256: stableHash(body) };
}

async function fileSha256(relativePath: string): Promise<string> {
  return sha256(await readFile(resolve(relativePath)));
}

async function dataFreezeV2(dataGate: DataGateReport): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    schema: "v15-data-freeze-v2",
    status: "FROZEN_BEFORE_RETURNS",
    sourceHead: currentHead(),
    baseline: BASELINE,
    branch: BRANCH,
    originalFreeze: { commit: ORIGINAL_FREEZE_COMMIT, sha256: ORIGINAL_FREEZE_SHA256 },
    alphaDefinitionsUnchanged: true,
    fixedAlphaDefinitions: {
      features: ["spotReturn30", "perpReturn30", "spotQuoteVolume30", "perpQuoteVolume30", "spotTakerBuyQuote30", "perpTakerBuyQuote30", "spotFlow30", "perpFlow30", "direction", "spotShock", "leadStrength", "spotDirectionalFlow", "perpDirectionalFlow"],
      thresholds: { spotShock: "Q90", absoluteSpotFlow: "Q75", positiveLeadStrength: "Q80", lookback: "60d" },
      decisionClock: "15m",
      featureWindow: "30m of closed 5m bars",
      execution: "next complete futures 5m open after the closed decision window",
      risk: { atrPeriod: 14, stopAtrMultiple: 1.5, takeProfitR: 2, maxHold: "4h", noOverlapSameSymbol: true },
      liquidity: { lookback: "30d", participation: 0.0001, bothLegs: true },
      costs: { feeBpsPerSide: 4, slippageBpsPerSide: 2, funding: "actual historical funding with mark-price settlement" },
      manualDelays: ["5m", "15m", "30m"],
      validation: { folds: [2022, 2023, 2024], holdoutA: "2025", holdoutB: "2026-01/2026-07", placebos: true },
    },
    enumerationRule: "Enumerate every official Spot SYMBOLUSDT and USD-M perpetual SYMBOLUSDT monthly 5m prefix, including later-delisted symbols.",
    pitLifecycleRule: "At each timestamp require both legs to be available, at least 90 days old, and fully observed for the required lookback; never use today's survivor universe or future lifecycle information.",
    archiveRegistry: { path: "reports/v15-archive-registry.json", sha256: await fileSha256("reports/v15-archive-registry.json") },
    stageBArchiveManifest: { path: "reports/v15-stage-b-archive-manifest.json", sha256: await fileSha256("reports/v15-stage-b-archive-manifest.json") },
    costInputManifest: { path: "reports/v15-cost-input-manifest.json", sha256: await fileSha256("reports/v15-cost-input-manifest.json") },
    dataGate: { path: "reports/v15-data-gate.json", sha256: await fileSha256("reports/v15-data-gate.json"), status: dataGate.status },
    codeHashes: {
      timestampParser: await fileSha256("lib/v15/lead-lag.ts"),
      featureEngine: await fileSha256("lib/v15/lead-lag.ts"),
      executionEngine: await fileSha256("lib/v15/engine.ts"),
      costEngine: await fileSha256("lib/v15/cost.ts"),
      archiveParser: await fileSha256("lib/v15/archive.ts"),
    },
    historicalReturnsRead: false,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false },
  };
  return { ...body, manifestSha256: stableHash(body) };
}

async function runFreeze(): Promise<void> {
  if (currentHead() !== CONTINUATION_HEAD) throw new Error(`data freeze v2 must start at the approved V15 result head ${CONTINUATION_HEAD}; current ${currentHead()}`);
  const [spot, futures] = await Promise.all([enumerateExchange("spot"), enumerateExchange("futuresUm")]);
  const sentinels = await materializeSentinels(spot, futures);
  await writeJson("v15-archive-registry.json", buildArchiveRegistry(spot, futures));
  const pitUniverse = buildPitUniverse(spot, futures);
  const stageB = buildStageBArchiveManifest(spot, futures, pitUniverse, sentinels);
  const costInputs = buildCostInputManifest(pitUniverse);
  await writeJson("v15-stage-b-archive-manifest.json", stageB);
  await writeJson("v15-cost-input-manifest.json", costInputs);
  const dataGate = buildDataGate(spot, futures, sentinels);
  await writeJson("v15-data-gate.json", dataGate);
  await writeJson("v15-freeze-manifest.json", freezeManifest(dataGate));
  await writeJson("v15-data-freeze-v2.json", await dataFreezeV2(dataGate));
  console.info(JSON.stringify({ phase: "freeze", status: dataGate.status, reasons: dataGate.reasons, historicalReturnsRead: false }));
}

function notRun(reason: string): Record<string, unknown> {
  return { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
}

function metricRecord(metrics: V15MetricSet): Record<string, unknown> {
  return {
    trades: metrics.trades, grossR: metrics.grossR, feesR: metrics.feesR, slippageR: metrics.slippageR,
    fundingR: metrics.fundingR, netR: metrics.netR, netPnl: metrics.netPnl, avgR: metrics.avgR,
    profitFactor: metrics.profitFactor, maxDrawdownR: metrics.maxDrawdownR, cvar95R: metrics.cvar95R, winRate: metrics.winRate,
  };
}

function windowTrades(trades: V15EngineResult["trades"], start: number, end: number): V15EngineResult["trades"] {
  return trades.filter((trade) => trade.decisionTime >= start && trade.decisionTime <= end);
}

function maxDroughtDays(trades: V15EngineResult["trades"]): number {
  const entries = trades.map((trade) => trade.entryTime).sort((left, right) => left - right);
  let largest = 0;
  for (let index = 1; index < entries.length; index += 1) largest = Math.max(largest, entries[index] - entries[index - 1]);
  return largest / (24 * 60 * 60_000);
}

function integrityIsValid(integrity: KlineIntegrity): boolean {
  return integrity.duplicateOpenTimes === 0
    && integrity.nonMonotonicOpenTimes === 0
    && integrity.invalidDurations === 0
    && integrity.cadenceCoverage >= 0.99;
}

async function loadFrozenDataset(stageB: StageBArchiveManifest, costs: CostInputManifest, symbol: string): Promise<V15PairDataset> {
  if (stageB.actualUsedArchives.length !== stageB.requiredArchiveSlots) throw new Error("Stage B archive set is not fully materialized");
  if (costs.funding.coverage < 1 || costs.markPrice.coverage < 1) throw new Error("actual funding and mark-price inputs are not fully materialized");
  const actual = new Map(stageB.actualUsedArchives.map((row) => [row.exchange + "/" + row.symbol + "/" + row.month, row]));
  const requirements = stageB.requiredArchives.filter((requirement) => requirement.symbol === symbol);
  const spotBars: V15PairDataset["spotBars"] = [];
  const futuresBars: V15PairDataset["futuresBars"] = [];
  for (const requirement of requirements) {
    const key = requirement.exchange + "/" + requirement.symbol + "/" + requirement.month;
    const record = actual.get(key);
    if (!record) throw new Error("missing immutable archive record: " + key);
    const bytes = await readFile(resolve(record.cachePath));
    if (sha256(bytes) !== record.sha256) throw new Error("immutable archive digest mismatch: " + record.cachePath);
    const bars = parseKlineArchive(bytes);
    if (!bars.length || !integrityIsValid(validateKlineIntegrity(bars))) throw new Error("invalid immutable archive: " + record.cachePath);
    if (requirement.exchange === "spot") spotBars.push(...bars);
    else futuresBars.push(...bars);
  }
  const funding: V15FundingPoint[] = [];
  for (const file of costs.funding.actualFiles.filter((path) => path.replaceAll("\\", "/").includes(`/funding/${symbol}/`))) {
    const payload = JSON.parse(await readFile(resolve(file), "utf8")) as { symbol?: string; points?: V15FundingPoint[] };
    if (payload.symbol !== symbol || !Array.isArray(payload.points)) throw new Error("invalid funding cache: " + file);
    const points = payload.points.filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.fundingRate) && Number.isFinite(point.markPrice) && point.markPrice > 0);
    funding.push(...points);
  }
  if (!spotBars.length || !futuresBars.length || !funding.length) throw new Error(`incomplete frozen dataset: ${symbol}`);
  return {
    symbol,
    spotBars,
    futuresBars,
    funding,
    eligible: true,
    firstSpotTime: Math.min(...spotBars.map((bar) => bar.openTime)),
    firstFuturesTime: Math.min(...futuresBars.map((bar) => bar.openTime)),
  };
}

type V15Variant = "primary" | "reverse-direction" | "perp-led-swap" | "random-direction";

async function runFrozenVariantsBySymbol(stageB: StageBArchiveManifest, costs: CostInputManifest, variants: V15Variant[]): Promise<Record<V15Variant, V15EngineResult>> {
  const symbols = [...new Set(stageB.requiredArchives.map((requirement) => requirement.symbol))].sort();
  const accumulators = new Map<V15Variant, { signalsEvaluated: number; rawTriggers: number; rejectedSignals: number; trades: V15EngineResult["trades"]; delays: Record<5 | 15 | 30, { expired: number; trades: V15EngineResult["trades"] }> }>();
  for (const variant of variants) accumulators.set(variant, { signalsEvaluated: 0, rawTriggers: 0, rejectedSignals: 0, trades: [], delays: { 5: { expired: 0, trades: [] }, 15: { expired: 0, trades: [] }, 30: { expired: 0, trades: [] } } });
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    const dataset = await loadFrozenDataset(stageB, costs, symbol);
    for (const variant of variants) {
      const result = runFrozenV15([dataset], { startTime: START, endTime: END, referenceCapitalUsdt: 10_000, variant, retainFeatureSnapshots: false });
      const accumulator = accumulators.get(variant)!;
      accumulator.signalsEvaluated += result.signalsEvaluated;
      accumulator.rawTriggers += result.rawTriggers;
      accumulator.rejectedSignals += result.rejectedSignals;
      accumulator.trades.push(...result.trades);
      for (const delay of result.delayOutcomes) {
        accumulator.delays[delay.delayMinutes].expired += delay.expiredBeforeEntry;
        accumulator.delays[delay.delayMinutes].trades.push(...delay.trades);
      }
    }
    if ((index + 1) % 10 === 0 || index + 1 === symbols.length) console.info(JSON.stringify({ phase: "result", variantRuns: variants, symbolsProcessed: index + 1, symbolsTotal: symbols.length }));
  }
  return Object.fromEntries(variants.map((variant) => {
    const accumulator = accumulators.get(variant)!;
    return [variant, {
      signalsEvaluated: accumulator.signalsEvaluated,
      rawTriggers: accumulator.rawTriggers,
      rejectedSignals: accumulator.rejectedSignals,
      trades: accumulator.trades,
      featureSnapshots: [],
      metrics: metricsAtStress(accumulator.trades, 0),
      delayOutcomes: ([5, 15, 30] as const).map((delayMinutes) => ({ delayMinutes, expiredBeforeEntry: accumulator.delays[delayMinutes].expired, trades: accumulator.delays[delayMinutes].trades, metrics: metricsAtStress(accumulator.delays[delayMinutes].trades, 0) })),
      confidence: confidenceForTrades(accumulator.trades),
    } satisfies V15EngineResult];
  })) as unknown as Record<V15Variant, V15EngineResult>;
}

function resultEmailUtility(trades: V15EngineResult["trades"]): Record<string, unknown> {
  const inSample = windowTrades(trades, Date.UTC(2022, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59, 999));
  const counts = new Map<string, number>();
  for (const trade of inSample) {
    const date = new Date(trade.entryTime);
    const key = date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const monthly = Array.from({ length: 36 }, (_, index) => {
    const date = new Date(Date.UTC(2022, index, 1));
    return counts.get(date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0")) ?? 0;
  });
  const ordered = monthly.slice().sort((left, right) => left - right);
  return {
    emails: inSample.length,
    meanPerMonth: inSample.length / 36,
    medianPerMonth: ordered.length % 2 ? ordered[18] : (ordered[17] + ordered[18]) / 2,
    activeMonthRatio: monthly.filter((value) => value > 0).length / 36,
    maxDroughtDays: maxDroughtDays(inSample),
  };
}

function metricGate(metrics: V15MetricSet, rules: { trades: number; netR: number; avgR?: number; profitFactor: number; maxDrawdownR?: number }): boolean {
  return metrics.trades >= rules.trades
    && metrics.netR > rules.netR
    && (rules.avgR === undefined || metrics.avgR >= rules.avgR)
    && metrics.profitFactor >= rules.profitFactor
    && (rules.maxDrawdownR === undefined || metrics.maxDrawdownR <= rules.maxDrawdownR);
}

function median(values: number[]): number {
  const ordered = values.slice().sort((left, right) => left - right);
  if (!ordered.length) return Number.NaN;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function yearMetricMap(trades: V15EngineResult["trades"]): Record<string, V15MetricSet> {
  return Object.fromEntries([2022, 2023, 2024].map((year) => [
    String(year),
    metricsAtStress(windowTrades(trades, Date.UTC(year, 0, 1), Date.UTC(year, 11, 31, 23, 59, 59, 999)), 0),
  ]));
}

function summarizeFoldGate(years: Record<string, V15MetricSet>): { positiveFoldRatio: number; medianFoldNetR: number } {
  const foldNet = Object.values(years).map((metrics) => metrics.netR);
  return { positiveFoldRatio: foldNet.filter((value) => value > 0).length / foldNet.length, medianFoldNetR: median(foldNet) };
}

function metricWithFold(metrics: V15MetricSet, folds: { positiveFoldRatio: number; medianFoldNetR: number }): Record<string, unknown> {
  return { ...metricRecord(metrics), ...folds };
}

async function writeDataInsufficientResult(dataGate: DataGateReport, freezeSha256: string, dataFreezeSha256: string): Promise<void> {
  const classification = dataGate.classification;
  const reason = "DATA_GATE_FAIL: " + dataGate.reasons.join(", ");
  for (const file of ["v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json"]) await writeJson(file, notRun(reason));
  await writeJson("v15-validation-summary.json", {
    schema: "v15-validation-summary-v1", baseline: BASELINE, branch: BRANCH, freezeCommit: currentHead(), freezeSha256, dataFreezeV2Sha256: dataFreezeSha256,
    dataGate: dataGate.status, historicalReturnsRead: false, result: classification, emailPromotionCandidate: "FAIL", researchStop: "YES", reason,
    primaryOos: null, years: { 2022: null, 2023: null, 2024: null }, holdoutA: null, holdoutB: null, long: null, short: null, placebos: null, cost: null, manualDelay: null, confidence: null, emailUtility: null,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, autoTrading: false, migration: false, privateBinanceApi: false, orderPlacement: false },
  });
  await writeJson("v15-promotion-decision.json", { schema: "v15-promotion-decision-v1", classification, emailPromotionCandidate: "FAIL", researchStop: "YES", reason, historicalReturnsRead: false });
  await writeText("v15-promotion-decision.md", [
    "# V15 Promotion Decision", "", "- Classification: **" + classification + "**", "- Data Gate: **FAIL**",
    "- Strategy returns: **NOT READ** because the immutable full archive and required cost inputs did not satisfy the gate.",
    "- Email promotion: **FAIL**", "- Research stop: **YES**", "- Production changed: **NO**", "",
  ].join("\n"));
  const files = ["v15-data-gate.json", "v15-archive-registry.json", "v15-stage-b-archive-manifest.json", "v15-cost-input-manifest.json", "v15-freeze-manifest.json", "v15-data-freeze-v2.json", "v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-validation-summary.json", "v15-promotion-decision.json", "v15-promotion-decision.md"];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(resolve(REPORT_DIR, file)));
  await writeJson("v15-evidence-manifest.json", { schema: "v15-evidence-manifest-v2", baseline: BASELINE, branch: BRANCH, freezeSha256, dataFreezeV2Sha256: dataFreezeSha256, resultCommit: currentHead(), historicalReturnsRead: false, artifacts: hashes });
  console.info(JSON.stringify({ phase: "result", classification, historicalReturnsRead: false }));
}

async function runResult(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-freeze-manifest.json"), "utf8")) as Record<string, unknown>;
  const freezeSha256 = manifest.manifestSha256;
  const manifestBody = { ...manifest };
  delete manifestBody.manifestSha256;
  if (typeof freezeSha256 !== "string" || freezeSha256 !== stableHash(manifestBody)) throw new Error("freeze manifest hash verification failed");
  if (manifest.baseline !== BASELINE || manifest.branch !== BRANCH || manifest.historicalReturnsRead !== false) throw new Error("freeze identity or returns-read guard failed");
  const dataFreeze = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-data-freeze-v2.json"), "utf8")) as Record<string, unknown>;
  const dataFreezeSha256 = dataFreeze.manifestSha256;
  const dataFreezeBody = { ...dataFreeze };
  delete dataFreezeBody.manifestSha256;
  if (typeof dataFreezeSha256 !== "string" || dataFreezeSha256 !== stableHash(dataFreezeBody)) throw new Error("data freeze v2 hash verification failed");
  const original = dataFreeze.originalFreeze as Record<string, unknown> | undefined;
  if (!original || original.commit !== ORIGINAL_FREEZE_COMMIT || original.sha256 !== ORIGINAL_FREEZE_SHA256) throw new Error("original freeze identity drift");
  if (dataFreeze.historicalReturnsRead !== false) throw new Error("data freeze v2 claims returns were read");
  const dataGate = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-data-gate.json"), "utf8")) as DataGateReport;
  if (dataGate.status === "FAIL") {
    await writeDataInsufficientResult(dataGate, freezeSha256, dataFreezeSha256);
    return;
  }
  const stageB = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-stage-b-archive-manifest.json"), "utf8")) as StageBArchiveManifest;
  const costs = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-cost-input-manifest.json"), "utf8")) as CostInputManifest;
  const engines = await runFrozenVariantsBySymbol(stageB, costs, ["primary", "reverse-direction", "perp-led-swap", "random-direction"]);
  const engine = engines.primary;
  const oosTrades = windowTrades(engine.trades, Date.UTC(2022, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59, 999));
  const holdoutATrades = windowTrades(engine.trades, Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31, 23, 59, 59, 999));
  const holdoutBTrades = windowTrades(engine.trades, Date.UTC(2026, 0, 1), END);
  const baseMetrics = metricsAtStress(oosTrades, 0);
  const holdoutAMetrics = metricsAtStress(holdoutATrades, 0);
  const holdoutBMetrics = metricsAtStress(holdoutBTrades, 0);
  const years = yearMetricMap(oosTrades);
  const folds = summarizeFoldGate(years);
  const base = metricWithFold(baseMetrics, folds);
  const holdoutA = metricRecord(holdoutAMetrics);
  const holdoutB = metricRecord(holdoutBMetrics);
  const delays = Object.fromEntries(engine.delayOutcomes.map((outcome) => [
    outcome.delayMinutes + "m", {
      expiredBeforeEntry: outcome.expiredBeforeEntry,
      metrics: metricRecord(metricsAtStress(windowTrades(outcome.trades, Date.UTC(2022, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59, 999)), 0)),
    },
  ]));
  const delay15 = engine.delayOutcomes.find((outcome) => outcome.delayMinutes === 15)!;
  const delay30 = engine.delayOutcomes.find((outcome) => outcome.delayMinutes === 30)!;
  const symbols = metricsForSymbols(oosTrades);
  const stress5 = metricsAtStress(oosTrades, 5);
  const stress10 = metricsAtStress(oosTrades, 10);
  const stress20 = metricsAtStress(oosTrades, 20);
  const emailUtility = resultEmailUtility(oosTrades);
  const primaryGate = metricGate(baseMetrics, { trades: 200, netR: 0, avgR: 0.10, profitFactor: 1.30, maxDrawdownR: 8 })
    && folds.positiveFoldRatio >= 0.67
    && folds.medianFoldNetR > 0
    && stress5.netR > 0
    && stress10.netR > 0
    && engine.confidence.lower95 > 0;
  const holdoutGate = metricGate(holdoutAMetrics, { trades: 50, netR: 0, avgR: 0, profitFactor: 1.20, maxDrawdownR: 6 })
    && metricGate(holdoutBMetrics, { trades: 30, netR: 0, avgR: 0, profitFactor: 1.20, maxDrawdownR: 6 });
  const manualGate = delay15.metrics.netR > 0 && delay15.metrics.profitFactor >= 1.20
    && delay30.metrics.netR > 0 && delay30.metrics.profitFactor >= 1.15;
  const emailGate = Number(emailUtility.meanPerMonth) >= 2
    && Number(emailUtility.medianPerMonth) >= 2
    && Number(emailUtility.activeMonthRatio) >= 0.75
    && Number(emailUtility.maxDroughtDays) <= 30;
  const allGates = primaryGate && holdoutGate && manualGate && emailGate;
  const classification = oosTrades.length < 200
    ? "V15_INSUFFICIENT_SAMPLE"
    : allGates
      ? "V15_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED"
      : "V15_SPOT_PERP_LEAD_LAG_REJECTED";
  const common = { baseline: BASELINE, branch: BRANCH, historicalReturnsRead: true, classification };
  const cost = {
    base,
    "+5bps": metricRecord(stress5),
    "+10bps": metricRecord(stress10),
    "+20bps": metricRecord(stress20),
    fixedHorizon: Object.fromEntries([30, 60, 120, 240].map((minutes) => [minutes + "m", metricRecord(metricsForHorizon(oosTrades, minutes * 60_000))])),
    symbolMetrics: Object.fromEntries(Object.entries(symbols).map(([symbol, metrics]) => [symbol, metricRecord(metrics)])),
    emailUtility,
  };
  const placeboMetrics = Object.fromEntries(Object.entries(engines).filter(([variant]) => variant !== "primary").map(([variant, placebo]) => [variant, {
    oos: metricRecord(metricsAtStress(windowTrades(placebo.trades, Date.UTC(2022, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59, 999)), 0)),
    holdoutA: metricRecord(metricsAtStress(windowTrades(placebo.trades, Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31, 23, 59, 59, 999)), 0)),
    holdoutB: metricRecord(metricsAtStress(windowTrades(placebo.trades, Date.UTC(2026, 0, 1), END), 0)),
  }]));
  await writeJson("v15-oos-results.json", { schema: "v15-oos-results-v2", ...common, primary: base, rawTriggers: engine.rawTriggers, rejectedSignals: engine.rejectedSignals, years: Object.fromEntries(Object.entries(years).map(([year, metrics]) => [year, metricRecord(metrics)])), long: metricRecord(metricsAtStress(oosTrades.filter((trade) => trade.direction === 1), 0)), short: metricRecord(metricsAtStress(oosTrades.filter((trade) => trade.direction === -1), 0)), confidence: engine.confidence, stress: cost, gates: { primary: primaryGate, holdouts: holdoutGate, manualDelay: manualGate, emailUtility: emailGate } });
  await writeJson("v15-holdouts.json", { schema: "v15-holdouts-v2", ...common, holdoutA, holdoutB });
  await writeJson("v15-placebos.json", { schema: "v15-placebos-v2", ...common, status: "RUN", variants: placeboMetrics });
  await writeJson("v15-manual-delay.json", { schema: "v15-manual-delay-v2", ...common, delays });
  await writeJson("v15-cost-attribution.json", { schema: "v15-cost-attribution-v2", ...common, ...cost });
  await writeJson("v15-validation-summary.json", {
    schema: "v15-validation-summary-v2", baseline: BASELINE, branch: BRANCH, freezeCommit: currentHead(), freezeSha256, dataFreezeV2Sha256: dataFreezeSha256,
    dataGate: "PASS", historicalReturnsRead: true, result: classification, emailPromotionCandidate: allGates ? "PASS" : "FAIL", researchStop: "YES",
    primaryOos: base, years: Object.fromEntries(Object.entries(years).map(([year, metrics]) => [year, metricRecord(metrics)])),
    holdoutA, holdoutB, long: metricRecord(metricsAtStress(oosTrades.filter((trade) => trade.direction === 1), 0)), short: metricRecord(metricsAtStress(oosTrades.filter((trade) => trade.direction === -1), 0)),
    placebos: { status: "RUN", variants: placeboMetrics }, cost, manualDelay: delays, confidence: engine.confidence, emailUtility,
    gates: { primary: primaryGate, holdouts: holdoutGate, manualDelay: manualGate, emailUtility: emailGate },
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, autoTrading: false, migration: false, privateBinanceApi: false, orderPlacement: false },
  });
  await writeJson("v15-promotion-decision.json", { schema: "v15-promotion-decision-v2", ...common, emailPromotionCandidate: allGates ? "PASS" : "FAIL", researchStop: "YES", historicalReturnsRead: true, gates: { primary: primaryGate, holdouts: holdoutGate, manualDelay: manualGate, emailUtility: emailGate } });
  await writeText("v15-promotion-decision.md", ["# V15 Promotion Decision", "", "- Classification: **" + classification + "**", "- Data Gate: **PASS**", "- Email promotion candidate: **" + (allGates ? "PASS" : "FAIL") + "**", "- Primary gate: **" + (primaryGate ? "PASS" : "FAIL") + "**", "- Holdout gate: **" + (holdoutGate ? "PASS" : "FAIL") + "**", "- Manual delay gate: **" + (manualGate ? "PASS" : "FAIL") + "**", "- Email utility gate: **" + (emailGate ? "PASS" : "FAIL") + "**", "- Production changed: **NO**", ""].join("\n"));
  const files = ["v15-data-gate.json", "v15-archive-registry.json", "v15-stage-b-archive-manifest.json", "v15-cost-input-manifest.json", "v15-freeze-manifest.json", "v15-data-freeze-v2.json", "v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-validation-summary.json", "v15-promotion-decision.json", "v15-promotion-decision.md"];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(resolve(REPORT_DIR, file)));
  await writeJson("v15-evidence-manifest.json", { schema: "v15-evidence-manifest-v2", baseline: BASELINE, branch: BRANCH, freezeSha256, dataFreezeV2Sha256: dataFreezeSha256, resultCommit: currentHead(), historicalReturnsRead: true, artifacts: hashes });
  console.info(JSON.stringify({ phase: "result", classification, historicalReturnsRead: true, trades: oosTrades.length }));
}

async function writeText(name: string, value: string): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), value, "utf8");
}

async function main(): Promise<void> {
  const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "freeze";
  if (phase === "freeze") await runFreeze();
  else if (phase === "result") await runResult();
  else throw new Error("unknown V15 phase: " + phase);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
