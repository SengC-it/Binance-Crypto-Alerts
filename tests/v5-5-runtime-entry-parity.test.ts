import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { Candle, MarketSnapshot } from "@/lib/core/types";
import { buildFeatureFrames } from "@/lib/v5-3/feature-snapshot";
import { buildStructuralPlan, detectStructuralSignal, runStructuralCandidate } from "@/lib/v5-3/structural";
import { getFrozenStrategy, V55_FORWARD_EXPERIMENT_ID } from "@/lib/v5-5/manifest";
import { evaluateV55Snapshot } from "@/lib/v5-5/runtime";
import { persistV55ShadowEvidence } from "@/lib/v5-5/repository";

const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
const interval = 15 * 60 * 1000;
const signalIndex = 130;

const instrument = {
  symbol: "PARITYUSDT",
  baseAsset: "PARITY",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.01,
  quantityStep: 0.001,
};

function fixtureCandle(
  index: number,
  open: number,
  close: number,
  high = Math.max(open, close) + 0.5,
  low = Math.min(open, close) - 0.5,
  volume = 100,
): Candle {
  const openTime = baseTime + index * interval;
  return { openTime, open, high, low, close, volume, closeTime: openTime + interval - 1 };
}

function parityFixture(nextOpen = 101): {
  dataset: HistoricalDataset;
  snapshot: MarketSnapshot;
  signal: Candle;
  next: Candle;
} {
  const candles = Array.from({ length: 170 }, (_, index) => fixtureCandle(index, 100, 100, 100.5, 99.5));
  candles[signalIndex - 2] = fixtureCandle(signalIndex - 2, 100.2, 101.2, 101.5, 99.8, 150);
  candles[signalIndex - 1] = fixtureCandle(signalIndex - 1, 100.2, 100.2, 100.4, 99.7, 100);
  candles[signalIndex] = fixtureCandle(signalIndex, 100.3, 100, 100.2, 99.7, 200);
  candles[signalIndex + 1] = fixtureCandle(signalIndex + 1, nextOpen, 101.2, 101.5, 100.5, 100);
  const signal = candles[signalIndex];
  const next = candles[signalIndex + 1];
  const dataset: HistoricalDataset = {
    symbol: instrument.symbol,
    instrument,
    candles: { "15m": candles, "1h": [], "4h": [] },
  };
  return {
    dataset,
    signal,
    next,
    snapshot: {
      instrument,
      tickerPrice: signal.close,
      candles: { "15m": candles.slice(0, signalIndex + 1), "1h": [], "4h": [] },
      sourceTimestamp: signal.closeTime,
      nextExecutionCandle: { openTime: next.openTime, open: nextOpen },
    },
  };
}

function parityContext(scanId = "parity-scan") {
  return {
    scanId,
    scanGroupKey: "parity-group",
    scanTimestamp: baseTime,
    forwardStartTimestamp: 0,
    experimentId: V55_FORWARD_EXPERIMENT_ID,
    runtimeCommitSha: "runtime-parity-test",
    strategyManifestHash: getFrozenStrategy().manifestHash,
    universeSnapshotHash: "u".repeat(64),
    universeSnapshotId: "universe-parity",
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
      if (rows.some((existing) => this.isDuplicate(existing, row))) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      rows.push(row);
      this.client.rows.set(this.table, rows);
      return { data: row, error: null };
    }
    const matches = rows.filter((row) => this.filters.every(([column, value]) => row[column] === value));
    return { data: matches[0] ?? null, error: null };
  }

  private isDuplicate(existing: FakeRow, incoming: FakeRow): boolean {
    if (this.table === "bca_v55_signal_feature_snapshots") {
      return existing.experiment_id === incoming.experiment_id
        && existing.strategy_version === incoming.strategy_version
        && existing.symbol === incoming.symbol
        && existing.source_data_timestamp === incoming.source_data_timestamp;
    }
    return existing.id === incoming.id;
  }
}

