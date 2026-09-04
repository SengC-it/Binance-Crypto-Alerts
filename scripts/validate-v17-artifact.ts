import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPORT_DIR = resolve("reports");
const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v17-crowding-failed-continuation";
const RESULT_NAMES = ["v17-primary-oos.json", "v17-yearly.json", "v17-holdouts.json", "v17-instrument-sides.json", "v17-directions.json", "v17-placebos.json", "v17-cost.json", "v17-manual-delay.json", "v17-fixed-horizon.json", "v17-confidence.json", "v17-email-utility.json"];

type JsonRecord = Record<string, unknown>;

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function readJson(name: string): Promise<JsonRecord> { return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as JsonRecord; }
async function fileHash(name: string): Promise<string> { return hash(await readFile(resolve(REPORT_DIR, name), "utf8")); }
function expect(value: boolean, message: string): void { if (!value) throw new Error(`V17 artifact validation failed: ${message}`); }

async function main(): Promise<void> {
  const freeze = await readJson("v17-freeze-manifest.json");
  const freezeHash = freeze.manifestSha256;
  const freezeBody = { ...freeze };
  delete freezeBody.manifestSha256;
  expect(freeze.baseline === BASELINE && freeze.branch === BRANCH && freeze.status === "FROZEN_BEFORE_RETURNS" && freeze.historicalReturnsRead === false, "freeze identity/status drift");
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
  const gate = await readJson("v17-data-gate.json");
  expect(gate.schema === "v17-data-gate-v1" && gate.baseline === BASELINE && gate.branch === BRANCH && gate.historicalReturnsRead === false, "data gate identity/returns boundary drift");
  expect(gate.inventorySha256 === await fileHash("v17-official-inventory.json"), "inventory provenance hash drift");
  expect(gate.cacheManifestSha256 === await fileHash("v17-cache-manifest.json"), "cache provenance hash drift");
  expect(gate.parserReportSha256 === await fileHash("v17-parser-report.json"), "parser provenance hash drift");
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
