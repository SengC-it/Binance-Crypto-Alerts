import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { externalArchiveUrl, monthKeys, type V57ExternalTimeframe } from "@/lib/v5-7/external-data";
import { sha256Json } from "@/lib/v5-7/manifest";
import {
  V59_BASELINE_COMMIT,
  V59_BASE_SLIPPAGE_BPS,
  V59_COOLDOWN_HOURS,
  V59_DEV_END,
  V59_DEV_START,
  V59_EVENT_REGISTRY,
  V59_FEE_RATE,
  V59_MAX_CORE_FEATURES,
  V59_MODEL_CONFIGS,
  V59_MAX_EVENTS_PER_FAMILY,
  V59_PRIMARY_EDGE_ID,
  V59_RESEARCH_RULES,
  V59_RISK_PER_TRADE_USDT,
  V59_RISK_TEMPLATES,
  V59_UNTOUCHED_END,
  V59_UNTOUCHED_START,
  V59_UNTOUCHED_SYMBOLS,
  V59_CORE_FEATURE_NAMES,
} from "@/lib/v5-9/registry";

const REPORT_DIR = resolve("reports");
const PIT_UNIVERSE_PATH = resolve("data/validation-universe-50.json");
const PIT_INDEX_PATH = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
const MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-untouched-symbol-manifest.json");
const RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-9-research-manifest.json");
const CACHE_ROOT = resolve("data/raw/v5-9-untouched-cache/archives");
const FROZEN_AT = "2026-08-26T00:00:00.000Z";
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
  effectiveStart: string | null;
  effectiveEnd: string | null;
  listingWindowSource: string;
  status: "AVAILABLE" | "DATA_INCOMPLETE";
  archives: ArchiveRecord[];
}

