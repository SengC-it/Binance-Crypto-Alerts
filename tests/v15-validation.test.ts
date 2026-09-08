import { describe, expect, it } from "vitest";
import {
  V15_CONSTANTS,
  blockBootstrapLcb,
  buildFeatureSnapshot,
  buildPitThresholds,
  buildTradePlan,
  isClosedBefore,
  manualEntryTime,
  netReturnFromGross,
  nextExecutableOpen,
  normalizeBinanceTimestamp,
  passesCapacity,
  qualifiesPrimarySignal,
  simulateAdverseBracket,
  type V15Bar,
  type V15FeatureSnapshot,
} from "@/lib/v15/lead-lag";

function bar(openTime: number, open: number, close = open, overrides: Partial<V15Bar> = {}): V15Bar {
  return { openTime, closeTime: openTime + 299_999, open, high: Math.max(open, close), low: Math.min(open, close), close, quoteVolume: 100, takerBuyQuoteVolume: 60, ...overrides };
}

function featureWindow(decisionTime: number, firstOpen: number, open = 100, close = 101): V15Bar[] {
  return Array.from({ length: 6 }, (_, index) => bar(firstOpen + index * 300_000, open, index === 5 ? close : open));
}

describe("V15 spot-led perpetual catch-up primitives", () => {
  it("normalizes milliseconds and 2025 microseconds independently", () => {
    expect(normalizeBinanceTimestamp(1704067200000)).toBe(1704067200000);
    expect(normalizeBinanceTimestamp(1735689600000000)).toBe(1735689600000);
  });

  it("uses only six closed 5m bars for the 30m features", () => {
    const decisionTime = Date.UTC(2024, 0, 1, 10, 0);
    const past = featureWindow(decisionTime, decisionTime - 30 * 60_000, 100, 110);
    const future = bar(decisionTime, 110, 999_999, { high: 1_000_000, low: 1, quoteVolume: 999_999, takerBuyQuoteVolume: 999_999, closeTime: decisionTime + 299_999 });
    const snapshot = buildFeatureSnapshot("BTCUSDT", decisionTime, [...past, future], [...past, future]);
    expect(snapshot.spotReturn30).toBeCloseTo(0.1, 12);
    expect(snapshot.perpReturn30).toBeCloseTo(0.1, 12);
    expect(isClosedBefore(future, decisionTime)).toBe(false);
  });

  it("matches the preregistered flow and lead formulas", () => {
    const decisionTime = Date.UTC(2024, 0, 1, 10, 0);
    const spot = featureWindow(decisionTime, decisionTime - 30 * 60_000, 100, 110).map((item) => ({ ...item, quoteVolume: 10, takerBuyQuoteVolume: 8 }));
    const perp = featureWindow(decisionTime, decisionTime - 30 * 60_000, 100, 105).map((item) => ({ ...item, quoteVolume: 20, takerBuyQuoteVolume: 6 }));
    const snapshot = buildFeatureSnapshot("ETHUSDT", decisionTime, spot, perp);
    expect(snapshot.spotFlow30).toBeCloseTo(0.6, 12);
    expect(snapshot.perpFlow30).toBeCloseTo(-0.4, 12);
    expect(snapshot.leadStrength).toBeCloseTo(0.05, 12);
    expect(snapshot.spotDirectionalFlow).toBeCloseTo(0.6, 12);
    expect(snapshot.perpDirectionalFlow).toBeCloseTo(-0.4, 12);
  });

  it("requires consecutive closed windows", () => {
    const decisionTime = Date.UTC(2024, 0, 1, 10, 0);
    const bars = featureWindow(decisionTime, decisionTime - 30 * 60_000);
    bars[3] = { ...bars[3], openTime: bars[3].openTime + 60_000, closeTime: bars[3].closeTime + 60_000 };
    expect(() => buildFeatureSnapshot("BTCUSDT", decisionTime, bars, bars)).toThrow("consecutive");
  });

  it("requires Spot and Futures feature windows to be time aligned", () => {
    const decisionTime = Date.UTC(2024, 0, 1, 10, 0);
    const spot = featureWindow(decisionTime, decisionTime - 30 * 60_000);
    const perp = featureWindow(decisionTime, decisionTime - 30 * 60_000).map((item) => ({ ...item, openTime: item.openTime - 1, closeTime: item.closeTime - 1 }));
    expect(() => buildFeatureSnapshot("BTCUSDT", decisionTime, spot, perp)).toThrow("aligned");
  });

  it("builds fixed PIT thresholds without a parameter search", () => {
    const base = (spotShock: number, flow: number, lead: number): V15FeatureSnapshot => ({
      decisionTime: 1, symbol: "BTCUSDT", direction: 1, spotReturn30: spotShock, perpReturn30: spotShock - lead,
      spotFlow30: flow, perpFlow30: 0, spotQuoteVolume30: 1, perpQuoteVolume30: 1, spotTakerBuyQuote30: 1, perpTakerBuyQuote30: 1,
      spotShock, leadStrength: lead, spotDirectionalFlow: flow, perpDirectionalFlow: 0,
    });
    const history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => base(value, value / 20, value / 10));
    const thresholds = buildPitThresholds(history);
    expect(thresholds.spotShockQ90).toBe(9.1);
    expect(thresholds.absoluteSpotFlowQ75).toBeCloseTo(0.3875, 12);
    expect(thresholds.positiveLeadStrengthQ80).toBeCloseTo(0.82, 12);
    expect(qualifiesPrimarySignal(base(11, 0.8, 1), thresholds)).toBe(true);
    expect(qualifiesPrimarySignal(base(11, -0.8, 1), thresholds)).toBe(false);
  });

  it("uses the next executable futures open as the entry reference", () => {
    const signalTime = Date.UTC(2024, 0, 1, 10, 0);
    const entry = nextExecutableOpen([
      bar(signalTime - 300_000, 100, 100),
      bar(signalTime, 101, 500, { high: 900, low: 1 }),
    ], signalTime);
    expect(entry?.open).toBe(101);
    expect(entry?.open).not.toBe(500);
  });

  it("constructs stop, TP, risk, and max hold from the actual entry", () => {
    const plan = buildTradePlan(1, bar(10_000, 101), 2);
    expect(plan.entryPrice).toBe(101);
    expect(plan.riskPrice).toBe(3);
    expect(plan.stopPrice).toBe(98);
    expect(plan.takeProfitPrice).toBe(107);
    expect(plan.maxHoldMs).toBe(V15_CONSTANTS.maxHoldMs);
  });

  it("applies the adverse stop-first rule when both bracket levels are touched", () => {
    const plan = buildTradePlan(1, bar(10_000, 100), 2);
    expect(simulateAdverseBracket(plan, [bar(10_000, 100, 100, { high: 110, low: 90 })])).toEqual({ exitTime: 10_000, exitPrice: 97, reason: "STOP" });
  });

  it("uses the max-hold close when neither bracket is hit", () => {
    const plan = buildTradePlan(-1, bar(10_000, 100), 2);
    const result = simulateAdverseBracket(plan, [bar(10_000, 100, 100), bar(10_000 + 300_000, 100, 99)]);
    expect(result.reason).toBe("TIME");
    expect(result.exitPrice).toBe(99);
  });

  it("applies fixed fees, base slippage, and stress costs", () => {
    expect(netReturnFromGross(0.5, 0, 0)).toBeCloseTo(0.4988, 12);
    expect(netReturnFromGross(0.5, 0, 20)).toBeCloseTo(0.4968, 12);
  });

  it("enforces both-leg 1bp capacity without optimizing returns", () => {
    expect(passesCapacity(1, 10_000, 10_000)).toBe(true);
    expect(passesCapacity(1.01, 10_000, 10_000)).toBe(false);
    expect(passesCapacity(1, 10_000, 9_000)).toBe(false);
  });

  it("rounds manual delay from the decision timestamp only", () => {
    expect(manualEntryTime(1_000, 5)).toBe(301_000);
    expect(manualEntryTime(1_000, 30)).toBe(1_801_000);
  });

  it("returns a deterministic block-bootstrap confidence interval", () => {
    const first = blockBootstrapLcb([0.1, 0.2, 0.3, 0.4, 0.5], 2, 100, 15);
    const second = blockBootstrapLcb([0.1, 0.2, 0.3, 0.4, 0.5], 2, 100, 15);
    expect(first).toEqual(second);
    expect(first.estimate).toBeCloseTo(0.3, 12);
    expect(first.lower95).toBeLessThanOrEqual(first.estimate);
  });
});
