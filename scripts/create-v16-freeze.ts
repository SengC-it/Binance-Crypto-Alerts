import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V16_BASELINE,
  V16_BRANCH,
  V16_END,
  V16_START,
  V16_SYMBOLS,
  V16_GATE_THRESHOLDS,
} from "@/lib/v16/data-gate";

const REPORT_DIR = resolve("reports");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const body = {
    schema: "v16-freeze-manifest-v1",
    status: "FROZEN_BEFORE_RETURNS",
    generatedAt: new Date().toISOString(),
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    source: {
      provider: "Binance Data Vision",
      baseUrl: "https://data.binance.vision",
      market: "USD-M perpetual",
      officialOnly: true,
      start: V16_START,
      end: V16_END,
      archives: ["aggTrades", "klines/1m", "klines/5m", "fundingRate", "markPriceKlines"],
      noThirdPartyPriceData: true,
      immutableCacheRequired: true,
      checksumRequired: "100% of every used ZIP",
    },
    universe: {
      symbols: [...V16_SYMBOLS],
      fixedNamedInstrumentUniverse: true,
      selectionRule: "Pre-registered BTCUSDT and ETHUSDT USD-M perpetuals; never select by historical returns.",
      noPostResultUniverseTuning: true,
    },
    flowFeatures: {
      aggTradeFields: ["price", "qty", "timestamp", "isBuyerMaker"],
      aggressiveBuyRule: "isBuyerMaker=false",
      aggressiveSellRule: "isBuyerMaker=true",
      window: "trailing 30 minutes ending before each decision timestamp",
      values: ["buyQuote", "sellQuote", "totalQuote", "flowImbalance", "return30m", "highLowRange30m", "realizedVol30m", "VWAP30m"],
      flowImbalance: "(buyQuote - sellQuote) / totalQuote",
      priceResponse: "same-direction return response, PIT trailing 60-day distribution",
      noFutureTradesInFeatures: true,
    },
    absorption: {
      distribution: "per instrument, trailing 60-day PIT distribution at T",
      flowThresholds: { buy: "Q90", sell: "Q10" },
      priceResponseThreshold: "Q50",
      buyAbsorption: "flowImbalance >= Q90 and same-direction return response below PIT Q50 => SHORT",
      sellAbsorption: "flowImbalance <= Q10 and absolute downside response below PIT Q50 => LONG",
      directionIsReversed: true,
      parameterSearch: false,
    },
    decisionClock: {
      cadence: "15m",
      inputs: ["aggTrades observed before T", "closed bars before T"],
      sameWindowExecution: false,
    },
    execution: {
      primary: "first futures 5m open after T",
      noSameWindowExecution: true,
      noSignalCandleCloseFallback: true,
    },
    risk: {
      atr: "15m ATR14",
      stop: "1.5 ATR",
      takeProfit: "2R",
      maxHold: "4h",
      overlap: "same symbol positions do not overlap",
      sameBarStopTakeProfit: "unfavorable direction; Stop first",
    },
    costs: {
      fee: "4bps per side",
      slippage: "2bps per side",
      funding: "actual historical funding rows at actual timestamps only",
      missingFundingSettlement: "funding=0 only when no settlement occurred; occurred-but-missing is DATA_UNAVAILABLE",
      markPrice: "actual historical mark price",
      fixedFundingScheduleFallback: false,
      stressBps: [5, 10, 20],
    },
    manualDelay: {
      delays: ["5m", "15m", "30m"],
      execution: "actual delayed entry",
      expiredWhen: "theoretical trade reaches Stop/TP before delayed entry",
      thirtyMinuteRequirement: "NetR > 0 and suitable for email use",
    },
    validation: {
      warmup: [2021],
      primaryOos: [2022, 2023, 2024],
      holdoutA: [2025],
      holdoutB: "2026-01 through 2026-07",
      method: "nested purged walk-forward",
      holdoutFrozenBeforeResults: true,
      directionReport: ["BUY absorption => SHORT", "SELL absorption => LONG"],
      instrumentReport: [...V16_SYMBOLS],
      capitalSimulations: [1000, 2000, 10000],
    },
    placebos: {
      sameDirection: "same flow, trade with the flow",
      randomMatchedTimestamp: "same symbol/month/hour matched timestamp",
      nonAbsorbedFlow: "extreme flow with normal strong price response",
    },
    gates: {
      ...V16_GATE_THRESHOLDS,
      aggTradeCoverage: ">=99% per instrument",
      featureCoverage: ">=99%",
      executionPriceCoverage: ">=99%",
      fundingSettlementCoverage: "100% of actually required settlements",
      oos: { trades: ">=200", netR: ">0", avgR: ">=0.10", pf: ">=1.30", maxDdR: "<=8", positiveYearRatio: ">=2/3", medianYearNetR: ">0", plus5bps: ">0", plus10bps: ">0" },
      holdouts: { eachTrades: ">=50 A / >=30 B", netR: ">0", pf: ">=1.20", maxDdR: "<=6" },
      manual: { delay15m: { netR: ">0", pf: ">=1.20" }, delay30m: { netR: ">0", pf: ">=1.15" } },
      confidence: "block bootstrap AvgR 95% LCB > 0",
      emailUtility: { meanSignalsPerMonth: ">=2", medianSignalsPerMonth: ">=2", activeMonthRatio: ">=75%", maxDrought: "<=30d" },
    },
    boundaries: {
      system: "SIGNAL + SMTP ONLY",
      productionEmail: "OFF",
      productionChanged: false,
      deploy: false,
      merge: false,
      migration: false,
      autoTrading: false,
      privateBinanceApi: false,
      orderPlacement: false,
      accountBalanceOrPositions: false,
      v15Changed: false,
    },
    historicalReturnsRead: false,
  };
  const manifest = { ...body, manifestSha256: sha256(JSON.stringify(body)) };
  await writeFile(resolve(REPORT_DIR, "v16-freeze-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ branch: V16_BRANCH, baseline: V16_BASELINE, status: manifest.status, manifestSha256: manifest.manifestSha256, historicalReturnsRead: manifest.historicalReturnsRead }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
