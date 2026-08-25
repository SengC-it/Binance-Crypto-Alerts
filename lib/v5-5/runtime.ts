import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, ExecutionCandleOpen, MarketSnapshot, TradePlan } from "@/lib/core/types";
import { buildFeatureFrames, type FeatureFrame } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan, detectStructuralSignal } from "@/lib/v5-3/structural";
import { hashToUuid } from "./canonical";
import { getFrozenStrategy, V55_STRATEGY_VERSION } from "./manifest";
import {
  buildSignalFeatureSnapshot,
  V55_EXECUTION_REFERENCE_SOURCE,
  V55_EXECUTION_REFERENCE_UNAVAILABLE,
  type SignalFeatureSnapshotV2,
} from "./snapshot";

const RISK_PER_TRADE_USDT = 50;
const ASSUMED_MARGIN_USDT = 100;
const ASSUMED_LEVERAGE = 20;
const FIFTEEN_MINUTE_CLOSE_OFFSET_MS = 15 * 60 * 1000 - 1;

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
  signalCandleCloseTime: number;
  executionCandleOpenTime: number;
  executionReferencePrice: number;
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
    "15m": closedCandles(marketSnapshot.candles["15m"] ?? [], sourceTimestamp),
    "1h": closedCandles(marketSnapshot.candles["1h"] ?? [], sourceTimestamp),
    "4h": closedCandles(marketSnapshot.candles["4h"] ?? [], sourceTimestamp),
  };
  const executionReference = validExecutionReference(marketSnapshot.nextExecutionCandle, sourceTimestamp);
  const evaluation = buildLatestFrame(candles, marketSnapshot.instrument, sourceTimestamp, executionReference);
  const frame = evaluation.frame;
  const rawTrigger = frame !== null && detectStructuralSignal(frame, evaluation.candles15m, frozen.definition);
  const regimePass = frame === null ? false : passesRegime(frame);
  const tradePlan = rawTrigger && frame !== null && executionReference !== null
    ? buildRuntimeTradePlan(candles["15m"], frame, toExecutionCandle(executionReference), sourceTimestamp, frozen.definition)
    : null;
  const riskPass = tradePlan !== null;
  const beforeForwardStart = sourceTimestamp < context.forwardStartTimestamp;
  const rejectionReasons = rejectionReasonsFor({
    frame,
    rawTrigger,
    regimePass,
    riskPass,
    beforeForwardStart,
    executionReferenceAvailable: executionReference !== null,
  });
  const finalEligible = rawTrigger && riskPass && !beforeForwardStart && executionReference !== null;
  const shadowSignalId = finalEligible ? signalId : null;
  const snapshot = buildSignalFeatureSnapshot({
    snapshotId,
    scanId: context.scanId,
    signalId,
    shadowSignalId,
    scanTimestamp: context.scanTimestamp,
    sourceDataTimestamp: sourceTimestamp,
    signalCandleCloseTime: sourceTimestamp,
    executionCandleOpenTime: executionReference?.openTime ?? null,
    executionReferencePrice: executionReference?.open ?? null,
    executionReferenceSource: executionReference ? V55_EXECUTION_REFERENCE_SOURCE : V55_EXECUTION_REFERENCE_UNAVAILABLE,
    executionReferenceStatus: executionReference ? "AVAILABLE" : V55_EXECUTION_REFERENCE_UNAVAILABLE,
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
  instrument: MarketSnapshot["instrument"],
  sourceTimestamp: number,
  executionReference: ExecutionCandleOpen | null,
): { frame: FeatureFrame | null; candles15m: Candle[] } {
  const primary = candles["15m"];
  if (primary.length < 101) return { frame: null, candles15m: primary };
  const last = primary.at(-1)!;
  // The boundary candle only lets the shared feature builder evaluate the last
  // closed signal frame. It is never an execution reference or a trade input.
  const boundaryCandle: Candle = executionReference
    ? {
      openTime: executionReference.openTime,
      open: executionReference.open,
      high: executionReference.open,
      low: executionReference.open,
      close: executionReference.open,
      volume: 0,
      closeTime: executionReference.openTime + FIFTEEN_MINUTE_CLOSE_OFFSET_MS,
    }
    : {
      openTime: last.closeTime + 1,
      open: last.open,
      high: last.open,
      low: last.open,
      close: last.open,
      volume: 0,
      closeTime: last.closeTime + 1 + FIFTEEN_MINUTE_CLOSE_OFFSET_MS,
    };
  const candles15m = [...primary, boundaryCandle];
  const dataset: HistoricalDataset = {
    symbol: instrument.symbol,
    instrument,
    candles: {
      "15m": candles15m,
      "1h": candles["1h"],
      "4h": candles["4h"],
    },
  };
  const frames = buildFeatureFrames(dataset, {
    startTime: sourceTimestamp,
    endTime: sourceTimestamp,
    entryStrideBars: 1,
  });
  return { frame: frames.find((candidate) => candidate.signalTimestamp === sourceTimestamp) ?? null, candles15m };
}

function buildRuntimeTradePlan(
  candles: Candle[],
  frame: FeatureFrame,
  nextEntryCandle: Candle,
  signalCandleCloseTime: number,
  definition: ReturnType<typeof getFrozenStrategy>["definition"],
): V55TradePlan | null {
  const structuralPlan = buildStructuralPlan(candles, frame, nextEntryCandle, definition);
  if (!structuralPlan || !Number.isFinite(structuralPlan.riskPrice) || structuralPlan.riskPrice <= 0) return null;
  const entryPrice = nextEntryCandle.open;
  const quantity = RISK_PER_TRADE_USDT / structuralPlan.riskPrice;
  return {
    entryReference: entryPrice,
    sourceTimestamp: signalCandleCloseTime,
    signalCandleCloseTime,
    executionCandleOpenTime: nextEntryCandle.openTime,
    executionReferencePrice: entryPrice,
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
    validUntil: nextEntryCandle.openTime + definition.expectedHoldingHorizonHours * 60 * 60 * 1000,
  };
}

function closedCandles(candles: Candle[], sourceTimestamp: number): Candle[] {
  return candles.filter((candle) => candle.closeTime <= sourceTimestamp);
}

function validExecutionReference(
  executionCandle: ExecutionCandleOpen | null | undefined,
  signalCandleCloseTime: number,
): ExecutionCandleOpen | null {
  if (!executionCandle || executionCandle.openTime !== signalCandleCloseTime + 1) return null;
  if (!Number.isFinite(executionCandle.open) || executionCandle.open <= 0) return null;
  return executionCandle;
}

function toExecutionCandle(executionReference: ExecutionCandleOpen): Candle {
  return {
    openTime: executionReference.openTime,
    open: executionReference.open,
    high: executionReference.open,
    low: executionReference.open,
    close: executionReference.open,
    volume: 0,
    closeTime: executionReference.openTime + FIFTEEN_MINUTE_CLOSE_OFFSET_MS,
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
  executionReferenceAvailable: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.frame) reasons.push("INSUFFICIENT_FEATURE_HISTORY");
  if (!input.rawTrigger) reasons.push("RAW_TRIGGER_FALSE");
  if (input.frame && !input.regimePass) reasons.push("REGIME_REJECTED");
  if (input.rawTrigger && !input.riskPass) reasons.push("INVALID_RISK_PLAN");
  if (input.beforeForwardStart) reasons.push("BEFORE_FORWARD_START");
  if (!input.executionReferenceAvailable) reasons.push(V55_EXECUTION_REFERENCE_UNAVAILABLE);
  return reasons;
}

export function v55StrategyVersion(): string {
  return V55_STRATEGY_VERSION;
}
