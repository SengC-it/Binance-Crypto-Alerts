import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeDegradationTrades, type DegradationFeatures, type DegradationForwardEvidence, type DegradationTrade } from "@/lib/analysis/degradation";
import { DEFAULT_STRATEGY_HEALTH_POLICY, evaluateStrategyHealth } from "@/lib/core/strategy-health";
import { PRODUCTION_STRATEGY_VERSION } from "@/lib/core/production-policy";

const FULL_REPORT = resolve("reports", "degradation-analysis-1y.json");
const SUMMARY_REPORT = resolve("reports", "degradation-analysis-summary.json");

async function main() {
  await loadLocalEnv();
  const inputPath = cliInputPath();
  let source: { kind: "SUPABASE" | "EXPORT" | "NONE"; location?: string; rows: number; reason?: string };
  let trades: DegradationTrade[] = [];

  if (inputPath && await exists(inputPath)) {
    trades = await loadExport(inputPath);
    source = { kind: "EXPORT", location: inputPath, rows: trades.length };
  } else {
    const result = await loadFromSupabase();
    trades = result.trades;
    source = result.source;
  }

  const report = analyzeDegradationTrades(
    trades,
    PRODUCTION_STRATEGY_VERSION,
    source.kind === "NONE" ? "DATA_UNAVAILABLE" : trades.length === 0 ? "EMPTY" : "AVAILABLE",
  );
  const health = evaluateStrategyHealth(
    trades.map((trade) => ({
      rMultiple: trade.rMultiple,
      exitReason: trade.exitReason,
      entryTime: trade.entryTime,
    })),
    [],
    DEFAULT_STRATEGY_HEALTH_POLICY,
  );
  const output = {
    ...report,
    source,
    strategyHealth: health,
    acceptanceSafety: {
      signalOnly: true,
      automaticTrading: false,
      automaticStrategySwitch: false,
      permanentSymbolBlacklist: false,
      productionAEmailAllowed: health.productionAAllowed,
    },
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(FULL_REPORT, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(SUMMARY_REPORT, JSON.stringify({
    schemaVersion: output.schemaVersion,
    generatedAt: new Date().toISOString(),
    strategyVersion: output.strategyVersion,
    source: output.source,
    overall: output.overall,
    sampleCaveat: output.sampleCaveat,
    sourceStatus: output.sourceStatus,
    breakdowns: output.breakdowns,
    strategyHealth: output.strategyHealth,
    rootCauseAssessment: output.rootCauseAssessment,
    acceptanceSafety: output.acceptanceSafety,
  }, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    fullReport: FULL_REPORT,
    summaryReport: SUMMARY_REPORT,
    source,
    overall: output.overall,
    strategyHealth: output.strategyHealth.status,
    rootCauses: output.rootCauseAssessment.findings,
  }, null, 2));
}

async function loadExport(path: string): Promise<DegradationTrade[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.trades)
      ? raw.trades
      : isRecord(raw) && Array.isArray(raw.rows)
        ? raw.rows
        : [];
  return rows.map((row) => normalizeTrade(row)).filter((row): row is DegradationTrade => row !== null);
}

async function loadFromSupabase(): Promise<{
  trades: DegradationTrade[];
  source: { kind: "SUPABASE" | "NONE"; location?: string; rows: number; reason?: string };
}> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || key.startsWith("[SENSITIVE") || key.length < 30) {
    return {
      trades: [],
      source: {
        kind: "NONE",
        rows: 0,
        reason: "No usable Supabase service key and no immutable export was supplied.",
      },
    };
  }
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await queryProductionTrades(client);
  if (result.error) {
    return {
      trades: [],
      source: {
        kind: "NONE",
        location: url,
        rows: 0,
        reason: "Supabase read failed: " + result.error,
      },
    };
  }
  return {
    trades: result.rows,
    source: { kind: "SUPABASE", location: url, rows: result.rows.length },
  };
}

async function queryProductionTrades(client: SupabaseClient): Promise<{ rows: DegradationTrade[]; error?: string }> {
  const { data, error } = await client
    .from("bca_paper_trades")
    // Keep this projection compatible with the original paper-trade schema;
    // V5 trace columns are optional and are read from metadata when present.
    .select("id,symbol,side,strategy_version,status,entry_time,exit_time,exit_reason,entry_price,stop_price,net_pnl_usdt,r_multiple,theoretical_risk_usdt,metadata")
    .eq("strategy_version", PRODUCTION_STRATEGY_VERSION)
    .not("exit_time", "is", null)
    .order("entry_time", { ascending: true })
    .limit(1000);
  if (error) return { rows: [], error: error.message };
  return {
    rows: (data ?? []).map((row) => normalizeTrade(row)).filter((row): row is DegradationTrade => row !== null),
  };
}

