import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  calculateLiveSignalUniverseParity,
  type LiveSignalUniverseRow,
  type PitLifecycleSymbol,
} from "@/lib/lfv/live-signal-universe";
import {
  sha256Bytes,
  sha256Text,
  stableStringify,
  type LfvBar,
} from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = process.env.LFV_DATA_ROOT ?? resolve("../../data/raw");
const CACHE_DIR = join(DATA_ROOT, "lfv-001-cache", "live-signal-universe-v2");
const ENDPOINT = "https://fapi.binance.com/fapi/v1/klines";
const INTERVAL = 15 * 60 * 1000;
const WINDOW_BARS = 96;
const LOOKBACK_BARS = 120;
const REQUEST_LIMIT = 1500;
const MAX_CONCURRENCY = 8;
const MIN_REQUEST_INTERVAL_MS = 350;
const LIVE_INPUT = "lfv-001-live-parity-input-v1.json";
const REGISTRY = "lfv-001-archive-registry.json";

configureNodeProxy();

let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

interface ArchiveRegistryReport {
  registrySha256: string;
  symbols: PitLifecycleSymbol[];
  historicalSymbols: string[];
}

interface CachedRequestRecord {
  symbol: string;
  part: number;
  url: string;
  path: string;
  status: number;
  rowCount: number;
  bytes: number;
  sha256: string;
  source: "BINANCE_FAPI_PUBLIC_KLINES";
}

interface LiveCacheManifest {
  schema: "bca-lfv-001-live-signal-universe-cache-v2";
  source: "BINANCE_FAPI_PUBLIC_KLINES";
  endpoint: string;
  interval: "15m";
  range: { start: string; end: string };
  lookbackBars: number;
  requestLimit: number;
  registrySha256: string;
  requests: CachedRequestRecord[];
  errors: string[];
}

