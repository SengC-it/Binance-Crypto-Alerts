import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  R1_BASE_SHA,
  R1_BRANCH,
  R1_EXPERIMENTS,
  SYSTEM_BOUNDARY,
  V18_BRANCH_HEAD_SHA,
  V18_FREEZE_MANIFEST_BODY_SHA,
  V18_FREEZE_SHA,
  V18_POST_RESULT_VALIDATOR_COMMITS,
  V18_RESULT_PARENT_SHA,
  V18_RESULT_SHA,
  V21_FREEZE_SHA,
  V21_RESULT_SHA,
  canonicalJson,
  computeReturnComparisonEligibility,
  isV18CanonicalResult,
  isV18PostResultValidatorCommit,
  isV21CanonicalResult,
  isV21PostResultValidatorCommit,
  sha256,
  type EvidenceSource,
  type ExperimentDefinition,
} from "./r1-catalog";

const root = process.cwd();
const artifactPaths = [
  "reports/r1-system-boundary.json",
  "reports/r1-experiment-inventory.json",
  "reports/r1-evidence-provenance.json",
  "reports/r1-wp1-summary.json",
  "reports/r1-wp1-manifest.json",
] as const;
const allowedChangedPaths = new Set<string>([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/r1-catalog.ts",
  "scripts/build-r1-evidence-inventory.ts",
  "scripts/validate-r1-wp1.ts",
  "tests/r1-wp1.test.ts",
  "scripts/build-r1-edge-attribution.ts",
  "scripts/validate-r1-wp2.ts",
  "tests/r1-wp2.test.ts",
  "scripts/build-r1-research-direction.ts",
  "scripts/validate-r1-wp3.ts",
  "tests/r1-wp3.test.ts",
  "reports/r1-metric-contracts.json",
  "reports/r1-edge-attribution.json",
  "reports/r1-failure-gate-matrix.json",
  "reports/r1-wp2-summary.json",
  "reports/r1-wp2-manifest.json",
  "reports/r1-exhausted-alpha-families.json",
  "reports/r1-future-research-admission.json",
  "reports/r1-alpha-research-budget.json",
  "reports/r1-wp3-decision.json",
  "reports/r1-wp3-manifest.json",
  ...artifactPaths,
]);

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function firstParent(commit: string): string | null {
  return gitText(["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean)[0] ?? null;
}

function assertCommitAvailable(commit: string, label: string): void {
  try {
    assertCondition(gitText(["cat-file", "-t", `${commit}^{commit}`]) === "commit", `${label}: commit object unavailable`);
  } catch {
    fail(`${label}: commit object unavailable`);
  }
}

function resolveRef(ref: string, label: string): string {
  try {
    return gitText(["rev-parse", ref]);
  } catch {
    fail(`${label}: ref unavailable`);
  }
}

function fail(message: string): never {
  throw new Error(`R1_WP1_VALIDATION_FAILED: ${message}`);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(message);
}

function canonicalText(value: Buffer): string {
  return value.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function canonicalArtifactHash(value: Buffer, path: string): string {
  const text = canonicalText(value);
  if (path.endsWith(".json")) return sha256(canonicalJson(JSON.parse(text) as unknown));
  return sha256(text);
}

function readJson(path: string): Promise<unknown> {
  return readFile(resolve(root, path), "utf8").then((text) => JSON.parse(text) as unknown);
}

function expectedSourceKey(source: EvidenceSource): string {
  return [source.commit, source.path, source.evidenceRole].join("|");
}

function actualSourceKey(entry: Record<string, unknown>): string {
  return [entry.commit, entry.path, entry.evidenceRole].join("|");
}

function resolveProductionBaseRef(): string {
  for (const ref of ["agent/shadow-entry-deployment", "origin/agent/shadow-entry-deployment"]) {
    try {
      return gitText(["rev-parse", ref]);
    } catch {
      continue;
    }
  }
  fail("production base ref is unavailable");
}

function assertNoForbiddenKeys(value: unknown, forbidden: ReadonlySet<string>, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, forbidden, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) fail(`forbidden performance/result field ${path}.${key}`);
    assertNoForbiddenKeys(child, forbidden, `${path}.${key}`);
  }
}

function assertExactFields(record: Record<string, unknown>, definition: ExperimentDefinition): void {
  const fields: Array<keyof ExperimentDefinition> = [
    "experimentId",
    "version",
    "branch",
    "branchHead",
    "approvedEvidenceCommit",
    "dataGate",
    "freeze",
    "historicalStrategyOutcomeReturnsRead",
    "resultCommit",
    "promotionEvaluated",
    "classification",
    "researchStop",
    "taxonomy",
    "alphaFamily",
    "primaryDataSource",
    "informationSourceClass",
    "productionChanged",
    "deploy",
    "merge",
    "autoTrading",
  ];
  for (const field of fields) {
    if (canonicalJson(record[field]) !== canonicalJson(definition[field])) fail(`${definition.experimentId}: field ${field} drift`);
  }
  const expectedEligibility = computeReturnComparisonEligibility({
    dataGate: definition.dataGate,
    historicalStrategyOutcomeReturnsRead: definition.historicalStrategyOutcomeReturnsRead,
    resultCommit: definition.resultCommit,
    executionCostContractIdentifiable: definition.resultCommit !== null,
    superseded: definition.superseded,
    knownInvalid: definition.knownInvalid,
  });
  assertCondition(record.returnComparisonEligible === expectedEligibility.eligible, `${definition.experimentId}: eligibility rule drift`);
  assertCondition(record.returnComparisonExclusionReason === expectedEligibility.reason, `${definition.experimentId}: exclusion reason drift`);
  const canonicalParent = firstParent(definition.resultCommit ?? definition.approvedEvidenceCommit);
  assertCondition(record.parentCommit === (definition.parentCommit ?? canonicalParent), `${definition.experimentId}: canonical parent drift`);
  if (definition.taxonomy === "RESULT_REJECTED" || definition.taxonomy === "PROMOTION_CANDIDATE") {
    assertCondition(definition.resultCommit !== null, `${definition.experimentId}: classified result requires a Result commit`);
    assertCondition(record.approvedEvidenceCommit === record.resultCommit, `${definition.experimentId}: approved evidence is not the canonical Result`);
    assertCondition(record.parentCommit === firstParent(String(record.resultCommit)), `${definition.experimentId}: Result parent is not canonical`);
  }
  if (definition.taxonomy === "DATA_INSUFFICIENT" && definition.resultCommit === null) {
    assertCondition(record.approvedEvidenceCommit !== record.resultCommit, `${definition.experimentId}: data gate evidence must not be a Result`);
  }
  assertCondition(canonicalJson(record.evidencePaths) === canonicalJson(definition.evidenceSources.map((source) => source.path).sort()), `${definition.experimentId}: evidence paths drift`);
  assertCondition(record.superseded === (definition.superseded ?? false), `${definition.experimentId}: superseded flag drift`);
  assertCondition(record.knownInvalid === (definition.knownInvalid ?? false), `${definition.experimentId}: knownInvalid flag drift`);
  assertCondition(canonicalJson(record.postResultValidatorCommits) === canonicalJson(definition.postResultValidatorCommits ?? []), `${definition.experimentId}: post-result commit list drift`);
  if (definition.taxonomy === "DATA_INSUFFICIENT") {
    assertCondition(record.returnComparisonEligible === false, `${definition.experimentId}: data-insufficient record became eligible`);
  }
}

function assertSortedBy(values: readonly Record<string, unknown>[], key: string, message: string): void {
  const actual = values.map((value) => String(value[key]));
  const expected = [...actual].sort((left, right) => left.localeCompare(right));
  assertCondition(canonicalJson(actual) === canonicalJson(expected), message);
}

async function validateGitScope(): Promise<void> {
  const currentBranch = gitText(["branch", "--show-current"]);
  const ciBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || currentBranch;
  assertCondition((currentBranch || ciBranch) === R1_BRANCH || ciBranch === R1_BRANCH, `branch must be ${R1_BRANCH}`);
  assertCondition(resolveProductionBaseRef() === R1_BASE_SHA, "production base ref drifted from exact R1 base");
  assertCondition(gitText(["merge-base", "HEAD", R1_BASE_SHA]) === R1_BASE_SHA, "HEAD is not based on exact R1 base");
  assertCondition(gitText(["status", "--porcelain"]) === "", "worktree is not clean");
  const changed = gitText(["diff", "--name-only", `${R1_BASE_SHA}...HEAD`]).split(/\r?\n/).filter(Boolean);
  assertCondition(changed.length > 0, "R1 commit has no changed files");
  for (const path of changed) if (!allowedChangedPaths.has(path)) fail(`out-of-scope changed path: ${path}`);
  assertCondition(changed.includes("scripts/r1-catalog.ts"), "catalog is not part of the R1 change");
}

async function validateArtifacts(): Promise<void> {
  const [boundaryValue, inventoryValue, provenanceValue, summaryValue, manifestValue] = await Promise.all(artifactPaths.map(readJson));
  assertRecord(boundaryValue, "system boundary artifact must be an object");
  assertRecord(inventoryValue, "inventory artifact must be an object");
  assertRecord(provenanceValue, "provenance artifact must be an object");
  assertRecord(summaryValue, "summary artifact must be an object");
  assertRecord(manifestValue, "manifest artifact must be an object");

  assertCondition(canonicalJson(boundaryValue.boundary) === canonicalJson(SYSTEM_BOUNDARY), "system boundary is not exact");
  assertCondition(boundaryValue.baseSha === R1_BASE_SHA, "system boundary base drift");
  assertCondition(boundaryValue.program === "R1_CROSS_EXPERIMENT_EDGE_ATTRIBUTION_AUDIT", "system boundary program drift");

  assertCondition(inventoryValue.branch === R1_BRANCH, "inventory branch drift");
  assertCondition(inventoryValue.baseSha === R1_BASE_SHA, "inventory base drift");
  assertCondition(inventoryValue.program === "R1_CROSS_EXPERIMENT_EDGE_ATTRIBUTION_AUDIT", "inventory program drift");
  assertRecord(inventoryValue.discovery, "inventory discovery must be an object");
  assertRecord(inventoryValue.discovery, "inventory discovery must be an object");
  assertCondition(Array.isArray(inventoryValue.experiments), "inventory experiments must be an array");
  const records = inventoryValue.experiments.filter(isRecord);
  assertCondition(records.length === inventoryValue.experiments.length, "inventory contains a non-object record");
  assertCondition(records.length === R1_EXPERIMENTS.length, `expected ${R1_EXPERIMENTS.length} canonical experiments, found ${records.length}`);
  assertSortedBy(records, "experimentId", "inventory is not deterministically ordered");
  const definitions = new Map(R1_EXPERIMENTS.map((definition) => [definition.experimentId, definition]));
  const seenIds = new Set<string>();
  for (const record of records) {
    const id = String(record.experimentId);
    assertCondition(!seenIds.has(id), `duplicate inventory experiment ${id}`);
    seenIds.add(id);
    const definition = definitions.get(id);
    if (!definition) fail(`unexpected inventory experiment ${id}`);
    assertExactFields(record, definition);
    assertCondition(record.evidenceProvenanceStatus === (definition.evidenceSources.every((source) => source.sourceKind === "github-commit-metadata") ? "REMOTE_ONLY" : "LOCAL_GIT_BLOBS_VERIFIED"), `${id}: provenance status drift`);
  }
  assertCondition(seenIds.size === definitions.size, "canonical inventory experiment missing");
  assertNoForbiddenKeys(inventoryValue.experiments, new Set(["metrics", "returns", "performance", "avgR", "avgNetR", "PF", "pf", "NetR", "netPnl", "winRate", "trades", "bootstrap"]));

  assertCondition(provenanceValue.branch === R1_BRANCH, "provenance branch drift");
  assertCondition(provenanceValue.baseSha === R1_BASE_SHA, "provenance base drift");
  assertCondition(Array.isArray(provenanceValue.entries), "provenance entries must be an array");
  const entries = provenanceValue.entries.filter(isRecord);
  assertCondition(entries.length === provenanceValue.entries.length, "provenance contains a non-object entry");
  const expectedSources = R1_EXPERIMENTS.flatMap((definition) => definition.evidenceSources.map((source) => ({ definition, source })));
  assertCondition(entries.length === expectedSources.length, "provenance entry count drift");
  assertSortedBy(entries, "experimentId", "provenance is not deterministically ordered by experiment");
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = actualSourceKey(entry);
    assertCondition(!entryKeys.has(key), `duplicate provenance entry ${key}`);
    entryKeys.add(key);
    const expected = expectedSources.find(({ source }) => expectedSourceKey(source) === [entry.commit, entry.path, entry.evidenceRole].join("|"));
    if (!expected) fail(`unexpected provenance entry ${key}`);
    assertCondition(entry.experimentId === expected.definition.experimentId, `${key}: experiment ownership drift`);
    if (expected.source.sourceKind === "github-commit-metadata") {
      assertCondition(entry.sourceAvailable === false, `${key}: remote-only evidence marked available`);
      assertCondition(entry.gitBlobSha === null && entry.rawSha256 === null && entry.canonicalSha256 === null, `${key}: remote-only evidence has inferred blob hashes`);
      continue;
    }
    assertCondition(entry.sourceAvailable === true, `${key}: local evidence unavailable`);
    const spec = `${String(entry.commit)}:${String(entry.path)}`;
    try {
      gitText(["cat-file", "-e", spec]);
    } catch {
      fail(`${key}: cited Git blob does not exist`);
    }
    const bytes = gitBytes(["cat-file", "blob", spec]);
    const blobSha = gitText(["rev-parse", spec]);
    assertCondition(entry.gitBlobSha === blobSha, `${key}: Git blob SHA mismatch`);
    assertCondition(entry.rawSha256 === sha256(bytes), `${key}: raw SHA mismatch`);
    assertCondition(entry.canonicalSha256 === canonicalArtifactHash(bytes, String(entry.path)), `${key}: canonical SHA mismatch`);
  }
  assertCondition(entryKeys.size === expectedSources.length, "one or more evidence sources have no provenance");

  const v18 = records.find((record) => record.experimentId === "V18_TAKER_FLOW_ABSORPTION_REVERSAL");
  assertRecord(v18, "V18 record missing");
  assertCondition(resolveRef("origin/feat/v18-taker-flow-absorption-reversal", "V18 remote branch") === V18_BRANCH_HEAD_SHA, "V18 branch HEAD drift");
  for (const [label, commit] of [
    ["V18 freeze", V18_FREEZE_SHA],
    ["V18 result", V18_RESULT_SHA],
    ["V18 branch HEAD", V18_BRANCH_HEAD_SHA],
    ...V18_POST_RESULT_VALIDATOR_COMMITS.map((commit, index) => [`V18 post-result validator ${index + 1}`, commit] as const),
  ] as const) assertCommitAvailable(commit, label);
  assertCondition(firstParent(V18_RESULT_SHA) === V18_RESULT_PARENT_SHA, "V18 Result parent is not the Freeze commit");
  assertCondition(firstParent(V18_POST_RESULT_VALIDATOR_COMMITS[0]) === V18_RESULT_SHA, "V18 first post-result validator parent drift");
  assertCondition(firstParent(V18_POST_RESULT_VALIDATOR_COMMITS[1]) === V18_POST_RESULT_VALIDATOR_COMMITS[0], "V18 branch validator lineage drift");
  assertCondition(canonicalJson(v18.postResultValidatorCommits) === canonicalJson([...V18_POST_RESULT_VALIDATOR_COMMITS]), "V18 post-result validator commits drift");
  assertCondition(records.filter((record) => record.resultCommit === V18_RESULT_SHA).length === 1, "V18 canonical result recognized more than once");
  assertCondition(!records.some((record) => record.resultCommit !== null && isV18PostResultValidatorCommit(String(record.resultCommit))), "V18 post-result validator counted as a Result");
  assertCondition(isV18CanonicalResult(V18_RESULT_SHA, V18_RESULT_SHA), "V18 canonical result helper failed");
  const v18Entries = entries.filter((entry) => entry.experimentId === v18.experimentId);
  assertCondition(v18Entries.length === 6, "V18 exact evidence source count drift");
  assertCondition(v18Entries.every((entry) => entry.sourceAvailable === true && entry.sourceKind === "git-blob" && !String(entry.path).startsWith("COMMIT_METADATA:")), "V18 evidence must be verified Git blobs, not metadata");
  const v18FreezeManifest = JSON.parse(gitBytes(["cat-file", "blob", `${V18_FREEZE_SHA}:reports/v18-freeze-manifest.json`]).toString("utf8")) as Record<string, unknown>;
  assertCondition(v18FreezeManifest.manifestBodySha256 === V18_FREEZE_MANIFEST_BODY_SHA, "V18 Freeze manifest body hash drift");

  const v21 = records.find((record) => record.experimentId === "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL");
  assertRecord(v21, "V21 record missing");
  assertCondition(v21.approvedEvidenceCommit === V21_RESULT_SHA, "V21 approved evidence must be the canonical Result");
  assertCondition(v21.parentCommit === V21_FREEZE_SHA, "V21 parent must be the Freeze commit");
  assertCondition(v21.resultCommit === V21_RESULT_SHA, "V21 canonical result drift");
  assertCondition(v21.branchHead === "0822c099eeff4f36e8d8e4865a4ed1380ae94709", "V21 final branch head drift");
  assertCondition(firstParent(V21_RESULT_SHA) === V21_FREEZE_SHA, "V21 Result parent is not the Freeze commit");
  assertCondition(records.filter((record) => record.resultCommit === V21_RESULT_SHA).length === 1, "V21 canonical result recognized more than once");
  assertCondition(canonicalJson(v21.postResultValidatorCommits) === canonicalJson(["180bfc2b42322eb6e42fb3a90cc2a998e1b2a2ba", "0822c099eeff4f36e8d8e4865a4ed1380ae94709"]), "V21 post-result validator commits drift");
  assertCondition(!records.some((record) => (record.resultCommit !== null && isV21PostResultValidatorCommit(String(record.resultCommit)))), "post-result validator commit counted as a Result");
  assertCondition(isV21CanonicalResult(V21_RESULT_SHA, V21_RESULT_SHA), "V21 canonical result helper failed");

  const expectedCounts = {
    formalExperimentCount: records.length,
    dataInsufficientCount: records.filter((record) => record.taxonomy === "DATA_INSUFFICIENT").length,
    resultRejectedCount: records.filter((record) => record.taxonomy === "RESULT_REJECTED").length,
    promotionCandidateCount: records.filter((record) => record.taxonomy === "PROMOTION_CANDIDATE").length,
    processIncompleteCount: records.filter((record) => record.taxonomy === "PROCESS_INCOMPLETE").length,
    evidenceIncompleteCount: records.filter((record) => record.taxonomy === "EVIDENCE_INCOMPLETE").length,
    noFormalResultCount: records.filter((record) => record.taxonomy === "NO_FORMAL_RESULT").length,
    returnComparisonEligibleCount: records.filter((record) => record.returnComparisonEligible === true).length,
  };
  for (const [key, value] of Object.entries(expectedCounts)) assertCondition(summaryValue[key] === value, `summary ${key} drift`);
  for (const key of Object.keys(expectedCounts)) assertCondition(manifestValue.counts && (manifestValue.counts as Record<string, unknown>)[key] === expectedCounts[key as keyof typeof expectedCounts], `manifest ${key} drift`);

  const expectedFlags = {
    newStrategyDesigned: false,
    newAlphaTested: false,
    historicalBacktestRerun: false,
    historicalResultRegenerated: false,
    historicalOutcomePricesNewlyRead: false,
    parameterSearch: false,
    controlsRegenerated: false,
    signalsRegenerated: false,
    newForwardReturnsRead: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  };
  assertCondition(canonicalJson(manifestValue.flags) === canonicalJson(expectedFlags), "R1 manifest flags are not fail-closed");
  assertCondition(manifestValue.branch === R1_BRANCH && manifestValue.directParent === R1_BASE_SHA, "R1 manifest lineage drift");

  const body = { ...manifestValue };
  delete body.manifestBodySha256;
  delete body.manifestSha256;
  assertCondition(manifestValue.manifestBodySha256 === sha256(canonicalJson(body)), "manifest body hash mismatch");
  const withoutManifestHash = { ...manifestValue };
  delete withoutManifestHash.manifestSha256;
  assertCondition(manifestValue.manifestSha256 === sha256(canonicalJson(withoutManifestHash)), "manifest hash mismatch");
  for (const path of artifactPaths.slice(0, 4)) {
    const bytes = await readFile(resolve(root, path));
    const hash = manifestValue.artifacts && (manifestValue.artifacts as Record<string, unknown>)[path];
    assertRecord(hash, `manifest hash missing for ${path}`);
    assertCondition(hash.rawSha256 === sha256(bytes), `${path}: manifest raw hash mismatch`);
    assertCondition(hash.canonicalSha256 === canonicalArtifactHash(bytes, path), `${path}: manifest canonical hash mismatch`);
  }
}

async function main(): Promise<void> {
  await validateGitScope();
  await validateArtifacts();
  console.log("R1-WP1 validation PASS");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
