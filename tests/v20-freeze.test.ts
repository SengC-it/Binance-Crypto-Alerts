import { describe, expect, it } from "vitest";
import { parseBinanceKlineCsv } from "../lib/v20/archive";
import {
  V20_BASE_SHA,
  V20_BOUNDARIES,
  V20_BRANCH,
  V20_INTERVAL_MS,
  V20_PIT_WINDOW_BARS,
  V20_SYMBOLS,
} from "../lib/v20/constants";
import { canonicalTextSha256, sha256 } from "../lib/v20/canonical";
import { synchronizeExact, type V20SynchronizedSeries } from "../lib/v20/sync";
import {
  enumerateLastIndexControl,
  enumerateLastMarkEvents,
  enumerateLastReturnControl,
  enumerateTimeMatchedRandom,
  lastIndexGap,
  lastLogReturns,
  lastMarkGap,
  medianAndNearestRankAbsoluteDeviation,
  nearestRankQuantile,
} from "../lib/v20/signals";

describe("V20 freeze-only data and signal identity", () => {
  it("performs an exact inner synchronization without nearest-time fill", () => {
    const regular = [bar(0, 100), bar(V20_INTERVAL_MS, 101), bar(2 * V20_INTERVAL_MS, 102)];
    const mark = [bar(0, 99), bar(2 * V20_INTERVAL_MS, 101)];
    const index = [bar(0, 98), bar(V20_INTERVAL_MS, 100), bar(2 * V20_INTERVAL_MS, 101)];
    const result = synchronizeExact("BTCUSDT", regular, mark, index);
    expect(result.series.openTimes).toEqual([0, 2 * V20_INTERVAL_MS]);
    expect(result.series.markCloses).toEqual([99, 101]);
    expect(result.summary.noNearestTimeJoin).toBe(true);
    expect(result.summary.noForwardFill).toBe(true);
  });

  it("rejects a malformed/future kline rather than fabricating a row", () => {
    const period = { start: 0, endExclusive: 2 * V20_INTERVAL_MS };
    const csv = [
      "open_time,open,high,low,close,volume,close_time",
      `${0},100,101,99,100,1,${V20_INTERVAL_MS - 1}`,
      `${2 * V20_INTERVAL_MS},100,101,99,100,1,${3 * V20_INTERVAL_MS - 1}`,
    ].join("\n");
    const parsed = parseBinanceKlineCsv(csv, "BTCUSDT", "regular", period);
    expect(parsed.bars).toHaveLength(1);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("retains valid official rows across a recorded cadence gap without filling it", () => {
    const csv = [
      "open_time,open,high,low,close,volume,close_time",
      `0,100,101,99,100,1,${V20_INTERVAL_MS - 1}`,
      `${2 * V20_INTERVAL_MS},102,103,101,102,1,${3 * V20_INTERVAL_MS - 1}`,
    ].join("\n");
    const parsed = parseBinanceKlineCsv(csv, "BTCUSDT", "mark", { start: 0, endExclusive: 3 * V20_INTERVAL_MS });
    expect(parsed.errors).toEqual([]);
    expect(parsed.bars).toHaveLength(2);
    expect(parsed.cadenceErrors).toBe(1);
  });

  it("uses deterministic nearest-rank quantiles and median", () => {
    expect(nearestRankQuantile([3, 1, 2, 100], 0.5)).toBe(2);
    expect(nearestRankQuantile([1, 2, 3, 100], 0.99)).toBe(100);
    expect(medianAndNearestRankAbsoluteDeviation([0, 1, 2, 3], 0.5)).toEqual({ median: 1.5, threshold: 0.5 });
  });

  it("excludes the current bar from the PIT center and Q99, then maps positive deviation to SHORT", () => {
    const series = makeDislocationSeries(0.01);
    const result = enumerateLastMarkEvents(series);
    expect(result.firstCrossEvents).toBeGreaterThanOrEqual(1);
    expect(result.events.at(-1)?.side).toBe("SHORT");
    expect(result.events.at(-1)?.signalOpenTime).toBe(V20_PIT_WINDOW_BARS * V20_INTERVAL_MS);
    expect(result.events.at(-1)?.nextEntryOpenTime).toBe((V20_PIT_WINDOW_BARS + 1) * V20_INTERVAL_MS);
    expect(result.events.at(-1)?.nextEntryAvailable).toBe(true);
  });

  it("maps negative deviation to LONG and preserves exact signal timestamp", () => {
    const series = makeDislocationSeries(-0.01);
    const result = enumerateLastMarkEvents(series);
    const event = result.events.at(-1);
    expect(event?.side).toBe("LONG");
    expect(event?.signalTimestamp).toBe(new Date(series.closeTimes[V20_PIT_WINDOW_BARS]).toISOString());
    expect(event?.signalTimestamp).not.toBe(new Date(series.openTimes[V20_PIT_WINDOW_BARS]).toISOString());
  });

  it("emits a first crossing only once while a later bar remains outside", () => {
    const series = makeDislocationSeries(0.01, 0.02);
    const result = enumerateLastMarkEvents(series);
    const latest = result.events.filter((event) => event.signalOpenTime >= V20_PIT_WINDOW_BARS * V20_INTERVAL_MS);
    expect(latest).toHaveLength(1);
    expect(result.firstCrossEvents).toBe(1);
  });

  it("calculates independent index and last-return controls", () => {
    const series = makeDislocationSeries(0.01);
    expect(lastMarkGap(series)[V20_PIT_WINDOW_BARS]).toBeCloseTo(0.01, 8);
    expect(lastIndexGap(series)[V20_PIT_WINDOW_BARS]).toBeCloseTo(0.01, 8);
    expect(lastLogReturns(series)[0]).toBeNaN();
    expect(enumerateLastIndexControl(series).control).toBe("LAST_INDEX_DISLOCATION");
    expect(enumerateLastReturnControl(series).control).toBe("EXTREME_LAST_RETURN_REVERSAL");
  });

  it("uses same-symbol overlap exclusion and same-timestamp cluster identity", () => {
    const first = enumerateLastMarkEvents(makeDislocationSeries(0.01));
    const second = enumerateLastMarkEvents(makeDislocationSeries(-0.01));
    expect(first.events.at(-1)?.clusterId).toBe(second.events.at(-1)?.clusterId);
    expect(first.events.at(-1)?.symbol).toBe("BTCUSDT");
    expect(first.events.at(-1)?.nextEntryOpenTime).toBe(first.events.at(-1)!.signalOpenTime + V20_INTERVAL_MS);
  });

  it("creates deterministic time-matched random identities without changing primary events", () => {
    const series = makeDislocationSeries(0.01);
    const primary = enumerateLastMarkEvents(series);
    const first = enumerateTimeMatchedRandom(series, primary.events, 2020);
    const second = enumerateTimeMatchedRandom(series, primary.events, 2020);
    expect(first.events).toEqual(second.events);
    expect(first.eventCount).toBe(primary.finalEligibleEvents);
    expect(first.control).toBe("TIME_MATCHED_RANDOM");
  });

  it("keeps the V20 boundary flags and source digest deterministic", () => {
    expect(V20_BASE_SHA).toBe("7b9e5d82f471ee3c9fec07e00101263c8d84e953");
    expect(V20_BRANCH).toBe("feat/v20-last-mark-dislocation-convergence");
    expect(V20_SYMBOLS).toEqual(["BTCUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT"]);
    expect(V20_BOUNDARIES.historicalReturnsRead).toBe(false);
    expect(V20_BOUNDARIES.forwardReturnsRead).toBe(false);
    expect(V20_BOUNDARIES.oosMetricsRead).toBe(false);
    expect(V20_BOUNDARIES.holdoutRead).toBe(false);
    expect(V20_BOUNDARIES.parameterSearch).toBe(false);
    expect(canonicalTextSha256("a\nb\n")).toBe(canonicalTextSha256("a\r\nb\r\n"));
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

function bar(openTime: number, close: number) {
  return {
    openTime,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    closeTime: openTime + V20_INTERVAL_MS - 1,
  };
}

function makeDislocationSeries(...currentGaps: number[]): V20SynchronizedSeries {
  const length = V20_PIT_WINDOW_BARS + currentGaps.length + 1;
  const openTimes = Array.from({ length }, (_, index) => index * V20_INTERVAL_MS);
  const closeTimes = openTimes.map((openTime) => openTime + V20_INTERVAL_MS - 1);
  const gaps = Array.from({ length }, () => 0);
  for (let index = V20_PIT_WINDOW_BARS - 101; index < V20_PIT_WINDOW_BARS - 1; index += 1) gaps[index] = 0.001;
  currentGaps.forEach((gap, index) => { gaps[V20_PIT_WINDOW_BARS + index] = gap; });
  const markCloses = gaps.map(() => 100);
  const lastCloses = gaps.map((gap) => 100 * Math.exp(gap));
  return {
    symbol: "BTCUSDT",
    openTimes,
    closeTimes,
    lastOpens: lastCloses,
    lastHighs: lastCloses,
    lastLows: lastCloses,
    lastCloses,
    markCloses,
    indexCloses: markCloses,
  };
}
