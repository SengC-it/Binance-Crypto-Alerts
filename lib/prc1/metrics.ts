import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRC1_BASELINE_STRATEGY_VERSION,
  PRC1_CHALLENGER_STRATEGY_VERSION,
  PRC1_HYPOTHESIS_FROZEN_AT_UTC,
} from "./contract";

export interface Prc1ForwardTradeRow {
  strategy_version: string;
  entry_time: string;
  exit_time: string | null;
  status: string;
  net_pnl_usdt: number | null;
  gross_pnl_usdt?: number | null;
  r_multiple: number | null;
}

export interface Prc1PerformanceMetrics {
  closedTrades: number;
  netPnlUsdt: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  winRate: number;
  avgPnl: number;
  avgR: number;
  maxDrawdown: number;
  largestWinningTrade: number;
  grossProfitContributionLargestTradePct: number;
}

export interface Prc1PerformanceDifference {
  netPnlUsdt: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  winRate: number;
  avgPnl: number;
  avgR: number;
  maxDrawdown: number;
  largestWinningTrade: number;
  grossProfitContributionLargestTradePct: number;
  closedTrades: number;
}

export interface Prc1ForwardComparison {
  baseline: Prc1PerformanceMetrics;
  challenger: Prc1PerformanceMetrics;
  difference: Prc1PerformanceDifference;
}

export async function loadPrc1ForwardComparison(
  supabase: SupabaseClient,
  hypothesisFrozenAtUtc = PRC1_HYPOTHESIS_FROZEN_AT_UTC,
): Promise<Prc1ForwardComparison> {
  const { data, error } = await supabase
    .from("bca_shadow_paper_trades")
    .select("strategy_version,entry_time,exit_time,status,net_pnl_usdt,gross_pnl_usdt,r_multiple")
    .in("strategy_version", [PRC1_BASELINE_STRATEGY_VERSION, PRC1_CHALLENGER_STRATEGY_VERSION])
    .gte("entry_time", hypothesisFrozenAtUtc);
  if (error) throw new Error(`PRC-1 forward comparison lookup failed: ${error.message}`);

  const rows = (data ?? []) as Prc1ForwardTradeRow[];
  return comparePrc1ForwardTrades(
    rows.filter((row) => row.strategy_version === PRC1_BASELINE_STRATEGY_VERSION),
    rows.filter((row) => row.strategy_version === PRC1_CHALLENGER_STRATEGY_VERSION),
  );
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
      grossProfit: challenger.grossProfit - baseline.grossProfit,
      grossLoss: challenger.grossLoss - baseline.grossLoss,
      profitFactor: difference(challenger.profitFactor, baseline.profitFactor),
      winRate: challenger.winRate - baseline.winRate,
      avgPnl: challenger.avgPnl - baseline.avgPnl,
      avgR: challenger.avgR - baseline.avgR,
      maxDrawdown: challenger.maxDrawdown - baseline.maxDrawdown,
      largestWinningTrade: challenger.largestWinningTrade - baseline.largestWinningTrade,
      grossProfitContributionLargestTradePct:
        challenger.grossProfitContributionLargestTradePct - baseline.grossProfitContributionLargestTradePct,
    },
  };
}

export function summarizePrc1Trades(rows: Prc1ForwardTradeRow[]): Prc1PerformanceMetrics {
  const closed = rows
    .filter((row) => row.status !== "OPEN" && row.exit_time !== null)
    .map((row) => ({
      pnl: row.net_pnl_usdt === null || row.net_pnl_usdt === undefined ? Number.NaN : Number(row.net_pnl_usdt),
      gross: row.gross_pnl_usdt === null || row.gross_pnl_usdt === undefined ? Number.NaN : Number(row.gross_pnl_usdt),
      r: row.r_multiple === null || row.r_multiple === undefined ? Number.NaN : Number(row.r_multiple),
    }))
    .map((row) => ({ ...row, gross: Number.isFinite(row.gross) ? row.gross : row.pnl }))
    .filter((row) => Number.isFinite(row.pnl));
  const netPnlUsdt = closed.reduce((total, row) => total + row.pnl, 0);
  const grossProfit = closed.reduce((total, row) => total + Math.max(0, row.gross), 0);
  const grossLoss = closed.reduce((total, row) => total + Math.max(0, -row.gross), 0);
  const wins = closed.filter((row) => row.pnl > 0).length;
  const rValues = closed.filter((row) => Number.isFinite(row.r)).map((row) => row.r);
  const largestWinningTrade = closed.reduce((largest, row) => Math.max(largest, row.gross), 0);
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

  return {
    closedTrades: closed.length,
    netPnlUsdt,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0) : grossProfit / grossLoss,
    winRate: closed.length === 0 ? 0 : wins / closed.length,
    avgPnl: closed.length === 0 ? 0 : netPnlUsdt / closed.length,
    avgR: rValues.length === 0 ? 0 : rValues.reduce((total, value) => total + value, 0) / rValues.length,
    maxDrawdown,
    largestWinningTrade,
    grossProfitContributionLargestTradePct: grossProfit === 0 ? 0 : largestWinningTrade / grossProfit * 100,
  };
}

function difference(left: number, right: number): number {
  if (left === right || (left === Number.POSITIVE_INFINITY && right === Number.POSITIVE_INFINITY)) return 0;
  return left - right;
}
