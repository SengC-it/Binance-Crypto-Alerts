import { describe, expect, it } from "vitest";
import {
  canonicalJsonLine,
  directionFromSignedReturn,
  evaluateV22ShockSignal,
  passesV22PreReturnSampleGate,
  periodForV22Signal,
  xorshift32,
} from "@/lib/v22/enumeration";
import { V22_INTERVAL_MS, V22_ROLLING_OBSERVATIONS, V22_MIN_GAP_LOG, type V22SynchronizedObservation } from "@/lib/v22/signal";

const T = Date.parse("2024-01-01T00:00:00.000Z");

function priorWindow(currentOpenTimeUtc = T, value = 0): V22SynchronizedObservation[] {
  return Array.from({ length: V22_ROLLING_OBSERVATIONS }, (_, index) => ({
    openTimeUtc: currentOpenTimeUtc - (V22_ROLLING_OBSERVATIONS - index) * V22_INTERVAL_MS,
    binanceClose: 100,
    okxClose: 100,
    binanceReturn: value,
    okxReturn: value,
    gap: value,
  }));
}

describe("V22 WP3A pre-return enumeration contract", () => {
  it("uses the frozen UTC period mapping based on signal timestamp", () => {
    expect(periodForV22Signal(Date.parse("2023-07-01T00:00:00Z"))).toBe("PRIMARY_OOS");
    expect(periodForV22Signal(Date.parse("2025-01-01T00:00:00Z"))).toBe("HOLDOUT_A");
    expect(periodForV22Signal(Date.parse("2026-01-01T00:00:00Z"))).toBe("HOLDOUT_B");
    expect(periodForV22Signal(Date.parse("2026-08-01T00:00:00Z"))).toBeNull();
  });

  it("evaluates shock controls from exactly 8640 prior returns", () => {
    const result = evaluateV22ShockSignal({ symbol: "BTCUSDT", metric: "OKX_RETURN", signalOpenTimeUtc: T, currentReturn: 0.003, priorObservations: priorWindow() });
    expect(result).toMatchObject({ eligible: true, candidate: { currentReturn: 0.003, previousReturn: 0, threshold: V22_MIN_GAP_LOG, direction: "LONG" } });
    expect(evaluateV22ShockSignal({ symbol: "BTCUSDT", metric: "OKX_RETURN", signalOpenTimeUtc: T, currentReturn: 0.003, priorObservations: priorWindow().slice(1) })).toEqual({ eligible: false, reason: "EXACT_PRIOR_WINDOW_REQUIRED" });
  });

  it("uses the exact xorshift32 sequence and never a nondeterministic source", () => {
    const first = xorshift32(583057630);
    expect(first).toBe(1639492563);
    expect(xorshift32(first)).toBe(3969697778);
  });

  it("maps zero-free shock direction without any return outcome", () => {
    expect(directionFromSignedReturn(1)).toBe("LONG");
    expect(directionFromSignedReturn(-1)).toBe("SHORT");
    expect(directionFromSignedReturn(0)).toBeNull();
  });

  it("requires every fixed symbol and all frozen sample thresholds", () => {
    const perSymbol = { BTCUSDT: 50, ETHUSDT: 50, SOLUSDT: 50, XRPUSDT: 50, DOGEUSDT: 50 } as const;
    expect(passesV22PreReturnSampleGate({ acceptedEvents: 500, distinctClusters: 250, perSymbol })).toBe(true);
    expect(passesV22PreReturnSampleGate({ acceptedEvents: 499, distinctClusters: 250, perSymbol })).toBe(false);
    expect(passesV22PreReturnSampleGate({ acceptedEvents: 500, distinctClusters: 249, perSymbol })).toBe(false);
    expect(passesV22PreReturnSampleGate({ acceptedEvents: 500, distinctClusters: 250, perSymbol: { ...perSymbol, DOGEUSDT: 49 } })).toBe(false);
  });

  it("freezes compact canonical JSONL records", () => {
    const record = { eventKind: "PRIMARY", symbol: "BTCUSDT", signalOpenTimeUtc: "2024-01-01T00:00:00.000Z" };
    expect(canonicalJsonLine(record)).toBe('{"eventKind":"PRIMARY","symbol":"BTCUSDT","signalOpenTimeUtc":"2024-01-01T00:00:00.000Z"}\n');
    expect(canonicalJsonLine(record).replace(/\n/g, "\r\n")).not.toBe(canonicalJsonLine(record));
  });
});
