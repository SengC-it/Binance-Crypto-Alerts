import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { V21_INTERVAL_MS, V21_SYMBOLS } from "../lib/v21/constants";
import {
  V21_PIT_OBSERVATION_COUNT,
} from "../lib/v21/features";
import {
  applyV21AuditOverlap,
  applyV21TimestampOverlap,
  enumerateV21PreReturnEvents,
  v21AuditIdentityPayload,
  v21EventIdentityPayload,
  type V21EventIdentity,
  type V21PreReturnAudit,
  type V21SynchronizedReturnMatrix,
} from "../lib/v21/events";

describe("V21 WP3A pre-return event identities", () => {
  it("enumerates a first-cross identity without any outcome data", () => {
    const input = syntheticFirstCrossInput();
    const result = enumerateV21PreReturnEvents(input);
    expect(result.diagnostics.synchronizedReturnRows).toBe(V21_PIT_OBSERVATION_COUNT + 1);
    expect(result.diagnostics.eligiblePitFeatures).toBe(V21_SYMBOLS.length);
    expect(result.diagnostics.firstCrossCandidates).toBeGreaterThan(0);
    expect(result.primaryOosEvents.length).toBeGreaterThan(0);
    for (const event of result.primaryOosEvents) {
      expect(Object.keys(event)).toEqual(["symbol", "signalOpenTime", "direction", "clusterId"]);
      expect(event.clusterId).toBe(event.signalOpenTime);
    }
    expect(v21AuditIdentityPayload(result.auditCandidates)).toEqual(result.allEvents);
    expect(result.auditCandidates.every((row) => !("entryOpen" in row) && !("netReturn" in row))).toBe(true);
  }, 120000);

  it("preserves an explicit zero-residual ineligible audit marker", () => {
    const zero: V21PreReturnAudit = {
      symbol: "BTCUSDT",
      signalOpenTime: Date.parse("2022-01-01T00:00:00.000Z"),
      signalCloseTime: Date.parse("2022-01-01T00:05:00.000Z"),
      signalTimestamp: Date.parse("2022-01-01T00:05:00.000Z"),
      direction: null,
      assetReturn: 0,
      marketReturn: 0,
      alpha: 0,
      beta: 1,
      previousResidual: 0,
      currentResidual: 0,
      residualAbsQ99: 0,
      clusterId: Date.parse("2022-01-01T00:00:00.000Z"),
      eligibilityStatus: "ZERO_RESIDUAL_INELIGIBLE",
      overlapStatus: "ACCEPTED",
    };
    const result = applyV21AuditOverlap([zero]);
    expect(result.audits).toEqual([zero]);
    expect(v21AuditIdentityPayload(result.audits)).toEqual([]);
  });

  it("applies timestamp-only overlap per symbol while allowing same-time symbols", () => {
    const time = Date.parse("2022-01-01T00:00:00.000Z");
    const candidates = [
      { symbol: "BTCUSDT" as const, signalOpenTime: time, direction: "SHORT" as const },
      { symbol: "ETHUSDT" as const, signalOpenTime: time, direction: "LONG" as const },
      { symbol: "BTCUSDT" as const, signalOpenTime: time + V21_INTERVAL_MS, direction: "LONG" as const },
      { symbol: "BTCUSDT" as const, signalOpenTime: time + 6 * V21_INTERVAL_MS, direction: "SHORT" as const },
    ];
    const result = applyV21TimestampOverlap(candidates);
    expect(result.excluded).toBe(1);
    expect(result.accepted.map((event) => `${event.symbol}:${event.signalOpenTime}`)).toEqual([
      `BTCUSDT:${time}`,
      `ETHUSDT:${time}`,
      `BTCUSDT:${time + 6 * V21_INTERVAL_MS}`,
    ]);
  });

  it("sorts the identity payload deterministically and contains no execution fields", () => {
    const events: V21EventIdentity[] = [
      { symbol: "ETHUSDT", signalOpenTime: 2, direction: "LONG", clusterId: 2 },
      { symbol: "BTCUSDT", signalOpenTime: 1, direction: "SHORT", clusterId: 1 },
    ];
    expect(v21EventIdentityPayload(events)).toEqual([
      { symbol: "BTCUSDT", signalOpenTime: 1, direction: "SHORT", clusterId: 1 },
      { symbol: "ETHUSDT", signalOpenTime: 2, direction: "LONG", clusterId: 2 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/pnl|win|loss|price|return/i);
  });

  it("keeps the historical runner behind the future-data firewall", () => {
    const runner = readFileSync("scripts/run-v21-event-stage.ts", "utf8");
    expect(runner).toContain("noNetworkFetch");
    expect(runner).not.toMatch(/bar\.(high|low|volume|quoteVolume|tradeCount)/);
    expect(runner).not.toMatch(/\bt\s*\+\s*1\b|\bfuture\s+(?:price|bar|return)/i);
  });

  it("requires dependency validation and explicit boundary metadata", () => {
    const validator = readFileSync("scripts/validate-v21-events.ts", "utf8");
    expect(validator).toContain('"validate:v21:data"');
    expect(validator).toContain('"validate:v21:features"');
    expect(validator).toContain('"validate:v21:feature-scan"');
    expect(validator).toContain('"validate:v21:event-predicate"');
    expect(validator).toContain("nextBarOpenRead");
    expect(validator).toContain("futurePriceRead");
    expect(validator).toContain("holdoutOutcomeRead");
  });
});

function syntheticFirstCrossInput(): V21SynchronizedReturnMatrix {
  const length = V21_PIT_OBSERVATION_COUNT + 1;
  const baseTime = Date.parse("2022-01-01T00:00:00.000Z") - V21_PIT_OBSERVATION_COUNT * V21_INTERVAL_MS;
  const openTimes = new Float64Array(length);
  const returnsBySymbol = {} as Record<(typeof V21_SYMBOLS)[number], Float64Array>;
  for (const symbol of V21_SYMBOLS) returnsBySymbol[symbol] = new Float64Array(length);

  for (let rowIndex = 0; rowIndex < length; rowIndex += 1) {
    openTimes[rowIndex] = baseTime + rowIndex * V21_INTERVAL_MS;
    const market = 0.002 * Math.sin(rowIndex / 17) + 0.0007 * Math.cos(rowIndex / 31);
    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      returnsBySymbol[V21_SYMBOLS[symbolIndex]][rowIndex] = market + (symbolIndex - 3.5) * 0.00001;
    }
    if (rowIndex >= length - 1 - 88 && rowIndex < length - 2) {
      returnsBySymbol.BTCUSDT[rowIndex] += 0.01;
    }
    if (rowIndex === length - 1) returnsBySymbol.BTCUSDT[rowIndex] += 0.02;
  }
  return { openTimes, returnsBySymbol };
}