function normalizeTrade(input: unknown): DegradationTrade | null {
  if (!isRecord(input)) return null;
  const metadata = recordValue(input.metadata);
  const candidate = recordValue(metadata?.candidate) ?? recordValue(input.candidate);
  const edge = recordValue(metadata?.entry_edge_features)
    ?? recordValue(metadata?.entryEdgeFeatures)
    ?? recordValue(candidate?.entryEdgeFeatures);
  const candidateNoChase = recordValue(candidate?.noChase);
  const noChase = recordValue(metadata?.no_chase_features)
    ?? recordValue(metadata?.noChaseFeatures)
    ?? recordValue(candidateNoChase?.features);
  const rMultiple = numberValue(input.r_multiple)
    ?? (() => {
      const pnl = numberValue(input.net_pnl_usdt);
      const risk = numberValue(input.theoretical_risk_usdt);
      return pnl !== null && risk !== null && risk > 0 ? pnl / risk : null;
    })();
  if (rMultiple === null) return null;
  const features: DegradationFeatures = {
    marketState: optionalString(stringValue(input.market_state) ?? stringValue(metadata?.market_state) ?? stringValue(candidate?.marketState)),
    btcRegime: optionalString(stringValue(metadata?.btc_regime) ?? stringValue(recordValue(metadata?.global_market_state)?.btcRegime)),
    ethRegime: optionalString(stringValue(metadata?.eth_regime) ?? stringValue(recordValue(metadata?.global_market_state)?.ethRegime)),
    breadth: optionalNumber(numberValue(metadata?.breadth) ?? numberValue(recordValue(metadata?.global_market_state)?.breadth)),
    score: optionalNumber(numberValue(input.score) ?? numberValue(metadata?.score) ?? numberValue(candidate?.score)),
    symbol: optionalString(stringValue(input.symbol)),
    entryExtensionAtr: optionalNumber(numberValue(edge?.breakoutExtensionAtr) ?? numberValue(noChase?.breakoutExtensionAtr)),
    distanceToEma: optionalNumber(numberValue(edge?.distanceFromFastEmaAtr) ?? numberValue(noChase?.distanceToFastEmaAtr)),
    pullbackDepth: optionalNumber(numberValue(noChase?.pullbackDepth)),
    rsi: optionalNumber(numberValue(edge?.rsi) ?? numberValue(noChase?.rsi)),
    volumeRatio: optionalNumber(numberValue(noChase?.volumeRatio)),
    fundingCost: optionalNumber(numberValue(metadata?.projected_funding_cost_risk_fraction)),
    stopDistance: stopDistance(input),
    setupAge: optionalNumber(numberValue(edge?.setupAgeBars)),
  };
  const forward = normalizeForward(recordValue(metadata?.forward) ?? recordValue(input.forward));
  return {
    id: stringValue(input.id) ?? undefined,
    symbol: stringValue(input.symbol) ?? "UNKNOWN",
    side: stringValue(input.side) === "LONG" || stringValue(input.side) === "SHORT"
      ? stringValue(input.side) as "LONG" | "SHORT"
      : undefined,
    strategyVersion: stringValue(input.strategy_version) ?? undefined,
    status: stringValue(input.status) ?? undefined,
    entryTime: dateValue(input.entry_time),
    exitTime: dateValue(input.exit_time),
    exitReason: stringValue(input.exit_reason),
    rMultiple,
    netPnlUsdt: numberValue(input.net_pnl_usdt),
    features,
    forward,
  };
}

function normalizeForward(value: Record<string, unknown> | undefined): DegradationForwardEvidence | undefined {
  if (!value) return undefined;
  const h24 = recordValue(value.horizon24h);
  const h72 = recordValue(value.horizon72h);
  return {
    mfe24h: numberValue(h24?.maxFavorableR) ?? numberValue(value.mfe24h),
    mae24h: numberValue(h24?.maxAdverseR) ?? numberValue(value.mae24h),
    mfe72h: numberValue(h72?.maxFavorableR) ?? numberValue(value.mfe72h),
    mae72h: numberValue(h72?.maxAdverseR) ?? numberValue(value.mae72h),
    halfRBeforeStop: booleanValue(h24?.pPositiveHalfRBeforeStop) ?? booleanValue(value.halfRBeforeStop),
    oneRBeforeStop: booleanValue(h24?.pPositiveOneRBeforeStop) ?? booleanValue(value.oneRBeforeStop),
  };
}

function stopDistance(input: Record<string, unknown>): number | undefined {
  const entry = numberValue(input.entry_price);
  const stop = numberValue(input.stop_price);
  if (entry === null || stop === null || entry === 0) return undefined;
  return Math.abs(entry - stop) / entry;
}

async function loadLocalEnv(): Promise<void> {
  const path = resolve(".env.local");
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
  } catch {
    // A deployment/export runner may already provide its environment.
  }
}

function cliInputPath(): string | undefined {
  const index = process.argv.indexOf("--input");
  return index >= 0 ? process.argv[index + 1] : process.env.BCA_DEGRADATION_DATASET;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNumber(value: number | null): number | undefined {
  return value ?? undefined;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function dateValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
