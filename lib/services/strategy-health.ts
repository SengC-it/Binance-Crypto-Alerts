import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_STRATEGY_HEALTH_POLICY,
  evaluateStrategyHealth,
  type StrategyHealthDecision,
  type StrategyHealthPolicy,
  type StrategyHealthTrade,
} from "@/lib/core/strategy-health";

export async function loadProspectiveStrategyHealth(
  supabase: SupabaseClient,
  strategyVersion: string,
  options: {
    policy?: StrategyHealthPolicy;
    timeoutMs?: number;
  } = {},
): Promise<StrategyHealthDecision> {
  const policy = options.policy ?? DEFAULT_STRATEGY_HEALTH_POLICY;
  const load = async () => {
    const rolling = await loadSettledTrades(supabase, strategyVersion, policy.rollingWindowTrades);
    if (rolling.error) return unknownHealth(policy, rolling.error);
    const historical = await loadSettledTrades(
      supabase,
      strategyVersion,
      policy.historicalWindowTrades,
      policy.rollingWindowTrades,
    );
    if (historical.error) return unknownHealth(policy, historical.error);
    return evaluateStrategyHealth(rolling.rows, historical.rows, policy);
  };
  try {
    return await withTimeout(load(), options.timeoutMs ?? 5_000);
  } catch {
    return unknownHealth(policy, "health_query_failed_or_timed_out");
  }
}

async function loadSettledTrades(
  supabase: SupabaseClient,
  strategyVersion: string,
  limit: number,
  offset = 0,
): Promise<{ rows: StrategyHealthTrade[]; error?: string }> {
  const { data, error } = await supabase
    .from("bca_paper_trades")
    .select("strategy_version,entry_time,exit_time,exit_reason,r_multiple,net_pnl_usdt,theoretical_risk_usdt")
    .eq("strategy_version", strategyVersion)
    .not("exit_time", "is", null)
    .order("entry_time", { ascending: false })
    .range(offset, offset + Math.max(1, limit) - 1);
  if (error) return { rows: [], error: "health_query_failed: " + error.message };
  return {
    rows: (data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      const rMultiple = toNumber(record.r_multiple)
        ?? (() => {
          const pnl = toNumber(record.net_pnl_usdt);
          const risk = toNumber(record.theoretical_risk_usdt);
          return pnl !== null && risk !== null && risk > 0 ? pnl / risk : null;
        })();
      return {
        rMultiple: rMultiple ?? Number.NaN,
        exitReason: typeof record.exit_reason === "string" ? record.exit_reason : null,
        entryTime: Date.parse(String(record.entry_time ?? "")),
      };
    }).filter((trade) => Number.isFinite(trade.rMultiple)),
  };
}

function unknownHealth(policy: StrategyHealthPolicy, reason: string): StrategyHealthDecision {
  return {
    status: "UNKNOWN",
    productionAAllowed: false,
    reasons: [reason],
    metrics: {
      rollingTrades: 0,
      rollingAverageNetR: 0,
      rollingProfitFactor: 0,
      rollingStopRate: 0,
      rollingMaxDrawdownR: 0,
      rollingLowerConfidenceBound: 0,
      historicalTrades: 0,
      historicalAverageNetR: null,
      recentVsHistoricalDrift: null,
    },
    policy,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health query timeout")), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
