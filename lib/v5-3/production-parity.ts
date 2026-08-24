import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTradePlan } from "@/lib/core/risk";
import { estimatedExecutionCostRiskFraction, isEntryIntervalAllowed } from "@/lib/core/execution-policy";
import {
  PRODUCTION_ENTRY_MODE,
  PRODUCTION_STRATEGY_VERSION,
} from "@/lib/core/production-policy";
import { DEFAULT_STRATEGY_PARAMS, generateCandidates, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketSnapshot, ScoredCandidate } from "@/lib/core/types";
import { rankCandidates } from "@/lib/core/scoring";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { BacktestOptions } from "@/lib/backtest/engine";
import type { ServerConfig } from "@/lib/config";
import { calculateMetrics, type ValidationMetrics, type ValidationTrade } from "@/lib/v5-2/validation";

export const PRODUCTION_ENTRY_MODEL = "just_closed_15m_reference";
const PAPER_TRADE_QUERY = [
  "id",
  "symbol",
  "side",
  "strategy_family",
  "strategy_version",
  "entry_time",
  "entry_price",
  "entry_fill_price",
  "stop_price",
  "take_profit_price",
  "max_hold_until",
  "quantity",
  "theoretical_risk_usdt",
  "exit_time",
  "exit_price",
  "exit_reason",
  "r_multiple",
  "net_pnl_usdt",
  "fees_usdt",
  "funding_usdt",
  "slippage_usdt",
  "metadata",
].join(",");

export interface ProductionControlConfig {
  source: "resolved_runtime_config";
  strategyVersion: string;
  entryMode: typeof PRODUCTION_ENTRY_MODE;
  params: StrategyParams;
  options: BacktestOptions;
  normalized: Record<string, unknown>;
}

export interface CanonicalTradeSet<T extends ValidationTrade> {
  rawTrades: T[];
  uniqueTrades: T[];
  rawTradeCount: number;
  uniqueTradeCount: number;
  duplicateTradeCount: number;
  duplicateKeys: string[];
}

export interface ProductionPaperTradeRow {
  id: string;
  symbol: string;
  side: string | null;
  strategyFamily: string | null;
  strategyVersion: string | null;
  entryTime: string | null;
  entryPrice: number | null;
  entryFillPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  maxHoldUntil: string | null;
  quantity: number | null;
  theoreticalRiskUsdt: number | null;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  rMultiple: number | null;
  netPnlUsdt: number | null;
  feesUsdt: number | null;
  fundingUsdt: number | null;
  slippageUsdt: number | null;
  metadata: Record<string, unknown>;
}

export type ReplayStatus = "MATCH" | "PARTIAL_MATCH" | "MISMATCH" | "DATA_UNAVAILABLE";

export interface ProductionReplayResult {
  id: string;
  symbol: string;
  sourceTimestamp: string | null;
  status: ReplayStatus;
  reasons: string[];
  dataUnavailable: string[];
  replay: {
    signalGenerated: boolean | null;
    candidateSide: string | null;
    candidateFamily: string | null;
    score: number | null;
    regime: string | null;
    admission: boolean | null;
    entryPrice: number | null;
    stopPrice: number | null;
    takeProfitPrice: number | null;
    maxHoldUntil: string | null;
    exitReason: string | null;
    exitTime: string | null;
    exitPrice: number | null;
    feesUsdt: number | null;
    fundingUsdt: number | null;
    netPnlUsdt: number | null;
    rMultiple: number | null;
  };
}

export interface ProductionParityReport {
  queryTimestamp: string;
  dataSource: "live_supabase_read" | "immutable_read_only_export";
  sourceTable: "public.bca_paper_trades";
  strategyVersion: string;
  extractionQuery: string;
  settledProspectiveTrades: number | null;
  rawRows: ProductionPaperTradeRow[];
  prospectiveMetrics: ValidationMetrics | null;
  replayResults: ProductionReplayResult[];
  exactMatches: number | null;
  partialMatches: number | null;
  mismatches: number | null;
  dataUnavailable: number | null;
  configParity: ConfigParityResult;
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  failureClassification: "MODEL_PARITY_FAILURE" | "PROSPECTIVE_DISTRIBUTION_SHIFT" | "INCONCLUSIVE";
  historicalControlReliable: boolean;
  queryError?: string;
}

