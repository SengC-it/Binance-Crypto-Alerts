import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Candle, FundingRatePoint, ScoredCandidate, TradePlan } from "@/lib/core/types";
import { stopBandFilterPass } from "@/lib/prc1/stopband";
import { evaluateIpv1EmailPilotGate } from "@/lib/ipv1/gate";
import { ceilToNextMinute, simulateIpv1Execution } from "@/lib/ipv1/execution";
import { summarizeIpv1Replay } from "@/lib/ipv1/metrics";
import {
  candidatesForGroup,
  prepareIpv1Evidence,
  runIpv1Replay,
  selectBaselineCandidate,
  selectChallengerCandidate,
} from "@/lib/ipv1/replay";
import {
  IPV1_BASELINE_STRATEGY_VERSION,
  IPV1_CHALLENGER_STRATEGY_VERSION,
  IPV1_GATE_COLLECTING,
  IPV1_GATE_FAIL,
  IPV1_GATE_PASS,
  IPV1_PRIMARY_EXECUTION,
  IPV1_STRESS_EXECUTION,
  type Ipv1Candidate,
  type Ipv1MarketDataProvider,
  type Ipv1Metrics,
  type Ipv1ReplayDecision,
} from "@/lib/ipv1/types";

const FREEZE_MS = Date.parse("2026-09-12T23:46:20.666Z");
const BASE_TIME = Date.parse("2026-09-13T00:00:00.000Z");

function plan(stopPrice = 104, entryPrice = 100, takeProfitPrice = 95, validUntil = BASE_TIME + 72 * 60 * 60 * 1000): TradePlan {
  return {
    entryPrice,
    stopPrice,
    takeProfitPrice,
    rewardRisk: 2,
    assumedMarginUsdt: 100,
    assumedLeverage: 20,
    positionNotionalUsdt: 2_000,
    quantity: 20,
    theoreticalRiskUsdt: Math.abs(stopPrice - entryPrice) * 20,
    riskOverSingleCap: false,
    validUntil,
  };
}

function candidate(
  symbol: string,
  score: number,
  options: { side?: "LONG" | "SHORT"; stopPrice?: number; entryPrice?: number; takeProfitPrice?: number; validUntil?: number } = {},
): Ipv1Candidate {
  const side = options.side ?? "SHORT";
  const entryPrice = options.entryPrice ?? 100;
  const stopPrice = options.stopPrice ?? 104;
  const takeProfitPrice = options.takeProfitPrice ?? (side === "SHORT" ? 95 : 105);
  return {
    scanGroupKey: "g1",
    symbol,
    sourceDataTimestamp: FREEZE_MS + 1,
    score,
    candidate: {
      strategyFamily: "TREND",
      side,
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h"],
      entryPrice,
      stopReferencePrice: stopPrice,
      atr: 2,
      scoreComponents: {
        trendAlignment: 1,
        momentum: 1,
        structure: 1,
        liquidity: 1,
        volatility: 1,
        regimeFit: 1,
        dataQuality: 1,
      },
      marketRegime: "RANGE",
      regimeDependency: "LOW",
      rationale: ["test"],
      score,
    },
    plan: plan(stopPrice, entryPrice, takeProfitPrice, options.validUntil),
  };
}

function group(scanGroupKey: string, finishedAt: number, status = "COMPLETED") {
  return { scanGroupKey, status, finishedAt };
}

function candle(openTime: number, open: number, high = open, low = open, close = open): Candle {
  return { openTime, open, high, low, close, volume: 1, closeTime: openTime + 59_999 };
}

function provider(candles: Candle[] | ((symbol: string) => Candle[]), fundingRates: FundingRatePoint[] = []): Ipv1MarketDataProvider {
  return {
    async getMinuteCandles(symbol) {
      return typeof candles === "function" ? candles(symbol) : candles;
    },
    async getFundingRates() {
      return fundingRates;
    },
  };
}

function row(item: Ipv1Candidate, source = new Date(FREEZE_MS + 1).toISOString()) {
  return {
    scan_group_key: item.scanGroupKey,
    symbol: item.symbol,
    source_data_timestamp: source,
    score: item.score,
    candidate: item.candidate,
    trade_plan: item.plan,
  };
}

function closedExecution(netPnlUsdt: number, rMultiple: number, entryTime: number, exitTime: number): Ipv1ReplayDecision {
  return {
    scanGroupKey: `g-${entryTime}`,
    decisionTime: entryTime,
    candidate: candidate("BTCUSDT", 1),
    outcome: "CLOSED",
    execution: {
      status: "CLOSED",
      opened: true,
      closed: true,
      dataInvalid: false,
      entryTime,
      exitTime,
      entryReferencePrice: 100,
      entryFillPrice: 100,
      rawExitPrice: 100,
      exitFillPrice: 100,
      exitReason: netPnlUsdt > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
      grossPnlUsdt: netPnlUsdt,
      feesUsdt: 0,
      fundingUsdt: 0,
      slippageUsdt: 0,
      netPnlUsdt,
      rMultiple,
      theoreticalRiskUsdt: 50,
    },
  };
}

