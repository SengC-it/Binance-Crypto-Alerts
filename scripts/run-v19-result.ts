import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  extractFirstZipFile,
  parseBinanceKlineCsv,
  type V19ArchiveSlot,
} from "../lib/v19/archive";
import {
  V19_BASE_SHA,
  V19_END_TIMESTAMP,
  V19_EXPERIMENT_ID,
  V19_INTERVAL_MS,
  V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS,
  V19_TAKER_FEE_BPS_PER_SIDE,
  V19_SLIPPAGE_BPS_PER_SIDE,
  V19_PRIMARY_OOS_START,
  V19_PRIMARY_OOS_END,
  V19_HOLDOUT_A_START,
  V19_HOLDOUT_A_END,
  V19_HOLDOUT_B_START,
  V19_END_EXCLUSIVE_TIMESTAMP,
  V19_PIT_WINDOW_MS,
  V19_BRANCH,
  V19_LEADER_SYMBOL,
} from "../lib/v19/constants";
import { canonicalJson, sha256, sha256Bytes } from "../lib/v19/canonical";
import {
  bootstrapClusterMean,
  compactSeries,
  evaluateFollowerFeatureAt,
  findExactIndex,
  settleV19Identity,
  summarizeClusters,
  summarizeOutcomes,
  type V19CompactSeries,
  type V19MetricSet,
  type V19NetField,
  type V19Outcome,
  type V19OutcomeIdentity,
} from "../lib/v19/result-engine";
import { hasOverlap, rollingMedianTradeCountSeries, type V19Bar } from "../lib/v19/features";

const REPORT_DIR = resolve("reports");
const ARCHIVE_DIR = resolve("data/raw/v19/archives");
const FREEZE_COMMIT = V19_BASE_SHA === "7b9e5d82f471ee3c9fec07e00101263c8d84e953"
  ? "f10df65620a630add002d0aaf3c0dff4d8f23c83"
  : "FREEZE_COMMIT_DRIFT";
const FREEZE_MANIFEST_HASH = "cf84b3e141b8709cf5dbe254a0767edc110cb48741b5c777d574b60506337e94";
const EXPECTED_EVENT_COUNT = 5_855;
const EXPECTED_CLUSTER_COUNT = 2_872;
const PRIMARY_EXIT_MINUTES = 15;
const OUTCOME_ARTIFACT = "reports/v19-trade-outcomes.json";
const RESULT_REPORTS = [
  "reports/v19-primary-oos.json",
  "reports/v19-holdouts.json",
  "reports/v19-followers.json",
  "reports/v19-directions.json",
  "reports/v19-yearly.json",
  "reports/v19-confidence.json",
  "reports/v19-cost.json",
  "reports/v19-stress.json",
  "reports/v19-concentration.json",
  "reports/v19-controls.json",
  "reports/v19-promotion-decision.json",
  OUTCOME_ARTIFACT,
  "reports/v19-validation-summary.md",
] as const;

interface FrozenEvent extends V19OutcomeIdentity {
  liquidityRank: number;
  eligibleFollowerCount: number;
}

interface ArchiveManifestFile {
  slots: V19ArchiveSlot[];
}

interface PreReturnFile {
  events: FrozenEvent[];
  enumeration: {
    eventDigest: string;
    finalEligibleEvents: number;
    distinctBtcShockClusters: number;
  };
  eligibleFollowers: string[];
}

interface FreezeFile {
  manifestBodySha256: string;
  flags: Record<string, unknown>;
  eligibleFollowers: string[];
}

interface ControlResult {
  name: string;
  identityCount: number;
  unavailable: number;
  trade: V19MetricSet;
  cluster: V19MetricSet;
}

