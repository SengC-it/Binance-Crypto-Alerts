import { describe, expect, it } from "vitest";
import { fundingDecisionTime, quantile, V17_PARAMETERS } from "../lib/v17/engine";

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
});
