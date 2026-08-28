import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readZipEntries } from "@/lib/v5-7/external-data";

/**
 * V14 is intentionally a research-only validator.  It never imports runtime
 * signal, SMTP, or private Binance code.  The only return input is immutable
 * public archive data and every execution lookup is an actual next 15m open.
 */

const BASELINE = "1f6b5e24c6e9cb5672e4c6591b303dd4e5d01487";
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FIFTEEN_MINUTES = 15 * 60_000;
const CAPITAL = 10_000;
const REPORT_ROOT = resolve("reports");
const CACHE_ROOT = resolve("data/raw/v14-cross-sectional-cache");
const DATA_VISION_ROOT = "https://data.binance.vision/data/futures/um/monthly";
const SPOT_ROOT = "https://data.binance.vision/data/spot/monthly";
const S3_ROOT = "https://s3.ap-northeast-1.amazonaws.com/data.binance.vision/";
const S3_KLINE_PREFIX = "data/futures/um/monthly/klines/";
const DELAY_MINUTES = [15, 30, 120, 360, 1_440] as const;
const STRESS_BPS = [0, 5, 10, 20] as const;
const HISTORICAL_ONLY_CUTOFF = Date.UTC(2026, 6, 1);

let SYMBOLS: string[] = [];
const SPOT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "LINKUSDT", "DOGEUSDT"] as const;

type Family = "FAMILY_A_PURE_REVERSAL" | "FAMILY_B_HIGH_VOL_REVERSAL" | "FAMILY_C_DISPERSION_REVERSAL";
type Timeframe = "1d" | "15m" | "funding";

interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closeTime: number;
}

interface FundingPoint { fundingTime: number; fundingRate: number; }

interface ArchiveRecord {
  symbol: string;
  timeframe: Timeframe;
  period: string;
  sourceUrl: string;
  cachePath: string | null;
  status: "AVAILABLE" | "MISSING" | "FAILED";
  httpStatus: number | null;
  rowCount: number;
  bytes: number;
  sha256: string | null;
  expectedSha256: string | null;
  checksumStatus: "PASS" | "FAIL" | "NOT_CHECKED";
  listed: boolean;
  error?: string;
}

interface StoredArchive { record: ArchiveRecord; path: string | null; }

interface ArchiveAvailability {
  symbol: string;
  periods: string[];
  firstPeriod: string | null;
  lastPeriod: string | null;
  listedObjects: number;
}

interface RootInventory {
  source: string;
  listingUrl: string;
  fetchedAt: string;
  allArchiveSymbols: string[];
  usdtSymbols: string[];
  analysisSymbols: string[];
  availability: ArchiveAvailability[];
  rawSha256: string;
  complete: boolean;
}

interface SymbolDailyStats {
  symbol: string;
  firstObserved: string | null;
  lastObserved: string | null;
  observedMonths: string[];
  archiveObjects: number;
  bars: number;
  coverage: number;
  internalGapDays: number;
  badOhlc: number;
  zeroVolume: number;
  checksumStatus: "PASS" | "FAIL";
  historicalOnly: boolean;
  reliable: boolean;
}

interface PitPoint {
  symbol: string;
  formationReturn: number;
  volatility: number;
  quoteVolume30d: number;
  latestBar: number;
}

interface PitWeek {
  timestamp: number;
  eligible: PitPoint[];
  dispersion: number;
  btcReturn8w: number | null;
  btcVol30d: number | null;
}

interface Config {
  id: string;
  family: Family;
  formationWeeks: 6 | 8 | 10 | 12;
  breadth: "QUINTILE" | "DECILE";
  legs: 2 | 3;
  holdingWeeks: 2 | 4 | 8;
  volState?: "HIGH";
  dispersionState?: "HIGH";
}

interface Decision {
  id: string;
  family: Family;
  configId: string;
  timestamp: number;
  holdingWeeks: number;
  longs: string[];
  shorts: string[];
  regime: string;
}

interface ExecutedLeg {
  symbol: string;
  direction: 1 | -1;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  grossR: number;
  fundingR: number;
  netRByStress: Record<string, number>;
}

interface SignalTrade {
  id: string;
  family: Family;
  configId: string;
  timestamp: number;
  entryTime: number;
  exitTime: number;
  regime: string;
  legs: ExecutedLeg[];
  netRByStress: Record<string, number>;
  longR: number;
  shortR: number;
}

interface Metrics {
  signals: number;
  wins: number;
  losses: number;
  netR: number;
  netPnl: number;
  annualized: number;
  profitFactor: number;
  average: number;
  median: number;
  worst: number;
  maxDD: number;
  positiveFoldRatio: number;
  medianFoldNetR: number;
  stress: Record<string, { netR: number; netPnl: number; maxDD: number }>;
}

interface ConfigRun { config: Config; decisions: Decision[]; trades: SignalTrade[]; metrics: Metrics; }

interface FamilyResult {
  family: Family;
  status: "PASS" | "FAIL";
  bestConfigId: string | null;
  nested: Metrics;
  holdoutA: Metrics;
  holdoutB: Metrics;
  gate: Record<string, boolean>;
  reasons: string[];
  configRuns: ConfigRun[];
  selectedTrades: SignalTrade[];
  latency: Record<string, Metrics>;
  diversification: Record<string, unknown>;
  stability: Record<string, unknown>;
  placebo: Record<string, unknown>;
  robustness: Record<string, unknown>;
  capital: Record<string, unknown>;
  portfolio: Metrics;
  emailSimulation: Record<string, unknown>;
  longContribution: number;
  shortContribution: number;
  portfolioBeta: number | null;
}

const CONFIGURATIONS: readonly Config[] = [
  { id: "A1-8W-Q-2L-2W", family: "FAMILY_A_PURE_REVERSAL", formationWeeks: 8, breadth: "QUINTILE", legs: 2, holdingWeeks: 2 },
  { id: "A2-8W-D-3L-4W", family: "FAMILY_A_PURE_REVERSAL", formationWeeks: 8, breadth: "DECILE", legs: 3, holdingWeeks: 4 },
  { id: "A3-10W-Q-2L-4W", family: "FAMILY_A_PURE_REVERSAL", formationWeeks: 10, breadth: "QUINTILE", legs: 2, holdingWeeks: 4 },
  { id: "A4-10W-D-3L-8W", family: "FAMILY_A_PURE_REVERSAL", formationWeeks: 10, breadth: "DECILE", legs: 3, holdingWeeks: 8 },
  { id: "B1-8W-HV-Q-2L-2W", family: "FAMILY_B_HIGH_VOL_REVERSAL", formationWeeks: 8, breadth: "QUINTILE", legs: 2, holdingWeeks: 2, volState: "HIGH" },
  { id: "B2-10W-HV-Q-2L-4W", family: "FAMILY_B_HIGH_VOL_REVERSAL", formationWeeks: 10, breadth: "QUINTILE", legs: 2, holdingWeeks: 4, volState: "HIGH" },
  { id: "B3-12W-HV-D-3L-8W", family: "FAMILY_B_HIGH_VOL_REVERSAL", formationWeeks: 12, breadth: "DECILE", legs: 3, holdingWeeks: 8, volState: "HIGH" },
  { id: "B4-8W-HV-D-3L-4W", family: "FAMILY_B_HIGH_VOL_REVERSAL", formationWeeks: 8, breadth: "DECILE", legs: 3, holdingWeeks: 4, volState: "HIGH" },
  { id: "C1-8W-DISP-Q-2L-2W", family: "FAMILY_C_DISPERSION_REVERSAL", formationWeeks: 8, breadth: "QUINTILE", legs: 2, holdingWeeks: 2, dispersionState: "HIGH" },
  { id: "C2-10W-DISP-Q-2L-4W", family: "FAMILY_C_DISPERSION_REVERSAL", formationWeeks: 10, breadth: "QUINTILE", legs: 2, holdingWeeks: 4, dispersionState: "HIGH" },
  { id: "C3-12W-DISP-D-3L-8W", family: "FAMILY_C_DISPERSION_REVERSAL", formationWeeks: 12, breadth: "DECILE", legs: 3, holdingWeeks: 8, dispersionState: "HIGH" },
  { id: "C4-8W-DISP-D-3L-4W", family: "FAMILY_C_DISPERSION_REVERSAL", formationWeeks: 8, breadth: "DECILE", legs: 3, holdingWeeks: 4, dispersionState: "HIGH" },
] as const;

const COST_MODEL = {
  feeBpsPerSide: 4,
  baseSlippageBpsPerSide: 2,
  stressBpsPerSide: STRESS_BPS,
  capital: CAPITAL,
  leveragePreferred: 2,
  leverageHardLimit: 3,
  execution: "Signal is formed from closed daily bars; each leg uses the actual next available Binance USDⓈ-M 15m open at the manual delay. No same-window close execution or synthetic price is used.",
  funding: "Every funding contribution is read from the corresponding official fundingRate archive; missing funding archives make the execution unavailable.",
} as const;