async function main(): Promise<void> {
  const freeze = await readJson("v19-freeze-manifest.json") as unknown as FreezeFile;
  const preReturn = await readJson("v19-pre-return-assessment.json") as unknown as PreReturnFile;
  const archiveManifest = await readJson("v19-archive-manifest.json") as unknown as ArchiveManifestFile;
  assertFreezeIdentity(freeze, preReturn);
  const primaryEvents = preReturn.events;
  const seriesBySymbol = await loadSeries([V19_LEADER_SYMBOL, ...preReturn.eligibleFollowers], archiveManifest.slots);
  const primaryOutcomes = primaryEvents.map((event) => settleV19Identity(event, seriesBySymbol));
  const primaryOosOutcomes = primaryOutcomes.filter((outcome) => outcome.identity.evaluationWindow === "PRIMARY_OOS");
  const holdoutAOutcomes = primaryOutcomes.filter((outcome) => outcome.identity.evaluationWindow === "HOLDOUT_A");
  const holdoutBOutcomes = primaryOutcomes.filter((outcome) => outcome.identity.evaluationWindow === "HOLDOUT_B");
  const primaryOos = summarizeOutcomes(primaryOosOutcomes);
  const primaryOosClusters = summarizeClusters(primaryOosOutcomes);
  const holdoutA = summarizeOutcomes(holdoutAOutcomes);
  const holdoutB = summarizeOutcomes(holdoutBOutcomes);
  const secondaryDiagnostics = [30, 60].map((minutes) => secondaryDiagnostic(primaryOosOutcomes, seriesBySymbol, minutes));

  await writeJson("v19-trade-outcomes.json", withProvenance({
    schemaVersion: "v19-trade-outcomes-v1",
    outcomeDefinition: "directional simple return from exact next 5m open to exact close 15 minutes after entry",
    unavailableOutcomeCount: primaryOutcomes.filter((outcome) => outcome.status !== "SETTLED").length,
    outcomes: primaryOutcomes,
  }));
  await writeJson("v19-primary-oos.json", withProvenance({
    schemaVersion: "v19-primary-oos-v1",
    window: { start: V19_PRIMARY_OOS_START, endInclusive: V19_PRIMARY_OOS_END },
    tradeLevel: primaryOos,
    clusterLevel: primaryOosClusters,
    unavailableOutcomeCount: unavailableCount(primaryOosOutcomes),
    outcomeArtifact: OUTCOME_ARTIFACT,
    secondaryDiagnostics,
  }));
  await writeJson("v19-holdouts.json", withProvenance({
    schemaVersion: "v19-holdouts-v1",
    holdoutA: {
      window: { start: V19_HOLDOUT_A_START, endInclusive: V19_HOLDOUT_A_END },
      tradeLevel: holdoutA,
      clusterLevel: summarizeClusters(holdoutAOutcomes),
      unavailableOutcomeCount: unavailableCount(holdoutAOutcomes),
    },
    holdoutB: {
      window: { start: V19_HOLDOUT_B_START, endInclusive: V19_END_TIMESTAMP },
      tradeLevel: holdoutB,
      clusterLevel: summarizeClusters(holdoutBOutcomes),
      unavailableOutcomeCount: unavailableCount(holdoutBOutcomes),
    },
  }));
  await writeJson("v19-followers.json", withProvenance({
    schemaVersion: "v19-followers-v1",
    window: "PRIMARY_OOS",
    followers: Object.fromEntries(preReturn.eligibleFollowers.map((symbol) => {
      const outcomes = primaryOosOutcomes.filter((outcome) => outcome.identity.follower === symbol);
      return [symbol, {
        tradeLevel: summarizeOutcomes(outcomes),
        clusterLevel: summarizeClusters(outcomes),
        unavailableOutcomeCount: unavailableCount(outcomes),
      }];
    })),
  }));
  await writeJson("v19-directions.json", withProvenance({
    schemaVersion: "v19-directions-v1",
    window: "PRIMARY_OOS",
    LONG: summarizeOutcomes(primaryOosOutcomes.filter((outcome) => outcome.identity.side === "LONG")),
    SHORT: summarizeOutcomes(primaryOosOutcomes.filter((outcome) => outcome.identity.side === "SHORT")),
  }));
  await writeJson("v19-yearly.json", withProvenance({
    schemaVersion: "v19-yearly-v1",
    years: Object.fromEntries([2022, 2023, 2024, 2025, 2026].map((year) => {
      const outcomes = primaryOutcomes.filter((outcome) => new Date(outcome.identity.signalOpenTime).getUTCFullYear() === year);
      return [String(year), summarizeOutcomes(outcomes)];
    })),
    note: "2026 includes data through 2026-07-31 inclusive",
  }));
  await writeJson("v19-confidence.json", withProvenance({
    schemaVersion: "v19-confidence-v1",
    primaryOosTradeLevel: primaryOos,
    primaryOosClusterLevel: primaryOosClusters,
    clusterBootstrap: bootstrapClusterMean(primaryOosOutcomes, "baselineNetReturn", 10_000, 19_019),
    bootstrapUnit: "BTC shock cluster keyed by btcShockTimestamp; deterministic seed 19019",
  }));
  await writeJson("v19-cost.json", withProvenance({
    schemaVersion: "v19-cost-v1",
    assumptions: {
      takerFeeBpsPerSide: V19_TAKER_FEE_BPS_PER_SIDE,
      slippageBpsPerSide: V19_SLIPPAGE_BPS_PER_SIDE,
      baselineRoundTripBps: 14,
      additionalStressBps: [...V19_STRESS_ADDITIONAL_ROUND_TRIP_BPS],
      funding: "not part of frozen V19 cost model",
    },
    primaryOos: {
      grossReturn: primaryOos.grossReturn,
      feeCost: primaryOos.feeCost,
      slippageCost: primaryOos.slippageCost,
      netReturn: primaryOos.netReturn,
    },
  }));
  await writeJson("v19-stress.json", withProvenance({
    schemaVersion: "v19-stress-v1",
    primaryOos: stressSummaries(primaryOosOutcomes),
    holdoutA: stressSummaries(holdoutAOutcomes),
    holdoutB: stressSummaries(holdoutBOutcomes),
    promotionStress: "+10bps additional round-trip cost; no horizon selection",
  }));
  await writeJson("v19-concentration.json", withProvenance({
    schemaVersion: "v19-concentration-v1",
    primaryOos: concentration(primaryOosOutcomes, preReturn.eligibleFollowers),
  }));

  const controls = buildAndSettleControls(primaryEvents, preReturn.eligibleFollowers, seriesBySymbol);
  await writeJson("v19-controls.json", withProvenance({
    schemaVersion: "v19-controls-v1",
    controlScope: "pre-registered explanatory controls evaluated only on the frozen primary BTC-shock cluster timestamps; never used for selection",
    controls,
  }));

  const promotion = buildPromotionDecision({
    primaryOos,
    primaryOosClusters,
    holdoutA,
    holdoutB,
    primaryOosOutcomes,
    yearly: [2022, 2023, 2024].map((year) => summarizeOutcomes(primaryOutcomes.filter((outcome) => new Date(outcome.identity.signalOpenTime).getUTCFullYear() === year))),
    concentration: concentration(primaryOosOutcomes, preReturn.eligibleFollowers),
    controls,
    eligibleFollowers: preReturn.eligibleFollowers,
  });
  await writeJson("v19-promotion-decision.json", withProvenance({
    schemaVersion: "v19-promotion-decision-v1",
    ...promotion,
  }));
  await writeFile(resolve(REPORT_DIR, "v19-validation-summary.md"), validationSummary({
    primaryOos,
    primaryOosClusters,
    holdoutA,
    holdoutB,
    promotion,
    unavailable: primaryOutcomes.filter((outcome) => outcome.status !== "SETTLED").length,
  }), "utf8");

  console.info(JSON.stringify({
    stage: "v19_result_complete",
    primaryTrades: primaryOos.trades,
    primaryClusters: primaryOos.distinctClusters,
    primaryNet: primaryOos.netReturn,
    primaryAvgNet: primaryOos.averageNetReturn,
    primaryPF: primaryOos.profitFactor,
    clusterLCB95: bootstrapClusterMean(primaryOosOutcomes, "baselineNetReturn", 10_000, 19_019).lcb95,
    holdoutANet: holdoutA.netReturn,
    holdoutBNet: holdoutB.netReturn,
    stress10Net: summarizeOutcomes(primaryOosOutcomes, "stress10NetReturn").netReturn,
    classification: promotion.classification,
    historicalReturnsRead: true,
    parameterSearch: false,
  }));
}

