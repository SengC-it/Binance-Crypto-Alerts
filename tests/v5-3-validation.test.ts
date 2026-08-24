import { describe, expect, it } from "vitest";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, Instrument, MarketSnapshot, ScoredCandidate } from "@/lib/core/types";
import { DEFAULT_STRATEGY_PARAMS } from "@/lib/core/strategies";
import { evaluateProductionSignal } from "@/lib/core/production-signal";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";
import {
  buildPerturbationSummary,
  candidateFamilies,
  extensionBucket,
  removeTopTrades,
  selectionAdjustedLowerConfidenceBound,
  summarizeExtensionBuckets,
  trueEquityDrawdown,
  V53_CANDIDATE_REGISTRY,
  evaluateV53PromotionGate,
  type StructuralTrade,
} from "@/lib/v5-3/structural";
import {
  buildCostStressMetrics,
} from "@/lib/v5-2/validation";
import {
  classifyQuantizationMismatch,
  compareControlConfigParity,
  deduplicateCanonicalTrades,
  finalizeParityReport,
  hashCanonicalRows,
  readActualProductionRuntimeConfig,
  readProductionPaperTradeExport,
  replayProductionPaperTrade,
  serializeAllowlistedConfig,
  type ProductionControlConfig,
  type ProductionPaperTradeRow,
  type ProductionReplayResult,
  type ProductionSignalTelemetry,
} from "@/lib/v5-3/production-parity";
import { calculateMetrics, createFrozenHoldoutWindow, createPurgedWalkForwardFolds } from "@/lib/v5-2/validation";

function candle(index: number, close: number): Candle {
  const openTime = index * 15 * 60 * 1000;
  return { openTime, closeTime: openTime + 15 * 60 * 1000 - 1, open: close, high: close + 1, low: close - 1, close, volume: 100 + index };
}

function dataset(count = 240): HistoricalDataset {
  const candles = Array.from({ length: count }, (_, index) => candle(index, 100 + Math.sin(index / 8) * 3 + index * 0.02));
  const instrument: Instrument = {
    symbol: "TESTUSDT",
    baseAsset: "TEST",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    priceTick: 0.01,
    quantityStep: 0.001,
  };
  return { symbol: "TESTUSDT", instrument, candles: { "15m": candles } };
}

function descendingDataset(count = 240): HistoricalDataset {
  const base = dataset(count);
  const candles = base.candles["15m"].map((row, index) => {
    const close = 300 - index * 0.8;
    return { ...row, open: close + 0.2, high: close + 0.8, low: close - 0.8, close };
  });
  const instrument = { ...base.instrument, quoteVolume24h: 1_000_000_000 };
  return { ...base, instrument, candles: { "15m": candles, "1h": candles, "4h": candles } };
}

function snapshotFor(data: HistoricalDataset): MarketSnapshot {
  const primary = data.candles["15m"];
  return {
    instrument: data.instrument,
    tickerPrice: primary.at(-1)!.close,
    candles: data.candles,
    sourceTimestamp: primary.at(-1)!.closeTime,
  };
}

function telemetryFor(candidate: ScoredCandidate, timestamp: number, inputProvenance?: ProductionSignalTelemetry["inputProvenance"]): ProductionSignalTelemetry {
  return {
    signalId: "signal-1",
    sourceDataTimestamp: new Date(timestamp).toISOString(),
    score: candidate.score,
    scoreComponents: candidate.scoreComponents,
    marketRegime: candidate.marketRegime,
    side: candidate.side,
    strategyFamily: candidate.strategyFamily,
    primaryTimeframe: candidate.primaryTimeframe,
    confirmationTimeframes: candidate.confirmationTimeframes,
    regimeDependency: candidate.regimeDependency,
    entryPrice: candidate.entryPrice,
    stopPrice: null,
    takeProfitPrice: null,
    validUntil: null,
    inputProvenance,
  };
}

