export const V16_BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
export const V16_BRANCH = "feat/v16-aggtrade-absorption";
export const V16_START = "2021-01-01T00:00:00.000Z";
export const V16_END = "2026-07-31T23:59:59.999Z";
export const V16_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type V16Symbol = (typeof V16_SYMBOLS)[number];

export const V16_GATE_THRESHOLDS = {
  usedZipChecksumCoverage: 1,
  aggTradeCoverage: 0.99,
  klineCoverage: 0.99,
  featureCoverage: 0.99,
  executionPriceCoverage: 0.99,
  fundingSettlementCoverage: 1,
} as const;

export const V16_DATASET_KINDS = [
  "aggTrades",
  "klines-1m",
  "klines-5m",
  "fundingRate",
  "markPriceKlines",
] as const;
export type V16DatasetKind = (typeof V16_DATASET_KINDS)[number];

export interface V16ArchiveSlot {
  dataset: V16DatasetKind;
  symbol: V16Symbol;
  month: string;
  url: string;
  localPath: string;
}

export interface V16CoverageInput {
  requiredArchiveSlots: number;
  materializedArchiveSlots: number;
  usedArchiveSlots: number;
  usedZipChecksumCoverage: number;
  officialArchiveInventoryComplete?: boolean;
  aggTradeCoverage: Record<V16Symbol, number>;
  klineCoverage: Record<V16Symbol, number>;
  timestampMonotonicity: Record<V16Symbol, boolean>;
  aggTradeIdMonotonicity: Record<V16Symbol, boolean>;
  aggTradeFieldValidity?: Record<V16Symbol, boolean>;
  duplicateCoverage: Record<V16Symbol, number>;
  klineCadence?: Record<V16Symbol, boolean>;
  fundingFieldValidity?: Record<V16Symbol, boolean>;
  featureCoverage: number;
  executionPriceCoverage: number;
  fundingSettlementCoverage: number;
  markSettlementCoverage?: number;
}

export interface V16DataGateResult {
  status: "PASS" | "FAIL";
  classification: "PASS" | "V16_DATA_INSUFFICIENT_FINAL";
  reasons: string[];
  gates: {
    officialArchiveInventory: boolean;
    usedZipChecksum: boolean;
    aggTradeCoverage: boolean;
    klineCoverage: boolean;
    timestampMonotonicity: boolean;
    aggTradeIdMonotonicity: boolean;
    aggTradeFieldValidity: boolean;
    duplicateCoverage: boolean;
    klineCadence: boolean;
    featureCoverage: boolean;
    executionPriceCoverage: boolean;
    fundingSettlementCoverage: boolean;
    markSettlementCoverage: boolean;
    fundingFieldValidity: boolean;
  };
}

