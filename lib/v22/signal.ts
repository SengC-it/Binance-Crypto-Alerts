import { V22_INTERVAL_MS, V22_SYMBOLS, type V22Symbol } from "@/lib/v22/types";

export { V22_INTERVAL_MS } from "@/lib/v22/types";

export const V22_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const V22_ROLLING_OBSERVATIONS = 8_640;
export const V22_Q99_QUANTILE = 0.99;
export const V22_Q99_RANK = 8_554;
export const V22_Q99_INDEX = 8_553;
export const V22_FEE_BPS_PER_SIDE = 4;
export const V22_SLIPPAGE_BPS_PER_SIDE = 2;
export const V22_BASELINE_ROUND_TRIP_BPS = 12;
export const V22_INFORMATION_DENSITY_FLOOR_BPS = 24;
export const V22_MIN_GAP_LOG = Math.log1p(0.0024);

export type V22Direction = "LONG" | "SHORT";
export type V22EventKind =
  | "PRIMARY"
  | "OKX_SHOCK_MOMENTUM"
  | "BINANCE_SHOCK_MOMENTUM"
  | "TIME_MATCHED_RANDOM";

export interface V22SynchronizedObservation {
  openTimeUtc: number;
  binanceClose: number;
  okxClose: number;
  binanceReturn: number;
  okxReturn: number;
  gap: number;
}

export interface V22ExecutionContract {
  targetVenue: "BINANCE_USDM_PERPETUAL";
  entry: {
    openTimeUtc: number;
    priceField: "open";
  };
  primary: {
    exitOpenTimeUtc: number;
    exitPriceField: "close";
    outcomeBoundaryTimeUtc: number;
    horizonMinutes: 15;
  };
  diagnostics: {
    fiveMinute: {
      exitOpenTimeUtc: number;
      exitPriceField: "close";
      outcomeBoundaryTimeUtc: number;
      horizonMinutes: 5;
    };
    thirtyMinute: {
      exitOpenTimeUtc: number;
      exitPriceField: "close";
      outcomeBoundaryTimeUtc: number;
      horizonMinutes: 30;
    };
  };
}

export interface V22SignalEvaluationInput {
  symbol: V22Symbol;
  signalOpenTimeUtc: number;
  signalCloseTimeUtc: number;
  binanceReturn: number;
  okxReturn: number;
  priorObservations: readonly V22SynchronizedObservation[];
}

export interface V22SignalCandidate {
  symbol: V22Symbol;
  eventKind: "PRIMARY";
  direction: V22Direction;
  signalOpenTimeUtc: number;
  decisionTimeUtc: number;
  gap: number;
  threshold: number;
  execution: V22ExecutionContract;
  clusterId: string;
}

export type V22SignalRejectionReason =
  | "INVALID_SYMBOL"
  | "INVALID_SIGNAL_TIMING"
  | "EXACT_PRIOR_WINDOW_REQUIRED"
  | "CURRENT_OBSERVATION_INCLUDED"
  | "NONCONTIGUOUS_PRIOR_WINDOW"
  | "NONFINITE_OBSERVATION"
  | "NONFINITE_SIGNAL"
  | "ZERO_GAP"
  | "BELOW_THRESHOLD"
  | "NOT_FIRST_CROSS"
  | "VENUE_DIRECTION_MISMATCH"
  | "OKX_NOT_DOMINANT";

export type V22SignalEvaluation =
  | { eligible: true; candidate: V22SignalCandidate }
  | { eligible: false; reason: V22SignalRejectionReason };

export interface V22PrimaryPosition {
  symbol: V22Symbol;
  entryOpenTimeUtc: number;
  outcomeBoundaryTimeUtc: number;
  accepted: boolean;
}

export interface V22OverlapDecision {
  accepted: boolean;
  reason: "ACCEPTED" | "OVERLAP_EXCLUDED";
}

const isFinitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function logReturn(current: number, previous: number): number {
  if (!isFinitePositive(current) || !isFinitePositive(previous)) return Number.NaN;
  return Math.log(current / previous);
}

export function crossVenueGap(okxReturn: number, binanceReturn: number): number {
  return okxReturn - binanceReturn;
}

export function nearestRankQ99(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(V22_Q99_QUANTILE * sorted.length);
  return sorted[rank - 1] ?? Number.NaN;
}

export function rollingGapThreshold(priorGaps: readonly number[]): number | null {
  if (priorGaps.length !== V22_ROLLING_OBSERVATIONS || priorGaps.some((gap) => !Number.isFinite(gap))) return null;
  const q99 = nearestRankQ99(priorGaps.map((gap) => Math.abs(gap)));
  if (!Number.isFinite(q99)) return null;
  return Math.max(q99, V22_MIN_GAP_LOG);
}

export function firstCross(currentGap: number, previousGap: number, threshold: number): boolean {
  return Number.isFinite(currentGap) && Number.isFinite(previousGap) && Number.isFinite(threshold) && Math.abs(currentGap) >= threshold && Math.abs(previousGap) < threshold;
}

export function referenceDominance(okxReturn: number, binanceReturn: number): boolean {
  return Number.isFinite(okxReturn) && Number.isFinite(binanceReturn) && Math.abs(okxReturn) > Math.abs(binanceReturn);
}

export function directionFromGap(gap: number): V22Direction | null {
  if (gap > 0) return "LONG";
  if (gap < 0) return "SHORT";
  return null;
}

