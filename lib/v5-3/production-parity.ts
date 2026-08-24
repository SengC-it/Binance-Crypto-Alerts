import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateProductionSignal, type ProductionSignalEvaluation, type ProductionSignalPolicy } from "@/lib/core/production-signal";
import {
  PRODUCTION_ENTRY_MODE,
  PRODUCTION_STRATEGY_VERSION,
} from "@/lib/core/production-policy";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import { atr, closes, ema, latest, rsi, volumeRatio } from "@/lib/core/indicators";
import type { Candle, MarketSnapshot, ScoreComponents, Timeframe, TradePlan } from "@/lib/core/types";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { BacktestOptions } from "@/lib/backtest/engine";
import type { ServerConfig } from "@/lib/config";
import { calculateMetrics, type ValidationMetrics, type ValidationTrade } from "@/lib/v5-2/validation";

export const PRODUCTION_ENTRY_MODEL = "just_closed_15m_reference";
const PAPER_TRADE_QUERY = [
  "id",
  "signal_id",
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

const SIGNAL_QUERY = [
  "id",
  "source_data_timestamp",
  "score",
  "score_components",
  "market_regime",
  "side",
  "strategy_family",
  "primary_timeframe",
  "confirmation_timeframes",
  "regime_dependency",
  "entry_price",
  "stop_price",
  "take_profit_price",
  "valid_until",
].join(",");

const EXTRACTION_QUERY = `SELECT p.${PAPER_TRADE_QUERY.replaceAll(",", ", p.")}, s.${SIGNAL_QUERY.replaceAll(",", ", s.")} FROM public.bca_paper_trades p LEFT JOIN public.bca_signals s ON s.id = p.signal_id WHERE p.strategy_version = '${PRODUCTION_STRATEGY_VERSION}' AND p.exit_time IS NOT NULL ORDER BY p.entry_time ASC`;

const CONFIG_ALLOWLIST = [
  "strategyVersion",
  "entryMode",
  "scoreThreshold",
  "stopAtrMultiplier",
  "rewardRisk",
  "sideFilter",
  "strategyFamily",
  "regimeAlignment",
  "cooldownHours",
  "maxHoldHours",
  "entryIntervalHours",
  "maxConcurrentPositions",
  "maxPositionNotionalUsdt",
  "riskPerTradeUsdt",
  "perSignalRiskCapUsdt",
  "dailyRiskBudgetUsdt",
  "takerFeeRate",
  "slippageBps",
  "maxExecutionCostRiskFraction",
  "universeTopSymbols",
  "scanTimeframes",
  "entryReference",
  "closedCandleHandling",
] as const;

export type ConfigAllowlistKey = typeof CONFIG_ALLOWLIST[number];

export interface ImmutableExportProvenance {
  capturedAt: string;
  rowCount: number;
  sha256: string;
  hashScope: "canonical_json_rows";
  sourceTable: string;
  query: string;
  relatedSourceTable?: string;
  verified: boolean;
}

export interface ProductionControlConfig {
  source: "resolved_runtime_config";
  strategyVersion: string;
  entryMode: typeof PRODUCTION_ENTRY_MODE;
  params: StrategyParams;
  options: BacktestOptions;
  signalPolicy: ProductionSignalPolicy;
  replayExpectedConfig: Record<ConfigAllowlistKey, unknown>;
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
  signalId: string | null;
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
  signalTelemetry: ProductionSignalTelemetry | null;
}

export interface ProductionSignalTelemetry {
  signalId: string;
  sourceDataTimestamp: string | null;
  score: number | null;
  scoreComponents: ScoreComponents | null;
  marketRegime: string | null;
  side: string | null;
  strategyFamily: string | null;
  primaryTimeframe: string | null;
  confirmationTimeframes: string[];
  regimeDependency: string | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  validUntil: string | null;
  inputProvenance?: PersistedProductionInputProvenance | null;
}

export type ReplayStatus = "MATCH" | "PARTIAL_MATCH" | "QUANTIZATION_EXPLAINED" | "INPUT_DATA_UNAVAILABLE" | "MATERIAL_MISMATCH";
export type QuantizationVerdict = "QUANTIZATION_EXPLAINED" | "MATERIAL_MISMATCH" | "INPUT_DATA_UNAVAILABLE";

export interface CandleCounts {
  "15m": number | null;
  "1h": number | null;
  "4h": number | null;
}

export interface PersistedProductionInputProvenance {
  quoteVolume24h: number | null;
  candleCounts: CandleCounts | null;
  rawCandlesAvailable: boolean;
  source: string;
}

export interface ReplayInputProvenance {
  productionLiquidity: number | null;
  replayLiquidity: number | null;
  pointInTimeLiquidityAvailable: boolean;
  source: string;
  productionCandleCounts: CandleCounts | null;
  replayCandleCounts: CandleCounts;
  pointInTimeCandleCountsAvailable: boolean;
  dataQualityComparison: "PASS" | "DATA_UNAVAILABLE";
  rawCandlesAvailable: boolean;
}

export type DivergenceStage =
  | "raw_candles"
  | "indicators"
  | "strategy_trigger"
  | "score"
  | "score_components"
  | "rank_candidates"
  | "regime"
  | "entry_interval"
  | "side_family_filter"
  | "risk_admission"
  | "settlement"
  | "data_unavailable";

export interface DivergenceValue {
  productionEquivalentValue: unknown;
  replayValue: unknown;
}

export interface ProductionReplayResult {
  id: string;
  symbol: string;
  sourceTimestamp: string | null;
  status: ReplayStatus;
  quantizationVerdict: QuantizationVerdict;
  reasons: string[];
  dataUnavailable: string[];
  firstDivergenceStage: DivergenceStage | null;
  divergence: DivergenceValue | null;
  inputProvenance: ReplayInputProvenance;
  trace: {
    rawCandles: Record<string, unknown>;
    indicators: Record<string, unknown>;
    rawStrategyTrigger: DivergenceValue;
    score: DivergenceValue;
    strategyTrigger: DivergenceValue;
    scoreComponents: DivergenceValue;
    rankCandidates: DivergenceValue;
    regime: DivergenceValue;
    entryInterval: DivergenceValue;
    sideFamilyFilter: DivergenceValue;
    riskAdmission: DivergenceValue;
  };
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
  exportProvenance: ImmutableExportProvenance | null;
  settledProspectiveTrades: number | null;
  rawRows: ProductionPaperTradeRow[];
  prospectiveMetrics: ValidationMetrics | null;
  replayResults: ProductionReplayResult[];
  exactMatches: number | null;
  partialMatches: number | null;
  quantizationExplained: number | null;
  inputDataUnavailable: number | null;
  materialMismatches: number | null;
  configParity: ConfigParityResult;
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  failureClassification: "MODEL_PARITY_FAILURE" | "PROSPECTIVE_DISTRIBUTION_SHIFT" | "INCONCLUSIVE";
  historicalControlReliable: boolean;
  queryError?: string;
}

export interface ConfigParityResult {
  source: "production_runtime_environment" | "unavailable";
  expectedSource: "replay_runtime_config";
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
  const signalPolicy: ProductionSignalPolicy = {
    strategyParams: params,
    minimumScore: config.CS_MIN_SIGNAL_SCORE,
    sideFilter: sideFilter as "LONG" | "SHORT" | undefined,
    strategyFamily: strategyFamilies?.[0],
    requireRegimeAlignment: config.CS_REQUIRE_REGIME_ALIGNMENT,
    entryIntervalHours: config.CS_ENTRY_INTERVAL_HOURS,
    marginUsdt: config.CS_MARGIN_USDT,
    leverage: config.CS_ASSUMED_LEVERAGE,
    singleSignalRiskCapUsdt: config.CS_PER_SIGNAL_RISK_CAP_USDT,
    dailyRiskBudgetUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
    maxHoldHours: config.CS_MAX_HOLD_HOURS,
    rewardRisk: config.CS_REWARD_RISK,
    riskPerTradeUsdt: config.CS_RISK_PER_TRADE_USDT,
    maxPositionNotionalUsdt: config.CS_MAX_POSITION_NOTIONAL_USDT,
    takerFeeRate: config.CS_PAPER_TAKER_FEE_RATE,
    slippageBps: config.CS_PAPER_SLIPPAGE_BPS,
    maxExecutionCostRiskFraction: config.CS_MAX_EXECUTION_COST_RISK_FRACTION,
  };
  const replayExpectedConfig = {
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
  } satisfies Record<ConfigAllowlistKey, unknown>;
  return {
    source: "resolved_runtime_config",
    strategyVersion: PRODUCTION_STRATEGY_VERSION,
    entryMode: PRODUCTION_ENTRY_MODE,
    params,
    options,
    signalPolicy,
    replayExpectedConfig,
  };
}

export function compareControlConfigParity(
  actual: Record<string, unknown> | null,
  expected: Record<string, unknown> | null,
  source: ConfigParityResult["source"] = actual ? "production_runtime_environment" : "unavailable",
): ConfigParityResult {
  const checked = expected ? Object.keys(expected) : [...CONFIG_ALLOWLIST];
  if (actual && expected && actual === expected) {
    return {
      source,
      expectedSource: "replay_runtime_config",
      status: "INCOMPLETE",
      checked,
      mismatches: [],
      unavailable: ["actual Production config and replay expected config must be independent sources"],
    };
  }
  if (!actual || !expected) {
    return {
      source,
      expectedSource: "replay_runtime_config",
      status: "INCOMPLETE",
      checked,
      mismatches: [],
      unavailable: [!actual ? "actual Production runtime config" : "replay expected config"],
    };
  }
  const unavailable = checked.filter((key) => actual[key] === undefined || actual[key] === null);
  const mismatches = checked
    .filter((key) => !unavailable.includes(key) && canonicalJson(actual[key]) !== canonicalJson(expected[key]))
    .map((key) => `${key}: actual=${String(actual[key])}, expected=${String(expected[key])}`);
  return {
    source,
    expectedSource: "replay_runtime_config",
    status: mismatches.length > 0 ? "FAIL" : unavailable.length > 0 ? "INCOMPLETE" : "PASS",
    checked,
    mismatches,
    unavailable,
  };
}

export function readActualProductionRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): { source: ConfigParityResult["source"]; config: Record<string, unknown> | null; unavailable: string[] } {
  const raw = env.PRODUCTION_RUNTIME_CONFIG_ALLOWLIST_JSON;
  if (!raw) {
    return {
      source: "unavailable",
      config: null,
      unavailable: ["PRODUCTION_RUNTIME_CONFIG_ALLOWLIST_JSON was not independently provided by Production"],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { source: "unavailable", config: null, unavailable: ["Production runtime config allowlist is not valid JSON"] };
  }
  if (!isRecord(parsed)) {
    return { source: "unavailable", config: null, unavailable: ["Production runtime config allowlist is not an object"] };
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => !CONFIG_ALLOWLIST.includes(key as ConfigAllowlistKey))) {
    return { source: "unavailable", config: null, unavailable: ["Production runtime config contains a non-allowlisted field"] };
  }
  return { source: "production_runtime_environment", config: parsed, unavailable: [] };
}

