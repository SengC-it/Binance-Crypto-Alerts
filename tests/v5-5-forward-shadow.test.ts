import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExchangeUniverseSnapshot } from "@/lib/binance/public-client";
import type { Instrument, MarketSnapshot } from "@/lib/core/types";
import { V55_SHADOW_DEFAULT_ENABLED } from "@/lib/config";
import { canonicalJson } from "@/lib/v5-5/canonical";
import {
  evaluateV55ForwardEvidence,
  buildForwardIdempotencyKey,
  V55_MIN_FORWARD_DAYS,
  V55_MIN_FORWARD_TRADES,
  type V55ForwardTradeRow,
} from "@/lib/v5-5/evaluator";
import { getFrozenStrategy, V55_FORWARD_EXPERIMENT_ID, V55_PRODUCTION_EMAIL_ALLOWED, V55_STRATEGY_VERSION } from "@/lib/v5-5/manifest";
import { evaluateV55Snapshot } from "@/lib/v5-5/runtime";
import { serializeSignalFeatureSnapshotV2 } from "@/lib/v5-5/snapshot";
import { buildUniverseSnapshot } from "@/lib/v5-5/universe";

const baseInstrument: Instrument = {
  symbol: "TESTUSDT",
  baseAsset: "TEST",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.01,
  quantityStep: 0.001,
  minQuantity: 0.001,
  minNotional: 5,
  pricePrecision: 2,
  quantityPrecision: 3,
  quoteVolume24h: 100_000,
};

function emptyMarketSnapshot(): MarketSnapshot {
  return {
    instrument: baseInstrument,
    tickerPrice: 100,
    candles: { "15m": [], "1h": [], "4h": [] },
    sourceTimestamp: Date.parse("2026-08-25T00:00:00.000Z"),
  };
}

function context() {
  return {
    scanId: "scan-1",
    scanGroupKey: "2026-08-25T00:00Z",
    scanTimestamp: Date.parse("2026-08-25T00:15:00.000Z"),
    forwardStartTimestamp: Date.parse("2026-08-25T00:00:00.000Z"),
    experimentId: V55_FORWARD_EXPERIMENT_ID,
    runtimeCommitSha: "runtime-test",
    strategyManifestHash: getFrozenStrategy().manifestHash,
    universeSnapshotHash: "u".repeat(64),
  };
}

function forwardRow(index: number, rMultiple: number): V55ForwardTradeRow {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const source = start + index * 86_400_000;
  return {
    id: `trade-${index}`,
    strategy_version: V55_STRATEGY_VERSION,
    forward_experiment_id: V55_FORWARD_EXPERIMENT_ID,
    source_data_timestamp: new Date(source).toISOString(),
    entry_time: new Date(source).toISOString(),
    exit_time: new Date(source + 3_600_000).toISOString(),
    status: rMultiple > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    symbol: `S${index % 5}USDT`,
    r_multiple: rMultiple,
    net_pnl_usdt: rMultiple * 50,
    fees_usdt: 0.1,
    funding_usdt: 0.01,
    slippage_usdt: 0.05,
    metadata: { market_regime: index % 2 === 0 ? "BULL" : "RANGE" },
  };
}

