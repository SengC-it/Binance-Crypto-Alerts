import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BOUNDARIES,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_END_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_EXPECTED_ARCHIVE_SLOTS,
  V21_FORBIDDEN_PATHS,
  V21_MONTH_COUNT,
  V21_REPORT_FILES,
  V21_REPOSITORY,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  v21MonthKeys,
} from "../lib/v21/constants";
import {
  V21_ARCHIVE_EXCHANGE,
  V21_ARCHIVE_ROOT,
  downloadAndParseV21Archive,
  evaluateV21SymbolCoverage,
  type V21ArchiveSlot,
} from "../lib/v21/archive";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";

const REPORT_DIR = resolve("reports");
const CONCURRENCY = 6;
const SOURCE_FILES = [
  "lib/v21/constants.ts",
  "lib/v21/canonical.ts",
  "lib/v21/archive.ts",
  "scripts/run-v21-data-stage.ts",
  "scripts/validate-v21-data.ts",
  "tests/v21-data.test.ts",
  "package.json",
] as const;

async function main(): Promise<void> {
  assertFreezeBase();
  await mkdir(REPORT_DIR, { recursive: true });

  const months = v21MonthKeys();
  const tasks = V21_SYMBOLS.flatMap((symbol) => months.map((month) => ({ symbol, month })));
  const slots = await mapWithConcurrency(tasks, CONCURRENCY, async ({ symbol, month }) => {
    const result = await downloadAndParseV21Archive(symbol, month, { rootDir: V21_ARCHIVE_ROOT });
    return result.slot;
  });
  slots.sort(slotOrder);

  const archiveManifest = {
    schemaVersion: "v21-archive-manifest-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    baseSha: V21_BASE_SHA,
    branch: V21_BRANCH,
    source: "official Binance Data Vision",
    exchange: V21_ARCHIVE_EXCHANGE,
    market: "USD-M Futures",
    dataType: "regular",
    interval: "5m",
    period: {
      start: V21_START_TIMESTAMP,
      endInclusive: V21_END_TIMESTAMP,
      endExclusive: V21_END_EXCLUSIVE_TIMESTAMP,
    },
    fixedSymbols: V21_SYMBOLS,
    expectedArchiveSlots: V21_EXPECTED_ARCHIVE_SLOTS,
    expectedMonthsPerSymbol: V21_MONTH_COUNT,
    expectedRowsPerSymbol: V21_EXPECTED_ROWS_PER_SYMBOL,
    immutableCache: true,
    noApiBackfill: true,
    noSyntheticRows: true,
    noForwardFill: true,
    archiveSlots: slots,
    checksumVerifiedArchiveSlots: slots.filter((slot) => slot.checksumVerified).length,
    verifiedArchiveSlots: slots.filter((slot) => slot.status === "VERIFIED").length,
  };
  await writeJson("v21-archive-manifest.json", archiveManifest);

  const coverageBySymbol = V21_SYMBOLS.map((symbol) => evaluateV21SymbolCoverage(symbol, slots));
  const parserReport = {
    schemaVersion: "v21-parser-report-v1",
    experimentId: V21_EXPERIMENT_ID,
    parserContract: {
      requiredFields: ["symbol", "openTime", "open", "high", "low", "close", "closeTime"],
      optionalFields: ["volume", "quoteVolume", "tradeCount"],
      openTime: "safe integer, 5m aligned, within month",
      closeTime: "openTime + 5m - 1ms",
      ohlc: "finite, positive, high >= max(open, close), low <= min(open, close)",
      monotonicTimestamps: true,
      duplicateOpenTime: 0,
      internalGaps: "recorded as cadenceErrors; never filled",
      invalidRows: "recorded in parserErrors; never silently accepted",
    },
    bySymbol: coverageBySymbol,
    byArchive: slots.map((slot) => ({
      symbol: slot.symbol,
      month: slot.month,
      status: slot.status,
      rowCount: slot.rowCount,
      expectedMonthRows: slot.expectedMonthRows,
      coverage: slot.coverage,
      parserErrors: slot.parserErrors,
      duplicateOpenTimes: slot.duplicateOpenTimes,
      internalGaps: slot.cadenceErrors,
      monotonic: slot.monotonicOpenTime,
      checksumVerified: slot.checksumVerified,
      error: slot.error,
    })),
    anomalies: slots.filter((slot) => slot.status !== "VERIFIED"
      || slot.parserErrors.length > 0
      || slot.duplicateOpenTimes > 0
      || slot.cadenceErrors > 0).map((slot) => ({
        symbol: slot.symbol,
        month: slot.month,
        status: slot.status,
        parserErrors: slot.parserErrors,
        duplicateOpenTimes: slot.duplicateOpenTimes,
        internalGaps: slot.cadenceErrors,
        error: slot.error,
      })),
  };
  await writeJson("v21-parser-report.json", parserReport);

  const dataGatePassed = slots.length === V21_EXPECTED_ARCHIVE_SLOTS
    && slots.every((slot) => slot.checksumVerified)
    && coverageBySymbol.every((coverage) => coverage.pass);
  const dataGate = {
    schemaVersion: "v21-data-gate-v1",
    experimentId: V21_EXPERIMENT_ID,
    source: "official Binance Data Vision only",
    exchange: V21_ARCHIVE_EXCHANGE,
    dataType: "regular",
    interval: "5m",
    fixedSymbols: V21_SYMBOLS,
    expectedArchiveSlots: V21_EXPECTED_ARCHIVE_SLOTS,
    archiveSlots: slots.length,
    checksumVerifiedArchiveSlots: slots.filter((slot) => slot.checksumVerified).length,
    expectedRowsPerSymbol: V21_EXPECTED_ROWS_PER_SYMBOL,
    coverageRequirement: 1,
    bySymbol: coverageBySymbol,
    status: dataGatePassed ? "PASS" : "FAIL",
    classification: dataGatePassed ? "V21_REGULAR_KLINE_DATA_GATE_PASS" : "V21_REGULAR_KLINE_DATA_INSUFFICIENT",
    failClosed: !dataGatePassed,
    featuresComputed: false,
    signalsEnumerated: false,
    historicalReturnsRead: false,
    forwardReturnsRead: false,
    oosMetricsRead: false,
    holdoutRead: false,
    parameterSearch: false,
  } as const;
  await writeJson("v21-data-gate.json", dataGate);

  const reportHashes = await hashReports();
  const sourceHashes = await hashSources();
  const manifestBody = {
    schemaVersion: "v21-data-stage-manifest-v1",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    baseSha: V21_BASE_SHA,
    branch: V21_BRANCH,
    fixedSymbols: V21_SYMBOLS,
    period: {
      start: V21_START_TIMESTAMP,
      endInclusive: V21_END_TIMESTAMP,
      endExclusive: V21_END_EXCLUSIVE_TIMESTAMP,
    },
    expectedArchiveSlots: V21_EXPECTED_ARCHIVE_SLOTS,
    checksumVerifiedArchiveSlots: slots.filter((slot) => slot.checksumVerified).length,
    archiveManifestSha256: reportHashes["reports/v21-archive-manifest.json"],
    parserReportSha256: reportHashes["reports/v21-parser-report.json"],
    dataGateSha256: reportHashes["reports/v21-data-gate.json"],
    dataGate: {
      status: dataGate.status,
      classification: dataGate.classification,
    },
    sourceHashes,
    flags: V21_BOUNDARIES,
    ...V21_BOUNDARIES,
    sourceFiles: SOURCE_FILES,
    forbiddenPaths: V21_FORBIDDEN_PATHS,
  };
  await writeJson("v21-data-stage-manifest.json", {
    ...manifestBody,
    manifestBodySha256: sha256(manifestBody),
  });

  console.info(`V21 Data Gate: ${dataGate.status} (${dataGate.classification})`);
  console.info(`V21 checksum verified slots: ${archiveManifest.checksumVerifiedArchiveSlots}/${V21_EXPECTED_ARCHIVE_SLOTS}`);
  console.info(`V21 data-stage manifestBodySha256: ${sha256(manifestBody)}`);
}

function assertFreezeBase(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== V21_BRANCH) throw new Error(`V21 data stage requires ${V21_BRANCH}, got ${branch}`);
  if (head !== V21_BASE_SHA) throw new Error(`V21 data stage requires exact base ${V21_BASE_SHA}, got ${head}`);
}

async function hashReports(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const report of V21_REPORT_FILES.slice(0, 3)) {
    hashes[report] = canonicalTextSha256(await readFile(resolve(report), "utf8"));
  }
  return hashes;
}

async function hashSources(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const source of SOURCE_FILES) hashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  return hashes;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slotOrder(left: V21ArchiveSlot, right: V21ArchiveSlot): number {
  const symbolOrder = V21_SYMBOLS.indexOf(left.symbol) - V21_SYMBOLS.indexOf(right.symbol);
  return symbolOrder || left.month.localeCompare(right.month);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
