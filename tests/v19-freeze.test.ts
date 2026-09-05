import { describe, expect, it } from "vitest";
import {
  V19_BASE_SHA,
  V19_BTC_SHOCK_QUANTILE,
  V19_FOLLOWER_CANDIDATES,
  V19_PARAMETERS,
  V19_PIT_WINDOW_MS,
  V19_UNDERREACTION_QUANTILE,
} from "../lib/v19/constants";
import { canonicalTextSha256, sha256 } from "../lib/v19/canonical";
import {
  buildFollowerFeature,
  buildSynchronizedPriorWindow,
  classifyLiquidity,
  directionalUnderreaction,
  exactPrimaryExitCloseTime,
  fitOls,
  hasExactPrimaryExit,
  hasOverlap,
  isPITWindowComplete,
  logReturn,
  nearestRankQuantile,
  resolveNextExecutionReference,
  rollingMedianTradeCountSeries,
  rollingNearestRankQuantileSeries,
  sideForShock,
  type V19Bar,
} from "../lib/v19/features";

describe("V19 frozen PIT feature semantics", () => {
  it("computes the BTC log return from closed-bar closes", () => {
    expect(logReturn(110, 100)).toBeCloseTo(Math.log(1.1));
    expect(logReturn(0, 100)).toBeNull();
  });

  it("uses nearest-rank Q99 and excludes the current observation", () => {
    expect(nearestRankQuantile(Array.from({ length: 100 }, (_, index) => index + 1), V19_BTC_SHOCK_QUANTILE)).toBe(99);
    const values = Float64Array.from([1, 2, 3, 4, 100, 5]);
    const rolling = rollingNearestRankQuantileSeries(values, 4, 0.75);

    expect(rolling[5]).toBe(4);
  });

  it("fits follower beta on synchronized prior rows only", () => {
    expect(fitOls([2, 4, 6], [1, 2, 3])).toEqual({ alpha: 0, beta: 2 });
    expect(fitOls([2, 4], [1, 1])).toBeNull();
  });

  it("keeps the current signal row out of the PIT prior window", () => {
    const interval = 5 * 60 * 1000;
    const signalOpenTime = 4 * interval;
    const btc = new Map<number, V19Bar>();
    const follower = new Map<number, V19Bar>();
    for (let index = 0; index <= 4; index += 1) {
      const time = index * interval;
      btc.set(time, testBar(time, 100 + index, 100 + index));
      follower.set(time, testBar(time, 200 + index, 200 + index));
    }
    const prior = buildSynchronizedPriorWindow(btc, follower, signalOpenTime, 3 * interval, interval);

    expect(prior?.endOpenTimeExclusive).toBe(signalOpenTime);
    expect(prior?.btcReturns).toHaveLength(3);
    expect(prior?.btcReturns.at(-1)).toBeCloseTo(Math.log(103 / 102));
  });

  it("computes residual underreaction and a PIT Q90 threshold", () => {
    const prior = {
      startOpenTime: 0,
      endOpenTimeExclusive: 3,
      btcReturns: [0.01, 0.02, -0.01, 0.03],
      followerReturns: [0.02, 0.04, -0.02, 0.06],
      tradeCounts: [10, 11, 12, 13],
    };
    const feature = buildFollowerFeature(prior, 0.04, 0.02, 11.5);

    expect(feature?.beta).toBeCloseTo(2);
    expect(feature?.residual).toBeCloseTo(-0.06);
    expect(feature?.directionalUnderreaction).toBeCloseTo(0.06);
    expect(feature?.underreactionQ90).toBeTypeOf("number");
    expect(directionalUnderreaction(-0.1, 0.02)).toBeCloseTo(0.02);
    expect(V19_UNDERREACTION_QUANTILE).toBe(0.9);
  });

  it("ranks prior liquidity only, with alphabetical tie breaks and a bottom half", () => {
    expect(classifyLiquidity(new Map([
      ["ZUSDT", 10],
      ["ADAUSDT", 10],
      ["BNBUSDT", 20],
      ["XRPUSDT", 30],
      ["LTCUSDT", 40],
    ]))).toEqual({
      lowLiquidity: ["ADAUSDT", "ZUSDT", "BNBUSDT"],
      highLiquidity: ["XRPUSDT", "LTCUSDT"],
      orderedSymbols: ["ADAUSDT", "ZUSDT", "BNBUSDT", "XRPUSDT", "LTCUSDT"],
    });
    expect(rollingMedianTradeCountSeries([0, 1, 2, 3], [3, 1, 2, 100], 2)).toEqual(Float64Array.from([NaN, NaN, 2, 1.5]));
  });

  it("maps shock direction and excludes high-liquidity followers", () => {
    expect(sideForShock(0.01)).toBe("LONG");
    expect(sideForShock(-0.01)).toBe("SHORT");
    expect(sideForShock(0)).toBeNull();
    const low = classifyLiquidity(new Map([["A", 1], ["B", 2], ["C", 3], ["D", 4]])).lowLiquidity;
    expect(low).toEqual(["A", "B"]);
    expect(low).not.toContain("D");
  });

  it("fails a PIT window when any required row is missing", () => {
    expect(isPITWindowComplete([0, 5, 10], 15, 15, 5)).toBe(true);
    expect(isPITWindowComplete([0, 10], 15, 15, 5)).toBe(false);
  });

  it("uses the next bar open and never substitutes the signal close", () => {
    const openTimes = [0, 5, 10, 15];
    const opens = [100, 101, 102, 103];
    const reference = resolveNextExecutionReference(openTimes, opens, 5, 5);

    expect(reference).toEqual({ openTime: 10, price: 102 });
    expect(reference?.price).not.toBe(101);
    expect(resolveNextExecutionReference([0, 5, 15], opens, 5, 5)).toBeNull();
    const fiveMinutes = 5 * 60 * 1000;
    const entryOpenTime = fiveMinutes;
    expect(exactPrimaryExitCloseTime(entryOpenTime, 15)).toBe(entryOpenTime + 15 * 60 * 1000 - 1);
    expect(hasExactPrimaryExit([0, fiveMinutes, 2 * fiveMinutes, 3 * fiveMinutes], entryOpenTime, 15, fiveMinutes)).toBe(true);
    expect(hasExactPrimaryExit([0, fiveMinutes, 2 * fiveMinutes], entryOpenTime, 15, fiveMinutes)).toBe(false);
  });

  it("keeps same-follower trades non-overlapping and clusters by BTC shock timestamp", () => {
    expect(hasOverlap(null, 0)).toBe(false);
    expect(hasOverlap(0, 14 * 60 * 1000)).toBe(true);
    expect(hasOverlap(0, 15 * 60 * 1000)).toBe(false);
    const events = [
      { btcShockTimestamp: "2025-01-01T00:00:00.000Z", follower: "ADAUSDT" },
      { btcShockTimestamp: "2025-01-01T00:00:00.000Z", follower: "BNBUSDT" },
    ];
    expect(new Set(events.map((event) => event.btcShockTimestamp)).size).toBe(1);
  });

  it("produces deterministic, content-sensitive provenance hashes", () => {
    const lf = "{\n  \"v\": 1\n}\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(canonicalTextSha256(lf)).toBe(canonicalTextSha256(crlf));
    expect(canonicalTextSha256(`${lf}x`)).not.toBe(canonicalTextSha256(lf));
    expect(sha256({ base: V19_BASE_SHA, followers: V19_FOLLOWER_CANDIDATES })).toBe(
      sha256({ followers: V19_FOLLOWER_CANDIDATES, base: V19_BASE_SHA }),
    );
  });

  it("freezes the alpha field allow-list and outcome boundary", () => {
    expect(V19_PARAMETERS.dataFieldsUsedForAlpha).toEqual(["openTime", "close", "tradeCount"]);
    expect(V19_PARAMETERS.retainedButNotUsedForAlpha).toContain("high");
    expect(V19_PARAMETERS.retainedButNotUsedForAlpha).toContain("takerBuyQuoteVolume");
  });
});

function testBar(openTime: number, open: number, close: number): V19Bar {
  return {
    openTime,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    closeTime: openTime + 5 * 60 * 1000 - 1,
    quoteVolume: 1,
    tradeCount: 1,
    takerBuyBaseVolume: 0,
    takerBuyQuoteVolume: 0,
  };
}
