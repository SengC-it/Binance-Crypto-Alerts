import { createHash } from "node:crypto";

export const R1_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
export const R1_BRANCH = "research/r1-edge-attribution-audit";
export const R1_PROGRAM = "R1_CROSS_EXPERIMENT_EDGE_ATTRIBUTION_AUDIT";

export type EvidenceTruth = boolean | "unknown";
export type Taxonomy =
  | "DATA_INSUFFICIENT"
  | "RESULT_REJECTED"
  | "PROMOTION_CANDIDATE"
  | "PROCESS_INCOMPLETE"
  | "EVIDENCE_INCOMPLETE"
  | "NO_FORMAL_RESULT";

export interface EvidenceSource {
  commit: string;
  path: string;
  evidenceRole: "DATA_GATE" | "FREEZE" | "RESULT" | "PROMOTION" | "MANIFEST" | "CI_METADATA" | "PROCESS";
  sourceKind?: "git-blob" | "github-commit-metadata";
}

export interface ExperimentDefinition {
  experimentId: string;
  version: string;
  branch: string;
  branchHead: string;
  approvedEvidenceCommit: string;
  parentCommit: string | null;
  dataGate: EvidenceTruth;
  freeze: EvidenceTruth;
  historicalStrategyOutcomeReturnsRead: EvidenceTruth;
  resultCommit: string | null;
  promotionEvaluated: EvidenceTruth;
  classification: string;
  researchStop: boolean | "unknown";
  taxonomy: Taxonomy;
  alphaFamily: string;
  primaryDataSource: string;
  informationSourceClass: string;
  productionChanged: boolean | "unknown";
  deploy: boolean | "unknown";
  merge: boolean | "unknown";
  autoTrading: boolean | "unknown";
  returnComparisonEligible: boolean;
  returnComparisonExclusionReason: string | null;
  superseded?: boolean;
  knownInvalid?: boolean;
  postResultValidatorCommits?: string[];
  notes?: string;
  evidenceSources: EvidenceSource[];
}

const source = (
  commit: string,
  path: string,
  evidenceRole: EvidenceSource["evidenceRole"],
): EvidenceSource => ({ commit, path, evidenceRole, sourceKind: "git-blob" });

const commonBoundaries = {
  productionChanged: false,
  deploy: false,
  merge: false,
  autoTrading: false,
};