function assertFreezeIdentity(freeze: FreezeFile, preReturn: PreReturnFile): void {
  if (freeze.manifestBodySha256 !== FREEZE_MANIFEST_HASH) throw new Error("Freeze manifest hash drift");
  if (preReturn.events.length !== EXPECTED_EVENT_COUNT) throw new Error("Frozen event count drift");
  if (preReturn.enumeration.finalEligibleEvents !== EXPECTED_EVENT_COUNT) throw new Error("Frozen final event count drift");
  if (preReturn.enumeration.distinctBtcShockClusters !== EXPECTED_CLUSTER_COUNT) throw new Error("Frozen cluster count drift");
  if (sha256(canonicalJson(preReturn.events)) !== preReturn.enumeration.eventDigest) throw new Error("Frozen event digest drift");
  if (canonicalJson(preReturn.eligibleFollowers) !== canonicalJson(["BNBUSDT", "ADAUSDT", "BCHUSDT", "DOGEUSDT", "LINKUSDT", "DOTUSDT"])) {
    throw new Error("Frozen eligible follower universe drift");
  }
  const requiredFlags: Record<string, unknown> = {
    historicalReturnsRead: false,
    forwardReturnsRead: false,
    oosMetricsRead: false,
    holdoutRead: false,
    parameterSearch: false,
  };
  for (const [key, expected] of Object.entries(requiredFlags)) if (freeze.flags[key] !== expected) throw new Error(`Freeze flag drift: ${key}`);
}

