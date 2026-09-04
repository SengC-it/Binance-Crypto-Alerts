import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMaterializedArchives, readJson, V17_BASELINE, V17_BRANCH, V17_END, V17_DATA_ROOT, type V17ParsedDatasets, type V17Symbol } from "../lib/v17/data";
import { buildSignalEvents, metricsFor, runDelayMatrix, runEngine, type V17Metrics, type V17SignalEvent, type V17Trade } from "../lib/v17/engine";

const REPORT_DIR = resolve("reports");
const FREEZE_PATH = resolve(REPORT_DIR, "v17-freeze-manifest.json");
const GATE_PATH = resolve(REPORT_DIR, "v17-data-gate.json");
const RESULT_NAMES = ["v17-primary-oos.json", "v17-yearly.json", "v17-holdouts.json", "v17-instrument-sides.json", "v17-directions.json", "v17-placebos.json", "v17-cost.json", "v17-manual-delay.json", "v17-fixed-horizon.json", "v17-confidence.json", "v17-email-utility.json"];

async function writeJson(name: string, value: unknown): Promise<void> { await mkdir(REPORT_DIR, { recursive: true }); await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function period(year: number): { start: number; end: number } { return { start: Date.parse(`${year}-01-01T00:00:00.000Z`), end: Date.parse(`${year}-12-31T23:59:59.999Z`) }; }
function metric(metrics: V17Metrics): Record<string, number> { return { trades: metrics.trades, wins: metrics.wins, losses: metrics.losses, winRate: metrics.winRate, grossR: metrics.grossR, feesR: metrics.feesR, slippageR: metrics.slippageR, fundingR: metrics.fundingR, netR: metrics.netR, netPnL: metrics.netPnl, avgR: metrics.avgR, PF: metrics.profitFactor, maxDD: metrics.maxDrawdownR, CVaR95: metrics.cvar95R }; }
function tradesFor(result: { trades: V17Trade[] }): V17Metrics { return metricsFor(result.trades); }
function bootstrap(values: number[], repetitions = 1000): { average: number; ci95: [number, number]; lcb95: number } {
  if (!values.length) return { average: 0, ci95: [0, 0], lcb95: 0 };
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const samples: number[] = [];
  const block = Math.max(1, Math.floor(Math.sqrt(values.length)));
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += block) {
      const start = (repetition * 37 + index * 13) % values.length;
      for (let offset = 0; offset < block && index + offset < values.length; offset += 1) sum += values[(start + offset) % values.length];
    }
    samples.push(sum / values.length);
  }
  samples.sort((left, right) => left - right);
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * q))];
  return { average, ci95: [at(0.025), at(0.975)], lcb95: at(0.025) };
}

function eventMonthCounts(events: V17SignalEvent[]): number[] {
  const counts = new Map<string, number>();
  for (const event of events.filter((item) => item.primaryEligible)) {
    const key = new Date(event.fundingTimestamp).toISOString().slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()];
}

function capitalSimulation(trades: V17Trade[], capital: number): Record<string, number> {
  const scale = capital / 10_000;
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  for (const trade of trades.slice().sort((left, right) => left.exitTime - right.exitTime)) { equity += trade.netPnl * scale; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return { initial: capital, final: equity, netPnL: equity - capital, maxDD: maxDrawdown };
}

function futureHorizon(datasets: V17ParsedDatasets, events: V17SignalEvent[], hours: number): { observations: number; averageDirectionalReturn: number } {
  const values: number[] = [];
  for (const event of events.filter((item) => item.primaryEligible)) {
    const data = datasets[event.symbol];
    const target = event.decisionTime + hours * 3_600_000;
    const candle = data.candles15m.find((item) => item.closeTime >= target);
    if (!candle || event.priceAtFunding <= 0) continue;
    values.push(event.direction * (candle.close / event.priceAtFunding - 1));
  }
  return { observations: values.length, averageDirectionalReturn: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 };
}

function timeMatchedRandom(events: V17SignalEvent[], datasets: V17ParsedDatasets): V17Trade[] {
  const trades: V17Trade[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event.primaryEligible) continue;
    const data = datasets[event.symbol];
    const sameBucket = data.funding.filter((point) => {
      const original = new Date(event.fundingTimestamp);
      const candidate = new Date(point.timestamp);
      return point.timestamp !== event.fundingTimestamp && original.getUTCFullYear() === candidate.getUTCFullYear() && original.getUTCMonth() === candidate.getUTCMonth() && original.getUTCHours() === candidate.getUTCHours();
    });
    if (!sameBucket.length) continue;
    const shifted = sameBucket[index % sameBucket.length];
    const pseudo: V17SignalEvent = { ...event, fundingTimestamp: shifted.timestamp, decisionTime: shifted.timestamp + 30 * 60_000 };
    const result = runEngine({ BTCUSDT: datasets.BTCUSDT, ETHUSDT: datasets.ETHUSDT }, "PRIMARY", 0, pseudo.fundingTimestamp, pseudo.fundingTimestamp);
    trades.push(...result.trades.slice(0, 1));
  }
  return trades;
}

