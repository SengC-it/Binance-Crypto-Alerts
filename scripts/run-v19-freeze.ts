import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V19_ARCHIVE_EXCHANGE,
  V19_ARCHIVE_ROOT,
  downloadAndParseV19Archive,
  v19MonthKeys,
  type V19ArchiveSlot,
} from "../lib/v19/archive";
import {
  V19_BASE_SHA,
  V19_BRANCH,
  V19_CANDIDATE_SYMBOLS,
  V19_CONTROLS,
  V19_END_EXCLUSIVE_TIMESTAMP,
  V19_END_TIMESTAMP,
  V19_EXPERIMENT_ID,
  V19_FOLLOWER_CANDIDATES,
  V19_INTERVAL_MS,
  V19_LEADER_SYMBOL,
  V19_PARAMETERS,
  V19_PIT_WINDOW_MS,
  V19_PRIMARY_OOS_START,
  V19_PROMOTION_GATES,
  V19_REPORT_FILES,
  V19_SOURCE_FILES,
  V19_START_TIMESTAMP,
  V19_UNDERREACTION_QUANTILE,
  V19_BTC_SHOCK_QUANTILE,
  evaluationWindowFor,
} from "../lib/v19/constants";
import { canonicalJson, canonicalTextSha256, sha256 } from "../lib/v19/canonical";
import {
  directionalUnderreaction,
  fitOls,
  hasOverlap,
  logReturn,
  nearestRankQuantile,
  rollingMedianTradeCountSeries,
  rollingNearestRankQuantileSeries,
  sideForShock,
  type V19Bar,
  type V19PrimaryEvent,
} from "../lib/v19/features";

const REPORT_DIR = resolve("reports");
const MONTHS = v19MonthKeys();
const ARCHIVE_WORKERS = 8;
const PIT_WINDOW_BARS = Math.floor(V19_PIT_WINDOW_MS / V19_INTERVAL_MS);

interface V19Series {
  symbol: string;
  openTimes: Float64Array;
  opens: Float64Array;
  closes: Float64Array;
  tradeCounts: Float64Array;
}

interface SymbolAssessment {
  symbol: string;
  eligible: boolean;
  exclusionReason: string | null;
  verifiedArchiveSlots: number;
  firstAvailableMonth: string | null;
  lastAvailableMonth: string | null;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  combinedRows: number;
  expectedObservedRows: number;
  coverage: number;
  monotonicOpenTime: boolean;
  internalArchiveGaps: number;
}

interface MaterializedSymbol {
  assessment: SymbolAssessment;
  slots: V19ArchiveSlot[];
  series: V19Series | null;
}

interface EnumerationResult {
  btcShockCount: number;
  rawTriggers: number;
  overlapExcluded: number;
  finalEligibleEvents: number;
  distinctShockClusters: number;
  eventsByFollower: Record<string, number>;
  rawEventsByFollower: Record<string, number>;
  longEventCount: number;
  shortEventCount: number;
  executionReferenceUnavailable: number;
  eventDigest: string;
  events: V19PrimaryEvent[];
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const materials = await materializeArchives();
  const assessments = V19_CANDIDATE_SYMBOLS.map((symbol) => materials.get(symbol)!.assessment);
  const leader = materials.get(V19_LEADER_SYMBOL)!.assessment;
  const eligibleFollowers = V19_FOLLOWER_CANDIDATES.filter((symbol) => materials.get(symbol)!.assessment.eligible);
  const excludedFollowers = V19_FOLLOWER_CANDIDATES
    .filter((symbol) => !materials.get(symbol)!.assessment.eligible)
    .map((symbol) => ({ symbol, reason: materials.get(symbol)!.assessment.exclusionReason }));
  const allSlots = [...materials.values()].flatMap((material) => material.slots);
  const checksumVerifiedArchiveSlots = allSlots.filter((slot) => slot.checksumVerified).length;

