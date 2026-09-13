import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
} from "./contract";

export interface Prc1ForwardTradeRow {
  id: string | number;
  strategy_version: string;
  entry_time: string;
  exit_time: string | null;
  status: string;
  net_pnl_usdt: number | string | null;
  gross_pnl_usdt?: number | string | null;
  r_multiple: number | string | null;
}

export interface Prc1GrossDiagnostics {
  diagnosticOnly: true;
  grossProfit: number;
  grossLoss: number;
  largestWinningTrade: number;
  grossProfitContributionLargestTradePct: number;
}

export interface Prc1PerformanceMetrics {
  closedTrades: number;
  netPnlUsdt: number;
  netProfit: number;
  netLoss: number;
  profitFactor: number;
  winRate: number;
  avgPnl: number;
  avgR: number;
  maxDrawdown: number;
  grossProfit: number;
  grossLoss: number;
  largestWinningTrade: number;
  grossProfitContributionLargestTradePct: number;
  grossMetrics: Prc1GrossDiagnostics;
}

export interface Prc1PerformanceDifference {
  closedTrades: number;
  netPnlUsdt: number;
  netProfit: number;
  netLoss: number;
  profitFactor: number;
  winRate: number;
  avgPnl: number;
  avgR: number;
  maxDrawdown: number;
  grossProfit: number;
  grossLoss: number;
  largestWinningTrade: number;
  grossProfitContributionLargestTradePct: number;
}

export interface Prc1ForwardComparison {
  baseline: Prc1PerformanceMetrics;
  challenger: Prc1PerformanceMetrics;
  difference: Prc1PerformanceDifference;
  forwardWindow?: {
    forwardStartUtc: string;
    asOfUtc: string;
  };
}

export async function loadPrc1ForwardComparison(
  supabase: SupabaseClient,
  forwardStartUtc: string,
  asOfUtc: string,
): Promise<Prc1ForwardComparison> {
  assertForwardWindow(forwardStartUtc, asOfUtc);

  const { data, error } = await supabase
    .from("bca_shadow_paper_trades")
    .select("id,strategy_version,entry_time,exit_time,status,net_pnl_usdt,gross_pnl_usdt,r_multiple")
    .in("strategy_version", [PRC1_BASELINE_STRATEGY_VERSION, PRC1_CHALLENGER_STRATEGY_VERSION])
    .gte("entry_time", forwardStartUtc)
    .lt("entry_time", asOfUtc)
    .order("entry_time", { ascending: true })
    .order("exit_time", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`PRC-1 forward comparison lookup failed: ${error.message}`);

  const rows = (data ?? []) as Prc1ForwardTradeRow[];
  const comparison = comparePrc1ForwardTrades(
    rows.filter((row) => row.strategy_version === PRC1_BASELINE_STRATEGY_VERSION),
    rows.filter((row) => row.strategy_version === PRC1_CHALLENGER_STRATEGY_VERSION),
  );
  return {
    ...comparison,
    forwardWindow: { forwardStartUtc, asOfUtc },
  };
}

export function assertForwardWindow(forwardStartUtc: string, asOfUtc: string): void {
  const frozenAt = Date.parse(PRC1_HYPOTHESIS_FROZEN_AT_UTC);
  const start = Date.parse(forwardStartUtc);
  const asOf = Date.parse(asOfUtc);
  if (!Number.isFinite(start) || !Number.isFinite(asOf)) {
    throw new Error("DATA_INVALID: forward comparison window timestamps must be valid UTC timestamps");
  }
  if (start < frozenAt) {
    throw new Error("DATA_INVALID: forwardStartUtc precedes the frozen hypothesis timestamp");
  }
  if (asOf <= start) {
    throw new Error("DATA_INVALID: asOfUtc must be later than forwardStartUtc");
  }
}

export function comparePrc1ForwardTrades(
  baselineRows: Prc1ForwardTradeRow[],
  challengerRows: Prc1ForwardTradeRow[],
): Prc1ForwardComparison {
  const baseline = summarizePrc1Trades(baselineRows);
  const challenger = summarizePrc1Trades(challengerRows);
  return {
    baseline,
    challenger,
    difference: {
      closedTrades: challenger.closedTrades - baseline.closedTrades,
      netPnlUsdt: challenger.netPnlUsdt - baseline.netPnlUsdt,
      netProfit: challenger.netProfit - baseline.netProfit,
      netLoss: challenger.netLoss - baseline.netLoss,
      profitFactor: difference(challenger.profitFactor, baseline.profitFactor),
      winRate: challenger.winRate - baseline.winRate,
      avgPnl: challenger.avgPnl - baseline.avgPnl,
      avgR: challenger.avgR - baseline.avgR,
      maxDrawdown: challenger.maxDrawdown - baseline.maxDrawdown,
      grossProfit: challenger.grossProfit - baseline.grossProfit,
      grossLoss: challenger.grossLoss - baseline.grossLoss,
      largestWinningTrade: challenger.largestWinningTrade - baseline.largestWinningTrade,
      grossProfitContributionLargestTradePct:
        challenger.grossProfitContributionLargestTradePct - baseline.grossProfitContributionLargestTradePct,
    },
  };
}