function metrics(overrides: Partial<Ipv1Metrics> = {}): Ipv1Metrics {
  return {
    candidateDecisionGroups: 20,
    openedTrades: 20,
    closedTrades: 20,
    notExecutableTrades: 0,
    dataInvalidTrades: 0,
    netPnlUsdt: 100,
    netProfit: 200,
    netLoss: 100,
    netProfitFactor: 2,
    avgNetPnlUsdt: 5,
    avgR: 0.1,
    winRate: 0.6,
    maxDrawdownUsdt: 100,
    maxDrawdownR: 2,
    grossProfit: 200,
    largestWinningTrade: 20,
    largestWinningTradeGrossProfitContributionPct: 10,
    distinctUtcEntryDays: 5,
    feesUsdt: 10,
    slippageUsdt: 10,
    fundingUsdt: 0,
    stopLossCount: 8,
    takeProfitCount: 12,
    timeLimitCount: 0,
    ...overrides,
  };
}

describe("IPV-1 independent evidence preparation", () => {
  it("excludes pre-freeze candidates and non-completed groups", () => {
    const eligible = candidate("BTCUSDT", 90);
    const beforeFreeze = candidate("ETHUSDT", 100);
    const prepared = prepareIpv1Evidence(
      [
        { scan_group_key: "g1", status: "COMPLETED", finished_at: new Date(BASE_TIME).toISOString() },
        { scan_group_key: "g2", status: "PARTIAL", finished_at: new Date(BASE_TIME + 1).toISOString() },
      ],
      [row(eligible), row(beforeFreeze, "2026-09-12T23:46:20.665Z")],
    );
    expect(prepared.groups).toEqual([group("g1", BASE_TIME)]);
    expect(prepared.candidates.map((item) => item.symbol)).toEqual(["BTCUSDT"]);
    expect(prepared.excludedBeforeFreezeCount).toBe(1);
    expect(prepared.excludedNonCompletedGroupCount).toBe(1);
  });

  it("uses scan group ASC and score DESC plus symbol ASC ordering", () => {
    const highSymbol = { ...candidate("ETHUSDT", 90), scanGroupKey: "g2" };
    const lowSymbol = { ...candidate("BTCUSDT", 90), scanGroupKey: "g2" };
    const top = { ...candidate("SOLUSDT", 95), scanGroupKey: "g2" };
    const ranked = candidatesForGroup([highSymbol, lowSymbol, top], "g2");
    expect(ranked.map((item) => item.symbol)).toEqual(["SOLUSDT", "BTCUSDT", "ETHUSDT"]);
    expect(selectBaselineCandidate(ranked)?.symbol).toBe("SOLUSDT");
  });

  it("selects the first challenger outside the exact frozen stop band", () => {
    const rejected = candidate("BTCUSDT", 100, { stopPrice: 102.5 });
    const accepted = candidate("ETHUSDT", 90, { stopPrice: 104 });
    const later = candidate("SOLUSDT", 80, { stopPrice: 105 });
    expect(stopBandFilterPass(rejected.plan)).toBe(false);
    expect(selectChallengerCandidate([rejected, accepted, later])?.symbol).toBe("ETHUSDT");
    expect(selectChallengerCandidate([candidate("BTCUSDT", 100, { stopPrice: 103.499999 })])).toBeUndefined();
    expect(stopBandFilterPass(candidate("BTCUSDT", 100, { stopPrice: 103.5 }).plan)).toBe(true);
  });
});

