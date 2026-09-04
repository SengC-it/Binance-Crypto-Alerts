import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalTextSha256 } from "../lib/v16/provenance";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = resolve("data/raw/v16-aggtrade-absorption");
const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v16-aggtrade-absorption";
const ORIGINAL_FREEZE_COMMIT = "da77ba6c83e9066658d331972353d05b8341c152";
const ORIGINAL_FREEZE_SHA = "b9af07c66b1890acc9090a947b4e510fdb5b2dada749aec14fce4cea5f876f8f";

type JsonRecord = Record<string, unknown>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

async function readEvidenceJson(primaryPath: string, snapshotPath: string, label: string): Promise<{ path: string; value: JsonRecord }> {
  try {
    return { path: primaryPath, value: await readJson(primaryPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      return { path: snapshotPath, value: await readJson(snapshotPath) };
    } catch {
      fail(`${label} is unavailable in the local cache and no tracked evidence snapshot exists`);
    }
  }
}

async function normalizedFileHash(path: string): Promise<string> {
  return canonicalTextSha256(await readFile(path, "utf8"));
}

function fail(message: string): never {
  throw new Error(`V16 artifact validation failed: ${message}`);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value;
}

function expect(value: boolean, message: string): void {
  if (!value) fail(message);
}

async function main(): Promise<void> {
  const freeze = await readJson(resolve(REPORT_DIR, "v16-freeze-manifest.json"));
  const freezeHash = freeze.manifestSha256;
  const freezeBody = { ...freeze };
  delete freezeBody.manifestSha256;
  expect(typeof freezeHash === "string" && freezeHash === hash(JSON.stringify(freezeBody)), "original freeze SHA-256 mismatch");
  expect(freeze.schema === "v16-freeze-manifest-v1" && freeze.status === "FROZEN_BEFORE_RETURNS", "original freeze status drift");
  expect(freeze.baseline === BASELINE && freeze.branch === BRANCH && freeze.historicalReturnsRead === false, "original freeze identity drift");
  expect(freezeHash === ORIGINAL_FREEZE_SHA, "original freeze manifest SHA drift");
  const freezeBoundaries = asRecord(freeze.boundaries, "original freeze boundaries");
  expect(freezeBoundaries.productionEmail === "OFF" && freezeBoundaries.productionChanged === false && freezeBoundaries.deploy === false && freezeBoundaries.merge === false && freezeBoundaries.migration === false && freezeBoundaries.autoTrading === false && freezeBoundaries.privateBinanceApi === false && freezeBoundaries.orderPlacement === false, "original freeze production boundary drift");

  const dataFreeze = await readJson(resolve(REPORT_DIR, "v16-data-freeze-v2.json"));
  const dataFreezeHash = dataFreeze.manifestSha256;
  const dataFreezeFileHash = await normalizedFileHash(resolve(REPORT_DIR, "v16-data-freeze-v2.json"));
  const dataFreezeBody = { ...dataFreeze };
  delete dataFreezeBody.manifestSha256;
  expect(typeof dataFreezeHash === "string" && dataFreezeHash === hash(JSON.stringify(dataFreezeBody)), "data Freeze v2 SHA-256 mismatch");
  expect(dataFreeze.schema === "v16-data-freeze-v2" && dataFreeze.status === "FROZEN_BEFORE_RETURNS" && dataFreeze.historicalReturnsRead === false, "data Freeze v2 status drift");
  const originalLink = asRecord(dataFreeze.originalFreeze, "data Freeze v2 original freeze");
  expect(originalLink.commit === ORIGINAL_FREEZE_COMMIT && originalLink.manifestSha256 === ORIGINAL_FREEZE_SHA, "data Freeze v2 original freeze link drift");
  const dataBoundaries = asRecord(dataFreeze.boundaries, "data Freeze v2 boundaries");
  expect(dataBoundaries.productionEmail === "OFF" && dataBoundaries.productionChanged === false && dataBoundaries.deploy === false && dataBoundaries.merge === false && dataBoundaries.migration === false && dataBoundaries.autoTrading === false, "data Freeze v2 production boundary drift");

  const inventoryEvidence = await readEvidenceJson(resolve(DATA_ROOT, "official-inventory.json"), resolve(REPORT_DIR, "v16-official-inventory.json"), "official inventory");
  const inventory = inventoryEvidence.value;
  const inventoryHash = await normalizedFileHash(inventoryEvidence.path);
  expect(inventory.schema === "v16-official-inventory-v1" && inventory.provider === "Binance Data Vision" && inventory.officialOnly === true, "official inventory identity drift");
  expect(inventory.expectedSlots === 670 && typeof inventory.enumerationSha256 === "string" && inventory.enumerationComplete === true, "official inventory completeness drift");
  const inventoryRecords = asArray(inventory.records, "official inventory records").map((value) => asRecord(value, "official inventory record"));
  expect(inventoryRecords.length === inventory.expectedSlots, "official inventory record count drift");

  const cacheEvidence = await readEvidenceJson(resolve(DATA_ROOT, "manifest.json"), resolve(REPORT_DIR, "v16-cache-manifest.json"), "cache manifest");
  const cache = cacheEvidence.value;
  const cacheHash = await normalizedFileHash(cacheEvidence.path);
  expect(cache.schema === "v16-cache-manifest-v2" && cache.enumerationSha256 === inventory.enumerationSha256 && cache.sealed === true, "cache manifest provenance drift");
  const cacheRecords = asArray(cache.records, "cache records").map((value) => asRecord(value, "cache record"));
  expect(cacheRecords.length === inventoryRecords.length, "cache record count drift");
  const availableKeys = new Set(inventoryRecords.filter((record) => record.availability === "AVAILABLE").map((record) => `${record.dataset}|${record.symbol}|${record.month}`));
  const verifiedRecords = cacheRecords.filter((record) => record.status === "CHECKSUM_VERIFIED" && record.checksumVerified === true && typeof record.expectedSha256 === "string" && record.expectedSha256 === record.actualSha256);
  expect(cacheRecords.every((record) => record.availability === "OFFICIAL_UNAVAILABLE" || record.availability === "CHECKSUM_UNAVAILABLE" || availableKeys.has(`${record.dataset}|${record.symbol}|${record.month}`)), "cache contains an unknown archive key");
  expect(verifiedRecords.every((record) => record.bytes === record.remoteBytes && typeof record.localPath === "string" && typeof record.url === "string" && typeof record.checksumUrl === "string"), "verified cache record provenance incomplete");

  const parserEvidence = await readEvidenceJson(resolve(DATA_ROOT, "parser-report.json"), resolve(REPORT_DIR, "v16-parser-report.json"), "parser report");
  const parser = parserEvidence.value;
  const parserHash = await normalizedFileHash(parserEvidence.path);
  expect(parser.schema === "v16-parser-report-v1", "parser report schema drift");
  const parserSource = asRecord(parser.source, "parser source");
  expect(parserSource.noSyntheticData === true && parserSource.noV15Substitute === true, "parser source substitution/synthetic-data boundary drift");
  const proofs = asRecord(parser.proofs, "parser proofs");
  expect(proofs.noSyntheticData === true, "parser synthetic-data proof missing");

  const gate = await readJson(resolve(REPORT_DIR, "v16-data-gate-v2.json"));
  const legacyGate = await readJson(resolve(REPORT_DIR, "v16-data-gate.json"));
  expect(JSON.stringify(gate) === JSON.stringify(legacyGate), "legacy and v2 data gate artifacts differ");
  expect(gate.schema === "v16-data-gate-v2" && gate.baseline === BASELINE && gate.branch === BRANCH && gate.historicalReturnsRead === false, "data gate identity/returns provenance drift");
  const gateOriginal = asRecord(gate.originalFreeze, "data gate original freeze");
  expect(gateOriginal.commit === ORIGINAL_FREEZE_COMMIT && gateOriginal.manifestSha256 === ORIGINAL_FREEZE_SHA, "data gate original freeze link drift");
  const gateFreeze = asRecord(gate.dataFreezeV2, "data gate data Freeze v2");
  expect(gateFreeze.sha256 === dataFreezeFileHash, "data gate data Freeze v2 hash drift");
  const gateInventory = asRecord(gate.dataInventory, "data gate data inventory");
  expect(gateInventory.sha256 === inventoryHash, "data gate inventory hash drift");
  const gateParser = asRecord(gate.parserReport, "data gate parser report");
  expect(gateParser.sha256 === parserHash, "data gate parser report hash drift");
  const gateBoundaries = asRecord(gate.boundaries, "data gate boundaries");
  expect(gateBoundaries.productionEmail === "OFF" && gateBoundaries.productionChanged === false && gateBoundaries.deploy === false && gateBoundaries.merge === false && gateBoundaries.migration === false && gateBoundaries.autoTrading === false, "data gate production boundary drift");
  const gateArchive = asRecord(gate.archiveInventory, "data gate archive inventory");
  expect(gateArchive.materializedArchiveSlots === verifiedRecords.length && gateArchive.usedArchiveSlots === verifiedRecords.length, "data gate/cache materialization count drift");
  expect(asRecord(dataFreeze.officialEnumeration, "data Freeze official enumeration").inventoryFileSha256 === inventoryHash, "data Freeze inventory hash drift");
  expect(asRecord(dataFreeze.cacheManifest, "data Freeze cache manifest").sha256 === cacheHash, "data Freeze cache manifest hash drift");
  expect(gate.status === "PASS" || gate.status === "FAIL", "data gate status invalid");
  if (gate.status === "FAIL") {
    expect(gate.classification === "V16_DATA_INSUFFICIENT_FINAL", "failed data gate classification drift");
    expect(gate.historicalReturnsRead === false, "returns were read after failed data gate");
    for (const name of ["v16-primary-oos.json", "v16-yearly.json", "v16-holdouts.json", "v16-instrument-sides.json", "v16-placebos.json", "v16-cost.json", "v16-manual-delay.json", "v16-confidence.json", "v16-email-utility.json"]) {
      const result = await readJson(resolve(REPORT_DIR, name));
      expect(result.status === "NOT_RUN" && result.historicalReturnsRead === false && result.metrics === null, `${name} is not a truthful NOT_RUN artifact`);
    }
    const summary = await readJson(resolve(REPORT_DIR, "v16-validation-summary.json"));
    expect(summary.result === "V16_DATA_INSUFFICIENT_FINAL" && summary.historicalReturnsRead === false && summary.dataGate === "FAIL", "failed summary is not fail-closed");
    const decision = await readJson(resolve(REPORT_DIR, "v16-promotion-decision.json"));
    expect(decision.classification === "V16_DATA_INSUFFICIENT_FINAL" && decision.historicalReturnsRead === false && decision.researchStop === "YES", "failed promotion decision is not fail-closed");
  }
  const evidence = await readJson(resolve(REPORT_DIR, "v16-evidence-manifest.json"));
  expect(evidence.schema === "v16-evidence-manifest-v2" && evidence.baseline === BASELINE && evidence.branch === BRANCH && evidence.originalFreezeSha256 === ORIGINAL_FREEZE_SHA && evidence.dataFreezeV2Sha256 === dataFreezeFileHash && evidence.historicalReturnsRead === false, "evidence manifest provenance drift");
  const artifacts = asRecord(evidence.artifacts, "evidence artifacts");
  for (const [name, expected] of Object.entries(artifacts)) {
    if (typeof expected !== "string") continue;
    expect(expected === await normalizedFileHash(resolve(REPORT_DIR, name)), `evidence artifact hash mismatch: ${name}`);
  }
  console.info(JSON.stringify({ artifact: "v16", status: "PASS", dataGate: gate.status, classification: gate.classification, verifiedArchives: verifiedRecords.length, historicalReturnsRead: false }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