export function serializeAllowlistedConfig(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) return null;
  return Object.fromEntries(CONFIG_ALLOWLIST.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
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
  const signalIds = [...new Set(rows.map((row) => row.signalId).filter((value): value is string => Boolean(value)))];
  if (signalIds.length === 0) return rows;
  const { data: signalRows, error: signalError } = await supabase
    .from("bca_signals")
    .select(SIGNAL_QUERY)
    .in("id", signalIds);
  if (signalError) throw new Error(`Production signal telemetry query failed: ${signalError.message}`);
  const signals = new Map((signalRows ?? []).map((row) => {
    const record = row as unknown as Record<string, unknown>;
    return [String(record.id), parseSignalTelemetry(record)] as const;
  }));
  return rows.map((row) => ({ ...row, signalTelemetry: row.signalId ? signals.get(row.signalId) ?? null : null }));
}

export async function readProductionPaperTradeExport(
  root = process.cwd(),
): Promise<{ provenance: ImmutableExportProvenance; rows: ProductionPaperTradeRow[] } | null> {
  const path = resolve(root, "data/production-parity/settled-paper-trades.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      provenance?: unknown;
      rows?: unknown[];
    };
    const rawRows = Array.isArray(parsed.rows) ? parsed.rows.filter(isRecord) : [];
    const rows = rawRows.map((row) => parsePaperTradeRow(row));
    if (!isRecord(parsed.provenance)) return null;
    const provenance = parseExportProvenance(parsed.provenance, rawRows);
    if (!provenance || !provenance.verified) return null;
    return { provenance, rows };
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
    quantizationVerdict: "INPUT_DATA_UNAVAILABLE" as QuantizationVerdict,
  };
  const unavailableInputProvenance = buildReplayInputProvenance(row.signalTelemetry, null);
  if (!dataset || !config || sourceTimestamp === null) {
    return {
      ...base,
      status: "INPUT_DATA_UNAVAILABLE",
      reasons: [],
      dataUnavailable: [
        ...(!dataset ? ["historical cache for symbol/timestamp"] : []),
        ...(!config ? ["resolved Production runtime config"] : []),
        ...(sourceTimestamp === null ? ["metadata.source_data_timestamp or entry_time"] : []),
      ],
      firstDivergenceStage: "data_unavailable",
      divergence: { productionEquivalentValue: row.signalTelemetry ?? "DATA_UNAVAILABLE", replayValue: "DATA_UNAVAILABLE" },
      inputProvenance: unavailableInputProvenance,
      trace: emptyTrace(),
    };
  }
  const snapshot = snapshotAt(dataset, sourceTimestamp);
  if (!snapshot) {
    return {
      ...base,
      status: "INPUT_DATA_UNAVAILABLE",
      reasons: [],
      dataUnavailable: ["exact source timestamp candle in immutable cache"],
      firstDivergenceStage: "data_unavailable",
      divergence: { productionEquivalentValue: row.signalTelemetry ?? "DATA_UNAVAILABLE", replayValue: "DATA_UNAVAILABLE" },
      inputProvenance: unavailableInputProvenance,
      trace: emptyTrace(),
    };
  }
  const inputProvenance = buildReplayInputProvenance(row.signalTelemetry, snapshot.snapshot);
  const replayQuoteVolume = row.signalTelemetry?.inputProvenance?.quoteVolume24h ?? undefined;
  const replaySnapshot: MarketSnapshot = {
    ...snapshot.snapshot,
    instrument: {
      ...snapshot.snapshot.instrument,
      quoteVolume24h: replayQuoteVolume,
    },
  };
  const evaluation = evaluateProductionSignal(replaySnapshot, config.signalPolicy);
  const candidate = selectReplayCandidate(evaluation, row.signalTelemetry);
  inputProvenance.replayLiquidity = inputProvenance.pointInTimeLiquidityAvailable
    ? candidate?.scoreComponents.liquidity ?? null
    : null;
  const trace = buildReplayTrace(replaySnapshot, evaluation, row.signalTelemetry, inputProvenance);
  const replay = base.replay;
  replay.signalGenerated = evaluation.status === "ADMITTED";
  replay.candidateSide = candidate?.side ?? null;
  replay.candidateFamily = candidate?.strategyFamily ?? null;
  replay.score = candidate?.score ?? null;
  replay.regime = candidate?.marketRegime ?? null;
  const comparisonReasons: string[] = [];
  const dataUnavailable: string[] = [
    "global claimSignal cooldown/cap context is not reconstructable from a single paper row",
    ...(!inputProvenance.rawCandlesAvailable ? ["Production raw candles and indicator snapshots were not persisted with the admitted signal"] : []),
    ...(!inputProvenance.pointInTimeLiquidityAvailable ? ["point-in-time quoteVolume24h was not persisted with the admitted signal"] : []),
    ...(inputProvenance.dataQualityComparison === "DATA_UNAVAILABLE" ? ["Production 15m/1h/4h snapshot candle counts were not persisted or could not be matched"] : []),
  ];
  if (!row.signalTelemetry) dataUnavailable.push("bca_signals telemetry for the admitted Production signal");
  compareRequiredText(row.strategyVersion, config.strategyVersion, "strategy_version", comparisonReasons, dataUnavailable);
  if (row.signalTelemetry) compareSignalTelemetry(row.signalTelemetry, evaluation, sourceTimestamp, inputProvenance, comparisonReasons, dataUnavailable);
  if (evaluation.status !== "ADMITTED" || !candidate || !evaluation.plan) {
    if (row.signalTelemetry) dataUnavailable.push(`Production persisted an admitted signal, but the shared replay returned ${evaluation.status}: ${evaluation.reason ?? "no admitted candidate"}.`);
    const stage = row.signalTelemetry ? divergenceStageForEvaluation(evaluation) : "data_unavailable";
    const classified = classifyComparisonReasons(comparisonReasons, inputProvenance);
    return {
      ...base,
      status: row.signalTelemetry
        ? classified.materialReasons.length > 0 ? "MATERIAL_MISMATCH" : "INPUT_DATA_UNAVAILABLE"
        : "PARTIAL_MATCH",
      reasons: classified.materialReasons,
      dataUnavailable: dataUnavailable.concat(classified.unavailableReasons),
      firstDivergenceStage: stage,
      divergence: divergenceForStage(stage, trace),
      inputProvenance,
      trace,
      replay,
    };
  }
  const plan = evaluation.plan;
  replay.admission = true;
  replay.entryPrice = plan.entryPrice;
  replay.stopPrice = plan.stopPrice;
  replay.takeProfitPrice = plan.takeProfitPrice;
  replay.maxHoldUntil = new Date(plan.validUntil).toISOString();
  compareRequiredText(row.side, candidate.side, "side", comparisonReasons, dataUnavailable);
  compareRequiredText(row.strategyFamily, candidate.strategyFamily, "strategy_family", comparisonReasons, dataUnavailable);
  compareNumber(row.entryPrice, plan.entryPrice, "entry_price", comparisonReasons, dataUnavailable);
  compareNumber(row.entryFillPrice, adverseFill(plan.entryPrice, candidate.side === "LONG" ? 1 : -1, config.signalPolicy.slippageBps / 10_000, "entry"), "entry_fill_price", comparisonReasons, dataUnavailable);
  compareNumber(row.stopPrice, plan.stopPrice, "stop_price", comparisonReasons, dataUnavailable);
  compareNumber(row.takeProfitPrice, plan.takeProfitPrice, "take_profit_price", comparisonReasons, dataUnavailable);
  compareRequiredText(row.maxHoldUntil, new Date(plan.validUntil).toISOString(), "max_hold_until", comparisonReasons, dataUnavailable, true);
  compareNumber(row.quantity, plan.quantity, "quantity", comparisonReasons, dataUnavailable);
  compareNumber(row.theoreticalRiskUsdt, plan.theoreticalRiskUsdt, "theoretical_risk_usdt", comparisonReasons, dataUnavailable);
  const entryModel = typeof row.metadata.entry_model === "string" ? row.metadata.entry_model : null;
  compareRequiredText(entryModel, PRODUCTION_ENTRY_MODEL, "metadata.entry_model", comparisonReasons, dataUnavailable);
  const quantizationVerdict = classifyQuantizationMismatch({
    actualStop: row.signalTelemetry?.stopPrice ?? row.stopPrice,
    actualTakeProfit: row.signalTelemetry?.takeProfitPrice ?? row.takeProfitPrice,
    replayStop: plan.stopPrice,
    replayTakeProfit: plan.takeProfitPrice,
    historicalPriceTick: numberOrNull(row.metadata.production_price_tick),
    replayPriceTick: dataset.instrument.priceTick,
    sameUnroundedInputs: typeof row.metadata.same_unrounded_risk_inputs === "boolean" ? row.metadata.same_unrounded_risk_inputs : undefined,
    sameNonPriceFields: typeof row.metadata.same_non_price_risk_fields === "boolean" ? row.metadata.same_non_price_risk_fields : undefined,
  });
  if (quantizationVerdict === "INPUT_DATA_UNAVAILABLE") {
    dataUnavailable.push("historical Production price-filter and rounding proof for stop/take-profit quantization");
  }
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
    compareRequiredText(row.exitReason, settlement.exitReason, "exit_reason", comparisonReasons, dataUnavailable);
    compareRequiredText(row.exitTime, new Date(settlement.exitTime).toISOString(), "exit_time", comparisonReasons, dataUnavailable, true);
    compareNumber(row.exitPrice, settlement.exitPrice, "exit_price", comparisonReasons, dataUnavailable);
    compareNumber(row.feesUsdt, settlement.feesUsdt, "fees_usdt", comparisonReasons, dataUnavailable);
    compareNumber(row.fundingUsdt, settlement.fundingUsdt, "funding_usdt", comparisonReasons, dataUnavailable);
    compareNumber(row.netPnlUsdt, settlement.netPnlUsdt, "net_pnl_usdt", comparisonReasons, dataUnavailable);
    compareNumber(row.rMultiple, replay.rMultiple, "r_multiple", comparisonReasons, dataUnavailable);
  }
  if (quantizationVerdict === "QUANTIZATION_EXPLAINED") {
    const quantizationReasons = comparisonReasons.filter((reason) => /(?:stop_price|take_profit_price|entry_price|quantity)/.test(reason));
    if (quantizationReasons.length === comparisonReasons.length) comparisonReasons.length = 0;
  }
  const classified = classifyComparisonReasons(comparisonReasons, inputProvenance);
  const status: ReplayStatus = classified.materialReasons.length > 0
    ? "MATERIAL_MISMATCH"
    : quantizationVerdict === "QUANTIZATION_EXPLAINED" && dataUnavailable.length === 0
      ? "QUANTIZATION_EXPLAINED"
    : dataUnavailable.length > 0
      ? "INPUT_DATA_UNAVAILABLE"
      : "MATCH";
  const firstDivergenceStage = firstMaterialDivergence(evaluation, classified.materialReasons, dataUnavailable, quantizationVerdict);
  return {
    ...base,
    status,
    quantizationVerdict,
    reasons: classified.materialReasons,
    dataUnavailable: dataUnavailable.concat(classified.unavailableReasons),
    firstDivergenceStage,
    divergence: firstDivergenceStage ? divergenceForStage(firstDivergenceStage, trace) : null,
    inputProvenance,
    trace,
    replay,
  };
}

