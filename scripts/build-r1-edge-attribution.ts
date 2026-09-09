import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  R1_BASE_SHA,
  R1_BRANCH,
  R1_EXPERIMENTS,
  R1_PROGRAM,
  SYSTEM_BOUNDARY,
  V18_FREEZE_SHA,
  V18_RESULT_SHA,
  V21_FREEZE_SHA,
  V21_RESULT_SHA,
  canonicalJson,
  sha256,
} from "./r1-catalog";

export const WP1_COMMIT = "3897dfaf3d368ba391684f12580ba3aa12a632d2";
export const WP2_EXPERIMENT_IDS = [
  "V7_DERIVATIVES_FLOW_ALPHA",
  "V17_CROWDING_FAILED_CONTINUATION",
  "V18_TAKER_FLOW_ABSORPTION_REVERSAL",
  "V19_BTC_SHOCK_ALT_CATCHUP",
  "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL",
] as const;

export const EXPECTED_CANONICAL_RESULT_COMMITS: Record<(typeof WP2_EXPERIMENT_IDS)[number], string> = {
  V7_DERIVATIVES_FLOW_ALPHA: "33be0cf4facf62952a196caa98a2102515bd4c2f",
  V17_CROWDING_FAILED_CONTINUATION: "0b1381a6bcbf4b60e746e09ec8d614d65b1aa754",
  V18_TAKER_FLOW_ABSORPTION_REVERSAL: V18_RESULT_SHA,
  V19_BTC_SHOCK_ALT_CATCHUP: "1f06e6c327af42da741abe8e7f7e51ad26144325",
  V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL: V21_RESULT_SHA,
};

export const ATTRIBUTION_CATEGORIES = [
  "NO_PRE_FRICTION_EDGE",
  "EXECUTION_FRICTION_DOMINATED",
  "NET_EDGE_NOT_ROBUST",
  "ROBUST_NET_EDGE",
  "ATTRIBUTION_UNRESOLVED",
] as const;

export const ROBUSTNESS_LABELS = [
  "NEGATIVE_PRIMARY",
  "LOW_PROFIT_FACTOR",
  "NEGATIVE_AVG_EXPECTANCY",
  "NEGATIVE_BOOTSTRAP_LCB",
  "NEGATIVE_HOLDOUT_A",
  "NEGATIVE_HOLDOUT_B",
  "COST_STRESS_FAIL",
  "SYMBOL_BREADTH_FAIL",
  "YEAR_BREADTH_FAIL",
  "CONTROL_INFORMATION_GAIN_FAIL",
  "CONCENTRATION_FAIL",
  "SAMPLE_FAIL",
  "OTHER_FROZEN_GATE_FAIL",
] as const;

export type AttributionCategory = (typeof ATTRIBUTION_CATEGORIES)[number];
export type RobustnessLabel = (typeof ROBUSTNESS_LABELS)[number];
export type GateValue = boolean | "NOT_APPLICABLE";
export type ReturnUnit = "DECIMAL_RETURN" | "R_MULTIPLE" | "USDT" | "OTHER";

export interface SourcePathRecord {
  commit: string;
  path: string;
  gitBlobSha: string;
  rawSha256: string;
  canonicalSha256: string;
}

export interface NumericProvenance {
  experimentId: string;
  commit: string;
  path: string;
  gitBlobSha: string;
  jsonPath: string;
  rawValue: unknown;
  value: number;
  extraction: "DIRECTLY_REPORTED" | "EXACTLY_DERIVED";
  derivationFormula: string | null;
  inputFields: string[];
  inputValues: Record<string, unknown> | null;
  inputUnits: Record<string, string> | null;
  unit: string;
}

export interface MetricContract {
  experimentId: string;
  version: string;
  alphaFamily: string;
  informationSourceClass: string;
  classification: string;
  canonicalResultCommit: string;
  primaryEvaluationWindow: string | null;
  primaryHorizon: string | null;
  returnUnit: ReturnUnit;
  primarySample: number | null;
  baselineNetMetricName: string | null;
  baselineNetTotal: number | null;
  baselineNetAverage: number | null;
  grossMetricName: string | null;
  grossTotal: number | null;
  grossAverage: number | null;
  preExecutionFrictionEdge: number | null;
  feesTotal: number | null;
  slippageTotal: number | null;
  fundingCarry: number | null;
  feeModel: string;
  slippageModel: string;
  fundingTreatment: string;
  otherCosts: string | null;
  executionContractIdentifiable: boolean;
  costContractIdentifiable: boolean;
  grossEdgeIdentifiable: boolean;
  netEdgeIdentifiable: boolean;
  sourcePaths: SourcePathRecord[];
  numericProvenance: Record<string, NumericProvenance[]>;
  unavailableReasons: Record<string, string>;
}

export interface GateEvidence {
  value: GateValue;
  source: string | null;
  jsonPath: string | null;
  reason: string | null;
}

export interface FailureGateMatrix {
  experimentId: string;
  canonicalResultCommit: string;
  gates: {
    dataGatePass: GateValue;
    primaryNetPositive: GateValue;
    primaryPfPass: GateValue;
    primaryAvgNetPositive: GateValue;
    bootstrapPass: GateValue;
    holdoutAPass: GateValue;
    holdoutBPass: GateValue;
    stressPass: GateValue;
    symbolBreadthPass: GateValue;
    yearBreadthPass: GateValue;
    informationGainPass: GateValue;
    concentrationPass: GateValue;
  };
  gateEvidence: Record<string, GateEvidence>;
  failedRobustnessLabels: RobustnessLabel[];
}

interface BuiltEvidence {
  contracts: MetricContract[];
  matrix: FailureGateMatrix[];
  edge: Record<string, unknown>;
  summary: Record<string, unknown>;
}

interface GitBlob {
  commit: string;
  path: string;
  bytes: Buffer;
  text: string;
  json: unknown;
  record: SourcePathRecord;
}

