import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_EXPERIMENT_ID,
  PRC1_FILTER_RULE,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
  isPrc1ForwardEligible,
} from "@/lib/prc1/contract";
import {
  assertForwardWindow,
  comparePrc1ForwardTrades,
  loadPrc1ForwardComparison,
  summarizePrc1Trades,
  type Prc1ForwardTradeRow,
} from "@/lib/prc1/metrics";
import {
  PRC1_DATA_INVALID,
  PRC1_FORWARD_GATE_COLLECTING,
  PRC1_FORWARD_GATE_FAIL,
  PRC1_FORWARD_GATE_PASS,
  evaluatePrc1ForwardGate,
} from "@/lib/prc1/gate";
import {
  buildPrc1ChallengerMetadata,
  plannedStopDistancePct,
  selectChallengerOpportunity,
  stopBandFilterPass,
} from "@/lib/prc1/stopband";
import type { TradePlan } from "@/lib/core/types";

const routeSource = readFileSync(resolve(process.cwd(), "app/api/scan/route.ts"), "utf8");
const paperTradingSource = readFileSync(resolve(process.cwd(), "lib/services/paper-trading.ts"), "utf8");
const releasePolicySource = readFileSync(resolve(process.cwd(), "lib/core/release-policy.ts"), "utf8");

function plan(stopPrice: number, entryPrice = 100): TradePlan {
  return {
    entryPrice,
    stopPrice,
    takeProfitPrice: 95,
    rewardRisk: 2,
    assumedMarginUsdt: 100,
    assumedLeverage: 20,
    positionNotionalUsdt: 2_000,
    quantity: 20,
    theoreticalRiskUsdt: Math.abs(stopPrice - entryPrice) * 20,
    riskOverSingleCap: false,
    validUntil: 1_800_000_000_000,
  };
}

interface ForwardTradeOverrides {
  id?: string | number;
  entryTime?: string;
  exitTime?: string | null;
  grossPnl?: number | null;
}

function forwardTrade(
  strategyVersion: string,
  index: number,
  pnl: number | null,
  rMultiple: number | null = pnl === null ? null : pnl / 50,
  overrides: ForwardTradeOverrides = {},
): Prc1ForwardTradeRow {
  const entryMs = Date.parse("2026-09-13T00:00:00.000Z") + index * 3_600_000;
  return {
    id: overrides.id ?? `${strategyVersion}-${index}`,
    strategy_version: strategyVersion,
    entry_time: overrides.entryTime ?? new Date(entryMs).toISOString(),
    exit_time: overrides.exitTime === undefined
      ? new Date(entryMs + 3_600_000).toISOString()
      : overrides.exitTime,
    status: pnl !== null && pnl > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    net_pnl_usdt: pnl,
    gross_pnl_usdt: overrides.grossPnl === undefined ? pnl : overrides.grossPnl,
    r_multiple: rMultiple,
  };
}

function rowsFor(
  strategyVersion: string,
  pnls: number[],
  rMultiple = 0.1,
  grossPnl = pnls,
): Prc1ForwardTradeRow[] {
  return pnls.map((pnl, index) => forwardTrade(
    strategyVersion,
    index,
    pnl,
    rMultiple,
    { grossPnl: grossPnl[index] },
  ));
}

function comparisonForCounts(challengerCount: number) {
  return comparePrc1ForwardTrades(
    rowsFor(PRC1_BASELINE_STRATEGY_VERSION, Array.from({ length: challengerCount }, () => 1)),
    rowsFor(PRC1_CHALLENGER_STRATEGY_VERSION, Array.from({ length: challengerCount }, () => 1)),
  );
}

function passingComparison() {
  return comparePrc1ForwardTrades(
    rowsFor(PRC1_BASELINE_STRATEGY_VERSION, [
      ...Array.from({ length: 30 }, () => 2),
      ...Array.from({ length: 20 }, () => -1),
    ], 0.1),
    rowsFor(PRC1_CHALLENGER_STRATEGY_VERSION, [
      ...Array.from({ length: 35 }, () => 2),
      ...Array.from({ length: 15 }, () => -1),
    ], 0.2),
  );
}