export function classifyQuantizationMismatch(input: {
  actualStop: number | null;
  actualTakeProfit: number | null;
  replayStop: number | null;
  replayTakeProfit: number | null;
  historicalPriceTick?: number | null;
  replayPriceTick?: number | null;
  sameUnroundedInputs?: boolean;
  sameNonPriceFields?: boolean;
}): QuantizationVerdict {
  const {
    actualStop,
    actualTakeProfit,
    replayStop,
    replayTakeProfit,
    historicalPriceTick,
    replayPriceTick,
    sameUnroundedInputs,
    sameNonPriceFields,
  } = input;
  if (![actualStop, actualTakeProfit, replayStop, replayTakeProfit].every((value) => value !== null && value !== undefined && Number.isFinite(value))) {
    return "INPUT_DATA_UNAVAILABLE";
  }
  const samePrices = Math.abs((actualStop as number) - (replayStop as number)) <= 1e-12
    && Math.abs((actualTakeProfit as number) - (replayTakeProfit as number)) <= 1e-12;
  if (samePrices) return "INPUT_DATA_UNAVAILABLE";
  if (![historicalPriceTick, replayPriceTick].every((value) => value !== null && value !== undefined && Number.isFinite(value))) return "INPUT_DATA_UNAVAILABLE";
  if (sameUnroundedInputs !== true || sameNonPriceFields !== true) return "INPUT_DATA_UNAVAILABLE";
  const actualTick = historicalPriceTick as number;
  const replayTick = replayPriceTick as number;
  const aligned = (value: number, tick: number): boolean => {
    if (tick <= 0) return false;
    const units = value / tick;
    return Math.abs(units - Math.round(units)) <= 1e-9;
  };
  const stopDifference = Math.abs((actualStop as number) - (replayStop as number));
  const takeProfitDifference = Math.abs((actualTakeProfit as number) - (replayTakeProfit as number));
  const maxAllowedDifference = Math.max(actualTick, replayTick) + 1e-12;
  return aligned(actualStop as number, actualTick)
    && aligned(actualTakeProfit as number, actualTick)
    && aligned(replayStop as number, replayTick)
    && aligned(replayTakeProfit as number, replayTick)
    && stopDifference <= maxAllowedDifference
    && takeProfitDifference <= maxAllowedDifference
    ? "QUANTIZATION_EXPLAINED"
    : "MATERIAL_MISMATCH";
}

