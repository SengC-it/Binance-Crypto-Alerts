export const V24_EXPERIMENT_ID = "V24_ORDER_BOOK_LIQUIDITY_WITHDRAWAL" as const;
export const V24_FAMILY = "near-book liquidity withdrawal / depth-state change" as const;
export const V24_INFORMATION_SOURCE_CLASS = "LIQUIDITY_WITHDRAWAL" as const;
export const V24_BRANCH = "feat/v24-liquidity-withdrawal" as const;
export const V24_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const V24_R1_ADMISSION_SHA = "6c5c415023683b6d8905aae2444af28d1510d9b6" as const;
export const V24_V22_TERMINAL_SHA = "160cf38780dfd14ed8e6119bcb6c6841fad6fd93" as const;
export const V24_V23_TERMINAL_SHA = "c6e9f008b308317f777ff4685575b32673306f15" as const;

export const V24_START_MS = Date.parse("2023-01-01T00:00:00.000Z");
export const V24_END_MS = Date.parse("2026-08-01T00:00:00.000Z");
export const V24_BOOK_DEPTH_CADENCE_MS = 30_000;
export const V24_DECISION_INTERVAL_MS = 5 * 60 * 1000;
export const V24_MAX_SNAPSHOT_AGE_MS = 90_000;
export const V24_MAX_UNAVAILABLE_MINUTES = 60;
export const V24_COVERAGE_THRESHOLD = 0.995;
export const V24_TARGET_COVERAGE_THRESHOLD = 0.999;
export const V24_MAX_PRICE_ANCHOR_LOG_DEVIATION = Math.log(1.15);

export const V24_UNDERLYINGS = ["BTC", "ETH"] as const;
export type V24Underlying = (typeof V24_UNDERLYINGS)[number];

export const V24_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type V24Symbol = (typeof V24_SYMBOLS)[number];

export const V24_SYMBOL_BY_UNDERLYING: Record<V24Underlying, V24Symbol> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
};

export const V24_PERIODS = ["PRIMARY", "HOLDOUT_A", "HOLDOUT_B"] as const;
export type V24Period = (typeof V24_PERIODS)[number];

export const V24_REQUIRED_BANDS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5] as const;
export type V24RequiredBand = (typeof V24_REQUIRED_BANDS)[number];
export const V24_BOOK_DEPTH_HEADER = ["timestamp", "percentage", "depth", "notional"] as const;

export interface V24DepthRow {
  timestampUtc: string;
  timestampMs: number;
  percentage: number;
  depth: number;
  notional: number;
}

export interface V24ParsedDepthRows {
  rows: V24DepthRow[];
  invalidRows: number;
  transportRows: number;
  headerValid: boolean;
}

export interface V24TargetCandle {
  openTimeMs: number;
  closeTimeMs: number;
  close: number;
}

export interface V24ParsedTargetRows {
  rows: V24TargetCandle[];
  invalidRows: number;
  transportRows: number;
  headerValid: boolean;
}

export interface V24SnapshotAudit {
  timestampUtc: string;
  date: string;
  rowCount: number;
  requiredBandsPresent: boolean;
  missingBands: number[];
  invalidRows: number;
  monotonicityViolations: number;
  priceAnchorChecked: boolean;
  priceAnchorValid: boolean;
  priceAnchorViolations: number;
  valid: boolean;
  fingerprint: string;
}

export interface V24PeriodQuality {
  expectedBookDepthSnapshots: number;
  canonicalSnapshots: number;
  validSnapshots: number;
  validSnapshotRatio: number;
  expected5mSlots: number;
  valid5mSlots: number;
  valid5mCoverage: number;
  targetExpected5mSlots: number;
  targetRows: number;
  targetCoverage: number;
}

export interface V24SeriesQuality {
  symbol: V24Symbol;
  expectedDays: number;
  archivePresenceDays: number;
  archivePresenceRatio: number;
  checksumVerifiedArchives: number;
  checksumVerifiedRatio: number;
  totalTransportRows: number;
  totalCanonicalSnapshots: number;
  validSnapshots: number;
  requiredBandValidityRatio: number;
  negativeRows: number;
  invalidRows: number;
  missingBandSnapshots: number;
  monotonicityViolations: number;
  priceAnchorCheckedSnapshots: number;
  priceAnchorValidSnapshots: number;
  priceAnchorValidityRatio: number;
  transportDuplicateRows: number;
  identicalDuplicateRows: number;
  conflictingDuplicateRows: number;
  canonicalDuplicateRows: number;
  nonMonotonicTimestamps: number;
  medianIntervalSeconds: number | null;
  p5IntervalSeconds: number | null;
  p95IntervalSeconds: number | null;
  maximumIntervalSeconds: number | null;
  maxContiguousGapMinutes: number;
  maxIdenticalFingerprintDurationMinutes: number;
  staleIntervals: number;
  expected5mSlots: number;
  valid5mSlots: number;
  valid5mCoverage: number;
  maxContiguousUnavailableMinutes: number;
  targetExpected5mSlots: number;
  targetRows: number;
  targetCoverage: number;
  primary: V24PeriodQuality;
  holdoutA: V24PeriodQuality;
  holdoutB: V24PeriodQuality;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface V24ArchiveEntry {
  symbol: V24Symbol;
  date: string;
  sourceUrl: string;
  checksumUrl: string;
  bodyPath: string;
  checksumPath: string;
  httpStatus: number;
  checksumHttpStatus: number;
  responseByteLength: number;
  zipSha256: string;
  officialChecksum: string | null;
  checksumVerified: boolean;
  archiveEntry: string | null;
  extractedCsvSha256: string | null;
  rowCount: number;
  retrievedAt: string;
  error: string | null;
}

export interface V24TargetArchiveEntry {
  symbol: V24Symbol;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  bodyPath: string;
  checksumPath: string;
  httpStatus: number;
  checksumHttpStatus: number;
  responseByteLength: number;
  zipSha256: string;
  officialChecksum: string | null;
  checksumVerified: boolean;
  archiveEntry: string | null;
  extractedCsvSha256: string | null;
  rowCount: number;
  retrievedAt: string;
  error: string | null;
}

export interface V24DownloadManifest {
  schema: "v24-download-manifest-v1";
  source: "Binance official Data Vision USD-M daily bookDepth and 5m klines";
  authenticationRequired: false;
  accountPermissionRequired: false;
  tradingPermissionRequired: false;
  start: string;
  endExclusive: string;
  bookDepthCadence: "30s";
  targetInterval: "5m";
  symbols: readonly V24Symbol[];
  bookDepthEntries: V24ArchiveEntry[];
  targetEntries: V24TargetArchiveEntry[];
}

export interface V24LiveFeedSymbolResult {
  symbol: V24Symbol;
  depthUrl: string;
  tickerUrl: string;
  httpStatus: number;
  depthLimit: number;
  updateId: number | null;
  timestamp: string | null;
  bids: number;
  asks: number;
  bidsWithin1Pct: boolean;
  asksWithin1Pct: boolean;
  reconstructibleWithin1Pct: boolean;
  rateLimitMetadata: Record<string, string>;
  vercelRuntimeCompatible: boolean;
  authenticationRequired: false;
  tradingPermissionRequired: false;
  error: string | null;
}
