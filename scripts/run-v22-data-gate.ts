import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeQuality, addSynchronizationQuality, intersectTimestampSets, passesHardGate, parseBinanceKlineCsv, parseOkxResponseBodies } from "@/lib/v22/data";
import { V22_END_MS, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS, type V22Candle, type V22Symbol } from "@/lib/v22/types";

const BINANCE_ROOT = resolve("data/raw/v22/binance");
const OKX_ROOT = resolve("data/raw/v22/okx");
const REPORT_DIR = resolve("reports");

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readBinance(symbol: V22Symbol): Promise<V22Candle[]> {
  const directory = resolve(BINANCE_ROOT, symbol);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".csv")).sort();
  const candles: V22Candle[] = [];
  for (const name of names) candles.push(...parseBinanceKlineCsv(await readFile(resolve(directory, name), "utf8"), symbol));
  return candles;
}

async function readOkx(symbol: V22Symbol): Promise<V22Candle[]> {
  const path = resolve(OKX_ROOT, symbol, `${symbol}-5m.ndjson`);
  const bodies = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  return parseOkxResponseBodies(bodies, symbol);
}

function summarizeBinanceManifest(manifest: unknown, symbol: V22Symbol): unknown {
  if (!manifest || typeof manifest !== "object") return null;
  const value = manifest as { source?: string; interval?: string; artifacts?: Array<Record<string, unknown>> };
  return {
    source: value.source,
    interval: value.interval,
    artifacts: (value.artifacts ?? []).filter((artifact) => artifact.symbol === symbol).map((artifact) => ({
      symbol: artifact.symbol,
      month: artifact.month,
      url: artifact.url,
      checksumUrl: artifact.checksumUrl,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      officialChecksum: artifact.officialChecksum,
      downloadStatus: artifact.downloadStatus ?? "PASS",
    })),
  };
}

function summarizeOkxManifest(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== "object") return null;
  const value = manifest as { source?: string; instrument?: string; interval?: string; start?: string; endExclusive?: string; bodyByteLength?: number; responseCount?: number; responses?: Array<Record<string, unknown>> };
  return {
    source: value.source,
    instrument: value.instrument,
    interval: value.interval,
    start: value.start,
    endExclusive: value.endExclusive,
    bodyByteLength: value.bodyByteLength,
    responseCount: value.responseCount,
    responses: (value.responses ?? []).map((response) => ({
      request: response.request,
      line: response.line,
      byteLength: response.byteLength,
      sha256: response.sha256,
      firstTimestamp: response.firstTimestamp,
      lastTimestamp: response.lastTimestamp,
      rows: response.rows,
    })),
  };
}

function emptyQuality() {
  return analyzeQuality([], V22_START_MS, V22_END_MS);
}