function compareSignalTelemetry(
  telemetry: ProductionSignalTelemetry,
  evaluation: ProductionSignalEvaluation,
  sourceTimestamp: number,
  inputProvenance: ReplayInputProvenance,
  reasons: string[],
  dataUnavailable: string[],
): void {
  const candidate = selectReplayCandidate(evaluation, telemetry);
  if (telemetry.sourceDataTimestamp) compareRequiredText(telemetry.sourceDataTimestamp, new Date(sourceTimestamp).toISOString(), "signal.source_data_timestamp", reasons, dataUnavailable, true);
  else dataUnavailable.push("signal.source_data_timestamp missing from bca_signals telemetry");
  if (telemetry.score === null) dataUnavailable.push("signal.score missing from bca_signals telemetry");
  else if (candidate) {
    const scoreInputsUnavailable = !inputProvenance.rawCandlesAvailable
      || !inputProvenance.pointInTimeLiquidityAvailable
      || inputProvenance.dataQualityComparison !== "PASS";
    if (scoreInputsUnavailable) dataUnavailable.push("signal.score comparison depends on unavailable point-in-time replay inputs");
    else compareNumber(telemetry.score, candidate.score, "signal.score", reasons, dataUnavailable);
  }
  if (!telemetry.scoreComponents) dataUnavailable.push("signal.score_components missing or incomplete in bca_signals telemetry");
  else if (candidate) compareScoreComponents(telemetry.scoreComponents, candidate.scoreComponents, inputProvenance, reasons, dataUnavailable);
  if (telemetry.marketRegime === null) dataUnavailable.push("signal.market_regime missing from bca_signals telemetry");
  else if (candidate && inputProvenance.rawCandlesAvailable) compareRequiredText(telemetry.marketRegime, candidate.marketRegime, "signal.market_regime", reasons, dataUnavailable);
  else if (candidate) dataUnavailable.push("signal.market_regime comparison depends on unavailable Production candle inputs");
  if (telemetry.side === null) dataUnavailable.push("signal.side missing from bca_signals telemetry");
  else if (candidate) compareRequiredText(telemetry.side, candidate.side, "signal.side", reasons, dataUnavailable);
  if (telemetry.strategyFamily === null) dataUnavailable.push("signal.strategy_family missing from bca_signals telemetry");
  else if (candidate) compareRequiredText(telemetry.strategyFamily, candidate.strategyFamily, "signal.strategy_family", reasons, dataUnavailable);
  if (candidate && evaluation.plan && inputProvenance.rawCandlesAvailable) {
    compareNumber(telemetry.entryPrice, evaluation.plan.entryPrice, "signal.entry_price", reasons, dataUnavailable);
    compareNumber(telemetry.stopPrice, evaluation.plan.stopPrice, "signal.stop_price", reasons, dataUnavailable);
    compareNumber(telemetry.takeProfitPrice, evaluation.plan.takeProfitPrice, "signal.take_profit_price", reasons, dataUnavailable);
    compareRequiredText(telemetry.validUntil, new Date(evaluation.plan.validUntil).toISOString(), "signal.valid_until", reasons, dataUnavailable, true);
  } else if (candidate && evaluation.plan) {
    dataUnavailable.push("signal risk-plan comparison depends on unavailable Production candle inputs");
  }
}

