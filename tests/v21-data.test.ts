import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  V21_BASE_SHA,
  V21_BOUNDARIES,
  V21_BRANCH,
  V21_EXPECTED_ARCHIVE_SLOTS,
  V21_EXPECTED_ROWS_PER_SYMBOL,
  V21_FORBIDDEN_PATHS,
  V21_INTERVAL_MS,
  V21_MONTH_COUNT,
  V21_SYMBOLS,
  monthPeriod,
  v21MonthKeys,
} from "../lib/v21/constants";
import {
  V21_ARCHIVE_EXCHANGE,
  V21_DATA_TYPE,
  evaluateV21SymbolCoverage,
  parseBinanceKlineCsv,
  parseChecksum,
  v21ArchiveUrl,
  v21ChecksumUrl,
  type V21ArchiveSlot,
} from "../lib/v21/archive";
import { canonicalTextSha256, sha256 } from "../lib/v21/canonical";

describe("V21 data foundation only", () => {
  it("enumerates the fixed 67-month period", () => {
    const months = v21MonthKeys();
    expect(months).toHaveLength(V21_MONTH_COUNT);
    expect(months[0]).toBe("2021-01");
    expect(months.at(-1)).toBe("2026-07");
    expect(new Set(months).size).toBe(V21_MONTH_COUNT);
  });

  it("creates exactly 536 fixed symbol/month archive identities", () => {
    const identities = V21_SYMBOLS.flatMap((symbol) => v21MonthKeys().map((month) => `${symbol}/${month}`));
    expect(identities).toHaveLength(V21_EXPECTED_ARCHIVE_SLOTS);
    expect(new Set(identities).size).toBe(V21_EXPECTED_ARCHIVE_SLOTS);
    expect(V21_SYMBOLS).toEqual(["BTCUSDT", "ETHUSDT", "BNBUSDT", "ADAUSDT", "BCHUSDT", "DOGEUSDT", "LINKUSDT", "DOTUSDT"]);
  });

  it("uses only official USD-M regular-kline archive and checksum URLs", () => {
    const url = v21ArchiveUrl("BTCUSDT", "2021-01");
    expect(url).toBe("https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-2021-01.zip");
    expect(v21ChecksumUrl("BTCUSDT", "2021-01")).toBe(`${url}.CHECKSUM`);
    expect(V21_ARCHIVE_EXCHANGE).toBe("BINANCE_DATA_VISION");
    expect(V21_DATA_TYPE).toBe("regular");
  });

  it("parses the official checksum without accepting a malformed value", () => {
    const checksum = "a".repeat(64);
    expect(parseChecksum(`${checksum}  BTCUSDT-5m-2021-01.zip`)).toBe(checksum);
    expect(parseChecksum("not-a-checksum")).toBeNull();
  });

  it("validates safe timestamps and exact five-minute close time", () => {
    const valid = csv([row(0, 100)]);
    const parsed = parseBinanceKlineCsv(valid, "BTCUSDT", monthPeriodForTest(0));
    expect(parsed.bars).toHaveLength(1);
    expect(parsed.errors).toEqual([]);

    const invalidClose = csv([`0,100,101,99,100,1,${V21_INTERVAL_MS - 2}`]);
    expect(parseBinanceKlineCsv(invalidClose, "BTCUSDT", monthPeriodForTest(0)).errors).toHaveLength(1);
  });

  it("rejects invalid OHLC while recording the parser anomaly", () => {
    const invalid = csv([`0,100,99,98,100,1,${V21_INTERVAL_MS - 1}`]);
    const parsed = parseBinanceKlineCsv(invalid, "BTCUSDT", monthPeriodForTest(0));
    expect(parsed.bars).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });

  it("detects duplicate rows and non-monotonic timestamps", () => {
    const parsed = parseBinanceKlineCsv(csv([row(0, 100), row(0, 100)]), "BTCUSDT", monthPeriodForTest(0));
    expect(parsed.duplicateOpenTimes).toBe(1);
    expect(parsed.monotonicOpenTime).toBe(false);
    expect(parsed.errors).toHaveLength(1);
  });

  it("records internal gaps and never fills synthetic rows", () => {
    const parsed = parseBinanceKlineCsv(csv([row(0, 100), row(2 * V21_INTERVAL_MS, 102)]), "BTCUSDT", {
      start: 0,
      endExclusive: 3 * V21_INTERVAL_MS,
    });
    expect(parsed.bars).toHaveLength(2);
    expect(parsed.cadenceErrors).toBe(1);
    expect(parsed.errors).toEqual([]);
  });

  it("fails the symbol coverage gate when an archive, row, or cadence is incomplete", () => {
    const slot = fakeSlot("BTCUSDT", "2021-01", { rowCount: 1, cadenceErrors: 1, checksumVerified: false });
    const coverage = evaluateV21SymbolCoverage("BTCUSDT", [slot]);
    expect(coverage.expectedRows).toBe(V21_EXPECTED_ROWS_PER_SYMBOL);
    expect(coverage.pass).toBe(false);
    expect(coverage.checksumVerifiedArchiveSlots).toBe(0);
    expect(coverage.internalGaps).toBe(1);
  });

  it("keeps the deterministic hash platform-independent and content-sensitive", () => {
    expect(canonicalTextSha256("parser-report\n")).toBe(canonicalTextSha256("parser-report\r\n"));
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
    expect(sha256("parser-report\n")).not.toBe(sha256("parser-report changed\n"));
  });

  it("keeps the pre-result boundary that remains forbidden after result generation", () => {
    expect(V21_BASE_SHA).toBe("7b9e5d82f471ee3c9fec07e00101263c8d84e953");
    expect(V21_BRANCH).toBe("feat/v21-idiosyncratic-jump-reversal");
    expect(V21_BOUNDARIES.historicalReturnsRead).toBe(false);
    expect(V21_BOUNDARIES.forwardReturnsRead).toBe(false);
    expect(V21_BOUNDARIES.featuresComputed).toBe(false);
    expect(V21_BOUNDARIES.signalsEnumerated).toBe(false);
    expect(V21_BOUNDARIES.oosMetricsRead).toBe(false);
    expect(V21_BOUNDARIES.holdoutRead).toBe(false);
    expect(V21_BOUNDARIES.parameterSearch).toBe(false);
    expect(V21_BOUNDARIES.productionEmail).toBe("OFF");
    for (const forbidden of V21_FORBIDDEN_PATHS.filter((path) => (
      path === "lib/v21/signals.ts"
      || path === "reports/v21-holdout.json"
      || path === "reports/v21-promotion-decision.md"
    ))) expect(existsSync(forbidden)).toBe(false);
  });
});