export interface ConfigParityResult {
  status: "PASS" | "FAIL" | "INCOMPLETE";
  checked: string[];
  mismatches: string[];
  unavailable: string[];
}

export function loadLocalRuntimeEnv(root = process.cwd()): string[] {
  const path = resolve(root, ".env.local");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;
    const value = unquoteEnvValue(rawValue.trim());
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}

export function buildProductionControlConfig(config: ServerConfig): ProductionControlConfig {
  const sideFilter = config.CS_SIGNAL_SIDE_FILTER === "BOTH" ? undefined : config.CS_SIGNAL_SIDE_FILTER;
  const strategyFamilies = config.CS_SIGNAL_STRATEGY_FAMILY === "ALL"
    ? undefined
    : [config.CS_SIGNAL_STRATEGY_FAMILY as "TREND" | "BREAKOUT" | "MEAN_REVERSION"];
  const params: StrategyParams = {
    ...DEFAULT_STRATEGY_PARAMS,
    entryMode: PRODUCTION_ENTRY_MODE,
    stopAtrMultiplier: config.CS_STRATEGY_STOP_ATR_MULTIPLIER,
  };
  const options: BacktestOptions = {
    initialCapitalUsdt: config.CS_INITIAL_PAPER_CAPITAL_USDT,
    minScore: config.CS_MIN_SIGNAL_SCORE,
    maxHoldHours: config.CS_MAX_HOLD_HOURS,
    minimumSampleDays: 30,
    singleSignalRiskCapUsdt: config.CS_PER_SIGNAL_RISK_CAP_USDT,
    dailyRiskBudgetUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
    dailyLossLimitUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
    maxConcurrentPositions: config.CS_MAX_CONCURRENT_POSITIONS,
    maxEmailsPerDay: config.CS_NEW_EMAIL_DAILY_CAP,
    maxEmailsPerScan: config.CS_MAX_EMAILS_PER_SCAN,
    marginUsdt: config.CS_MARGIN_USDT,
    leverage: config.CS_ASSUMED_LEVERAGE,
    takerFeeRate: config.CS_PAPER_TAKER_FEE_RATE,
    slippageBps: config.CS_PAPER_SLIPPAGE_BPS,
    riskPerTradeUsdt: config.CS_RISK_PER_TRADE_USDT,
    maxPositionNotionalUsdt: config.CS_MAX_POSITION_NOTIONAL_USDT,
    rewardRisk: config.CS_REWARD_RISK,
    cooldownHours: config.CS_COOLDOWN_HOURS,
    maxExecutionCostRiskFraction: config.CS_MAX_EXECUTION_COST_RISK_FRACTION,
    entryIntervalHours: config.CS_ENTRY_INTERVAL_HOURS,
    requireRegimeAlignment: config.CS_REQUIRE_REGIME_ALIGNMENT,
    sideFilter,
    strategyFamilies,
  };
  return {
    source: "resolved_runtime_config",
    strategyVersion: PRODUCTION_STRATEGY_VERSION,
    entryMode: PRODUCTION_ENTRY_MODE,
    params,
    options,
    normalized: {
      strategyVersion: PRODUCTION_STRATEGY_VERSION,
      entryMode: PRODUCTION_ENTRY_MODE,
      scoreThreshold: config.CS_MIN_SIGNAL_SCORE,
      stopAtrMultiplier: config.CS_STRATEGY_STOP_ATR_MULTIPLIER,
      rewardRisk: config.CS_REWARD_RISK,
      sideFilter: config.CS_SIGNAL_SIDE_FILTER,
      strategyFamily: config.CS_SIGNAL_STRATEGY_FAMILY,
      regimeAlignment: config.CS_REQUIRE_REGIME_ALIGNMENT,
      cooldownHours: config.CS_COOLDOWN_HOURS,
      maxHoldHours: config.CS_MAX_HOLD_HOURS,
      entryIntervalHours: config.CS_ENTRY_INTERVAL_HOURS,
      maxConcurrentPositions: config.CS_MAX_CONCURRENT_POSITIONS,
      maxPositionNotionalUsdt: config.CS_MAX_POSITION_NOTIONAL_USDT,
      riskPerTradeUsdt: config.CS_RISK_PER_TRADE_USDT,
      perSignalRiskCapUsdt: config.CS_PER_SIGNAL_RISK_CAP_USDT,
      dailyRiskBudgetUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
      takerFeeRate: config.CS_PAPER_TAKER_FEE_RATE,
      slippageBps: config.CS_PAPER_SLIPPAGE_BPS,
      maxExecutionCostRiskFraction: config.CS_MAX_EXECUTION_COST_RISK_FRACTION,
      universeTopSymbols: config.CS_TOP_SYMBOLS,
      scanTimeframes: config.scanTimeframes,
      entryReference: PRODUCTION_ENTRY_MODEL,
      closedCandleHandling: "only just-closed 15m candle; source timestamp is candle closeTime",
    },
  };
}