async function main(): Promise<void> {
  const inventory: Record<string, unknown> = {
    schema: "v22-data-inventory-v1",
    experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY",
    interval: "5m",
    start: new Date(V22_START_MS).toISOString(),
    endExclusive: new Date(V22_END_MS).toISOString(),
    sourcePolicy: {
      binance: "Binance Data Vision official USD-M monthly archives with official CHECKSUM",
      okx: "OKX official public market history-candles API; immutable response pages",
      thirdPartyData: false,
    },
    symbols: {},
  };
  const gateSymbols: Record<string, unknown> = {};
  for (const symbol of V22_SYMBOLS) {
    let binance: V22Candle[] = [];
    let okx: V22Candle[] = [];
    let binanceManifest: unknown = null;
    let okxManifest: unknown = null;
    try {
      binance = await readBinance(symbol);
      binanceManifest = await jsonFile(resolve(BINANCE_ROOT, symbol, "..", "manifest.json")).catch(() => null);
    } catch {
      binance = [];
    }
    try {
      okx = await readOkx(symbol);
      okxManifest = await jsonFile(resolve(OKX_ROOT, symbol, "manifest.json")).catch(() => null);
    } catch {
      okx = [];
    }
    const binanceQuality = binance.length ? analyzeQuality(binance, V22_START_MS, V22_END_MS) : emptyQuality();
    const okxQuality = okx.length ? analyzeQuality(okx, V22_START_MS, V22_END_MS) : emptyQuality();
    const intersectionRows = intersectTimestampSets(binance, okx).length;
    const synchronized = addSynchronizationQuality(binanceQuality, intersectionRows, V22_START_MS, V22_END_MS);
    const gateQuality = {
      ...synchronized,
      okxCoverageRatio: okxQuality.coverageRatio,
      okxDuplicates: okxQuality.duplicates,
      okxNonMonotonic: okxQuality.nonMonotonic,
      okxInvalidRows: okxQuality.invalidRows,
      okxMaxContiguousMissingMinutes: okxQuality.maxContiguousMissingMinutes,
      okxFirstTimestamp: okxQuality.firstTimestamp,
      okxLastTimestamp: okxQuality.lastTimestamp,
      okxPrimaryCoverage: okxQuality.primaryCoverage,
      okxHoldoutACoverage: okxQuality.holdoutACoverage,
      okxHoldoutBCoverage: okxQuality.holdoutBCoverage,
      okxExpected5mRows: okxQuality.expected5mRows,
      okxActualRows: okxQuality.actualRows,
    };
    const okxPass = okxQuality.coverageRatio >= 0.999 && okxQuality.duplicates === 0 && okxQuality.nonMonotonic === 0 && okxQuality.invalidRows === 0 && okxQuality.maxContiguousMissingMinutes <= 15;
    const pass = passesHardGate(gateQuality) && okxPass;
    inventory.symbols = {
      ...(inventory.symbols as Record<string, unknown>),
      [symbol]: {
        binanceInstrument: symbol,
        okxInstrument: V22_OKX_INSTRUMENTS[symbol],
        binanceManifest: summarizeBinanceManifest(binanceManifest, symbol),
        okxManifest: summarizeOkxManifest(okxManifest),
        binance: binanceQuality,
        okx: okxQuality,
        exactTimestampIntersectionRows: intersectionRows,
        synchronizedCoverageRatio: synchronized.synchronizedCoverageRatio,
      },
    };
    gateSymbols[symbol] = {
      binanceRows: binanceQuality.actualRows,
      binanceCoverage: binanceQuality.coverageRatio,
      okxRows: okxQuality.actualRows,
      okxCoverage: okxQuality.coverageRatio,
      synchronizedRows: intersectionRows,
      synchronizedCoverage: synchronized.synchronizedCoverageRatio,
      duplicates: binanceQuality.duplicates + okxQuality.duplicates,
      invalidRows: binanceQuality.invalidRows + okxQuality.invalidRows,
      maxContiguousMissingMinutes: Math.max(binanceQuality.maxContiguousMissingMinutes, okxQuality.maxContiguousMissingMinutes),
      pass,
    };
  }
  const allPass = V22_SYMBOLS.every((symbol) => (gateSymbols[symbol] as { pass: boolean }).pass);
  const gate = {
    schema: "v22-data-gate-v1",
    experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY",
    policy: {
      requiredCoverage: 0.999,
      maxContiguousMissingMinutes: 15,
      fixedSymbols: [...V22_SYMBOLS],
      noSymbolReplacement: true,
      noGapRepair: true,
      synchronizedByExactTimestampIntersection: true,
    },
    symbols: gateSymbols,
    allSymbolsPass: allPass,
    classification: allPass ? "V22_CROSS_VENUE_DATA_GATE_PASS" : "V22_CROSS_VENUE_DATA_INSUFFICIENT",
    researchStop: !allPass,
    budgetConsumed: 1,
    remainingBudget: 2,
    noPerformanceAnalysis: true,
  };
  await writeFile(resolve(REPORT_DIR, "v22-data-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-data-gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v22_data_gate_complete", allSymbolsPass: allPass, classification: gate.classification }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