describe("V5.5 frozen runtime entry parity", () => {
  it("uses the historical next-bar OPEN and the shared structural plan", () => {
    const fixture = parityFixture();
    const frozen = getFrozenStrategy();
    const frames = buildFeatureFrames(fixture.dataset, { entryStrideBars: 1 });
    const frame = frames.find((candidate) => candidate.index === signalIndex);
    expect(frame).toBeDefined();
    const historicalPlan = buildStructuralPlan(fixture.dataset.candles["15m"], frame!, fixture.next, frozen.definition);
    const historicalTrades = runStructuralCandidate(fixture.dataset, frames, frozen.definition, {
      startTime: fixture.signal.closeTime,
      endTime: fixture.next.closeTime,
      cooldownHours: 0,
    });
    const historicalTrade = historicalTrades.find((trade) => trade.entryTime === fixture.next.closeTime);
    const runtime = evaluateV55Snapshot(fixture.snapshot, parityContext());

    expect(detectStructuralSignal(frame!, fixture.dataset.candles["15m"], frozen.definition)).toBe(true);
    expect(historicalTrade).toBeDefined();
    expect(historicalPlan).not.toBeNull();
    expect(runtime.snapshot.decision.rawTrigger).toBe(true);
    expect(runtime.tradePlan).not.toBeNull();
    expect(runtime.snapshot.signalCandleCloseTime).toBe(new Date(fixture.signal.closeTime).toISOString());
    expect(runtime.snapshot.executionCandleOpenTime).toBe(new Date(fixture.next.openTime).toISOString());
    expect(runtime.snapshot.executionReferencePrice).toBe(101);
    expect(runtime.snapshot.executionReferenceSource).toBe("BINANCE_15M_NEXT_BAR_OPEN");
    expect(runtime.snapshot.executionReferenceStatus).toBe("AVAILABLE");
    expect(runtime.tradePlan?.entryReference).toBe(101);
    expect(runtime.tradePlan?.entryPrice).toBe(101);
    expect(runtime.tradePlan?.stopPrice).toBe(historicalPlan?.stopPrice);
    expect(runtime.tradePlan?.takeProfitPrice).toBe(historicalPlan?.targetPrice);
    expect(runtime.tradePlan?.riskPrice).toBe(historicalPlan?.riskPrice);
    expect(runtime.tradePlan?.rewardRisk).toBe(frozen.definition.rewardRisk);
    expect(runtime.tradePlan?.quantity).toBe(50 / historicalPlan!.riskPrice);
    expect(runtime.tradePlan?.validUntil).toBe(
      fixture.next.openTime + frozen.definition.expectedHoldingHorizonHours * 60 * 60 * 1000,
    );
    expect(historicalTrade?.entryTime).toBe(fixture.next.closeTime);
    expect(runtime.tradePlan?.entryPrice).not.toBe(fixture.signal.close);
  });

  it("does not use the next candle high, low, close, or volume for the signal", () => {
    const fixture = parityFixture();
    const baseline = evaluateV55Snapshot(fixture.snapshot, parityContext());
    const pollutedNext = fixture.next;
    const pollutedSnapshot: MarketSnapshot = {
      ...fixture.snapshot,
      candles: {
        ...fixture.snapshot.candles,
        "15m": [...fixture.snapshot.candles["15m"]!, {
          ...pollutedNext,
          high: 999,
          low: 1,
          close: 777,
          volume: 999_999,
        }],
      },
    };
    const polluted = evaluateV55Snapshot(pollutedSnapshot, parityContext());

    expect(polluted.snapshot.decision.rawTrigger).toBe(baseline.snapshot.decision.rawTrigger);
    expect(polluted.snapshot.provenance.snapshotHash).toBe(baseline.snapshot.provenance.snapshotHash);
    expect(polluted.tradePlan?.stopPrice).toBe(baseline.tradePlan?.stopPrice);
    expect(polluted.tradePlan?.takeProfitPrice).toBe(baseline.tradePlan?.takeProfitPrice);
  });

  it("fails closed without a valid next-bar open and writes no Shadow trade", async () => {
    const fixture = parityFixture();
    const snapshot: MarketSnapshot = { ...fixture.snapshot, nextExecutionCandle: null };
    const evaluation = evaluateV55Snapshot(snapshot, parityContext());
    const store = new FakeSupabase();
    const summary = await persistV55ShadowEvidence(store as unknown as SupabaseClient, parityContext(), [evaluation]);

    expect(evaluation.snapshot.decision.rawTrigger).toBe(true);
    expect(evaluation.snapshot.decision.finalEligible).toBe(false);
    expect(evaluation.snapshot.executionCandleOpenTime).toBeNull();
    expect(evaluation.snapshot.executionReferencePrice).toBeNull();
    expect(evaluation.snapshot.executionReferenceSource).toBe("EXECUTION_REFERENCE_UNAVAILABLE");
    expect(evaluation.snapshot.executionReferenceStatus).toBe("EXECUTION_REFERENCE_UNAVAILABLE");
    expect(evaluation.snapshot.decision.rejectionReasons).toContain("EXECUTION_REFERENCE_UNAVAILABLE");
    expect(summary.shadowTradesWritten).toBe(0);
    expect(store.rows.get("bca_shadow_paper_trades") ?? []).toHaveLength(0);
  });

  it("persists execution provenance at the next candle open", async () => {
    const fixture = parityFixture();
    const evaluation = evaluateV55Snapshot(fixture.snapshot, parityContext());
    const store = new FakeSupabase();
    const summary = await persistV55ShadowEvidence(store as unknown as SupabaseClient, parityContext(), [evaluation]);
    const feature = (store.rows.get("bca_v55_signal_feature_snapshots") ?? [])[0];
    const trade = (store.rows.get("bca_shadow_paper_trades") ?? [])[0];
    const snapshotJson = feature?.snapshot_json as Record<string, unknown>;
    const metadata = trade?.metadata as Record<string, unknown>;

    expect(summary.shadowTradesWritten).toBe(1);
    expect(snapshotJson.executionReferenceSource).toBe("BINANCE_15M_NEXT_BAR_OPEN");
    expect(snapshotJson.executionReferencePrice).toBe(101);
    expect(trade?.entry_time).toBe(new Date(fixture.next.openTime).toISOString());
    expect(trade?.entry_price).toBe(101);
    expect(metadata.execution_reference_source).toBe("BINANCE_15M_NEXT_BAR_OPEN");
    expect(metadata.execution_candle_open_time).toBe(new Date(fixture.next.openTime).toISOString());
    expect(fixture.signal.closeTime).toBeLessThan(fixture.next.openTime);
  });

  it("does not backfill a trade when a duplicate snapshot becomes eligible later", async () => {
    const fixture = parityFixture();
    const store = new FakeSupabase();
    const first = evaluateV55Snapshot(
      { ...fixture.snapshot, nextExecutionCandle: null },
      parityContext("canonical-scan"),
    );
    const second = evaluateV55Snapshot(fixture.snapshot, parityContext("duplicate-scan"));

    await persistV55ShadowEvidence(store as unknown as SupabaseClient, parityContext("canonical-scan"), [first]);
    const duplicate = await persistV55ShadowEvidence(store as unknown as SupabaseClient, parityContext("duplicate-scan"), [second]);

    expect(duplicate.idempotentSnapshots).toBe(1);
    expect(duplicate.idempotentTradeSkips).toBe(1);
    expect(duplicate.shadowTradesWritten).toBe(0);
    expect(store.rows.get("bca_shadow_paper_trades") ?? []).toHaveLength(0);
  });

  it("keeps the canonical trade when a duplicate cron has a different evaluation", async () => {
    const firstFixture = parityFixture(101);
    const secondFixture = parityFixture(101.1);
    const store = new FakeSupabase();
    const firstContext = parityContext("canonical-scan");
    const secondContext = parityContext("duplicate-scan");
    const first = evaluateV55Snapshot(firstFixture.snapshot, firstContext);
    const second = evaluateV55Snapshot(secondFixture.snapshot, secondContext);

    await persistV55ShadowEvidence(store as unknown as SupabaseClient, firstContext, [first]);
    const duplicate = await persistV55ShadowEvidence(store as unknown as SupabaseClient, secondContext, [second]);
    const trades = store.rows.get("bca_shadow_paper_trades") ?? [];

    expect(duplicate.idempotentSnapshots).toBe(1);
    expect(duplicate.idempotentTradeSkips).toBe(1);
    expect(trades).toHaveLength(1);
    expect(trades[0].entry_price).toBe(101);
    expect((trades[0].metadata as Record<string, unknown>).execution_reference_price).toBe(101);
  });
});
