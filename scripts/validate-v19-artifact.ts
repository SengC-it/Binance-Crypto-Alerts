import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V19_BASE_SHA,
  V19_BOUNDARIES,
  V19_EXPERIMENT_ID,
  V19_FOLLOWER_CANDIDATES,
  V19_PARAMETERS,
  V19_PROMOTION_GATES,
  V19_BRANCH,
} from "../lib/v19/constants";
import { canonicalJson } from "../lib/v19/canonical";

const REPORT_DIR = resolve("reports");
const FREEZE_COMMIT = "f10df65620a630add002d0aaf3c0dff4d8f23c83";
const FREEZE_MANIFEST_HASH = "cf84b3e141b8709cf5dbe254a0767edc110cb48741b5c777d574b60506337e94";
const EXPECTED_EVENT_COUNT = 5_855;
const EXPECTED_CLUSTER_COUNT = 2_872;
const RESULT_FILES = [
  "v19-primary-oos.json",
  "v19-holdouts.json",
  "v19-followers.json",
  "v19-directions.json",
  "v19-yearly.json",
  "v19-confidence.json",
  "v19-cost.json",
  "v19-stress.json",
  "v19-concentration.json",
  "v19-controls.json",
  "v19-promotion-decision.json",
  "v19-trade-outcomes.json",
] as const;

async function main(): Promise<void> {
  const freeze = await readJson("v19-freeze-manifest.json");
  const preReturn = await readJson("v19-pre-return-assessment.json");
  const dataGate = await readJson("v19-data-gate.json");
  const outcomesFile = await readJson("v19-trade-outcomes.json");
  const eventIds = (preReturn.events as Record<string, unknown>[]).map(identityKey);
  const outcomeRows = outcomesFile.outcomes as Record<string, unknown>[];
  const outcomeIds = outcomeRows.map((row) => identityKey(requireRecord(row.identity, "outcome.identity")));
  const enumeration = requireRecord(preReturn.enumeration, "preReturn.enumeration");
  if (freeze.manifestBodySha256 !== FREEZE_MANIFEST_HASH) throw new Error("Freeze manifest hash drift");
  assertEqual(freeze.experimentId, V19_EXPERIMENT_ID, "experiment");
  assertEqual(freeze.baseSha, V19_BASE_SHA, "base SHA");
  assertEqual(freeze.branch, V19_BRANCH, "branch");
  assertEqual(freeze.fixedCandidateFollowers, V19_FOLLOWER_CANDIDATES, "candidate universe");
  assertEqual(freeze.parameters, V19_PARAMETERS, "parameters");
  assertEqual(freeze.promotionGates, V19_PROMOTION_GATES, "promotion gates");
  assertEqual(freeze.flags, V19_BOUNDARIES, "freeze boundaries");
  if (eventIds.length !== EXPECTED_EVENT_COUNT || outcomeIds.length !== EXPECTED_EVENT_COUNT) throw new Error("frozen event count drift");
  assertEqual(eventIds, outcomeIds, "frozen event identity sequence");
  if (new Set(eventIds.map((id) => id.split("|")[0])).size !== EXPECTED_CLUSTER_COUNT) throw new Error("frozen cluster count drift");
  if (enumeration.finalEligibleEvents !== EXPECTED_EVENT_COUNT) throw new Error("pre-return event count drift");
  if (enumeration.distinctBtcShockClusters !== EXPECTED_CLUSTER_COUNT) throw new Error("pre-return cluster count drift");
  if (dataGate.status !== "PASS") throw new Error("data gate drifted from PASS");
  const provenance = requireRecord(outcomesFile.provenance, "outcomes.provenance");
  assertEqual(provenance.freezeCommit, FREEZE_COMMIT, "result freeze commit");
  assertEqual(provenance.freezeManifestBodySha256, FREEZE_MANIFEST_HASH, "result freeze hash");
  if (provenance.historicalReturnsRead !== true || provenance.parameterSearch !== false) throw new Error("result boundary flags drift");
  if (provenance.productionChanged !== false || provenance.automaticPromotion !== false || provenance.deploy !== false || provenance.merge !== false || provenance.migration !== false || provenance.autoTrading !== false) {
    throw new Error("Production boundary drift");
  }
  const resultNames = await readdir(REPORT_DIR);
  for (const name of RESULT_FILES) if (!resultNames.includes(name)) throw new Error(`missing result artifact ${name}`);
  for (const name of RESULT_FILES) {
    const report = await readJson(name);
    const reportProvenance = requireRecord(report.provenance, `${name}.provenance`);
    assertEqual(reportProvenance.freezeCommit, FREEZE_COMMIT, `${name} freeze commit`);
    assertEqual(reportProvenance.freezeManifestBodySha256, FREEZE_MANIFEST_HASH, `${name} freeze hash`);
    if (reportProvenance.automaticPromotion !== false || reportProvenance.productionChanged !== false || reportProvenance.productionEmail !== "OFF") throw new Error(`${name} production boundary drift`);
  }
  const forbiddenWiring = JSON.stringify(resultNames.filter((name) => /^v19-(result|promotion|oos|holdout)-.*\.json$/i.test(name)));
  if (forbiddenWiring.includes("v19-result")) throw new Error(`unexpected result wiring artifact ${forbiddenWiring}`);

  console.info("V19 result artifact validation PASS");
}

function identityKey(identity: Record<string, unknown>): string {
  return [
    identity.btcShockTimestamp,
    identity.signalTimestamp,
    identity.signalOpenTime,
    identity.follower,
    identity.side,
    identity.nextExecutionOpenTime,
    identity.executionReferencePrice,
    identity.primaryExitCloseTime,
    identity.evaluationWindow,
  ].map(String).join("|");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
