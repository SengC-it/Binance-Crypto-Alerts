import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalTextSha256, parseKlineArchive, sha256, V18_INTERVAL_MS, V18_WINDOW_BARS } from "@/lib/v18/data";
import { buildPreReturnAssessment, evaluateV18SignalAt, flowImbalance, selectNonOverlappingSignals, takerSellQuote, type V18SignalEvent } from "@/lib/v18/engine";

const BASE_TIME = Date.parse("2021-01-01T00:00:00.000Z");

function candle(index: number, changes: Partial<{ open: number; high: number; low: number; close: number; quoteVolume: number; takerBuyQuoteVolume: number; openTime: number }> = {}) {
  const open = changes.open ?? 100;
  const high = changes.high ?? 101;
  const low = changes.low ?? 99;
  const close = changes.close ?? 100;
  const quoteVolume = changes.quoteVolume ?? 100;
  return {
    openTime: changes.openTime ?? BASE_TIME + index * V18_INTERVAL_MS,
    open,
    high,
    low,
    close,
    volume: quoteVolume,
    closeTime: (changes.openTime ?? BASE_TIME + index * V18_INTERVAL_MS) + V18_INTERVAL_MS - 1,
    quoteVolume,
    tradeCount: 10,
    takerBuyBaseVolume: quoteVolume / 2,
    takerBuyQuoteVolume: changes.takerBuyQuoteVolume ?? quoteVolume / 2,
  };
}

function fixture(flow: "buy" | "sell" | "continuation" | "zero-volume" | "zero-range" = "buy") {
  const bars = Array.from({ length: V18_WINDOW_BARS + 2 }, (_, index) => candle(index));
  const index = V18_WINDOW_BARS;
  if (flow === "buy") bars[index] = candle(index, { close: 99, quoteVolume: 200, takerBuyQuoteVolume: 190 });
  if (flow === "sell") bars[index] = candle(index, { close: 101, quoteVolume: 200, takerBuyQuoteVolume: 10 });
  if (flow === "continuation") bars[index] = candle(index, { close: 101, quoteVolume: 200, takerBuyQuoteVolume: 190 });
  if (flow === "zero-volume") bars[index] = candle(index, { close: 99, quoteVolume: 0, takerBuyQuoteVolume: 0 });
  if (flow === "zero-range") bars[index] = candle(index, { high: 100, low: 100, close: 100, quoteVolume: 200, takerBuyQuoteVolume: 190 });
  bars[index + 1] = candle(index + 1, { open: 101, openTime: bars[index].closeTime + 1 });
  return { bars, index };
}

function event(executionTime: number, symbol: "BTCUSDT" | "ETHUSDT" = "BTCUSDT"): V18SignalEvent {
  return { symbol, signalOpenTime: executionTime - V18_INTERVAL_MS, signalCandleCloseTime: executionTime - 1, executionCandleOpenTime: executionTime, executionReferencePrice: 101, executionReferenceSource: "BINANCE_USDM_5M_NEXT_BAR_OPEN_ARCHIVE", flowDirection: "BUY_FLOW_ABSORBED", side: "SHORT", flowImbalance: 0.9, priorFiQ05: 0, priorFiQ95: 0, priorQuoteVolumeQ75: 100, quoteVolume: 200, priceResponse: -0.5, signedEfficiency: -0.45 };
}

function singleEntryZip(csv: string): Buffer {
  const name = Buffer.from("BTCUSDT-5m-2021-01.csv");
  const compressed = deflateRawSync(Buffer.from(csv, "utf8"));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(Buffer.byteLength(csv), 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, compressed]);
}