const dailyBars = new Map<string, Bar[]>();
const dailyStats = new Map<string, SymbolDailyStats>();
const executionBars = new Map<string, Bar[]>();
const fundingPoints = new Map<string, FundingPoint[]>();
const executionLoads = new Map<string, Promise<void>>();
const fundingLoads = new Map<string, Promise<void>>();
const archiveRecords: ArchiveRecord[] = [];
const executionArchiveRecords = new Map<string, ArchiveRecord>();
const listedDailyArchives = new Map<string, Set<string>>();

async function main(): Promise<void> {
  await mkdir(REPORT_ROOT, { recursive: true });
  await mkdir(CACHE_ROOT, { recursive: true });
  const generatedAt = new Date().toISOString();
  const rootInventory = await loadRootInventory();
  SYMBOLS = rootInventory.analysisSymbols;
  console.info(JSON.stringify({ stage: "v14_archive_inventory_complete", archiveSymbols: rootInventory.allArchiveSymbols.length, usdtSymbols: rootInventory.usdtSymbols.length, analysisSymbols: SYMBOLS.length, historicalOnlyCandidates: rootInventory.availability.filter((item) => item.lastPeriod !== null && item.lastPeriod < "2026-07").length }));
  const daily = await loadDailyData();
  const pitWeeks = buildPitWeeks(daily);
  const registryBody = buildArchiveRegistry(rootInventory, daily);
  const registryHash = hashObject(registryBody);
  const dataGate = buildDataGate(rootInventory, daily, pitWeeks);
  const freezeManifest = buildFreezeManifest(registryHash, dataGate);
  await writeJson(resolve(REPORT_ROOT, "v14-archive-symbol-registry.json"), { ...registryBody, registrySha256: registryHash });
  await writeJson(resolve(REPORT_ROOT, "v14-data-gate.json"), { schema: "bca-v14-data-gate-v1", generatedAt, baseline: BASELINE, dataGate, dailyStats: [...dailyStats.values()], archiveRecords });
  await writeJson(resolve(REPORT_ROOT, "v14-freeze-manifest.json"), freezeManifest);

  if (!dataGate.pass) {
    const stop = buildDataStopSummary(dataGate, registryHash);
    await writeJson(resolve(REPORT_ROOT, "v14-validation-summary.json"), stop);
    await writeJson(resolve(REPORT_ROOT, "v14-promotion-decision.json"), { status: "V14_PIT_UNIVERSE_INSUFFICIENT", researchStop: "YES", registryHash });
    await writeFile(resolve(REPORT_ROOT, "v14-promotion-decision.md"), renderDecision(stop), "utf8");
    console.error("V14_PIT_UNIVERSE_INSUFFICIENT");
    process.exitCode = 2;
    return;
  }

  const spotDiagnostic = await runSpotDiagnostic();
  const families: Record<Family, FamilyResult> = {
    FAMILY_A_PURE_REVERSAL: await evaluateFamily("FAMILY_A_PURE_REVERSAL", pitWeeks),
    FAMILY_B_HIGH_VOL_REVERSAL: await evaluateFamily("FAMILY_B_HIGH_VOL_REVERSAL", pitWeeks),
    FAMILY_C_DISPERSION_REVERSAL: await evaluateFamily("FAMILY_C_DISPERSION_REVERSAL", pitWeeks),
  };
  const best = selectBestFamily(Object.values(families));
  const promotion = best?.status === "PASS" ? "PASS" : "FAIL";
  const summary = buildFullSummary({ generatedAt, dataGate, registryHash, spotDiagnostic, families, best, promotion });
  await writeJson(resolve(REPORT_ROOT, "v14-family-results.json"), families);
  await writeJson(resolve(REPORT_ROOT, "v14-validation-summary.json"), summary);
  await writeJson(resolve(REPORT_ROOT, "v14-promotion-decision.json"), { schema: "bca-v14-promotion-decision-v1", baseline: BASELINE, registryHash, status: promotion === "PASS" ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "V14_CROSS_SECTIONAL_REVERSAL_REJECTED", researchStop: "YES", winner: best ? { family: best.family, configId: best.bestConfigId } : null });
  await writeFile(resolve(REPORT_ROOT, "v14-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({ stage: "v14_validation_complete", dataGate: dataGate.status, archiveSymbols: rootInventory.usdtSymbols.length, analysisSymbols: SYMBOLS.length, pitMedian: dataGate.medianPitUniverse, pitMinimum: dataGate.minimumPitUniverse, families: Object.values(families).map((family) => ({ family: family.family, status: family.status, configId: family.bestConfigId, signals: family.nested.signals })), EMAIL_PROMOTION_CANDIDATE: promotion, researchStop: "YES" }));
}

async function loadRootInventory(): Promise<RootInventory> {
  const listing = await listS3Objects(S3_KLINE_PREFIX, "/");
  const allArchiveSymbols = listing.prefixes.map((prefix) => prefix.slice(S3_KLINE_PREFIX.length).replace(/\/$/, "")).filter(Boolean).sort();
  const usdtSymbols = allArchiveSymbols.filter((symbol) => symbol.endsWith("USDT"));
  const availability = await mapLimit(usdtSymbols, 8, async (symbol) => {
    const symbolListing = await listS3Objects(`${S3_KLINE_PREFIX}${symbol}/1d/`);
    const periods = [...new Set(symbolListing.keys.filter((key) => key.endsWith(".zip")).map(periodFromArchiveKey).filter((period): period is string => period !== null))].sort();
    const targetPeriods = new Set(monthKeys(START, END));
    const target = periods.filter((period) => targetPeriods.has(period));
    listedDailyArchives.set(symbol, new Set(target));
    return { symbol, periods: target, firstPeriod: target[0] ?? null, lastPeriod: target.at(-1) ?? null, listedObjects: symbolListing.keys.filter((key) => key.endsWith(".zip")).length } satisfies ArchiveAvailability;
  });
  const targetMonthCount = monthKeys(START, END).length;
  const analysisSymbols = availability.filter((item) => {
    const longHistory = item.periods.length >= Math.ceil(targetMonthCount * 0.9);
    const historicalOnly = item.lastPeriod !== null && item.lastPeriod < "2026-07" && item.periods.length >= 12;
    return longHistory || historicalOnly;
  }).map((item) => item.symbol).sort();
  const inventoryBody = { source: "Binance Data Vision official public archive via S3 ListObjectsV2", listingUrl: `${S3_ROOT}?list-type=2&prefix=${encodeURIComponent(S3_KLINE_PREFIX)}&delimiter=%2F`, allArchiveSymbols, usdtSymbols, availability, analysisRule: `Use every USDT-M symbol with at least ${Math.ceil(targetMonthCount * 0.9)} of ${targetMonthCount} target monthly 1d archives, plus every later-delisted symbol with at least 12 target monthly archives; this rule is based only on archive object availability, never on returns or current exchangeInfo.` };
  return { ...inventoryBody, analysisSymbols, fetchedAt: new Date().toISOString(), rawSha256: hashObject(inventoryBody), complete: !listing.truncated };
}

interface S3Listing {
  keys: string[];
  prefixes: string[];
  truncated: boolean;
}

async function listS3Objects(prefix: string, delimiter?: string): Promise<S3Listing> {
  const keys: string[] = [];
  const prefixes: string[] = [];
  let continuationToken: string | null = null;
  let truncated = false;
  do {
    const query = new URLSearchParams({ "list-type": "2", prefix });
    if (delimiter) query.set("delimiter", delimiter);
    if (continuationToken) query.set("continuation-token", continuationToken);
    const response = await fetchWithRetry(`${S3_ROOT}?${query.toString()}`);
    if (!response.ok) throw new Error(`official archive listing failed: HTTP ${response.status} for ${prefix}`);
    const xml = await response.text();
    keys.push(...xmlValues(xml, "Key"));
    prefixes.push(...xmlValues(xml, "Prefix"));
    truncated = xmlValues(xml, "IsTruncated")[0] === "true";
    continuationToken = xmlValues(xml, "NextContinuationToken")[0] ?? null;
    if (truncated && !continuationToken) throw new Error(`official archive listing was truncated without continuation token: ${prefix}`);
  } while (truncated);
  return { keys: [...new Set(keys)], prefixes: [...new Set(prefixes)], truncated };
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok || response.status === 404) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function xmlValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1]));
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
}

function periodFromArchiveKey(key: string): string | null {
  if (!key.endsWith(".zip")) return null;
  const period = key.slice(-11, -4);
  return /^\d{4}-\d{2}$/.test(period) ? period : null;
}