  const dataGate = {
    schemaVersion: "v19-data-gate-v1",
    experimentId: V19_EXPERIMENT_ID,
    status: leader.eligible && eligibleFollowers.length >= 5 ? "PASS" : "FAIL",
    classification: leader.eligible && eligibleFollowers.length >= 5 ? "V19_DATA_GATE_PASS_PRE_RETURN_ONLY" : "V19_DATA_INSUFFICIENT",
    source: "official Binance Data Vision monthly USD-M 5m kline archives only",
    period: { start: V19_START_TIMESTAMP, endInclusive: V19_END_TIMESTAMP },
    expectedArchiveSlots: V19_CANDIDATE_SYMBOLS.length * MONTHS.length,
    checksumVerifiedArchiveSlots,
    leader,
    eligibleFollowers,
    excludedFollowers,
    minimumEligibleFollowers: 5,
    noSyntheticRows: true,
    noForwardFill: true,
    noCurrentApiBackfill: true,
    strategyReturnsRead: false,
    performanceEvaluation: "NOT_RUN_IN_FREEZE_STAGE",
  };

  await writeJson("v19-universe-feasibility.json", {
    schemaVersion: "v19-universe-feasibility-v1",
    experimentId: V19_EXPERIMENT_ID,
    leader: V19_LEADER_SYMBOL,
    fixedFollowerCandidates: V19_FOLLOWER_CANDIDATES,
    period: { start: V19_START_TIMESTAMP, endInclusive: V19_END_TIMESTAMP, months: MONTHS.length },
    expectedArchiveSlots: V19_CANDIDATE_SYMBOLS.length * MONTHS.length,
    checksumVerifiedArchiveSlots,
    symbols: assessments,
    eligibleFollowers,
    excludedFollowers,
    dataGate: dataGate.status,
    eligibilityRule: "official archive enumeration through each symbol's observed availability, checksum verified, valid OHLC/tradeCount, monotonic 5m timestamps, no internal gaps, observed coverage >= 0.999",
  });

  await writeJson("v19-archive-manifest.json", {
    schemaVersion: "v19-archive-manifest-v1",
    exchange: V19_ARCHIVE_EXCHANGE,
    source: "https://data.binance.vision/data/futures/um/monthly/klines",
    instrumentType: "USD-M_PERPETUAL",
    interval: "5m",
    period: { start: V19_START_TIMESTAMP, endExclusive: V19_END_EXCLUSIVE_TIMESTAMP },
    months: MONTHS,
    expectedSlots: V19_CANDIDATE_SYMBOLS.length * MONTHS.length,
    symbols: V19_CANDIDATE_SYMBOLS,
    slots: allSlots,
    rawBytesAreHashed: true,
    textCanonicalization: "not applied to ZIP bytes; raw ZIP bytes are SHA256 verified against the official CHECKSUM file",
  });

  await writeJson("v19-parser-report.json", {
    schemaVersion: "v19-parser-report-v1",
    parser: "Binance monthly kline CSV parser with strict numeric, OHLC, timestamp, duplicate, and contiguous-row validation",
    retainedFields: [
      "openTime",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "closeTime",
      "quoteVolume",
      "tradeCount",
      "takerBuyBaseVolume",
      "takerBuyQuoteVolume",
    ],
    alphaFieldsOnly: ["openTime", "close", "tradeCount"],
    retainedButNotAlphaFields: ["high", "low", "volume", "quoteVolume", "takerBuyBaseVolume", "takerBuyQuoteVolume"],
    symbols: assessments,
    slotParserErrors: allSlots
      .filter((slot) => slot.parserErrors.length > 0)
      .map((slot) => ({ symbol: slot.symbol, month: slot.month, errors: slot.parserErrors })),
    dataGate: dataGate.status,
    futureOutcomeColumns: "NOT MATERIALIZED",
  });

  await writeJson("v19-data-gate.json", dataGate);

