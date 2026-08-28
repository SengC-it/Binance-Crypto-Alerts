import { describe, expect, it } from "vitest";
import {
  V14_BOUNDARIES,
  buildPitPointAtTimestamp,
  calculateFourLegNetReturn,
  calculateMarkWeightedFunding,
  allocateOverlappingSleeves,
  passesCapacityGate,
  resolveConservativeDelisting,
  selectActionableSymbols,
  selectNextExecutionOpen,
  type Bar,
  type FundingPoint,
} from "../scripts/run-v14-validation";

const DAY = 86_400_000;

function dailyBar(index: number, close: number, quoteVolume = 100_000_000): Bar {
  const openTime = index * DAY;
  return { openTime, open: close, high: close + 1, low: close - 1, close, volume: quoteVolume / close, quoteVolume, closeTime: openTime + DAY - 1 };
}

function fullHistory(length = 150): Bar[] {
  return Array.from({ length }, (_, index) => dailyBar(index, 100 + index * 0.2 + (index % 7 === 0 ? 4 : 0)));
}

describe("V14 correctness rerun integrity", () => {
  it("uses only PIT bars and does not apply a future lifecycle filter", () => {
    const bars = fullHistory();
    const point = buildPitPointAtTimestamp(bars, 120 * DAY);
    expect(point?.latestBar).toBeLessThanOrEqual(120 * DAY);
    expect(point?.quoteVolume30d).toBe(100_000_000);
    const listedLater = fullHistory().map((bar) => ({ ...bar, openTime: bar.openTime + 160 * DAY, closeTime: bar.closeTime + 160 * DAY }));
    expect(buildPitPointAtTimestamp(listedLater, 120 * DAY)).toBeNull();
    expect(buildPitPointAtTimestamp(listedLater, 280 * DAY)).not.toBeNull();
  });

  it("keeps a short-lived delisted symbol eligible while it has PIT history", () => {
    const bars = fullHistory(105);
    expect(buildPitPointAtTimestamp(bars, 100 * DAY)).not.toBeNull();
    expect(bars.at(-1)?.openTime).toBe(104 * DAY);
  });

  it("uses distinct 8W/10W/12W formation returns for actionable ranking", () => {
    const points = [
      { symbol: "A", formationReturns: { 8: 0.20, 10: -0.10, 12: 0.05 } },
      { symbol: "B", formationReturns: { 8: 0.10, 10: 0.30, 12: 0.01 } },
      { symbol: "C", formationReturns: { 8: -0.05, 10: 0.05, 12: 0.30 } },
      { symbol: "D", formationReturns: { 8: -0.20, 10: 0.01, 12: -0.20 } },
    ];
    expect(selectActionableSymbols(points, 8, 2)).not.toEqual(selectActionableSymbols(points, 10, 2));
    expect(selectActionableSymbols(points, 8, 2)).toEqual({ longs: ["D", "C"], shorts: ["A", "B"] });
    expect(selectActionableSymbols(points, 12, 2)).toEqual({ longs: ["D", "B"], shorts: ["C", "A"] });
  });

  it("applies the frozen ADV30 capacity gate without using future volume", () => {
    expect(passesCapacityGate(50_000_000, 2)).toBe(true);
    expect(passesCapacityGate(49_999_999, 2)).toBe(false);
    expect(passesCapacityGate(33_333_334, 3)).toBe(true);
    expect(passesCapacityGate(10_000_000, 2)).toBe(false);
  });

  it("retains terminal positions under conservative delisting treatment", () => {
    expect(resolveConservativeDelisting(1)).toEqual({ priceReturn: -1, mode: "CONSERVATIVE_DELISTING", direction: 1 });
    expect(resolveConservativeDelisting(-1).priceReturn).toBe(-1);
  });

  it("uses mark-weighted funding rather than summing rates", () => {
    const points: FundingPoint[] = [
      { fundingTime: 1, fundingRate: 0.01, markPrice: 200 },
      { fundingTime: 2, fundingRate: 0.01, markPrice: 100 },
    ];
    const weighted = calculateMarkWeightedFunding(1, 1_000, 100, points);
    expect(weighted).toBeCloseTo(-0.03, 10);
    expect(weighted).not.toBeCloseTo(-0.02, 10);
  });

  it("accounts for four legs and cost stress explicitly", () => {
    const base = calculateFourLegNetReturn([0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0], 0);
    const stressed = calculateFourLegNetReturn([0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0], 10);
    expect(base).toBeCloseTo(0.0988, 10);
    expect(stressed).toBeCloseTo(0.0968, 10);
    expect(stressed).toBeLessThan(base);
  });

  it("does not allocate overlapping sleeves each a full starting capital", () => {
    const allocation = allocateOverlappingSleeves([{ entryTime: 0, exitTime: 10 }, { entryTime: 5, exitTime: 15 }]);
    expect(allocation.peakConcurrentSleeves).toBe(2);
    expect(allocation.grossExposurePerSleeve).toBe(10_000);
    expect(allocation.peakGrossExposure).toBe(20_000);
    expect(allocation.hardLimitRespected).toBe(true);
  });

  it("uses an actual later 15m open for delayed execution", () => {
    expect(selectNextExecutionOpen([{ openTime: 101, open: 101 }, { openTime: 102, open: 102 }], 100)).toEqual({ openTime: 101, open: 101 });
    expect(selectNextExecutionOpen([{ openTime: 102, open: 102 }], 100)).toBeNull();
  });

  it("keeps the research boundary free of private trading, SMTP, and Production mutation", () => {
    expect(V14_BOUNDARIES).toMatchObject({ productionChanged: false, productionEmail: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false, smtpProductionSignal: false, deployment: false, merge: false, migration: false, shadow002Restarted: false });
  });
});
