export const V20_EXPERIMENT_ID = "V20_LAST_MARK_DISLOCATION_CONVERGENCE" as const;
export const V20_REPOSITORY = "SengC-it/Binance-Crypto-Alerts" as const;
export const V20_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const V20_BRANCH = "feat/v20-last-mark-dislocation-convergence" as const;

export const V20_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT"] as const;
export type V20Symbol = (typeof V20_SYMBOLS)[number];

export const V20_START_TIMESTAMP = "2021-01-01T00:00:00.000Z" as const;
export const V20_END_TIMESTAMP = "2026-07-31T23:59:59.999Z" as const;
export const V20_END_EXCLUSIVE_TIMESTAMP = "2026-08-01T00:00:00.000Z" as const;
export const V20_MONTH_COUNT = 67;
export const V20_EXPECTED_ARCHIVE_SLOTS = V20_SYMBOLS.length * V20_MONTH_COUNT * 3;

export const V20_INTERVAL_MS = 5 * 60 * 1000;
export const V20_PIT_WINDOW_DAYS = 30;
export const V20_PIT_WINDOW_BARS = (V20_PIT_WINDOW_DAYS * 24 * 60) / 5;
export const V20_PIT_WINDOW_MS = V20_PIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const V20_SIGNAL_QUANTILE = 0.99;
export const V20_PRIMARY_HORIZON_MINUTES = 5;
export const V20_SECONDARY_HORIZONS_MINUTES = [15, 30] as const;
export const V20_TAKER_FEE_BPS_PER_SIDE = 4;
export const V20_SLIPPAGE_BPS_PER_SIDE = 2;
export const V20_BASELINE_ROUND_TRIP_BPS = 12;
export const V20_STRESS_ADDITIONAL_ROUND_TRIP_BPS = [5, 10, 20] as const;

export const V20_WARMUP_START = "2021-01-01T00:00:00.000Z" as const;
export const V20_PRIMARY_OOS_START = "2022-01-01T00:00:00.000Z" as const;
export const V20_PRIMARY_OOS_END = "2024-12-31T23:59:59.999Z" as const;
export const V20_HOLDOUT_A_START = "2025-01-01T00:00:00.000Z" as const;
export const V20_HOLDOUT_A_END = "2025-12-31T23:59:59.999Z" as const;
export const V20_HOLDOUT_B_START = "2026-01-01T00:00:00.000Z" as const;
export const V20_HOLDOUT_B_END = V20_END_TIMESTAMP;

export const V20_PARAMETERS = {
  dataSource: "official Binance Data Vision monthly USD-M futures archives",
  signalTimeframe: "5m",
  synchronizedJoin: "exact inner join on openTime across regular, markPrice, and indexPrice klines",
  primaryAlphaFields: ["lastClose", "markClose", "openTime"],
  controlFields: {
    lastIndex: ["lastClose", "indexClose", "openTime"],
    lastReturn: ["lastClose", "openTime"],
  },
  pitHistory: "[t-30d,t)",
  pitWindowBars: V20_PIT_WINDOW_BARS,
  center: "arithmetic median of the prior 30 calendar days of synchronized 5m gaps; even window averages the two middle observations",
  quantile: "nearest-rank Q99 of prior absolute deviations from the PIT median",
  firstCross: "abs(prevDev) < threshold_t AND abs(dev_t) >= threshold_t",
  positiveDeviationDirection: "SHORT",
  negativeDeviationDirection: "LONG",
  primaryExecution: "next complete regular USD-M futures 5m candle OPEN",
  primaryExit: "next entry candle CLOSE; one complete 5m candle",
  overlapRule: "same-symbol primary events with a signal openTime less than 5m after the last accepted event are excluded",
  clusterId: "signalTimestamp",
  costModel: {
    takerFeeBpsPerSide: V20_TAKER_FEE_BPS_PER_SIDE,
    slippageBpsPerSide: V20_SLIPPAGE_BPS_PER_SIDE,
    baselineRoundTripBps: V20_BASELINE_ROUND_TRIP_BPS,
    additionalRoundTripStressBps: [...V20_STRESS_ADDITIONAL_ROUND_TRIP_BPS],
  },
  secondaryDiagnostics: [...V20_SECONDARY_HORIZONS_MINUTES],
} as const;