async function loadDailyData(): Promise<{ symbols: string[]; records: ArchiveRecord[] }> {
  const periods = monthKeys(START, END);
  const work = SYMBOLS.flatMap((symbol) => periods.map((period) => ({ symbol, period })));
  const results = await mapLimit(work, 24, async (item) => {
    const stored = await ensureArchive(item.symbol, "1d", item.period, DATA_VISION_ROOT, true);
    let bars: Bar[] = [];
    if (stored.path) {
      try { bars = parseBars(await readFile(stored.path)); stored.record.rowCount = bars.length; } catch (error) { stored.record.status = "FAILED"; stored.record.error = error instanceof Error ? error.message : String(error); stored.record.sha256 = null; stored.record.checksumStatus = "FAIL"; }
    }
    return { stored, bars };
  });
  const grouped = new Map<string, Bar[]>();
  for (const symbol of SYMBOLS) grouped.set(symbol, []);
  for (const result of results) {
    archiveRecords.push(result.stored.record);
    grouped.get(result.stored.record.symbol)!.push(...result.bars.filter((bar) => bar.openTime >= START && bar.openTime <= END));
  }
  for (const symbol of SYMBOLS) {
    const raw = grouped.get(symbol)!;
    const unique = dedupeBars(raw);
    dailyBars.set(symbol, unique);
    dailyStats.set(symbol, buildDailyStats(symbol, unique, archiveRecords.filter((record) => record.symbol === symbol && record.timeframe === "1d")));
  }
  return { symbols: [...SYMBOLS], records: results.map((result) => result.stored.record) };
}

function buildDailyStats(symbol: string, bars: Bar[], records: ArchiveRecord[]): SymbolDailyStats {
  const first = bars[0]?.openTime ?? null;
  const last = bars.at(-1)?.openTime ?? null;
  const expected = first === null || last === null ? 0 : Math.floor((last - first) / DAY) + 1;
  const internalGapDays = Math.max(0, expected - bars.length);
  const badOhlc = bars.filter((bar) => bar.open <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low <= 0 || bar.close <= 0).length;
  const zeroVolume = bars.filter((bar) => bar.volume <= 0 || bar.quoteVolume <= 0).length;
  const coverage = expected > 0 ? bars.length / expected : 0;
  const available = records.filter((record) => record.status === "AVAILABLE" && record.checksumStatus === "PASS");
  return {
    symbol,
    firstObserved: first === null ? null : new Date(first).toISOString(),
    lastObserved: last === null ? null : new Date(last).toISOString(),
    observedMonths: available.map((record) => record.period).sort(),
    archiveObjects: available.length,
    bars: bars.length,
    coverage,
    internalGapDays,
    badOhlc,
    zeroVolume,
    checksumStatus: available.length > 0 && available.every((record) => Boolean(record.sha256)) && records.every((record) => record.status !== "FAILED" && record.checksumStatus !== "FAIL") ? "PASS" : "FAIL",
    historicalOnly: last !== null && last < HISTORICAL_ONLY_CUTOFF,
    reliable: bars.length > 0 && coverage >= 0.98 && badOhlc === 0 && zeroVolume === 0,
  };
}

function buildArchiveRegistry(root: RootInventory, daily: { symbols: string[] }): Record<string, unknown> {
  const candidateSet = new Set(daily.symbols);
  const availability = new Map(root.availability.map((item) => [item.symbol, item]));
  const records = root.usdtSymbols.map((symbol) => {
    const symbolRecords = archiveRecords.filter((record) => record.symbol === symbol && record.timeframe === "1d");
    const stats = dailyStats.get(symbol);
    const listed = availability.get(symbol);
    return {
      symbol,
      market: "USDⓈ-M Futures",
      firstObservedMonth: stats?.observedMonths[0] ?? null,
      lastObservedMonth: stats?.observedMonths.at(-1) ?? null,
      observedMonths: stats?.observedMonths ?? [],
      archiveObjects: symbolRecords.filter((record) => record.status === "AVAILABLE").map((record) => ({ period: record.period, url: record.sourceUrl, bytes: record.bytes, sha256: record.sha256 })),
      checksumStatus: candidateSet.has(symbol) ? (stats?.checksumStatus ?? "FAIL") : "DISCOVERY_ONLY_NOT_DOWNLOADED",
      phase1Status: candidateSet.has(symbol) ? "PHASE1_DAILY_VALIDATED" : "ARCHIVE_DISCOVERY_ONLY",
      historicalOnly: stats?.historicalOnly ?? null,
      listedTargetMonths: listed?.periods ?? [],
    };
  });
  return {
    schema: "bca-v14-archive-symbol-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baseline: BASELINE,
    source: root.source,
    inventoryFetchedAt: root.fetchedAt,
    inventoryRawSha256: root.rawSha256,
    inventoryStatus: root.complete ? "COMPLETE" : "INCOMPLETE",
    enumeration: { method: "Live official Data Vision S3 ListObjectsV2 root prefixes", pagination: root.complete ? "COMPLETE" : "INCOMPLETE", liveS3Listing: "USED", currentExchangeInfoUsedForHistory: false, allArchiveSymbols: root.allArchiveSymbols.length, usdtSymbols: root.usdtSymbols.length },
    period: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), frequency: "1d phase-1; 15m/funding phase-2 on selected execution legs" },
    candidateSymbols: daily.symbols,
    rootArchiveSymbolCount: root.usdtSymbols.length,
    analysisSymbolCount: daily.symbols.length,
    symbols: records,
    checksumRule: "Every downloaded/reused ZIP is SHA-256 verified; expected pre-listing/post-terminal 404 objects are lifecycle absence, not fabricated bars.",
    lifecycleRule: "Observed archive bars define availability at each PIT timestamp. Future bars and current active exchangeInfo are never used for historical membership.",
  };
}

function buildDataGate(root: RootInventory, daily: { symbols: string[] }, weeks: PitWeek[]): Record<string, unknown> & { pass: boolean; status: string; medianPitUniverse: number; minimumPitUniverse: number } {
  const stats = [...dailyStats.values()];
  const reliableSymbols = stats.filter((value) => value.reliable);
  const universeSizes = weeks.map((week) => week.eligible.length);
  const medianPitUniverse = median(universeSizes);
  const minimumPitUniverse = universeSizes.length ? Math.min(...universeSizes) : 0;
  const formationCoverage = weeks.length ? weeks.filter((week) => week.eligible.length >= 20).length / weeks.length : 0;
  const allChecksummed = archiveRecords.filter((record) => record.status === "AVAILABLE").length > 0 && archiveRecords.filter((record) => record.status === "AVAILABLE").every((record) => Boolean(record.sha256) && record.checksumStatus === "PASS") && archiveRecords.every((record) => record.status !== "FAILED" && record.checksumStatus !== "FAIL");
  const fullWindowSymbols = stats.filter((value) => value.firstObserved !== null && Date.parse(value.firstObserved) <= START && value.lastObserved !== null && Date.parse(value.lastObserved) >= END - DAY).length;
  const historicalOnlySymbols = stats.filter((value) => value.historicalOnly).map((value) => value.symbol);
  const reasons = [
    ...(!root.complete ? ["archive_root_inventory_not_complete"] : []),
    ...(!allChecksummed ? ["download_or_checksum_failure"] : []),
    ...(fullWindowSymbols < 2 ? ["requested_period_not_reliably_covered"] : []),
    ...(reliableSymbols.length < 30 ? ["fewer_than_30_reliable_phase1_symbols"] : []),
    ...(medianPitUniverse < 30 ? ["median_pit_universe_below_30"] : []),
    ...(minimumPitUniverse < 20 ? ["minimum_actionable_pit_universe_below_20"] : []),
    ...(formationCoverage < 0.98 ? ["formation_coverage_below_98_percent"] : []),
    ...(historicalOnlySymbols.length === 0 ? ["historical_only_symbols_not_included"] : []),
  ];
  return {
    status: reasons.length ? "V14_PIT_UNIVERSE_INSUFFICIENT" : "PASS",
    pass: reasons.length === 0,
    archiveEnumeration: root.complete ? "COMPLETE_LIVE_S3_INVENTORY" : "FAIL",
    archiveSymbols: root.usdtSymbols.length,
    requestedPeriod: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), fullWindowSymbols },
    phase1CandidateSymbols: daily.symbols.length,
    reliablePhase1Symbols: reliableSymbols.length,
    checksum: allChecksummed ? "100%_OF_DOWNLOADED_ZIPS" : "FAIL",
    medianPitUniverse,
    minimumPitUniverse,
    formationCoverage,
    historicalOnlySymbols,
    pitMembership: reasons.includes("median_pit_universe_below_30") || reasons.includes("minimum_actionable_pit_universe_below_20") ? "FAIL" : "PASS",
    currentSurvivorOnlyUniverse: false,
    dataQuality: { duplicateBars: 0, forwardFill: false, syntheticBars: false, zeroVolumeSymbols: stats.filter((value) => value.zeroVolume > 0).map((value) => value.symbol), badOhlcSymbols: stats.filter((value) => value.badOhlc > 0).map((value) => value.symbol) },
    reasons,
  };
}

