import { z } from "zod";
import type { FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import type { Instrument, Side } from "@/lib/core/types";
import { canonicalJson, sha256 } from "./canonical";
import { V55_STRATEGY_VERSION } from "./manifest";

const nullableNumber = z.number().finite().nullable();
const nullableString = z.string().nullable();

export const V55_EXECUTION_REFERENCE_SOURCE = "BINANCE_15M_NEXT_BAR_OPEN" as const;
export const V55_EXECUTION_REFERENCE_UNAVAILABLE = "EXECUTION_REFERENCE_UNAVAILABLE" as const;
export type V55ExecutionReferenceSource = typeof V55_EXECUTION_REFERENCE_SOURCE | typeof V55_EXECUTION_REFERENCE_UNAVAILABLE;
export type V55ExecutionReferenceStatus = "AVAILABLE" | typeof V55_EXECUTION_REFERENCE_UNAVAILABLE;

export const SignalFeatureSnapshotV2Schema = z.object({
  schema: z.literal("SignalFeatureSnapshotV2"),
  schemaVersion: z.literal("2"),
  snapshotId: z.string().min(1),
  scanId: z.string().min(1),
  signalId: nullableString,
  shadowSignalId: nullableString,
  scanTimestamp: z.string().min(1),
  sourceDataTimestamp: z.string().min(1),
  signalCandleCloseTime: z.string().min(1),
  executionCandleOpenTime: nullableString,
  executionReferencePrice: nullableNumber,
  executionReferenceSource: z.enum([V55_EXECUTION_REFERENCE_SOURCE, V55_EXECUTION_REFERENCE_UNAVAILABLE]),
  executionReferenceStatus: z.enum(["AVAILABLE", V55_EXECUTION_REFERENCE_UNAVAILABLE]),
  closeTime15m: nullableString,
  closeTime1h: nullableString,
  closeTime4h: nullableString,
  strategy: z.object({
    strategyId: z.string().min(1),
    strategyVersion: z.literal(V55_STRATEGY_VERSION),
    manifestHash: z.string().length(64),
    candidateFamily: z.literal("FAILED_BREAKOUT_SHORT"),
    side: z.literal("SHORT"),
  }).strict(),
  instrument: z.object({
    symbol: z.string().min(1),
    quoteVolume24h: nullableNumber,
    contractStatus: z.string().min(1),
    quoteAsset: z.string().min(1),
    contractType: z.string().min(1),
    tickSize: nullableNumber,
    stepSize: nullableNumber,
    minQty: nullableNumber,
    minNotional: nullableNumber,
    pricePrecision: z.number().int().nonnegative().nullable(),
    quantityPrecision: z.number().int().nonnegative().nullable(),
  }).strict(),
  candleProvenance: z.object({
    count15m: z.number().int().nonnegative(),
    count1h: z.number().int().nonnegative(),
    count4h: z.number().int().nonnegative(),
    firstTimestamp15m: nullableString,
    lastTimestamp15m: nullableString,
    firstTimestamp1h: nullableString,
    lastTimestamp1h: nullableString,
    firstTimestamp4h: nullableString,
    lastTimestamp4h: nullableString,
    hash15m: z.string().length(64),
    hash1h: z.string().length(64),
    hash4h: z.string().length(64),
  }).strict(),
  features: z.object({
    atr: nullableNumber,
    atrPercentile: nullableNumber,
    emaFast: nullableNumber,
    emaSlow: nullableNumber,
    emaDistance: nullableNumber,
    rsi: nullableNumber,
    volumeRatio: nullableNumber,
    breakoutLevel: nullableNumber,
    failedBreakoutState: z.string().min(1),
    entryExtensionATR: nullableNumber,
    marketRegime: nullableString,
    btcRegime: nullableString,
    ethRegime: nullableString,
    breadth: nullableNumber,
  }).strict(),
  score: z.object({
    finalScore: nullableNumber,
    scoreComponents: z.record(z.string(), nullableNumber),
  }).strict(),
  decision: z.object({
    rawTrigger: z.boolean(),
    scorePass: z.boolean(),
    sidePass: z.boolean(),
    familyPass: z.boolean(),
    regimePass: z.boolean(),
    entryIntervalPass: z.boolean(),
    riskPass: z.boolean(),
    finalEligible: z.boolean(),
    rejectionReasons: z.array(z.string()),
  }).strict(),
  tradePlan: z.object({
    entryReference: nullableNumber,
    entryPrice: nullableNumber,
    stopPrice: nullableNumber,
    takeProfitPrice: nullableNumber,
    rewardRisk: nullableNumber,
    maxHoldUntil: nullableString,
  }).strict().nullable(),
  cost: z.object({
    feeRate: z.number().finite(),
    slippageBps: z.number().finite(),
    fundingInput: nullableNumber,
  }).strict(),
  provenance: z.object({
    runtimeCommitSha: z.string().min(1),
    strategyManifestHash: z.string().length(64),
    universeSnapshotHash: z.string().length(64),
    snapshotHash: z.string().length(64),
  }).strict(),
}).strict();

export type SignalFeatureSnapshotV2 = z.infer<typeof SignalFeatureSnapshotV2Schema>;

export function buildSignalFeatureSnapshot(input: {
  snapshotId: string;
  scanId: string;
  signalId: string;
  shadowSignalId: string | null;
  scanTimestamp: number;
  sourceDataTimestamp: number;
  signalCandleCloseTime: number;
  executionCandleOpenTime: number | null;
  executionReferencePrice: number | null;
  executionReferenceSource: V55ExecutionReferenceSource;
  executionReferenceStatus: V55ExecutionReferenceStatus;
  strategyId: string;
  manifestHash: string;
  instrument: Instrument;
  frame: FeatureFrame | null;
  candles: { "15m": import("@/lib/core/types").Candle[]; "1h": import("@/lib/core/types").Candle[]; "4h": import("@/lib/core/types").Candle[] };
  decision: SignalFeatureSnapshotV2["decision"];
  tradePlan: SignalFeatureSnapshotV2["tradePlan"];
  runtimeCommitSha: string;
  universeSnapshotHash: string;
  fundingInput?: number | null;
}): SignalFeatureSnapshotV2 {
  const body = {
    schema: "SignalFeatureSnapshotV2" as const,
    schemaVersion: "2" as const,
    snapshotId: input.snapshotId,
    scanId: input.scanId,
    signalId: input.signalId,
    shadowSignalId: input.shadowSignalId,
    scanTimestamp: new Date(input.scanTimestamp).toISOString(),
    sourceDataTimestamp: new Date(input.sourceDataTimestamp).toISOString(),
    signalCandleCloseTime: new Date(input.signalCandleCloseTime).toISOString(),
    executionCandleOpenTime: timestampOf(input.executionCandleOpenTime ?? undefined),
    executionReferencePrice: input.executionReferencePrice,
    executionReferenceSource: input.executionReferenceSource,
    executionReferenceStatus: input.executionReferenceStatus,
    closeTime15m: timestampOf(input.candles["15m"].at(-1)?.closeTime),
    closeTime1h: timestampOf(input.candles["1h"].at(-1)?.closeTime),
    closeTime4h: timestampOf(input.candles["4h"].at(-1)?.closeTime),
    strategy: {
      strategyId: input.strategyId,
      strategyVersion: V55_STRATEGY_VERSION as typeof V55_STRATEGY_VERSION,
      manifestHash: input.manifestHash,
      candidateFamily: "FAILED_BREAKOUT_SHORT" as const,
      side: "SHORT" as const,
    },
    instrument: {
      symbol: input.instrument.symbol,
      quoteVolume24h: input.instrument.quoteVolume24h ?? null,
      contractStatus: input.instrument.status,
      quoteAsset: input.instrument.quoteAsset,
      contractType: input.instrument.contractType,
      tickSize: input.instrument.priceTick ?? null,
      stepSize: input.instrument.quantityStep ?? null,
      minQty: input.instrument.minQuantity ?? null,
      minNotional: input.instrument.minNotional ?? null,
      pricePrecision: input.instrument.pricePrecision ?? null,
      quantityPrecision: input.instrument.quantityPrecision ?? null,
    },
    candleProvenance: {
      count15m: input.candles["15m"].length,
      count1h: input.candles["1h"].length,
      count4h: input.candles["4h"].length,
      firstTimestamp15m: timestampOf(input.candles["15m"][0]?.closeTime),
      lastTimestamp15m: timestampOf(input.candles["15m"].at(-1)?.closeTime),
      firstTimestamp1h: timestampOf(input.candles["1h"][0]?.closeTime),
      lastTimestamp1h: timestampOf(input.candles["1h"].at(-1)?.closeTime),
      firstTimestamp4h: timestampOf(input.candles["4h"][0]?.closeTime),
      lastTimestamp4h: timestampOf(input.candles["4h"].at(-1)?.closeTime),
      hash15m: sha256(input.candles["15m"]),
      hash1h: sha256(input.candles["1h"]),
      hash4h: sha256(input.candles["4h"]),
    },
    features: featureValues(input.frame),
    score: {
      finalScore: null,
      scoreComponents: featureScoreComponents(input.frame),
    },
    decision: input.decision,
    tradePlan: input.tradePlan,
    cost: {
      feeRate: 0.0004,
      slippageBps: 2,
      fundingInput: input.fundingInput ?? null,
    },
    provenance: {
      runtimeCommitSha: input.runtimeCommitSha,
      strategyManifestHash: input.manifestHash,
      universeSnapshotHash: input.universeSnapshotHash,
      snapshotHash: "pending",
    },
  };
  const snapshotHash = sha256(canonicalJson(body));
  return SignalFeatureSnapshotV2Schema.parse({
    ...body,
    provenance: { ...body.provenance, snapshotHash },
  });
}

export function serializeSignalFeatureSnapshotV2(input: SignalFeatureSnapshotV2): SignalFeatureSnapshotV2 {
  const output = {
    schema: "SignalFeatureSnapshotV2" as const,
    schemaVersion: "2" as const,
    snapshotId: input.snapshotId,
    scanId: input.scanId,
    signalId: input.signalId,
    shadowSignalId: input.shadowSignalId,
    scanTimestamp: input.scanTimestamp,
    sourceDataTimestamp: input.sourceDataTimestamp,
    signalCandleCloseTime: input.signalCandleCloseTime,
    executionCandleOpenTime: input.executionCandleOpenTime,
    executionReferencePrice: input.executionReferencePrice,
    executionReferenceSource: input.executionReferenceSource,
    executionReferenceStatus: input.executionReferenceStatus,
    closeTime15m: input.closeTime15m,
    closeTime1h: input.closeTime1h,
    closeTime4h: input.closeTime4h,
    strategy: { ...input.strategy },
    instrument: { ...input.instrument },
    candleProvenance: { ...input.candleProvenance },
    features: { ...input.features },
    score: { finalScore: input.score.finalScore, scoreComponents: { ...input.score.scoreComponents } },
    decision: { ...input.decision, rejectionReasons: [...input.decision.rejectionReasons] },
    tradePlan: input.tradePlan ? { ...input.tradePlan } : null,
    cost: { ...input.cost },
    provenance: { ...input.provenance },
  };
  return SignalFeatureSnapshotV2Schema.parse(output);
}

function featureValues(frame: FeatureFrame | null): SignalFeatureSnapshotV2["features"] {
  return {
    atr: frame?.atr ?? null,
    atrPercentile: frame?.atrPercentile ?? null,
    emaFast: frame?.emaFast ?? null,
    emaSlow: frame?.emaSlow ?? null,
    emaDistance: frame?.shortDistanceToEMA ?? null,
    rsi: frame?.rsi ?? null,
    volumeRatio: frame?.volumeRatio ?? null,
    breakoutLevel: frame?.breakoutHigh20 ?? null,
    failedBreakoutState: frame ? "EVALUATED" : "INSUFFICIENT_DATA",
    entryExtensionATR: frame?.shortEntryExtensionATR ?? null,
    marketRegime: frame?.marketRegime ?? null,
    btcRegime: frame?.btcRegime ?? null,
    ethRegime: frame?.ethRegime ?? null,
    breadth: frame?.breadth ?? null,
  };
}

function featureScoreComponents(frame: FeatureFrame | null): Record<string, number | null> {
  return {
    atr: frame?.atr ?? null,
    atrPercentile: frame?.atrPercentile ?? null,
    volumeRatio: frame?.volumeRatio ?? null,
    rsi: frame?.rsi ?? null,
    momentumAcceleration: frame?.momentumAcceleration ?? null,
    entryExtensionATR: frame?.shortEntryExtensionATR ?? null,
    trendAge: frame?.bearTrendAge ?? null,
  };
}

function timestampOf(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

export type V55SnapshotSide = Side;
