import { describe, expect, it } from "vitest";
import {
  auditConfidence,
  bootstrapLowerConfidenceBound,
  clusterBootstrapLowerConfidenceBound,
  selectionAdjustedConfidence,
} from "@/lib/v5-4/confidence";
import {
  buildFoldUniverse,
  buildPitSymbolEvidence,
  isPitTradableAt,
  validateNoSurvivorLeakage,
} from "@/lib/v5-4/pit-universe";
import { serializeSignalFeatureSnapshotV2 } from "@/lib/v5-4/telemetry";
import { createFrozenHoldoutWindow, createPurgedWalkForwardFolds } from "@/lib/v5-2/validation";
import { V53_CANDIDATE_REGISTRY } from "@/lib/v5-3/structural";

function monthlyKeys(symbol: string, months: string[]): string[] {
  return months.map((month) => `data/futures/um/monthly/klines/${symbol}/15m/${symbol}-15m-${month}.zip`);
}

describe("V5.4 PIT universe evidence", () => {
  it("enforces conservative first/last observed-month boundaries", () => {
    const record = buildPitSymbolEvidence("TESTUSDT", monthlyKeys("TESTUSDT", ["2024-01", "2024-02", "2024-03"]), "hash");
    expect(isPitTradableAt(record, Date.parse("2024-01-15T00:00:00Z"))).toBe(false);
    expect(isPitTradableAt(record, Date.parse("2024-02-15T00:00:00Z"))).toBe(true);
    expect(isPitTradableAt(record, Date.parse("2024-03-15T00:00:00Z"))).toBe(false);
    expect(record.listingDate).toBeNull();
    expect(record.delistingDate).toBeNull();
    expect(record.boundaryPrecision).toBe("MONTH");
  });

  it("excludes a delisted symbol after its observed archive range", () => {
    const delisted = buildPitSymbolEvidence("DELISTUSDT", monthlyKeys("DELISTUSDT", ["2023-01", "2023-06", "2024-02"]), "hash");
    expect(isPitTradableAt(delisted, Date.parse("2023-06-15T00:00:00Z"))).toBe(true);
    expect(isPitTradableAt(delisted, Date.parse("2024-03-01T00:00:00Z"))).toBe(false);
  });

  it("does not leak a survivor or an unknown symbol into a fold universe", () => {
    const records = [
      buildPitSymbolEvidence("ACTIVEUSDT", monthlyKeys("ACTIVEUSDT", ["2024-01", "2024-03"]), "active"),
      buildPitSymbolEvidence("DELISTUSDT", monthlyKeys("DELISTUSDT", ["2023-01", "2023-06", "2024-02"]), "delisted"),
    ];
    const snapshot = Date.parse("2023-06-15T00:00:00Z");
    expect(buildFoldUniverse(records, snapshot)).toEqual(["DELISTUSDT"]);
    const leakage = validateNoSurvivorLeakage(records, snapshot, ["ACTIVEUSDT", "DELISTUSDT", "GHOSTUSDT"]);
    expect(leakage.unknown).toEqual(["GHOSTUSDT"]);
    expect(leakage.included).toEqual(["DELISTUSDT"]);
  });

  it("produces different fold-specific membership from historical evidence", () => {
    const records = [
      buildPitSymbolEvidence("EARLYUSDT", monthlyKeys("EARLYUSDT", ["2023-01", "2023-06", "2024-02", "2024-03", "2024-04"]), "early"),
      buildPitSymbolEvidence("LATEUSDT", monthlyKeys("LATEUSDT", ["2024-02", "2024-03", "2024-04"]), "late"),
    ];
    expect(buildFoldUniverse(records, Date.parse("2023-06-15T00:00:00Z"))).toEqual(["EARLYUSDT"]);
    expect(buildFoldUniverse(records, Date.parse("2024-02-15T00:00:00Z"))).toEqual(["EARLYUSDT"]);
  });
});

describe("V5.4 frozen validation boundaries", () => {
  it("keeps the frozen holdout after the final purged outer fold", () => {
    const folds = createPurgedWalkForwardFolds({
      start: Date.parse("2023-01-01T00:00:00Z"),
      end: Date.parse("2027-01-01T00:00:00Z"),
      initialTrainMonths: 12,
      validationMonths: 3,
      foldCount: 6,
      purgeHours: 72,
    });
    const holdout = createFrozenHoldoutWindow(Date.parse("2027-01-01T00:00:00Z"), folds, 72);
    expect(holdout).not.toBeNull();
    expect(holdout!.start).toBeGreaterThan(folds.at(-1)!.validationEnd);
    expect(holdout!.start).toBeGreaterThan(holdout!.purgeEnd);
  });

  it("keeps the registered SHORT candidate parameters frozen", () => {
    const candidate = V53_CANDIDATE_REGISTRY.find((item) => item.id === "SHORT-FAILED_BREAKOUT_SHORT-02");
    expect(candidate).toBeDefined();
    expect(candidate!.parameters).toEqual({
      breakoutLookback: 20,
      volumeRatioMin: 1.35,
      retestDistanceATR: 0.6,
      maxExtensionATR: 0.8,
      pullbackMinATR: 0.35,
      pullbackMaxATR: 1.6,
      trendAgeMinBars: 16,
      compressionBarsMin: 8,
      compressionRangeMaxATR: 4.5,
      expansionVolumeMin: 1.25,
      expansionVolatilityMin: 1.15,
      stopATRMultiplier: 1.25,
      structureLookback: 8,
    });
    expect(candidate!.rewardRisk).toBe(1.8);
    expect(candidate!.stopStyle).toBe("STRUCTURE");
  });
});