export function v16Months(): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.parse(V16_START));
  const end = Date.parse(V16_END);
  while (cursor.getTime() <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function expectedV16ArchiveSlots(): V16ArchiveSlot[] {
  const baseUrl = "https://data.binance.vision/data/futures/um/monthly";
  const slots: V16ArchiveSlot[] = [];
  for (const symbol of V16_SYMBOLS) {
    for (const month of v16Months()) {
      for (const dataset of V16_DATASET_KINDS) {
        const { directory, fileName } = archiveLocation(dataset, symbol, month);
        slots.push({
          dataset,
          symbol,
          month,
          url: `${baseUrl}/${directory}/${fileName}`,
          localPath: `data/raw/v16-aggtrade-absorption/${dataset === "aggTrades" ? `${directory}/${month}` : directory}/${fileName}`,
        });
      }
    }
  }
  return slots;
}

export function archiveLocation(dataset: V16DatasetKind, symbol: V16Symbol, month: string): { directory: string; fileName: string } {
  switch (dataset) {
    case "aggTrades":
      return { directory: `aggTrades/${symbol}`, fileName: `${symbol}-aggTrades-${month}.zip` };
    case "klines-1m":
      return { directory: `klines/${symbol}/1m`, fileName: `${symbol}-1m-${month}.zip` };
    case "klines-5m":
      return { directory: `klines/${symbol}/5m`, fileName: `${symbol}-5m-${month}.zip` };
    case "fundingRate":
      return { directory: `fundingRate/${symbol}`, fileName: `${symbol}-fundingRate-${month}.zip` };
    case "markPriceKlines":
      return { directory: `markPriceKlines/${symbol}/5m`, fileName: `${symbol}-5m-${month}.zip` };
  }
}

export function evaluateV16DataGate(input: V16CoverageInput): V16DataGateResult {
  const aggTradeCoverage = Math.min(...V16_SYMBOLS.map((symbol) => input.aggTradeCoverage[symbol]));
  const klineCoverage = Math.min(...V16_SYMBOLS.map((symbol) => input.klineCoverage[symbol]));
  const timestampMonotonicity = V16_SYMBOLS.every((symbol) => input.timestampMonotonicity[symbol]);
  const aggTradeIdMonotonicity = V16_SYMBOLS.every((symbol) => input.aggTradeIdMonotonicity[symbol]);
  const aggTradeFieldValidity = input.aggTradeFieldValidity === undefined || V16_SYMBOLS.every((symbol) => input.aggTradeFieldValidity?.[symbol] === true);
  const duplicateCoverage = V16_SYMBOLS.every((symbol) => input.duplicateCoverage[symbol] >= 1);
  const klineCadence = input.klineCadence === undefined || V16_SYMBOLS.every((symbol) => input.klineCadence?.[symbol] === true);
  const markSettlementCoverage = input.markSettlementCoverage ?? input.fundingSettlementCoverage;
  const fundingFieldValidity = input.fundingFieldValidity === undefined || V16_SYMBOLS.every((symbol) => input.fundingFieldValidity?.[symbol] === true);
  const gates = {
    officialArchiveInventory: (input.officialArchiveInventoryComplete ?? true) && input.requiredArchiveSlots > 0 && input.materializedArchiveSlots === input.requiredArchiveSlots,
    usedZipChecksum: input.usedArchiveSlots > 0 && input.usedZipChecksumCoverage >= V16_GATE_THRESHOLDS.usedZipChecksumCoverage,
    aggTradeCoverage: aggTradeCoverage >= V16_GATE_THRESHOLDS.aggTradeCoverage,
    klineCoverage: klineCoverage >= V16_GATE_THRESHOLDS.klineCoverage,
    timestampMonotonicity,
    aggTradeIdMonotonicity,
    aggTradeFieldValidity,
    duplicateCoverage,
    klineCadence,
    featureCoverage: input.featureCoverage >= V16_GATE_THRESHOLDS.featureCoverage,
    executionPriceCoverage: input.executionPriceCoverage >= V16_GATE_THRESHOLDS.executionPriceCoverage,
    fundingSettlementCoverage: input.fundingSettlementCoverage >= V16_GATE_THRESHOLDS.fundingSettlementCoverage,
    markSettlementCoverage: markSettlementCoverage >= V16_GATE_THRESHOLDS.fundingSettlementCoverage,
    fundingFieldValidity,
  };
  const reasons: string[] = [];
  if (!gates.officialArchiveInventory) reasons.push("OFFICIAL_ARCHIVE_INVENTORY_INCOMPLETE");
  if (!gates.usedZipChecksum) reasons.push("USED_ZIP_CHECKSUM_COVERAGE_BELOW_100_PERCENT");
  if (!gates.aggTradeCoverage) reasons.push("AGGTRADE_COVERAGE_BELOW_99_PERCENT");
  if (!gates.klineCoverage) reasons.push("KLINE_COVERAGE_BELOW_99_PERCENT");
  if (!gates.timestampMonotonicity) reasons.push("AGGTRADE_TIMESTAMP_MONOTONICITY_NOT_PROVEN");
  if (!gates.aggTradeIdMonotonicity) reasons.push("AGGTRADE_ID_MONOTONICITY_NOT_PROVEN");
  if (!gates.aggTradeFieldValidity) reasons.push("AGGTRADE_FIELD_VALIDITY_FAILED");
  if (!gates.duplicateCoverage) reasons.push("AGGTRADE_DUPLICATE_COVERAGE_NOT_PROVEN");
  if (!gates.klineCadence) reasons.push("KLINE_CADENCE_NOT_PROVEN");
  if (!gates.featureCoverage) reasons.push("FEATURE_COVERAGE_BELOW_99_PERCENT");
  if (!gates.executionPriceCoverage) reasons.push("EXECUTION_PRICE_COVERAGE_BELOW_99_PERCENT");
  if (!gates.fundingSettlementCoverage) reasons.push("FUNDING_SETTLEMENT_COVERAGE_BELOW_100_PERCENT");
  if (!gates.markSettlementCoverage) reasons.push("MARK_SETTLEMENT_COVERAGE_BELOW_100_PERCENT");
  if (!gates.fundingFieldValidity) reasons.push("FUNDING_FIELD_VALIDITY_FAILED");
  const status = reasons.length === 0 ? "PASS" : "FAIL";
  return {
    status,
    classification: status === "PASS" ? "PASS" : "V16_DATA_INSUFFICIENT_FINAL",
    reasons,
    gates,
  };
}