function buildPitWeeks(_: { symbols: string[] }): PitWeek[] {
  const first = nextMonday(START + 180 * DAY);
  const weeks: PitWeek[] = [];
  for (let timestamp = first; timestamp <= END - 8 * WEEK; timestamp += WEEK) {
    const candidates: PitPoint[] = [];
    for (const symbol of SYMBOLS) {
      const bars = dailyBars.get(symbol) ?? [];
      const latest = latestClosedBar(bars, timestamp);
      if (!latest || latest.openTime + DAY < timestamp - 2 * DAY) continue;
      const age = latest.openTime - (bars[0]?.openTime ?? latest.openTime);
      if (age < 90 * DAY) continue;
      const formationEnd = latest.openTime;
      const formationStart = formationEnd - 12 * WEEK;
      const recentBars = bars.filter((bar) => bar.openTime > formationEnd - 30 * DAY && bar.openTime <= formationEnd);
      if (recentBars.length < 28 || recentBars.some((bar) => bar.quoteVolume <= 0)) continue;
      const formationBars = bars.filter((bar) => bar.openTime >= formationStart && bar.openTime <= formationEnd);
      if (formationBars.length < 0.98 * 84) continue;
      const startBar = barAtOrBefore(bars, formationEnd - 8 * WEEK);
      if (!startBar || startBar.close <= 0 || latest.close <= 0) continue;
      const logReturns = consecutiveLogReturns(formationBars);
      if (logReturns.length < 28) continue;
      candidates.push({ symbol, formationReturn: latest.close / startBar.close - 1, volatility: Math.sqrt(mean(logReturns.map((value) => value ** 2))) * Math.sqrt(365), quoteVolume30d: mean(recentBars.map((bar) => bar.quoteVolume)), latestBar: latest.openTime });
    }
    const returns = candidates.map((candidate) => candidate.formationReturn);
    const btcBars = dailyBars.get("BTCUSDT") ?? [];
    const btcLatest = latestClosedBar(btcBars, timestamp);
    const btcStart = btcLatest ? barAtOrBefore(btcBars, btcLatest.openTime - 8 * WEEK) : null;
    const btcReturn8w = btcLatest && btcStart && btcStart.close > 0 ? btcLatest.close / btcStart.close - 1 : null;
    const btcRecent = btcBars.filter((bar) => btcLatest && bar.openTime > btcLatest.openTime - 30 * DAY && bar.openTime <= btcLatest.openTime);
    const btcVol30d = btcRecent.length >= 20 ? Math.sqrt(mean(consecutiveLogReturns(btcRecent).map((value) => value ** 2))) * Math.sqrt(365) : null;
    weeks.push({ timestamp, eligible: candidates, dispersion: standardDeviation(returns), btcReturn8w, btcVol30d });
  }
  return weeks;
}

async function evaluateFamily(family: Family, weeks: PitWeek[]): Promise<FamilyResult> {
  const configs = CONFIGURATIONS.filter((config) => config.family === family);
  const configRuns: ConfigRun[] = [];
  for (const config of configs) {
    const decisions = buildDecisions(config, weeks);
    const trades = await executeDecisions(decisions, 15);
    configRuns.push({ config, decisions, trades, metrics: metricsFor(trades) });
  }
  const nested = nestedEvaluation(configRuns);
  const bestConfigId = nested.configId;
  const selectedRun = configRuns.find((run) => run.config.id === bestConfigId) ?? configRuns[0];
  const selectedTrades = selectedRun ? filterByDecisionPeriod(selectedRun.trades, START, END) : [];
  const holdoutA = selectedRun ? metricsFor(filterByDecisionPeriod(selectedRun.trades, Date.UTC(2024, 6, 1), Date.UTC(2025, 5, 30, 23, 59, 59, 999))) : emptyMetrics();
  const holdoutB = selectedRun ? metricsFor(filterByDecisionPeriod(selectedRun.trades, Date.UTC(2025, 6, 1), END)) : emptyMetrics();
  const latency: Record<string, Metrics> = {};
  for (const delay of DELAY_MINUTES) latency[`${delay}m`] = selectedRun ? metricsFor(await executeDecisions(selectedRun.decisions, delay)) : emptyMetrics();
  const diversificationReport = diversification(selectedTrades);
  const stabilityReport = stability(selectedTrades, weeks);
  const placeboReport = await placebo(selectedRun, weeks);
  const robustnessReport = robustness(nested.metrics, selectedTrades);
  const capitalReport = capitalSimulation(selectedTrades);
  const emailReport = emailSimulation(selectedTrades, latency);
  const portfolioReport = metricsFor(selectedTrades);
  const gate = buildPromotionGate(nested.metrics, holdoutA, holdoutB, latency, selectedTrades, { stability: stabilityReport, placebo: placeboReport, robustness: robustnessReport, capital: capitalReport, email: emailReport, portfolio: portfolioReport });
  const result: FamilyResult = {
    family,
    status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL",
    bestConfigId,
    nested: nested.metrics,
    holdoutA,
    holdoutB,
    gate,
    reasons: Object.entries(gate).filter(([, value]) => !value).map(([key]) => key),
    configRuns,
    selectedTrades,
    latency,
    diversification: diversificationReport,
    stability: stabilityReport,
    placebo: placeboReport,
    robustness: robustnessReport,
    capital: capitalReport,
    portfolio: portfolioReport,
    emailSimulation: emailReport,
    longContribution: sum(selectedTrades.map((trade) => trade.longR)),
    shortContribution: sum(selectedTrades.map((trade) => trade.shortR)),
    portfolioBeta: portfolioBeta(selectedTrades, weeks),
  };
  return result;
}

function buildDecisions(config: Config, weeks: PitWeek[]): Decision[] {
  const output: Decision[] = [];
  const priorDispersions: number[] = [];
  for (const [index, week] of weeks.entries()) {
    const eligible = week.eligible.filter((candidate) => candidate.formationReturn !== null);
    const volMedian = median(eligible.map((candidate) => candidate.volatility));
    const priorDispersionMedian = median(priorDispersions.slice(-12));
    priorDispersions.push(week.dispersion);
    const filtered = eligible.filter((candidate) => (!config.volState || candidate.volatility >= volMedian) && (!config.dispersionState || week.dispersion >= priorDispersionMedian || index < 12));
    const ordered = filtered.slice().sort((left, right) => left.formationReturn - right.formationReturn || left.symbol.localeCompare(right.symbol));
    const breadthPool = config.breadth === "DECILE" ? Math.max(config.legs, Math.ceil(ordered.length * 0.1)) : Math.max(config.legs, Math.ceil(ordered.length * 0.2));
    if (ordered.length < config.legs * 2 || breadthPool < config.legs) continue;
    const longs = ordered.slice(0, Math.min(config.legs, breadthPool)).map((candidate) => candidate.symbol);
    const shorts = ordered.slice(-Math.min(config.legs, breadthPool)).reverse().map((candidate) => candidate.symbol);
    if (new Set([...longs, ...shorts]).size !== longs.length + shorts.length) continue;
    output.push({ id: `${config.id}-${week.timestamp}`, family: config.family, configId: config.id, timestamp: week.timestamp, holdingWeeks: config.holdingWeeks, longs, shorts, regime: regimeFor(week) });
  }
  return output;
}

async function executeDecisions(decisions: Decision[], delayMinutes: number): Promise<SignalTrade[]> {
  const output = await mapLimit(decisions, 16, async (decision): Promise<SignalTrade | null> => {
    const entryTarget = decision.timestamp + delayMinutes * 60_000;
    const exitTarget = entryTarget + decision.holdingWeeks * WEEK;
    if (exitTarget > END) return null;
    const legs: ExecutedLeg[] = [];
    const legResults = await Promise.all([
      ...decision.longs.map((symbol) => executeLeg(symbol, 1, entryTarget, exitTarget)),
      ...decision.shorts.map((symbol) => executeLeg(symbol, -1, entryTarget, exitTarget)),
    ]);
    for (const leg of legResults) if (leg) legs.push(leg);
    if (legs.length !== decision.longs.length + decision.shorts.length) return null;
    const netRByStress = Object.fromEntries(STRESS_BPS.map((bps) => [String(bps), mean(legs.map((leg) => leg.netRByStress[String(bps)]))]));
    return { id: decision.id, family: decision.family, configId: decision.configId, timestamp: decision.timestamp, entryTime: Math.min(...legs.map((leg) => leg.entryTime)), exitTime: Math.max(...legs.map((leg) => leg.exitTime)), regime: decision.regime, legs, netRByStress, longR: mean(legs.filter((leg) => leg.direction === 1).map((leg) => leg.netRByStress["0"])), shortR: mean(legs.filter((leg) => leg.direction === -1).map((leg) => leg.netRByStress["0"])) };
  });
  return output.filter((trade): trade is SignalTrade => trade !== null);
}

async function executeLeg(symbol: string, direction: 1 | -1, entryTarget: number, exitTarget: number): Promise<ExecutedLeg | null> {
  const entry = await candleAtOrAfter(symbol, entryTarget);
  const exit = await candleAtOrAfter(symbol, exitTarget);
  if (!entry || !exit || entry.open <= 0 || exit.open <= 0 || exit.openTime <= entry.openTime) return null;
  const funding = await fundingBetween(symbol, entry.openTime, exit.openTime);
  if (funding === null) return null;
  const grossR = direction * (exit.open / entry.open - 1);
  const fundingR = -direction * funding;
  const netRByStress = Object.fromEntries(STRESS_BPS.map((stress) => {
    const costs = 2 * (COST_MODEL.feeBpsPerSide + COST_MODEL.baseSlippageBpsPerSide + stress) / 10_000;
    return [String(stress), grossR + fundingR - costs];
  }));
  return { symbol, direction, entryTime: entry.openTime, exitTime: exit.openTime, entryPrice: entry.open, exitPrice: exit.open, grossR, fundingR, netRByStress };
}

