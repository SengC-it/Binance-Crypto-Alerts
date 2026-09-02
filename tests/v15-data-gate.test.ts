import { describe, expect, it } from "vitest";
import {
  coverageOrNotApplicable,
  pairMonthIsAvailable,
  potentialFundingSettlements,
  settlementInputsCover,
  trailingAdvWindow,
} from "@/lib/v15/data-gate";
import type { V15Bar } from "@/lib/v15/lead-lag";

function bar(openTime: number, quoteVolume = 0): V15Bar {
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    quoteVolume,
    takerBuyQuoteVolume: 0,
  };
}

describe("V15 Data Gate V3 semantics", () => {
  it("excludes an invalid pair-month without failing every other pair-month", () => {
    expect(pairMonthIsAvailable({ spotIntegrityPass: false, futuresIntegrityPass: true })).toBe(false);
    expect(pairMonthIsAvailable({ spotIntegrityPass: true, futuresIntegrityPass: true })).toBe(true);
  });

  it("measures ADV availability from a trailing 30-day bar window", () => {
    const end = Date.UTC(2024, 1, 1);
    const bars = Array.from({ length: 30 * 24 * 12 }, (_, index) => bar(end - (30 * 24 * 12 - index) * 5 * 60_000));
    const result = trailingAdvWindow(bars, end);
    expect(result.available).toBe(true);
    expect(result.observedBars).toBe(30 * 24 * 12);
    expect(result.quoteVolume).toBe(0);
  });

  it("does not treat a zero-volume window as missing, but rejects a missing bar", () => {
    const end = Date.UTC(2024, 1, 1);
    const bars = Array.from({ length: 30 * 24 * 12 }, (_, index) => bar(end - (30 * 24 * 12 - index) * 5 * 60_000));
    bars.splice(100, 1);
    expect(trailingAdvWindow(bars, end).available).toBe(false);
  });

  it("requires real settlement inputs only when the potential hold crosses funding time", () => {
    const entry = Date.UTC(2024, 0, 1, 4, 0);
    const required = potentialFundingSettlements(entry, entry + 4 * 60 * 60_000);
    expect(required).toHaveLength(1);
    expect(settlementInputsCover(required, new Map())).toBe(false);
    expect(settlementInputsCover(required, new Map([[required[0], 100]]))).toBe(true);
    expect(coverageOrNotApplicable(0, 0)).toBeNull();
  });
});
