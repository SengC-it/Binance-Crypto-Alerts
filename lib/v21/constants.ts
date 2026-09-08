export const V21_EXPERIMENT_ID = "V21_CROSS_SECTIONAL_IDIOSYNCRATIC_JUMP_REVERSAL" as const;
export const V21_REPOSITORY = "SengC-it/Binance-Crypto-Alerts" as const;
export const V21_BASE_SHA = "7b9e5d82f471ee3c9fec07e00101263c8d84e953" as const;
export const V21_BRANCH = "feat/v21-idiosyncratic-jump-reversal" as const;

export const V21_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "DOTUSDT",
] as const;
export type V21Symbol = (typeof V21_SYMBOLS)[number];

export const V21_START_TIMESTAMP = "2021-01-01T00:00:00.000Z" as const;
export const V21_END_TIMESTAMP = "2026-07-31T23:59:59.999Z" as const;
export const V21_END_EXCLUSIVE_TIMESTAMP = "2026-08-01T00:00:00.000Z" as const;
export const V21_INTERVAL_MS = 5 * 60 * 1000;
export const V21_MONTH_COUNT = 67;
export const V21_EXPECTED_ARCHIVE_SLOTS = V21_SYMBOLS.length * V21_MONTH_COUNT;
export const V21_EXPECTED_ROWS_PER_SYMBOL = Math.round(
  (Date.parse(V21_END_EXCLUSIVE_TIMESTAMP) - Date.parse(V21_START_TIMESTAMP)) / V21_INTERVAL_MS,
);

export const V21_BOUNDARIES = {
  historicalReturnsRead: false,
  forwardReturnsRead: false,
  featuresComputed: false,
  signalsEnumerated: false,
  oosMetricsRead: false,
  holdoutRead: false,
  parameterSearch: false,
  freezeCreated: false,
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

export const V21_REPORT_FILES = [
  "reports/v21-archive-manifest.json",
  "reports/v21-parser-report.json",
  "reports/v21-data-gate.json",
  "reports/v21-data-stage-manifest.json",
  "reports/v21-feature-stage-manifest.json",
  "reports/v21-scan-feasibility.json",
  "reports/v21-scan-stage-manifest.json",
  "reports/v21-event-predicate-feasibility.json",
  "reports/v21-event-predicate-stage-manifest.json",
  "reports/v21-event-enumeration.json",
  "reports/v21-event-identities.json",
  "reports/v21-event-stage-manifest.json",
] as const;

export const V21_FORBIDDEN_PATHS = [
  "lib/v21/signals.ts",
  "scripts/run-v21-result.ts",
  "reports/v21-primary-oos.json",
  "reports/v21-holdout.json",
  "reports/v21-performance.json",
  "reports/v21-result.json",
  "reports/v21-promotion-decision.json",
  "reports/v21-promotion-decision.md",
] as const;

export function v21MonthKeys(): string[] {
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
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new Error(`Invalid month number: ${month}`);
  const start = Date.UTC(year, monthNumber - 1, 1);
  return { start, endExclusive: Date.UTC(year, monthNumber, 1) };
}
