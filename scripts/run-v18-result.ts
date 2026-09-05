import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  prepareOfficialData,
  sha256,
  V18_END,
  V18_MONTHS,
  V18_START,
  V18_SYMBOLS,
  writeJson,
  type V18Symbol,
} from "@/lib/v18/data";
import { buildPreReturnAssessment, type V18PreReturnAssessment, type V18SignalEvent } from "@/lib/v18/engine";
import {
  bootstrapMeanConfidence,
  buildControlEvents,
  controlIdentityDigest,
  inWindow,
  metricsForOutcomes,
  readControlOutcome,
  readFrozenOutcomes,
  V18_BASELINE_ROUND_TRIP_BPS,
  V18_FREEZE_COMMIT,
  V18_FREEZE_MANIFEST_SHA256,
  V18_RESULT_BOUNDARIES,
  V18_RESULT_WINDOWS,
  V18_STRESS_BPS,
  type V18Confidence,
  type V18ControlEvent,
  type V18Metrics,
  type V18Outcome,
  type V18OutcomeRead,
} from "@/lib/v18/result";

const REPORT_DIR = resolve("reports");
const EXPECTED_ARCHIVE_SLOTS = V18_MONTHS.length * V18_SYMBOLS.length;
const EXPECTED_FINAL_EVENTS = 301;
const EXPECTED_BUY_EVENTS = 161;
const EXPECTED_SELL_EVENTS = 140;

interface FreezeDataGate {
  schema: string;
  status: string;
  archive: { enumeratedSlots: number; checksumVerifiedSlots: number; parsedSlots: number; enumerationComplete: boolean; cacheSealed: boolean };
  bySymbol: Record<string, { coverage: number }>;
  returns: { forwardReturnsRead: boolean; strategyReturnsRead: boolean; oosMetricsRead: boolean; holdoutRead: boolean };
}

interface FreezeManifest {
  schema: string;
  baseline: { sha: string; branch: string };
  flags: { forwardReturnsRead: boolean; oosMetricsRead: boolean; holdoutRead: boolean; parameterSearch: boolean; resultCommitCreated: boolean };
  boundaries: { productionChanged: boolean; productionEmail: string; deploy: boolean; merge: boolean; migration: boolean; privateBinanceApi: boolean; orderPlacement: boolean; autoTrading: boolean };
  manifestBodySha256: string;
}

interface PopulationReport {
  eventCount: number;
  outcomeCount: number;
  unavailableCount: number;
  unavailable: Array<{ symbol: V18Symbol; signalOpenTime: number; reason: "NO_60M_EXIT" | "NO_ENTRY" }>;
  metrics: V18Metrics;
}

