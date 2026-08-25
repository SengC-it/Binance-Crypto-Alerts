import { z } from "zod";

const nullableNumber = z.number().finite().nullable();

export const SignalFeatureSnapshotV2Schema = z.object({
  schema: z.literal("SignalFeatureSnapshotV2"),
  signalId: z.string().min(1),
  strategyVersion: z.string().min(1),
  candidateFamily: z.string().min(1),
  timestamp: z.string().min(1),
  instrument: z.object({
    quoteVolume24h: nullableNumber,
    tickSize: nullableNumber,
    stepSize: nullableNumber,
    pricePrecision: z.number().int().nonnegative().nullable(),
    quantityPrecision: z.number().int().nonnegative().nullable(),
  }).strict(),
  snapshot: z.object({
    candleCount15m: z.number().int().nonnegative(),
    candleCount1h: z.number().int().nonnegative(),
    candleCount4h: z.number().int().nonnegative(),
    lastCandleTimestamp15m: z.string().nullable(),
    lastCandleTimestamp1h: z.string().nullable(),
    lastCandleTimestamp4h: z.string().nullable(),
  }).strict(),
  features: z.object({
    atr: nullableNumber,
    ema: nullableNumber,
    rsi: nullableNumber,
    volumeRatio: nullableNumber,
    marketRegime: z.string().nullable(),
    score: nullableNumber,
    scoreComponents: z.record(z.string(), nullableNumber),
  }).strict(),
  policy: z.object({
    entryMode: z.string().min(1),
    scoreThreshold: z.number().finite(),
    sideFilter: z.string().min(1),
    strategyFamily: z.string().min(1),
    regimeAlignment: z.string().min(1),
    stopATR: z.number().finite(),
    RR: z.number().finite(),
  }).strict(),
  sourceHashes: z.object({
    candle15m: z.string().min(1),
    candle1h: z.string().min(1),
    candle4h: z.string().min(1),
    features: z.string().min(1),
    policy: z.string().min(1),
  }).strict(),
  version: z.object({
    schemaVersion: z.literal("2"),
    producerVersion: z.string().min(1),
    featureCodeVersion: z.string().min(1),
  }).strict(),
}).strict();

export type SignalFeatureSnapshotV2 = z.infer<typeof SignalFeatureSnapshotV2Schema>;

/**
 * The serializer is intentionally allow-listed. Runtime objects may contain
 * request/config metadata, but only the research schema can leave this layer.
 * No Supabase or Production write is performed by this module.
 */
export function serializeSignalFeatureSnapshotV2(input: SignalFeatureSnapshotV2): SignalFeatureSnapshotV2 {
  const output = {
    schema: "SignalFeatureSnapshotV2" as const,
    signalId: input.signalId,
    strategyVersion: input.strategyVersion,
    candidateFamily: input.candidateFamily,
    timestamp: input.timestamp,
    instrument: {
      quoteVolume24h: input.instrument.quoteVolume24h,
      tickSize: input.instrument.tickSize,
      stepSize: input.instrument.stepSize,
      pricePrecision: input.instrument.pricePrecision,
      quantityPrecision: input.instrument.quantityPrecision,
    },
    snapshot: {
      candleCount15m: input.snapshot.candleCount15m,
      candleCount1h: input.snapshot.candleCount1h,
      candleCount4h: input.snapshot.candleCount4h,
      lastCandleTimestamp15m: input.snapshot.lastCandleTimestamp15m,
      lastCandleTimestamp1h: input.snapshot.lastCandleTimestamp1h,
      lastCandleTimestamp4h: input.snapshot.lastCandleTimestamp4h,
    },
    features: {
      atr: input.features.atr,
      ema: input.features.ema,
      rsi: input.features.rsi,
      volumeRatio: input.features.volumeRatio,
      marketRegime: input.features.marketRegime,
      score: input.features.score,
      scoreComponents: { ...input.features.scoreComponents },
    },
    policy: {
      entryMode: input.policy.entryMode,
      scoreThreshold: input.policy.scoreThreshold,
      sideFilter: input.policy.sideFilter,
      strategyFamily: input.policy.strategyFamily,
      regimeAlignment: input.policy.regimeAlignment,
      stopATR: input.policy.stopATR,
      RR: input.policy.RR,
    },
    sourceHashes: {
      candle15m: input.sourceHashes.candle15m,
      candle1h: input.sourceHashes.candle1h,
      candle4h: input.sourceHashes.candle4h,
      features: input.sourceHashes.features,
      policy: input.sourceHashes.policy,
    },
    version: {
      schemaVersion: "2" as const,
      producerVersion: input.version.producerVersion,
      featureCodeVersion: input.version.featureCodeVersion,
    },
  };
  return SignalFeatureSnapshotV2Schema.parse(output);
}
