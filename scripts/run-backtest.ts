import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBacktest } from "@/lib/backtest/engine";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { BinancePublicClient, mapWithConcurrency } from "@/lib/binance/public-client";
import { DEFAULT_STRATEGY_PARAMS } from "@/lib/core/strategies";
import type { Instrument } from "@/lib/core/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];

const INITIAL_CAPITAL_USDT = 10_000;
const MARGIN_USDT = 100;
const LEVERAGE = 20;
const SINGLE_SIGNAL_RISK_CAP_USDT = 100;
const DAILY_RISK_BUDGET_USDT = 600;
const DAILY_EMAIL_CAP = 10;
const SCAN_EMAIL_CAP = 6;
const MAX_HOLD_HOURS = 72;

interface PortfolioMetrics {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  pricePnlBeforeExecutionCostsUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  finalEquityUsdt: number;
  initialCapitalUsdt: number;
}

async function main() {
  const now = Date.now();
  const currentBucketOpen = Math.floor(now / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
  const windowEnd = currentBucketOpen - 1;
  const windowStart = currentBucketOpen - 365 * DAY;
  const warmupStart = windowStart - 14 * DAY;
  const minScore = numberEnv("CS_BACKTEST_MIN_SCORE", 60);
  const takerFeeRate = numberEnv("CS_BACKTEST_FEE_RATE", 0.0004);
  const slippageBps = numberEnv("CS_BACKTEST_SLIPPAGE_BPS", 2);
  const concurrency = Math.max(1, Math.min(4, Math.floor(numberEnv("CS_BACKTEST_CONCURRENCY", 2))));
  const symbols = parseSymbols(process.env.CS_BACKTEST_SYMBOLS);

  const client = new BinancePublicClient(process.env.BINANCE_API_BASE_URL);
  const universe = await client.getUniverse();
  const instruments = selectInstruments(universe, symbols);

  console.info(JSON.stringify({
    stage: "fetching_binance_history",
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    warmupDays: 14,
    symbols: instruments.map((instrument) => instrument.symbol),
    concurrency,
  }));

  const datasets = await mapWithConcurrency(instruments, concurrency, async (instrument) => {
    const [candles15m, candles1h, candles4h, fundingRates] = await Promise.all([
      client.getCandlesRange(instrument.symbol, "15m", warmupStart, windowEnd),
      client.getCandlesRange(instrument.symbol, "1h", warmupStart, windowEnd),
      client.getCandlesRange(instrument.symbol, "4h", warmupStart, windowEnd),
      client.getFundingRatesRange(instrument.symbol, windowStart, windowEnd),
    ]);
    if (candles15m.length < 80 || candles1h.length < 80 || candles4h.length < 80) {
      throw new Error("Insufficient candles for " + instrument.symbol);
    }
    console.info(JSON.stringify({
      stage: "downloaded",
      symbol: instrument.symbol,
      candles15m: candles15m.length,
      candles1h: candles1h.length,
      candles4h: candles4h.length,
      fundingRates: fundingRates.length,
    }));
    return {
      symbol: instrument.symbol,
      instrument,
      candles: { "15m": candles15m, "1h": candles1h, "4h": candles4h },
      fundingRates,
    } satisfies HistoricalDataset;
  });

  const runs = datasets.map((dataset) => runBacktest(dataset, DEFAULT_STRATEGY_PARAMS, {
    initialCapitalUsdt: INITIAL_CAPITAL_USDT,
    minScore,
    maxHoldHours: MAX_HOLD_HOURS,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: SINGLE_SIGNAL_RISK_CAP_USDT,
    marginUsdt: MARGIN_USDT,
    leverage: LEVERAGE,
    takerFeeRate,
    slippageBps,
    evaluationStartTime: windowStart,
  }));
  const rawTrades = runs.flatMap((run) => run.trades).sort(byEntryTime);
  const rawMetrics = summarizeTrades(rawTrades, INITIAL_CAPITAL_USDT);
  const operational = applyOperationalCaps(rawTrades);
  const riskAcceptedMetrics = summarizeTrades(operational.riskAccepted, INITIAL_CAPITAL_USDT);
  const emailedMetrics = summarizeTrades(operational.emailEligible, INITIAL_CAPITAL_USDT);

  const report = {
    generatedAt: new Date().toISOString(),
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
      days: 365,
      warmupStart: new Date(warmupStart).toISOString(),
      latestClosed15mOnly: true,
    },
    universe: {
      selection: "fixed liquid symbols for a reproducible MVP validation",
      symbols: instruments.map((instrument) => instrument.symbol),
      note: "This is not the full production top-100 universe; use CS_BACKTEST_SYMBOLS to repeat with another set.",
    },
    assumptions: {
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h", "4h"],
      minScore,
      strategyParams: DEFAULT_STRATEGY_PARAMS,
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      marginUsdt: MARGIN_USDT,
      leverage: LEVERAGE,
      takeProfitRewardRisk: 2,
      maxHoldHours: MAX_HOLD_HOURS,
      singleSignalRiskCapUsdt: SINGLE_SIGNAL_RISK_CAP_USDT,
      dailyRiskBudgetUsdt: DAILY_RISK_BUDGET_USDT,
      dailyEmailCap: DAILY_EMAIL_CAP,
      scanEmailCap: SCAN_EMAIL_CAP,
      takerFeeRate,
      slippageBps,
      funding: "actual Binance USDⓈ-M fundingRate observations; no fallback rate",
      entryModel: "enter at the just-closed 15m close, then evaluate exits from the next candle",
      intrabarModel: "stop-first when both stop and take-profit are inside one OHLC candle",
      positionModel: "fixed 100 USDT margin x 20 leverage; one sequential position per symbol",
      liquidationModel: "not modeled; results are not a live margin or liquidation simulation",
    },
    data: datasets.map((dataset) => ({
      symbol: dataset.symbol,
      quoteVolume24h: dataset.instrument.quoteVolume24h,
      candles: {
        "15m": dataset.candles["15m"].length,
        "1h": dataset.candles["1h"]?.length ?? 0,
        "4h": dataset.candles["4h"]?.length ?? 0,
      },
      fundingRates: dataset.fundingRates?.length ?? 0,
      first15m: new Date(dataset.candles["15m"][0].openTime).toISOString(),
      last15m: new Date(dataset.candles["15m"].at(-1)?.closeTime ?? 0).toISOString(),
    })),
    results: {
      raw: {
        metrics: rawMetrics,
        bySymbol: groupMetrics(rawTrades, (trade) => trade.symbol),
        byStrategy: groupMetrics(rawTrades, (trade) => trade.strategyFamily),
      },
      operational: {
        rawSignals: rawTrades.length,
        riskAcceptedSignals: operational.riskAccepted.length,
        emailEligibleSignals: operational.emailEligible.length,
        riskBudgetBlocked: operational.riskBudgetBlocked,
        emailCapped: operational.emailCapped,
        singleSignalRiskOverCap: operational.singleSignalRiskOverCap,
        riskAcceptedMetrics,
        emailEligibleMetrics: emailedMetrics,
        bySymbol: groupMetrics(operational.emailEligible, (trade) => trade.symbol),
        byStrategy: groupMetrics(operational.emailEligible, (trade) => trade.strategyFamily),
      },
      perSymbolEngineMetrics: runs.map((run) => ({
        symbol: run.trades[0]?.symbol ?? "unknown",
        metrics: run.metrics,
      })),
    },
    trades: rawTrades,
    dataSources: {
      exchangeInfo: "https://fapi.binance.com/fapi/v1/exchangeInfo",
      klines: "https://fapi.binance.com/fapi/v1/klines",
      fundingRate: "https://fapi.binance.com/fapi/v1/fundingRate",
    },
  };

  const reportPath = resolve("reports/backtest-latest.json");
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.info(JSON.stringify({
    ok: true,
    reportPath,
    rawSignals: rawMetrics.signals,
    riskAcceptedSignals: operational.riskAccepted.length,
    emailEligibleSignals: operational.emailEligible.length,
    raw: rawMetrics,
    emailEligible: emailedMetrics,
  }, null, 2));
}

