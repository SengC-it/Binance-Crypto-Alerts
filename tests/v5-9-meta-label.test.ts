import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessCalibration,
  hasValidExecutionProvenance,
  runUntouchedValidation,
  type V59CandidateEvent,
  type V59LabeledSample,
  type V59NestedResult,
} from "@/lib/v5-9/meta-label";
import {
  V59_CORE_FEATURE_NAMES,
  V59_EVENT_REGISTRY,
  V59_MODEL_CONFIGS,
  V59_RISK_TEMPLATES,
  V59_UNTOUCHED_SYMBOLS,
} from "@/lib/v5-9/registry";

const DAY_MS = 86_400_000;

function sample(input: { symbol?: string; signalTimestamp?: number; rMultiple?: number; label?: "POSITIVE" | "NEGATIVE" }): V59LabeledSample {
  const signalTimestamp = input.signalTimestamp ?? Date.UTC(2023, 0, 1);
  const symbol = input.symbol ?? "TESTUSDT";
  const rMultiple = input.rMultiple ?? 1;
  return {
    symbol,
    side: "SHORT",
    entryTime: signalTimestamp + 1,
    exitTime: signalTimestamp + 15 * 60_000,
    rMultiple,
    netPnlUsdt: rMultiple * 50,
    pnlUsdt: rMultiple * 50,
    theoreticalRiskUsdt: 50,
    feesUsdt: 0,
    fundingUsdt: 0,
    slippageUsdt: 0,
    marketRegime: "BEAR",
    eventId: `${symbol}|${signalTimestamp}`,
    family: "FAILED_BREAKOUT_LIQUIDITY_REJECTION",
    templateId: V59_RISK_TEMPLATES[0].id,
    signalTimestamp,
    signalIndex: 100,
    signalCandleCloseTime: signalTimestamp,
    executionCandleOpenTime: signalTimestamp + 1,
    executionReferencePrice: 100,
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
    entryPrice: 100,
    exitPrice: 99,
    stopPrice: 101,
    targetPrice: 98.5,
    riskPrice: 1,
    label: input.label ?? (rMultiple > 0 ? "POSITIVE" : "NEGATIVE"),
    highQuality: rMultiple >= 0.5,
    features: Array.from({ length: V59_CORE_FEATURE_NAMES.length }, () => 0.1),
  };
}

function nestedResult(): V59NestedResult {
  return {
    folds: [],
    predictions: [],
    alerts: [],
    metrics: {} as V59NestedResult["metrics"],
    plus10Bps: {} as V59NestedResult["plus10Bps"],
    positiveFoldRatio: null,
    foldMetrics: [],
    selectedConfig: V59_MODEL_CONFIGS[0],
    selectedTemplate: V59_RISK_TEMPLATES[0],
    selectionAdjustedLcb: null,
    promotionLcb: null,
    thresholdEvaluations: [],
    calibration: { status: "INCONCLUSIVE", buckets: [], monotonicExpectancy: null },
  };
}

describe("V5.9 frozen meta-label registry", () => {
  it("keeps the event, model, risk, feature, and untouched-symbol registries bounded", () => {
    expect(V59_EVENT_REGISTRY).toHaveLength(5);
    expect(V59_RISK_TEMPLATES).toHaveLength(3);
    expect(V59_MODEL_CONFIGS).toHaveLength(6);
    expect(V59_CORE_FEATURE_NAMES).toHaveLength(12);
    expect(new Set(V59_UNTOUCHED_SYMBOLS).size).toBeGreaterThanOrEqual(15);

    const seenSymbols = (JSON.parse(readFileSync(resolve(process.cwd(), "data/validation-universe-50.json"), "utf8")) as { symbols: string[] }).symbols;
    expect(V59_UNTOUCHED_SYMBOLS.every((symbol) => !seenSymbols.includes(symbol))).toBe(true);
  });

  it("requires a real contiguous next-bar execution reference", () => {
    const valid = sample({});
    expect(hasValidExecutionProvenance([valid])).toBe(true);
    expect(hasValidExecutionProvenance([{ ...valid, executionCandleOpenTime: valid.signalCandleCloseTime }])).toBe(false);
    expect(hasValidExecutionProvenance([{ ...valid, executionReferenceSource: "SIGNAL_CLOSE" as V59LabeledSample["executionReferenceSource"] }])).toBe(false);
  });

  it("reports calibration only when at least two populated probability buckets are monotonic", () => {
    const predictions = [
      ...Array.from({ length: 5 }, (_, index) => ({ sample: sample({ symbol: `LOW${index}USDT`, rMultiple: 0.1 }), probability: 0.52, alert: false, outerFold: "fold-1", configId: V59_MODEL_CONFIGS[0].id, templateId: V59_RISK_TEMPLATES[0].id })),
      ...Array.from({ length: 5 }, (_, index) => ({ sample: sample({ symbol: `HIGH${index}USDT`, rMultiple: 0.6 }), probability: 0.57, alert: true, outerFold: "fold-1", configId: V59_MODEL_CONFIGS[0].id, templateId: V59_RISK_TEMPLATES[0].id })),
    ];
    expect(assessCalibration(predictions).status).toBe("PASS");
  });

  it("keeps an under-sized untouched holdout inconclusive", () => {
    const outcomes = Array.from({ length: 9 }, (_, index) => sample({ symbol: `HOLDOUT${index}USDT`, signalTimestamp: Date.UTC(2023, 0, 1) + index * DAY_MS }));
    const result = runUntouchedValidation(
      [{ eventId: "frozen-event" } as V59CandidateEvent],
      outcomes,
      Array.from({ length: 10 }, (_, index) => sample({ symbol: `DEV${index}USDT`, signalTimestamp: Date.UTC(2020, 0, 1) + index * DAY_MS })),
      nestedResult(),
      [],
      [],
    );
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.gate.signals).toBe(false);
  });

  it("can pass the untouched gate only with the frozen minimum evidence", () => {
    const outcomes = Array.from({ length: 50 }, (_, index) => sample({ symbol: `HOLDOUT${index % 10}USDT`, signalTimestamp: Date.UTC(2023, 0, 1) + index * DAY_MS }));
    const result = runUntouchedValidation(
      [{ eventId: "frozen-event" } as V59CandidateEvent],
      outcomes,
      Array.from({ length: 10 }, (_, index) => sample({ symbol: `DEV${index}USDT`, signalTimestamp: Date.UTC(2020, 0, 1) + index * DAY_MS })),
      nestedResult(),
      [],
      [],
    );
    expect(result.status).toBe("PASS");
    expect(result.alerts).toHaveLength(50);
    expect(Object.values(result.gate).every(Boolean)).toBe(true);
  });
});
