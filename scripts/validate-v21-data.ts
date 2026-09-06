import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BOUNDARIES,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_END_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_EXPECTED_ARCHIVE_SLOTS,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_FORBIDDEN_PATHS,
  V21_MONTH_COUNT,
  V21_REPORT_FILES,
  V21_REPOSITORY,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
  monthPeriod,
  v21MonthKeys,
} from "../lib/v21/constants";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";

const REPORT_DIR = resolve("reports");

async function main(): Promise<void> {
  const archiveManifest = await readJson("v21-archive-manifest.json");
  const parserReport = await readJson("v21-parser-report.json");
  const dataGate = await readJson("v21-data-gate.json");
  const stageManifest = await readJson("v21-data-stage-manifest.json");

  assertEqual(stageManifest.schemaVersion, "v21-data-stage-manifest-v1", "stage manifest schema");
  assertEqual(stageManifest.experimentId, V21_EXPERIMENT_ID, "stage experiment");
  assertEqual(stageManifest.repository, V21_REPOSITORY, "stage repository");
  assertEqual(stageManifest.baseSha, V21_BASE_SHA, "stage base SHA");
  assertEqual(stageManifest.branch, V21_BRANCH, "stage branch");
  assertArrayEqual(stageManifest.fixedSymbols, V21_SYMBOLS, "stage symbols");
  assertEqual(stageManifest.period.start, V21_START_TIMESTAMP, "stage period start");
  assertEqual(stageManifest.period.endInclusive, V21_END_TIMESTAMP, "stage period end");
  assertEqual(stageManifest.period.endExclusive, V21_END_EXCLUSIVE_TIMESTAMP, "stage period end exclusive");
  assertEqual(stageManifest.expectedArchiveSlots, V21_EXPECTED_ARCHIVE_SLOTS, "stage slot count");
  assertEqual(stageManifest.checksumVerifiedArchiveSlots, archiveManifest.checksumVerifiedArchiveSlots, "stage checksum count");

  assertEqual(archiveManifest.schemaVersion, "v21-archive-manifest-v1", "archive schema");
  assertEqual(archiveManifest.source, "official Binance Data Vision", "archive source");
  assertEqual(archiveManifest.exchange, "BINANCE_DATA_VISION", "archive exchange");
  assertEqual(archiveManifest.dataType, "regular", "archive data type");
  assertEqual(archiveManifest.interval, "5m", "archive interval");
  assertArrayEqual(archiveManifest.fixedSymbols, V21_SYMBOLS, "archive symbols");
  assertEqual(archiveManifest.expectedArchiveSlots, V21_EXPECTED_ARCHIVE_SLOTS, "archive slot count");
  assertEqual(archiveManifest.expectedMonthsPerSymbol, V21_MONTH_COUNT, "archive month count");
  assertEqual(archiveManifest.expectedRowsPerSymbol, V21_EXPECTED_ROWS_PER_SYMBOL, "archive expected rows");
  assertEqual(archiveManifest.immutableCache, true, "archive immutable cache");
  assertEqual(archiveManifest.noApiBackfill, true, "archive no API backfill");
  assertEqual(archiveManifest.noSyntheticRows, true, "archive no synthetic rows");
  assertEqual(archiveManifest.noForwardFill, true, "archive no forward fill");

  const expectedIdentity = new Set(V21_SYMBOLS.flatMap((symbol) => v21MonthKeys().map((month) => `${symbol}/${month}`)));
  const seenIdentity = new Set<string>();
  assertEqual(archiveManifest.archiveSlots.length, V21_EXPECTED_ARCHIVE_SLOTS, "archive slot records");
  for (const slot of archiveManifest.archiveSlots as Array<Record<string, unknown>>) {
    const symbol = String(slot.symbol);
    const month = String(slot.month);
    const identity = `${symbol}/${month}`;
    assert(expectedIdentity.has(identity), `unexpected archive identity ${identity}`);
    assert(!seenIdentity.has(identity), `duplicate archive identity ${identity}`);
    seenIdentity.add(identity);
    assertEqual(slot.url, `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`, `${identity} URL`);
    assertEqual(slot.checksumUrl, `${slot.url}.CHECKSUM`, `${identity} checksum URL`);
    assertEqual(slot.exchange, "BINANCE_DATA_VISION", `${identity} exchange`);
    assertEqual(slot.dataType, "regular", `${identity} data type`);
    assertEqual(slot.interval, "5m", `${identity} interval`);
    const period = monthPeriod(month);
    assertEqual(slot.periodStart, new Date(period.start).toISOString(), `${identity} period start`);
    assertEqual(slot.periodEndExclusive, new Date(period.endExclusive).toISOString(), `${identity} period end`);
    assert(typeof slot.bytes === "number" && slot.bytes >= 0, `${identity} byte count`);
    assert(typeof slot.sha256 === "string" || slot.sha256 === null, `${identity} raw SHA`);
    assert(typeof slot.expectedSha256 === "string" || slot.expectedSha256 === null, `${identity} expected SHA`);
    assert(typeof slot.parserErrors === "object" && Array.isArray(slot.parserErrors), `${identity} parser errors`);
  }
  assertEqual(seenIdentity.size, expectedIdentity.size, "archive identity coverage");
  assertEqual(archiveManifest.checksumVerifiedArchiveSlots, (archiveManifest.archiveSlots as Array<Record<string, unknown>>).filter((slot) => slot.checksumVerified === true).length, "archive checksum count");
  assertEqual(archiveManifest.verifiedArchiveSlots, (archiveManifest.archiveSlots as Array<Record<string, unknown>>).filter((slot) => slot.status === "VERIFIED").length, "archive verified count");

  assertEqual(parserReport.schemaVersion, "v21-parser-report-v1", "parser schema");
  assertEqual(parserReport.experimentId, V21_EXPERIMENT_ID, "parser experiment");
  assertArrayEqual(parserReport.parserContract.requiredFields, ["symbol", "openTime", "open", "high", "low", "close", "closeTime"], "parser required fields");
  assertEqual(parserReport.parserContract.duplicateOpenTime, 0, "parser duplicate contract");
  assertEqual(parserReport.bySymbol.length, V21_SYMBOLS.length, "parser symbol coverage records");
  for (const symbol of V21_SYMBOLS) {
    const coverage = (parserReport.bySymbol as Array<Record<string, unknown>>).find((value) => value.symbol === symbol);
    assert(coverage !== undefined, `missing parser coverage for ${symbol}`);
    assertEqual(coverage.expectedRows, V21_EXPECTED_ROWS_PER_SYMBOL, `${symbol} expected rows`);
  }

  assertEqual(dataGate.schemaVersion, "v21-data-gate-v1", "data gate schema");
  assertEqual(dataGate.experimentId, V21_EXPERIMENT_ID, "data gate experiment");
  assertEqual(dataGate.expectedArchiveSlots, V21_EXPECTED_ARCHIVE_SLOTS, "data gate slots");
  assertEqual(dataGate.expectedRowsPerSymbol, V21_EXPECTED_ROWS_PER_SYMBOL, "data gate rows");
  assertEqual(dataGate.coverageRequirement, 1, "data gate coverage requirement");
  assertArrayEqual(dataGate.fixedSymbols, V21_SYMBOLS, "data gate symbols");
  assert(dataGate.status === "PASS" || dataGate.status === "FAIL", "data gate status");
  if (dataGate.status === "FAIL") assertEqual(dataGate.classification, "V21_REGULAR_KLINE_DATA_INSUFFICIENT", "data gate fail classification");
  if (dataGate.status === "PASS") assertEqual(dataGate.classification, "V21_REGULAR_KLINE_DATA_GATE_PASS", "data gate pass classification");
  assertEqual(dataGate.failClosed, dataGate.status === "FAIL", "data gate fail closed");

  const expectedFlags = V21_BOUNDARIES as Record<string, unknown>;
  for (const [key, value] of Object.entries(expectedFlags)) assertEqual(stageManifest[key], value, `boundary ${key}`);
  assertEqual(stageManifest.flags, expectedFlags, "boundary flags object");
  assertEqual(stageManifest.freezeCreated, false, "freeze boundary");
  assertEqual(stageManifest.resultCommitCreated, false, "result boundary");
  assertEqual(stageManifest.productionEmail, "OFF", "email boundary");

  const expectedReportHashes: Record<string, string> = {
    "reports/v21-archive-manifest.json": canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-archive-manifest.json"), "utf8")),
    "reports/v21-parser-report.json": canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-parser-report.json"), "utf8")),
    "reports/v21-data-gate.json": canonicalTextSha256(await readFile(resolve(REPORT_DIR, "v21-data-gate.json"), "utf8")),
  };
  assertEqual(stageManifest.archiveManifestSha256, expectedReportHashes["reports/v21-archive-manifest.json"], "archive report hash");
  assertEqual(stageManifest.parserReportSha256, expectedReportHashes["reports/v21-parser-report.json"], "parser report hash");
  assertEqual(stageManifest.dataGateSha256, expectedReportHashes["reports/v21-data-gate.json"], "data gate report hash");
  const manifestBody = { ...stageManifest };
  delete manifestBody.manifestBodySha256;
  assertEqual(stageManifest.manifestBodySha256, sha256(manifestBody), "data stage manifest body hash");

  for (const forbidden of V21_FORBIDDEN_PATHS) assert(!existsSync(resolve(forbidden)), `forbidden V21 artifact exists: ${forbidden}`);
  const reportNames = await readdir(REPORT_DIR);
  const unexpectedV21Reports = reportNames.filter((name) => name.startsWith("v21-")
    && name !== "v21-feature-stage-manifest.json"
    && !V21_REPORT_FILES.some((file) => file === `reports/${name}`));
  assertEqual(unexpectedV21Reports.length, 0, "unexpected V21 report artifacts");

  console.info(`V21 data validation PASS (${dataGate.status})`);
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`V21 validation failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`V21 validation failed: ${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertArrayEqual(actual: unknown, expected: unknown, message: string): void {
  assert(Array.isArray(actual), `${message}: expected array`);
  assertEqual(actual, expected, message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