describe("IPV-1 virtual replay and execution", () => {
  it("starts flat, enforces one open position, cooldown, and no cooldown fallback", async () => {
    const first = { ...candidate("BTCUSDT", 100), scanGroupKey: "g1" };
    const blockedTop = { ...candidate("BTCUSDT", 100), scanGroupKey: "g2" };
    const forbiddenFallback = { ...candidate("ETHUSDT", 99), scanGroupKey: "g2" };
    const afterCooldown = { ...candidate("BTCUSDT", 100), scanGroupKey: "g3" };
    const groups = [group("g1", BASE_TIME), group("g2", BASE_TIME + 2 * 60 * 60 * 1000), group("g3", BASE_TIME + 10 * 60 * 60 * 1000)];
    const candles = [
      candle(BASE_TIME + 120_000, 100, 100, 94, 96),
      candle(BASE_TIME + 180_000, 100, 100, 94, 96),
    ];
    const replay = await runIpv1Replay(
      groups,
      [first, blockedTop, forbiddenFallback, afterCooldown],
      IPV1_BASELINE_STRATEGY_VERSION,
      IPV1_PRIMARY_EXECUTION,
      BASE_TIME + 12 * 60 * 60 * 1000,
      {
        async getMinuteCandles(_symbol, startTime) {
          return [candle(startTime, 100, 100, 94, 96), candle(startTime + 60_000, 100, 100, 94, 96)];
        },
        async getFundingRates() {
          return [];
        },
      },
    );
    expect(replay.decisions.map((decision) => decision.outcome)).toEqual(["CLOSED", "COOLDOWN_BLOCKED", "CLOSED"]);
    expect(replay.decisions[1].candidate?.symbol).toBe("BTCUSDT");
    expect(replay.decisions[1].candidate?.symbol).not.toBe("ETHUSDT");

    const independent = await runIpv1Replay(
      groups.slice(0, 1),
      [first],
      IPV1_CHALLENGER_STRATEGY_VERSION,
      IPV1_PRIMARY_EXECUTION,
      BASE_TIME + 12 * 60 * 60 * 1000,
      provider(candles),
    );
    expect(independent.decisions[0].outcome).toBe("CLOSED");
  });

  it("uses finished_at plus 60 seconds, ceils to one minute, and fills from market open", async () => {
    const decision = BASE_TIME + 123;
    const actual = ceilToNextMinute(decision + 60_000);
    const item = candidate("BTCUSDT", 100);
    const result = await simulateIpv1Execution({
      candidate: item,
      decisionTime: decision,
      asOfMs: actual + 120_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([candle(actual, 101, 101, 101, 101), candle(actual + 60_000, 101, 101, 94, 96)]),
    });
    expect(result.actualEntryTimestamp).toBe(actual);
    expect(result.entryReferencePrice).toBe(101);
    expect(result.entryReferencePrice).not.toBe(item.plan.entryPrice);
    expect(result.entryFillPrice).toBeCloseTo(100.9798, 8);
  });

  it("applies adverse LONG/SHORT slippage, two-sided fees, and funding boundaries", async () => {
    const item = candidate("BTCUSDT", 100);
    const actual = BASE_TIME + 60_000;
    const funding = [
      { fundingTime: actual, fundingRate: 0.01 },
      { fundingTime: actual + 59_999, fundingRate: 0.01 },
      { fundingTime: actual + 119_999, fundingRate: 0.01 },
    ];
    const shortResult = await simulateIpv1Execution({
      candidate: item,
      decisionTime: BASE_TIME,
      asOfMs: actual + 180_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([candle(actual, 100, 100, 100, 100), candle(actual + 60_000, 100, 100, 94, 96)], funding),
    });
    expect(shortResult.exitReason).toBe("TAKE_PROFIT");
    expect(shortResult.fundingUsdt).toBeGreaterThan(0);
    expect(shortResult.feesUsdt).toBeGreaterThan(0);
    expect(shortResult.slippageUsdt).toBeGreaterThan(0);

    const long = candidate("ETHUSDT", 100, { side: "LONG", stopPrice: 96, takeProfitPrice: 105 });
    const stressActual = BASE_TIME + 180_000;
    const longResult = await simulateIpv1Execution({
      candidate: long,
      decisionTime: BASE_TIME,
      asOfMs: actual + 180_000,
      executionModel: IPV1_STRESS_EXECUTION,
      provider: provider([candle(stressActual, 100, 106, 100, 104)], []),
    });
    expect(longResult.entryFillPrice).toBeCloseTo(100.05, 8);
    expect(longResult.exitFillPrice).toBeCloseTo(104.9475, 8);
  });

  it("does not open when delayed entry already crossed stop or take profit", async () => {
    const item = candidate("BTCUSDT", 100);
    const result = await simulateIpv1Execution({
      candidate: item,
      decisionTime: BASE_TIME,
      asOfMs: BASE_TIME + 180_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([candle(BASE_TIME + 60_000, 105, 105, 105, 105)]),
    });
    expect(result.status).toBe("NOT_EXECUTABLE_AT_DECISION");
    expect(result.opened).toBe(false);
  });

  it("uses STOP_FIRST for same candle and TIME_LIMIT at first close past validUntil", async () => {
    const bothHit = candidate("BTCUSDT", 100, { validUntil: BASE_TIME + 10 * 60_000 });
    const stopFirst = await simulateIpv1Execution({
      candidate: bothHit,
      decisionTime: BASE_TIME,
      asOfMs: BASE_TIME + 180_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([
        candle(BASE_TIME + 60_000, 100, 100, 100, 100),
        candle(BASE_TIME + 120_000, 100, 105, 94, 100),
      ]),
    });
    expect(stopFirst.exitReason).toBe("STOP_LOSS");

    const timeLimited = candidate("ETHUSDT", 100, { validUntil: BASE_TIME + 120_000 });
    const timeExit = await simulateIpv1Execution({
      candidate: timeLimited,
      decisionTime: BASE_TIME,
      asOfMs: BASE_TIME + 240_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([
        candle(BASE_TIME + 60_000, 100, 100, 100, 100),
        candle(BASE_TIME + 120_000, 101, 101, 101, 101),
      ]),
    });
    expect(timeExit.exitReason).toBe("TIME_LIMIT");
  });

  it("fails closed for missing market data and missing history through validUntil", async () => {
    const missing = await simulateIpv1Execution({
      candidate: candidate("BTCUSDT", 100),
      decisionTime: BASE_TIME,
      asOfMs: BASE_TIME + 120_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([]),
    });
    expect(missing.status).toBe("DATA_INVALID");
    const expired = await simulateIpv1Execution({
      candidate: candidate("BTCUSDT", 100, { validUntil: BASE_TIME + 120_000 }),
      decisionTime: BASE_TIME,
      asOfMs: BASE_TIME + 240_000,
      executionModel: IPV1_PRIMARY_EXECUTION,
      provider: provider([candle(BASE_TIME + 60_000, 100)]),
    });
    expect(expired.status).toBe("DATA_INVALID");
  });
});

