import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V20_ARCHIVE_EXCHANGE,
  V20_ARCHIVE_ROOT,
  V20_DATA_TYPES,
  downloadAndParseV20Archive,
  type V20Bar,
  type V20ArchiveSlot,
  type V20DataType,
} from "../lib/v20/archive";
import {
  V20_BASE_SHA,
  V20_BRANCH,
  V20_BOUNDARIES,
  V20_CONTROLS,
  V20_END_EXCLUSIVE_TIMESTAMP,
  V20_END_TIMESTAMP,
  V20_EXPERIMENT_ID,
  V20_EXPECTED_ARCHIVE_SLOTS,
  V20_HOLDOUT_A_END,
  V20_HOLDOUT_A_START,
  V20_HOLDOUT_B_START,
  V20_PARAMETERS,
  V20_PROMOTION_GATES,
  V20_PRIMARY_OOS_END,
  V20_PRIMARY_OOS_START,
  V20_REPORT_FILES,
  V20_SOURCE_FILES,
  V20_START_TIMESTAMP,
  V20_SYMBOLS,
  V20_WARMUP_START,
  v20MonthKeys,
} from "../lib/v20/constants";
import { canonicalTextSha256, sha256 } from "../lib/v20/canonical";
import { synchronizeExact, type V20SynchronizedSeries } from "../lib/v20/sync";
import { enumerateLastIndexControl, enumerateLastMarkEvents, enumerateLastReturnControl, enumerateTimeMatchedRandom, type V20ControlEnumeration, type V20PrimaryEvent } from "../lib/v20/signals";

const REPORT_DIR = resolve("reports");

