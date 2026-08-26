import { describe, expect, it } from "vitest";
import {
  V56_CANDIDATE_REGISTRY,
  V56_CONTROL_B_ID,
  V56_MAX_CANDIDATES,
  buildParetoFrontier,
  calculateCvar95,
  calculateYieldMetrics,
  canonicalResearchTradeKey,
  selectionScore,
} from "../lib/v5-6/research";
import { calculateMetrics } from "../lib/v5-2/validation";

describe("V5.6 finite profitability research boundary", () => {
  it("keeps the preregistered registry finite and retains the frozen Control B parameters", () => {
    expect(V56_CANDIDATE_REGISTRY.length).toBeLessThanOrEqual(V56_MAX_CANDIDATES);
    expect(V56_CANDIDATE_REGISTRY).toHaveLength(12);
    const control = V56_CANDIDATE_REGISTRY.find((candidate) => candidate.id === V56_CONTROL_B_ID);
    expect(control).toMatchObject({
      sourceCandidateId: "SHORT-FAILED_BREAKOUT_SHORT-02",
      isControl: true,
      side: "SHORT",
      rewardRisk: 1.8,
      stopStyle: "STRUCTURE",
      parameters: {
        breakoutLookback: 20,
        volumeRatioMin: 1.35,
        retestDistanceATR: 0.6,
        maxExtensionATR: 0.8,
      },
    });
  });

  it("does not treat an observed result as a new candidate or promote the Production path", () => {
    expect(V56_CANDIDATE_REGISTRY.some((candidate) => candidate.id === "trend-rejection-short-v1")).toBe(false);
    expect(V56_CANDIDATE_REGISTRY.every((candidate) => candidate.id !== "v55-fbos02-forward-002")).toBe(true);
    expect(V56_CANDIDATE_REGISTRY.filter((candidate) => candidate.isControl)).toHaveLength(1);
  });
});

describe("V5.6 research metrics", () => {
  const trades = [
    { symbol: "BTCUSDT", side: "SHORT" as const, entryTime: 0, exitTime: 1, rMultiple: -2 },
    { symbol: "ETHUSDT", side: "SHORT" as const, entryTime: 86_400_000, exitTime: 86_400_001, rMultiple: 1 },
    { symbol: "BTCUSDT", side: "SHORT" as const, entryTime: 2 * 86_400_000, exitTime: 2 * 86_400_001, rMultiple: 2 },
    { symbol: "SOLUSDT", side: "SHORT" as const, entryTime: 3 * 86_400_000, exitTime: 3 * 86_400_001, rMultiple: -1 },
  ];

  it("calculates a conservative lower-tail CVaR95", () => {
    expect(calculateCvar95(trades)).toBe(-2);
  });

  it("reports signal yield and breadth without using future outcome fields", () => {
    const yieldMetrics = calculateYieldMetrics(trades, 0, 4 * 86_400_000 - 1);
    expect(yieldMetrics.alertsPerWeek).toBeCloseTo(7);
    expect(yieldMetrics.symbolBreadth).toBe(3);
    expect(yieldMetrics.regimeBreadth).toBe(0);
    expect(yieldMetrics.maxSignalDroughtDays).toBe(1);
  });

  it("uses a deterministic selection score and keeps cost/risk inputs visible", () => {
    const metrics = calculateMetrics(trades);
    expect(selectionScore(metrics, 2)).toBe(selectionScore(metrics, 2));
    expect(selectionScore(metrics, 2)).toBeLessThan(selectionScore({ ...metrics, avgNetR: metrics.avgNetR + 0.1 }, 2));
  });

  it("builds a non-dominated Pareto frontier", () => {
    const frontier = buildParetoFrontier([
      { id: "dominated", netR: 1, alertsPerWeek: 1, maxDrawdownR: 5, cvar95: -2 },
      { id: "better", netR: 2, alertsPerWeek: 2, maxDrawdownR: 4, cvar95: -1 },
      { id: "tradeoff", netR: 3, alertsPerWeek: 0.5, maxDrawdownR: 3, cvar95: -1 },
    ]);
    expect(frontier.map((row) => row.id)).toEqual(expect.arrayContaining(["better", "tradeoff"]));
    expect(frontier.map((row) => row.id)).not.toContain("dominated");
  });

  it("uses symbol/side/time identity for research deduplication", () => {
    expect(canonicalResearchTradeKey(trades[0])).toBe("BTCUSDT|SHORT|0|1");
  });
});
