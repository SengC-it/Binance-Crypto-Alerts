import { describe, expect, it } from "vitest";
import { V19_INTERVAL_MS } from "../lib/v19/constants";
import type { V19Bar } from "../lib/v19/features";
import {
  bootstrapClusterMean,
  compactSeries,
  settleV19Identity,
  type V19OutcomeIdentity,
} from "../lib/v19/result-engine";

describe("V19 result settlement", () => {
  it("uses the exact next 5m open rather than the signal close", () => {
    const interval = V19_INTERVAL_MS;
    const series = compactSeries("ADAUSDT", [
      testBar(0, 99, 100),
      testBar(interval, 100, 100),
      testBar(2 * interval, 101, 101),
      testBar(3 * interval, 102, 102),
      testBar(4 * interval, 103, 103),
      testBar(5 * interval, 104, 104),
    ]);
    const outcome = settleV19Identity(identity({
      nextExecutionOpenTime: 2 * interval,
      executionReferencePrice: 101,
      primaryExitCloseTime: 6 * interval - 1,
    }), new Map([["ADAUSDT", series]]));

    expect(outcome.status).toBe("SETTLED");
    expect(outcome.entryPrice).toBe(101);
    expect(outcome.entryPrice).not.toBe(100);
    expect(outcome.exitPrice).toBe(104);
    expect(outcome.feeCost).toBeCloseTo(0.0008);
    expect(outcome.slippageCost).toBeCloseTo(0.0006);
  });

  it("fails closed when the exact execution reference is unavailable", () => {
    const interval = V19_INTERVAL_MS;
    const series = compactSeries("ADAUSDT", [
      testBar(0, 99, 100),
      testBar(interval, 100, 100),
      testBar(3 * interval, 102, 102),
      testBar(4 * interval, 103, 103),
      testBar(5 * interval, 104, 104),
    ]);
    const outcome = settleV19Identity(identity({
      nextExecutionOpenTime: 2 * interval,
      executionReferencePrice: 101,
      primaryExitCloseTime: 6 * interval - 1,
    }), new Map([["ADAUSDT", series]]));

    expect(outcome).toMatchObject({
      status: "OUTCOME_DATA_UNAVAILABLE",
      unavailableReason: "EXACT_ENTRY_OR_EXIT_MISSING",
    });
  });

  it("keeps cluster bootstrap deterministic and uses the requested sample count", () => {
    const outcomes = [
      settled("2022-01-01T00:00:00.000Z", 0, 0.01),
      settled("2022-01-01T00:00:00.000Z", V19_INTERVAL_MS, 0.03),
      settled("2022-01-02T00:00:00.000Z", 2 * V19_INTERVAL_MS, -0.02),
    ];
    const first = bootstrapClusterMean(outcomes, "baselineNetReturn", 10_000, 19_019);
    const second = bootstrapClusterMean(outcomes, "baselineNetReturn", 10_000, 19_019);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ clusters: 2, samples: 10_000, seed: 19_019 });
    expect(first.lcb95).toBeTypeOf("number");
  });
});

function identity(overrides: Partial<V19OutcomeIdentity> = {}): V19OutcomeIdentity {
  return {
    btcShockTimestamp: "2022-01-01T00:00:00.000Z",
    signalTimestamp: "2022-01-01T00:04:59.999Z",
    signalOpenTime: V19_INTERVAL_MS,
    follower: "ADAUSDT",
    side: "LONG",
    nextExecutionOpenTime: 2 * V19_INTERVAL_MS,
    executionReferencePrice: 101,
    primaryExitCloseTime: 6 * V19_INTERVAL_MS - 1,
    evaluationWindow: "PRIMARY_OOS",
    ...overrides,
  };
}

function settled(cluster: string, signalOpenTime: number, net: number) {
  return {
    identity: identity({ btcShockTimestamp: cluster, signalOpenTime }),
    status: "SETTLED" as const,
    grossReturn: net,
    feeCost: 0,
    slippageCost: 0,
    baselineNetReturn: net,
  };
}

function testBar(openTime: number, open: number, close: number): V19Bar {
  return {
    openTime,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    closeTime: openTime + V19_INTERVAL_MS - 1,
    quoteVolume: 1,
    tradeCount: 1,
    takerBuyBaseVolume: 0,
    takerBuyQuoteVolume: 0,
  };
}
