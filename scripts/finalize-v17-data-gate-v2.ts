import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMaterializedArchives, readJson, sha256, V17_BASELINE, V17_BRANCH, V17_CACHE_MANIFEST_PATH, V17_DATA_ROOT, V17_INVENTORY_PATH, V17_PARSER_REPORT_PATH, type V17CacheManifest, type V17OfficialInventory, type V17ParserReport } from "../lib/v17/data";
import { buildPreReturnAssessment, type V17PreReturnAssessment } from "../lib/v17/pre-return";

const REPORT_DIR = resolve("reports");
const FREEZE_PATH = resolve(REPORT_DIR, "v17-data-freeze-v2.json");
const GATE_PATH = resolve(REPORT_DIR, "v17-data-gate-v2.json");
const EVALUATION_START = Date.parse("2022-01-01T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-07-31T23:59:59.999Z");

async function fileSha256(path: string): Promise<string> { return sha256(await readFile(path)); }
async function writeJson(name: string, value: unknown): Promise<void> { await mkdir(REPORT_DIR, { recursive: true }); await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function minBySymbol(parser: V17ParserReport, key: "coverage"): number { return Math.min(parser.bySymbol.BTCUSDT.candles15m[key], parser.bySymbol.ETHUSDT.candles15m[key]); }
function fundingValidity(parser: V17ParserReport): boolean { return Object.values(parser.bySymbol).every((symbol) => symbol.funding.invalidRows === 0 && symbol.funding.rows === symbol.funding.validRows); }
function archiveChecks(inventory: V17OfficialInventory, cache: V17CacheManifest, parser: V17ParserReport): Record<string, boolean> {
  return {
    officialArchiveInventoryComplete: inventory.enumerationComplete && inventory.records.length === inventory.expectedSlots,
    usedZipChecksumCoverage: cache.verifiedArchiveSlots === inventory.expectedSlots && cache.records.every((record) => record.status === "CHECKSUM_VERIFIED" || record.status === "PARSED"),
    parsedArchiveSlots: parser.archiveSlots.parseComplete && parser.archiveSlots.checksumVerified === inventory.expectedSlots,
    kline15mCoverage: Object.values(parser.bySymbol).every((symbol) => symbol.candles15m.coverage >= 0.995 && symbol.candles15m.duplicateOpenTimes === 0 && symbol.candles15m.nonMonotonicOpenTimes === 0 && symbol.candles15m.cadencePass),
    kline1hCoverage: Object.values(parser.bySymbol).every((symbol) => symbol.candles1h.coverage >= 0.995 && symbol.candles1h.duplicateOpenTimes === 0 && symbol.candles1h.nonMonotonicOpenTimes === 0 && symbol.candles1h.cadencePass),
    fundingRowValidity: fundingValidity(parser),
    fundingTimestampMonotonicity: Object.values(parser.bySymbol).every((symbol) => symbol.funding.timestampMonotonic && symbol.funding.duplicateTimestamps === 0),
    noSyntheticFallback: parser.noSyntheticFallback && parser.source.noSyntheticData && parser.source.noForwardFill,
  };
}

function correctedGates(archive: Record<string, boolean>, assessment: V17PreReturnAssessment): Record<string, boolean> {
  const { counts, coverage } = assessment;
  return {
    ...archive,
    evaluationHistoryUsesMinimum90d: counts.pitHistoryAvailableEvaluationEvents > 0 && counts.evaluationNotEligibleUnder90d === 0,
    priceAtFundingCoverage: coverage.priceAtFunding.coverage >= 0.99,
    preReturn8hCoverage: coverage.preReturn8h.coverage >= 0.99,
    postFunding30mCoverage: coverage.postFunding30m.coverage >= 0.99,
    referenceExtremeEventsAvailable: counts.referenceExtremeEvaluationEvents > 0,
    responseQ50Availability: counts.responseQ50AvailableEvaluationEvents > 0,
    primaryCandidatesAvailable: counts.primaryCandidateEvaluationEvents > 0,
    candidateEntryCoverage: coverage.candidateEntry.coverage >= 0.99,
    candidateAtr14Coverage: coverage.candidateAtr14.coverage >= 0.99,
    candidateSettlementMarkCoverage: coverage.candidateSettlementMarks.coverage === 1,
  };
}

function boundaries(): Record<string, string> { return { productionChanged: "NO", productionEmail: "OFF", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" }; }

async function main(): Promise<void> {
  const freeze = await readJson<Record<string, unknown>>(FREEZE_PATH);
  if (freeze.baseline !== V17_BASELINE || freeze.branch !== V17_BRANCH || freeze.schema !== "v17-data-freeze-v2" || freeze.status !== "FROZEN_BEFORE_RETURNS" || freeze.historicalReturnsRead !== false) throw new Error("V17 data freeze v2 is not valid or claims returns were read");
  const inventory = await readJson<V17OfficialInventory>(V17_INVENTORY_PATH);
  const cache = await readJson<V17CacheManifest>(V17_CACHE_MANIFEST_PATH);
  const parser = await readJson<V17ParserReport>(V17_PARSER_REPORT_PATH);
  const rawCache = await readJson<V17CacheManifest>(resolve(V17_DATA_ROOT, "manifest.json"));
  const parsed = await parseMaterializedArchives(rawCache);
  const assessment = buildPreReturnAssessment(parsed.datasets);
  const archive = archiveChecks(inventory, cache, parser);
  const gates = correctedGates(archive, assessment);
  const reasons = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
  const gate = {
    schema: "v17-data-gate-v2",
    baseline: V17_BASELINE,
    branch: V17_BRANCH,
    freezeSha256: freeze.manifestSha256,
    source: "Binance Data Vision USD-M official monthly archives; existing checksum-verified cache only",
    evaluationPeriod: { start: new Date(EVALUATION_START).toISOString(), end: new Date(EVALUATION_END).toISOString() },
    provenance: { inventorySha256: await fileSha256(resolve(REPORT_DIR, "v17-official-inventory.json")), cacheManifestSha256: await fileSha256(resolve(REPORT_DIR, "v17-cache-manifest.json")), parserReportSha256: await fileSha256(resolve(REPORT_DIR, "v17-parser-report.json")), noRedownload: true, noRematerialize: true },
    counts: assessment.counts,
    coverage: { fifteenMinute: minBySymbol(parser, "coverage"), oneHour: Math.min(parser.bySymbol.BTCUSDT.candles1h.coverage, parser.bySymbol.ETHUSDT.candles1h.coverage), funding: Math.min(...Object.values(parser.bySymbol).map((symbol) => symbol.funding.rows ? symbol.funding.validRows / symbol.funding.rows : 0)), ...assessment.coverage },
    candidateTimestamps: assessment.candidateTimestamps,
    semantics: assessment.semantics,
    gates,
    status: reasons.length ? "FAIL" : "PASS",
    classification: reasons.length ? "V17_DATA_INSUFFICIENT_FINAL" : "DATA_GATE_PASS",
    reasons,
    historicalReturnsRead: false,
    boundaries: boundaries(),
  };
  await writeJson("v17-data-gate-v2.json", gate);
  console.info(JSON.stringify({ phase: "v17-data-gate-v2", status: gate.status, classification: gate.classification, reasons, counts: assessment.counts, coverage: assessment.coverage, historicalReturnsRead: false }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
