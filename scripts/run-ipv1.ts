import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { evaluateIpv1EmailPilotGate } from "@/lib/ipv1/gate";
import { prepareIpv1Evidence, runIpv1Replay } from "@/lib/ipv1/replay";
import { summarizeIpv1Replay } from "@/lib/ipv1/metrics";
import {
  IPV1_BASELINE_STRATEGY_VERSION,
  IPV1_CHALLENGER_STRATEGY_VERSION,
  IPV1_EXPERIMENT_ID,
  IPV1_HYPOTHESIS_FROZEN_AT_UTC,
  IPV1_PRIMARY_EXECUTION,
  IPV1_STRESS_EXECUTION,
  type Ipv1CandidateRow,
  type Ipv1MarketDataProvider,
  type Ipv1ScanGroupRow,
} from "@/lib/ipv1/types";
import type { Candle, FundingRatePoint } from "@/lib/core/types";

const FAPI_DEFAULT = "https://fapi.binance.com";
const MINUTE_MS = 60 * 1000;
const KLINE_LIMIT = 1_500;

interface ReadResult {
  groups: Ipv1ScanGroupRow[];
  candidates: Ipv1CandidateRow[];
  error?: string;
}

class Ipv1BinanceProvider implements Ipv1MarketDataProvider {
  constructor(private readonly baseUrl: string, private readonly asOfMs: number) {}

  async getMinuteCandles(symbol: string, startTime: number, endTime: number): Promise<Candle[]> {
    const candles = await this.getRange<unknown[][], Candle>("/fapi/v1/klines", symbol, startTime, endTime, (raw) => parseCandle(raw));
    return candles.filter((candle) => candle.closeTime <= this.asOfMs);
  }

  async getFundingRates(symbol: string, startTime: number, endTime: number): Promise<FundingRatePoint[]> {
    return this.getRange<BinanceFundingRate, FundingRatePoint>("/fapi/v1/fundingRate", symbol, startTime, endTime, (point) => parseFunding(point));
  }

  private async getRange<T, R>(
    endpoint: string,
    symbol: string,
    startTime: number,
    endTime: number,
    parse: (value: T) => R,
  ): Promise<R[]> {
    if (startTime > endTime) return [];
    const values: R[] = [];
    let cursor = startTime;
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(endpoint, this.baseUrl);
      url.searchParams.set("symbol", symbol);
      if (endpoint.endsWith("klines")) url.searchParams.set("interval", "1m");
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(Math.min(endTime, this.asOfMs)));
      const pageLimit = endpoint.endsWith("klines") ? KLINE_LIMIT : 1_000;
      url.searchParams.set("limit", String(pageLimit));
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`PUBLIC_MARKET_DATA_HTTP_${response.status}`);
      const body = await response.json() as T[];
      if (!Array.isArray(body) || body.length === 0) break;
      for (const raw of body) values.push(parse(raw));
      const lastTimestamp = endpoint.endsWith("klines")
        ? Number((body.at(-1) as unknown[])[0])
        : Number((body.at(-1) as BinanceFundingRate).fundingTime);
      if (!Number.isFinite(lastTimestamp) || body.length < pageLimit) break;
      const nextCursor = lastTimestamp + (endpoint.endsWith("klines") ? MINUTE_MS : 1);
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return values;
  }
}

interface BinanceFundingRate {
  fundingTime: number;
  fundingRate: string;
}