function compareScoreComponents(
  actual: ScoreComponents,
  expected: ScoreComponents,
  inputProvenance: ReplayInputProvenance,
  reasons: string[],
  dataUnavailable: string[],
): void {
  for (const key of ["trendAlignment", "momentum", "structure", "liquidity", "volatility", "regimeFit", "dataQuality"] as const) {
    const unavailable = key === "liquidity"
      ? !inputProvenance.pointInTimeLiquidityAvailable
      : key === "dataQuality"
        ? inputProvenance.dataQualityComparison !== "PASS"
        : !inputProvenance.rawCandlesAvailable;
    if (unavailable) {
      dataUnavailable.push(`signal.score_components.${key} comparison is DATA_UNAVAILABLE because the Production input was not persisted`);
    } else {
      compareNumber(actual[key], expected[key], `signal.score_components.${key}`, reasons, dataUnavailable);
    }
  }
}

function divergenceStageForEvaluation(evaluation: ProductionSignalEvaluation): DivergenceStage {
  if (evaluation.rawCandidates.length === 0) return "strategy_trigger";
  if (evaluation.scoreEligibleCandidates.length === 0) return "score";
  if (evaluation.sideFamilyEligibleCandidates.length === 0) return "side_family_filter";
  if (evaluation.status === "NO_REGIME_ELIGIBLE_CANDIDATE") return "regime";
  if (evaluation.status === "ENTRY_INTERVAL_BLOCKED") return "entry_interval";
  if (["RISK_PLAN_ERROR", "SINGLE_RISK_CAP", "EXECUTION_COST_BLOCKED", "ADMITTED"].includes(evaluation.status)) return "risk_admission";
  return "data_unavailable";
}

function firstMaterialDivergence(
  evaluation: ProductionSignalEvaluation,
  reasons: string[],
  dataUnavailable: string[],
  quantizationVerdict: QuantizationVerdict,
): DivergenceStage | null {
  if (reasons.length === 0) return dataUnavailable.length > 0 ? "data_unavailable" : null;
  if (evaluation.status !== "ADMITTED") return divergenceStageForEvaluation(evaluation);
  if (reasons.some((reason) => reason.startsWith("signal.score") || reason.startsWith("signal.score_components"))) return "score_components";
  if (reasons.some((reason) => reason.startsWith("signal.market_regime"))) return "regime";
  if (reasons.some((reason) => reason.startsWith("signal.side") || reason.startsWith("signal.strategy_family") || reason.startsWith("side:") || reason.startsWith("strategy_family:"))) return "side_family_filter";
  if (quantizationVerdict === "MATERIAL_MISMATCH" || reasons.some((reason) => /(?:entry_price|stop_price|take_profit_price|quantity|theoretical_risk|risk)/.test(reason))) return "risk_admission";
  if (reasons.some((reason) => /(?:exit_|fees_|funding_|net_pnl|r_multiple)/.test(reason))) return "settlement";
  return "data_unavailable";
}

function divergenceForStage(
  stage: DivergenceStage,
  trace: ProductionReplayResult["trace"],
): DivergenceValue {
  if (stage === "raw_candles") return { productionEquivalentValue: trace.rawCandles.productionEquivalentValue, replayValue: trace.rawCandles.replayValue };
  if (stage === "indicators") return { productionEquivalentValue: trace.indicators.productionEquivalentValue, replayValue: trace.indicators.replayValue };
  if (stage === "strategy_trigger" || stage === "score" || stage === "score_components" || stage === "rank_candidates" || stage === "regime" || stage === "entry_interval" || stage === "side_family_filter" || stage === "risk_admission") {
    const key = stage === "strategy_trigger"
      ? "rawStrategyTrigger"
      : stage === "score"
        ? "score"
        : stage === "score_components"
        ? "scoreComponents"
        : stage === "rank_candidates"
          ? "rankCandidates"
          : stage === "entry_interval"
              ? "entryInterval"
              : stage === "side_family_filter"
                ? "sideFamilyFilter"
                : "riskAdmission";
    return trace[key];
  }
  return { productionEquivalentValue: "DATA_UNAVAILABLE", replayValue: "DATA_UNAVAILABLE" };
}