async function loadSeries(symbols: readonly string[], slots: readonly V19ArchiveSlot[]): Promise<Map<string, V19CompactSeries>> {
  const result = new Map<string, V19CompactSeries>();
  for (const symbol of symbols) {
    const bars: V19Bar[] = [];
    for (const slot of slots.filter((item) => item.symbol === symbol && item.status === "VERIFIED")) {
      if (!slot.checksumVerified || !slot.sha256) throw new Error(`Unverified archive slot ${symbol}/${slot.month}`);
      const path = resolve(ARCHIVE_DIR, `${symbol}-5m-${slot.month}.zip`);
      const zipBytes = new Uint8Array(await readFile(path));
      if (sha256Bytes(zipBytes) !== slot.sha256) throw new Error(`Archive changed after Freeze: ${symbol}/${slot.month}`);
      const parsed = parseBinanceKlineCsv(new TextDecoder().decode(extractFirstZipFile(zipBytes)), symbol);
      if (parsed.errors.length > 0) throw new Error(`Parser drift in ${symbol}/${slot.month}: ${parsed.errors.join("; ")}`);
      bars.push(...parsed.bars);
    }
    bars.sort((left, right) => left.openTime - right.openTime);
    result.set(symbol, compactSeries(symbol, bars));
  }
  return result;
}

