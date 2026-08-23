import { describe, expect, it } from "vitest";
import { calculateForwardEdge } from "../lib/backtest/forward-metrics";
import { evaluateExecutionDelay, simulateDelayedReferenceTrade } from "../lib/backtest/execution-stress";
import { createFrozenHoldoutWindow, createPurgedWalkForwardFolds, evaluatePromotionGate, type DirectionalValidationMetrics } from "../lib/backtest/validation";
import { evaluateStrategyHealth } from "../lib/core/strategy-health";
import { buildGlobalMarketStateFromSnapshots } from "../lib/core/market-regime";
import { fitDirectionalCostAwareScoreModel, projectedFundingCostRiskFraction } from "../lib/core/opportunity-policy";
import { fitDirectionalScoreCalibration, scoreCandidate } from "../lib/core/scoring";
import { DEFAULT_V5_POLICY } from "../lib/core/policy-registry";
import { buildTradePlan } from "../lib/core/risk";
import { admitSignal } from "../lib/core/signal-admission";
import { DEFAULT_STRATEGY_PARAMS, generateCandidates } from "../lib/core/strategies";
import { DEFAULT_NO_CHASE_POLICY, DEFAULT_V51_ENTRY_EDGE_POLICY, evaluateNoChase, generateV51CandidateWithDiagnostics } from "../lib/core/v5-entry-policy";
import { evaluateUniverseQuality } from "../lib/core/universe-policy";
import type { Candle, Instrument, MarketSnapshot, MarketStateKey, NoChaseFeatures, StrategyCandidate } from "../lib/core/types";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.1,
  quantityStep: 0.001,
};

describe("V5 entry separation and symmetric no-chase", () => {
  it("does not turn a trend-only snapshot into an entry", () => {
    const candles = trendCandles(140, "LONG", false);
    const snapshot = makeSnapshot(candles, "BULL_STRONG");
    const candidates = generateCandidates(snapshot, { ...DEFAULT_STRATEGY_PARAMS, entryMode: "V5_SIGNAL_EDGE" });
    expect(candidates).toHaveLength(0);
  });

  it("requires a LONG pullback, rejection and re-break", () => {
    const candles = trendCandles(140, "LONG", true);
    const candidate = generateCandidates(makeSnapshot(candles, "BULL_PULLBACK"), {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "V5_SIGNAL_EDGE",
    })[0];
    expect(candidate?.side).toBe("LONG");
    expect(candidate?.setupType).toBe("TREND_PULLBACK");
    expect(candidate?.entryTrigger).toBe("REJECTION_REBREAK");
    expect(candidate?.noChase?.passed).toBe(true);
  });

  it("requires a SHORT rebound, rejection and re-break, symmetrically", () => {
    const candles = trendCandles(140, "SHORT", true);
    const candidate = generateCandidates(makeSnapshot(candles, "BEAR_WEAK"), {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "V5_SIGNAL_EDGE",
    })[0];
    expect(candidate?.side).toBe("SHORT");
    expect(candidate?.setupType).toBe("TREND_PULLBACK");
    expect(candidate?.entryTrigger).toBe("REJECTION_REBREAK");
    expect(candidate?.noChase?.passed).toBe(true);
  });

  it("rejects chase extensions for both directions", () => {
    const features: NoChaseFeatures = {
      distanceToFastEmaAtr: 0.4,
      distanceToSlowEmaAtr: 0.8,
      distanceToStructureAtr: 0.3,
      recentMoveAtr: 4,
      candleBodyAtr: 0.8,
      rangeExpansionAtr: 1,
      rsi: 62,
      volumeRatio: 1,
      pullbackDepth: 0.5,
      breakoutExtensionAtr: 2,
    };
    expect(evaluateNoChase("LONG", features, DEFAULT_NO_CHASE_POLICY).passed).toBe(false);
    expect(evaluateNoChase("SHORT", { ...features, rsi: 38 }, DEFAULT_NO_CHASE_POLICY).passed).toBe(false);
  });

  it("keeps V5.1 entry-edge rejection observable and policy-controlled", () => {
    const diagnostics = generateV51CandidateWithDiagnostics(
      makeSnapshot(trendCandles(140, "LONG", true), "BULL_PULLBACK"),
      { ...DEFAULT_STRATEGY_PARAMS, entryMode: "V5_1_SIGNAL_EDGE" },
      undefined,
      { ...DEFAULT_V51_ENTRY_EDGE_POLICY, maxReversalRisk: "LOW" },
    );
    expect(diagnostics.candidate).toBeNull();
    expect(diagnostics.rejectionReasons).toContain("ENTRY_EDGE_REJECTED");
  });
});

