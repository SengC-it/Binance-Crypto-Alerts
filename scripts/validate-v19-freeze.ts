import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V19_BASE_SHA,
  V19_BRANCH,
  V19_FOLLOWER_CANDIDATES,
  V19_PARAMETERS,
  V19_PROMOTION_GATES,
  V19_REPORT_FILES,
  V19_SOURCE_FILES,
  V19_EXPERIMENT_ID,
  V19_BOUNDARIES,
} from "../lib/v19/constants";
import { canonicalJson, canonicalTextSha256, sha256 } from "../lib/v19/canonical";

const REPORT_DIR = resolve("reports");

async function main(): Promise<void> {
  const manifest = await readJson("v19-freeze-manifest.json") as Record<string, unknown>;
  const manifestBodySha256 = requireString(manifest.manifestBodySha256, "manifestBodySha256");
  const body = { ...manifest };
  delete body.manifestBodySha256;
  assertEqual(manifestBodySha256, sha256(body), "manifest body hash");
  assertEqual(manifest.experimentId, V19_EXPERIMENT_ID, "experiment identity");
  assertEqual(manifest.baseSha, V19_BASE_SHA, "base SHA");
  assertEqual(manifest.branch, V19_BRANCH, "branch");
  assertEqual(manifest.stage, "FREEZE_BEFORE_STRATEGY_RETURNS", "freeze stage");
  assertEqual(manifest.fixedCandidateFollowers, V19_FOLLOWER_CANDIDATES, "fixed candidate followers");
  assertEqual(manifest.parameters, V19_PARAMETERS, "frozen parameters");
  assertEqual(manifest.promotionGates, V19_PROMOTION_GATES, "promotion gates");
  assertEqual(manifest.flags, V19_BOUNDARIES, "boundary flags");

  const requiredArtifactHashes = requireRecord(manifest.requiredArtifactHashes, "requiredArtifactHashes");
  for (const report of V19_REPORT_FILES.slice(0, -1)) {
    const actualHash = canonicalTextSha256(await readFile(resolve(report), "utf8"));
    assertEqual(requiredArtifactHashes[report], actualHash, `${report} hash`);
  }
  const sourceHashes = requireRecord(requireRecord(manifest.signalEngine, "signalEngine").sourceHashes, "signalEngine.sourceHashes");
  for (const source of V19_SOURCE_FILES) {
    const actualHash = canonicalTextSha256(await readFile(resolve(source), "utf8"));
    assertEqual(sourceHashes[source], actualHash, `${source} hash`);
  }

  const dataGate = await readJson("v19-data-gate.json");
  const feasibility = await readJson("v19-universe-feasibility.json");
  const preReturn = await readJson("v19-pre-return-assessment.json");
  assertEqual(dataGate.experimentId, V19_EXPERIMENT_ID, "data gate experiment");
  assertEqual(feasibility.experimentId, V19_EXPERIMENT_ID, "feasibility experiment");
  assertEqual(preReturn.experimentId, V19_EXPERIMENT_ID, "pre-return experiment");
  assertEqual(requireRecord(manifest.dataGate, "manifest.dataGate").status, dataGate.status, "data gate status");
  assertNoForbiddenOutcomeKeys(preReturn, "pre-return assessment");

  const reportNames = await readdir(REPORT_DIR);
  const forbiddenResultFiles = reportNames.filter((name) => /^v19-(result|oos|holdout|performance|bootstrap)/i.test(name));
  if (forbiddenResultFiles.length > 0) throw new Error(`forbidden V19 result artifacts exist: ${forbiddenResultFiles.join(", ")}`);
  if (Boolean(dataGate.strategyReturnsRead)) throw new Error("strategy returns were marked as read");
  const outcomeAccess = requireRecord(preReturn.outcomeAccess, "outcomeAccess");
  if (outcomeAccess.outcomesNotCalculated !== true) {
    throw new Error("pre-return artifact does not prove outcomes were not calculated");
  }

  console.info("V19 freeze validation PASS");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch\nactual=${canonicalJson(actual)}\nexpected=${canonicalJson(expected)}`);
  }
}

function assertNoForbiddenOutcomeKeys(value: unknown, path: string): void {
  const forbidden = new Set(["pnl", "netpnl", "winrate", "profitfactor", "avgr", "netr", "maxdd", "cvar", "bootstrapreturnci", "futurereturn"]);
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
