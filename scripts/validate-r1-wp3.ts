import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALPHA_RESEARCH_BUDGET,
  EXHAUSTED_ALPHA_FAMILIES,
  FUTURE_INFORMATION_SOURCE_CLASSES,
  RETUNING_ONLY_DIMENSIONS,
  STRUCTURAL_ORTHOGONALITY_DIMENSIONS,
  WP2_COMMIT,
  WP3_ARTIFACT_PATHS,
  WP3_SOURCE_ARTIFACT_PATHS,
  assertPromotionIsNotProductionActivation,
  assertStructurallyOrthogonal,
} from "./build-r1-research-direction";
import { R1_BASE_SHA, R1_BRANCH, R1_PROGRAM, SYSTEM_BOUNDARY, canonicalJson, sha256 } from "./r1-catalog";

const root = process.cwd();
const allowedChangedPaths = new Set<string>([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/build-r1-research-direction.ts",
  "scripts/validate-r1-wp1.ts",
  "scripts/validate-r1-wp2.ts",
  "scripts/validate-r1-wp3.ts",
  "tests/r1-wp3.test.ts",
  ...WP3_ARTIFACT_PATHS,
  "reports/r1-wp3-manifest.json",
]);
const forbiddenArtifactKeys = new Set(["returns", "metrics", "PF", "pf", "NetR", "netPnl", "winRate", "bootstrap", "ranking", "bestCandidate", "leaderboard"]);

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function fail(message: string): never {
  throw new Error(`R1_WP3_VALIDATION_FAILED: ${message}`);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;
}

function canonicalArtifactHash(bytes: Buffer, path: string): string {
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return path.endsWith(".json") ? sha256(canonicalJson(JSON.parse(text) as unknown)) : sha256(text);
}

function assertUnchangedSinceWp2(path: string): void {
  const before = gitBytes(["cat-file", "blob", `${WP2_COMMIT}:${path}`]);
  const after = readFileSync(resolve(root, path));
  assertCondition(sha256(before) === sha256(after), `${path}: historical WP2 evidence changed`);
}

