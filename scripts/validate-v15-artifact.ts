import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v15-spot-perp-lead-lag";
const ORIGINAL_FREEZE_COMMIT = "f469138c314454b973c8d5fd764cae662b9c92d4";
const ORIGINAL_FREEZE_SHA256 = "77e1091826c2e443d044645018ee19421cfdb38c1d92e22db2d4aab090f563b3";
const REPORT_DIR = resolve("reports");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

function fail(message: string): never {
  throw new Error(`V15 artifact validation failed: ${message}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not a finite number`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fileHash(name: string): Promise<string> {
  return hash(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function assertFileHash(name: string, expected: unknown, label: string): Promise<void> {
  if (typeof expected !== "string" || expected !== await fileHash(name)) fail(`${label} hash mismatch`);
}

async function main(): Promise<void> {
  const manifest = await readJson("v15-freeze-manifest.json");
  const manifestHash = manifest.manifestSha256;
  const manifestBody = { ...manifest };
  delete manifestBody.manifestSha256;
  if (typeof manifestHash !== "string" || manifestHash !== hash(JSON.stringify(manifestBody))) fail("freeze manifest SHA-256 mismatch");
  if (manifest.baseline !== BASELINE) fail("baseline drift");
  if (manifest.branch !== BRANCH) fail("branch drift");
  if (manifest.status !== "FROZEN_BEFORE_RETURNS") fail("manifest is not marked frozen before returns");
  if (manifest.historicalReturnsRead !== false) fail("freeze manifest claims returns were read");

  const dataFreeze = await readJson("v15-data-freeze-v2.json");
  const dataFreezeHash = dataFreeze.manifestSha256;
  const dataFreezeBody = { ...dataFreeze };
  delete dataFreezeBody.manifestSha256;
  if (typeof dataFreezeHash !== "string" || dataFreezeHash !== hash(JSON.stringify(dataFreezeBody))) fail("data freeze v2 SHA-256 mismatch");
  if (dataFreeze.schema !== "v15-data-freeze-v2" || dataFreeze.status !== "FROZEN_BEFORE_RETURNS") fail("data freeze v2 status drift");
  const originalFreeze = asRecord(dataFreeze.originalFreeze, "data freeze v2 originalFreeze");
  if (originalFreeze.commit !== ORIGINAL_FREEZE_COMMIT || originalFreeze.sha256 !== ORIGINAL_FREEZE_SHA256) fail("original freeze provenance drift");
  if (dataFreeze.baseline !== BASELINE || dataFreeze.branch !== BRANCH || dataFreeze.historicalReturnsRead !== false) fail("data freeze v2 identity drift");

  await readJson("v15-archive-registry.json");
  await readJson("v15-stage-b-archive-manifest.json");
  await readJson("v15-cost-input-manifest.json");
  const dataFreezeArchiveRegistry = asRecord(dataFreeze.archiveRegistry, "data freeze v2 archiveRegistry");
  const dataFreezeStageManifest = asRecord(dataFreeze.stageBArchiveManifest, "data freeze v2 stageBArchiveManifest");
  const dataFreezeCostManifest = asRecord(dataFreeze.costInputManifest, "data freeze v2 costInputManifest");
  await assertFileHash("v15-archive-registry.json", dataFreezeArchiveRegistry.sha256, "archive registry");
  await assertFileHash("v15-stage-b-archive-manifest.json", dataFreezeStageManifest.sha256, "stage B archive manifest");
  await assertFileHash("v15-cost-input-manifest.json", dataFreezeCostManifest.sha256, "cost input manifest");

  const dataGate = await readJson("v15-data-gate.json");
  const dataGateV3 = await readJson("v15-data-gate-v3.json");
  if (!sameJson(dataGate, dataGateV3)) fail("v2 and v3 data gate payloads diverge");
  if (dataGateV3.schema !== "v15-data-gate-v3") fail("unknown data gate schema");
  if (dataGateV3.baseline !== BASELINE || dataGateV3.branch !== BRANCH) fail("data gate identity drift");
  if (dataGateV3.historicalReturnsRead !== false) fail("data gate claims returns were read");
  if (dataGateV3.status !== "FAIL" && dataGateV3.status !== "PASS") fail("unknown data gate status");
  if (dataGateV3.classification !== (dataGateV3.status === "FAIL" ? "V15_DATA_INSUFFICIENT_FINAL" : "PASS")) fail("data gate classification drift");
  const gateReasons = asArray(dataGateV3.reasons, "data gate reasons");
  const archiveInventory = asRecord(dataGateV3.archiveInventory, "data gate archiveInventory");
  const requiredArchiveSlots = asFiniteNumber(archiveInventory.requiredArchiveSlots, "required archive slots");
  const materializedArchiveSlots = asFiniteNumber(archiveInventory.materializedArchiveSlots, "materialized archive slots");
  const validArchiveSlots = asFiniteNumber(archiveInventory.validArchiveSlots, "valid archive slots");
  const invalidArchiveSlots = asFiniteNumber(archiveInventory.invalidArchiveSlots, "invalid archive slots");
  const usedArchiveSlots = asFiniteNumber(archiveInventory.usedArchiveSlots, "used archive slots");
  const invalidPairMonths = asArray(archiveInventory.invalidPairMonths, "invalid pair-month exclusions");
  const invalidArchiveKeys = asArray(archiveInventory.invalidArchiveKeys, "invalid archive keys");
  if (materializedArchiveSlots !== requiredArchiveSlots) fail("materialized archive inventory is incomplete");
  if (validArchiveSlots + invalidArchiveSlots !== requiredArchiveSlots) fail("archive inventory counts do not reconcile");
  if (invalidArchiveSlots !== invalidPairMonths.length * 2 || invalidArchiveKeys.length !== invalidArchiveSlots) fail("invalid archive exclusion counts do not reconcile");
  if (usedArchiveSlots !== validArchiveSlots) fail("used archive slots are not limited to valid archives");
  if (archiveInventory.usedChecksumCoverage !== 1 || archiveInventory.usedIntegrityCoverage !== 1) fail("used archive checksum/integrity coverage is incomplete");
  if (archiveInventory.officialRegistryComplete !== true || archiveInventory.stageInventoryComplete !== true) fail("official archive inventory is incomplete");
  const gateLifecycle = asRecord(dataGateV3.lifecycle, "data gate lifecycle");
  const gateCostInputs = asRecord(dataGateV3.costInputs, "data gate costInputs");
  if (gateLifecycle.noCurrentSurvivorFilter !== true || gateLifecycle.noFutureLifecycle !== true) fail("PIT lifecycle proof is incomplete");
  if (gateCostInputs.noFallback !== true) fail("synthetic cost fallback is not ruled out");
  const gateCostAvailability = asRecord(dataGateV3.costAvailability, "data gate costAvailability");
  if (gateCostAvailability.noFallback !== true) fail("cost availability fallback proof is incomplete");
  const gateDefinitions = asRecord(dataGateV3.definitions, "data gate definitions");
  const gateCandidates = asRecord(dataGateV3.candidates, "data gate candidates");

  const freezeDataGateHash = manifest.dataGateHash;
  if (typeof freezeDataGateHash !== "string" || freezeDataGateHash !== hash(JSON.stringify(dataGateV3))) fail("freeze manifest data gate hash mismatch");
  const dataFreezeGate = asRecord(dataFreeze.dataGate, "data freeze v2 dataGate");
  await assertFileHash("v15-data-gate.json", dataFreezeGate.sha256, "data freeze v2 data gate");
  if (dataFreezeGate.path !== "reports/v15-data-gate.json" || dataFreezeGate.status !== dataGateV3.status) fail("data freeze v2 data gate link drift");

  const dataFreezeV3 = await readJson("v15-data-freeze-v3.json");
  const dataFreezeV3Hash = dataFreezeV3.manifestSha256;
  const dataFreezeV3Body = { ...dataFreezeV3 };
  delete dataFreezeV3Body.manifestSha256;
  if (typeof dataFreezeV3Hash !== "string" || dataFreezeV3Hash !== hash(JSON.stringify(dataFreezeV3Body))) fail("data freeze v3 SHA-256 mismatch");
  if (dataFreezeV3.schema !== "v15-data-freeze-v3" || dataFreezeV3.status !== "FROZEN_BEFORE_RETURNS") fail("data freeze v3 status drift");
  if (dataFreezeV3.baseline !== BASELINE || dataFreezeV3.branch !== BRANCH || dataFreezeV3.historicalReturnsRead !== false) fail("data freeze v3 identity drift");
  if (dataFreezeV3.dataFreezeV2Sha256 !== dataFreezeHash) fail("data freeze v3 does not reference data freeze v2");
  if (!sameJson(dataFreezeV3.invalidPairMonths, invalidPairMonths)) fail("invalid pair-month exclusions drift");
  if (dataFreezeV3.invalidArchiveExclusionHash !== archiveInventory.invalidArchiveExclusionHash || dataFreezeV3.invalidArchiveExclusionHash !== hash(JSON.stringify(invalidPairMonths))) fail("invalid archive exclusion hash drift");
  if (dataFreezeV3.advCoverageDefinitionHash !== gateDefinitions.advCoverageDefinitionHash) fail("ADV definition hash drift");
  if (dataFreezeV3.costAvailabilityDefinitionHash !== gateCostAvailability.definitionHash) fail("cost availability definition hash drift");
  if (dataFreezeV3.candidateSettlementCoverageDefinitionHash !== gateCandidates.settlementDefinitionHash) fail("settlement definition hash drift");
  const dataFreezeV3Gate = asRecord(dataFreezeV3.dataGateV3, "data freeze v3 dataGateV3");
  await assertFileHash("v15-data-gate-v3.json", dataFreezeV3Gate.sha256, "data freeze v3 data gate");
  if (dataFreezeV3Gate.path !== "reports/v15-data-gate-v3.json" || dataFreezeV3Gate.status !== dataGateV3.status) fail("data freeze v3 data gate link drift");

  const evidence = await readJson("v15-evidence-manifest.json");
  if (evidence.schema !== "v15-evidence-manifest-v3" || evidence.baseline !== BASELINE || evidence.branch !== BRANCH) fail("evidence manifest identity drift");
  if (evidence.freezeSha256 !== manifestHash || evidence.dataFreezeV2Sha256 !== dataFreezeHash || evidence.dataFreezeV3Sha256 !== dataFreezeV3Hash) fail("evidence freeze provenance drift");
  if (evidence.dataGateV3Sha256 !== await fileHash("v15-data-gate-v3.json") || evidence.historicalReturnsRead !== false) fail("evidence data gate provenance drift");
  if (dataGateV3.status === "FAIL" && evidence.resultCommit !== null) fail("failed data gate has a result commit");
  const evidenceArtifacts = asRecord(evidence.artifacts, "evidence artifacts");
  const artifactNames = ["v15-data-gate.json", "v15-data-gate-v3.json", "v15-archive-registry.json", "v15-stage-b-archive-manifest.json", "v15-cost-input-manifest.json", "v15-freeze-manifest.json", "v15-data-freeze-v2.json", "v15-data-freeze-v3.json", "v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-validation-summary.json", "v15-promotion-decision.json", "v15-promotion-decision.md"];
  for (const name of artifactNames) await assertFileHash(name, evidenceArtifacts[name], `evidence artifact ${name}`);

  const result = await readJson("v15-validation-summary.json");
  if (result.baseline !== BASELINE || result.branch !== BRANCH) fail("result identity drift");
  if (result.freezeSha256 !== manifestHash || result.dataFreezeV2Sha256 !== dataFreezeHash || result.dataFreezeV3Sha256 !== dataFreezeV3Hash) fail("result provenance drift");
  if (result.dataGateV3 !== dataGateV3.status || result.historicalReturnsRead !== (dataGateV3.status === "PASS")) fail("result data gate guard drift");
  if (result.emailPromotionCandidate !== (dataGateV3.status === "PASS" ? "PASS" : "FAIL") || result.researchStop !== "YES") fail("result promotion/stop drift");
  if (dataGateV3.status === "FAIL") {
    if (result.result !== "V15_DATA_INSUFFICIENT_FINAL" || result.reasons === undefined || !sameJson(result.reasons, gateReasons)) fail("failed result does not preserve data gate reasons");
    if (result.reason !== `DATA_GATE_V3_FAIL: ${gateReasons.join(", ")}`) fail("failed result reason drift");
    for (const name of ["v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json"]) {
      const notRun = await readJson(name);
      if (notRun.status !== "NOT_RUN" || notRun.historicalReturnsRead !== false || notRun.metrics !== null) fail(`${name} is not a truthful NOT_RUN artifact`);
    }
    const promotion = await readJson("v15-promotion-decision.json");
    if (promotion.dataGateV3 !== "FAIL" || !sameJson(promotion.dataGateReasons, gateReasons) || promotion.historicalReturnsRead !== false) fail("promotion decision drift");
  }
  console.info(JSON.stringify({ artifact: "v15", status: "PASS", freezeSha256: manifestHash, resultWritten: Boolean(result), historicalReturnsRead: result?.historicalReturnsRead ?? false }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
