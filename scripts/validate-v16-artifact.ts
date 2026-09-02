import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v16-aggtrade-absorption";
const REPORT_DIR = resolve("reports");

type JsonRecord = Record<string, unknown>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(name: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as JsonRecord;
}

async function fileHash(name: string): Promise<string> {
  return hash((await readFile(resolve(REPORT_DIR, name), "utf8")).replace(/\r\n/g, "\n"));
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`V16 artifact validation failed: ${label} is not an object`);
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`V16 artifact validation failed: ${label} is not an array`);
  return value;
}

function fail(message: string): never {
  throw new Error(`V16 artifact validation failed: ${message}`);
}

async function main(): Promise<void> {
  const freeze = await readJson("v16-freeze-manifest.json");
  const freezeHash = freeze.manifestSha256;
  const freezeBody = { ...freeze };
  delete freezeBody.manifestSha256;
  if (typeof freezeHash !== "string" || freezeHash !== hash(JSON.stringify(freezeBody))) fail("freeze manifest SHA-256 mismatch");
  if (freeze.schema !== "v16-freeze-manifest-v1" || freeze.status !== "FROZEN_BEFORE_RETURNS") fail("freeze manifest status drift");
  if (freeze.baseline !== BASELINE || freeze.branch !== BRANCH || freeze.historicalReturnsRead !== false) fail("freeze manifest identity drift");
  const boundaries = asRecord(freeze.boundaries, "freeze boundaries");
  if (boundaries.productionEmail !== "OFF" || boundaries.productionChanged !== false || boundaries.deploy !== false || boundaries.merge !== false || boundaries.migration !== false || boundaries.autoTrading !== false || boundaries.privateBinanceApi !== false || boundaries.orderPlacement !== false) fail("freeze production boundary drift");

  const inventory = await readJson("v16-data-inventory.json");
  const inventoryHash = await fileHash("v16-data-inventory.json");
  if (inventory.schema !== "v16-data-inventory-v1" || inventory.source === undefined) fail("data inventory schema drift");
  const requiredArchiveSlots = inventory.requiredArchiveSlots;
  const slots = asArray(inventory.slots, "data inventory slots");
  if (typeof requiredArchiveSlots !== "number" || slots.length !== requiredArchiveSlots) fail("data inventory slot count drift");
  if (inventory.cacheManifestPresent !== false || inventory.materializedArchiveSlots !== 0 || inventory.validArchiveSlots !== 0 || inventory.usedArchiveSlots !== 0) fail("unexpected local V16 archive cache state");

  const gate = await readJson("v16-data-gate.json");
  if (gate.schema !== "v16-data-gate-v1" || gate.baseline !== BASELINE || gate.branch !== BRANCH) fail("data gate identity drift");
  if (gate.freezeSha256 !== freezeHash || gate.historicalReturnsRead !== false) fail("data gate freeze/returns provenance drift");
  if (gate.status !== "FAIL" || gate.classification !== "V16_DATA_INSUFFICIENT_FINAL") fail("data gate must fail closed before returns");
  const reasons = asArray(gate.reasons, "data gate reasons");
  if (reasons.length === 0) fail("data gate has no failure reason");
  const gateInventory = asRecord(gate.archiveInventory, "data gate archive inventory");
  if (gateInventory.requiredArchiveSlots !== requiredArchiveSlots || gateInventory.materializedArchiveSlots !== 0 || gateInventory.usedArchiveSlots !== 0) fail("data gate inventory drift");
  const gateInventoryLink = asRecord(gate.dataInventory, "data gate data inventory");
  if (gateInventoryLink.path !== "reports/v16-data-inventory.json" || gateInventoryLink.sha256 !== inventoryHash) fail("data gate inventory link drift");
  const gateBoundaries = asRecord(gate.boundaries, "data gate boundaries");
  if (gateBoundaries.productionEmail !== "OFF" || gateBoundaries.productionChanged !== false || gateBoundaries.deploy !== false || gateBoundaries.merge !== false || gateBoundaries.migration !== false || gateBoundaries.autoTrading !== false) fail("data gate production boundary drift");

  const summary = await readJson("v16-validation-summary.json");
  if (summary.baseline !== BASELINE || summary.branch !== BRANCH || summary.freezeSha256 !== freezeHash || summary.dataInventorySha256 !== inventoryHash) fail("summary provenance drift");
  if (summary.dataGate !== "FAIL" || summary.historicalReturnsRead !== false || summary.result !== "V16_DATA_INSUFFICIENT_FINAL" || summary.emailPromotionCandidate !== "FAIL" || summary.researchStop !== "YES") fail("summary fail-closed state drift");
  if (summary.reasons === undefined || JSON.stringify(summary.reasons) !== JSON.stringify(reasons)) fail("summary reasons drift");
  if (summary.reason !== `DATA_GATE_FAIL: ${reasons.join(", ")}`) fail("summary reason drift");

  const promotion = await readJson("v16-promotion-decision.json");
  if (promotion.classification !== "V16_DATA_INSUFFICIENT_FINAL" || promotion.dataGate !== "FAIL" || promotion.historicalReturnsRead !== false || promotion.emailPromotionCandidate !== "FAIL" || promotion.researchStop !== "YES") fail("promotion decision drift");
  if (promotion.dataGateReasons === undefined || JSON.stringify(promotion.dataGateReasons) !== JSON.stringify(reasons)) fail("promotion decision reasons drift");

  const resultNames = ["v16-primary-oos.json", "v16-yearly.json", "v16-holdouts.json", "v16-instrument-sides.json", "v16-placebos.json", "v16-cost.json", "v16-manual-delay.json", "v16-confidence.json", "v16-email-utility.json"];
  for (const name of resultNames) {
    const result = await readJson(name);
    if (result.status !== "NOT_RUN" || result.historicalReturnsRead !== false || result.metrics !== null) fail(`${name} is not a truthful NOT_RUN artifact`);
  }

  const evidence = await readJson("v16-evidence-manifest.json");
  if (evidence.schema !== "v16-evidence-manifest-v1" || evidence.baseline !== BASELINE || evidence.branch !== BRANCH) fail("evidence manifest identity drift");
  if (evidence.freezeSha256 !== freezeHash || evidence.dataInventorySha256 !== inventoryHash || evidence.dataGateSha256 !== await fileHash("v16-data-gate.json") || evidence.resultCommit !== null || evidence.historicalReturnsRead !== false) fail("evidence manifest provenance drift");
  const artifacts = asRecord(evidence.artifacts, "evidence artifacts");
  const names = ["v16-freeze-manifest.json", "v16-data-inventory.json", "v16-data-gate.json", ...resultNames, "v16-validation-summary.json", "v16-promotion-decision.json", "v16-promotion-decision.md"];
  for (const name of names) {
    if (artifacts[name] !== await fileHash(name)) fail(`evidence artifact hash mismatch: ${name}`);
  }
  console.info(JSON.stringify({ artifact: "v16", status: "PASS", dataGate: gate.status, classification: gate.classification, historicalReturnsRead: false, resultArtifacts: "NOT_RUN" }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