  const enumeration = dataGate.status === "PASS"
    ? enumerateEvents(materials, eligibleFollowers)
    : emptyEnumeration();
  await writeJson("v19-pre-return-assessment.json", {
    schemaVersion: "v19-pre-return-assessment-v1",
    experimentId: V19_EXPERIMENT_ID,
    stage: "PRE_RETURN_EVENT_ENUMERATION",
    dataGate: dataGate.status,
    fixedFollowerCandidates: V19_FOLLOWER_CANDIDATES,
    eligibleFollowers,
    excludedFollowers,
    signalWindow: {
      signalTimeframe: "5m closed candle",
      primaryWindows: ["PRIMARY_OOS", "HOLDOUT_A", "HOLDOUT_B"],
      warmup: "2021 calendar year",
    },
    enumeration: {
      btcShockCount: enumeration.btcShockCount,
      rawV19Triggers: enumeration.rawTriggers,
      overlapExcluded: enumeration.overlapExcluded,
      finalEligibleEvents: enumeration.finalEligibleEvents,
      distinctBtcShockClusters: enumeration.distinctShockClusters,
      eventsByFollower: enumeration.eventsByFollower,
      rawEventsByFollower: enumeration.rawEventsByFollower,
      longEventCount: enumeration.longEventCount,
      shortEventCount: enumeration.shortEventCount,
      executionReferenceUnavailable: enumeration.executionReferenceUnavailable,
      eventDigest: enumeration.eventDigest,
    },
    events: enumeration.events,
    outcomeAccess: {
      historicalReturnsRead: false,
      forwardReturnsRead: false,
      pnlRead: false,
      winRateRead: false,
      profitFactorRead: false,
      holdoutPerformanceRead: false,
      bootstrapRead: false,
      outcomesNotCalculated: true,
    },
  });

  const freezeManifest = await buildFreezeManifest({
    dataGate,
    enumeration,
    eligibleFollowers,
    excludedFollowers,
    checksumVerifiedArchiveSlots,
  });
  await writeJson("v19-freeze-manifest.json", freezeManifest);

  console.info(JSON.stringify({
    stage: "v19_freeze_complete",
    experimentId: V19_EXPERIMENT_ID,
    dataGate: dataGate.status,
    eligibleFollowers,
    checksumVerifiedArchiveSlots,
    btcShockCount: enumeration.btcShockCount,
    rawTriggers: enumeration.rawTriggers,
    finalEligibleEvents: enumeration.finalEligibleEvents,
    historicalReturnsRead: false,
    forwardReturnsRead: false,
    manifestBodySha256: freezeManifest.manifestBodySha256,
  }));
}

async function materializeArchives(): Promise<Map<string, MaterializedSymbol>> {
  const materials = new Map<string, MaterializedSymbol>();
  for (const symbol of V19_CANDIDATE_SYMBOLS) {
    const downloads = await mapWithConcurrency(MONTHS, ARCHIVE_WORKERS, async (month) => {
      return downloadAndParseV19Archive(symbol, month, { rootDir: resolve(V19_ARCHIVE_ROOT) });
    });
    const slots = downloads.map((download) => download.slot);
    const verifiedBars = downloads
      .filter((download) => download.slot.status === "VERIFIED")
      .flatMap((download) => download.bars);
    const assessment = assessSymbol(symbol, slots, verifiedBars);
    const series = assessment.eligible ? compactSeries(symbol, verifiedBars) : null;
    materials.set(symbol, { assessment, slots, series });
    console.info(`${symbol}: ${assessment.eligible ? "eligible" : "excluded"}, verified slots ${assessment.verifiedArchiveSlots}/${MONTHS.length}, rows ${assessment.combinedRows}`);
  }
  return materials;
}