function trade(index: number, rMultiple: number, symbol = "TESTUSDT"): StructuralTrade {
  return {
    symbol,
    side: "LONG",
    entryTime: index * 60 * 60 * 1000,
    exitTime: (index + 1) * 60 * 60 * 1000,
    rMultiple,
    netPnlUsdt: rMultiple * 50,
    pnlUsdt: rMultiple * 50,
    theoreticalRiskUsdt: 50,
    candidateId: "TEST",
    family: "TREND_PULLBACK_LONG",
    stopStyle: "HYBRID",
    entryPrice: 100,
    exitPrice: 100 + rMultiple,
    entryExtensionATR: 0.2,
    mfeR: Math.max(0, rMultiple),
    maeR: Math.max(0, -rMultiple),
    timeToMfeHours: 1,
    timeToMaeHours: 1,
    hitHalfRBeforeStop: rMultiple > 0.5,
    hitOneRBeforeStop: rMultiple > 1,
    exitReason: rMultiple > 0 ? "TAKE_PROFIT" : "STOP",
    delayedEntryBars: 0,
  };
}

function paperRow(overrides: Partial<ProductionPaperTradeRow> = {}): ProductionPaperTradeRow {
  return {
    id: "paper-1",
    signalId: null,
    symbol: "TESTUSDT",
    side: "SHORT",
    strategyFamily: "TREND",
    strategyVersion: "trend-rejection-short-v1",
    entryTime: new Date(1_000).toISOString(),
    entryPrice: 100,
    entryFillPrice: 100,
    stopPrice: 101,
    takeProfitPrice: 98,
    maxHoldUntil: new Date(72 * 60 * 60 * 1000).toISOString(),
    quantity: 1,
    theoreticalRiskUsdt: 1,
    exitTime: new Date(2_000).toISOString(),
    exitPrice: 99,
    exitReason: "STOP_LOSS",
    rMultiple: -1,
    netPnlUsdt: -1,
    feesUsdt: 0,
    fundingUsdt: 0,
    slippageUsdt: 0,
    metadata: {},
    signalTelemetry: null,
    ...overrides,
  };
}

function replayConfig(minimumScore = 101): ProductionControlConfig {
  const signalPolicy = {
    strategyParams: DEFAULT_STRATEGY_PARAMS,
    minimumScore,
    sideFilter: "SHORT" as const,
    strategyFamily: "TREND" as const,
    requireRegimeAlignment: false,
    entryIntervalHours: 0,
    marginUsdt: 100,
    leverage: 20,
    singleSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    maxHoldHours: 72,
    rewardRisk: 2,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 2_000,
    takerFeeRate: 0.0004,
    slippageBps: 2,
    maxExecutionCostRiskFraction: 1,
  };
  return {
    source: "resolved_runtime_config",
    strategyVersion: "trend-rejection-short-v1",
    entryMode: "TREND_REJECTION",
    params: DEFAULT_STRATEGY_PARAMS,
    options: { minScore: minimumScore, sideFilter: "SHORT", strategyFamilies: ["TREND"] },
    signalPolicy,
    replayExpectedConfig: {} as ProductionControlConfig["replayExpectedConfig"],
  };
}

