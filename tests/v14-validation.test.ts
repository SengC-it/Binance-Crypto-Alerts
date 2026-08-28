import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  parseFundingCsv,
  parseMarkPriceCsv,
  classifyExecutionGap,
  type Bar,
  type FundingPointWithMark,
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
    const points: FundingPointWithMark[] = [
      { fundingTime: 1, fundingIntervalHours: 8, fundingRate: 0.01, markPrice: 200 },
      { fundingTime: 2, fundingIntervalHours: 8, fundingRate: 0.01, markPrice: 100 },
    ];
    const weighted = calculateMarkWeightedFunding(1, 1_000, 100, points);
    expect(weighted).toBeCloseTo(-0.03, 10);
    expect(weighted).not.toBeCloseTo(-0.02, 10);
  });

  it("parses the official three-column fundingRate schema with header and negative rates", () => {
    const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/v14-funding-rate-schema.csv"), "utf8");
    const parsed = parseFundingCsv(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ fundingTime: 1622505600000, fundingIntervalHours: 8, fundingRate: 0.0001 });
    expect(parsed[1]).toMatchObject({ fundingTime: 1622534400000, fundingIntervalHours: 8, fundingRate: -0.00005 });
    expect(parsed[0]).not.toHaveProperty("markPrice");
  });

  it("parses the same fundingRate schema without a header and never treats interval as rate", () => {
    const parsed = parseFundingCsv("1622505600000,8,0.00010000\n1622534400000,8,-0.00005000\n");
    expect(parsed.map((point) => [point.fundingIntervalHours, point.fundingRate])).toEqual([[8, 0.0001], [8, -0.00005]]);
  });

  it("uses an independent mark-price source parser", () => {
    expect(parseMarkPriceCsv("open_time,open,high,low,close\n1622505600000,35000,35100,34900,35050\n")).toEqual([{ openTime: 1622505600000, open: 35000 }]);
  });

  it("accounts for four legs and cost stress explicitly", () => {
    const base = calculateFourLegNetReturn([0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0], 0);
    const stressed = calculateFourLegNetReturn([0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0], 10);
    expect(base).toBeCloseTo(0.0988, 10);
    expect(stressed).toBeCloseTo(0.0968, 10);
    expect(stressed).toBeLessThan(base);
  });

  it("does not allocate overlapping sleeves each a full starting capital", () => {
    const allocation = allocateOverlappingSleeves([{ entryTime: 0, exitTime: 10 }, { entryTime: 5, exitTime: 15 }], 10_000, 2);
    expect(allocation.peakConcurrentSleeves).toBe(2);
    expect(allocation.grossExposurePerSleeve).toBe(10_000);
    expect(allocation.peakGrossExposure).toBe(20_000);
    expect(allocation.hardLimitRespected).toBe(true);
  });

  it("freezes sleeve notional ex ante so a future signal cannot rewrite past sizing", () => {
    const base = allocateOverlappingSleeves([{ entryTime: 0, exitTime: 10 }], 10_000, 4);
    const withFutureSignal = allocateOverlappingSleeves([{ entryTime: 0, exitTime: 10 }, { entryTime: 20, exitTime: 30 }], 10_000, 4);
    expect(withFutureSignal.grossExposurePerSleeve).toBe(base.grossExposurePerSleeve);
    expect(withFutureSignal.sizingUsesFutureRealizedConcurrency).toBe(false);
  });

  it("uses an actual later 15m open for delayed execution", () => {
    const minute = 60_000;
    expect(selectNextExecutionOpen([{ openTime: 15 * minute, open: 101 }, { openTime: 30 * minute, open: 102 }], 15 * minute)).toEqual({ openTime: 15 * minute, open: 101 });
    expect(selectNextExecutionOpen([{ openTime: 30 * minute, open: 102 }], 15 * minute)).toEqual({ openTime: 30 * minute, open: 102 });
    expect(selectNextExecutionOpen([{ openTime: 60 * minute, open: 103 }], 15 * minute)).toBeNull();
  });

  it("keeps true delisting, execution gap, and funding missing as separate classifications", () => {
    expect(classifyExecutionGap({ terminalDelisting: true, dataGap: false, fundingUnavailable: false })).toEqual({ kind: "CONSERVATIVE_DELISTING", conservativeDelistingPenalty: 1 });
    expect(classifyExecutionGap({ terminalDelisting: false, dataGap: true, fundingUnavailable: false })).toEqual({ kind: "DATA_GAP", conservativeDelistingPenalty: 0 });
    expect(classifyExecutionGap({ terminalDelisting: false, dataGap: false, fundingUnavailable: true })).toEqual({ kind: "FUNDING_DATA_UNAVAILABLE", conservativeDelistingPenalty: 0 });
  });

  it("keeps the research boundary free of private trading, SMTP, and Production mutation", () => {
    expect(V14_BOUNDARIES).toMatchObject({ productionChanged: false, productionEmail: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false, smtpProductionSignal: false, deployment: false, merge: false, migration: false, shadow002Restarted: false });
  });
});