function buildReplayTrace(
  snapshot: MarketSnapshot,
  evaluation: ProductionSignalEvaluation,
  telemetry: ProductionSignalTelemetry | null,
  inputProvenance: ReplayInputProvenance,
): ProductionReplayResult["trace"] {
  const replayCandidate = selectReplayCandidate(evaluation, telemetry);
  const rawStrategyTrigger = {
    productionEquivalentValue: telemetry ? { signalId: telemetry.signalId, persisted: true, rawTrigger: "DATA_UNAVAILABLE" } : "DATA_UNAVAILABLE",
    replayValue: {
      status: evaluation.stages.rawStrategyTrigger,
      candidateCount: evaluation.rawCandidates.length,
      candidates: evaluation.rawCandidates.map((candidate) => ({ side: candidate.side, family: candidate.strategyFamily })),
    },
  };
  return {
    rawCandles: {
      productionEquivalentValue: "DATA_UNAVAILABLE",
      replayValue: summarizeCandles(snapshot.candles),
    },
    indicators: {
      productionEquivalentValue: "DATA_UNAVAILABLE",
      replayValue: summarizeIndicators(snapshot.candles),
    },
    rawStrategyTrigger,
    score: {
      productionEquivalentValue: telemetry ? { score: telemetry.score, threshold: "DATA_UNAVAILABLE" } : "DATA_UNAVAILABLE",
      replayValue: {
        status: replayScoreStageStatus(evaluation, inputProvenance),
        minimumScore: "DATA_UNAVAILABLE",
        candidates: evaluation.scoredCandidates.map((candidate) => ({ side: candidate.side, family: candidate.strategyFamily, score: candidate.score })),
      },
    },
    strategyTrigger: rawStrategyTrigger,
    scoreComponents: {
      productionEquivalentValue: telemetry ? { score: telemetry.score, components: telemetry.scoreComponents } : "DATA_UNAVAILABLE",
      replayValue: replayCandidate ? { score: replayCandidate.score, components: replayScoreComponents(replayCandidate, inputProvenance) } : "DATA_UNAVAILABLE",
    },
    rankCandidates: {
      productionEquivalentValue: "DATA_UNAVAILABLE: Production rank context was not persisted",
      replayValue: evaluation.rankedCandidates.map((candidate, index) => ({ rank: index + 1, side: candidate.side, family: candidate.strategyFamily, score: candidate.score })),
    },
    regime: {
      productionEquivalentValue: telemetry?.marketRegime ?? "DATA_UNAVAILABLE",
      replayValue: replayCandidate?.marketRegime ?? "DATA_UNAVAILABLE",
    },
    entryInterval: {
      productionEquivalentValue: "DATA_UNAVAILABLE: Production admission context was not persisted",
      replayValue: evaluation.entryIntervalAllowed,
    },
    sideFamilyFilter: {
      productionEquivalentValue: telemetry ? { side: telemetry.side, family: telemetry.strategyFamily } : "DATA_UNAVAILABLE",
      replayValue: { status: evaluation.stages.sideFamilyFilter, candidate: replayCandidate ? { side: replayCandidate.side, family: replayCandidate.strategyFamily } : null },
    },
    riskAdmission: {
      productionEquivalentValue: telemetry ? { paperTradePersisted: true, plan: { entry: telemetry.entryPrice, stop: telemetry.stopPrice, takeProfit: telemetry.takeProfitPrice } } : "DATA_UNAVAILABLE",
      replayValue: { status: evaluation.stages.riskAdmission, evaluation: evaluation.status, admitted: evaluation.status === "ADMITTED", plan: evaluation.plan ? { entry: evaluation.plan.entryPrice, stop: evaluation.plan.stopPrice, takeProfit: evaluation.plan.takeProfitPrice } : null },
    },
  };
}

function replayScoreStageStatus(
  evaluation: ProductionSignalEvaluation,
  inputProvenance: ReplayInputProvenance,
): "PASS" | "FAIL" | "DATA_UNAVAILABLE" {
  if (!inputProvenance.rawCandlesAvailable
    || !inputProvenance.pointInTimeLiquidityAvailable
    || inputProvenance.dataQualityComparison !== "PASS") return "DATA_UNAVAILABLE";
  return evaluation.stages.score;
}

function replayScoreComponents(
  candidate: import("@/lib/core/types").ScoredCandidate,
  inputProvenance: ReplayInputProvenance,
): Record<string, unknown> {
  const components: Record<string, unknown> = { ...candidate.scoreComponents };
  if (!inputProvenance.rawCandlesAvailable) {
    for (const key of ["trendAlignment", "momentum", "structure", "volatility", "regimeFit"] as const) components[key] = "DATA_UNAVAILABLE";
  }
  if (!inputProvenance.pointInTimeLiquidityAvailable) components.liquidity = "DATA_UNAVAILABLE";
  if (inputProvenance.dataQualityComparison !== "PASS") components.dataQuality = "DATA_UNAVAILABLE";
  return components;
}

function selectReplayCandidate(
  evaluation: ProductionSignalEvaluation,
  telemetry: ProductionSignalTelemetry | null,
): import("@/lib/core/types").ScoredCandidate | null {
  const matching = telemetry
    ? evaluation.scoredCandidates.find((candidate) => (
      candidate.side === telemetry.side && candidate.strategyFamily === telemetry.strategyFamily
    ))
    : undefined;
  return matching ?? evaluation.candidate ?? evaluation.scoredCandidates[0] ?? null;
}

