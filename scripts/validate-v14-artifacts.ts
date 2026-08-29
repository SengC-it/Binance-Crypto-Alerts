import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve("reports");
const required = [
  "v14-final-integrity-freeze-manifest.json",
  "v14-data-gate.json",
  "v14-validation-summary.json",
  "v14-family-results.json",
  "v14-promotion-decision.json",
  "v14-promotion-decision.md",
  "v14-evidence-manifest.json",
];

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function assertCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function containsExactFundingPlaceholder(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsExactFundingPlaceholder);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) =>
    (key === "fundingR" && nested === -1) || containsExactFundingPlaceholder(nested),
  );
}

async function main(): Promise<void> {
const documents = new Map<string, unknown>();
for (const name of required) {
  const contents = await readFile(resolve(root, name), "utf8");
  documents.set(name, name.endsWith(".md") ? contents : JSON.parse(contents));
}

const freeze = documents.get("v14-final-integrity-freeze-manifest.json") as Record<string, unknown>;
const { manifestSha256: freezeHash, ...freezeBody } = freeze;
assertCondition(typeof freezeHash === "string" && hash(freezeBody) === freezeHash, "correctness freeze manifest hash mismatch");
assertCondition(freeze.schema === "v14-final-integrity-freeze-manifest-v1", "final integrity freeze schema missing");
assertCondition(freeze.rulesSha256 === hash(freeze.rules), "correctness freeze rules hash mismatch");
assertCondition((freeze.rules as Record<string, unknown>).priorWindowsContaminatedForPromotion === true, "prior-window contamination flag missing from freeze");

const dataGate = documents.get("v14-data-gate.json") as Record<string, unknown>;
const gate = dataGate.dataGate as Record<string, unknown>;
assertCondition(gate.status === "PASS" && gate.pass === true, "V14 data gate is not PASS");
assertCondition(gate.currentSurvivorOnlyUniverse === false && gate.futureLifecycleFilter === "NO", "PIT lifecycle boundary failed");
const dataCounts = gate.archiveCounts as Record<string, number>;
assertCondition(dataCounts.requestedArchiveSlots >= 0 && dataCounts.availableZipCount >= dataCounts.checksumPassZipCount, "data gate archive arithmetic failed");
const fundingGate = gate.fundingGate as Record<string, unknown> | undefined;
assertCondition(typeof fundingGate === "object", "funding gate missing");
assertCondition(Number(fundingGate?.requiredMarkCoverage) === 0.995, "funding mark coverage gate changed");
assertCondition(Number(fundingGate?.markCoverage) >= 0 && Number(fundingGate?.markCoverage) <= 1, "funding mark coverage invalid");

const evidence = documents.get("v14-evidence-manifest.json") as Record<string, unknown>;
const { evidenceSha256, ...evidenceBody } = evidence;
assertCondition(typeof evidenceSha256 === "string" && hash(evidenceBody) === evidenceSha256, "evidence manifest hash mismatch");
for (const key of ["requestedArchiveSlots", "availableZipCount", "checksumPassZipCount", "missingSlotCount", "failedZipCount", "fundingRateZipCount", "markPriceZipCount", "fundingEvents", "exactMarkMatches", "fallbackMarkMatches", "missingMarkEvents", "fundingUnavailableLegs", "fundingUnavailableEvents"]) assertCondition(Number.isInteger(evidence[key]) && Number(evidence[key]) >= 0, `invalid evidence count: ${key}`);
assertCondition(Number(evidence.checksumPassZipCount) <= Number(evidence.availableZipCount), "checksum count exceeds available ZIP count");
assertCondition(Number(evidence.dailyRequestedArchiveSlots) === Number(dataCounts.requestedArchiveSlots), "daily requested slot count mismatch");
assertCondition(Number(evidence.markCoverage) >= 0 && Number(evidence.markCoverage) <= 1, "evidence mark coverage invalid");

const summary = documents.get("v14-validation-summary.json") as Record<string, unknown>;
const familyResults = documents.get("v14-family-results.json") as Record<string, Record<string, unknown>>;
const summaryFamilies = summary.families as Record<string, Record<string, unknown>>;
for (const family of ["FAMILY_A_PURE_REVERSAL", "FAMILY_B_HIGH_VOL_REVERSAL", "FAMILY_C_DISPERSION_REVERSAL"]) {
  assertCondition(familyResults[family]?.status === summaryFamilies[family]?.status, `${family} status mismatch`);
  const familyGate = familyResults[family]?.gate as Record<string, boolean>;
  assertCondition(typeof familyGate === "object", `${family} gate missing`);
  assertCondition(familyResults[family].confirmationA !== undefined && familyResults[family].confirmationB !== undefined, `${family} confirmation windows missing`);
}
assertCondition(summary.EMAIL_PROMOTION_CANDIDATE === "FAIL", "promotion flag must remain FAIL");
assertCondition(summary.researchStop === "YES", "research stop must be YES");
assertCondition(summary.priorWindowsContaminatedForPromotion === true, "summary contamination flag missing");
assertCondition(["V14_CROSS_SECTIONAL_REVERSAL_REJECTED", "V14_FUNDING_DATA_INSUFFICIENT", "V14_CORRECTNESS_PASS_EXTERNAL_CONFIRMATION_REQUIRED"].includes(String(summary.result)), "invalid V14 result state");
const boundaries = summary.boundaries as Record<string, boolean>;
for (const key of ["productionChanged", "productionEmail", "autoTrading", "privateBinanceApi", "orderPlacement", "smtpProductionSignal", "deployment", "merge", "migration", "v13Changed", "shadow002Restarted"]) assertCondition(boundaries[key] === false, `boundary changed: ${key}`);

const decision = documents.get("v14-promotion-decision.json") as Record<string, unknown>;
assertCondition(decision.status === summary.result && decision.priorWindowsContaminatedForPromotion === true, "promotion decision mismatch");
for (const [name, document] of documents) {
  assertCondition(!containsExactFundingPlaceholder(document), `invalid -100% funding substitution remains in ${name}`);
}
assertCondition(String(documents.get("v14-promotion-decision.md")).includes(String(summary.result)), "promotion markdown mismatch");
console.log(JSON.stringify({ stage: "v14_artifact_validation_complete", status: "V14_ARTIFACT_VALIDATION_PASS", result: summary.result, promotion: summary.EMAIL_PROMOTION_CANDIDATE }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