describe("V5.5 frozen strategy and Shadow isolation", () => {
  it("keeps the candidate parameters, side, stop and RR frozen", () => {
    const frozen = getFrozenStrategy();
    expect(frozen.definition.id).toBe("SHORT-FAILED_BREAKOUT_SHORT-02");
    expect(frozen.definition.parameters.volumeRatioMin).toBe(1.35);
    expect(frozen.definition.rewardRisk).toBe(1.8);
    expect(frozen.definition.stopStyle).toBe("STRUCTURE");
    expect(frozen.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("has a disabled-by-default V5.5 flag and no Production email capability", () => {
    expect(V55_SHADOW_DEFAULT_ENABLED).toBe(false);
    expect(V55_PRODUCTION_EMAIL_ALLOWED).toBe(false);
    const result = evaluateV55Snapshot(emptyMarketSnapshot(), context());
    expect(result.snapshot.strategy.side).toBe("SHORT");
    expect(result.snapshot.decision.finalEligible).toBe(false);
    expect(result.snapshot.decision.rejectionReasons).toContain("INSUFFICIENT_FEATURE_HISTORY");
    expect(result.snapshot.score.finalScore).toBeNull();
  });

  it("captures raw trigger attrition before any score gate", () => {
    const result = evaluateV55Snapshot(emptyMarketSnapshot(), context());
    expect(result.snapshot.decision.rawTrigger).toBe(false);
    expect(result.snapshot.decision.rejectionReasons).toContain("RAW_TRIGGER_FALSE");
    expect(result.snapshot.score.finalScore).toBeNull();
  });

  it("creates a deterministic, secret-free SignalFeatureSnapshotV2", () => {
    const first = evaluateV55Snapshot(emptyMarketSnapshot(), context()).snapshot;
    const second = evaluateV55Snapshot(emptyMarketSnapshot(), context()).snapshot;
    expect(first.provenance.snapshotHash).toBe(second.provenance.snapshotHash);
    const withSecrets = { ...first, apiKey: "secret", CRON_SECRET: "secret" } as unknown as typeof first;
    const serialized = serializeSignalFeatureSnapshotV2(withSecrets);
    expect(JSON.stringify(serialized)).not.toContain("secret");
    expect(canonicalJson(serialized)).toContain("SignalFeatureSnapshotV2");
  });
});

describe("V5.5 point-in-time universe capture", () => {
  it("persists quote volume, status, filters and exclusion reasons in the hash input", () => {
    const other: Instrument = { ...baseInstrument, symbol: "OLDUSDT", status: "BREAK" };
    const observed: ExchangeUniverseSnapshot = {
      retrievedAt: Date.parse("2026-08-25T00:15:00.000Z"),
      allSymbols: [baseInstrument, other],
      eligibleSymbols: [baseInstrument],
      excludedSymbols: [{ instrument: other, reason: "EXCHANGE_STATUS_BREAK" }],
    };
    const snapshot = buildUniverseSnapshot({
      scanId: "scan-1",
      scanGroupKey: "group-1",
      scanTimestamp: observed.retrievedAt,
      observed,
      selectedForEvaluation: ["TESTUSDT"],
    });
    expect(snapshot.consideredSymbols[0].filters.minNotional).toBe(5);
    expect(snapshot.excludedSymbols[0].exclusionReason).toBe("EXCHANGE_STATUS_BREAK");
    expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("V5.5 forward evidence boundaries", () => {
  it("does not backfill historical or legacy shadow rows", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const rows = [
      { ...forwardRow(0, 1), source_data_timestamp: new Date(start - 1).toISOString() },
      ...Array.from({ length: V55_MIN_FORWARD_TRADES }, (_, index) => forwardRow(index, index % 10 === 0 ? -0.05 : 0.5)),
    ];
    const evidence = evaluateV55ForwardEvidence({
      rows,
      forwardStartTimestamp: start,
      asOfTimestamp: start + 60 * 86_400_000,
      repetitions: 100,
    });
    expect(evidence.settledTrades).toBe(V55_MIN_FORWARD_TRADES);
    expect(evidence.excludedRows).toBe(1);
    expect(evidence.automaticPromotionAllowed).toBe(false);
    expect(evidence.status).not.toBe("INSUFFICIENT_FORWARD_EVIDENCE");
  });

  it("requires both the minimum sample and minimum calendar duration", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const evidence = evaluateV55ForwardEvidence({
      rows: Array.from({ length: V55_MIN_FORWARD_TRADES - 1 }, (_, index) => forwardRow(index, 0.5)),
      forwardStartTimestamp: start,
      asOfTimestamp: start + (V55_MIN_FORWARD_DAYS + 1) * 86_400_000,
      repetitions: 100,
    });
    expect(evidence.status).toBe("INSUFFICIENT_FORWARD_EVIDENCE");
  });

  it("uses the exact strategy/symbol/source timestamp idempotency key", () => {
    expect(buildForwardIdempotencyKey(V55_STRATEGY_VERSION, "TESTUSDT", "2026-01-01T00:00:00.000Z"))
      .toBe(`${V55_STRATEGY_VERSION}|TESTUSDT|2026-01-01T00:00:00.000Z`);
  });
});

describe("V5.5 additive migration safeguards", () => {
  const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260825090000_v55_forward_shadow_evidence.sql"), "utf8");

  it("prepares separate forward and snapshot tables without applying them here", () => {
    expect(migration).toContain("create table if not exists public.bca_v55_forward_experiments");
    expect(migration).toContain("create table if not exists public.bca_v55_signal_feature_snapshots");
    expect(migration).toContain("alter table public.bca_shadow_paper_trades");
  });

  it("protects snapshots and entry-side evidence from mutation", () => {
    expect(migration).toContain("bca_v55_snapshot_immutable");
    expect(migration).toContain("bca_v55_guard_shadow_entry");
    expect(migration).toContain("old.entry_price is distinct from new.entry_price");
    expect(migration).toContain("old.metadata is distinct from new.metadata");
  });

  it("enforces duplicate protection at the database boundary", () => {
    expect(migration).toContain("bca_shadow_paper_trades_v55_idempotency_idx");
    expect(migration).toContain("v55_idempotency_key");
  });
});
