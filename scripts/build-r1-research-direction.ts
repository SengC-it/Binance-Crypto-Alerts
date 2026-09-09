import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { R1_BASE_SHA, R1_BRANCH, R1_PROGRAM, SYSTEM_BOUNDARY, canonicalJson, sha256 } from "./r1-catalog";

export const WP2_COMMIT = "4e8652153855701a5ab07c7745e562fdb559f836";
export const WP3_ARTIFACT_PATHS = [
  "reports/r1-exhausted-alpha-families.json",
  "reports/r1-future-research-admission.json",
  "reports/r1-alpha-research-budget.json",
  "reports/r1-wp3-decision.json",
] as const;
export const WP3_SOURCE_ARTIFACT_PATHS = [
  "reports/r1-system-boundary.json",
  "reports/r1-experiment-inventory.json",
  "reports/r1-wp2-summary.json",
  "reports/r1-edge-attribution.json",
  "reports/r1-failure-gate-matrix.json",
  "reports/r1-wp2-manifest.json",
] as const;

export const RETUNING_ONLY_DIMENSIONS = [
  "parameter_only",
  "threshold_only",
  "horizon_only",
  "universe_only",
  "math_transform_only",
  "model_only",
] as const;

export const STRUCTURAL_ORTHOGONALITY_DIMENSIONS = [
  "information_source",
  "market_mechanism",
  "economic_mechanism",
  "causal_timing",
  "cross_venue_structure",
  "derivative_state",
  "liquidity_mechanism",
] as const;

export const FUTURE_INFORMATION_SOURCE_CLASSES = [
  "LIQUIDATION_STRUCTURE",
  "OPEN_INTEREST_STATE_CHANGE",
  "OPTIONS_VOLATILITY_STRUCTURE",
  "CROSS_EXCHANGE_PRICE_DISCOVERY",
  "TERM_STRUCTURE_BASIS",
  "LIQUIDITY_WITHDRAWAL",
  "LARGE_TRADE_STRUCTURE",
  "SPOT_DERIVATIVES_FLOW_DIVERGENCE",
  "OTHER_GENUINELY_NEW_INFORMATION",
] as const;

export const ALPHA_RESEARCH_BUDGET = 3;

export type LegacyFamilyStatus =
  | "EXHAUSTED_DO_NOT_RETUNE"
  | "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"
  | "INCOMPLETE_NOT_ELIGIBLE_FOR_VARIANT_MINING";

export interface ExhaustedAlphaFamily {
  family: string;
  experimentIds: string[];
  informationSourceClass: string;
  finalStatuses: string[];
  futureStatus: LegacyFamilyStatus;
}

const family = (
  name: string,
  experimentIds: string[],
  informationSourceClass: string,
  finalStatuses: string[],
  futureStatus: LegacyFamilyStatus,
): ExhaustedAlphaFamily => ({ family: name, experimentIds, informationSourceClass, finalStatuses, futureStatus });