function secondaryDiagnostic(outcomes: readonly V19Outcome[], seriesBySymbol: ReadonlyMap<string, V19CompactSeries>, horizonMinutes: number): Record<string, unknown> {
  const diagnosticOutcomes: V19Outcome[] = [];
  let unavailable = 0;
  for (const outcome of outcomes) {
    const identity = outcome.identity;
    const series = seriesBySymbol.get(identity.follower);
    if (!series || outcome.status !== "SETTLED") {
      unavailable += 1;
      continue;
    }
    const entryIndex = findExactIndex(series.openTimes, identity.nextExecutionOpenTime);
    const exitCloseTime = identity.nextExecutionOpenTime + horizonMinutes * 60 * 1000 - 1;
    const exitIndex = findExactIndex(series.openTimes, exitCloseTime - V19_INTERVAL_MS + 1);
    if (entryIndex < 0 || exitIndex < 0 || series.openTimes[exitIndex] + V19_INTERVAL_MS - 1 !== exitCloseTime) {
      unavailable += 1;
      continue;
    }
    const entryPrice = series.opens[entryIndex];
    const exitPrice = series.closes[exitIndex];
    const grossReturn = identity.side === "LONG" ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1;
    const net = grossReturn - 14 / 10_000;
    diagnosticOutcomes.push({ ...outcome, grossReturn, baselineNetReturn: net, stress5NetReturn: net - 5 / 10_000, stress10NetReturn: net - 10 / 10_000, stress20NetReturn: net - 20 / 10_000 });
  }
  return {
    horizonMinutes,
    classification: "SECONDARY_DIAGNOSTIC",
    promotionEligible: false,
    tradeLevel: summarizeOutcomes(diagnosticOutcomes),
    unavailableOutcomeCount: unavailable,
  };
}

function stressSummaries(outcomes: readonly V19Outcome[]): Record<string, V19MetricSet> {
  return {
    baseline: summarizeOutcomes(outcomes, "baselineNetReturn"),
    additional5bps: summarizeOutcomes(outcomes, "stress5NetReturn"),
    additional10bps: summarizeOutcomes(outcomes, "stress10NetReturn"),
    additional20bps: summarizeOutcomes(outcomes, "stress20NetReturn"),
  };
}

function concentration(outcomes: readonly V19Outcome[], followers: readonly string[]): Record<string, unknown> {
  const settled = outcomes.filter((outcome) => outcome.status === "SETTLED");
  const totalPositiveGross = settled.reduce((total, outcome) => total + Math.max(0, outcome.grossReturn ?? 0), 0);
  const perFollower = Object.fromEntries(followers.map((symbol) => {
    const rows = settled.filter((outcome) => outcome.identity.follower === symbol);
    const positiveGross = rows.reduce((total, outcome) => total + Math.max(0, outcome.grossReturn ?? 0), 0);
    return [symbol, {
      trades: rows.length,
      tradeCountShare: settled.length === 0 ? 0 : rows.length / settled.length,
      positiveGrossContributionShare: totalPositiveGross === 0 ? 0 : positiveGross / totalPositiveGross,
    }];
  }));
  const values = Object.values(perFollower) as Array<{ tradeCountShare: number; positiveGrossContributionShare: number }>;
  return {
    perFollower,
    maxFollowerTradeCountShare: Math.max(0, ...values.map((value) => value.tradeCountShare)),
    maxPositiveGrossContributionShare: Math.max(0, ...values.map((value) => value.positiveGrossContributionShare)),
  };
}

