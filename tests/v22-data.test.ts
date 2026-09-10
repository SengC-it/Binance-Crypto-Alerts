import { describe, expect, it } from "vitest";
import { admitV22Family, isFamilyInAuthoritativeRegistry, normalizeFamilyName } from "@/lib/v22/admission";
import { addSynchronizationQuality, analyzeQuality, canonicalizeCandleRows, expectedRows, intersectTimestampSets, parseBinanceKlineCsv, parseOkxResponseBodies, passesHardGate, sha256, validateCandle } from "@/lib/v22/data";
import { verifyExtractedCsvMatch, verifyOkxFrozenLines, verifyZipChecksum } from "@/lib/v22/provenance";
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
    expect(okx.candles[0]!.openTimeUtc).toBe(START);
    expect(parseBinanceKlineCsv(`${START + 1},100,101,99,100.5,1,${START + 5 * 60 * 1000 - 1}`, "BTCUSDT")).toHaveLength(1);
    expect(analyzeQuality(parseBinanceKlineCsv(`${START + 1},100,101,99,100.5,1,${START + 5 * 60 * 1000 - 1}`, "BTCUSDT"), START, END).missingRows).toBe(10);
  });

  it("intersects venues by exact timestamp only", () => {
    const left = [candle(START), candle(START + 5 * 60 * 1000)];
    const right = [candle(START + 1), candle(START + 5 * 60 * 1000)];
    expect(intersectTimestampSets(left, right)).toEqual([START + 5 * 60 * 1000]);
  });

  it("reports identical transport duplicates before collapsing them", () => {
    const rows = [candle(START), candle(START)];
    const parsed = canonicalizeCandleRows(rows);
    expect(parsed.candles).toHaveLength(1);
    expect(parsed.audit.transportDuplicateRows).toBe(1);
    expect(parsed.audit.exactIdenticalDuplicateRows).toBe(1);
    expect(parsed.audit.conflictingDuplicateRows).toBe(0);
    expect(parsed.audit.canonicalDuplicateRows).toBe(0);
  });

  it("does not silently accept a conflicting OKX duplicate", () => {
    const body = (close: string) => JSON.stringify({ code: "0", data: [[String(START), "100", "101", "99", close, "1", "1", "100", "1"]], msg: "" });
    const parsed = parseOkxResponseBodies([body("100.5"), body("100.6")], "BTCUSDT");
    expect(parsed.audit.transportDuplicateRows).toBe(1);
    expect(parsed.audit.exactIdenticalDuplicateRows).toBe(0);
    expect(parsed.audit.conflictingDuplicateRows).toBe(1);
    const quality = addSynchronizationQuality(analyzeQuality(parsed.candles, START, END, parsed.audit), 1, START, END);
    expect(passesHardGate(quality, true)).toBe(false);
  });

  it("audits reverse source order while producing strict ascending canonical order", () => {
    const parsed = canonicalizeCandleRows([candle(START + 5 * 60 * 1000), candle(START)]);
    expect(parsed.audit.sourceOrderNonMonotonic).toBe(1);
    expect(parsed.candles.map((row) => row.openTimeUtc)).toEqual([START, START + 5 * 60 * 1000]);
    const reverseParsed = canonicalizeCandleRows([candle(START + 5 * 60 * 1000), candle(START + 5 * 60 * 1000), candle(START)]);
    expect(reverseParsed.audit.sourceOrderNonMonotonic).toBe(1);
    expect(reverseParsed.audit.canonicalNonMonotonic).toBe(0);
  });

  it("does not let out-of-range candles increase cross-venue intersection", () => {
    const outside = START - 5 * 60 * 1000;
    const left = [candle(outside), candle(START)];
    const right = [candle(outside), candle(START)];
    expect(intersectTimestampSets(left, right, START, END)).toEqual([START]);
  });

  it("fails frozen OKX provenance when an NDJSON line or manifest hash changes", () => {
    const body = Buffer.from(JSON.stringify({ code: "0", data: [[String(START), "100", "101", "99", "100.5", "1", "1", "100", "1"]], msg: "" }));
    const manifest = [{ request: "https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=5m&limit=300&after=1", byteLength: body.byteLength, sha256: sha256(body) }];
    expect(verifyOkxFrozenLines({ bodyBytes: Buffer.concat([body, Buffer.from("\n")]), responses: manifest }).pass).toBe(true);
    const modified = Buffer.from(body.toString("utf8").replace("100.5", "100.6"));
    expect(verifyOkxFrozenLines({ bodyBytes: Buffer.concat([modified, Buffer.from("\n")]), responses: manifest }).pass).toBe(false);
    expect(verifyOkxFrozenLines({ bodyBytes: Buffer.concat([body, Buffer.from("\n")]), responses: [{ ...manifest[0]!, sha256: "0".repeat(64) }] }).pass).toBe(false);
  });

  it("fails modified Binance CSV and checksum provenance", () => {
    const zip = Buffer.from("verified zip bytes");
    const csv = Buffer.from("open,high,low,close\n100,101,99,100.5\n");
    expect(verifyZipChecksum(zip, sha256(zip))).toBe(true);
    expect(verifyZipChecksum(Buffer.from("modified zip bytes"), sha256(zip))).toBe(false);
    expect(verifyExtractedCsvMatch(csv, Buffer.from(csv))).toBe(true);
    expect(verifyExtractedCsvMatch(csv, Buffer.from(`${csv.toString("utf8")}changed`))).toBe(false);
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
    expect(isFamilyInAuthoritativeRegistry("cross-venue same-instrument price discovery", ["spot-perp lead-lag", "breakout"])).toBe(false);
    expect(isFamilyInAuthoritativeRegistry("spot-perp lead-lag", ["spot-perp lead-lag", "breakout"])).toBe(true);
  });
});
