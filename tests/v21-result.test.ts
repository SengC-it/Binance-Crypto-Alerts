import { describe, expect, it } from "vitest";
import {
  V21_EXECUTION_CONTRACT,
  evaluateV21PriceOutcome,
  mapV21ExecutionIndices,
} from "../lib/v21/result-evaluator";
import {
  exactIndex,
  resolveV21Execution,
  type V21PriceSeries,
} from "../scripts/v21-result-support";

const INTERVAL = 5 * 60 * 1000;
const START = Date.parse("2022-01-01T00:00:00.000Z");

describe("V21 exactly-one result plumbing", () => {
  it("looks up exact timestamps and maps entry to OPEN and exit to CLOSE", () => {
    const series = syntheticSeries(20);
    const signalOpenTime = START + 2 * INTERVAL;
    const event = { symbol: "BTCUSDT" as const, signalOpenTime, direction: "LONG" as const, clusterId: signalOpenTime };
    const resolved = resolveV21Execution(series, event, "PRIMARY_30M");

    expect(exactIndex(series, signalOpenTime)).toBe(2);
    expect(resolved.mapping).toEqual(mapV21ExecutionIndices(2, 20, "PRIMARY_30M"));
    expect(resolved.entryBarOpenTime).toBe(signalOpenTime + INTERVAL);
    expect(resolved.entryPrice).toBe(103);
    expect(resolved.exitBarOpenTime).toBe(signalOpenTime + 6 * INTERVAL);
    expect(resolved.exitPrice).toBe(208);
    expect(resolved.exitCloseBoundaryTime).toBe(signalOpenTime + 7 * INTERVAL);
  });

  it("proves signal close and next-bar OPEN are distinct execution values", () => {
    const series = syntheticSeries(10);
    series.opens[0] = 100;
    series.closes[0] = 100;
    series.opens[1] = 101;
    const signalOpenTime = START;
    const resolved = resolveV21Execution(
      series,
      { symbol: "ETHUSDT", signalOpenTime, direction: "SHORT", clusterId: signalOpenTime },
      "DIAGNOSTIC_15M",
    );

    expect(resolved.entryPrice).toBe(101);
    expect(resolved.entryPrice).not.toBe(series.closes[0]);
    expect(V21_EXECUTION_CONTRACT.entryUsesSignalClose).toBe(false);
    expect(V21_EXECUTION_CONTRACT.entryPriceField).toBe("open");
  });

  it("fails closed when the required next bar is missing", () => {
    const series = syntheticSeries(10);
    series.present[1] = 0;
    const signalOpenTime = START;
    const resolved = resolveV21Execution(
      series,
      { symbol: "BNBUSDT", signalOpenTime, direction: "LONG", clusterId: signalOpenTime },
      "PRIMARY_30M",
    );

    expect(resolved.unavailableReason).toBe("INTERNAL_GAP");
    expect(resolved.mapping.outcomeAvailable).toBe(false);
    expect(resolved.entryPrice).toBeNull();
    expect(evaluateV21PriceOutcome({
      symbol: "BNBUSDT",
      signalOpenTime,
      direction: "LONG",
      clusterId: signalOpenTime,
      entryPrice: 101,
      exitPrice: 102,
      mapping: resolved.mapping,
    })).toBeNull();
  });

  it("uses the fixed 15m, 30m, and 60m execution contracts", () => {
    expect(resolveV21Execution(
      syntheticSeries(20),
      { symbol: "BTCUSDT", signalOpenTime: START, direction: "LONG", clusterId: START },
      "DIAGNOSTIC_15M",
    ).exitBarOpenTime).toBe(START + 3 * INTERVAL);
    expect(resolveV21Execution(
      syntheticSeries(20),
      { symbol: "BTCUSDT", signalOpenTime: START, direction: "LONG", clusterId: START },
      "PRIMARY_30M",
    ).exitBarOpenTime).toBe(START + 6 * INTERVAL);
    expect(resolveV21Execution(
      syntheticSeries(20),
      { symbol: "BTCUSDT", signalOpenTime: START, direction: "LONG", clusterId: START },
      "DIAGNOSTIC_60M",
    ).exitBarOpenTime).toBe(START + 12 * INTERVAL);
  });

  it("does not use future bar fields for signal or execution identity", () => {
    expect(V21_EXECUTION_CONTRACT.entryUsesNextClose).toBe(false);
    expect(V21_EXECUTION_CONTRACT.entryUsesExitOpen).toBe(false);
    expect(V21_EXECUTION_CONTRACT.entryUsesHighLow).toBe(false);
    expect(V21_EXECUTION_CONTRACT.exitPriceField).toBe("close");
  });
});

function syntheticSeries(length: number): V21PriceSeries {
  const opens = new Float64Array(length);
  const closes = new Float64Array(length);
  const present = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    opens[index] = 100 + index;
    closes[index] = 200 + index;
    present[index] = 1;
  }
  return {
    symbol: "BTCUSDT",
    start: START,
    endExclusive: START + length * INTERVAL,
    interval: INTERVAL,
    opens,
    closes,
    present,
  };
}
