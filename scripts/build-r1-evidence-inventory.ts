import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  R1_BASE_SHA,
  R1_BRANCH,
  R1_EXPERIMENTS,
  R1_PROGRAM,
  SYSTEM_BOUNDARY,
  canonicalJson,
  computeReturnComparisonEligibility,
  sha256,
  type EvidenceSource,
  type ExperimentDefinition,
} from "./r1-catalog";

const root = process.cwd();
const requiredOutputs = [
  "reports/r1-system-boundary.json",
  "reports/r1-experiment-inventory.json",
  "reports/r1-evidence-provenance.json",
  "reports/r1-wp1-summary.json",
  "reports/r1-wp1-manifest.json",
] as const;

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function canonicalText(value: Buffer): string {
  return value.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function canonicalArtifactHash(value: Buffer, path: string): string {
  const text = canonicalText(value);
  if (path.endsWith(".json")) return sha256(canonicalJson(JSON.parse(text) as unknown));
  return sha256(text);
}

function firstParent(commit: string): string | null {
  return gitText(["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean)[0] ?? null;
}

function readBlob(commit: string, path: string): { blobSha: string; bytes: Buffer } {
  const spec = `${commit}:${path}`;
  const blobSha = gitText(["rev-parse", spec]);
  const bytes = gitBytes(["cat-file", "blob", spec]);
  return { blobSha, bytes };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sourceIsRemote(source: EvidenceSource): boolean {
  return source.sourceKind === "github-commit-metadata";
}

function discoverCandidateBranches(): {
  branches: string[];
  reportsByBranch: Array<{ branch: string; head: string; reportPaths: string[] }>;
  excluded: Array<{ branch: string; reason: string }>;
} {
  const refs = gitText(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"])
    .split(/\r?\n/)
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter((ref) => /^(feat|research|rollout|hotfix|chore)\//.test(ref));
  const branches = sortedUnique(refs);
  const reportsByBranch = branches.map((branch) => {
    const head = gitText(["rev-parse", branch]);
    const reportPaths = gitText(["ls-tree", "-r", "--name-only", branch])
      .split(/\r?\n/)
      .filter((path) => path.startsWith("reports/"));
    return { branch, head, reportPaths };
  });
  const canonicalBranches = new Set(R1_EXPERIMENTS.map((experiment) => experiment.branch));
  const excluded = reportsByBranch
    .filter(({ branch, reportPaths }) => !canonicalBranches.has(branch) && (reportPaths.length > 0 || branch === "chore/research-closeout"))
    .map(({ branch, reportPaths }) => ({
      branch,
      reason: branch === "chore/research-closeout"
        ? "DOCUMENTATION_ONLY_ARCHIVE"
        : branch.startsWith("hotfix/") || branch.startsWith("rollout/")
          ? "OPERATIONAL_BRANCH_NOT_FORMAL_RESEARCH"
          : reportPaths.length === 0
            ? "NO_COMMITTED_REPORT_EVIDENCE"
            : "NO_CANONICAL_EXPERIMENT_RECORD",
    }));
  return { branches, reportsByBranch, excluded };
}

function buildProvenance(experiment: ExperimentDefinition): Array<Record<string, unknown>> {
  return experiment.evidenceSources.map((source) => {
    if (sourceIsRemote(source)) {
      return {
        experimentId: experiment.experimentId,
        branch: experiment.branch,
        commit: source.commit,
        path: source.path,
        gitBlobSha: null,
        rawSha256: null,
        canonicalSha256: null,
        evidenceRole: source.evidenceRole,
        sourceKind: source.sourceKind,
        sourceAvailable: false,
        note: "GitHub commit metadata was previously confirmed; local Git object is unavailable, so blob provenance is intentionally not inferred.",
      };
    }
    const { blobSha, bytes } = readBlob(source.commit, source.path);
    return {
      experimentId: experiment.experimentId,
      branch: experiment.branch,
      commit: source.commit,
      path: source.path,
      gitBlobSha: blobSha,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      canonicalSha256: canonicalArtifactHash(bytes, source.path),
      evidenceRole: source.evidenceRole,
      sourceKind: source.sourceKind,
      sourceAvailable: true,
    };
  });
}

function buildInventoryRecord(experiment: ExperimentDefinition): Record<string, unknown> {
  const eligibility = computeReturnComparisonEligibility({
    dataGate: experiment.dataGate,
    historicalStrategyOutcomeReturnsRead: experiment.historicalStrategyOutcomeReturnsRead,
    resultCommit: experiment.resultCommit,
    executionCostContractIdentifiable: experiment.resultCommit !== null,
    superseded: experiment.superseded,
    knownInvalid: experiment.knownInvalid,
  });
  requireCondition(eligibility.eligible === experiment.returnComparisonEligible, `${experiment.experimentId}: return eligibility definition drift`);
  requireCondition(eligibility.reason === experiment.returnComparisonExclusionReason, `${experiment.experimentId}: exclusion reason drift`);
  const remoteOnly = experiment.evidenceSources.every(sourceIsRemote);
  return {
    experimentId: experiment.experimentId,
    version: experiment.version,
    branch: experiment.branch,
    branchHead: experiment.branchHead,
    approvedEvidenceCommit: experiment.approvedEvidenceCommit,
    parentCommit: remoteOnly ? experiment.parentCommit : firstParent(experiment.branchHead),
    dataGate: experiment.dataGate,
    freeze: experiment.freeze,
    historicalStrategyOutcomeReturnsRead: experiment.historicalStrategyOutcomeReturnsRead,
    resultCommit: experiment.resultCommit,
    promotionEvaluated: experiment.promotionEvaluated,
    classification: experiment.classification,
    researchStop: experiment.researchStop,
    taxonomy: experiment.taxonomy,
    alphaFamily: experiment.alphaFamily,
    primaryDataSource: experiment.primaryDataSource,
    informationSourceClass: experiment.informationSourceClass,
    productionChanged: experiment.productionChanged,
    deploy: experiment.deploy,
    merge: experiment.merge,
    autoTrading: experiment.autoTrading,
    returnComparisonEligible: eligibility.eligible,
    returnComparisonExclusionReason: eligibility.reason,
    superseded: experiment.superseded ?? false,
    knownInvalid: experiment.knownInvalid ?? false,
    postResultValidatorCommits: experiment.postResultValidatorCommits ?? [],
    evidencePaths: experiment.evidenceSources.map((source) => source.path).sort(),
    evidenceProvenanceStatus: remoteOnly ? "REMOTE_ONLY" : "LOCAL_GIT_BLOBS_VERIFIED",
    ...(experiment.notes ? { notes: experiment.notes } : {}),
  };
}

function countBy(records: readonly Record<string, unknown>[], key: string): Record<string, number> {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = String(record[key]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const absolutePath = resolve(root, path);
  await mkdir(resolve(root, "reports"), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureOutputsDoNotExist(): Promise<void> {
  for (const path of requiredOutputs) {
    try {
      await access(resolve(root, path));
      throw new Error(`R1_OUTPUT_ALREADY_EXISTS: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("R1_OUTPUT_ALREADY_EXISTS")) throw error;
    }
  }
}

async function main(): Promise<void> {
  requireCondition(gitText(["branch", "--show-current"]) === R1_BRANCH, `R1 branch must be ${R1_BRANCH}`);
  requireCondition(gitText(["rev-parse", "HEAD"]) === R1_BASE_SHA, `R1 builder must run at clean base ${R1_BASE_SHA}`);
  requireCondition(gitText(["merge-base", "HEAD", R1_BASE_SHA]) === R1_BASE_SHA, "R1 base ancestry mismatch");
  const preGenerationPaths = new Set([
    ".github/workflows/ci.yml",
    "package.json",
    "scripts/build-r1-evidence-inventory.ts",
    "scripts/r1-catalog.ts",
    "scripts/validate-r1-wp1.ts",
    "tests/r1-wp1.test.ts",
  ]);
  const preGenerationStatus = gitText(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  for (const status of preGenerationStatus) {
    const normalizedStatus = status.trimStart();
    const path = normalizedStatus.startsWith("?? ") ? normalizedStatus.slice(3) : normalizedStatus.slice(2).trim();
    requireCondition(preGenerationPaths.has(path), `unexpected pre-generation worktree change: ${path}`);
  }
  await ensureOutputsDoNotExist();

  const discovery = discoverCandidateBranches();
  const provenanceEntries = R1_EXPERIMENTS.flatMap(buildProvenance).sort((left, right) => {
    const experimentOrder = String(left.experimentId).localeCompare(String(right.experimentId));
    return experimentOrder || String(left.path).localeCompare(String(right.path));
  });
  const inventoryRecords = R1_EXPERIMENTS.map(buildInventoryRecord).sort((left, right) => String(left.experimentId).localeCompare(String(right.experimentId)));
  const systemBoundary = {
    schemaVersion: "r1-system-boundary-v1",
    program: R1_PROGRAM,
    baseSha: R1_BASE_SHA,
    boundary: SYSTEM_BOUNDARY,
  };
  const inventory = {
    schemaVersion: "r1-experiment-inventory-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    discovery: {
      method: "git for-each-ref + git ls-tree; canonical records require committed report evidence",
      candidateBranches: discovery.branches,
      discoveredReports: discovery.reportsByBranch,
      excludedCandidates: discovery.excluded,
      canonicalExperimentIds: inventoryRecords.map((record) => record.experimentId),
    },
    experiments: inventoryRecords,
  };
  const provenance = {
    schemaVersion: "r1-evidence-provenance-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    generatedFrom: "historical Git objects via git rev-parse and git cat-file; never current working-tree evidence",
    entries: provenanceEntries,
  };
  const summary = {
    schemaVersion: "r1-wp1-summary-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    formalExperimentCount: inventoryRecords.length,
    dataInsufficientCount: inventoryRecords.filter((record) => record.taxonomy === "DATA_INSUFFICIENT").length,
    resultRejectedCount: inventoryRecords.filter((record) => record.taxonomy === "RESULT_REJECTED").length,
    promotionCandidateCount: inventoryRecords.filter((record) => record.taxonomy === "PROMOTION_CANDIDATE").length,
    processIncompleteCount: inventoryRecords.filter((record) => record.taxonomy === "PROCESS_INCOMPLETE").length,
    evidenceIncompleteCount: inventoryRecords.filter((record) => record.taxonomy === "EVIDENCE_INCOMPLETE").length,
    noFormalResultCount: inventoryRecords.filter((record) => record.taxonomy === "NO_FORMAL_RESULT").length,
    returnComparisonEligibleCount: inventoryRecords.filter((record) => record.returnComparisonEligible === true).length,
    countsByAlphaFamily: countBy(inventoryRecords, "alphaFamily"),
    countsByInformationSourceClass: countBy(inventoryRecords, "informationSourceClass"),
  };

  await writeJson("reports/r1-system-boundary.json", systemBoundary);
  await writeJson("reports/r1-experiment-inventory.json", inventory);
  await writeJson("reports/r1-evidence-provenance.json", provenance);
  await writeJson("reports/r1-wp1-summary.json", summary);

  const artifactHashes = Object.fromEntries(await Promise.all(requiredOutputs.slice(0, 4).map(async (path) => {
    const content = await readFile(resolve(root, path));
    return [path, {
      rawSha256: sha256(content),
      canonicalSha256: canonicalArtifactHash(content, path),
    }];
  })));
  const manifestCore = {
    schemaVersion: "r1-wp1-manifest-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    directParent: R1_BASE_SHA,
    generatedFrom: "historical Git objects and committed reports only",
    artifacts: artifactHashes,
    counts: {
      formalExperimentCount: summary.formalExperimentCount,
      dataInsufficientCount: summary.dataInsufficientCount,
      resultRejectedCount: summary.resultRejectedCount,
      promotionCandidateCount: summary.promotionCandidateCount,
      processIncompleteCount: summary.processIncompleteCount,
      evidenceIncompleteCount: summary.evidenceIncompleteCount,
      noFormalResultCount: summary.noFormalResultCount,
      returnComparisonEligibleCount: summary.returnComparisonEligibleCount,
    },
    flags: {
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
    },
    provenancePolicy: "Every local evidence hash is computed from the exact Git blob at its cited commit; remote-only metadata is never treated as a verified local blob.",
  };
  const manifestBodySha256 = sha256(canonicalJson(manifestCore));
  const manifestWithBody = { ...manifestCore, manifestBodySha256 };
  const manifestSha256 = sha256(canonicalJson(manifestWithBody));
  await writeJson("reports/r1-wp1-manifest.json", { ...manifestWithBody, manifestSha256 });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
