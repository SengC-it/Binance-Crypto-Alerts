import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBacktest, type BacktestOptions } from "@/lib/backtest/engine";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { BinancePublicClient, mapWithConcurrency } from "@/lib/binance/public-client";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Instrument } from "@/lib/core/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_HOLD_HOURS = 72;
const INITIAL_CAPITAL_USDT = 10_000;
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

interface Variant {
  id: string;
  description: string;
  params: StrategyParams;
  options: BacktestOptions;
}

interface Metrics {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgScore: number;
  avgRiskUsdt: number;
  avgPnlUsdt: number;
  netR: number;
  netPnlUsdt: number;
  pricePnlBeforeExecutionCostsUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  finalEquityUsdt: number;
}

async function main() {
  const currentBucketOpen = Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
  const windowStart = currentBucketOpen - 365 * DAY;
  const windowEnd = currentBucketOpen - 1;
  const warmupStart = windowStart - 14 * DAY;
  const splitTime = addMonths(windowStart, 9);
  const trainEnd = splitTime - MAX_HOLD_HOURS * HOUR;
  const oosStart = splitTime;
  const minScore = numberEnv("CS_VALIDATION_MIN_SCORE", 60);
  const feeRate = numberEnv("CS_VALIDATION_FEE_RATE", 0.0004);
  const slippageBps = numberEnv("CS_VALIDATION_SLIPPAGE_BPS", 2);
  const concurrency = Math.max(1, Math.min(4, Math.floor(numberEnv("CS_VALIDATION_CONCURRENCY", 2))));
  const focus = process.env.CS_VALIDATION_FOCUS ?? "full";
  const requestedSymbols = parseSymbols(process.env.CS_VALIDATION_SYMBOLS);
  const client = new BinancePublicClient(process.env.BINANCE_API_BASE_URL);
  const universe = await client.getUniverse();
  const instruments = selectInstruments(universe, requestedSymbols);

  console.info(JSON.stringify({
    stage: "fetching_validation_history",
    symbols: instruments.map((instrument) => instrument.symbol),
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    trainEnd: new Date(trainEnd).toISOString(),
    oosStart: new Date(oosStart).toISOString(),
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

  const variants = createVariants(minScore, feeRate, slippageBps, focus);
  const results = variants.map((variant) => {
    const trainTrades = datasets.flatMap((dataset) => runBacktest(dataset, variant.params, {
      ...variant.options,
      evaluationStartTime: windowStart,
      evaluationEndTime: trainEnd,
    }).trades);
    const oosTrades = datasets.flatMap((dataset) => runBacktest(dataset, variant.params, {
      ...variant.options,
      evaluationStartTime: oosStart,
      evaluationEndTime: windowEnd,
    }).trades);
    const train = summarize(trainTrades);
    const outOfSample = summarize(oosTrades);
    return {
      id: variant.id,
      description: variant.description,
      params: variant.params,
      options: variant.options,
      train,
      outOfSample,
      passesSuggestedGate: passesSuggestedGate(outOfSample),
    };
  });

  results.sort((left, right) => rankResult(right) - rankResult(left));
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "P0-P1 experimental validation; no production strategy changed",
    focus,
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
      warmupStart: new Date(warmupStart).toISOString(),
      train: {
        start: new Date(windowStart).toISOString(),
        end: new Date(trainEnd).toISOString(),
      },
      outOfSample: {
        start: new Date(oosStart).toISOString(),
        end: new Date(windowEnd).toISOString(),
      },
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h", "4h"],
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      maxHoldHours: MAX_HOLD_HOURS,
      takeProfitRewardRisk: 2,
      takerFeeRate: feeRate,
      slippageBps,
      intrabarModel: "stop-first when both levels are inside one candle",
      entryModel: "entry at just-closed 15m close; exits begin from next candle",
      note: "The suggested gate is a research threshold, not a profit guarantee.",
    },
    universe: {
      symbols: instruments.map((instrument) => instrument.symbol),
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    variants: results,
    data: datasets.map((dataset) => ({
      symbol: dataset.symbol,
      candles15m: dataset.candles["15m"].length,
      candles1h: dataset.candles["1h"]?.length ?? 0,
      candles4h: dataset.candles["4h"]?.length ?? 0,
      fundingRates: dataset.fundingRates?.length ?? 0,
    })),
  };

  const reportPath = resolve(focus === "full" ? "reports/validation-latest.json" : "reports/validation-" + focus + "-latest.json");
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    variants: results.map((result) => ({
      id: result.id,
      trainSignals: result.train.signals,
      trainNetPnlUsdt: result.train.netPnlUsdt,
      trainPF: result.train.profitFactor,
      oosSignals: result.outOfSample.signals,
      oosNetPnlUsdt: result.outOfSample.netPnlUsdt,
      oosPF: result.outOfSample.profitFactor,
      passesSuggestedGate: result.passesSuggestedGate,
    })),
  }, null, 2));
}

