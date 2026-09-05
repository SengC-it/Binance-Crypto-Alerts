import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, canonicalTextSha256, sha256 } from "@/lib/v18/data";
import { V18_FREEZE_COMMIT, V18_FREEZE_MANIFEST_SHA256, V18_RESULT_BOUNDARIES } from "@/lib/v18/result";

const REPORT_DIR = resolve("reports");
const RESULT_JSON = [
  "v18-primary-oos.json",
  "v18-directions.json",
  "v18-symbols.json",
  "v18-holdouts.json",
  "v18-yearly.json",
  "v18-confidence.json",
  "v18-cost.json",
  "v18-stress.json",
  "v18-controls.json",
  "v18-promotion-decision.json",
] as const;
const FREEZE_REPORTS = [
  "reports/v18-archive-manifest.json",
  "reports/v18-parser-report.json",
  "reports/v18-data-gate.json",
  "reports/v18-pre-return-assessment.json",
  "reports/v18-freeze-manifest.json",
] as const;
const ALLOWED_RESULT_PATHS = new Set([
  "lib/v18/result.ts",
  "scripts/run-v18-result.ts",
  "scripts/validate-v18-artifact.ts",
  "tests/v18-result.test.ts",
  "package.json",
  ...RESULT_JSON.map((name) => `reports/${name}`),
  "reports/v18-validation-summary.md",
]);

type JsonObject = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V18_ARTIFACT_VALIDATION_FAILED: ${message}`);
}

async function readJson(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(name), "utf8")) as JsonObject;
}

function object(value: unknown, label: string): JsonObject {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  return value as JsonObject;
}

function number(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `${label} is not a finite number`);
  return value;
}

async function fileSha256(path: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(path), "utf8"));
}

function changedPaths(): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${V18_FREEZE_COMMIT}..HEAD`], { encoding: "utf8" }).trim();
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

async function main(): Promise<void> {
  const parent = execFileSync("git", ["show", "-s", "--format=%P", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  assert(parent === V18_FREEZE_COMMIT, `Result commit parent is ${parent}, expected Freeze ${V18_FREEZE_COMMIT}`);
  const changed = changedPaths();
  for (const path of changed) assert(ALLOWED_RESULT_PATHS.has(path), `unexpected path changed after Freeze: ${path}`);
  for (const path of FREEZE_REPORTS) assert(!changed.includes(path), `Freeze artifact was modified: ${path}`);

  const dataGate = await readJson("reports/v18-data-gate.json");
  const parser = await readJson("reports/v18-parser-report.json");
  const preReturn = await readJson("reports/v18-pre-return-assessment.json");
  const freeze = await readJson("reports/v18-freeze-manifest.json");
  assert(dataGate.schema === "v18-data-gate-v1" && dataGate.status === "PASS", "Data Gate changed from PASS");
  assert(parser.schema === "v18-parser-report-v1" && parser.allChecksPassed === true, "parser integrity changed");
  const archive = object(dataGate.archive, "Data Gate archive");
  assert(archive.enumeratedSlots === 134 && archive.checksumVerifiedSlots === 134 && archive.parsedSlots === 134 && archive.enumerationComplete === true && archive.cacheSealed === true, "archive integrity counts changed");
  const preTotals = object(preReturn.totals, "pre-return totals");
  assert(preTotals.finalEligibleEvents === 301 && preTotals.finalEligibleBuyFlowAbsorbed === 161 && preTotals.finalEligibleSellFlowAbsorbed === 140, "frozen 301 event totals changed");
  assert(preTotals.eventDigestSha256 === "ba61f9adbcbea26179c0c5476f7871c303b429765903a99e0b599c7a51ff1805", "frozen event identity digest changed");
  assert(preReturn.outcomeData === "NOT_READ" && preReturn.forwardReturnsRead === false && preReturn.oosMetricsRead === false && preReturn.holdoutRead === false, "pre-return flags changed");
  const freezeBody = { ...freeze };
  delete freezeBody.manifestBodySha256;
  assert(freeze.schema === "v18-freeze-manifest-v1" && freeze.manifestBodySha256 === V18_FREEZE_MANIFEST_SHA256 && sha256(canonicalJson(freezeBody)) === V18_FREEZE_MANIFEST_SHA256, "Freeze manifest body changed");
  const freezeFlags = object(freeze.flags, "Freeze flags");
  assert(freezeFlags.forwardReturnsRead === false && freezeFlags.oosMetricsRead === false && freezeFlags.holdoutRead === false && freezeFlags.parameterSearch === false && freezeFlags.resultCommitCreated === false, "Freeze flags are not unchanged");
  const artifacts = object(freeze.artifacts, "Freeze artifacts");
  for (const [hashKey, pathKey] of [["archiveManifestSha256", "archiveManifest"], ["parserReportSha256", "parserReport"], ["dataGateSha256", "dataGate"], ["preReturnAssessmentSha256", "preReturnAssessment"]]) {
    const path = artifacts[pathKey];
    assert(typeof path === "string" && artifacts[hashKey] === await fileSha256(path), `Freeze artifact hash mismatch: ${hashKey}`);
  }

  const results = new Map<string, JsonObject>();
  for (const name of RESULT_JSON) {
    const report = await readJson(`reports/${name}`);
    results.set(name, report);
    assert(report.freezeCommit === V18_FREEZE_COMMIT, `${name} does not reference the approved Freeze commit`);
    assert(report.freezeManifestBodySha256 === V18_FREEZE_MANIFEST_SHA256, `${name} does not reference the approved Freeze manifest SHA`);
    assert(report.historicalReturnsRead === true && report.parameterSearch === false, `${name} has invalid Result flags`);
    const boundaries = object(report.boundaries, `${name} boundaries`);
    for (const [key, expected] of Object.entries(V18_RESULT_BOUNDARIES)) assert(boundaries[key] === expected, `${name} boundary ${key} drifted`);
    const raw = JSON.stringify(report);
    assert(!raw.includes('"parameterSearch":true') && !raw.includes('"productionChanged":true') && !raw.includes('"automaticPromotion":true') && !raw.includes('"orderPlacement":true'), `${name} contains a forbidden enabled flag`);
  }

  const primary = object(results.get("v18-primary-oos.json")?.all, "primary all population");
  assert(primary.eventCount === 301, "Result artifact no longer covers all 301 frozen events");
  const directions = results.get("v18-directions.json");
  assert(number(object(directions?.BUY_FLOW_ABSORBED, "BUY direction").eventCount, "BUY event count") === 161, "BUY direction count drifted");
  assert(number(object(directions?.SELL_FLOW_ABSORBED, "SELL direction").eventCount, "SELL event count") === 140, "SELL direction count drifted");
  const promotion = object(results.get("v18-promotion-decision.json")?.decision, "promotion decision");
  assert(typeof promotion.classification === "string" && typeof promotion.promotion === "boolean" && promotion.researchStop === true, "promotion decision is incomplete");
  assert((await readFile(resolve("reports/v18-validation-summary.md"), "utf8")).includes(V18_FREEZE_COMMIT), "validation summary does not reference Freeze commit");
  console.log(`V18 artifact validation PASS (${RESULT_JSON.length} Result JSON artifacts; Freeze ${V18_FREEZE_COMMIT} unchanged)`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