function buildAndSettleControls(primaryEvents: readonly FrozenEvent[], followers: readonly string[], seriesBySymbol: ReadonlyMap<string, V19CompactSeries>): Record<string, ControlResult> {
  const leader = seriesBySymbol.get("BTCUSDT");
  if (!leader) throw new Error("BTC leader series unavailable");
  const medians = new Map<string, Float64Array>();
  for (const symbol of followers) {
    const series = seriesBySymbol.get(symbol);
    if (series) medians.set(symbol, rollingMedianTradeCountSeries(series.openTimes, series.tradeCounts, Math.floor(V19_PIT_WINDOW_MS / V19_INTERVAL_MS)));
  }
  const clusterEvents = [...new Map(primaryEvents.map((event) => [event.btcShockTimestamp, event])).values()]
    .sort((left, right) => left.signalOpenTime - right.signalOpenTime);
  const lowIdentities: V19OutcomeIdentity[] = [];
  const highIdentities: V19OutcomeIdentity[] = [];
  for (const cluster of clusterEvents) {
    const rankable = followers.map((symbol) => {
      const series = seriesBySymbol.get(symbol);
      const median = series && medians.get(symbol);
      const index = series ? findExactIndex(series.openTimes, cluster.signalOpenTime) : -1;
      const value = index >= 0 && median ? median[index] : Number.NaN;
      return { symbol, value };
    }).filter((item) => Number.isFinite(item.value)).sort((left, right) => left.value - right.value || left.symbol.localeCompare(right.symbol));
    const lowCount = Math.ceil(rankable.length / 2);
    const low = new Set(rankable.slice(0, lowCount).map((item) => item.symbol));
    const high = rankable.slice(lowCount).map((item) => item.symbol);
    for (const symbol of rankable.map((item) => item.symbol)) {
      const series = seriesBySymbol.get(symbol);
      if (!series) continue;
      const index = findExactIndex(series.openTimes, cluster.signalOpenTime);
      const entryIndex = index + 1;
      if (index < 1 || series.openTimes[entryIndex] !== cluster.nextExecutionOpenTime) continue;
      const identity = makeControlIdentity(cluster, symbol, series.opens[entryIndex], low.has(symbol) ? "BTC_SHOCK_ONLY_LOW_LIQ" : "HIGH_LIQUIDITY_UNDERREACTION");
      if (low.has(symbol)) lowIdentities.push(identity);
      else if (high.includes(symbol)) {
        const median = medians.get(symbol)?.[index];
        const feature = median === undefined ? null : evaluateFollowerFeatureAt(leader, series, cluster.signalOpenTime, median);
        if (feature && feature.directionalUnderreaction >= feature.underreactionQ90) highIdentities.push(identity);
      }
    }
  }
  const randomIdentities = buildRandomPlaceboIdentities(primaryEvents, followers, seriesBySymbol);
  return {
    BTC_SHOCK_ONLY_LOW_LIQ: controlSummary("BTC_SHOCK_ONLY_LOW_LIQ", deoverlap(lowIdentities), seriesBySymbol),
    HIGH_LIQUIDITY_UNDERREACTION: controlSummary("HIGH_LIQUIDITY_UNDERREACTION", deoverlap(highIdentities), seriesBySymbol),
    TIME_MATCHED_RANDOM: controlSummary("TIME_MATCHED_RANDOM", deoverlap(randomIdentities), seriesBySymbol),
  };
}

function makeControlIdentity(event: FrozenEvent, follower: string, executionReferencePrice: number, controlName: string): V19OutcomeIdentity {
  return {
    btcShockTimestamp: event.btcShockTimestamp,
    signalTimestamp: event.signalTimestamp,
    signalOpenTime: event.signalOpenTime,
    follower,
    side: event.side,
    nextExecutionOpenTime: event.nextExecutionOpenTime,
    executionReferencePrice,
    primaryExitCloseTime: event.nextExecutionOpenTime + PRIMARY_EXIT_MINUTES * 60 * 1000 - 1,
    evaluationWindow: event.evaluationWindow,
    controlName,
  };
}