function assessSymbol(symbol: string, slots: V19ArchiveSlot[], bars: V19Bar[]): SymbolAssessment {
  const verifiedSlots = slots.filter((slot) => slot.status === "VERIFIED").sort((left, right) => MONTHS.indexOf(left.month) - MONTHS.indexOf(right.month));
  const firstAvailableMonth = verifiedSlots[0]?.month ?? null;
  const lastAvailableMonth = verifiedSlots.at(-1)?.month ?? null;
  let internalArchiveGaps = 0;
  if (firstAvailableMonth && lastAvailableMonth) {
    const firstIndex = MONTHS.indexOf(firstAvailableMonth);
    const lastIndex = MONTHS.indexOf(lastAvailableMonth);
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      if (slots.find((slot) => slot.month === MONTHS[index])?.status !== "VERIFIED") internalArchiveGaps += 1;
    }
  }
  const combined = [...bars].sort((left, right) => left.openTime - right.openTime);
  let monotonicOpenTime = combined.length > 0;
  let duplicateCount = 0;
  let gapCount = 0;
  for (let index = 1; index < combined.length; index += 1) {
    const delta = combined[index].openTime - combined[index - 1].openTime;
    if (delta === 0) duplicateCount += 1;
    if (delta !== V19_INTERVAL_MS) gapCount += 1;
    if (delta <= 0) monotonicOpenTime = false;
  }
  const firstOpenTime = combined[0]?.openTime ?? null;
  const lastOpenTime = combined.at(-1)?.openTime ?? null;
  const expectedObservedRows = firstOpenTime !== null && lastOpenTime !== null
    ? Math.floor((lastOpenTime - firstOpenTime) / V19_INTERVAL_MS) + 1
    : 0;
  const coverage = expectedObservedRows > 0 ? combined.length / expectedObservedRows : 0;
  const parserOrChecksumFailure = slots.some((slot) => slot.status === "ERROR" && slot.parserErrors.length > 0);
  const eligible = verifiedSlots.length > 0
    && internalArchiveGaps === 0
    && duplicateCount === 0
    && gapCount === 0
    && monotonicOpenTime
    && coverage >= 0.999;
  let exclusionReason: string | null = null;
  if (!eligible) {
    if (verifiedSlots.length === 0) exclusionReason = "OFFICIAL_ARCHIVE_UNAVAILABLE_OR_CHECKSUM_FAILURE";
    else if (parserOrChecksumFailure) exclusionReason = "PARSER_OR_CHECKSUM_FAILURE";
    else if (internalArchiveGaps > 0) exclusionReason = "INTERNAL_ARCHIVE_GAP_OR_UNVERIFIED_SLOT";
    else if (duplicateCount > 0 || !monotonicOpenTime) exclusionReason = "DUPLICATE_OR_NON_MONOTONIC_OPEN_TIME";
    else if (gapCount > 0 || coverage < 0.999) exclusionReason = "PIT_COVERAGE_BELOW_0.999_OR_MISSING_ROW";
    else exclusionReason = "ARCHIVE_INTEGRITY_REQUIREMENT_FAILED";
  }
  return {
    symbol,
    eligible,
    exclusionReason,
    verifiedArchiveSlots: verifiedSlots.length,
    firstAvailableMonth,
    lastAvailableMonth,
    firstOpenTime,
    lastOpenTime,
    combinedRows: combined.length,
    expectedObservedRows,
    coverage,
    monotonicOpenTime,
    internalArchiveGaps,
  };
}

function compactSeries(symbol: string, bars: V19Bar[]): V19Series {
  const openTimes = Float64Array.from(bars, (bar) => bar.openTime);
  const opens = Float64Array.from(bars, (bar) => bar.open);
  const closes = Float64Array.from(bars, (bar) => bar.close);
  const tradeCounts = Float64Array.from(bars, (bar) => bar.tradeCount);
  return { symbol, openTimes, opens, closes, tradeCounts };
}