function createVariants(minScore: number, feeRate: number, slippageBps: number, focus: string): Variant[] {
  const common = {
    initialCapitalUsdt: INITIAL_CAPITAL_USDT,
    minScore,
    maxHoldHours: MAX_HOLD_HOURS,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: 100,
    marginUsdt: 100,
    leverage: 20,
    takerFeeRate: feeRate,
    slippageBps,
  } satisfies BacktestOptions;

  const fixedRisk = (stopAtrMultiplier: number, extras: Partial<BacktestOptions> = {}, variantMinScore = minScore): Variant => ({
    id: "risk50-stop" + stopAtrMultiplier.toString().replace(".", "-") + variantSuffix(extras, variantMinScore, minScore),
    description: "50U fixed-risk sizing, " + stopAtrMultiplier + " ATR stop" + (extras.requireRegimeAlignment ? ", strict regime alignment" : "") + (variantMinScore === minScore ? "" : ", score >= " + variantMinScore),
    params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier },
    options: {
      ...common,
      ...extras,
      minScore: variantMinScore,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
    },
  });

  if (focus === "short-score") {
    return [65, 70, 75, 80, 85, 90].map((variantMinScore) => fixedRisk(0.75, {
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
    }, variantMinScore));
  }

  return [
    {
      id: "baseline-fixed-margin-stop0-25",
      description: "Original fixed 100U margin x20, 0.25 ATR stop",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: common,
    },
    fixedRisk(0.5),
    fixedRisk(0.75),
    fixedRisk(1),
    fixedRisk(0.75, { requireRegimeAlignment: true }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "LONG" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "SHORT" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["TREND"] }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["BREAKOUT"] }),
    {
      id: "risk25-stop0-75-regime",
      description: "25U fixed-risk sizing, 0.75 ATR stop, strict regime alignment",
      params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier: 0.75 },
      options: {
        ...common,
        riskPerTradeUsdt: 25,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 25,
        requireRegimeAlignment: true,
      },
    },
  ];
}

function variantSuffix(options: Partial<BacktestOptions>, variantMinScore: number, defaultMinScore: number): string {
  const parts = [
    options.requireRegimeAlignment ? "regime" : "",
    options.sideFilter ? options.sideFilter.toLowerCase() : "",
    options.strategyFamilies?.join("-").toLowerCase() ?? "",
  ].filter(Boolean);
  if (variantMinScore !== defaultMinScore) parts.push("score" + variantMinScore);
  return parts.length === 0 ? "" : "-" + parts.join("-");
}

function summarize(trades: BacktestTrade[]): Metrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = INITIAL_CAPITAL_USDT;
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
    avgScore: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.score, 0) / trades.length, 2),
    avgRiskUsdt: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.theoreticalRiskUsdt, 0) / trades.length, 4),
    avgPnlUsdt: trades.length === 0 ? 0 : round(netPnlUsdt / trades.length, 4),
    netR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    pricePnlBeforeExecutionCostsUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt + trade.slippageUsdt, 0), 4),
    totalFeesUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((sum, trade) => sum + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((sum, trade) => sum + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 4),
    maxDrawdownPercent: round(maxDrawdownUsdt / INITIAL_CAPITAL_USDT * 100, 4),
    finalEquityUsdt: round(INITIAL_CAPITAL_USDT + netPnlUsdt, 4),
  };
}

function passesSuggestedGate(metrics: Metrics): boolean {
  return metrics.signals >= 100
    && metrics.netPnlUsdt > 0
    && metrics.profitFactor >= 1.1
    && metrics.maxDrawdownPercent <= 30;
}

function rankResult(result: {
  outOfSample: Metrics;
  passesSuggestedGate: boolean;
}): number {
  return (result.passesSuggestedGate ? 1_000_000 : 0)
    + result.outOfSample.netPnlUsdt
    - result.outOfSample.maxDrawdownUsdt;
}

function selectInstruments(universe: Instrument[], symbols: string[]): Instrument[] {
  const bySymbol = new Map(universe.map((instrument) => [instrument.symbol, instrument]));
  const missing = symbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length > 0) throw new Error("Symbols are not currently trading USDT-M perpetuals: " + missing.join(", "));
  return symbols.map((symbol) => bySymbol.get(symbol) as Instrument);
}

function parseSymbols(value: string | undefined): string[] {
  if (!value?.trim()) return DEFAULT_SYMBOLS;
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return symbols.length === 0 ? DEFAULT_SYMBOLS : [...new Set(symbols)];
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