async function main(): Promise<void> {
  assertExactStartingPoint();
  await mkdir(REPORT_DIR, { recursive: true });
  const months = v20MonthKeys();
  if (months.length !== 67) throw new Error(`Expected 67 months, received ${months.length}`);
  console.info(`V20 freeze: downloading and verifying ${V20_EXPECTED_ARCHIVE_SLOTS} official archive slots`);

  const allSlots: V20ArchiveSlot[] = [];
  const seriesBySymbol = new Map<typeof V20_SYMBOLS[number], V20SynchronizedSeries>();
  const parserByDataset: Record<string, Record<string, unknown>> = {};
  let completedSlots = 0;

  for (const symbol of V20_SYMBOLS) {
    const datasets = new Map<V20DataType, V20Bar[]>();
    for (const dataType of V20_DATA_TYPES) {
      const downloads = await mapWithConcurrency(months, 6, async (month) => {
        const result = await downloadAndParseV20Archive(dataType, symbol, month, { rootDir: V20_ARCHIVE_ROOT });
        completedSlots += 1;
        if (completedSlots % 24 === 0 || result.slot.status !== "VERIFIED") {
          console.info(`V20 archive progress ${completedSlots}/${V20_EXPECTED_ARCHIVE_SLOTS}: ${result.slot.dataType}/${result.slot.symbol}/${result.slot.month} ${result.slot.status}`);
        }
        return result;
      });
      const bars = downloads.flatMap((download) => download.bars).sort((left, right) => left.openTime - right.openTime);
      datasets.set(dataType, bars);
      allSlots.push(...downloads.map((download) => download.slot));
      parserByDataset[`${symbol}/${dataType}`] = parserSummary(downloads.map((download) => download.slot), bars);
    }
    const regular = datasets.get("regular") ?? [];
    const mark = datasets.get("mark") ?? [];
    const index = datasets.get("index") ?? [];
    const synced = synchronizeExact(symbol, regular, mark, index);
    seriesBySymbol.set(symbol, synced.series);
  }

  allSlots.sort(slotOrder);
  const archiveManifest = {
    schemaVersion: "v20-archive-manifest-v1",
    experimentId: V20_EXPERIMENT_ID,
    repository: "SengC-it/Binance-Crypto-Alerts",
    exchange: V20_ARCHIVE_EXCHANGE,
    source: "official Binance Data Vision monthly USD-M futures archives",
    period: { start: V20_START_TIMESTAMP, endExclusive: V20_END_EXCLUSIVE_TIMESTAMP },
    months,
    symbols: V20_SYMBOLS,
    dataTypes: V20_DATA_TYPES,
    expectedArchiveSlots: V20_EXPECTED_ARCHIVE_SLOTS,
    slots: allSlots,
    summary: archiveSummary(allSlots),
    immutableCache: {
      root: "data/raw/v20/archives",
      rawBytesSha256: true,
      officialChecksumRequired: true,
      dynamicRedownloadOverwrite: false,
    },
  };
  await writeJson("v20-archive-manifest.json", archiveManifest);

  const parserReport = {
    schemaVersion: "v20-parser-report-v1",
    experimentId: V20_EXPERIMENT_ID,
    parser: {
      regularFields: ["openTime", "open", "high", "low", "close", "closeTime"],
      markFields: ["openTime", "open", "high", "low", "close", "closeTime"],
      indexFields: ["openTime", "open", "high", "low", "close", "closeTime"],
      finiteNumericValues: true,
      positiveOhlc: true,
      validOhlcOrdering: true,
      monotonicTimestamps: true,
      duplicateOpenTimeRejected: true,
      exactFiveMinuteCadence: true,
      correctCloseTime: true,
      frozenEndEnforced: true,
      noSyntheticRows: true,
      noForwardFill: true,
    },
    byDataset: parserByDataset,
  };
  await writeJson("v20-parser-report.json", parserReport);

  const actualSyncReports = V20_SYMBOLS.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    if (!series) throw new Error(`Missing synchronized series for ${symbol}`);
    const slotsFor = (dataType: V20DataType) => allSlots.filter((slot) => slot.symbol === symbol && slot.dataType === dataType);
    return synchronizationReport(symbol, series, slotsFor("regular"), slotsFor("mark"), slotsFor("index"));
  });
  const syncReport = {
    schemaVersion: "v20-sync-report-v1",
    experimentId: V20_EXPERIMENT_ID,
    join: "exact inner join on openTime",
    nearestTimeJoin: false,
    timestampTolerance: 0,
    forwardFill: false,
    bySymbol: actualSyncReports,
    totals: {
      expectedRows: actualSyncReports.reduce((sum, report) => sum + Number(report.expectedRows ?? 0), 0),
      synchronizedRows: actualSyncReports.reduce((sum, report) => sum + Number(report.synchronizedRows ?? 0), 0),
      synchronizedCoverage: weightedCoverage(actualSyncReports),
    },
  };
  await writeJson("v20-sync-report.json", syncReport);

  const dataGate = buildDataGate(allSlots, parserByDataset);
  await writeJson("v20-data-gate.json", dataGate);
  if (dataGate.status !== "PASS") {
    await writeDataGateFailureFreeze(archiveManifest, parserReport, syncReport, dataGate, allSlots);
    console.info("V20 freeze stopped before event enumeration: V20_FAIR_VALUE_DATA_INSUFFICIENT");
    return;
  }

  const primaryBySymbol = V20_SYMBOLS.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    if (!series) throw new Error(`Missing synchronized series for ${symbol}`);
    return enumerateLastMarkEvents(series);
  });
  const primaryEvents = primaryBySymbol.flatMap((result) => result.events).sort(eventOrder);
  const indexControls = V20_SYMBOLS.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    if (!series) throw new Error(`Missing synchronized series for ${symbol}`);
    return enumerateLastIndexControl(series);
  });
  const lastReturnControls = V20_SYMBOLS.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    if (!series) throw new Error(`Missing synchronized series for ${symbol}`);
    return enumerateLastReturnControl(series);
  });
  const randomControls = V20_SYMBOLS.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    if (!series) throw new Error(`Missing synchronized series for ${symbol}`);
    return enumerateTimeMatchedRandom(series, primaryEvents.filter((event) => event.symbol === symbol));
  });
  const primarySummary = summarizePrimary(primaryBySymbol, primaryEvents);
  const controls = {
    LAST_INDEX_DISLOCATION: summarizeControls(indexControls),
    EXTREME_LAST_RETURN_REVERSAL: summarizeControls(lastReturnControls),
    TIME_MATCHED_RANDOM: summarizeControls(randomControls),
  };
  const primaryOosEvents = primaryEvents.filter((event) => event.evaluationWindow === "PRIMARY_OOS");
  const primaryOosDistinctSignalClusters = new Set(primaryOosEvents.map((event) => event.clusterId)).size;
  const primaryOosEventsBySymbol = countBySymbol(primaryOosEvents);
  const preReturnCapacityGate = {
    primaryOosEligibleEventsMinimum: V20_PROMOTION_GATES.preReturn.primaryOosEligibleEventsMinimum,
    primaryOosEligibleEvents: primaryOosEvents.length,
    primaryOosDistinctSignalClustersMinimum: V20_PROMOTION_GATES.preReturn.primaryOosSignalClustersMinimum,
    primaryOosDistinctSignalClusters,
    perSymbolPrimaryOosEventsMinimum: V20_PROMOTION_GATES.preReturn.perSymbolPrimaryOosEventsMinimum,
    primaryOosEventsBySymbol,
    pass: primaryOosEvents.length >= V20_PROMOTION_GATES.preReturn.primaryOosEligibleEventsMinimum
      && primaryOosDistinctSignalClusters >= V20_PROMOTION_GATES.preReturn.primaryOosSignalClustersMinimum
      && V20_SYMBOLS.every((symbol) => primaryOosEventsBySymbol[symbol] >= V20_PROMOTION_GATES.preReturn.perSymbolPrimaryOosEventsMinimum),
  };
  const preReturnAssessment = {
    schemaVersion: "v20-pre-return-assessment-v1",
    experimentId: V20_EXPERIMENT_ID,
    period: {
      warmup: { start: V20_WARMUP_START, endExclusive: V20_PRIMARY_OOS_START },
      primaryOos: { start: V20_PRIMARY_OOS_START, endInclusive: V20_PRIMARY_OOS_END },
      holdoutA: { start: V20_HOLDOUT_A_START, endInclusive: V20_HOLDOUT_A_END },
      holdoutB: { start: V20_HOLDOUT_B_START, endInclusive: V20_END_TIMESTAMP },
    },
    signalDefinition: {
      field: "gap=ln(lastClose/markClose)",
      closedSignalBarsOnly: true,
      pitWindow: "[t-30d,t)",
      currentBarExcludedFromMedianAndQ99: true,
      firstCrossOnly: true,
      direction: { positiveDeviation: "SHORT", negativeDeviation: "LONG" },
      primaryExecutionReference: "next complete regular 5m candle OPEN (availability only; price not read)",
    },
    rawExtremeEvents: primarySummary.rawExtremeEvents,
    rawExtremeByWindow: primarySummary.rawExtremeByWindow,
    firstCrossEvents: primarySummary.firstCrossEvents,
    firstCrossByWindow: primarySummary.firstCrossByWindow,
    overlapExcluded: primarySummary.overlapExcluded,
    executionReferenceUnavailable: primarySummary.executionReferenceUnavailable,
    finalEligibleEvents: primarySummary.finalEligibleEvents,
    preReturnCapacityGate,
    classification: preReturnCapacityGate.pass ? "V20_PRE_RETURN_CAPACITY_PASS" : "V20_PRE_RETURN_SAMPLE_INSUFFICIENT",
    primaryOosEligibleEvents: primaryOosEvents.length,
    distinctSignalClusters: new Set(primaryEvents.map((event) => event.clusterId)).size,
    primaryOosDistinctSignalClusters,
    eventsBySymbol: primarySummary.eventsBySymbol,
    primaryOosEventsBySymbol,
    eventsBySide: primarySummary.eventsBySide,
    primaryOosEventsBySide: sideCounts(primaryOosEvents),
    events: primaryEvents,
    eventDigest: sha256(primaryEvents),
    controls: {
      eventCounts: Object.fromEntries(Object.entries(controls).map(([name, value]) => [name, value.eventCount])),
      identityDigests: Object.fromEntries(Object.entries(controls).map(([name, value]) => [name, value.eventDigest])),
      events: Object.fromEntries(Object.entries(controls).map(([name, value]) => [name, value.events])),
    },
    outcomeAccess: {
      historicalReturnsRead: false,
      forwardReturnsRead: false,
      oosMetricsRead: false,
      holdoutRead: false,
      outcomesNotCalculated: true,
      forbiddenBeforeHumanAcceptance: ["gross return", "future return", "PnL", "PF", "winRate", "MaxDD", "CVaR", "bootstrap return CI", "promotion decision"],
    },
  };
  await writeJson("v20-pre-return-assessment.json", preReturnAssessment);

  const reportHashes: Record<string, string> = {};
  for (const report of V20_REPORT_FILES.slice(0, -1)) reportHashes[report] = canonicalTextSha256(await readFile(resolve(report), "utf8"));
  const sourceHashes: Record<string, string> = {};
  for (const source of V20_SOURCE_FILES) sourceHashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  const manifestBody = {
    schemaVersion: "v20-freeze-manifest-v1",
    experimentId: V20_EXPERIMENT_ID,
    repository: "SengC-it/Binance-Crypto-Alerts",
    baseSha: V20_BASE_SHA,
    branch: V20_BRANCH,
    stage: "FREEZE_BEFORE_STRATEGY_RETURNS",
    symbols: V20_SYMBOLS,
    dataSources: {
      exchange: V20_ARCHIVE_EXCHANGE,
      source: "official Binance Data Vision",
      dataTypes: V20_DATA_TYPES,
      expectedArchiveSlots: V20_EXPECTED_ARCHIVE_SLOTS,
      checksumVerifiedArchiveSlots: allSlots.filter((slot) => slot.checksumVerified).length,
      archiveManifestSha256: reportHashes["reports/v20-archive-manifest.json"],
    },
    parser: {
      parserSha256: reportHashes["reports/v20-parser-report.json"],
      sourceHash: sourceHashes["lib/v20/archive.ts"],
      noSyntheticRows: true,
      noForwardFill: true,
    },
    synchronization: {
      syncReportSha256: reportHashes["reports/v20-sync-report.json"],
      syncEngineSha256: sourceHashes["lib/v20/sync.ts"],
      exactInnerJoinOn: "openTime",
      nearestTimeJoin: false,
      timestampTolerance: 0,
      forwardFill: false,
    },
    signalEngine: {
      signalEngineSha256: sourceHashes["lib/v20/signals.ts"],
      eventEnumerationSha256: preReturnAssessment.eventDigest,
      controlIdentityDigest: sha256(preReturnAssessment.controls.identityDigests),
      preReturnAssessmentSha256: reportHashes["reports/v20-pre-return-assessment.json"],
    },
    parameters: V20_PARAMETERS,
    controls: V20_CONTROLS,
    promotionGates: V20_PROMOTION_GATES,
    reportHashes,
    sourceHashes,
      classification: dataGate.status === "PASS" ? "V20_DATA_GATE_PASS" : "V20_FAIR_VALUE_DATA_INSUFFICIENT",
      dataGate: {
      status: dataGate.status,
      dataGateSha256: reportHashes["reports/v20-data-gate.json"],
      synchronizedCoverage: syncReport.totals.synchronizedCoverage,
    },
    enumeration: {
      rawExtremeEvents: preReturnAssessment.rawExtremeEvents,
      firstCrossEvents: preReturnAssessment.firstCrossEvents,
      overlapExcluded: preReturnAssessment.overlapExcluded,
      finalEligibleEvents: preReturnAssessment.finalEligibleEvents,
      primaryOosEligibleEvents: preReturnAssessment.primaryOosEligibleEvents,
      primaryOosDistinctSignalClusters: preReturnAssessment.primaryOosDistinctSignalClusters,
      preReturnCapacityGate: preReturnAssessment.preReturnCapacityGate,
      classification: preReturnAssessment.classification,
      eventsBySymbol: preReturnAssessment.eventsBySymbol,
      primaryOosEventsBySymbol: preReturnAssessment.primaryOosEventsBySymbol,
      eventsBySide: preReturnAssessment.eventsBySide,
      primaryOosEventsBySide: preReturnAssessment.primaryOosEventsBySide,
      eventDigest: preReturnAssessment.eventDigest,
      controlIdentityDigest: sha256(preReturnAssessment.controls.identityDigests),
    },
    execution: {
      signalBar: "closed 5m synchronized bar",
      nextEntry: "next complete regular futures 5m candle OPEN",
      primaryExit: "next entry candle CLOSE; outcome calculation prohibited in Freeze",
      secondaryDiagnostics: [15, 30],
    },
    costModel: V20_PARAMETERS.costModel,
    windows: {
      warmup: { start: V20_WARMUP_START, endExclusive: V20_PRIMARY_OOS_START },
      primaryOos: { start: V20_PRIMARY_OOS_START, endInclusive: V20_PRIMARY_OOS_END },
      holdoutA: { start: V20_HOLDOUT_A_START, endInclusive: V20_HOLDOUT_A_END },
      holdoutB: { start: V20_HOLDOUT_B_START, endInclusive: V20_END_TIMESTAMP },
    },
    flags: V20_BOUNDARIES,
    sourceFiles: V20_SOURCE_FILES,
    prohibitedBeforeHumanAcceptance: ["strategy returns", "OOS metrics", "holdout performance", "PF", "PnL", "bootstrap return confidence intervals", "promotion decision", "Result commit"],
  };
  const freezeManifest = { ...manifestBody, manifestBodySha256: sha256(manifestBody) };
  await writeJson("v20-freeze-manifest.json", freezeManifest);
  console.info(`V20 freeze complete: ${preReturnAssessment.primaryOosEligibleEvents} Primary OOS event identities, ${preReturnAssessment.primaryOosDistinctSignalClusters} signal clusters`);
  console.info(`V20 manifestBodySha256: ${freezeManifest.manifestBodySha256}`);
}