export function compareControlConfigParity(
  actual: Record<string, unknown> | null,
  expected: Record<string, unknown>,
): ConfigParityResult {
  const checked = Object.keys(expected);
  if (!actual) {
    return { status: "INCOMPLETE", checked, mismatches: [], unavailable: ["resolved Production runtime config"] };
  }
  const mismatches = checked.filter((key) => actual[key] !== expected[key]).map((key) => `${key}: actual=${String(actual[key])}, expected=${String(expected[key])}`);
  return { status: mismatches.length > 0 ? "FAIL" : "PASS", checked, mismatches, unavailable: [] };
}

export function canonicalTradeKey(trade: ValidationTrade & { candidateId?: string }, candidateKey?: string): string {
  const candidate = candidateKey ?? trade.candidateId ?? "UNKNOWN_CANDIDATE";
  return [
    candidate,
    trade.symbol,
    trade.side ?? "UNKNOWN_SIDE",
    String(trade.entryTime),
    String(trade.exitTime ?? "OPEN"),
  ].join("|");
}

export function deduplicateCanonicalTrades<T extends ValidationTrade & { candidateId?: string }>(
  trades: T[],
  candidateKey?: string,
): CanonicalTradeSet<T> {
  const seen = new Set<string>();
  const uniqueTrades: T[] = [];
  const duplicateKeys: string[] = [];
  for (const trade of trades) {
    const key = canonicalTradeKey(trade, candidateKey);
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    uniqueTrades.push(trade);
  }
  return {
    rawTrades: trades,
    uniqueTrades,
    rawTradeCount: trades.length,
    uniqueTradeCount: uniqueTrades.length,
    duplicateTradeCount: trades.length - uniqueTrades.length,
    duplicateKeys,
  };
}

