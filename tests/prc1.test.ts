import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_EXPERIMENT_ID,
  PRC1_FILTER_RULE,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
  isPrc1ForwardEligible,
} from "@/lib/prc1/contract";
import { comparePrc1ForwardTrades, summarizePrc1Trades, type Prc1ForwardTradeRow } from "@/lib/prc1/metrics";
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

function forwardTrade(
  strategyVersion: string,
  index: number,
  pnl: number,
  rMultiple = pnl / 50,
): Prc1ForwardTradeRow {
  const entry = `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
  return {
    strategy_version: strategyVersion,
    entry_time: entry,
    exit_time: `2026-09-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
    status: pnl > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    net_pnl_usdt: pnl,
    gross_pnl_usdt: pnl,
    r_multiple: rMultiple,
  };
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

  it("summarizes the same forward window without changing the stored rows", () => {
    const baselineRows = [forwardTrade(PRC1_BASELINE_STRATEGY_VERSION, 0, 10), forwardTrade(PRC1_BASELINE_STRATEGY_VERSION, 1, -5)];
    const challengerRows = [forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, 20), forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 1, -5)];
    const baselineBefore = JSON.stringify(baselineRows);
    const challengerBefore = JSON.stringify(challengerRows);
    const summary = comparePrc1ForwardTrades(baselineRows, challengerRows);

    expect(summary.baseline).toMatchObject({ closedTrades: 2, netPnlUsdt: 5, grossProfit: 10, grossLoss: 5, profitFactor: 2, maxDrawdown: 5 });
    expect(summary.challenger).toMatchObject({ closedTrades: 2, netPnlUsdt: 15, grossProfit: 20, grossLoss: 5, profitFactor: 4, maxDrawdown: 5 });
    expect(summary.difference.netPnlUsdt).toBe(10);
    expect(JSON.stringify(baselineRows)).toBe(baselineBefore);
    expect(JSON.stringify(challengerRows)).toBe(challengerBefore);
    expect(summarizePrc1Trades([{ ...forwardTrade(PRC1_CHALLENGER_STRATEGY_VERSION, 0, 20), status: "OPEN", exit_time: null }]).closedTrades).toBe(0);
  });

  it("keeps baseline selection, independent shadow state, and all release kills", () => {
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