function assertExactStartingPoint(): void {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== V20_BRANCH) throw new Error(`V20 branch mismatch: ${branch}`);
  if (head !== V20_BASE_SHA) throw new Error(`V20 Freeze must start at exact base ${V20_BASE_SHA}; got ${head}`);
}

function parserSummary(slots: readonly V20ArchiveSlot[], bars: readonly V20Bar[]): Record<string, unknown> {
  const expectedRows = slots.reduce((sum, slot) => sum + slot.expectedFullMonthRows, 0);
  return {
    symbol: slots[0]?.symbol,
    dataType: slots[0]?.dataType,
    archiveSlots: slots.length,
    verifiedArchiveSlots: slots.filter((slot) => slot.status === "VERIFIED").length,
    expectedRows,
    parsedRows: bars.length,
    coverage: expectedRows === 0 ? 0 : bars.length / expectedRows,
    checksumVerified: slots.every((slot) => slot.checksumVerified),
    parserErrors: slots.flatMap((slot) => slot.parserErrors),
    duplicateOpenTimes: countDuplicateOpenTimes(bars),
    monotonicOpenTime: bars.every((bar, index) => index === 0 || bar.openTime > bars[index - 1].openTime),
    cadenceErrors: countCadenceErrors(bars),
  };
}

function archiveSummary(slots: readonly V20ArchiveSlot[]): Record<string, unknown> {
  return {
    totalSlots: slots.length,
    checksumVerifiedSlots: slots.filter((slot) => slot.checksumVerified).length,
    verifiedSlots: slots.filter((slot) => slot.status === "VERIFIED").length,
    missingSlots: slots.filter((slot) => slot.status === "MISSING").length,
    errorSlots: slots.filter((slot) => slot.status === "ERROR").length,
    totalBytes: slots.reduce((sum, slot) => sum + slot.bytes, 0),
  };
}

