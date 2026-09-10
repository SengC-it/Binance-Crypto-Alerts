import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V22_BASELINE_ROUND_TRIP_BPS,
  V22_FEE_BPS_PER_SIDE,
  V22_INFORMATION_DENSITY_FLOOR_BPS,
  V22_INTERVAL_MS,
  V22_MIN_GAP_LOG,
  V22_Q99_INDEX,
  V22_Q99_RANK,
  V22_Q99_QUANTILE,
  V22_ROLLING_OBSERVATIONS,
  V22_SLIPPAGE_BPS_PER_SIDE,
  V22_WINDOW_MS,
} from "@/lib/v22/signal";
import { V22_BASE_SHA, V22_BRANCH, V22_END_MS, V22_EXPERIMENT_ID, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";

const WP1_SHA = "1a223849bd8790521c0c139552969b6bd2cc4b93";
const WP2_ORIGINAL_SHA = "9dd7705466a49c82bcfa7e4851747d92bb46bd63";
const WP1_MANIFEST_SHA = "a3272cd83b0ed661587ea86723aa8e04b764749e49605566cede05721b7e290a";
const REPORT_DIR = resolve("reports");
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function fileSha(path: string): Promise<string> {
  return sha256(await readFile(resolve(path)));
}

async function main(): Promise<void> {
  const contract = {
    schema: "v22-signal-contract-v1",
    experimentId: V22_EXPERIMENT_ID,
    targetVenue: "BINANCE_USDM_PERPETUAL",
    referenceVenue: "OKX_USDT_SWAP",
    fixedSymbols: [...V22_SYMBOLS],
    fixedMappings: V22_OKX_INSTRUMENTS,
    source: {
      input: "both venues CLOSED exact synchronized 5m candles only",
      synchronization: "exact openTime intersection; no nearest timestamp, resampling, forward fill, interpolation, or unclosed candles",
      signalOpenTime: "T",
      decisionTime: "T+5m after the signal candle closes",
    },
    formulas: {
      binanceReturn: "rB_t = ln(BinanceClose_t / BinanceClose_t-1)",
      okxReturn: "rO_t = ln(OKXClose_t / OKXClose_t-1)",
      gap: "g_t = rO_t - rB_t",
      rollingWindow: { durationCalendarDays: 30, durationMs: V22_WINDOW_MS, range: "[t-30d,t)", exactPriorObservations: V22_ROLLING_OBSERVATIONS, currentExcluded: true },
      nearestRankQ99: { quantile: V22_Q99_QUANTILE, sampleSize: V22_ROLLING_OBSERVATIONS, rank: V22_Q99_RANK, zeroBasedIndex: V22_Q99_INDEX, value: "nearest-rank(abs(g_j))" },
      threshold: { empirical: "Q99(abs(g_j))", floorRoundTripBps: V22_INFORMATION_DENSITY_FLOOR_BPS, floorLog: V22_MIN_GAP_LOG, formula: "max(Q99(abs(g_j)), ln(1+0.0024))", alternatives: [] },
      firstCross: { current: "abs(g_t) >= threshold", previous: "abs(g_t-1) < threshold", previousGapSource: "last observation of exact frozen [t-30d,t) PIT window", singleSourceOfTruth: true, previousThreshold: "same current-t threshold" },
    },
    primaryCandidate: {
      conditions: [
        "abs(g_t) >= threshold",
        "abs(g_t-1) < threshold",
        "rO_t * rB_t >= 0",
        "abs(rO_t) > abs(rB_t)",
        "sign(g_t) == sign(rO_t)",
        "g_t != 0",
        "all values finite",
      ],
      forbiddenFilters: ["volume", "funding", "open interest", "taker flow", "regime", "RSI", "MACD", "volatility optimization", "symbol-specific thresholds", "time-of-day"],
    },
    direction: { positiveGap: "LONG BINANCE", negativeGap: "SHORT BINANCE", reversal: false },
    execution: {
      entry: { candle: "next Binance 5m candle", timestamp: "T+5m", field: "open" },
      primary: { exitCandleOpen: "T+15m", exitField: "close", outcomeBoundary: "T+20m", horizonMinutes: 15 },
      diagnostics: { fiveMinute: { exitCandleOpen: "T+5m", exitField: "close", outcomeBoundary: "T+10m" }, thirtyMinute: { exitCandleOpen: "T+30m", exitField: "close", outcomeBoundary: "T+35m" } },
      sameWindowExecution: false,
    },
    costs: { feeBpsPerSide: V22_FEE_BPS_PER_SIDE, slippageBpsPerSide: V22_SLIPPAGE_BPS_PER_SIDE, baselineRoundTripBps: V22_BASELINE_ROUND_TRIP_BPS, stressBps: [17, 22, 32] },
    overlap: { primaryHorizonMinutes: 15, sameSymbol: "later candidate while accepted position is open => OVERLAP_EXCLUDED", differentSymbolsConcurrent: true, clusterId: "signalOpenTime" },
    periods: {
      primaryOos: { start: "2023-07-01T00:00:00.000Z", endExclusive: "2025-01-01T00:00:00.000Z" },
      holdoutA: { start: "2025-01-01T00:00:00.000Z", endExclusive: "2026-01-01T00:00:00.000Z" },
      holdoutB: { start: "2026-01-01T00:00:00.000Z", endExclusive: "2026-08-01T00:00:00.000Z" },
    },
    controls: {
      A: { name: "OKX_SHOCK_MOMENTUM", source: "OKX rO", threshold: "max(Q99(abs(rO)), ln(1+0.0024))", firstCross: true, direction: "sign(rO)", overlap: "same symbol 15m non-overlap" },
      B: { name: "BINANCE_SHOCK_MOMENTUM", source: "Binance rB", threshold: "max(Q99(abs(rB)), ln(1+0.0024))", firstCross: true, direction: "sign(rB)", overlap: "same symbol 15m non-overlap" },
      C: { name: "TIME_MATCHED_RANDOM", seedHex: "0x22C0C0DE", seedDecimal: 583057630, matching: ["same symbol", "same YYYY-MM", "same UTC hour", "same direction"], noDuplicateTimestampSymbol: true, excludesV22Timestamp: true, obeysOverlap: true, generatedOnce: true },
    },
    wp3aSampleGate: { primaryEventsMinimum: 500, distinctSignalClustersMinimum: 250, perFixedSymbolMinimum: 50, failureClassification: "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT", researchStop: true },
    flags: { historicalStrategyOutcomeReturnsRead: false, forwardReturnsRead: false, futureOutcomePricesRead: false, eventEnumerationRun: false, backtestRun: false, parameterSearch: false, promotionEvaluated: false },
    previousGapSource: "last observation of exact frozen [t-30d,t) PIT window",
    singleSourceOfTruth: true,
    firstCrossPreviousThreshold: "same current-t threshold",
  };
  const contractBody = json(contract);
  await writeFile(resolve(REPORT_DIR, "v22-signal-contract.json"), contractBody, "utf8");
  const sourceFiles = [
    "lib/v22/signal.ts",
    "lib/v22/types.ts",
    "lib/v22/data.ts",
    "tests/v22-signal.test.ts",
    "scripts/build-v22-wp2.ts",
    "scripts/validate-v22-wp1.ts",
  ];
  const sourceSha256: Record<string, string> = {};
  for (const path of sourceFiles) sourceSha256[path] = await fileSha(path);
  const manifest = {
    schema: "v22-wp2-freeze-manifest-v1",
    experimentId: V22_EXPERIMENT_ID,
    branch: V22_BRANCH,
    baseSha: V22_BASE_SHA,
    directParent: WP2_ORIGINAL_SHA,
    wp1_1AcceptedCommit: WP1_SHA,
    wp1_1ManifestSha256: WP1_MANIFEST_SHA,
    wp2OriginalCommit: WP2_ORIGINAL_SHA,
    correctiveType: "FIRST_CROSS_INTEGRITY_ONLY",
    researchSemanticsChanged: false,
    fixedSymbols: [...V22_SYMBOLS],
    fixedMappings: V22_OKX_INSTRUMENTS,
    period: { start: new Date(V22_START_MS).toISOString(), endExclusive: new Date(V22_END_MS).toISOString(), interval: "5m", closedCandlesOnly: true },
    signalContractSha256: sha256(contractBody),
    sourceFileSha256: sourceSha256,
    q99: { quantile: V22_Q99_QUANTILE, sampleSize: V22_ROLLING_OBSERVATIONS, rank: V22_Q99_RANK, zeroBasedIndex: V22_Q99_INDEX },
    informationDensityFloor: { roundTripBps: V22_INFORMATION_DENSITY_FLOOR_BPS, minGapLog: V22_MIN_GAP_LOG },
    execution: { signalDecisionAfterClose: true, entry: "next Binance 5m open", primaryExit: "Binance close at T+15m", primaryOutcomeBoundary: "T+20m", diagnostics: ["5m", "30m"] },
    costs: { baselineRoundTripBps: V22_BASELINE_ROUND_TRIP_BPS, stressRoundTripBps: [17, 22, 32] },
    overlap: { sameSymbolPrimaryNonOverlap: true, differentSymbolsConcurrent: true, clusterId: "signalOpenTime" },
    controls: { names: ["OKX_SHOCK_MOMENTUM", "BINANCE_SHOCK_MOMENTUM", "TIME_MATCHED_RANDOM"], randomSeedHex: "0x22C0C0DE", randomSeedDecimal: 583057630 },
    wp3aSampleGate: { primaryEventsMinimum: 500, distinctSignalClustersMinimum: 250, perSymbolMinimum: 50, failureClassification: "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT" },
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    futureOutcomePricesRead: false,
    eventEnumerationRun: false,
    backtestRun: false,
    parameterSearch: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  };
  await writeFile(resolve(REPORT_DIR, "v22-wp2-freeze-manifest.json"), json(manifest), "utf8");
  console.info(JSON.stringify({ stage: "v22_wp2_reports_complete", signalContractSha256: sha256(contractBody), wp1_1ManifestSha256: WP1_MANIFEST_SHA }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
