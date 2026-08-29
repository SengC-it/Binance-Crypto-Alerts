import { describe, expect, it, vi } from "vitest";
import type { MarketSnapshot, ScoredCandidate, TradePlan } from "@/lib/core/types";
import { buildTradePlan } from "@/lib/core/risk";
import { DEFAULT_STRATEGY_PARAMS, generateCandidates } from "@/lib/core/strategies";
import { evaluateProductionSignal, buildProductionOpportunity } from "@/lib/core/production-signal";
import {
  buildRollingUniverseSnapshot,
  compareUniverseSnapshots,
  ROLLING_15M_24H_VOLUME_PROXY,
  summarizeUniverseParity,
} from "@/lib/lfv/universe-replay";
import {
  closed15mSchedule,
  replayProductionSignals,
  settleReplayTrade,
  type ReplayTrade,
} from "@/lib/lfv/production-replay";
import type { LfvBar } from "@/lib/lfv/archive-data";

const interval = 15 * 60 * 1000;
const instrument = {
  symbol: "LFVTESTUSDT",
  baseAsset: "LFVTEST",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.01,
  quantityStep: 1,
  minQuantity: 1,
};

const candidate: ScoredCandidate = {
  strategyFamily: "TREND",
  side: "SHORT",
  primaryTimeframe: "15m",
  confirmationTimeframes: ["1h", "4h"],
  entryPrice: 100,
  stopReferencePrice: 105,
  atr: 2,
  scoreComponents: {
    trendAlignment: 0.9,
    momentum: 0.9,
    structure: 0.9,
    liquidity: 0.9,
    volatility: 0.9,
    regimeFit: 0.9,
    dataQuality: 0.9,
  },
  marketRegime: "BEAR",
  regimeDependency: "HIGH",
  rationale: ["deterministic LFV replay fixture"],
  score: 90,
};

vi.mock("@/lib/core/strategies", async () => {
  const actual = await vi.importActual<typeof import("@/lib/core/strategies")>("@/lib/core/strategies");
  return { ...actual, generateCandidates: () => [candidate] };
});

function bar(openTime: number, quoteVolume: number, close = 100): LfvBar {
  return {
    openTime,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: quoteVolume / close,
    closeTime: openTime + interval - 1,
    quoteVolume,
  };
}

function snapshot(sourceTimestamp = interval * 4 - 1): MarketSnapshot {
  return {
    instrument,
    tickerPrice: 100,
    sourceTimestamp,
    candles: {
      "15m": [bar(0, 100)].map((item) => ({
        openTime: item.openTime,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        closeTime: item.closeTime,
      })),
      "1h": [],
      "4h": [],
    },
  };
}

function policy() {
  return {
    strategyParams: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_REJECTION" as const },
    minimumScore: 70,
    sideFilter: "SHORT" as const,
    strategyFamily: "TREND" as const,
    requireRegimeAlignment: true,
    entryIntervalHours: 1,
    takerFeeRate: 0.0004,
    slippageBps: 2,
    maxExecutionCostRiskFraction: 0.1,
    marginUsdt: 100,
    leverage: 20,
    singleSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    maxHoldHours: 72,
    rewardRisk: 2,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
  };
}

function replayTrade(overrides: Partial<ReplayTrade> = {}): ReplayTrade {
  const sourceTimestamp = 3_599_999;
  const plan: TradePlan = {
    entryPrice: 100,
    stopPrice: 105,
    takeProfitPrice: 90,
    rewardRisk: 2,
    assumedMarginUsdt: 100,
    assumedLeverage: 20,
    positionNotionalUsdt: 2_000,
    quantity: 20,
    theoreticalRiskUsdt: 100,
    riskOverSingleCap: false,
    validUntil: sourceTimestamp + 72 * 60 * 60 * 1000,
  };
  return {
    symbol: instrument.symbol,
    strategyVersion: "trend-rejection-short-v1",
    signalTimestamp: sourceTimestamp,
    snapshot: snapshot(sourceTimestamp),
    plan,
    score: 90,
    side: "SHORT",
    entryTime: sourceTimestamp,
    entryPrice: 100,
    entryFillPrice: 100,
    stopPrice: 105,
    takeProfitPrice: 90,
    maxHoldUntil: plan.validUntil,
    quantity: 20,
    theoreticalRiskUsdt: 100,
    ...overrides,
  };
}