function buildDataGate(slots: readonly V20ArchiveSlot[], parserByDataset: Record<string, Record<string, unknown>>): Record<string, unknown> & { status: "PASS" | "FAIL" } {
  const datasets = Object.fromEntries(Object.entries(parserByDataset).map(([key, value]) => [key, {
    archiveSlots: value.archiveSlots,
    verifiedArchiveSlots: value.verifiedArchiveSlots,
    coverage: value.coverage,
    checksumVerified: value.checksumVerified,
    parserErrors: value.parserErrors,
    duplicateOpenTimes: value.duplicateOpenTimes,
    monotonicOpenTime: value.monotonicOpenTime,
    cadenceErrors: value.cadenceErrors,
    pass: value.archiveSlots === 67 && value.verifiedArchiveSlots === 67 && value.checksumVerified === true
      && Number(value.coverage) >= 0.999 && value.parserErrors instanceof Array && value.parserErrors.length === 0
      && value.duplicateOpenTimes === 0 && value.monotonicOpenTime === true,
  }]));
  const status = Object.values(datasets).every((dataset) => dataset.pass) && slots.length === V20_EXPECTED_ARCHIVE_SLOTS ? "PASS" : "FAIL";
  return {
    schemaVersion: "v20-data-gate-v1",
    experimentId: V20_EXPERIMENT_ID,
    source: "official Binance Data Vision only",
    expectedArchiveSlots: V20_EXPECTED_ARCHIVE_SLOTS,
    archiveSlots: slots.length,
    checksumVerifiedArchiveSlots: slots.filter((slot) => slot.checksumVerified).length,
    coverageRequirement: 0.999,
    fixedSymbols: V20_SYMBOLS,
    datasets,
    status,
    classification: status === "PASS" ? "V20_DATA_GATE_PASS" : "V20_FAIR_VALUE_DATA_INSUFFICIENT",
    strategyReturnsRead: false,
    historicalReturnsRead: false,
    forwardReturnsRead: false,
    oosMetricsRead: false,
    holdoutRead: false,
    parameterSearch: false,
  };
}

