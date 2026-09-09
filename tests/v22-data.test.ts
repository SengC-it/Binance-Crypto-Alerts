import { describe, expect, it } from "vitest";
import { admitV22Family, normalizeFamilyName } from "@/lib/v22/admission";
import { addSynchronizationQuality, analyzeQuality, expectedRows, intersectTimestampSets, parseBinanceKlineCsv, parseOkxResponseBodies, passesHardGate, validateCandle } from "@/lib/v22/data";
import { V22_OKX_INSTRUMENTS, V22_SYMBOLS } from "@/lib/v22/types";

const START = Date.parse("2023-07-01T00:00:00.000Z");
const END = START + 10 * 5 * 60 * 1000;

function candle(timestamp: number, overrides: Partial<ReturnType<typeof makeCandle>> = {}) {
  return makeCandle(timestamp, overrides);
}

function makeCandle(timestamp: number, overrides: Partial<{ open: number; high: number; low: number; close: number; volume: number; closed: boolean }> = {}) {
  return {
    venue: "BINANCE_USDM" as const,
    instrument: "BTCUSDT" as const,
    symbol: "BTCUSDT" as const,
    openTimeUtc: timestamp,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
    closeTimeUtc: timestamp + 5 * 60 * 1000 - 1,
    closed: true,
    ...overrides,
  };
}

describe("V22 public candle data contract", () => {
  it("requires exact 5m timestamps and closed candle semantics", () => {
    expect(expectedRows(START, END)).toBe(10);
    expect(validateCandle(candle(START))).toBe(true);
    expect(validateCandle(candle(START + 1))).toBe(false);
    expect(validateCandle(candle(START, { closed: false }))).toBe(false);
  });

  it("rejects nonfinite and invalid OHLC rows", () => {
    expect(validateCandle(candle(START, { open: Number.NaN }))).toBe(false);
    expect(validateCandle(candle(START, { high: 98 }))).toBe(false);
    expect(validateCandle(candle(START, { low: 102 }))).toBe(false);
  });

  it("counts duplicates and detects a gap over 15 minutes without filling it", () => {
    const rows = [candle(START), candle(START), candle(START + 8 * 5 * 60 * 1000)];
    const quality = analyzeQuality(rows, START, END);
    expect(quality.duplicates).toBe(1);
    expect(quality.missingRows).toBe(8);
    expect(quality.maxContiguousMissingMinutes).toBe(35);
    expect(quality.actualRows).toBe(2);
    expect(passesHardGate(addSynchronizationQuality(quality, 2, START, END))).toBe(false);
  });

  it("rejects coverage below 0.999", () => {
    const rows = Array.from({ length: 998 }, (_, index) => candle(START + index * 5 * 60 * 1000));
    const longerEnd = START + 1000 * 5 * 60 * 1000;
    const quality = addSynchronizationQuality(analyzeQuality(rows, START, longerEnd), 998, START, longerEnd);
    expect(quality.coverageRatio).toBeLessThan(0.999);
    expect(passesHardGate(quality)).toBe(false);
  });

  it("parses Binance and OKX without nearest-timestamp repair", () => {
    const binance = parseBinanceKlineCsv(`${START},100,101,99,100.5,1,${START + 5 * 60 * 1000 - 1}`, "BTCUSDT");
    const okx = parseOkxResponseBodies([JSON.stringify({ code: "0", data: [[String(START), "100", "101", "99", "100.5", "1", "1", "100", "1"]], msg: "" })], "BTCUSDT");
    expect(binance[0].openTimeUtc).toBe(START);
    expect(okx[0].openTimeUtc).toBe(START);
    expect(parseBinanceKlineCsv(`${START + 1},100,101,99,100.5,1,${START + 5 * 60 * 1000 - 1}`, "BTCUSDT")).toHaveLength(1);
    expect(analyzeQuality(parseBinanceKlineCsv(`${START + 1},100,101,99,100.5,1,${START + 5 * 60 * 1000 - 1}`, "BTCUSDT"), START, END).missingRows).toBe(10);
  });

  it("intersects venues by exact timestamp only", () => {
    const left = [candle(START), candle(START + 5 * 60 * 1000)];
    const right = [candle(START + 1), candle(START + 5 * 60 * 1000)];
    expect(intersectTimestampSets(left, right)).toEqual([START + 5 * 60 * 1000]);
  });

  it("keeps the fixed five-symbol mapping exact", () => {
    expect(V22_SYMBOLS).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"]);
    expect(V22_OKX_INSTRUMENTS).toEqual({ BTCUSDT: "BTC-USDT-SWAP", ETHUSDT: "ETH-USDT-SWAP", SOLUSDT: "SOL-USDT-SWAP", XRPUSDT: "XRP-USDT-SWAP", DOGEUSDT: "DOGE-USDT-SWAP" });
  });

  it("fails the all-symbol gate when one fixed symbol is missing", () => {
    const quality = addSynchronizationQuality(analyzeQuality(Array.from({ length: 10 }, (_, index) => candle(START + index * 5 * 60 * 1000)), START, END), 10, START, END);
    expect(passesHardGate(quality)).toBe(true);
    expect(passesHardGate(addSynchronizationQuality(analyzeQuality([], START, END), 0, START, END))).toBe(false);
  });

  it("runs the canonical legacy-family admission boundary", () => {
    expect(normalizeFamilyName("  Spot-perp__lead   lag ")).toBe("spot perp lead lag");
    expect(admitV22Family({ experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY", family: "spot-perp lead-lag", informationSourceClass: "CROSS_EXCHANGE_PRICE_DISCOVERY" }).status).toBe("FAIL");
    expect(admitV22Family({ experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY", family: "cross-venue same-instrument price discovery", informationSourceClass: "CROSS_EXCHANGE_PRICE_DISCOVERY" }).status).toBe("PASS");
  });
});
