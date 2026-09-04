import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { V17_CACHE_MANIFEST_PATH, V17_INVENTORY_PATH, V17_PARSER_REPORT_PATH, V17_BASELINE, V17_BRANCH, readJson, sha256, type V17CacheManifest, type V17OfficialInventory, type V17ParserReport } from "../lib/v17/data";

const REPORT_DIR = resolve("reports");
const FREEZE_PATH = resolve(REPORT_DIR, "v17-freeze-manifest.json");
const GATE_PATH = resolve(REPORT_DIR, "v17-data-gate.json");
const RESULT_NAMES = ["v17-primary-oos.json", "v17-yearly.json", "v17-holdouts.json", "v17-instrument-sides.json", "v17-directions.json", "v17-placebos.json", "v17-cost.json", "v17-manual-delay.json", "v17-fixed-horizon.json", "v17-confidence.json", "v17-email-utility.json"];

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileSha256(path: string): Promise<string> { return sha256(await readFile(path)); }

function minBySymbol(report: V17ParserReport, key: "coverage"): number {
  return Math.min(report.bySymbol.BTCUSDT.candles15m[key], report.bySymbol.ETHUSDT.candles15m[key]);
}

function gatesFor(inventory: V17OfficialInventory, cache: V17CacheManifest, parser: V17ParserReport): Record<string, boolean> {
  return {
    officialArchiveInventoryComplete: inventory.enumerationComplete && inventory.records.length === inventory.expectedSlots,
    usedZipChecksumCoverage: cache.verifiedArchiveSlots === inventory.expectedSlots && cache.records.every((record) => record.status === "CHECKSUM_VERIFIED" || record.status === "PARSED"),
    kline15mCoverage: Object.values(parser.bySymbol).every((symbol) => symbol.candles15m.coverage >= 0.995 && symbol.candles15m.duplicateOpenTimes === 0 && symbol.candles15m.nonMonotonicOpenTimes === 0 && symbol.candles15m.cadencePass),
    kline1hCoverage: Object.values(parser.bySymbol).every((symbol) => symbol.candles1h.coverage >= 0.995 && symbol.candles1h.duplicateOpenTimes === 0 && symbol.candles1h.nonMonotonicOpenTimes === 0 && symbol.candles1h.cadencePass),
    fundingRowValidity: Object.values(parser.bySymbol).every((symbol) => symbol.funding.invalidRows === 0 && symbol.funding.rows === symbol.funding.validRows),
    fundingTimestampMonotonicity: Object.values(parser.bySymbol).every((symbol) => symbol.funding.timestampMonotonic && symbol.funding.duplicateTimestamps === 0),
    markSettlementCoverage: parser.fundingSettlement.coverage === 1,
    pit180dFundingHistory: parser.pit180dFundingHistory.coverage >= 0.99,
    preReturn8hAvailability: parser.preReturn8h.coverage >= 0.99,
    postFunding30mAvailability: parser.postFunding30m.coverage >= 0.99,
    executionPriceCoverage: parser.executionPrice.coverage >= 0.99,
    atrAvailability: parser.atr14.coverage >= 0.99,
    noSyntheticFallback: parser.noSyntheticFallback && parser.source.noSyntheticData && parser.source.noForwardFill,
  };
}

function boundaries(): Record<string, string> {
  return { productionChanged: "NO", productionEmail: "OFF", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" };
}

async function writeFailClosedArtifacts(gate: Record<string, unknown>, freeze: Record<string, unknown>): Promise<void> {
  const reason = `DATA_GATE_FAIL: ${(gate.reasons as string[]).join(", ")}`;
  const notRun = { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
  for (const name of RESULT_NAMES) await writeJson(name, notRun);
  await writeJson("v17-validation-summary.json", { schema: "v17-validation-summary-v1", baseline: V17_BASELINE, branch: V17_BRANCH, freezeSha256: freeze.manifestSha256, dataGate: "FAIL", historicalReturnsRead: false, result: "V17_DATA_INSUFFICIENT_FINAL", emailPromotionCandidate: "FAIL", researchStop: "YES", reason, reasons: gate.reasons, primaryOos: null, yearly: null, holdouts: null, btc: null, eth: null, crowdedLongShort: null, crowdedShortLong: null, placebos: null, costs: null, manualDelay: null, fixedHorizon: null, confidence: null, emailUtility: null, boundaries: boundaries() });
  await writeJson("v17-promotion-decision.json", { schema: "v17-promotion-decision-v1", classification: "V17_DATA_INSUFFICIENT_FINAL", dataGate: "FAIL", historicalReturnsRead: false, emailPromotionCandidate: "FAIL", researchStop: "YES", reasons: gate.reasons, boundaries: boundaries() });
  await writeJson("v17-promotion-decision.md", { classification: "V17_DATA_INSUFFICIENT_FINAL", dataGate: "FAIL", historicalReturns: "NOT READ", promotion: "FAIL", researchStop: "YES", boundaries: boundaries() });
}

async function main(): Promise<void> {
  const freeze = await readJson<Record<string, unknown>>(FREEZE_PATH);
  if (freeze.baseline !== V17_BASELINE || freeze.branch !== V17_BRANCH || freeze.status !== "FROZEN_BEFORE_RETURNS" || freeze.historicalReturnsRead !== false) throw new Error("V17 Freeze is not valid or claims returns were read");
  const inventory = await readJson<V17OfficialInventory>(V17_INVENTORY_PATH);
  const cache = await readJson<V17CacheManifest>(V17_CACHE_MANIFEST_PATH);
  const parser = await readJson<V17ParserReport>(V17_PARSER_REPORT_PATH);
  await writeJson("v17-official-inventory.json", inventory);
  await writeJson("v17-cache-manifest.json", cache);
  await writeJson("v17-parser-report.json", parser);
  const gates = gatesFor(inventory, cache, parser);
  const reasons = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
  const gate = { schema: "v17-data-gate-v1", baseline: V17_BASELINE, branch: V17_BRANCH, source: "Binance Data Vision USD-M official monthly archives", inventorySha256: await fileSha256(V17_INVENTORY_PATH), cacheManifestSha256: await fileSha256(V17_CACHE_MANIFEST_PATH), parserReportSha256: await fileSha256(V17_PARSER_REPORT_PATH), expectedArchiveSlots: inventory.expectedSlots, verifiedArchiveSlots: cache.verifiedArchiveSlots, coverage: { fifteenMinute: minBySymbol(parser, "coverage"), oneHour: Math.min(parser.bySymbol.BTCUSDT.candles1h.coverage, parser.bySymbol.ETHUSDT.candles1h.coverage), funding: Math.min(...Object.values(parser.bySymbol).map((symbol) => symbol.funding.rows ? symbol.funding.validRows / symbol.funding.rows : 0)), fundingSettlement: parser.fundingSettlement.coverage, pit180d: parser.pit180dFundingHistory.coverage, preReturn8h: parser.preReturn8h.coverage, postFunding30m: parser.postFunding30m.coverage, execution: parser.executionPrice.coverage, atr14: parser.atr14.coverage }, gates, status: reasons.length ? "FAIL" : "PASS", classification: reasons.length ? "V17_DATA_INSUFFICIENT_FINAL" : "DATA_GATE_PASS", reasons, historicalReturnsRead: false, boundaries: boundaries(), parser };
  await writeJson("v17-data-gate.json", gate);
  if (reasons.length) await writeFailClosedArtifacts(gate, freeze);
  console.info(JSON.stringify({ phase: "v17-data-gate", status: gate.status, classification: gate.classification, reasons, coverage: gate.coverage, historicalReturnsRead: false }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