function synchronizationReport(
  symbol: typeof V20_SYMBOLS[number],
  series: V20SynchronizedSeries,
  regularSlots: readonly V20ArchiveSlot[],
  markSlots: readonly V20ArchiveSlot[],
  indexSlots: readonly V20ArchiveSlot[],
): Record<string, unknown> {
  const expectedRows = regularSlots.reduce((sum, slot) => sum + slot.expectedFullMonthRows, 0);
  return {
    symbol,
    expectedRows,
    regularRows: regularSlots.reduce((sum, slot) => sum + slot.rowCount, 0),
    markRows: markSlots.reduce((sum, slot) => sum + slot.rowCount, 0),
    indexRows: indexSlots.reduce((sum, slot) => sum + slot.rowCount, 0),
    synchronizedRows: series.openTimes.length,
    synchronizedCoverage: expectedRows === 0 ? 0 : series.openTimes.length / expectedRows,
    missingSynchronizedRows: Math.max(0, expectedRows - series.openTimes.length),
    duplicateOpenTimes: countDuplicateOpenTimes(series.openTimes),
    cadenceErrors: countCadenceErrors(series.openTimes),
    exactInnerJoin: true,
    joinKey: "openTime",
    nearestTimeJoin: false,
    forwardFill: false,
  };
}