describe("V5.4 confidence audit", () => {
  const observations = [
    { value: 1, symbol: "A", fold: "F1" },
    { value: -1, symbol: "A", fold: "F1" },
    { value: 0.5, symbol: "B", fold: "F2" },
    { value: 0.2, symbol: "B", fold: "F2" },
    { value: 0.8, symbol: "C", fold: "F3" },
    { value: -0.2, symbol: "C", fold: "F3" },
  ];

  it("computes naive and block bootstrap LCBs", () => {
    expect(bootstrapLowerConfidenceBound(observations.map((item) => item.value), "naive_bootstrap", 100, 2)).not.toBeNull();
    expect(bootstrapLowerConfidenceBound(observations.map((item) => item.value), "block_bootstrap", 100, 2)).not.toBeNull();
  });

  it("computes symbol and fold cluster bootstrap LCBs", () => {
    expect(clusterBootstrapLowerConfidenceBound(observations, "symbol", 100)).not.toBeNull();
    expect(clusterBootstrapLowerConfidenceBound(observations, "fold", 100)).not.toBeNull();
  });

  it("uses the frozen selection-adjusted confidence and the conservative minimum", () => {
    const selectionAdjusted = selectionAdjustedConfidence([
      { candidateId: "selected", values: observations.map((item) => item.value) },
      { candidateId: "other", values: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] },
    ], "selected", 100, 2);
    const audit = auditConfidence({
      observations,
      candidateSeries: [],
      selectedCandidateId: "selected",
      selectionCandidateCount: 18,
      repetitions: 100,
      blockLength: 2,
      selectionAdjustedLcb: selectionAdjusted,
    });
    const numeric = audit.methods.map((item) => item.lcb95).filter((item): item is number => item !== null);
    expect(audit.promotionLcb95).toBe(Math.min(...numeric));
    expect(audit.promotionMethod).toBe("minimum_available_lcb95");
    expect(audit.methods.find((item) => item.method === "selection_adjusted_bootstrap")?.clusterCount).toBe(18);
  });
});

describe("V5.4 telemetry design", () => {
  it("serializes only the allow-listed SignalFeatureSnapshotV2 fields", () => {
    const input = {
      schema: "SignalFeatureSnapshotV2" as const,
      signalId: "signal-1",
      strategyVersion: "trend-rejection-short-v1",
      candidateFamily: "TREND",
      timestamp: "2026-01-01T00:00:00.000Z",
      instrument: { quoteVolume24h: 1, tickSize: 0.01, stepSize: 0.1, pricePrecision: 2, quantityPrecision: 1 },
      snapshot: {
        candleCount15m: 250,
        candleCount1h: 250,
        candleCount4h: 249,
        lastCandleTimestamp15m: "2026-01-01T00:00:00.000Z",
        lastCandleTimestamp1h: "2026-01-01T00:00:00.000Z",
        lastCandleTimestamp4h: "2026-01-01T00:00:00.000Z",
      },
      features: { atr: 1, ema: 2, rsi: 50, volumeRatio: 1.2, marketRegime: "BEAR", score: 70, scoreComponents: { trend: 1 } },
      policy: { entryMode: "TREND_REJECTION", scoreThreshold: 70, sideFilter: "SHORT", strategyFamily: "TREND", regimeAlignment: "REQUIRED", stopATR: 0.5, RR: 2 },
      sourceHashes: { candle15m: "a", candle1h: "b", candle4h: "c", features: "d", policy: "e" },
      version: { schemaVersion: "2" as const, producerVersion: "test", featureCodeVersion: "v5.4" },
      apiKey: "must-not-serialize",
      privateKey: "must-not-serialize",
    } as any;
    const serialized = serializeSignalFeatureSnapshotV2(input);
    expect(JSON.stringify(serialized)).not.toContain("must-not-serialize");
    expect(serialized.schema).toBe("SignalFeatureSnapshotV2");
    expect(serialized.instrument.quoteVolume24h).toBe(1);
  });
});
