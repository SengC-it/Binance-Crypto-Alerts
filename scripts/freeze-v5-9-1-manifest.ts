import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { externalArchiveUrl, monthKeys, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { sha256Json } from "@/lib/v5-7/manifest";
import {
  V591_BASELINE_COMMIT,
  V591_DEV_END,
  V591_DEV_START,
  V591_EVENT_REGISTRY,
  V591_FEE_RATE,
  V591_MAX_CORE_FEATURES,
  V591_MAX_EVENTS_PER_FAMILY,
  V591_MODEL_CONFIGS,
  V591_NEW_MANIFEST_ID,
  V591_PRIMARY_EDGE_ID,
  V591_RISK_PER_TRADE_USDT,
  V591_RISK_TEMPLATES,
  V591_UNTOUCHED_END,
  V591_UNTOUCHED_START,
  V591_CORE_FEATURE_NAMES,
  V591_RESEARCH_RULES,
  V591_LIQUIDITY_PROXY_CANDIDATES,
} from "@/lib/v5-9-1/registry";

const REPORT_DIR = resolve("reports");
const PRIOR_UNIVERSE_PATH = resolve("data/validation-universe-50.json");
const PRIOR_V57_INVENTORY_PATH = resolve(REPORT_DIR, "v5-7-external-data-inventory.json");
const PRIOR_V59_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-untouched-symbol-manifest.json");
const PIT_INDEX_PATH = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
const MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-1-untouched-symbol-manifest.json");
const RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-1-research-manifest.json");
const CACHE_ROOT = resolve("data/raw/v5-9-1-untouched-cache/archives");
const FROZEN_AT = "2026-08-26T00:00:00.000Z";
const TARGET_SYMBOLS = 20;
const MIN_SYMBOLS = 15;
const TIMEFRAMES: readonly V57ExternalTimeframe[] = ["15m", "1h", "4h", "funding"];
const SOURCE_ROOT = "https://data.binance.vision/data/futures/um/monthly";

interface ArchiveRecord {
  symbol: string;
  timeframe: V57ExternalTimeframe;
  period: string;
  sourceUrl: string;
  cachePath: string | null;
  status: "AVAILABLE" | "ARCHIVE_MISSING" | "DOWNLOAD_FAILED";
  sizeBytes: number | null;
  sha256: string | null;
  error?: string;
}

interface SymbolRecord {
  symbol: string;
  selectionRank: number;
  liquidityProxy: string;
  listingAgeMonths: number | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  listingWindowSource: string;
  status: "AVAILABLE" | "DATA_INCOMPLETE";
  archives: ArchiveRecord[];
}

interface PitEvidenceSymbol {
  symbol: string;
  observedFirstMonth?: string | null;
  observedLastMonth?: string | null;
  tradableStart?: string | null;
}

interface PitIndex {
  rootArchiveSymbols?: string[];
  evidenceSymbols?: PitEvidenceSymbol[];
}

async function main(): Promise<void> {
  const priorSymbols = await loadPriorSymbols();
  const priorUniverse = await readJson<{ symbols?: string[] }>(PRIOR_UNIVERSE_PATH);
  const pitIndex = await readJson<PitIndex>(PIT_INDEX_PATH);
  const rootSymbols = new Set(pitIndex.rootArchiveSymbols ?? []);
  const pitEvidence = new Map((pitIndex.evidenceSymbols ?? []).map((item) => [item.symbol, item]));
  const candidates = V591_LIQUIDITY_PROXY_CANDIDATES.filter((symbol) => rootSymbols.has(symbol) && !priorSymbols.has(symbol));
  if (candidates.length < MIN_SYMBOLS) throw new Error(`Only ${candidates.length} pre-registered candidates remain after prior-universe exclusion`);

  const shouldDownload = process.argv.includes("--download");
  await mkdir(CACHE_ROOT, { recursive: true });
  const periods = monthKeys(V591_UNTOUCHED_START, V591_UNTOUCHED_END);
  const selected: SymbolRecord[] = [];
  const screened: Array<Record<string, unknown>> = [];
  let rank = 0;
  for (const symbol of candidates) {
    rank += 1;
    const pending = periods.flatMap((period) => TIMEFRAMES.map((timeframe) => ({ symbol, timeframe, period })));
    const archives = await mapWithConcurrency(pending, 12, (item) => ensureArchive(item.symbol, item.timeframe, item.period, shouldDownload));
    const record = buildSymbolRecord(symbol, rank, archives, pitEvidence.get(symbol));
    screened.push({
      symbol,
      selectionRank: rank,
      rootArchivePresent: true,
      archiveStatus: record.status,
      effectiveStart: record.effectiveStart,
      effectiveEnd: record.effectiveEnd,
      listingAgeMonths: record.listingAgeMonths,
      liquidityProxy: record.liquidityProxy,
      availableArchiveCount: archives.filter((item) => item.status === "AVAILABLE").length,
      requestedArchiveCount: archives.length,
    });
    if (record.status === "AVAILABLE") selected.push(record);
    if (selected.length >= TARGET_SYMBOLS) break;
  }
  if (selected.length < MIN_SYMBOLS) throw new Error(`Only ${selected.length} untouched symbols have complete immutable archives; need at least ${MIN_SYMBOLS}`);

  const symbols = selected.map((record) => record.symbol);
  const archives = selected.flatMap((record) => record.archives);
  const manifestBody = {
    schema: "bca-v5-9-1-untouched-symbol-manifest-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    manifestId: V591_NEW_MANIFEST_ID,
    frozenAt: FROZEN_AT,
    baselineCommit: V591_BASELINE_COMMIT,
    source: "BINANCE_USDT_M_FUTURES_DATA_VISION",
    sourceRoot: SOURCE_ROOT,
    exchange: "Binance USDT-M Futures",
    period: { start: new Date(V591_UNTOUCHED_START).toISOString(), end: new Date(V591_UNTOUCHED_END).toISOString() },
    timeframes: TIMEFRAMES,
    targetSymbolCount: TARGET_SYMBOLS,
    minimumSymbolCount: MIN_SYMBOLS,
    symbols,
    availableSymbols: symbols,
    coveragePercent: symbols.length / candidates.length * 100,
    priorHoldout: { manifestId: "v59-binance-untouched-symbols-2023-01-01-2026-07-31", burnState: "BURNED_AFTER_ZERO_SIGNAL_REVIEW" },
    selectionRule: {
      priorUniverse: "Exclude symbols used by V5.2-V5.9, including the original validation universe, V5.7 inventory, and the burned V5.9 holdout.",
      candidateOrder: "Pre-registered static established USDT-M liquidity proxy order from V591_LIQUIDITY_PROXY_CANDIDATES.",
      archiveEligibility: "Candidate must exist in the frozen Binance monthly archive root and have non-empty 15m/1h/4h/funding archives across its effective contiguous window.",
      listingWindow: "Listing age and effective window are inferred only from archive availability boundaries at month precision; no candle return or strategy result is read for selection.",
      liquidityProxy: "Established perpetual contract proxy; no trade return, signal count, or outcome was read for selection.",
      noResultSelection: true,
    },
    priorUniverseProof: {
      source: "data/validation-universe-50.json",
      symbolCount: priorUniverse.symbols?.length ?? 0,
      sha256: sha256Json(priorUniverse.symbols ?? []),
      excludedSymbolCount: priorSymbols.size,
      selectedIntersectionCount: symbols.filter((symbol) => priorSymbols.has(symbol)).length,
    },
    execution: {
      signal: "closed 15m candle only",
      entryReference: "next contiguous 15m candle open",
      contiguousBoundary: "execution.openTime == signal.closeTime + 1ms",
      source: "BINANCE_15M_NEXT_BAR_OPEN",
      noLookahead: "The next candle contributes only openTime and open to execution; next high/low/close/volume never affect event detection or features.",
    },
    costs: { takerFeeRate: V591_FEE_RATE, baseSlippageBps: 2, riskPerTradeUsdt: V591_RISK_PER_TRADE_USDT, cooldownHours: 8 },
    rawCache: "data/raw/v5-9-1-untouched-cache/archives (ignored; never committed)",
    screened,
    archives,
    symbolRecords: selected,
    methodology: [
      "The new symbol order, archive period, listing-window rule, timeframes, execution reference, and cost assumptions were frozen before any strategy return was read.",
      "Archive bytes were downloaded and SHA256-hashed for immutable provenance; this freeze step never parses candles, detects events, or computes outcomes.",
      "A selected symbol is AVAILABLE only when every requested archive in its effective contiguous month window is present and non-empty.",
      "The burned V5.9 20-symbol holdout is diagnostic-only and cannot be used as this V5.9.1 final holdout.",
      "Missing/corrupt immutable cache fail-closes validation to DATA_UNAVAILABLE; no zero-row success is reported.",
    ],
  };
  const manifest = { ...manifestBody, manifestHash: sha256Json(manifestBody) };
  const researchBody = {
    schema: "bca-v5-9-1-research-manifest-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    manifestId: "v591-expectancy-calibrated-meta-label-decision-rule-01",
    frozenAt: FROZEN_AT,
    baselineCommit: V591_BASELINE_COMMIT,
    oldHoldout: { manifestId: "v59-binance-untouched-symbols-2023-01-01-2026-07-31", status: "BURNED_AFTER_ZERO_SIGNAL_REVIEW", role: "POST_HOC_DIAGNOSTIC_ONLY" },
    primary: { id: V591_PRIMARY_EDGE_ID, frozen: true, parameterChange: "NO", role: "UNGATED_COMPARATOR_ONLY" },
    candidateEvents: { families: V591_EVENT_REGISTRY, minimumTarget: ">=500 candidate events", maxEventsPerFamily: V591_MAX_EVENTS_PER_FAMILY, capPolicy: "Frozen V5.9 chronological stride cap before labels and independent of returns." },
    riskTemplates: { count: V591_RISK_TEMPLATES.length, max: 3, registry: V591_RISK_TEMPLATES },
    featureContract: { maxCoreFeatures: V591_MAX_CORE_FEATURES, names: V591_CORE_FEATURE_NAMES, signalTimestampOnly: true },
    modelRegistry: { count: V591_MODEL_CONFIGS.length, max: 6, configs: V591_MODEL_CONFIGS, models: ["LOGISTIC_L2", "SHALLOW_TREE"] },
    pools: {
      development: { start: new Date(V591_DEV_START).toISOString(), end: new Date(V591_DEV_END).toISOString(), use: "Training and purged nested walk-forward selection only." },
      untouched: { manifestId: manifest.manifestId, manifestHash: manifest.manifestHash, use: "New final untouched-symbol validation only; excluded from selection." },
    },
    rules: V591_RESEARCH_RULES,
    productionBoundary: { researchOnly: true, noProductionChange: true, noV55Change: true, noEmailChange: true, noEnvironmentChange: true, noMigration: true, noDeployment: true, noMerge: true, noAutoTrading: true },
  };
  const researchManifest = { ...researchBody, manifestHash: sha256Json(researchBody) };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(RESEARCH_MANIFEST_PATH, `${JSON.stringify(researchManifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_9_1_manifest_frozen", download: shouldDownload, selected: symbols.length, screened: screened.length, coveragePercent: manifest.coveragePercent, manifestHash: manifest.manifestHash, researchManifestHash: researchManifest.manifestHash }));
}

async function loadPriorSymbols(): Promise<Set<string>> {
  const seen = new Set<string>();
  const universe = await readJson<{ symbols?: string[] }>(PRIOR_UNIVERSE_PATH);
  for (const symbol of universe.symbols ?? []) seen.add(symbol);
  const inventory = await readJsonOrNull<{ symbols?: Array<{ symbol?: string }> }>(PRIOR_V57_INVENTORY_PATH);
  for (const item of inventory?.symbols ?? []) if (item.symbol) seen.add(item.symbol);
  const oldManifest = await readJsonOrNull<{ symbols?: string[]; availableSymbols?: string[] }>(PRIOR_V59_MANIFEST_PATH);
  for (const symbol of [...(oldManifest?.symbols ?? []), ...(oldManifest?.availableSymbols ?? [])]) seen.add(symbol);
  return seen;
}

function buildSymbolRecord(symbol: string, selectionRank: number, records: ArchiveRecord[], pitEvidence?: PitEvidenceSymbol): SymbolRecord {
  const byPeriod = new Map<string, Map<V57ExternalTimeframe, ArchiveRecord>>();
  for (const record of records) {
    const period = byPeriod.get(record.period) ?? new Map<V57ExternalTimeframe, ArchiveRecord>();
    period.set(record.timeframe, record);
    byPeriod.set(record.period, period);
  }
  const completePeriods = [...byPeriod.entries()]
    .filter(([, timeframeRecords]) => TIMEFRAMES.every((timeframe) => timeframeRecords.get(timeframe)?.status === "AVAILABLE"))
    .map(([period]) => period)
    .sort();
  const effectiveStart = completePeriods[0] ? `${completePeriods[0]}-01T00:00:00.000Z` : null;
  const effectiveEnd = completePeriods.at(-1) ? monthEnd(completePeriods.at(-1)!) : null;
  const effectivePeriodSet = new Set(completePeriods);
  const contiguous = completePeriods.every((period, index) => index === 0 || periodAfter(completePeriods[index - 1], period));
  const status = completePeriods.length > 0 && contiguous ? "AVAILABLE" as const : "DATA_INCOMPLETE" as const;
  const listingAgeMonths = effectiveStart ? monthDistance(new Date(effectiveStart).getTime(), V591_UNTOUCHED_END) : null;
  return {
    symbol,
    selectionRank,
    liquidityProxy: "ESTABLISHED_USDT_M_PERPETUAL_STATIC_PROXY",
    listingAgeMonths: pitEvidence?.tradableStart ? monthDistance(Date.parse(pitEvidence.tradableStart), V591_UNTOUCHED_END) : listingAgeMonths,
    effectiveStart,
    effectiveEnd,
    listingWindowSource: "Binance Data Vision archive availability boundary; month precision",
    status,
    archives: records.filter((record) => effectivePeriodSet.has(record.period)),
  };
}

function periodAfter(previous: string, current: string): boolean {
  const [year, month] = previous.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}` === current;
}

function monthDistance(start: number, end: number): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return Math.max(0, (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth());
}

async function ensureArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string, shouldDownload: boolean): Promise<ArchiveRecord> {
  const sourceUrl = externalArchiveUrl(symbol, timeframe, period);
  const relativePath = `data/raw/v5-9-1-untouched-cache/archives/${symbol}/${timeframe}/${period}.zip`;
  const cachePath = resolve(relativePath);
  try {
    let bytes: Buffer;
    try {
      bytes = await readFile(cachePath);
    } catch {
      if (!shouldDownload) throw new Error("not cached; run freeze-v5-9-1 with --download");
      const response = await fetchWithRetry(sourceUrl);
      if (response.status === 404) return { symbol, timeframe, period, sourceUrl, cachePath: null, status: "ARCHIVE_MISSING", sizeBytes: null, sha256: null, error: "HTTP 404" };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await mkdir(resolve(CACHE_ROOT, symbol, timeframe), { recursive: true });
      try {
        const existing = await readFile(cachePath);
        if (!existing.equals(bytes)) throw new Error("immutable cache collision: existing bytes differ");
      } catch (error) {
        if (error instanceof Error && error.message.includes("immutable cache collision")) throw error;
        await writeFile(cachePath, bytes);
      }
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength <= 0) throw new Error("empty archive");
    return { symbol, timeframe, period, sourceUrl, cachePath: relativePath, status: "AVAILABLE", sizeBytes: bytes.byteLength, sha256 };
  } catch (error) {
    return { symbol, timeframe, period, sourceUrl, cachePath: null, status: "DOWNLOAD_FAILED", sizeBytes: null, sha256: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await fetch(url, { signal: AbortSignal.timeout(60_000) }); }
    catch (error) { lastError = error; await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (attempt + 1))); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function monthEnd(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
}

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function readJsonOrNull<T>(path: string): Promise<T | null> { try { return await readJson<T>(path); } catch { return null; } }

void main();