function applyOperationalCaps(trades: BacktestTrade[]) {
  const dailyRisk = new Map<string, number>();
  const dailyEmails = new Map<string, number>();
  const scanEmails = new Map<number, number>();
  const riskAccepted: BacktestTrade[] = [];
  const emailEligible: BacktestTrade[] = [];
  let riskBudgetBlocked = 0;
  let emailCapped = 0;
  let singleSignalRiskOverCap = 0;

  const ordered = [...trades].sort((left, right) => left.entryTime - right.entryTime || right.score - left.score);
  for (const trade of ordered) {
    if (trade.theoreticalRiskUsdt > SINGLE_SIGNAL_RISK_CAP_USDT) singleSignalRiskOverCap += 1;
    const day = new Date(trade.entryTime).toISOString().slice(0, 10);
    const scanBucket = Math.floor(trade.entryTime / FIFTEEN_MINUTES);
    const reserved = dailyRisk.get(day) ?? 0;
    if (reserved + trade.theoreticalRiskUsdt > DAILY_RISK_BUDGET_USDT) {
      riskBudgetBlocked += 1;
      continue;
    }

    dailyRisk.set(day, reserved + trade.theoreticalRiskUsdt);
    riskAccepted.push(trade);
    const emailsToday = dailyEmails.get(day) ?? 0;
    const emailsThisScan = scanEmails.get(scanBucket) ?? 0;
    if (emailsToday >= DAILY_EMAIL_CAP || emailsThisScan >= SCAN_EMAIL_CAP) {
      emailCapped += 1;
      continue;
    }
    dailyEmails.set(day, emailsToday + 1);
    scanEmails.set(scanBucket, emailsThisScan + 1);
    emailEligible.push(trade);
  }

  return { riskAccepted, emailEligible, riskBudgetBlocked, emailCapped, singleSignalRiskOverCap };
}