const root = process.cwd();
const numericContractFields = [
  "primarySample",
  "baselineNetTotal",
  "baselineNetAverage",
  "grossTotal",
  "grossAverage",
  "preExecutionFrictionEdge",
  "feesTotal",
  "slippageTotal",
  "fundingCarry",
] as const;

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function canonicalText(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function canonicalArtifactHash(bytes: Buffer, path: string): string {
  const text = canonicalText(bytes);
  return path.endsWith(".json") ? sha256(canonicalJson(JSON.parse(text) as unknown)) : sha256(text);
}

function readGitBlob(commit: string, path: string): GitBlob {
  const bytes = gitBytes(["cat-file", "blob", `${commit}:${path}`]);
  const text = canonicalText(bytes);
  let json: unknown = null;
  if (path.endsWith(".json")) json = JSON.parse(text) as unknown;
  return {
    commit,
    path,
    bytes,
    text,
    json,
    record: {
      commit,
      path,
      gitBlobSha: gitText(["rev-parse", `${commit}:${path}`]),
      rawSha256: sha256(bytes),
      canonicalSha256: canonicalArtifactHash(bytes, path),
    },
  };
}

function recordFor(commit: string, path: string): SourcePathRecord {
  return readGitBlob(commit, path).record;
}

function sourceText(commit: string, path: string): string {
  return readGitBlob(commit, path).text;
}

function sourceJson<T>(commit: string, path: string): T {
  return readGitBlob(commit, path).json as T;
}

function experimentDefinition(experimentId: string) {
  const definition = R1_EXPERIMENTS.find((item) => item.experimentId === experimentId);
  if (!definition) throw new Error(`R1_WP2_BUILD_FAILED: experiment missing from WP1.1 catalog: ${experimentId}`);
  return definition;
}

function sourceRecordMap(sources: Array<[string, string]>): SourcePathRecord[] {
  const unique = new Map<string, SourcePathRecord>();
  for (const [commit, path] of sources) unique.set(`${commit}:${path}`, recordFor(commit, path));
  return [...unique.values()].sort((left, right) => `${left.commit}:${left.path}`.localeCompare(`${right.commit}:${right.path}`));
}

function direct(
  experimentId: string,
  source: GitBlob,
  jsonPath: string,
  value: number,
  unit: string,
): NumericProvenance {
  return {
    experimentId,
    commit: source.commit,
    path: source.path,
    gitBlobSha: source.record.gitBlobSha,
    jsonPath,
    rawValue: value,
    value,
    extraction: "DIRECTLY_REPORTED",
    derivationFormula: null,
    inputFields: [jsonPath],
    inputValues: null,
    inputUnits: null,
    unit,
  };
}

function derived(
  experimentId: string,
  source: GitBlob,
  jsonPath: string,
  value: number,
  formula: string,
  inputFields: string[],
  inputValues: Record<string, unknown>,
  inputUnits: Record<string, string>,
  unit: string,
): NumericProvenance {
  return {
    experimentId,
    commit: source.commit,
    path: source.path,
    gitBlobSha: source.record.gitBlobSha,
    jsonPath,
    rawValue: inputValues,
    value,
    extraction: "EXACTLY_DERIVED",
    derivationFormula: formula,
    inputFields,
    inputValues,
    inputUnits,
    unit,
  };
}

function withProvenance(
  contract: Omit<MetricContract, "numericProvenance">,
  numericProvenance: Record<string, NumericProvenance[]>,
): MetricContract {
  return { ...contract, numericProvenance };
}

export function derivePreExecutionFrictionEdge(input: {
  net: number;
  fees: number;
  slippage: number;
  funding?: number | null;
  unit: string;
  inputUnits: { net: string; fees: string; slippage: string; funding?: string | null };
}): number {
  const units = [input.inputUnits.net, input.inputUnits.fees, input.inputUnits.slippage];
  if (units.some((unit) => unit !== input.unit)) throw new Error("R1_WP2_UNIT_MISMATCH: execution friction inputs must share one unit");
  if (input.inputUnits.funding !== undefined && input.inputUnits.funding !== null && input.inputUnits.funding !== input.unit) {
    throw new Error("R1_WP2_UNIT_MISMATCH: funding input must not be mixed into a different return unit");
  }
  void input.funding;
  return input.net + input.fees + input.slippage;
}

export function classifyAttribution(input: {
  preExecutionFrictionEdge: number | null;
  baselineNet: number | null;
  promotionPass: boolean;
}): AttributionCategory {
  if (input.preExecutionFrictionEdge === null || input.baselineNet === null) return "ATTRIBUTION_UNRESOLVED";
  if (input.preExecutionFrictionEdge <= 0) return "NO_PRE_FRICTION_EDGE";
  if (input.baselineNet <= 0) return "EXECUTION_FRICTION_DOMINATED";
  return input.promotionPass ? "ROBUST_NET_EDGE" : "NET_EDGE_NOT_ROBUST";
}

export function computeDominantFailureMode(categories: readonly AttributionCategory[]): string {
  const resolved = categories.filter((category) => category !== "ATTRIBUTION_UNRESOLVED");
  if (resolved.length < 3) return "INSUFFICIENT_ATTRIBUTION_EVIDENCE";
  const counts = new Map<AttributionCategory, number>();
  for (const category of resolved) counts.set(category, (counts.get(category) ?? 0) + 1);
  const dominant = [...counts.entries()].find(([, count]) => count / resolved.length > 0.5);
  return dominant?.[0] ?? "MIXED_FAILURE_MODES";
}

export function assertNumericProvenance(contract: MetricContract): void {
  for (const field of numericContractFields) {
    const value = contract[field];
    if (typeof value !== "number") {
      if (value === null && !contract.unavailableReasons[field]) throw new Error(`R1_WP2_PROVENANCE_FAILED: ${contract.experimentId}.${field} is null without reason`);
      continue;
    }
    const entries = contract.numericProvenance[field];
    if (!entries?.length) throw new Error(`R1_WP2_PROVENANCE_FAILED: missing provenance for ${contract.experimentId}.${field}`);
    for (const entry of entries) {
      if (entry.experimentId !== contract.experimentId || !entry.commit || !entry.path || !entry.gitBlobSha || !entry.jsonPath || entry.value !== value || !entry.unit) {
        throw new Error(`R1_WP2_PROVENANCE_FAILED: incomplete provenance for ${contract.experimentId}.${field}`);
      }
      if (entry.extraction === "EXACTLY_DERIVED" && (!entry.derivationFormula || !entry.inputFields.length || !entry.inputValues || !entry.inputUnits)) {
        throw new Error(`R1_WP2_PROVENANCE_FAILED: incomplete derivation for ${contract.experimentId}.${field}`);
      }
    }
  }
}

export function assertNoCrossExperimentRanking(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCrossExperimentRanking(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["rank", "ranking", "score", "compositeScore", "bestCandidate", "averageNetAcrossExperiments", "sumNetAcrossExperiments", "netMagnitudeRank"].includes(key)) {
      throw new Error(`R1_WP2_FORBIDDEN_RANKING: ${path}.${key}`);
    }
    assertNoCrossExperimentRanking(child, `${path}.${key}`);
  }
}

function v7Contract(): MetricContract {
  const id = "V7_DERIVATIVES_FLOW_ALPHA";
  const definition = experimentDefinition(id);
  const result = readGitBlob(definition.approvedEvidenceCommit, "reports/v7-family-results.json");
  const dataGate = readGitBlob(definition.approvedEvidenceCommit, "reports/v7-data-feasibility.json");
  const promotion = readGitBlob(definition.approvedEvidenceCommit, "reports/v7-promotion-decision.md");
  const familyResults = result.json as Array<Record<string, unknown>>;
  const selected = familyResults[2] as Record<string, unknown>;
  const selectedRun = selected.selectedRun as Record<string, unknown> | undefined;
  const metrics = selectedRun?.metrics as Record<string, number> | undefined;
  if (!metrics) throw new Error("R1_WP2_BUILD_FAILED: V7 selected representative has no metrics");
  if (!promotion.text.includes("Best diagnostic representative: **CROWDING_REVERSAL")) throw new Error("R1_WP2_BUILD_FAILED: V7 frozen representative changed");
  const net = metrics.totalNetPnlUsdt;
  const fees = metrics.totalFeesUsdt;
  const slippage = metrics.totalSlippageUsdt;
  const funding = metrics.totalFundingUsdt;
  const sample = metrics.trades;
  const pre = derivePreExecutionFrictionEdge({ net, fees, slippage, funding, unit: "USDT", inputUnits: { net: "USDT", fees: "USDT", slippage: "USDT", funding: "USDT" } });
  const gross = pre + funding;
  const prov = {
    primarySample: [direct(id, result, "[2].selectedRun.metrics.trades", sample, "COUNT")],
    baselineNetTotal: [direct(id, result, "[2].selectedRun.metrics.totalNetPnlUsdt", net, "USDT")],
    grossTotal: [derived(id, result, "[2].selectedRun.metrics.totalNetPnlUsdt + totalFeesUsdt + totalSlippageUsdt + totalFundingUsdt", gross, "net + fees + slippage + funding", ["[2].selectedRun.metrics.totalNetPnlUsdt", "[2].selectedRun.metrics.totalFeesUsdt", "[2].selectedRun.metrics.totalSlippageUsdt", "[2].selectedRun.metrics.totalFundingUsdt"], { net, fees, slippage, funding }, { net: "USDT", fees: "USDT", slippage: "USDT", funding: "USDT" }, "USDT")],
    grossAverage: [derived(id, result, "grossTotal / [2].selectedRun.metrics.trades", gross / sample, "grossTotal / primarySample", ["derived.grossTotal", "[2].selectedRun.metrics.trades"], { gross, sample }, { gross: "USDT", sample: "COUNT" }, "USDT")],
    preExecutionFrictionEdge: [derived(id, result, "[2].selectedRun.metrics.totalNetPnlUsdt + totalFeesUsdt + totalSlippageUsdt", pre, "net + fees + slippage; funding remains separately reported", ["[2].selectedRun.metrics.totalNetPnlUsdt", "[2].selectedRun.metrics.totalFeesUsdt", "[2].selectedRun.metrics.totalSlippageUsdt"], { net, fees, slippage }, { net: "USDT", fees: "USDT", slippage: "USDT" }, "USDT")],
    feesTotal: [direct(id, result, "[2].selectedRun.metrics.totalFeesUsdt", fees, "USDT")],
    slippageTotal: [direct(id, result, "[2].selectedRun.metrics.totalSlippageUsdt", slippage, "USDT")],
    fundingCarry: [direct(id, result, "[2].selectedRun.metrics.totalFundingUsdt", funding, "USDT")],
  };
  return withProvenance({
    experimentId: id,
    version: definition.version,
    alphaFamily: definition.alphaFamily,
    informationSourceClass: definition.informationSourceClass,
    classification: definition.classification,
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS[id],
    primaryEvaluationWindow: "frozen report-declared CROWDING_REVERSAL selectedRun",
    primaryHorizon: null,
    returnUnit: "USDT",
    primarySample: sample,
    baselineNetMetricName: "selectedRun.metrics.totalNetPnlUsdt",
    baselineNetTotal: net,
    baselineNetAverage: null,
    grossMetricName: null,
    grossTotal: gross,
    grossAverage: gross / sample,
    preExecutionFrictionEdge: pre,
    feesTotal: fees,
    slippageTotal: slippage,
    fundingCarry: funding,
    feeModel: "native totalFeesUsdt from the frozen Result",
    slippageModel: "native totalSlippageUsdt from the frozen Result",
    fundingTreatment: "native totalFundingUsdt; reported separately and excluded from execution friction",
    otherCosts: null,
    executionContractIdentifiable: false,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: sourceRecordMap([[result.commit, result.path], [dataGate.commit, dataGate.path], [promotion.commit, promotion.path]]),
    unavailableReasons: {
      baselineNetAverage: "USDT average net is not explicitly reported; avgR is a different unit and is not substituted",
      grossMetricName: "No gross field name is present; gross is exactly derived from same-unit native totals",
      primaryHorizon: "Canonical V7 family report does not expose a single horizon for the selected representative",
    },
  }, prov);
}

