import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency, BinancePublicClient } from "@/lib/binance/public-client";
import type { Candle, FundingRatePoint, ScoredCandidate, TradePlan } from "@/lib/core/types";
import { isTransientSupabaseError, runQuery } from "@/lib/supabase/resilience";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const PRODUCTION_PAPER_TABLE = "bca_paper_trades";
const SHADOW_PAPER_TABLE = "bca_shadow_paper_trades";
type PaperTable = typeof PRODUCTION_PAPER_TABLE | typeof SHADOW_PAPER_TABLE;

export interface PaperTradeCreateInput {
  signalId: string;
  symbol: string;
  candidate: ScoredCandidate;
  plan: TradePlan;
  strategyVersion: string;
  sourceTimestamp: number;
  slippageBps: number;
}

interface PaperTradeRecord {
  id: string;
  table: PaperTable;
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  entryPrice: number;
  entryFillPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  maxHoldUntil: number;
  quantity: number;
  theoreticalRiskUsdt: number;
  lastCandleCloseTime?: number;
}

interface MarketHistory {
  candles: Candle[];
  fundingRates: FundingRatePoint[];
  error?: string;
}

export interface PaperSettlementOptions {
  takerFeeRate: number;
  slippageBps: number;
  requestConcurrency: number;
  batchSize: number;
}

export interface PaperSettlementSummary {
  openTrades: number;
  productionOpenTrades: number;
  shadowOpenTrades: number;
  checked: number;
  settled: number;
  stillOpen: number;
  errors: Array<{ symbol: string; message: string }>;
}

/**
 * Thrown when the paper-trading ledger cannot be read at all after retries.
 * Callers can use this to distinguish "the database is unreachable" (worth a
 * system alert) from "one trade failed to settle" (routine, per-trade error).
 */
export class PaperLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperLedgerUnavailableError";
  }
}

export async function createPaperTrade(
  supabase: SupabaseClient,
  input: PaperTradeCreateInput,
): Promise<boolean> {
  return insertPaperTrade(supabase, PRODUCTION_PAPER_TABLE, input, { signal_id: input.signalId });
}