function nestedEvaluation(runs: ConfigRun[]): { configId: string | null; metrics: Metrics } {
  const foldRanges = [
    [Date.UTC(2022, 0, 1), Date.UTC(2022, 11, 31, 23, 59, 59, 999)],
    [Date.UTC(2023, 0, 1), Date.UTC(2023, 11, 31, 23, 59, 59, 999)],
    [Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59, 999)],
  ] as const;
  const oos: SignalTrade[] = [];
  const selected: string[] = [];
  for (const [foldStart, foldEnd] of foldRanges) {
    const trainEnd = foldStart - 4 * WEEK;
    const candidate = runs.slice().sort((left, right) => scoreConfig(right, START, trainEnd) - scoreConfig(left, START, trainEnd) || left.config.id.localeCompare(right.config.id))[0];
    if (!candidate) continue;
    selected.push(candidate.config.id);
    oos.push(...filterByDecisionPeriod(candidate.trades, foldStart, foldEnd));
  }
  const fallback = runs.slice().sort((left, right) => scoreConfig(right, START, Date.UTC(2024, 5, 30)) - scoreConfig(left, START, Date.UTC(2024, 5, 30)))[0];
  return { configId: selected.at(-1) ?? fallback?.config.id ?? null, metrics: metricsFor(oos.length ? oos : fallback?.trades ?? []) };
}

function scoreConfig(run: ConfigRun, start: number, end: number): number {
  const metric = metricsFor(filterByDecisionPeriod(run.trades, start, end));
  return metric.signals >= 20 ? metric.netR + metric.profitFactor * 0.01 - metric.maxDD * 0.1 : -1e9;
}

function buildPromotionGate(nested: Metrics, holdoutA: Metrics, holdoutB: Metrics, latency: Record<string, Metrics>, trades: SignalTrade[], reports: { stability: Record<string, unknown>; placebo: Record<string, unknown>; robustness: Record<string, unknown>; capital: Record<string, unknown>; email: Record<string, unknown>; portfolio: Metrics }): Record<string, boolean> {
  const symbols = new Set(trades.flatMap((trade) => trade.legs.map((leg) => leg.symbol)));
  const stability = reports.stability as { regimes?: Record<string, Metrics>; years?: Record<string, Metrics> };
  const regimes = stability.regimes ?? {};
  const years = stability.years ?? {};
  const positiveRegimes = Object.values(regimes).filter((metric) => metric.netR > 0).length;
  const observedYears = Object.values(years).filter((metric) => metric.signals > 0);
  const positiveYears = observedYears.filter((metric) => metric.netR > 0).length;
  const robustnessReports = reports.robustness as { removeTop1?: Metrics; removeTop5?: Metrics; winsorized?: Metrics };
  const capitalReports = Object.values(reports.capital as Record<string, { effectiveLeverage?: number }>);
  const email = reports.email as { emailsPerMonth?: number; activeMonthRatio?: number; maxDroughtDays?: number; p95DroughtDays?: number };
  const placebo = reports.placebo as { pass?: unknown };
  return {
    nestedSignals: nested.signals >= 100,
    nestedNet: nested.netR > 0,
    nestedAnnualized: nested.annualized >= 0.12,
    nestedPF: nested.profitFactor >= 1.3,
    nestedMaxDD: nested.maxDD <= 0.15,
    nestedPositiveFoldRatio: nested.positiveFoldRatio >= 0.67,
    nestedMedianFold: nested.medianFoldNetR > 0,
    nestedPlus10bps: (nested.stress["10"]?.netR ?? 0) > 0,
    delay30m: (latency["30m"]?.netR ?? 0) > 0,
    delay2h: (latency["120m"]?.netR ?? 0) > 0,
    delay24h: (latency["1440m"]?.netR ?? 0) >= 0,
    holdoutA: holdoutA.signals >= 20 && holdoutA.netR > 0 && holdoutA.profitFactor >= 1.2 && holdoutA.maxDD <= 0.15,
    holdoutB: holdoutB.signals >= 20 && holdoutB.netR > 0 && holdoutB.profitFactor >= 1.2 && holdoutB.maxDD <= 0.15,
    diversificationSymbols: symbols.size >= 20,
    diversificationProfitable: profitableSymbols(trades) >= 10,
    top1Share: Number(diversification(trades).top1ProfitShare ?? 1) <= 0.2,
    top5Share: Number(diversification(trades).top5ProfitShare ?? 1) <= 0.5,
    regimeStability: positiveRegimes >= 3,
    yearStability: observedYears.length > 0 && positiveYears / observedYears.length >= 0.5,
    placebo: placebo.pass === true,
    removeTop1: (robustnessReports.removeTop1?.netR ?? 0) > 0,
    removeTop5: (robustnessReports.removeTop5?.netR ?? 0) > 0,
    winsorized: (robustnessReports.winsorized?.netR ?? 0) > 0,
    emailYield: Number(email.emailsPerMonth ?? 0) >= 3 && Number(email.activeMonthRatio ?? 0) >= 0.9 && Number(email.maxDroughtDays ?? Number.POSITIVE_INFINITY) <= 14,
    portfolio: reports.portfolio.netR > 0 && reports.portfolio.profitFactor >= 1.2,
    capitalLeverage: capitalReports.every((item) => Number(item.effectiveLeverage ?? Number.POSITIVE_INFINITY) <= 3),
  };
}

function metricsFor(trades: SignalTrade[]): Metrics {
  if (!trades.length) return emptyMetrics();
  const values = trades.map((trade) => trade.netRByStress["0"] ?? 0);
  const stress = Object.fromEntries(STRESS_BPS.map((bps) => {
    const netR = sum(trades.map((trade) => trade.netRByStress[String(bps)] ?? 0));
    return [String(bps), { netR, netPnl: netR * CAPITAL, maxDD: maxDrawdown(trades.map((trade) => trade.netRByStress[String(bps)] ?? 0)) }];
  }));
  const positive = values.filter((value) => value > 0);
  const negative = values.filter((value) => value < 0);
  const years = Math.max(1, (Math.max(...trades.map((trade) => trade.timestamp)) - Math.min(...trades.map((trade) => trade.timestamp))) / (365.25 * DAY));
  const foldValues = temporalFoldValues(trades, (trade) => trade.netRByStress["0"] ?? 0);
  return { signals: trades.length, wins: positive.length, losses: negative.length, netR: sum(values), netPnl: sum(values) * CAPITAL, annualized: sum(values) / years, profitFactor: negative.length ? sum(positive) / Math.abs(sum(negative)) : positive.length ? Number.POSITIVE_INFINITY : 0, average: mean(values), median: median(values), worst: Math.min(...values), maxDD: maxDrawdown(values), positiveFoldRatio: foldValues.filter((value) => value > 0).length / Math.max(1, foldValues.length), medianFoldNetR: median(foldValues), stress: stress as Record<string, { netR: number; netPnl: number; maxDD: number }> };
}

function emptyMetrics(): Metrics {
  return { signals: 0, wins: 0, losses: 0, netR: 0, netPnl: 0, annualized: 0, profitFactor: 0, average: 0, median: 0, worst: 0, maxDD: 0, positiveFoldRatio: 0, medianFoldNetR: 0, stress: Object.fromEntries(STRESS_BPS.map((bps) => [String(bps), { netR: 0, netPnl: 0, maxDD: 0 }])) };
}

function filterByDecisionPeriod(trades: SignalTrade[], start: number, end: number): SignalTrade[] { return trades.filter((trade) => trade.timestamp >= start && trade.timestamp <= end); }

function temporalFoldValues(trades: SignalTrade[], value: (trade: SignalTrade) => number): number[] {
  if (!trades.length) return [];
  const sorted = trades.slice().sort((left, right) => left.timestamp - right.timestamp);
  const folds: number[][] = [[], [], [], [], [], []];
  sorted.forEach((trade, index) => folds[Math.min(folds.length - 1, Math.floor(index / Math.max(1, sorted.length / folds.length)))].push(value(trade)));
  return folds.filter((fold) => fold.length).map(sum);
}

function diversification(trades: SignalTrade[]): Record<string, unknown> {
  const contribution = new Map<string, number>();
  for (const trade of trades) for (const leg of trade.legs) contribution.set(leg.symbol, (contribution.get(leg.symbol) ?? 0) + (leg.netRByStress["0"] ?? 0) / trade.legs.length);
  const positive = [...contribution.values()].filter((value) => value > 0);
  const ranked = positive.slice().sort((left, right) => right - left);
  const totalPositive = sum(positive);
  const stats = new Map([...dailyStats.entries()].map(([symbol, value]) => [symbol, value]));
  const historicalOnly = sum([...contribution.entries()].filter(([symbol]) => stats.get(symbol)?.historicalOnly).map(([, value]) => value));
  return { symbols: contribution.size, profitable: positive.length, top1ProfitShare: totalPositive ? (ranked[0] ?? 0) / totalPositive : null, top5ProfitShare: totalPositive ? sum(ranked.slice(0, 5)) / totalPositive : null, historicalOnlyContributionR: historicalOnly, activeTodayContributionR: sum([...contribution.entries()].filter(([symbol]) => !stats.get(symbol)?.historicalOnly).map(([, value]) => value)) };
}

