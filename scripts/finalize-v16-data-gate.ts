import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateV16DataGate,
  expectedV16ArchiveSlots,
  V16_BASELINE,
  V16_BRANCH,
  V16_END,
  V16_START,
  V16_SYMBOLS,
  type V16ArchiveSlot,
  type V16CoverageInput,
  type V16DatasetKind,
  type V16Symbol,
} from "@/lib/v16/data-gate";

const REPORT_DIR = resolve("reports");
const CACHE_ROOT = resolve("data/raw/v16-aggtrade-absorption");
const CACHE_MANIFEST = resolve(CACHE_ROOT, "manifest.json");

type JsonRecord = Record<string, unknown>;

interface CacheRecord {
  dataset: V16DatasetKind;
  symbol: V16Symbol;
  month: string;
  sha256: string;
  bytes: number;
  checksumVerified: boolean;
  integrity: "PASS" | "FAIL";
  coverage?: JsonRecord;
}

interface CacheManifest {
  records: CacheRecord[];
  coverage?: JsonRecord;
  proofs?: JsonRecord;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function mapMetric(source: JsonRecord, key: string, fallback: number): Record<V16Symbol, number> {
  const value = asRecord(source[key]);
  return {
    BTCUSDT: numberOr(value.BTCUSDT, fallback),
    ETHUSDT: numberOr(value.ETHUSDT, fallback),
  };
}

function mapBoolean(source: JsonRecord, key: string, fallback: boolean): Record<V16Symbol, boolean> {
  const value = asRecord(source[key]);
  return {
    BTCUSDT: booleanOr(value.BTCUSDT, fallback),
    ETHUSDT: booleanOr(value.ETHUSDT, fallback),
  };
}

function mapKey(record: Pick<CacheRecord, "dataset" | "symbol" | "month">): string {
  return `${record.dataset}|${record.symbol}|${record.month}`;
}

async function readCacheManifest(): Promise<CacheManifest | null> {
  try {
    const value = JSON.parse(await readFile(CACHE_MANIFEST, "utf8")) as JsonRecord;
    const records = Array.isArray(value.records) ? value.records : [];
    return {
      records: records.filter((record): record is CacheRecord => {
        const item = asRecord(record);
        return typeof item.dataset === "string" && typeof item.symbol === "string" && typeof item.month === "string" && typeof item.sha256 === "string" && typeof item.bytes === "number" && typeof item.checksumVerified === "boolean" && (item.integrity === "PASS" || item.integrity === "FAIL");
      }),
      coverage: asRecord(value.coverage),
      proofs: asRecord(value.proofs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileHash(path: string): Promise<string> {
  return sha256((await readFile(path, "utf8")).replace(/\r\n/g, "\n"));
}

async function inspectSlots(slots: V16ArchiveSlot[], cache: CacheManifest | null): Promise<{ inventory: JsonRecord; validRecords: CacheRecord[] }> {
  const records = new Map((cache?.records ?? []).map((record) => [mapKey(record), record]));
  const inspected: JsonRecord[] = [];
  const validRecords: CacheRecord[] = [];
  let materialized = 0;
  let invalid = 0;
  for (const slot of slots) {
    const record = records.get(mapKey(slot));
    const absolutePath = resolve(slot.localPath);
    let status: "MISSING" | "CHECKSUM_UNVERIFIED" | "INTEGRITY_FAIL" | "PASS" = "MISSING";
    let actualBytes: number | null = null;
    let actualSha256: string | null = null;
    try {
      actualBytes = (await stat(absolutePath)).size;
      materialized += 1;
      if (!record || record.bytes !== actualBytes || !record.checksumVerified || record.sha256.length !== 64) {
        status = "CHECKSUM_UNVERIFIED";
      } else {
        actualSha256 = sha256(await readFile(absolutePath));
        if (actualSha256 !== record.sha256) status = "CHECKSUM_UNVERIFIED";
        else if (record.integrity !== "PASS") status = "INTEGRITY_FAIL";
        else {
          status = "PASS";
          validRecords.push(record);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (status !== "MISSING" && status !== "PASS") invalid += 1;
    inspected.push({
      ...slot,
      status,
      declaredSha256: record?.sha256 ?? null,
      declaredBytes: record?.bytes ?? null,
      actualSha256,
      actualBytes,
    });
  }
  const used = validRecords.length;
  const inventory = {
    schema: "v16-data-inventory-v1",
    source: { provider: "Binance Data Vision", officialOnly: true, start: V16_START, end: V16_END, cacheRoot: "data/raw/v16-aggtrade-absorption", remoteDownloadPerformed: false },
    cacheManifestPresent: cache !== null,
    requiredArchiveSlots: slots.length,
    materializedArchiveSlots: materialized,
    validArchiveSlots: used,
    invalidArchiveSlots: invalid,
    usedArchiveSlots: used,
    usedZipChecksumCoverage: used === 0 ? 0 : validRecords.length / used,
    slots: inspected,
  };
  return { inventory, validRecords };
}

function coverageInput(inventory: JsonRecord, cache: CacheManifest | null): V16CoverageInput {
  const coverage = cache?.coverage ?? {};
  const proofs = cache?.proofs ?? {};
  return {
    requiredArchiveSlots: numberOr(inventory.requiredArchiveSlots, 0),
    materializedArchiveSlots: numberOr(inventory.materializedArchiveSlots, 0),
    usedArchiveSlots: numberOr(inventory.usedArchiveSlots, 0),
    usedZipChecksumCoverage: numberOr(inventory.usedZipChecksumCoverage, 0),
    aggTradeCoverage: mapMetric(coverage, "aggTradeCoverage", 0),
    klineCoverage: mapMetric(coverage, "klineCoverage", 0),
    timestampMonotonicity: mapBoolean(proofs, "timestampMonotonicity", false),
    aggTradeIdMonotonicity: mapBoolean(proofs, "aggTradeIdMonotonicity", false),
    duplicateCoverage: mapMetric(coverage, "duplicateCoverage", 0),
    featureCoverage: numberOr(coverage.featureCoverage, 0),
    executionPriceCoverage: numberOr(coverage.executionPriceCoverage, 0),
    fundingSettlementCoverage: numberOr(coverage.fundingSettlementCoverage, 0),
  };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeNoResultArtifacts(gate: JsonRecord, freeze: JsonRecord, inventoryHash: string): Promise<void> {
  const reason = `DATA_GATE_FAIL: ${asArray(gate.reasons).join(", ")}`;
  const notRun = { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
  const resultArtifacts = [
    "v16-primary-oos.json",
    "v16-yearly.json",
    "v16-holdouts.json",
    "v16-instrument-sides.json",
    "v16-placebos.json",
    "v16-cost.json",
    "v16-manual-delay.json",
    "v16-confidence.json",
    "v16-email-utility.json",
  ];
  for (const name of resultArtifacts) await writeJson(name, notRun);
  await writeJson("v16-validation-summary.json", {
    schema: "v16-validation-summary-v1",
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    freezeSha256: freeze.manifestSha256,
    dataInventorySha256: inventoryHash,
    dataGate: gate.status,
    historicalReturnsRead: false,
    result: "V16_DATA_INSUFFICIENT_FINAL",
    emailPromotionCandidate: "FAIL",
    researchStop: "YES",
    reason,
    reasons: gate.reasons,
    primaryOos: null,
    years: { "2022": null, "2023": null, "2024": null },
    holdoutA: null,
    holdoutB: null,
    btc: null,
    eth: null,
    buyAbsorptionShort: null,
    sellAbsorptionLong: null,
    placebos: null,
    cost: null,
    manualDelay: null,
    confidence: null,
    emailUtility: null,
    boundaries: boundaries(),
  });
  await writeJson("v16-promotion-decision.json", {
    schema: "v16-promotion-decision-v1",
    classification: "V16_DATA_INSUFFICIENT_FINAL",
    dataGate: gate.status,
    dataGateReasons: gate.reasons,
    historicalReturnsRead: false,
    emailPromotionCandidate: "FAIL",
    researchStop: "YES",
    reason,
  });
  await writeJson("v16-promotion-decision.md", {
    classification: "V16_DATA_INSUFFICIENT_FINAL",
    dataGate: "FAIL",
    reasons: gate.reasons,
    historicalReturns: "NOT READ",
    promotion: "FAIL",
    researchStop: "YES",
    productionChanged: "NO",
  });
  const names = ["v16-freeze-manifest.json", "v16-data-inventory.json", "v16-data-gate.json", ...resultArtifacts, "v16-validation-summary.json", "v16-promotion-decision.json", "v16-promotion-decision.md"];
  const artifacts: JsonRecord = {};
  for (const name of names) artifacts[name] = await fileHash(resolve(REPORT_DIR, name));
  await writeJson("v16-evidence-manifest.json", {
    schema: "v16-evidence-manifest-v1",
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    freezeSha256: freeze.manifestSha256,
    dataInventorySha256: inventoryHash,
    dataGateSha256: await fileHash(resolve(REPORT_DIR, "v16-data-gate.json")),
    resultCommit: null,
    historicalReturnsRead: false,
    artifacts,
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundaries(): JsonRecord {
  return { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false };
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const freeze = JSON.parse(await readFile(resolve(REPORT_DIR, "v16-freeze-manifest.json"), "utf8")) as JsonRecord;
  if (freeze.baseline !== V16_BASELINE || freeze.branch !== V16_BRANCH || freeze.status !== "FROZEN_BEFORE_RETURNS" || freeze.historicalReturnsRead !== false) throw new Error("V16 freeze manifest is not valid or claims returns were read");
  const slots = expectedV16ArchiveSlots();
  const cache = await readCacheManifest();
  const { inventory, validRecords } = await inspectSlots(slots, cache);
  const inventoryWithEvidence = {
    ...inventory,
    cacheRecordCount: cache?.records.length ?? 0,
    validRecordCount: validRecords.length,
    coverage: cache?.coverage ?? null,
    proofs: cache?.proofs ?? null,
    note: cache === null ? "No immutable V16 archive manifest is present; no remote download or substitute V15 cache was used." : "Only checksum-verified PASS records are eligible; missing or invalid archives are DATA_UNAVAILABLE and are not repaired or forward-filled.",
  };
  await writeJson("v16-data-inventory.json", inventoryWithEvidence);
  const inventoryHash = await fileHash(resolve(REPORT_DIR, "v16-data-inventory.json"));
  const input = coverageInput(inventoryWithEvidence, cache);
  const result = evaluateV16DataGate(input);
  const gate: JsonRecord = {
    schema: "v16-data-gate-v1",
    generatedAt: new Date().toISOString(),
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    freezeSha256: freeze.manifestSha256,
    dataInventory: { path: "reports/v16-data-inventory.json", sha256: inventoryHash },
    source: { provider: "Binance Data Vision", officialOnly: true, instruments: [...V16_SYMBOLS], start: V16_START, end: V16_END, noThirdPartyPriceData: true },
    archiveInventory: inventoryWithEvidence,
    coverage: input,
    gates: result.gates,
    status: result.status,
    classification: result.classification,
    reasons: result.reasons,
    historicalReturnsRead: false,
    boundaries: boundaries(),
  };
  await writeJson("v16-data-gate.json", gate);
  if (result.status === "FAIL") await writeNoResultArtifacts(gate, freeze, inventoryHash);
  console.info(JSON.stringify({ phase: "v16-data-gate", status: result.status, classification: result.classification, reasons: result.reasons, requiredArchiveSlots: input.requiredArchiveSlots, materializedArchiveSlots: input.materializedArchiveSlots, usedZipChecksumCoverage: input.usedZipChecksumCoverage, aggTradeCoverage: input.aggTradeCoverage, klineCoverage: input.klineCoverage, featureCoverage: input.featureCoverage, executionPriceCoverage: input.executionPriceCoverage, fundingSettlementCoverage: input.fundingSettlementCoverage, historicalReturnsRead: false }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
