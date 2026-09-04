import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPORT_DIR = resolve("reports");
const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v17-crowding-failed-continuation";
const ORIGINAL_FREEZE_SHA256 = "5b438583ae859f972c5b0c81b295bb4432a1e717ce321151f79fbbbc095e1b8a";
const RESULT_NAMES = ["v17-primary-oos.json", "v17-yearly.json", "v17-holdouts.json", "v17-instrument-sides.json", "v17-directions.json", "v17-placebos.json", "v17-cost.json", "v17-manual-delay.json", "v17-fixed-horizon.json", "v17-confidence.json", "v17-email-utility.json"];

type JsonRecord = Record<string, unknown>;

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function readJson(name: string): Promise<JsonRecord> { return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as JsonRecord; }
async function fileHash(name: string): Promise<string> { return hash(await readFile(resolve(REPORT_DIR, name), "utf8")); }
function expect(value: boolean, message: string): void { if (!value) throw new Error(`V17 artifact validation failed: ${message}`); }

async function main(): Promise<void> {
  const freeze = await readJson("v17-data-freeze-v2.json");
  const freezeHash = freeze.manifestSha256;
  const freezeBody = { ...freeze };
  delete freezeBody.manifestSha256;
  expect(freeze.schema === "v17-data-freeze-v2" && freeze.baseline === BASELINE && freeze.branch === BRANCH && freeze.status === "FROZEN_BEFORE_RETURNS" && freeze.historicalReturnsRead === false, "data freeze v2 identity/status drift");
  const lineage = freeze.lineage as JsonRecord;
  expect(lineage.originalFreezeManifestSha256 === ORIGINAL_FREEZE_SHA256 && lineage.parserCorrectnessCommit === "bb3a189eec29df9f2ef8c3820454c6630f1ccd03" && freeze.alphaDefinitionsUnchanged === true, "freeze lineage or alpha definition drift");
  expect(typeof freezeHash === "string" && freezeHash === hash(JSON.stringify(freezeBody)), "freeze manifest hash mismatch");

  const inventory = await readJson("v17-official-inventory.json");
  expect(inventory.schema === "v17-official-inventory-v1" && inventory.provider === "Binance Data Vision" && inventory.officialOnly === true && inventory.expectedSlots === 536, "inventory identity drift");
  const records = inventory.records;
  expect(Array.isArray(records) && records.length === 536, "inventory record count drift");
  expect((records as unknown[]).every((value) => { const record = value as JsonRecord; return record.officialStatus === "AVAILABLE" && record.checksumListed === true && typeof record.expectedSha256 === "string"; }), "inventory is not complete and checksum-backed");

  const cache = await readJson("v17-cache-manifest.json");
  expect(cache.schema === "v17-cache-manifest-v1" && cache.sealed === true && cache.verifiedArchiveSlots === 536, "cache manifest is not sealed with 536 verified archives");
  const parser = await readJson("v17-parser-report.json");
  const parserSource = parser.source as JsonRecord;
  expect(parser.schema === "v17-parser-report-v1" && parserSource.provider === "Binance Data Vision" && parserSource.officialOnly === true && parserSource.noSyntheticData === true && parserSource.noForwardFill === true, "parser source boundary drift");
  const gate = await readJson("v17-data-gate-v2.json");
  expect(gate.schema === "v17-data-gate-v2" && gate.baseline === BASELINE && gate.branch === BRANCH && gate.freezeSha256 === freezeHash && gate.historicalReturnsRead === false, "data gate v2 identity/returns boundary drift");
  const provenance = gate.provenance as JsonRecord;
  expect(provenance.inventorySha256 === await fileHash("v17-official-inventory.json"), "inventory provenance hash drift");
  expect(provenance.cacheManifestSha256 === await fileHash("v17-cache-manifest.json"), "cache provenance hash drift");
  expect(provenance.parserReportSha256 === await fileHash("v17-parser-report.json"), "parser provenance hash drift");
  expect(provenance.noRedownload === true && provenance.noRematerialize === true, "data gate v2 redownload/rematerialize boundary drift");
  const counts = gate.counts as JsonRecord;
  const coverage = gate.coverage as JsonRecord;
  const priceCoverage = coverage.priceAtFunding as JsonRecord;
  const settlementCoverage = coverage.candidateSettlementMarks as JsonRecord;
  expect(typeof counts.allFundingEvents === "number" && typeof counts.warmupEvents === "number" && typeof counts.notEligibleUnder90d === "number" && typeof counts.evaluationPeriodEvents === "number" && typeof counts.pitHistoryAvailableEvaluationEvents === "number", "corrected denominator fields missing");
  expect(priceCoverage.source === "USD_M_FUTURES_15M_CLOSED_CLOSE", "price-at-funding source drift");
  expect((coverage.eventMarkAvailability as JsonRecord).descriptiveOnly === true && settlementCoverage.noCandidateRequirementIsValid === true, "mark settlement scope drift");
  const boundaries = gate.boundaries as JsonRecord;
  expect(boundaries.productionEmail === "OFF" && boundaries.productionChanged === "NO" && boundaries.deploy === "NO" && boundaries.merge === "NO" && boundaries.migration === "NO" && boundaries.autoTrading === "NO" && boundaries.privateBinanceApi === "NO" && boundaries.orderPlacement === "NO", "production boundary drift");

  const summary = await readJson("v17-validation-summary.json");
  const decision = await readJson("v17-promotion-decision.json");
  if (gate.status === "FAIL") {
    expect(gate.classification === "V17_DATA_INSUFFICIENT_FINAL", "failed data gate classification drift");
    expect(summary.result === "V17_DATA_INSUFFICIENT_FINAL" && summary.historicalReturnsRead === false && summary.dataGate === "FAIL", "fail-closed summary drift");
    expect(decision.classification === "V17_DATA_INSUFFICIENT_FINAL" && decision.historicalReturnsRead === false, "fail-closed decision drift");
    for (const name of RESULT_NAMES) { const result = await readJson(name); expect(result.status === "NOT_RUN" && result.historicalReturnsRead === false && result.metrics === null, `${name} was read after a failed Data Gate`); }
  } else {
    expect(gate.classification === "DATA_GATE_PASS", "passed data gate classification drift");
    expect(summary.historicalReturnsRead === true && decision.historicalReturnsRead === true, "result artifacts are not marked as post-freeze");
  }
  console.info(JSON.stringify({ artifact: "v17", status: "PASS", dataGate: gate.status, classification: gate.classification, archives: 536, historicalReturnsRead: summary.historicalReturnsRead }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