function summarizeTrades(trades: BacktestTrade[], initialCapitalUsdt: number): PortfolioMetrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = initialCapitalUsdt;
  let peak = equity;
  let maxDrawdownUsdt = 0;
  for (const trade of ordered) {
    equity += trade.pnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = trades.filter((trade) => trade.pnlUsdt > 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(trades.filter((trade) => trade.pnlUsdt < 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  return {
    signals: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : round(wins / trades.length * 100, 2),
    netR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0), 4),
    pricePnlBeforeExecutionCostsUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt + trade.slippageUsdt, 0), 4),
    grossPnlUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    grossProfitUsdt: round(grossProfitUsdt, 4),
    grossLossUsdt: round(grossLossUsdt, 4),
    totalFeesUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((sum, trade) => sum + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((sum, trade) => sum + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 4),
    maxDrawdownPercent: round(initialCapitalUsdt === 0 ? 0 : maxDrawdownUsdt / initialCapitalUsdt * 100, 4),
    finalEquityUsdt: round(initialCapitalUsdt + netPnlUsdt, 4),
    initialCapitalUsdt,
  };
}

function groupMetrics(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const group = groups.get(key(trade)) ?? [];
    group.push(trade);
    groups.set(key(trade), group);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, group]) => [name, summarizeTrades(group, INITIAL_CAPITAL_USDT)]));
}

function selectInstruments(universe: Instrument[], requestedSymbols: string[]): Instrument[] {
  const bySymbol = new Map(universe.map((instrument) => [instrument.symbol, instrument]));
  const missing = requestedSymbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length > 0) throw new Error("Symbols are not currently trading USDT-M perpetuals: " + missing.join(", "));
  return requestedSymbols.map((symbol) => bySymbol.get(symbol) as Instrument);
}

function parseSymbols(value: string | undefined): string[] {
  if (!value?.trim()) return DEFAULT_SYMBOLS;
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return DEFAULT_SYMBOLS;
  return [...new Set(symbols)];
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function byEntryTime(left: BacktestTrade, right: BacktestTrade): number {
  return left.entryTime - right.entryTime || right.score - left.score;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