function buildRandomPlaceboIdentities(events: readonly FrozenEvent[], followers: readonly string[], seriesBySymbol: ReadonlyMap<string, V19CompactSeries>): V19OutcomeIdentity[] {
  const groups = new Map<string, FrozenEvent[]>();
  for (const event of events) {
    const date = new Date(event.signalOpenTime);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCHours()}-${event.side}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const random = mulberry32(19_020);
  const identities: V19OutcomeIdentity[] = [];
  for (const group of groups.values()) {
    const labels = group.map((event) => event.follower);
    for (let index = labels.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [labels[index], labels[swapIndex]] = [labels[swapIndex], labels[index]];
    }
    group.sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.follower.localeCompare(right.follower));
    group.forEach((event, index) => {
      const follower = followers.includes(labels[index]) ? labels[index] : followers[0];
      const series = seriesBySymbol.get(follower);
      const entryIndex = series ? findExactIndex(series.openTimes, event.nextExecutionOpenTime) : -1;
      identities.push(makeControlIdentity(event, follower, entryIndex >= 0 ? series!.opens[entryIndex] : 0, "TIME_MATCHED_RANDOM"));
    });
  }
  return identities;
}

function deoverlap(identities: readonly V19OutcomeIdentity[]): V19OutcomeIdentity[] {
  const ordered = [...identities].sort((left, right) => left.signalOpenTime - right.signalOpenTime || left.follower.localeCompare(right.follower));
  const result: V19OutcomeIdentity[] = [];
  const lastByFollower = new Map<string, number>();
  for (const identity of ordered) {
    const last = lastByFollower.get(identity.follower) ?? null;
    if (hasOverlap(last, identity.signalOpenTime)) continue;
    lastByFollower.set(identity.follower, identity.signalOpenTime);
    result.push(identity);
  }
  return result;
}

function controlSummary(name: string, identities: readonly V19OutcomeIdentity[], seriesBySymbol: ReadonlyMap<string, V19CompactSeries>): ControlResult {
  const outcomes = identities.map((identity) => settleV19Identity(identity, seriesBySymbol));
  return {
    name,
    identityCount: identities.length,
    unavailable: unavailableCount(outcomes),
    trade: summarizeOutcomes(outcomes),
    cluster: summarizeClusters(outcomes),
  };
}

function buildPromotionDecision(input: {
  primaryOos: V19MetricSet;
  primaryOosClusters: V19MetricSet;
  holdoutA: V19MetricSet;
  holdoutB: V19MetricSet;
  primaryOosOutcomes: readonly V19Outcome[];
  yearly: V19MetricSet[];
  concentration: Record<string, unknown>;
  controls: Record<string, ControlResult>;
  eligibleFollowers: readonly string[];
}): { gates: Record<string, boolean>; classification: string; promotion: "PASS" | "FAIL"; researchStop: "YES" | "NO"; informationGain: { controlA: number | null; controlB: number | null; primary: number | null; pass: boolean } } {
  const bootstrap = bootstrapClusterMean(input.primaryOosOutcomes, "baselineNetReturn", 10_000, 19_019);
  const controlA = input.controls.BTC_SHOCK_ONLY_LOW_LIQ.trade.averageNetReturn;
  const controlB = input.controls.HIGH_LIQUIDITY_UNDERREACTION.trade.averageNetReturn;
  const primaryAvg = input.primaryOos.averageNetReturn;
  const followersWith50 = input.eligibleFollowers.filter((symbol) => input.primaryOosOutcomes.filter((outcome) => outcome.status === "SETTLED" && outcome.identity.follower === symbol).length >= 50).length;
  const profitableFollowers = input.eligibleFollowers.filter((symbol) => summarizeOutcomes(input.primaryOosOutcomes.filter((outcome) => outcome.identity.follower === symbol)).netReturn > 0).length;
  const profitableYears = input.yearly.filter((metric) => metric.netReturn > 0).length;
  const maxTradeShare = Number(input.concentration.maxFollowerTradeCountShare);
  const maxPositiveContribution = Number(input.concentration.maxPositiveGrossContributionShare);
  const gates = {
    eligibleFollowers: input.eligibleFollowers.length >= 5,
    primaryTrades: input.primaryOos.trades >= 500,
    shockClusters: input.primaryOos.distinctClusters >= 200,
    followersWithAtLeast50Trades: followersWith50 >= 4,
    primaryNetPositive: input.primaryOos.netReturn > 0,
    primaryPf: input.primaryOos.profitFactor !== null && input.primaryOos.profitFactor >= 1.25,
    primaryAvgNetPositive: primaryAvg !== null && primaryAvg > 0,
    clusterBootstrapLcb95Positive: bootstrap.lcb95 !== null && bootstrap.lcb95 > 0,
    holdoutANetPositive: input.holdoutA.netReturn > 0,
    holdoutBNetPositive: input.holdoutB.netReturn > 0,
    stress10NetPositive: summarizeOutcomes(input.primaryOosOutcomes, "stress10NetReturn").netReturn > 0,
    profitableFollowers: profitableFollowers >= 4,
    profitableYears: profitableYears >= 2,
    maxFollowerTradeShare: maxTradeShare <= 0.35,
    maxPositiveGrossContribution: maxPositiveContribution <= 0.4,
    informationGain: primaryAvg !== null && controlA !== null && controlB !== null && primaryAvg > controlA && primaryAvg > controlB,
  };
  const pass = Object.values(gates).every(Boolean);
  return {
    gates,
    classification: pass ? "V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP_PROMOTION_CANDIDATE" : "V19_BTC_SHOCK_LOW_LIQUIDITY_ALT_CATCHUP_REJECTED",
    promotion: pass ? "PASS" : "FAIL",
    researchStop: pass ? "NO" : "YES",
    informationGain: { controlA, controlB, primary: primaryAvg, pass: gates.informationGain },
  };
}

