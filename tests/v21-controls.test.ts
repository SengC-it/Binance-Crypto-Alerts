import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  V21_CONTROL_NAMES,
  SlidingNearestRank,
  V21_TIME_MATCHED_RANDOM_ALGORITHM,
  V21_TIME_MATCHED_RANDOM_SEED,
  deriveV21PlaceboSeed,
} from "../lib/v21/controls";
import { V21_SYMBOLS } from "../lib/v21/constants";
import { V21_PIT_OBSERVATION_COUNT } from "../lib/v21/features";
import { V21_Q99_RANK } from "../lib/v21/event-predicate";

describe("V21 WP3B frozen controls", () => {
  it("freezes the three controls and the exact placebo seed", () => {
    expect(V21_CONTROL_NAMES).toEqual([
      "RAW_RETURN_REVERSAL",
      "SIMPLE_MEDIAN_GAP_REVERSAL",
      "TIME_MATCHED_RANDOM",
    ]);
    expect(V21_TIME_MATCHED_RANDOM_SEED).toBe(0x21C0C0DE);
    expect(V21_TIME_MATCHED_RANDOM_ALGORITHM).toContain("xorshift32");
    expect(deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, "BTCUSDT|2022-01|0|LONG"))
      .toBe(deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, "BTCUSDT|2022-01|0|LONG"));
    expect(deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, "BTCUSDT|2022-01|0|LONG"))
      .not.toBe(deriveV21PlaceboSeed(V21_TIME_MATCHED_RANDOM_SEED, "BTCUSDT|2022-01|0|SHORT"));
  });

  it("keeps controls pre-return and independent of outcome fields", () => {
    const source = readFileSync("lib/v21/controls.ts", "utf8");
    expect(source).not.toMatch(/grossReturn|netReturn|entryPrice|exitPrice|PnL/);
    expect(source).toContain("V21_PIT_OBSERVATION_COUNT");
    expect(source).toContain("V21_PRIMARY_HORIZON_MS");
    expect(source).toContain("applyControlOverlap");
  });

  it("matches brute-force Q99 and first-cross decisions for synthetic rolling windows", () => {
    const observations = 500;
    const seriesLength = V21_PIT_OBSERVATION_COUNT + observations;
    let compared = 0;
    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      const series = Array.from({ length: seriesLength }, (_, index) => (
        Math.sin((index + 1) * (symbolIndex + 1) * 0.013) + ((index * 37 + symbolIndex * 11) % 101) / 1000
      ));
      const optimized = new SlidingNearestRank(series, 0);
      const optimizedFirstCross: boolean[] = [];
      const bruteFirstCross: boolean[] = [];
      for (let currentIndex = V21_PIT_OBSERVATION_COUNT; currentIndex < seriesLength; currentIndex += 1) {
        const prior = series
          .slice(currentIndex - V21_PIT_OBSERVATION_COUNT, currentIndex)
          .map((value) => Math.abs(value))
          .sort((left, right) => left - right);
        const bruteThreshold = prior[V21_Q99_RANK - 1];
        expect(Math.abs(optimized.value() - bruteThreshold)).toBeLessThanOrEqual(1e-15);
        const bruteCross = Math.abs(series[currentIndex - 1]) < bruteThreshold
          && Math.abs(series[currentIndex]) >= bruteThreshold;
        optimizedFirstCross.push(Math.abs(series[currentIndex - 1]) < optimized.value()
          && Math.abs(series[currentIndex]) >= optimized.value());
        bruteFirstCross.push(bruteCross);
        compared += 1;
        if (currentIndex + 1 < seriesLength) optimized.advance(currentIndex - V21_PIT_OBSERVATION_COUNT, currentIndex);
      }
      expect(optimizedFirstCross).toEqual(bruteFirstCross);
    }
    expect(compared).toBe(V21_SYMBOLS.length * observations);
  }, 60_000);
});