function buildReplayInputProvenance(
  telemetry: ProductionSignalTelemetry | null,
  snapshot: MarketSnapshot | null,
): ReplayInputProvenance {
  const persisted = telemetry?.inputProvenance ?? null;
  const replayCandleCounts = snapshot ? candleCounts(snapshot.candles) : emptyCandleCounts();
  const productionCandleCounts = persisted?.candleCounts ?? null;
  const pointInTimeCandleCountsAvailable = productionCandleCounts !== null;
  const sameCandleCounts = pointInTimeCandleCountsAvailable
    && Object.keys(replayCandleCounts).every((key) => replayCandleCounts[key as Timeframe] === productionCandleCounts?.[key as Timeframe]);
  const pointInTimeLiquidityAvailable = persisted?.quoteVolume24h !== null && persisted?.quoteVolume24h !== undefined;
  return {
    productionLiquidity: telemetry?.scoreComponents?.liquidity ?? null,
    replayLiquidity: null,
    pointInTimeLiquidityAvailable,
    source: persisted?.source ?? "public.bca_signals.score_components; point-in-time quoteVolume24h not persisted",
    productionCandleCounts,
    replayCandleCounts,
    pointInTimeCandleCountsAvailable,
    dataQualityComparison: sameCandleCounts ? "PASS" : "DATA_UNAVAILABLE",
    rawCandlesAvailable: persisted?.rawCandlesAvailable === true,
  };
}

function candleCounts(candles: Partial<Record<Timeframe, Candle[]>>): CandleCounts {
  return {
    "15m": candles["15m"]?.length ?? null,
    "1h": candles["1h"]?.length ?? null,
    "4h": candles["4h"]?.length ?? null,
  };
}

function emptyCandleCounts(): CandleCounts {
  return { "15m": null, "1h": null, "4h": null };
}

function classifyComparisonReasons(
  reasons: string[],
  inputProvenance: ReplayInputProvenance,
): { materialReasons: string[]; unavailableReasons: string[] } {
  const materialReasons: string[] = [];
  const unavailableReasons: string[] = [];
  for (const reason of reasons) {
    if (isInputDependentReason(reason, inputProvenance)) {
      unavailableReasons.push(`${reason}; input provenance is incomplete`);
    } else {
      materialReasons.push(reason);
    }
  }
  return { materialReasons, unavailableReasons };
}

function isInputDependentReason(reason: string, inputProvenance: ReplayInputProvenance): boolean {
  if (!inputProvenance.rawCandlesAvailable) return true;
  if (!inputProvenance.pointInTimeLiquidityAvailable && /signal\.score(?:_components\.liquidity)?/.test(reason)) return true;
  if (inputProvenance.dataQualityComparison !== "PASS" && /signal\.score(?:_components\.dataQuality)?/.test(reason)) return true;
  if (/global claimSignal|entry_|stop_|take_profit_|quantity|theoretical_risk|risk|exit_|fees_|funding_|net_pnl|r_multiple/.test(reason)) return true;
  return false;
}

function summarizeCandles(candles: Partial<Record<"15m" | "1h" | "4h", Candle[]>>): Record<string, unknown> {
  return Object.fromEntries((["15m", "1h", "4h"] as const).map((timeframe) => {
    const rows = candles[timeframe] ?? [];
    const first = rows[0];
    const last = rows[rows.length - 1];
    return [timeframe, {
      count: rows.length,
      firstCloseTime: first?.closeTime ?? null,
      lastCloseTime: last?.closeTime ?? null,
      lastClose: last?.close ?? null,
      lastVolume: last?.volume ?? null,
    }];
  }));
}

function summarizeIndicators(candles: Partial<Record<"15m" | "1h" | "4h", Candle[]>>): Record<string, unknown> {
  return Object.fromEntries((["15m", "1h", "4h"] as const).map((timeframe) => {
    const rows = candles[timeframe] ?? [];
    const values = closes(rows);
    return [timeframe, {
      ema20: latest(ema(values, 20)),
      ema50: latest(ema(values, 50)),
      rsi14: latest(rsi(values, 14)),
      atr14: latest(atr(rows, 14)),
      volumeRatio20: latest(volumeRatio(rows, 20)),
    }];
  }));
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
  exportProvenance: ImmutableExportProvenance | null = null,
): ProductionParityReport {
  return {
    queryTimestamp: new Date().toISOString(),
    dataSource: "live_supabase_read",
    sourceTable: "public.bca_paper_trades",
    strategyVersion: PRODUCTION_STRATEGY_VERSION,
    extractionQuery: EXTRACTION_QUERY,
    exportProvenance,
    settledProspectiveTrades: null,
    rawRows: [],
    prospectiveMetrics: null,
    replayResults: [],
    exactMatches: null,
    partialMatches: null,
    quantizationExplained: null,
    inputDataUnavailable: null,
    materialMismatches: null,
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
  exportProvenance: ImmutableExportProvenance | null = null,
): ProductionParityReport {
  const exactMatches = replayResults.filter((result) => result.status === "MATCH").length;
  const partialMatches = replayResults.filter((result) => result.status === "PARTIAL_MATCH").length;
  const quantizationExplained = replayResults.filter((result) => result.status === "QUANTIZATION_EXPLAINED").length;
  const materialMismatches = replayResults.filter((result) => result.status === "MATERIAL_MISMATCH").length;
  const inputDataUnavailable = replayResults.filter((result) => result.status === "INPUT_DATA_UNAVAILABLE").length;
  const verdict = configParity.status === "FAIL" || materialMismatches > 0
    ? "FAIL"
    : configParity.status !== "PASS" || rows.length === 0 || partialMatches > 0 || inputDataUnavailable > 0 || (dataSource === "immutable_read_only_export" && !exportProvenance?.verified)
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
    extractionQuery: EXTRACTION_QUERY,
    exportProvenance,
    settledProspectiveTrades: rows.length,
    rawRows: rows,
    prospectiveMetrics,
    replayResults,
    exactMatches,
    partialMatches,
    quantizationExplained,
    inputDataUnavailable,
    materialMismatches,
    configParity,
    verdict,
    failureClassification,
    historicalControlReliable: verdict === "PASS",
    queryError,
  };
}

function parseExportProvenance(value: Record<string, unknown>, rows: unknown[]): ImmutableExportProvenance | null {
  const capturedAt = stringOrNull(value.capturedAt);
  const rowCount = numberOrNull(value.rowCount);
  const sha256 = stringOrNull(value.sha256)?.toLowerCase() ?? null;
  const hashScope = value.hashScope === "canonical_json_rows" ? value.hashScope : null;
  const sourceTable = stringOrNull(value.sourceTable);
  const query = stringOrNull(value.query);
  if (!capturedAt || rowCount === null || !sha256 || !hashScope || !sourceTable || !query) return null;
  const verified = rowCount === rows.length && hashCanonicalRows(rows) === sha256;
  return {
    capturedAt,
    rowCount,
    sha256,
    hashScope,
    sourceTable,
    query,
    relatedSourceTable: stringOrNull(value.relatedSourceTable) ?? undefined,
    verified,
  };
}