function configureNodeProxy(): void {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await scheduleRequest();
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok || response.status === 400 || response.status === 404) return response;
      if (response.status === 418 || response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(60_000, retryAfterSeconds * 1_000)
          : Math.min(60_000, 10_000 * (attempt + 1));
        lastError = new Error(`HTTP_${response.status}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs));
        continue;
      }
      lastError = new Error(`HTTP_${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function scheduleRequest(): Promise<void> {
  const turn = requestQueue.then(async () => {
    const waitMs = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
    lastRequestAt = Date.now();
  });
  requestQueue = turn.catch(() => undefined);
  await turn;
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function requestUrl(symbol: string, startTime: number, endTime: number): string {
  const query = new URLSearchParams({
    symbol,
    interval: "15m",
    startTime: String(startTime),
    endTime: String(endTime),
    limit: String(REQUEST_LIMIT),
  });
  return `${ENDPOINT}?${query.toString()}`;
}

function parseBars(value: unknown): LfvBar[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 8) return [];
    const values = [item[0], item[1], item[2], item[3], item[4], item[5], item[6], item[7]].map(Number);
    if (!values.every(Number.isFinite)) return [];
    return [{
      openTime: values[0],
      open: values[1],
      high: values[2],
      low: values[3],
      close: values[4],
      volume: values[5],
      closeTime: values[6],
      quoteVolume: values[7],
    } satisfies LfvBar];
  });
}

async function readOrFetch(symbol: string, part: number, startTime: number, endTime: number): Promise<{ record: CachedRequestRecord; bars: LfvBar[]; error?: string }> {
  const url = requestUrl(symbol, startTime, endTime);
  const fileName = `${symbol}-${part}.json`;
  const path = join(CACHE_DIR, fileName);
  let body: Buffer;
  let status = 200;
  if (await pathExists(path)) {
    body = await readFile(path);
  } else {
    const response = await fetchWithRetry(url);
    status = response.status;
    body = Buffer.from(await response.arrayBuffer());
    if (status === 200) {
      await mkdir(CACHE_DIR, { recursive: true });
      if (await pathExists(path)) {
        const existing = await readFile(path);
        if (sha256Bytes(existing) !== sha256Bytes(body)) throw new Error(`immutable live cache collision: ${path}`);
      } else {
        await writeFile(path, body);
      }
    }
  }
  const bodyText = body.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    return {
      record: { symbol, part, url, path: `data/raw/lfv-001-cache/live-signal-universe-v2/${fileName}`, status, rowCount: 0, bytes: body.byteLength, sha256: sha256Bytes(body), source: "BINANCE_FAPI_PUBLIC_KLINES" },
      bars: [],
      error: `${symbol}|part${part}|INVALID_JSON|${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const bars = status === 200 ? parseBars(parsed) : [];
  const error = status === 200 || status === 400 || status === 404 ? undefined : `${symbol}|part${part}|HTTP_${status}`;
  return {
    record: { symbol, part, url, path: `data/raw/lfv-001-cache/live-signal-universe-v2/${fileName}`, status, rowCount: bars.length, bytes: body.byteLength, sha256: sha256Bytes(body), source: "BINANCE_FAPI_PUBLIC_KLINES" },
    bars,
    ...(error ? { error } : {}),
  };
}

async function main(): Promise<void> {
  const live = await readJson<{ rows: LiveSignalUniverseRow[] }>(LIVE_INPUT);
  const registry = await readJson<ArchiveRegistryReport>(REGISTRY);
  if (live.rows.length !== 44) throw new Error(`expected 44 frozen live signals, got ${live.rows.length}`);
  const timestamps = live.rows.map((row) => Date.parse(row.sourceDataTimestamp)).filter(Number.isFinite).sort((left, right) => left - right);
  if (timestamps.length !== live.rows.length) throw new Error("live signal source timestamp is invalid");
  const minTimestamp = timestamps[0];
  const maxTimestamp = timestamps.at(-1)!;
  const rangeStart = Math.floor((minTimestamp - LOOKBACK_BARS * INTERVAL) / INTERVAL) * INTERVAL;
  const rangeEnd = Math.ceil((maxTimestamp + 1) / INTERVAL) * INTERVAL - 1;
  const firstPartEnd = Math.min(rangeEnd, rangeStart + REQUEST_LIMIT * INTERVAL - 1);
  const requests = registry.symbols
    .filter((symbol) => symbol.firstObserved && Date.parse(`${symbol.firstObserved}-01T00:00:00.000Z`) <= minTimestamp - 90 * 86_400_000)
    .flatMap((symbol) => [
      { symbol: symbol.symbol, part: 1, startTime: rangeStart, endTime: firstPartEnd },
      ...(firstPartEnd < rangeEnd ? [{ symbol: symbol.symbol, part: 2, startTime: firstPartEnd + 1, endTime: rangeEnd }] : []),
    ]);
  const results = await mapLimit(requests, MAX_CONCURRENCY, async (request, index) => {
    try {
      const result = await readOrFetch(request.symbol, request.part, request.startTime, request.endTime);
      if ((index + 1) % 100 === 0 || index + 1 === requests.length) console.info(JSON.stringify({ stage: "live_signal_universe_fetch", completed: index + 1, total: requests.length }));
      return result;
    } catch (error) {
      const message = `${request.symbol}|part${request.part}|${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      return { record: { symbol: request.symbol, part: request.part, url: requestUrl(request.symbol, request.startTime, request.endTime), path: `data/raw/lfv-001-cache/live-signal-universe-v2/${request.symbol}-${request.part}.json`, status: 0, rowCount: 0, bytes: 0, sha256: sha256Text(message), source: "BINANCE_FAPI_PUBLIC_KLINES" } satisfies CachedRequestRecord, bars: [], error: message };
    }
  });

  const barsBySymbol = new Map<string, LfvBar[]>();
  for (const result of results) {
    const existing = barsBySymbol.get(result.record.symbol) ?? [];
    barsBySymbol.set(result.record.symbol, [...existing, ...result.bars]);
  }
  const dataErrors = results.map((result) => result.error).filter((error): error is string => Boolean(error));
  const parity = calculateLiveSignalUniverseParity({ rows: live.rows, lifecycleSymbols: registry.symbols, barsBySymbol, requestDataErrors: dataErrors });
  const cacheManifest: LiveCacheManifest = {
    schema: "bca-lfv-001-live-signal-universe-cache-v2",
    source: "BINANCE_FAPI_PUBLIC_KLINES",
    endpoint: ENDPOINT,
    interval: "15m",
    range: { start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd).toISOString() },
    lookbackBars: LOOKBACK_BARS,
    requestLimit: REQUEST_LIMIT,
    registrySha256: registry.registrySha256,
    requests: results.map((result) => result.record).sort((left, right) => `${left.symbol}|${left.part}`.localeCompare(`${right.symbol}|${right.part}`)),
    errors: dataErrors.sort(),
  };
  await mkdir(CACHE_DIR, { recursive: true });
  const manifestPath = join(CACHE_DIR, "manifest.json");
  const manifestBody = `${JSON.stringify(cacheManifest, null, 2)}\n`;
  if (await pathExists(manifestPath)) {
    const existing = await readFile(manifestPath, "utf8");
    if (sha256Text(existing) !== sha256Text(manifestBody)) throw new Error("immutable live cache manifest collision");
  } else {
    await writeFile(manifestPath, manifestBody, "utf8");
  }
  const sourceContent = await readFile(resolve(REPORT_DIR, LIVE_INPUT), "utf8");
  const registryContent = await readFile(resolve(REPORT_DIR, REGISTRY), "utf8");
  const reportCore = {
    schema: "bca-lfv-001-live-signal-universe-v2",
    status: parity.pass ? "PASS" : "FAIL",
    code: parity.pass ? null : "LFV_UNIVERSE_PARITY_INSUFFICIENT",
    generatedAt: new Date().toISOString(),
    reconstruction: parity.reconstruction,
    source: {
      endpoint: ENDPOINT,
      exchange: "BINANCE",
      market: "USDⓈ-M perpetual public klines",
      registry: { path: `reports/${REGISTRY}`, sha256: sha256Text(registryContent), registrySha256: registry.registrySha256 },
      liveInput: { path: `reports/${LIVE_INPUT}`, sha256: sha256Text(sourceContent) },
      cacheManifest: { path: "data/raw/lfv-001-cache/live-signal-universe-v2/manifest.json", sha256: sha256Text(manifestBody), requestCount: cacheManifest.requests.length },
    },
    frozenWindow: {
      signalTimestamps: [...new Set(timestamps)].map((timestamp) => new Date(timestamp).toISOString()),
      rangeStart: new Date(rangeStart).toISOString(),
      rangeEnd: new Date(rangeEnd).toISOString(),
      interval: "15m",
      barsPerSignalWindow: WINDOW_BARS,
      lookbackBarsDownloaded: LOOKBACK_BARS,
      closedBarBoundary: "bar.closeTime < source_data_timestamp",
      ranking: "rolling 24h quote volume descending, symbol ascending; top min(100,N)",
    },
    lifecycle: {
      minimumAgeDays: 90,
      firstObservedSource: "official archive registry month; no current exchangeInfo or current survivor filter",
      inactiveTreatment: "symbols without a complete PIT 96-bar window are conservatively excluded from the active eligible set",
      futureLifecycleFilter: "NO",
    },
    dataCoverage: parity.dataCoverage,
    snapshots: parity.snapshots,
    observedParityDiagnostic: {
      source: "reports/lfv-001-universe-parity.json",
      snapshotsCompared: 111,
      medianTop100Overlap: 1,
      p10Top100Overlap: 1,
      rankSpearman: 0.9999864412420502,
      treatment: "unchanged observed snapshot parity diagnostic; live signal reconstruction is independent of observedUniverseSymbols",
    },
    thresholds: { signalCoverage: 0.95, signalInclusionRecall: 0.98 },
    pass: parity.pass,
    reasons: parity.reasons,
    returnsRead: false,
    methodology: [
      "Every frozen live row is keyed by source_data_timestamp plus symbol; scan_group_key is not used for inclusion mapping.",
      "The frozen official archive registry supplies the historical candidate symbol set and month-level PIT lifecycle; current active-universe data is not used.",
      "Only the union envelope of the 120-bar lookback windows for the 44 frozen timestamps was read from the official public Binance 15m klines endpoint; no new full historical month was downloaded.",
      "A symbol is active at T only when its 96 bars with closeTime < T are complete, contiguous 15m bars with finite non-negative quote volume; top min(100,N) is then selected by rolling 24h quote volume.",
      "HTTP/data errors remain coverage errors; inactive or delisted symbols with no complete PIT window are excluded conservatively and are not forward-filled or synthesized.",
    ],
  };
  const report = { ...reportCore, reportSha256: sha256Text(stableStringify(reportCore)) };
  await writeFile(resolve(REPORT_DIR, "lfv-001-live-signal-universe-v2.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "live-signal-universe", status: report.status, code: report.code, dataCoverage: parity.dataCoverage, reasons: parity.reasons }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