export const EXHAUSTED_ALPHA_FAMILIES: readonly ExhaustedAlphaFamily[] = [
  family("aggtrade absorption reversal", ["V16_AGGTRADE_ABSORPTION_REVERSAL"], "FLOW_DERIVED", ["V16_AGGTRADE_ABSORPTION_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("breakdown retest", ["V5_3_STRUCTURAL_EDGE"], "PRICE_DERIVED", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("breakout", ["V5_1_SIGNAL_EDGE", "V5_2_PROFITABILITY_VALIDATION"], "PRICE_DERIVED", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("BTC leader / low-liquidity alt follower catch-up", ["V19_BTC_SHOCK_ALT_CATCHUP"], "CROSS_MARKET", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("cross-sectional", ["V14_CROSS_SECTIONAL_REVERSAL"], "MULTI_ASSET_RELATIVE", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("cross-sectional idiosyncratic jump reversal", ["V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL"], "MULTI_ASSET_RELATIVE", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("crowded positioning failed-continuation reversal", ["V17_CROWDING_FAILED_CONTINUATION"], "DERIVATIVES_STATE", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("derivatives flow alpha", ["V7_DERIVATIVES_FLOW_ALPHA"], "FLOW_DERIVED", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("ensemble", ["V5_6_1_EVIDENCE_ENSEMBLE", "V5_9_META_LABEL_VALIDATION", "V5_9_1_EXPECTANCY_CALIBRATION"], "MIXED", ["RESULT_REJECTED", "PROCESS_INCOMPLETE"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("failed breakout", ["V5_5_FORWARD_SHADOW"], "MIXED", ["INCOMPLETE_FORWARD_EVIDENCE"], "INCOMPLETE_NOT_ELIGIBLE_FOR_VARIANT_MINING"),
  family("funding/crowding continuation/reversal", ["V7_DERIVATIVES_FLOW_ALPHA", "V17_CROWDING_FAILED_CONTINUATION"], "DERIVATIVES_STATE", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("independent long", ["V5_6_PROFITABLE_SIGNAL_YIELD"], "PRICE_DERIVED", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("LFV-001 loss-factor validation", ["LFV_001_PRODUCTION_LOSS_FACTOR_VALIDATION"], "MIXED", ["LFV_UNIVERSE_PARITY_FAIL"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("Last Price / Mark Price dislocation convergence", ["V20_LAST_MARK_DISLOCATION_CONVERGENCE"], "FAIR_VALUE_REFERENCE", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("market-neutral relative value", ["V12_MARKET_NEUTRAL_ALPHA", "V13_RELATIVE_VALUE_ALPHA"], "MULTI_ASSET_RELATIVE", ["NO_FORMAL_RESULT"], "INCOMPLETE_NOT_ELIGIBLE_FOR_VARIANT_MINING"),
  family("regime reconstruction", ["V5_8_REGIME_RECONSTRUCTION"], "MIXED", ["INCONCLUSIVE"], "INCOMPLETE_NOT_ELIGIBLE_FOR_VARIANT_MINING"),
  family("second edge data completion", ["V5_7_SECOND_EDGE_DATA_COMPLETION"], "PRICE_DERIVED", ["NO_VALID_SECOND_EDGE"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("spot-perp lead-lag", ["V15_SPOT_PERP_LEAD_LAG"], "CROSS_MARKET", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("taker-flow absorption/reversal", ["V18_TAKER_FLOW_ABSORPTION_REVERSAL"], "FLOW_DERIVED", ["RESULT_REJECTED"], "EXHAUSTED_DO_NOT_RETUNE"),
  family("trend pullback", ["V5_4_EVIDENCE_HARDENING"], "PRICE_DERIVED", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("volatility compression breakdown", ["V5_4_EVIDENCE_HARDENING"], "PRICE_DERIVED", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
  family("volatility expansion", ["V6_STRATEGY_RESET"], "PRICE_DERIVED", ["DATA_INSUFFICIENT"], "DATA_FEASIBILITY_FAILED_DO_NOT_SALVAGE"),
] as const;

export interface AdmissionCandidate {
  family: string;
  informationSourceClass: string;
  structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL" | "NOT_STRUCTURALLY_ORTHOGONAL";
  structuralDifferenceDimensions: string[];
  changedDimensions: string[];
  familyStatus?: LegacyFamilyStatus | "NEW";
}

export function normalizeFamilyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

export function findExhaustedAlphaFamily(name: string): ExhaustedAlphaFamily | undefined {
  const normalized = normalizeFamilyName(name);
  return EXHAUSTED_ALPHA_FAMILIES.find((entry) => normalizeFamilyName(entry.family) === normalized);
}

export interface LegacyRegistryCompleteness {
  inventoryExperimentIds: string[];
  registryExperimentIds: string[];
  missingIds: string[];
  unknownIds: string[];
  passes: boolean;
}

export function validateLegacyRegistryCompleteness(
  inventoryExperimentIds: readonly string[],
  families: readonly Pick<ExhaustedAlphaFamily, "experimentIds">[] = EXHAUSTED_ALPHA_FAMILIES,
): LegacyRegistryCompleteness {
  const inventory = [...new Set(inventoryExperimentIds)].sort();
  const registry = [...new Set(families.flatMap((entry) => entry.experimentIds))].sort();
  const inventorySet = new Set(inventory);
  const registrySet = new Set(registry);
  const missingIds = inventory.filter((id) => !registrySet.has(id));
  const unknownIds = registry.filter((id) => !inventorySet.has(id));
  return { inventoryExperimentIds: inventory, registryExperimentIds: registry, missingIds, unknownIds, passes: missingIds.length === 0 && unknownIds.length === 0 };
}

export function assertStructurallyOrthogonal(candidate: AdmissionCandidate): void {
  const canonicalFamily = findExhaustedAlphaFamily(candidate.family);
  if (canonicalFamily) {
    if (candidate.familyStatus !== undefined && candidate.familyStatus !== canonicalFamily.futureStatus) {
      throw new Error("RESEARCH_ADMISSION_FAIL: legacy family status is canonical and cannot be overridden");
    }
    throw new Error("RESEARCH_ADMISSION_FAIL: legacy family is not eligible for a variant");
  }
  if (candidate.familyStatus !== undefined && candidate.familyStatus !== "NEW") {
    throw new Error("RESEARCH_ADMISSION_FAIL: unknown family status is not authoritative");
  }
  if (candidate.structuralOrthogonality !== "STRUCTURALLY_ORTHOGONAL") {
    throw new Error("RESEARCH_ADMISSION_FAIL: structural orthogonality required");
  }
  if (!candidate.informationSourceClass || candidate.structuralDifferenceDimensions.length === 0) {
    throw new Error("RESEARCH_ADMISSION_FAIL: no structural information difference");
  }
  const hasStructuralDifference = candidate.structuralDifferenceDimensions.some((dimension) =>
    (STRUCTURAL_ORTHOGONALITY_DIMENSIONS as readonly string[]).includes(dimension),
  );
  if (!hasStructuralDifference || candidate.changedDimensions.every((dimension) =>
    (RETUNING_ONLY_DIMENSIONS as readonly string[]).includes(dimension),
  )) {
    throw new Error("RESEARCH_ADMISSION_FAIL: parameter or implementation variant is not a new family");
  }
}

export function assertLegacyVariantForbidden(candidate: Pick<AdmissionCandidate, "changedDimensions">): void {
  if (candidate.changedDimensions.length > 0 && candidate.changedDimensions.every((dimension) =>
    (RETUNING_ONLY_DIMENSIONS as readonly string[]).includes(dimension),
  )) {
    throw new Error("RESEARCH_ADMISSION_FAIL: retuning-only variant is forbidden");
  }
}

export interface BudgetLedger {
  totalFamilies: number;
  consumedFamilies: string[];
}

export function consumeFamilyBudget(ledger: BudgetLedger, familyId: string): BudgetLedger {
  if (ledger.consumedFamilies.includes(familyId)) {
    throw new Error("ALPHA_BUDGET_FAIL: family already consumed");
  }
  if (ledger.consumedFamilies.length >= ledger.totalFamilies) {
    throw new Error("ALPHA_BUDGET_FAIL: no orthogonal family budget remains");
  }
  return {
    totalFamilies: ledger.totalFamilies,
    consumedFamilies: [...ledger.consumedFamilies, familyId].sort(),
  };
}

export function remainingFamilyBudget(ledger: BudgetLedger): number {
  return ledger.totalFamilies - ledger.consumedFamilies.length;
}

export function shouldStopAlphaProgram(input: { failedOrthogonalFamilies: number; promotionCandidates: number; budget: number }): boolean {
  return input.promotionCandidates === 0 && input.failedOrthogonalFamilies >= input.budget;
}

export function assertPromotionIsNotProductionActivation(input: {
  promotionCandidate: boolean;
  productionEmail: string;
  productionChanged: boolean;
  deploy: boolean;
  orderPlacement: boolean;
  autoTrading: boolean;
}): void {
  if (input.promotionCandidate && (input.productionEmail !== "OFF" || input.productionChanged || input.deploy || input.orderPlacement || input.autoTrading)) {
    throw new Error("BOUNDARY_FAIL: research evidence pass cannot activate Production");
  }
}

const flags = {
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
} as const;

const programStopRule = {
  id: "ALPHA_RESEARCH_PROGRAM_STOP_RULE",
  condition: "If three structurally orthogonal families produce no Promotion Candidate, stop new alpha research.",
  alphaResearchProgramStatus: "STOP_NEW_ALPHA_RESEARCH",
  preservedCapabilities: ["market monitoring", "research archive", "signal infrastructure", "manual decision support"],
} as const;

const futureAdmission = {
  schema: "r1-future-research-admission-v1",
  program: R1_PROGRAM,
  objective: "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT",
  noSignalIsAcceptable: true,
  alertQualityPriority: ["INFORMATION_EDGE", "ROBUSTNESS", "HUMAN_ACTIONABILITY", "SIGNAL_FREQUENCY"],
  structuralOrthogonalityRule: "STRUCTURALLY_ORTHOGONAL",
  structuralOrthogonalityDimensions: STRUCTURAL_ORTHOGONALITY_DIMENSIONS,
  forbiddenVariantDimensions: RETUNING_ONLY_DIMENSIONS,
  requiredPreReturnDeclarations: [
    "expectedSignalMechanism",
    "whyInformationArrivesBeforePriceAdjustment",
    "whyNotEquivalentToLegacyFamily",
    "expectedAlertFrequencyBand",
    "humanActionability",
    "requiredPublicData",
    "dataAvailabilityRisk",
    "executionLatencySensitivity",
    "expectedHoldingMechanism",
    "frictionSensitivityRationale",
  ],
  futureInformationSourceClasses: FUTURE_INFORMATION_SOURCE_CLASSES,
  sourceClassesAreAdmissionDirectionsOnly: true,
  noSpecificStrategyDesign: true,
  noThresholdsOrParameters: true,
  noDataQuery: true,
  noBacktest: true,
  noPostResultRetune: true,
  promotionCandidateMeans: "RESEARCH_EVIDENCE_PASS_ONLY",
  productionActivationRequiresSeparateHumanApproval: true,
  lowerFrequencyIsNotFailure: true,
  minimumResearchQualityGates: [
    "pre-register hypothesis",
    "pre-register universe",
    "pre-register data source",
    "pre-register event definition",
    "pre-register direction mapping",
    "pre-register execution reference",
    "pre-register costs",
    "pre-register Primary",
    "pre-register Holdout A/B",
    "pre-register bootstrap/inference",
    "pre-register controls",
    "freeze before returns",
    "exactly-one result reveal",
    "no post-result retune",
    "independent human acceptance",
  ],
} as const;

const budget = {
  schema: "r1-alpha-research-budget-v1",
  program: R1_PROGRAM,
  unit: "STRUCTURALLY_ORTHOGONAL_ALPHA_FAMILY",
  totalFamilies: ALPHA_RESEARCH_BUDGET,
  consumedFamilies: [],
  remainingOrthogonalFamilyBudget: ALPHA_RESEARCH_BUDGET,
  sameFamilyOnlyOnce: true,
  versionsDoNotConsumeAdditionalBudget: true,
  failedFamilyIsPermanent: true,
  dataInsufficientMayNotLowerDataGate: true,
  programStopRule,
} as const;

const decision = {
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
  programStopRule,
} as const;

function canonicalArtifactHash(bytes: Buffer, path: string): string {
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return path.endsWith(".json") ? sha256(canonicalJson(JSON.parse(text) as unknown)) : sha256(text);
}

function writeJson(path: string, value: unknown): void {
  const absolute = resolve(process.cwd(), path);
  mkdirSync(resolve(process.cwd(), "reports"), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileHashes(paths: readonly string[]): Record<string, { rawSha256: string; canonicalSha256: string }> {
  return Object.fromEntries(paths.map((path) => {
    const bytes = readFileSync(resolve(process.cwd(), path));
    return [path, { rawSha256: sha256(bytes), canonicalSha256: canonicalArtifactHash(bytes, path) }];
  }));
}

function readInventoryExperimentIds(): string[] {
  const inventory = JSON.parse(readFileSync(resolve(process.cwd(), "reports/r1-experiment-inventory.json"), "utf8")) as { experiments?: Array<{ experimentId?: unknown }> };
  if (!Array.isArray(inventory.experiments)) throw new Error("r1 experiment inventory is invalid");
  return inventory.experiments.map((entry) => {
    if (typeof entry.experimentId !== "string" || entry.experimentId.length === 0) throw new Error("r1 experiment inventory has an invalid experimentId");
    return entry.experimentId;
  });
}

export function buildWp3Artifacts(): void {
  const inventoryExperimentIds = readInventoryExperimentIds();
  const completeness = validateLegacyRegistryCompleteness(inventoryExperimentIds);
  if (!completeness.passes) throw new Error(`legacy registry does not cover inventory: missing=${completeness.missingIds.join(",")} unknown=${completeness.unknownIds.join(",")}`);
  writeJson(WP3_ARTIFACT_PATHS[0], {
    schema: "r1-exhausted-alpha-families-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    source: { wp1: "reports/r1-experiment-inventory.json", wp2: "reports/r1-wp2-summary.json", wp2Commit: WP2_COMMIT },
    inventoryExperimentIds: completeness.inventoryExperimentIds,
    registryExperimentIds: completeness.registryExperimentIds,
    registryCompleteness: { missingIds: completeness.missingIds, unknownIds: completeness.unknownIds, exactSetEquality: completeness.passes },
    noNewHistoricalEvidence: true,
    families: EXHAUSTED_ALPHA_FAMILIES,
    retuningForbidden: true,
    forbiddenSalvageActions: ["change threshold", "change lookback", "change universe", "change horizon", "remove losing symbol", "remove losing year", "change percentile", "combine failed strategies lightly"],
  });
  writeJson(WP3_ARTIFACT_PATHS[1], futureAdmission);
  writeJson(WP3_ARTIFACT_PATHS[2], budget);
  writeJson(WP3_ARTIFACT_PATHS[3], decision);

  const sourceArtifacts = fileHashes(WP3_SOURCE_ARTIFACT_PATHS);
  const artifactHashes = fileHashes(WP3_ARTIFACT_PATHS);
  const body = {
    schema: "r1-wp3-manifest-v1",
    program: R1_PROGRAM,
    branch: R1_BRANCH,
    baseSha: R1_BASE_SHA,
    directParent: WP2_COMMIT,
    generatedFrom: "approved WP1/WP2 committed reports only",
    sourceArtifacts,
    artifacts: artifactHashes,
    systemBoundaryCanonicalSha256: sha256(canonicalJson(SYSTEM_BOUNDARY)),
    diagnosis: {
      NO_PRE_FRICTION_EDGE: 1,
      EXECUTION_FRICTION_DOMINATED: 3,
      NET_EDGE_NOT_ROBUST: 1,
      ROBUST_NET_EDGE: 0,
      ATTRIBUTION_UNRESOLVED: 0,
      dominantFailureMode: "EXECUTION_FRICTION_DOMINATED",
      researchImplication: "HIGHER_INFORMATION_DENSITY_REQUIRED",
    },
    contract: {
      legacyFamilyRetuningAllowed: false,
      structuralOrthogonalityRequired: true,
      researchBudgetFamilies: ALPHA_RESEARCH_BUDGET,
      programStopRule: programStopRule.id,
      v22Designed: false,
      v22Authorized: false,
    },
    flags,
  };
  const manifestBodySha256 = sha256(canonicalJson(body));
  const withBodyHash = { ...body, manifestBodySha256 };
  writeJson("reports/r1-wp3-manifest.json", { ...withBodyHash, manifestSha256: sha256(canonicalJson(withBodyHash)) });
}

if (process.argv[1]?.endsWith("build-r1-research-direction.ts")) buildWp3Artifacts();