export function hashCanonicalRows(rows: unknown[]): string {
  return createHash("sha256").update(canonicalJson(rows)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsePaperTradeRow(row: Record<string, unknown>): ProductionPaperTradeRow {
  const nestedSignal = isRecord(row.signal) ? parseSignalTelemetry(row.signal) : null;
  const flatSignal = row.signal_score !== undefined || row.signal_market_regime !== undefined
    ? parseSignalTelemetry({
      id: row.signal_id,
      source_data_timestamp: row.signal_source_data_timestamp,
      score: row.signal_score,
      score_components: row.signal_score_components,
      market_regime: row.signal_market_regime,
      side: row.signal_side,
      strategy_family: row.signal_strategy_family,
      primary_timeframe: row.signal_primary_timeframe,
      confirmation_timeframes: row.signal_confirmation_timeframes,
      regime_dependency: row.signal_regime_dependency,
      entry_price: row.signal_entry_price,
      stop_price: row.signal_stop_price,
      take_profit_price: row.signal_take_profit_price,
      valid_until: row.signal_valid_until,
      input_provenance: row.signal_input_provenance,
    })
    : null;
  const metadata = sanitizePaperMetadata(row.metadata);
  const metadataInputProvenance = isRecord(metadata.input_provenance)
    ? parsePersistedProductionInputProvenance(metadata.input_provenance)
    : null;
  const signalTelemetry = nestedSignal ?? flatSignal;
  if (signalTelemetry && !signalTelemetry.inputProvenance && metadataInputProvenance) {
    signalTelemetry.inputProvenance = metadataInputProvenance;
  }
  return {
    id: stringOrNull(row.id) ?? "UNKNOWN_ROW",
    signalId: stringOrNull(row.signal_id),
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
    metadata,
    signalTelemetry,
  };
}

function parseSignalTelemetry(row: Record<string, unknown>): ProductionSignalTelemetry | null {
  const signalId = stringOrNull(row.id) ?? stringOrNull(row.signal_id);
  if (!signalId) return null;
  const scoreComponents = isRecord(row.score_components)
    ? parseScoreComponents(row.score_components)
    : null;
  return {
    signalId,
    sourceDataTimestamp: stringOrNull(row.source_data_timestamp),
    score: numberOrNull(row.score),
    scoreComponents,
    marketRegime: stringOrNull(row.market_regime),
    side: stringOrNull(row.side),
    strategyFamily: stringOrNull(row.strategy_family),
    primaryTimeframe: stringOrNull(row.primary_timeframe),
    confirmationTimeframes: Array.isArray(row.confirmation_timeframes)
      ? row.confirmation_timeframes.filter((value): value is string => typeof value === "string")
      : [],
    regimeDependency: stringOrNull(row.regime_dependency),
    entryPrice: numberOrNull(row.entry_price),
    stopPrice: numberOrNull(row.stop_price),
    takeProfitPrice: numberOrNull(row.take_profit_price),
    validUntil: stringOrNull(row.valid_until),
    inputProvenance: parsePersistedProductionInputProvenance(row.input_provenance),
  };
}

function parsePersistedProductionInputProvenance(value: unknown): PersistedProductionInputProvenance | null {
  if (!isRecord(value)) return null;
  const quoteVolume24h = numberOrNull(value.quoteVolume24h ?? value.quote_volume_24h);
  const rawCounts = value.candleCounts ?? value.candle_counts;
  const candleCounts = parseCandleCounts(rawCounts);
  const rawCandlesAvailable = value.rawCandlesAvailable === true || value.raw_candles_available === true;
  if (quoteVolume24h === null && candleCounts === null && !rawCandlesAvailable) return null;
  return {
    quoteVolume24h,
    candleCounts,
    rawCandlesAvailable,
    source: stringOrNull(value.source) ?? "persisted Production input provenance",
  };
}

function parseCandleCounts(value: unknown): CandleCounts | null {
  if (!isRecord(value)) return null;
  const counts = {
    "15m": numberOrNull(value["15m"]),
    "1h": numberOrNull(value["1h"]),
    "4h": numberOrNull(value["4h"]),
  } satisfies CandleCounts;
  return Object.values(counts).every((count) => count !== null) ? counts : null;
}

function parseScoreComponents(row: Record<string, unknown>): ScoreComponents | null {
  const keys: Array<keyof ScoreComponents> = [
    "trendAlignment",
    "momentum",
    "structure",
    "liquidity",
    "volatility",
    "regimeFit",
    "dataQuality",
  ];
  if (keys.some((key) => numberOrNull(row[key]) === null)) return null;
  return Object.fromEntries(keys.map((key) => [key, numberOrNull(row[key])])) as unknown as ScoreComponents;
}

function sanitizePaperMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const metadata: Record<string, unknown> = {};
  if (typeof value.entry_model === "string") metadata.entry_model = value.entry_model;
  if (typeof value.source_data_timestamp === "string") metadata.source_data_timestamp = value.source_data_timestamp;
  if (numberOrNull(value.slippage_bps) !== null) metadata.slippage_bps = numberOrNull(value.slippage_bps);
  if (numberOrNull(value.production_price_tick) !== null) metadata.production_price_tick = numberOrNull(value.production_price_tick);
  if (typeof value.same_unrounded_risk_inputs === "boolean") metadata.same_unrounded_risk_inputs = value.same_unrounded_risk_inputs;
  if (typeof value.same_non_price_risk_fields === "boolean") metadata.same_non_price_risk_fields = value.same_non_price_risk_fields;
  const inputProvenance = parsePersistedProductionInputProvenance(value.input_provenance);
  if (inputProvenance) metadata.input_provenance = inputProvenance;
  return metadata;
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
  plan: TradePlan,
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

function emptyTrace(): ProductionReplayResult["trace"] {
  const unavailable = { productionEquivalentValue: "DATA_UNAVAILABLE", replayValue: "DATA_UNAVAILABLE" };
  return {
    rawCandles: { ...unavailable },
    indicators: { ...unavailable },
    rawStrategyTrigger: { ...unavailable },
    score: { ...unavailable },
    strategyTrigger: { ...unavailable },
    scoreComponents: { ...unavailable },
    rankCandidates: { ...unavailable },
    regime: { ...unavailable },
    entryInterval: { ...unavailable },
    sideFamilyFilter: { ...unavailable },
    riskAdmission: { ...unavailable },
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