async function writeFailClosed(freeze: Record<string, unknown>, gate: Record<string, unknown>): Promise<void> {
  const reason = `DATA_GATE_FAIL: ${((gate.reasons as unknown[]) ?? []).join(", ")}`;
  const notRun = { status: "NOT_RUN", reason, historicalReturnsRead: false, metrics: null };
  for (const name of RESULT_NAMES) await writeJson(name, notRun);
  await writeJson("v17-validation-summary.json", { schema: "v17-validation-summary-v1", baseline: V17_BASELINE, branch: V17_BRANCH, freezeSha256: freeze.manifestSha256, dataGate: "FAIL", historicalReturnsRead: false, result: "V17_DATA_INSUFFICIENT_FINAL", emailPromotionCandidate: "FAIL", researchStop: "YES", reasons: gate.reasons, boundaries: { productionEmail: "OFF", productionChanged: "NO", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" } });
  await writeJson("v17-promotion-decision.json", { schema: "v17-promotion-decision-v1", classification: "V17_DATA_INSUFFICIENT_FINAL", dataGate: "FAIL", historicalReturnsRead: false, emailPromotionCandidate: "FAIL", researchStop: "YES", reasons: gate.reasons });
  await writeJson("v17-promotion-decision.md", { classification: "V17_DATA_INSUFFICIENT_FINAL", historicalReturns: "NOT READ", promotion: "FAIL", researchStop: "YES" });
}

async function main(): Promise<void> {
  const freeze = await readJson<Record<string, unknown>>(FREEZE_PATH);
  const gate = await readJson<Record<string, unknown>>(GATE_PATH);
  if (freeze.baseline !== V17_BASELINE || freeze.branch !== V17_BRANCH || freeze.historicalReturnsRead !== false) throw new Error("V17 freeze provenance invalid");
  if (gate.status === "FAIL") {
    await writeFailClosed(freeze, gate);
    console.info(JSON.stringify({ phase: "v17-result", status: "NOT_RUN", classification: "V17_DATA_INSUFFICIENT_FINAL", historicalReturnsRead: false }));
    return;
  }
  const cache = await readJson<Parameters<typeof parseMaterializedArchives>[0]>(resolve(V17_DATA_ROOT, "manifest.json"));
  const parsed = await parseMaterializedArchives(cache);
  const events = buildSignalEvents(parsed.datasets);
  const oos = runEngine(parsed.datasets, "PRIMARY", 0, Date.parse("2022-01-01T00:00:00.000Z"), Date.parse("2024-12-31T23:59:59.999Z"));
  const yearResults = [2022, 2023, 2024].map((year) => { const p = period(year); const result = runEngine(parsed.datasets, "PRIMARY", 0, p.start, p.end); const summary = metric(result.metrics); return { year, ...summary, netR: result.metrics.netR }; });
  const holdoutA = runEngine(parsed.datasets, "PRIMARY", 0, period(2025).start, period(2025).end);
  const holdoutB = runEngine(parsed.datasets, "PRIMARY", 0, Date.parse("2026-01-01T00:00:00.000Z"), Date.parse(V17_END));
  const delays = runDelayMatrix(parsed.datasets, Date.parse("2022-01-01T00:00:00.000Z"), Date.parse("2024-12-31T23:59:59.999Z"));
  const primaryEvents = events.filter((event) => event.primaryEligible && event.fundingTimestamp >= Date.parse("2022-01-01T00:00:00.000Z") && event.fundingTimestamp <= Date.parse("2024-12-31T23:59:59.999Z"));
  const confidence = bootstrap(oos.trades.map((trade) => trade.netR));
  const yearlyPositive = yearResults.filter((result) => result.netR > 0).length / yearResults.length;
  const primary = { ...metric(oos.metrics), stress5bps: oos.trades.reduce((sum, trade) => sum + trade.stressNetR[5], 0), stress10bps: oos.trades.reduce((sum, trade) => sum + trade.stressNetR[10], 0), stress20bps: oos.trades.reduce((sum, trade) => sum + trade.stressNetR[20], 0), signalsEvaluated: oos.signalsEvaluated, rawTriggers: oos.rawTriggers, rejectedSignals: oos.rejectedSignals };
  const families = { primary: primary, extremeFundingOnly: metric(runEngine(parsed.datasets, "EXTREME_FUNDING_ONLY", 0, Date.parse("2022-01-01T00:00:00.000Z"), Date.parse("2024-12-31T23:59:59.999Z")).metrics), continuationDirection: metric(runEngine(parsed.datasets, "CONTINUATION_DIRECTION", 0, Date.parse("2022-01-01T00:00:00.000Z"), Date.parse("2024-12-31T23:59:59.999Z")).metrics), timeMatchedRandom: metric(metricsFor(timeMatchedRandom(primaryEvents, parsed.datasets))) };
  const instrument = Object.fromEntries(((["BTCUSDT", "ETHUSDT"] as const).map((symbol: V17Symbol) => [symbol, metric(metricsFor(oos.trades.filter((trade) => trade.symbol === symbol)))])));
  const directions = { crowdedLongToShort: metric(metricsFor(oos.trades.filter((trade) => trade.crowdingSide === "CROWDED_LONG"))), crowdedShortToLong: metric(metricsFor(oos.trades.filter((trade) => trade.crowdingSide === "CROWDED_SHORT"))) };
  const placebos = { extremeFundingOnly: families.extremeFundingOnly, continuationDirection: families.continuationDirection, timeMatchedRandom: families.timeMatchedRandom, primaryImprovementOverExtremeFunding: oos.metrics.netR - (families.extremeFundingOnly.netR ?? 0) };
  const cost = { grossR: oos.metrics.grossR, feesR: oos.metrics.feesR, slippageR: oos.metrics.slippageR, fundingR: oos.metrics.fundingR, netR: oos.metrics.netR };
  const fixedHorizon = Object.fromEntries([1, 2, 4, 6].map((hours) => [`${hours}h`, futureHorizon(parsed.datasets, primaryEvents, hours)]));
  const monthly = eventMonthCounts(primaryEvents);
  const months = 36;
  const activeMonthRatio = monthly.filter((count) => count > 0).length / months;
  const primaryDays = primaryEvents.map((event) => event.fundingTimestamp).sort((left, right) => left - right);
  const maxDroughtDays = primaryDays.length > 1 ? Math.max(...primaryDays.slice(1).map((timestamp, index) => (timestamp - primaryDays[index]) / 86_400_000)) : 0;
  const emailUtility = { meanPerMonth: primaryEvents.length / months, medianPerMonth: monthly.length ? [...monthly].sort((a, b) => a - b)[Math.floor(monthly.length / 2)] : 0, activeMonthRatio, maxDroughtDays };
  const allGates = { sample: oos.metrics.trades >= 150 && holdoutA.metrics.trades >= 35 && holdoutB.metrics.trades >= 20, primary: oos.metrics.netR > 0 && oos.metrics.avgR >= 0.1 && oos.metrics.profitFactor >= 1.3 && oos.metrics.maxDrawdownR <= 8 && yearlyPositive >= 2 / 3 && Math.min(...yearResults.map((result) => result.netR)) > 0 && primary.stress5bps > 0 && primary.stress10bps > 0, holdoutA: holdoutA.metrics.netR > 0 && holdoutA.metrics.avgR > 0 && holdoutA.metrics.profitFactor >= 1.2 && holdoutA.metrics.maxDrawdownR <= 6, holdoutB: holdoutB.metrics.netR > 0 && holdoutB.metrics.avgR > 0 && holdoutB.metrics.profitFactor >= 1.2 && holdoutB.metrics.maxDrawdownR <= 6, manual: (delays.find((item) => item.delayMinutes === 15)?.metrics.netR ?? 0) > 0 && (delays.find((item) => item.delayMinutes === 15)?.metrics.profitFactor ?? 0) >= 1.2 && (delays.find((item) => item.delayMinutes === 30)?.metrics.netR ?? 0) > 0 && (delays.find((item) => item.delayMinutes === 30)?.metrics.profitFactor ?? 0) >= 1.15, confidence: confidence.lcb95 > 0, emailUtility: emailUtility.meanPerMonth >= 2 && emailUtility.medianPerMonth >= 2 && emailUtility.activeMonthRatio >= 0.7 && emailUtility.maxDroughtDays <= 45 };
  const classification = !allGates.sample ? "V17_INSUFFICIENT_SAMPLE" : Object.values(allGates).every(Boolean) ? "V17_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED" : "V17_CROWDING_FAILED_CONTINUATION_REJECTED";
  const promotion = classification === "V17_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED" ? "PASS" : "FAIL";
  await writeJson("v17-primary-oos.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: primary });
  await writeJson("v17-yearly.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: yearResults });
  await writeJson("v17-holdouts.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: { A: metric(holdoutA.metrics), B: metric(holdoutB.metrics) } });
  await writeJson("v17-instrument-sides.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: instrument });
  await writeJson("v17-directions.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: directions });
  await writeJson("v17-placebos.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: placebos });
  await writeJson("v17-cost.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: cost });
  await writeJson("v17-manual-delay.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: Object.fromEntries(delays.map((item) => [`${item.delayMinutes}m`, { expiredBeforeEntry: item.expiredBeforeEntry, ...metric(item.metrics) }])) });
  await writeJson("v17-fixed-horizon.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: fixedHorizon });
  await writeJson("v17-confidence.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: confidence });
  await writeJson("v17-email-utility.json", { status: "COMPLETE", historicalReturnsRead: true, metrics: emailUtility });
  await writeJson("v17-validation-summary.json", { schema: "v17-validation-summary-v1", baseline: V17_BASELINE, branch: V17_BRANCH, freezeSha256: freeze.manifestSha256, dataGate: "PASS", historicalReturnsRead: true, result: classification, emailPromotionCandidate: promotion, researchStop: classification !== "V17_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED" ? "YES" : "NO", primaryOos: primary, yearly: yearResults, holdouts: { A: metric(holdoutA.metrics), B: metric(holdoutB.metrics) }, instrument, directions, placebos, cost, manualDelay: delays, confidence, emailUtility, capital: { "1000": capitalSimulation(oos.trades, 1000), "2000": capitalSimulation(oos.trades, 2000), "10000": capitalSimulation(oos.trades, 10000) }, boundaries: { productionEmail: "OFF", productionChanged: "NO", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" } });
  await writeJson("v17-promotion-decision.json", { schema: "v17-promotion-decision-v1", classification, dataGate: "PASS", historicalReturnsRead: true, emailPromotionCandidate: promotion, researchStop: classification !== "V17_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED" ? "YES" : "NO" });
  await writeJson("v17-promotion-decision.md", { classification, dataGate: "PASS", historicalReturns: "READ ONCE AFTER FREEZE", promotion, researchStop: classification !== "V17_HISTORICAL_PASS_FORWARD_CONFIRMATION_REQUIRED" ? "YES" : "NO" });
  console.info(JSON.stringify({ phase: "v17-result", status: "COMPLETE", classification, emailPromotionCandidate: promotion, historicalReturnsRead: true }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
