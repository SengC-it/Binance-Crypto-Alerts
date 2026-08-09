import { NextRequest, NextResponse } from "next/server";
import { BinancePublicClient, mapWithConcurrency, selectDeepUniverse } from "@/lib/binance/public-client";
import { getServerConfig, type ServerConfig } from "@/lib/config";
import { buildTradePlan } from "@/lib/core/risk";
import { rankCandidates } from "@/lib/core/scoring";
import { generateCandidates } from "@/lib/core/strategies";
import { fifteenMinuteGroupKey, signalKey, zonedDateString } from "@/lib/core/time";
import type { Instrument, MarketSnapshot, Timeframe } from "@/lib/core/types";
import { sendSignalEmail, sendSystemAlertEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  claimSignal,
  completeScanRun,
  createNotification,
  createScanRun,
  finishNotification,
  recordSystemEvent,
  upsertInstruments,
} from "@/lib/services/signal-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRATEGY_VERSION = "rules-mvp-v1";

export async function GET(request: NextRequest) {
  return runScan(request);
}

export async function POST(request: NextRequest) {
  return runScan(request);
}

async function runScan(request: NextRequest): Promise<NextResponse> {
  let scanRunId: string | undefined;
  let supabase: ReturnType<typeof getSupabaseAdmin> | undefined;
  let config: ServerConfig | undefined;

  try {
    const runtimeConfig = getServerConfig();
    config = runtimeConfig;
    if (!isAuthorized(request, runtimeConfig.CRON_SECRET)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const batchNumber = parseBatchNumber(request.nextUrl.searchParams.get("batch"));
    const client = new BinancePublicClient(runtimeConfig.BINANCE_API_BASE_URL);
    const universe = await client.getUniverse();
    const deepUniverse = selectDeepUniverse(universe, runtimeConfig.CS_TOP_SYMBOLS);
    const batchCount = Math.max(1, Math.ceil(deepUniverse.length / runtimeConfig.CS_SCAN_BATCH_SIZE));
    if (batchNumber >= batchCount) {
      return NextResponse.json({ ok: false, error: "batch_out_of_range", batchNumber, batchCount }, { status: 400 });
    }

    const scanGroupKey = fifteenMinuteGroupKey(Date.now());
    const runKey = `${scanGroupKey}:batch:${batchNumber}`;
    const batch = deepUniverse.slice(
      batchNumber * runtimeConfig.CS_SCAN_BATCH_SIZE,
      (batchNumber + 1) * runtimeConfig.CS_SCAN_BATCH_SIZE,
    );
    supabase = getSupabaseAdmin();
    await upsertInstruments(supabase, universe.map(toInstrumentRow));
    scanRunId = await createScanRun(supabase, {
      runKey,
      scanGroupKey,
      timeframe: "15m",
      batchNumber,
      batchCount,
      universeSize: universe.length,
    });

    const errors: Array<{ symbol?: string; stage: string; message: string }> = [];
    const snapshots = await mapWithConcurrency(batch, runtimeConfig.CS_REQUEST_CONCURRENCY, async (instrument) => {
      try {
        const timeframes = normalizedTimeframes(runtimeConfig.scanTimeframes);
        return await client.getSnapshot(instrument, timeframes, 250) as MarketSnapshot;
      } catch (error) {
        errors.push({ symbol: instrument.symbol, stage: "market_data", message: errorMessage(error) });
        return null;
      }
    });

    const candidates = snapshots
      .filter((snapshot): snapshot is MarketSnapshot => snapshot !== null)
      .flatMap((snapshot) => {
        try {
          const top = rankCandidates(generateCandidates(snapshot))[0];
          if (!top || top.score < runtimeConfig.CS_MIN_SIGNAL_SCORE) return [];
          const plan = buildTradePlan(top, snapshot.instrument, {
            marginUsdt: runtimeConfig.CS_MARGIN_USDT,
            leverage: runtimeConfig.CS_ASSUMED_LEVERAGE,
            singleSignalRiskCapUsdt: runtimeConfig.CS_PER_SIGNAL_RISK_CAP_USDT,
            dailyRiskBudgetUsdt: runtimeConfig.CS_DAILY_RISK_BUDGET_USDT,
            maxHoldHours: runtimeConfig.CS_MAX_HOLD_HOURS,
          }, snapshot.sourceTimestamp);
          return [{ snapshot, candidate: top, plan }];
        } catch (error) {
          errors.push({ symbol: snapshot.instrument.symbol, stage: "risk_plan", message: errorMessage(error) });
          return [];
        }
      })
      .sort((left, right) => right.candidate.score - left.candidate.score);

    let emailedCount = 0;
    let claimedCount = 0;
    for (const opportunity of candidates) {
      const occurrenceDate = zonedDateString(opportunity.snapshot.sourceTimestamp, runtimeConfig.CS_DEFAULT_TIMEZONE);
      const key = signalKey({
        symbol: opportunity.snapshot.instrument.symbol,
        side: opportunity.candidate.side,
        timeframe: opportunity.candidate.primaryTimeframe,
        strategyVersion: STRATEGY_VERSION,
        sourceTimestamp: opportunity.snapshot.sourceTimestamp,
      });
      const hasEmailConfig = Boolean(runtimeConfig.GMAIL_SMTP_USER && runtimeConfig.GMAIL_SMTP_APP_PASSWORD && runtimeConfig.GMAIL_RECIPIENT);
      const claim = await claimSignal(
        supabase,
        {
          scanRunId,
          scanGroupKey,
          signalKey: key,
          symbol: opportunity.snapshot.instrument.symbol,
          candidate: opportunity.candidate,
          plan: opportunity.plan,
          strategyVersion: STRATEGY_VERSION,
          sourceTimestamp: opportunity.snapshot.sourceTimestamp,
          occurrenceDate,
        },
        {
          dailyDate: occurrenceDate,
          dailyLimitUsdt: runtimeConfig.CS_DAILY_RISK_BUDGET_USDT,
          singleRiskCapUsdt: runtimeConfig.CS_PER_SIGNAL_RISK_CAP_USDT,
          dailyEmailCap: runtimeConfig.CS_NEW_EMAIL_DAILY_CAP,
          scanEmailCap: runtimeConfig.CS_MAX_EMAILS_PER_SCAN,
          shouldEmail: hasEmailConfig,
        },
      );
      if (claim.status === "CREATED" || claim.status === "REPLACED") claimedCount += 1;
      if (!claim.email_allowed || !runtimeConfig.GMAIL_RECIPIENT) continue;

      const idempotencyKey = `${claim.signal_id}:GMAIL_SMTP`;
      const subject = `[风险警告] ${opportunity.snapshot.instrument.symbol} ${opportunity.candidate.side} · ${opportunity.candidate.score.toFixed(1)} 分`;
      const created = await createNotification(supabase, {
        signalId: claim.signal_id,
        idempotencyKey,
        recipient: runtimeConfig.GMAIL_RECIPIENT,
        subject,
      });
      if (!created) continue;

      try {
        const sent = await sendSignalEmail({
          symbol: opportunity.snapshot.instrument.symbol,
          candidate: opportunity.candidate,
          plan: opportunity.plan,
          strategyVersion: STRATEGY_VERSION,
          sourceTimestamp: opportunity.snapshot.sourceTimestamp,
        });
        await finishNotification(supabase, idempotencyKey, {
          status: sent.skipped ? "SKIPPED" : "SENT",
          providerMessageId: sent.messageId,
        });
        if (!sent.skipped) emailedCount += 1;
      } catch (error) {
        errors.push({ symbol: opportunity.snapshot.instrument.symbol, stage: "email", message: errorMessage(error) });
        await finishNotification(supabase, idempotencyKey, { status: "FAILED", error: errorMessage(error) });
      }
    }

    await completeScanRun(supabase, scanRunId, {
      scannedSymbols: batch.length,
      candidateCount: candidates.length,
      emailedCount,
      status: errors.length === 0 ? "COMPLETED" : "PARTIAL",
      errorSummary: errors,
    });

    return NextResponse.json({
      ok: true,
      scanGroupKey,
      batchNumber,
      batchCount,
      universeSize: universe.length,
      deepUniverseSize: deepUniverse.length,
      scannedSymbols: batch.length,
      candidateCount: candidates.length,
      claimedCount,
      emailedCount,
      errors,
      dryRun: runtimeConfig.CS_DRY_RUN,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (supabase) {
      try {
        await recordSystemEvent(supabase, {
          eventType: "SCAN_ERROR",
          severity: "ERROR",
          component: "scan_api",
          message,
          details: { scanRunId },
        });
      } catch {
        // Preserve the original scan error when the error logger is unavailable.
      }
    }
    if (config) {
      try {
        await sendSystemAlertEmail(config, {
          component: "scan_api",
          message,
          scanRunId,
        });
      } catch {
        // The original error remains the response when the SMTP side channel is unavailable.
      }
    }
    return NextResponse.json({ ok: false, error: message, scanRunId }, { status: 500 });
  }
}

function isAuthorized(request: NextRequest, expectedSecret?: string): boolean {
  if (!expectedSecret) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === expectedSecret || request.headers.get("x-cron-secret") === expectedSecret;
}

function parseBatchNumber(value: string | null): number {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("batch must be a non-negative integer");
  return parsed;
}

function normalizedTimeframes(values: string[]): Timeframe[] {
  const valid = values.filter((value): value is Timeframe => value === "15m" || value === "1h" || value === "4h");
  return valid.includes("15m") ? valid : ["15m", ...valid];
}

function toInstrumentRow(instrument: Instrument) {
  return {
    symbol: instrument.symbol,
    base_asset: instrument.baseAsset,
    quote_asset: instrument.quoteAsset,
    contract_type: instrument.contractType,
    exchange_status: instrument.status,
    price_tick: instrument.priceTick,
    quantity_step: instrument.quantityStep,
    min_quantity: instrument.minQuantity,
    max_leverage: instrument.maxLeverage,
    quote_volume_24h: instrument.quoteVolume24h,
    universe_rank: instrument.universeRank,
    last_seen_at: new Date().toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