export const V20_CONTROLS = {
  controlA: "LAST_INDEX_DISLOCATION: same PIT median/Q99/first-cross rule with lastClose/indexClose gap",
  controlB: "EXTREME_LAST_RETURN_REVERSAL: prior PIT nearest-rank Q99 of abs(log last-close return), first-cross rule",
  controlC: "TIME_MATCHED_RANDOM: deterministic real-bar identities matched by symbol/month/UTC hour/direction frequency",
  controlUse: "explanatory only; never used for parameter selection",
} as const;

export const V20_PROMOTION_GATES = {
  data: {
    archiveSlots: V20_EXPECTED_ARCHIVE_SLOTS,
    datasetCoverageMinimum: 0.999,
    symbols: V20_SYMBOLS.length,
  },
  preReturn: {
    primaryOosEligibleEventsMinimum: 500,
    primaryOosSignalClustersMinimum: 250,
    perSymbolPrimaryOosEventsMinimum: 75,
  },
  performance: {
    primaryNetPositive: true,
    primaryProfitFactorMinimum: 1.2,
    primaryAverageNetReturnPositive: true,
    clusterBootstrapLCB95Positive: true,
    holdoutANetPositive: true,
    holdoutBNetPositive: true,
    stress10bpsNetPositive: true,
  },
  breadth: {
    profitableSymbolsMinimum: 3,
    profitableYearsMinimum: 2,
    years: [2022, 2023, 2024],
  },
  concentration: {
    maxSymbolTradeShare: 0.4,
    maxSymbolPositiveGrossContribution: 0.45,
  },
  informationGain: "primary AvgNet must exceed LAST_INDEX_DISLOCATION and EXTREME_LAST_RETURN_REVERSAL",
} as const;

export const V20_BOUNDARIES = {
  historicalReturnsRead: false,
  forwardReturnsRead: false,
  oosMetricsRead: false,
  holdoutRead: false,
  parameterSearch: false,
  resultCommitCreated: false,
  productionChanged: false,
  productionEmail: "OFF",
  deploy: false,
  merge: false,
  migration: false,
  privateBinanceApi: false,
  orderPlacement: false,
  autoTrading: false,
  automaticPromotion: false,
} as const;

export const V20_REPORT_FILES = [
  "reports/v20-archive-manifest.json",
  "reports/v20-parser-report.json",
  "reports/v20-sync-report.json",
  "reports/v20-data-gate.json",
  "reports/v20-pre-return-assessment.json",
  "reports/v20-freeze-manifest.json",
] as const;

export const V20_SOURCE_FILES = [
  "lib/v20/constants.ts",
  "lib/v20/canonical.ts",
  "lib/v20/archive.ts",
  "lib/v20/sync.ts",
  "lib/v20/signals.ts",
  "scripts/run-v20-freeze.ts",
  "scripts/validate-v20-freeze.ts",
  "tests/v20-freeze.test.ts",
  "package.json",
] as const;

export type V20EvaluationWindow = "WARMUP" | "PRIMARY_OOS" | "HOLDOUT_A" | "HOLDOUT_B";

export function evaluationWindowFor(timestamp: number): V20EvaluationWindow | null {
  if (timestamp < Date.parse(V20_PRIMARY_OOS_START)) return "WARMUP";
  if (timestamp <= Date.parse(V20_PRIMARY_OOS_END)) return "PRIMARY_OOS";
  if (timestamp <= Date.parse(V20_HOLDOUT_A_END)) return "HOLDOUT_A";
  if (timestamp <= Date.parse(V20_HOLDOUT_B_END)) return "HOLDOUT_B";
  return null;
}
export function v20MonthKeys(): string[] {
  const months: string[] = [];
  for (let year = 2021; year <= 2026; year += 1) {
    const lastMonth = year === 2026 ? 7 : 12;
    for (let month = 1; month <= lastMonth; month += 1) {
      months.push(`${year}-${String(month).padStart(2, "0")}`);
    }
  }
  return months;
}

export function monthPeriod(month: string): { start: number; endExclusive: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid YYYY-MM month: ${month}`);
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  const endExclusive = Date.UTC(Number(match[1]), Number(match[2]), 1);
  return { start, endExclusive };
}