function profitableSymbols(trades: SignalTrade[]): number { return Number(diversification(trades).profitable ?? 0); }

function stability(trades: SignalTrade[], weeks: PitWeek[]): Record<string, unknown> {
  const years = Object.fromEntries([2021, 2022, 2023, 2024, 2025, 2026].map((year) => [String(year), metricsFor(trades.filter((trade) => new Date(trade.timestamp).getUTCFullYear() === year))]));
  const regimes = ["BULL", "BEAR", "RANGE", "HIGH_VOL", "LOW_VOL"];
  const regimeMetrics = Object.fromEntries(regimes.map((regime) => [regime, metricsFor(trades.filter((trade) => trade.regime === regime))]));
  return { years, regimes: regimeMetrics, majorRegimesPositive: Object.values(regimeMetrics).filter((metric) => (metric as Metrics).netR > 0).length >= 3, weekCount: weeks.length };
}

async function placebo(run: ConfigRun | undefined, weeks: PitWeek[]): Promise<Record<string, unknown>> {
  if (!run) return { status: "NOT_RUN", metrics: emptyMetrics() };
  const decisions = run.decisions.map((decision, index) => {
    const week = weeks.find((value) => value.timestamp === decision.timestamp);
    if (!week) return decision;
    const shuffled = week.eligible.slice().sort((left, right) => seededValue(140000 + index, left.symbol) - seededValue(140000 + index, right.symbol));
    return { ...decision, longs: shuffled.slice(0, decision.longs.length).map((item) => item.symbol), shorts: shuffled.slice(-decision.shorts.length).map((item) => item.symbol) };
  });
  const trades = await executeDecisions(decisions, 15);
  const candidate = metricsFor(run.trades);
  const random = metricsFor(trades);
  return { status: "PASS" as const, candidateNetR: candidate.netR, candidatePF: candidate.profitFactor, randomNetR: random.netR, randomPF: random.profitFactor, candidateImprovement: candidate.netR - random.netR, pass: candidate.netR > random.netR && candidate.profitFactor > random.profitFactor };
}

function robustness(nested: Metrics, trades: SignalTrade[]): Record<string, unknown> {
  const ranked = trades.slice().sort((left, right) => (right.netRByStress["0"] ?? 0) - (left.netRByStress["0"] ?? 0));
  const full = metricsFor(trades);
  const removeTop1 = metricsFor(ranked.slice(1));
  const removeTop5 = metricsFor(ranked.slice(5));
  const winsorized = metricsFor(trades.map((trade) => ({ ...trade, netRByStress: { ...trade.netRByStress, "0": clamp(trade.netRByStress["0"] ?? 0, -0.1, 0.1) } })));
  return { full, removeTop1, removeTop5, winsorized, nestedNetR: nested.netR };
}

function capitalSimulation(trades: SignalTrade[]): Record<string, unknown> {
  const timeline = [...new Set(trades.flatMap((trade) => [trade.entryTime, trade.exitTime]))].sort((left, right) => left - right);
  const concurrentAt = (timestamp: number): number => trades.filter((trade) => trade.entryTime <= timestamp && trade.exitTime > timestamp).length;
  const peakConcurrent = Math.max(1, ...timeline.map(concurrentAt));
  const rows = [1_000, 2_000, 10_000].map((capital) => {
    const grossExposurePerSleeve = capital * 2 / peakConcurrent;
    const margins = timeline.map((timestamp) => concurrentAt(timestamp) * grossExposurePerSleeve / 2);
    const average = mean(margins);
    const peak = margins.length ? Math.max(...margins) : 0;
    const scaledNetPnl = sum(trades.map((trade) => (trade.netRByStress["0"] ?? 0) * grossExposurePerSleeve));
    return [String(capital), { startingCapital: capital, effectiveLeverage: 2, grossExposurePerSleeve, averageCapitalLocked: average, peakCapitalLocked: peak, peakConcurrentSleeves: peakConcurrent, marginUtilization: peak / Math.max(1, capital), scaledNetPnl }];
  });
  return Object.fromEntries(rows);
}

function emailSimulation(trades: SignalTrade[], latency: Record<string, Metrics>): Record<string, unknown> {
  const metrics = metricsFor(trades);
  const years = Math.max(1, (END - START) / (365.25 * DAY));
  const droughts = droughtDays(trades);
  return { oneWeeklyPortfolioSignalPerEmail: true, emails: metrics.signals, emailsPerWeek: metrics.signals / years / 52, emailsPerYear: metrics.signals / years, emailsPerMonth: metrics.signals / Math.max(1, (END - START) / (30.4375 * DAY)), profitable: metrics.wins, losing: metrics.losses, winRate: metrics.signals ? metrics.wins / metrics.signals : 0, netPnl: metrics.netPnl, annualized: metrics.annualized, profitFactor: metrics.profitFactor, average: metrics.average, median: metrics.median, worst: metrics.worst, maxDD: metrics.maxDD, p95DroughtDays: percentile(droughts, 0.95), maxDroughtDays: maxDroughtDays(trades), activeMonthRatio: activeMonthRatio(trades), delayMetrics: latency };
}

function maxDroughtDays(trades: SignalTrade[]): number {
  return Math.max(0, ...droughtDays(trades));
}

function droughtDays(trades: SignalTrade[]): number[] {
  const timestamps = trades.slice().sort((left, right) => left.timestamp - right.timestamp).map((trade) => trade.timestamp);
  const gaps: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) gaps.push((timestamps[index] - timestamps[index - 1]) / DAY);
  return gaps;
}

function percentile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

function activeMonthRatio(trades: SignalTrade[]): number {
  const months = monthKeys(START, END);
  const active = new Set(trades.map((trade) => monthKey(trade.timestamp)));
  return months.length ? months.filter((month) => active.has(month)).length / months.length : 0;
}

function portfolioBeta(trades: SignalTrade[], weeks: PitWeek[]): number | null {
  const pairs = trades.map((trade) => [trade.netRByStress["0"] ?? 0, weeks.find((week) => week.timestamp === trade.timestamp)?.btcReturn8w ?? Number.NaN]).filter((pair) => Number.isFinite(pair[1])) as [number, number][];
  if (pairs.length < 2) return null;
  const x = pairs.map((pair) => pair[1]);
  const y = pairs.map((pair) => pair[0]);
  const meanX = mean(x);
  const meanY = mean(y);
  const variance = sum(x.map((value) => (value - meanX) ** 2));
  return variance > 0 ? sum(pairs.map(([valueY, valueX]) => (valueX - meanX) * (valueY - meanY))) / variance : null;
}

function selectBestFamily(families: FamilyResult[]): FamilyResult | null { return families.slice().sort((left, right) => Number(right.status === "PASS") - Number(left.status === "PASS") || right.nested.netR - left.nested.netR || left.family.localeCompare(right.family))[0] ?? null; }

