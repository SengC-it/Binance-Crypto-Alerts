import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  archiveIndexPrefix,
  archiveUrl,
  buildArchiveAvailability,
  dedupeBars,
  listS3Objects,
  parseKlineArchive,
  readZipEntries,
  sha256Bytes,
  sha256Text,
  stableStringify,
  type ArchiveChecksumRecord,
  type LfvArchiveAvailability,
  type LfvArchiveTimeframe,
  type LfvBar,
  type PitUniverseSnapshot,
} from "@/lib/lfv/archive-data";
import {
  LFV_BASELINE_SHA,
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_LIVE_OBSERVATION_CUTOFF,
  LFV_SYSTEM_BOUNDARY,
} from "@/lib/lfv/loss-factors";

const REPORT_DIR = resolve("reports");
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const PIT_START = Date.UTC(2021, 6, 1);
const DAY = 86_400_000;
const TOP_SYMBOLS = 100;
const PIT_RECONSTRUCTION_TARGET = 0.98;
const FEATURE_COVERAGE_TARGET = 0.98;
const FUNDING_COVERAGE_TARGET = 0.99;
const ARCHIVE_TIMEFRAMES = ["1d", "15m", "1h", "4h", "funding", "markPriceKlines"] as const satisfies readonly LfvArchiveTimeframe[];
const FEATURE_TIMEFRAMES = ["15m", "1h", "4h", "funding", "markPriceKlines"] as const;
const TARGET_MONTHS = monthKeys(START, END);
const ARCHIVE_REGISTRY_NAME = "lfv-001-archive-registry.json";
const PIT_SNAPSHOT_NAME = "lfv-001-pit-universe.json";
const DATA_FREEZE_V2_NAME = "lfv-001-data-freeze-v2.json";
const DATA_GATE_NAME = "lfv-001-data-gate.json";
const RAW_ROOT_CANDIDATES = [
  process.env.LFV_DATA_ROOT,
  resolve("../../data/raw"),
  resolve("data/raw"),
].filter((value): value is string => Boolean(value));
const DATA_CACHE_DIR_NAME = "lfv-001-cache";
const S3_RESEARCH_ROOT = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const KLINE_ROOT_PREFIX = "data/futures/um/monthly/klines/";

configureNodeProxy();

interface ArchiveRegistry {
  schema: "bca-lfv-001-archive-registry-v2";
  status: "FROZEN_BEFORE_RETURN_READ";
  baseline: string;
  source: string;
  fetchedAt: string;
  period: { start: string; end: string; months: number };
  enumeration: {
    method: string;
    pagination: "COMPLETE" | "INCOMPLETE";
    rootPages: number;
    symbolIndexPages: number;
    liveS3Listing: true;
    currentExchangeInfoUsedForHistory: false;
    allArchiveSymbols: number;
    usdtSymbols: number;
  };
  historicalSymbols: string[];
  symbols: LfvArchiveAvailability[];
  rawListingSha256: string;
  methodology: string[];
}

interface DailyLoad {
  barsBySymbol: Map<string, LfvBar[]>;
  records: ArchiveChecksumRecord[];
  missingSymbols: string[];
  missingSlots: string[];
}

export interface DataGateV2 {
  schema: "bca-lfv-001-data-gate-v2";
  generatedAt: string;
  baseline: string;
  status: "PASS" | "FAIL";
  code: "LFV_DATA_INSUFFICIENT_FINAL" | null;
  pass: boolean;
  source: string;
  period: { start: string; end: string; months: number };
  archiveEnumeration: {
    status: "COMPLETE" | "INCOMPLETE";
    allArchiveSymbols: number;
    usdtSymbols: number;
    registrySha256: string;
  };
  pit: {
    totalScanTimestamps: number;
    validScanTimestamps: number;
    exactReconstructableRatio: number;
    medianUniverse: number;
    minimumUniverse: number;
    maximumUniverse: number;
    effectiveUniverseRule: string;
    futureLifecycleFilter: "NO";
    currentSurvivorOnlyFilter: "NO";
  };
  deepScan: {
    topMin100N: "PASS" | "FAIL";
    symbolMonthSlots: number;
    usedSymbols: number;
    usedMonths: number;
  };
  featureCoverage: Record<"15m" | "1h" | "4h" | "funding" | "markPriceKlines", {
    requiredSlots: number;
    availableSlots: number;
    coverage: number;
    target: number;
    checksumPassSlots: number;
    status: "PASS" | "FAIL";
  }>;
  checksum: {
    usedArchiveSlots: number;
    passSlots: number;
    passRatio: number;
    status: "PASS" | "FAIL";
    noSyntheticData: true;
    noForwardFill: true;
  };
  liveObservations: { count: 44; cutoff: string; treatment: "EXCLUDED_FROM_RETURNS" };
  reasons: string[];
  historicalReturnReplay: "NOT_RUN";
}

interface RawListingCache {
  schema: "bca-lfv-001-official-listing-v1";
  fetchedAt: string;
  root: { keys: string[]; prefixes: string[]; pages: number };
  symbols: Array<{ symbol: string; keys: Record<LfvArchiveTimeframe, string[]>; pages: number }>;
}

