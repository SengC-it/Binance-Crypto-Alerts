import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeQuality, addSynchronizationQuality, intersectTimestampSets, parseBinanceKlineCsv, parseOkxResponseBodies, sha256 } from "@/lib/v22/data";
import { secureRevalidateOkxResponses, splitNdjsonLines, verifyBinanceArtifact, verifyOkxFrozenLines, type BinanceProvenance, type OkxLineAudit } from "@/lib/v22/provenance";
import { V22_END_MS, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS, type V22Candle, type V22Symbol } from "@/lib/v22/types";

const BINANCE_ROOT = resolve("data/raw/v22/binance");
const OKX_ROOT = resolve("data/raw/v22/okx");
const REPORT_DIR = resolve("reports");

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function failedBinance(symbol: V22Symbol, month: string, error: unknown): BinanceProvenance {
  return {
    symbol,
    month,
    zipSha256: "",
    officialChecksum: "",
    checksumVerified: false,
    archiveEntryName: null,
    extractedCsvSha256: "",
    extractedCsvByteLength: 0,
    freshExtractionSha256: null,
    freshExtractionByteLength: null,
    extractedCsvVerifiedAgainstZip: false,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function failedOkxLine(manifest: { request: string; byteLength: number; sha256: string }, line: number, error: unknown): OkxLineAudit {
  return {
    line,
    request: manifest.request,
    manifestByteLength: manifest.byteLength,
    actualByteLength: 0,
    manifestSha256: manifest.sha256,
    actualSha256: "",
    byteHashVerified: false,
    responseCode: null,
    rows: 0,
    rowsValid: false,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function sourceSummary(quality: ReturnType<typeof analyzeQuality>) {
  return {
    rows: quality.actualRows,
    coverage: quality.coverageRatio,
    transportDuplicateRows: quality.transportDuplicateRows,
    exactIdenticalDuplicateRows: quality.exactIdenticalDuplicateRows,
    conflictingDuplicateRows: quality.conflictingDuplicateRows,
    canonicalDuplicateRows: quality.canonicalDuplicateRows,
    sourceOrderNonMonotonic: quality.sourceOrderNonMonotonic,
    canonicalNonMonotonic: quality.canonicalNonMonotonic,
    invalidRows: quality.invalidRows,
    maxGap: quality.maxContiguousMissingMinutes,
    primaryCoverage: quality.primaryCoverage,
    holdoutACoverage: quality.holdoutACoverage,
    holdoutBCoverage: quality.holdoutBCoverage,
  };
}

async function readBinance(symbol: V22Symbol): Promise<{ candles: V22Candle[]; provenance: BinanceProvenance[]; passed: boolean }> {
  const directory = resolve(BINANCE_ROOT, symbol);
  const rawManifest = await jsonFile<{ artifacts?: Array<Record<string, unknown>> }>(resolve(BINANCE_ROOT, "manifest.json"));
  const artifacts = (rawManifest.artifacts ?? []).filter((artifact) => artifact.symbol === symbol).sort((left, right) => String(left.month).localeCompare(String(right.month)));
  const provenance: BinanceProvenance[] = [];
  let nextArtifact = 0;
  const verified = new Array<BinanceProvenance>(artifacts.length);
  async function worker(): Promise<void> {
    while (nextArtifact < artifacts.length) {
      const index = nextArtifact;
      nextArtifact += 1;
      const artifact = artifacts[index]!;
      try {
        verified[index] = await verifyBinanceArtifact({ symbol, month: String(artifact.month), zipPath: String(artifact.zipPath), checksumPath: String(artifact.checksumPath), extractedCsvPath: String(artifact.extractedCsv) });
      } catch (error) {
        verified[index] = failedBinance(symbol, String(artifact.month), error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, artifacts.length)) }, () => worker()));
  provenance.push(...verified.filter((artifact): artifact is BinanceProvenance => artifact !== undefined));
  provenance.sort((left, right) => left.month.localeCompare(right.month));
  const passed = provenance.length === 37 && provenance.every((artifact) => artifact.pass);
  if (!passed) return { candles: [], provenance, passed };
  const candles: V22Candle[] = [];
  for (const artifact of provenance) {
    const original = artifacts.find((candidate) => String(candidate.month) === artifact.month);
    if (!original) throw new Error(`Binance manifest artifact missing after verification: ${artifact.month}`);
    candles.push(...parseBinanceKlineCsv(await readFile(String(original.extractedCsv), "utf8"), symbol));
  }
  return { candles, provenance, passed };
}

async function readOkx(symbol: V22Symbol): Promise<{
  candles: V22Candle[];
  lines: Buffer[];
  lineAudit: OkxLineAudit[];
  secure: Awaited<ReturnType<typeof secureRevalidateOkxResponses>>;
  manifest: { source?: string; instrument?: string; interval?: string; responseCount?: number; responses?: Array<{ request: string; byteLength: number; sha256: string }> };
}> {
  const directory = resolve(OKX_ROOT, symbol);
  const bodyBytes = await readFile(resolve(directory, `${symbol}-5m.ndjson`));
  const manifest = await jsonFile<{ source?: string; instrument?: string; interval?: string; responseCount?: number; responses?: Array<{ request: string; byteLength: number; sha256: string }> }>(resolve(directory, "manifest.json"));
  const frozen = verifyOkxFrozenLines({ bodyBytes, responses: manifest.responses ?? [] });
  const lines = splitNdjsonLines(bodyBytes);
  if (!frozen.pass) {
    return { candles: [], lines, lineAudit: frozen.lines, secure: { attempted: 0, succeeded: 0, failed: manifest.responses?.length ?? 0, parsedRowsEqual: 0, mismatches: [{ line: 0, request: "", reason: "frozen OKX body provenance failed" }], pass: false }, manifest };
  }
  const secure = await secureRevalidateOkxResponses({ lines, responses: manifest.responses ?? [], concurrency: 4 });
  const parsed = parseOkxResponseBodies(lines.map((line) => line.toString("utf8")), symbol);
  return { candles: parsed.candles, lines, lineAudit: frozen.lines, secure, manifest };
}

function gatePass(binanceQuality: ReturnType<typeof analyzeQuality>, okxQuality: ReturnType<typeof analyzeQuality>, okxSecurePass: boolean, binanceProvenancePass: boolean, synchronizedCoverage: number): boolean {
  const synchronized = synchronizedCoverage >= 0.999;
  return (
    binanceQuality.coverageRatio >= 0.999 &&
    okxQuality.coverageRatio >= 0.999 &&
    synchronized &&
    binanceQuality.conflictingDuplicateRows === 0 &&
    binanceQuality.canonicalDuplicateRows === 0 &&
    binanceQuality.canonicalNonMonotonic === 0 &&
    binanceQuality.invalidRows === 0 &&
    binanceQuality.maxContiguousMissingMinutes <= 15 &&
    okxQuality.conflictingDuplicateRows === 0 &&
    okxQuality.canonicalDuplicateRows === 0 &&
    okxQuality.canonicalNonMonotonic === 0 &&
    okxQuality.invalidRows === 0 &&
    okxQuality.maxContiguousMissingMinutes <= 15 &&
    okxSecurePass &&
    binanceProvenancePass
  );
}

async function main(): Promise<void> {
  const inventory: Record<string, unknown> = {
    schema: "v22-data-inventory-v2",
    experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY",
    interval: "5m",
    start: new Date(V22_START_MS).toISOString(),
    endExclusive: new Date(V22_END_MS).toISOString(),
    expectedRows: 324576,
    sourcePolicy: {
      binance: "Binance Data Vision official USD-M monthly archives with official CHECKSUM and fresh in-memory ZIP extraction",
      okx: "OKX official public market history-candles API; immutable response pages with secure full revalidation",
      thirdPartyData: false,
      noInsecureTransport: true,
    },
    symbols: {},
  };
  const gateSymbols: Record<string, unknown> = {};
  const provenanceSymbols: Record<string, unknown> = {};
  await Promise.all(V22_SYMBOLS.map(async (symbol) => {
    let binance = { candles: [] as V22Candle[], provenance: [] as BinanceProvenance[], passed: false };
    let okx: Awaited<ReturnType<typeof readOkx>> | null = null;
    try { binance = await readBinance(symbol); } catch (error) { binance = { candles: [], provenance: [failedBinance(symbol, "manifest", error)], passed: false }; }
    try { okx = await readOkx(symbol); } catch (error) {
      okx = {
        candles: [], lines: [], lineAudit: [],
        secure: { attempted: 0, succeeded: 0, failed: 1, parsedRowsEqual: 0, mismatches: [{ line: 0, request: "", reason: error instanceof Error ? error.message : String(error) }], pass: false },
        manifest: {},
      };
    }
    const binanceQuality = analyzeQuality(binance.candles, V22_START_MS, V22_END_MS);
    const okxParsed = okx.candles.length ? parseOkxResponseBodies(okx.lines.map((line) => line.toString("utf8")), symbol) : { candles: [], audit: { sourceOrderNonMonotonic: 0, canonicalNonMonotonic: 0, transportDuplicateRows: 0, exactIdenticalDuplicateRows: 0, conflictingDuplicateRows: 0, canonicalDuplicateRows: 0 } };
    const okxQuality = analyzeQuality(okxParsed.candles, V22_START_MS, V22_END_MS, okxParsed.audit);
    const intersectionRows = intersectTimestampSets(binance.candles, okxParsed.candles, V22_START_MS, V22_END_MS).length;
    const synchronized = addSynchronizationQuality(binanceQuality, intersectionRows, V22_START_MS, V22_END_MS);
    const pass = gatePass(binanceQuality, okxQuality, okx.secure.pass, binance.passed, synchronized.synchronizedCoverageRatio ?? 0);
    inventory.symbols = {
      ...(inventory.symbols as Record<string, unknown>),
      [symbol]: {
        binanceInstrument: symbol,
        okxInstrument: V22_OKX_INSTRUMENTS[symbol],
        binance: sourceSummary(binanceQuality),
        okx: {
          ...sourceSummary(okxQuality),
          transportDuplicateRows: okxQuality.transportDuplicateRows,
          exactIdenticalDuplicateRows: okxQuality.exactIdenticalDuplicateRows,
          conflictingDuplicateRows: okxQuality.conflictingDuplicateRows,
          canonicalDuplicateRows: okxQuality.canonicalDuplicateRows,
          secureHistoricalRevalidation: okx.secure.pass,
          secureResponses: okx.secure.succeeded,
          secureFailures: okx.secure.failed,
        },
        exactTimestampIntersectionRows: intersectionRows,
        synchronizedCoverageRatio: synchronized.synchronizedCoverageRatio,
        pass,
      },
    };
    gateSymbols[symbol] = {
      binanceRows: binanceQuality.actualRows,
      binanceCoverage: binanceQuality.coverageRatio,
      binanceDuplicates: binanceQuality.transportDuplicateRows,
      binanceExactIdenticalDuplicateRows: binanceQuality.exactIdenticalDuplicateRows,
      binanceConflictingDuplicateRows: binanceQuality.conflictingDuplicateRows,
      binanceCanonicalDuplicateRows: binanceQuality.canonicalDuplicateRows,
      binanceNonMonotonic: binanceQuality.canonicalNonMonotonic,
      binanceSourceOrderNonMonotonic: binanceQuality.sourceOrderNonMonotonic,
      binanceInvalidRows: binanceQuality.invalidRows,
      binanceMaxGap: binanceQuality.maxContiguousMissingMinutes,
      okxRows: okxQuality.actualRows,
      okxCoverage: okxQuality.coverageRatio,
      okxTransportDuplicateRows: okxQuality.transportDuplicateRows,
      okxExactIdenticalDuplicateRows: okxQuality.exactIdenticalDuplicateRows,
      okxConflictingDuplicateRows: okxQuality.conflictingDuplicateRows,
      okxCanonicalDuplicateRows: okxQuality.canonicalDuplicateRows,
      okxSourceOrderNonMonotonic: okxQuality.sourceOrderNonMonotonic,
      okxCanonicalNonMonotonic: okxQuality.canonicalNonMonotonic,
      okxInvalidRows: okxQuality.invalidRows,
      okxMaxGap: okxQuality.maxContiguousMissingMinutes,
      synchronizedRows: intersectionRows,
      synchronizedCoverage: synchronized.synchronizedCoverageRatio,
      primaryCoverage: { binance: binanceQuality.primaryCoverage, okx: okxQuality.primaryCoverage },
      holdoutACoverage: { binance: binanceQuality.holdoutACoverage, okx: okxQuality.holdoutACoverage },
      holdoutBCoverage: { binance: binanceQuality.holdoutBCoverage, okx: okxQuality.holdoutBCoverage },
      provenancePass: binance.passed && okx.secure.pass,
      pass,
    };
    provenanceSymbols[symbol] = {
      binance: binance.provenance,
      okx: {
        source: okx.manifest.source,
        instrument: okx.manifest.instrument,
        interval: okx.manifest.interval,
        bodySha256: sha256(await readFile(resolve(OKX_ROOT, symbol, `${symbol}-5m.ndjson`))),
        lineCount: okx.lines.length,
        responseCount: okx.manifest.responseCount ?? 0,
        allResponseHashesVerified: okx.lineAudit.length > 0 && okx.lineAudit.every((line) => line.pass),
        lines: okx.lineAudit,
        secureHistoricalRevalidation: okx.secure,
      },
    };
  }));
  const allPass = V22_SYMBOLS.every((symbol) => (gateSymbols[symbol] as { pass: boolean }).pass);
  const gate = {
    schema: "v22-data-gate-v2",
    experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY",
    policy: {
      requiredCoverage: 0.999,
      maxContiguousMissingMinutes: 15,
      expectedRows: 324576,
      fixedSymbols: [...V22_SYMBOLS],
      noSymbolReplacement: true,
      noGapRepair: true,
      exactFrozenRange: { startMs: V22_START_MS, endExclusiveMs: V22_END_MS },
      synchronizedByExactTimestampIntersection: true,
      noInsecureTransport: true,
    },
    symbols: gateSymbols,
    allSymbolsPass: allPass,
    classification: allPass ? "V22_CROSS_VENUE_DATA_GATE_PASS" : Object.values(gateSymbols).some((row) => !(row as { provenancePass: boolean }).provenancePass) ? "V22_SOURCE_PROVENANCE_FAIL" : "V22_CROSS_VENUE_DATA_INSUFFICIENT",
    researchStop: !allPass,
    budgetBefore: 3,
    budgetConsumed: 1,
    remainingResearchBudget: 2,
    noPerformanceAnalysis: true,
  };
  await writeFile(resolve(REPORT_DIR, "v22-source-provenance.json"), `${JSON.stringify({ schema: "v22-source-provenance-v1", experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY", frozenRange: { start: new Date(V22_START_MS).toISOString(), endExclusive: new Date(V22_END_MS).toISOString() }, symbols: provenanceSymbols, allSymbolsPass: allPass }, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-data-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-data-gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v22_data_gate_complete", allSymbolsPass: allPass, classification: gate.classification }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