export function summarizePrc1Trades(rows: Prc1ForwardTradeRow[]): Prc1PerformanceMetrics {
  const closedRows = rows.filter((row) => {
    if (row.status === "OPEN") {
      if (row.exit_time !== null) {
        throw new Error(`DATA_INVALID: OPEN trade ${String(row.id)} has an exit_time`);
      }
      return false;
    }
    if (row.exit_time === null) {
      throw new Error(`DATA_INVALID: closed trade ${String(row.id)} has no exit_time`);
    }
    return true;
  });

  const orderedClosedRows = [...closedRows].sort(compareTradeChronology);
  const closed = orderedClosedRows.map((row) => {
    const pnl = finiteNumber(row.net_pnl_usdt);
    const r = finiteNumber(row.r_multiple);
    if (pnl === null) throw new Error(`DATA_INVALID: closed trade ${String(row.id)} has invalid net_pnl_usdt`);
    if (r === null) throw new Error(`DATA_INVALID: closed trade ${String(row.id)} has invalid r_multiple`);
    const grossValue = finiteNumber(row.gross_pnl_usdt);
    return {
      pnl,
      gross: grossValue ?? pnl,
      r,
    };
  });

  const netPnlUsdt = closed.reduce((total, row) => total + row.pnl, 0);
  const netProfit = closed.reduce((total, row) => total + Math.max(0, row.pnl), 0);
  const netLoss = closed.reduce((total, row) => total + Math.max(0, -row.pnl), 0);
  const grossProfit = closed.reduce((total, row) => total + Math.max(0, row.gross), 0);
  const grossLoss = closed.reduce((total, row) => total + Math.max(0, -row.gross), 0);
  const wins = closed.filter((row) => row.pnl > 0).length;
  const avgR = closed.length === 0
    ? 0
    : closed.reduce((total, row) => total + row.r, 0) / closed.length;
  const largestWinningTrade = closed.reduce((largest, row) => Math.max(largest, row.gross), 0);
  const grossProfitContributionLargestTradePct = grossProfit === 0
    ? 0
    : largestWinningTrade / grossProfit * 100;
  const equity = closed.reduce<number[]>((values, row) => {
    values.push((values.at(-1) ?? 0) + row.pnl);
    return values;
  }, []);
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  const grossMetrics: Prc1GrossDiagnostics = {
    diagnosticOnly: true,
    grossProfit,
    grossLoss,
    largestWinningTrade,
    grossProfitContributionLargestTradePct,
  };

  return {
    closedTrades: closed.length,
    netPnlUsdt,
    netProfit,
    netLoss,
    profitFactor: netLoss === 0 ? (netProfit > 0 ? Number.POSITIVE_INFINITY : 0) : netProfit / netLoss,
    winRate: closed.length === 0 ? 0 : wins / closed.length,
    avgPnl: closed.length === 0 ? 0 : netPnlUsdt / closed.length,
    avgR,
    maxDrawdown,
    grossProfit,
    grossLoss,
    largestWinningTrade,
    grossProfitContributionLargestTradePct,
    grossMetrics,
  };
}

function compareTradeChronology(left: Prc1ForwardTradeRow, right: Prc1ForwardTradeRow): number {
  const entryOrder = compareTimestamp(left.entry_time, right.entry_time, "entry_time");
  if (entryOrder !== 0) return entryOrder;
  const exitOrder = compareTimestamp(left.exit_time, right.exit_time, "exit_time");
  if (exitOrder !== 0) return exitOrder;
  return compareId(left.id, right.id);
}

function compareTimestamp(left: string | null, right: string | null, field: string): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    throw new Error(`DATA_INVALID: invalid ${field} in forward trade chronology`);
  }
  return leftMs - rightMs;
}

function compareId(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function difference(left: number, right: number): number {
  if (left === right || (left === Number.POSITIVE_INFINITY && right === Number.POSITIVE_INFINITY)) return 0;
  return left - right;
}