interface FreezeV2 {
  schema: "bca-lfv-001-data-freeze-v2";
  status: "FROZEN_BEFORE_RETURN_READ";
  originalFreezeCommit: string;
  originalFreezeSHA256: string;
  hypotheses: Record<string, unknown>;
  hypothesisHashes: Record<string, string>;
  combinedDefinition: readonly string[];
  combinedDefinitionHash: string;
  gateDefinition: Record<string, unknown>;
  gateDefinitionHash: string;
  dataPipelineDefinition: Record<string, unknown>;
  dataPipelineDefinitionHash: string;
  archiveRegistryHash: string;
  pitUniverseRule: Record<string, unknown>;
  pitUniverseRuleHash: string;
  returnsRead: false;
  freezeSha256: string;
}

function configureNodeProxy(): void {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

function monthKeys(start: number, end: number): string[] {
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const last = new Date(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1));
  const output: string[] = [];
  while (cursor <= last) {
    output.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function isUsdtPerpetualArchiveSymbol(symbol: string): boolean {
  return symbol.endsWith("USDT") && !symbol.endsWith("USDTSETTLED");
}

async function assertOriginalFreeze(): Promise<Record<string, unknown>> {
  const path = resolve(REPORT_DIR, "lfv-001-freeze-manifest.json");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const { freezeSha256, ...core } = value;
  if (typeof freezeSha256 !== "string" || freezeSha256 !== sha256Text(stableStringify(core))) throw new Error("original LFV freeze hash mismatch");
  if ((core.baseline as { sha?: string } | undefined)?.sha !== LFV_BASELINE_SHA) throw new Error("original LFV baseline mismatch");
  return value;
}

async function loadFreezeV2(): Promise<FreezeV2> {
  const value = JSON.parse(await readFile(resolve(REPORT_DIR, DATA_FREEZE_V2_NAME), "utf8")) as FreezeV2;
  const { freezeSha256, ...core } = value;
  if (typeof freezeSha256 !== "string" || freezeSha256 !== sha256Text(stableStringify(core))) throw new Error("LFV data freeze v2 hash mismatch");
  if (value.originalFreezeCommit !== "d68737cbd27c38e8fb09812ab225cfaaec56f037") throw new Error("LFV data freeze v2 original commit mismatch");
  if (value.returnsRead !== false) throw new Error("LFV data freeze v2 was created after returns were read");
  return value;
}

async function loadArchiveRegistry(): Promise<{ registry: ArchiveRegistry; registrySha256: string }> {
  const value = JSON.parse(await readFile(resolve(REPORT_DIR, ARCHIVE_REGISTRY_NAME), "utf8")) as ArchiveRegistry & { registrySha256?: string };
  const { registrySha256, ...registry } = value;
  if (registry.status !== "FROZEN_BEFORE_RETURN_READ" || registry.baseline !== LFV_BASELINE_SHA) throw new Error("LFV archive registry is not a valid frozen registry");
  const expected = sha256Text(stableStringify(registry));
  if (!registrySha256 || registrySha256 !== expected) throw new Error("LFV archive registry hash mismatch");
  return { registry, registrySha256 };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function chooseDataRoot(): Promise<string> {
  for (const candidate of RAW_ROOT_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }
  const fallback = resolve("data/raw");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.ok || response.status === 404) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function emptyTimeframeKeyMap(): Record<LfvArchiveTimeframe, string[]> {
  return Object.fromEntries(ARCHIVE_TIMEFRAMES.map((timeframe) => [timeframe, []])) as unknown as Record<LfvArchiveTimeframe, string[]>;
}

async function enumerateOfficialArchives(dataRoot: string): Promise<RawListingCache> {
  const cachePath = join(dataRoot, DATA_CACHE_DIR_NAME, "official-listing.json");
  if (await pathExists(cachePath) && process.env.LFV_FORCE_LIVE_LISTING !== "1") {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as RawListingCache;
    if (cached.schema === "bca-lfv-001-official-listing-v1" && cached.root?.pages > 0 && cached.symbols?.length > 0) return cached;
  }

  const root = await listS3Objects(KLINE_ROOT_PREFIX, {
    delimiter: "/",
    fetchImpl: fetchWithRetry,
    s3Root: S3_RESEARCH_ROOT,
  });
  const symbols = root.prefixes
    .map((prefix) => prefix.slice(KLINE_ROOT_PREFIX.length).replace(/\/$/, ""))
    .filter(isUsdtPerpetualArchiveSymbol)
    .sort();
  if (symbols.length === 0) throw new Error("official archive enumeration returned no USDⓈ-M USDT symbols");

  let completed = 0;
  const symbolListings = await mapLimit(symbols, 12, async (symbol) => {
    const keys = emptyTimeframeKeyMap();
    let pages = 0;
    const listed = await mapLimit(ARCHIVE_TIMEFRAMES, 6, async (timeframe) => {
      const listing = await listS3Objects(archiveIndexPrefix(timeframe, symbol), {
        fetchImpl: fetchWithRetry,
        s3Root: S3_RESEARCH_ROOT,
      });
      return { timeframe, keys: listing.keys, pages: listing.pages };
    });
    for (const item of listed) {
      keys[item.timeframe] = item.keys;
      pages += item.pages;
    }
    completed += 1;
    if (completed % 50 === 0 || completed === symbols.length) console.info(JSON.stringify({ stage: "official_archive_enumeration", completed, total: symbols.length }));
    return { symbol, keys, pages };
  });

  const result: RawListingCache = {
    schema: "bca-lfv-001-official-listing-v1",
    fetchedAt: new Date().toISOString(),
    root: { keys: root.keys, prefixes: root.prefixes, pages: root.pages },
    symbols: symbolListings,
  };
  await mkdir(join(dataRoot, DATA_CACHE_DIR_NAME), { recursive: true });
  await writeFile(cachePath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

function buildArchiveRegistry(listing: RawListingCache): ArchiveRegistry {
  const symbols = listing.symbols.map((item) => buildArchiveAvailability(item.symbol, item.keys));
  const historicalSymbols = symbols.map((item) => item.symbol).sort();
  const registryBody = {
    schema: "bca-lfv-001-archive-registry-v2",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: LFV_BASELINE_SHA,
    source: "Binance Data Vision official public USDⓈ-M futures archive via S3 ListObjectsV2",
    fetchedAt: listing.fetchedAt,
    period: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), months: TARGET_MONTHS.length },
    enumeration: {
      method: "Live official S3 ListObjectsV2 root prefixes plus per-symbol timeframe listings",
      pagination: "COMPLETE",
      rootPages: listing.root.pages,
      symbolIndexPages: listing.symbols.reduce((sum, item) => sum + item.pages, 0),
      liveS3Listing: true,
      currentExchangeInfoUsedForHistory: false,
      allArchiveSymbols: listing.root.prefixes.length,
      usdtSymbols: historicalSymbols.length,
    },
    historicalSymbols,
    symbols,
    rawListingSha256: sha256Text(stableStringify(listing)),
    methodology: [
      "The official archive root is enumerated with complete ListObjectsV2 pagination; no current exchangeInfo or current survivor list is used.",
      "Only historical USDⓈ-M perpetual archive prefixes ending in USDT are retained; USDTSETTLED and non-USDT prefixes are excluded.",
      "firstObserved and lastObserved are derived from official 1d archive months; daily bars are the PIT liquidity/lifecycle evidence.",
      "Archive availability is recorded for 1d, 15m, 1h, 4h, fundingRate, and 1m markPriceKlines without forward filling or synthetic bars.",
      "Checksum status is evaluated for every archive actually used by the deep scan; discovery-only symbols are not claimed as content-verified.",
    ],
  } satisfies ArchiveRegistry;
  return registryBody;
}

function archiveRegistryHash(registry: ArchiveRegistry): string {
  return sha256Text(stableStringify(registry));
}

function monthFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function findLocalArchive(dataRoot: string, symbol: string, timeframe: LfvArchiveTimeframe, period: string): Promise<string | null> {
  const filename = `${period}.zip`;
  const candidates = [
    join(dataRoot, DATA_CACHE_DIR_NAME, "um", timeframe, symbol, filename),
    join(dataRoot, "v14-cross-sectional-cache", "um", timeframe, symbol, filename),
    join(dataRoot, "v7-derivatives-flow-cache", "market", symbol, timeframe, filename),
    join(dataRoot, "v5-7-external-cache", "archives", symbol, timeframe, filename),
    join(dataRoot, "v5-8-fresh-cache", "archives", symbol, timeframe, filename),
    join(dataRoot, "v5-9-1-untouched-cache", "archives", symbol, timeframe, filename),
    join(dataRoot, "v5-9-untouched-cache", "archives", symbol, timeframe, filename),
    join(dataRoot, "v10-execution-cache", symbol, timeframe, filename),
  ];
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return null;
}

type ChecksumEvidence = Map<string, string>;

async function loadPriorChecksumEvidence(): Promise<ChecksumEvidence> {
  const evidence = new Map<string, string>();
  const candidates = [
    resolve("../../reports/v14-data-gate.json"),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    try {
      const value = JSON.parse(await readFile(candidate, "utf8")) as { archiveRecords?: Array<{ sourceUrl?: string; sha256?: string; status?: string; checksumStatus?: string }> };
      for (const record of value.archiveRecords ?? []) {
        if (record.sourceUrl && record.sha256 && record.status === "AVAILABLE" && record.checksumStatus === "PASS") evidence.set(record.sourceUrl, record.sha256.toLowerCase());
      }
      if (evidence.size > 0) return evidence;
    } catch {
      // A prior report is optional; the official .CHECKSUM endpoint remains authoritative.
    }
  }
  return evidence;
}

const checksumCache = new Map<string, string>();
const checksumRequests = new Map<string, Promise<string | null>>();

async function expectedChecksum(sourceUrl: string, priorEvidence: ChecksumEvidence): Promise<string | null> {
  const prior = priorEvidence.get(sourceUrl);
  if (prior) return prior;
  const cached = checksumCache.get(sourceUrl);
  if (cached) return cached;
  const running = checksumRequests.get(sourceUrl);
  if (running) return running;
  const request = (async () => {
    try {
      const response = await fetchWithRetry(`${sourceUrl}.CHECKSUM`);
      if (!response.ok) return null;
      const value = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(value ?? "")) return null;
      checksumCache.set(sourceUrl, value);
      return value;
    } catch {
      return null;
    }
  })();
  checksumRequests.set(sourceUrl, request);
  return request;
}

async function loadChecksumCache(dataRoot: string): Promise<void> {
  const path = join(dataRoot, DATA_CACHE_DIR_NAME, "checksums.json");
  if (!(await pathExists(path))) return;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    for (const [url, checksum] of Object.entries(value)) if (/^[a-f0-9]{64}$/i.test(checksum)) checksumCache.set(url, checksum.toLowerCase());
  } catch {
    // A corrupt cache is ignored and rebuilt from official CHECKSUM objects.
  }
}

async function saveChecksumCache(dataRoot: string): Promise<void> {
  if (checksumCache.size === 0) return;
  const path = join(dataRoot, DATA_CACHE_DIR_NAME, "checksums.json");
  await mkdir(join(dataRoot, DATA_CACHE_DIR_NAME), { recursive: true });
  await writeFile(path, JSON.stringify(Object.fromEntries([...checksumCache.entries()].sort(([left], [right]) => left.localeCompare(right))), null, 2) + "\n", "utf8");
}

function localArchiveRelativePath(dataRoot: string, path: string): string {
  return relative(dataRoot, path).replaceAll("\\", "/");
}

async function ensureArchiveFile(
  dataRoot: string,
  symbol: string,
  timeframe: LfvArchiveTimeframe,
  period: string,
  priorEvidence: ChecksumEvidence,
  allowDownload: boolean,
): Promise<{ record: ArchiveChecksumRecord; bytes: Buffer | null }> {
  const sourceUrl = archiveUrl(symbol, timeframe, period);
  let path = await findLocalArchive(dataRoot, symbol, timeframe, period);
  let bytes: Buffer | null = null;
  if (path) {
    try {
      bytes = await readFile(path);
    } catch {
      path = null;
    }
  }

  if (!bytes && allowDownload) {
    const response = await fetchWithRetry(sourceUrl);
    if (response.status === 404) {
      return { record: { symbol, timeframe, period, sourceUrl, cachePath: null, status: "MISSING", bytes: 0, rowCount: 0, sha256: null, expectedSha256: null, checksumStatus: "NOT_CHECKED", error: "OFFICIAL_ARCHIVE_404" }, bytes: null };
    }
    if (!response.ok) {
      return { record: { symbol, timeframe, period, sourceUrl, cachePath: null, status: "FAILED", bytes: 0, rowCount: 0, sha256: null, expectedSha256: null, checksumStatus: "FAIL", error: `HTTP_${response.status}` }, bytes: null };
    }
    bytes = Buffer.from(await response.arrayBuffer());
    const target = join(dataRoot, DATA_CACHE_DIR_NAME, "um", timeframe, symbol, `${period}.zip`);
    await mkdir(join(dataRoot, DATA_CACHE_DIR_NAME, "um", timeframe, symbol), { recursive: true });
    if (await pathExists(target)) {
      const existing = await readFile(target);
      if (sha256Bytes(existing) !== sha256Bytes(bytes)) throw new Error(`immutable cache collision at ${target}`);
    } else {
      await writeFile(target, bytes);
    }
    path = target;
  }

  if (!bytes) {
    return { record: { symbol, timeframe, period, sourceUrl, cachePath: null, status: "MISSING", bytes: 0, rowCount: 0, sha256: null, expectedSha256: null, checksumStatus: "NOT_CHECKED", error: allowDownload ? "LOCAL_AND_OFFICIAL_ARCHIVE_UNAVAILABLE" : "LOCAL_CACHE_NOT_PRESENT" }, bytes: null };
  }

  const actualSha256 = sha256Bytes(bytes);
  const expectedSha256 = await expectedChecksum(sourceUrl, priorEvidence);
  let rowCount = 0;
  try {
    if (timeframe === "funding") rowCount = countArchiveRows(bytes);
    else rowCount = parseKlineArchive(bytes).length;
  } catch (error) {
    return { record: { symbol, timeframe, period, sourceUrl, cachePath: path ? localArchiveRelativePath(dataRoot, path) : null, status: "FAILED", bytes: bytes.byteLength, rowCount: 0, sha256: actualSha256, expectedSha256, checksumStatus: "FAIL", error: error instanceof Error ? error.message : String(error) }, bytes: null };
  }
  const checksumStatus = expectedSha256 && actualSha256 === expectedSha256 ? "PASS" : "FAIL";
  return {
    record: {
      symbol,
      timeframe,
      period,
      sourceUrl,
      cachePath: path ? localArchiveRelativePath(dataRoot, path) : null,
      status: "AVAILABLE",
      bytes: bytes.byteLength,
      rowCount,
      sha256: actualSha256,
      expectedSha256,
      checksumStatus,
      ...(checksumStatus === "FAIL" ? { error: expectedSha256 ? "SHA256_MISMATCH" : "CHECKSUM_NOT_AVAILABLE" } : {}),
    },
    bytes,
  };
}

async function loadDailyBars(registry: ArchiveRegistry, dataRoot: string, priorEvidence: ChecksumEvidence, allowDownload: boolean): Promise<DailyLoad> {
  const barsBySymbol = new Map<string, LfvBar[]>();
  const records: ArchiveChecksumRecord[] = [];
  const missingSymbols: string[] = [];
  const missingSlots: string[] = [];
  let completed = 0;
  for (const symbolRecord of registry.symbols) {
    const symbolBars: LfvBar[] = [];
    const targetMonths = symbolRecord.available1dMonths.filter((period) => TARGET_MONTHS.includes(period));
    for (const period of targetMonths) {
      const result = await ensureArchiveFile(dataRoot, symbolRecord.symbol, "1d", period, priorEvidence, allowDownload);
      records.push(result.record);
      if (result.record.status !== "AVAILABLE" || result.record.checksumStatus !== "PASS") {
        missingSlots.push(`${symbolRecord.symbol}|1d|${period}`);
        continue;
      }
      try {
        symbolBars.push(...parseKlineArchive(result.bytes!));
      } catch {
        missingSlots.push(`${symbolRecord.symbol}|1d|${period}`);
      }
    }
    const ordered = dedupeBars(symbolBars.filter((bar) => bar.openTime >= START && bar.openTime <= END));
    barsBySymbol.set(symbolRecord.symbol, ordered);
    if (targetMonths.length > 0 && ordered.length === 0) missingSymbols.push(symbolRecord.symbol);
    completed += 1;
    if (completed % 100 === 0 || completed === registry.symbols.length) console.info(JSON.stringify({ stage: "pit_daily_load", completed, total: registry.symbols.length }));
  }
  return { barsBySymbol, records, missingSymbols, missingSlots };
}

function lowerBoundByOpenTime(bars: LfvBar[], timestamp: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].openTime < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildPitSnapshots(barsBySymbol: Map<string, LfvBar[]>): { snapshots: PitUniverseSnapshot[]; noFutureLifecycle: boolean } {
  const state = new Map<string, { bars: LfvBar[]; index: number }>();
  for (const [symbol, bars] of barsBySymbol) state.set(symbol, { bars, index: -1 });
  const snapshots: PitUniverseSnapshot[] = [];
  let noFutureLifecycle = true;
  for (let timestamp = PIT_START; timestamp <= END; timestamp += DAY) {
    const eligible: Array<{ symbol: string; latestBarTime: number; quoteVolume24h: number }> = [];
    for (const [symbol, item] of state) {
      while (item.index + 1 < item.bars.length && item.bars[item.index + 1].closeTime <= timestamp) item.index += 1;
      const latest = item.index >= 0 ? item.bars[item.index] : null;
      if (!latest || latest.closeTime > timestamp || latest.quoteVolume <= 0) continue;
      const first = item.bars[0];
      if (!first || latest.openTime - first.openTime < 90 * DAY) continue;
      const recentStart = lowerBoundByOpenTime(item.bars, latest.openTime - 30 * DAY + 1);
      const recent = item.bars.slice(recentStart, item.index + 1);
      if (recent.length < 28 || recent.some((bar) => bar.quoteVolume <= 0)) continue;
      eligible.push({ symbol, latestBarTime: latest.openTime, quoteVolume24h: latest.quoteVolume });
    }
    eligible.sort((left, right) => right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol));
    const deepScan = eligible.slice(0, Math.min(TOP_SYMBOLS, eligible.length)).map((item) => item.symbol);
    if (eligible.some((item) => item.latestBarTime > timestamp)) noFutureLifecycle = false;
    snapshots.push({ timestamp, eligible, deepScan, effectiveUniverseSize: deepScan.length });
  }
  return { snapshots, noFutureLifecycle };
}