async function main(): Promise<void> {
  const universe = JSON.parse(await readFile(PIT_UNIVERSE_PATH, "utf8")) as { symbols?: string[] };
  const pitIndex = JSON.parse(await readFile(PIT_INDEX_PATH, "utf8")) as { rootArchiveSymbols?: string[] };
  const seen = new Set(universe.symbols ?? []);
  const rootSymbols = new Set(pitIndex.rootArchiveSymbols ?? []);
  if ((universe.symbols?.length ?? 0) !== 50) throw new Error("V5.9 expected the frozen 50-symbol universe");
  if (V59_UNTOUCHED_SYMBOLS.some((symbol) => seen.has(symbol))) throw new Error("Untouched manifest intersects the prior 50-symbol universe");
  if (V59_UNTOUCHED_SYMBOLS.some((symbol) => !rootSymbols.has(symbol))) throw new Error("Untouched symbol is absent from the frozen Binance archive root index");
  if (V59_UNTOUCHED_SYMBOLS.length < 15) throw new Error("V5.9 requires at least 15 untouched symbols");

  const shouldDownload = process.argv.includes("--download");
  await mkdir(CACHE_ROOT, { recursive: true });
  const periods = monthKeys(V59_UNTOUCHED_START, V59_UNTOUCHED_END);
  const pending = V59_UNTOUCHED_SYMBOLS.flatMap((symbol) => periods.flatMap((period) => TIMEFRAMES.map((timeframe) => ({ symbol, timeframe, period }))));
  const archives = await mapWithConcurrency(pending, 12, (item) => ensureArchive(item.symbol, item.timeframe, item.period, shouldDownload));
  const symbolRecords = V59_UNTOUCHED_SYMBOLS.map((symbol, index) => buildSymbolRecord(symbol, index + 1, archives.filter((record) => record.symbol === symbol)));
  const availableSymbols = symbolRecords.filter((record) => record.status === "AVAILABLE").map((record) => record.symbol);
  const manifestBody = {
    schema: "bca-v5-9-untouched-symbol-manifest-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    manifestId: "v59-binance-untouched-symbols-2023-01-01-2026-07-31",
    frozenAt: FROZEN_AT,
    baselineCommit: V59_BASELINE_COMMIT,
    source: "BINANCE_USDT_M_FUTURES_DATA_VISION",
    sourceRoot: SOURCE_ROOT,
    exchange: "Binance USDT-M Futures",
    period: { start: new Date(V59_UNTOUCHED_START).toISOString(), end: new Date(V59_UNTOUCHED_END).toISOString() },
    timeframes: TIMEFRAMES,
    symbols: [...V59_UNTOUCHED_SYMBOLS],
    availableSymbols,
    coveragePercent: availableSymbols.length / V59_UNTOUCHED_SYMBOLS.length * 100,
    selectionRule: {
      priorUniverse: "Exclude every symbol in data/validation-universe-50.json used by V5.2-V5.8.",
      archiveEligibility: "Symbol must exist in the frozen Binance monthly archive root index and have a complete requested 15m/1h/4h/funding archive window.",
      listingWindow: "Effective listing window is inferred only from archive availability boundaries, with month precision; it is not inferred from strategy outcomes.",
      liquidityProxy: "Pre-registered established perpetual contracts selected by static market/liquidity proxy; no trade return, signal count, or outcome was read for selection.",
      noResultSelection: true,
    },
    priorUniverseProof: {
      source: "data/validation-universe-50.json",
      symbolCount: universe.symbols?.length ?? 0,
      symbols: universe.symbols ?? [],
      sha256: sha256Json(universe.symbols ?? []),
      intersectionCount: V59_UNTOUCHED_SYMBOLS.filter((symbol) => seen.has(symbol)).length,
    },
    execution: {
      signal: "closed 15m candle only",
      entryReference: "next contiguous 15m candle open",
      contiguousBoundary: "execution.openTime == signal.closeTime + 1ms",
      source: "BINANCE_15M_NEXT_BAR_OPEN",
      noLookahead: "The next candle contributes only openTime and open to execution; next high/low/close/volume never affect event detection or features.",
    },
    costs: { takerFeeRate: V59_FEE_RATE, baseSlippageBps: V59_BASE_SLIPPAGE_BPS, riskPerTradeUsdt: V59_RISK_PER_TRADE_USDT, cooldownHours: V59_COOLDOWN_HOURS },
    rawCache: "data/raw/v5-9-untouched-cache/archives (ignored; never committed)",
    archives,
    symbolRecords,
    methodology: [
      "The 20-symbol list, common period, timeframes, execution reference, and cost assumptions were frozen before return outcomes were calculated.",
      "Archive bytes are downloaded and hashed for immutable provenance; this freeze step never parses candles or computes a strategy outcome.",
      "A symbol is AVAILABLE only when every archive in its effective contiguous window is present and non-empty at validation time.",
      "Missing/corrupt immutable cache fail-closes untouched validation to DATA_UNAVAILABLE; no zero-row success is reported.",
    ],
  };
  const manifest = { ...manifestBody, manifestHash: sha256Json(manifestBody) };
  const researchBody = {
    schema: "bca-v5-9-research-manifest-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    manifestId: "v59-purged-meta-label-signal-engine-01",
    frozenAt: FROZEN_AT,
    baselineCommit: V59_BASELINE_COMMIT,
    primary: { id: V59_PRIMARY_EDGE_ID, frozen: true, parameterChange: "NO", role: "UNGATED_COMPARATOR_ONLY" },
    candidateEvents: { families: V59_EVENT_REGISTRY, minimumTarget: ">=500 candidate events", maxEventsPerFamily: V59_MAX_EVENTS_PER_FAMILY, capPolicy: "Deterministic chronological stride cap, applied before outcome labels and independent of returns.", noLegacyFinalFilters: true },
    riskTemplates: { count: V59_RISK_TEMPLATES.length, max: 3, registry: V59_RISK_TEMPLATES },
    featureContract: { maxCoreFeatures: V59_MAX_CORE_FEATURES, names: V59_CORE_FEATURE_NAMES, signalTimestampOnly: true },
    modelRegistry: { count: V59_MODEL_CONFIGS.length, max: 12, configs: V59_MODEL_CONFIGS, ModelA: "LOGISTIC_L2", ModelB: "SHALLOW_TREE" },
    pools: {
      development: { start: new Date(V59_DEV_START).toISOString(), end: new Date(V59_DEV_END).toISOString(), use: "Training and purged nested walk-forward selection only; all prior seen data is development/research." },
      untouched: { manifestId: manifest.manifestId, manifestHash: manifest.manifestHash, use: "One-time final untouched-symbol validation only; excluded from selection." },
    },
    labels: V59_RESEARCH_RULES,
    execution: manifestBody.execution,
    costs: manifestBody.costs,
    productionBoundary: { researchOnly: true, noProductionChange: true, noV55Change: true, noEmailChange: true, noEnvironmentChange: true, noMigration: true, noDeployment: true, noMerge: true, noAutoTrading: true },
  };
  const researchManifest = { ...researchBody, manifestHash: sha256Json(researchBody) };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(RESEARCH_MANIFEST_PATH, `${JSON.stringify(researchManifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_9_manifests_frozen", download: shouldDownload, selected: V59_UNTOUCHED_SYMBOLS.length, available: availableSymbols.length, coveragePercent: manifest.coveragePercent, manifestHash: manifest.manifestHash, researchManifestHash: researchManifest.manifestHash }));
}

function buildSymbolRecord(symbol: string, selectionRank: number, records: ArchiveRecord[]): SymbolRecord {
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
  const status = completePeriods.length > 0
    && completePeriods.every((period, index) => index === 0 || periodAfter(completePeriods[index - 1], period))
    && records.filter((record) => effectivePeriodSet.has(record.period)).length === completePeriods.length * TIMEFRAMES.length
    ? "AVAILABLE" as const
    : "DATA_INCOMPLETE" as const;
  return {
    symbol,
    selectionRank,
    liquidityProxy: "ESTABLISHED_USDT_M_PERPETUAL_STATIC_PROXY",
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

async function ensureArchive(symbol: string, timeframe: V57ExternalTimeframe, period: string, shouldDownload: boolean): Promise<ArchiveRecord> {
  const sourceUrl = externalArchiveUrl(symbol, timeframe, period);
  const relativePath = `data/raw/v5-9-untouched-cache/archives/${symbol}/${timeframe}/${period}.zip`;
  const cachePath = resolve(relativePath);
  try {
    let bytes: Buffer;
    try {
      bytes = await readFile(cachePath);
    } catch {
      if (!shouldDownload) throw new Error("not cached; run freeze-v5-9 with --download");
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

void main();
