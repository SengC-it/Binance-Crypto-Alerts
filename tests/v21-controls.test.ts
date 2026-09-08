import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  V21_CONTROL_NAMES,
  V21_TIME_MATCHED_RANDOM_ALGORITHM,
  V21_TIME_MATCHED_RANDOM_SEED,
  deriveV21PlaceboSeed,
} from "../lib/v21/controls";

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
});