export async function fetchSettledProductionPaperTrades(
  supabase: SupabaseClient,
): Promise<ProductionPaperTradeRow[]> {
  const rows: ProductionPaperTradeRow[] = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("bca_paper_trades")
      .select(PAPER_TRADE_QUERY)
      .eq("strategy_version", PRODUCTION_STRATEGY_VERSION)
      .not("exit_time", "is", null)
      .order("entry_time", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Production paper trade query failed: ${error.message}`);
    const page = (data ?? []).map((row) => parsePaperTradeRow(row as unknown as Record<string, unknown>));
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function readProductionPaperTradeExport(
  root = process.cwd(),
): Promise<{ capturedAt: string | null; rows: ProductionPaperTradeRow[] } | null> {
  const path = resolve(root, "data/production-parity/settled-paper-trades.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { capturedAt?: unknown; rows?: unknown[] };
    const rows = Array.isArray(parsed.rows)
      ? parsed.rows.filter(isRecord).map((row) => parsePaperTradeRow(row))
      : [];
    return { capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : null, rows };
  } catch {
    return null;
  }
}

export function replayProductionPaperTrade(
  row: ProductionPaperTradeRow,
  dataset: HistoricalDataset | null,
  config: ProductionControlConfig | null,
): ProductionReplayResult {
  const sourceTimestamp = parseSourceTimestamp(row);
  const base = {
    id: row.id,
    symbol: row.symbol,
    sourceTimestamp: sourceTimestamp === null ? null : new Date(sourceTimestamp).toISOString(),
    replay: emptyReplay(),
  };
  if (!dataset || !config || sourceTimestamp === null) {
    return {
      ...base,
      status: "DATA_UNAVAILABLE",
      reasons: [],
      dataUnavailable: [
        ...(!dataset ? ["historical cache for symbol/timestamp"] : []),
        ...(!config ? ["resolved Production runtime config"] : []),
        ...(sourceTimestamp === null ? ["metadata.source_data_timestamp or entry_time"] : []),
      ],
    };
  }
  const snapshot = snapshotAt(dataset, sourceTimestamp);
  if (!snapshot) {
    return {
      ...base,
      status: "DATA_UNAVAILABLE",
      reasons: [],
      dataUnavailable: ["exact source timestamp candle in immutable cache"],
    };
  }
  const candidates = rankCandidates(generateCandidates(snapshot.snapshot, config.params), {
    minimumScore: config.options.minScore,
    sideFilter: config.options.sideFilter,
    strategyFamily: config.options.strategyFamilies?.length === 1 ? config.options.strategyFamilies[0] : undefined,
  });
  const candidate = candidates.find((item) => isRegimeAllowed(item, config.options.requireRegimeAlignment)
    && isEntryIntervalAllowed(sourceTimestamp, config.options.entryIntervalHours ?? 0));
  const replay = base.replay;
  replay.signalGenerated = candidate !== undefined;
  replay.candidateSide = candidate?.side ?? null;
  replay.candidateFamily = candidate?.strategyFamily ?? null;
  replay.score = candidate?.score ?? null;
  replay.regime = candidate?.marketRegime ?? null;
  const reasons: string[] = [];
  const dataUnavailable: string[] = [
    "Production paper row does not persist the admitted candidate score",
    "Production paper row does not persist the admitted market regime",
    "global claimSignal cooldown/cap context is not reconstructable from a single paper row",
  ];
  if (!candidate) {
    reasons.push("No current Production candidate passed signal, score, side, family, regime, and entry-timing admission at the exact timestamp.");
    return { ...base, status: "MISMATCH", reasons, dataUnavailable, replay };
  }
  let plan;
  try {
    plan = buildTradePlan(candidate, dataset.instrument, {
      marginUsdt: config.options.marginUsdt ?? 100,
      leverage: config.options.leverage ?? 20,
      singleSignalRiskCapUsdt: config.options.singleSignalRiskCapUsdt ?? 100,
      dailyRiskBudgetUsdt: config.options.dailyRiskBudgetUsdt ?? 600,
      maxHoldHours: config.options.maxHoldHours ?? 72,
      rewardRisk: config.options.rewardRisk,
      riskPerTradeUsdt: config.options.riskPerTradeUsdt,
      maxPositionNotionalUsdt: config.options.maxPositionNotionalUsdt,
    }, sourceTimestamp);
  } catch (error) {
    reasons.push(`Production risk-plan replay failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ...base, status: "MISMATCH", reasons, dataUnavailable, replay };
  }
  replay.admission = !plan.riskOverSingleCap
    && estimatedExecutionCostRiskFraction(plan, config.options.takerFeeRate ?? 0.0004, config.options.slippageBps ?? 2)
      <= (config.options.maxExecutionCostRiskFraction ?? Number.POSITIVE_INFINITY);
  replay.entryPrice = plan.entryPrice;
  replay.stopPrice = plan.stopPrice;
  replay.takeProfitPrice = plan.takeProfitPrice;
  replay.maxHoldUntil = new Date(plan.validUntil).toISOString();
  if (!replay.admission) reasons.push("Replayed risk/cost admission rejected the stored Production paper trade.");
  compareRequiredText(row.strategyVersion, config.strategyVersion, "strategy_version", reasons, dataUnavailable);
  compareRequiredText(row.side, candidate.side, "side", reasons, dataUnavailable);
  compareRequiredText(row.strategyFamily, candidate.strategyFamily, "strategy_family", reasons, dataUnavailable);
  compareNumber(row.entryPrice, plan.entryPrice, "entry_price", reasons, dataUnavailable);
  compareNumber(row.entryFillPrice, adverseFill(plan.entryPrice, candidate.side === "LONG" ? 1 : -1, (config.options.slippageBps ?? 2) / 10_000, "entry"), "entry_fill_price", reasons, dataUnavailable);
  compareNumber(row.stopPrice, plan.stopPrice, "stop_price", reasons, dataUnavailable);
  compareNumber(row.takeProfitPrice, plan.takeProfitPrice, "take_profit_price", reasons, dataUnavailable);
  compareRequiredText(row.maxHoldUntil, new Date(plan.validUntil).toISOString(), "max_hold_until", reasons, dataUnavailable, true);
  compareNumber(row.quantity, plan.quantity, "quantity", reasons, dataUnavailable);
  compareNumber(row.theoreticalRiskUsdt, plan.theoreticalRiskUsdt, "theoretical_risk_usdt", reasons, dataUnavailable);
  const entryModel = typeof row.metadata.entry_model === "string" ? row.metadata.entry_model : null;
  compareRequiredText(entryModel, PRODUCTION_ENTRY_MODEL, "metadata.entry_model", reasons, dataUnavailable);
  const settlement = replaySettlement(dataset, snapshot.index, plan, candidate.side, config);
  if (!settlement) {
    dataUnavailable.push("settlement path after exact entry timestamp in immutable cache");
  } else {
    replay.exitReason = settlement.exitReason;
    replay.exitTime = new Date(settlement.exitTime).toISOString();
    replay.exitPrice = settlement.exitPrice;
    replay.feesUsdt = settlement.feesUsdt;
    replay.fundingUsdt = settlement.fundingUsdt;
    replay.netPnlUsdt = settlement.netPnlUsdt;
    replay.rMultiple = plan.theoreticalRiskUsdt === 0 ? 0 : settlement.netPnlUsdt / plan.theoreticalRiskUsdt;
    compareRequiredText(row.exitReason, settlement.exitReason, "exit_reason", reasons, dataUnavailable);
    compareRequiredText(row.exitTime, new Date(settlement.exitTime).toISOString(), "exit_time", reasons, dataUnavailable, true);
    compareNumber(row.exitPrice, settlement.exitPrice, "exit_price", reasons, dataUnavailable);
    compareNumber(row.feesUsdt, settlement.feesUsdt, "fees_usdt", reasons, dataUnavailable);
    compareNumber(row.fundingUsdt, settlement.fundingUsdt, "funding_usdt", reasons, dataUnavailable);
    compareNumber(row.netPnlUsdt, settlement.netPnlUsdt, "net_pnl_usdt", reasons, dataUnavailable);
    compareNumber(row.rMultiple, replay.rMultiple, "r_multiple", reasons, dataUnavailable);
  }
  const status: ReplayStatus = reasons.length > 0
    ? "MISMATCH"
    : dataUnavailable.length > 0
      ? "PARTIAL_MATCH"
      : "MATCH";
  return { ...base, status, reasons, dataUnavailable, replay };
}