describe("PRC-1 stop-distance challenger", () => {
  it("uses the planned entry and stop, not a fill or outcome", () => {
    expect(plannedStopDistancePct(plan(102.5))).toBe(2.5);
    expect(stopBandFilterPass(plan(102.499999))).toBe(true);
    expect(stopBandFilterPass(plan(102.5))).toBe(false);
    expect(stopBandFilterPass(plan(103.499999))).toBe(false);
    expect(stopBandFilterPass(plan(103.5))).toBe(true);
  });

  it("uses the exact frozen exclusion boundaries", () => {
    expect(plannedStopDistancePct(plan(102.499999))).toBeCloseTo(2.499999, 6);
    expect(plannedStopDistancePct(plan(102.5))).toBe(2.5);
    expect(plannedStopDistancePct(plan(103.499999))).toBeCloseTo(3.499999, 6);
    expect(plannedStopDistancePct(plan(103.5))).toBeCloseTo(3.5, 12);
  });

  it("selects the first ranked candidate outside the band", () => {
    const opportunities = [
      { id: "top-rejected", plan: plan(102.5) },
      { id: "second-accepted", plan: plan(104) },
      { id: "third-accepted", plan: plan(105) },
    ];
    expect(selectChallengerOpportunity(opportunities)?.id).toBe("second-accepted");
    expect(selectChallengerOpportunity([{ id: "only", plan: plan(103) }])).toBeUndefined();
  });

  it("freezes challenger metadata and the forward-only timestamp", () => {
    const metadata = buildPrc1ChallengerMetadata({
      plan: plan(104),
      sourceDataTimestamp: Date.parse("2026-09-13T00:00:00.000Z"),
      runtimeCommitSha: "runtime-test",
    });
    expect(metadata).toMatchObject({
      experimentId: PRC1_EXPERIMENT_ID,
      challengerVersion: PRC1_CHALLENGER_STRATEGY_VERSION,
      hypothesisFrozenAtUtc: PRC1_HYPOTHESIS_FROZEN_AT_UTC,
      plannedStopDistancePct: 4,
      filterRule: PRC1_FILTER_RULE,
      baselineStrategyVersion: PRC1_BASELINE_STRATEGY_VERSION,
      sourceDataTimestamp: "2026-09-13T00:00:00.000Z",
      runtimeCommitSha: "runtime-test",
    });
    expect(isPrc1ForwardEligible(Date.parse("2026-09-12T23:46:20.665Z"))).toBe(false);
    expect(isPrc1ForwardEligible(Date.parse(PRC1_HYPOTHESIS_FROZEN_AT_UTC))).toBe(true);
  });

  it("uses NET PnL for profit factor even when gross PnL looks profitable", () => {
    const summary = summarizePrc1Trades([
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, -1, -0.1, { grossPnl: 10 }),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 1, -5, -0.5, { grossPnl: -5 }),
    ]);
    expect(summary).toMatchObject({
      netProfit: 0,
      netLoss: 6,
      profitFactor: 0,
      grossProfit: 10,
      grossLoss: 5,
    });
    expect(summary.grossMetrics.diagnosticOnly).toBe(true);
    expect(summary.profitFactor).not.toBe(2);
  });

  it("fails the gate when fees and funding turn gross profitability into net loss", () => {
    const comparison = comparePrc1ForwardTrades(
      rowsFor(PRC1_BASELINE_STRATEGY_VERSION, Array.from({ length: 50 }, () => -1), 0.1, Array.from({ length: 50 }, () => -0.5)),
      rowsFor(PRC1_CHALLENGER_STRATEGY_VERSION, Array.from({ length: 50 }, () => -1), 0.1, Array.from({ length: 50 }, () => 2)),
    );
    expect(comparison.challenger.grossProfit).toBe(100);
    expect(comparison.challenger.netPnlUsdt).toBe(-50);
    expect(evaluatePrc1ForwardGate(comparison).classification).toBe(PRC1_FORWARD_GATE_FAIL);
  });

  it("computes identical max drawdown for chronological, reverse, and shuffled inputs", () => {
    const chronological = [
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, 10),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 1, -20),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 2, 5),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 3, -1),
    ];
    const expected = summarizePrc1Trades(chronological).maxDrawdown;
    expect(expected).toBe(20);
    expect(summarizePrc1Trades([...chronological].reverse()).maxDrawdown).toBe(expected);
    expect(summarizePrc1Trades([chronological[2], chronological[0], chronological[3], chronological[1]]).maxDrawdown).toBe(expected);
  });

  it("orders ties by exit_time and then id", () => {
    const entryTime = "2026-09-13T00:00:00.000Z";
    const exitTime = "2026-09-13T01:00:00.000Z";
    const rows = [
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, 5, 0.1, { id: "b", entryTime, exitTime }),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 1, -10, -0.1, { id: "a", entryTime, exitTime }),
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 2, -1, -0.1, { id: "c", entryTime, exitTime: "2026-09-13T02:00:00.000Z" }),
    ];
    expect(summarizePrc1Trades(rows).maxDrawdown).toBe(10);
  });

  it("requires an explicit forward window at or after the frozen hypothesis", async () => {
    expect(() => assertForwardWindow("2026-09-12T23:46:20.665Z", "2026-09-13T00:00:00.000Z"))
      .toThrow("DATA_INVALID");
    expect(() => assertForwardWindow("2026-09-13T00:00:00.000Z", "2026-09-12T23:59:00.000Z"))
      .toThrow("DATA_INVALID");

    const calls: string[] = [];
    const query: any = {
      from(table: string) { calls.push(`from:${table}`); return query; },
      select(columns: string) { calls.push(`select:${columns}`); return query; },
      in(column: string) { calls.push(`in:${column}`); return query; },
      gte(column: string, value: string) { calls.push(`gte:${column}:${value}`); return query; },
      lt(column: string, value: string) { calls.push(`lt:${column}:${value}`); return query; },
      order(column: string, options: { ascending: boolean }) { calls.push(`order:${column}:${options.ascending}`); return query; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    await loadPrc1ForwardComparison(
      { from: query.from } as unknown as SupabaseClient,
      "2026-09-13T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
    );
    expect(calls).toEqual([
      "from:bca_shadow_paper_trades",
      "select:id,strategy_version,entry_time,exit_time,status,net_pnl_usdt,gross_pnl_usdt,r_multiple",
      "in:strategy_version",
      "gte:entry_time:2026-09-13T00:00:00.000Z",
      "lt:entry_time:2026-09-14T00:00:00.000Z",
      "order:entry_time:true",
      "order:exit_time:true",
      "order:id:true",
    ]);
  });

  it("fails closed for invalid closed net PnL and R multiple", () => {
    expect(() => summarizePrc1Trades([
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, null, 0.1),
    ])).toThrow("DATA_INVALID");
    expect(() => summarizePrc1Trades([
      forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, 1, null),
    ])).toThrow("DATA_INVALID");
    const comparison = passingComparison();
    const invalid = {
      ...comparison,
      challenger: { ...comparison.challenger, avgR: Number.NaN },
    };
    expect(evaluatePrc1ForwardGate(invalid).status).toBe(PRC1_DATA_INVALID);
    expect(evaluatePrc1ForwardGate(invalid).eligibleForHumanPromotionReview).toBe(false);
  });

  it("keeps collecting status and interim diagnostic eligibility at the frozen counts", () => {
    expect(evaluatePrc1ForwardGate(comparisonForCounts(19))).toMatchObject({
      status: PRC1_FORWARD_GATE_COLLECTING,
      classification: null,
      interimDiagnosticEligible: false,
    });
    expect(evaluatePrc1ForwardGate(comparisonForCounts(20))).toMatchObject({
      status: PRC1_FORWARD_GATE_COLLECTING,
      classification: null,
      interimDiagnosticEligible: true,
    });
    expect(evaluatePrc1ForwardGate(comparisonForCounts(49)).classification).toBeNull();
  });

  it("passes exactly at 50 only when every frozen criterion passes", () => {
    const evaluation = evaluatePrc1ForwardGate(passingComparison());
    expect(evaluation).toMatchObject({
      status: PRC1_FORWARD_GATE_PASS,
      classification: PRC1_FORWARD_GATE_PASS,
      invalidData: false,
      eligibleForHumanPromotionReview: true,
      automaticPromotion: false,
      signalEmailEnabled: false,
    });
    expect(Object.values(evaluation.criteria).every((criterion) => criterion.pass)).toBe(true);
  });

  it.each([
    ["net PnL", { netPnlUsdt: -1 }],
    ["net PF", { profitFactor: 1.19 }],
    ["Avg R", { avgPnl: 1, avgR: -0.01 }],
    ["drawdown comparison", { maxDrawdown: passingComparison().baseline.maxDrawdown }],
    ["baseline PF comparison", { profitFactor: passingComparison().baseline.profitFactor }],
    ["single-winner concentration", { grossProfitContributionLargestTradePct: 36 }],
  ])("fails independently when the frozen %s criterion is broken", (_label, challengerPatch) => {
    const comparison = passingComparison();
    const broken = {
      ...comparison,
      challenger: { ...comparison.challenger, ...challengerPatch },
    };
    expect(evaluatePrc1ForwardGate(broken).classification).toBe(PRC1_FORWARD_GATE_FAIL);
  });

  it("keeps baseline behavior, strategy isolation, and release hard kills", () => {
    expect(routeSource).toContain("const shadowOpportunity = finalShadowCandidates[0];");
    expect(routeSource).toContain("const challengerOpportunity = selectChallengerOpportunity(finalShadowCandidates);");
    expect(routeSource).toContain("isPrc1ForwardEligible(challengerOpportunity.sourceTimestamp)");
    expect(routeSource).toContain("strategyVersion: PRC1_CHALLENGER_STRATEGY_VERSION");
    expect(routeSource).toContain("metadata: buildPrc1ChallengerMetadata");
    expect(paperTradingSource).toContain(".eq(\"strategy_version\", input.strategyVersion)");
    expect(paperTradingSource).toContain("return insertPaperTrade(supabase, PRODUCTION_PAPER_TABLE, input, { signal_id: input.signalId });");
    expect(releasePolicySource).toContain("PRODUCTION_SIGNAL_EMAIL_ENABLED = false");
    expect(releasePolicySource).toContain("AUTOMATIC_TRADING_ENABLED = false");
    expect(releasePolicySource).toContain("ORDER_PLACEMENT_ENABLED = false");
    expect(routeSource).not.toContain("sendSignalEmail({\n          symbol: challengerOpportunity");
  });
});
