import {
  V53_CANDIDATE_REGISTRY,
  type StructuralCandidateDefinition,
  type StructuralParameters,
} from "@/lib/v5-3/structural";
import { canonicalJson, sha256 } from "./canonical";

export const V55_STRATEGY_ID = "SHORT-FAILED_BREAKOUT_SHORT-02";
export const V55_STRATEGY_VERSION = "failed-breakout-short-02-shadow-v1";
export const V55_FORWARD_EXPERIMENT_ID = "v55-fbos02-forward-001";
export const V55_SCHEMA_VERSION = "v5.5a";
export const V55_PRODUCTION_EMAIL_ALLOWED = false;

const EXPECTED_PARAMETERS: StructuralParameters = {
  breakoutLookback: 20,
  volumeRatioMin: 1.35,
  retestDistanceATR: 0.6,
  maxExtensionATR: 0.8,
  pullbackMinATR: 0.35,
  pullbackMaxATR: 1.6,
  trendAgeMinBars: 16,
  compressionBarsMin: 8,
  compressionRangeMaxATR: 4.5,
  expansionVolumeMin: 1.25,
  expansionVolatilityMin: 1.15,
  stopATRMultiplier: 1.25,
  structureLookback: 8,
};

export interface V55StrategyManifest {
  schemaVersion: string;
  strategyId: string;
  strategyVersion: string;
  side: "SHORT";
  family: "FAILED_BREAKOUT_SHORT";
  variant: number;
  hypothesis: string;
  marketMechanism: string;
  expectedRegime: string;
  featureDefinitions: string[];
  entryLogic: string;
  exitLogic: string;
  maxHoldHours: number;
  stopStyle: StructuralCandidateDefinition["stopStyle"];
  rewardRisk: number;
  parameters: StructuralParameters;
  costAssumptions: {
    takerFeeRate: number;
    slippageBps: number;
    riskPerTradeUsdt: number;
    assumedMarginUsdt: number;
    assumedLeverage: number;
    cooldownHours: number;
    fundingInput: string;
  };
}

export interface FrozenStrategy {
  definition: StructuralCandidateDefinition;
  manifest: V55StrategyManifest;
  manifestHash: string;
}

const FEATURE_DEFINITIONS = [
  "15m ATR(14) and ATR percentile",
  "15m EMA(20) and EMA(50)",
  "15m RSI(14)",
  "15m volume ratio over 20 candles",
  "20-candle upside breakout level",
  "failed-breakout state: attempted break, two closes below level, lower high",
  "short entry extension in ATR units",
  "15m/1h/4h market regime plus BTC/ETH regime when available",
];

export function getFrozenStrategy(): FrozenStrategy {
  const definition = V53_CANDIDATE_REGISTRY.find((item) => item.id === V55_STRATEGY_ID);
  if (!definition) throw new Error(`Frozen V5.5 candidate is missing: ${V55_STRATEGY_ID}`);
  assertDefinitionIsFrozen(definition);

  const manifest: V55StrategyManifest = {
    schemaVersion: V55_SCHEMA_VERSION,
    strategyId: definition.id,
    strategyVersion: V55_STRATEGY_VERSION,
    side: "SHORT",
    family: "FAILED_BREAKOUT_SHORT",
    variant: definition.variant,
    hypothesis: definition.hypothesis,
    marketMechanism: definition.marketMechanism,
    expectedRegime: definition.expectedRegime,
    featureDefinitions: FEATURE_DEFINITIONS,
    entryLogic: definition.entryLogic,
    exitLogic: `${definition.invalidationLogic}; ${definition.stopStyle} stop; ${definition.rewardRisk}R take-profit; time limit ${definition.expectedHoldingHorizonHours}h.`,
    maxHoldHours: definition.expectedHoldingHorizonHours,
    stopStyle: definition.stopStyle,
    rewardRisk: definition.rewardRisk,
    parameters: { ...definition.parameters },
    costAssumptions: {
      takerFeeRate: 0.0004,
      slippageBps: 2,
      riskPerTradeUsdt: 50,
      assumedMarginUsdt: 100,
      assumedLeverage: 20,
      cooldownHours: 8,
      fundingInput: "public Binance futures funding-rate endpoint when available",
    },
  };

  return { definition, manifest, manifestHash: sha256(canonicalJson(manifest)) };
}

export function assertDefinitionIsFrozen(definition: StructuralCandidateDefinition): void {
  if (definition.side !== "SHORT" || definition.family !== "FAILED_BREAKOUT_SHORT" || definition.variant !== 2) {
    throw new Error("V5.5 frozen candidate drifted in side, family, or variant");
  }
  if (canonicalJson(definition.parameters) !== canonicalJson(EXPECTED_PARAMETERS)) {
    throw new Error("V5.5 frozen candidate parameters drifted");
  }
  if (definition.stopStyle !== "STRUCTURE" || definition.rewardRisk !== 1.8 || definition.expectedHoldingHorizonHours !== 48) {
    throw new Error("V5.5 frozen candidate exit policy drifted");
  }
}

export function expectedFrozenParameters(): StructuralParameters {
  return { ...EXPECTED_PARAMETERS };
}