interface SymbolMonthSlot { symbol: string; period: string; }

function buildDeepScanSlots(snapshots: PitUniverseSnapshot[]): SymbolMonthSlot[] {
  const slots = new Map<string, SymbolMonthSlot>();
  for (const snapshot of snapshots) {
    for (const symbol of snapshot.deepScan) {
      const period = monthFromTimestamp(snapshot.timestamp);
      slots.set(`${symbol}|${period}`, { symbol, period });
    }
  }
  return [...slots.values()].sort((left, right) => left.symbol.localeCompare(right.symbol) || left.period.localeCompare(right.period));
}

function availabilityFor(registry: ArchiveRegistry, symbol: string): LfvArchiveAvailability | undefined {
  return registry.symbols.find((record) => record.symbol === symbol);
}

function listedFor(record: LfvArchiveAvailability | undefined, timeframe: LfvArchiveTimeframe, period: string): boolean {
  if (!record) return false;
  const field: Record<LfvArchiveTimeframe, keyof LfvArchiveAvailability> = {
    "1d": "available1dMonths",
    "15m": "available15mMonths",
    "1h": "available1hMonths",
    "4h": "available4hMonths",
    funding: "fundingMonths",
    markPriceKlines: "markPriceKlineMonths",
  };
  return (record[field[timeframe]] as string[]).includes(period);
}

