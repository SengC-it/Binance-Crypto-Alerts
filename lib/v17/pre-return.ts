import type { V17Candle, V17ParsedDatasets, V17Symbol } from "./data";
import { atrAt, buildSignalEvents, hasMinimumFundingHistory, postReturn30m, preReturn8h, priceAtFunding, type V17SignalEvent } from "./engine";

const DAY_MS = 86_400_000;
const EVALUATION_START = Date.parse("2022-01-01T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-07-31T23:59:59.999Z");

export interface V17PreReturnCandidate {
  symbol: V17Symbol;
  fundingTimestamp: number;
  crowdingSide: V17SignalEvent["crowdingSide"];
  direction: V17SignalEvent["direction"];
  response: number;
  responseQ50: number;
  entryTime: number | null;
  atrAvailable: boolean;
  settlementFundingRequired: number;
  settlementMarksCovered: number;
}

export interface V17PreReturnAssessment {
  schema: "v17-pre-return-assessment-v1";
  evaluation: { start: string; end: string; primaryDenominator: "history-eligible-evaluation-events" };
  counts: {
    allFundingEvents: number;
    warmupEvents: number;
    notEligibleUnder90d: number;
    evaluationPeriodEvents: number;
    evaluationNotEligibleUnder90d: number;
    pitHistoryAvailableEvaluationEvents: number;
    crowdingExtremeEvaluationEvents: number;
    referenceExtremeEvaluationEvents: number;
    responseQ50AvailableEvaluationEvents: number;
    rawTriggerEvaluationEvents: number;
    primaryCandidateEvaluationEvents: number;
  };
  coverage: {
    priceAtFunding: { eligible: number; covered: number; coverage: number; source: "USD_M_FUTURES_15M_CLOSED_CLOSE" };
    preReturn8h: { eligible: number; covered: number; coverage: number };
    postFunding30m: { eligible: number; covered: number; coverage: number };
    eventMarkAvailability: { eligible: number; covered: number; coverage: number; descriptiveOnly: true };
    candidateEntry: { eligible: number; covered: number; coverage: number };
    candidateAtr14: { eligible: number; covered: number; coverage: number };
    candidateSettlementMarks: { required: number; covered: number; coverage: number; noCandidateRequirementIsValid: true };
  };
  candidateTimestamps: V17PreReturnCandidate[];
  semantics: {
    fundingHistory: "funding rows in [F-180d,F), future rows excluded, minimum available span >=90d";
    responseQ50: "prior 180d valid reference extreme events by symbol and crowding side, current F excluded, response gate excluded from reference eligibility";
    priceAtFunding: "latest fully closed USD-M futures 15m close strictly before F";
    candidateSettlement: "future funding rows in (entry,entry+6h] require an available mark at each settlement";
    returns: "NOT READ";
  };
  historicalReturnsRead: false;
}

type MutableCounts = V17PreReturnAssessment["counts"];