async function runSpotDiagnostic(): Promise<Record<string, unknown>> {
  const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "LINKUSDT", "DOGEUSDT"];
  const bySymbol = new Map<string, Bar[]>(symbols.map((symbol) => [symbol, []]));
  let available = 0;
  for (const symbol of symbols) {
    for (const period of monthKeys(START, END)) {
      const stored = await ensureArchive(symbol, "1d", period, SPOT_ROOT, true);
      if (!stored.path) continue;
      available += 1;
      bySymbol.get(symbol)!.push(...parseBars(await readFile(stored.path)));
    }
  }
  const signals: number[] = [];
  const first = nextMonday(START + 180 * DAY);
  for (let timestamp = first; timestamp <= END - 4 * WEEK; timestamp += WEEK) {
    const ranked = symbols.map((symbol) => {
      const bars = dedupeBars(bySymbol.get(symbol) ?? []);
      const latest = latestClosedBar(bars, timestamp);
      const start = latest ? barAtOrBefore(bars, latest.openTime - 8 * WEEK) : null;
      const recent = latest ? bars.filter((bar) => bar.openTime > latest.openTime - 30 * DAY && bar.openTime <= latest.openTime) : [];
      const vol = recent.length >= 20 ? Math.sqrt(mean(consecutiveLogReturns(recent).map((value) => value ** 2))) * Math.sqrt(365) : Number.NaN;
      return latest && start && start.close > 0 && latest.close > 0 && Number.isFinite(vol) ? { symbol, returnValue: latest.close / start.close - 1, vol } : null;
    }).filter((value): value is { symbol: string; returnValue: number; vol: number } => value !== null);
    if (ranked.length < 8) continue;
    const volatilityMedian = median(ranked.map((value) => value.vol));
    const eligible = ranked.filter((value) => value.vol >= volatilityMedian).sort((left, right) => left.returnValue - right.returnValue);
    if (eligible.length < 4) continue;
    const longSymbols = eligible.slice(0, 2).map((value) => value.symbol);
    const shortSymbols = eligible.slice(-2).map((value) => value.symbol);
    const returns: number[] = [];
    for (const symbol of [...longSymbols, ...shortSymbols]) {
      const bars = dedupeBars(bySymbol.get(symbol) ?? []);
      const entry = bars.find((bar) => bar.openTime >= timestamp);
      const exit = bars.find((bar) => bar.openTime >= timestamp + 4 * WEEK);
      if (!entry || !exit || entry.open <= 0 || exit.open <= 0) { returns.length = 0; break; }
      const direction = longSymbols.includes(symbol) ? 1 : -1;
      returns.push(direction * (exit.open / entry.open - 1) - 2 * (4 + 2) / 10_000);
    }
    if (returns.length === 4) signals.push(mean(returns));
  }
  const net = sum(signals);
  const positive = signals.filter((value) => value > 0);
  const negative = signals.filter((value) => value < 0);
  const sharpe = signals.length > 1 && standardDeviation(signals) > 0 ? mean(signals) / standardDeviation(signals) * Math.sqrt(52) : null;
  return { status: available ? "COMPUTED_FIXED_DIAGNOSTIC" : "NOT_AVAILABLE", source: "Binance Spot public monthly 1d archives", archives: available, signals: signals.length, Net: net, Sharpe: sharpe, PF: negative.length ? sum(positive) / Math.abs(sum(negative)) : positive.length ? Number.POSITIVE_INFINITY : 0, DD: maxDrawdown(signals), promotionEligible: false, rule: "Fixed 8-week reversal with lagged high-vol conditioning, 2 long/2 short, 4-week holding, 4bps fee plus 2bps slippage per side.", note: "Diagnostic only; no spot result can bypass the USD-M promotion gate." };
}

function buildFreezeManifest(registryHash: string, dataGate: Record<string, unknown>): Record<string, unknown> {
  const rules = { universe: "PIT archive-derived membership from bars <= rebalance timestamp; minimum age 90d, 30d quote volume, recent bar and formation completeness", formation: [6, 8, 10, 12], breadth: ["QUINTILE", "DECILE"], legs: [2, 3], holdingWeeks: [2, 4, 8], delaysMinutes: DELAY_MINUTES, stressBps: STRESS_BPS, families: ["FAMILY_A_PURE_REVERSAL", "FAMILY_B_HIGH_VOL_REVERSAL", "FAMILY_C_DISPERSION_REVERSAL"], configurations: CONFIGURATIONS, holdouts: ["2024-07-01/2025-06-30", "2025-07-01/2026-07-31"], execution: COST_MODEL.execution, costModel: COST_MODEL, placeboSeed: 140000, frozenBeforeReturnRead: true };
  return { schema: "bca-v14-freeze-manifest-v1", status: "FROZEN_BEFORE_RETURN_READ", generatedAt: new Date().toISOString(), baseline: BASELINE, registryHash, rules, dataGateStatus: dataGate.status, rawArchiveSha256: hashObject(archiveRecords.filter((record) => record.sha256).map((record) => ({ url: record.sourceUrl, symbol: record.symbol, timeframe: record.timeframe, period: record.period, bytes: record.bytes, sha256: record.sha256 }))) };
}

function buildDataStopSummary(dataGate: Record<string, unknown>, registryHash: string): Record<string, unknown> {
  return { schema: "bca-v14-validation-summary-v1", baseline: BASELINE, dataGate, registryHash, EMAIL_PROMOTION_CANDIDATE: "FAIL", result: "V14_PIT_UNIVERSE_INSUFFICIENT", researchStop: "YES", emailImplementation: "NOT_DONE", simulationEmail: "NOT_SENT", hardBoundaries: { productionChanged: false, productionEmail: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false, deployment: false, merge: false, migration: false, v13Changed: false } };
}

function buildFullSummary(input: { generatedAt: string; dataGate: Record<string, unknown>; registryHash: string; spotDiagnostic: Record<string, unknown>; families: Record<Family, FamilyResult>; best: FamilyResult | null; promotion: string }): Record<string, unknown> {
  return { schema: "bca-v14-validation-summary-v1", generatedAt: input.generatedAt, baseline: BASELINE, branch: "feat/v14-cross-sectional-reversal", dataGate: input.dataGate, spotDiagnostic: input.spotDiagnostic, families: input.families, best: input.best ? { family: input.best.family, configId: input.best.bestConfigId } : null, EMAIL_PROMOTION_CANDIDATE: input.promotion === "PASS" ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "FAIL", result: input.promotion === "PASS" ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "V14_CROSS_SECTIONAL_REVERSAL_REJECTED", researchStop: "YES", registryHash: input.registryHash, emailImplementation: "NOT_DONE", simulationEmail: "NOT_SENT", boundaries: { productionChanged: false, productionEmail: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false, deployment: false, merge: false, migration: false, v13Changed: false } };
}

function renderDecision(summary: Record<string, unknown>): string {
  return ["# V14.0 Promotion Decision", "", `Baseline: ${BASELINE}`, "", `Data gate: ${String((summary.dataGate as Record<string, unknown> | undefined)?.status ?? "UNKNOWN")}`, `Result: ${String(summary.result ?? "UNKNOWN")}`, "Research stop: YES", "", "The V14 study is research-only. No Production code, SMTP state, strategy runtime, deployment, merge, migration, private Binance API, or order placement was changed.", ""].join("\n");
}

async function ensureArchive(symbol: string, timeframe: Timeframe, period: string, root: string, download: boolean): Promise<StoredArchive> {
  const sourceUrl = archiveUrl(symbol, timeframe, period, root);
  const relative = join("data/raw/v14-cross-sectional-cache", root === SPOT_ROOT ? "spot" : "um", timeframe, symbol, `${period}.zip`);
  const ownPath = resolve(relative);
  if (root === DATA_VISION_ROOT && timeframe === "1d" && !listedDailyArchives.get(symbol)?.has(period)) {
    return { record: missingArchiveRecord(symbol, timeframe, period, sourceUrl, false), path: null };
  }
  const existingRoots = root === DATA_VISION_ROOT && timeframe !== "1d" ? [
    resolve(`data/raw/v7-derivatives-flow-cache/market/${symbol}/${timeframe}/${period}.zip`),
    resolve(`data/raw/v5-7-external-cache/archives/${symbol}/${timeframe}/${period}.zip`),
    resolve(`data/raw/v5-8-fresh-cache/archives/${symbol}/${timeframe}/${period}.zip`),
    resolve(`data/raw/v5-9-untouched-cache/archives/${symbol}/${timeframe}/${period}.zip`),
    resolve(`data/raw/v5-9-1-untouched-cache/archives/${symbol}/${timeframe}/${period}.zip`),
  ] : [];
  for (const path of [ownPath, ...existingRoots]) {
    try {
      const bytes = await readFile(path);
      const record = await verifiedArchiveRecord(symbol, timeframe, period, sourceUrl, path, bytes, 200, true);
      return { record, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { record: failedArchiveRecord(symbol, timeframe, period, sourceUrl, path, error), path: null };
      }
    }
  }
  if (!download) return { record: missingArchiveRecord(symbol, timeframe, period, sourceUrl, false), path: null };
  try {
    const response = await fetchWithRetry(sourceUrl);
    if (response.status === 404) return { record: missingArchiveRecord(symbol, timeframe, period, sourceUrl, true), path: null };
    if (!response.ok) return { record: failedArchiveRecord(symbol, timeframe, period, sourceUrl, null, `HTTP ${response.status}`), path: null };
    const bytes = Buffer.from(await response.arrayBuffer());
    await immutableWrite(ownPath, bytes);
    return { record: await verifiedArchiveRecord(symbol, timeframe, period, sourceUrl, ownPath, bytes, response.status, false), path: ownPath };
  } catch (error) {
    return { record: failedArchiveRecord(symbol, timeframe, period, sourceUrl, ownPath, error), path: null };
  }
}

function missingArchiveRecord(symbol: string, timeframe: Timeframe, period: string, sourceUrl: string, listed: boolean): ArchiveRecord {
  return { symbol, timeframe, period, sourceUrl, cachePath: null, status: "MISSING", httpStatus: listed ? 404 : null, rowCount: 0, bytes: 0, sha256: null, expectedSha256: null, checksumStatus: "NOT_CHECKED", listed };
}

function failedArchiveRecord(symbol: string, timeframe: Timeframe, period: string, sourceUrl: string, path: string | null, error: unknown): ArchiveRecord {
  return { symbol, timeframe, period, sourceUrl, cachePath: path ? relativePath(path) : null, status: "FAILED", httpStatus: null, rowCount: 0, bytes: 0, sha256: null, expectedSha256: null, checksumStatus: "FAIL", listed: true, error: error instanceof Error ? error.message : String(error) };
}

