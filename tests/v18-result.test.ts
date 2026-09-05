import { describe, expect, it } from "vitest";
import type { V18Candle } from "@/lib/v18/data";
import {
  bootstrapMeanConfidence,
  fixedHorizonExitOpenTime,
  metricsForOutcomes,
  readFixedHorizonOutcome,
  type V18Outcome,
} from "@/lib/v18/result";
import type { V18SignalEvent } from "@/lib/v18/engine";

function candle(openTime: number, open: number, close: number, high = Math.max(open, close), low = Math.min(open, close)): V18Candle {
  return { openTime, open, high, low, close, volume: 10, closeTime: openTime + 299_999, quoteVolume: 1_000, tradeCount: 10, takerBuyBaseVolume: 5, takerBuyQuoteVolume: 500 };
}

function event(side: "LONG" | "SHORT"): V18SignalEvent {
  return { symbol: "BTCUSDT", signalOpenTime: 0, signalCandleCloseTime: 299_999, executionCandleOpenTime: 300_000, executionReferencePrice: 101, executionReferenceSource: "BINANCE_USDM_5M_NEXT_BAR_OPEN_ARCHIVE", flowDirection: side === "SHORT" ? "BUY_FLOW_ABSORBED" : "SELL_FLOW_ABSORBED", side, flowImbalance: 0.9, priorFiQ05: -0.2, priorFiQ95: 0.2, priorQuoteVolumeQ75: 100, quoteVolume: 1_000, priceResponse: 0, signedEfficiency: 0 };
}

describe("V18 frozen result evaluation", () => {
  it("maps a next-bar entry to the close of the exact 60-minute horizon", () => {
    expect(fixedHorizonExitOpenTime(300_000)).toBe(3_600_000);
    const outcome = readFixedHorizonOutcome(event("LONG"), [candle(300_000, 101, 101), candle(3_600_000, 102, 103, 10_000, 1)]);
    expect(outcome?.entryPrice).toBe(101);
    expect(outcome?.exitPrice).toBe(103);
    expect(outcome?.exitTime).toBe(3_899_999);
  });

  it("uses the signal direction and close at the fixed horizon, not intrabar extremes", () => {
    const short = readFixedHorizonOutcome(event("SHORT"), [candle(300_000, 101, 101), candle(3_600_000, 102, 99, 1_000, 1)]);
    expect(short?.grossReturn).toBeCloseTo(2 / 101, 12);
    const long = readFixedHorizonOutcome(event("LONG"), [candle(300_000, 101, 101), candle(3_600_000, 102, 103, 1_000, 1)]);
    expect(long?.grossReturn).toBeCloseTo(2 / 101, 12);
  });

  it("returns no outcome when the exact horizon candle is unavailable", () => {
    expect(readFixedHorizonOutcome(event("LONG"), [candle(300_000, 101, 101)])).toBeNull();
  });

  it("applies the frozen 12bps baseline and additive stress costs", () => {
    const outcome = readFixedHorizonOutcome(event("LONG"), [candle(300_000, 101, 101), candle(3_600_000, 102, 103)]) as V18Outcome;
    const baseline = metricsForOutcomes([outcome]);
    const stressed = metricsForOutcomes([outcome], 10);
    expect(baseline.netReturn).toBeCloseTo(outcome.grossReturn - 0.0012, 12);
    expect(stressed.netReturn).toBeCloseTo(outcome.grossReturn - 0.0022, 12);
    expect(baseline.fees).toBeCloseTo(0.0008, 12);
    expect(baseline.slippage).toBeCloseTo(0.0004, 12);
  });

  it("produces deterministic bootstrap confidence intervals", () => {
    const outcomes = [
      readFixedHorizonOutcome(event("LONG"), [candle(300_000, 101, 101), candle(3_600_000, 102, 103)]) as V18Outcome,
      readFixedHorizonOutcome(event("SHORT"), [candle(300_000, 101, 101), candle(3_600_000, 102, 100)]) as V18Outcome,
    ];
    expect(bootstrapMeanConfidence(outcomes, 0, 200, 1234)).toEqual(bootstrapMeanConfidence(outcomes, 0, 200, 1234));
  });
});
