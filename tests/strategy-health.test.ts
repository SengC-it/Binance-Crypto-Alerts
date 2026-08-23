import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRODUCTION_STRATEGY_VERSION, SHADOW_STRATEGY_VERSION } from "../lib/core/production-policy";
import {
  DEFAULT_STRATEGY_HEALTH_POLICY,
  buildStrategyHealthEvent,
  evaluateStrategyHealth,
} from "../lib/core/strategy-health";
import { loadProspectiveStrategyHealth } from "../lib/services/strategy-health";
import {
  productionHealth11Trades,
  productionHealthAcceptanceSummary,
} from "./fixtures/production-health-11-trades";

describe("Production Strategy Health Gate", () => {
  it("fails closed on the current 11-trade Production regression fixture", () => {
    const decision = evaluateStrategyHealth(productionHealth11Trades);

    expect(productionHealthAcceptanceSummary.trades).toBe(11);
    expect(productionHealthAcceptanceSummary.takeProfitTrades).toBe(1);
    expect(productionHealthAcceptanceSummary.stopLossTrades).toBe(10);
    expect(decision.status).toBe("FAIL_CLOSED");
    expect(decision.productionAAllowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "rolling_average_net_r",
      "rolling_profit_factor",
      "rolling_stop_rate",
      "rolling_lower_confidence_bound",
    ]));
    expect(decision.metrics.rollingTrades).toBe(11);
    expect(decision.metrics.rollingAverageNetR).toBeCloseTo(productionHealthAcceptanceSummary.averageNetR, 3);
    expect(decision.metrics.rollingProfitFactor).toBeCloseTo(productionHealthAcceptanceSummary.profitFactor, 3);
    expect(decision.metrics.rollingStopRate).toBeCloseTo(productionHealthAcceptanceSummary.stopRate, 3);
  });

  it("returns UNKNOWN and blocks email for zero or nine settled trades", () => {
    expect(evaluateStrategyHealth([])).toMatchObject({ status: "UNKNOWN", productionAAllowed: false });
    expect(evaluateStrategyHealth(productionHealth11Trades.slice(0, 9))).toMatchObject({
      status: "UNKNOWN",
      productionAAllowed: false,
    });
  });

  it("returns HEALTHY for ten healthy settled trades", () => {
    const decision = evaluateStrategyHealth(Array.from({ length: 10 }, (_, index) => ({
      entryTime: index,
      rMultiple: 0.2,
      exitReason: "TAKE_PROFIT",
    })));

    expect(decision.status).toBe("HEALTHY");
    expect(decision.productionAAllowed).toBe(true);
  });

  it("fails closed when average R or PF collapses", () => {
    const poorAverage = evaluateStrategyHealth(Array.from({ length: 10 }, (_, index) => ({
      entryTime: index,
      rMultiple: -0.5,
      exitReason: "TIME_LIMIT",
    })));
    const poorPf = evaluateStrategyHealth([
      { entryTime: 0, rMultiple: 0.1, exitReason: "TAKE_PROFIT" },
      ...Array.from({ length: 9 }, (_, index) => ({ entryTime: index + 1, rMultiple: -0.1, exitReason: "TIME_LIMIT" })),
    ]);

    expect(poorAverage.status).toBe("FAIL_CLOSED");
    expect(poorAverage.reasons).toContain("rolling_average_net_r");
    expect(poorPf.status).toBe("FAIL_CLOSED");
    expect(poorPf.reasons).toContain("rolling_profit_factor");
  });

  it("fails closed at a 90% stop rate", () => {
    const decision = evaluateStrategyHealth([
      { entryTime: 0, rMultiple: 0.2, exitReason: "TAKE_PROFIT" },
      ...Array.from({ length: 9 }, (_, index) => ({ entryTime: index + 1, rMultiple: -0.1, exitReason: "STOP_LOSS" })),
    ]);

    expect(decision.status).toBe("FAIL_CLOSED");
    expect(decision.reasons).toContain("rolling_stop_rate");
  });

  it("returns UNKNOWN when the health query fails", async () => {
    const supabase = fakeSupabase({ data: null, error: { message: "database unavailable" } });
    const decision = await loadProspectiveStrategyHealth(supabase, PRODUCTION_STRATEGY_VERSION);

    expect(decision.status).toBe("UNKNOWN");
    expect(decision.productionAAllowed).toBe(false);
    expect(decision.reasons[0]).toContain("health_query_failed");
  });

  it("uses WARNING events with status-specific severity", () => {
    const failClosed = evaluateStrategyHealth(productionHealth11Trades);
    const degraded = evaluateStrategyHealth([
      ...Array.from({ length: 5 }, (_, index) => ({
        entryTime: index,
        rMultiple: 0.2,
        exitReason: "TAKE_PROFIT",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        entryTime: index + 5,
        rMultiple: -0.3,
        exitReason: "TIME_LIMIT",
      })),
    ]);
    const unknown = evaluateStrategyHealth([]);

    expect(failClosed.status).toBe("FAIL_CLOSED");
    expect(degraded.status).toBe("DEGRADED");
    expect(unknown.status).toBe("UNKNOWN");
    expect(buildStrategyHealthEvent(failClosed, 0)).toMatchObject({
      eventType: "WARNING",
      severity: "CRITICAL",
    });
    expect(buildStrategyHealthEvent(degraded, 0)).toMatchObject({
      eventType: "WARNING",
      severity: "WARNING",
    });
    expect(buildStrategyHealthEvent(unknown, 0)).toMatchObject({
      eventType: "WARNING",
      severity: "WARNING",
    });
    expect(failClosed.productionAAllowed).toBe(false);
    expect(degraded.productionAAllowed).toBe(false);
    expect(unknown.productionAAllowed).toBe(false);
  });

  it("records the health event only for batch zero", () => {
    const failed = evaluateStrategyHealth(productionHealth11Trades);

    expect(buildStrategyHealthEvent(failed, 0)).not.toBeNull();
    expect(buildStrategyHealthEvent(failed, 1)).toBeNull();
  });

  it("does not change paper tracking or strategy selection boundaries", () => {
    const failed = evaluateStrategyHealth(productionHealth11Trades);

    expect(failed.productionAAllowed).toBe(false);
    expect(SHADOW_STRATEGY_VERSION).toBe("default-trend-shadow-v1");
    expect(PRODUCTION_STRATEGY_VERSION).toBe("trend-rejection-short-v1");
    expect(DEFAULT_STRATEGY_HEALTH_POLICY.minimumRollingTrades).toBe(10);
  });
});

function fakeSupabase(result: { data: unknown; error: { message: string } | null }): SupabaseClient {
  return {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        range: async () => result,
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