describe("V5.3 registry and isolation", () => {
  it("keeps three families and a finite preregistered search space per direction", () => {
    expect(candidateFamilies("LONG")).toHaveLength(3);
    expect(candidateFamilies("SHORT")).toHaveLength(3);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "LONG")).toHaveLength(9);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "SHORT")).toHaveLength(9);
    for (const family of candidateFamilies("LONG").concat(candidateFamilies("SHORT"))) {
      expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.family === family).length).toBeLessThanOrEqual(5);
    }
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "LONG").every((candidate) => candidate.family.includes("LONG") || candidate.family === "BREAKOUT_RETEST_V2")).toBe(true);
    expect(V53_CANDIDATE_REGISTRY.filter((candidate) => candidate.side === "SHORT").every((candidate) => candidate.family.includes("SHORT") || candidate.family === "FAILED_BREAKOUT_SHORT")).toBe(true);
  });

  it("creates purged outer folds and excludes the frozen holdout from selection", () => {
    const start = Date.UTC(2020, 0, 1);
    const end = Date.UTC(2024, 0, 1);
    const folds = createPurgedWalkForwardFolds({ start, end, initialTrainMonths: 12, validationMonths: 3, foldCount: 6, purgeHours: 72 });
    const holdout = createFrozenHoldoutWindow(end, folds, 72);
    expect(folds).toHaveLength(6);
    expect(folds.every((fold) => fold.purgeEnd - fold.purgeStart + 1 >= 72 * 60 * 60 * 1000)).toBe(true);
    expect(holdout).not.toBeNull();
    expect(folds.every((fold) => fold.validationEnd < (holdout?.start ?? Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe("V5.3 entry-time features", () => {
  it("does not change an earlier feature frame when future candles change", () => {
    const original = dataset();
    const changed = dataset();
    changed.candles["15m"].forEach((row, index) => {
      if (index > 180) row.close += 10_000;
    });
    const first = buildFeatureFrames(original, { entryStrideBars: 4 });
    const second = buildFeatureFrames(changed, { entryStrideBars: 4 });
    const target = first.findIndex((frame) => frame.index < 180);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(second[target].signalTimestamp).toBe(first[target].signalTimestamp);
    expect(second[target].close).toBe(first[target].close);
    expect(second[target].atr).toBe(first[target].atr);
    expect(second[target].longEntryExtensionATR).toBe(first[target].longEntryExtensionATR);
  });
});

describe("V5.3 confidence and robustness", () => {
  it("reports naive and selection-adjusted block-bootstrap confidence", () => {
    const series = [
      { candidateId: "A", values: [0.2, 0.1, 0.3, -0.1, 0.2, 0.1, 0.05] },
      { candidateId: "B", values: [0.3, 0.25, 0.4, -0.2, 0.25, 0.2, 0.1] },
      { candidateId: "C", values: [-0.1, 0.05, 0.01, 0.02, -0.03, 0.04, 0.02] },
    ];
    const adjusted = selectionAdjustedLowerConfidenceBound(series, "B", 200, 3);
    expect(adjusted).not.toBeNull();
    expect(Number.isFinite(adjusted!)).toBe(true);
  });

  it("keeps extension buckets and stop-path evidence without post-hoc deletion", () => {
    const rows = [trade(1, 1), { ...trade(2, -1), entryExtensionATR: 0.8 }, { ...trade(3, 0.2), entryExtensionATR: 1.2 }];
    expect(extensionBucket(0.2)).toBe("<=0.25");
    expect(extensionBucket(0.8)).toBe("0.75-1.0");
    expect(extensionBucket(1.2)).toBe(">1.0");
    expect(summarizeExtensionBuckets(rows)).toHaveLength(6);
    expect(rows).toHaveLength(3);
  });

  it("tests delayed/cost/parameter and top-trade robustness metrics", () => {
    const rows = [trade(1, 1.5), trade(2, 0.4), trade(3, -0.3), trade(4, 0.2), trade(5, 0.1)];
    const base = calculateMetrics(rows);
    const removed = calculateMetrics(removeTopTrades(rows, 3));
    const perturbations = buildPerturbationSummary(base, [
      { label: "-10%", metrics: calculateMetrics(rows.map((row) => ({ ...row, rMultiple: row.rMultiple - 0.01 }))) },
      { label: "+10%", metrics: calculateMetrics(rows.map((row) => ({ ...row, rMultiple: row.rMultiple + 0.01 }))) },
    ]);
    expect(removed.trades).toBe(2);
    expect(perturbations).toHaveLength(2);
    expect(base.trades).toBe(5);
  });

  it("reports true equity drawdown and concentration inputs", () => {
    const rows = [trade(1, 1, "A"), trade(2, -2, "B"), trade(3, 0.5, "C")];
    const drawdown = trueEquityDrawdown(rows);
    expect(drawdown.maxDrawdownUsdt).toBeGreaterThan(0);
    expect(drawdown.finalEquityUsdt).toBeLessThan(10_000);
    expect(calculateMetrics(rows).topSymbolProfitShare).not.toBeNull();
  });
});

describe("V5.3 fixed-candidate attribution and parity audit", () => {
  it("keeps nested selector OOS separate from fixed final-candidate OOS", () => {
    const nested = [trade(1, 1), { ...trade(2, -0.5), candidateId: "OTHER" }];
    const fixed = deduplicateCanonicalTrades(nested.filter((row) => row.candidateId === "TEST"), "TEST");
    expect(calculateMetrics(nested).trades).toBe(2);
    expect(calculateMetrics(fixed.uniqueTrades).trades).toBe(1);
    expect(calculateMetrics(nested).avgNetR).not.toBe(calculateMetrics(fixed.uniqueTrades).avgNetR);
    expect(fixed.uniqueTrades[0].candidateId).toBe("TEST");
  });

  it("deduplicates the same trade across Core/Broad and holdout windows", () => {
    const coreTrade = trade(10, 0.8, "BTCUSDT");
    const broadTrade = { ...coreTrade };
    const holdoutTrade = { ...coreTrade };
    const coreBroad = deduplicateCanonicalTrades([coreTrade, broadTrade], "SHORT-FAILED_BREAKOUT_SHORT-02");
    const holdout = deduplicateCanonicalTrades([coreTrade, holdoutTrade], "SHORT-FAILED_BREAKOUT_SHORT-02");
    expect(coreBroad.rawTradeCount).toBe(2);
    expect(coreBroad.uniqueTradeCount).toBe(1);
    expect(coreBroad.duplicateTradeCount).toBe(1);
    expect(holdout.uniqueTradeCount).toBe(1);
    expect(holdout.duplicateTradeCount).toBe(1);
  });

  it("uses fixed-candidate OOS identity for stress and remove-top3 inputs", () => {
    const fixed = [trade(1, 1.5), trade(2, 0.4), trade(3, -0.3)];
    const audit = deduplicateCanonicalTrades(fixed, "FIXED");
    const stressed = audit.uniqueTrades.map((row) => ({ ...row, rMultiple: row.rMultiple - 0.1 }));
    expect(calculateMetrics(stressed).trades).toBe(audit.uniqueTradeCount);
    expect(removeTopTrades(audit.uniqueTrades, 3)).toHaveLength(0);
    expect(audit.uniqueTrades.every((row) => row.candidateId === "TEST")).toBe(true);
  });

  it("detects control configuration drift and marks parity mismatch unreliable", () => {
    const configParity = compareControlConfigParity(
      { strategyVersion: "trend-rejection-short-v1", scoreThreshold: 65 },
      { strategyVersion: "trend-rejection-short-v1", scoreThreshold: 70 },
    );
    expect(configParity.status).toBe("FAIL");
    const mismatch = {
      id: "paper-1",
      signalId: null,
      symbol: "BTCUSDT",
      sourceTimestamp: null,
      status: "MATERIAL_MISMATCH",
      reasons: ["score threshold drift"],
      dataUnavailable: [],
      replay: {},
    } as unknown as ProductionReplayResult;
    const report = finalizeParityReport([], [mismatch], configParity, null);
    expect(report.verdict).toBe("FAIL");
    expect(report.failureClassification).toBe("MODEL_PARITY_FAILURE");
    expect(report.historicalControlReliable).toBe(false);
  });

  it("evaluates the raw trigger before score threshold and keeps score failure separate", () => {
    const data = descendingDataset();
    const evaluation = evaluateProductionSignal(snapshotFor(data), replayConfig(101).signalPolicy);

    expect(evaluation.rawCandidates.length).toBeGreaterThan(0);
    expect(evaluation.stages.rawStrategyTrigger).toBe("PASS");
    expect(evaluation.stages.score).toBe("FAIL");
    expect(evaluation.status).toBe("NO_SIGNAL_CANDIDATE");
    expect(evaluation.reason).toContain("score threshold");
  });

  it("does not turn unavailable historical quoteVolume24h into a material mismatch", () => {
    const data = descendingDataset();
    const sourceTimestamp = data.candles["15m"].at(-1)!.closeTime;
    const evaluation = evaluateProductionSignal(snapshotFor(data), replayConfig(0).signalPolicy);
    const candidate = evaluation.scoredCandidates.find((item) => item.side === "SHORT" && item.strategyFamily === "TREND");
    expect(candidate).toBeDefined();
    const row = paperRow({
      id: "liquidity-input-row",
      symbol: data.symbol,
      entryTime: new Date(sourceTimestamp).toISOString(),
      metadata: { source_data_timestamp: new Date(sourceTimestamp).toISOString() },
      signalTelemetry: telemetryFor(candidate!, sourceTimestamp),
    });

    const replay = replayProductionPaperTrade(row, data, replayConfig(0));

    expect(replay.status).toBe("INPUT_DATA_UNAVAILABLE");
    expect(replay.reasons).toHaveLength(0);
    expect(replay.inputProvenance.productionLiquidity).toBe(candidate!.scoreComponents.liquidity);
    expect(replay.inputProvenance.replayLiquidity).toBeNull();
    expect(replay.inputProvenance.pointInTimeLiquidityAvailable).toBe(false);
    expect(replay.inputProvenance.source).toContain("quoteVolume24h");
    expect(replay.inputProvenance.dataQualityComparison).toBe("DATA_UNAVAILABLE");
    expect(replay.trace.score.replayValue).toMatchObject({ status: "DATA_UNAVAILABLE" });
    expect(replay.trace.scoreComponents.replayValue).toMatchObject({ components: { liquidity: "DATA_UNAVAILABLE" } });
    expect(replay.dataUnavailable.join(" ")).toContain("point-in-time quoteVolume24h");
  });

  it("requires identical known inputs before classifying a score difference as material", () => {
    const data = descendingDataset();
    const sourceTimestamp = data.candles["15m"].at(-1)!.closeTime;
    const evaluation = evaluateProductionSignal(snapshotFor(data), replayConfig(0).signalPolicy);
    const candidate = evaluation.scoredCandidates.find((item) => item.side === "SHORT" && item.strategyFamily === "TREND");
    expect(candidate).toBeDefined();
    const row = paperRow({
      id: "known-input-score-row",
      symbol: data.symbol,
      entryTime: new Date(sourceTimestamp).toISOString(),
      metadata: { source_data_timestamp: new Date(sourceTimestamp).toISOString() },
      signalTelemetry: {
        ...telemetryFor(candidate!, sourceTimestamp, {
          quoteVolume24h: data.instrument.quoteVolume24h!,
          candleCounts: { "15m": 240, "1h": 240, "4h": 240 },
          rawCandlesAvailable: true,
          source: "immutable Production snapshot export",
        }),
        score: candidate!.score + 5,
      },
    });

    const replay = replayProductionPaperTrade(row, data, replayConfig(0));

    expect(replay.inputProvenance.pointInTimeLiquidityAvailable).toBe(true);
    expect(replay.inputProvenance.dataQualityComparison).toBe("PASS");
    expect(replay.status).toBe("MATERIAL_MISMATCH");
    expect(replay.reasons.some((reason) => reason.startsWith("signal.score:"))).toBe(true);
  });

  it("keeps missing candle-count provenance inconclusive", () => {
    const data = descendingDataset();
    const sourceTimestamp = data.candles["15m"].at(-1)!.closeTime;
    const evaluation = evaluateProductionSignal(snapshotFor(data), replayConfig(0).signalPolicy);
    const candidate = evaluation.scoredCandidates[0];
    const row = paperRow({
      id: "candle-count-input-row",
      symbol: data.symbol,
      entryTime: new Date(sourceTimestamp).toISOString(),
      metadata: { source_data_timestamp: new Date(sourceTimestamp).toISOString() },
      signalTelemetry: telemetryFor(candidate, sourceTimestamp, {
        quoteVolume24h: data.instrument.quoteVolume24h!,
        candleCounts: null,
        rawCandlesAvailable: false,
        source: "partial Production signal export",
      }),
    });
    const replay = replayProductionPaperTrade(row, data, replayConfig(0));
    const report = finalizeParityReport([row], [replay], compareControlConfigParity(null, replayConfig(0).replayExpectedConfig), null);

    expect(replay.inputProvenance.dataQualityComparison).toBe("DATA_UNAVAILABLE");
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.failureClassification).toBe("INCONCLUSIVE");
    expect(report.historicalControlReliable).toBe(false);
  });

  it("never treats the same config object as an independent Production parity source", () => {
    const expected = { strategyVersion: "trend-rejection-short-v1", scoreThreshold: 70 };
    const parity = compareControlConfigParity(expected, expected);
    expect(parity.status).toBe("INCOMPLETE");
    expect(parity.unavailable.join(" ")).toContain("independent sources");
  });

  it("marks missing actual Production config as INCOMPLETE", () => {
    const parity = compareControlConfigParity(null, { strategyVersion: "trend-rejection-short-v1" });
    expect(parity.status).toBe("INCOMPLETE");
    expect(parity.source).toBe("unavailable");
    expect(readActualProductionRuntimeConfig({} as NodeJS.ProcessEnv).config).toBeNull();
  });

  it("fails the historical control gate closed when Production parity is not reliable", () => {
    const rows = [trade(1, 1), trade(2, 1), trade(3, 1), trade(4, 1)];
    const metrics = calculateMetrics(rows);
    const stress = buildCostStressMetrics(rows);
    const gate = evaluateV53PromotionGate({
      metrics,
      holdout: metrics,
      control: metrics,
      costStress: stress,
      folds: [{ netR: metrics.netR, trades: metrics.trades }],
      foldGroups: [{ id: "3Y_CORE", folds: [{ netR: metrics.netR, trades: metrics.trades }] }],
      regimeMetrics: [{ regime: "BULL", metrics }],
      dataQuality: { passed: true, reason: "test" },
      controlComparison: { reliable: false, reason: "reliable Production comparator unavailable" },
      adjustedLcb: 1,
      delayedEntry: metrics,
      removeTop3: metrics,
      perturbations: [{ label: "test", metrics, passed: true }],
    });
    const controlGate = gate.gates.find((item) => item.id === "control_comparison");
    expect(controlGate?.passed).toBe(false);
    expect(controlGate?.evidence).toContain("DATA_UNAVAILABLE");
    expect(gate.status).not.toBe("PRODUCTION_EMAIL_ELIGIBLE");
  });

  it("classifies material signal divergence as MODEL_PARITY_FAILURE", () => {
    const configParity = compareControlConfigParity(
      { strategyVersion: "trend-rejection-short-v1" },
      { strategyVersion: "trend-rejection-short-v1" },
    );
    const mismatch = {
      id: "home-paper",
      symbol: "HOMEUSDT",
      sourceTimestamp: new Date(1_000).toISOString(),
      status: "MATERIAL_MISMATCH",
      quantizationVerdict: "INPUT_DATA_UNAVAILABLE",
      reasons: ["strategy trigger divergence"],
      dataUnavailable: [],
      firstDivergenceStage: "strategy_trigger",
      divergence: { productionEquivalentValue: "signal persisted", replayValue: "NO_SIGNAL_CANDIDATE" },
      trace: {} as ProductionReplayResult["trace"],
      replay: {},
    } as unknown as ProductionReplayResult;
    const report = finalizeParityReport([paperRow()], [mismatch], configParity, null);
    expect(report.verdict).toBe("FAIL");
    expect(report.failureClassification).toBe("MODEL_PARITY_FAILURE");
    expect(report.historicalControlReliable).toBe(false);
  });

  it("keeps missing persisted telemetry INCOMPLETE rather than model failure", () => {
    const config = { strategyVersion: "trend-rejection-short-v1" };
    const configParity = compareControlConfigParity({ ...config }, { ...config });
    const partial = {
      id: "partial-paper",
      symbol: "TESTUSDT",
      sourceTimestamp: null,
      status: "PARTIAL_MATCH",
      quantizationVerdict: "INPUT_DATA_UNAVAILABLE",
      reasons: [],
      dataUnavailable: ["bca_signals telemetry"],
      firstDivergenceStage: "data_unavailable",
      divergence: { productionEquivalentValue: "DATA_UNAVAILABLE", replayValue: "DATA_UNAVAILABLE" },
      trace: {} as ProductionReplayResult["trace"],
      replay: {},
    } as unknown as ProductionReplayResult;
    const report = finalizeParityReport([paperRow()], [partial], configParity, null);
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.failureClassification).toBe("INCONCLUSIVE");
    expect(report.historicalControlReliable).toBe(false);
  });

  it("only explains quantization when both raw inputs and non-price fields are proven equal", () => {
    expect(classifyQuantizationMismatch({
      actualStop: 0.0792,
      actualTakeProfit: 0.0744,
      replayStop: 0.07916,
      replayTakeProfit: 0.07449,
      historicalPriceTick: 0.0001,
      replayPriceTick: 0.00001,
      sameUnroundedInputs: true,
      sameNonPriceFields: true,
    })).toBe("QUANTIZATION_EXPLAINED");
    expect(classifyQuantizationMismatch({
      actualStop: 0.0792,
      actualTakeProfit: 0.0744,
      replayStop: 0.07916,
      replayTakeProfit: 0.07449,
      replayPriceTick: 0.00001,
      sameUnroundedInputs: true,
      sameNonPriceFields: true,
    })).toBe("INPUT_DATA_UNAVAILABLE");
  });

  it("records HOME-style raw-trigger and score stages separately", () => {
    const sourceCandle = dataset().candles["15m"]![100];
    const row = paperRow({
      id: "c783bdeb-cfc6-4b88-aa78-911b5b8fe9b1",
      symbol: "HOMEUSDT",
      entryTime: new Date(sourceCandle.closeTime).toISOString(),
      metadata: { source_data_timestamp: new Date(sourceCandle.closeTime).toISOString() },
      signalId: "home-signal",
      signalTelemetry: {
        signalId: "home-signal",
        sourceDataTimestamp: new Date(sourceCandle.closeTime).toISOString(),
        score: 70.629,
        scoreComponents: { trendAlignment: 1, momentum: 0.5295, structure: 0.392, liquidity: 0.4989, volatility: 0.7854, regimeFit: 1, dataQuality: 0.7114 },
        marketRegime: "BEAR",
        side: "SHORT",
        strategyFamily: "TREND",
        primaryTimeframe: "15m",
        confirmationTimeframes: ["1h", "4h"],
        regimeDependency: "HIGH",
        entryPrice: 100,
        stopPrice: 101,
        takeProfitPrice: 98,
        validUntil: new Date(sourceCandle.closeTime + 72 * 60 * 60 * 1000).toISOString(),
      },
    });
    const replay = replayProductionPaperTrade(row, dataset(), replayConfig(101));
    expect(replay.status).toBe("INPUT_DATA_UNAVAILABLE");
    expect(replay.firstDivergenceStage).toBe("score");
    expect(replay.trace.rawStrategyTrigger.replayValue).toMatchObject({ status: "PASS" });
    expect(replay.trace.score.replayValue).toMatchObject({ status: "DATA_UNAVAILABLE" });
    expect(replay.divergence?.replayValue).toMatchObject({ status: "DATA_UNAVAILABLE" });
  });

  it("verifies immutable export provenance and excludes secrets from config serialization", async () => {
    const exportData = await readProductionPaperTradeExport();
    expect(exportData?.provenance.verified).toBe(true);
    expect(exportData?.provenance.rowCount).toBe(exportData?.rows.length);
    expect(hashCanonicalRows([{ b: 2, a: 1 }])).toBe(hashCanonicalRows([{ a: 1, b: 2 }]));
    const serialized = serializeAllowlistedConfig({ strategyVersion: "trend-rejection-short-v1", CRON_SECRET: "secret", SUPABASE_SERVICE_ROLE_KEY: "secret2" });
    expect(serialized).toEqual({ strategyVersion: "trend-rejection-short-v1" });
    expect(JSON.stringify(serialized)).not.toContain("secret");
  });

  it("classifies replay rows as DATA_UNAVAILABLE without inventing a match", () => {
    const row = {
      id: "paper-1",
      signalId: null,
      symbol: "BTCUSDT",
      side: "SHORT",
      strategyFamily: "TREND",
      strategyVersion: "trend-rejection-short-v1",
      entryTime: new Date(1_000).toISOString(),
      entryPrice: 100,
      entryFillPrice: 100,
      stopPrice: 101,
      takeProfitPrice: 98,
      maxHoldUntil: new Date(72 * 60 * 60 * 1000).toISOString(),
      quantity: 1,
      theoreticalRiskUsdt: 1,
      exitTime: new Date(2_000).toISOString(),
      exitPrice: 99,
      exitReason: "STOP_LOSS",
      rMultiple: -1,
      netPnlUsdt: -1,
      feesUsdt: 0,
      fundingUsdt: 0,
      slippageUsdt: 0,
      metadata: {},
      signalTelemetry: null,
    } satisfies ProductionPaperTradeRow;
    const replay = replayProductionPaperTrade(row, null, null);
    expect(replay.status).toBe("INPUT_DATA_UNAVAILABLE");
    expect(replay.reasons).toHaveLength(0);
    expect(replay.dataUnavailable.length).toBeGreaterThan(0);
  });
});