async function verifiedArchiveRecord(symbol: string, timeframe: Timeframe, period: string, sourceUrl: string, path: string, bytes: Buffer, httpStatus: number, listed: boolean): Promise<ArchiveRecord> {
  const actualSha256 = sha256(bytes);
  const expectedSha256 = await fetchExpectedChecksum(sourceUrl);
  if (actualSha256 !== expectedSha256) throw new Error(`SHA-256 mismatch for ${sourceUrl}: expected ${expectedSha256}, got ${actualSha256}`);
  return { symbol, timeframe, period, sourceUrl, cachePath: relativePath(path), status: "AVAILABLE", httpStatus, rowCount: 0, bytes: bytes.byteLength, sha256: actualSha256, expectedSha256, checksumStatus: "PASS", listed };
}

async function fetchExpectedChecksum(sourceUrl: string): Promise<string> {
  const response = await fetchWithRetry(`${sourceUrl}.CHECKSUM`);
  if (!response.ok) throw new Error(`checksum fetch failed: HTTP ${response.status} for ${sourceUrl}`);
  const value = (await response.text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`invalid SHA-256 checksum for ${sourceUrl}`);
  return value.toLowerCase();
}

async function immutableWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== sha256(bytes)) throw new Error(`immutable cache collision at ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await writeFile(path, bytes);
    else throw error;
  }
}

function parseBars(bytes: Buffer): Bar[] {
  const entry = readZipEntries(bytes).find((value) => !value.name.endsWith("/"));
  if (!entry) throw new Error("ZIP contains no data entry");
  const lines = entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  const output: Bar[] = [];
  for (const line of lines) {
    const fields = splitCsv(line);
    const openTime = parseTimestamp(fields[0]);
    if (!Number.isFinite(openTime) || fields.length < 8) continue;
    const values = [fields[1], fields[2], fields[3], fields[4], fields[5], fields[7]].map(Number);
    const closeTime = parseTimestamp(fields[6]);
    if (!values.every(Number.isFinite) || !Number.isFinite(closeTime)) continue;
    output.push({ openTime, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4], quoteVolume: values[5], closeTime });
  }
  return output;
}

function parseFunding(bytes: Buffer): FundingPoint[] {
  const entry = readZipEntries(bytes).find((value) => !value.name.endsWith("/"));
  if (!entry) throw new Error("ZIP contains no data entry");
  const output: FundingPoint[] = [];
  for (const line of entry.data.toString("utf8").split(/\r?\n/).filter((value) => value.trim())) {
    const fields = splitCsv(line);
    const time = parseTimestamp(fields[0]);
    const rate = Number(fields.at(-1));
    if (Number.isFinite(time) && Number.isFinite(rate)) output.push({ fundingTime: time, fundingRate: rate });
  }
  return output;
}

async function candleAtOrAfter(symbol: string, timestamp: number): Promise<Bar | null> {
  const targetMonth = monthKey(timestamp);
  const nextMonth = monthKey(timestamp + 32 * DAY);
  const months = [...new Set([targetMonth, nextMonth])];
  await Promise.all(months.map((month) => loadExecutionMonth(symbol, month)));
  return [...new Set(months.flatMap((month) => executionBars.get(`${symbol}:15m:${month}`) ?? []))].filter((bar) => bar.openTime >= timestamp && bar.openTime <= END).sort((left, right) => left.openTime - right.openTime)[0] ?? null;
}

async function fundingBetween(symbol: string, start: number, end: number): Promise<number | null> {
  const periods = monthKeys(start, end);
  const all: FundingPoint[] = [];
  for (const month of periods) {
    await loadFundingMonth(symbol, month);
    if (!(fundingPoints.get(`${symbol}:funding:${month}`))) return null;
    all.push(...(fundingPoints.get(`${symbol}:funding:${month}`) ?? []));
  }
  return sum(all.filter((point) => point.fundingTime > start && point.fundingTime <= end).map((point) => point.fundingRate));
}

async function loadExecutionMonth(symbol: string, month: string): Promise<void> {
  const key = `${symbol}:15m:${month}`;
  if (executionBars.has(key)) return;
  const running = executionLoads.get(key);
  if (running) return running;
  const promise = (async () => {
    const stored = await ensureArchive(symbol, "15m", month, DATA_VISION_ROOT, true);
    executionArchiveRecords.set(key, stored.record);
    if (!stored.path) { executionBars.set(key, []); return; }
    try { executionBars.set(key, dedupeBars(parseBars(await readFile(stored.path)))); } catch { executionBars.set(key, []); }
  })();
  executionLoads.set(key, promise);
  await promise;
}

async function loadFundingMonth(symbol: string, month: string): Promise<void> {
  const key = `${symbol}:funding:${month}`;
  if (fundingPoints.has(key)) return;
  const running = fundingLoads.get(key);
  if (running) return running;
  const promise = (async () => {
    const stored = await ensureArchive(symbol, "funding", month, DATA_VISION_ROOT, true);
    executionArchiveRecords.set(key, stored.record);
    if (!stored.path) return;
    try { fundingPoints.set(key, dedupeFunding(parseFunding(await readFile(stored.path)))); } catch { /* unavailable remains absent */ }
  })();
  fundingLoads.set(key, promise);
  await promise;
}

function archiveUrl(symbol: string, timeframe: Timeframe, period: string, root: string): string {
  const encodedSymbol = encodeURIComponent(symbol);
  if (root === SPOT_ROOT) return `${root}/klines/${encodedSymbol}/1d/${encodedSymbol}-1d-${period}.zip`;
  if (timeframe === "funding") return `${root}/fundingRate/${encodedSymbol}/${encodedSymbol}-fundingRate-${period}.zip`;
  return `${root}/klines/${encodedSymbol}/${timeframe}/${encodedSymbol}-${timeframe}-${period}.zip`;
}

function dedupeBars(bars: Bar[]): Bar[] { return [...new Map(bars.map((bar) => [bar.openTime, bar])).values()].sort((left, right) => left.openTime - right.openTime); }
function dedupeFunding(points: FundingPoint[]): FundingPoint[] { return [...new Map(points.map((point) => [point.fundingTime, point])).values()].sort((left, right) => left.fundingTime - right.fundingTime); }
function latestClosedBar(bars: Bar[], timestamp: number): Bar | null { return bars.filter((bar) => bar.closeTime <= timestamp).at(-1) ?? null; }
function barAtOrBefore(bars: Bar[], timestamp: number): Bar | null { return bars.filter((bar) => bar.openTime <= timestamp).at(-1) ?? null; }
function consecutiveLogReturns(bars: Bar[]): number[] { const output: number[] = []; for (let index = 1; index < bars.length; index += 1) if (bars[index - 1].close > 0 && bars[index].close > 0) output.push(Math.log(bars[index].close / bars[index - 1].close)); return output; }
function regimeFor(week: PitWeek): string { if ((week.btcVol30d ?? 0) >= 0.8) return "HIGH_VOL"; if ((week.btcReturn8w ?? 0) > 0.1) return "BULL"; if ((week.btcReturn8w ?? 0) < -0.1) return "BEAR"; if ((week.btcVol30d ?? 0) < 0.45) return "LOW_VOL"; return "RANGE"; }
function nextMonday(timestamp: number): number { const day = new Date(timestamp).getUTCDay(); return timestamp + ((8 - day) % 7) * DAY; }
function monthKeys(start: number, end: number): string[] { const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1)); const last = new Date(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1)); const output: string[] = []; while (cursor <= last) { output.push(monthKey(cursor.getTime())); cursor.setUTCMonth(cursor.getUTCMonth() + 1); } return output; }
function monthKey(timestamp: number): string { const date = new Date(timestamp); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function parseTimestamp(value: string | undefined): number { const numeric = Number(value); if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric; const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function splitCsv(line: string): string[] { const output: string[] = []; let current = ""; let quoted = false; for (const character of line) { if (character === '"') quoted = !quoted; else if (character === "," && !quoted) { output.push(current); current = ""; } else current += character; } output.push(current); return output; }
function standardDeviation(values: number[]): number { if (values.length < 2) return 0; const average = mean(values); return Math.sqrt(mean(values.map((value) => (value - average) ** 2))); }
function mean(values: number[]): number { return values.length ? sum(values) / values.length : 0; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function median(values: number[]): number { if (!values.length) return 0; const sorted = values.slice().sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function maxDrawdown(values: number[]): number { let equity = 1; let peak = 1; let drawdown = 0; for (const value of values) { equity *= 1 + value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak > 0 ? (peak - equity) / peak : 0); } return drawdown; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function seededValue(seed: number, value: string): number { let hash = seed >>> 0; for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return hash; }
function hashObject(value: unknown): string { return sha256(Buffer.from(JSON.stringify(value))); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function relativePath(path: string): string { return path.replace(`${resolve(".")}\\`, "").replaceAll("\\", "/"); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const output: R[] = []; let cursor = 0; async function consume(): Promise<void> { while (true) { const index = cursor; cursor += 1; if (index >= items.length) return; output[index] = await worker(items[index]); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume())); return output; }

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
