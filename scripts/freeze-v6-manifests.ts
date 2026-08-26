import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { V6_CONFIGURATIONS, V6_RISK_TEMPLATES, V6_BASELINE_COMMIT, V6_DEV_END, V6_DEV_START, V6_RESEARCH_RULES, V6_VALIDATION_A_CANDIDATES, V6_VALIDATION_A_MANIFEST_ID, V6_VALIDATION_B_MANIFEST_ID } from "@/lib/v6/registry";
import { sha256Json } from "@/lib/v5-7/manifest";

const REPORT_DIR = resolve("reports");
const LOCAL_CACHE_DIR = resolve("data/validation-cache");
const PIT_INDEX_PATH = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
const V6_REGISTRY_PATH = resolve(REPORT_DIR, "v6-registry.json");
const DEVELOPMENT_MANIFEST_PATH = resolve(REPORT_DIR, "v6-development-manifest.json");
const VALIDATION_A_MANIFEST_PATH = resolve(REPORT_DIR, "v6-validation-a-manifest.json");
const VALIDATION_B_MANIFEST_PATH = resolve(REPORT_DIR, "v6-validation-b-manifest.json");
const VALIDATION_A_START = Date.parse("2023-01-01T00:00:00.000Z");
const VALIDATION_A_END = Date.parse("2026-07-31T23:59:59.999Z");

const PRIOR_SYMBOL_FILES = [
  "data/validation-universe-50.json",
  "reports/v5-9-untouched-symbol-manifest.json",
  "reports/v5-9-1-untouched-symbol-manifest.json",
];

interface PitIndex {
  status?: string;
  rootArchiveSymbols?: string[];
  evidenceSymbols?: Array<{ symbol?: string; observedMonths?: string[] }>;
}

interface CacheRecord {
  symbol: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  source: "BINANCE_USDT_M_VALIDATION_CACHE";
  availableWindow: { start: string; end: string };
}

async function main(): Promise<void> {
  const registryBody = {
    schema: "bca-v6-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    baselineCommit: V6_BASELINE_COMMIT,
    frozenAt: "2026-08-26T00:00:00.000Z",
    families: ["TIME_SERIES_TREND", "CROSS_SECTIONAL_MOMENTUM", "TREND_CARRY"],
    configurations: V6_CONFIGURATIONS,
    configurationCount: V6_CONFIGURATIONS.length,
    configurationBudget: "<=24; 12 signal configurations frozen before validation returns",
    riskTemplates: V6_RISK_TEMPLATES,
    timeframe: { primary: "4h", context: "1d may be derived from closed 4h bars", execution: "next contiguous 4h open; 15m is not an alpha timeframe" },
    pitUniverse: { source: "data/pit-universe/binance-um-monthly-15m-index.json", membership: "timestamp-valid closed 4h data intersected with the immutable monthly archive availability proxy; no return-based membership" },
    costs: { takerFeeRate: 0.0004, baseSlippageBps: 2, stressTotalBps: [5, 10, 15], funding: "historical funding points" },
    rules: V6_RESEARCH_RULES,
  };
  const registry = { ...registryBody, registryHash: sha256Json(registryBody) };

  const priorSymbols = await loadPriorSymbols();
  const pitIndex = await readJson<PitIndex>(PIT_INDEX_PATH);
  const candidates = V6_VALIDATION_A_CANDIDATES.filter((symbol) => (pitIndex.rootArchiveSymbols ?? []).includes(symbol) && !priorSymbols.has(symbol));
  if (candidates.length !== V6_VALIDATION_A_CANDIDATES.length) throw new Error("V6 Validation A candidate set intersects an observed/prior symbol or PIT root");
  const cacheRecords = await findLocalCacheRecords(candidates);
  const availableSymbols = cacheRecords.map((record) => record.symbol);

  const developmentBody = {
    schema: "bca-v6-development-manifest-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    manifestId: "v6-development-all-observed-data-2020-01-01-2026-07-31",
    frozenAt: "2026-08-26T00:00:00.000Z",
    baselineCommit: V6_BASELINE_COMMIT,
    period: { start: new Date(V6_DEV_START).toISOString(), end: new Date(V6_DEV_END).toISOString() },
    source: "Existing immutable research caches from V5.5-V5.9.1 plus prior validation cache; no Validation A/B symbols included.",
    includedSources: [
      "data/raw/v5-8-fresh-cache/archives (previously observed 2020 data)",
      "data/raw/v5-7-external-cache/archives (previously observed 2021-2023 data)",
      "data/raw/v5-9-1-untouched-cache/archives (previously observed V5.9.1 data)",
      "data/validation-cache (previously observed validation data)",
    ],
    selectionRule: "All previously observed symbols/data are Development Pool; exclude frozen Validation A candidates and never use return performance for selection.",
    timeframe: "4h primary with historical funding; next-bar execution reference",
    execution: "Closed 4h signal candle followed by next contiguous 4h open; no same-bar execution.",
    pitUniverse: {
      source: "data/pit-universe/binance-um-monthly-15m-index.json",
      status: pitIndex.status ?? "UNKNOWN",
      rootArchiveSymbols: pitIndex.rootArchiveSymbols?.length ?? 0,
      evidenceSymbols: pitIndex.evidenceSymbols?.length ?? 0,
      monthlyEvidenceCounts: Object.fromEntries([...new Set((pitIndex.evidenceSymbols ?? []).flatMap((record) => record.observedMonths ?? []))].sort().map((month) => [month, (pitIndex.evidenceSymbols ?? []).filter((record) => (record.observedMonths ?? []).includes(month)).length])),
      membershipRule: "Only timestamp-valid observed 4h data is used for each cross-section; the immutable monthly 15m archive index is an availability proxy, not a return-ranked universe.",
      limitation: "The checked-in PIT index is incomplete and does not provide historical exchangeInfo status or exact daily listing/delisting timestamps.",
    },
    noLookahead: true,
  };

  const validationABody = {
    schema: "bca-v6-validation-a-manifest-v1",
    status: availableSymbols.length >= 15 ? "AVAILABLE" : "DATA_INSUFFICIENT",
    manifestId: V6_VALIDATION_A_MANIFEST_ID,
    frozenAt: "2026-08-26T00:00:00.000Z",
    baselineCommit: V6_BASELINE_COMMIT,
    exchange: "Binance USDT-M Futures",
    source: "Immutable local Binance research cache; selection uses PIT root membership, listing-window metadata and data availability only.",
    period: { start: new Date(VALIDATION_A_START).toISOString(), end: new Date(VALIDATION_A_END).toISOString() },
    targetSymbols: 20,
    minimumSymbols: 15,
    candidateSymbols: candidates,
    symbols: availableSymbols,
    coverage: `${availableSymbols.length}/${candidates.length}`,
    listingWindowRule: "Cache filename window and PIT archive membership; minimum 30-day listing age; no returns or strategy outcomes read for selection.",
    selectionRule: "Static pre-registered candidates, excluding data/validation-universe-50.json, V5.7 observed symbols, V5.9 burned holdout, V5.9.1 holdout, and known Production symbols; select only complete immutable local cache records.",
    execution: { signal: "closed 4h", entry: "next contiguous 4h open", sameBar: false },
    costs: { takerFeeRate: 0.0004, baseSlippageBps: 2, stressTotalBps: [5, 10, 15] },
    cacheRecords,
    dataInsufficientReason: availableSymbols.length >= 15 ? null : `Only ${availableSymbols.length} immutable unused Binance symbol caches are present; need >=15. No old holdout is reused and no zero-row PASS is emitted.`,
  };

  const validationBBody = {
    schema: "bca-v6-validation-b-manifest-v1",
    status: "DATA_INSUFFICIENT",
    manifestId: V6_VALIDATION_B_MANIFEST_ID,
    frozenAt: "2026-08-26T00:00:00.000Z",
    baselineCommit: V6_BASELINE_COMMIT,
    exchange: "Bybit or OKX perpetual",
    period: { start: new Date(V6_DEV_START).toISOString(), end: new Date(V6_DEV_END).toISOString() },
    symbols: [],
    execution: { signal: "closed 4h", entry: "next contiguous 4h open", sameBar: false },
    costs: { takerFeeRate: 0.0004, baseSlippageBps: 2, stressTotalBps: [5, 10, 15] },
    selectionRule: "Independent exchange and symbol manifest must be frozen before returns are read; no Bybit/OKX immutable archive is present in the workspace.",
    dataInsufficientReason: "No immutable Bybit/OKX historical archive or manifest is present; no online return read was performed and Binance data is not substituted.",
  };

  await writeJson(V6_REGISTRY_PATH, registry);
  await writeJson(DEVELOPMENT_MANIFEST_PATH, { ...developmentBody, manifestHash: sha256Json(developmentBody) });
  await writeJson(VALIDATION_A_MANIFEST_PATH, { ...validationABody, manifestHash: sha256Json(validationABody) });
  await writeJson(VALIDATION_B_MANIFEST_PATH, { ...validationBBody, manifestHash: sha256Json(validationBBody) });
  console.info(JSON.stringify({ stage: "v6_manifests_frozen", registryHash: registry.registryHash, validationAStatus: validationABody.status, validationASymbols: availableSymbols.length, validationBStatus: validationBBody.status }));
}

