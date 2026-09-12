export const V23_EXPERIMENT_ID = "V23_TERM_STRUCTURE_BASIS_STATE" as const;
export const V23_FAMILY = "same-underlying futures term-structure basis state" as const;
export const V23_BRANCH = "feat/v23-term-structure-basis" as const;
export const V23_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const V23_R1_ADMISSION_SHA = "6c5c415023683b6d8905aae2444af28d1510d9b6" as const;
export const V23_V22_TERMINAL_SHA = "160cf38780dfd14ed8e6119bcb6c6841fad6fd93" as const;

export const V23_START_MS = Date.parse("2022-01-01T00:00:00.000Z");
export const V23_END_MS = Date.parse("2026-08-01T00:00:00.000Z");
export const V23_INTERVAL_MS = 60 * 60 * 1000;
export const V23_COVERAGE_THRESHOLD = 0.995;
export const V23_MAX_ALLOWED_GAP_HOURS = 24;

export const V23_UNDERLYINGS = ["BTC", "ETH"] as const;
export type V23Underlying = (typeof V23_UNDERLYINGS)[number];

export const V23_TARGET_SYMBOLS: Record<V23Underlying, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
};

export const V23_SERIES_TYPES = [
  "TARGET_USDM_PERPETUAL",
  "INDEX_PRICE",
  "PERPETUAL",
  "CURRENT_QUARTER",
  "NEXT_QUARTER",
] as const;
export type V23SeriesType = (typeof V23_SERIES_TYPES)[number];

export const V23_REQUIRED_SERIES = [
  "TARGET_USDM_PERPETUAL",
  "INDEX_PRICE",
  "CURRENT_QUARTER",
  "NEXT_QUARTER",
] as const satisfies readonly V23SeriesType[];

export const V23_PERIODS = ["PRIMARY", "HOLDOUT_A", "HOLDOUT_B"] as const;
export type V23Period = (typeof V23_PERIODS)[number];

export interface V23Candle {
  underlying: V23Underlying;
  seriesType: V23SeriesType;
  openTimeUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTimeUtc: string;
  closed: true;
}

export interface V23PeriodQuality {
  expectedRows: number;
  actualRows: number;
  coverageRatio: number;
}

export interface V23SeriesQuality extends V23PeriodQuality {
  underlying: V23Underlying;
  seriesType: V23SeriesType;
  transportDuplicates: number;
  identicalDuplicates: number;
  conflictingDuplicates: number;
  canonicalDuplicates: number;
  canonicalNonMonotonic: number;
  invalidRows: number;
  missingRows: number;
  maxContiguousMissingHours: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  primary: V23PeriodQuality;
  holdoutA: V23PeriodQuality;
  holdoutB: V23PeriodQuality;
}

export interface V23BasisRow {
  timestampUtc: string;
  currentBasis: number;
  nextBasis: number;
  curveSlope: number;
  perpetualBasis?: number;
}

export interface V23RollTransition {
  transitionTimestamp: string;
  seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER";
  preClose: number;
  postOpen: number;
  postClose: number;
  rawGap: number;
}