function lowerBound<T>(values: T[], target: number, get: (value: T) => number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (get(values[middle]) < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound<T>(values: T[], target: number, get: (value: T) => number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (get(values[middle]) <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function coverage(eligible: number, covered: number): number {
  return eligible === 0 ? 1 : covered / eligible;
}

function markAvailable(marks: V17Candle[], timestamp: number): boolean {
  const index = upperBound(marks, timestamp, (bar) => bar.openTime) - 1;
  const bar = index >= 0 ? marks[index] : null;
  return bar !== null && timestamp <= bar.closeTime;
}

function firstEntry(candles: V17Candle[], requestedTime: number): { candle: V17Candle; index: number } | null {
  const index = lowerBound(candles, requestedTime, (bar) => bar.openTime);
  const candle = candles[index];
  return candle ? { candle, index } : null;
}

function emptyCounts(): MutableCounts {
  return { allFundingEvents: 0, warmupEvents: 0, notEligibleUnder90d: 0, evaluationPeriodEvents: 0, evaluationNotEligibleUnder90d: 0, pitHistoryAvailableEvaluationEvents: 0, crowdingExtremeEvaluationEvents: 0, referenceExtremeEvaluationEvents: 0, responseQ50AvailableEvaluationEvents: 0, rawTriggerEvaluationEvents: 0, primaryCandidateEvaluationEvents: 0 };
}

function eventKey(symbol: V17Symbol, timestamp: number): string {
  return `${symbol}:${timestamp}`;
}

export function buildPreReturnAssessment(datasets: V17ParsedDatasets): V17PreReturnAssessment {
  const events = buildSignalEvents(datasets);
  const eventByKey = new Map(events.map((event) => [eventKey(event.symbol, event.fundingTimestamp), event]));
  const counts = emptyCounts();
  let priceEligible = 0;
  let priceCovered = 0;
  let preEligible = 0;
  let preCovered = 0;
  let postEligible = 0;
  let postCovered = 0;
  let candidateEntryCovered = 0;
  let candidateAtrCovered = 0;
  let settlementRequired = 0;
  let settlementCovered = 0;
  const candidateTimestamps: V17PreReturnCandidate[] = [];

  for (const symbol of ["BTCUSDT", "ETHUSDT"] as const) {
    const data = datasets[symbol];
    for (const funding of data.funding) {
      if (funding.timestamp < Date.parse("2021-01-01T00:00:00.000Z") || funding.timestamp > EVALUATION_END) continue;
      counts.allFundingEvents += 1;
      const warmup = funding.timestamp < EVALUATION_START;
      if (warmup) counts.warmupEvents += 1;
      else counts.evaluationPeriodEvents += 1;
      const historyEligible = hasMinimumFundingHistory(data.funding, funding.timestamp);
      if (!historyEligible) {
        counts.notEligibleUnder90d += 1;
        if (!warmup) counts.evaluationNotEligibleUnder90d += 1;
        continue;
      }
      if (warmup) continue;
      counts.pitHistoryAvailableEvaluationEvents += 1;
      const price = priceAtFunding(data.candles15m, funding.timestamp);
      const pre = preReturn8h(data.candles15m, funding.timestamp);
      const post = price === null ? null : postReturn30m(data.candles15m, funding.timestamp, price);
      priceEligible += 1;
      if (price !== null) priceCovered += 1;
      preEligible += 1;
      if (pre !== null) preCovered += 1;
      postEligible += 1;
      if (post !== null) postCovered += 1;
      const event = eventByKey.get(eventKey(symbol, funding.timestamp));
      if (!event) continue;
      counts.crowdingExtremeEvaluationEvents += 1;
      if (event.referenceEligible) counts.referenceExtremeEvaluationEvents += 1;
      if (event.responseQ50 !== null) counts.responseQ50AvailableEvaluationEvents += 1;
      if (event.primaryEligible || event.rejectionReason === "CONTINUATION_NOT_FAILED") counts.rawTriggerEvaluationEvents += 1;
      if (!event.primaryEligible) continue;
      counts.primaryCandidateEvaluationEvents += 1;
      const entry = firstEntry(data.candles15m, event.decisionTime);
      const atrAvailable = entry !== null && atrAt(data.candles15m, entry.index) !== null;
      if (entry) candidateEntryCovered += 1;
      if (atrAvailable) candidateAtrCovered += 1;
      const futureFunding = entry ? data.funding.filter((point) => point.timestamp > entry.candle.openTime && point.timestamp <= entry.candle.openTime + 6 * 3_600_000) : [];
      const marksCovered = futureFunding.filter((point) => markAvailable(data.marks5m, point.timestamp)).length;
      settlementRequired += futureFunding.length;
      settlementCovered += marksCovered;
      candidateTimestamps.push({ symbol, fundingTimestamp: funding.timestamp, crowdingSide: event.crowdingSide, direction: event.direction, response: event.continuationResponse, responseQ50: event.responseQ50 as number, entryTime: entry?.candle.openTime ?? null, atrAvailable, settlementFundingRequired: futureFunding.length, settlementMarksCovered: marksCovered });
    }
  }

  const globalEventMarkEligible = counts.allFundingEvents;
  const globalEventMarkCovered = (["BTCUSDT", "ETHUSDT"] as const).reduce((total, symbol) => total + datasets[symbol].funding.filter((funding) => funding.timestamp >= Date.parse("2021-01-01T00:00:00.000Z") && funding.timestamp <= EVALUATION_END && markAvailable(datasets[symbol].marks5m, funding.timestamp)).length, 0);
  return {
    schema: "v17-pre-return-assessment-v1",
    evaluation: { start: new Date(EVALUATION_START).toISOString(), end: new Date(EVALUATION_END).toISOString(), primaryDenominator: "history-eligible-evaluation-events" },
    counts,
    coverage: {
      priceAtFunding: { eligible: priceEligible, covered: priceCovered, coverage: coverage(priceEligible, priceCovered), source: "USD_M_FUTURES_15M_CLOSED_CLOSE" },
      preReturn8h: { eligible: preEligible, covered: preCovered, coverage: coverage(preEligible, preCovered) },
      postFunding30m: { eligible: postEligible, covered: postCovered, coverage: coverage(postEligible, postCovered) },
      eventMarkAvailability: { eligible: globalEventMarkEligible, covered: globalEventMarkCovered, coverage: coverage(globalEventMarkEligible, globalEventMarkCovered), descriptiveOnly: true },
      candidateEntry: { eligible: counts.primaryCandidateEvaluationEvents, covered: candidateEntryCovered, coverage: coverage(counts.primaryCandidateEvaluationEvents, candidateEntryCovered) },
      candidateAtr14: { eligible: counts.primaryCandidateEvaluationEvents, covered: candidateAtrCovered, coverage: coverage(counts.primaryCandidateEvaluationEvents, candidateAtrCovered) },
      candidateSettlementMarks: { required: settlementRequired, covered: settlementCovered, coverage: coverage(settlementRequired, settlementCovered), noCandidateRequirementIsValid: true },
    },
    candidateTimestamps,
    semantics: { fundingHistory: "funding rows in [F-180d,F), future rows excluded, minimum available span >=90d", responseQ50: "prior 180d valid reference extreme events by symbol and crowding side, current F excluded, response gate excluded from reference eligibility", priceAtFunding: "latest fully closed USD-M futures 15m close strictly before F", candidateSettlement: "future funding rows in (entry,entry+6h] require an available mark at each settlement", returns: "NOT READ" },
    historicalReturnsRead: false,
  };
}
