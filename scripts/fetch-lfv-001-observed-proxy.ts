import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const REPORT_PATH = resolve("reports/lfv-001-observed-universe-evidence-v1.json");
const DATA_ROOT = resolve("../../data/raw/lfv-001-cache/observed-universe-rest");
const OUTPUT_PATH = resolve(DATA_ROOT, "2026-08-25_to_2026-08-27_15m.json");
const RETRY_OUTPUT_PATH = resolve(DATA_ROOT, "2026-08-25_to_2026-08-27_15m_retry.json");
const INTERVAL_MS = 15 * 60 * 1000;

interface ObservedReport {
  groups: Array<{ scanGroupKey: string; scanTimestamp: string; observedRankedSymbols: string[] }>;
}

interface ApiBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
}

function configureProxy(): void {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
}

async function fetchSymbol(symbol: string, startTime: number, endTime: number): Promise<{ symbol: string; bars: ApiBar[]; error?: string }> {
  try {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "15m");
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1500");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { symbol, bars: [], error: `HTTP ${response.status}` };
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows)) return { symbol, bars: [], error: "Kline response was not an array" };
    const bars = rows.flatMap((row): ApiBar[] => {
      if (!Array.isArray(row) || row.length < 8) return [];
      const values = row.slice(0, 8).map(Number);
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
      }];
    });
    return { symbol, bars };
  } catch (error) {
    return { symbol, bars: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchSymbolWithRetry(symbol: string, startTime: number, endTime: number): Promise<{ symbol: string; bars: ApiBar[]; error?: string }> {
  let result = await fetchSymbol(symbol, startTime, endTime);
  for (let attempt = 1; attempt <= 4 && result.error; attempt += 1) {
    if (!result.error.includes("HTTP 418") && !result.error.includes("HTTP 429")) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000 * attempt));
    result = await fetchSymbol(symbol, startTime, endTime);
  }
  return result;
}

async function main(): Promise<void> {
  configureProxy();
  if (process.argv.includes("--retry-missing")) {
    const existing = JSON.parse(await readFile(OUTPUT_PATH, "utf8")) as {
      startTime: string;
      endTime: string;
      results: Array<{ symbol: string; bars: ApiBar[]; error?: string }>;
    };
    try {
      await stat(RETRY_OUTPUT_PATH);
      throw new Error(`Refusing to overwrite immutable retry cache: ${RETRY_OUTPUT_PATH}`);
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
    const startTime = Date.parse(existing.startTime);
    const endTime = Date.parse(existing.endTime);
    const missing = existing.results.filter((result) => result.error || result.bars.length < 96).map((result) => result.symbol);
    const results: Array<{ symbol: string; bars: ApiBar[]; error?: string }> = Array(missing.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= missing.length) return;
        results[index] = await fetchSymbolWithRetry(missing[index], startTime, endTime);
        if ((index + 1) % 25 === 0 || index + 1 === missing.length) console.info(JSON.stringify({ completed: index + 1, total: missing.length }));
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    await mkdir(DATA_ROOT, { recursive: true });
    await writeFile(RETRY_OUTPUT_PATH, `${JSON.stringify({
      schema: "bca-lfv-001-observed-universe-rest-retry-cache-v1",
      source: "https://fapi.binance.com/fapi/v1/klines",
      exchange: "BINANCE",
      interval: "15m",
      startTime: existing.startTime,
      endTime: existing.endTime,
      queryPolicy: "retry only prior 418/429/incomplete public responses; never overwrite the first immutable cache",
      capturedAt: new Date().toISOString(),
      results,
    }, null, 2)}\n`, "utf8");
    console.info(JSON.stringify({ output: RETRY_OUTPUT_PATH, symbols: missing.length, errors: results.filter((result) => result.error).length }, null, 2));
    return;
  }
  try {
    await stat(OUTPUT_PATH);
    throw new Error(`Refusing to overwrite immutable observed proxy cache: ${OUTPUT_PATH}`);
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  }
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8")) as ObservedReport;
  const timestamps = report.groups.map((group) => Date.parse(group.scanGroupKey)).filter(Number.isFinite);
  const startTime = Math.min(...timestamps) - 96 * INTERVAL_MS;
  const endTime = Math.max(...timestamps) + INTERVAL_MS - 1;
  const symbols = [...new Set(report.groups.flatMap((group) => group.observedRankedSymbols))].sort();
  const results: Array<{ symbol: string; bars: ApiBar[]; error?: string }> = Array(symbols.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= symbols.length) return;
      results[index] = await fetchSymbol(symbols[index], startTime, endTime);
      if ((index + 1) % 50 === 0 || index + 1 === symbols.length) console.info(JSON.stringify({ completed: index + 1, total: symbols.length }));
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify({
    schema: "bca-lfv-001-observed-universe-rest-cache-v1",
    source: "https://fapi.binance.com/fapi/v1/klines",
    exchange: "BINANCE",
    interval: "15m",
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    queryPolicy: "one public request per observed symbol; no current ticker, no future bars, closeTime < scan timestamp at evaluation",
    capturedAt: new Date().toISOString(),
    results,
  }, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ output: OUTPUT_PATH, symbols: symbols.length, errors: results.filter((result) => result.error).length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
