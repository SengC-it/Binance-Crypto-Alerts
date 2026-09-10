import {
  V22_INTERVAL_MS,
  V22_SYMBOLS,
  type V22Symbol,
} from "@/lib/v22/types";
import { V22_INFORMATION_DENSITY_FLOOR_BPS, V22_ROLLING_OBSERVATIONS, nearestRankQ99, firstCross, type V22Direction, type V22SynchronizedObservation } from "@/lib/v22/signal";

export const V22_PRIMARY_OOS = "PRIMARY_OOS" as const;
export const V22_HOLDOUT_A = "HOLDOUT_A" as const;
export const V22_HOLDOUT_B = "HOLDOUT_B" as const;
export const V22_PERIODS = [V22_PRIMARY_OOS, V22_HOLDOUT_A, V22_HOLDOUT_B] as const;
export type V22EnumerationPeriod = (typeof V22_PERIODS)[number];

export const V22_CONTROL_C_SEED_HEX = "0x22C0C0DE" as const;
export const V22_CONTROL_C_SEED = 583057630 as const;

export type V22ShockMetric = "OKX_RETURN" | "BINANCE_RETURN";
export type V22ShockRejectionReason =
  | "EXACT_PRIOR_WINDOW_REQUIRED"
  | "NONCONTIGUOUS_PRIOR_WINDOW"
  | "NONFINITE_OBSERVATION"
  | "NONFINITE_SIGNAL"
  | "ZERO_RETURN"
  | "BELOW_THRESHOLD"
  | "NOT_FIRST_CROSS";

export interface V22ShockCandidate {
  symbol: V22Symbol;
  metric: V22ShockMetric;
  direction: V22Direction;
  signalOpenTimeUtc: number;
  decisionTimeUtc: number;
  currentReturn: number;
  previousReturn: number;
  threshold: number;
}

export type V22ShockEvaluation =
  | { eligible: true; candidate: V22ShockCandidate }
  | { eligible: false; reason: V22ShockRejectionReason };

export function periodForV22Signal(signalOpenTimeUtc: number): V22EnumerationPeriod | null {
  const timestamp = new Date(signalOpenTimeUtc).toISOString();
  if (timestamp >= "2023-07-01T00:00:00.000Z" && timestamp < "2025-01-01T00:00:00.000Z") return V22_PRIMARY_OOS;
  if (timestamp < "2026-01-01T00:00:00.000Z") return V22_HOLDOUT_A;
  if (timestamp < "2026-08-01T00:00:00.000Z") return V22_HOLDOUT_B;
  return null;
}

export function yearUtc(signalOpenTimeUtc: number): number {
  return new Date(signalOpenTimeUtc).getUTCFullYear();
}

export function monthUtc(signalOpenTimeUtc: number): string {
  const date = new Date(signalOpenTimeUtc);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function hourUtc(signalOpenTimeUtc: number): number {
  return new Date(signalOpenTimeUtc).getUTCHours();
}

export function directionFromSignedReturn(value: number): V22Direction | null {
  if (value > 0) return "LONG";
  if (value < 0) return "SHORT";
  return null;
}

function exactPriorWindow(currentOpenTimeUtc: number, observations: readonly V22SynchronizedObservation[]): V22ShockRejectionReason | null {
  if (observations.length !== V22_ROLLING_OBSERVATIONS) return "EXACT_PRIOR_WINDOW_REQUIRED";
  const firstExpected = currentOpenTimeUtc - 30 * 24 * 60 * 60 * 1000;
  for (const [index, observation] of observations.entries()) {
    if (observation.openTimeUtc !== firstExpected + index * V22_INTERVAL_MS) return "NONCONTIGUOUS_PRIOR_WINDOW";
    if (!Number.isFinite(observation.openTimeUtc) || !Number.isFinite(observation.gap)) return "NONFINITE_OBSERVATION";
  }
  if (observations[observations.length - 1]!.openTimeUtc >= currentOpenTimeUtc) return "NONCONTIGUOUS_PRIOR_WINDOW";
  return null;
}

export function evaluateV22ShockSignal(input: {
  symbol: V22Symbol;
  metric: V22ShockMetric;
  signalOpenTimeUtc: number;
  currentReturn: number;
  priorObservations: readonly V22SynchronizedObservation[];
}): V22ShockEvaluation {
  const windowError = exactPriorWindow(input.signalOpenTimeUtc, input.priorObservations);
  if (windowError) return { eligible: false, reason: windowError };
  const priorReturns = input.priorObservations.map((observation) => input.metric === "OKX_RETURN" ? observation.okxReturn : observation.binanceReturn);
  if (!Number.isFinite(input.currentReturn)) return { eligible: false, reason: "NONFINITE_SIGNAL" };
  if (priorReturns.some((value) => !Number.isFinite(value))) return { eligible: false, reason: "NONFINITE_OBSERVATION" };
  const threshold = Math.max(nearestRankQ99(priorReturns.map((value) => Math.abs(value))), Math.log1p(V22_INFORMATION_DENSITY_FLOOR_BPS / 10_000));
  if (!Number.isFinite(threshold)) return { eligible: false, reason: "NONFINITE_OBSERVATION" };
  const direction = directionFromSignedReturn(input.currentReturn);
  if (!direction) return { eligible: false, reason: "ZERO_RETURN" };
  if (Math.abs(input.currentReturn) < threshold) return { eligible: false, reason: "BELOW_THRESHOLD" };
  const previousReturn = priorReturns[priorReturns.length - 1]!;
  if (!firstCross(input.currentReturn, previousReturn, threshold)) return { eligible: false, reason: "NOT_FIRST_CROSS" };
  return {
    eligible: true,
    candidate: {
      symbol: input.symbol,
      metric: input.metric,
      direction,
      signalOpenTimeUtc: input.signalOpenTimeUtc,
      decisionTimeUtc: input.signalOpenTimeUtc + V22_INTERVAL_MS,
      currentReturn: input.currentReturn,
      previousReturn,
      threshold,
    },
  };
}

export function xorshift32(state: number): number {
  let next = state >>> 0;
  next ^= next << 13;
  next >>>= 0;
  next ^= next >>> 17;
  next >>>= 0;
  next ^= next << 5;
  return next >>> 0;
}

export function fixedSymbolOrder(symbol: V22Symbol): number {
  return V22_SYMBOLS.indexOf(symbol);
}

export function compareV22SignalIdentity(left: { signalOpenTimeUtc: number; symbol: V22Symbol }, right: { signalOpenTimeUtc: number; symbol: V22Symbol }): number {
  return left.signalOpenTimeUtc - right.signalOpenTimeUtc || fixedSymbolOrder(left.symbol) - fixedSymbolOrder(right.symbol);
}

export function placeboStratumKey(symbol: V22Symbol, period: V22EnumerationPeriod, signalOpenTimeUtc: number, direction: V22Direction): string {
  return `${symbol}|${period}|${monthUtc(signalOpenTimeUtc)}|${hourUtc(signalOpenTimeUtc)}|${direction}`;
}

export function passesV22PreReturnSampleGate(input: { acceptedEvents: number; distinctClusters: number; perSymbol: Readonly<Record<V22Symbol, number>> }): boolean {
  return input.acceptedEvents >= 500 && input.distinctClusters >= 250 && V22_SYMBOLS.every((symbol) => (input.perSymbol[symbol] ?? 0) >= 50);
}

export function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
