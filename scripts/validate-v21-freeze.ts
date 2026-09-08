import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V21_BASE_SHA,
  V21_BRANCH,
  V21_END_EXCLUSIVE_TIMESTAMP,
  V21_EXPERIMENT_ID,
  V21_INTERVAL_MS,
  V21_REPORT_FILES,
  V21_SYMBOLS,
} from "../lib/v21/constants";
import {
  V21_CONTROL_NAMES,
  V21_TIME_MATCHED_RANDOM_SEED,
  deriveV21PlaceboSeed,
  type V21ControlName,
  type V21ControlAuditRow,
  type V21ControlPlaceboAuditRow,
} from "../lib/v21/controls";
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
import type { V21EventIdentity } from "../lib/v21/events";

const REPORT_DIR = resolve("reports");
const APPROVED_WP3A1_COMMIT = "39a670aa5a777876ba8cccfc5e8eaed14f061194";
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
const EXPECTED_EVENT_AUDIT_SHA = "305b0d897e86031e742e9f6c3bddadc363806f35ee4a6cb956698d38cfcfe785";
const EXPECTED_PRIMARY_IDENTITY_ARTIFACT_SHA = "505e5481a66711d974b83b3252429181c4c3b2efcdb73a785edf61fe00c636b8";
const EXPECTED_PRIOR_EVIDENCE_LOCK_SHA = "021aa5bf9a34df978784ef0473272b39a53c9da128a95ff685a3150f41a74872";
const EXPECTED_CONTROL_ARTIFACT_HASHES = {
  "v21-control-identities.json": {
    raw: "478ad14f6cda2efebe9e9ffbed46c31381d6e6c12f5511e7cb027ca2e9e83ce6",
    canonical: "478ad14f6cda2efebe9e9ffbed46c31381d6e6c12f5511e7cb027ca2e9e83ce6",
  },
  "v21-control-audit.json": {
    raw: "38e7a446ac3676c235eb51d468e3d123ce0f3db95f4560402784a955ff8e607a",
    canonical: "38e7a446ac3676c235eb51d468e3d123ce0f3db95f4560402784a955ff8e607a",
  },
  "v21-control-enumeration.json": {
    raw: "44bb19d6ffe6e82445abf8bcc594e433e7a928f9b77f2b3d6d4aee85537f1ee1",
    canonical: "44bb19d6ffe6e82445abf8bcc594e433e7a928f9b77f2b3d6d4aee85537f1ee1",
  },
} as const;
const FORBIDDEN_RESULT_ARTIFACTS = [
  "reports/v21-primary-oos.json",
  "reports/v21-holdout-results.json",
  "reports/v21-performance.json",
  "reports/v21-result.json",
  "reports/v21-promotion-decision.json",
  "reports/v21-promotion-decision.md",
] as const;
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
  runDependencyValidators();
  assert(existsSync(resolve("reports/v21-freeze-manifest.json")), "freeze manifest missing");
  for (const path of FORBIDDEN_RESULT_ARTIFACTS) assert(!existsSync(resolve(path)), `real result artifact exists: ${path}`);

  const eventReport = await readJson("v21-event-enumeration.json");
  const eventIdentities = await readJson("v21-event-identities.json");
  const eventAudit = await readJson("v21-event-audit.json");
  const priorEvidenceLock = await readJson("v21-prior-stage-evidence-lock.json");
  const controlIdentities = await readJson("v21-control-identities.json");
  const controlAudit = await readJson("v21-control-audit.json");
  const controlEnumeration = await readJson("v21-control-enumeration.json");
  const resultContract = await readJson("v21-result-contract.json");
  const manifest = await readJson("v21-freeze-manifest.json");

  assertGitDependency();
  await assertPrimaryLock(eventReport, eventIdentities, eventAudit, priorEvidenceLock);
  assertControlIdentities(controlIdentities);
  assertControlAudits(controlAudit, controlIdentities, eventIdentities);
  await assertControlEnumeration(controlEnumeration, controlIdentities, controlAudit);
  await assertControlArtifactsUnchanged();
  assertResultContract(resultContract);
  await assertFreezeManifest(manifest, controlIdentities, controlAudit, controlEnumeration, resultContract);

  const reportNames = await readdir(REPORT_DIR);
  const allowed = new Set(V21_REPORT_FILES.map((path) => path.replace(/^reports\//, "")));
  const unexpected = reportNames.filter((name) => name.startsWith("v21-") && !allowed.has(name));
  assertEqual(unexpected, [], "unexpected V21 report artifacts");
  console.info("V21 WP3B freeze validation PASS");
}

function assertGitDependency(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
  const workflowBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "";
  if (branch === "HEAD" && workflowBranch) assertEqual(workflowBranch, V21_BRANCH, "workflow branch");
  else assertEqual(branch, V21_BRANCH, "branch");
  assertEqual(parent, APPROVED_WP3B_COMMIT, "WP3B.1 direct parent");
}

async function assertPrimaryLock(eventReport: any, identities: any, audit: any, priorLock: any): Promise<void> {
  assertEqual(eventReport.eventDigests, EXPECTED_PRIMARY_EVENT_DIGESTS, "primary event digests");
  assertEqual(eventReport.diagnostics.finalEligibleEvents, EXPECTED_PRIMARY_COUNTS.allEvents, "primary final events");
  assertEqual(eventReport.diagnostics.eventsByPeriod.primaryOos, EXPECTED_PRIMARY_COUNTS.primaryOosEvents, "primary OOS events");
  assertEqual(eventReport.diagnostics.eventsByPeriod.holdoutA, EXPECTED_PRIMARY_COUNTS.holdoutAEvents, "holdout A events");
  assertEqual(eventReport.diagnostics.eventsByPeriod.holdoutB, EXPECTED_PRIMARY_COUNTS.holdoutBEvents, "holdout B events");
  assertEqual(eventReport.diagnostics.distinctPrimarySignalClusters, EXPECTED_PRIMARY_COUNTS.primaryClusters, "primary clusters");
  assertEqual(eventReport.identityArtifactSha256, EXPECTED_PRIMARY_IDENTITY_ARTIFACT_SHA, "primary identity artifact");
  assertEqual(await reportHash("v21-event-audit.json"), EXPECTED_EVENT_AUDIT_SHA, "primary audit hash");
  assertEqual(await reportHash("v21-prior-stage-evidence-lock.json"), EXPECTED_PRIOR_EVIDENCE_LOCK_SHA, "prior evidence lock hash");
  for (const name of ["allEvents", "primaryOosEvents", "holdoutAEvents", "holdoutBEvents"] as const) {
    assertIdentityArray(identities[name], name);
    assertEqual(eventReport.eventDigests[name], sha256(identities[name]), `${name} digest`);
  }
  assertEqual(new Set(identities.primaryOosEvents.map((event: V21EventIdentity) => event.clusterId)).size, EXPECTED_PRIMARY_COUNTS.primaryClusters, "primary identity clusters");
  assertEqual(audit.noOutcomeFields, true, "primary audit outcome boundary");
  assertEqual(priorLock.experimentId, V21_EXPERIMENT_ID, "prior lock identity");
  assert(eventReport.historicalSignalFeatureReturnsRead === true, "primary feature boundary");
  for (const key of [
    "historicalStrategyOutcomeReturnsRead",
    "forwardReturnsRead",
    "nextBarOpenRead",
    "futurePriceRead",
    "holdoutOutcomeRead",
    "executionEvaluated",
    "oosMetricsRead",
    "holdoutRead",
    "parameterSearch",
    "controlsEnumerated",
  ]) assert(eventReport[key] === false, `primary boundary ${key}`);
}

function assertControlIdentities(report: any): void {
  assertEqual(report.schemaVersion, "v21-control-identities-v1", "control identity schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "control identity experiment");
  assertEqual(report.repository, "SengC-it/Binance-Crypto-Alerts", "control identity repository");
  assertEqual(report.branch, V21_BRANCH, "control identity branch");
  assertEqual(report.approvedWp3a1Commit, APPROVED_WP3A1_COMMIT, "control identity WP3A.1 commit");
  assertEqual(report.identityFields, ["symbol", "signalOpenTime", "direction", "clusterId"], "control identity fields");
  assertEqual(report.noOutcomeFields, true, "control identity outcome boundary");
  assertEqual(Object.keys(report.controls).sort(), [...V21_CONTROL_NAMES].sort(), "control identity names");
  for (const name of V21_CONTROL_NAMES) {
    const control = report.controls[name];
    for (const period of ["allEvents", "primaryOosEvents", "holdoutAEvents", "holdoutBEvents"] as const) assertIdentityArray(control[period], `${name}.${period}`);
    assertEqual(control.digests.allEvents, sha256(control.allEvents), `${name} all digest`);
    assertEqual(control.digests.primaryOosEvents, sha256(control.primaryOosEvents), `${name} primary digest`);
    assertEqual(control.digests.holdoutAEvents, sha256(control.holdoutAEvents), `${name} holdout A digest`);
    assertEqual(control.digests.holdoutBEvents, sha256(control.holdoutBEvents), `${name} holdout B digest`);
    assertEqual(control.counts, {
      all: control.allEvents.length,
      primary: control.primaryOosEvents.length,
      holdoutA: control.holdoutAEvents.length,
      holdoutB: control.holdoutBEvents.length,
    }, `${name} counts`);
    assertNoOutcomeKeys(control, `${name} identity`);
  }
}

function assertControlAudits(report: any, identitiesReport: any, primaryIdentities: any): void {
  assertEqual(report.schemaVersion, "v21-control-audit-v1", "control audit schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "control audit experiment");
  assertEqual(report.noOutcomeFields, true, "control audit outcome boundary");
  assertEqual(Object.keys(report.controls).sort(), [...V21_CONTROL_NAMES].sort(), "control audit names");
  for (const name of ["RAW_RETURN_REVERSAL", "SIMPLE_MEDIAN_GAP_REVERSAL"] as const) {
    const rows = report.controls[name].auditRows as V21ControlAuditRow[];
    let previous: [number, string] | null = null;
    const accepted: V21EventIdentity[] = [];
    const acceptedBySymbol = new Map<string, number>();
    for (const row of rows) {
      assertEqual(Object.keys(row), ["control", "symbol", "signalOpenTime", "featureValue", "previousFeatureValue", "q99Threshold", "direction", "clusterId", "overlapStatus"], `${name} audit fields`);
      assertEqual(row.control, name, `${name} audit control`);
      assert((V21_SYMBOLS as readonly string[]).includes(row.symbol), `${name} audit symbol`);
      assert(Number.isSafeInteger(row.signalOpenTime), `${name} audit timestamp`);
      assert(Number.isFinite(row.featureValue) && Number.isFinite(row.previousFeatureValue), `${name} audit feature values`);
      assert(Number.isFinite(row.q99Threshold) && row.q99Threshold >= 0, `${name} audit threshold`);
      assert(row.direction === null || row.direction === "LONG" || row.direction === "SHORT", `${name} audit direction`);
      assertEqual(row.clusterId, row.signalOpenTime, `${name} audit cluster`);
      assert(row.overlapStatus === "ACCEPTED" || row.overlapStatus === "OVERLAPPING_SIGNAL_EXCLUDED", `${name} audit overlap`);
      const sortKey: [number, string] = [row.signalOpenTime, row.symbol];
      if (previous) assert(sortKey[0] > previous[0] || (sortKey[0] === previous[0] && sortKey[1] >= previous[1]), `${name} audit ordering`);
      previous = sortKey;
      if (row.direction !== null && row.overlapStatus === "ACCEPTED") {
        const last = acceptedBySymbol.get(row.symbol);
        if (last !== undefined) assert(row.signalOpenTime >= last + 30 * 60 * 1000, `${name} identity overlap`);
        acceptedBySymbol.set(row.symbol, row.signalOpenTime);
        accepted.push({ symbol: row.symbol, signalOpenTime: row.signalOpenTime, direction: row.direction, clusterId: row.clusterId });
      }
      assertNoOutcomeKeys(row, `${name} audit`);
    }
    const control = identitiesReport.controls[name];
    assertEqual(accepted, control.allEvents, `${name} audit identity projection`);
    assertEqual(report.controls[name].counts.auditRows, rows.length, `${name} audit row count`);
    assertEqual(report.controls[name].counts.acceptedEvents, control.allEvents.length, `${name} accepted count`);
    assertEqual(report.controls[name].identityDigests, control.digests, `${name} audit digests`);
  }

  const placebo = report.controls.TIME_MATCHED_RANDOM;
  const rows = placebo.auditRows as V21ControlPlaceboAuditRow[];
  const targets = primaryIdentities.allEvents as V21EventIdentity[];
  assertEqual(rows.length, targets.length, "placebo one-to-one row count");
  const targetKeys = new Set(targets.map(eventKey));
  const seenTargets = new Set<string>();
  const seenRandom = new Set<string>();
  const acceptedTimes = new Set(targets.map((event) => `${event.symbol}|${event.signalOpenTime}`));
  const randomTimesBySymbol = new Map<string, number[]>();
  for (const row of rows) {
    assertEqual(Object.keys(row), ["control", "targetV21Symbol", "targetV21SignalOpenTime", "targetDirection", "targetYYYYMM", "targetUtcHour", "randomSignalOpenTime", "seed", "derivedSeed", "stratumId", "clusterId"], "placebo audit fields");
    assertEqual(row.control, "TIME_MATCHED_RANDOM", "placebo control");
    const targetKey = `${row.targetV21Symbol}|${row.targetV21SignalOpenTime}|${row.targetDirection}`;
    assert(targetKeys.has(targetKey), "placebo target not in primary identities");
    assert(!seenTargets.has(targetKey), "placebo target duplicate");
    seenTargets.add(targetKey);
    const targetDate = new Date(row.targetV21SignalOpenTime);
    const randomDate = new Date(row.randomSignalOpenTime);
    assertEqual(row.targetYYYYMM, utcMonth(row.targetV21SignalOpenTime), "placebo target month");
    assertEqual(row.targetUtcHour, targetDate.getUTCHours(), "placebo target hour");
    assertEqual(row.seed, V21_TIME_MATCHED_RANDOM_SEED, "placebo seed");
    const expectedStratum = `${row.targetV21Symbol}|${row.targetYYYYMM}|${row.targetUtcHour}|${row.targetDirection}`;
    assertEqual(row.stratumId, expectedStratum, "placebo stratum");
    assertEqual(row.derivedSeed, deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, expectedStratum), "placebo derived seed");
    assert(Number.isSafeInteger(row.randomSignalOpenTime), "placebo random timestamp");
    assert(row.randomSignalOpenTime >= Date.parse("2022-01-01T00:00:00.000Z") && row.randomSignalOpenTime < Date.parse(V21_END_EXCLUSIVE_TIMESTAMP), "placebo random range");
    assert(row.randomSignalOpenTime % V21_INTERVAL_MS === 0, "placebo random alignment");
    assertEqual(utcMonth(row.randomSignalOpenTime), row.targetYYYYMM, "placebo random month");
    assertEqual(randomDate.getUTCHours(), row.targetUtcHour, "placebo random hour");
    assert(!acceptedTimes.has(`${row.targetV21Symbol}|${row.randomSignalOpenTime}`), "placebo reuses primary timestamp");
    const randomKey = `${row.targetV21Symbol}|${row.randomSignalOpenTime}`;
    assert(!seenRandom.has(randomKey), "placebo random duplicate");
    seenRandom.add(randomKey);
    const times = randomTimesBySymbol.get(row.targetV21Symbol) ?? [];
    times.push(row.randomSignalOpenTime);
    randomTimesBySymbol.set(row.targetV21Symbol, times);
    assertEqual(row.clusterId, row.randomSignalOpenTime, "placebo cluster");
    assertNoOutcomeKeys(row, "placebo audit");
  }
  assertEqual(seenTargets.size, targets.length, "placebo target coverage");
  for (const [symbol, times] of randomTimesBySymbol) {
    const sorted = [...times].sort((left, right) => left - right);
    for (let index = 1; index < sorted.length; index += 1) assert(sorted[index] - sorted[index - 1] >= 30 * 60 * 1000, `${symbol} placebo overlap`);
  }
  assertEqual(placebo.counts.acceptedEvents, targets.length, "placebo accepted count");
  assertEqual(placebo.identityDigests, identitiesReport.controls.TIME_MATCHED_RANDOM.digests, "placebo digests");
}

async function assertControlEnumeration(report: any, identities: any, audit: any): Promise<void> {
  assertEqual(report.schemaVersion, "v21-control-enumeration-v1", "control enumeration schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "control enumeration experiment");
  assertEqual(report.source.exchange, "BINANCE_DATA_VISION", "control source");
  assertEqual(report.source.immutableArchiveCache, true, "control immutable cache");
  assertEqual(report.source.synchronizedReturnRows, 586943, "control synchronized rows");
  assertEqual(report.controlsEnumeratedAtWp3A, false, "WP3A control boundary");
  assertEqual(report.controlsEnumerated, true, "WP3B control boundary");
  assertEqual(report.timeMatchedRandom.seed, V21_TIME_MATCHED_RANDOM_SEED, "placebo enumeration seed");
  assertEqual(report.timeMatchedRandom.oneToOneTargetMatching, true, "placebo one-to-one contract");
  assertEqual(report.timeMatchedRandom.duplicateFree, true, "placebo duplicate contract");
  assertEqual(report.timeMatchedRandom.sameSymbol30mNonOverlap, true, "placebo overlap contract");
  assertEqual(report.identityDigests, Object.fromEntries(V21_CONTROL_NAMES.map((name) => [name, identities.controls[name].digests])), "enumeration identity digests");
  assertEqual(report.controlIdentitiesSha256, await reportHash("v21-control-identities.json"), "control identity artifact hash");
  assertEqual(report.controlAuditSha256, await reportHash("v21-control-audit.json"), "control audit artifact hash");
  assertEqual(report.historicalSignalFeatureReturnsRead, true, "control feature boundary");
  for (const key of ["historicalStrategyOutcomeReturnsRead", "realOutcomePricesRead", "forwardReturnsRead", "nextBarOpenRead", "futurePriceRead", "executionEvaluated", "promotionEvaluated"]) assert(report[key] === false, `control boundary ${key}`);
  assertNoOutcomeKeys(report.diagnostics, "control diagnostics");
  void audit;
}

async function assertControlArtifactsUnchanged(): Promise<void> {
  for (const [name, expected] of Object.entries(EXPECTED_CONTROL_ARTIFACT_HASHES)) {
    const bytes = await readFile(resolve(REPORT_DIR, name));
    assertEqual(sha256Bytes(bytes), expected.raw, `${name} byte hash`);
    assertEqual(canonicalTextSha256(bytes.toString("utf8")), expected.canonical, `${name} canonical hash`);
  }
}

function assertResultContract(report: any): void {
  assertEqual(report.schemaVersion, "v21-result-contract-v2", "result contract schema");
  assertEqual(report.experimentId, V21_EXPERIMENT_ID, "result contract experiment");
  assertEqual(report.contractOnly, true, "result contract only");
  assertEqual(report.realOutcomeEvaluationPerformed, false, "result contract outcome boundary");
  assertEqual(report.entryPriceField, "open", "result contract entry price field");
  assertEqual(report.exitPriceField, "close", "result contract exit price field");
  assertEqual(report.execution, V21_EXECUTION_CONTRACT, "execution contract");
  assertEqual(report.outcomeAvailabilityContract, V21_OUTCOME_AVAILABILITY_CONTRACT, "outcome availability contract");
  assertEqual(report.costs, V21_COST_CONTRACT, "cost contract");
  assertEqual(report.metrics, V21_METRIC_CONTRACT, "metric contract");
  assertEqual(report.bootstrap, V21_BOOTSTRAP_CONTRACT, "bootstrap contract");
  assertEqual(report.bootstrapSeedCallerOverrideAllowed, false, "bootstrap seed override boundary");
  assertEqual(report.clusterIdentityMutable, false, "cluster identity boundary");
  assertEqual(report.yearDerivedFromSignalTimestamp, true, "UTC year derivation boundary");
  assertEqual(report.promotionGates, V21_PROMOTION_GATE_DEFINITIONS, "promotion contract");
  assertEqual(report.classification, V21_CLASSIFICATION_CONTRACT, "classification contract");
  assertEqual(report.evaluator, {
    source: "lib/v21/result-evaluator.ts",
    pureDeterministic: true,
    network: false,
    productionDependencies: false,
    realV21PricesCalledInWp3B: false,
  }, "evaluator contract");
}

async function assertFreezeManifest(
  manifest: any,
  identities: any,
  audit: any,
  enumeration: any,
  resultContract: any,
): Promise<void> {
  assertEqual(manifest.schemaVersion, "v21-freeze-manifest-v2", "freeze schema");
  assertEqual(manifest.experimentId, V21_EXPERIMENT_ID, "freeze experiment");
  assertEqual(manifest.repository, "SengC-it/Binance-Crypto-Alerts", "freeze repository");
  assertEqual(manifest.branch, V21_BRANCH, "freeze branch");
  assertEqual(manifest.baseResearchSha, V21_BASE_SHA, "freeze base");
  assertEqual(manifest.approvedWp3bCommit, APPROVED_WP3B_COMMIT, "freeze WP3B commit");
  assertEqual(manifest.approvedWp3bDirectParent, APPROVED_WP3B_DIRECT_PARENT, "freeze WP3B direct parent");
  assertEqual(manifest.fixedSymbols, V21_SYMBOLS, "freeze symbols");
  assertEqual(manifest.primaryEventDigests, EXPECTED_PRIMARY_EVENT_DIGESTS, "freeze primary digests");
  assertEqual(manifest.primaryCounts, EXPECTED_PRIMARY_COUNTS, "freeze primary counts");
  assertEqual(manifest.primaryEventAuditSha256, EXPECTED_EVENT_AUDIT_SHA, "freeze primary audit hash");
  assertEqual(manifest.priorStageEvidenceLockSha256, EXPECTED_PRIOR_EVIDENCE_LOCK_SHA, "freeze prior lock hash");
  assertEqual(manifest.controls.identityDigests, Object.fromEntries(V21_CONTROL_NAMES.map((name) => [name, identities.controls[name].digests])), "freeze control digests");
  assertEqual(manifest.controls.identityArtifactSha256, await reportHash("v21-control-identities.json"), "freeze control identities hash");
  assertEqual(manifest.controls.auditSha256, await reportHash("v21-control-audit.json"), "freeze control audit hash");
  assertEqual(manifest.controls.enumerationArtifactSha256, await reportHash("v21-control-enumeration.json"), "freeze control enumeration hash");
  assertEqual(manifest.resultContractSha256, await reportHash("v21-result-contract.json"), "freeze result contract hash");
  assertEqual(manifest.entryPriceField, "open", "freeze entry price field");
  assertEqual(manifest.exitPriceField, "close", "freeze exit price field");
  assertEqual(manifest.execution, V21_EXECUTION_CONTRACT, "freeze execution");
  assertEqual(manifest.horizons, V21_EXECUTION_CONTRACT.horizons, "freeze horizons");
  assertEqual(manifest.outcomeAvailabilityContract, V21_OUTCOME_AVAILABILITY_CONTRACT, "freeze outcome availability contract");
  assertEqual(manifest.costs, V21_COST_CONTRACT, "freeze costs");
  assertEqual(manifest.metrics, V21_METRIC_CONTRACT, "freeze metrics");
  assertEqual(manifest.bootstrap, V21_BOOTSTRAP_CONTRACT, "freeze bootstrap");
  assertEqual(manifest.promotionGates, V21_PROMOTION_GATE_DEFINITIONS, "freeze gates");
  assertEqual(manifest.classification, V21_CLASSIFICATION_CONTRACT, "freeze classification");
  assertEqual(manifest.resultEvaluatorSourceSha256, await fileHash("lib/v21/result-evaluator.ts"), "evaluator source hash");
  assertEqual(manifest.resultEvaluatorTestsSha256, await fileHash("tests/v21-result-evaluator.test.ts"), "evaluator test hash");
  assertEqual(manifest.freezeValidatorSha256, await fileHash("scripts/validate-v21-freeze.ts"), "freeze validator hash");
  assertEqual(manifest.contractClosureSourceSha256, await fileHash("scripts/close-v21-freeze-contract.ts"), "contract closure source hash");
  assertEqual(manifest.bootstrapSeedCallerOverrideAllowed, false, "freeze bootstrap seed override boundary");
  assertEqual(manifest.clusterIdentityMutable, false, "freeze cluster identity boundary");
  assertEqual(manifest.yearDerivedFromSignalTimestamp, true, "freeze UTC year derivation boundary");
  assertEqual(manifest.sourceHashes, await sourceHashes(), "freeze source hashes");
  assertFlags(manifest.flags);
  for (const [key, value] of Object.entries(manifest.flags)) assertEqual(manifest[key], value, `top-level flag ${key}`);
  const expectedBundle = {
    primaryEventDigests: EXPECTED_PRIMARY_EVENT_DIGESTS,
    primaryEventAuditSha256: EXPECTED_EVENT_AUDIT_SHA,
    priorEvidenceLockSha256: EXPECTED_PRIOR_EVIDENCE_LOCK_SHA,
    controlIdentityDigests: manifest.controls.identityDigests,
    controlAuditSha256: manifest.controls.auditSha256,
    resultContractSha256: manifest.resultContractSha256,
    entryPriceField: manifest.entryPriceField,
    exitPriceField: manifest.exitPriceField,
    execution: V21_EXECUTION_CONTRACT,
    outcomeAvailabilityContract: V21_OUTCOME_AVAILABILITY_CONTRACT,
    costs: V21_COST_CONTRACT,
    metrics: V21_METRIC_CONTRACT,
    bootstrap: V21_BOOTSTRAP_CONTRACT,
    promotionGates: V21_PROMOTION_GATE_DEFINITIONS,
    classification: V21_CLASSIFICATION_CONTRACT,
    resultEvaluatorSourceSha256: manifest.resultEvaluatorSourceSha256,
    resultEvaluatorTestsSha256: manifest.resultEvaluatorTestsSha256,
    freezeValidatorSha256: manifest.freezeValidatorSha256,
    contractClosureSourceSha256: manifest.contractClosureSourceSha256,
    bootstrapSeedCallerOverrideAllowed: manifest.bootstrapSeedCallerOverrideAllowed,
    clusterIdentityMutable: manifest.clusterIdentityMutable,
    yearDerivedFromSignalTimestamp: manifest.yearDerivedFromSignalTimestamp,
  };
  assertEqual(manifest.freezeBundle, expectedBundle, "freeze bundle contents");
  assertEqual(manifest.freezeBundleSha256, sha256(expectedBundle), "freeze bundle hash");
  assertEqual(manifest.manifestBodySha256, sha256(withoutKey(manifest, "manifestBodySha256")), "freeze manifest body hash");
  assertEqual(enumeration.controlsEnumerated, true, "enumeration linked");
  assertEqual(audit.noOutcomeFields, true, "audit linked");
  assertEqual(resultContract.contractOnly, true, "contract linked");
}

function assertFlags(flags: Record<string, unknown>): void {
  const expected = {
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
  };
  assertEqual(flags, expected, "freeze flags");
}

function assertIdentityArray(value: unknown, name: string): asserts value is V21EventIdentity[] {
  assert(Array.isArray(value), `${name} must be an array`);
  let previous: [number, string] | null = null;
  const seen = new Set<string>();
  for (const event of value) {
    assertEqual(Object.keys(event), ["symbol", "signalOpenTime", "direction", "clusterId"], `${name} fields`);
    assert((V21_SYMBOLS as readonly string[]).includes(event.symbol), `${name} symbol`);
    assert(Number.isSafeInteger(event.signalOpenTime), `${name} timestamp`);
    assert(event.direction === "LONG" || event.direction === "SHORT", `${name} direction`);
    assertEqual(event.clusterId, event.signalOpenTime, `${name} cluster`);
    const key = `${event.symbol}|${event.signalOpenTime}`;
    assert(!seen.has(key), `${name} duplicate`);
    seen.add(key);
    const current: [number, string] = [event.signalOpenTime, event.symbol];
    if (previous) assert(current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]), `${name} ordering`);
    previous = current;
  }
}

function eventKey(event: V21EventIdentity): string {
  return `${event.symbol}|${event.signalOpenTime}|${event.direction}`;
}

function utcMonth(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function assertNoOutcomeKeys(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert(!/^(entry|exit|price|pnl|grossreturn|netreturn|win|loss|profitfactor|avgr|holdoutnet|stressnet|bootstrapoutcome|promotiondecision)$/i.test(key.replace(/[^a-z]/gi, "")), `${path}.${key} is an outcome field`);
    assertNoOutcomeKeys(nested, `${path}.${key}`);
  }
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function runDependencyValidators(): void {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const scriptName of [
    "validate:v21:data",
    "validate:v21:features",
    "validate:v21:feature-scan",
    "validate:v21:event-predicate",
    "validate:v21:events",
  ]) {
    execFileSync(executable, [scriptName], {
      shell: process.platform === "win32",
      stdio: "inherit",
    });
  }
}

async function reportHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(REPORT_DIR, name), "utf8"));
}

async function fileHash(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(name), "utf8"));
}

async function sourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const source of SOURCE_FILES) hashes[source] = await fileHash(source);
  return hashes;
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as any;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`V21 WP3B freeze validation failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`V21 WP3B freeze validation failed: ${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