function csv(rows: string[]): string {
  return ["open_time,open,high,low,close,volume,close_time", ...rows].join("\n");
}

function row(openTime: number, close: number): string {
  return `${openTime},${close},${close + 1},${close - 1},${close},1,${openTime + V21_INTERVAL_MS - 1}`;
}

function monthPeriodForTest(openTime: number): { start: number; endExclusive: number } {
  return { start: openTime, endExclusive: 2 * V21_INTERVAL_MS };
}

function fakeSlot(
  symbol: typeof V21_SYMBOLS[number],
  month: string,
  overrides: Partial<V21ArchiveSlot> = {},
): V21ArchiveSlot {
  const period = monthPeriod(month);
  return {
    exchange: V21_ARCHIVE_EXCHANGE,
    dataType: V21_DATA_TYPE,
    symbol,
    month,
    periodStart: new Date(period.start).toISOString(),
    periodEndExclusive: new Date(period.endExclusive).toISOString(),
    interval: "5m",
    url: v21ArchiveUrl(symbol, month),
    checksumUrl: v21ChecksumUrl(symbol, month),
    status: "ERROR",
    bytes: 0,
    sha256: null,
    expectedSha256: null,
    checksumVerified: false,
    rowCount: 0,
    expectedMonthRows: Math.round((period.endExclusive - period.start) / V21_INTERVAL_MS),
    coverage: 0,
    firstOpenTime: null,
    lastOpenTime: null,
    parserErrors: [],
    duplicateOpenTimes: 0,
    cadenceErrors: 0,
    monotonicOpenTime: true,
    error: null,
    ...overrides,
  };
}
