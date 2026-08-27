import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { parseMonthlyArchive } from "@/lib/v5-7/external-data";
import type { Candle, FundingRatePoint } from "@/lib/core/types";

const execFileAsync = promisify(execFile);

const BASELINE = "33be0cf4facf62952a196caa98a2102515bd4c2f";
const START = Date.UTC(2023, 0, 1);
const END = Date.UTC(2025, 11, 31, 23, 59, 59, 999);
const HOLDOUT_START = Date.UTC(2025, 0, 1);
const HOLDOUT_END = END;
const HOUR = 60 * 60 * 1_000;
const EIGHT_HOURS = 8 * HOUR;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY;
const STARTING_CAPITAL = 10_000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT"] as const;
const PERIODS = monthKeys(START, END);
const CACHE_ROOT = resolve("data/raw/v12-market-neutral-cache");
const REPORT_ROOT = resolve("reports");
const BINANCE_MONTHLY_ROOT = "https://data.binance.vision/data";
const BINANCE_UM_ROOT = `${BINANCE_MONTHLY_ROOT}/futures/um/monthly`;
const BINANCE_SPOT_ROOT = `${BINANCE_MONTHLY_ROOT}/spot/monthly`;
const STRESS_BPS = [0, 5, 10, 20] as const;
const HEDGE_DELAYS_SECONDS = [0, 5, 30, 60] as const;
const PURGE_HOURS = 72;

type ArchiveKind = "spot" | "perp" | "mark" | "index" | "premium" | "funding" | "delivery";
type FamilyStatus = "PASS" | "FAIL" | "EXCLUDED_DATA_INSUFFICIENT";

interface ArchiveRecord {
  symbol: string;
  kind: ArchiveKind;
  period: string;
  source: "BINANCE_DATA_VISION_PUBLIC";
  sourceUrl: string;
  cachePath: string | null;
  status: "CACHED" | "DOWNLOADED" | "MISSING" | "FAILED";
  rowCount: number;
  sizeBytes: number;
  sha256: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  error?: string;
}

interface LoadedArchive {
  record: ArchiveRecord;
  candles: Candle[];
  funding: FundingRatePoint[];
}

interface Series {
  spot: Candle[];
  perp: Candle[];
  mark: Candle[];
  index: Candle[];
  premium: Candle[];
  funding: FundingRatePoint[];
}

interface DeliveryContract {
  asset: "BTC" | "ETH";
  contract: string;
  firstPeriod: string;
  lastPeriod: string;
  expiryTimestamp: number;
}

interface DeliveryCandle {
  asset: "BTC" | "ETH";
  contract: string;
  expiryTimestamp: number;
  candle: Candle;
}

interface DeliveryLoaded {
  records: ArchiveRecord[];
  candles: Map<"BTC" | "ETH", DeliveryCandle[]>;
}

interface DeliveryConfig {
  id: string;
  family: "BASIS_CONVERGENCE";
  annualizedBasisThreshold: number;
  normalizeBasisBps: number;
  maxHoldHours: number;
  minDaysToExpiry: number;
}

interface DeliveryConfigResult {
  config: DeliveryConfig;
  trades: V12Trade[];
  metrics: MetricSummary;
  selectedByFrozenRule: boolean;
}

interface V12Config {
  id: string;
  family: "BINANCE_CASH_AND_CARRY";
  fundingThreshold: number;
  persistenceSettlements: number;
  holdSettlements: number;
  maxBasisBps: number;
  maxRealizedVol24h: number;
}

interface V12Trade {
  configId: string;
  symbol: string;
  signalTimestamp: number;
  entryTimestamp: number;
  exitTimestamp: number;
  entrySpot: number;
  entryPerp: number;
  exitSpot: number;
  exitPerp: number;
  entryBasisBps: number;
  exitBasisBps: number;
  fundingPnl: number;
  pairPricePnl: number;
  grossPnl: number;
  feesPnl: number;
  slippagePnl: number;
  basisBufferPnl: number;
  hedgeDelayPnl: number;
  holdingHours: number;
  capital: number;
  netPnlByStress: Record<string, number>;
}

interface MetricSummary {
  trades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  netPnl: number;
  returnPct: number;
  annualizedReturnPct: number;
  profitFactor: number | null;
  winRate: number;
  averageTradeProfit: number;
  medianTradeProfit: number;
  worstTrade: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  positivePeriodRatio: number;
  positivePeriods: number;
  observedPeriods: number;
  topSymbolProfitShare: number | null;
  profitableSymbols: number;
  symbolCount: number;
  averageHoldingHours: number;
  medianHoldingHours: number;
  averageCapitalLocked: number;
  capitalUtilization: number;
  stress: Record<string, { netPnl: number; returnPct: number; maxDrawdownPct: number }>;
}

interface ConfigResult {
  config: V12Config;
  trades: V12Trade[];
  metrics: MetricSummary;
  selectedByFrozenRule: boolean;
}

interface ValidationResult {
  status: FamilyStatus;
  configId: string | null;
  metrics: MetricSummary;
  gate: Record<string, boolean>;
  reasons: string[];
  trades: V12Trade[];
}

