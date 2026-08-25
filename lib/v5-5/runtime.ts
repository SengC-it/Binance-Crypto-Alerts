import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, MarketSnapshot, TradePlan } from "@/lib/core/types";
import { buildFeatureFrames, type FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan, detectStructuralSignal } from "@/lib/v5-3/structural";
import { hashToUuid } from "./canonical";
import { getFrozenStrategy, V55_STRATEGY_VERSION } from "./manifest";
import { buildSignalFeatureSnapshot, type SignalFeatureSnapshotV2 } from "./snapshot";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const RISK_PER_TRADE_USDT = 50;
const ASSUMED_MARGIN_USDT = 100;
const ASSUMED_LEVERAGE = 20;

export interface V55RuntimeContext {
  scanId: string;
  scanGroupKey: string;
  scanTimestamp: number;
  forwardStartTimestamp: number;
  experimentId: string;
  runtimeCommitSha: string;
  strategyManifestHash: string;
  universeSnapshotHash: string;
  universeSnapshotId?: string;
}

export interface V55TradePlan extends TradePlan {
  entryReference: number;
  sourceTimestamp: number;
  riskPrice: number;
}

export interface V55Evaluation {
  snapshot: SignalFeatureSnapshotV2;
  shadowSignalId: string | null;
  tradePlan: V55TradePlan | null;
  finalEligible: boolean;
}

export function evaluateV55Snapshot(
  marketSnapshot: MarketSnapshot,
  context: V55RuntimeContext,
): V55Evaluation {
  const frozen = getFrozenStrategy();
  const sourceTimestamp = marketSnapshot.sourceTimestamp;
  const signalId = `v55:${context.experimentId}:${marketSnapshot.instrument.symbol}:${sourceTimestamp}`;
  const snapshotId = hashToUuid(`${context.scanId}|${marketSnapshot.instrument.symbol}|${sourceTimestamp}|${frozen.manifestHash}`);
  const candles = {
    "15m": marketSnapshot.candles["15m"] ?? [],
    "1h": marketSnapshot.candles["1h"] ?? [],
    "4h": marketSnapshot.candles["4h"] ?? [],
  };
  const evaluation = buildLatestFrame(candles, marketSnapshot);
  const frame = evaluation.frame;
  const rawTrigger = frame !== null && detectStructuralSignal(frame, evaluation.candles15m, frozen.definition);
  const regimePass = frame === null ? false : passesRegime(frame);
  const tradePlan = rawTrigger && frame !== null
    ? buildRuntimeTradePlan(evaluation.candles15m, frame, frozen.definition)
    : null;
  const riskPass = tradePlan !== null;
  const beforeForwardStart = sourceTimestamp < context.forwardStartTimestamp;
  const rejectionReasons = rejectionReasonsFor({
    frame,
    rawTrigger,
    regimePass,
    riskPass,
    beforeForwardStart,
  });
  const finalEligible = rawTrigger && riskPass && !beforeForwardStart;
  const shadowSignalId = finalEligible ? signalId : null;
  const snapshot = buildSignalFeatureSnapshot({
    snapshotId,
    scanId: context.scanId,
    signalId,
    shadowSignalId,
    scanTimestamp: context.scanTimestamp,
    sourceDataTimestamp: sourceTimestamp,
    strategyId: frozen.manifest.strategyId,
    manifestHash: frozen.manifestHash,
    instrument: marketSnapshot.instrument,
    frame,
    candles,
    decision: {
      rawTrigger,
      scorePass: true,
      sidePass: frozen.definition.side === "SHORT",
      familyPass: frozen.definition.family === "FAILED_BREAKOUT_SHORT",
      regimePass,
      entryIntervalPass: true,
      riskPass,
      finalEligible,
      rejectionReasons,
    },
    tradePlan: tradePlan ? {
      entryReference: tradePlan.entryReference,
      entryPrice: tradePlan.entryPrice,
      stopPrice: tradePlan.stopPrice,
      takeProfitPrice: tradePlan.takeProfitPrice,
      rewardRisk: tradePlan.rewardRisk,
      maxHoldUntil: new Date(tradePlan.validUntil).toISOString(),
    } : null,
    runtimeCommitSha: context.runtimeCommitSha,
    universeSnapshotHash: context.universeSnapshotHash,
  });
  return { snapshot, shadowSignalId, tradePlan, finalEligible };
}

