import { bootstrapLowerConfidenceBound } from "@/lib/v5-4/confidence";
import { canonicalJson } from "./canonical";
import { V55_STRATEGY_VERSION, V55_FORWARD_EXPERIMENT_ID } from "./manifest";

export const V55_MIN_FORWARD_TRADES = 50;
export const V55_MIN_FORWARD_DAYS = 30;
export const V55_STRONG_FORWARD_TRADES = 100;
export const V55_STRONG_FORWARD_DAYS = 60;

export type V55ForwardStatus =
  | "INSUFFICIENT_FORWARD_EVIDENCE"
  | "SHADOW_HEALTHY"
  | "SHADOW_DEGRADED"
  | "SHADOW_FAILED";

export interface V55ForwardTradeRow {
  id?: string;
  strategy_version: string;
  forward_experiment_id: string | null;
  source_data_timestamp: string | null;
  entry_time: string;
  exit_time: string | null;
  status: string;
  symbol: string;
  r_multiple: number | null;
  net_pnl_usdt: number | null;
  fees_usdt?: number | null;
  funding_usdt?: number | null;
  slippage_usdt?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface V55ForwardEvidence {
  experimentId: string;
  strategyVersion: string;
  forwardStartTimestamp: string;
  status: V55ForwardStatus;
  automaticPromotionAllowed: false;
  settledTrades: number;
  wins: number;
  losses: number;
  avgR: number | null;
  profitFactor: number | null;
  netR: number;
  stopRate: number | null;
  positiveMonths: number;
  monthsObserved: number;
  maxDrawdownR: number;
  symbolBreadth: number;
  regimeBreadth: number;
  costTotals: {
    feesUsdt: number;
    fundingUsdt: number;
    slippageUsdt: number;
  };
  bootstrapLcb95: number | null;
  observationDays: number;
  excludedRows: number;
  notes: string[];
}

export function evaluateV55ForwardEvidence(input: {
  rows: V55ForwardTradeRow[];
  experimentId?: string;
  strategyVersion?: string;
  forwardStartTimestamp: number;
  asOfTimestamp?: number;
  repetitions?: number;
}): V55ForwardEvidence {
  const experimentId = input.experimentId ?? V55_FORWARD_EXPERIMENT_ID;
  const strategyVersion = input.strategyVersion ?? V55_STRATEGY_VERSION;
  const start = input.forwardStartTimestamp;
  const asOf = input.asOfTimestamp ?? Date.now();
  const eligible = input.rows.filter((row) => isEligibleForwardRow(row, experimentId, strategyVersion, start));
  const settled = eligible.filter((row) => row.r_multiple !== null && row.exit_time !== null && row.status !== "OPEN");
  const values = settled.map((row) => Number(row.r_multiple)).filter(Number.isFinite);
  const wins = values.filter((value) => value > 0).length;
  const losses = values.filter((value) => value < 0).length;
  const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const avgR = values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const netR = round(values.reduce((sum, value) => sum + value, 0));
  const profitFactor = grossLoss > 0 ? round(grossProfit / grossLoss) : values.length > 0 && grossProfit > 0 ? null : 0;
  const months = monthBuckets(settled);
  const observationDays = settled.length > 0
    ? Math.max(0, Math.floor((Math.max(...settled.map((row) => Date.parse(row.exit_time!))) - start) / 86_400_000) + 1)
    : Math.max(0, Math.floor((asOf - start) / 86_400_000));
  const lcb = values.length >= 2
    ? bootstrapLowerConfidenceBound(values, "block_bootstrap", input.repetitions ?? 2_000, Math.min(5, values.length))
    : null;
  const maxDrawdownR = calculateMaxDrawdown(values);
  const status = classifyStatus({ settledTrades: values.length, observationDays, avgR, profitFactor, lcb });

  return {
    experimentId,
    strategyVersion,
    forwardStartTimestamp: new Date(start).toISOString(),
    status,
    automaticPromotionAllowed: false,
    settledTrades: values.length,
    wins,
    losses,
    avgR,
    profitFactor,
    netR,
    stopRate: values.length > 0 ? round(settled.filter((row) => row.status === "STOP_LOSS" || row.metadata?.exit_reason === "STOP_LOSS").length / values.length) : null,
    positiveMonths: months.filter((month) => month.netR > 0).length,
    monthsObserved: months.length,
    maxDrawdownR,
    symbolBreadth: new Set(settled.map((row) => row.symbol)).size,
    regimeBreadth: new Set(settled.map((row) => String(row.metadata?.market_regime ?? "UNKNOWN"))).size,
    costTotals: {
      feesUsdt: round(settled.reduce((sum, row) => sum + Number(row.fees_usdt ?? 0), 0)),
      fundingUsdt: round(settled.reduce((sum, row) => sum + Number(row.funding_usdt ?? 0), 0)),
      slippageUsdt: round(settled.reduce((sum, row) => sum + Number(row.slippage_usdt ?? 0), 0)),
    },
    bootstrapLcb95: lcb,
    observationDays,
    excludedRows: input.rows.length - eligible.length,
    notes: [
      "Only exact strategy_version, forward_experiment_id, and source_data_timestamp >= forwardStartTimestamp are included.",
      "Historical, backtest, and legacy shadow rows are excluded and cannot be backfilled into this experiment.",
      "This evaluator never returns PRODUCTION_EMAIL_ELIGIBLE and cannot trigger promotion.",
    ],
  };
}

export function isEligibleForwardRow(
  row: V55ForwardTradeRow,
  experimentId: string,
  strategyVersion: string,
  forwardStartTimestamp: number,
): boolean {
  const sourceTimestamp = row.source_data_timestamp ? Date.parse(row.source_data_timestamp) : NaN;
  return row.forward_experiment_id === experimentId
    && row.strategy_version === strategyVersion
    && Number.isFinite(sourceTimestamp)
    && sourceTimestamp >= forwardStartTimestamp;
}

export function buildForwardIdempotencyKey(strategyVersion: string, symbol: string, sourceDataTimestamp: string): string {
  return `${strategyVersion}|${symbol}|${sourceDataTimestamp}`;
}

export function evaluatorCanonicalInput(input: unknown): string {
  return canonicalJson(input);
}

function classifyStatus(input: {
  settledTrades: number;
  observationDays: number;
  avgR: number | null;
  profitFactor: number | null;
  lcb: number | null;
}): V55ForwardStatus {
  if (input.settledTrades < V55_MIN_FORWARD_TRADES || input.observationDays < V55_MIN_FORWARD_DAYS) {
    return "INSUFFICIENT_FORWARD_EVIDENCE";
  }
  if (input.avgR !== null && input.profitFactor !== null && input.lcb !== null && input.avgR > 0 && input.profitFactor >= 1 && input.lcb >= 0) {
    return "SHADOW_HEALTHY";
  }
  if ((input.avgR ?? -Infinity) > -0.15 && (input.profitFactor ?? 0) >= 0.85) return "SHADOW_DEGRADED";
  return "SHADOW_FAILED";
}

function monthBuckets(rows: V55ForwardTradeRow[]): Array<{ month: string; netR: number }> {
  const months = new Map<string, number>();
  for (const row of rows) {
    const timestamp = Date.parse(row.exit_time!);
    const date = new Date(timestamp);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    months.set(month, (months.get(month) ?? 0) + Number(row.r_multiple));
  }
  return [...months.entries()].map(([month, netR]) => ({ month, netR: round(netR) })).sort((left, right) => left.month.localeCompare(right.month));
}

function calculateMaxDrawdown(values: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return round(maxDrawdown);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