describe("directional edge admission", () => {
  it("keeps UNKNOWN and BEAR_REBOUND out of A-level production", () => {
    const candidate = scoreCandidate(baseCandidate({ side: "SHORT", marketState: "BEAR_REBOUND", noChase: passedNoChase(), setupType: "TREND_PULLBACK", entryTrigger: "REJECTION_REBREAK" }));
    const decision = admitSignal(candidate, { ...DEFAULT_V5_POLICY, status: "APPROVED", directionApproval: { LONG: "APPROVED", SHORT: "APPROVED" } }, { expectedGrossR: 0.4, expectedNetR: 0.2, confidence: 0.9, calibrationSamples: 100 });
    expect(decision.productionEligible).toBe(false);
    expect(decision.reasons).toContain("WRONG_REGIME");

    const unknown = admitSignal(scoreCandidate(baseCandidate({ side: "LONG", marketState: "UNKNOWN", noChase: passedNoChase(), setupType: "TREND_PULLBACK", entryTrigger: "REJECTION_REBREAK" })), undefined, { expectedGrossR: 0.4, expectedNetR: 0.2, confidence: 0.9, calibrationSamples: 100 });
    expect(unknown.productionEligible).toBe(false);
    expect(unknown.reasons).toContain("UNKNOWN_MARKET_STATE");
  });

  it("calibrates LONG and SHORT independently and only admits an approved direction", () => {
    const scored = scoreCandidate(baseCandidate({ side: "LONG", marketState: "BULL_STRONG", noChase: passedNoChase(), setupType: "TREND_PULLBACK", entryTrigger: "REJECTION_REBREAK" }));
    const calibrationModel = fitDirectionalScoreCalibration([
      ...Array.from({ length: 40 }, () => ({ side: "LONG" as const, score: scored.score, netR: 0.2 })),
      ...Array.from({ length: 40 }, () => ({ side: "SHORT" as const, score: scored.score, netR: -0.2 })),
    ], { minimumSamples: 40, minimumExpectedNetR: 0.02, priorWeight: 0 });
    const expectedEdgeModel = fitDirectionalCostAwareScoreModel([
      ...Array.from({ length: 40 }, () => ({ side: "LONG" as const, score: scored.score, marketState: "BULL_STRONG" as const, projectedFundingCostRiskFraction: 0, executionCostRiskFraction: 0.01, netR: 0.2 })),
      ...Array.from({ length: 40 }, () => ({ side: "SHORT" as const, score: scored.score, marketState: "BULL_STRONG" as const, projectedFundingCostRiskFraction: 0, executionCostRiskFraction: 0.01, netR: -0.2 })),
    ], { minimumSamples: 40, minimumExpectedNetR: 0.02, priorWeight: 0 });
    const policy = {
      ...DEFAULT_V5_POLICY,
      status: "APPROVED" as const,
      directionApproval: { LONG: "APPROVED" as const, SHORT: "SHADOW_ONLY" as const },
      calibrationModel,
      expectedEdgeModel,
    };
    const decision = admitSignal(scored, policy, {
      expectedGrossR: 0.3,
      policyFeatures: { marketState: "BULL_STRONG", projectedFundingCostRiskFraction: 0, executionCostRiskFraction: 0.01 },
    });
    expect(decision.tier).toBe("A");
    expect(decision.productionEligible).toBe(true);
    expect(decision.calibrationSamples).toBe(40);

    const shortDecision = admitSignal(scoreCandidate({ ...scored, side: "SHORT", marketState: "BEAR_WEAK" }), policy, {
      expectedGrossR: 0.3,
      policyFeatures: { marketState: "BEAR_WEAK", projectedFundingCostRiskFraction: 0, executionCostRiskFraction: 0.01 },
    });
    expect(shortDecision.productionEligible).toBe(false);
    expect(shortDecision.reasons).toContain("DIRECTION_NOT_APPROVED");
  });
});