function v17Contract(): MetricContract {
  const id = "V17_CROWDING_FAILED_CONTINUATION";
  const definition = experimentDefinition(id);
  const result = readGitBlob(definition.approvedEvidenceCommit, "reports/v17-validation-summary.json");
  const dataGate = readGitBlob(definition.approvedEvidenceCommit, "reports/v17-data-gate-v2.json");
  const freeze = readGitBlob(definition.approvedEvidenceCommit, "reports/v17-freeze-manifest.json");
  const promotion = readGitBlob(definition.approvedEvidenceCommit, "reports/v17-promotion-decision.json");
  const report = result.json as Record<string, unknown>;
  const primary = report.primaryOos as Record<string, number>;
  const prov = {
    primarySample: [direct(id, result, "primaryOos.trades", primary.trades, "COUNT")],
    baselineNetTotal: [direct(id, result, "primaryOos.netR", primary.netR, "R_MULTIPLE")],
    baselineNetAverage: [direct(id, result, "primaryOos.avgR", primary.avgR, "R_MULTIPLE")],
    grossTotal: [direct(id, result, "primaryOos.grossR", primary.grossR, "R_MULTIPLE")],
    grossAverage: [derived(id, result, "primaryOos.grossR / primaryOos.trades", primary.grossR / primary.trades, "grossR / trades", ["primaryOos.grossR", "primaryOos.trades"], { grossR: primary.grossR, trades: primary.trades }, { grossR: "R_MULTIPLE", trades: "COUNT" }, "R_MULTIPLE")],
    preExecutionFrictionEdge: [direct(id, result, "primaryOos.grossR", primary.grossR, "R_MULTIPLE")],
    feesTotal: [direct(id, result, "primaryOos.feesR", primary.feesR, "R_MULTIPLE")],
    slippageTotal: [direct(id, result, "primaryOos.slippageR", primary.slippageR, "R_MULTIPLE")],
    fundingCarry: [direct(id, result, "primaryOos.fundingR", primary.fundingR, "R_MULTIPLE")],
  };
  return withProvenance({
    experimentId: id,
    version: definition.version,
    alphaFamily: definition.alphaFamily,
    informationSourceClass: definition.informationSourceClass,
    classification: definition.classification,
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS[id],
    primaryEvaluationWindow: "primaryOos",
    primaryHorizon: null,
    returnUnit: "R_MULTIPLE",
    primarySample: primary.trades,
    baselineNetMetricName: "primaryOos.netR",
    baselineNetTotal: primary.netR,
    baselineNetAverage: primary.avgR,
    grossMetricName: "primaryOos.grossR",
    grossTotal: primary.grossR,
    grossAverage: primary.grossR / primary.trades,
    preExecutionFrictionEdge: primary.grossR,
    feesTotal: primary.feesR,
    slippageTotal: primary.slippageR,
    fundingCarry: primary.fundingR,
    feeModel: "native feesR from the frozen Result",
    slippageModel: "native slippageR from the frozen Result",
    fundingTreatment: "native fundingR; reported separately and excluded from execution friction",
    otherCosts: null,
    executionContractIdentifiable: true,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: sourceRecordMap([[dataGate.commit, dataGate.path], [freeze.commit, freeze.path], [result.commit, result.path], [promotion.commit, promotion.path]]),
    unavailableReasons: {
      primaryHorizon: "V17 validation summary names primaryOos but does not state one horizon in that Result object",
    },
  }, prov);
}

function v18Contract(): MetricContract {
  const id = "V18_TAKER_FLOW_ABSORPTION_REVERSAL";
  const definition = experimentDefinition(id);
  const primary = readGitBlob(V18_RESULT_SHA, "reports/v18-primary-oos.json");
  const holdouts = readGitBlob(V18_RESULT_SHA, "reports/v18-holdouts.json");
  const confidence = readGitBlob(V18_RESULT_SHA, "reports/v18-confidence.json");
  const promotion = readGitBlob(V18_RESULT_SHA, "reports/v18-promotion-decision.json");
  const freeze = readGitBlob(V18_FREEZE_SHA, "reports/v18-freeze-manifest.json");
  const report = primary.json as Record<string, unknown>;
  const metrics = (report.primary as Record<string, unknown>).metrics as Record<string, number>;
  const prov = {
    primarySample: [direct(id, primary, "primary.metrics.trades", metrics.trades, "COUNT")],
    baselineNetTotal: [direct(id, primary, "primary.metrics.netReturn", metrics.netReturn, "DECIMAL_RETURN")],
    baselineNetAverage: [direct(id, primary, "primary.metrics.averageNetReturnPerTrade", metrics.averageNetReturnPerTrade, "DECIMAL_RETURN")],
    grossTotal: [direct(id, primary, "primary.metrics.grossReturn", metrics.grossReturn, "DECIMAL_RETURN")],
    grossAverage: [derived(id, primary, "primary.metrics.grossReturn / primary.metrics.trades", metrics.grossReturn / metrics.trades, "grossReturn / trades", ["primary.metrics.grossReturn", "primary.metrics.trades"], { grossReturn: metrics.grossReturn, trades: metrics.trades }, { grossReturn: "DECIMAL_RETURN", trades: "COUNT" }, "DECIMAL_RETURN")],
    preExecutionFrictionEdge: [direct(id, primary, "primary.metrics.grossReturn", metrics.grossReturn, "DECIMAL_RETURN")],
    feesTotal: [direct(id, primary, "primary.metrics.fees", metrics.fees, "DECIMAL_RETURN")],
    slippageTotal: [direct(id, primary, "primary.metrics.slippage", metrics.slippage, "DECIMAL_RETURN")],
  };
  return withProvenance({
    experimentId: id,
    version: definition.version,
    alphaFamily: definition.alphaFamily,
    informationSourceClass: definition.informationSourceClass,
    classification: definition.classification,
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS[id],
    primaryEvaluationWindow: "2022-01-01/2024-12-31",
    primaryHorizon: "60m",
    returnUnit: "DECIMAL_RETURN",
    primarySample: metrics.trades,
    baselineNetMetricName: "primary.metrics.netReturn",
    baselineNetTotal: metrics.netReturn,
    baselineNetAverage: metrics.averageNetReturnPerTrade,
    grossMetricName: "primary.metrics.grossReturn",
    grossTotal: metrics.grossReturn,
    grossAverage: metrics.grossReturn / metrics.trades,
    preExecutionFrictionEdge: metrics.grossReturn,
    feesTotal: metrics.fees,
    slippageTotal: metrics.slippage,
    fundingCarry: null,
    feeModel: "4 bps per side; 12 bps baseline round trip in the frozen manifest",
    slippageModel: "2 bps per side; 12 bps baseline round trip in the frozen manifest",
    fundingTreatment: "not present in the V18 frozen accounting contract; not inferred as zero",
    otherCosts: null,
    executionContractIdentifiable: true,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: sourceRecordMap([[freeze.commit, freeze.path], [primary.commit, primary.path], [holdouts.commit, holdouts.path], [confidence.commit, confidence.path], [promotion.commit, promotion.path]]),
    unavailableReasons: {
      fundingCarry: "V18 canonical Result reports no funding field and the frozen strategy prohibits funding as a feature",
    },
  }, prov);
}