export function buildProspectiveMetrics(rows: ProductionPaperTradeRow[]): ValidationMetrics | null {
  const trades: ValidationTrade[] = rows
    .filter((row) => row.entryTime !== null && row.rMultiple !== null)
    .map((row) => ({
      symbol: row.symbol,
      side: row.side === "LONG" || row.side === "SHORT" ? row.side : undefined,
      entryTime: Date.parse(row.entryTime as string),
      exitTime: row.exitTime ? Date.parse(row.exitTime) : undefined,
      rMultiple: row.rMultiple as number,
      netPnlUsdt: row.netPnlUsdt ?? undefined,
      pnlUsdt: row.netPnlUsdt ?? undefined,
      theoreticalRiskUsdt: row.theoreticalRiskUsdt ?? undefined,
      feesUsdt: row.feesUsdt ?? undefined,
      fundingUsdt: row.fundingUsdt ?? undefined,
      slippageUsdt: row.slippageUsdt ?? undefined,
    }));
  return trades.length > 0 ? calculateMetrics(trades) : null;
}

export function createUnavailableParityReport(
  error: unknown,
  configParity: ConfigParityResult,
): ProductionParityReport {
  return {
    queryTimestamp: new Date().toISOString(),
    dataSource: "live_supabase_read",
    sourceTable: "public.bca_paper_trades",
    strategyVersion: PRODUCTION_STRATEGY_VERSION,
    extractionQuery: `SELECT ${PAPER_TRADE_QUERY} FROM public.bca_paper_trades WHERE strategy_version = '${PRODUCTION_STRATEGY_VERSION}' AND exit_time IS NOT NULL ORDER BY entry_time ASC`,
    settledProspectiveTrades: null,
    rawRows: [],
    prospectiveMetrics: null,
    replayResults: [],
    exactMatches: null,
    partialMatches: null,
    mismatches: null,
    dataUnavailable: null,
    configParity,
    verdict: "INCOMPLETE",
    failureClassification: "INCONCLUSIVE",
    historicalControlReliable: false,
    queryError: error instanceof Error ? error.message : String(error),
  };
}