function enumerateEvents(materials: Map<string, MaterializedSymbol>, eligibleFollowers: string[]): EnumerationResult {
  const leader = materials.get(V19_LEADER_SYMBOL)!.series;
  if (!leader) return emptyEnumeration();
  const followerSeries = new Map<string, V19Series>();
  for (const symbol of eligibleFollowers) {
    const series = materials.get(symbol)!.series;
    if (series) followerSeries.set(symbol, series);
  }
  const absBtcReturns = new Float64Array(leader.closes.length);
  absBtcReturns.fill(Number.NaN);
  for (let index = 1; index < leader.closes.length; index += 1) {
    const value = logReturn(leader.closes[index], leader.closes[index - 1]);
    absBtcReturns[index] = value === null ? Number.NaN : Math.abs(value);
  }
  const shockThresholds = rollingNearestRankQuantileSeries(absBtcReturns, PIT_WINDOW_BARS, V19_BTC_SHOCK_QUANTILE);
  const medianTradeCounts = new Map<string, Float64Array>();
  for (const [symbol, series] of followerSeries) {
    medianTradeCounts.set(symbol, rollingMedianTradeCountSeries(series.openTimes, series.tradeCounts, PIT_WINDOW_BARS));
  }
  const rawEvents: V19PrimaryEvent[] = [];
  const rawEventsByFollower = countRecord(eligibleFollowers);
  let btcShockCount = 0;
  let executionReferenceUnavailable = 0;
  const firstSignalIndex = PIT_WINDOW_BARS + 1;
  for (let signalIndex = firstSignalIndex; signalIndex < leader.openTimes.length; signalIndex += 1) {
    const signalOpenTime = leader.openTimes[signalIndex];
    const evaluationWindow = evaluationWindowFor(signalOpenTime);
    if (!evaluationWindow || evaluationWindow === "WARMUP") continue;
    if (signalOpenTime < Date.parse(V19_PRIMARY_OOS_START) || signalOpenTime > Date.parse(V19_END_TIMESTAMP)) continue;
    const btcReturn = logReturn(leader.closes[signalIndex], leader.closes[signalIndex - 1]);
    const shockThreshold = shockThresholds[signalIndex];
    if (btcReturn === null || !Number.isFinite(shockThreshold) || Math.abs(btcReturn) < shockThreshold) continue;
    btcShockCount += 1;
    const rankableMedians = new Map<string, number>();
    for (const symbol of eligibleFollowers) {
      const series = followerSeries.get(symbol);
      const medians = medianTradeCounts.get(symbol);
      const followerIndex = series ? findExactIndex(series.openTimes, signalOpenTime) : -1;
      const median = followerIndex >= 0 && medians ? medians[followerIndex] : Number.NaN;
      if (Number.isFinite(median)) rankableMedians.set(symbol, median);
    }
    const orderedSymbols = [...rankableMedians.entries()]
      .sort(([leftSymbol, leftCount], [rightSymbol, rightCount]) => leftCount - rightCount || leftSymbol.localeCompare(rightSymbol))
      .map(([symbol]) => symbol);
    const lowLiquidity = new Set(orderedSymbols.slice(0, Math.ceil(orderedSymbols.length / 2)));
    const liquidityRank = new Map(orderedSymbols.map((symbol, index) => [symbol, index]));
    for (const symbol of eligibleFollowers) {
      if (!lowLiquidity.has(symbol)) continue;
      const follower = followerSeries.get(symbol);
      if (!follower) continue;
      const followerIndex = findExactIndex(follower.openTimes, signalOpenTime);
      if (followerIndex < 1) {
        executionReferenceUnavailable += 1;
        continue;
      }
      const median = rankableMedians.get(symbol);
      const feature = median === undefined ? null : evaluateFollowerAt(follower, leader, signalIndex, followerIndex, median);
      if (!feature || feature.directionalUnderreaction < feature.underreactionQ90) continue;
      const entryIndex = followerIndex + 1;
      const nextOpenTime = signalOpenTime + V19_INTERVAL_MS;
      const nextExitOpenTime = nextOpenTime + 2 * V19_INTERVAL_MS;
      const nextOpenAvailable = follower.openTimes[entryIndex] === nextOpenTime;
      const exactExitAvailable = follower.openTimes[entryIndex + 2] === nextExitOpenTime
        && follower.openTimes[entryIndex + 2] + V19_INTERVAL_MS - 1 === nextOpenTime + 15 * 60 * 1000 - 1;
      if (!nextOpenAvailable || !exactExitAvailable || leader.openTimes[signalIndex + 1] !== nextOpenTime) {
        executionReferenceUnavailable += 1;
        continue;
      }
      const side = sideForShock(btcReturn);
      if (!side) continue;
      const event: V19PrimaryEvent = {
        btcShockTimestamp: new Date(signalOpenTime).toISOString(),
        signalTimestamp: new Date(signalOpenTime + V19_INTERVAL_MS - 1).toISOString(),
        signalOpenTime,
        follower: symbol,
        side,
        nextExecutionOpenTime: nextOpenTime,
        executionReferencePrice: follower.opens[entryIndex],
        primaryExitCloseTime: nextOpenTime + 15 * 60 * 1000 - 1,
        evaluationWindow,
        liquidityRank: liquidityRank.get(symbol) ?? -1,
        eligibleFollowerCount: orderedSymbols.length,
      };
      rawEvents.push(event);
      rawEventsByFollower[symbol] += 1;
    }
  }
  rawEvents.sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.follower.localeCompare(right.follower));
  const lastSignalByFollower = new Map<string, number>();
  const events: V19PrimaryEvent[] = [];
  let overlapExcluded = 0;
  for (const event of rawEvents) {
    const lastSignal = lastSignalByFollower.get(event.follower) ?? null;
    if (hasOverlap(lastSignal, event.signalOpenTime)) {
      overlapExcluded += 1;
      continue;
    }
    lastSignalByFollower.set(event.follower, event.signalOpenTime);
    events.push(event);
  }
  const eventsByFollower = countRecord(eligibleFollowers);
  let longEventCount = 0;
  let shortEventCount = 0;
  const clusters = new Set<string>();
  for (const event of events) {
    eventsByFollower[event.follower] += 1;
    clusters.add(event.btcShockTimestamp);
    if (event.side === "LONG") longEventCount += 1;
    else shortEventCount += 1;
  }
  return {
    btcShockCount,
    rawTriggers: rawEvents.length,
    overlapExcluded,
    finalEligibleEvents: events.length,
    distinctShockClusters: clusters.size,
    eventsByFollower,
    rawEventsByFollower,
    longEventCount,
    shortEventCount,
    executionReferenceUnavailable,
    eventDigest: sha256(canonicalJson(events)),
    events,
  };
}