describe("purged validation, forward edge and data quality", () => {
  it("keeps purge and frozen holdout outside selection windows", () => {
    const start = Date.UTC(2023, 0, 1);
    const end = Date.UTC(2026, 0, 1);
    const folds = createPurgedWalkForwardFolds({ start, end, initialTrainMonths: 12, validationMonths: 3, foldCount: 4, purgeHours: 72 });
    expect(folds.length).toBe(4);
    expect(folds.every((fold) => fold.trainEnd < fold.purgeStart && fold.purgeEnd < fold.validationStart)).toBe(true);
    const holdout = createFrozenHoldoutWindow(start, end, folds, 72);
    expect(holdout?.start).toBeGreaterThan(folds.at(-1)!.validationEnd);
  });

  it("computes direction-normalized forward returns and R-first outcomes", () => {
    const candles = trendCandles(8, "LONG", false);
    const entry = candles[1].close;
    candles[2] = { ...candles[2], high: entry + 1, low: entry - 0.2, close: entry + 0.6 };
    candles[3] = { ...candles[3], high: entry + 0.2, low: entry - 1.2, close: entry - 0.5 };
    const metrics = calculateForwardEdge(candles, 1, "LONG", candles[1].close, 1);
    expect(metrics.forwardReturn15m).toBeTypeOf("number");
    expect(metrics.maxFavorableR).toBeGreaterThan(0);
    expect(metrics.maxAdverseR).toBeGreaterThan(0);
    expect(metrics.pPositiveHalfRBeforeStop).toBe(true);
  });

  it("marks fine-grained execution delay as a proxy when only 15m candles exist", () => {
    const candles = trendCandles(8, "LONG", false);
    const result = evaluateExecutionDelay(candles, candles[1].closeTime, candles[1].close, "T+5m");
    expect(result.entryPrice).toBeTypeOf("number");
    expect(result.proxy).toBe(true);
  });

  it("rejects stale and incomplete universes without a blacklist", () => {
    const candles = trendCandles(20, "LONG", false);
    const result = evaluateUniverseQuality(instrument, candles, candles.at(-1)!.closeTime + 2 * 60 * 60 * 1000, {
      minimumListingAgeDays: 0,
      minimumHistoryDays: 365,
      minimumCompleteness: 0.98,
      minimumMedianQuoteVolume: 0,
      minimumAtrPercent: 0,
      maximumAtrPercent: 1,
      maximumVolumeSpikeRatio: 100,
      staleCandleMinutes: 45,
      orderBookAvailability: "UNAVAILABLE",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("HISTORY");
    expect(result.reasons).toContain("STALE_DATA");
  });
});

describe("validation integrity guards", () => {
  it("keeps global state deterministic for the same fixed timestamp and lets ETH participate", () => {
    const sourceTimestamp = 1_700_000_000_000;
    const fixedUniverse = [
      globalSnapshot("BTCUSDT", "LONG", sourceTimestamp),
      globalSnapshot("ETHUSDT", "LONG", sourceTimestamp),
      globalSnapshot("SOLUSDT", "LONG", sourceTimestamp),
      globalSnapshot("ADAUSDT", "SHORT", sourceTimestamp),
    ];
    const first = buildGlobalMarketStateFromSnapshots({ snapshots: fixedUniverse, sourceTimestamp, breadthUniverseId: "fixed-v1" });
    const reordered = buildGlobalMarketStateFromSnapshots({ snapshots: [...fixedUniverse].reverse(), sourceTimestamp, breadthUniverseId: "fixed-v1" });
    expect(first).toEqual(reordered);
    expect(first?.breadthUniverseId).toBe("fixed-v1");
    expect(first?.breadthUniverseSize).toBe(4);

    const ethConflict = buildGlobalMarketStateFromSnapshots({
      snapshots: [
        globalSnapshot("BTCUSDT", "LONG", sourceTimestamp),
        globalSnapshot("ETHUSDT", "SHORT", sourceTimestamp),
      ],
      sourceTimestamp,
      breadthUniverseId: "fixed-v1",
    });
    expect(ethConflict?.key).toBe("OTHER");
  });

  it("marks missing funding as unavailable instead of projecting a favorable zero", () => {
    const scored = scoreCandidate(baseCandidate({
      side: "LONG",
      marketState: "BULL_STRONG",
      setupType: "TREND_PULLBACK",
      entryTrigger: "REJECTION_REBREAK",
      noChase: passedNoChase(),
    }));
    const plan = buildTradePlan(scored, instrument, {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 100,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 72,
    }, 1_700_000_000_000);
    expect(projectedFundingCostRiskFraction("LONG", plan, [], 1_700_000_000_000)).toBe(Infinity);
    const decision = admitSignal({ ...scored, confidence: 0.9 }, {
      ...DEFAULT_V5_POLICY,
      status: "APPROVED",
      directionApproval: { LONG: "APPROVED", SHORT: "SHADOW_ONLY" },
    }, {
      expectedGrossR: 0.3,
      expectedNetR: 0.2,
      calibrationSamples: 100,
      edgeConfidence: 0.9,
      policyFeatures: {
        marketState: "BULL_STRONG",
        projectedFundingCostRiskFraction: Infinity,
        executionCostRiskFraction: 0.01,
        fundingDataStatus: "UNKNOWN",
      },
    });
    expect(decision.productionEligible).toBe(false);
    expect(decision.reasons).toContain("FUNDING_UNAVAILABLE");
  });

  it("caps forward horizons at maxHold and does not borrow a later candle", () => {
    const candles = trendCandles(20, "LONG", false);
    candles[10] = { ...candles[10], high: candles[1].close + 100, close: candles[1].close + 50 };
    const metrics = calculateForwardEdge(candles, 1, "LONG", candles[1].close, 1, 1);
    expect(metrics.forwardReturn72h).toBeNull();
    expect(metrics.horizon72h.maxFavorableR).toBeLessThan(100);
  });

  it("re-simulates delayed entry through the stop/TP path and labels 15m proxies", () => {
    const sourceTimestamp = 1_700_000_000_000;
    const candles = [
      simpleCandle(sourceTimestamp, 100, 100, 99, 100),
      simpleCandle(sourceTimestamp + 15 * 60_000, 100, 103, 99, 102),
      simpleCandle(sourceTimestamp + 30 * 60_000, 102, 106, 101, 105),
    ];
    const result = simulateDelayedReferenceTrade(candles, {
      side: "LONG",
      sourceTimestamp,
      referenceEntryPrice: 100,
      stopPrice: 95,
      takeProfitPrice: 105,
      quantity: 1,
      theoreticalRiskUsdt: 5,
      maxHoldHours: 72,
      takerFeeRate: 0,
      slippageBps: 0,
    }, "T+5m");
    expect(result.exitReason).toBe("TAKE_PROFIT");
    expect(result.netR).toBe(0.6);
    expect(result.proxy).toBe(true);
    expect(result.note).toContain("true path re-simulation");
  });

  it("does not make median net R a default promotion hard condition", () => {
    const metrics: DirectionalValidationMetrics = {
      direction: "SHORT",
      trades: 100,
      winRate: 0.55,
      grossR: 20,
      netR: 10,
      averageNetR: 0.1,
      medianNetR: -0.5,
      winProbability: 0.55,
      edgeConfidence: 0.8,
      profitFactor: 2,
      maxDrawdownR: 5,
      maxDrawdownPercent: 5,
      cvar95: -1,
      positiveMonths: 8,
      positiveFolds: 2,
      monthsObserved: 10,
      foldsEvaluated: 2,
      symbolBreadth: 20,
      regimeBreadth: 3,
      topSymbolProfitShare: 0.2,
      topThreeSymbolProfitShare: 0.5,
      profitConcentrationHhi: 0.1,
      averageMFE: 1,
      averageMAE: 1,
      averageMFE24h: 1,
      averageMFE72h: 1.5,
      averageMAE24h: 1,
      averageMAE72h: 1.5,
      stopFirstRate: 0.4,
      grossEdge: 20,
      costs: 10,
      netEdge: 10,
      stressNetR: 0.1,
      rFirst: { halfRBeforeStop: 0.6, oneRBeforeStop: 0.5, twoRBeforeStop: 0.3 },
      rFirst24h: { halfRBeforeStop: 0.6, oneRBeforeStop: 0.5, twoRBeforeStop: 0.3 },
      rFirst72h: { halfRBeforeStop: 0.6, oneRBeforeStop: 0.5, twoRBeforeStop: 0.3 },
    };
    const decision = evaluatePromotionGate(metrics, { frozenHoldout: true });
    expect(decision.passed).toBe(true);
    expect(decision.reasons).not.toContain("median_net_r");
  });
});

describe("prospective strategy health gate", () => {
  it("does not fail closed on only two or three settled losses", () => {
    const decision = evaluateStrategyHealth([
      { rMultiple: -1, exitReason: "STOP_LOSS" },
      { rMultiple: -1, exitReason: "STOP_LOSS" },
      { rMultiple: -1, exitReason: "STOP_LOSS" },
    ]);

    expect(decision.status).toBe("UNKNOWN");
    expect(decision.productionAAllowed).toBe(false);
  });

  it("fails closed on a sustained prospective stop-heavy degradation", () => {
    const decision = evaluateStrategyHealth([
      ...Array.from({ length: 10 }, (_, index) => ({
        rMultiple: index === 0 ? 0.8 : -0.8,
        exitReason: index === 0 ? "TAKE_PROFIT" : "STOP_LOSS",
        entryTime: index,
      })),
      { rMultiple: -0.8, exitReason: "STOP_LOSS", entryTime: 11 },
    ]);

    expect(decision.status).toBe("FAIL_CLOSED");
    expect(decision.productionAAllowed).toBe(false);
    expect(decision.reasons).toContain("rolling_stop_rate");
  });
});

function makeSnapshot(candles: Candle[], marketState: MarketStateKey): MarketSnapshot {
  return {
    instrument,
    tickerPrice: candles.at(-1)!.close,
    candles: { "15m": candles, "1h": trendCandles(120, marketState.startsWith("BULL") ? "LONG" : "SHORT", false), "4h": trendCandles(120, marketState.startsWith("BULL") ? "LONG" : "SHORT", false) },
    sourceTimestamp: candles.at(-1)!.closeTime,
    globalMarketState: { key: marketState, btcRegime: marketState.startsWith("BULL") ? "BULL" : "BEAR", breadth: marketState.startsWith("BULL") ? 0.7 : 0.3, sourceTimestamp: candles.at(-1)!.closeTime },
  };
}

function globalSnapshot(symbol: string, side: "LONG" | "SHORT", sourceTimestamp: number): MarketSnapshot {
  return {
    instrument: { ...instrument, symbol },
    tickerPrice: 100,
    candles: { "4h": trendCandles(120, side, false) },
    sourceTimestamp,
  };
}

function simpleCandle(closeTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: closeTime - 14 * 60_000 - 59_999, open, high, low, close, volume: 1, closeTime };
}

function trendCandles(count: number, side: "LONG" | "SHORT", trigger: boolean): Candle[] {
  const direction = side === "LONG" ? 1 : -1;
  const candles = Array.from({ length: count }, (_, index) => {
      const close = 200 + direction * (index * 0.1 + (index % 5 === 0 ? -1 : 0));
    return {
      openTime: index * 900_000,
      open: close - direction * 0.2,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: 100,
      closeTime: (index + 1) * 900_000 - 1,
    };
  });
  if (trigger) {
    const previous = candles[count - 2];
    const before = candles[count - 3];
    if (side === "LONG") {
      previous.low = previous.close - 5;
      previous.high = previous.close + 1;
      previous.open = previous.close - 0.2;
      candles[count - 1] = { ...candles[count - 1], open: previous.high - 0.2, close: previous.high + 0.8, high: previous.high + 1.2, low: previous.high - 1.8 };
    } else {
      previous.high = previous.close + 5;
      previous.low = previous.close - 1;
      previous.open = previous.close + 0.2;
      candles[count - 1] = { ...candles[count - 1], open: previous.low + 0.2, close: previous.low - 0.8, low: previous.low - 1.2, high: previous.low + 1.8 };
    }
    void before;
  }
  return candles;
}

function passedNoChase() {
  return {
    passed: true,
    reasons: [],
    features: {
      distanceToFastEmaAtr: 0.5,
      distanceToSlowEmaAtr: 0.8,
      distanceToStructureAtr: 0.3,
      recentMoveAtr: 0.6,
      candleBodyAtr: 0.5,
      rangeExpansionAtr: 1,
      rsi: 55,
      volumeRatio: 1,
      pullbackDepth: 0.5,
      breakoutExtensionAtr: 0.3,
    },
  };
}

function baseCandidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    strategyFamily: "TREND",
    side: "LONG",
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: 100,
    stopReferencePrice: 95,
    atr: 2,
    scoreComponents: { trendAlignment: 1, momentum: 0.8, structure: 0.8, liquidity: 0.8, volatility: 0.8, regimeFit: 1, dataQuality: 1 },
    marketRegime: "BULL",
    regimeDependency: "HIGH",
    rationale: ["test"],
    ...overrides,
  };
}
