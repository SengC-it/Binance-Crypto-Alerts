import { describe, expect, it } from "vitest";
import {
  buildBaseRateDiagnostics,
  buildEvCalibration,
  buildProbabilityDiagnostics,
  deriveTrainingPayoff,
  expectedNetR,
  selectBestEvConfig,
  type V59LabeledSample,
  type V591Prediction,
} from "@/lib/v5-9-1/meta-label";
import {
  V591_CORE_FEATURE_NAMES,
  V591_EVENT_REGISTRY,
  V591_MODEL_CONFIGS,
  V591_RISK_TEMPLATES,
  V591_THEORETICAL_BREAKEVEN,
} from "@/lib/v5-9-1/registry";

function sample(input: { symbol?: string; signalTimestamp?: number; rMultiple?: number; templateId?: string; family?: V59LabeledSample["family"] }): V59LabeledSample {
  const signalTimestamp = input.signalTimestamp ?? Date.UTC(2023, 0, 1);
  const rMultiple = input.rMultiple ?? 0.5;
  const templateId = input.templateId ?? V591_RISK_TEMPLATES[0].id;
  return {
    symbol: input.symbol ?? "TESTUSDT",
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
    eventId: `${input.symbol ?? "TESTUSDT"}|${signalTimestamp}|${templateId}`,
    family: input.family ?? "FAILED_BREAKOUT_LIQUIDITY_REJECTION",
    templateId,
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
    label: rMultiple > 0 ? "POSITIVE" : "NEGATIVE",
    highQuality: rMultiple >= 0.5,
    features: Array.from({ length: V591_CORE_FEATURE_NAMES.length }, () => 0.1),
  };
}

function prediction(input: { estimatedEV: number; rMultiple: number; symbol?: string }): V591Prediction {
  return {
    sample: sample({ symbol: input.symbol, rMultiple: input.rMultiple }),
    probability: 0.5,
    estimatedEV: input.estimatedEV,
    avgWinR: 1,
    avgLossR: -1,
    alert: input.estimatedEV > 0.05,
    outerFold: "fold-1",
    configId: V591_MODEL_CONFIGS[0].id,
    templateId: V591_RISK_TEMPLATES[0].id,
  };
}

describe("V5.9.1 expectancy-calibrated meta-label rule", () => {
  it("keeps the frozen architecture and six finite EV configurations", () => {
    expect(V591_EVENT_REGISTRY).toHaveLength(5);
    expect(V591_RISK_TEMPLATES).toHaveLength(3);
    expect(V591_MODEL_CONFIGS).toHaveLength(6);
    expect(new Set(V591_MODEL_CONFIGS.map((config) => config.evThresholdR))).toEqual(new Set([0.05, 0.1, 0.15]));
    expect(V591_MODEL_CONFIGS.every((config) => !("probabilityThreshold" in config))).toBe(true);
    expect(V591_CORE_FEATURE_NAMES).toHaveLength(12);
  });

  it("uses template payoff in the expected-net-R formula and preserves theoretical checks", () => {
    expect(expectedNetR(0.5, 1.5, -1)).toBe(0.25);
    expect(V591_THEORETICAL_BREAKEVEN.map((row) => row.beforeCostsProbability)).toEqual([0.4, 1 / 2.8, 1 / 3]);
    const payoff = deriveTrainingPayoff([
      sample({ rMultiple: 1.5 }),
      sample({ rMultiple: -1 }),
    ], V591_RISK_TEMPLATES[0].id);
    expect(payoff).toEqual({ avgWinR: 1.5, avgLossR: -1, wins: 1, losses: 1 });
  });

  it("returns no selected model when every inner validation configuration has zero alerts", () => {
    const rows = Array.from({ length: 96 }, (_, index) => sample({
      symbol: `ZERO${index % 4}USDT`,
      signalTimestamp: Date.UTC(2020, index, 1),
      rMultiple: index % 2 === 0 ? 0.01 : -0.01,
    }));
    expect(selectBestEvConfig(rows)).toBeNull();
  });

  it("reports the complete probability distribution and all eight buckets", () => {
    const probabilities = [0.1, 0.27, 0.32, 0.37, 0.42, 0.47, 0.52, 0.56];
    const diagnostic = buildProbabilityDiagnostics(
      probabilities.map((probability, index) => ({ probability, sample: sample({ symbol: `P${index}USDT`, rMultiple: index % 2 === 0 ? 0.5 : -0.5 }) })),
      "fold-1",
      V591_MODEL_CONFIGS[0].id,
      V591_RISK_TEMPLATES[0].id,
    );
    expect(diagnostic.buckets.map((bucket) => bucket.bucket)).toEqual(["<0.25", "0.25-0.30", "0.30-0.35", "0.35-0.40", "0.40-0.45", "0.45-0.50", "0.50-0.55", ">0.55"]);
    expect(diagnostic.buckets.map((bucket) => bucket.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(diagnostic.distribution.min).toBe(0.1);
    expect(diagnostic.distribution.max).toBe(0.56);
    expect(diagnostic.distribution.p95).toBe(0.56);
  });

  it("checks realized expectancy in predicted-EV buckets", () => {
    const monotonic = [
      ...Array.from({ length: 5 }, (_, index) => prediction({ estimatedEV: 0.02, rMultiple: 0.1, symbol: `LOW${index}USDT` })),
      ...Array.from({ length: 5 }, (_, index) => prediction({ estimatedEV: 0.3, rMultiple: 0.6, symbol: `HIGH${index}USDT` })),
    ];
    expect(buildEvCalibration(monotonic)).toMatchObject({ status: "PASS", failureCode: null, monotonicExpectancy: true });
    const inverted = [
      ...Array.from({ length: 5 }, (_, index) => prediction({ estimatedEV: 0.02, rMultiple: 0.6, symbol: `BADLOW${index}USDT` })),
      ...Array.from({ length: 5 }, (_, index) => prediction({ estimatedEV: 0.3, rMultiple: 0.1, symbol: `BADHIGH${index}USDT` })),
    ];
    expect(buildEvCalibration(inverted)).toMatchObject({ status: "FAIL", failureCode: "EV_CALIBRATION_FAIL", monotonicExpectancy: false });
  });

  it("reports training base rates separately by risk template and event family", () => {
    const rows = [
      sample({ rMultiple: 1, templateId: V591_RISK_TEMPLATES[0].id }),
      sample({ rMultiple: -1, templateId: V591_RISK_TEMPLATES[0].id }),
      sample({ rMultiple: 0.5, templateId: V591_RISK_TEMPLATES[1].id, family: "SUPPORT_BREAKDOWN_RETEST" }),
    ];
    const result = buildBaseRateDiagnostics(rows);
    expect(result.byRiskTemplate).toHaveLength(3);
    expect(result.byRiskTemplate[0]).toMatchObject({ events: 2, wins: 1, losses: 1, netR: 0 });
    expect(result.byEventFamily.find((row) => row.id === "SUPPORT_BREAKDOWN_RETEST")).toMatchObject({ events: 1, wins: 1 });
  });
});

