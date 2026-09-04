import { describe, expect, it } from "vitest";
import { fundingDecisionTime, fundingHistoryBefore, hasMinimumFundingHistory, latestClosedCandleBefore, priceAtFunding, quantile, responseQ50FromReferences, V17_PARAMETERS } from "../lib/v17/engine";
import type { V17Candle } from "../lib/v17/data";

describe("V17 funding-clock and PIT rules", () => {
  it("preserves the real funding timestamp instead of rounding to an eight-hour clock", () => {
    const fundingTimestamp = Date.parse("2021-01-01T00:00:00.022Z");

    expect(fundingDecisionTime(fundingTimestamp)).toBe(fundingTimestamp + 30 * 60_000);
    expect(fundingDecisionTime(fundingTimestamp)).not.toBe(Date.parse("2021-01-01T00:30:00.000Z"));
  });

  it("uses only the frozen empirical quantiles", () => {
    expect(quantile([1, 2, 3, 4, 5], V17_PARAMETERS.fundingQuantiles.long)).toBe(4.6);
    expect(quantile([1, 2, 3, 4, 5], V17_PARAMETERS.fundingQuantiles.short)).toBe(1.4);
    expect(V17_PARAMETERS.fundingLookbackDays).toBe(180);
    expect(V17_PARAMETERS.continuationQuantile).toBe(0.5);
  });

  it("uses available history span, not the newest row, for the 90-day PIT minimum", () => {
    const fundingTimestamp = Date.parse("2022-07-01T00:00:00.000Z");
    const day = 86_400_000;
    const rows = [
      { timestamp: fundingTimestamp - 120 * day, fundingRate: 0 },
      { timestamp: fundingTimestamp - 90 * day, fundingRate: 0 },
      { timestamp: fundingTimestamp - 1, fundingRate: 0 },
      { timestamp: fundingTimestamp + 1, fundingRate: 0 },
    ];
    expect(fundingHistoryBefore(rows, fundingTimestamp).at(-1)?.timestamp).toBe(fundingTimestamp - 1);
    expect(hasMinimumFundingHistory(rows, fundingTimestamp)).toBe(true);
    expect(hasMinimumFundingHistory([{ timestamp: fundingTimestamp - 89 * day, fundingRate: 0 }], fundingTimestamp)).toBe(false);
    expect(fundingHistoryBefore(rows, fundingTimestamp).every((row) => row.timestamp < fundingTimestamp)).toBe(true);
  });

  it("keeps Q50 reference events independent from the current response gate", () => {
    const timestamp = Date.parse("2022-07-01T00:00:00.000Z");
    expect(responseQ50FromReferences([{ timestamp: timestamp - 86_400_000, response: 0.2 }], timestamp)).toBe(0.2);
    expect(responseQ50FromReferences([{ timestamp, response: 0.9 }], timestamp)).toBeNull();
  });

  it("uses the latest fully closed futures 15m close strictly before funding", () => {
    const fundingTimestamp = 1_000_000;
    const candles: V17Candle[] = [
      { openTime: 900_000, open: 99, high: 101, low: 98, close: 100, volume: 1, closeTime: 999_999 },
      { openTime: 1_000_000, open: 101, high: 102, low: 100, close: 101, volume: 1, closeTime: 1_899_999 },
    ];
    expect(latestClosedCandleBefore(candles, fundingTimestamp)?.close).toBe(100);
    expect(priceAtFunding(candles, fundingTimestamp)).toBe(100);
    expect(priceAtFunding(candles, 1_900_000)).toBe(101);
  });
});