function evaluateFollowerAt(
  follower: V19Series,
  leader: V19Series,
  signalIndex: number,
  followerIndex: number,
  priorMedianTradeCount: number,
): { directionalUnderreaction: number; underreactionQ90: number } | null {
  const signalOpenTime = leader.openTimes[signalIndex];
  const priorStartTime = signalOpenTime - V19_PIT_WINDOW_MS;
  const leaderPriorStart = findExactIndex(leader.openTimes, priorStartTime);
  const followerPriorStart = findExactIndex(follower.openTimes, priorStartTime);
  if (leaderPriorStart < 1 || followerPriorStart < 1 || !Number.isFinite(priorMedianTradeCount)) return null;
  const btcReturns = new Float64Array(PIT_WINDOW_BARS);
  const followerReturns = new Float64Array(PIT_WINDOW_BARS);
  for (let index = 0; index < PIT_WINDOW_BARS; index += 1) {
    const leaderIndex = leaderPriorStart + index;
    const followerRow = followerPriorStart + index;
    const expectedOpenTime = priorStartTime + index * V19_INTERVAL_MS;
    if (leader.openTimes[leaderIndex] !== expectedOpenTime || follower.openTimes[followerRow] !== expectedOpenTime) return null;
    const btcReturn = logReturn(leader.closes[leaderIndex], leader.closes[leaderIndex - 1]);
    const followerReturn = logReturn(follower.closes[followerRow], follower.closes[followerRow - 1]);
    if (btcReturn === null || followerReturn === null) return null;
    btcReturns[index] = btcReturn;
    followerReturns[index] = followerReturn;
  }
  const fit = fitOls(followerReturns, btcReturns);
  const currentBtcReturn = logReturn(leader.closes[signalIndex], leader.closes[signalIndex - 1]);
  const currentFollowerReturn = logReturn(follower.closes[followerIndex], follower.closes[followerIndex - 1]);
  if (!fit || currentBtcReturn === null || currentFollowerReturn === null) return null;
  const currentResidual = currentFollowerReturn - (fit.alpha + fit.beta * currentBtcReturn);
  const priorUnderreaction = new Float64Array(PIT_WINDOW_BARS);
  for (let index = 0; index < PIT_WINDOW_BARS; index += 1) {
    const residual = followerReturns[index] - (fit.alpha + fit.beta * btcReturns[index]);
    priorUnderreaction[index] = directionalUnderreaction(btcReturns[index], residual);
  }
  const underreactionQ90 = nearestRankQuantile(priorUnderreaction, V19_UNDERREACTION_QUANTILE);
  if (underreactionQ90 === null) return null;
  return {
    directionalUnderreaction: directionalUnderreaction(currentBtcReturn, currentResidual),
    underreactionQ90,
  };
}

function findExactIndex(openTimes: ArrayLike<number>, timestamp: number): number {
  let left = 0;
  let right = openTimes.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (openTimes[middle] === timestamp) return middle;
    if (openTimes[middle] < timestamp) left = middle + 1;
    else right = middle - 1;
  }
  return -1;
}

function emptyEnumeration(): EnumerationResult {
  return {
    btcShockCount: 0,
    rawTriggers: 0,
    overlapExcluded: 0,
    finalEligibleEvents: 0,
    distinctShockClusters: 0,
    eventsByFollower: countRecord(V19_FOLLOWER_CANDIDATES),
    rawEventsByFollower: countRecord(V19_FOLLOWER_CANDIDATES),
    longEventCount: 0,
    shortEventCount: 0,
    executionReferenceUnavailable: 0,
    eventDigest: sha256(canonicalJson([])),
    events: [],
  };
}

