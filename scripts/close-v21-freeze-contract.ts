import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_REPOSITORY,
  V21_START_TIMESTAMP,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import {
  V21_BOOTSTRAP_CONTRACT,
  V21_CLASSIFICATION_CONTRACT,
  V21_COST_CONTRACT,
  V21_EXECUTION_CONTRACT,
  V21_METRIC_CONTRACT,
  V21_OUTCOME_AVAILABILITY_CONTRACT,
  V21_PROMOTION_GATE_DEFINITIONS,
} from "../lib/v21/result-evaluator";
import { canonicalTextSha256, sha256, sha256Bytes } from "../lib/v21/canonical";

const REPORT_DIR = resolve("reports");
const APPROVED_WP3B_COMMIT = "1b9bebed1071e00bbd44269d38577205cc6f84ed";
const APPROVED_WP3B_DIRECT_PARENT = "39a670aa5a777876ba8cccfc5e8eaed14f061194";
const EXPECTED_PRIMARY_EVENT_DIGESTS = {
  allEvents: "a8435418f6007dd6a25a20d1a292fabd5cdfaa84f7cc7d713a617ed375ebec4b",
  primaryOosEvents: "621607df1f34fbb378ec938a5808ca27de17918dda498433da396e73e02d840c",
  holdoutAEvents: "fda762168a03429660b9805d616cbc88b54ce02f556abaa2bc7148b1e401ec6d",
  holdoutBEvents: "cf46b0ccad40b4ba84300e70c78438d943a96d8d1bc6adcc15bfdf8d85dd7433",
} as const;
const EXPECTED_PRIMARY_COUNTS = {
  allEvents: 29090,
  primaryOosEvents: 19160,
  holdoutAEvents: 6212,
  holdoutBEvents: 3718,
  primaryClusters: 16532,
} as const;
const EXPECTED_PRIMARY_EVENT_AUDIT_SHA = "305b0d897e86031e742e9f6c3bddadc363806f35ee4a6cb956698d38cfcfe785";
const EXPECTED_PRIOR_EVIDENCE_LOCK_SHA = "021aa5bf9a34df978784ef0473272b39a53c9da128a95ff685a3150f41a74872";
const EXPECTED_CONTROL_ARTIFACT_HASHES = {
  "v21-control-identities.json": "478ad14f6cda2efebe9e9ffbed46c31381d6e6c12f5511e7cb027ca2e9e83ce6",
  "v21-control-audit.json": "38e7a446ac3676c235eb51d468e3d123ce0f3db95f4560402784a955ff8e607a",
  "v21-control-enumeration.json": "44bb19d6ffe6e82445abf8bcc594e433e7a928f9b77f2b3d6d4aee85537f1ee1",
} as const;
const SOURCE_FILES = [
  "lib/v21/controls.ts",
  "lib/v21/result-evaluator.ts",
  "scripts/run-v21-freeze.ts",
  "scripts/validate-v21-freeze.ts",
  "scripts/close-v21-freeze-contract.ts",
  "tests/v21-controls.test.ts",
  "tests/v21-result-evaluator.test.ts",
] as const;

