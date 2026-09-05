export const V19_EXPERIMENT_ID = "V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP" as const;
export const V19_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const V19_BRANCH = "feat/v19-btc-shock-alt-catchup" as const;

export const V19_LEADER_SYMBOL = "BTCUSDT" as const;
export const V19_FOLLOWER_CANDIDATES = [
  "BNBUSDT",
  "ADAUSDT",
  "XRPUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "DOTUSDT",
] as const;
export const V19_CANDIDATE_SYMBOLS = [V19_LEADER_SYMBOL, ...V19_FOLLOWER_CANDIDATES] as const;

export const V19_START_TIMESTAMP = "2021-01-01T00:00:00.000Z" as const;
export const V19_END_TIMESTAMP = "2026-07-31T23:59:59.999Z" as const;
export const V19_END_EXCLUSIVE_TIMESTAMP = "2026-08-01T00:00:00.000Z" as const;
export const V19_MONTH_COUNT = 67;
export const V19_EXPECTED_ARCHIVE_SLOTS = V19_CANDIDATE_SYMBOLS.length * V19_MONTH_COUNT;

export const V19_INTERVAL_MS = 5 * 60 * 1000;
export const V19_PIT_WINDOW_DAYS = 30;
export const V19_PIT_WINDOW_MS = V19_PIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const V19_BTC_SHOCK_QUANTILE = 0.99;
export const V19_UNDERREACTION_QUANTILE = 0.9;
export const V19_PRIMARY_HORIZON_MINUTES = 15;
export const V19_SECONDARY_HORIZONS_MINUTES = [30, 60] as const;
export const V19_TAKER_FEE_BPS_PER_SIDE = 4;
export const V19_SLIPPAGE_BPS_PER_SIDE = 3;
export const V19_BASELINE_ROUND_TRIP_BPS = 14;
export const V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS = [5, 10, 20] as const;

export const V19_WARMUP_START = "2021-01-01T00:00:00.000Z" as const;
export const V19_PRIMARY_OOS_START = "2022-01-01T00:00:00.000Z" as const;
export const V19_PRIMARY_OOS_END = "2024-12-31T23:59:59.999Z" as const;
export const V19_HOLDOUT_A_START = "2025-01-01T00:00:00.000Z" as const;
export const V19_HOLDOUT_A_END = "2025-12-31T23:59:59.999Z" as const;
export const V19_HOLDOUT_B_START = "2026-01-01T00:00:00.000Z" as const;
export const V19_HOLDOUT_B_END = V19_END_TIMESTAMP;

export const V19_PARAMETERS = {
  signalTimeframe: "5m",
  pitHistory: "[t-30d,t)",
  btcShockDefinition: "abs(log(BTC_close_t / BTC_close_t-1)) >= nearest-rank Q99(abs(prior synchronized BTC log returns))",
  betaModel: "OLS follower_log_return = alpha + beta * BTC_log_return using prior synchronized 5m rows only",
  underreactionDefinition: "-sign(BTC_log_return_t) * (follower_log_return_t - (alpha + beta * BTC_log_return_t))",
  underreactionThreshold: "nearest-rank Q90 of prior PIT directional underreaction values",
  liquidityMeasure: "median prior-30d tradeCount",
  liquidityClassification: "ascending prior median tradeCount; bottom ceil(n/2); alphabetical symbol tie-break",
  primaryExecution: "next complete 5m candle OPEN",
  primaryExit: "close of the candle ending exactly 15 minutes after entry",
  overlapRule: "same follower signal timestamps less than 15 minutes apart are excluded",
  clusterId: "btcShockTimestamp",
  dataFieldsUsedForAlpha: ["openTime", "close", "tradeCount"],
  retainedButNotUsedForAlpha: ["high", "low", "volume", "quoteVolume", "takerBuyBaseVolume", "takerBuyQuoteVolume"],
  costModel: {
    takerFeeBpsPerSide: V19_TAKER_FEE_BPS_PER_SIDE,
    slippageBpsPerSide: V19_SLIPPAGE_BPS_PER_SIDE,
    baselineRoundTripBps: V19_BASELINE_ROUND_TRIP_BPS,
    additionalRoundTripStressBps: [...V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS],
  },
  secondaryDiagnostics: [...V19_SECONDARY_HORIZONS_MINUTES],
} as const;

export const V19_CONTROLS = {
  controlA: "BTC_SHOCK_ONLY_LOW_LIQ: same shock and low-liquidity followers without underreaction Q90",
  controlB: "HIGH_LIQUIDITY_UNDERREACTION: same shock, beta, and underreaction using top-half liquidity followers",
  controlC: "TIME_MATCHED_RANDOM: follower/month/UTC hour/direction-frequency matched random events",
  controlUse: "explanatory only; never used for parameter selection",
} as const;

export const V19_PROMOTION_GATES = {
  data: {
    eligibleFollowersMinimum: 5,
    primaryDeoverlappedTradesMinimum: 500,
    distinctShockClustersMinimum: 200,
    followerSymbolsMinimum: 4,
    perFollowerPrimaryTradesMinimum: 50,
  },
  performance: {
    primaryNetPositive: true,
    primaryProfitFactorMinimum: 1.25,
    primaryAverageNetReturnPositive: true,
    clusterBootstrapLCB95Positive: true,
    holdoutANetPositive: true,
    holdoutBNetPositive: true,
    stress10bpsNetPositive: true,
  },
  breadth: {
    profitableFollowerSymbolsMinimum: 4,
    profitableYearsMinimum: 2,
    years: [2022, 2023, 2024],
  },
  concentration: {
    maxFollowerTradeCountShare: 0.35,
    maxFollowerPositiveGrossContribution: 0.4,
  },
  informationGain: "primary average net return must exceed both explanatory controls",
} as const;

export const V19_BOUNDARIES = {
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

export const V19_REPORT_FILES = [
  "reports/v19-universe-feasibility.json",
  "reports/v19-archive-manifest.json",
  "reports/v19-parser-report.json",
  "reports/v19-data-gate.json",
  "reports/v19-pre-return-assessment.json",
  "reports/v19-freeze-manifest.json",
] as const;

export const V19_SOURCE_FILES = [
  "lib/v19/constants.ts",
  "lib/v19/canonical.ts",
  "lib/v19/features.ts",
  "lib/v19/archive.ts",
  "scripts/run-v19-freeze.ts",
  "scripts/validate-v19-freeze.ts",
  "tests/v19-freeze.test.ts",
  "package.json",
] as const;

export type V19Side = "LONG" | "SHORT";
export type V19EvaluationWindow = "WARMUP" | "PRIMARY_OOS" | "HOLDOUT_A" | "HOLDOUT_B";

export function evaluationWindowFor(timestamp: number): V19EvaluationWindow | null {
  if (timestamp < Date.parse(V19_PRIMARY_OOS_START)) return "WARMUP";
  if (timestamp <= Date.parse(V19_PRIMARY_OOS_END)) return "PRIMARY_OOS";
  if (timestamp <= Date.parse(V19_HOLDOUT_A_END)) return "HOLDOUT_A";
  if (timestamp <= Date.parse(V19_HOLDOUT_B_END)) return "HOLDOUT_B";
  return null;
}