function summarizePrimary(results: readonly ReturnType<typeof enumerateLastMarkEvents>[], events: readonly V20PrimaryEvent[]): Record<string, unknown> {
  return {
    rawExtremeEvents: results.reduce((sum, result) => sum + result.rawExtremeEvents, 0),
    rawExtremeByWindow: sumWindowCounts(results.map((result) => result.rawExtremeByWindow)),
    firstCrossEvents: results.reduce((sum, result) => sum + result.firstCrossEvents, 0),
    firstCrossByWindow: sumWindowCounts(results.map((result) => result.firstCrossByWindow)),
    overlapExcluded: results.reduce((sum, result) => sum + result.overlapExcluded, 0),
    executionReferenceUnavailable: results.reduce((sum, result) => sum + result.executionReferenceUnavailable, 0),
    finalEligibleEvents: events.length,
    eventsBySymbol: countBySymbol(events),
    eventsBySide: sideCounts(events),
  };
}

function summarizeControls(results: readonly V20ControlEnumeration[]): Record<string, unknown> {
  const events = results.flatMap((result) => result.events).sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol));
  return {
    eventCount: events.length,
    eventsBySymbol: countBySymbol(events),
    eventsBySide: sideCounts(events),
    distinctSignalClusters: new Set(events.map((event) => event.clusterId)).size,
    eventDigest: sha256(events),
    events,
  };
}

function countBySymbol(events: readonly { symbol: typeof V20_SYMBOLS[number] }[]): Record<typeof V20_SYMBOLS[number], number> {
  const counts = { BTCUSDT: 0, ETHUSDT: 0, BNBUSDT: 0, DOGEUSDT: 0 };
  for (const event of events) counts[event.symbol] += 1;
  return counts;
}

function sideCounts(events: readonly { side: "LONG" | "SHORT" }[]): Record<"LONG" | "SHORT", number> {
  const counts = { LONG: 0, SHORT: 0 };
  for (const event of events) counts[event.side] += 1;
  return counts;
}