async function main(): Promise<void> {
  const controlIdentities = await readJson("v21-control-identities.json");
  const controlAudit = await readJson("v21-control-audit.json");
  const controlEnumeration = await readJson("v21-control-enumeration.json");
  await assertFrozenControlArtifacts();

  const controlIdentityDigests = Object.fromEntries(
    Object.entries(controlIdentities.controls).map(([name, value]: [string, any]) => [name, value.digests]),
  );
  const resultContract = {
    schemaVersion: "v21-result-contract-v2",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    approvedWp3bCommit: APPROVED_WP3B_COMMIT,
    contractOnly: true,
    realOutcomeEvaluationPerformed: false,
    entryPriceField: "open",
    exitPriceField: "close",
    execution: V21_EXECUTION_CONTRACT,
    outcomeAvailabilityContract: V21_OUTCOME_AVAILABILITY_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    bootstrapSeedCallerOverrideAllowed: false,
    clusterIdentityMutable: false,
    yearDerivedFromSignalTimestamp: true,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    evaluator: {
      source: "lib/v21/result-evaluator.ts",
      pureDeterministic: true,
      network: false,
      productionDependencies: false,
      realV21PricesCalledInWp3B: false,
    },
  };
  await writeJson("v21-result-contract.json", resultContract);
  const resultContractSha256 = await reportHash("v21-result-contract.json");

  const sourceHashes = await hashSources();
  const freezeBundle = {
    primaryEventDigests: EXPECTED_PRIMARY_EVENT_DIGESTS,
    primaryEventAuditSha256: EXPECTED_PRIMARY_EVENT_AUDIT_SHA,
    priorEvidenceLockSha256: EXPECTED_PRIOR_EVIDENCE_LOCK_SHA,
    controlIdentityDigests,
    controlAuditSha256: EXPECTED_CONTROL_ARTIFACT_HASHES["v21-control-audit.json"],
    resultContractSha256,
    entryPriceField: "open",
    exitPriceField: "close",
    execution: V21_EXECUTION_CONTRACT,
    outcomeAvailabilityContract: V21_OUTCOME_AVAILABILITY_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: sourceHashes["lib/v21/result-evaluator.ts"],
    resultEvaluatorTestsSha256: sourceHashes["tests/v21-result-evaluator.test.ts"],
    freezeValidatorSha256: sourceHashes["scripts/validate-v21-freeze.ts"],
    contractClosureSourceSha256: sourceHashes["scripts/close-v21-freeze-contract.ts"],
    bootstrapSeedCallerOverrideAllowed: false,
    clusterIdentityMutable: false,
    yearDerivedFromSignalTimestamp: true,
  };
  const flags = {
    historicalSignalFeatureReturnsRead: true,
    controlsEnumerated: true,
    controlsEnumeratedAtWp3A: false,
    historicalStrategyOutcomeReturnsRead: false,
    realOutcomePricesRead: false,
    nextBarOpenRead: false,
    futurePriceRead: false,
    forwardReturnsRead: false,
    executionEvaluated: false,
    oosMetricsRead: false,
    holdoutOutcomeRead: false,
    holdoutRead: false,
    promotionEvaluated: false,
    parameterSearch: false,
    freezeCreated: true,
    resultCommitCreated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    migration: false,
    privateBinanceApi: false,
    orderPlacement: false,
    autoTrading: false,
    automaticPromotion: false,
  } as const;
  const freezeManifestBody = {
    schemaVersion: "v21-freeze-manifest-v2",
    experimentId: V21_EXPERIMENT_ID,
    repository: V21_REPOSITORY,
    branch: V21_BRANCH,
    baseResearchSha: V21_BASE_SHA,
    approvedWp3bCommit: APPROVED_WP3B_COMMIT,
    approvedWp3bDirectParent: APPROVED_WP3B_DIRECT_PARENT,
    fixedSymbols: V21_SYMBOLS,
    period: {
      start: V21_START_TIMESTAMP,
      endExclusive: V21_END_EXCLUSIVE_TIMESTAMP,
    },
    primaryEventDigests: EXPECTED_PRIMARY_EVENT_DIGESTS,
    primaryCounts: EXPECTED_PRIMARY_COUNTS,
    primaryEventAuditSha256: EXPECTED_PRIMARY_EVENT_AUDIT_SHA,
    priorStageEvidenceLockSha256: EXPECTED_PRIOR_EVIDENCE_LOCK_SHA,
    controls: {
      definitions: controlEnumeration.definitions,
      identityDigests: controlIdentityDigests,
      identityArtifactSha256: EXPECTED_CONTROL_ARTIFACT_HASHES["v21-control-identities.json"],
      auditSha256: EXPECTED_CONTROL_ARTIFACT_HASHES["v21-control-audit.json"],
      enumerationArtifactSha256: EXPECTED_CONTROL_ARTIFACT_HASHES["v21-control-enumeration.json"],
    },
    resultContractSha256,
    entryPriceField: "open",
    exitPriceField: "close",
    execution: V21_EXECUTION_CONTRACT,
    horizons: V21_EXECUTION_CONTRACT.horizons,
    outcomeAvailabilityContract: V21_OUTCOME_AVAILABILITY_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: sourceHashes["lib/v21/result-evaluator.ts"],
    resultEvaluatorTestsSha256: sourceHashes["tests/v21-result-evaluator.test.ts"],
    freezeValidatorSha256: sourceHashes["scripts/validate-v21-freeze.ts"],
    contractClosureSourceSha256: sourceHashes["scripts/close-v21-freeze-contract.ts"],
    bootstrapSeedCallerOverrideAllowed: false,
    clusterIdentityMutable: false,
    yearDerivedFromSignalTimestamp: true,
    sourceHashes,
    flags,
    ...flags,
    freezeBundle,
    freezeBundleSha256: sha256(freezeBundle),
  };
  await writeJson("v21-freeze-manifest.json", {
    ...freezeManifestBody,
    manifestBodySha256: sha256(freezeManifestBody),
  });
  void controlAudit;
  console.info("V21 WP3B.1 result contract closure artifacts written");
}

async function assertFrozenControlArtifacts(): Promise<void> {
  for (const [name, expected] of Object.entries(EXPECTED_CONTROL_ARTIFACT_HASHES)) {
    const bytes = await readFile(resolve(REPORT_DIR, name));
    assertEqual(sha256Bytes(bytes), expected, `${name} byte hash`);
    assertEqual(canonicalTextSha256(bytes.toString("utf8")), expected, `${name} canonical hash`);
  }
}

async function hashSources(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const source of SOURCE_FILES) hashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  return hashes;
}

async function reportHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`V21 WP3B.1 closure failed: ${message}; expected ${expected}, got ${actual}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
