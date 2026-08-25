import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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
import { persistV55ShadowEvidence, persistV55Snapshot, persistV55UniverseSnapshot } from "@/lib/v5-5/repository";
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
    universeSnapshotId: "universe-1",
  };
}

type FakeRow = Record<string, unknown>;

class FakeSupabase {
  readonly rows = new Map<string, FakeRow[]>();

  from(table: string): FakeSupabaseQuery {
    return new FakeSupabaseQuery(this, table);
  }
}

class FakeSupabaseQuery {
  private operation: "select" | "insert" = "select";
  private payload: FakeRow | null = null;
  private readonly filters: Array<[string, unknown]> = [];

  constructor(private readonly client: FakeSupabase, private readonly table: string) {}

  select(_columns?: string): this {
    return this;
  }

  insert(payload: FakeRow): this {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  async maybeSingle(): Promise<{ data: FakeRow | null; error: { code?: string; message: string } | null }> {
    const rows = this.client.rows.get(this.table) ?? [];
    if (this.operation === "insert") {
      const row = { ...(this.payload ?? {}) };
      const duplicate = rows.some((existing) => this.isDuplicate(existing, row));
      if (duplicate) return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (!row.snapshot_id && this.table === "bca_v55_universe_snapshots") {
        row.snapshot_id = `${this.table}-${rows.length + 1}`;
      }
      rows.push(row);
      this.client.rows.set(this.table, rows);
      return { data: row, error: null };
    }
    const matches = rows.filter((row) => this.filters.every(([column, value]) => row[column] === value));
    if (matches.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: matches[0] ?? null, error: null };
  }

  private isDuplicate(existing: FakeRow, incoming: FakeRow): boolean {
    if (this.table === "bca_v55_forward_experiments") {
      return existing.experiment_id === incoming.experiment_id;
    }
    if (this.table === "bca_v55_universe_snapshots") {
      return existing.experiment_id === incoming.experiment_id && existing.scan_id === incoming.scan_id;
    }
    if (this.table === "bca_v55_signal_feature_snapshots") {
      return existing.experiment_id === incoming.experiment_id
        && existing.strategy_version === incoming.strategy_version
        && existing.symbol === incoming.symbol
        && existing.source_data_timestamp === incoming.source_data_timestamp;
    }
    return existing.id === incoming.id;
  }
}

function fakeSupabase(): FakeSupabase {
  return new FakeSupabase();
}

function universeInput(symbol: string, status = "TRADING"): ExchangeUniverseSnapshot {
  const instrument = { ...baseInstrument, symbol, baseAsset: symbol.replace("USDT", ""), status };
  return {
    retrievedAt: Date.parse("2026-08-25T00:15:00.000Z"),
    allSymbols: [instrument],
    eligibleSymbols: status === "TRADING" ? [instrument] : [],
    excludedSymbols: status === "TRADING" ? [] : [{ instrument, reason: "EXCHANGE_STATUS_BREAK" }],
  };
}

function universeSnapshot(symbol: string, scanId: string, scanGroupKey: string) {
  return buildUniverseSnapshot({
    scanId,
    scanGroupKey,
    scanTimestamp: Date.parse("2026-08-25T00:15:00.000Z"),
    observed: universeInput(symbol),
    selectedForEvaluation: [symbol],
  });
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

describe("V5.5 repository forward-evidence integrity", () => {
  it("treats duplicate cron snapshots as idempotent by the natural identity", async () => {
    const store = fakeSupabase();
    const contextA = { ...context(), scanId: "scan-A", universeSnapshotId: "universe-A" };
    const contextB = { ...contextA, scanId: "scan-B" };
    const evaluationA = evaluateV55Snapshot(emptyMarketSnapshot(), contextA);
    const evaluationB = evaluateV55Snapshot(emptyMarketSnapshot(), contextB);

    const first = await persistV55Snapshot(store as unknown as SupabaseClient, contextA, evaluationA);
    const second = await persistV55Snapshot(store as unknown as SupabaseClient, contextB, evaluationB);
    const summary = await persistV55ShadowEvidence(store as unknown as SupabaseClient, contextB, [evaluationB]);
    const rows = store.rows.get("bca_v55_signal_feature_snapshots") ?? [];

    expect(rows).toHaveLength(1);
    expect(first.status).toBe("CREATED");
    expect(second.status).toBe("IDEMPOTENT_EXISTING");
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(summary.snapshotsWritten).toBe(0);
    expect(summary.idempotentSnapshots).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("keeps two batch universe rows and resolves each feature snapshot provenance", async () => {
    const store = fakeSupabase();
    const group = "group-forward-1";
    const contextA = { ...context(), scanId: "scan-A", scanGroupKey: group };
    const contextB = { ...contextA, scanId: "scan-B" };
    const universeA = universeSnapshot("TESTUSDT", contextA.scanId, group);
    const universeB = universeSnapshot("SECONDUSDT", contextB.scanId, group);
    const persistedA = await persistV55UniverseSnapshot(store as unknown as SupabaseClient, contextA, universeA);
    const duplicateA = await persistV55UniverseSnapshot(store as unknown as SupabaseClient, contextA, universeA);
    const persistedB = await persistV55UniverseSnapshot(store as unknown as SupabaseClient, contextB, universeB);

    const evidenceContextA = {
      ...contextA,
      universeSnapshotHash: universeA.snapshotHash,
      universeSnapshotId: persistedA.snapshotId,
    };
    const evidenceContextB = {
      ...contextB,
      universeSnapshotHash: universeB.snapshotHash,
      universeSnapshotId: persistedB.snapshotId,
    };
    const evaluationA = evaluateV55Snapshot(emptyMarketSnapshot(), evidenceContextA);
    const evaluationB = evaluateV55Snapshot({
      ...emptyMarketSnapshot(),
      instrument: { ...baseInstrument, symbol: "SECONDUSDT", baseAsset: "SECOND" },
    }, evidenceContextB);
    await persistV55ShadowEvidence(store as unknown as SupabaseClient, evidenceContextA, [evaluationA]);
    await persistV55ShadowEvidence(store as unknown as SupabaseClient, evidenceContextB, [evaluationB]);

    const universes = store.rows.get("bca_v55_universe_snapshots") ?? [];
    const features = store.rows.get("bca_v55_signal_feature_snapshots") ?? [];
    expect(universes).toHaveLength(2);
    expect(duplicateA.status).toBe("IDEMPOTENT_EXISTING");
    expect(duplicateA.snapshotId).toBe(persistedA.snapshotId);
    expect(persistedA.snapshotId).not.toBe(persistedB.snapshotId);
    expect(features).toHaveLength(2);
    for (const feature of features) {
      const universe = universes.find((row) => row.snapshot_id === feature.universe_snapshot_id);
      expect(universe).toBeDefined();
      expect(feature.universe_snapshot_hash).toBe(universe?.snapshot_hash);
    }
  });

  it("fails closed when an existing forward experiment identity changes", async () => {
    const store = fakeSupabase();
    const firstContext = { ...context(), scanId: "scan-A", runtimeCommitSha: "approved-runtime" };
    await persistV55UniverseSnapshot(
      store as unknown as SupabaseClient,
      firstContext,
      universeSnapshot("TESTUSDT", firstContext.scanId, firstContext.scanGroupKey),
    );

    await expect(persistV55UniverseSnapshot(
      store as unknown as SupabaseClient,
      { ...firstContext, scanId: "scan-B", runtimeCommitSha: "different-runtime" },
      universeSnapshot("SECONDUSDT", "scan-B", firstContext.scanGroupKey),
    )).rejects.toThrow("identity mismatch");
  });

  it("freezes manifest hash and forward start along with the approved runtime", async () => {
    const store = fakeSupabase();
    const firstContext = { ...context(), scanId: "scan-A", runtimeCommitSha: "approved-runtime" };
    await persistV55UniverseSnapshot(
      store as unknown as SupabaseClient,
      firstContext,
      universeSnapshot("TESTUSDT", firstContext.scanId, firstContext.scanGroupKey),
    );

    const variants = [
      { scanId: "scan-B", symbol: "SECONDUSDT", strategyManifestHash: "m".repeat(64) },
      {
        scanId: "scan-C",
        symbol: "THIRDUSDT",
        forwardStartTimestamp: firstContext.forwardStartTimestamp + 60_000,
      },
    ];
    for (const variant of variants) {
      await expect(persistV55UniverseSnapshot(
        store as unknown as SupabaseClient,
        { ...firstContext, ...variant },
        universeSnapshot(variant.symbol, variant.scanId, firstContext.scanGroupKey),
      )).rejects.toThrow("identity mismatch");
    }
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
    expect(migration).toContain("unique (experiment_id, scan_id)");
    expect(migration).not.toContain("unique (experiment_id, scan_group_key)");
    expect(migration).toContain("universe_snapshot_id uuid not null");
    expect(migration).toContain("foreign key (universe_snapshot_id, universe_snapshot_hash)");
    expect(migration).toContain("forward_start_timestamp timestamptz not null");
    expect(migration).toContain("runtime_commit_sha text not null");
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
    expect(migration).toContain("bca_v55_universe_snapshots_immutable");
    expect(migration).toContain("bca_v55_forward_experiment_identity_guard");
    expect(migration).toContain("from public, anon, authenticated");
  });

  it("allows settlement updates while blocking entry evidence mutation", () => {
    const initial = {
      v55_snapshot_id: "snapshot-A",
      symbol: "TESTUSDT",
      strategy_version: V55_STRATEGY_VERSION,
      entry_time: "2026-08-25T00:00:00.000Z",
      entry_price: 100,
      stop_price: 105,
      take_profit_price: 95,
      metadata: { entry_evidence_hash: "hash-A" },
      status: "OPEN",
      last_price: 100,
      last_candle_close_time: null,
      last_checked_at: "2026-08-25T00:15:00.000Z",
      unrealized_pnl_usdt: 0,
      exit_time: null,
      exit_price: null,
      exit_reason: null,
      gross_pnl_usdt: null,
      fees_usdt: 0,
      funding_usdt: 0,
      slippage_usdt: 0,
      net_pnl_usdt: null,
      r_multiple: null,
      settlement_error: null,
    };
    const entryFields = [
      "v55_snapshot_id", "symbol", "strategy_version", "entry_time", "entry_price", "stop_price", "take_profit_price", "metadata",
    ] as const;
    const settlementFields = [
      "last_price", "last_candle_close_time", "last_checked_at", "unrealized_pnl_usdt", "exit_time", "exit_price", "exit_reason",
      "gross_pnl_usdt", "fees_usdt", "funding_usdt", "slippage_usdt", "net_pnl_usdt", "r_multiple", "settlement_error", "status",
    ] as const;
    const interim = {
      ...initial,
      last_price: 101,
      last_candle_close_time: "2026-08-25T00:30:00.000Z",
      last_checked_at: "2026-08-25T00:31:00.000Z",
      unrealized_pnl_usdt: -0.5,
    };
    const takeProfit = {
      ...interim,
      status: "TAKE_PROFIT",
      exit_time: "2026-08-25T01:00:00.000Z",
      exit_price: 95,
      exit_reason: "TAKE_PROFIT",
      gross_pnl_usdt: 5,
      fees_usdt: 0.2,
      funding_usdt: -0.01,
      slippage_usdt: 0.1,
      net_pnl_usdt: 4.69,
      r_multiple: 0.94,
      settlement_error: null,
    };
    const stopLoss = {
      ...interim,
      status: "STOP_LOSS",
      exit_time: "2026-08-25T00:45:00.000Z",
      exit_price: 105,
      exit_reason: "STOP_LOSS",
      gross_pnl_usdt: -5,
      fees_usdt: 0.2,
      funding_usdt: 0.01,
      slippage_usdt: 0.1,
      net_pnl_usdt: -5.31,
      r_multiple: -1.06,
      settlement_error: null,
    };
    const timeLimit = {
      ...interim,
      status: "TIME_LIMIT",
      exit_time: "2026-08-25T02:00:00.000Z",
      exit_price: 99,
      exit_reason: "TIME_LIMIT",
      gross_pnl_usdt: 1,
      fees_usdt: 0.2,
      funding_usdt: -0.01,
      slippage_usdt: 0.1,
      net_pnl_usdt: 0.69,
      r_multiple: 0.14,
      settlement_error: null,
    };
    const settlements = [takeProfit, stopLoss, timeLimit];
    expect(settlements.map((row) => row.status)).toEqual(["TAKE_PROFIT", "STOP_LOSS", "TIME_LIMIT"]);
    for (const settlement of settlements) {
      expect(entryFields.map((field) => settlement[field])).toEqual(entryFields.map((field) => initial[field]));
    }
    for (const field of settlementFields) {
      expect(migration).not.toContain(`old.${field} is distinct from new.${field}`);
    }
  });
});