function buildLatestFrame(
  candles: { "15m": Candle[]; "1h": Candle[]; "4h": Candle[] },
  marketSnapshot: MarketSnapshot,
): { frame: FeatureFrame | null; candles15m: Candle[] } {
  const primary = candles["15m"];
  if (primary.length < 101) return { frame: null, candles15m: primary };
  const last = primary.at(-1)!;
  const syntheticNext: Candle = {
    openTime: last.closeTime + 1,
    open: last.close,
    high: last.close,
    low: last.close,
    close: last.close,
    volume: 0,
    closeTime: last.closeTime + FIFTEEN_MINUTES_MS,
  };
  const candles15m = [...primary, syntheticNext];
  const dataset: HistoricalDataset = {
    symbol: marketSnapshot.instrument.symbol,
    instrument: marketSnapshot.instrument,
    candles: {
      "15m": candles15m,
      "1h": candles["1h"],
      "4h": candles["4h"],
    },
  };
  const frames = buildFeatureFrames(dataset, {
    startTime: marketSnapshot.sourceTimestamp,
    endTime: marketSnapshot.sourceTimestamp,
    entryStrideBars: 1,
  });
  return { frame: frames.at(-1) ?? null, candles15m };
}

function buildRuntimeTradePlan(
  candles: Candle[],
  frame: FeatureFrame,
  definition: ReturnType<typeof getFrozenStrategy>["definition"],
): V55TradePlan | null {
  const current = candles[frame.index];
  if (!current) return null;
  const structuralPlan = buildStructuralPlan(candles, frame, {
    ...current,
    open: current.close,
    high: current.close,
    low: current.close,
    close: current.close,
  }, definition);
  if (!structuralPlan || !Number.isFinite(structuralPlan.riskPrice) || structuralPlan.riskPrice <= 0) return null;
  const entryPrice = current.close;
  const quantity = RISK_PER_TRADE_USDT / structuralPlan.riskPrice;
  return {
    entryReference: entryPrice,
    sourceTimestamp: current.closeTime,
    riskPrice: structuralPlan.riskPrice,
    entryPrice,
    stopPrice: structuralPlan.stopPrice,
    takeProfitPrice: structuralPlan.targetPrice,
    rewardRisk: definition.rewardRisk,
    assumedMarginUsdt: ASSUMED_MARGIN_USDT,
    assumedLeverage: ASSUMED_LEVERAGE,
    positionNotionalUsdt: entryPrice * quantity,
    quantity,
    theoreticalRiskUsdt: RISK_PER_TRADE_USDT,
    riskOverSingleCap: false,
    validUntil: current.closeTime + definition.expectedHoldingHorizonHours * 60 * 60 * 1000,
  };
}

function passesRegime(frame: FeatureFrame): boolean {
  const benchmarkRegimes = [frame.btcRegime, frame.ethRegime].filter((regime) => regime !== "UNKNOWN");
  const alignedBenchmark = benchmarkRegimes.length === 0 || benchmarkRegimes.every((regime) => regime === "BEAR");
  const breadthAligned = frame.breadth === null || frame.breadth <= 0.65;
  return alignedBenchmark && breadthAligned;
}

function rejectionReasonsFor(input: {
  frame: FeatureFrame | null;
  rawTrigger: boolean;
  regimePass: boolean;
  riskPass: boolean;
  beforeForwardStart: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.frame) reasons.push("INSUFFICIENT_FEATURE_HISTORY");
  if (!input.rawTrigger) reasons.push("RAW_TRIGGER_FALSE");
  if (input.frame && !input.regimePass) reasons.push("REGIME_REJECTED");
  if (input.rawTrigger && !input.riskPass) reasons.push("INVALID_RISK_PLAN");
  if (input.beforeForwardStart) reasons.push("BEFORE_FORWARD_START");
  return reasons;
}

export function v55StrategyVersion(): string {
  return V55_STRATEGY_VERSION;
}