const CONFIGURATIONS: readonly V12Config[] = [
  { id: "A1-FUNDING-LOW-8H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0001, persistenceSettlements: 1, holdSettlements: 1, maxBasisBps: 50, maxRealizedVol24h: 0.12 },
  { id: "A2-FUNDING-LOW-16H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0001, persistenceSettlements: 2, holdSettlements: 2, maxBasisBps: 75, maxRealizedVol24h: 0.12 },
  { id: "A3-FUNDING-MID-24H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0002, persistenceSettlements: 1, holdSettlements: 3, maxBasisBps: 100, maxRealizedVol24h: 0.15 },
  { id: "A4-FUNDING-HIGH-48H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0003, persistenceSettlements: 1, holdSettlements: 6, maxBasisBps: 150, maxRealizedVol24h: 0.18 },
  { id: "A5-FUNDING-HIGH-PERSIST-24H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0005, persistenceSettlements: 2, holdSettlements: 3, maxBasisBps: 100, maxRealizedVol24h: 0.15 },
  { id: "A6-FUNDING-MID-PERSIST-72H", family: "BINANCE_CASH_AND_CARRY", fundingThreshold: 0.0002, persistenceSettlements: 3, holdSettlements: 9, maxBasisBps: 150, maxRealizedVol24h: 0.18 },
] as const;

const DELIVERY_SERIES = [
  ["230331", "2023-01", "2023-03", "2023-03-31T08:00:00.000Z"],
  ["230630", "2023-01", "2023-06", "2023-06-30T08:00:00.000Z"],
  ["230929", "2023-03", "2023-09", "2023-09-29T08:00:00.000Z"],
  ["231229", "2023-06", "2023-12", "2023-12-29T08:00:00.000Z"],
  ["240329", "2023-09", "2024-03", "2024-03-29T08:00:00.000Z"],
  ["240628", "2024-01", "2024-06", "2024-06-28T08:00:00.000Z"],
  ["240927", "2024-04", "2024-09", "2024-09-27T08:00:00.000Z"],
  ["241227", "2024-07", "2024-12", "2024-12-27T08:00:00.000Z"],
  ["250328", "2024-10", "2025-03", "2025-03-28T08:00:00.000Z"],
  ["250627", "2025-01", "2025-06", "2025-06-27T08:00:00.000Z"],
  ["250926", "2025-04", "2025-09", "2025-09-26T08:00:00.000Z"],
  ["251226", "2025-07", "2025-12", "2025-12-26T08:00:00.000Z"],
  ["260327", "2025-10", "2025-12", "2026-03-27T08:00:00.000Z"],
] as const;

const DELIVERY_CONTRACTS: readonly DeliveryContract[] = (["BTC", "ETH"] as const).flatMap((asset) => DELIVERY_SERIES.map(([suffix, firstPeriod, lastPeriod, expiry]) => ({ asset, contract: `${asset}USD_${suffix}`, firstPeriod, lastPeriod, expiryTimestamp: Date.parse(expiry) })));

const DELIVERY_CONFIGURATIONS: readonly DeliveryConfig[] = [
  { id: "C1-BASIS-8PCT-30D", family: "BASIS_CONVERGENCE", annualizedBasisThreshold: 0.08, normalizeBasisBps: 5, maxHoldHours: 24 * 30, minDaysToExpiry: 7 },
  { id: "C2-BASIS-12PCT-45D", family: "BASIS_CONVERGENCE", annualizedBasisThreshold: 0.12, normalizeBasisBps: 10, maxHoldHours: 24 * 45, minDaysToExpiry: 7 },
  { id: "C3-BASIS-20PCT-60D", family: "BASIS_CONVERGENCE", annualizedBasisThreshold: 0.20, normalizeBasisBps: 10, maxHoldHours: 24 * 60, minDaysToExpiry: 14 },
  { id: "C4-BASIS-15PCT-72H", family: "BASIS_CONVERGENCE", annualizedBasisThreshold: 0.15, normalizeBasisBps: 20, maxHoldHours: 72, minDaysToExpiry: 3 },
] as const;

const COST_MODEL = {
  spotFeeBpsPerSide: 4,
  perpFeeBpsPerSide: 4,
  baseSlippageBpsPerLeg: 2,
  hedgeDelayBps: { "0": 0, "5": 0.25, "30": 1.5, "60": 3 },
  basisRiskBufferBpsPerDay: 2,
  effectiveLeverage: 1,
  maxConcurrentPositions: 5,
  startingCapital: STARTING_CAPITAL,
  execution: "Both legs use the next complete 1h open; the second-leg delay is a frozen bps proxy because historical tick-level leg timing is unavailable.",
} as const;

async function main(): Promise<void> {
  const shouldDownload = process.argv.includes("--download");
  await mkdir(REPORT_ROOT, { recursive: true });
  const loaded = await loadBinanceData(shouldDownload);
  const dataGate = buildDataGate(loaded.records, loaded.series);
  const crossExchange = await probeCrossExchange();
  const deliveryLoaded = await loadDeliveryData(shouldDownload);
  const deliveryProbe = await probeDelivery();
  const delivery = { ...deliveryProbe, availability: buildDeliveryGate(deliveryLoaded) };
  const archiveRecords = [...loaded.records, ...deliveryLoaded.records];
  await writeJson(resolve(REPORT_ROOT, "v12-data-gate.json"), { schema: "bca-v12-data-gate-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, dataGate, crossExchange, delivery, archiveRecords });

  if (!dataGate.binanceCorePass) {
    await writeJson(resolve(REPORT_ROOT, "v12-validation-summary.json"), buildDataStopSummary(dataGate, crossExchange, delivery));
    await writeJson(resolve(REPORT_ROOT, "v12-promotion-decision.json"), { status: "V12_DATA_INSUFFICIENT", researchStop: "YES" });
    console.error("V12_DATA_INSUFFICIENT");
    process.exitCode = 2;
    return;
  }

  const registry = buildRegistry();
  const registryHash = hashObject(registry);
  await writeJson(resolve(REPORT_ROOT, "v12-registry.json"), { ...registry, registryHash, freezeStatus: "FROZEN_BEFORE_RETURN_READ" });
  const freeze = { schema: "bca-v12-freeze-manifest-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, registryHash, costModel: COST_MODEL, configurations: [...CONFIGURATIONS, ...DELIVERY_CONFIGURATIONS], dataGate, sources: archiveRecords.filter((record) => record.sha256).map((record) => ({ sourceUrl: record.sourceUrl, cachePath: record.cachePath, symbol: record.symbol, kind: record.kind, period: record.period, rowCount: record.rowCount, bytes: record.sizeBytes, sha256: record.sha256 })), crossExchange, delivery, frozenRules: registry.rules };
  await writeJson(resolve(REPORT_ROOT, "v12-freeze-manifest.json"), freeze);

  const familyA = evaluateFamilyA(loaded.series, registryHash);
  const familyB = excludedFamily("CROSS_EXCHANGE_FUNDING_SPREAD", "No immutable 3-year synchronized Binance/OKX/Bybit funding-and-price panel was available before return reads.");
  const familyC: ReturnType<typeof evaluateFamilyC> = (delivery.availability as Record<string, unknown>).pass ? evaluateFamilyC(deliveryLoaded, loaded.series, registryHash) : excludedFamily("BASIS_CONVERGENCE", "The official Binance delivery-futures chain did not pass the frozen BTC+ETH coverage gate before return reads.") as ReturnType<typeof evaluateFamilyC>;
  const best = familyA.status === "PASS" ? familyA : familyC.status === "PASS" ? familyC : familyA.configId ? familyA : null;
  const summary = buildSummary({ dataGate, crossExchange, delivery, registryHash, familyA, familyB, familyC, best, series: loaded.series });
  await writeJson(resolve(REPORT_ROOT, "v12-family-results.json"), { familyA, familyB, familyC });
  await writeJson(resolve(REPORT_ROOT, "v12-validation-summary.json"), summary);
  await writeJson(resolve(REPORT_ROOT, "v12-promotion-decision.json"), { schema: "bca-v12-promotion-decision-v1", baseline: BASELINE, registryHash, EMAIL_PROMOTION_CANDIDATE: summary.EMAIL_PROMOTION_CANDIDATE, researchStop: summary.researchStop, reason: summary.researchStopReason });
  await writeFile(resolve(REPORT_ROOT, "v12-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({ stage: "v12_validation_complete", dataGate: dataGate.status, familyA: { configId: familyA.configId, status: familyA.status, trades: familyA.metrics.trades }, familyB: familyB.status, familyC: familyC.status, emailPromotionCandidate: summary.EMAIL_PROMOTION_CANDIDATE, researchStop: summary.researchStop }));
}

function buildRegistry(): Record<string, unknown> {
  return {
    schema: "bca-v12-registry-v1",
    baseline: BASELINE,
    family: "MARKET_NEUTRAL_CARRY_BASIS_RELATIVE_VALUE",
    universe: SYMBOLS,
    configurations: [...CONFIGURATIONS, ...DELIVERY_CONFIGURATIONS],
    risk: { startingCapital: STARTING_CAPITAL, effectiveLeverage: 1, maxConcurrentPositions: 5, executionInterval: "next complete 1h open", holdDurations: ["1 settlement", "2 settlements", "3 settlements", "24h", "48h", "72h"] },
    rules: { selection: "Select the highest training net PnL among frozen configurations with at least 20 training trades; tie-break PF, then lower max drawdown.", purgeHours: PURGE_HOURS, holdout: "2025-01-01 through 2025-12-31", email: "One email per accepted pair opportunity; no same-symbol overlap.", data: "All thresholds and costs are frozen before any outer OOS return is read." },
    gates: { nested: { trades: 100, netPnl: ">0", annualizedReturnPct: ">=8", profitFactor: ">=1.30", maxDrawdownPct: "<=10", positivePeriodRatio: ">=0.70", medianTradeNetProfit: ">0", plus10BpsNetPnl: ">0", plus20BpsCatastrophicLossPct: ">=-20" }, holdout: { trades: 20, netPnl: ">0", profitFactor: ">=1.20", maxDrawdownPct: "<=10" }, symbol: { profitableSymbols: 5, topSymbolProfitShare: "<=0.40" }, email: { alertsPerMonth: ">=2", activeMonthRatio: ">=0.70", maxDroughtDays: "<=45" } },
  };
}

async function loadBinanceData(shouldDownload: boolean): Promise<{ records: ArchiveRecord[]; series: Map<string, Series> }> {
  const jobs = SYMBOLS.flatMap((symbol) => PERIODS.flatMap((period) => ( ["spot", "perp", "mark", "index", "premium", "funding"] as ArchiveKind[]).map((kind) => ({ symbol, period, kind }))));
  const loaded = await mapLimit(jobs, 12, (job) => ensureArchive(job.symbol, job.kind, job.period, shouldDownload));
  const records = loaded.map((item) => item.record);
  const series = new Map<string, Series>();
  for (const symbol of SYMBOLS) series.set(symbol, { spot: [], perp: [], mark: [], index: [], premium: [], funding: [] });
  for (const item of loaded) {
    const target = series.get(item.record.symbol)!;
    if (item.record.kind === "funding") target.funding.push(...item.funding);
    else if (item.record.kind !== "delivery") target[item.record.kind].push(...item.candles);
  }
  for (const [symbol, value] of series) {
    value.spot = dedupeCandles(value.spot);
    value.perp = dedupeCandles(value.perp);
    value.mark = dedupeCandles(value.mark);
    value.index = dedupeCandles(value.index);
    value.premium = dedupeCandles(value.premium);
    value.funding = dedupeFunding(value.funding);
    series.set(symbol, value);
  }
  return { records, series };
}

async function ensureArchive(symbol: string, kind: ArchiveKind, period: string, shouldDownload: boolean): Promise<LoadedArchive> {
  const sourceUrl = sourceUrlFor(symbol, kind, period);
  const ownPath = resolve(CACHE_ROOT, kind, symbol, `${period}.zip`);
  const fallbackPath = kind === "perp" ? resolve(`data/raw/v7-derivatives-flow-cache/market/${symbol}/1h/${period}.zip`) : kind === "funding" ? resolve(`data/raw/v7-derivatives-flow-cache/market/${symbol}/funding/${period}.zip`) : null;
  let path: string | null = ownPath;
  let status: ArchiveRecord["status"] = "CACHED";
  try {
    await stat(ownPath);
  } catch {
    if (fallbackPath) {
      try { await stat(fallbackPath); path = fallbackPath; status = "CACHED"; } catch { path = ownPath; }
    }
  }
  try {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      if (!shouldDownload) throw new Error("not cached; rerun with --download");
      bytes = await downloadBytes(sourceUrl);
      await writeImmutableBuffer(ownPath, bytes);
      path = ownPath;
      status = "DOWNLOADED";
    }
    const parsed = parseMonthlyArchive(bytes, kind === "funding" ? "funding" : "1h");
    const candles = (parsed.candles ?? []).map(normalizeCandleTimestamps);
    const funding = (parsed.fundingRates ?? []).map(normalizeFundingTimestamp);
    const timestamps = kind === "funding" ? funding.map((item) => item.fundingTime) : candles.map((item) => item.openTime);
    const record: ArchiveRecord = { symbol, kind, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: relativePath(path), status, rowCount: parsed.rowCount, sizeBytes: bytes.byteLength, sha256: sha256(bytes), firstTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null, lastTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null };
    return { record, candles, funding };
  } catch (error) {
    return { record: { symbol, kind, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: null, status: status === "CACHED" ? "FAILED" : "MISSING", rowCount: 0, sizeBytes: 0, sha256: null, firstTimestamp: null, lastTimestamp: null, error: error instanceof Error ? error.message : String(error) }, candles: [], funding: [] };
  }
}

function sourceUrlFor(symbol: string, kind: ArchiveKind, period: string): string {
  if (kind === "spot") return `${BINANCE_SPOT_ROOT}/klines/${symbol}/1h/${symbol}-1h-${period}.zip`;
  if (kind === "perp") return `${BINANCE_UM_ROOT}/klines/${symbol}/1h/${symbol}-1h-${period}.zip`;
  if (kind === "mark") return `${BINANCE_UM_ROOT}/markPriceKlines/${symbol}/1h/${symbol}-1h-${period}.zip`;
  if (kind === "index") return `${BINANCE_UM_ROOT}/indexPriceKlines/${symbol}/1h/${symbol}-1h-${period}.zip`;
  if (kind === "premium") return `${BINANCE_UM_ROOT}/premiumIndexKlines/${symbol}/1h/${symbol}-1h-${period}.zip`;
  return `${BINANCE_UM_ROOT}/fundingRate/${symbol}/${symbol}-fundingRate-${period}.zip`;
}

function normalizeCandleTimestamps(candle: Candle): Candle {
  return { ...candle, openTime: normalizeTimestamp(candle.openTime), closeTime: normalizeTimestamp(candle.closeTime) };
}

function normalizeFundingTimestamp(point: FundingRatePoint): FundingRatePoint {
  return { ...point, fundingTime: normalizeTimestamp(point.fundingTime) };
}

function normalizeTimestamp(timestamp: number): number {
  return timestamp >= 10_000_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp;
}

async function downloadBytes(url: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("curl.exe", ["-k", "--http1.1", "--fail", "--location", "--connect-timeout", "30", "--max-time", "180", "--retry", "2", "--retry-delay", "2", "-sS", url], { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" as const });
  return Buffer.from(stdout as Buffer);
}

async function writeImmutableBuffer(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`immutable cache collision: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("immutable cache collision")) throw error;
    await writeFile(path, bytes);
  }
}

function buildDataGate(records: readonly ArchiveRecord[], series: ReadonlyMap<string, Series>): Record<string, unknown> {
  const expectedHours = expectedBuckets(START, END, HOUR);
  const bySymbol = SYMBOLS.map((symbol) => {
    const value = series.get(symbol)!;
    const coverage = Object.fromEntries(( ["spot", "perp", "mark", "index", "premium"] as const).map((kind) => [kind, value[kind].filter((candle) => candle.openTime >= START && candle.openTime <= END).length / expectedHours]));
    const expectedFunding = Math.floor((END - START) / EIGHT_HOURS) + 1;
    const fundingCoverage = value.funding.filter((item) => item.fundingTime >= START && item.fundingTime <= END).length / expectedFunding;
    return { symbol, coverage, fundingCoverage, minTimestampCoverage: Math.min(...Object.values(coverage)), rows: { spot: value.spot.length, perp: value.perp.length, mark: value.mark.length, index: value.index.length, premium: value.premium.length, funding: value.funding.length } };
  });
  const minTimestampCoverage = Math.min(...bySymbol.map((item) => item.minTimestampCoverage));
  const historyYears = (END - START + 1) / YEAR;
  const reasons: string[] = [];
  if (historyYears < 3) reasons.push(`history is ${historyYears.toFixed(3)} years`);
  if (SYMBOLS.length < 10) reasons.push("fewer than 10 symbols");
  if (minTimestampCoverage < 0.98) reasons.push(`minimum Binance timestamp coverage is ${(minTimestampCoverage * 100).toFixed(2)}%`);
  if (bySymbol.some((item) => item.fundingCoverage < 0.98)) reasons.push("funding settlement coverage is below 98% for at least one symbol");
  return { status: reasons.length === 0 ? "PASS" : "V12_DATA_INSUFFICIENT", binanceCorePass: reasons.length === 0, historyYears, start: new Date(START).toISOString(), end: new Date(END).toISOString(), symbols: SYMBOLS.length, universe: SYMBOLS, expectedHourlyBuckets: expectedHours, minTimestampCoverage, bySymbol, requiredCore: ["spot klines", "USDⓈ-M perp klines", "mark price", "index price", "premium index", "funding history"], reasons, source: "Binance Data Vision public monthly archives; V7 perp/funding bytes are reused byte-for-byte when already cached and source URLs remain recorded.", records: records.length };
}

async function probeCrossExchange(): Promise<Record<string, unknown>> {
  const probes = await Promise.all([
    probeJson("OKX", "BTC-USDT-SWAP", "https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100"),
    probeJson("OKX", "ETH-USDT-SWAP", "https://www.okx.com/api/v5/public/funding-rate-history?instId=ETH-USDT-SWAP&limit=100"),
    probeJson("Bybit", "BTCUSDT", "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200"),
    probeJson("Bybit", "ETHUSDT", "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=ETHUSDT&limit=200"),
  ]);
  return { status: "EXCLUDED_DATA_INSUFFICIENT", reason: "Official endpoints returned only a bounded recent page; no immutable >=3-year synchronized cross-exchange export was frozen for this run, so Family B was removed before return reads.", probes };
}

async function probeJson(exchange: string, instrument: string, url: string): Promise<Record<string, unknown>> {
  try {
    const body = (await downloadText(url)).trim();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const data = Array.isArray(parsed.data) ? parsed.data : Array.isArray((parsed.result as Record<string, unknown> | undefined)?.list) ? ((parsed.result as Record<string, unknown>).list as unknown[]) : [];
    const timestamps = data.flatMap((item) => { const row = item as Record<string, unknown>; const value = row.ts ?? row.fundingRateTimestamp ?? row.fundingTime; const numeric = Number(value); return Number.isFinite(numeric) ? [numeric < 10_000_000_000 ? numeric * 1_000 : numeric] : []; });
    return { exchange, instrument, url, http: 200, rows: data.length, firstTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null, lastTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null };
  } catch (error) {
    return { exchange, instrument, url, http: null, rows: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeDelivery(): Promise<Record<string, unknown>> {
  const probes = await mapLimit(DELIVERY_CONTRACTS, 6, async (definition) => {
    const url = deliverySourceUrl(definition, definition.firstPeriod);
    try { await downloadHead(url); return { asset: definition.asset, contract: definition.contract, period: definition.firstPeriod, url, http: 200 }; } catch (error) { return { asset: definition.asset, contract: definition.contract, period: definition.firstPeriod, url, http: null, error: error instanceof Error ? error.message : String(error) }; }
  });
  return { status: "PROBED", source: "Binance COIN-M delivery-futures public monthly 1h archives", probes };
}

async function loadDeliveryData(shouldDownload: boolean): Promise<DeliveryLoaded> {
  const jobs = DELIVERY_CONTRACTS.flatMap((definition) => monthKeys(Date.parse(`${definition.firstPeriod}-01T00:00:00.000Z`), Date.parse(`${definition.lastPeriod}-28T23:59:59.999Z`)).map((period) => ({ definition, period })));
  const loaded = await mapLimit(jobs, 8, (job) => ensureDeliveryArchive(job.definition, job.period, shouldDownload));
  const grouped = new Map<string, DeliveryCandle[]>();
  for (const item of loaded) {
    const key = item.definition.contract;
    const candles = grouped.get(key) ?? [];
    candles.push(...item.candles);
    grouped.set(key, candles);
  }
  const byAsset = new Map<"BTC" | "ETH", DeliveryCandle[]>([["BTC", []], ["ETH", []]]);
  for (const definition of DELIVERY_CONTRACTS) {
    const candles = dedupeDeliveryCandles(grouped.get(definition.contract) ?? []);
    byAsset.get(definition.asset)!.push(...candles);
  }
  for (const [asset, candles] of byAsset) byAsset.set(asset, candles.sort((left, right) => left.candle.openTime - right.candle.openTime || left.expiryTimestamp - right.expiryTimestamp));
  return { records: loaded.map((item) => item.record), candles: byAsset };
}

async function ensureDeliveryArchive(definition: DeliveryContract, period: string, shouldDownload: boolean): Promise<{ definition: DeliveryContract; record: ArchiveRecord; candles: DeliveryCandle[] }> {
  const sourceUrl = deliverySourceUrl(definition, period);
  const ownPath = resolve(CACHE_ROOT, "delivery", definition.contract, `${period}.zip`);
  let status: ArchiveRecord["status"] = "CACHED";
  try { await stat(ownPath); } catch {
    try {
      if (!shouldDownload) throw new Error("not cached; rerun with --download");
      const bytes = await downloadBytes(sourceUrl);
      await writeImmutableBuffer(ownPath, bytes);
      status = "DOWNLOADED";
    } catch (error) {
      return { definition, record: { symbol: definition.contract, kind: "delivery", period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: null, status: "MISSING", rowCount: 0, sizeBytes: 0, sha256: null, firstTimestamp: null, lastTimestamp: null, error: error instanceof Error ? error.message : String(error) }, candles: [] };
    }
  }
  try {
    const bytes = await readFile(ownPath);
    const parsed = parseMonthlyArchive(bytes, "1h");
    const candles = (parsed.candles ?? []).map(normalizeCandleTimestamps).map((candle) => ({ asset: definition.asset, contract: definition.contract, expiryTimestamp: definition.expiryTimestamp, candle }));
    const timestamps = candles.map((item) => item.candle.openTime);
    return { definition, record: { symbol: definition.contract, kind: "delivery", period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: relativePath(ownPath), status, rowCount: parsed.rowCount, sizeBytes: bytes.byteLength, sha256: sha256(bytes), firstTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null, lastTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null }, candles };
  } catch (error) {
    return { definition, record: { symbol: definition.contract, kind: "delivery", period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: relativePath(ownPath), status: "FAILED", rowCount: 0, sizeBytes: 0, sha256: null, firstTimestamp: null, lastTimestamp: null, error: error instanceof Error ? error.message : String(error) }, candles: [] };
  }
}

function deliverySourceUrl(definition: DeliveryContract, period: string): string {
  return `${BINANCE_MONTHLY_ROOT}/futures/cm/monthly/klines/${definition.contract}/1h/${definition.contract}-1h-${period}.zip`;
}

function dedupeDeliveryCandles(candles: readonly DeliveryCandle[]): DeliveryCandle[] {
  const map = new Map<string, DeliveryCandle>();
  for (const item of candles) {
    if (item.candle.openTime < START || item.candle.openTime > END || item.candle.openTime >= item.expiryTimestamp) continue;
    const key = `${item.contract}:${item.candle.openTime}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].sort((left, right) => left.candle.openTime - right.candle.openTime);
}

function buildDeliveryGate(loaded: DeliveryLoaded): Record<string, unknown> {
  const expectedHours = expectedBuckets(START, END, HOUR);
  const byAsset = (['BTC', 'ETH'] as const).map((asset) => {
    const candles = loaded.candles.get(asset) ?? [];
    const chosen = new Map<number, DeliveryCandle>();
    for (const item of candles) {
      const timestamp = item.candle.openTime;
      const existing = chosen.get(timestamp);
      if (timestamp >= START && timestamp <= END && item.expiryTimestamp > timestamp + HOUR && (!existing || item.expiryTimestamp < existing.expiryTimestamp)) chosen.set(timestamp, item);
    }
    const coverage = chosen.size / expectedHours;
    const timestamps = [...chosen.keys()].sort((left, right) => left - right);
    return { asset, coverage, rows: candles.length, selectedRows: chosen.size, firstTimestamp: timestamps.length ? new Date(timestamps[0]).toISOString() : null, lastTimestamp: timestamps.length ? new Date(timestamps.at(-1)!).toISOString() : null, contracts: [...new Set(candles.map((item) => item.contract))] };
  });
  const reasons = byAsset.filter((item) => item.coverage < 0.98).map((item) => `${item.asset} delivery coverage ${(item.coverage * 100).toFixed(2)}% is below 98%`);
  return { status: reasons.length ? "V12_DELIVERY_DATA_INSUFFICIENT" : "PASS", pass: reasons.length === 0, historyYears: (END - START + 1) / YEAR, expectedHourlyBuckets: expectedHours, byAsset, reasons, source: "Binance COIN-M delivery-futures public monthly 1h archives" };
}

async function downloadText(url: string): Promise<string> {
  const { stdout } = await execFileAsync("curl.exe", ["-k", "--http1.1", "--fail", "--location", "--connect-timeout", "20", "--max-time", "60", "--retry", "1", "-sS", url], { maxBuffer: 5 * 1024 * 1024, encoding: "utf8" });
  return String(stdout);
}

async function downloadHead(url: string): Promise<void> {
  await execFileAsync("curl.exe", ["-k", "--http1.1", "--fail", "--location", "--head", "--connect-timeout", "20", "--max-time", "60", "--retry", "1", "-sS", url], { maxBuffer: 1 * 1024 * 1024, encoding: "utf8" });
}

function evaluateFamilyA(series: ReadonlyMap<string, Series>, registryHash: string): ValidationResult & { configResults: ConfigResult[]; nested: ValidationResult; holdout: ValidationResult; symbol: Record<string, unknown>; email: Record<string, unknown>; portfolio: Record<string, unknown>; registryHash: string } {
  const configResults = CONFIGURATIONS.map((config) => {
    const trades = buildCashCarryTrades(series, config);
    return { config, trades, metrics: metricsFor(trades, 0), selectedByFrozenRule: false };
  });
  const selectedConfig = selectConfig(configResults, START, HOLDOUT_START - 1);
  if (selectedConfig) selectedConfig.selectedByFrozenRule = true;
  const selected = selectedConfig ?? configResults[0];
  const nested = evaluateNested(configResults);
  const holdout = evaluatePeriod(selected, HOLDOUT_START, HOLDOUT_END);
  const symbol = symbolGate(selected.trades);
  const email = emailGate(selected.trades);
  const portfolio = portfolioSimulation(selected.trades);
  const metrics = metricsFor(selected.trades, 0);
  const gate = { nested: nested.status === "PASS", holdout: holdout.status === "PASS", symbol: Boolean(symbol.pass), email: Boolean(email.pass), capitalRisk: Boolean((portfolio as Record<string, unknown>).pass), costStress: metrics.stress["20"].netPnl >= -STARTING_CAPITAL * 0.2 };
  const reasons = [nested, holdout].flatMap((item) => item.reasons).concat(symbol.reasons as string[]).concat(email.reasons as string[]).concat((portfolio.reasons as string[]) ?? []);
  const status: FamilyStatus = Object.values(gate).every(Boolean) ? "PASS" : "FAIL";
  return { status, configId: selected.config.id, metrics, gate, reasons: [...new Set(reasons)], trades: selected.trades, configResults, nested, holdout, symbol, email, portfolio, registryHash };
}

function evaluateFamilyC(loaded: DeliveryLoaded, series: ReadonlyMap<string, Series>, registryHash: string): ValidationResult & { configResults: DeliveryConfigResult[]; nested: ValidationResult; holdout: ValidationResult; symbol: Record<string, unknown>; email: Record<string, unknown>; portfolio: Record<string, unknown>; registryHash: string } {
  const configResults = DELIVERY_CONFIGURATIONS.map((config) => {
    const trades = buildBasisTrades(loaded, series, config);
    return { config, trades, metrics: metricsFor(trades, 0), selectedByFrozenRule: false };
  });
  const selectedConfig = selectDeliveryConfig(configResults, START, HOLDOUT_START - 1);
  if (selectedConfig) selectedConfig.selectedByFrozenRule = true;
  const selected = selectedConfig ?? configResults[0];
  const nested = evaluateNestedDelivery(configResults);
  const holdout = evaluateDeliveryPeriod(selected, HOLDOUT_START, HOLDOUT_END);
  const symbol = symbolGate(selected.trades);
  const email = emailGate(selected.trades);
  const portfolio = portfolioSimulation(selected.trades);
  const metrics = metricsFor(selected.trades, 0);
  const gate = { nested: nested.status === "PASS", holdout: holdout.status === "PASS", symbol: Boolean(symbol.pass), email: Boolean(email.pass), capitalRisk: Boolean((portfolio as Record<string, unknown>).pass), costStress: metrics.stress["20"].netPnl >= -STARTING_CAPITAL * 0.2 };
  const reasons = [nested, holdout].flatMap((item) => item.reasons).concat(symbol.reasons as string[]).concat(email.reasons as string[]).concat((portfolio.reasons as string[]) ?? []);
  const status: FamilyStatus = Object.values(gate).every(Boolean) ? "PASS" : "FAIL";
  return { status, configId: selected.config.id, metrics, gate, reasons: [...new Set(reasons)], trades: selected.trades, configResults, nested, holdout, symbol, email, portfolio, registryHash };
}

function buildBasisTrades(loaded: DeliveryLoaded, series: ReadonlyMap<string, Series>, config: DeliveryConfig): V12Trade[] {
  const candidates: V12Trade[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const value = series.get(`${asset}USDT`);
    if (!value) continue;
    const spotByTime = new Map(value.spot.map((candle) => [candle.openTime, candle]));
    const byContract = new Map<string, DeliveryCandle[]>();
    for (const item of loaded.candles.get(asset) ?? []) byContract.set(item.contract, [...(byContract.get(item.contract) ?? []), item]);
    for (const contractCandles of byContract.values()) {
      const sorted = contractCandles.slice().sort((left, right) => left.candle.openTime - right.candle.openTime);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        const signalDelivery = sorted[index];
        const signalSpot = spotByTime.get(signalDelivery.candle.openTime);
        const timeToExpiryDays = (signalDelivery.expiryTimestamp - signalDelivery.candle.openTime) / DAY;
        if (!signalSpot || timeToExpiryDays < config.minDaysToExpiry || signalDelivery.candle.openTime < START || signalDelivery.candle.openTime > END) continue;
        if (![signalSpot.close, signalDelivery.candle.close].every((price) => Number.isFinite(price) && price > 0)) continue;
        const signalBasis = signalDelivery.candle.close / signalSpot.close - 1;
        const annualizedBasis = Math.abs(signalBasis) * 365.25 / timeToExpiryDays;
        if (annualizedBasis < config.annualizedBasisThreshold) continue;
        const entryTimestamp = signalDelivery.candle.openTime + HOUR;
        const entryDelivery = sorted.find((item) => item.candle.openTime === entryTimestamp);
        const entrySpot = spotByTime.get(entryTimestamp);
        if (!entryDelivery || !entrySpot || entryDelivery.expiryTimestamp <= entryTimestamp) continue;
        let exit: { delivery: DeliveryCandle; spot: Candle } | null = null;
        let lastEligible: { delivery: DeliveryCandle; spot: Candle } | null = null;
        const maxExitTimestamp = entryTimestamp + config.maxHoldHours * HOUR;
        for (let exitIndex = index + 1; exitIndex < sorted.length; exitIndex += 1) {
          const delivery = sorted[exitIndex];
          if (delivery.candle.openTime < entryTimestamp || delivery.candle.openTime > maxExitTimestamp || delivery.expiryTimestamp <= delivery.candle.openTime) continue;
          const spot = spotByTime.get(delivery.candle.openTime);
          if (!spot || !Number.isFinite(spot.close) || spot.close <= 0 || !Number.isFinite(delivery.candle.close) || delivery.candle.close <= 0) continue;
          lastEligible = { delivery, spot };
          const exitBasisBps = Math.abs(delivery.candle.close / spot.close - 1) * 10_000;
          if (exitBasisBps <= config.normalizeBasisBps) { exit = lastEligible; break; }
        }
        exit ??= lastEligible;
        if (!exit || exit.delivery.candle.openTime <= entryTimestamp) continue;
        const trade = buildBasisTrade(asset, config, signalDelivery.candle.closeTime, entrySpot, entryDelivery.candle, exit.spot, exit.delivery.candle, signalBasis * 10_000);
        if (trade) candidates.push(trade);
      }
    }
  }
  const selected: V12Trade[] = [];
  const availableAfter = new Map<string, number>();
  for (const trade of candidates.sort((left, right) => left.entryTimestamp - right.entryTimestamp || left.exitTimestamp - right.exitTimestamp)) {
    if (trade.entryTimestamp < (availableAfter.get(trade.symbol) ?? START)) continue;
    selected.push(trade);
    availableAfter.set(trade.symbol, trade.exitTimestamp + HOUR);
  }
  return selected;
}

function buildBasisTrade(asset: "BTC" | "ETH", config: DeliveryConfig, signalTimestamp: number, entrySpotCandle: Candle, entryDeliveryCandle: Candle, exitSpotCandle: Candle, exitDeliveryCandle: Candle, entryBasisBps: number): V12Trade | null {
  if (![entrySpotCandle.open, entryDeliveryCandle.open, exitSpotCandle.close, exitDeliveryCandle.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  const capital = STARTING_CAPITAL;
  const spotNotional = capital / 2;
  const deliveryNotional = capital / 2;
  const spotQty = spotNotional / entrySpotCandle.open;
  const deliveryQty = deliveryNotional / entryDeliveryCandle.open;
  const positiveBasis = entryBasisBps >= 0;
  const spotPnl = positiveBasis ? spotQty * (exitSpotCandle.close - entrySpotCandle.open) : spotQty * (entrySpotCandle.open - exitSpotCandle.close);
  const deliveryPnl = positiveBasis ? deliveryQty * (entryDeliveryCandle.open - exitDeliveryCandle.close) : deliveryQty * (exitDeliveryCandle.close - entryDeliveryCandle.open);
  const pairPricePnl = spotPnl + deliveryPnl;
  const grossPnl = pairPricePnl;
  const turnover = spotNotional * 2 + deliveryNotional * 2;
  const feesPnl = turnover * ((COST_MODEL.spotFeeBpsPerSide + COST_MODEL.perpFeeBpsPerSide) / 2) / 10_000;
  const holdingHours = (exitSpotCandle.openTime - entrySpotCandle.openTime) / HOUR;
  const holdingDays = Math.max(0, holdingHours / 24);
  const basisBufferPnl = capital * COST_MODEL.basisRiskBufferBpsPerDay * holdingDays / 10_000;
  const netPnlByStress: Record<string, number> = {};
  for (const delay of HEDGE_DELAYS_SECONDS) {
    const delayBps = COST_MODEL.hedgeDelayBps[String(delay) as keyof typeof COST_MODEL.hedgeDelayBps];
    const delayPnl = capital * delayBps / 10_000;
    for (const stress of STRESS_BPS) netPnlByStress[`${delay}:${stress}`] = grossPnl - feesPnl - basisBufferPnl - delayPnl - turnover * (COST_MODEL.baseSlippageBpsPerLeg + stress) / 10_000;
  }
  const exitBasisBps = (exitDeliveryCandle.close / exitSpotCandle.close - 1) * 10_000;
  return { configId: config.id, symbol: asset, signalTimestamp, entryTimestamp: entrySpotCandle.openTime, exitTimestamp: exitSpotCandle.openTime, entrySpot: entrySpotCandle.open, entryPerp: entryDeliveryCandle.open, exitSpot: exitSpotCandle.close, exitPerp: exitDeliveryCandle.close, entryBasisBps, exitBasisBps, fundingPnl: 0, pairPricePnl, grossPnl, feesPnl, slippagePnl: turnover * COST_MODEL.baseSlippageBpsPerLeg / 10_000, basisBufferPnl, hedgeDelayPnl: 0, holdingHours, capital, netPnlByStress };
}

function evaluateNestedDelivery(configResults: DeliveryConfigResult[]): ValidationResult {
  const folds = [
    { trainStart: START, trainEnd: Date.UTC(2023, 5, 30, 23, 59, 59, 999), testStart: Date.UTC(2023, 6, 1), testEnd: Date.UTC(2023, 11, 31, 23, 59, 59, 999) },
    { trainStart: START, trainEnd: Date.UTC(2023, 11, 31, 23, 59, 59, 999), testStart: Date.UTC(2024, 0, 1), testEnd: Date.UTC(2024, 5, 30, 23, 59, 59, 999) },
    { trainStart: START, trainEnd: Date.UTC(2024, 5, 30, 23, 59, 59, 999), testStart: Date.UTC(2024, 6, 1), testEnd: Date.UTC(2024, 11, 31, 23, 59, 59, 999) },
  ];
  const selectedTrades: V12Trade[] = [];
  for (const fold of folds) {
    const chosen = selectDeliveryConfig(configResults, fold.trainStart, fold.testStart - PURGE_HOURS * HOUR);
    if (chosen) selectedTrades.push(...chosen.trades.filter((trade) => trade.entryTimestamp >= fold.testStart && trade.entryTimestamp <= fold.testEnd));
  }
  const metrics = metricsFor(selectedTrades, 0);
  const gate = nestedGate(metrics);
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: selectedTrades.length ? "FROZEN-WALK-FORWARD-SELECTION" : null, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades: selectedTrades };
}

function evaluateDeliveryPeriod(result: DeliveryConfigResult, start: number, end: number): ValidationResult {
  const trades = result.trades.filter((trade) => trade.entryTimestamp >= start && trade.entryTimestamp <= end);
  const metrics = metricsFor(trades, 0);
  const gate = { trades: metrics.trades >= 20, netPnl: metrics.netPnl > 0, profitFactor: (metrics.profitFactor ?? 0) >= 1.2, maxDrawdown: metrics.maxDrawdownPct <= 10 };
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: result.config.id, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades };
}

function selectDeliveryConfig(results: readonly DeliveryConfigResult[], start: number, end: number): DeliveryConfigResult | null {
  return results.map((result) => ({ result, trades: result.trades.filter((trade) => trade.entryTimestamp >= start && trade.entryTimestamp <= end) })).filter((item) => item.trades.length >= 20).sort((left, right) => { const leftMetrics = metricsFor(left.trades, 0); const rightMetrics = metricsFor(right.trades, 0); return rightMetrics.netPnl - leftMetrics.netPnl || (rightMetrics.profitFactor ?? -Infinity) - (leftMetrics.profitFactor ?? -Infinity) || leftMetrics.maxDrawdownPct - rightMetrics.maxDrawdownPct; })[0]?.result ?? null;
}

function buildCashCarryTrades(series: ReadonlyMap<string, Series>, config: V12Config): V12Trade[] {
  const trades: V12Trade[] = [];
  for (const symbol of SYMBOLS) {
    const value = series.get(symbol)!;
    const funding = value.funding.filter((item) => item.fundingTime >= START && item.fundingTime <= END);
    let availableAfter = START;
    for (let index = config.persistenceSettlements - 1; index + config.holdSettlements < funding.length; index += 1) {
      const signal = funding[index];
      if (signal.fundingTime < availableAfter) continue;
      const window = funding.slice(index - config.persistenceSettlements + 1, index + 1);
      if (window.some((item) => item.fundingRate < config.fundingThreshold)) continue;
      const entryCandleSpot = nextCandle(value.spot, signal.fundingTime + 1);
      const entryCandlePerp = nextCandle(value.perp, signal.fundingTime + 1);
      const exitFunding = funding[index + config.holdSettlements];
      const exitCandleSpot = nextCandle(value.spot, exitFunding.fundingTime);
      const exitCandlePerp = nextCandle(value.perp, exitFunding.fundingTime);
      if (!entryCandleSpot || !entryCandlePerp || !exitCandleSpot || !exitCandlePerp) continue;
      const entryBasisBps = ((entryCandlePerp.open / entryCandleSpot.open) - 1) * 10_000;
      if (Math.abs(entryBasisBps) > config.maxBasisBps) continue;
      const vol = realizedVol24h(value.spot, entryCandleSpot.openTime);
      if (vol > config.maxRealizedVol24h) continue;
      const expectedFunding = window.at(-1)!.fundingRate * config.holdSettlements;
      const expectedCostBps = 2 * COST_MODEL.spotFeeBpsPerSide + 2 * COST_MODEL.perpFeeBpsPerSide + 4 * COST_MODEL.baseSlippageBpsPerLeg + COST_MODEL.basisRiskBufferBpsPerDay * (config.holdSettlements * 8 / 24);
      if (expectedFunding * 10_000 <= expectedCostBps) continue;
      const trade = buildTrade(symbol, config, signal.fundingTime, entryCandleSpot, entryCandlePerp, exitCandleSpot, exitCandlePerp, funding.filter((item) => item.fundingTime > entryCandleSpot.openTime && item.fundingTime <= exitCandleSpot.openTime), entryBasisBps);
      if (trade) { trades.push(trade); availableAfter = trade.exitTimestamp + HOUR; }
    }
  }
  return trades.sort((left, right) => left.exitTimestamp - right.exitTimestamp || left.entryTimestamp - right.entryTimestamp);
}

function buildTrade(symbol: string, config: V12Config, signalTimestamp: number, entrySpotCandle: Candle, entryPerpCandle: Candle, exitSpotCandle: Candle, exitPerpCandle: Candle, funding: FundingRatePoint[], entryBasisBps: number): V12Trade | null {
  if (![entrySpotCandle.open, entryPerpCandle.open, exitSpotCandle.close, exitPerpCandle.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  const capital = STARTING_CAPITAL;
  const spotNotional = capital / 2;
  const perpNotional = capital / 2;
  const spotQty = spotNotional / entrySpotCandle.open;
  const perpQty = perpNotional / entryPerpCandle.open;
  const pairPricePnl = spotQty * (exitSpotCandle.close - entrySpotCandle.open) + perpQty * (entryPerpCandle.open - exitPerpCandle.close);
  const fundingPnl = funding.reduce((total, point) => total + point.fundingRate * perpNotional, 0);
  const grossPnl = pairPricePnl + fundingPnl;
  const turnover = spotNotional * 2 + perpNotional * 2;
  const feesPnl = turnover * ((COST_MODEL.spotFeeBpsPerSide + COST_MODEL.perpFeeBpsPerSide) / 2) / 10_000;
  const holdingDays = Math.max(0, (exitPerpCandle.openTime - entryPerpCandle.openTime) / DAY);
  const basisBufferPnl = capital * COST_MODEL.basisRiskBufferBpsPerDay * holdingDays / 10_000;
  const netPnlByStress: Record<string, number> = {};
  for (const delay of HEDGE_DELAYS_SECONDS) {
    const delayBps = COST_MODEL.hedgeDelayBps[String(delay) as keyof typeof COST_MODEL.hedgeDelayBps];
    const delayPnl = capital * delayBps / 10_000;
    for (const stress of STRESS_BPS) netPnlByStress[`${delay}:${stress}`] = grossPnl - feesPnl - basisBufferPnl - delayPnl - turnover * (COST_MODEL.baseSlippageBpsPerLeg + stress) / 10_000;
  }
  const exitBasisBps = ((exitPerpCandle.close / exitSpotCandle.close) - 1) * 10_000;
  return { configId: config.id, symbol, signalTimestamp, entryTimestamp: entrySpotCandle.openTime, exitTimestamp: exitSpotCandle.openTime, entrySpot: entrySpotCandle.open, entryPerp: entryPerpCandle.open, exitSpot: exitSpotCandle.close, exitPerp: exitPerpCandle.close, entryBasisBps, exitBasisBps, fundingPnl, pairPricePnl, grossPnl, feesPnl, slippagePnl: turnover * COST_MODEL.baseSlippageBpsPerLeg / 10_000, basisBufferPnl, hedgeDelayPnl: capital * COST_MODEL.hedgeDelayBps["0"] / 10_000, holdingHours: (exitSpotCandle.openTime - entrySpotCandle.openTime) / HOUR, capital, netPnlByStress };
}

function metricsFor(trades: readonly V12Trade[], delaySeconds: number): MetricSummary {
  const values = trades.map((trade) => trade.netPnlByStress[`${delaySeconds}:0`] ?? trade.netPnlByStress["0:0"] ?? 0);
  const sorted = trades.slice().sort((left, right) => left.exitTimestamp - right.exitTimestamp);
  const netPnl = sum(values);
  const grossPnl = sum(trades.map((trade) => trade.grossPnl));
  const wins = values.filter((value) => value > 0).length;
  const losses = values.filter((value) => value <= 0).length;
  const positive = sum(values.filter((value) => value > 0));
  const negative = Math.abs(sum(values.filter((value) => value < 0)));
  const equity = cumulative(values, sorted, delaySeconds, 0);
  const maxDrawdownUsdt = maxDrawdown(equity);
  const start = trades.length ? Math.min(...trades.map((trade) => trade.entryTimestamp)) : START;
  const end = trades.length ? Math.max(...trades.map((trade) => trade.exitTimestamp)) : END;
  const years = Math.max(1 / 365.25, (end - start) / YEAR);
  const months = monthKeys(start, end);
  const monthPnl = new Map<string, number>();
  for (const trade of sorted) { const key = monthKey(trade.exitTimestamp); monthPnl.set(key, (monthPnl.get(key) ?? 0) + (trade.netPnlByStress[`${delaySeconds}:0`] ?? 0)); }
  const symbolPnl = new Map<string, number>();
  for (const trade of trades) symbolPnl.set(trade.symbol, (symbolPnl.get(trade.symbol) ?? 0) + (trade.netPnlByStress[`${delaySeconds}:0`] ?? 0));
  const profits = [...symbolPnl.values()].filter((value) => value > 0);
  const absolutePositiveSymbolProfit = sum(profits);
  const topSymbolProfitShare = absolutePositiveSymbolProfit > 0 ? Math.max(...profits) / absolutePositiveSymbolProfit : null;
  const stress = Object.fromEntries(STRESS_BPS.map((bps) => { const stressValues = trades.map((trade) => trade.netPnlByStress[`${delaySeconds}:${bps}`] ?? 0); const stressEquity = cumulative(stressValues, sorted, delaySeconds, bps); return [String(bps), { netPnl: sum(stressValues), returnPct: sum(stressValues) / STARTING_CAPITAL * 100, maxDrawdownPct: maxDrawdown(stressEquity) / STARTING_CAPITAL * 100 }]; })) as Record<string, { netPnl: number; returnPct: number; maxDrawdownPct: number }>;
  const totalHours = Math.max(HOUR, end - start) / HOUR;
  const capitalHours = sum(trades.map((trade) => trade.capital * trade.holdingHours));
  const capitalUtilization = capitalHours / (STARTING_CAPITAL * totalHours * Math.max(1, SYMBOLS.length));
  return { trades: trades.length, wins, losses, grossPnl, netPnl, returnPct: netPnl / STARTING_CAPITAL * 100, annualizedReturnPct: netPnl / STARTING_CAPITAL / years * 100, profitFactor: negative > 0 ? positive / negative : positive > 0 ? null : 0, winRate: trades.length ? wins / trades.length : 0, averageTradeProfit: trades.length ? netPnl / trades.length : 0, medianTradeProfit: median(values), worstTrade: values.length ? Math.min(...values) : 0, maxDrawdownUsdt, maxDrawdownPct: maxDrawdownUsdt / STARTING_CAPITAL * 100, positivePeriodRatio: months.length ? months.filter((month) => (monthPnl.get(month) ?? 0) > 0).length / months.length : 0, positivePeriods: months.filter((month) => (monthPnl.get(month) ?? 0) > 0).length, observedPeriods: months.length, topSymbolProfitShare, profitableSymbols: profits.length, symbolCount: symbolPnl.size, averageHoldingHours: trades.length ? sum(trades.map((trade) => trade.holdingHours)) / trades.length : 0, medianHoldingHours: median(trades.map((trade) => trade.holdingHours)), averageCapitalLocked: trades.length ? sum(trades.map((trade) => trade.capital)) / trades.length : 0, capitalUtilization, stress };
}

function evaluateNested(configResults: ConfigResult[]): ValidationResult {
  const folds = [
    { trainStart: START, trainEnd: Date.UTC(2023, 5, 30, 23, 59, 59, 999), testStart: Date.UTC(2023, 6, 1), testEnd: Date.UTC(2023, 11, 31, 23, 59, 59, 999) },
    { trainStart: START, trainEnd: Date.UTC(2023, 11, 31, 23, 59, 59, 999), testStart: Date.UTC(2024, 0, 1), testEnd: Date.UTC(2024, 5, 30, 23, 59, 59, 999) },
    { trainStart: START, trainEnd: Date.UTC(2024, 5, 30, 23, 59, 59, 999), testStart: Date.UTC(2024, 6, 1), testEnd: Date.UTC(2024, 11, 31, 23, 59, 59, 999) },
  ];
  const selectedTrades: V12Trade[] = [];
  for (const fold of folds) {
    const trainEnd = fold.testStart - PURGE_HOURS * HOUR;
    const chosen = selectConfig(configResults, fold.trainStart, trainEnd);
    if (chosen) selectedTrades.push(...chosen.trades.filter((trade) => trade.entryTimestamp >= fold.testStart && trade.entryTimestamp <= fold.testEnd));
  }
  const metrics = metricsFor(selectedTrades, 0);
  const gate = nestedGate(metrics);
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: selectedTrades.length ? "FROZEN-WALK-FORWARD-SELECTION" : null, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades: selectedTrades };
}

function evaluatePeriod(result: ConfigResult, start: number, end: number): ValidationResult {
  const trades = result.trades.filter((trade) => trade.entryTimestamp >= start && trade.entryTimestamp <= end);
  const metrics = metricsFor(trades, 0);
  const gate = { trades: metrics.trades >= 20, netPnl: metrics.netPnl > 0, profitFactor: (metrics.profitFactor ?? 0) >= 1.2, maxDrawdown: metrics.maxDrawdownPct <= 10 };
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: result.config.id, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades };
}

function nestedGate(metrics: MetricSummary): Record<string, boolean> {
  return { trades: metrics.trades >= 100, netPnl: metrics.netPnl > 0, annualizedReturn: metrics.annualizedReturnPct >= 8, profitFactor: (metrics.profitFactor ?? 0) >= 1.3, maxDrawdown: metrics.maxDrawdownPct <= 10, positivePeriodRatio: metrics.positivePeriodRatio >= 0.7, medianTradeProfit: metrics.medianTradeProfit > 0, plus10Bps: metrics.stress["10"].netPnl > 0, plus20BpsCatastrophic: metrics.stress["20"].netPnl >= -STARTING_CAPITAL * 0.2 };
}

function symbolGate(trades: readonly V12Trade[]): Record<string, unknown> {
  const bySymbol = new Map<string, V12Trade[]>();
  for (const trade of trades) bySymbol.set(trade.symbol, [...(bySymbol.get(trade.symbol) ?? []), trade]);
  const metrics = [...bySymbol.entries()].map(([symbol, value]) => ({ symbol, metrics: metricsFor(value, 0) }));
  const profitableSymbols = metrics.filter((item) => item.metrics.netPnl > 0).length;
  const positive = metrics.filter((item) => item.metrics.netPnl > 0).map((item) => item.metrics.netPnl);
  const topProfitShare = sum(positive) > 0 ? Math.max(...positive) / sum(positive) : null;
  const reasons: string[] = [];
  if (profitableSymbols < 5) reasons.push("fewer_than_5_profitable_symbols");
  if (topProfitShare !== null && topProfitShare > 0.4) reasons.push("top_symbol_profit_share_over_40pct");
  return { pass: reasons.length === 0, profitableSymbols, symbolCount: metrics.length, topSymbolProfitShare: topProfitShare, bySymbol: metrics.map((item) => ({ symbol: item.symbol, netPnl: item.metrics.netPnl, trades: item.metrics.trades, profitFactor: item.metrics.profitFactor })), reasons };
}

function emailGate(trades: readonly V12Trade[]): Record<string, unknown> {
  const start = trades.length ? Math.min(...trades.map((trade) => trade.entryTimestamp)) : START;
  const end = trades.length ? Math.max(...trades.map((trade) => trade.entryTimestamp)) : END;
  const months = monthKeys(start, end);
  const byMonth = new Map<string, number>();
  for (const trade of trades) byMonth.set(monthKey(trade.entryTimestamp), (byMonth.get(monthKey(trade.entryTimestamp)) ?? 0) + 1);
  const dates = trades.map((trade) => trade.entryTimestamp).sort((a, b) => a - b);
  const droughts = dates.length > 1 ? dates.slice(1).map((date, index) => (date - dates[index]) / DAY) : [Infinity];
  const activeMonthRatio = months.length ? months.filter((month) => (byMonth.get(month) ?? 0) >= 2).length / months.length : 0;
  const alertsPerMonth = months.length ? trades.length / months.length : 0;
  const sortedDroughts = droughts.slice().sort((a, b) => a - b);
  const p95Index = sortedDroughts.length ? Math.min(sortedDroughts.length - 1, Math.ceil(sortedDroughts.length * 0.95) - 1) : 0;
  const p95Drought = sortedDroughts[p95Index] ?? Infinity;
  const maxDrought = Math.max(...droughts);
  const gate = { alertsPerMonth: alertsPerMonth >= 2, activeMonthRatio: activeMonthRatio >= 0.7, maxDrought: maxDrought <= 45 };
  const profits = trades.map((trade) => trade.netPnlByStress["0:0"] ?? 0);
  const equity = cumulative(profits, trades.slice().sort((left, right) => left.exitTimestamp - right.exitTimestamp), 0, 0);
  return { pass: Object.values(gate).every(Boolean), emails: trades.length, alertsPerYear: trades.length / Math.max(1 / 12, months.length / 12), alertsPerMonth, activeMonthRatio, p95Drought, maxDrought, profitableEmails: profits.filter((value) => value > 0).length, losingEmails: profits.filter((value) => value <= 0).length, netProfit: sum(profits), averageProfitPerEmail: profits.length ? mean(profits) : 0, medianProfitPerEmail: median(profits), maxDrawdown: maxDrawdown(equity), gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name) };
}

function portfolioSimulation(trades: readonly V12Trade[]): Record<string, unknown> {
  const ordered = trades.slice().sort((a, b) => a.entryTimestamp - b.entryTimestamp || a.exitTimestamp - b.exitTimestamp);
  const open: V12Trade[] = [];
  const accepted: V12Trade[] = [];
  let rejectedForCapacity = 0;
  for (const trade of ordered) {
    for (let index = open.length - 1; index >= 0; index -= 1) if (open[index].exitTimestamp <= trade.entryTimestamp) open.splice(index, 1);
    if (open.length >= COST_MODEL.maxConcurrentPositions) { rejectedForCapacity += 1; continue; }
    open.push(trade);
    accepted.push(trade);
  }
  const scale = 1 / COST_MODEL.maxConcurrentPositions;
  const scaled = accepted.map((trade) => ({ ...trade, netPnlByStress: Object.fromEntries(Object.entries(trade.netPnlByStress).map(([key, value]) => [key, value * scale])) }));
  const metrics = metricsFor(scaled, 0);
  const gate = { netPnl: metrics.netPnl > 0, profitFactor: (metrics.profitFactor ?? 0) >= 1.2, maxDrawdown: metrics.maxDrawdownPct <= 10 };
  const capitalOptions = Object.fromEntries(([1_000, 2_000, 10_000] as const).map((capital) => { const scale = capital / STARTING_CAPITAL; return [String(capital), { executable: true, scale, netPnl: metrics.netPnl * scale, annualizedNetReturnPct: metrics.annualizedReturnPct, maxDrawdownUsdt: metrics.maxDrawdownUsdt * scale, averageCapitalLocked: metrics.averageCapitalLocked * scale, caveat: capital === STARTING_CAPITAL ? "Reference case with 1x effective leverage." : "Same proportional model; minimum exchange notional, borrow/transfer costs and account-level margin rules are not included." }]; }));
  const marginRisk = { effectiveLeverage: COST_MODEL.effectiveLeverage, maximumMarginUtilizationPct: COST_MODEL.effectiveLeverage * 100, liquidationBufferProxyPct: COST_MODEL.effectiveLeverage > 0 ? 100 / COST_MODEL.effectiveLeverage : null, model: "1x delta-neutral notional proxy; exchange maintenance margin and liquidation bands are not available in public historical data and are not inferred.", basisWideningStress: Object.fromEntries(([20, 30, 50] as const).map((shock) => [String(shock), { adverseResidualExposureUsdt: STARTING_CAPITAL * shock / 100, remainingCapitalProxyUsdt: STARTING_CAPITAL * (1 - shock / 100), catastrophic: shock >= 50 }])), historicalWorstObservedDrawdownUsdt: metrics.maxDrawdownUsdt };
  return { pass: Object.values(gate).every(Boolean), gate, metrics, acceptedTrades: accepted.length, rejectedForCapacity, maxConcurrentPositions: COST_MODEL.maxConcurrentPositions, startingCapital: STARTING_CAPITAL, capitalOptions, marginRisk, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name) };
}

function selectConfig(results: readonly ConfigResult[], start: number, end: number): ConfigResult | null {
  return results.map((result) => ({ result, trades: result.trades.filter((trade) => trade.entryTimestamp >= start && trade.entryTimestamp <= end) })).filter((item) => item.trades.length >= 20).sort((left, right) => { const leftMetrics = metricsFor(left.trades, 0); const rightMetrics = metricsFor(right.trades, 0); return rightMetrics.netPnl - leftMetrics.netPnl || (rightMetrics.profitFactor ?? -Infinity) - (leftMetrics.profitFactor ?? -Infinity) || leftMetrics.maxDrawdownPct - rightMetrics.maxDrawdownPct; })[0]?.result ?? null;
}

function excludedFamily(family: string, reason: string): ValidationResult { return { status: "EXCLUDED_DATA_INSUFFICIENT", configId: null, metrics: metricsFor([], 0), gate: {}, reasons: [reason], trades: [] }; }

function buildSummary(input: { dataGate: Record<string, unknown>; crossExchange: Record<string, unknown>; delivery: Record<string, unknown>; registryHash: string; familyA: ReturnType<typeof evaluateFamilyA>; familyB: ValidationResult; familyC: ReturnType<typeof evaluateFamilyC>; best: ValidationResult | null; series: ReadonlyMap<string, Series> }): Record<string, unknown> {
  const allPass = input.familyA.status === "PASS" || input.familyC.status === "PASS";
  const conclusion = allPass ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "V12_MARKET_NEUTRAL_ALPHA_REJECTED";
  const bestFamily = input.familyA.status === "PASS" ? "BINANCE_CASH_AND_CARRY" : input.familyC.status === "PASS" ? "BASIS_CONVERGENCE" : null;
  const fallback = input.best ?? input.familyA;
  const researchStop = allPass ? "NO" : "YES";
  const reasons = [...input.familyA.reasons, ...input.familyC.reasons];
  return { schema: "bca-v12-validation-summary-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, registryHash: input.registryHash, data: input.dataGate, crossExchange: input.crossExchange, delivery: input.delivery, families: { BINANCE_CASH_AND_CARRY: serializeFamilyA(input.familyA), CROSS_EXCHANGE_FUNDING_SPREAD: serializeFamily(input.familyB), BASIS_CONVERGENCE: serializeFamilyC(input.familyC) }, bestCandidate: { family: bestFamily, configId: fallback.configId, promotion: bestFamily ? "PASS" : "FAIL" }, capital: input.best ? ("portfolio" in input.best ? input.best.portfolio : null) : input.familyA.portfolio, emailSimulation: input.best ? ("email" in input.best ? input.best.email : null) : input.familyA.email, EMAIL_PROMOTION_CANDIDATE: conclusion, researchStop, researchStopReason: allPass ? "All V12 gates passed; implementation remains off until external acceptance." : `V12_MARKET_NEUTRAL_ALPHA_REJECTED: ${[...new Set(reasons)].join(", ") || "no family passed all frozen gates"}.`, hardBoundaries: { productionChanged: false, productionEmail: false, autoTrading: false, deployment: false, merge: false, migration: false, oldDirectionalStrategiesTuned: false } };
}

function serializeFamily(value: ValidationResult): Record<string, unknown> { return { status: value.status, configId: value.configId, metrics: value.metrics, gate: value.gate, reasons: value.reasons, trades: value.trades.length }; }
function serializeFamilyA(value: ReturnType<typeof evaluateFamilyA>): Record<string, unknown> { return { ...serializeFamily(value), configResults: value.configResults.map((item) => ({ config: item.config, metrics: item.metrics, trades: item.trades.length, selectedByFrozenRule: item.selectedByFrozenRule })), nested: serializeValidation(value.nested), holdout: serializeValidation(value.holdout), symbol: value.symbol, email: value.email, portfolio: value.portfolio }; }
function serializeFamilyC(value: ReturnType<typeof evaluateFamilyC>): Record<string, unknown> { return { ...serializeFamily(value), configResults: value.configResults.map((item) => ({ config: item.config, metrics: item.metrics, trades: item.trades.length, selectedByFrozenRule: item.selectedByFrozenRule })), nested: serializeValidation(value.nested), holdout: serializeValidation(value.holdout), symbol: value.symbol, email: value.email, portfolio: value.portfolio }; }
function serializeValidation(value: ValidationResult): Record<string, unknown> { return { status: value.status, configId: value.configId, metrics: value.metrics, gate: value.gate, reasons: value.reasons, trades: value.trades.length }; }

function buildDataStopSummary(dataGate: Record<string, unknown>, crossExchange: Record<string, unknown>, delivery: Record<string, unknown>): Record<string, unknown> { return { schema: "bca-v12-validation-summary-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, data: dataGate, crossExchange, delivery, families: { BINANCE_CASH_AND_CARRY: { status: "EXCLUDED_DATA_INSUFFICIENT" }, CROSS_EXCHANGE_FUNDING_SPREAD: { status: "EXCLUDED_DATA_INSUFFICIENT" }, BASIS_CONVERGENCE: { status: "EXCLUDED_DATA_INSUFFICIENT" } }, EMAIL_PROMOTION_CANDIDATE: "V12_DATA_INSUFFICIENT", researchStop: "YES", researchStopReason: "Binance core data gate failed before any return read.", hardBoundaries: { productionChanged: false, productionEmail: false, autoTrading: false, deployment: false, merge: false, migration: false } };
}

function renderDecision(summary: Record<string, unknown>): string { return [`# V12.0 Market-Neutral Profit Email Strategy`, ``, `Baseline: **${BASELINE}**; registry: **${String(summary.registryHash)}**.`, `Data gate: **${String((summary.data as Record<string, unknown>).status)}**.`, `EMAIL_PROMOTION_CANDIDATE: **${String(summary.EMAIL_PROMOTION_CANDIDATE)}**.`, `Research stop: **${String(summary.researchStop)}** — ${String(summary.researchStopReason)}.`, ``, `Production Email remains OFF. No Production, database schema, migration, deployment, merge, account access, order placement or auto trading is changed by this research.`].join("\n"); }

function cumulative(values: readonly number[], trades: readonly V12Trade[], delaySeconds: number, stress: number): number[] { let total = 0; return trades.map((trade) => { total += trade.netPnlByStress[`${delaySeconds}:${stress}`] ?? 0; return total; }); }
function maxDrawdown(equity: readonly number[]): number { let peak = 0; let drawdown = 0; for (const value of equity) { peak = Math.max(peak, value); drawdown = Math.max(drawdown, peak - value); } return drawdown; }
function realizedVol24h(candles: readonly Candle[], timestamp: number): number { const values = candles.filter((candle) => candle.openTime < timestamp && candle.openTime >= timestamp - 24 * HOUR).map((candle) => candle.close).filter((value) => value > 0); if (values.length < 3) return Infinity; const returns = values.slice(1).map((value, index) => Math.log(value / values[index])); const meanValue = mean(returns); return Math.sqrt(mean(returns.map((value) => (value - meanValue) ** 2))) * Math.sqrt(24); }
function nextCandle(candles: readonly Candle[], timestamp: number): Candle | null { return candles.find((candle) => candle.openTime >= timestamp) ?? null; }
function dedupeCandles(candles: readonly Candle[]): Candle[] { const map = new Map<number, Candle>(); for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle); return [...map.values()].filter((candle) => candle.openTime >= START && candle.openTime <= END).sort((left, right) => left.openTime - right.openTime); }
function dedupeFunding(points: readonly FundingRatePoint[]): FundingRatePoint[] { const map = new Map<number, FundingRatePoint>(); for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point); return [...map.values()].filter((point) => point.fundingTime >= START && point.fundingTime <= END).sort((left, right) => left.fundingTime - right.fundingTime); }
function expectedBuckets(start: number, end: number, interval: number): number { return Math.floor((end - start) / interval) + 1; }
function monthKeys(start: number, end: number): string[] { const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1)); const last = new Date(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1)); const output: string[] = []; while (cursor <= last) { output.push(monthKey(cursor.getTime())); cursor.setUTCMonth(cursor.getUTCMonth() + 1); } return output; }
function monthKey(timestamp: number): string { const date = new Date(timestamp); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function median(values: readonly number[]): number { if (!values.length) return 0; const sorted = values.slice().sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function mean(values: readonly number[]): number { return values.length ? sum(values) / values.length : 0; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function hashObject(value: unknown): string { return sha256(Buffer.from(JSON.stringify(value))); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function relativePath(path: string): string { return path.replace(`${resolve(".")}\\`, "").replaceAll("\\", "/"); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const output = new Array<R>(items.length); let next = 0; async function consume(): Promise<void> { while (true) { const index = next; next += 1; if (index >= items.length) return; output[index] = await worker(items[index]); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume())); return output; }

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