function assertNoForbiddenKeys(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assertCondition(!forbiddenArtifactKeys.has(key), `${path}.${key}: return/performance aggregation is forbidden in WP3`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function validateLineage(): void {
  const currentBranch = gitText(["branch", "--show-current"]);
  const ciBranch = process.env.R1_BRANCH_REF || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || currentBranch;
  assertCondition((currentBranch || ciBranch) === R1_BRANCH || ciBranch === R1_BRANCH, `branch must be ${R1_BRANCH}`);
  assertCondition(gitText(["merge-base", "HEAD", R1_BASE_SHA]) === R1_BASE_SHA, "WP3 is not based on exact R1 base");
  const branchHead = gitText(["rev-parse", `origin/${R1_BRANCH}`]);
  const head = gitText(["rev-parse", "HEAD"]);
  if (head === branchHead) {
    assertCondition(gitText(["rev-parse", "HEAD^"]) === WP2_COMMIT, "WP3 direct parent is not exact WP2");
  } else {
    assertCondition(gitText(["rev-parse", "HEAD^2"]) === branchHead, "PR merge checkout does not contain exact WP3 branch HEAD");
    assertCondition(gitText(["rev-parse", `${branchHead}^`]) === WP2_COMMIT, "remote WP3 direct parent is not exact WP2");
  }
  assertCondition(gitText(["status", "--porcelain"]) === "", "working tree is not clean");
  const changed = gitText(["diff", "--name-only", `${WP2_COMMIT}..HEAD`]).split(/\r?\n/).filter(Boolean);
  assertCondition(changed.length === allowedChangedPaths.size, "WP3 changed-file set is incomplete or has duplicate scope");
  for (const path of changed) assertCondition(allowedChangedPaths.has(path), `out-of-scope changed path: ${path}`);
  for (const path of WP3_SOURCE_ARTIFACT_PATHS) assertUnchangedSinceWp2(path);
  assertCondition(gitText(["ls-files", "reports/v22*"]) === "", "V22 artifact exists");
  assertCondition(gitText(["ls-files", "lib/v22*"]) === "", "V22 implementation exists");
}

function validateSourceHashes(manifest: Record<string, unknown>): void {
  const sourceArtifacts = manifest.sourceArtifacts;
  assertCondition(isRecord(sourceArtifacts), "source artifact hashes missing");
  for (const path of WP3_SOURCE_ARTIFACT_PATHS) {
    const entry = sourceArtifacts[path];
    assertCondition(isRecord(entry), `${path}: source hash missing`);
    const bytes = readFileSync(resolve(root, path));
    assertCondition(entry.rawSha256 === sha256(bytes), `${path}: raw hash drift`);
    assertCondition(entry.canonicalSha256 === canonicalArtifactHash(bytes, path), `${path}: canonical hash drift`);
  }
  const artifacts = manifest.artifacts;
  assertCondition(isRecord(artifacts), "WP3 artifact hashes missing");
  for (const path of WP3_ARTIFACT_PATHS) {
    const entry = artifacts[path];
    assertCondition(isRecord(entry), `${path}: artifact hash missing`);
    const bytes = readFileSync(resolve(root, path));
    assertCondition(entry.rawSha256 === sha256(bytes), `${path}: raw hash drift`);
    assertCondition(entry.canonicalSha256 === canonicalArtifactHash(bytes, path), `${path}: canonical hash drift`);
  }
}

function validateArtifacts(): void {
  const boundary = readJson("reports/r1-system-boundary.json") as Record<string, unknown>;
  const wp2 = readJson("reports/r1-wp2-summary.json") as Record<string, unknown>;
  const exhausted = readJson(WP3_ARTIFACT_PATHS[0]) as Record<string, unknown>;
  const admission = readJson(WP3_ARTIFACT_PATHS[1]) as Record<string, unknown>;
  const budget = readJson(WP3_ARTIFACT_PATHS[2]) as Record<string, unknown>;
  const decision = readJson(WP3_ARTIFACT_PATHS[3]) as Record<string, unknown>;
  const manifest = readJson("reports/r1-wp3-manifest.json") as Record<string, unknown>;

  assertCondition(canonicalJson(boundary.boundary) === canonicalJson(SYSTEM_BOUNDARY), "system boundary changed");
  assertCondition(boundary.baseSha === R1_BASE_SHA && boundary.program === R1_PROGRAM, "system boundary identity drift");
  assertCondition(wp2.wp1Commit === "3897dfaf3d368ba391684f12580ba3aa12a632d2", "WP2 anchor drift");
  assertCondition(canonicalJson(wp2.categoryCounts) === canonicalJson({ NO_PRE_FRICTION_EDGE: 1, EXECUTION_FRICTION_DOMINATED: 3, NET_EDGE_NOT_ROBUST: 1, ROBUST_NET_EDGE: 0, ATTRIBUTION_UNRESOLVED: 0 }), "WP2 diagnosis drift");
  assertCondition(wp2.dominantFailureMode === "EXECUTION_FRICTION_DOMINATED", "dominant failure mode drift");
  assertCondition(wp2.researchImplication === "HIGHER_INFORMATION_DENSITY_REQUIRED", "research implication drift");

  assertCondition(exhausted.schema === "r1-exhausted-alpha-families-v1" && exhausted.branch === R1_BRANCH, "legacy family registry identity drift");
  assertCondition(canonicalJson(exhausted.families) === canonicalJson(EXHAUSTED_ALPHA_FAMILIES), "legacy family registry is incomplete or changed");
  assertCondition(exhausted.retuningForbidden === true, "legacy retuning is not forbidden");
  for (const entry of exhausted.families as unknown[]) {
    assertCondition(isRecord(entry) && (RETUNING_ONLY_DIMENSIONS.length > 0), "legacy family record invalid");
    assertCondition(["EXHAUSTED_DO_NOT_RETUNE", "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE", "INCOMPLETE_NOT_ELIGIBLE_FOR_VARIANT_MINING"].includes(String(entry.futureStatus)), "invalid legacy future status");
  }

  assertCondition(admission.structuralOrthogonalityRule === "STRUCTURALLY_ORTHOGONAL", "structural orthogonality rule drift");
  assertCondition(canonicalJson(admission.structuralOrthogonalityDimensions) === canonicalJson(STRUCTURAL_ORTHOGONALITY_DIMENSIONS), "structural dimensions drift");
  assertCondition(canonicalJson(admission.forbiddenVariantDimensions) === canonicalJson(RETUNING_ONLY_DIMENSIONS), "forbidden variant dimensions drift");
  assertCondition(canonicalJson(admission.futureInformationSourceClasses) === canonicalJson(FUTURE_INFORMATION_SOURCE_CLASSES), "future information-source classes drift");
  assertCondition(admission.noSpecificStrategyDesign === true && admission.noThresholdsOrParameters === true && admission.noDataQuery === true && admission.noBacktest === true, "WP3 contains specific alpha design permissions");
  assertCondition(admission.promotionCandidateMeans === "RESEARCH_EVIDENCE_PASS_ONLY" && admission.productionActivationRequiresSeparateHumanApproval === true, "promotion boundary drift");

  assertCondition(budget.totalFamilies === ALPHA_RESEARCH_BUDGET && budget.remainingOrthogonalFamilyBudget === ALPHA_RESEARCH_BUDGET, "research budget drift");
  assertCondition(Array.isArray(budget.consumedFamilies) && budget.consumedFamilies.length === 0, "WP3 consumed research budget");
  assertCondition(budget.sameFamilyOnlyOnce === true && budget.versionsDoNotConsumeAdditionalBudget === true && budget.failedFamilyIsPermanent === true && budget.dataInsufficientMayNotLowerDataGate === true, "budget safeguards drift");
  assertCondition(isRecord(budget.programStopRule) && budget.programStopRule.id === "ALPHA_RESEARCH_PROGRAM_STOP_RULE" && budget.programStopRule.alphaResearchProgramStatus === "STOP_NEW_ALPHA_RESEARCH", "program stop rule drift");

  const expectedDecision = {
    schema: "r1-wp3-decision-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    wp2Commit: WP2_COMMIT,
    projectWorthContinuing: "YES",
    alphaResearchWorthContinuing: "YES_WITH_FIXED_BUDGET",
    dominantHistoricalFailure: "EXECUTION_FRICTION_DOMINATED",
    requiredFutureDirection: "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT",
    remainingOrthogonalFamilyBudget: ALPHA_RESEARCH_BUDGET,
    legacyFamilyRetuningAllowed: false,
    v22Authorized: false,
    nextRequiredStage: "FUTURE_ALPHA_DIRECTION_SELECTION",
    programStopRule: decision.programStopRule,
  };
  assertCondition(canonicalJson(decision) === canonicalJson(expectedDecision), "WP3 decision drift");

  assertCondition(manifest.schema === "r1-wp3-manifest-v1" && manifest.program === R1_PROGRAM && manifest.branch === R1_BRANCH, "WP3 manifest identity drift");
  assertCondition(manifest.baseSha === R1_BASE_SHA && manifest.directParent === WP2_COMMIT, "WP3 manifest lineage drift");
  assertCondition(canonicalJson(manifest.diagnosis) === canonicalJson({
    NO_PRE_FRICTION_EDGE: 1,
    EXECUTION_FRICTION_DOMINATED: 3,
    NET_EDGE_NOT_ROBUST: 1,
    ROBUST_NET_EDGE: 0,
    ATTRIBUTION_UNRESOLVED: 0,
    dominantFailureMode: "EXECUTION_FRICTION_DOMINATED",
    researchImplication: "HIGHER_INFORMATION_DENSITY_REQUIRED",
  }), "manifest diagnosis drift");
  const flags = manifest.flags;
  assertCondition(canonicalJson(flags) === canonicalJson({
    newStrategyDesigned: false,
    newAlphaTested: false,
    historicalBacktestRerun: false,
    historicalResultRegenerated: false,
    historicalOutcomePricesNewlyRead: false,
    newForwardReturnsRead: false,
    parameterSearch: false,
    v22Designed: false,
    v22Authorized: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  }), "WP3 flags are not fail-closed");
  assertCondition(isRecord(manifest.contract) && manifest.contract.legacyFamilyRetuningAllowed === false && manifest.contract.structuralOrthogonalityRequired === true && manifest.contract.researchBudgetFamilies === 3, "WP3 contract drift");
  assertCondition(manifest.systemBoundaryCanonicalSha256 === sha256(canonicalJson(SYSTEM_BOUNDARY)), "system boundary hash drift");
  validateSourceHashes(manifest);
  const body = { ...manifest };
  delete body.manifestBodySha256;
  delete body.manifestSha256;
  assertCondition(manifest.manifestBodySha256 === sha256(canonicalJson(body)), "manifest body hash mismatch");
  const withBodyHash = { ...body, manifestBodySha256: manifest.manifestBodySha256 };
  assertCondition(manifest.manifestSha256 === sha256(canonicalJson(withBodyHash)), "manifest hash mismatch");

  for (const path of WP3_ARTIFACT_PATHS) assertNoForbiddenKeys(readJson(path), path);
  assertStructurallyOrthogonal({ family: "future-example", informationSourceClass: "LIQUIDATION_STRUCTURE", structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL", structuralDifferenceDimensions: ["information_source"], changedDimensions: ["information_source"], familyStatus: "NEW" });
  assertPromotionIsNotProductionActivation({ promotionCandidate: true, productionEmail: "OFF", productionChanged: false, deploy: false, orderPlacement: false, autoTrading: false });
}

function main(): void {
  validateLineage();
  validateArtifacts();
  console.log("R1-WP3 validation PASS");
}

main();
