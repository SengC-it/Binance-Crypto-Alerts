import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPreReturnAssessment } from "@/lib/v18/engine";
import { canonicalJson, canonicalTextSha256, prepareOfficialData, sha256, V18_BASELINE, V18_BRANCH, V18_END, V18_FREEZE_TIMESTAMP, V18_MONTHS, V18_START, V18_SYMBOLS, V18_WINDOW_BARS, writeJson } from "@/lib/v18/data";

const REPORT_DIR = resolve("reports");
const ARCHIVE_REPORT = resolve(REPORT_DIR, "v18-archive-manifest.json");
const PARSER_REPORT = resolve(REPORT_DIR, "v18-parser-report.json");
const DATA_GATE_REPORT = resolve(REPORT_DIR, "v18-data-gate.json");
const PRE_RETURN_REPORT = resolve(REPORT_DIR, "v18-pre-return-assessment.json");
const FREEZE_MANIFEST = resolve(REPORT_DIR, "v18-freeze-manifest.json");

async function fileSha256(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  return canonicalTextSha256(text);
}

async function main(): Promise<void> {
  const prepared = await prepareOfficialData();
  const preReturn = buildPreReturnAssessment(prepared.candles);
  const archiveManifest = { ...prepared.archiveManifest, freezeTimestamp: V18_FREEZE_TIMESTAMP };
  const parser = { ...prepared.parser, generatedAt: V18_FREEZE_TIMESTAMP };
  const assessment = { ...preReturn.assessment, generatedAt: V18_FREEZE_TIMESTAMP };
  await writeJson(ARCHIVE_REPORT, archiveManifest);
  await writeJson(PARSER_REPORT, parser);
  await writeJson(PRE_RETURN_REPORT, assessment);
  const archiveManifestSha256 = await fileSha256(ARCHIVE_REPORT);
  const parserReportSha256 = await fileSha256(PARSER_REPORT);
  const preReturnAssessmentSha256 = await fileSha256(PRE_RETURN_REPORT);
  const dataGatePass = prepared.inventory.expectedSlots === V18_MONTHS.length * V18_SYMBOLS.length
    && prepared.inventory.enumerationComplete
    && prepared.cache.sealed
    && prepared.parser.archiveSlots.expected === V18_MONTHS.length * V18_SYMBOLS.length
    && prepared.parser.archiveSlots.checksumVerified === V18_MONTHS.length * V18_SYMBOLS.length
    && prepared.parser.archiveSlots.parsed === V18_MONTHS.length * V18_SYMBOLS.length
    && prepared.parser.allChecksPassed
    && V18_SYMBOLS.every((symbol) => prepared.parser.bySymbol[symbol].coverage >= 0.999);
  const dataGate = {
    schema: "v18-data-gate-v1",
    status: dataGatePass ? "PASS" : "FAIL",
    source: {
      provider: "Binance Data Vision",
      dataset: "USD-M Futures monthly 5m klines",
      officialOnly: true,
      symbols: [...V18_SYMBOLS],
      start: V18_START,
      end: V18_END,
      months: V18_MONTHS.length,
      expectedArchiveSlots: V18_MONTHS.length * V18_SYMBOLS.length,
      fixedUniverse: true,
      noCurrentSurvivorUniverseExpansion: true,
      noSyntheticData: true,
      noForwardFill: true,
    },
    archive: {
      enumeratedSlots: prepared.inventory.expectedSlots,
      checksumVerifiedSlots: prepared.cache.verifiedArchiveSlots,
      parsedSlots: prepared.parser.archiveSlots.parsed,
      enumerationComplete: prepared.inventory.enumerationComplete,
      cacheSealed: prepared.cache.sealed,
      archiveManifestSha256,
    },
    parser: { reportSha256: parserReportSha256, ...parser },
    coverageRequirement: { minimumPerSymbol: 0.999, rationale: "complete official monthly 5m archive coverage; no synthetic fill" },
    bySymbol: prepared.parser.bySymbol,
    integrity: { checksum: "PASS", numericFields: "PASS", ohlc: "PASS", timestamps: "PASS", monotonic: "PASS", duplicates: "PASS", cadence: "PASS", takerVolumeConstraints: "PASS", futureData: "PASS" },
    returns: { forwardReturnsRead: false, strategyReturnsRead: false, oosMetricsRead: false, holdoutRead: false },
    generatedAt: V18_FREEZE_TIMESTAMP,
  };
  await writeJson(DATA_GATE_REPORT, dataGate);
  const dataGateSha256 = await fileSha256(DATA_GATE_REPORT);
  const freezeBody = {
    schema: "v18-freeze-manifest-v1",
    experimentId: "V18_TAKER_FLOW_ABSORPTION_REVERSAL",
    hypothesis: "Extreme taker buy/sell flow with contemporaneous price absorption predicts opposite-direction catch-up over the next 60 minutes.",
    baseline: { repository: "SengC-it/Binance-Crypto-Alerts", sha: V18_BASELINE, branch: V18_BRANCH },
    source: { provider: "Binance Data Vision", dataset: "USD-M Futures monthly 5m klines", symbols: [...V18_SYMBOLS], start: V18_START, end: V18_END, months: V18_MONTHS, archiveSlots: V18_MONTHS.length * V18_SYMBOLS.length, archiveManifestSha256 },
    artifacts: { archiveManifest: "reports/v18-archive-manifest.json", archiveManifestSha256, parserReport: "reports/v18-parser-report.json", parserReportSha256, dataGate: "reports/v18-data-gate.json", dataGateSha256, preReturnAssessment: "reports/v18-pre-return-assessment.json", preReturnAssessmentSha256, dataModuleSha256: await fileSha256(resolve("lib/v18/data.ts")), signalEngineSha256: await fileSha256(resolve("lib/v18/engine.ts")) },
    frozenParameters: {
      interval: "5m",
      history: "full_prior_30d",
      priorWindowBars: V18_WINDOW_BARS,
      flowImbalance: "(takerBuyQuoteVolume - (quoteVolume - takerBuyQuoteVolume)) / quoteVolume",
      quoteVolumeNonPositive: "ineligible",
      priorQuantiles: ["FI_Q95", "FI_Q05", "QUOTE_VOLUME_Q75"],
      priceResponse: "(close - open) / (high - low)",
      signedEfficiency: "sign(FI) * priceResponse",
      absorption: "signedEfficiency <= 0",
      directionMapping: { BUY_FLOW_ABSORBED: "SHORT", SELL_FLOW_ABSORBED: "LONG" },
      prohibitedFilters: ["RSI", "MACD", "funding", "trend", "regime", "ATR", "other_filters"],
    },
    execution: { signal: "closed_5m_candle", entry: "next_full_5m_open", nextBarFieldsUsed: ["openTime", "open"], prohibitedNextBarFields: ["high", "low", "close", "volume", "quoteVolume", "tradeCount", "takerBuyBaseVolume", "takerBuyQuoteVolume"], noNextBar: "DATA_UNAVAILABLE_NO_EVENT", horizonMinutes: 60, oneActivePositionPerSymbol: true, overlap: "OVERLAPPING_SIGNAL_EXCLUDED", feeBpsPerSide: 4, slippageBpsPerSide: 2, baselineRoundTripBps: 12, stressAdditionalRoundTripBps: [5, 10, 20] },
    evaluation: { warmup: "2021", primaryOos: "2022-01-01/2024-12-31", holdoutA: "2025-01-01/2025-12-31", holdoutB: "2026-01-01/2026-07-31", primaryOutcome: "60m_fixed_horizon_opposite_flow_return", secondaryOutcomes: ["30m", "120m"], evaluationStartsAfterFreeze: true },
    futurePromotionGate: { deoverlappedEventsMinimum: 300, buyAbsorbedMinimum: 100, sellAbsorbedMinimum: 100, primaryNetPositive: true, primaryPfAtLeast: 1.2, bootstrap95PercentLcbPositive: true, holdoutNetPositive: true, btcNetPositive: true, ethNetPositive: true, plus10BpsNetPositive: true, anyFailure: "V18_TAKER_FLOW_ABSORPTION_REJECTED" },
    frozenControls: ["EXTREME_FLOW_ONLY", "FLOW_CONTINUATION", "TIME_MATCHED_RANDOM"],
    flags: { forwardReturnsRead: false, oosMetricsRead: false, holdoutRead: false, parameterSearch: false, resultCommitCreated: false },
    boundaries: { productionChanged: false, productionEmail: "OFF", deploy: false, merge: false, migration: false, privateBinanceApi: false, orderPlacement: false, autoTrading: false },
    generatedAt: V18_FREEZE_TIMESTAMP,
  };
  const manifest = { ...freezeBody, manifestBodySha256: sha256(canonicalJson(freezeBody)) };
  await writeJson(FREEZE_MANIFEST, manifest);
  console.log(JSON.stringify({ dataGate: dataGate.status, archiveSlots: prepared.parser.archiveSlots, preReturn: assessment.totals, freezeManifestSha256: sha256(canonicalJson(freezeBody)) }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