async function loadUsedFeatureArchives(
  registry: ArchiveRegistry,
  dataRoot: string,
  slots: SymbolMonthSlot[],
  priorEvidence: ChecksumEvidence,
  allowDownload: boolean,
): Promise<ArchiveChecksumRecord[]> {
  const work = slots.flatMap((slot) => FEATURE_TIMEFRAMES.map((timeframe) => ({ ...slot, timeframe })));
  let completed = 0;
  const records = await mapLimit(work, 18, async (item) => {
    const availability = availabilityFor(registry, item.symbol);
    if (!listedFor(availability, item.timeframe, item.period)) {
      return { symbol: item.symbol, timeframe: item.timeframe, period: item.period, sourceUrl: archiveUrl(item.symbol, item.timeframe, item.period), cachePath: null, status: "MISSING", bytes: 0, rowCount: 0, sha256: null, expectedSha256: null, checksumStatus: "NOT_CHECKED", error: "NOT_LISTED_IN_OFFICIAL_ARCHIVE_INDEX" } satisfies ArchiveChecksumRecord;
    }
    const result = await ensureArchiveFile(dataRoot, item.symbol, item.timeframe, item.period, priorEvidence, allowDownload);
    completed += 1;
    if (completed % 100 === 0 || completed === work.length) console.info(JSON.stringify({ stage: "deep_scan_archive_validation", completed, total: work.length }));
    return result.record;
  });
  await saveChecksumCache(dataRoot);
  return records.sort((left, right) => `${left.symbol}|${left.timeframe}|${left.period}`.localeCompare(`${right.symbol}|${right.timeframe}|${right.period}`));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function buildFeatureCoverage(records: ArchiveChecksumRecord[], slots: SymbolMonthSlot[]): DataGateV2["featureCoverage"] {
  return Object.fromEntries(FEATURE_TIMEFRAMES.map((timeframe) => {
    const timeframeRecords = records.filter((record) => record.timeframe === timeframe);
    const requiredSlots = slots.length;
    const availableSlots = timeframeRecords.filter((record) => record.status === "AVAILABLE" && record.rowCount > 0).length;
    const checksumPassSlots = timeframeRecords.filter((record) => record.status === "AVAILABLE" && record.checksumStatus === "PASS" && record.rowCount > 0).length;
    const target = timeframe === "funding" || timeframe === "markPriceKlines" ? FUNDING_COVERAGE_TARGET : FEATURE_COVERAGE_TARGET;
    const coverage = requiredSlots === 0 ? 0 : availableSlots / requiredSlots;
    return [timeframe, { requiredSlots, availableSlots, coverage, target, checksumPassSlots, status: coverage >= target && checksumPassSlots === availableSlots ? "PASS" : "FAIL" }];
  })) as DataGateV2["featureCoverage"];
}

function buildDataGateV2(
  registry: ArchiveRegistry,
  registryHash: string,
  daily: DailyLoad,
  snapshots: PitUniverseSnapshot[],
  noFutureLifecycle: boolean,
  featureRecords: ArchiveChecksumRecord[],
): DataGateV2 {
  const slots = buildDeepScanSlots(snapshots);
  const validSnapshots = daily.missingSlots.length === 0 && noFutureLifecycle ? snapshots : [];
  const universeSizes = snapshots.map((snapshot) => snapshot.effectiveUniverseSize);
  const validRatio = snapshots.length === 0 ? 0 : validSnapshots.length / snapshots.length;
  const featureCoverage = buildFeatureCoverage(featureRecords, slots);
  const usedArchiveSlots = featureRecords.length + daily.records.length;
  const passSlots = [...daily.records, ...featureRecords].filter((record) => record.status === "AVAILABLE" && record.checksumStatus === "PASS").length;
  const checksumPassRatio = usedArchiveSlots === 0 ? 0 : passSlots / usedArchiveSlots;
  const reasons: string[] = [];
  if (registry.enumeration.pagination !== "COMPLETE") reasons.push("official_archive_enumeration_incomplete");
  if (validRatio < PIT_RECONSTRUCTION_TARGET) reasons.push(`historical PIT top min(100,N) reconstructable ratio ${(validRatio * 100).toFixed(2)}% is below ${(PIT_RECONSTRUCTION_TARGET * 100).toFixed(2)}%`);
  if (daily.missingSlots.length > 0) reasons.push(`${daily.missingSlots.length} required 1d lifecycle/liquidity archive slots are unavailable or checksum-invalid`);
  if (!noFutureLifecycle) reasons.push("future lifecycle data entered at least one PIT universe timestamp");
  for (const timeframe of FEATURE_TIMEFRAMES) {
    const coverage = featureCoverage[timeframe];
    if (coverage.status !== "PASS") reasons.push(`${timeframe} coverage ${(coverage.coverage * 100).toFixed(2)}% is below ${(coverage.target * 100).toFixed(2)}% or has unverified content`);
  }
  if (checksumPassRatio < 1) reasons.push(`used archive checksum pass ratio ${(checksumPassRatio * 100).toFixed(2)}% is below 100%`);
  const archiveEnumeration = registry.enumeration;
  return {
    schema: "bca-lfv-001-data-gate-v2",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    code: reasons.length === 0 ? null : "LFV_DATA_INSUFFICIENT_FINAL",
    pass: reasons.length === 0,
    source: registry.source,
    period: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), months: TARGET_MONTHS.length },
    archiveEnumeration: { status: archiveEnumeration.pagination, allArchiveSymbols: archiveEnumeration.allArchiveSymbols, usdtSymbols: archiveEnumeration.usdtSymbols, registrySha256: registryHash },
    pit: {
      totalScanTimestamps: snapshots.length,
      validScanTimestamps: validSnapshots.length,
      exactReconstructableRatio: validRatio,
      medianUniverse: median(universeSizes),
      minimumUniverse: universeSizes.length ? Math.min(...universeSizes) : 0,
      maximumUniverse: universeSizes.length ? Math.max(...universeSizes) : 0,
      effectiveUniverseRule: "At each UTC daily scan timestamp T, eligible symbols are then-observed USDⓈ-M perpetuals with >=90d age, >=28 of the prior 30 daily bars, and positive quoteVolume24h; select top min(100,N) by the latest closed bar's quoteVolume24h with symbol tie-break.",
      futureLifecycleFilter: "NO",
      currentSurvivorOnlyFilter: "NO",
    },
    deepScan: { topMin100N: validRatio >= PIT_RECONSTRUCTION_TARGET ? "PASS" : "FAIL", symbolMonthSlots: slots.length, usedSymbols: new Set(slots.map((slot) => slot.symbol)).size, usedMonths: new Set(slots.map((slot) => slot.period)).size },
    featureCoverage,
    checksum: { usedArchiveSlots, passSlots, passRatio: checksumPassRatio, status: checksumPassRatio === 1 ? "PASS" : "FAIL", noSyntheticData: true, noForwardFill: true },
    liveObservations: { count: 44, cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(), treatment: "EXCLUDED_FROM_RETURNS" },
    reasons,
    historicalReturnReplay: "NOT_RUN",
  };
}