async function main(): Promise<void> {
  const asOfInput = process.argv.slice(2).find((argument) => argument.startsWith("--as-of="))?.slice("--as-of=".length);
  if (!asOfInput) throw new Error("IPV-1 requires an explicit --as-of=<ISO UTC> argument");
  const asOfMs = parseUtc(asOfInput);
  const asOfUtc = new Date(asOfMs).toISOString();
  const read = await readIndependentEvidence(asOfUtc);
  const evidence = prepareIpv1Evidence(read.groups, read.candidates);
  const provider = new Ipv1BinanceProvider(process.env.BINANCE_API_BASE_URL ?? FAPI_DEFAULT, asOfMs);

  const primaryBaselineReplay = await runIpv1Replay(
    evidence.groups,
    evidence.candidates,
    IPV1_BASELINE_STRATEGY_VERSION,
    IPV1_PRIMARY_EXECUTION,
    asOfMs,
    provider,
    evidence.invalidEvidenceCount,
  );
  const primaryChallengerReplay = await runIpv1Replay(
    evidence.groups,
    evidence.candidates,
    IPV1_CHALLENGER_STRATEGY_VERSION,
    IPV1_PRIMARY_EXECUTION,
    asOfMs,
    provider,
    evidence.invalidEvidenceCount,
  );
  const stressBaselineReplay = await runIpv1Replay(
    evidence.groups,
    evidence.candidates,
    IPV1_BASELINE_STRATEGY_VERSION,
    IPV1_STRESS_EXECUTION,
    asOfMs,
    provider,
    evidence.invalidEvidenceCount,
  );
  const stressChallengerReplay = await runIpv1Replay(
    evidence.groups,
    evidence.candidates,
    IPV1_CHALLENGER_STRATEGY_VERSION,
    IPV1_STRESS_EXECUTION,
    asOfMs,
    provider,
    evidence.invalidEvidenceCount,
  );

  const primaryBaseline = summarizeIpv1Replay(primaryBaselineReplay.decisions);
  const primaryChallenger = summarizeIpv1Replay(primaryChallengerReplay.decisions);
  const stressBaseline = summarizeIpv1Replay(stressBaselineReplay.decisions);
  const stressChallenger = summarizeIpv1Replay(stressChallengerReplay.decisions);
  const dataInvalid = Boolean(read.error)
    || evidence.invalidEvidenceCount > 0
    || primaryBaseline.dataInvalidTrades > 0
    || primaryChallenger.dataInvalidTrades > 0
    || stressBaseline.dataInvalidTrades > 0
    || stressChallenger.dataInvalidTrades > 0;
  const gate = evaluateIpv1EmailPilotGate(primaryBaseline, primaryChallenger, stressChallenger, dataInvalid);
  const reportWithoutHash = {
    experimentId: IPV1_EXPERIMENT_ID,
    hypothesisFrozenAtUtc: IPV1_HYPOTHESIS_FROZEN_AT_UTC,
    asOfUtc,
    candidateDataWindow: { fromInclusive: IPV1_HYPOTHESIS_FROZEN_AT_UTC, toExclusive: asOfUtc },
    sourceTables: ["public.bca_scan_groups", "public.bca_shadow_candidates"],
    marketDataSource: "Binance official public USD-M klines and fundingRate endpoints",
    completedScanGroupsRead: evidence.groups.length,
    candidateGroups: new Set(evidence.candidates.map((candidate) => candidate.scanGroupKey)).size,
    excludedBeforeFreezeCount: evidence.excludedBeforeFreezeCount,
    invalidEvidenceCount: evidence.invalidEvidenceCount,
    readError: read.error ?? null,
    baselineDecisionCount: primaryBaseline.candidateDecisionGroups,
    challengerDecisionCount: primaryChallenger.candidateDecisionGroups,
    primary: { baseline: primaryBaseline, challenger: primaryChallenger },
    stress: { baseline: stressBaseline, challenger: stressChallenger },
    gate,
    dataInvalid,
    historicalBenchmarksContextOnly: {
      oldEmailStrategy: {
        strategyVersion: "trend-rejection-short-v1",
        closedTrades: 37,
        netPnlUsdt: -608.54,
        netProfitFactor: 0.511,
        avgR: -0.358,
        maxDrawdownUsdt: 703.67,
      },
      rulesProfitOrientedV4: {
        closedTrades: 26,
        netPnlUsdt: -64.96,
        netProfitFactor: 0.899,
        maxDrawdownUsdt: 322.89,
      },
      usedAsIndependentSample: false,
    },
    productionSignalEmailEnabled: false,
    autoTrading: false,
    orderPlacement: false,
    automaticPromotion: false,
    historicalPaperBenchmarkContextOnly: true,
  };
  const reportSha256 = sha256(canonicalJson(reportWithoutHash));
  const report = { ...reportWithoutHash, reportSha256 };
  const artifactDirectory = resolve("artifacts/ipv1");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactPath = resolve(artifactDirectory, `ipv1-${asOfUtc.replace(/[:.]/g, "-")}.json`);
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ artifactPath, ...report }, null, 2));
}

async function readIndependentEvidence(asOfUtc: string): Promise<ReadResult> {
  try {
    const supabase = getSupabaseAdmin();
    const [groupsResult, candidatesResult] = await Promise.all([
      supabase
        .from("bca_scan_groups")
        .select("scan_group_key,status,finished_at")
        .eq("status", "COMPLETED")
        .not("finished_at", "is", null)
        .lt("finished_at", asOfUtc)
        .order("scan_group_key", { ascending: true }),
      supabase
        .from("bca_shadow_candidates")
        .select("scan_group_key,symbol,source_data_timestamp,score,candidate,trade_plan")
        .gte("source_data_timestamp", IPV1_HYPOTHESIS_FROZEN_AT_UTC)
        .lt("source_data_timestamp", asOfUtc)
        .order("scan_group_key", { ascending: true })
        .order("score", { ascending: false })
        .order("symbol", { ascending: true }),
    ]);
    if (groupsResult.error || candidatesResult.error) throw new Error("SUPABASE_READ_FAILED");
    return {
      groups: (groupsResult.data ?? []) as Ipv1ScanGroupRow[],
      candidates: (candidatesResult.data ?? []) as Ipv1CandidateRow[],
    };
  } catch {
    return { groups: [], candidates: [], error: "SUPABASE_READ_FAILED" };
  }
}

function parseUtc(value: string): number {
  if (!/Z$/i.test(value)) throw new Error("IPV-1 --as-of must be an ISO UTC timestamp ending in Z");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("IPV-1 --as-of must be a valid ISO UTC timestamp");
  return timestamp;
}

function parseCandle(raw: unknown[]): Candle {
  if (!Array.isArray(raw) || raw.length < 7) throw new Error("INVALID_PUBLIC_KLINE");
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
}

function parseFunding(raw: BinanceFundingRate): FundingRatePoint {
  return { fundingTime: Number(raw.fundingTime), fundingRate: Number(raw.fundingRate) };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "number" && !Number.isFinite(nested)) return null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    }
    return nested;
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