describe("V18 taker-flow absorption PIT engine", () => {
  it("computes taker sell quote and flow imbalance from official kline fields", () => {
    const sample = candle(0, { quoteVolume: 200, takerBuyQuoteVolume: 150 });
    expect(takerSellQuote(sample)).toBe(50);
    expect(flowImbalance(sample)).toBe(0.5);
  });

  it("uses only the prior window for quantiles, excluding current and future bars", () => {
    const { bars, index } = fixture("buy");
    const evaluation = evaluateV18SignalAt("BTCUSDT", bars, index);
    expect(evaluation.event?.flowImbalance).toBe(0.9);
    expect(evaluation.event?.priorFiQ95).toBe(0);
    const future = bars[index + 1];
    future.takerBuyQuoteVolume = 0;
    future.quoteVolume = 200;
    expect(evaluateV18SignalAt("BTCUSDT", bars, index).event?.priorFiQ95).toBe(0);
  });

  it("maps absorbed extreme buy flow to SHORT and sell flow to LONG", () => {
    const buy = fixture("buy");
    const sell = fixture("sell");
    expect(evaluateV18SignalAt("BTCUSDT", buy.bars, buy.index).event?.side).toBe("SHORT");
    expect(evaluateV18SignalAt("BTCUSDT", sell.bars, sell.index).event?.side).toBe("LONG");
  });

  it("excludes flow continuation rather than treating it as absorption", () => {
    const { bars, index } = fixture("continuation");
    expect(evaluateV18SignalAt("BTCUSDT", bars, index).reason).toBe("NOT_ABSORBED");
  });

  it("rejects zero quote volume and zero range", () => {
    const zeroVolume = fixture("zero-volume");
    const zeroRange = fixture("zero-range");
    expect(evaluateV18SignalAt("BTCUSDT", zeroVolume.bars, zeroVolume.index).reason).toBe("QUOTE_VOLUME_NON_POSITIVE");
    expect(evaluateV18SignalAt("BTCUSDT", zeroRange.bars, zeroRange.index).reason).toBe("RANGE_NON_POSITIVE");
  });

  it("uses the real next-bar open, not the signal close", () => {
    const { bars, index } = fixture("buy");
    const evaluation = evaluateV18SignalAt("BTCUSDT", bars, index);
    expect(evaluation.event?.signalCandleCloseTime).toBe(bars[index].closeTime);
    expect(evaluation.event?.executionCandleOpenTime).toBe(bars[index + 1].openTime);
    expect(evaluation.event?.executionReferencePrice).toBe(101);
    expect(evaluation.event?.executionReferencePrice).not.toBe(bars[index].close);
    expect(bars[index].closeTime).toBeLessThan(evaluation.event!.executionCandleOpenTime!);
  });

  it("does not use next-bar high, low, close, volume, or taker fields for signal judgment", () => {
    const first = fixture("buy");
    const second = fixture("buy");
    Object.assign(second.bars[second.index + 1], { high: 9_999, low: 1, close: 9_000, volume: 1, quoteVolume: 1, tradeCount: 1, takerBuyBaseVolume: 0, takerBuyQuoteVolume: 0 });
    const left = evaluateV18SignalAt("BTCUSDT", first.bars, first.index).event!;
    const right = evaluateV18SignalAt("BTCUSDT", second.bars, second.index).event!;
    expect({ ...right, executionReferencePrice: left.executionReferencePrice }).toEqual(left);
  });

  it("fails closed when the next execution candle is unavailable", () => {
    const { bars, index } = fixture("buy");
    bars.pop();
    const evaluation = evaluateV18SignalAt("BTCUSDT", bars, index);
    expect(evaluation.reason).toBe("EXECUTION_REFERENCE_UNAVAILABLE");
    expect(evaluation.event).toBeNull();
  });

  it("enforces one active position per symbol for overlapping events", () => {
    const selected = selectNonOverlappingSignals([event(BASE_TIME + 60 * 60_000), event(BASE_TIME + 30 * 60_000), event(BASE_TIME + 120 * 60_000, "ETHUSDT")]);
    expect(selected.eligible).toHaveLength(2);
    expect(selected.excluded).toBe(1);
    expect(selected.eligible.map((item) => item.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("validates an official kline archive row and keeps checksum bytes distinct", () => {
    const csv = "1609459200000,100,101,99,100,10,1609459499999,1000,10,5,500,0\n";
    const parsed = parseKlineArchive(singleEntryZip(csv), "2021-01");
    expect(parsed.invalidRows).toBe(0);
    expect(parsed.rows[0].takerBuyQuoteVolume).toBe(500);
    expect(sha256(Buffer.from("official-archive"))).not.toBe(sha256(Buffer.from("changed-archive")));
  });

  it("keeps outcome data unread before Freeze and hashes canonical content deterministically", () => {
    const result = buildPreReturnAssessment({ BTCUSDT: [], ETHUSDT: [] });
    expect(result.assessment.outcomeData).toBe("NOT_READ");
    expect(result.assessment.forwardReturnsRead).toBe(false);
    expect(result.assessment.oosMetricsRead).toBe(false);
    expect(result.assessment.holdoutRead).toBe(false);
    expect(JSON.stringify(result.assessment)).not.toMatch(/\"(pnl|pf|winRate)\"/i);
    expect(canonicalTextSha256("a\nb\n")).toBe(canonicalTextSha256("a\r\nb\r\n"));
    expect(canonicalTextSha256("a\nb\n")).not.toBe(canonicalTextSha256("a\nc\n"));
  });
});
