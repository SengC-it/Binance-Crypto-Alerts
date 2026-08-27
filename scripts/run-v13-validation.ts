import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMonthlyArchive } from "@/lib/v5-7/external-data";
import type { Candle, FundingRatePoint } from "@/lib/core/types";

const BASELINE = "a32ba74b3c139f9bec1647a5478124b37bfb00b9";
const START = Date.UTC(2023, 0, 1);
const END = Date.UTC(2025, 11, 31, 23, 59, 59, 999);
const HOLDOUT_A_START = Date.UTC(2025, 0, 1);
const HOLDOUT_A_END = Date.UTC(2025, 5, 30, 23, 59, 59, 999);
const HOLDOUT_B_START = Date.UTC(2025, 6, 1);
const HOLDOUT_B_END = END;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const EIGHT_HOURS = 8 * 60 * 60 * 1_000;
const DAY = 24 * 60 * 60 * 1_000;
const YEAR = 365.25 * DAY;
const CAPITAL = 10_000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT"] as const;
const ALTCOINS = SYMBOLS.filter((symbol) => symbol !== "BTCUSDT");
const CACHE_ROOT = resolve("data/raw/v7-derivatives-flow-cache/market");
const REPORT_ROOT = resolve("reports");
const ARCHIVE_ROOT = "https://data.binance.vision/data/futures/um/monthly";
const NORMAL_LATENCY_MINUTES = 15;
const NORMAL_MISALIGN_SECONDS = 120;
const EMAIL_LATENCIES = [5, 15, 30] as const;
const LEG_MISALIGNMENTS = [30, 120, 300] as const;
const STRESS_BPS = [0, 5, 10, 20] as const;
const COST_MODEL = {
  feeBpsPerSide: 4,
  baseSlippageBpsPerLegExecution: 2,
  emailLatencyBps: { "5": 1, "15": 2, "30": 4 },
  legMisalignmentBps: { "30": 0.5, "120": 1.5, "300": 3 },
  effectiveLeverage: 1,
  maxConcurrentSignals: 5,
  startingCapital: CAPITAL,
  execution: "Each candidate executes two logical legs at the next closed 15m bar open; latency and leg misalignment are fixed, preregistered bps proxies.",
} as const;

type Family = "BETA_NEUTRAL_RESIDUAL_REVERSION" | "PAIR_SPREAD_MEAN_REVERSION" | "CLUSTER_RELATIVE_VALUE";
type FamilyStatus = "PASS" | "FAIL";
type ArchiveKind = "perp15m" | "funding";

interface ArchiveRecord {
  symbol: string;
  kind: ArchiveKind;
  period: string;
  source: "BINANCE_DATA_VISION_PUBLIC";
  sourceUrl: string;
  cachePath: string | null;
  status: "CACHED" | "MISSING" | "FAILED";
  rowCount: number;
  sizeBytes: number;
  sha256: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  error?: string;
}

interface Series {
  candles: Candle[];
  funding: FundingRatePoint[];
}

interface RelativeIndex {
  left: readonly Candle[];
  rightAt: readonly (Candle | undefined)[];
  leftLog: readonly number[];
  rightLog: readonly number[];
  prefixPriceCount: readonly number[];
  prefixLeft: readonly number[];
  prefixRight: readonly number[];
  prefixLeftSquared: readonly number[];
  prefixRightSquared: readonly number[];
  prefixCross: readonly number[];
  prefixReturnCount: readonly number[];
  prefixReturnLeft: readonly number[];
  prefixReturnRight: readonly number[];
  prefixReturnLeftSquared: readonly number[];
  prefixReturnRightSquared: readonly number[];
  prefixReturnCross: readonly number[];
}

interface ClusterIndex {
  asset: readonly Candle[];
  peersAt: readonly (readonly (Candle | undefined)[])[];
  assetLog: readonly number[];
  basketLog: readonly number[];
  prefixPriceCount: readonly number[];
  prefixAsset: readonly number[];
  prefixBasket: readonly number[];
  prefixAssetSquared: readonly number[];
  prefixBasketSquared: readonly number[];
  prefixCross: readonly number[];
  prefixReturnCount: readonly number[];
  prefixReturnAsset: readonly number[];
  prefixReturnBasket: readonly number[];
  prefixReturnAssetSquared: readonly number[];
  prefixReturnBasketSquared: readonly number[];
  prefixReturnCross: readonly number[];
}

interface LoadedData {
  records: ArchiveRecord[];
  series: Map<string, Series>;
}

interface V13Config {
  id: string;
  family: Family;
  entryZ: number;
  exitZ: number;
  lookbackBars: number;
  zWindowBars: number;
  maxHoldBars: number;
  minCorrelation?: number;
}

interface PairDefinition {
  id: string;
  left: string;
  right: string;
}

interface ClusterDefinition {
  id: string;
  members: readonly string[];
}

interface FundingContribution {
  symbol: string;
  direction: 1 | -1;
  notional: number;
}

interface LegInput {
  direction: 1 | -1;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  funding: FundingContribution[];
}

interface V13Trade {
  family: Family;
  configId: string;
  pairId: string;
  signalTimestamp: number;
  entryTimestamp: number;
  exitTimestamp: number;
  holdingHours: number;
  grossPnl: number;
  fundingPnl: number;
  feesPnl: number;
  executionPnl: number;
  netPnlByScenario: Record<string, number>;
}

interface MetricSummary {
  trades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  netPnl: number;
  returnPct: number;
  annualizedReturnPct: number;
  profitFactor: number;
  winRate: number;
  averageTradeProfit: number;
  medianTradeProfit: number;
  worstTrade: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  positiveMonthRatio: number;
  positiveMonths: number;
  observedMonths: number;
  profitablePairs: number;
  pairCount: number;
  topPairProfitShare: number | null;
  averageHoldingHours: number;
  medianHoldingHours: number;
  stress: Record<string, { netPnl: number; returnPct: number; maxDrawdownPct: number }>;
}

interface ConfigResult {
  config: V13Config;
  trades: V13Trade[];
  metrics: MetricSummary;
  selectedByFrozenRule: boolean;
}

interface ValidationResult {
  status: FamilyStatus;
  configId: string | null;
  metrics: MetricSummary;
  gate: Record<string, boolean>;
  reasons: string[];
  trades: V13Trade[];
}

interface StabilityResult {
  pass: boolean;
  positiveGroupRatio: number;
  groups: Record<string, MetricSummary>;
  reasons: string[];
}

interface FamilyEvaluation extends ValidationResult {
  family: Family;
  configResults: ConfigResult[];
  nested: ValidationResult;
  holdoutA: ValidationResult;
  holdoutB: ValidationResult;
  pairDiversification: Record<string, unknown>;
  yearStability: StabilityResult;
  regimeStability: StabilityResult;
  volatilityStability: StabilityResult;
  latency: Record<string, unknown>;
  legMisalignment: Record<string, unknown>;
  emailSimulation: Record<string, unknown>;
  portfolio: Record<string, unknown>;
  placebo: Record<string, unknown>;
  capital: Record<string, unknown>;
  registryHash: string;
}

const CONFIGURATIONS: readonly V13Config[] = [
  { id: "A1-RESIDUAL-1.5Z-16H", family: "BETA_NEUTRAL_RESIDUAL_REVERSION", entryZ: 1.5, exitZ: 0.25, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 64 },
  { id: "A2-RESIDUAL-2.0Z-24H", family: "BETA_NEUTRAL_RESIDUAL_REVERSION", entryZ: 2, exitZ: 0.5, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 96 },
  { id: "A3-RESIDUAL-2.5Z-48H", family: "BETA_NEUTRAL_RESIDUAL_REVERSION", entryZ: 2.5, exitZ: 0.75, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 192 },
  { id: "B1-PAIR-1.5Z-16H", family: "PAIR_SPREAD_MEAN_REVERSION", entryZ: 1.5, exitZ: 0.25, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 64, minCorrelation: 0.45 },
  { id: "B2-PAIR-2.0Z-24H", family: "PAIR_SPREAD_MEAN_REVERSION", entryZ: 2, exitZ: 0.5, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 96, minCorrelation: 0.55 },
  { id: "B3-PAIR-2.5Z-48H", family: "PAIR_SPREAD_MEAN_REVERSION", entryZ: 2.5, exitZ: 0.75, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 192, minCorrelation: 0.65 },
  { id: "C1-CLUSTER-1.5Z-16H", family: "CLUSTER_RELATIVE_VALUE", entryZ: 1.5, exitZ: 0.25, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 64 },
  { id: "C2-CLUSTER-2.0Z-24H", family: "CLUSTER_RELATIVE_VALUE", entryZ: 2, exitZ: 0.5, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 96 },
  { id: "C3-CLUSTER-2.5Z-48H", family: "CLUSTER_RELATIVE_VALUE", entryZ: 2.5, exitZ: 0.75, lookbackBars: 672, zWindowBars: 288, maxHoldBars: 192 },
] as const;