function sumWindowCounts(values: readonly Record<"WARMUP" | "PRIMARY_OOS" | "HOLDOUT_A" | "HOLDOUT_B", number>[]): Record<"WARMUP" | "PRIMARY_OOS" | "HOLDOUT_A" | "HOLDOUT_B", number> {
  return values.reduce((sum, value) => {
    sum.WARMUP += value.WARMUP;
    sum.PRIMARY_OOS += value.PRIMARY_OOS;
    sum.HOLDOUT_A += value.HOLDOUT_A;
    sum.HOLDOUT_B += value.HOLDOUT_B;
    return sum;
  }, { WARMUP: 0, PRIMARY_OOS: 0, HOLDOUT_A: 0, HOLDOUT_B: 0 });
}

function slotOrder(left: V20ArchiveSlot, right: V20ArchiveSlot): number {
  const typeOrder = V20_DATA_TYPES.indexOf(left.dataType) - V20_DATA_TYPES.indexOf(right.dataType);
  return typeOrder || V20_SYMBOLS.indexOf(left.symbol) - V20_SYMBOLS.indexOf(right.symbol) || left.month.localeCompare(right.month);
}

function eventOrder(left: V20PrimaryEvent, right: V20PrimaryEvent): number {
  return left.signalOpenTime - right.signalOpenTime || left.symbol.localeCompare(right.symbol) || left.side.localeCompare(right.side);
}

function countDuplicateOpenTimes(values: readonly number[] | readonly V20Bar[]): number {
  const times = values.map((value) => typeof value === "number" ? value : value.openTime);
  return times.length - new Set(times).size;
}

function countCadenceErrors(values: readonly number[] | readonly V20Bar[]): number {
  const times = values.map((value) => typeof value === "number" ? value : value.openTime);
  let errors = 0;
  for (let index = 1; index < times.length; index += 1) if (times[index] !== times[index - 1] + 5 * 60 * 1000) errors += 1;
  return errors;
}

function weightedCoverage(reports: readonly Record<string, unknown>[]): number {
  const expected = reports.reduce((sum, report) => sum + Number(report.expectedRows ?? 0), 0);
  const observed = reports.reduce((sum, report) => sum + Number(report.synchronizedRows ?? 0), 0);
  return expected === 0 ? 0 : observed / expected;
}

