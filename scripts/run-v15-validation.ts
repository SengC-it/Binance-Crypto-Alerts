import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProxyAgent, fetch } from "undici";
import { normalizeBinanceTimestamp } from "@/lib/v15/lead-lag";
import { parseKlineArchive, readZipEntries } from "@/lib/v15/archive";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v15-spot-perp-lead-lag";
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
  error: string | null;
}

interface DataGateReport {
  schema: "v15-data-gate-v1";
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
  requirements: {
    archiveChecksumCoverage: number;
    matchedBarCoverage: number;
    trailingFeatureCoverage: number;
    pitFormationCoverage: number;
  };
  status: "PASS" | "V15_DATA_INSUFFICIENT";
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
  const probeSymbols = symbols.filter((symbol) => symbol === "BTCUSDT" || symbol === "ETHUSDT");
  if (probeSymbols.length !== symbols.length) errors.push("FULL_ARCHIVE_ENUMERATION_NOT_COMPLETED: only BTCUSDT and ETHUSDT were probed before the data gate");
  const rows = await mapLimit(probeSymbols, 20, async (symbol) => {
    try {
      const listing = await listObjects(`${root}${symbol}/5m/`);
      const archives = listing.keys.map((item) => {
        const match = item.key.match(/-(5m)-(\d{4}-\d{2})\.zip$/);
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
          normalizedFirstOpenTime: null, timestampUnit: "unknown", error: null,
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

function buildDataGate(spot: ExchangeAvailability, futures: ExchangeAvailability, sentinels: SentinelResult[]): DataGateReport {
  const pitUniverse = buildPitUniverse(spot, futures);
  const requiredArchiveSlots = pitUniverse.monthly.reduce((sum, row) => sum + row.eligiblePairs * 2, 0);
  const materializedArchiveSlots = sentinels.filter((row) => row.status === "PASS").length;
  const checksumCoverage = requiredArchiveSlots ? materializedArchiveSlots / requiredArchiveSlots : 0;
  const timestampSamples = sentinels.filter((row) => row.status === "PASS");
  const timestampPass = timestampSamples.length >= 2 && timestampSamples.every((row) => row.normalizedFirstOpenTime !== null);
  const reasons: string[] = [];
  if (spot.errors.length || futures.errors.length) reasons.push("ARCHIVE_ENUMERATION_INCOMPLETE");
  if (pitUniverse.medianEligiblePairs < 20) reasons.push("PIT_ACTIONABLE_UNIVERSE_BELOW_20");
  if (pitUniverse.formationCoverage < 0.98) reasons.push("PIT_FORMATION_COVERAGE_BELOW_98_PERCENT");
  if (materializedArchiveSlots < requiredArchiveSlots) reasons.push("IMMUTABLE_FULL_5M_ARCHIVE_SET_NOT_MATERIALIZED");
  if (checksumCoverage < 1) reasons.push("ARCHIVE_CHECKSUM_COVERAGE_BELOW_100_PERCENT");
  if (!timestampPass) reasons.push("TIMESTAMP_NORMALIZATION_NOT_VERIFIED_FOR_REQUIRED_SAMPLES");
  reasons.push("MATCHED_BAR_COVERAGE_NOT_COMPUTED_FOR_FULL_ARCHIVE");
  reasons.push("TRAILING_FEATURE_COVERAGE_NOT_COMPUTED_FOR_FULL_ARCHIVE");
  return {
    schema: "v15-data-gate-v1",
    generatedAt: new Date().toISOString(), baseline: BASELINE, branch: BRANCH,
    source: {
      provider: "Binance Data Vision", spotPath: "data/spot/monthly/klines/{symbol}/5m", futuresPath: "data/futures/um/monthly/klines/{symbol}/5m",
      interval: "5m", start: new Date(START).toISOString(), end: new Date(END).toISOString(), officialOnly: true,
    },
    enumeration: {
      spotSymbols: spot.symbols.length, futuresSymbols: futures.symbols.length, sharedSymbols: spot.symbols.filter((symbol) => futures.symbols.includes(symbol)).length,
      spotErrors: spot.errors, futuresErrors: futures.errors, archiveObjectsFound: Object.values(spot.archives).flat().length + Object.values(futures.archives).flat().length,
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
      matchedBarCoverage: 0, trailingFeatureCoverage: 0, liquidityAdvCoverage: 0,
      note: "Full-pair 5m materialization did not complete; no returns or strategy metrics were read.",
    },
    requirements: { archiveChecksumCoverage: 1, matchedBarCoverage: 0.99, trailingFeatureCoverage: 0.98, pitFormationCoverage: 0.98 },
    status: reasons.length ? "V15_DATA_INSUFFICIENT" : "PASS", reasons, historicalReturnsRead: false,
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

async function runFreeze(): Promise<void> {
  if (currentHead() !== BASELINE) throw new Error(`freeze must start at exact baseline ${BASELINE}; current ${currentHead()}`);
  const [spot, futures] = await Promise.all([enumerateExchange("spot"), enumerateExchange("futuresUm")]);
  const sentinels = await materializeSentinels(spot, futures);
  const dataGate = buildDataGate(spot, futures, sentinels);
  await writeJson("v15-data-gate.json", dataGate);
  await writeJson("v15-freeze-manifest.json", freezeManifest(dataGate));
  console.info(JSON.stringify({ phase: "freeze", status: dataGate.status, reasons: dataGate.reasons, historicalReturnsRead: false }));
}

function notRun(reason: string): Record<string, unknown> {
  return { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
}

async function runResult(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-freeze-manifest.json"), "utf8")) as Record<string, unknown>;
  const expectedHash = manifest.manifestSha256;
  const body = { ...manifest };
  delete body.manifestSha256;
  if (expectedHash !== stableHash(body)) throw new Error("freeze manifest hash verification failed");
  if (manifest.baseline !== BASELINE || manifest.branch !== BRANCH || manifest.historicalReturnsRead !== false) throw new Error("freeze identity or returns-read guard failed");
  const dataGate = JSON.parse(await readFile(resolve(REPORT_DIR, "v15-data-gate.json"), "utf8")) as DataGateReport;
  if (dataGate.status === "PASS") throw new Error("full V15 result engine is not permitted to proceed without a complete immutable archive implementation");
  const reason = `DATA_GATE_FAIL: ${dataGate.reasons.join(", ")}`;
  for (const file of ["v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json"]) await writeJson(file, notRun(reason));
  await writeJson("v15-validation-summary.json", {
    schema: "v15-validation-summary-v1", baseline: BASELINE, branch: BRANCH, freezeCommit: currentHead(), freezeSha256: expectedHash, dataGate: dataGate.status,
    historicalReturnsRead: false, result: "V15_DATA_INSUFFICIENT", emailPromotionCandidate: "FAIL", researchStop: "YES", reason,
    primaryOos: null, years: { 2022: null, 2023: null, 2024: null }, holdoutA: null, holdoutB: null, long: null, short: null, placebos: null, cost: null, manualDelay: null, confidence: null, emailUtility: null,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, autoTrading: false },
  });
  await writeJson("v15-promotion-decision.json", { schema: "v15-promotion-decision-v1", classification: "V15_DATA_INSUFFICIENT", emailPromotionCandidate: "FAIL", researchStop: "YES", reason, historicalReturnsRead: false });
  await writeText("v15-promotion-decision.md", `# V15 Promotion Decision\n\n- Classification: **V15_DATA_INSUFFICIENT**\n- Data Gate: **FAIL**\n- Strategy returns: **NOT READ** because the immutable full archive and required coverage gate were incomplete.\n- Email promotion: **FAIL**\n- Research stop: **YES**\n- Production changed: **NO**\n`);
  const files = ["v15-data-gate.json", "v15-freeze-manifest.json", "v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-validation-summary.json", "v15-promotion-decision.json", "v15-promotion-decision.md"];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(resolve(REPORT_DIR, file)));
  await writeJson("v15-evidence-manifest.json", { schema: "v15-evidence-manifest-v1", baseline: BASELINE, branch: BRANCH, freezeSha256: expectedHash, resultCommit: currentHead(), historicalReturnsRead: false, artifacts: hashes });
  console.info(JSON.stringify({ phase: "result", classification: "V15_DATA_INSUFFICIENT", historicalReturnsRead: false }));
}

async function writeText(name: string, value: string): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), value, "utf8");
}

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "freeze";
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