export function finalizeParityReport(
  rows: ProductionPaperTradeRow[],
  replayResults: ProductionReplayResult[],
  configParity: ConfigParityResult,
  historicalControl: ValidationMetrics | null,
  dataSource: ProductionParityReport["dataSource"] = "live_supabase_read",
  queryError?: string,
): ProductionParityReport {
  const exactMatches = replayResults.filter((result) => result.status === "MATCH").length;
  const partialMatches = replayResults.filter((result) => result.status === "PARTIAL_MATCH").length;
  const mismatches = replayResults.filter((result) => result.status === "MISMATCH").length;
  const dataUnavailable = replayResults.filter((result) => result.status === "DATA_UNAVAILABLE").length;
  const verdict = configParity.status === "FAIL" || mismatches > 0
    ? "FAIL"
    : configParity.status !== "PASS" || rows.length === 0 || partialMatches > 0 || dataUnavailable > 0
      ? "INCOMPLETE"
      : "PASS";
  const prospectiveMetrics = buildProspectiveMetrics(rows);
  const failureClassification = verdict === "FAIL"
    ? "MODEL_PARITY_FAILURE"
    : verdict === "PASS"
      && prospectiveMetrics
      && historicalControl
      && prospectiveMetrics.avgNetR < 0
      && historicalControl.avgNetR > 0
      ? "PROSPECTIVE_DISTRIBUTION_SHIFT"
      : "INCONCLUSIVE";
  return {
    queryTimestamp: new Date().toISOString(),
    dataSource,
    sourceTable: "public.bca_paper_trades",
    strategyVersion: PRODUCTION_STRATEGY_VERSION,
    extractionQuery: `SELECT ${PAPER_TRADE_QUERY} FROM public.bca_paper_trades WHERE strategy_version = '${PRODUCTION_STRATEGY_VERSION}' AND exit_time IS NOT NULL ORDER BY entry_time ASC`,
    settledProspectiveTrades: rows.length,
    rawRows: rows,
    prospectiveMetrics,
    replayResults,
    exactMatches,
    partialMatches,
    mismatches,
    dataUnavailable,
    configParity,
    verdict,
    failureClassification,
    historicalControlReliable: verdict === "PASS",
    queryError,
  };
}