export async function createShadowPaperTrade(
  supabase: SupabaseClient,
  input: Omit<PaperTradeCreateInput, "signalId">,
  cooldownHours: number,
): Promise<boolean> {
  const openCount = await runQuery(
    "shadow position lookup",
    () => supabase
      .from(SHADOW_PAPER_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("status", "OPEN"),
  ).catch((error) => {
    throw new Error(`Shadow position lookup failed: ${errorMessage(error)}`);
  });
  if (typeof openCount === "number" ? openCount >= 1 : false) return false;

  const lastTrade = await runQuery(
    "shadow cooldown lookup",
    () => supabase
      .from(SHADOW_PAPER_TABLE)
      .select("exit_time")
      .eq("symbol", input.symbol)
      .not("exit_time", "is", null)
      .order("exit_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ).catch((error) => {
    throw new Error(`Shadow cooldown lookup failed: ${errorMessage(error)}`);
  });
  if (lastTrade?.exit_time) {
    const cooldownUntil = Date.parse(lastTrade.exit_time as string) + cooldownHours * 60 * 60 * 1000;
    if (input.sourceTimestamp < cooldownUntil) return false;
  }

  return insertPaperTrade(supabase, SHADOW_PAPER_TABLE, input);
}

async function insertPaperTrade(
  supabase: SupabaseClient,
  table: PaperTable,
  input: Omit<PaperTradeCreateInput, "signalId">,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const direction = input.candidate.side === "LONG" ? 1 : -1;
  const entryFillPrice = adverseFill(input.plan.entryPrice, direction, input.slippageBps / 10_000, "entry");
  let data: { id: string } | null;
  try {
    data = await runQuery(
      `paper trade creation (${table})`,
      () => supabase
        .from(table)
        .insert({
          ...extra,
          symbol: input.symbol,
          side: input.candidate.side,
          strategy_family: input.candidate.strategyFamily,
          strategy_version: input.strategyVersion,
          entry_time: new Date(input.sourceTimestamp).toISOString(),
          entry_price: input.plan.entryPrice,
          entry_fill_price: entryFillPrice,
          stop_price: input.plan.stopPrice,
          take_profit_price: input.plan.takeProfitPrice,
          max_hold_until: new Date(input.plan.validUntil).toISOString(),
          quantity: input.plan.quantity,
          assumed_margin_usdt: input.plan.assumedMarginUsdt,
          assumed_leverage: input.plan.assumedLeverage,
          position_notional_usdt: input.plan.positionNotionalUsdt,
          theoretical_risk_usdt: input.plan.theoreticalRiskUsdt,
          last_price: entryFillPrice,
          metadata: {
            source_data_timestamp: new Date(input.sourceTimestamp).toISOString(),
            entry_model: "just_closed_15m_reference",
            slippage_bps: input.slippageBps,
          },
        })
        .select("id")
        .maybeSingle(),
    );
  } catch (error) {
    // A duplicate signal already has a paper trade; treat it as a no-op.
    if ((error as { code?: string }).code === "23505") return false;
    throw new Error(`Paper trade creation failed: ${errorMessage(error)}`);
  }

  if (!data) throw new Error("Paper trade creation failed: empty response");
  return true;
}

export async function settleOpenPaperTrades(
  supabase: SupabaseClient,
  client: BinancePublicClient,
  options: PaperSettlementOptions,
): Promise<PaperSettlementSummary> {
  // Read both ledgers independently. A persistent failure in one table must not
  // stop the other from settling, and must not be misreported as a per-trade error.
  const [productionResult, shadowResult] = await Promise.all([
    readOpenPaperTrades(supabase, PRODUCTION_PAPER_TABLE, options.batchSize),
    readOpenPaperTrades(supabase, SHADOW_PAPER_TABLE, options.batchSize),
  ]);

  if (productionResult.fatal && shadowResult.fatal) {
    throw new PaperLedgerUnavailableError(
      `Paper trade lookup failed after retries: ${productionResult.fatal}`,
    );
  }

  const productionTrades = productionResult.trades;
  const shadowTrades = shadowResult.trades;
  const openTrades = [...productionTrades, ...shadowTrades].slice(0, options.batchSize);
  const summary: PaperSettlementSummary = {
    openTrades: openTrades.length,
    productionOpenTrades: productionTrades.length,
    shadowOpenTrades: shadowTrades.length,
    checked: 0,
    settled: 0,
    stillOpen: 0,
    errors: [],
  };
  for (const result of [productionResult, shadowResult]) {
    if (result.fatal) summary.errors.push({ symbol: "-", message: result.fatal });
  }
  if (openTrades.length === 0) return summary;

  const latestClosedCandleTime = Math.floor(Date.now() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS - 1;
  const symbols = [...new Set(openTrades.map((trade) => trade.symbol))];
  const historyBySymbol = new Map<string, MarketHistory>();
  await mapWithConcurrency(symbols, options.requestConcurrency, async (symbol) => {
    const symbolTrades = openTrades.filter((trade) => trade.symbol === symbol);
    const startTime = Math.min(...symbolTrades.map((trade) => trade.entryTime)) + 1;
    if (startTime > latestClosedCandleTime) {
      historyBySymbol.set(symbol, { candles: [], fundingRates: [] });
      return symbol;
    }
    try {
      const [candles, fundingRates] = await Promise.all([
        client.getCandlesRange(symbol, "15m", startTime, latestClosedCandleTime),
        client.getFundingRatesRange(symbol, startTime, latestClosedCandleTime),
      ]);
      historyBySymbol.set(symbol, { candles, fundingRates });
    } catch (error) {
      historyBySymbol.set(symbol, {
        candles: [],
        fundingRates: [],
        error: errorMessage(error),
      });
    }
    return symbol;
  });

  for (const trade of openTrades) {
    summary.checked += 1;
    const history = historyBySymbol.get(trade.symbol);
    if (!history || history.error) {
      const message = history?.error ?? "No market history was returned";
      summary.errors.push({ symbol: trade.symbol, message });
      await updatePaperTrade(supabase, trade.table, trade.id, {
        last_checked_at: new Date().toISOString(),
        settlement_error: message,
      });
      continue;
    }

    const result = resolvePaperTrade(trade, history.candles, history.fundingRates, options);
    try {
      await updatePaperTrade(supabase, trade.table, trade.id, result.patch);
      if (result.closed) summary.settled += 1;
      else summary.stillOpen += 1;
    } catch (error) {
      const message = errorMessage(error);
      summary.errors.push({ symbol: trade.symbol, message });
      await updatePaperTrade(supabase, trade.table, trade.id, {
        last_checked_at: new Date().toISOString(),
        settlement_error: message,
      });
    }
  }

  return summary;
}

async function listOpenPaperTrades(
  supabase: SupabaseClient,
  table: PaperTable,
  batchSize: number,
): Promise<PaperTradeRecord[]> {
  const rows = await runQuery(
    `paper trade lookup (${table})`,
    () => supabase
      .from(table)
      .select("*")
      .eq("status", "OPEN")
      .order("entry_time", { ascending: true })
      .limit(batchSize),
  );
  return (rows ?? []).map((row) => parsePaperTrade(row as Record<string, unknown>, table));
}

/**
 * Reads one ledger without letting its failure abort the whole settlement pass.
 * A transient error that survived retries is reported as `fatal` so the caller
 * can decide whether to escalate; a malformed row is reported as a normal
 * per-trade error.
 */
async function readOpenPaperTrades(
  supabase: SupabaseClient,
  table: PaperTable,
  batchSize: number,
): Promise<{ trades: PaperTradeRecord[]; fatal?: string }> {
  try {
    return { trades: await listOpenPaperTrades(supabase, table, batchSize) };
  } catch (error) {
    const message = errorMessage(error);
    if (isTransientSupabaseError(error)) {
      return { trades: [], fatal: message };
    }
    throw error;
  }
}

function resolvePaperTrade(
  trade: PaperTradeRecord,
  candles: Candle[],
  fundingRates: FundingRatePoint[],
  options: PaperSettlementOptions,
): { closed: boolean; patch: Record<string, unknown> } {
  const lastCheckedAt = new Date().toISOString();
  const eligibleCandles = candles
    .filter((candle) => candle.closeTime > (trade.lastCandleCloseTime ?? trade.entryTime))
    .sort((left, right) => left.closeTime - right.closeTime);

  for (const candle of eligibleCandles) {
    const stopHit = trade.side === "LONG" ? candle.low <= trade.stopPrice : candle.high >= trade.stopPrice;
    const takeProfitHit = trade.side === "LONG"
      ? candle.high >= trade.takeProfitPrice
      : candle.low <= trade.takeProfitPrice;

    // OHLC data cannot reveal the intrabar path, so keep the conservative
    // stop-first rule used by the backtest engine.
    if (stopHit) {
      return {
        closed: true,
        patch: closePatch(trade, candle, trade.stopPrice, "STOP_LOSS", fundingRates, options),
      };
    }
    if (takeProfitHit) {
      return {
        closed: true,
        patch: closePatch(trade, candle, trade.takeProfitPrice, "TAKE_PROFIT", fundingRates, options),
      };
    }
    if (candle.closeTime >= trade.maxHoldUntil) {
      return {
        closed: true,
        patch: closePatch(trade, candle, candle.close, "TIME_LIMIT", fundingRates, options),
      };
    }
  }

  const latest = eligibleCandles.at(-1);
  if (!latest) {
    return {
      closed: false,
      patch: { last_checked_at: lastCheckedAt, settlement_error: null },
    };
  }

  const direction = trade.side === "LONG" ? 1 : -1;
  const unrealizedPnlUsdt = (latest.close - trade.entryFillPrice) * direction * trade.quantity;
  return {
    closed: false,
    patch: {
      status: "OPEN",
      last_price: latest.close,
      last_candle_close_time: new Date(latest.closeTime).toISOString(),
      last_checked_at: lastCheckedAt,
      unrealized_pnl_usdt: round(unrealizedPnlUsdt, 8),
      settlement_error: null,
    },
  };
}

function closePatch(
  trade: PaperTradeRecord,
  candle: Candle,
  rawExitPrice: number,
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_LIMIT",
  fundingRates: FundingRatePoint[],
  options: PaperSettlementOptions,
): Record<string, unknown> {
  const direction = trade.side === "LONG" ? 1 : -1;
  const slippageRate = options.slippageBps / 10_000;
  const exitFillPrice = adverseFill(rawExitPrice, direction, slippageRate, "exit");
  const grossPnlUsdt = (exitFillPrice - trade.entryFillPrice) * direction * trade.quantity;
  const feesUsdt = (Math.abs(trade.entryFillPrice * trade.quantity) + Math.abs(exitFillPrice * trade.quantity)) * options.takerFeeRate;
  const fundingUsdt = calculateFunding(
    fundingRates,
    trade.entryTime,
    candle.closeTime,
    trade.entryFillPrice * trade.quantity,
    direction,
  );
  const rawGrossPnlUsdt = (rawExitPrice - trade.entryPrice) * direction * trade.quantity;
  const slippageUsdt = Math.max(0, rawGrossPnlUsdt - grossPnlUsdt);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;

  return {
    status: exitReason,
    last_price: exitFillPrice,
    last_candle_close_time: new Date(candle.closeTime).toISOString(),
    last_checked_at: new Date().toISOString(),
    unrealized_pnl_usdt: 0,
    exit_time: new Date(candle.closeTime).toISOString(),
    exit_price: exitFillPrice,
    exit_reason: exitReason,
    gross_pnl_usdt: round(grossPnlUsdt, 8),
    fees_usdt: round(feesUsdt, 8),
    funding_usdt: round(fundingUsdt, 8),
    slippage_usdt: round(slippageUsdt, 8),
    net_pnl_usdt: round(netPnlUsdt, 8),
    r_multiple: trade.theoreticalRiskUsdt === 0 ? 0 : round(netPnlUsdt / trade.theoreticalRiskUsdt, 8),
    settlement_error: null,
  };
}

async function updatePaperTrade(
  supabase: SupabaseClient,
  table: PaperTable,
  tradeId: string,
  patch: Record<string, unknown>,
) {
  await runQuery(
    `paper trade update (${table})`,
    () => supabase
      .from(table)
      .update(patch)
      .eq("id", tradeId)
      .eq("status", "OPEN")
      .select("id"),
  );
}

function parsePaperTrade(row: Record<string, unknown>, table: PaperTable): PaperTradeRecord {
  return {
    id: requiredString(row, "id"),
    table,
    symbol: requiredString(row, "symbol"),
    side: requiredString(row, "side") as PaperTradeRecord["side"],
    entryTime: requiredTimestamp(row, "entry_time"),
    entryPrice: requiredNumber(row, "entry_price"),
    entryFillPrice: requiredNumber(row, "entry_fill_price"),
    stopPrice: requiredNumber(row, "stop_price"),
    takeProfitPrice: requiredNumber(row, "take_profit_price"),
    maxHoldUntil: requiredTimestamp(row, "max_hold_until"),
    quantity: requiredNumber(row, "quantity"),
    theoreticalRiskUsdt: requiredNumber(row, "theoretical_risk_usdt"),
    lastCandleCloseTime: optionalTimestamp(row, "last_candle_close_time"),
  };
}

function calculateFunding(
  fundingRates: FundingRatePoint[],
  entryTime: number,
  exitTime: number,
  notionalUsdt: number,
  direction: number,
): number {
  return fundingRates
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notionalUsdt * point.fundingRate, 0);
}

function adverseFill(
  price: number,
  direction: number,
  slippageRate: number,
  phase: "entry" | "exit",
): number {
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageRate);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid paper trade ${key}`);
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid paper trade ${key}`);
  return value;
}

function requiredTimestamp(row: Record<string, unknown>, key: string): number {
  const value = Date.parse(requiredString(row, key));
  if (!Number.isFinite(value)) throw new Error(`Invalid paper trade ${key}`);
  return value;
}

function optionalTimestamp(row: Record<string, unknown>, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  const value = Date.parse(String(row[key]));
  return Number.isFinite(value) ? value : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
