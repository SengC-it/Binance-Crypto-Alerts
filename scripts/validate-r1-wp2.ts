import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ATTRIBUTION_CATEGORIES,
  EXPECTED_CANONICAL_RESULT_COMMITS,
  ROBUSTNESS_LABELS,
  WP1_COMMIT,
  WP2_EXPERIMENT_IDS,
  assertNoCrossExperimentRanking,
  assertNumericProvenance,
  buildWp2Evidence,
  computeDominantFailureMode,
  type FailureGateMatrix,
  type GateValue,
  type MetricContract,
} from "./build-r1-edge-attribution";
import { WP2_COMMIT } from "./build-r1-research-direction";
import { R1_BASE_SHA, R1_BRANCH, R1_PROGRAM, SYSTEM_BOUNDARY, canonicalJson, sha256 } from "./r1-catalog";

const root = process.cwd();
const artifactPaths = [
  "reports/r1-metric-contracts.json",
  "reports/r1-edge-attribution.json",
  "reports/r1-failure-gate-matrix.json",
  "reports/r1-wp2-summary.json",
  "reports/r1-wp2-manifest.json",
] as const;
const allowedWp2Paths = new Set<string>([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/validate-r1-wp1.ts",
  "scripts/build-r1-edge-attribution.ts",
  "scripts/validate-r1-wp2.ts",
  "tests/r1-wp2.test.ts",
  "scripts/build-r1-research-direction.ts",
  "scripts/validate-r1-wp3.ts",
  "tests/r1-wp3.test.ts",
  ...artifactPaths,
  "reports/r1-exhausted-alpha-families.json",
  "reports/r1-future-research-admission.json",
  "reports/r1-alpha-research-budget.json",
  "reports/r1-wp3-decision.json",
  "reports/r1-wp3-manifest.json",
]);

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function fail(message: string): never {
  throw new Error(`R1_WP2_VALIDATION_FAILED: ${message}`);
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

function canonicalText(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function canonicalArtifactHash(bytes: Buffer, path: string): string {
  const text = canonicalText(bytes);
  return path.endsWith(".json") ? sha256(canonicalJson(JSON.parse(text) as unknown)) : sha256(text);
}

function assertGitBlob(commit: string, path: string, label: string): void {
  const spec = `${commit}:${path}`;
  try {
    gitText(["cat-file", "-e", spec]);
  } catch {
    fail(`${label}: Git blob unavailable (${spec})`);
  }
  const bytes = gitBytes(["cat-file", "blob", spec]);
  assertCondition(gitText(["rev-parse", spec]) !== "", `${label}: empty Git blob SHA`);
  void bytes;
}

function validateSourcePaths(contracts: MetricContract[]): void {
  for (const contract of contracts) {
    assertCondition(contract.canonicalResultCommit === EXPECTED_CANONICAL_RESULT_COMMITS[contract.experimentId as (typeof WP2_EXPERIMENT_IDS)[number]], `${contract.experimentId}: canonical Result drift`);
    const sources = new Set(contract.sourcePaths.map((source) => `${source.commit}:${source.path}`));
    for (const source of contract.sourcePaths) {
      const spec = `${source.commit}:${source.path}`;
      assertGitBlob(source.commit, source.path, `${contract.experimentId} source`);
      const bytes = gitBytes(["cat-file", "blob", spec]);
      assertCondition(source.gitBlobSha === gitText(["rev-parse", spec]), `${contract.experimentId}: Git blob SHA drift for ${source.path}`);
      assertCondition(source.rawSha256 === sha256(bytes), `${contract.experimentId}: raw SHA drift for ${source.path}`);
      assertCondition(source.canonicalSha256 === canonicalArtifactHash(bytes, source.path), `${contract.experimentId}: canonical SHA drift for ${source.path}`);
    }
    assertNumericProvenance(contract);
    for (const entries of Object.values(contract.numericProvenance)) {
      for (const entry of entries) {
        assertCondition(sources.has(`${entry.commit}:${entry.path}`), `${contract.experimentId}: numeric provenance source is not declared`);
        assertCondition(entry.gitBlobSha === gitText(["rev-parse", `${entry.commit}:${entry.path}`]), `${contract.experimentId}: numeric provenance Git blob SHA drift`);
        if (entry.extraction === "EXACTLY_DERIVED") {
          assertCondition(entry.derivationFormula !== null, `${contract.experimentId}: derived numeric field lacks formula`);
          assertCondition(entry.inputFields.length > 0, `${contract.experimentId}: derived numeric field lacks inputs`);
          assertCondition(entry.inputValues !== null && entry.inputUnits !== null, `${contract.experimentId}: derived numeric field lacks input values/units`);
          assertCondition(entry.unit !== "R+USDT", `${contract.experimentId}: mixed return unit was encoded`);
        }
      }
    }
  }
}

function validateGateValues(matrix: FailureGateMatrix[]): void {
  const gateNames = [
    "dataGatePass",
    "primaryNetPositive",
    "primaryPfPass",
    "primaryAvgNetPositive",
    "bootstrapPass",
    "holdoutAPass",
    "holdoutBPass",
    "stressPass",
    "symbolBreadthPass",
    "yearBreadthPass",
    "informationGainPass",
    "concentrationPass",
  ] as const;
  for (const entry of matrix) {
    assertCondition(WP2_EXPERIMENT_IDS.includes(entry.experimentId as (typeof WP2_EXPERIMENT_IDS)[number]), `unexpected gate-matrix experiment ${entry.experimentId}`);
    for (const name of gateNames) {
      const value = entry.gates[name] as GateValue;
      assertCondition(value === true || value === false || value === "NOT_APPLICABLE", `${entry.experimentId}.${name}: invalid gate value`);
      const evidence = entry.gateEvidence[name];
      assertCondition(isRecord(evidence), `${entry.experimentId}.${name}: missing gate evidence`);
      if (value === "NOT_APPLICABLE") assertCondition(typeof evidence.reason === "string" && evidence.reason.length > 0, `${entry.experimentId}.${name}: N/A gate has no reason`);
      if (value !== "NOT_APPLICABLE") assertCondition(typeof evidence.source === "string" && typeof evidence.jsonPath === "string", `${entry.experimentId}.${name}: gate lacks source path`);
      if (evidence.source) assertGitBlob(entry.canonicalResultCommit, evidence.source, `${entry.experimentId}.${name}`);
    }
    for (const label of entry.failedRobustnessLabels) assertCondition((ROBUSTNESS_LABELS as readonly string[]).includes(label), `${entry.experimentId}: unknown robustness label ${label}`);
  }
}

function validateManifest(manifest: Record<string, unknown>, evidence: ReturnType<typeof buildWp2Evidence>): void {
  assertCondition(manifest.schema === "r1-wp2-manifest-v1", "manifest schema drift");
  assertCondition(manifest.program === R1_PROGRAM && manifest.branch === R1_BRANCH, "manifest identity drift");
  assertCondition(manifest.baseSha === R1_BASE_SHA && manifest.directParent === WP1_COMMIT, "manifest lineage drift");
  assertCondition(canonicalJson(manifest.analyzedExperimentIds) === canonicalJson([...WP2_EXPERIMENT_IDS].sort()), "manifest experiment set drift");
  assertCondition(canonicalJson(manifest.canonicalResultCommits) === canonicalJson(EXPECTED_CANONICAL_RESULT_COMMITS), "manifest canonical Result map drift");
  assertCondition(canonicalJson(manifest.flags) === canonicalJson(evidence.summary.flags), "manifest flags drift");
  assertCondition((manifest.sourcePolicy as Record<string, unknown>).rawMarketDataRead === false, "raw market data read flag is not false");
  assertCondition((manifest.sourcePolicy as Record<string, unknown>).historicalRunnerInvoked === false, "historical runner flag is not false");
  assertCondition((manifest.sourcePolicy as Record<string, unknown>).newReturnsGenerated === false, "new returns flag is not false");
  const body = { ...manifest };
  delete body.manifestBodySha256;
  delete body.manifestSha256;
  assertCondition(manifest.manifestBodySha256 === sha256(canonicalJson(body)), "manifest body hash mismatch");
  const withBodyHash = { ...body, manifestBodySha256: manifest.manifestBodySha256 };
  assertCondition(manifest.manifestSha256 === sha256(canonicalJson(withBodyHash)), "manifest hash mismatch");
  const artifacts = manifest.artifacts as Record<string, Record<string, string>>;
  for (const path of artifactPaths.slice(0, 4)) {
    const bytes = readFileSync(resolve(root, path));
    assertCondition(artifacts[path]?.rawSha256 === sha256(bytes), `${path}: raw artifact hash mismatch`);
    assertCondition(artifacts[path]?.canonicalSha256 === canonicalArtifactHash(bytes, path), `${path}: canonical artifact hash mismatch`);
  }
}

function validateWorkingTreeScope(): void {
  const status = gitBytes(["status", "--porcelain=v1"]).toString("utf8");
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    assertCondition(allowedWp2Paths.has(path), `out-of-scope working-tree path: ${path}`);
  }
}

async function main(): Promise<void> {
  const currentBranch = gitText(["branch", "--show-current"]);
  const ciBranch = process.env.R1_BRANCH_REF || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || currentBranch;
  assertCondition((currentBranch || ciBranch) === R1_BRANCH || ciBranch === R1_BRANCH, `branch must be ${R1_BRANCH}`);
  validateWorkingTreeScope();
  const branchHead = gitText(["rev-parse", `origin/${R1_BRANCH}`]);
  const head = gitText(["rev-parse", "HEAD"]);
  if (head === branchHead) {
    const parent = gitText(["rev-parse", "HEAD^"]);
    assertCondition(parent === WP1_COMMIT || gitText(["merge-base", "HEAD", WP2_COMMIT]) === WP2_COMMIT, "WP2 HEAD is not the exact WP2 commit or a validated descendant");
  } else {
    assertCondition(gitText(["rev-parse", "HEAD^2"]) === branchHead, "PR merge commit does not contain the exact R1 branch HEAD");
    const remoteParent = gitText(["rev-parse", `${branchHead}^`]);
    assertCondition(remoteParent === WP1_COMMIT || gitText(["merge-base", branchHead, WP2_COMMIT]) === WP2_COMMIT, "remote R1 branch is not the exact WP2 commit or a validated descendant");
  }
  assertCondition(gitText(["merge-base", "HEAD", R1_BASE_SHA]) === R1_BASE_SHA, "WP2 is not based on exact R1 base");
  const changed = gitText(["diff", "--name-only", `${WP1_COMMIT}..HEAD`]).split(/\r?\n/).filter(Boolean);
  assertCondition(changed.length > 0, "WP2 has no changed files");
  for (const path of changed) assertCondition(allowedWp2Paths.has(path), `out-of-scope WP2 path: ${path}`);

  const localContracts = readJson("reports/r1-metric-contracts.json") as Record<string, unknown>;
  const localEdge = readJson("reports/r1-edge-attribution.json");
  const localMatrix = readJson("reports/r1-failure-gate-matrix.json") as Record<string, unknown>;
  const localSummary = readJson("reports/r1-wp2-summary.json") as Record<string, unknown>;
  const localManifest = readJson("reports/r1-wp2-manifest.json") as Record<string, unknown>;
  const evidence = buildWp2Evidence();
  const expectedContracts = { schema: "r1-metric-contracts-v1", program: R1_PROGRAM, branch: R1_BRANCH, baseSha: R1_BASE_SHA, wp1Commit: WP1_COMMIT, sourcePolicy: evidence.edge.sourcePolicy, experiments: evidence.contracts };
  const expectedMatrix = { schema: "r1-failure-gate-matrix-v1", program: R1_PROGRAM, branch: R1_BRANCH, baseSha: R1_BASE_SHA, wp1Commit: WP1_COMMIT, experiments: evidence.matrix };
  assertCondition(canonicalJson(localContracts) === canonicalJson(expectedContracts), "metric contracts do not match deterministic canonical-blob extraction");
  assertCondition(canonicalJson(localEdge) === canonicalJson(evidence.edge), "edge attribution does not match deterministic canonical-blob extraction");
  assertCondition(canonicalJson(localMatrix) === canonicalJson(expectedMatrix), "failure gate matrix does not match deterministic canonical-blob extraction");
  assertCondition(canonicalJson(localSummary) === canonicalJson(evidence.summary), "WP2 summary does not match deterministic canonical-blob extraction");

  const contracts = localContracts.experiments as MetricContract[];
  const matrix = localMatrix.experiments as FailureGateMatrix[];
  assertCondition(contracts.length === 5 && matrix.length === 5, "WP2 artifact experiment count is not five");
  assertCondition(canonicalJson(contracts.map((item) => item.experimentId)) === canonicalJson([...WP2_EXPERIMENT_IDS].sort()), "WP2 experiment IDs drift");
  validateSourcePaths(contracts);
  validateGateValues(matrix);
  assertNoCrossExperimentRanking(localContracts);
  assertNoCrossExperimentRanking(localEdge);
  assertNoCrossExperimentRanking(localMatrix);
  assertNoCrossExperimentRanking(localSummary);
  assertNoCrossExperimentRanking(localManifest);
  assertCondition(canonicalJson(localSummary.boundaries) === canonicalJson(SYSTEM_BOUNDARY), "system boundary changed");
  const expectedCategoryCounts = evidence.summary.categoryCounts as Record<string, number>;
  assertCondition(canonicalJson(localSummary.categoryCounts) === canonicalJson(Object.fromEntries(ATTRIBUTION_CATEGORIES.map((category) => [category, expectedCategoryCounts[category]]))), "category counts drift");
  assertCondition(isRecord(localEdge), "edge attribution artifact is not an object");
  const edge = localEdge;
  assertCondition(computeDominantFailureMode(contracts.map((contract) => {
    const item = edge.experiments as Array<Record<string, unknown>>;
    return item.find((entry) => entry.experimentId === contract.experimentId)?.attributionCategory as (typeof ATTRIBUTION_CATEGORIES)[number];
  })) === edge.dominantFailureMode, "dominant failure mode calculation drift");
  validateManifest(localManifest, evidence);
  console.log("R1-WP2 validation PASS");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
