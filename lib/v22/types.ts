export const V22_EXPERIMENT_ID = "V22_CROSS_VENUE_PRICE_DISCOVERY" as const;
export const V22_BRANCH = "feat/v22-cross-venue-price-discovery" as const;
export const V22_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const R1_FINAL_GATE_COMMIT = "6c5c415023683b6d8905aae2444af28d1510d9b6" as const;

export const V22_START_MS = Date.parse("2023-07-01T00:00:00.000Z");
export const V22_END_MS = Date.parse("2026-08-01T00:00:00.000Z");
export const V22_INTERVAL_MS = 5 * 60 * 1000;

export const V22_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
] as const;

export type V22Symbol = (typeof V22_SYMBOLS)[number];
export type V22Venue = "BINANCE_USDM" | "OKX_USDT_SWAP";

export const V22_OKX_INSTRUMENTS: Record<V22Symbol, string> = {
  BTCUSDT: "BTC-USDT-SWAP",
  ETHUSDT: "ETH-USDT-SWAP",
  SOLUSDT: "SOL-USDT-SWAP",
  XRPUSDT: "XRP-USDT-SWAP",
  DOGEUSDT: "DOGE-USDT-SWAP",
};

export interface V22Candle {
  venue: V22Venue;
  instrument: string;
  symbol: V22Symbol;
  openTimeUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTimeUtc: number;
  closed: boolean;
}

export interface V22Quality {
  expected5mRows: number;
  actualRows: number;
  coverageRatio: number;
  duplicates: number;
  nonMonotonic: number;
  sourceOrderNonMonotonic: number;
  canonicalNonMonotonic: number;
  transportDuplicateRows: number;
  exactIdenticalDuplicateRows: number;
  conflictingDuplicateRows: number;
  canonicalDuplicateRows: number;
  invalidRows: number;
  missingRows: number;
  maxContiguousMissingMinutes: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  primaryCoverage: number;
  holdoutACoverage: number;
  holdoutBCoverage: number;
  exactTimestampIntersectionRows?: number;
  synchronizedCoverageRatio?: number;
}

export interface V22SourceRecord {
  venue: V22Venue;
  symbol: V22Symbol;
  instrument: string;
  interval: "5m";
  period: { start: string; endExclusive: string };
  sourceType: "BINANCE_OFFICIAL_ARCHIVE" | "OKX_OFFICIAL_PUBLIC_API";
  sourceIdentity: string;
  byteLength: number;
  sha256: string;
  officialChecksum?: string;
  downloadStatus: "PASS" | "FAIL";
}