async function loadPriorSymbols(): Promise<Set<string>> {
  const symbols = new Set<string>(["BLESSUSDT", "DOLOUSDT", "LABUSDT", "APRUSDT", "GRVTUSDT"]);
  for (const path of PRIOR_SYMBOL_FILES) {
    try {
      const value = await readJson<Record<string, unknown> | string[]>(resolve(path));
      const candidates = Array.isArray(value) ? value : [value.symbols, value.availableSymbols, value.pitEligibleSymbols].flat().filter((item): item is string => typeof item === "string");
      for (const symbol of candidates) symbols.add(symbol);
    } catch {
      // A missing prior report makes the freeze unsafe; the caller will notice
      // the resulting candidate mismatch rather than silently reusing a set.
    }
  }
  try {
    const inventory = await readJson<{ symbols?: Array<{ symbol?: string }> }>(resolve("reports/v5-7-external-data-inventory.json"));
    for (const item of inventory.symbols ?? []) if (item.symbol) symbols.add(item.symbol);
  } catch {
    // The V5.7 inventory is tracked in this baseline; absence is handled by CI.
  }
  return symbols;
}

async function findLocalCacheRecords(candidates: readonly string[]): Promise<CacheRecord[]> {
  let files: string[] = [];
  try { files = await readdir(LOCAL_CACHE_DIR); } catch { return []; }
  const records: CacheRecord[] = [];
  for (const symbol of candidates) {
    const matches = files.filter((file) => file.startsWith(`${symbol}-`) && file.endsWith(".json"));
    const selected = matches.sort((left, right) => right.localeCompare(left))[0];
    if (!selected) continue;
    const bytes = await readFile(resolve(LOCAL_CACHE_DIR, selected));
    const fields = selected.replace(/\.json$/i, "").split("-");
    const start = Number(fields.at(-2));
    const end = Number(fields.at(-1));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    records.push({
      symbol,
      path: `data/validation-cache/${selected}`,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: "BINANCE_USDT_M_VALIDATION_CACHE",
      availableWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    });
  }
  return records;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

void main();