function parsePaperTradeRow(row: Record<string, unknown>): ProductionPaperTradeRow {
  return {
    id: stringOrNull(row.id) ?? "UNKNOWN_ROW",
    symbol: stringOrNull(row.symbol) ?? "UNKNOWN_SYMBOL",
    side: stringOrNull(row.side),
    strategyFamily: stringOrNull(row.strategy_family),
    strategyVersion: stringOrNull(row.strategy_version),
    entryTime: stringOrNull(row.entry_time),
    entryPrice: numberOrNull(row.entry_price),
    entryFillPrice: numberOrNull(row.entry_fill_price),
    stopPrice: numberOrNull(row.stop_price),
    takeProfitPrice: numberOrNull(row.take_profit_price),
    maxHoldUntil: stringOrNull(row.max_hold_until),
    quantity: numberOrNull(row.quantity),
    theoreticalRiskUsdt: numberOrNull(row.theoretical_risk_usdt),
    exitTime: stringOrNull(row.exit_time),
    exitPrice: numberOrNull(row.exit_price),
    exitReason: stringOrNull(row.exit_reason),
    rMultiple: numberOrNull(row.r_multiple),
    netPnlUsdt: numberOrNull(row.net_pnl_usdt),
    feesUsdt: numberOrNull(row.fees_usdt),
    fundingUsdt: numberOrNull(row.funding_usdt),
    slippageUsdt: numberOrNull(row.slippage_usdt),
    metadata: isRecord(row.metadata) ? row.metadata : {},
  };
}

function parseSourceTimestamp(row: ProductionPaperTradeRow): number | null {
  const metadataTimestamp = typeof row.metadata.source_data_timestamp === "string"
    ? Date.parse(row.metadata.source_data_timestamp)
    : Number.NaN;
  if (Number.isFinite(metadataTimestamp)) return metadataTimestamp;
  const entryTimestamp = row.entryTime ? Date.parse(row.entryTime) : Number.NaN;
  return Number.isFinite(entryTimestamp) ? entryTimestamp : null;
}

function snapshotAt(dataset: HistoricalDataset, timestamp: number): { snapshot: MarketSnapshot; index: number } | null {
  const primary = dataset.candles["15m"];
  const index = primary.findIndex((candle) => candle.closeTime === timestamp);
  if (index < 0) return null;
  const asOf = (candles: Candle[] | undefined): Candle[] => {
    if (!candles) return [];
    const end = candles.findIndex((candle) => candle.closeTime > timestamp);
    return candles.slice(Math.max(0, (end < 0 ? candles.length : end) - 250), end < 0 ? candles.length : end);
  };
  return {
    index,
    snapshot: {
      instrument: dataset.instrument,
      tickerPrice: primary[index].close,
      candles: {
        "15m": asOf(primary),
        "1h": asOf(dataset.candles["1h"]),
        "4h": asOf(dataset.candles["4h"]),
      },
      sourceTimestamp: timestamp,
    },
  };
}

function isRegimeAllowed(candidate: ScoredCandidate, required: boolean | undefined): boolean {
  if (!required) return true;
  if (candidate.strategyFamily === "MEAN_REVERSION") return candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN";
  return candidate.side === "LONG" ? candidate.marketRegime === "BULL" : candidate.marketRegime === "BEAR";
}

interface ReplaySettlement {
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_LIMIT";
  exitTime: number;
  exitPrice: number;
  feesUsdt: number;
  fundingUsdt: number;
  netPnlUsdt: number;
}

