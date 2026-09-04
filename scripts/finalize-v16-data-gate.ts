import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadCacheManifest,
  sha256File,
  V16_PARSER_REPORT,
  type ParserReport,
} from "../lib/v16/data-engine";
import {
  evaluateV16DataGate,
  V16_BASELINE,
  V16_BRANCH,
  V16_END,
  V16_START,
  V16_SYMBOLS,
  type V16CoverageInput,
  type V16Symbol,
} from "../lib/v16/data-gate";

const REPORT_DIR = resolve("reports");
const DATA_ROOT = resolve("data/raw/v16-aggtrade-absorption");
const INVENTORY_PATH = resolve(DATA_ROOT, "official-inventory.json");
const DATA_FREEZE_PATH = resolve(REPORT_DIR, "v16-data-freeze-v2.json");

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function symbolBoolean(source: JsonRecord, key: string): Record<V16Symbol, boolean> {
  const value = asRecord(source[key]);
  return { BTCUSDT: boolOr(value.BTCUSDT), ETHUSDT: boolOr(value.ETHUSDT) };
}

function monthCoverage(parsed: number, available: number): number {
  return available === 0 ? 0 : parsed / available;
}

function aggTradeCoverage(parser: ParserReport, inventory: JsonRecord): Record<V16Symbol, number> {
  const records = asArray(inventory.records).map(asRecord);
  const result = {} as Record<V16Symbol, number>;
  for (const symbol of V16_SYMBOLS) {
    const available = records.filter((record) => record.dataset === "aggTrades" && record.symbol === symbol && record.availability !== "OFFICIAL_UNAVAILABLE").length;
    const summary = parser.bySymbol[symbol];
    const first = summary.aggTradeFirstTimestamp;
    const last = summary.aggTradeLastTimestamp;
    const start = Date.parse(V16_START);
    const end = Date.parse(V16_END);
    const rangeCovered = first !== null && last !== null && first <= start + 900_000 && last >= end - 86_400_000;
    result[symbol] = Math.min(monthCoverage(summary.aggTradeMonths, available), rangeCovered ? 1 : 0);
  }
  return result;
}

function klineCoverage(parser: ParserReport, inventory: JsonRecord): Record<V16Symbol, number> {
  const records = asArray(inventory.records).map(asRecord);
  const result = {} as Record<V16Symbol, number>;
  for (const symbol of V16_SYMBOLS) {
    const available1m = records.filter((record) => record.dataset === "klines-1m" && record.symbol === symbol && record.availability !== "OFFICIAL_UNAVAILABLE").length;
    const available5m = records.filter((record) => record.dataset === "klines-5m" && record.symbol === symbol && record.availability !== "OFFICIAL_UNAVAILABLE").length;
    const summary = parser.bySymbol[symbol];
    const months1m = monthCoverage(summary.kline1mMonths, available1m);
    const months5m = monthCoverage(summary.kline5mMonths, available5m);
    const rows1m = summary.kline1mExpectedRows === 0 ? 0 : summary.kline1mValidRows / summary.kline1mExpectedRows;
    const rows5m = summary.kline5mExpectedRows === 0 ? 0 : summary.kline5mValidRows / summary.kline5mExpectedRows;
    result[symbol] = Math.min(months1m, months5m, rows1m, rows5m);
  }
  return result;
}