describe("IPV-1 metrics and email pilot gate", () => {
  it("uses net PnL for PF and deterministic chronological DD", () => {
    const decisions = [
      closedExecution(10, 0.2, BASE_TIME + 60_000, BASE_TIME + 120_000),
      closedExecution(-20, -0.4, BASE_TIME + 120_000, BASE_TIME + 180_000),
      closedExecution(5, 0.1, BASE_TIME + 180_000, BASE_TIME + 240_000),
    ];
    const summary = summarizeIpv1Replay([...decisions].reverse());
    expect(summary.netProfitFactor).toBe(15 / 20);
    expect(summary.maxDrawdownUsdt).toBe(20);
    expect(summary.maxDrawdownR).toBeCloseTo(0.4, 8);
  });

  it("collects below 20 closed trades and evaluates at exactly 20", () => {
    expect(evaluateIpv1EmailPilotGate(metrics({ closedTrades: 19 }), metrics({ closedTrades: 19 }), metrics({ closedTrades: 19 })).status)
      .toBe(IPV1_GATE_COLLECTING);
    expect(evaluateIpv1EmailPilotGate(
      metrics({ netPnlUsdt: 50, netProfitFactor: 1.2, maxDrawdownR: 3 }),
      metrics(),
      metrics(),
    ).status).toBe(IPV1_GATE_PASS);
  });

  const gateFailures: Array<[string, Partial<Ipv1Metrics>, Partial<Ipv1Metrics>]> = [
    ["PF 1.09", { netProfitFactor: 1.09 }, {}],
    ["stress negative", {}, { netPnlUsdt: -1 }],
    ["baseline comparison", { netPnlUsdt: 50 }, {}],
    ["winner concentration", { largestWinningTradeGrossProfitContributionPct: 36 }, {}],
    ["entry days", { distinctUtcEntryDays: 2 }, {}],
  ];

  it.each(gateFailures)("fails the pilot gate for %s", (_label, challengerPatch, stressPatch) => {
    const result = evaluateIpv1EmailPilotGate(metrics(), metrics(challengerPatch), metrics(stressPatch));
    expect(result.status).toBe(IPV1_GATE_FAIL);
    expect(result.eligibleForEmailPilotReview).toBe(false);
  });

  it("fails closed on invalid data and has no automatic email or promotion", () => {
    const result = evaluateIpv1EmailPilotGate(metrics(), metrics(), metrics(), true);
    expect(result.status).toBe(IPV1_GATE_FAIL);
    expect(result.invalidData).toBe(true);
    expect(result.automaticPromotion).toBe(false);
    expect(result.signalEmailEnabled).toBe(false);
  });
});

describe("IPV-1 safety contract", () => {
  it("does not add an email/trading/write path", () => {
    const sources = [
      "lib/ipv1/types.ts",
      "lib/ipv1/replay.ts",
      "lib/ipv1/execution.ts",
      "lib/ipv1/metrics.ts",
      "lib/ipv1/gate.ts",
      "scripts/run-ipv1.ts",
    ].map((file) => readFileSync(resolve(process.cwd(), file), "utf8")).join("\n");
    expect(sources).not.toMatch(/\.from\([^)]*\)\s*\.(insert|update|delete|upsert|rpc)\s*\(/);
    expect(sources).not.toMatch(/createOrder|newOrder|cancelOrder|positionRisk|account/i);
    expect(sources).not.toContain("Date.now()");
    expect(IPV1_BASELINE_STRATEGY_VERSION).toBe("default-trend-shadow-v1");
    expect(IPV1_CHALLENGER_STRATEGY_VERSION).toBe("default-trend-shadow-v2-stopband-filter");
  });
});