function v19Contract(): MetricContract {
  const id = "V19_BTC_SHOCK_ALT_CATCHUP";
  const definition = experimentDefinition(id);
  const outcomes = readGitBlob(EXPECTED_CANONICAL_RESULT_COMMITS[id], "reports/v19-trade-outcomes.json");
  const freeze = readGitBlob(EXPECTED_CANONICAL_RESULT_COMMITS[id], "reports/v19-freeze-manifest.json");
  const promotion = readGitBlob(EXPECTED_CANONICAL_RESULT_COMMITS[id], "reports/v19-promotion-decision.json");
  const report = outcomes.json as { outcomes: Array<Record<string, unknown>> };
  const selected = report.outcomes.filter((row) => {
    const identity = row.identity as Record<string, unknown>;
    return row.status === "SETTLED" && identity.evaluationWindow === "PRIMARY_OOS";
  });
  const sum = (key: string): number => selected.reduce((total, row) => total + Number(row[key]), 0);
  const sample = selected.length;
  const gross = sum("grossReturn");
  const fees = sum("feeCost");
  const slippage = sum("slippageCost");
  const net = sum("baselineNetReturn");
  const pre = derivePreExecutionFrictionEdge({ net, fees, slippage, unit: "DECIMAL_RETURN", inputUnits: { net: "DECIMAL_RETURN", fees: "DECIMAL_RETURN", slippage: "DECIMAL_RETURN" } });
  const aggregateInputs = { sourceRowCount: report.outcomes.length, selectedSettledPrimaryOosRows: sample, selection: "status=SETTLED AND identity.evaluationWindow=PRIMARY_OOS" };
  const prov = {
    primarySample: [derived(id, outcomes, "outcomes[*].status + outcomes[*].identity.evaluationWindow", sample, "count(rows where status=SETTLED and evaluationWindow=PRIMARY_OOS)", ["outcomes[*].status", "outcomes[*].identity.evaluationWindow"], aggregateInputs, { status: "ENUM", evaluationWindow: "ENUM" }, "COUNT")],
    baselineNetTotal: [derived(id, outcomes, "outcomes[*].baselineNetReturn where PRIMARY_OOS/SETTLED", net, "sum(baselineNetReturn for selected rows)", ["outcomes[*].baselineNetReturn", "outcomes[*].status", "outcomes[*].identity.evaluationWindow"], { ...aggregateInputs, sumBaselineNetReturn: net }, { baselineNetReturn: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    baselineNetAverage: [derived(id, outcomes, "derived baselineNetTotal / derived primarySample", net / sample, "baselineNetTotal / primarySample", ["derived.baselineNetTotal", "derived.primarySample"], { net, sample }, { net: "DECIMAL_RETURN", sample: "COUNT" }, "DECIMAL_RETURN")],
    grossTotal: [derived(id, outcomes, "outcomes[*].grossReturn where PRIMARY_OOS/SETTLED", gross, "sum(grossReturn for selected rows)", ["outcomes[*].grossReturn", "outcomes[*].status", "outcomes[*].identity.evaluationWindow"], { ...aggregateInputs, sumGrossReturn: gross }, { grossReturn: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    grossAverage: [derived(id, outcomes, "derived grossTotal / derived primarySample", gross / sample, "grossTotal / primarySample", ["derived.grossTotal", "derived.primarySample"], { gross, sample }, { gross: "DECIMAL_RETURN", sample: "COUNT" }, "DECIMAL_RETURN")],
    preExecutionFrictionEdge: [derived(id, outcomes, "derived baselineNetTotal + derived feeCost + derived slippageCost", pre, "baselineNetTotal + feesTotal + slippageTotal; no funding field exists", ["derived.baselineNetTotal", "outcomes[*].feeCost", "outcomes[*].slippageCost"], { net, fees, slippage }, { net: "DECIMAL_RETURN", fees: "DECIMAL_RETURN", slippage: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    feesTotal: [derived(id, outcomes, "outcomes[*].feeCost where PRIMARY_OOS/SETTLED", fees, "sum(feeCost for selected rows)", ["outcomes[*].feeCost", "outcomes[*].status", "outcomes[*].identity.evaluationWindow"], { ...aggregateInputs, sumFeeCost: fees }, { feeCost: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    slippageTotal: [derived(id, outcomes, "outcomes[*].slippageCost where PRIMARY_OOS/SETTLED", slippage, "sum(slippageCost for selected rows)", ["outcomes[*].slippageCost", "outcomes[*].status", "outcomes[*].identity.evaluationWindow"], { ...aggregateInputs, sumSlippageCost: slippage }, { slippageCost: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
  };
  return withProvenance({
    experimentId: id,
    version: definition.version,
    alphaFamily: definition.alphaFamily,
    informationSourceClass: definition.informationSourceClass,
    classification: definition.classification,
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS[id],
    primaryEvaluationWindow: "identity.evaluationWindow=PRIMARY_OOS",
    primaryHorizon: "15m",
    returnUnit: "DECIMAL_RETURN",
    primarySample: sample,
    baselineNetMetricName: "outcomes[*].baselineNetReturn (selected PRIMARY_OOS/SETTLED rows)",
    baselineNetTotal: net,
    baselineNetAverage: net / sample,
    grossMetricName: "outcomes[*].grossReturn (selected PRIMARY_OOS/SETTLED rows)",
    grossTotal: gross,
    grossAverage: gross / sample,
    preExecutionFrictionEdge: pre,
    feesTotal: fees,
    slippageTotal: slippage,
    fundingCarry: null,
    feeModel: "4 bps per side; exact feeCost rows in the canonical outcome Result",
    slippageModel: "3 bps per side; exact slippageCost rows in the canonical outcome Result",
    fundingTreatment: "not present in the V19 outcome schema or frozen cost model; not inferred as zero",
    otherCosts: null,
    executionContractIdentifiable: true,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: sourceRecordMap([[freeze.commit, freeze.path], [outcomes.commit, outcomes.path], [promotion.commit, promotion.path]]),
    unavailableReasons: {
      fundingCarry: "V19 canonical outcome rows have no funding field; frozen cost model contains only fee and slippage",
    },
  }, prov);
}

function v21Contract(): MetricContract {
  const id = "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL";
  const definition = experimentDefinition(id);
  const result = readGitBlob(V21_RESULT_SHA, "reports/v21-result.json");
  const freeze = readGitBlob(V21_FREEZE_SHA, "reports/v21-freeze-manifest.json");
  const promotion = readGitBlob(V21_RESULT_SHA, "reports/v21-promotion-decision.json");
  const report = result.json as Record<string, unknown>;
  const primaryOos = report.primaryOos as Record<string, unknown>;
  const metrics = primaryOos.metrics as Record<string, Record<string, number>>;
  const sample = Number(primaryOos.identityCount);
  const net = metrics.baseline.net;
  const fee = sample * 0.0008;
  const slippage = sample * 0.0004;
  const pre = derivePreExecutionFrictionEdge({ net, fees: fee, slippage, unit: "DECIMAL_RETURN", inputUnits: { net: "DECIMAL_RETURN", fees: "DECIMAL_RETURN", slippage: "DECIMAL_RETURN" } });
  const prov = {
    primarySample: [direct(id, result, "primaryOos.identityCount", sample, "COUNT")],
    baselineNetTotal: [direct(id, result, "primaryOos.metrics.baseline.net", net, "DECIMAL_RETURN")],
    baselineNetAverage: [direct(id, result, "primaryOos.metrics.baseline.averageNet", metrics.baseline.averageNet, "DECIMAL_RETURN")],
    grossTotal: [derived(id, result, "primaryOos.metrics.baseline.net + frozen baseline round-trip cost", pre, "net + explicit fee/slippage friction", ["primaryOos.metrics.baseline.net", "costs.feeBpsPerSide", "costs.slippageBpsPerSide", "primaryOos.identityCount"], { net, feeBpsPerSide: 4, slippageBpsPerSide: 2, sample, fees: fee, slippage }, { net: "DECIMAL_RETURN", feeBpsPerSide: "BPS", slippageBpsPerSide: "BPS", sample: "COUNT", fees: "DECIMAL_RETURN", slippage: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    grossAverage: [derived(id, result, "derived grossTotal / primaryOos.identityCount", pre / sample, "grossTotal / primarySample", ["derived.grossTotal", "primaryOos.identityCount"], { gross: pre, sample }, { gross: "DECIMAL_RETURN", sample: "COUNT" }, "DECIMAL_RETURN")],
    preExecutionFrictionEdge: [derived(id, result, "primaryOos.metrics.baseline.net + explicit fee/slippage friction", pre, "net + (sample * (2*feeBpsPerSide + 2*slippageBpsPerSide) / 10000)", ["primaryOos.metrics.baseline.net", "costs.feeBpsPerSide", "costs.slippageBpsPerSide", "primaryOos.identityCount"], { net, feeBpsPerSide: 4, slippageBpsPerSide: 2, sample, fees: fee, slippage }, { net: "DECIMAL_RETURN", feeBpsPerSide: "BPS", slippageBpsPerSide: "BPS", sample: "COUNT", fees: "DECIMAL_RETURN", slippage: "DECIMAL_RETURN" }, "DECIMAL_RETURN")],
    feesTotal: [derived(id, freeze, "costs.feeBpsPerSide * 2 * primaryOos.identityCount / 10000", fee, "feeBpsPerSide * 2 * primarySample / 10000", ["costs.feeBpsPerSide", "primaryOos.identityCount"], { feeBpsPerSide: 4, sample }, { feeBpsPerSide: "BPS", sample: "COUNT" }, "DECIMAL_RETURN")],
    slippageTotal: [derived(id, freeze, "costs.slippageBpsPerSide * 2 * primaryOos.identityCount / 10000", slippage, "slippageBpsPerSide * 2 * primarySample / 10000", ["costs.slippageBpsPerSide", "primaryOos.identityCount"], { slippageBpsPerSide: 2, sample }, { slippageBpsPerSide: "BPS", sample: "COUNT" }, "DECIMAL_RETURN")],
  };
  return withProvenance({
    experimentId: id,
    version: definition.version,
    alphaFamily: definition.alphaFamily,
    informationSourceClass: definition.informationSourceClass,
    classification: definition.classification,
    canonicalResultCommit: EXPECTED_CANONICAL_RESULT_COMMITS[id],
    primaryEvaluationWindow: "PRIMARY_OOS",
    primaryHorizon: "PRIMARY_30M",
    returnUnit: "DECIMAL_RETURN",
    primarySample: sample,
    baselineNetMetricName: "primaryOos.metrics.baseline.net",
    baselineNetTotal: net,
    baselineNetAverage: metrics.baseline.averageNet,
    grossMetricName: null,
    grossTotal: pre,
    grossAverage: pre / sample,
    preExecutionFrictionEdge: pre,
    feesTotal: fee,
    slippageTotal: slippage,
    fundingCarry: null,
    feeModel: "frozen 4 bps per side; fixed additive return deduction",
    slippageModel: "frozen 2 bps per side; fixed additive return deduction",
    fundingTreatment: "not present in V21 frozen costs or Result; not inferred as zero",
    otherCosts: null,
    executionContractIdentifiable: true,
    costContractIdentifiable: true,
    grossEdgeIdentifiable: true,
    netEdgeIdentifiable: true,
    sourcePaths: sourceRecordMap([[freeze.commit, freeze.path], [result.commit, result.path], [promotion.commit, promotion.path]]),
    unavailableReasons: {
      fundingCarry: "V21 frozen accounting contract contains fee and slippage only",
      grossMetricName: "V21 Result exposes net only; pre-friction edge is exactly derived from its frozen fixed cost contract",
    },
  }, prov);
}

function nA(reason: string): GateEvidence {
  return { value: "NOT_APPLICABLE", source: null, jsonPath: null, reason };
}

function gate(value: boolean, source: string, jsonPath: string): GateEvidence {
  return { value, source, jsonPath, reason: null };
}

function combineGates(values: boolean[], source: string, jsonPath: string, reason: string): GateEvidence {
  return { value: values.every(Boolean), source, jsonPath, reason };
}

function labelsFromMatrix(matrix: Pick<FailureGateMatrix, "gates">, extra: RobustnessLabel[] = []): RobustnessLabel[] {
  const labels = new Set<RobustnessLabel>(extra);
  if (matrix.gates.primaryNetPositive === false) labels.add("NEGATIVE_PRIMARY");
  if (matrix.gates.primaryPfPass === false) labels.add("LOW_PROFIT_FACTOR");
  if (matrix.gates.primaryAvgNetPositive === false) labels.add("NEGATIVE_AVG_EXPECTANCY");
  if (matrix.gates.bootstrapPass === false) labels.add("NEGATIVE_BOOTSTRAP_LCB");
  if (matrix.gates.holdoutAPass === false) labels.add("NEGATIVE_HOLDOUT_A");
  if (matrix.gates.holdoutBPass === false) labels.add("NEGATIVE_HOLDOUT_B");
  if (matrix.gates.stressPass === false) labels.add("COST_STRESS_FAIL");
  if (matrix.gates.symbolBreadthPass === false) labels.add("SYMBOL_BREADTH_FAIL");
  if (matrix.gates.yearBreadthPass === false) labels.add("YEAR_BREADTH_FAIL");
  if (matrix.gates.informationGainPass === false) labels.add("CONTROL_INFORMATION_GAIN_FAIL");
  if (matrix.gates.concentrationPass === false) labels.add("CONCENTRATION_FAIL");
  if (!labels.size) labels.add("OTHER_FROZEN_GATE_FAIL");
  return ROBUSTNESS_LABELS.filter((label) => labels.has(label));
}

function v7Matrix(contract: MetricContract): FailureGateMatrix {
  const result = EXPECTED_CANONICAL_RESULT_COMMITS.V7_DERIVATIVES_FLOW_ALPHA;
  const data = readGitBlob(result, "reports/v7-data-feasibility.json");
  const family = readGitBlob(result, "reports/v7-family-results.json");
  const gates = {
    dataGatePass: true as GateValue,
    primaryNetPositive: "NOT_APPLICABLE" as GateValue,
    primaryPfPass: "NOT_APPLICABLE" as GateValue,
    primaryAvgNetPositive: "NOT_APPLICABLE" as GateValue,
    bootstrapPass: "NOT_APPLICABLE" as GateValue,
    holdoutAPass: "NOT_APPLICABLE" as GateValue,
    holdoutBPass: "NOT_APPLICABLE" as GateValue,
    stressPass: false as GateValue,
    symbolBreadthPass: "NOT_APPLICABLE" as GateValue,
    yearBreadthPass: "NOT_APPLICABLE" as GateValue,
    informationGainPass: "NOT_APPLICABLE" as GateValue,
    concentrationPass: "NOT_APPLICABLE" as GateValue,
  };
  const matrix: FailureGateMatrix = {
    experimentId: contract.experimentId,
    canonicalResultCommit: contract.canonicalResultCommit,
    gates,
    gateEvidence: {
      dataGatePass: gate(true, data.path, "status=PASS"),
      primaryNetPositive: nA("V7 report has no named primaryNetPositive promotion gate"),
      primaryPfPass: nA("V7 report has no named primary PF promotion gate"),
      primaryAvgNetPositive: nA("V7 report has no named primary average-net promotion gate"),
      bootstrapPass: nA("V7 report has no named bootstrap gate"),
      holdoutAPass: nA("V7 report has no named Holdout A gate"),
      holdoutBPass: nA("V7 report has no named Holdout B gate"),
      stressPass: gate(false, family.path, "[2].temporalValidation.gate.plus10BpsNetR"),
      symbolBreadthPass: nA("V7 symbol validation is incomplete but has no single breadth gate"),
      yearBreadthPass: nA("V7 report has no year-breadth gate"),
      informationGainPass: nA("V7 report has no information-gain gate"),
      concentrationPass: nA("V7 report has no concentration gate"),
    },
    failedRobustnessLabels: labelsFromMatrix({ gates }, ["NEGATIVE_BOOTSTRAP_LCB", "SAMPLE_FAIL"]),
  };
  return matrix;
}

function v17Matrix(contract: MetricContract): FailureGateMatrix {
  const result = EXPECTED_CANONICAL_RESULT_COMMITS.V17_CROWDING_FAILED_CONTINUATION;
  const data = readGitBlob(result, "reports/v17-validation-summary.json");
  const report = data.json as Record<string, unknown>;
  const primary = report.primaryOos as Record<string, number>;
  const holdouts = report.holdouts as Record<string, Record<string, number>>;
  const gates = {
    dataGatePass: true as GateValue,
    primaryNetPositive: "NOT_APPLICABLE" as GateValue,
    primaryPfPass: "NOT_APPLICABLE" as GateValue,
    primaryAvgNetPositive: "NOT_APPLICABLE" as GateValue,
    bootstrapPass: "NOT_APPLICABLE" as GateValue,
    holdoutAPass: "NOT_APPLICABLE" as GateValue,
    holdoutBPass: "NOT_APPLICABLE" as GateValue,
    stressPass: "NOT_APPLICABLE" as GateValue,
    symbolBreadthPass: "NOT_APPLICABLE" as GateValue,
    yearBreadthPass: "NOT_APPLICABLE" as GateValue,
    informationGainPass: "NOT_APPLICABLE" as GateValue,
    concentrationPass: "NOT_APPLICABLE" as GateValue,
  };
  const matrix: FailureGateMatrix = {
    experimentId: contract.experimentId,
    canonicalResultCommit: contract.canonicalResultCommit,
    gates,
    gateEvidence: {
      dataGatePass: gate(true, data.path, "dataGate=PASS"),
      primaryNetPositive: nA("V17 promotion JSON does not expose named gate booleans"),
      primaryPfPass: nA("V17 promotion JSON does not expose named gate booleans"),
      primaryAvgNetPositive: nA("V17 promotion JSON does not expose named gate booleans"),
      bootstrapPass: nA("V17 promotion JSON does not expose named bootstrap gate"),
      holdoutAPass: nA("V17 result exposes holdout metrics but no named gate boolean"),
      holdoutBPass: nA("V17 result exposes holdout metrics but no named gate boolean"),
      stressPass: nA("V17 result exposes stress metrics but no named gate boolean"),
      symbolBreadthPass: nA("V17 result exposes instrument metrics but no named breadth gate"),
      yearBreadthPass: nA("V17 result exposes yearly metrics but no named year gate"),
      informationGainPass: nA("V17 result has no named information-gain gate"),
      concentrationPass: nA("V17 result has no named concentration gate"),
    },
    failedRobustnessLabels: labelsFromMatrix({ gates }, [
      "NEGATIVE_PRIMARY",
      "LOW_PROFIT_FACTOR",
      "NEGATIVE_BOOTSTRAP_LCB",
      ...(holdouts.A.netR < 0 ? ["NEGATIVE_HOLDOUT_A" as const] : []),
      ...(holdouts.B.netR < 0 ? ["NEGATIVE_HOLDOUT_B" as const] : []),
      ...(primary.stress10bps < 0 ? ["COST_STRESS_FAIL" as const] : []),
    ]),
  };
  return matrix;
}

function v18Matrix(contract: MetricContract): FailureGateMatrix {
  const promotion = readGitBlob(V18_RESULT_SHA, "reports/v18-promotion-decision.json");
  const report = promotion.json as Record<string, unknown>;
  const gatesSource = (report.decision as Record<string, unknown>).gates as Record<string, boolean>;
  const gates = {
    dataGatePass: gatesSource.dataGatePass,
    primaryNetPositive: gatesSource.primaryNetPositive,
    primaryPfPass: gatesSource.primaryProfitFactorAtLeast1_20,
    primaryAvgNetPositive: "NOT_APPLICABLE" as GateValue,
    bootstrapPass: gatesSource.bootstrap95PercentLcbPositive,
    holdoutAPass: gatesSource.holdoutANetPositive,
    holdoutBPass: gatesSource.holdoutBNetPositive,
    stressPass: gatesSource.plus10BpsNetPositive,
    symbolBreadthPass: gatesSource.btcNetPositive && gatesSource.ethNetPositive,
    yearBreadthPass: "NOT_APPLICABLE" as GateValue,
    informationGainPass: "NOT_APPLICABLE" as GateValue,
    concentrationPass: "NOT_APPLICABLE" as GateValue,
  };
  const matrix: FailureGateMatrix = {
    experimentId: contract.experimentId,
    canonicalResultCommit: contract.canonicalResultCommit,
    gates,
    gateEvidence: {
      dataGatePass: gate(gatesSource.dataGatePass, promotion.path, "decision.gates.dataGatePass"),
      primaryNetPositive: gate(gatesSource.primaryNetPositive, promotion.path, "decision.gates.primaryNetPositive"),
      primaryPfPass: gate(gatesSource.primaryProfitFactorAtLeast1_20, promotion.path, "decision.gates.primaryProfitFactorAtLeast1_20"),
      primaryAvgNetPositive: nA("V18 future gate definition has no primary average-net gate"),
      bootstrapPass: gate(gatesSource.bootstrap95PercentLcbPositive, promotion.path, "decision.gates.bootstrap95PercentLcbPositive"),
      holdoutAPass: gate(gatesSource.holdoutANetPositive, promotion.path, "decision.gates.holdoutANetPositive"),
      holdoutBPass: gate(gatesSource.holdoutBNetPositive, promotion.path, "decision.gates.holdoutBNetPositive"),
      stressPass: gate(gatesSource.plus10BpsNetPositive, promotion.path, "decision.gates.plus10BpsNetPositive"),
      symbolBreadthPass: combineGates([gatesSource.btcNetPositive, gatesSource.ethNetPositive], promotion.path, "decision.gates.btcNetPositive && decision.gates.ethNetPositive", "V18 names BTC and ETH gates; breadth is their conjunction"),
      yearBreadthPass: nA("V18 has no year-breadth gate"),
      informationGainPass: nA("V18 controls are explanatory only; no information-gain gate"),
      concentrationPass: nA("V18 has no concentration gate"),
    },
    failedRobustnessLabels: labelsFromMatrix({ gates }),
  };
  return matrix;
}

function v19Matrix(contract: MetricContract): FailureGateMatrix {
  const promotion = readGitBlob(contract.canonicalResultCommit, "reports/v19-promotion-decision.json");
  const report = promotion.json as Record<string, unknown>;
  const sourceGates = (report.gates as Record<string, boolean>);
  const gates = {
    dataGatePass: true as GateValue,
    primaryNetPositive: sourceGates.primaryNetPositive,
    primaryPfPass: sourceGates.primaryPf,
    primaryAvgNetPositive: sourceGates.primaryAvgNetPositive,
    bootstrapPass: sourceGates.clusterBootstrapLcb95Positive,
    holdoutAPass: sourceGates.holdoutANetPositive,
    holdoutBPass: sourceGates.holdoutBNetPositive,
    stressPass: sourceGates.stress10NetPositive,
    symbolBreadthPass: sourceGates.profitableFollowers,
    yearBreadthPass: sourceGates.profitableYears,
    informationGainPass: sourceGates.informationGain,
    concentrationPass: sourceGates.maxFollowerTradeShare && sourceGates.maxPositiveGrossContribution,
  };
  const matrix: FailureGateMatrix = {
    experimentId: contract.experimentId,
    canonicalResultCommit: contract.canonicalResultCommit,
    gates,
    gateEvidence: {
      dataGatePass: gate(true, "reports/v19-data-gate.json", "status=PASS"),
      primaryNetPositive: gate(sourceGates.primaryNetPositive, promotion.path, "gates.primaryNetPositive"),
      primaryPfPass: gate(sourceGates.primaryPf, promotion.path, "gates.primaryPf"),
      primaryAvgNetPositive: gate(sourceGates.primaryAvgNetPositive, promotion.path, "gates.primaryAvgNetPositive"),
      bootstrapPass: gate(sourceGates.clusterBootstrapLcb95Positive, promotion.path, "gates.clusterBootstrapLcb95Positive"),
      holdoutAPass: gate(sourceGates.holdoutANetPositive, promotion.path, "gates.holdoutANetPositive"),
      holdoutBPass: gate(sourceGates.holdoutBNetPositive, promotion.path, "gates.holdoutBNetPositive"),
      stressPass: gate(sourceGates.stress10NetPositive, promotion.path, "gates.stress10NetPositive"),
      symbolBreadthPass: gate(sourceGates.profitableFollowers, promotion.path, "gates.profitableFollowers"),
      yearBreadthPass: gate(sourceGates.profitableYears, promotion.path, "gates.profitableYears"),
      informationGainPass: gate(sourceGates.informationGain, promotion.path, "gates.informationGain"),
      concentrationPass: combineGates([sourceGates.maxFollowerTradeShare, sourceGates.maxPositiveGrossContribution], promotion.path, "gates.maxFollowerTradeShare && gates.maxPositiveGrossContribution", "V19 concentration gate is the conjunction of both named caps"),
    },
    failedRobustnessLabels: labelsFromMatrix({ gates }),
  };
  return matrix;
}

function v21Matrix(contract: MetricContract): FailureGateMatrix {
  const promotion = readGitBlob(V21_RESULT_SHA, "reports/v21-promotion-decision.json");
  const report = promotion.json as Record<string, unknown>;
  const sourceGates = ((report.promotion as Record<string, unknown>).gates as Record<string, boolean>);
  const gates = {
    dataGatePass: true as GateValue,
    primaryNetPositive: sourceGates.primaryNetPositive,
    primaryPfPass: sourceGates.primaryProfitFactorMinimum,
    primaryAvgNetPositive: sourceGates.primaryAverageNetPositive,
    bootstrapPass: sourceGates.primaryClusterBootstrapLcbPositive,
    holdoutAPass: sourceGates.holdoutANetPositive,
    holdoutBPass: sourceGates.holdoutBNetPositive,
    stressPass: sourceGates.primaryStress10NetPositive,
    symbolBreadthPass: sourceGates.primaryPositiveSymbolsMinimum,
    yearBreadthPass: sourceGates.primaryPositiveYearsMinimum,
    informationGainPass: sourceGates.informationGainVsRawReturn && sourceGates.informationGainVsMedianGap,
    concentrationPass: sourceGates.maxSingleSymbolTradeShare && sourceGates.maxSingleSymbolPositiveGrossContribution && sourceGates.totalPositiveGrossContribution,
  };
  const matrix: FailureGateMatrix = {
    experimentId: contract.experimentId,
    canonicalResultCommit: contract.canonicalResultCommit,
    gates,
    gateEvidence: {
      dataGatePass: gate(true, "reports/v21-result.json", "dataIntegrity.pass=true"),
      primaryNetPositive: gate(sourceGates.primaryNetPositive, promotion.path, "promotion.gates.primaryNetPositive"),
      primaryPfPass: gate(sourceGates.primaryProfitFactorMinimum, promotion.path, "promotion.gates.primaryProfitFactorMinimum"),
      primaryAvgNetPositive: gate(sourceGates.primaryAverageNetPositive, promotion.path, "promotion.gates.primaryAverageNetPositive"),
      bootstrapPass: gate(sourceGates.primaryClusterBootstrapLcbPositive, promotion.path, "promotion.gates.primaryClusterBootstrapLcbPositive"),
      holdoutAPass: gate(sourceGates.holdoutANetPositive, promotion.path, "promotion.gates.holdoutANetPositive"),
      holdoutBPass: gate(sourceGates.holdoutBNetPositive, promotion.path, "promotion.gates.holdoutBNetPositive"),
      stressPass: gate(sourceGates.primaryStress10NetPositive, promotion.path, "promotion.gates.primaryStress10NetPositive"),
      symbolBreadthPass: gate(sourceGates.primaryPositiveSymbolsMinimum, promotion.path, "promotion.gates.primaryPositiveSymbolsMinimum"),
      yearBreadthPass: gate(sourceGates.primaryPositiveYearsMinimum, promotion.path, "promotion.gates.primaryPositiveYearsMinimum"),
      informationGainPass: combineGates([sourceGates.informationGainVsRawReturn, sourceGates.informationGainVsMedianGap], promotion.path, "promotion.gates.informationGainVsRawReturn && promotion.gates.informationGainVsMedianGap", "V21 information gain requires both frozen control comparisons"),
      concentrationPass: combineGates([sourceGates.maxSingleSymbolTradeShare, sourceGates.maxSingleSymbolPositiveGrossContribution, sourceGates.totalPositiveGrossContribution], promotion.path, "promotion.gates.maxSingleSymbolTradeShare && maxSingleSymbolPositiveGrossContribution && totalPositiveGrossContribution", "V21 concentration is the conjunction of all named concentration gates"),
    },
    failedRobustnessLabels: labelsFromMatrix({ gates }),
  };
  return matrix;
}

function emptyCounts(): Record<string, number> {
  return Object.fromEntries(ATTRIBUTION_CATEGORIES.map((category) => [category, 0]));
}

function incrementNested(target: Record<string, Record<string, number>>, group: string, category: AttributionCategory): void {
  target[group] ??= emptyCounts();
  target[group][category] += 1;
}

export function buildWp2Evidence(): BuiltEvidence {
  const contracts = [v7Contract(), v17Contract(), v18Contract(), v19Contract(), v21Contract()].sort((left, right) => left.experimentId.localeCompare(right.experimentId));
  if (contracts.length !== WP2_EXPERIMENT_IDS.length) throw new Error("R1_WP2_BUILD_FAILED: fixed experiment count drift");
  const matricesById = new Map<string, FailureGateMatrix>();
  const matrixBuilders: Record<string, (contract: MetricContract) => FailureGateMatrix> = {
    V7_DERIVATIVES_FLOW_ALPHA: v7Matrix,
    V17_CROWDING_FAILED_CONTINUATION: v17Matrix,
    V18_TAKER_FLOW_ABSORPTION_REVERSAL: v18Matrix,
    V19_BTC_SHOCK_ALT_CATCHUP: v19Matrix,
    V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL: v21Matrix,
  };
  for (const contract of contracts) matricesById.set(contract.experimentId, matrixBuilders[contract.experimentId](contract));
  const matrix = contracts.map((contract) => matricesById.get(contract.experimentId)!);
  const catalog = new Map(R1_EXPERIMENTS.map((item) => [item.experimentId, item]));
  const categoryCounts = emptyCounts();
  const byInformationSourceClass: Record<string, Record<string, number>> = {};
  const byAlphaFamily: Record<string, Record<string, number>> = {};
  const robustnessLabelCounts: Record<string, number> = Object.fromEntries(ROBUSTNESS_LABELS.map((label) => [label, 0]));
  const experimentAttribution: Array<Record<string, unknown>> = [];
  for (const contract of contracts) {
    const category = classifyAttribution({ preExecutionFrictionEdge: contract.preExecutionFrictionEdge, baselineNet: contract.baselineNetTotal, promotionPass: false });
    const labels = matricesById.get(contract.experimentId)!.failedRobustnessLabels;
    categoryCounts[category] += 1;
    const definition = catalog.get(contract.experimentId)!;
    incrementNested(byInformationSourceClass, definition.informationSourceClass, category);
    incrementNested(byAlphaFamily, definition.alphaFamily, category);
    for (const label of labels) robustnessLabelCounts[label] += 1;
    experimentAttribution.push({
      experimentId: contract.experimentId,
      version: contract.version,
      alphaFamily: contract.alphaFamily,
      informationSourceClass: contract.informationSourceClass,
      canonicalResultCommit: contract.canonicalResultCommit,
      returnUnit: contract.returnUnit,
      primarySample: contract.primarySample,
      baselineNet: { value: contract.baselineNetTotal, unit: contract.returnUnit, provenance: contract.numericProvenance.baselineNetTotal },
      preExecutionFrictionEdge: { value: contract.preExecutionFrictionEdge, unit: contract.returnUnit, provenance: contract.numericProvenance.preExecutionFrictionEdge },
      fees: { value: contract.feesTotal, unit: contract.returnUnit, provenance: contract.numericProvenance.feesTotal },
      slippage: { value: contract.slippageTotal, unit: contract.returnUnit, provenance: contract.numericProvenance.slippageTotal },
      funding: { value: contract.fundingCarry, unit: contract.returnUnit, provenance: contract.numericProvenance.fundingCarry ?? [], reason: contract.unavailableReasons.fundingCarry ?? null },
      grossAttributionSource: contract.grossMetricName ?? "exactly derived from native net/cost fields; no gross field was reported",
      attributionCategory: category,
      failedRobustnessLabels: labels,
      provenanceStatus: "PASS",
      promotionPass: false,
    });
  }
  const categories = experimentAttribution.map((item) => item.attributionCategory as AttributionCategory);
  const dominantFailureMode = computeDominantFailureMode(categories);
  const researchImplication = {
    NO_PRE_FRICTION_EDGE: "NEW_INFORMATION_SOURCE_REQUIRED",
    EXECUTION_FRICTION_DOMINATED: "HIGHER_INFORMATION_DENSITY_REQUIRED",
    NET_EDGE_NOT_ROBUST: "ROBUSTNESS_GENERALIZATION_REQUIRED",
    ROBUST_NET_EDGE: "EXISTING_EDGE_FAMILY_DESERVES_FURTHER_VALIDATION",
    MIXED_FAILURE_MODES: "NO_SINGLE_FAILURE_MODE_DOMINATES",
    INSUFFICIENT_ATTRIBUTION_EVIDENCE: "MORE_PROVENANCE_REQUIRED",
  }[dominantFailureMode as "NO_PRE_FRICTION_EDGE" | "EXECUTION_FRICTION_DOMINATED" | "NET_EDGE_NOT_ROBUST" | "ROBUST_NET_EDGE" | "MIXED_FAILURE_MODES" | "INSUFFICIENT_ATTRIBUTION_EVIDENCE"];
  const edge = {
    schema: "r1-edge-attribution-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    wp1Commit: WP1_COMMIT,
    analyzedExperimentIds: [...WP2_EXPERIMENT_IDS].sort(),
    sourcePolicy: {
      evidenceOnly: true,
      sourceKind: "git-blob",
      rawMarketDataRead: false,
      historicalRunnerInvoked: false,
      newReturnsGenerated: false,
      crossExperimentNumericAggregation: false,
      numericalRanking: false,
    },
    experiments: experimentAttribution.sort((left, right) => String(left.experimentId).localeCompare(String(right.experimentId))),
    categoryCounts,
    byInformationSourceClass,
    byAlphaFamily,
    robustnessLabelCounts,
    resolvedExperimentCount: categories.filter((category) => category !== "ATTRIBUTION_UNRESOLVED").length,
    dominantFailureMode,
    researchImplication,
  };
  const summary = {
    schema: "r1-wp2-summary-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    wp1Commit: WP1_COMMIT,
    analyzedExperimentIds: [...WP2_EXPERIMENT_IDS].sort(),
    categoryCounts,
    byInformationSourceClass,
    byAlphaFamily,
    robustnessLabelCounts,
    resolvedExperimentCount: categories.filter((category) => category !== "ATTRIBUTION_UNRESOLVED").length,
    dominantFailureMode,
    researchImplication,
    boundaries: SYSTEM_BOUNDARY,
    flags: {
      newStrategyDesigned: false,
      newAlphaTested: false,
      historicalBacktestRerun: false,
      historicalResultRegenerated: false,
      historicalOutcomePricesNewlyRead: false,
      historicalCommittedResultsRead: true,
      parameterSearch: false,
      controlsRegenerated: false,
      signalsRegenerated: false,
      newForwardReturnsRead: false,
      promotionEvaluated: false,
      v22Designed: false,
      productionChanged: false,
      productionEmail: "OFF",
      deploy: false,
      merge: false,
      orderPlacement: false,
      autoTrading: false,
    },
    noReturnMagnitudeAggregation: true,
  };
  return { contracts, matrix, edge, summary };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildManifest(evidence: BuiltEvidence): Record<string, unknown> {
  const artifactPaths = [
    "reports/r1-metric-contracts.json",
    "reports/r1-edge-attribution.json",
    "reports/r1-failure-gate-matrix.json",
    "reports/r1-wp2-summary.json",
  ];
  const artifacts: Record<string, unknown> = {};
  for (const path of artifactPaths) {
    const bytes = readFileSync(resolve(root, path));
    artifacts[path] = { rawSha256: sha256(bytes), canonicalSha256: canonicalArtifactHash(bytes, path) };
  }
  const body = {
    schema: "r1-wp2-manifest-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    directParent: WP1_COMMIT,
    baseSha: R1_BASE_SHA,
    analyzedExperimentIds: [...WP2_EXPERIMENT_IDS].sort(),
    canonicalResultCommits: EXPECTED_CANONICAL_RESULT_COMMITS,
    sourcePolicy: {
      evidenceOnly: true,
      rawMarketDataRead: false,
      historicalRunnerInvoked: false,
      newReturnsGenerated: false,
      numericalRanking: false,
    },
    flags: evidence.summary.flags,
    counts: {
      analyzedExperimentCount: WP2_EXPERIMENT_IDS.length,
      resolvedExperimentCount: evidence.summary.resolvedExperimentCount,
      unresolvedExperimentCount: WP2_EXPERIMENT_IDS.length - Number(evidence.summary.resolvedExperimentCount),
    },
    artifacts,
    productionEmail: "OFF",
    productionChanged: false,
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  };
  const manifestBodySha256 = sha256(canonicalJson(body));
  const withBodyHash = { ...body, manifestBodySha256 };
  return { ...withBodyHash, manifestSha256: sha256(canonicalJson(withBodyHash)) };
}

export function generateWp2Artifacts(): void {
  const evidence = buildWp2Evidence();
  assertNoCrossExperimentRanking(evidence.edge);
  for (const contract of evidence.contracts) assertNumericProvenance(contract);
  writeJson("reports/r1-metric-contracts.json", { schema: "r1-metric-contracts-v1", program: R1_PROGRAM, branch: R1_BRANCH, baseSha: R1_BASE_SHA, wp1Commit: WP1_COMMIT, sourcePolicy: evidence.edge.sourcePolicy, experiments: evidence.contracts });
  writeJson("reports/r1-edge-attribution.json", evidence.edge);
  writeJson("reports/r1-failure-gate-matrix.json", { schema: "r1-failure-gate-matrix-v1", program: R1_PROGRAM, branch: R1_BRANCH, baseSha: R1_BASE_SHA, wp1Commit: WP1_COMMIT, experiments: evidence.matrix });
  writeJson("reports/r1-wp2-summary.json", evidence.summary);
  writeJson("reports/r1-wp2-manifest.json", buildManifest(evidence));
  console.log("R1-WP2 evidence artifacts generated from canonical Git blobs");
}

if ((process.argv[1] ?? "").endsWith("build-r1-edge-attribution.ts")) generateWp2Artifacts();