function validationSummary(input: { primaryOos: V19MetricSet; primaryOosClusters: V19MetricSet; holdoutA: V19MetricSet; holdoutB: V19MetricSet; promotion: ReturnType<typeof buildPromotionDecision>; unavailable: number }): string {
  return `# V19 Result Validation Summary\n\n- Experiment: \`${V19_EXPERIMENT_ID}\`\n- Freeze commit: \`${FREEZE_COMMIT}\`\n- Freeze manifestBodySha256: \`${FREEZE_MANIFEST_HASH}\`\n- Frozen event identities: \`${EXPECTED_EVENT_COUNT}\`; frozen BTC-shock clusters: \`${EXPECTED_CLUSTER_COUNT}\`.\n- Historical returns read: **true**, exactly once from frozen event identities.\n- Parameter search: **false**.\n\n## Primary OOS\n\n- Trades: ${input.primaryOos.trades}; clusters: ${input.primaryOosClusters.distinctClusters}; net: ${input.primaryOos.netReturn}; average net: ${input.primaryOos.averageNetReturn}; PF: ${input.primaryOos.profitFactor}; cluster bootstrap LCB95 is recorded in \`v19-confidence.json\`.\n- Outcome data unavailable: ${input.unavailable}.\n\n## Holdouts\n\n- Holdout A net: ${input.holdoutA.netReturn}\n- Holdout B net: ${input.holdoutB.netReturn}\n\n## Decision\n\n- Classification: **${input.promotion.classification}**\n- Promotion: **${input.promotion.promotion}**\n- Research stop: **${input.promotion.researchStop}**\n- Production Email remains **OFF**; no deploy, merge, migration, private API, order placement, or auto trading.\n`;
}

function withProvenance<T extends Record<string, unknown>>(value: T): T & { provenance: Record<string, unknown> } {
  return {
    ...value,
    provenance: {
      experimentId: V19_EXPERIMENT_ID,
      repository: "SengC-it/Binance-Crypto-Alerts",
      branch: V19_BRANCH,
      freezeCommit: FREEZE_COMMIT,
      freezeManifestBodySha256: FREEZE_MANIFEST_HASH,
      historicalReturnsRead: true,
      parameterSearch: false,
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
  };
}

function unavailableCount(outcomes: readonly V19Outcome[]): number {
  return outcomes.filter((outcome) => outcome.status !== "SETTLED").length;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