function boundaries(): JsonRecord {
  return { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

async function writeNoResultArtifacts(gate: JsonRecord, freeze: JsonRecord, inventoryHash: string, parserHash: string): Promise<void> {
  const reasons = asArray(gate.reasons).map(String);
  const reason = `DATA_GATE_FAIL: ${reasons.join(", ")}`;
  const notRun = { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
  const resultNames = ["v16-primary-oos.json", "v16-yearly.json", "v16-holdouts.json", "v16-instrument-sides.json", "v16-placebos.json", "v16-cost.json", "v16-manual-delay.json", "v16-confidence.json", "v16-email-utility.json"];
  for (const name of resultNames) await writeJson(name, notRun);
  await writeJson("v16-validation-summary.json", {
    schema: "v16-validation-summary-v2",
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    freezeSha256: freeze.manifestSha256,
    dataFreezeV2Sha256: await sha256File(DATA_FREEZE_PATH),
    dataInventorySha256: inventoryHash,
    parserReportSha256: parserHash,
    dataGate: gate.status,
    historicalReturnsRead: false,
    result: "V16_DATA_INSUFFICIENT_FINAL",
    emailPromotionCandidate: "FAIL",
    researchStop: "YES",
    reason,
    reasons,
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
  await writeJson("v16-promotion-decision.json", { schema: "v16-promotion-decision-v2", classification: "V16_DATA_INSUFFICIENT_FINAL", dataGate: gate.status, dataGateReasons: reasons, historicalReturnsRead: false, emailPromotionCandidate: "FAIL", researchStop: "YES", reason });
  await writeJson("v16-promotion-decision.md", { classification: "V16_DATA_INSUFFICIENT_FINAL", dataGate: "FAIL", reasons, historicalReturns: "NOT READ", promotion: "FAIL", researchStop: "YES", productionChanged: "NO" });
  const artifactNames = ["v16-freeze-manifest.json", "v16-data-freeze-v2.json", "v16-data-inventory.json", "v16-official-inventory.json", "v16-cache-manifest.json", "v16-parser-report.json", "v16-data-gate.json", "v16-data-gate-v2.json", ...resultNames, "v16-validation-summary.json", "v16-promotion-decision.json", "v16-promotion-decision.md"];
  const artifacts: JsonRecord = {};
  for (const name of artifactNames) {
    try { artifacts[name] = await sha256File(resolve(REPORT_DIR, name)); } catch { artifacts[name] = null; }
  }
  await writeJson("v16-evidence-manifest.json", { schema: "v16-evidence-manifest-v2", baseline: V16_BASELINE, branch: V16_BRANCH, originalFreezeSha256: freeze.manifestSha256, dataFreezeV2Sha256: await sha256File(DATA_FREEZE_PATH), dataInventorySha256: inventoryHash, parserReportSha256: parserHash, dataGateSha256: await sha256File(resolve(REPORT_DIR, "v16-data-gate-v2.json")), resultCommit: null, historicalReturnsRead: false, artifacts });
}

async function main(): Promise<void> {
  const freeze = await readJson(resolve(REPORT_DIR, "v16-freeze-manifest.json"));
  if (freeze.baseline !== V16_BASELINE || freeze.branch !== V16_BRANCH || freeze.status !== "FROZEN_BEFORE_RETURNS" || freeze.historicalReturnsRead !== false) throw new Error("Original V16 Freeze is invalid or claims historical returns were read");
  const dataFreeze = await readJson(DATA_FREEZE_PATH);
  if (dataFreeze.schema !== "v16-data-freeze-v2" || dataFreeze.status !== "FROZEN_BEFORE_RETURNS" || dataFreeze.historicalReturnsRead !== false || dataFreeze.originalFreeze === undefined) throw new Error("V16 data Freeze v2 is missing or not frozen before returns");
  const inventory = await readJson(INVENTORY_PATH);
  const parser = await readJson(V16_PARSER_REPORT) as unknown as ParserReport;
  const cache = await loadCacheManifest();
  const inventoryHash = await sha256File(INVENTORY_PATH);
  const parserHash = await sha256File(V16_PARSER_REPORT);
  const availableRecords = asArray(inventory.records).map(asRecord).filter((record) => record.availability !== "OFFICIAL_UNAVAILABLE");
  const verifiedRecords = cache.records.filter((record) => record.status === "CHECKSUM_VERIFIED" && record.checksumVerified && record.actualSha256 === record.expectedSha256);
  const input: V16CoverageInput = {
    requiredArchiveSlots: availableRecords.length,
    materializedArchiveSlots: verifiedRecords.length,
    usedArchiveSlots: verifiedRecords.length,
    usedZipChecksumCoverage: verifiedRecords.length === 0 ? 0 : verifiedRecords.filter((record) => record.expectedSha256 !== null && record.actualSha256 === record.expectedSha256).length / verifiedRecords.length,
    officialArchiveInventoryComplete: inventory.enumerationComplete === true && numberOr(inventory.checksumUnavailableSlots) === 0,
    aggTradeCoverage: aggTradeCoverage(parser, inventory),
    klineCoverage: klineCoverage(parser, inventory),
    timestampMonotonicity: symbolBoolean(parser.proofs as unknown as JsonRecord, "timestampMonotonicity"),
    aggTradeIdMonotonicity: symbolBoolean(parser.proofs as unknown as JsonRecord, "aggTradeIdMonotonicity"),
    aggTradeFieldValidity: symbolBoolean(parser.proofs as unknown as JsonRecord, "aggTradeFieldValidity"),
    duplicateCoverage: { BTCUSDT: parser.proofs.duplicateFree.BTCUSDT ? 1 : 0, ETHUSDT: parser.proofs.duplicateFree.ETHUSDT ? 1 : 0 },
    klineCadence: parser.proofs.klineCadence,
    fundingFieldValidity: symbolBoolean(parser.proofs as unknown as JsonRecord, "fundingFieldValidity"),
    featureCoverage: Math.min(parser.featureCoverage.BTCUSDT, parser.featureCoverage.ETHUSDT),
    executionPriceCoverage: Math.min(parser.executionPriceCoverage.BTCUSDT, parser.executionPriceCoverage.ETHUSDT),
    fundingSettlementCoverage: parser.fundingSettlement.coverage,
    markSettlementCoverage: parser.markSettlement.coverage,
  };
  const gateResult = evaluateV16DataGate(input);
  const gate: JsonRecord = {
    schema: "v16-data-gate-v2",
    generatedAt: new Date().toISOString(),
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    originalFreeze: { commit: "da77ba6c83e9066658d331972353d05b8341c152", manifestSha256: freeze.manifestSha256 },
    dataFreezeV2: { path: "reports/v16-data-freeze-v2.json", sha256: await sha256File(DATA_FREEZE_PATH) },
    dataInventory: { path: "data/raw/v16-aggtrade-absorption/official-inventory.json", sha256: inventoryHash },
    parserReport: { path: "data/raw/v16-aggtrade-absorption/parser-report.json", sha256: parserHash },
    source: { provider: "Binance Data Vision", officialOnly: true, instruments: [...V16_SYMBOLS], start: V16_START, end: V16_END, noThirdPartyPriceData: true, noV15Substitute: true },
    archiveInventory: { expectedSlots: inventory.expectedSlots, officialRequiredSlots: availableRecords.length, officialAvailableSlots: inventory.officialAvailableSlots, officialUnavailableSlots: inventory.officialUnavailableSlots, checksumUnavailableSlots: inventory.checksumUnavailableSlots, materializedArchiveSlots: verifiedRecords.length, usedArchiveSlots: verifiedRecords.length, usedZipChecksumCoverage: input.usedZipChecksumCoverage, cacheManifest: cache.schema },
    coverage: { ...input, featureCoverageBySymbol: parser.featureCoverage, executionPriceCoverageBySymbol: parser.executionPriceCoverage, fundingSettlement: parser.fundingSettlement, markSettlement: parser.markSettlement },
    diagnostics: { bySymbol: parser.bySymbol, aggTrades: parser.aggTrades, klines: parser.klines, funding: parser.funding, proofs: parser.proofs },
    gates: gateResult.gates,
    status: gateResult.status,
    classification: gateResult.classification,
    reasons: gateResult.reasons,
    historicalReturnsRead: false,
    boundaries: boundaries(),
  };
  await writeJson("v16-data-inventory.json", { schema: "v16-data-inventory-v2", ...inventory, cacheManifest: { schema: cache.schema, records: cache.records.length, checksumVerified: verifiedRecords.length }, parserReport: { path: "data/raw/v16-aggtrade-absorption/parser-report.json", sha256: parserHash }, diagnostics: parser });
  await writeJson("v16-data-inventory-v2.json", await readJson(resolve(REPORT_DIR, "v16-data-inventory.json")));
  await copyFile(INVENTORY_PATH, resolve(REPORT_DIR, "v16-official-inventory.json"));
  await copyFile(resolve(DATA_ROOT, "manifest.json"), resolve(REPORT_DIR, "v16-cache-manifest.json"));
  await copyFile(V16_PARSER_REPORT, resolve(REPORT_DIR, "v16-parser-report.json"));
  await writeJson("v16-data-gate.json", gate);
  await writeJson("v16-data-gate-v2.json", gate);
  if (gateResult.status === "FAIL") await writeNoResultArtifacts(gate, freeze, await sha256File(resolve(REPORT_DIR, "v16-data-inventory.json")), parserHash);
  console.info(JSON.stringify({ phase: "v16-data-gate-v2", status: gateResult.status, classification: gateResult.classification, reasons: gateResult.reasons, archive: gate.archiveInventory, coverage: input, historicalReturnsRead: false }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