export const R1_EXPERIMENTS: readonly ExperimentDefinition[] = [
  {
    experimentId: "V5_1_SIGNAL_EDGE",
    version: "V5.1",
    branch: "feat/v5-signal-edge",
    branchHead: "317a681d7fe5d0eee2d9022f2c2257a4e27b9589",
    approvedEvidenceCommit: "317a681d7fe5d0eee2d9022f2c2257a4e27b9589",
    parentCommit: null,
    dataGate: false,
    freeze: false,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "317a681d7fe5d0eee2d9022f2c2257a4e27b9589",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "trend",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [source("317a681d7fe5d0eee2d9022f2c2257a4e27b9589", "reports/validation-v5-signal-edge-summary.json", "RESULT")],
  },
  {
    experimentId: "V5_2_PROFITABILITY_VALIDATION",
    version: "V5.2",
    branch: "feat/v5-2-profitability-validation",
    branchHead: "9b69efa2299157d1bf5cd334cc697d75a5af6203",
    approvedEvidenceCommit: "9b69efa2299157d1bf5cd334cc697d75a5af6203",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "9b69efa2299157d1bf5cd334cc697d75a5af6203",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "breakout",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("9b69efa2299157d1bf5cd334cc697d75a5af6203", "reports/v5-2-validation-summary.json", "RESULT"),
      source("9b69efa2299157d1bf5cd334cc697d75a5af6203", "reports/v5-2-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_3_STRUCTURAL_EDGE",
    version: "V5.3",
    branch: "feat/v5-3-structural-edge",
    branchHead: "4d880a1d226d7c62d94f73453b4b62ec808b59d9",
    approvedEvidenceCommit: "4d880a1d226d7c62d94f73453b4b62ec808b59d9",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "4d880a1d226d7c62d94f73453b4b62ec808b59d9",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "reversal",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("4d880a1d226d7c62d94f73453b4b62ec808b59d9", "reports/v5-3-executive-summary.md", "RESULT"),
      source("4d880a1d226d7c62d94f73453b4b62ec808b59d9", "reports/v5-3-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_4_EVIDENCE_HARDENING",
    version: "V5.4",
    branch: "feat/v5-4-evidence-hardening",
    branchHead: "3c66ab1e06642be0a785e59ea6df13b9da65bfdc",
    approvedEvidenceCommit: "3c66ab1e06642be0a785e59ea6df13b9da65bfdc",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "3c66ab1e06642be0a785e59ea6df13b9da65bfdc",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "reversal",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("3c66ab1e06642be0a785e59ea6df13b9da65bfdc", "reports/v5-4-pit-universe.json", "DATA_GATE"),
      source("3c66ab1e06642be0a785e59ea6df13b9da65bfdc", "reports/v5-4-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_5_FORWARD_SHADOW",
    version: "V5.5",
    branch: "feat/v5-5-forward-shadow",
    branchHead: "6033fa1095bfae6f8b2f20c70cbc543221741bc8",
    approvedEvidenceCommit: "6033fa1095bfae6f8b2f20c70cbc543221741bc8",
    parentCommit: null,
    dataGate: "unknown",
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: null,
    promotionEvaluated: false,
    classification: "INSUFFICIENT_FORWARD_EVIDENCE",
    researchStop: "unknown",
    taxonomy: "NO_FORMAL_RESULT",
    alphaFamily: "breakout",
    primaryDataSource: "regular OHLCV + prospective paper evidence",
    informationSourceClass: "MIXED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    notes: "Rollout/evidence preparation only; no comparable historical result.",
    evidenceSources: [
      source("6033fa1095bfae6f8b2f20c70cbc543221741bc8", "reports/v5-5-forward-gate.md", "DATA_GATE"),
      source("6033fa1095bfae6f8b2f20c70cbc543221741bc8", "reports/v5-5-rollout-manifest.json", "MANIFEST"),
    ],
  },
  {
    experimentId: "V5_6_PROFITABLE_SIGNAL_YIELD",
    version: "V5.6",
    branch: "feat/v5-6-profitable-signal-yield",
    branchHead: "c94ad43ab7477a9c4d770ea234137425c174821f",
    approvedEvidenceCommit: "c94ad43ab7477a9c4d770ea234137425c174821f",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "c94ad43ab7477a9c4d770ea234137425c174821f",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "reversal",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("c94ad43ab7477a9c4d770ea234137425c174821f", "reports/v5-6-executive-summary.md", "RESULT"),
      source("c94ad43ab7477a9c4d770ea234137425c174821f", "reports/v5-6-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_6_1_EVIDENCE_ENSEMBLE",
    version: "V5.6.1",
    branch: "feat/v5-6-1-evidence-ensemble",
    branchHead: "75227fc91ce0c3cc29f0ec3df1862ff38131dec4",
    approvedEvidenceCommit: "75227fc91ce0c3cc29f0ec3df1862ff38131dec4",
    parentCommit: null,
    dataGate: "unknown",
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "75227fc91ce0c3cc29f0ec3df1862ff38131dec4",
    promotionEvaluated: true,
    classification: "SHADOW_ONLY",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "ensemble",
    primaryDataSource: "regular OHLCV + production-control evidence",
    informationSourceClass: "MIXED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("75227fc91ce0c3cc29f0ec3df1862ff38131dec4", "reports/v5-6-1-executive-summary.md", "RESULT"),
      source("75227fc91ce0c3cc29f0ec3df1862ff38131dec4", "reports/v5-6-1-promotion-decision.md", "PROMOTION"),
      source("75227fc91ce0c3cc29f0ec3df1862ff38131dec4", "reports/v5-6-1-external-validation-manifest.json", "MANIFEST"),
    ],
  },
  {
    experimentId: "V5_7_SECOND_EDGE_DATA_COMPLETION",
    version: "V5.7",
    branch: "feat/v5-7-second-edge-data-completion",
    branchHead: "cc5d31e4e9984edafb7b077ef334e07a3f7391d4",
    approvedEvidenceCommit: "cc5d31e4e9984edafb7b077ef334e07a3f7391d4",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "cc5d31e4e9984edafb7b077ef334e07a3f7391d4",
    promotionEvaluated: true,
    classification: "NO_VALID_SECOND_EDGE",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "trend",
    primaryDataSource: "regular OHLCV + external archive inventory",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("cc5d31e4e9984edafb7b077ef334e07a3f7391d4", "reports/v5-7-external-data-inventory.json", "DATA_GATE"),
      source("cc5d31e4e9984edafb7b077ef334e07a3f7391d4", "reports/v5-7-validation-summary.json", "RESULT"),
      source("cc5d31e4e9984edafb7b077ef334e07a3f7391d4", "reports/v5-7-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_8_REGIME_RECONSTRUCTION",
    version: "V5.8",
    branch: "feat/v5-8-regime-reconstruction",
    branchHead: "576a6a2556da5dd184ad569ec018621ede9660a6",
    approvedEvidenceCommit: "576a6a2556da5dd184ad569ec018621ede9660a6",
    parentCommit: null,
    dataGate: "unknown",
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "576a6a2556da5dd184ad569ec018621ede9660a6",
    promotionEvaluated: true,
    classification: "INCONCLUSIVE",
    researchStop: true,
    taxonomy: "PROCESS_INCOMPLETE",
    alphaFamily: "reversal",
    primaryDataSource: "regular OHLCV + regime labels",
    informationSourceClass: "MIXED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("576a6a2556da5dd184ad569ec018621ede9660a6", "reports/v5-8-research-manifest.json", "MANIFEST"),
      source("576a6a2556da5dd184ad569ec018621ede9660a6", "reports/v5-8-validation-summary.json", "RESULT"),
      source("576a6a2556da5dd184ad569ec018621ede9660a6", "reports/v5-8-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_9_META_LABEL_VALIDATION",
    version: "V5.9",
    branch: "feat/v5-9-meta-label-validation",
    branchHead: "25f99797603b3500cd9e44bd6e3154e8d2475a0d",
    approvedEvidenceCommit: "25f99797603b3500cd9e44bd6e3154e8d2475a0d",
    parentCommit: null,
    dataGate: "unknown",
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "25f99797603b3500cd9e44bd6e3154e8d2475a0d",
    promotionEvaluated: true,
    classification: "INCONCLUSIVE",
    researchStop: true,
    taxonomy: "PROCESS_INCOMPLETE",
    alphaFamily: "ensemble",
    primaryDataSource: "regular OHLCV + probability labels",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("25f99797603b3500cd9e44bd6e3154e8d2475a0d", "reports/v5-9-research-manifest.json", "MANIFEST"),
      source("25f99797603b3500cd9e44bd6e3154e8d2475a0d", "reports/v5-9-validation-summary.json", "RESULT"),
      source("25f99797603b3500cd9e44bd6e3154e8d2475a0d", "reports/v5-9-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V5_9_1_EXPECTANCY_CALIBRATION",
    version: "V5.9.1",
    branch: "feat/v5-9-1-expectancy-calibration",
    branchHead: "4925d1b819770149a98c7014ef984fd1dba1a89c",
    approvedEvidenceCommit: "4925d1b819770149a98c7014ef984fd1dba1a89c",
    parentCommit: null,
    dataGate: "unknown",
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "4925d1b819770149a98c7014ef984fd1dba1a89c",
    promotionEvaluated: true,
    classification: "INCONCLUSIVE",
    researchStop: true,
    taxonomy: "PROCESS_INCOMPLETE",
    alphaFamily: "ensemble",
    primaryDataSource: "regular OHLCV + probability labels",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("4925d1b819770149a98c7014ef984fd1dba1a89c", "reports/v5-9-1-research-manifest.json", "MANIFEST"),
      source("4925d1b819770149a98c7014ef984fd1dba1a89c", "reports/v5-9-1-validation-summary.json", "RESULT"),
      source("4925d1b819770149a98c7014ef984fd1dba1a89c", "reports/v5-9-1-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V6_STRATEGY_RESET",
    version: "V6.0",
    branch: "feat/v6-strategy-reset",
    branchHead: "ea5c77f4ab15077953d161540574446ce66b67f6",
    approvedEvidenceCommit: "ea5c77f4ab15077953d161540574446ce66b67f6",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: "ea5c77f4ab15077953d161540574446ce66b67f6",
    promotionEvaluated: false,
    classification: "NO_VALID_V6_STRATEGY",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "other",
    primaryDataSource: "regular OHLCV",
    informationSourceClass: "PRICE_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("ea5c77f4ab15077953d161540574446ce66b67f6", "reports/v6-development-manifest.json", "MANIFEST"),
      source("ea5c77f4ab15077953d161540574446ce66b67f6", "reports/v6-validation-summary.json", "DATA_GATE"),
      source("ea5c77f4ab15077953d161540574446ce66b67f6", "reports/v6-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V7_DERIVATIVES_FLOW_ALPHA",
    version: "V7.0",
    branch: "feat/v7-derivatives-flow-alpha",
    branchHead: "33be0cf4facf62952a196caa98a2102515bd4c2f",
    approvedEvidenceCommit: "33be0cf4facf62952a196caa98a2102515bd4c2f",
    parentCommit: null,
    dataGate: true,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: true,
    resultCommit: "33be0cf4facf62952a196caa98a2102515bd4c2f",
    promotionEvaluated: true,
    classification: "NO_VALID_V7_STRATEGY",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "taker-flow",
    primaryDataSource: "aggTrades/taker flow + funding",
    informationSourceClass: "FLOW_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: true,
    returnComparisonExclusionReason: null,
    evidenceSources: [
      source("33be0cf4facf62952a196caa98a2102515bd4c2f", "reports/v7-data-feasibility.json", "DATA_GATE"),
      source("33be0cf4facf62952a196caa98a2102515bd4c2f", "reports/v7-family-results.json", "RESULT"),
      source("33be0cf4facf62952a196caa98a2102515bd4c2f", "reports/v7-promotion-decision.md", "PROMOTION"),
    ],
  },
  {
    experimentId: "V12_MARKET_NEUTRAL_ALPHA",
    version: "V12.0",
    branch: "feat/v12-market-neutral-alpha",
    branchHead: "a32ba74b3c139f9bec1647a5478124b37bfb00b9",
    approvedEvidenceCommit: "a32ba74b3c139f9bec1647a5478124b37bfb00b9",
    parentCommit: null,
    dataGate: "unknown",
    freeze: false,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: null,
    promotionEvaluated: false,
    classification: "NO_COMMITTED_RESULT",
    researchStop: "unknown",
    taxonomy: "NO_FORMAL_RESULT",
    alphaFamily: "market-neutral",
    primaryDataSource: "multi-symbol returns",
    informationSourceClass: "MULTI_ASSET_RELATIVE",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    notes: "Research runner exists; no committed R1-eligible result artifact at branch tip.",
    evidenceSources: [source("a32ba74b3c139f9bec1647a5478124b37bfb00b9", "scripts/run-v12-validation.ts", "PROCESS")],
  },
  {
    experimentId: "V13_RELATIVE_VALUE_ALPHA",
    version: "V13.0",
    branch: "feat/v13-relative-value-alpha",
    branchHead: "1f6b5e24c6e9cb5672e4c6591b303dd4e5d01487",
    approvedEvidenceCommit: "1f6b5e24c6e9cb5672e4c6591b303dd4e5d01487",
    parentCommit: null,
    dataGate: "unknown",
    freeze: false,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: null,
    promotionEvaluated: false,
    classification: "NO_COMMITTED_RESULT",
    researchStop: "unknown",
    taxonomy: "NO_FORMAL_RESULT",
    alphaFamily: "relative-value",
    primaryDataSource: "multi-symbol returns",
    informationSourceClass: "MULTI_ASSET_RELATIVE",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    notes: "Research runner exists; no committed R1-eligible result artifact at branch tip.",
    evidenceSources: [source("1f6b5e24c6e9cb5672e4c6591b303dd4e5d01487", "scripts/run-v13-validation.ts", "PROCESS")],
  },
  {
    experimentId: "V14_CROSS_SECTIONAL_REVERSAL",
    version: "V14.0",
    branch: "feat/v14-cross-sectional-reversal",
    branchHead: "f4169e034dde4652218ef6681f86fe4e9c96e800",
    approvedEvidenceCommit: "f4169e034dde4652218ef6681f86fe4e9c96e800",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "f4169e034dde4652218ef6681f86fe4e9c96e800",
    promotionEvaluated: true,
    classification: "V14_FUNDING_DATA_INSUFFICIENT",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "cross-sectional",
    primaryDataSource: "regular OHLCV + funding/mark",
    informationSourceClass: "MIXED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("f4169e034dde4652218ef6681f86fe4e9c96e800", "reports/v14-data-gate.json", "DATA_GATE"),
      source("f4169e034dde4652218ef6681f86fe4e9c96e800", "reports/v14-validation-summary.json", "RESULT"),
      source("f4169e034dde4652218ef6681f86fe4e9c96e800", "reports/v14-promotion-decision.json", "PROMOTION"),
    ],
  },
  {
    experimentId: "V15_SPOT_PERP_LEAD_LAG",
    version: "V15.0",
    branch: "feat/v15-spot-perp-lead-lag",
    branchHead: "7d9f977ffa2d25414a9a1fdcb7609c4cb842e414",
    approvedEvidenceCommit: "7d9f977ffa2d25414a9a1fdcb7609c4cb842e414",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: null,
    promotionEvaluated: false,
    classification: "V15_DATA_INSUFFICIENT_FINAL",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "spot-perp lead-lag",
    primaryDataSource: "spot+perp",
    informationSourceClass: "CROSS_MARKET",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("7d9f977ffa2d25414a9a1fdcb7609c4cb842e414", "reports/v15-data-gate-v3.json", "DATA_GATE"),
      source("7d9f977ffa2d25414a9a1fdcb7609c4cb842e414", "reports/v15-freeze-manifest.json", "FREEZE"),
      source("7d9f977ffa2d25414a9a1fdcb7609c4cb842e414", "reports/v15-promotion-decision.json", "PROMOTION"),
    ],
  },
  {
    experimentId: "V16_AGGTRADE_ABSORPTION_REVERSAL",
    version: "V16.0",
    branch: "feat/v16-aggtrade-absorption",
    branchHead: "09a89ea917cdf00f916a87f532e87f232500688f",
    approvedEvidenceCommit: "09a89ea917cdf00f916a87f532e87f232500688f",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: null,
    promotionEvaluated: false,
    classification: "V16_DATA_INSUFFICIENT_FINAL",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "taker-flow",
    primaryDataSource: "aggTrades/taker flow + funding/mark",
    informationSourceClass: "FLOW_DERIVED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("09a89ea917cdf00f916a87f532e87f232500688f", "reports/v16-data-gate-v2.json", "DATA_GATE"),
      source("09a89ea917cdf00f916a87f532e87f232500688f", "reports/v16-freeze-manifest.json", "FREEZE"),
      source("09a89ea917cdf00f916a87f532e87f232500688f", "reports/v16-promotion-decision.json", "PROMOTION"),
    ],
  },
  {
    experimentId: "V17_CROWDING_FAILED_CONTINUATION",
    version: "V17.0",
    branch: "feat/v17-crowding-failed-continuation",
    branchHead: "0b1381a6bcbf4b60e746e09ec8d614d65b1aa754",
    approvedEvidenceCommit: "0b1381a6bcbf4b60e746e09ec8d614d65b1aa754",
    parentCommit: null,
    dataGate: true,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: true,
    resultCommit: "0b1381a6bcbf4b60e746e09ec8d614d65b1aa754",
    promotionEvaluated: true,
    classification: "V17_CROWDING_FAILED_CONTINUATION_REJECTED",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "funding/crowding",
    primaryDataSource: "funding + regular OHLCV",
    informationSourceClass: "DERIVATIVES_STATE",
    ...commonBoundaries,
    returnComparisonEligible: true,
    returnComparisonExclusionReason: null,
    evidenceSources: [
      source("0b1381a6bcbf4b60e746e09ec8d614d65b1aa754", "reports/v17-data-gate-v2.json", "DATA_GATE"),
      source("0b1381a6bcbf4b60e746e09ec8d614d65b1aa754", "reports/v17-freeze-manifest.json", "FREEZE"),
      source("0b1381a6bcbf4b60e746e09ec8d614d65b1aa754", "reports/v17-validation-summary.json", "RESULT"),
      source("0b1381a6bcbf4b60e746e09ec8d614d65b1aa754", "reports/v17-promotion-decision.json", "PROMOTION"),
    ],
  },
  {
    experimentId: "V18_TAKER_FLOW_ABSORPTION_REVERSAL",
    version: "V18.0",
    branch: "feat/v18-taker-flow-absorption-reversal",
    branchHead: "b1f2341fc4aff2fc41aa679fb61f6f38d89b27e5",
    approvedEvidenceCommit: "b1f2341fc4aff2fc41aa679fb61f6f38d89b27e5",
    parentCommit: "c8b8c1e728079ce947e4b2314442a44d04d8ed90",
    dataGate: "unknown",
    freeze: "unknown",
    historicalStrategyOutcomeReturnsRead: "unknown",
    resultCommit: "b1f2341fc4aff2fc41aa679fb61f6f38d89b27e5",
    promotionEvaluated: "unknown",
    classification: "EVIDENCE_INCOMPLETE",
    researchStop: "unknown",
    taxonomy: "EVIDENCE_INCOMPLETE",
    alphaFamily: "taker-flow",
    primaryDataSource: "aggTrades/taker flow",
    informationSourceClass: "FLOW_DERIVED",
    productionChanged: "unknown",
    deploy: "unknown",
    merge: "unknown",
    autoTrading: "unknown",
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    notes: "GitHub commit metadata confirms the anchor exists; local repository lacks the object, so no classification is inferred.",
    evidenceSources: [{ commit: "b1f2341fc4aff2fc41aa679fb61f6f38d89b27e5", path: "COMMIT_METADATA:b1f2341fc4aff2fc41aa679fb61f6f38d89b27e5", evidenceRole: "CI_METADATA", sourceKind: "github-commit-metadata" }],
  },
  {
    experimentId: "V19_BTC_SHOCK_ALT_CATCHUP",
    version: "V19.0",
    branch: "feat/v19-btc-shock-alt-catchup",
    branchHead: "1f06e6c327af42da741abe8e7f7e51ad26144325",
    approvedEvidenceCommit: "1f06e6c327af42da741abe8e7f7e51ad26144325",
    parentCommit: null,
    dataGate: true,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: true,
    resultCommit: "1f06e6c327af42da741abe8e7f7e51ad26144325",
    promotionEvaluated: true,
    classification: "V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP_REJECTED",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "leader-follower",
    primaryDataSource: "regular OHLCV + funding/mark",
    informationSourceClass: "CROSS_MARKET",
    ...commonBoundaries,
    returnComparisonEligible: true,
    returnComparisonExclusionReason: null,
    evidenceSources: [
      source("1f06e6c327af42da741abe8e7f7e51ad26144325", "reports/v19-data-gate.json", "DATA_GATE"),
      source("1f06e6c327af42da741abe8e7f7e51ad26144325", "reports/v19-freeze-manifest.json", "FREEZE"),
      source("1f06e6c327af42da741abe8e7f7e51ad26144325", "reports/v19-trade-outcomes.json", "RESULT"),
      source("1f06e6c327af42da741abe8e7f7e51ad26144325", "reports/v19-promotion-decision.json", "PROMOTION"),
    ],
  },
  {
    experimentId: "V20_LAST_MARK_DISLOCATION_CONVERGENCE",
    version: "V20.0",
    branch: "feat/v20-last-mark-dislocation-convergence",
    branchHead: "8b73a64b87b3014f11f319858c4f4524ba5f5c65",
    approvedEvidenceCommit: "8b73a64b87b3014f11f319858c4f4524ba5f5c65",
    parentCommit: null,
    dataGate: false,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: null,
    promotionEvaluated: false,
    classification: "V20_FAIR_VALUE_DATA_INSUFFICIENT",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "fair-value dislocation",
    primaryDataSource: "mark/index + regular OHLCV",
    informationSourceClass: "FAIR_VALUE_REFERENCE",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "DATA_GATE_NOT_PROVEN_PASS",
    evidenceSources: [
      source("8b73a64b87b3014f11f319858c4f4524ba5f5c65", "reports/v20-data-gate.json", "DATA_GATE"),
      source("8b73a64b87b3014f11f319858c4f4524ba5f5c65", "reports/v20-freeze-manifest.json", "FREEZE"),
    ],
  },
  {
    experimentId: "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL",
    version: "V21.0",
    branch: "feat/v21-idiosyncratic-jump-reversal",
    branchHead: "0822c099eeff4f36e8d8e4865a4ed1380ae94709",
    approvedEvidenceCommit: "22f4229302d62104d3285e4b6b1b943bf9affbf2",
    parentCommit: null,
    dataGate: true,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: true,
    resultCommit: "54698f7a139cec978243cab55eb4edbd7f7ca439",
    promotionEvaluated: true,
    classification: "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL_REJECTED",
    researchStop: true,
    taxonomy: "RESULT_REJECTED",
    alphaFamily: "cross-sectional",
    primaryDataSource: "multi-symbol returns",
    informationSourceClass: "MULTI_ASSET_RELATIVE",
    ...commonBoundaries,
    returnComparisonEligible: true,
    returnComparisonExclusionReason: null,
    postResultValidatorCommits: ["180bfc2b42322eb6e42fb3a90cc2a998e1b2a2ba", "0822c099eeff4f36e8d8e4865a4ed1380ae94709"],
    evidenceSources: [
      source("22f4229302d62104d3285e4b6b1b943bf9affbf2", "reports/v21-freeze-manifest.json", "FREEZE"),
      source("54698f7a139cec978243cab55eb4edbd7f7ca439", "reports/v21-result.json", "RESULT"),
      source("54698f7a139cec978243cab55eb4edbd7f7ca439", "reports/v21-promotion-decision.json", "PROMOTION"),
      source("0822c099eeff4f36e8d8e4865a4ed1380ae94709", "reports/v21-result-stage-manifest.json", "MANIFEST"),
    ],
  },
  {
    experimentId: "LFV_001_PRODUCTION_LOSS_FACTOR_VALIDATION",
    version: "LFV-001",
    branch: "feat/lfv-001-loss-factor-validation",
    branchHead: "886cb2f429631a2a590f2ef07be03ef32bc161b4",
    approvedEvidenceCommit: "886cb2f429631a2a590f2ef07be03ef32bc161b4",
    parentCommit: null,
    dataGate: true,
    freeze: true,
    historicalStrategyOutcomeReturnsRead: false,
    resultCommit: null,
    promotionEvaluated: false,
    classification: "LFV_UNIVERSE_PARITY_FAIL",
    researchStop: true,
    taxonomy: "DATA_INSUFFICIENT",
    alphaFamily: "other",
    primaryDataSource: "regular OHLCV + live parity observations",
    informationSourceClass: "MIXED",
    ...commonBoundaries,
    returnComparisonEligible: false,
    returnComparisonExclusionReason: "HISTORICAL_OUTCOME_RETURNS_NOT_PROVEN_READ",
    evidenceSources: [
      source("886cb2f429631a2a590f2ef07be03ef32bc161b4", "reports/lfv-001-data-gate.json", "DATA_GATE"),
      source("886cb2f429631a2a590f2ef07be03ef32bc161b4", "reports/lfv-001-freeze-manifest.json", "FREEZE"),
      source("886cb2f429631a2a590f2ef07be03ef32bc161b4", "reports/lfv-001-decision.json", "PROMOTION"),
    ],
  },
];

export const SYSTEM_BOUNDARY = {
  productType: "SIGNAL_ALERT_HUMAN_DECISION_SUPPORT",
  profitObjective: "IMPROVE_SIGNAL_INFORMATION_EDGE_FOR_HUMAN_TRADING_DECISIONS",
  automaticTrading: false,
  orderPlacement: false,
  automaticEntry: false,
  automaticPositionSizing: false,
  automaticLeverage: false,
  automaticExit: false,
  automaticStopLossTakeProfit: false,
  humanDecisionRequiredFor: ["OPEN_POSITION", "POSITION_SIZE", "LEVERAGE", "EXIT_POSITION", "EXIT_TIME"],
  productionEmailDefault: "OFF",
  signalOutputsMayInclude: ["DIRECTION", "CONFIDENCE", "REASONS", "MARKET_CONTEXT", "REFERENCE_PRICE", "SIGNAL_VALIDITY"],
} as const;

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported value in canonicalJson");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ReturnEligibilityInput {
  dataGate: EvidenceTruth;
  historicalStrategyOutcomeReturnsRead: EvidenceTruth;
  resultCommit: string | null;
  executionCostContractIdentifiable: boolean;
  superseded?: boolean;
  knownInvalid?: boolean;
}

export function computeReturnComparisonEligibility(input: ReturnEligibilityInput): { eligible: boolean; reason: string | null } {
  if (input.dataGate !== true) return { eligible: false, reason: "DATA_GATE_NOT_PROVEN_PASS" };
  if (input.historicalStrategyOutcomeReturnsRead !== true) return { eligible: false, reason: "HISTORICAL_OUTCOME_RETURNS_NOT_PROVEN_READ" };
  if (!input.resultCommit) return { eligible: false, reason: "FORMAL_RESULT_MISSING" };
  if (!input.executionCostContractIdentifiable) return { eligible: false, reason: "EXECUTION_OR_COST_CONTRACT_UNIDENTIFIABLE" };
  if (input.superseded) return { eligible: false, reason: "RESULT_SUPERSEDED" };
  if (input.knownInvalid) return { eligible: false, reason: "RESULT_KNOWN_INVALID" };
  return { eligible: true, reason: null };
}

export function assertSystemBoundary(boundary: Record<string, unknown>): void {
  for (const key of ["automaticTrading", "orderPlacement", "automaticEntry", "automaticPositionSizing", "automaticLeverage", "automaticExit", "automaticStopLossTakeProfit"]) {
    if (boundary[key] !== false) throw new Error(`SYSTEM_BOUNDARY_INVALID: ${key}`);
  }
  if (boundary.productionEmailDefault !== "OFF") throw new Error("SYSTEM_BOUNDARY_INVALID: productionEmailDefault");
}

export function selectCanonicalFreezeCandidate(candidates: readonly string[]): string {
  const unique = [...new Set(candidates)].sort();
  if (unique.length !== 1) throw new Error(`FREEZE_CANDIDATE_AMBIGUOUS: ${unique.join(",")}`);
  return unique[0];
}

export function sortInventory(records: readonly ExperimentDefinition[]): ExperimentDefinition[] {
  return [...records].sort((left, right) => left.experimentId.localeCompare(right.experimentId));
}

export function isV21CanonicalResult(commit: string, resultCommit: string): boolean {
  return commit === resultCommit;
}

export function isV21PostResultValidatorCommit(commit: string): boolean {
  return ["180bfc2b42322eb6e42fb3a90cc2a998e1b2a2ba", "0822c099eeff4f36e8d8e4865a4ed1380ae94709"].includes(commit);
}
