import { describe, expect, it } from "vitest";
import {
  buildPitUniverseSnapshot,
  coverageRatio,
  listS3Objects,
  parseS3ListingPage,
  periodsFromArchiveKeys,
  sha256Bytes,
  validatePitSnapshot,
} from "../lib/lfv/archive-data";

function dailyBar(openTime: number, quoteVolume: number) {
  return {
    openTime,
    closeTime: openTime + 86_399_999,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    quoteVolume,
  };
}

function eligibleBars(quoteVolume: number, firstDay = 0) {
  return [
    dailyBar(firstDay * 86_400_000, quoteVolume),
    dailyBar((firstDay + 90) * 86_400_000, quoteVolume),
    dailyBar((firstDay + 100) * 86_400_000, quoteVolume),
  ];
}

describe("LFV-001 official archive and PIT data rules", () => {
  it("follows complete S3 ListObjectsV2 pagination", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string) => {
      calls.push(input);
      const xml = calls.length === 1
        ? "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken><CommonPrefixes><Prefix>root/BTCUSDT/</Prefix></CommonPrefixes><Contents><Key>root/a.zip</Key></Contents></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>root/b.zip</Key></Contents></ListBucketResult>";
      return new Response(xml, { status: 200 });
    };
    const listing = await listS3Objects("root/", { fetchImpl, s3Root: "https://s3.test" });
    expect(listing.pages).toBe(2);
    expect(listing.keys).toEqual(["root/a.zip", "root/b.zip"]);
    expect(listing.prefixes).toEqual(["root/BTCUSDT/"]);
    expect(calls[1]).toContain("continuation-token=page-2");
  });

  it("parses truncated pages without treating the first page as complete", () => {
    expect(parseS3ListingPage("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>")).toMatchObject({
      truncated: true,
      nextToken: "x",
    });
  });

  it("accepts early PIT universes with fewer than 100 eligible symbols", () => {
    const timestamp = 100 * 86_400_000;
    const bars = new Map([
      ["HISTORICALUSDT", eligibleBars(500)],
      ["SECONDUSDT", eligibleBars(400)],
    ]);
    const snapshot = buildPitUniverseSnapshot(timestamp, bars, { topSymbols: 100, minimumAgeDays: 0, recentDays: 30, minimumRecentBars: 1 });
    expect(snapshot.eligible).toHaveLength(2);
    expect(snapshot.deepScan).toHaveLength(2);
    expect(snapshot.effectiveUniverseSize).toBe(2);
    expect(validatePitSnapshot(snapshot, timestamp)).toBe(true);
  });

  it("selects top min(100,N) by PIT liquidity with a deterministic tie break", () => {
    const timestamp = 100 * 86_400_000;
    const bars = new Map(Array.from({ length: 101 }, (_, index) => [
      `S${String(index).padStart(3, "0")}USDT`,
      eligibleBars(index + 1),
    ]));
    const snapshot = buildPitUniverseSnapshot(timestamp, bars, { topSymbols: 100, minimumAgeDays: 0, recentDays: 30, minimumRecentBars: 1 });
    expect(snapshot.eligible).toHaveLength(101);
    expect(snapshot.deepScan).toHaveLength(100);
    expect(snapshot.deepScan).not.toContain("S000USDT");
    expect(snapshot.deepScan[0]).toBe("S100USDT");
  });

  it("never uses a future lifecycle bar in a PIT snapshot", () => {
    const timestamp = 100 * 86_400_000;
    const bars = new Map([["DELISTEDUSDT", [
      ...eligibleBars(900),
      dailyBar(101 * 86_400_000, 2_000),
    ]]]);
    const snapshot = buildPitUniverseSnapshot(timestamp, bars, { topSymbols: 100, minimumAgeDays: 0, recentDays: 30, minimumRecentBars: 1 });
    expect(snapshot.eligible[0].latestBarTime).toBeLessThanOrEqual(timestamp);
    expect(validatePitSnapshot(snapshot, timestamp)).toBe(true);
  });

  it("does not require a current-survivor filter for historical symbols", () => {
    const timestamp = 100 * 86_400_000;
    const snapshot = buildPitUniverseSnapshot(timestamp, new Map([["DELISTEDUSDT", eligibleBars(900)]]), { topSymbols: 100, minimumAgeDays: 0, recentDays: 30, minimumRecentBars: 1 });
    expect(snapshot.deepScan).toEqual(["DELISTEDUSDT"]);
  });

  it("verifies content hashes and archive month extraction deterministically", () => {
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(periodsFromArchiveKeys([
      "data/klines/BTCUSDT/15m/BTCUSDT-15m-2021-01.zip",
      "data/klines/BTCUSDT/15m/BTCUSDT-15m-2021-02.zip",
      "data/klines/BTCUSDT/15m/BTCUSDT-15m-2021-02.zip",
    ], "BTCUSDT", "15m")).toEqual(["2021-01", "2021-02"]);
  });

  it("calculates independent 15m/1h/4h coverage without a fixed symbol-count gate", () => {
    const required = ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05"];
    expect(coverageRatio(required, ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05"])).toBe(1);
    expect(coverageRatio(required, ["2021-01", "2021-02", "2021-03", "2021-04"])).toBe(0.8);
  });
});