interface Population {
  events: V18SignalEvent[];
  outcomes: V18Outcome[];
  unavailable: PopulationReport["unavailable"];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V18_FREEZE_DRIFT_ABORTED: ${message}`);
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

function identity(event: { symbol: V18Symbol; signalOpenTime: number }): string {
  return `${event.symbol}:${event.signalOpenTime}`;
}

function assertFreezeBody(freeze: FreezeManifest): void {
  const body = { ...freeze } as Record<string, unknown>;
  delete body.manifestBodySha256;
  assert(freeze.schema === "v18-freeze-manifest-v1", "freeze manifest schema changed");
  assert(freeze.manifestBodySha256 === V18_FREEZE_MANIFEST_SHA256, "freeze manifest body SHA changed");
  assert(sha256(canonicalJson(body)) === V18_FREEZE_MANIFEST_SHA256, "freeze manifest body does not reproduce the approved SHA");
  assert(freeze.baseline.sha === "7b9e5d82f471ee3c9fec07e00101263c8d84e953", "baseline SHA changed");
  assert(freeze.baseline.branch === "feat/v18-taker-flow-absorption-reversal", "freeze branch changed");
  assert(freeze.flags.forwardReturnsRead === false && freeze.flags.oosMetricsRead === false && freeze.flags.holdoutRead === false && freeze.flags.parameterSearch === false && freeze.flags.resultCommitCreated === false, "freeze flags are not closed");
  assert(freeze.boundaries.productionChanged === false && freeze.boundaries.productionEmail === "OFF" && freeze.boundaries.deploy === false && freeze.boundaries.merge === false && freeze.boundaries.migration === false && freeze.boundaries.privateBinanceApi === false && freeze.boundaries.orderPlacement === false && freeze.boundaries.autoTrading === false, "production boundary changed before Result Stage");
}

async function checkFreezeInvariants(prepared: Awaited<ReturnType<typeof prepareOfficialData>>): Promise<{ preReturn: V18PreReturnAssessment; events: V18SignalEvent[]; dataGate: FreezeDataGate; freeze: FreezeManifest }> {
  const [dataGate, preReturn, freeze] = await Promise.all([
    readJson<FreezeDataGate>("v18-data-gate.json"),
    readJson<V18PreReturnAssessment>("v18-pre-return-assessment.json"),
    readJson<FreezeManifest>("v18-freeze-manifest.json"),
  ]);
  assert(dataGate.schema === "v18-data-gate-v1" && dataGate.status === "PASS", "Data Gate is not PASS");
  assert(dataGate.archive.enumeratedSlots === EXPECTED_ARCHIVE_SLOTS && dataGate.archive.checksumVerifiedSlots === EXPECTED_ARCHIVE_SLOTS && dataGate.archive.parsedSlots === EXPECTED_ARCHIVE_SLOTS && dataGate.archive.enumerationComplete && dataGate.archive.cacheSealed, "official archive counts drifted");
  for (const symbol of V18_SYMBOLS) assert(dataGate.bySymbol[symbol]?.coverage >= 0.999, `coverage drifted for ${symbol}`);
  assert(dataGate.returns.forwardReturnsRead === false && dataGate.returns.strategyReturnsRead === false && dataGate.returns.oosMetricsRead === false && dataGate.returns.holdoutRead === false, "Data Gate return flags were opened");
  assert(preReturn.schema === "v18-pre-return-assessment-v1" && preReturn.outcomeData === "NOT_READ" && preReturn.forwardReturnsRead === false && preReturn.oosMetricsRead === false && preReturn.holdoutRead === false, "pre-return assessment was changed or read outcomes");
  assert(preReturn.totals.finalEligibleEvents === EXPECTED_FINAL_EVENTS && preReturn.totals.finalEligibleBuyFlowAbsorbed === EXPECTED_BUY_EVENTS && preReturn.totals.finalEligibleSellFlowAbsorbed === EXPECTED_SELL_EVENTS, "frozen event totals drifted");
  assertFreezeBody(freeze);

  const regenerated = buildPreReturnAssessment(prepared.candles);
  assert(regenerated.assessment.totals.finalEligibleEvents === EXPECTED_FINAL_EVENTS, "regenerated eligible event count drifted");
  assert(regenerated.assessment.totals.finalEligibleBuyFlowAbsorbed === EXPECTED_BUY_EVENTS && regenerated.assessment.totals.finalEligibleSellFlowAbsorbed === EXPECTED_SELL_EVENTS, "regenerated direction totals drifted");
  assert(regenerated.assessment.totals.eventDigestSha256 === preReturn.totals.eventDigestSha256, "frozen event identity digest drifted");
  assert(regenerated.events.length === EXPECTED_FINAL_EVENTS, "regenerated event identities are incomplete");
  assert(regenerated.events.filter((event) => event.flowDirection === "BUY_FLOW_ABSORBED").length === EXPECTED_BUY_EVENTS, "BUY event identities drifted");
  assert(regenerated.events.filter((event) => event.flowDirection === "SELL_FLOW_ABSORBED").length === EXPECTED_SELL_EVENTS, "SELL event identities drifted");
  return { preReturn, events: regenerated.events, dataGate, freeze };
}

function population(events: V18SignalEvent[], outcomesRead: V18OutcomeRead, predicate: (event: V18SignalEvent) => boolean): Population {
  const selectedEvents = events.filter(predicate);
  const selectedKeys = new Set(selectedEvents.map(identity));
  const selectedOutcomes = outcomesRead.outcomes.filter((outcome) => selectedKeys.has(identity(outcome.event)));
  const unavailable = outcomesRead.unavailableEventIdentities.filter((event) => selectedKeys.has(identity(event)));
  return { events: selectedEvents, outcomes: selectedOutcomes, unavailable };
}

function reportPopulation(value: Population, additionalRoundTripBps = 0): PopulationReport {
  return { eventCount: value.events.length, outcomeCount: value.outcomes.length, unavailableCount: value.unavailable.length, unavailable: value.unavailable, metrics: metricsForOutcomes(value.outcomes, additionalRoundTripBps) };
}

function metricByYear(events: V18SignalEvent[], outcomesRead: V18OutcomeRead, year: string): PopulationReport {
  return reportPopulation(population(events, outcomesRead, (event) => new Date(event.signalOpenTime).getUTCFullYear().toString() === year));
}

function periodPopulation(events: V18SignalEvent[], outcomesRead: V18OutcomeRead, start: string, end: string): PopulationReport {
  return reportPopulation(population(events, outcomesRead, (event) => inWindow(event.signalOpenTime, start, end)));
}

function nestedWalkForward(events: V18SignalEvent[], outcomesRead: V18OutcomeRead, primary: PopulationReport): Record<string, unknown> {
  const folds = ["2022", "2023", "2024"].map((year) => ({
    name: `PRIMARY_${year}`,
    training: year === "2022" ? "2021 warmup only" : `prior years through ${Number(year) - 1}`,
    test: `${year}-01-01/${year}-12-31`,
    purgeMinutes: 60,
    embargoMinutes: 60,
    parameterSearch: false,
    metrics: metricByYear(events, outcomesRead, year),
  }));
  return {
    method: "nested purged walk-forward reporting of the frozen rule; no parameters are learned or searched",
    primaryWindow: V18_RESULT_WINDOWS.primaryOos,
    purgeMinutes: 60,
    embargoMinutes: 60,
    innerValidation: "frozen-rule replay only; parameterSearch=false",
    folds,
    aggregate: primary,
  };
}

function costReport(value: Population): Record<string, PopulationReport> {
  return Object.fromEntries([["baseline", 0], ...V18_STRESS_BPS.map((bps) => [`+${bps}bps`, bps])].map(([name, bps]) => [name, reportPopulation(value, bps as number)]));
}

function controlPopulation(controlEvents: V18ControlEvent[], candles: Awaited<ReturnType<typeof prepareOfficialData>>["candles"], predicate: (event: V18ControlEvent) => boolean): { events: V18ControlEvent[]; outcomes: V18Outcome[] } {
  const events = controlEvents.filter(predicate);
  const outcomes = events.map((event) => readControlOutcome(event, candles[event.symbol])).filter((outcome): outcome is V18Outcome => outcome !== null).sort((left, right) => left.entryTime - right.entryTime || left.event.symbol.localeCompare(right.event.symbol));
  return { events, outcomes };
}

function controlsReport(controlEvents: Record<V18ControlEvent["control"], V18ControlEvent[]>, candles: Awaited<ReturnType<typeof prepareOfficialData>>["candles"]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const control of ["EXTREME_FLOW_ONLY", "FLOW_CONTINUATION", "TIME_MATCHED_RANDOM"] as const) {
    const values = controlPopulation(controlEvents[control], candles, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end));
    output[control] = {
      frozen: true,
      identityDigestSha256: controlIdentityDigest(controlEvents[control]),
      allEventCount: controlEvents[control].length,
      primary: { eventCount: values.events.length, outcomeCount: values.outcomes.length, metrics: metricsForOutcomes(values.outcomes) },
      selectionPurpose: control === "TIME_MATCHED_RANDOM" ? "time-matched random side placebo" : "frozen explanatory control; not a promotion candidate",
    };
  }
  return output;
}

function promotionDecision(frozenEventCount: number, primary: PopulationReport, holdoutA: PopulationReport, holdoutB: PopulationReport, btc: PopulationReport, eth: PopulationReport, confidence: V18Confidence, plus10: PopulationReport): { gates: Record<string, boolean>; classification: string; promotion: boolean; researchStop: true } {
  const gates = {
    dataGatePass: true,
    deOverlappedEventsAtLeast300: frozenEventCount >= 300,
    buyAbsorbedAtLeast100: EXPECTED_BUY_EVENTS >= 100,
    sellAbsorbedAtLeast100: EXPECTED_SELL_EVENTS >= 100,
    primaryNetPositive: primary.metrics.netReturn > 0,
    primaryProfitFactorAtLeast1_20: confidence && primary.metrics.profitFactor !== null && primary.metrics.profitFactor >= 1.2,
    bootstrap95PercentLcbPositive: confidence.bootstrapLCB95 > 0,
    holdoutANetPositive: holdoutA.metrics.netReturn > 0,
    holdoutBNetPositive: holdoutB.metrics.netReturn > 0,
    btcNetPositive: btc.metrics.netReturn > 0,
    ethNetPositive: eth.metrics.netReturn > 0,
    plus10BpsNetPositive: plus10.metrics.netReturn > 0,
  };
  const pass = Object.values(gates).every(Boolean);
  return { gates, classification: pass ? "V18_TAKER_FLOW_ABSORPTION_PROMOTION_CANDIDATE" : "V18_TAKER_FLOW_ABSORPTION_REJECTED", promotion: pass, researchStop: true };
}

function textMetric(report: PopulationReport): string {
  return `trades=${report.metrics.trades}, NetR=${report.metrics.netReturn}, AvgR=${report.metrics.averageNetReturnPerTrade}, PF=${report.metrics.profitFactor}, MaxDD=${report.metrics.maxDrawdown}, unavailable=${report.unavailableCount}`;
}

async function main(): Promise<void> {
  const prepared = await prepareOfficialData();
  const invariants = await checkFreezeInvariants(prepared);
  console.log(`[V18] Freeze invariants PASS: ${invariants.events.length} frozen events; returns may now be read once`);

  const outcomesRead = readFrozenOutcomes(invariants.events, prepared.candles);
  const primaryPopulation = population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end));
  const primary = reportPopulation(primaryPopulation);
  const holdoutA = periodPopulation(invariants.events, outcomesRead, V18_RESULT_WINDOWS.holdoutA.start, V18_RESULT_WINDOWS.holdoutA.end);
  const holdoutB = periodPopulation(invariants.events, outcomesRead, V18_RESULT_WINDOWS.holdoutB.start, V18_RESULT_WINDOWS.holdoutB.end);
  const all = reportPopulation(population(invariants.events, outcomesRead, () => true));
  const buy = reportPopulation(population(invariants.events, outcomesRead, (event) => event.flowDirection === "BUY_FLOW_ABSORBED"));
  const sell = reportPopulation(population(invariants.events, outcomesRead, (event) => event.flowDirection === "SELL_FLOW_ABSORBED"));
  const btc = reportPopulation(population(invariants.events, outcomesRead, (event) => event.symbol === "BTCUSDT" && inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end)));
  const eth = reportPopulation(population(invariants.events, outcomesRead, (event) => event.symbol === "ETHUSDT" && inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end)));
  const confidence = bootstrapMeanConfidence(primaryPopulation.outcomes);
  const plus10Primary = reportPopulation(population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end)), 10);
  const controls = buildControlEvents(prepared.candles, invariants.events);
  const decision = promotionDecision(all.eventCount, primary, holdoutA, holdoutB, btc, eth, confidence, plus10Primary);
  const common = { freezeCommit: V18_FREEZE_COMMIT, freezeManifestBodySha256: V18_FREEZE_MANIFEST_SHA256, historicalReturnsRead: true, parameterSearch: false, boundaries: V18_RESULT_BOUNDARIES, generatedAt: new Date().toISOString() };
  const outcomeDefinition = { signal: "frozen closed 5m candle", entry: "next full 5m candle OPEN", exit: "close of the 5m candle ending exactly 60 minutes after entry", directionMapping: { BUY_FLOW_ABSORBED: "SHORT", SELL_FLOW_ABSORBED: "LONG" }, noIntrabarOptimization: true, unavailableOutcome: "NO_60M_EXIT", eventCountRead: EXPECTED_FINAL_EVENTS };

  await writeJson("reports/v18-primary-oos.json", { schema: "v18-primary-oos-result-v1", ...common, window: V18_RESULT_WINDOWS.primaryOos, outcomeDefinition, primary, all, nestedPurgedWalkForward: nestedWalkForward(invariants.events, outcomesRead, primary) });
  await writeJson("reports/v18-directions.json", { schema: "v18-directions-result-v1", ...common, outcomeDefinition, BUY_FLOW_ABSORBED: { mapping: "SHORT", ...buy }, SELL_FLOW_ABSORBED: { mapping: "LONG", ...sell } });
  await writeJson("reports/v18-symbols.json", { schema: "v18-symbols-result-v1", ...common, outcomeDefinition, BTCUSDT: btc, ETHUSDT: eth });
  await writeJson("reports/v18-holdouts.json", { schema: "v18-holdouts-result-v1", ...common, outcomeDefinition, holdoutA: { window: V18_RESULT_WINDOWS.holdoutA, ...holdoutA }, holdoutB: { window: V18_RESULT_WINDOWS.holdoutB, ...holdoutB } });
  await writeJson("reports/v18-yearly.json", { schema: "v18-yearly-result-v1", ...common, outcomeDefinition, years: Object.fromEntries(["2022", "2023", "2024", "2025", "2026"].map((year) => [year, metricByYear(invariants.events, outcomesRead, year)])) });
  await writeJson("reports/v18-confidence.json", { schema: "v18-confidence-result-v1", ...common, outcomeDefinition, primaryBaseline: confidence, primaryPlus10bps: bootstrapMeanConfidence(primaryPopulation.outcomes, 10) });
  await writeJson("reports/v18-cost.json", { schema: "v18-cost-result-v1", ...common, outcomeDefinition, baselineRoundTripBps: V18_BASELINE_ROUND_TRIP_BPS, feeBpsPerSide: 4, slippageBpsPerSide: 2, primary: costReport(population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end))), holdoutA: costReport(population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.holdoutA.start, V18_RESULT_WINDOWS.holdoutA.end))), holdoutB: costReport(population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.holdoutB.start, V18_RESULT_WINDOWS.holdoutB.end))) });
  await writeJson("reports/v18-stress.json", { schema: "v18-stress-result-v1", ...common, outcomeDefinition, additionalRoundTripBps: [...V18_STRESS_BPS], primary: costReport(population(invariants.events, outcomesRead, (event) => inWindow(event.signalOpenTime, V18_RESULT_WINDOWS.primaryOos.start, V18_RESULT_WINDOWS.primaryOos.end))) });
  await writeJson("reports/v18-controls.json", { schema: "v18-controls-result-v1", ...common, outcomeDefinition, controls: controlsReport(controls, prepared.candles) });
  await writeJson("reports/v18-promotion-decision.json", { schema: "v18-promotion-decision-v1", ...common, gateDefinition: { deOverlappedEventsMinimum: 300, buyAbsorbedMinimum: 100, sellAbsorbedMinimum: 100, primaryNetPositive: true, primaryPfAtLeast: 1.2, bootstrap95PercentLcbPositive: true, holdoutNetPositive: true, btcNetPositive: true, ethNetPositive: true, plus10BpsNetPositive: true, anyFailure: "V18_TAKER_FLOW_ABSORPTION_REJECTED" }, decision, controlMetricsAreExplanatoryOnly: true });

  const summary = [
    "# V18 Taker-Flow Absorption Reversal — Result Stage",
    "",
    `- Freeze commit: ${V18_FREEZE_COMMIT}`,
    `- Freeze manifest body SHA256: ${V18_FREEZE_MANIFEST_SHA256}`,
    `- Historical returns read: true (exactly the ${EXPECTED_FINAL_EVENTS} frozen event identities)`,
    `- Outcome: next full 5m OPEN entry; close of the candle ending exactly 60 minutes after entry`,
    `- Costs: 4bps/side fee + 2bps/side slippage; 12bps baseline round trip; +5/+10/+20bps additive stress`,
    "- Parameter search: false; no signal, exit, stop, TP, or loss filtering was changed",
    "",
    `## Primary OOS (2022–2024): ${textMetric(primary)}`,
    `- Bootstrap 95% LCB of mean net return: ${confidence.bootstrapLCB95}`,
    `- +10bps stress: ${textMetric(plus10Primary)}`,
    `- BTC primary: ${textMetric(btc)}`,
    `- ETH primary: ${textMetric(eth)}`,
    `- BUY_FLOW_ABSORBED → SHORT: ${textMetric(buy)}`,
    `- SELL_FLOW_ABSORBED → LONG: ${textMetric(sell)}`,
    `- Holdout A (2025): ${textMetric(holdoutA)}`,
    `- Holdout B (2026-01..07): ${textMetric(holdoutB)}`,
    "",
    "## Frozen promotion decision",
    `- Classification: ${decision.classification}`,
    `- Promotion candidate: ${decision.promotion ? "PASS" : "FAIL"}`,
    "- Research stop: YES",
    "",
    "## Boundaries",
    "- Production changed: NO",
    "- Production Email: OFF",
    "- Deploy: NO",
    "- Merge: NO",
    "- Migration: NO",
    "- Private Binance API / order placement / auto trading: NO",
    "",
    "All detailed metrics, controls, stress cases, yearly partitions, and unavailable outcome identities are in the Result JSON artifacts.",
    "",
  ].join("\n");
  await writeFile(resolve(REPORT_DIR, "v18-validation-summary.md"), summary, "utf8");
  console.log(`[V18] Result complete: ${decision.classification}`);
  console.log(`[V18] Primary: ${textMetric(primary)}`);
  console.log(`[V18] Holdout A: ${textMetric(holdoutA)}`);
  console.log(`[V18] Holdout B: ${textMetric(holdoutB)}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