export function buildV22ExecutionContract(signalOpenTimeUtc: number): V22ExecutionContract {
  if (!Number.isFinite(signalOpenTimeUtc)) throw new Error("signal open time must be finite");
  const entryOpenTimeUtc = signalOpenTimeUtc + V22_INTERVAL_MS;
  return {
    targetVenue: "BINANCE_USDM_PERPETUAL",
    entry: { openTimeUtc: entryOpenTimeUtc, priceField: "open" },
    primary: {
      exitOpenTimeUtc: signalOpenTimeUtc + 3 * V22_INTERVAL_MS,
      exitPriceField: "close",
      outcomeBoundaryTimeUtc: signalOpenTimeUtc + 4 * V22_INTERVAL_MS,
      horizonMinutes: 15,
    },
    diagnostics: {
      fiveMinute: {
        exitOpenTimeUtc: signalOpenTimeUtc + V22_INTERVAL_MS,
        exitPriceField: "close",
        outcomeBoundaryTimeUtc: signalOpenTimeUtc + 2 * V22_INTERVAL_MS,
        horizonMinutes: 5,
      },
      thirtyMinute: {
        exitOpenTimeUtc: signalOpenTimeUtc + 6 * V22_INTERVAL_MS,
        exitPriceField: "close",
        outcomeBoundaryTimeUtc: signalOpenTimeUtc + 7 * V22_INTERVAL_MS,
        horizonMinutes: 30,
      },
    },
  };
}

function exactPriorWindow(currentOpenTimeUtc: number, observations: readonly V22SynchronizedObservation[]): V22SignalRejectionReason | null {
  if (observations.length !== V22_ROLLING_OBSERVATIONS) return "EXACT_PRIOR_WINDOW_REQUIRED";
  const firstExpected = currentOpenTimeUtc - V22_WINDOW_MS;
  for (const [index, observation] of observations.entries()) {
    if (observation.openTimeUtc === currentOpenTimeUtc) return "CURRENT_OBSERVATION_INCLUDED";
    if (observation.openTimeUtc !== firstExpected + index * V22_INTERVAL_MS) return "NONCONTIGUOUS_PRIOR_WINDOW";
    if (!Number.isFinite(observation.openTimeUtc) || !Number.isFinite(observation.gap)) return "NONFINITE_OBSERVATION";
  }
  if (observations[observations.length - 1]!.openTimeUtc >= currentOpenTimeUtc) return "CURRENT_OBSERVATION_INCLUDED";
  return null;
}

export function evaluateV22PrimarySignal(input: V22SignalEvaluationInput): V22SignalEvaluation {
  if (!(V22_SYMBOLS as readonly string[]).includes(input.symbol)) return { eligible: false, reason: "INVALID_SYMBOL" };
  if (input.signalCloseTimeUtc !== input.signalOpenTimeUtc + V22_INTERVAL_MS) return { eligible: false, reason: "INVALID_SIGNAL_TIMING" };
  const windowError = exactPriorWindow(input.signalOpenTimeUtc, input.priorObservations);
  if (windowError) return { eligible: false, reason: windowError };
  if (![input.binanceReturn, input.okxReturn].every((value) => Number.isFinite(value))) return { eligible: false, reason: "NONFINITE_SIGNAL" };
  const threshold = rollingGapThreshold(input.priorObservations.map((observation) => observation.gap));
  if (threshold === null) return { eligible: false, reason: "NONFINITE_OBSERVATION" };
  const gap = crossVenueGap(input.okxReturn, input.binanceReturn);
  const previousGap = input.priorObservations[V22_ROLLING_OBSERVATIONS - 1]!.gap;
  const direction = directionFromGap(gap);
  if (!direction) return { eligible: false, reason: "ZERO_GAP" };
  if (Math.abs(gap) < threshold) return { eligible: false, reason: "BELOW_THRESHOLD" };
  if (!firstCross(gap, previousGap, threshold)) return { eligible: false, reason: "NOT_FIRST_CROSS" };
  if (input.okxReturn * input.binanceReturn < 0) return { eligible: false, reason: "VENUE_DIRECTION_MISMATCH" };
  if (!referenceDominance(input.okxReturn, input.binanceReturn)) return { eligible: false, reason: "OKX_NOT_DOMINANT" };
  return {
    eligible: true,
    candidate: {
      symbol: input.symbol,
      eventKind: "PRIMARY",
      direction,
      signalOpenTimeUtc: input.signalOpenTimeUtc,
      decisionTimeUtc: input.signalCloseTimeUtc,
      gap,
      threshold,
      execution: buildV22ExecutionContract(input.signalOpenTimeUtc),
      clusterId: new Date(input.signalOpenTimeUtc).toISOString(),
    },
  };
}

export function acceptV22PrimaryOverlap(
  existingPositions: readonly V22PrimaryPosition[],
  candidate: Pick<V22PrimaryPosition, "symbol" | "entryOpenTimeUtc" | "outcomeBoundaryTimeUtc">,
): V22OverlapDecision {
  const overlap = existingPositions.some(
    (position) =>
      position.accepted &&
      position.symbol === candidate.symbol &&
      candidate.entryOpenTimeUtc < position.outcomeBoundaryTimeUtc &&
      position.entryOpenTimeUtc < candidate.outcomeBoundaryTimeUtc,
  );
  return overlap ? { accepted: false, reason: "OVERLAP_EXCLUDED" } : { accepted: true, reason: "ACCEPTED" };
}
