import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V20_BASE_SHA,
  V20_BRANCH,
  V20_BOUNDARIES,
  V20_EXPECTED_ARCHIVE_SLOTS,
  V20_EXPERIMENT_ID,
  V20_PROMOTION_GATES,
  V20_REPORT_FILES,
  V20_SOURCE_FILES,
  V20_SYMBOLS,
} from "../lib/v20/constants";
import { V20_DATA_TYPES } from "../lib/v20/archive";
import { canonicalJson, canonicalTextSha256, sha256 } from "../lib/v20/canonical";

const REPORT_DIR = resolve("reports");

async function main(): Promise<void> {
  assertGitLineage();
  const manifest = await readJson("v20-freeze-manifest.json");
  const body = { ...manifest };
  delete body.manifestBodySha256;
  assertEqual(manifest.manifestBodySha256, sha256(body), "manifest body hash");
  assertEqual(manifest.experimentId, V20_EXPERIMENT_ID, "experiment identity");
  assertEqual(manifest.baseSha, V20_BASE_SHA, "base SHA");
  assertEqual(manifest.branch, V20_BRANCH, "branch");
  assertEqual(manifest.stage, "FREEZE_BEFORE_STRATEGY_RETURNS", "freeze stage");
  assertEqual(manifest.symbols, V20_SYMBOLS, "fixed symbols");
  const parameters = requireRecord(manifest.parameters, "parameters");
  assertEqual(parameters.signalTimeframe, "5m", "signal timeframe");
  assertEqual(parameters.pitWindowBars, 8640, "PIT bars");
  assertEqual(parameters.firstCross, "abs(prevDev) < threshold_t AND abs(dev_t) >= threshold_t", "first-cross rule");
  assertEqual(parameters.primaryExecution, "next complete regular USD-M futures 5m candle OPEN", "execution semantics");
  assertEqual(parameters.primaryExit, "next entry candle CLOSE; one complete 5m candle", "exit semantics");
  assertEqual(manifest.promotionGates, V20_PROMOTION_GATES, "promotion gates");
  assertEqual(manifest.flags, V20_BOUNDARIES, "boundary flags");

  const reportHashes = requireRecord(manifest.reportHashes, "reportHashes");
  for (const report of V20_REPORT_FILES.slice(0, -1)) {
    assertEqual(reportHashes[report], canonicalTextSha256(await readFile(resolve(report), "utf8")), `${report} hash`);
  }
  const sourceHashes = requireRecord(manifest.sourceHashes, "sourceHashes");
  for (const source of V20_SOURCE_FILES) {
    assertEqual(sourceHashes[source], canonicalTextSha256(await readFile(resolve(source), "utf8")), `${source} hash`);
  }

  const archiveManifest = await readJson("v20-archive-manifest.json");
  const parserReport = await readJson("v20-parser-report.json");
  const syncReport = await readJson("v20-sync-report.json");
  const dataGate = await readJson("v20-data-gate.json");
  const preReturn = await readJson("v20-pre-return-assessment.json");
  assertEqual(archiveManifest.experimentId, V20_EXPERIMENT_ID, "archive experiment");
  assertEqual(parserReport.experimentId, V20_EXPERIMENT_ID, "parser experiment");
  assertEqual(syncReport.experimentId, V20_EXPERIMENT_ID, "sync experiment");
  assertEqual(dataGate.experimentId, V20_EXPERIMENT_ID, "data gate experiment");
  assertEqual(preReturn.experimentId, V20_EXPERIMENT_ID, "pre-return experiment");
  if (dataGate.status !== "PASS" && dataGate.status !== "FAIL") throw new Error(`invalid data gate status: ${String(dataGate.status)}`);
  assertEqual(requireRecord(manifest.dataGate, "manifest data gate").status, dataGate.status, "manifest data gate status");
  assertEqual(manifest.classification, dataGate.classification, "freeze classification");
  assertEqual(requireRecord(manifest.dataSources, "dataSources").expectedArchiveSlots, V20_EXPECTED_ARCHIVE_SLOTS, "expected archive slots");
  assertEqual(requireRecord(manifest.dataSources, "dataSources").checksumVerifiedArchiveSlots, V20_EXPECTED_ARCHIVE_SLOTS, "checksum slots");

  const archiveSlots = requireArray(archiveManifest.slots, "archive slots");
  assertEqual(archiveSlots.length, V20_EXPECTED_ARCHIVE_SLOTS, "archive slot count");
  if (archiveSlots.some((slot) => slot.status !== "VERIFIED" || slot.checksumVerified !== true)) throw new Error("archive slot is not verified");
  assertEqual(requireRecord(archiveManifest.summary, "archive summary").checksumVerifiedSlots, V20_EXPECTED_ARCHIVE_SLOTS, "archive checksum summary");
  assertEqual(requireRecord(archiveManifest.summary, "archive summary").verifiedSlots, V20_EXPECTED_ARCHIVE_SLOTS, "archive verified summary");

  const dataSets = requireRecord(dataGate.datasets, "data gate datasets");
  if (Object.keys(dataSets).length !== V20_SYMBOLS.length * V20_DATA_TYPES.length) throw new Error("data gate dataset cardinality drift");
  if (dataGate.status === "PASS" && Object.values(dataSets).some((dataset) => requireRecord(dataset, "dataset").pass !== true)) throw new Error("dataset gate failed");

  const outcomeAccess = requireRecord(preReturn.outcomeAccess, "outcomeAccess");
  for (const key of ["historicalReturnsRead", "forwardReturnsRead", "oosMetricsRead", "holdoutRead"]) assertEqual(outcomeAccess[key], false, `${key} flag`);
  assertEqual(outcomeAccess.outcomesNotCalculated, true, "outcome access");
  assertNoForbiddenOutcomeKeys(preReturn, "pre-return assessment");
  if (dataGate.status === "FAIL") {
    assertEqual(dataGate.classification, "V20_FAIR_VALUE_DATA_INSUFFICIENT", "data gate failure classification");
    assertEqual(preReturn.status, "NOT_RUN_DATA_GATE_FAIL", "pre-return stop status");
    assertEqual(preReturn.classification, "V20_FAIR_VALUE_DATA_INSUFFICIENT", "pre-return classification");
  }

  const reportNames = await readdir(REPORT_DIR);
  const forbiddenResultFiles = reportNames.filter((name) => /^v20-(result|oos|holdout|performance|bootstrap|returns)/i.test(name));
  if (forbiddenResultFiles.length > 0) throw new Error(`forbidden V20 result artifacts exist: ${forbiddenResultFiles.join(", ")}`);
  const flags = requireRecord(manifest.flags, "flags");
  for (const key of ["historicalReturnsRead", "forwardReturnsRead", "oosMetricsRead", "holdoutRead", "parameterSearch", "resultCommitCreated", "productionChanged", "deploy", "merge", "migration", "privateBinanceApi", "orderPlacement", "autoTrading", "automaticPromotion"]) {
    if (flags[key] !== false) throw new Error(`${key} must remain false`);
  }
  assertEqual(flags.productionEmail, "OFF", "production email boundary");
  assertEqual(requireRecord(manifest.dataGate, "data gate").status, dataGate.status, "manifest data gate");
  const enumeration = requireRecord(manifest.enumeration, "enumeration");
  if (dataGate.status === "PASS") assertEqual(enumeration.eventDigest, preReturn.eventDigest, "event digest");
  else {
    assertEqual(enumeration.status, "NOT_RUN_DATA_GATE_FAIL", "enumeration stop status");
    assertEqual(enumeration.eventDigest, null, "event digest on data gate failure");
  }
  const preReturnControls = requireRecord(preReturn.controls, "controls");
  const preReturnIdentityDigests = preReturnControls.identityDigests;
  if (dataGate.status === "PASS") assertEqual(enumeration.controlIdentityDigest, sha256(preReturnIdentityDigests), "control digest");
  else assertEqual(enumeration.controlIdentityDigest, null, "control digest on data gate failure");
  console.info("V20 freeze validation PASS");
}

function assertGitLineage(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== V20_BRANCH) throw new Error(`branch mismatch: ${branch}`);
  const parent = execFileSync("git", ["rev-parse", `${head}^`], { encoding: "utf8" }).trim();
  if (head !== V20_BASE_SHA && parent !== V20_BASE_SHA) throw new Error(`HEAD must be base or directly based on ${V20_BASE_SHA}; got ${head}`);
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value as Array<Record<string, unknown>>;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch\nactual=${canonicalJson(actual)}\nexpected=${canonicalJson(expected)}`);
}

function assertNoForbiddenOutcomeKeys(value: unknown, path: string): void {
  const forbidden = new Set(["grossreturn", "futurereturn", "pnl", "winrate", "profitfactor", "pf", "avgr", "netr", "maxdd", "cvar", "bootstrapreturnci", "holdoutperformance"]);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenOutcomeKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) throw new Error(`forbidden outcome key ${path}.${key}`);
    assertNoForbiddenOutcomeKeys(child, `${path}.${key}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