function replaySettlement(
  dataset: HistoricalDataset,
  entryIndex: number,
  plan: ReturnType<typeof buildTradePlan>,
  side: "LONG" | "SHORT",
  config: ProductionControlConfig,
): ReplaySettlement | null {
  const candles = dataset.candles["15m"];
  const entry = candles[entryIndex];
  if (!entry) return null;
  const deadline = plan.validUntil;
  let exit: Candle | null = null;
  let rawExitPrice = 0;
  let exitReason: ReplaySettlement["exitReason"] | null = null;
  for (let index = entryIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > deadline) break;
    const stopHit = side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const targetHit = side === "LONG" ? candle.high >= plan.takeProfitPrice : candle.low <= plan.takeProfitPrice;
    if (stopHit) {
      exit = candle;
      rawExitPrice = plan.stopPrice;
      exitReason = "STOP_LOSS";
      break;
    }
    if (targetHit) {
      exit = candle;
      rawExitPrice = plan.takeProfitPrice;
      exitReason = "TAKE_PROFIT";
      break;
    }
    if (candle.closeTime >= deadline) {
      exit = candle;
      rawExitPrice = candle.close;
      exitReason = "TIME_LIMIT";
      break;
    }
  }
  if (!exit || !exitReason) return null;
  const direction = side === "LONG" ? 1 : -1;
  const entryFillPrice = adverseFill(plan.entryPrice, direction, (config.options.slippageBps ?? 2) / 10_000, "entry");
  const exitFillPrice = adverseFill(rawExitPrice, direction, (config.options.slippageBps ?? 2) / 10_000, "exit");
  const grossPnlUsdt = (exitFillPrice - entryFillPrice) * direction * plan.quantity;
  const feesUsdt = (Math.abs(entryFillPrice * plan.quantity) + Math.abs(exitFillPrice * plan.quantity)) * (config.options.takerFeeRate ?? 0.0004);
  const fundingUsdt = calculateFunding(dataset, entry.closeTime, exit.closeTime, entryFillPrice * plan.quantity, direction);
  return {
    exitReason,
    exitTime: exit.closeTime,
    exitPrice: exitFillPrice,
    feesUsdt,
    fundingUsdt,
    netPnlUsdt: grossPnlUsdt - feesUsdt + fundingUsdt,
  };
}

function calculateFunding(dataset: HistoricalDataset, entryTime: number, exitTime: number, notional: number, direction: number): number {
  return (dataset.fundingRates ?? [])
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
}

function adverseFill(price: number, direction: number, slippageRate: number, phase: "entry" | "exit"): number {
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageRate);
}

function compareNumber(actual: number | null, expected: number, field: string, mismatches: string[], unavailable: string[]): void {
  if (actual === null || !Number.isFinite(actual)) {
    unavailable.push(`${field} missing from Production row`);
    return;
  }
  const tolerance = Math.max(1e-8, Math.abs(expected) * 1e-7);
  if (Math.abs(actual - expected) > tolerance) mismatches.push(`${field}: actual=${actual}, replay=${expected}`);
}

function compareRequiredText(
  actual: string | null,
  expected: string,
  field: string,
  mismatches: string[],
  unavailable: string[],
  timestamp = false,
): void {
  if (!actual) {
    unavailable.push(`${field} missing from Production row`);
    return;
  }
  if (timestamp) {
    const actualTime = Date.parse(actual);
    const expectedTime = Date.parse(expected);
    if (!Number.isFinite(actualTime) || actualTime !== expectedTime) mismatches.push(`${field}: actual=${actual}, replay=${expected}`);
    return;
  }
  if (actual !== expected) mismatches.push(`${field}: actual=${actual}, replay=${expected}`);
}

function emptyReplay(): ProductionReplayResult["replay"] {
  return {
    signalGenerated: null,
    candidateSide: null,
    candidateFamily: null,
    score: null,
    regime: null,
    admission: null,
    entryPrice: null,
    stopPrice: null,
    takeProfitPrice: null,
    maxHoldUntil: null,
    exitReason: null,
    exitTime: null,
    exitPrice: null,
    feesUsdt: null,
    fundingUsdt: null,
    netPnlUsdt: null,
    rMultiple: null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