function freezeV2Core(original: Record<string, unknown>, registry: ArchiveRegistry, registrySha256: string): Omit<FreezeV2, "freezeSha256"> {
  const originalHypotheses = (original.hypotheses ?? {}) as Record<string, unknown>;
  const originalGates = (original.gates ?? {}) as Record<string, unknown>;
  const hypotheses = {
    H1: originalHypotheses.H1,
    H2: originalHypotheses.H2,
    H3: originalHypotheses.H3,
    H4: originalHypotheses.H4,
    combined: LFV_COMBINED_PRIMARY,
  };
  const dataPipelineDefinition = {
    source: "Binance Data Vision official public USDⓈ-M perpetual S3 archives",
    stages: [
      "Stage A: complete paginated symbol/timeframe archive-index enumeration and immutable archive registry",
      "Stage B: only PIT top min(100,N) symbol-month slots are loaded for 15m, 1h, 4h, fundingRate, and 1m markPriceKlines",
    ],
    targetRange: { start: new Date(START).toISOString(), end: new Date(END).toISOString() },
    noApproximation: true,
    noForwardFill: true,
    noSyntheticOhlc: true,
    checksum: "Every used ZIP must match its official .CHECKSUM object; existing bytes are rehashed before use.",
    rawDataCommitPolicy: "Raw history remains outside Git; only registry, hashes, and summarized evidence are committed.",
  };
  const pitUniverseRule = {
    source: "Historical 1d archive bars only",
    eligible: [
      "latest closed daily bar at or before T",
      "minimum age 90 days from first observed bar",
      "at least 28 non-zero-quote-volume bars in the previous 30 days",
    ],
    ranking: "latest closed bar quoteVolume24h descending; symbol ascending tie-break",
    selection: "top min(100, eligible symbol count)",
    futureLifecycleFilter: false,
    currentSurvivorFilter: false,
    timestampFrequency: "daily UTC boundary from 2021-07-01 through 2026-07-31",
  };
  const gateDefinition = {
    ...originalGates,
    officialEnumeration: "COMPLETE",
    pitReconstructableRatio: `>=${PIT_RECONSTRUCTION_TARGET}`,
    featureCoverage: `15m/1h/4h>=${FEATURE_COVERAGE_TARGET}`,
    fundingCoverage: `fundingRate/markPriceKlines>=${FUNDING_COVERAGE_TARGET}`,
    earlyBreadth: "top min(100,N) is valid when N<100; no fixed 100-symbol monthly minimum",
    liveAugust: "EXCLUDED_FROM_RETURNS",
  };
  return {
    schema: "bca-lfv-001-data-freeze-v2",
    status: "FROZEN_BEFORE_RETURN_READ",
    originalFreezeCommit: "d68737cbd27c38e8fb09812ab225cfaaec56f037",
    originalFreezeSHA256: String(original.freezeSha256),
    hypotheses,
    hypothesisHashes: Object.fromEntries(Object.entries(hypotheses).filter(([key]) => key !== "combined").map(([key, value]) => [key, sha256Text(stableStringify(value))])),
    combinedDefinition: LFV_COMBINED_PRIMARY,
    combinedDefinitionHash: sha256Text(stableStringify(LFV_COMBINED_PRIMARY)),
    gateDefinition,
    gateDefinitionHash: sha256Text(stableStringify(gateDefinition)),
    dataPipelineDefinition,
    dataPipelineDefinitionHash: sha256Text(stableStringify(dataPipelineDefinition)),
    archiveRegistryHash: registrySha256,
    pitUniverseRule,
    pitUniverseRuleHash: sha256Text(stableStringify(pitUniverseRule)),
    returnsRead: false,
  };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function createLfvDataFreezeV2(): Promise<{ registry: ArchiveRegistry; registrySha256: string; freeze: FreezeV2 }> {
  const original = await assertOriginalFreeze();
  const dataRoot = await chooseDataRoot();
  const listing = await enumerateOfficialArchives(dataRoot);
  const registry = buildArchiveRegistry(listing);
  const registrySha256 = archiveRegistryHash(registry);
  await writeJson(ARCHIVE_REGISTRY_NAME, { ...registry, registrySha256 });
  const core = freezeV2Core(original, registry, registrySha256);
  const freeze = { ...core, freezeSha256: sha256Text(stableStringify(core)) } satisfies FreezeV2;
  await writeJson(DATA_FREEZE_V2_NAME, freeze);
  console.info(JSON.stringify({ stage: "data-freeze-v2", registrySha256, freezeSha256: freeze.freezeSha256, symbols: registry.historicalSymbols.length }, null, 2));
  return { registry, registrySha256, freeze };
}

export async function runLfvDataGateV2(): Promise<{ freeze: FreezeV2; registry: ArchiveRegistry; registrySha256: string; gate: DataGateV2; pit: { snapshots: PitUniverseSnapshot[]; slots: SymbolMonthSlot[] }; archives: ArchiveChecksumRecord[] }> {
  const freeze = await loadFreezeV2();
  const { registry, registrySha256 } = await loadArchiveRegistry();
  if (freeze.archiveRegistryHash !== registrySha256) throw new Error("LFV data freeze v2 archive registry hash mismatch");
  const dataRoot = await chooseDataRoot();
  const allowDownload = process.env.CI !== "true" && process.env.LFV_ALLOW_DOWNLOAD !== "0";
  await loadChecksumCache(dataRoot);
  const priorEvidence = await loadPriorChecksumEvidence();
  const daily = await loadDailyBars(registry, dataRoot, priorEvidence, allowDownload);
  const pitBuild = buildPitSnapshots(daily.barsBySymbol);
  const slots = buildDeepScanSlots(pitBuild.snapshots);
  const archives = await loadUsedFeatureArchives(registry, dataRoot, slots, priorEvidence, allowDownload);
  const gate = buildDataGateV2(registry, registrySha256, daily, pitBuild.snapshots, pitBuild.noFutureLifecycle, archives);
  await writeJson(PIT_SNAPSHOT_NAME, {
    schema: "bca-lfv-001-pit-universe-v2",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: LFV_BASELINE_SHA,
    registrySha256,
    ruleHash: freeze.pitUniverseRuleHash,
    scanTimestamps: pitBuild.snapshots.map((snapshot) => ({ timestamp: new Date(snapshot.timestamp).toISOString(), effectiveUniverseSize: snapshot.effectiveUniverseSize, deepScan: snapshot.deepScan })),
    symbolMonthSlots: slots,
    dailyMissingSlots: daily.missingSlots,
    dailyMissingSymbols: daily.missingSymbols,
    noFutureLifecycle: pitBuild.noFutureLifecycle,
  });
  await writeJson(DATA_GATE_NAME, {
    ...gate,
    archiveEvidence: {
      dailyRecords: { total: daily.records.length, available: daily.records.filter((record) => record.status === "AVAILABLE").length, checksumPass: daily.records.filter((record) => record.status === "AVAILABLE" && record.checksumStatus === "PASS").length },
      featureRecords: { total: archives.length, available: archives.filter((record) => record.status === "AVAILABLE").length, checksumPass: archives.filter((record) => record.status === "AVAILABLE" && record.checksumStatus === "PASS").length },
      failures: [...daily.records, ...archives].filter((record) => record.status !== "AVAILABLE" || record.checksumStatus !== "PASS").slice(0, 100),
    },
  });
  return { freeze, registry, registrySha256, gate, pit: { snapshots: pitBuild.snapshots, slots }, archives: [...daily.records, ...archives] };
}

function countArchiveRows(buffer: Buffer): number {
  const entry = parseArchiveDataLines(buffer);
  return entry.filter((line) => line.trim() && !line.toLowerCase().startsWith("calc_time") && !line.toLowerCase().startsWith("funding_time")).length;
}

function parseArchiveDataLines(buffer: Buffer): string[] {
  const signature = Buffer.from("PK").toString();
  if (buffer.subarray(0, 2).toString() !== signature) throw new Error("archive is not a ZIP");
  // Funding archives are small CSV ZIPs; use the shared ZIP decoder without
  // interpreting funding fields as prices.
  const entry = requireZipEntry(buffer);
  return entry.data.toString("utf8").split(/\r?\n/);
}

function requireZipEntry(buffer: Buffer): { data: Buffer } {
  return readZipEntries(buffer).find((item) => !item.name.endsWith("/")) ?? (() => { throw new Error("ZIP archive contained no data file"); })();
}