async function writeDataGateFailureFreeze(
  archiveManifest: Record<string, unknown>,
  parserReport: Record<string, unknown>,
  syncReport: Record<string, unknown>,
  dataGate: Record<string, unknown> & { status: "PASS" | "FAIL" },
  slots: readonly V20ArchiveSlot[],
): Promise<void> {
  const preReturnAssessment = {
    schemaVersion: "v20-pre-return-assessment-v1",
    experimentId: V20_EXPERIMENT_ID,
    status: "NOT_RUN_DATA_GATE_FAIL",
    classification: "V20_FAIR_VALUE_DATA_INSUFFICIENT",
    rawExtremeEvents: 0,
    firstCrossEvents: 0,
    overlapExcluded: 0,
    finalEligibleEvents: 0,
    primaryOosEligibleEvents: 0,
    primaryOosDistinctSignalClusters: 0,
    eventsBySymbol: { BTCUSDT: 0, ETHUSDT: 0, BNBUSDT: 0, DOGEUSDT: 0 },
    eventsBySide: { LONG: 0, SHORT: 0 },
    controls: {
      eventCounts: { LAST_INDEX_DISLOCATION: 0, EXTREME_LAST_RETURN_REVERSAL: 0, TIME_MATCHED_RANDOM: 0 },
      identityDigests: { LAST_INDEX_DISLOCATION: null, EXTREME_LAST_RETURN_REVERSAL: null, TIME_MATCHED_RANDOM: null },
    },
    outcomeAccess: {
      historicalReturnsRead: false,
      forwardReturnsRead: false,
      oosMetricsRead: false,
      holdoutRead: false,
      outcomesNotCalculated: true,
    },
  };
  await writeJson("v20-pre-return-assessment.json", preReturnAssessment);

  const reportHashes: Record<string, string> = {};
  for (const report of V20_REPORT_FILES.slice(0, -1)) reportHashes[report] = canonicalTextSha256(await readFile(resolve(report), "utf8"));
  const sourceHashes: Record<string, string> = {};
  for (const source of V20_SOURCE_FILES) sourceHashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  const manifestBody = {
    schemaVersion: "v20-freeze-manifest-v1",
    experimentId: V20_EXPERIMENT_ID,
    repository: "SengC-it/Binance-Crypto-Alerts",
    baseSha: V20_BASE_SHA,
    branch: V20_BRANCH,
    stage: "FREEZE_BEFORE_STRATEGY_RETURNS",
    classification: "V20_FAIR_VALUE_DATA_INSUFFICIENT",
    symbols: V20_SYMBOLS,
    dataSources: {
      exchange: V20_ARCHIVE_EXCHANGE,
      source: "official Binance Data Vision",
      dataTypes: V20_DATA_TYPES,
      expectedArchiveSlots: V20_EXPECTED_ARCHIVE_SLOTS,
      checksumVerifiedArchiveSlots: slots.filter((slot) => slot.checksumVerified).length,
      archiveManifestSha256: reportHashes["reports/v20-archive-manifest.json"],
    },
    parser: {
      parserSha256: reportHashes["reports/v20-parser-report.json"],
      sourceHash: sourceHashes["lib/v20/archive.ts"],
      noSyntheticRows: true,
      noForwardFill: true,
    },
    synchronization: {
      syncReportSha256: reportHashes["reports/v20-sync-report.json"],
      syncEngineSha256: sourceHashes["lib/v20/sync.ts"],
      exactInnerJoinOn: "openTime",
      nearestTimeJoin: false,
      timestampTolerance: 0,
      forwardFill: false,
    },
    signalEngine: {
      signalEngineSha256: sourceHashes["lib/v20/signals.ts"],
      eventEnumerationSha256: null,
      controlIdentityDigest: null,
      preReturnAssessmentSha256: reportHashes["reports/v20-pre-return-assessment.json"],
    },
    parameters: V20_PARAMETERS,
    controls: V20_CONTROLS,
    promotionGates: V20_PROMOTION_GATES,
    reportHashes,
    sourceHashes,
    dataGate: {
      status: dataGate.status,
      dataGateSha256: reportHashes["reports/v20-data-gate.json"],
      synchronizedCoverage: (syncReport.totals as { synchronizedCoverage?: number }).synchronizedCoverage ?? 0,
    },
    enumeration: {
      status: "NOT_RUN_DATA_GATE_FAIL",
      rawExtremeEvents: 0,
      firstCrossEvents: 0,
      overlapExcluded: 0,
      finalEligibleEvents: 0,
      primaryOosEligibleEvents: 0,
      primaryOosDistinctSignalClusters: 0,
      eventsBySymbol: { BTCUSDT: 0, ETHUSDT: 0, BNBUSDT: 0, DOGEUSDT: 0 },
      eventsBySide: { LONG: 0, SHORT: 0 },
      eventDigest: null,
      controlIdentityDigest: null,
    },
    execution: {
      signalBar: "closed 5m synchronized bar",
      nextEntry: "next complete regular futures 5m candle OPEN",
      primaryExit: "next entry candle CLOSE; outcome calculation prohibited in Freeze",
      secondaryDiagnostics: [15, 30],
    },
    costModel: V20_PARAMETERS.costModel,
    windows: {
      warmup: { start: V20_WARMUP_START, endExclusive: V20_PRIMARY_OOS_START },
      primaryOos: { start: V20_PRIMARY_OOS_START, endInclusive: V20_PRIMARY_OOS_END },
      holdoutA: { start: V20_HOLDOUT_A_START, endInclusive: V20_HOLDOUT_A_END },
      holdoutB: { start: V20_HOLDOUT_B_START, endInclusive: V20_END_TIMESTAMP },
    },
    flags: V20_BOUNDARIES,
    sourceFiles: V20_SOURCE_FILES,
    prohibitedBeforeHumanAcceptance: ["strategy returns", "OOS metrics", "holdout performance", "PF", "PnL", "bootstrap return confidence intervals", "promotion decision", "Result commit"],
  };
  await writeJson("v20-freeze-manifest.json", { ...manifestBody, manifestBodySha256: sha256(manifestBody) });
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