async function buildFreezeManifest(input: {
  dataGate: Record<string, unknown>;
  enumeration: EnumerationResult;
  eligibleFollowers: string[];
  excludedFollowers: Array<{ symbol: string; reason: string | null }>;
  checksumVerifiedArchiveSlots: number;
}): Promise<Record<string, unknown> & { manifestBodySha256: string }> {
  const reportHashes: Record<string, string> = {};
  for (const report of V19_REPORT_FILES.slice(0, -1)) {
    reportHashes[report] = canonicalTextSha256(await readFile(resolve(report), "utf8"));
  }
  const sourceHashes: Record<string, string> = {};
  for (const source of V19_SOURCE_FILES) {
    sourceHashes[source] = canonicalTextSha256(await readFile(resolve(source), "utf8"));
  }
  const body = {
    schemaVersion: "v19-freeze-manifest-v1",
    experimentId: V19_EXPERIMENT_ID,
    repository: "SengC-it/Binance-Crypto-Alerts",
    baseSha: V19_BASE_SHA,
    branch: V19_BRANCH,
    stage: "FREEZE_BEFORE_STRATEGY_RETURNS",
    fixedCandidateFollowers: V19_FOLLOWER_CANDIDATES,
    eligibleFollowers: input.eligibleFollowers,
    excludedFollowers: input.excludedFollowers,
    archive: {
      exchange: V19_ARCHIVE_EXCHANGE,
      root: "data/raw/v19/archives",
      expectedSlots: V19_CANDIDATE_SYMBOLS.length * MONTHS.length,
      checksumVerifiedSlots: input.checksumVerifiedArchiveSlots,
      period: { start: V19_START_TIMESTAMP, endExclusive: V19_END_EXCLUSIVE_TIMESTAMP },
      rawZipSha256: true,
      officialChecksumRequired: true,
      archiveManifestSha256: reportHashes["reports/v19-archive-manifest.json"],
    },
    parser: {
      parserReportSha256: reportHashes["reports/v19-parser-report.json"],
      alphaFields: ["openTime", "close", "tradeCount"],
      noMissingRowFill: true,
      noSyntheticData: true,
    },
    signalEngine: {
      sourceHashes,
      eventEnumerationSha256: sha256(canonicalJson(input.enumeration.events)),
      eventEnumeration: {
        btcShockCount: input.enumeration.btcShockCount,
        rawTriggers: input.enumeration.rawTriggers,
        overlapExcluded: input.enumeration.overlapExcluded,
        finalEligibleEvents: input.enumeration.finalEligibleEvents,
        distinctShockClusters: input.enumeration.distinctShockClusters,
        eventDigest: input.enumeration.eventDigest,
      },
    },
    parameters: V19_PARAMETERS,
    execution: {
      signalCandle: "closed 5m candle only",
      nextEntry: "next complete 5m candle OPEN",
      primaryExit: "exact close timestamp 15 minutes after entry; missing reference excludes event",
      secondaryDiagnostics: [30, 60],
      nextBarFieldsUsed: ["openTime", "open"],
      nextBarFieldsNotUsedForSignal: ["high", "low", "close", "volume", "quoteVolume", "tradeCount", "takerBuyBaseVolume", "takerBuyQuoteVolume"],
    },
    controls: V19_CONTROLS,
    promotionGates: V19_PROMOTION_GATES,
    requiredArtifactHashes: reportHashes,
    dataGate: input.dataGate,
    flags: {
      historicalReturnsRead: false,
      forwardReturnsRead: false,
      oosMetricsRead: false,
      holdoutRead: false,
      parameterSearch: false,
      resultCommitCreated: false,
      productionChanged: false,
      productionEmail: "OFF",
      deploy: false,
      merge: false,
      migration: false,
      privateBinanceApi: false,
      orderPlacement: false,
      autoTrading: false,
      automaticPromotion: false,
    },
    prohibitedBeforeHumanAcceptance: [
      "strategy returns",
      "OOS metrics",
      "holdout performance",
      "bootstrap return confidence intervals",
      "result commit",
      "Production wiring",
    ],
  };
  return { ...body, manifestBodySha256: sha256(body) };
}

function countRecord(symbols: readonly string[]): Record<string, number> {
  return Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
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