const PAIRS: readonly PairDefinition[] = [
  { id: "BTC-ETH", left: "BTCUSDT", right: "ETHUSDT" },
  { id: "BTC-LTC", left: "BTCUSDT", right: "LTCUSDT" },
  { id: "ETH-SOL", left: "ETHUSDT", right: "SOLUSDT" },
  { id: "BNB-ADA", left: "BNBUSDT", right: "ADAUSDT" },
  { id: "XRP-DOGE", left: "XRPUSDT", right: "DOGEUSDT" },
  { id: "SOL-AVAX", left: "SOLUSDT", right: "AVAXUSDT" },
  { id: "LINK-LTC", left: "LINKUSDT", right: "LTCUSDT" },
  { id: "ADA-AVAX", left: "ADAUSDT", right: "AVAXUSDT" },
] as const;

const CLUSTERS: readonly ClusterDefinition[] = [
  { id: "L1", members: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"] },
  { id: "PAYMENTS", members: ["XRPUSDT", "DOGEUSDT", "ADAUSDT"] },
  { id: "INFRA", members: ["LINKUSDT", "AVAXUSDT", "LTCUSDT"] },
] as const;

async function main(): Promise<void> {
  await mkdir(REPORT_ROOT, { recursive: true });
  const loaded = await loadData();
  const dataGate = buildDataGate(loaded);
  const registry = buildRegistry();
  const registryHash = hashObject(registry);
  await writeJson(resolve(REPORT_ROOT, "v13-data-gate.json"), { schema: "bca-v13-data-gate-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, dataGate, records: loaded.records });
  await writeJson(resolve(REPORT_ROOT, "v13-registry.json"), { ...registry, registryHash, freezeStatus: "FROZEN_BEFORE_RETURN_READ" });
  await writeJson(resolve(REPORT_ROOT, "v13-freeze-manifest.json"), { schema: "bca-v13-freeze-manifest-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, registryHash, registry, costModel: COST_MODEL, sources: loaded.records.filter((record) => record.sha256).map((record) => ({ sourceUrl: record.sourceUrl, cachePath: record.cachePath, symbol: record.symbol, kind: record.kind, period: record.period, rowCount: record.rowCount, bytes: record.sizeBytes, sha256: record.sha256 })), frozenRules: { data: "PIT completed 15m candles only; next 15m open is execution reference.", selection: "Training net PnL at 15m/2m/normal cost; tie-break PF then lower DD.", holdouts: ["2025-H1", "2025-H2"], configurations: CONFIGURATIONS.length, placeboSeed: 130013 } });

  if (!dataGate.pass) {
    const summary = buildDataStopSummary(dataGate, registryHash);
    await writeJson(resolve(REPORT_ROOT, "v13-validation-summary.json"), summary);
    await writeJson(resolve(REPORT_ROOT, "v13-promotion-decision.json"), { status: "V13_DATA_INSUFFICIENT", researchStop: "YES", registryHash });
    await writeFile(resolve(REPORT_ROOT, "v13-promotion-decision.md"), renderDecision(summary), "utf8");
    console.error("V13_DATA_INSUFFICIENT");
    process.exitCode = 2;
    return;
  }

  const familyA = evaluateFamily("BETA_NEUTRAL_RESIDUAL_REVERSION", loaded.series, registryHash);
  const familyB = evaluateFamily("PAIR_SPREAD_MEAN_REVERSION", loaded.series, registryHash);
  const familyC = evaluateFamily("CLUSTER_RELATIVE_VALUE", loaded.series, registryHash);
  const families = { BETA_NEUTRAL_RESIDUAL_REVERSION: familyA, PAIR_SPREAD_MEAN_REVERSION: familyB, CLUSTER_RELATIVE_VALUE: familyC };
  const best = selectWinner(families);
  const allPass = Object.values(families).some((family) => family.status === "PASS");
  const summary = buildSummary({ dataGate, registryHash, families, best, allPass });
  await writeJson(resolve(REPORT_ROOT, "v13-family-results.json"), families);
  await writeJson(resolve(REPORT_ROOT, "v13-validation-summary.json"), summary);
  await writeJson(resolve(REPORT_ROOT, "v13-promotion-decision.json"), { schema: "bca-v13-promotion-decision-v1", baseline: BASELINE, registryHash, status: summary.EMAIL_PROMOTION_CANDIDATE, researchStop: summary.researchStop, winner: best ? { family: best.family, configId: best.configId } : null });
  await writeFile(resolve(REPORT_ROOT, "v13-promotion-decision.md"), renderDecision(summary), "utf8");
  console.info(JSON.stringify({ stage: "v13_validation_complete", dataGate: dataGate.status, families: Object.fromEntries(Object.entries(families).map(([family, result]) => [family, { status: result.status, configId: result.configId, trades: result.metrics.trades }])), winner: best ? { family: best.family, configId: best.configId } : null, emailPromotionCandidate: summary.EMAIL_PROMOTION_CANDIDATE, researchStop: summary.researchStop }));
}

function buildRegistry(): Record<string, unknown> {
  const placeboPairs = buildPlaceboPairs(130013);
  return { schema: "bca-v13-registry-v1", baseline: BASELINE, universe: SYMBOLS, families: ["BETA_NEUTRAL_RESIDUAL_REVERSION", "PAIR_SPREAD_MEAN_REVERSION", "CLUSTER_RELATIVE_VALUE"], configurations: CONFIGURATIONS, pairRegistry: PAIRS, clusterRegistry: CLUSTERS, placeboPairs, dataRule: "Universe and pair registry are fixed before outcomes; beta/correlation/cluster hedge estimates use only bars closed at or before each signal.", executionRule: "Signal uses a closed 15m bar and executes the next complete 15m open; all strategies have two logical legs.", volatilityRule: "HIGH_VOL is a closed 96-bar RMS log-return reading >=1%; LOW_VOL is below 1%; UNKNOWN is excluded from the stability gate.", gateRule: "Nested: >=100 trades, net>0, annualized net return>=8%, PF>=1.30, DD<=10%, positiveMonthRatio>=70%, median>0, +10bps net>0, +20bps net>0. Holdout A/B: >=20 trades, net>0, PF>=1.20, DD<=10%. Diversification: >=8 pairs, >=5 profitable, top pair<=40%. Email yield: >=2/month, activeMonthRatio>=70%, max drought<=45d. All latency and 30s/2m/5m leg-misalignment scenarios must remain net positive.", costModel: COST_MODEL };
}

async function loadData(): Promise<LoadedData> {
  const periods = monthKeys(START, END);
  const records: ArchiveRecord[] = [];
  const series = new Map<string, Series>(SYMBOLS.map((symbol) => [symbol, { candles: [], funding: [] }]));
  for (const symbol of SYMBOLS) {
    for (const period of periods) {
      const market = await loadArchive(symbol, "perp15m", period);
      records.push(market.record);
      series.get(symbol)!.candles.push(...market.candles);
      const funding = await loadArchive(symbol, "funding", period);
      records.push(funding.record);
      series.get(symbol)!.funding.push(...funding.funding);
    }
  }
  for (const [symbol, value] of series) series.set(symbol, { candles: dedupeCandles(value.candles), funding: dedupeFunding(value.funding) });
  return { records, series };
}

async function loadArchive(symbol: string, kind: ArchiveKind, period: string): Promise<{ record: ArchiveRecord; candles: Candle[]; funding: FundingRatePoint[] }> {
  const sourceUrl = kind === "perp15m" ? `${ARCHIVE_ROOT}/klines/${symbol}/15m/${symbol}-15m-${period}.zip` : `${ARCHIVE_ROOT}/fundingRate/${symbol}/${symbol}-fundingRate-${period}.zip`;
  const cachePath = resolve(CACHE_ROOT, symbol, kind === "perp15m" ? "15m" : "funding", `${period}.zip`);
  try { await stat(cachePath); } catch {
    return { record: { symbol, kind, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: null, status: "MISSING", rowCount: 0, sizeBytes: 0, sha256: null, firstTimestamp: null, lastTimestamp: null, error: "official archive not present in immutable local cache" }, candles: [], funding: [] };
  }
  try {
    const bytes = await readFile(cachePath);
    const parsed = parseMonthlyArchive(bytes, kind === "funding" ? "funding" : "15m");
    const candles = (parsed.candles ?? []).map(normalizeCandle).filter((candle) => candle.openTime >= START && candle.openTime <= END);
    const funding = (parsed.fundingRates ?? []).map((point) => ({ ...point, fundingTime: normalizeTimestamp(point.fundingTime) })).filter((point) => point.fundingTime >= START && point.fundingTime <= END);
    const timestamps = kind === "funding" ? funding.map((point) => point.fundingTime) : candles.map((candle) => candle.openTime);
    return { record: { symbol, kind, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: relativePath(cachePath), status: "CACHED", rowCount: parsed.rowCount, sizeBytes: bytes.byteLength, sha256: sha256(bytes), firstTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null, lastTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null }, candles, funding };
  } catch (error) {
    return { record: { symbol, kind, period, source: "BINANCE_DATA_VISION_PUBLIC", sourceUrl, cachePath: relativePath(cachePath), status: "FAILED", rowCount: 0, sizeBytes: 0, sha256: null, firstTimestamp: null, lastTimestamp: null, error: error instanceof Error ? error.message : String(error) }, candles: [], funding: [] };
  }
}

function buildDataGate(loaded: LoadedData): Record<string, unknown> & { pass: boolean; status: string } {
  const expectedBars = expectedBuckets(START, END, FIFTEEN_MINUTES);
  const expectedFunding = Math.floor((END - START) / EIGHT_HOURS) + 1;
  const bySymbol = SYMBOLS.map((symbol) => {
    const value = loaded.series.get(symbol)!;
    const candleCoverage = value.candles.length / expectedBars;
    const fundingCoverage = value.funding.length / expectedFunding;
    return { symbol, candles15m: value.candles.length, fundingRows: value.funding.length, candleCoverage, fundingCoverage, minCoverage: Math.min(candleCoverage, fundingCoverage), firstCandle: value.candles[0] ? new Date(value.candles[0].openTime).toISOString() : null, lastCandle: value.candles.at(-1) ? new Date(value.candles.at(-1)!.openTime).toISOString() : null };
  });
  const minCoverage = Math.min(...bySymbol.map((item) => item.minCoverage));
  const years = (END - START + 1) / YEAR;
  const reasons = [...(years < 3 ? ["less_than_3_years"] : []), ...(SYMBOLS.length < 10 ? ["less_than_10_symbols"] : []), ...(minCoverage < 0.98 ? ["timestamp_coverage_below_98_percent"] : [])];
  return { status: reasons.length ? "V13_DATA_INSUFFICIENT" : "PASS", pass: reasons.length === 0, years, symbols: SYMBOLS.length, universe: SYMBOLS, start: new Date(START).toISOString(), end: new Date(END).toISOString(), expected15mBarsPerSymbol: expectedBars, expectedFundingRowsPerSymbol: expectedFunding, minCoverage, bySymbol, requiredSources: ["Binance official public USDⓈ-M 15m klines", "Binance official public fundingRate archives"], reasons, archiveRecords: loaded.records.length };
}

function evaluateFamily(family: Family, series: ReadonlyMap<string, Series>, registryHash: string): FamilyEvaluation {
  const configs = CONFIGURATIONS.filter((config) => config.family === family);
  const configResults = configs.map((config) => {
    const trades = buildFamilyTrades(family, series, config);
    return { config, trades, metrics: metricsFor(trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0), selectedByFrozenRule: false };
  });
  const selectedConfig = selectConfig(configResults, START, HOLDOUT_A_START - 1);
  if (selectedConfig) selectedConfig.selectedByFrozenRule = true;
  const selected = selectedConfig ?? configResults[0];
  const nested = evaluateNested(configResults);
  const holdoutA = evaluatePeriod(selected, HOLDOUT_A_START, HOLDOUT_A_END);
  const holdoutB = evaluatePeriod(selected, HOLDOUT_B_START, HOLDOUT_B_END);
  const pairDiversification = buildPairDiversification(selected.trades);
  const yearStability = buildStability(selected.trades, "year");
  const regimeStability = buildStability(selected.trades, "regime", series);
  const volatilityStability = buildStability(selected.trades, "volatility", series);
  const latency = buildLatencyReport(selected.trades);
  const legMisalignment = buildLegMisalignmentReport(selected.trades);
  const emailSimulation = buildEmailSimulation(selected.trades);
  const portfolio = buildPortfolioSimulation(selected.trades);
  const placebo = family === "PAIR_SPREAD_MEAN_REVERSION" ? buildPlaceboReport(selected.trades, selected.config, series) : { applicable: false, status: "NOT_APPLICABLE", reason: "Random-pair placebo is preregistered for the fixed pair family; residual and cluster families have no pair-label selection step." };
  const metrics = metricsFor(selected.trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const gate = { nested: nested.status === "PASS", holdoutA: holdoutA.status === "PASS", holdoutB: holdoutB.status === "PASS", pairDiversification: Boolean(pairDiversification.pass), yearStability: yearStability.pass, regimeStability: regimeStability.pass, volatilityStability: volatilityStability.pass, emailLatency: Boolean(latency.pass), legMisalignment: Boolean(legMisalignment.pass), emailYield: Boolean((emailSimulation as Record<string, unknown>).pass), portfolio: Boolean((portfolio as Record<string, unknown>).pass), costStress: metrics.stress["20"].netPnl > 0, placebo: family === "PAIR_SPREAD_MEAN_REVERSION" ? placebo.status === "PASS" : true };
  const reasons = [...nested.reasons, ...holdoutA.reasons.map((reason) => `holdoutA_${reason}`), ...holdoutB.reasons.map((reason) => `holdoutB_${reason}`), ...(pairDiversification.reasons as string[]), ...yearStability.reasons.map((reason) => `year_${reason}`), ...regimeStability.reasons.map((reason) => `regime_${reason}`), ...volatilityStability.reasons.map((reason) => `volatility_${reason}`), ...((latency.reasons as string[]) ?? []), ...((legMisalignment.reasons as string[]) ?? []), ...((emailSimulation.reasons as string[]) ?? []), ...((portfolio.reasons as string[]) ?? []), ...((placebo.reasons as string[]) ?? [])];
  const status: FamilyStatus = Object.values(gate).every(Boolean) ? "PASS" : "FAIL";
  return { family, status, configId: selected.config.id, metrics, gate, reasons: [...new Set(reasons)], trades: selected.trades, configResults, nested, holdoutA, holdoutB, pairDiversification, yearStability, regimeStability, volatilityStability, latency, legMisalignment, emailSimulation, portfolio, placebo, capital: buildCapitalSimulation(selected.trades), registryHash } as FamilyEvaluation;
}

function buildFamilyTrades(family: Family, series: ReadonlyMap<string, Series>, config: V13Config): V13Trade[] {
  if (family === "BETA_NEUTRAL_RESIDUAL_REVERSION") return buildResidualTrades(series, config);
  if (family === "PAIR_SPREAD_MEAN_REVERSION") return buildPairTrades(series, config, PAIRS);
  return buildClusterTrades(series, config);
}

function buildResidualTrades(series: ReadonlyMap<string, Series>, config: V13Config): V13Trade[] {
  const candidates: V13Trade[] = [];
  const benchmark = series.get("BTCUSDT")!;
  for (const symbol of ALTCOINS) {
    const value = series.get(symbol)!;
    const pairIndex = buildRelativeIndex(value.candles, benchmark.candles);
    for (let index = config.lookbackBars + config.zWindowBars; index < value.candles.length - 1; index += 1) {
      const signal = value.candles[index];
      const benchmarkSignal = pairIndex.rightAt[index];
      if (!benchmarkSignal) continue;
      const beta = betaForIndexed(pairIndex, index, config.lookbackBars);
      if (!beta || !Number.isFinite(beta.beta)) continue;
      const z = rollingZIndexed(pairIndex, index, config.zWindowBars, beta.beta);
      if (z === null || Math.abs(z) < config.entryZ) continue;
      const entry = value.candles[index + 1];
      const entryBenchmark = pairIndex.rightAt[index + 1];
      if (!entryBenchmark) continue;
      const exit = findResidualExit(pairIndex, index, config, beta.beta);
      if (!exit) continue;
      const assetWeight = 1 / (1 + Math.abs(beta.beta));
      const benchmarkWeight = Math.abs(beta.beta) / (1 + Math.abs(beta.beta));
      const assetDirection: 1 | -1 = z > 0 ? -1 : 1;
      const benchmarkDirection: 1 | -1 = z > 0 ? 1 : -1;
      const trade = buildTrade("BETA_NEUTRAL_RESIDUAL_REVERSION", config.id, `${symbol}/BTCUSDT`, signal.closeTime, entry.openTime, exit.asset.openTime, [
        { direction: assetDirection, entryPrice: entry.open, exitPrice: exit.asset.open, notional: CAPITAL * assetWeight, funding: [{ symbol, direction: assetDirection, notional: CAPITAL * assetWeight }] },
        { direction: benchmarkDirection, entryPrice: entryBenchmark.open, exitPrice: exit.benchmark.open, notional: CAPITAL * benchmarkWeight, funding: [{ symbol: "BTCUSDT", direction: benchmarkDirection, notional: CAPITAL * benchmarkWeight }] },
      ], series);
      if (trade) candidates.push(trade);
    }
  }
  return removeOverlaps(candidates);
}

function buildPairTrades(series: ReadonlyMap<string, Series>, config: V13Config, pairs: readonly PairDefinition[]): V13Trade[] {
  const candidates: V13Trade[] = [];
  for (const pair of pairs) {
    const left = series.get(pair.left)!;
    const right = series.get(pair.right)!;
    const pairIndex = buildRelativeIndex(left.candles, right.candles);
    for (let index = config.lookbackBars + config.zWindowBars; index < left.candles.length - 1; index += 1) {
      const signal = left.candles[index];
      const rightSignal = pairIndex.rightAt[index];
      if (!rightSignal) continue;
      const beta = betaForIndexed(pairIndex, index, config.lookbackBars);
      if (!beta || !Number.isFinite(beta.beta) || beta.correlation < (config.minCorrelation ?? 0)) continue;
      const z = rollingZIndexed(pairIndex, index, config.zWindowBars, beta.beta);
      if (z === null || Math.abs(z) < config.entryZ) continue;
      const entry = left.candles[index + 1];
      const entryRight = pairIndex.rightAt[index + 1];
      if (!entryRight) continue;
      const exit = findPairExit(pairIndex, index, config, beta.beta);
      if (!exit) continue;
      const leftWeight = 1 / (1 + Math.abs(beta.beta));
      const rightWeight = Math.abs(beta.beta) / (1 + Math.abs(beta.beta));
      const leftDirection: 1 | -1 = z > 0 ? -1 : 1;
      const rightDirection: 1 | -1 = z > 0 ? 1 : -1;
      const trade = buildTrade("PAIR_SPREAD_MEAN_REVERSION", config.id, pair.id, signal.closeTime, entry.openTime, exit.left.openTime, [
        { direction: leftDirection, entryPrice: entry.open, exitPrice: exit.left.open, notional: CAPITAL * leftWeight, funding: [{ symbol: pair.left, direction: leftDirection, notional: CAPITAL * leftWeight }] },
        { direction: rightDirection, entryPrice: entryRight.open, exitPrice: exit.right.open, notional: CAPITAL * rightWeight, funding: [{ symbol: pair.right, direction: rightDirection, notional: CAPITAL * rightWeight }] },
      ], series);
      if (trade) candidates.push(trade);
    }
  }
  return removeOverlaps(candidates);
}

function buildClusterTrades(series: ReadonlyMap<string, Series>, config: V13Config): V13Trade[] {
  const candidates: V13Trade[] = [];
  for (const cluster of CLUSTERS) {
    for (const assetSymbol of cluster.members) {
      const asset = series.get(assetSymbol)!;
      const peers = cluster.members.filter((symbol) => symbol !== assetSymbol).map((symbol) => ({ symbol, series: series.get(symbol)! }));
      const clusterIndex = buildClusterIndex(asset.candles, peers.map((peer) => peer.series.candles));
      for (let index = config.lookbackBars + config.zWindowBars; index < asset.candles.length - 1; index += 1) {
        const signal = asset.candles[index];
        const signalPeers = clusterIndex.peersAt[index];
        if (signalPeers.some((candle) => !candle)) continue;
        const beta = clusterBetaIndexed(clusterIndex, index, config.lookbackBars);
        if (!beta || !Number.isFinite(beta.beta)) continue;
        const z = clusterRollingZ(clusterIndex, index, config.zWindowBars);
        if (z === null || Math.abs(z) < config.entryZ) continue;
        const entry = asset.candles[index + 1];
        const entryPeers = clusterIndex.peersAt[index + 1];
        if (entryPeers.some((candle) => !candle)) continue;
        const exit = findClusterExit(clusterIndex, index, config);
        if (!exit) continue;
        const assetWeight = 1 / (1 + Math.abs(beta.beta));
        const basketWeight = Math.abs(beta.beta) / (1 + Math.abs(beta.beta));
        const assetDirection: 1 | -1 = z > 0 ? -1 : 1;
        const basketDirection: 1 | -1 = z > 0 ? 1 : -1;
        const entryBasket = mean(entryPeers.map((candle) => candle!.open));
        const exitBasket = mean(exit.peers.map((candle) => candle.open));
        const basketFunding = peers.map((peer) => ({ symbol: peer.symbol, direction: basketDirection, notional: CAPITAL * basketWeight / peers.length }));
        const trade = buildTrade("CLUSTER_RELATIVE_VALUE", config.id, `${cluster.id}/${assetSymbol}`, signal.closeTime, entry.openTime, exit.asset.openTime, [
          { direction: assetDirection, entryPrice: entry.open, exitPrice: exit.asset.open, notional: CAPITAL * assetWeight, funding: [{ symbol: assetSymbol, direction: assetDirection, notional: CAPITAL * assetWeight }] },
          { direction: basketDirection, entryPrice: entryBasket, exitPrice: exitBasket, notional: CAPITAL * basketWeight, funding: basketFunding },
        ], series);
        if (trade) candidates.push(trade);
      }
    }
  }
  return removeOverlaps(candidates);
}

function buildTrade(family: Family, configId: string, pairId: string, signalTimestamp: number, entryTimestamp: number, exitTimestamp: number, legs: readonly LegInput[], series: ReadonlyMap<string, Series>): V13Trade | null {
  if (!legs.every((leg) => [leg.entryPrice, leg.exitPrice, leg.notional].every((value) => Number.isFinite(value) && value > 0)) || exitTimestamp <= entryTimestamp) return null;
  const grossPnl = sum(legs.map((leg) => leg.direction * leg.notional * (leg.exitPrice / leg.entryPrice - 1)));
  const fundingPnl = sum(legs.flatMap((leg) => leg.funding).map((contribution) => {
    const points = series.get(contribution.symbol)?.funding ?? [];
    return sum(points.filter((point) => point.fundingTime > entryTimestamp && point.fundingTime <= exitTimestamp).map((point) => -contribution.direction * contribution.notional * point.fundingRate));
  }));
  const legNotional = sum(legs.map((leg) => leg.notional));
  const turnover = 2 * legNotional;
  const feesPnl = turnover * COST_MODEL.feeBpsPerSide / 10_000;
  const netPnlByScenario: Record<string, number> = {};
  for (const latency of EMAIL_LATENCIES) {
    for (const misalignment of LEG_MISALIGNMENTS) {
      for (const stress of STRESS_BPS) {
        const execution = turnover * (COST_MODEL.baseSlippageBpsPerLegExecution + stress) / 10_000 + legNotional * (COST_MODEL.emailLatencyBps[String(latency) as keyof typeof COST_MODEL.emailLatencyBps] + COST_MODEL.legMisalignmentBps[String(misalignment) as keyof typeof COST_MODEL.legMisalignmentBps]) / 10_000;
        netPnlByScenario[scenarioKey(latency, misalignment, stress)] = grossPnl + fundingPnl - feesPnl - execution;
      }
    }
  }
  return { family, configId, pairId, signalTimestamp, entryTimestamp, exitTimestamp, holdingHours: (exitTimestamp - entryTimestamp) / (60 * 60 * 1_000), grossPnl, fundingPnl, feesPnl, executionPnl: -turnover * COST_MODEL.baseSlippageBpsPerLegExecution / 10_000, netPnlByScenario };
}

function findResidualExit(pairIndex: RelativeIndex, signalIndex: number, config: V13Config, beta: number): { asset: Candle; benchmark: Candle } | null {
  let fallback: { asset: Candle; benchmark: Candle } | null = null;
  const maxIndex = Math.min(pairIndex.left.length - 1, signalIndex + config.maxHoldBars);
  for (let index = signalIndex + 1; index <= maxIndex; index += 1) {
    const benchmark = pairIndex.rightAt[index];
    if (!benchmark) continue;
    const z = rollingZIndexed(pairIndex, index, config.zWindowBars, beta);
    if (z === null) continue;
    const next = pairIndex.left[index + 1];
    const nextBenchmark = pairIndex.rightAt[index + 1];
    if (!next || !nextBenchmark) continue;
    fallback = { asset: next, benchmark: nextBenchmark };
    if (Math.abs(z) <= config.exitZ || index === maxIndex) return fallback;
  }
  return fallback;
}

function findPairExit(pairIndex: RelativeIndex, signalIndex: number, config: V13Config, beta: number): { left: Candle; right: Candle } | null {
  let fallback: { left: Candle; right: Candle } | null = null;
  const maxIndex = Math.min(pairIndex.left.length - 1, signalIndex + config.maxHoldBars);
  for (let index = signalIndex + 1; index <= maxIndex; index += 1) {
    const right = pairIndex.rightAt[index];
    if (!right) continue;
    const z = rollingZIndexed(pairIndex, index, config.zWindowBars, beta);
    if (z === null) continue;
    const next = pairIndex.left[index + 1];
    const nextRight = pairIndex.rightAt[index + 1];
    if (!next || !nextRight) continue;
    fallback = { left: next, right: nextRight };
    if (Math.abs(z) <= config.exitZ || index === maxIndex) return fallback;
  }
  return fallback;
}

function findClusterExit(clusterIndex: ClusterIndex, signalIndex: number, config: V13Config): { asset: Candle; peers: Candle[] } | null {
  let fallback: { asset: Candle; peers: Candle[] } | null = null;
  const maxIndex = Math.min(clusterIndex.asset.length - 1, signalIndex + config.maxHoldBars);
  for (let index = signalIndex + 1; index <= maxIndex; index += 1) {
    const peers = clusterIndex.peersAt[index];
    if (peers.some((candle) => !candle)) continue;
    const z = clusterRollingZ(clusterIndex, index, config.zWindowBars);
    if (z === null) continue;
    const next = clusterIndex.asset[index + 1];
    const nextPeers = clusterIndex.peersAt[index + 1];
    if (!next || nextPeers.some((candle) => !candle)) continue;
    fallback = { asset: next, peers: nextPeers as Candle[] };
    if (Math.abs(z) <= config.exitZ || index === maxIndex) return fallback;
  }
  return fallback;
}

function evaluateNested(configResults: readonly ConfigResult[]): ValidationResult {
  const folds = [
    { testStart: Date.UTC(2023, 6, 1), testEnd: Date.UTC(2023, 11, 31, 23, 59, 59, 999) },
    { testStart: Date.UTC(2024, 0, 1), testEnd: Date.UTC(2024, 5, 30, 23, 59, 59, 999) },
    { testStart: Date.UTC(2024, 6, 1), testEnd: Date.UTC(2024, 11, 31, 23, 59, 59, 999) },
  ];
  const selectedTrades: V13Trade[] = [];
  for (const fold of folds) {
    const chosen = selectConfig(configResults, START, fold.testStart - 72 * 60 * 60 * 1_000);
    if (chosen) selectedTrades.push(...chosen.trades.filter((trade) => trade.entryTimestamp >= fold.testStart && trade.exitTimestamp <= fold.testEnd));
  }
  const metrics = metricsFor(selectedTrades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const gate = nestedGate(metrics);
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: selectedTrades.length ? "NESTED-FROZEN-SELECTION" : null, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades: selectedTrades };
}

function evaluatePeriod(result: ConfigResult, start: number, end: number): ValidationResult {
  const trades = result.trades.filter((trade) => trade.entryTimestamp >= start && trade.exitTimestamp <= end);
  const metrics = metricsFor(trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const gate = { trades: metrics.trades >= 20, netPnl: metrics.netPnl > 0, profitFactor: metrics.profitFactor >= 1.2, maxDrawdown: metrics.maxDrawdownPct <= 10 };
  return { status: Object.values(gate).every(Boolean) ? "PASS" : "FAIL", configId: result.config.id, metrics, gate, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name), trades };
}

function nestedGate(metrics: MetricSummary): Record<string, boolean> {
  return { trades: metrics.trades >= 100, netPnl: metrics.netPnl > 0, annualizedReturn: metrics.annualizedReturnPct >= 8, profitFactor: metrics.profitFactor >= 1.3, maxDrawdown: metrics.maxDrawdownPct <= 10, positiveMonthRatio: metrics.positiveMonthRatio >= 0.7, medianTradeProfit: metrics.medianTradeProfit > 0, plus10Bps: metrics.stress["10"].netPnl > 0, plus20Bps: metrics.stress["20"].netPnl > 0 };
}

function selectConfig(results: readonly ConfigResult[], start: number, end: number): ConfigResult | null {
  return results.map((result) => ({ result, trades: result.trades.filter((trade) => trade.entryTimestamp >= start && trade.exitTimestamp <= end) })).filter((item) => item.trades.length >= 20).sort((left, right) => { const leftMetrics = metricsFor(left.trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0); const rightMetrics = metricsFor(right.trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0); return rightMetrics.netPnl - leftMetrics.netPnl || rightMetrics.profitFactor - leftMetrics.profitFactor || leftMetrics.maxDrawdownPct - rightMetrics.maxDrawdownPct; })[0]?.result ?? null;
}

function buildPairDiversification(trades: readonly V13Trade[]): Record<string, unknown> {
  const byPair = new Map<string, V13Trade[]>();
  for (const trade of trades) byPair.set(trade.pairId, [...(byPair.get(trade.pairId) ?? []), trade]);
  const metrics = [...byPair.entries()].map(([pair, value]) => ({ pair, metrics: metricsFor(value, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0) }));
  const positive = metrics.filter((item) => item.metrics.netPnl > 0).map((item) => item.metrics.netPnl);
  const topPairProfitShare = sum(positive) > 0 ? Math.max(...positive) / sum(positive) : null;
  const reasons = [ ...(metrics.length < 8 ? ["fewer_than_8_pairs"] : []), ...(positive.length < 5 ? ["fewer_than_5_profitable_pairs"] : []), ...(topPairProfitShare !== null && topPairProfitShare > 0.4 ? ["top_pair_profit_share_over_40pct"] : []) ];
  return { pass: reasons.length === 0, pairCount: metrics.length, profitablePairs: positive.length, topPairProfitShare, byPair: metrics.map((item) => ({ pair: item.pair, trades: item.metrics.trades, netPnl: item.metrics.netPnl, profitFactor: item.metrics.profitFactor })), reasons };
}

function buildStability(trades: readonly V13Trade[], mode: "year" | "regime" | "volatility", series?: ReadonlyMap<string, Series>): StabilityResult {
  const groups = new Map<string, V13Trade[]>();
  for (const trade of trades) {
    const key = mode === "year" ? String(new Date(trade.exitTimestamp).getUTCFullYear()) : mode === "regime" ? regimeFor(trade.signalTimestamp, series?.get("BTCUSDT")?.candles ?? []) : volatilityRegimeFor(trade.signalTimestamp, series?.get("BTCUSDT")?.candles ?? []);
    if (key === "UNKNOWN") continue;
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  const serialized = Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, metricsFor(value, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0)]));
  const positive = Object.values(serialized).filter((metrics) => metrics.netPnl > 0).length;
  const ratio = groups.size ? positive / groups.size : 0;
  const required = mode === "year" ? 0.67 : 0.67;
  const reasons = [ ...(groups.size < 2 ? ["insufficient_stability_groups"] : []), ...(ratio < required ? ["positive_group_ratio_below_67pct"] : []) ];
  return { pass: reasons.length === 0, positiveGroupRatio: ratio, groups: serialized, reasons };
}

function buildLatencyReport(trades: readonly V13Trade[]): Record<string, unknown> {
  const byLatency = Object.fromEntries(EMAIL_LATENCIES.map((latency) => { const metrics = metricsFor(trades, latency, NORMAL_MISALIGN_SECONDS, 0); return [String(latency), metrics]; }));
  const reasons = EMAIL_LATENCIES.flatMap((latency) => { const metrics = byLatency[String(latency)] as MetricSummary; return metrics.netPnl > 0 ? [] : [`${latency}m_net_not_positive`]; });
  return { pass: reasons.length === 0, normalMisalignmentSeconds: NORMAL_MISALIGN_SECONDS, byLatency, reasons };
}

function buildLegMisalignmentReport(trades: readonly V13Trade[]): Record<string, unknown> {
  const byMisalignment = Object.fromEntries(LEG_MISALIGNMENTS.map((misalignment) => { const metrics = metricsFor(trades, NORMAL_LATENCY_MINUTES, misalignment, 0); return [String(misalignment), metrics]; }));
  const reasons = LEG_MISALIGNMENTS.flatMap((misalignment) => { const metrics = byMisalignment[String(misalignment)] as MetricSummary; return metrics.netPnl > 0 ? [] : [`${misalignment}s_net_not_positive`]; });
  return { pass: reasons.length === 0, normalLatencyMinutes: NORMAL_LATENCY_MINUTES, byMisalignment, reasons };
}

function buildEmailSimulation(trades: readonly V13Trade[]): Record<string, unknown> {
  const values = trades.map((trade) => scenarioValue(trade, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0));
  const sorted = trades.slice().sort((left, right) => left.exitTimestamp - right.exitTimestamp);
  const equity = cumulative(sorted, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const start = trades.length ? Math.min(...trades.map((trade) => trade.entryTimestamp)) : START;
  const end = trades.length ? Math.max(...trades.map((trade) => trade.entryTimestamp)) : END;
  const months = monthKeys(start, end);
  const byMonth = new Map<string, number>();
  for (const trade of trades) byMonth.set(monthKey(trade.entryTimestamp), (byMonth.get(monthKey(trade.entryTimestamp)) ?? 0) + 1);
  const dates = trades.map((trade) => trade.entryTimestamp).sort((left, right) => left - right);
  const droughts = dates.length > 1 ? dates.slice(1).map((date, index) => (date - dates[index]) / DAY) : [Infinity];
  const sortedDroughts = droughts.slice().sort((left, right) => left - right);
  const p95Drought = sortedDroughts.length ? sortedDroughts[Math.min(sortedDroughts.length - 1, Math.ceil(sortedDroughts.length * 0.95) - 1)] : Infinity;
  const activeMonthRatio = months.length ? months.filter((month) => (byMonth.get(month) ?? 0) >= 2).length / months.length : 0;
  const alertsPerMonth = months.length ? trades.length / months.length : 0;
  const reasons = [ ...(alertsPerMonth < 2 ? ["alerts_per_month_below_2"] : []), ...(activeMonthRatio < 0.7 ? ["active_month_ratio_below_70pct"] : []), ...(Math.max(...droughts) > 45 ? ["max_drought_over_45_days"] : []) ];
  return { pass: reasons.length === 0, emails: trades.length, emailsPerYear: trades.length / Math.max(1 / 12, months.length / 12), alertsPerMonth, activeMonthRatio, p95Drought, maxDrought: Math.max(...droughts), profitable: values.filter((value) => value > 0).length, losing: values.filter((value) => value <= 0).length, netPnl: sum(values), averagePerEmail: mean(values), medianPerEmail: median(values), maxDrawdown: maxDrawdown(equity), reasons };
}

function buildPortfolioSimulation(trades: readonly V13Trade[]): Record<string, unknown> {
  const ordered = trades.slice().sort((left, right) => left.entryTimestamp - right.entryTimestamp || left.exitTimestamp - right.exitTimestamp);
  const open: V13Trade[] = [];
  const accepted: V13Trade[] = [];
  let rejected = 0;
  for (const trade of ordered) {
    for (let index = open.length - 1; index >= 0; index -= 1) if (open[index].exitTimestamp <= trade.entryTimestamp) open.splice(index, 1);
    if (open.length >= COST_MODEL.maxConcurrentSignals) { rejected += 1; continue; }
    open.push(trade);
    accepted.push(trade);
  }
  const scale = 1 / COST_MODEL.maxConcurrentSignals;
  const scaled = accepted.map((trade) => ({ ...trade, netPnlByScenario: Object.fromEntries(Object.entries(trade.netPnlByScenario).map(([key, value]) => [key, value * scale])) }));
  const metrics = metricsFor(scaled, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const gate = { netPnl: metrics.netPnl > 0, profitFactor: metrics.profitFactor >= 1.2, maxDrawdown: metrics.maxDrawdownPct <= 10 };
  return { pass: Object.values(gate).every(Boolean), gate, metrics, acceptedEmails: accepted.length, rejectedForCapacity: rejected, maxConcurrentSignals: COST_MODEL.maxConcurrentSignals, effectiveLeverage: COST_MODEL.effectiveLeverage, reasons: Object.entries(gate).filter(([, pass]) => !pass).map(([name]) => name) };
}

function buildCapitalSimulation(trades: readonly V13Trade[]): Record<string, unknown> {
  const metrics = metricsFor(trades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  return Object.fromEntries(([1_000, 2_000, 10_000] as const).map((capital) => { const scale = capital / CAPITAL; return [String(capital), { executable: true, scale, netPnl: metrics.netPnl * scale, returnPct: metrics.netPnl / CAPITAL * 100, maxDrawdownUsdt: metrics.maxDrawdownUsdt * scale, averageCapitalLocked: capital, leverage: COST_MODEL.effectiveLeverage, caveat: capital === CAPITAL ? "Reference 1x case." : "Proportional research model; exchange minimums, borrow/transfer and account margin constraints are not inferred." }]; }));
}

function buildPlaceboReport(candidateTrades: readonly V13Trade[], config: V13Config, series: ReadonlyMap<string, Series>): Record<string, unknown> {
  const placeboPairs = buildPlaceboPairs(130013);
  const placeboTrades = buildPairTrades(series, config, placeboPairs);
  const candidateMetrics = metricsFor(candidateTrades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const placeboMetrics = metricsFor(placeboTrades, NORMAL_LATENCY_MINUTES, NORMAL_MISALIGN_SECONDS, 0);
  const pass = candidateMetrics.netPnl > placeboMetrics.netPnl && candidateMetrics.profitFactor >= placeboMetrics.profitFactor;
  return { applicable: true, status: pass ? "PASS" : "FAIL", seed: 130013, pairs: placeboPairs, candidate: candidateMetrics, placebo: placeboMetrics, reasons: pass ? [] : ["candidate_did_not_outperform_deterministic_random_pair_placebo"] };
}

function selectWinner(families: Record<Family, FamilyEvaluation>): FamilyEvaluation | null {
  const passed = Object.values(families).filter((family) => family.status === "PASS");
  return passed.sort((left, right) => right.metrics.netPnl - left.metrics.netPnl || left.metrics.maxDrawdownPct - right.metrics.maxDrawdownPct || left.configId!.localeCompare(right.configId!))[0] ?? null;
}

function buildSummary(input: { dataGate: Record<string, unknown>; registryHash: string; families: Record<Family, FamilyEvaluation>; best: FamilyEvaluation | null; allPass: boolean }): Record<string, unknown> {
  const conclusion = input.allPass ? "EMAIL_PROMOTION_CANDIDATE_PASS" : "V13_RELATIVE_VALUE_ALPHA_REJECTED";
  return { schema: "bca-v13-validation-summary-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, data: input.dataGate, registryHash: input.registryHash, families: Object.fromEntries(Object.entries(input.families).map(([family, value]) => [family, serializeFamily(value)])), bestCandidate: input.best ? { family: input.best.family, configId: input.best.configId, status: input.best.status } : { family: null, configId: null, status: "NONE" }, EMAIL_PROMOTION_CANDIDATE: conclusion, researchStop: input.allPass ? "NO" : "YES", researchStopReason: input.allPass ? "A candidate passed the frozen development gates; Production implementation remains disabled pending acceptance." : "V13_RELATIVE_VALUE_ALPHA_REJECTED: no family passed the frozen nested, dual holdout, cost, diversification, stability, placebo, latency, yield and portfolio gates.", emailImplementation: input.allPass ? "REQUIRES_POST_GATE_IMPLEMENTATION" : "NOT_DONE", simulationEmail: "NOT_SENT", hardBoundaries: { productionChanged: false, productionEmail: false, autoTrading: false, deployment: false, merge: false, migration: false, v12Changed: false } };
}

function serializeFamily(value: FamilyEvaluation): Record<string, unknown> {
  return { status: value.status, family: value.family, configId: value.configId, metrics: value.metrics, gate: value.gate, reasons: value.reasons, trades: value.trades.length, configResults: value.configResults.map((item) => ({ config: item.config, trades: item.trades.length, metrics: item.metrics, selectedByFrozenRule: item.selectedByFrozenRule })), nested: serializeValidation(value.nested), holdoutA: serializeValidation(value.holdoutA), holdoutB: serializeValidation(value.holdoutB), pairDiversification: value.pairDiversification, yearStability: value.yearStability, regimeStability: value.regimeStability, volatilityStability: value.volatilityStability, latency: value.latency, legMisalignment: value.legMisalignment, emailSimulation: value.emailSimulation, portfolio: value.portfolio, placebo: value.placebo, capital: value.capital };
}

function serializeValidation(value: ValidationResult): Record<string, unknown> { return { status: value.status, configId: value.configId, metrics: value.metrics, gate: value.gate, reasons: value.reasons, trades: value.trades.length }; }

function buildDataStopSummary(dataGate: Record<string, unknown>, registryHash: string): Record<string, unknown> { return { schema: "bca-v13-validation-summary-v1", generatedAt: new Date().toISOString(), baseline: BASELINE, data: dataGate, registryHash, EMAIL_PROMOTION_CANDIDATE: "V13_DATA_INSUFFICIENT", researchStop: "YES", researchStopReason: "Official Binance public archive data gate failed before any return read.", emailImplementation: "NOT_DONE", simulationEmail: "NOT_SENT", hardBoundaries: { productionChanged: false, productionEmail: false, autoTrading: false, deployment: false, merge: false, migration: false, v12Changed: false } };
}

function renderDecision(summary: Record<string, unknown>): string { return [`# V13.0 Market-Neutral Relative-Value Email Alpha`, ``, `Baseline: **${BASELINE}**; registry: **${String(summary.registryHash)}**.`, `Data gate: **${String((summary.data as Record<string, unknown>).status)}**.`, `EMAIL_PROMOTION_CANDIDATE: **${String(summary.EMAIL_PROMOTION_CANDIDATE)}**.`, `Research stop: **${String(summary.researchStop)}** — ${String(summary.researchStopReason)}.`, ``, `Production Email remains OFF. No Production, V12, database, migration, deployment, merge, account access, order placement or auto trading is changed by this research.`].join("\n"); }

function metricsFor(trades: readonly V13Trade[], latency: number, misalignment: number, stress: number): MetricSummary {
  const ordered = trades.slice().sort((left, right) => left.exitTimestamp - right.exitTimestamp || left.entryTimestamp - right.entryTimestamp);
  const values = ordered.map((trade) => scenarioValue(trade, latency, misalignment, stress));
  const netPnl = sum(values);
  const positive = sum(values.filter((value) => value > 0));
  const negative = Math.abs(sum(values.filter((value) => value < 0)));
  const start = ordered.length ? Math.min(...ordered.map((trade) => trade.entryTimestamp)) : START;
  const end = ordered.length ? Math.max(...ordered.map((trade) => trade.exitTimestamp)) : END;
  const years = Math.max(1 / 365.25, (end - start) / YEAR);
  const months = monthKeys(start, end);
  const monthPnl = new Map<string, number>();
  for (const trade of ordered) monthPnl.set(monthKey(trade.exitTimestamp), (monthPnl.get(monthKey(trade.exitTimestamp)) ?? 0) + scenarioValue(trade, latency, misalignment, stress));
  const pairPnl = new Map<string, number>();
  for (const trade of ordered) pairPnl.set(trade.pairId, (pairPnl.get(trade.pairId) ?? 0) + scenarioValue(trade, latency, misalignment, stress));
  const profitablePairs = [...pairPnl.values()].filter((value) => value > 0);
  const equity = cumulative(ordered, latency, misalignment, stress);
  const stressMetrics = Object.fromEntries(STRESS_BPS.map((bps) => { const stressEquity = cumulative(ordered, latency, misalignment, bps); const stressNet = sum(ordered.map((trade) => scenarioValue(trade, latency, misalignment, bps))); return [String(bps), { netPnl: stressNet, returnPct: stressNet / CAPITAL * 100, maxDrawdownPct: maxDrawdown(stressEquity) / CAPITAL * 100 }]; })) as Record<string, { netPnl: number; returnPct: number; maxDrawdownPct: number }>;
  return { trades: ordered.length, wins: values.filter((value) => value > 0).length, losses: values.filter((value) => value <= 0).length, grossPnl: sum(ordered.map((trade) => trade.grossPnl + trade.fundingPnl)), netPnl, returnPct: netPnl / CAPITAL * 100, annualizedReturnPct: netPnl / CAPITAL / years * 100, profitFactor: negative > 0 ? positive / negative : positive > 0 ? Number.POSITIVE_INFINITY : 0, winRate: ordered.length ? values.filter((value) => value > 0).length / ordered.length : 0, averageTradeProfit: ordered.length ? netPnl / ordered.length : 0, medianTradeProfit: median(values), worstTrade: values.length ? Math.min(...values) : 0, maxDrawdownUsdt: maxDrawdown(equity), maxDrawdownPct: maxDrawdown(equity) / CAPITAL * 100, positiveMonthRatio: months.length ? months.filter((month) => (monthPnl.get(month) ?? 0) > 0).length / months.length : 0, positiveMonths: months.filter((month) => (monthPnl.get(month) ?? 0) > 0).length, observedMonths: months.length, profitablePairs: profitablePairs.length, pairCount: pairPnl.size, topPairProfitShare: sum(profitablePairs) > 0 ? Math.max(...profitablePairs) / sum(profitablePairs) : null, averageHoldingHours: ordered.length ? mean(ordered.map((trade) => trade.holdingHours)) : 0, medianHoldingHours: median(ordered.map((trade) => trade.holdingHours)), stress: stressMetrics };
}

function scenarioValue(trade: V13Trade, latency: number, misalignment: number, stress: number): number { return trade.netPnlByScenario[scenarioKey(latency, misalignment, stress)] ?? 0; }
function scenarioKey(latency: number, misalignment: number, stress: number): string { return `${latency}:${misalignment}:${stress}`; }
function cumulative(trades: readonly V13Trade[], latency: number, misalignment: number, stress: number): number[] { let total = 0; return trades.map((trade) => { total += scenarioValue(trade, latency, misalignment, stress); return total; }); }
function maxDrawdown(equity: readonly number[]): number { let peak = 0; let drawdown = 0; for (const value of equity) { peak = Math.max(peak, value); drawdown = Math.max(drawdown, peak - value); } return drawdown; }

interface RollingPrefixes {
  prefixPriceCount: number[];
  prefixLeft: number[];
  prefixRight: number[];
  prefixLeftSquared: number[];
  prefixRightSquared: number[];
  prefixCross: number[];
  prefixReturnCount: number[];
  prefixReturnLeft: number[];
  prefixReturnRight: number[];
  prefixReturnLeftSquared: number[];
  prefixReturnRightSquared: number[];
  prefixReturnCross: number[];
}

function buildRelativeIndex(left: readonly Candle[], right: readonly Candle[]): RelativeIndex {
  const rightMap = new Map(right.map((candle) => [candle.openTime, candle]));
  const rightAt = left.map((candle) => rightMap.get(candle.openTime));
  const leftLog = left.map((candle) => Math.log(candle.close));
  const rightLog = rightAt.map((candle) => candle ? Math.log(candle.close) : 0);
  const validPrices = rightAt.map((candle) => candle ? 1 : 0);
  const validReturns = left.map((_, index) => index > 0 && rightAt[index] && rightAt[index - 1] ? 1 : 0);
  const leftReturns = left.map((candle, index) => validReturns[index] ? leftLog[index] - leftLog[index - 1] : 0);
  const rightReturns = rightLog.map((value, index) => validReturns[index] ? value - rightLog[index - 1] : 0);
  return { left, rightAt, leftLog, rightLog, ...buildRollingPrefixes(leftLog, rightLog, validPrices, leftReturns, rightReturns, validReturns) };
}

function buildClusterIndex(asset: readonly Candle[], peers: readonly (readonly Candle[])[]): ClusterIndex {
  const peerMaps = peers.map((candles) => new Map(candles.map((candle) => [candle.openTime, candle])));
  const peersAt = asset.map((candle) => peerMaps.map((map) => map.get(candle.openTime)));
  const assetLog = asset.map((candle) => Math.log(candle.close));
  const basketLog = peersAt.map((at) => at.every(Boolean) ? mean(at.map((candle) => Math.log(candle!.close))) : 0);
  const validPrices = peersAt.map((at) => at.every(Boolean) ? 1 : 0);
  const validReturns = asset.map((_, index) => index > 0 && validPrices[index] === 1 && validPrices[index - 1] === 1 ? 1 : 0);
  const assetReturns = assetLog.map((value, index) => validReturns[index] ? value - assetLog[index - 1] : 0);
  const basketReturns = basketLog.map((value, index) => validReturns[index] ? value - basketLog[index - 1] : 0);
  const prefixes = buildRollingPrefixes(assetLog, basketLog, validPrices, assetReturns, basketReturns, validReturns);
  return { asset, peersAt, assetLog, basketLog, prefixPriceCount: prefixes.prefixPriceCount, prefixAsset: prefixes.prefixLeft, prefixBasket: prefixes.prefixRight, prefixAssetSquared: prefixes.prefixLeftSquared, prefixBasketSquared: prefixes.prefixRightSquared, prefixCross: prefixes.prefixCross, prefixReturnCount: prefixes.prefixReturnCount, prefixReturnAsset: prefixes.prefixReturnLeft, prefixReturnBasket: prefixes.prefixReturnRight, prefixReturnAssetSquared: prefixes.prefixReturnLeftSquared, prefixReturnBasketSquared: prefixes.prefixReturnRightSquared, prefixReturnCross: prefixes.prefixReturnCross };
}

function buildRollingPrefixes(left: readonly number[], right: readonly number[], validPrices: readonly number[], returnLeft: readonly number[], returnRight: readonly number[], validReturns: readonly number[]): RollingPrefixes {
  const prefixPriceCount = [0];
  const prefixLeft = [0];
  const prefixRight = [0];
  const prefixLeftSquared = [0];
  const prefixRightSquared = [0];
  const prefixCross = [0];
  const prefixReturnCount = [0];
  const prefixReturnLeft = [0];
  const prefixReturnRight = [0];
  const prefixReturnLeftSquared = [0];
  const prefixReturnRightSquared = [0];
  const prefixReturnCross = [0];
  for (let index = 0; index < left.length; index += 1) {
    const price = validPrices[index] ? 1 : 0;
    const returned = validReturns[index] ? 1 : 0;
    prefixPriceCount.push(prefixPriceCount[index] + price);
    prefixLeft.push(prefixLeft[index] + left[index] * price);
    prefixRight.push(prefixRight[index] + right[index] * price);
    prefixLeftSquared.push(prefixLeftSquared[index] + left[index] ** 2 * price);
    prefixRightSquared.push(prefixRightSquared[index] + right[index] ** 2 * price);
    prefixCross.push(prefixCross[index] + left[index] * right[index] * price);
    prefixReturnCount.push(prefixReturnCount[index] + returned);
    prefixReturnLeft.push(prefixReturnLeft[index] + returnLeft[index] * returned);
    prefixReturnRight.push(prefixReturnRight[index] + returnRight[index] * returned);
    prefixReturnLeftSquared.push(prefixReturnLeftSquared[index] + returnLeft[index] ** 2 * returned);
    prefixReturnRightSquared.push(prefixReturnRightSquared[index] + returnRight[index] ** 2 * returned);
    prefixReturnCross.push(prefixReturnCross[index] + returnLeft[index] * returnRight[index] * returned);
  }
  return { prefixPriceCount, prefixLeft, prefixRight, prefixLeftSquared, prefixRightSquared, prefixCross, prefixReturnCount, prefixReturnLeft, prefixReturnRight, prefixReturnLeftSquared, prefixReturnRightSquared, prefixReturnCross };
}

function betaForIndexed(index: RelativeIndex, position: number, lookback: number): { beta: number; correlation: number } | null {
  const start = Math.max(1, position - lookback + 1);
  const end = position + 1;
  return regressionFromPrefixes(index.prefixReturnCount, index.prefixReturnLeft, index.prefixReturnRight, index.prefixReturnLeftSquared, index.prefixReturnRightSquared, index.prefixReturnCross, start, end);
}

function clusterBetaIndexed(index: ClusterIndex, position: number, lookback: number): { beta: number } | null {
  const start = Math.max(1, position - lookback + 1);
  const end = position + 1;
  const result = regressionFromPrefixes(index.prefixReturnCount, index.prefixReturnAsset, index.prefixReturnBasket, index.prefixReturnAssetSquared, index.prefixReturnBasketSquared, index.prefixReturnCross, start, end);
  return result ? { beta: result.beta } : null;
}

function regressionFromPrefixes(countPrefix: readonly number[], yPrefix: readonly number[], xPrefix: readonly number[], ySquaredPrefix: readonly number[], xSquaredPrefix: readonly number[], crossPrefix: readonly number[], start: number, end: number): { beta: number; correlation: number } | null {
  const count = countPrefix[end] - countPrefix[start];
  if (count < 100) return null;
  const sumY = yPrefix[end] - yPrefix[start];
  const sumX = xPrefix[end] - xPrefix[start];
  const sumYSquared = ySquaredPrefix[end] - ySquaredPrefix[start];
  const sumXSquared = xSquaredPrefix[end] - xSquaredPrefix[start];
  const sumCross = crossPrefix[end] - crossPrefix[start];
  const covariance = sumCross - sumY * sumX / count;
  const varianceX = sumXSquared - sumX ** 2 / count;
  const varianceY = sumYSquared - sumY ** 2 / count;
  if (varianceX <= 0 || varianceY <= 0) return null;
  return { beta: covariance / varianceX, correlation: covariance / Math.sqrt(varianceX * varianceY) };
}

function rollingZIndexed(index: RelativeIndex, position: number, window: number, beta: number): number | null {
  const start = Math.max(0, position - window + 1);
  const end = position + 1;
  const count = index.prefixPriceCount[end] - index.prefixPriceCount[start];
  if (count < 30 || !index.rightAt[position]) return null;
  return rollingZFromPrefixes(index.prefixLeft, index.prefixRight, index.prefixLeftSquared, index.prefixRightSquared, index.prefixCross, index.leftLog[position], index.rightLog[position], beta, start, end, count);
}

function clusterRollingZ(index: ClusterIndex, position: number, window: number): number | null {
  const start = Math.max(0, position - window + 1);
  const end = position + 1;
  const count = index.prefixPriceCount[end] - index.prefixPriceCount[start];
  if (count < 30 || index.peersAt[position].some((candle) => !candle)) return null;
  return rollingZFromPrefixes(index.prefixAsset, index.prefixBasket, index.prefixAssetSquared, index.prefixBasketSquared, index.prefixCross, index.assetLog[position], index.basketLog[position], 1, start, end, count);
}

function rollingZFromPrefixes(leftPrefix: readonly number[], rightPrefix: readonly number[], leftSquaredPrefix: readonly number[], rightSquaredPrefix: readonly number[], crossPrefix: readonly number[], currentLeft: number, currentRight: number, beta: number, start: number, end: number, count: number): number | null {
  const sumLeft = leftPrefix[end] - leftPrefix[start];
  const sumRight = rightPrefix[end] - rightPrefix[start];
  const sumLeftSquared = leftSquaredPrefix[end] - leftSquaredPrefix[start];
  const sumRightSquared = rightSquaredPrefix[end] - rightSquaredPrefix[start];
  const sumCross = crossPrefix[end] - crossPrefix[start];
  const average = (sumLeft - beta * sumRight) / count;
  const secondMoment = (sumLeftSquared - 2 * beta * sumCross + beta ** 2 * sumRightSquared) / count;
  const variance = secondMoment - average ** 2;
  const deviation = variance > 0 ? Math.sqrt(variance) : 0;
  return deviation > 0 ? (currentLeft - beta * currentRight - average) / deviation : null;
}

function removeOverlaps(trades: readonly V13Trade[]): V13Trade[] { const availableAfter = new Map<string, number>(); const selected: V13Trade[] = []; for (const trade of trades.slice().sort((left, right) => left.entryTimestamp - right.entryTimestamp || left.exitTimestamp - right.exitTimestamp)) { if (trade.entryTimestamp < (availableAfter.get(trade.pairId) ?? START)) continue; selected.push(trade); availableAfter.set(trade.pairId, trade.exitTimestamp + FIFTEEN_MINUTES); } return selected.sort((left, right) => left.exitTimestamp - right.exitTimestamp || left.entryTimestamp - right.entryTimestamp); }

const CANDLE_INDEX_CACHE = new WeakMap<readonly Candle[], Map<number, number>>();

function candleIndexFor(timestamp: number, candles: readonly Candle[]): number | null {
  let indexByOpenTime = CANDLE_INDEX_CACHE.get(candles);
  if (!indexByOpenTime) {
    indexByOpenTime = new Map(candles.map((candle, index) => [candle.openTime, index]));
    CANDLE_INDEX_CACHE.set(candles, indexByOpenTime);
  }
  return indexByOpenTime.get(floorBar(timestamp)) ?? null;
}

function regimeFor(timestamp: number, btc: readonly Candle[]): string { const currentIndex = candleIndexFor(timestamp, btc); if (currentIndex === null) return "UNKNOWN"; const current = btc[currentIndex]; const previousIndex = candleIndexFor(current.openTime - 7 * DAY, btc); if (previousIndex === null) return "UNKNOWN"; const previous = btc[previousIndex]; if (previous.close <= 0) return "UNKNOWN"; const change = current.close / previous.close - 1; return change > 0.03 ? "BULL" : change < -0.03 ? "BEAR" : "RANGE"; }

function volatilityRegimeFor(timestamp: number, btc: readonly Candle[]): string {
  const currentIndex = candleIndexFor(timestamp, btc);
  if (currentIndex === null || currentIndex < 96) return "UNKNOWN";
  let squaredReturnSum = 0;
  for (let index = currentIndex - 95; index <= currentIndex; index += 1) {
    const previousClose = btc[index - 1].close;
    const close = btc[index].close;
    if (previousClose <= 0 || close <= 0) return "UNKNOWN";
    const logReturn = Math.log(close / previousClose);
    squaredReturnSum += logReturn ** 2;
  }
  return Math.sqrt(squaredReturnSum / 96) >= 0.01 ? "HIGH_VOL" : "LOW_VOL";
}
function floorBar(timestamp: number): number { return Math.floor(timestamp / FIFTEEN_MINUTES) * FIFTEEN_MINUTES; }

function buildPlaceboPairs(seed: number): PairDefinition[] { const shuffled = SYMBOLS.slice().sort((left, right) => seededValue(seed, left) - seededValue(seed, right)); const pairs: PairDefinition[] = []; for (let index = 0; index + 1 < shuffled.length; index += 1) pairs.push({ id: `PLACEBO-${shuffled[index].replace("USDT", "")}-${shuffled[index + 1].replace("USDT", "")}`, left: shuffled[index], right: shuffled[index + 1] }); return pairs; }
function seededValue(seed: number, value: string): number { let hash = seed; for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return hash; }

function normalizeCandle(candle: Candle): Candle { return { ...candle, openTime: normalizeTimestamp(candle.openTime), closeTime: normalizeTimestamp(candle.closeTime) }; }
function normalizeTimestamp(timestamp: number): number { return timestamp >= 10_000_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp; }
function dedupeCandles(candles: readonly Candle[]): Candle[] { const map = new Map<number, Candle>(); for (const candle of candles) if (!map.has(candle.openTime)) map.set(candle.openTime, candle); return [...map.values()].sort((left, right) => left.openTime - right.openTime); }
function dedupeFunding(points: readonly FundingRatePoint[]): FundingRatePoint[] { const map = new Map<number, FundingRatePoint>(); for (const point of points) if (!map.has(point.fundingTime)) map.set(point.fundingTime, point); return [...map.values()].sort((left, right) => left.fundingTime - right.fundingTime); }
function monthKeys(start: number, end: number): string[] { const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1)); const last = new Date(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1)); const output: string[] = []; while (cursor <= last) { output.push(monthKey(cursor.getTime())); cursor.setUTCMonth(cursor.getUTCMonth() + 1); } return output; }
function monthKey(timestamp: number): string { const date = new Date(timestamp); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function expectedBuckets(start: number, end: number, interval: number): number { return Math.floor((end - start) / interval) + 1; }
function median(values: readonly number[]): number { if (!values.length) return 0; const sorted = values.slice().sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function mean(values: readonly number[]): number { return values.length ? sum(values) / values.length : 0; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function hashObject(value: unknown): string { return sha256(Buffer.from(JSON.stringify(value))); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function relativePath(path: string): string { return path.replace(`${resolve(".")}\\`, "").replaceAll("\\", "/"); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