describe("LFV-001 PIT universe replay", () => {
  it("uses only the prior 96 closed 15m bars and excludes future volume", () => {
    const timestamp = 96 * interval;
    const bars = Array.from({ length: 97 }, (_, index) => bar(index * interval, index === 96 ? 1_000_000 : 10));
    const result = buildRollingUniverseSnapshot(timestamp, new Map([["AAAUSDT", bars]]), {
      requiredSymbols: ["AAAUSDT"],
    });

    expect(result.method).toBe(ROLLING_15M_24H_VOLUME_PROXY);
    expect(result.eligible[0]?.barsUsed).toBe(96);
    expect(result.eligible[0]?.rollingQuoteVolume24h).toBe(960);
    expect(result.eligible[0]?.latestClosedBarTime).toBe(95 * interval + interval - 1);
  });

  it("fails closed when an observed symbol lacks a complete PIT window", () => {
    const result = buildRollingUniverseSnapshot(interval * 2, new Map([["AAAUSDT", [bar(0, 10)]]]), {
      requiredSymbols: ["AAAUSDT", "MISSINGUSDT"],
    });

    expect(result.deepScan).toEqual([]);
    expect(result.missingSymbols).toEqual(["AAAUSDT", "MISSINGUSDT"]);
    expect(summarizeUniverseParity([]).pass).toBe(false);
  });

  it("compares observed Top100 membership and signal-symbol inclusion", () => {
    const timestamp = 96 * interval;
    const bars = Array.from({ length: 96 }, (_, index) => bar(index * interval, 100));
    const proxy = buildRollingUniverseSnapshot(timestamp, new Map([
      ["AAAUSDT", bars.map((item) => ({ ...item, quoteVolume: 200 }))],
      ["BBB ", bars],
    ]), { requiredSymbols: ["AAAUSDT", "BBB "] });
    const comparison = compareUniverseSnapshots({
      timestamp,
      rankedSymbols: ["AAAUSDT", "BBB "],
      selectedSymbols: ["AAAUSDT", "BBB "],
      signalSymbols: ["AAAUSDT"],
    }, proxy);

    expect(comparison.top100Overlap).toBe(1);
    expect(comparison.signalInclusionRecall).toBe(1);
  });
});

describe("LFV-001 Production replay", () => {
  it("uses the shared Production core and matches the legacy admission calculation", () => {
    const input = snapshot();
    const runtimePolicy = policy();
    const legacyCandidate = generateCandidates(input, runtimePolicy.strategyParams)[0];
    expect(legacyCandidate).toBeDefined();
    const shared = evaluateProductionSignal(input, runtimePolicy);
    const legacyPlan = buildTradePlan(shared.candidate!, input.instrument, runtimePolicy, input.sourceTimestamp);

    expect(shared.status).toBe("ADMITTED");
    expect(buildProductionOpportunity(input, runtimePolicy)?.candidate).toEqual(shared.candidate);
    expect(shared.plan).toEqual(legacyPlan);
    expect(shared.candidate?.side).toBe(candidate.side);
  });

  it("keeps future settlement candles out of candidate input", () => {
    const input = snapshot();
    const future = [{
      openTime: input.sourceTimestamp + 1,
      open: 101,
      high: 999,
      low: 1,
      close: 777,
      volume: 999_999,
      closeTime: input.sourceTimestamp + interval,
    }];
    const result = replayProductionSignals({
      snapshots: [input, input],
      strategyVersion: "trend-rejection-short-v1",
      policy: runtimePolicyForReplay(),
      maxConcurrentPositions: 1,
      settlementCandlesBySymbol: new Map([[instrument.symbol, future]]),
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.decisions.filter((item) => item.status === "ACCEPTED")).toHaveLength(1);
  });

  it("settles stop-first with explicit fees, slippage, and funding", () => {
    const trade = replayTrade();
    const exitTime = trade.entryTime + interval;
    const result = settleReplayTrade(trade, [{
      openTime: trade.entryTime + 1,
      open: 100,
      high: 106,
      low: 89,
      close: 95,
      volume: 1,
      closeTime: exitTime,
    }], {
      takerFeeRate: 0.0004,
      slippageBps: 2,
      fundingBySymbol: new Map([[instrument.symbol, [{ fundingTime: exitTime, fundingRate: 0.001 }]]]),
    });

    expect(result?.exitReason).toBe("STOP_LOSS");
    expect(result?.fundingUsdt).toBeCloseTo(2);
    expect(result?.feesUsdt).toBeGreaterThan(0);
    expect(result?.netPnlUsdt).toBeLessThan(-100);
  });

  it("does not create a second trade for a duplicate signal snapshot", () => {
    const input = snapshot();
    const result = replayProductionSignals({
      snapshots: [input, input],
      strategyVersion: "trend-rejection-short-v1",
      policy: runtimePolicyForReplay(),
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.reason).toBe("REJECTED_LOWER_SCORE");
  });

  it("emits the exact closed 15m schedule without a same-window timestamp", () => {
    expect(closed15mSchedule(0, interval * 2 - 1)).toEqual([interval - 1, interval * 2 - 1]);
  });
});

function runtimePolicyForReplay() {
  return policy();
}
