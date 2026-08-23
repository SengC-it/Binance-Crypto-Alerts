import { NextRequest, NextResponse } from "next/server";
import { BinancePublicClient, mapWithConcurrency, selectDeepUniverse } from "@/lib/binance/public-client";
import { getServerConfig, type ServerConfig } from "@/lib/config";
import { estimatedExecutionCostRiskFraction, isEntryIntervalAllowed } from "@/lib/core/execution-policy";
import { buildGlobalMarketState, classifyRegime } from "@/lib/core/market-regime";
import { expectedDirectionalNetR } from "@/lib/core/opportunity-policy";
import {
  PRODUCTION_ENTRY_MODE,
  PRODUCTION_STRATEGY_VERSION,
  V5_ENTRY_MODE,
  V5_STRATEGY_VERSION,
} from "@/lib/core/production-policy";
import { admitSignal, type SignalAdmissionDecision } from "@/lib/core/signal-admission";
import { DEFAULT_V5_POLICY, type V5Policy } from "@/lib/core/policy-registry";
import { buildTradePlan } from "@/lib/core/risk";
import { rankCandidates } from "@/lib/core/scoring";
import { DEFAULT_STRATEGY_PARAMS, generateCandidates, type StrategyParams } from "@/lib/core/strategies";
import { fifteenMinuteGroupKey, signalKey, zonedDateString } from "@/lib/core/time";
import type { Instrument, MarketSnapshot, ScoredCandidate, Timeframe, TradePlan } from "@/lib/core/types";
import { closedCandleOnly, DEFAULT_UNIVERSE_POLICY, evaluateUniverseQuality } from "@/lib/core/universe-policy";
import { sendSignalEmail, sendSystemAlertEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  claimSignal,
  completeScanRun,
  createNotification,
  createScanRun,
  finishNotification,
  finishScanGroup,
  listStagedCandidates,
  listStagedShadowCandidates,
  loadApprovedPolicy,
  recordSystemEvent,
  stageScanCandidates,
  stageShadowCandidates,
  tryStartScanGroupFinalization,
  upsertInstruments,
} from "@/lib/services/signal-repository";
import { createPaperTrade, createShadowPaperTrade } from "@/lib/services/paper-trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  let scanGroupKey: string | undefined;

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

    scanGroupKey = fifteenMinuteGroupKey(Date.now());
    const runKey = `${scanGroupKey}:batch:${batchNumber}`;
    const batch = deepUniverse.slice(
      batchNumber * runtimeConfig.CS_SCAN_BATCH_SIZE,
      (batchNumber + 1) * runtimeConfig.CS_SCAN_BATCH_SIZE,
    );
    const strategyParams: StrategyParams = {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: PRODUCTION_ENTRY_MODE,
      stopAtrMultiplier: runtimeConfig.CS_STRATEGY_STOP_ATR_MULTIPLIER,
    };
    const v5StrategyParams: StrategyParams = {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: V5_ENTRY_MODE,
      stopAtrMultiplier: runtimeConfig.CS_STRATEGY_STOP_ATR_MULTIPLIER,
    };
    supabase = getSupabaseAdmin();
    const errors: Array<{ symbol?: string; stage: string; message: string }> = [];
    let approvedPolicy: V5Policy | undefined;
    try {
      approvedPolicy = await loadApprovedPolicy(supabase, runtimeConfig.CS_V5_POLICY_VERSION);
    } catch (error) {
      errors.push({ stage: "policy_lookup", message: errorMessage(error) });
    }
    if (approvedPolicy) {
      Object.assign(v5StrategyParams, approvedPolicy.strategyParams, {
        entryMode: V5_ENTRY_MODE,
        noChasePolicy: approvedPolicy.noChasePolicy,
      });
    }
    await upsertInstruments(supabase, universe.map(toInstrumentRow));
    scanRunId = await createScanRun(supabase, {
      runKey,
      scanGroupKey: scanGroupKey as string,
      timeframe: "15m",
      batchNumber,
      batchCount,
      universeSize: universe.length,
    });

    const snapshots = await mapWithConcurrency(batch, runtimeConfig.CS_REQUEST_CONCURRENCY, async (instrument) => {
      try {
        const timeframes = normalizedTimeframes(runtimeConfig.scanTimeframes);
        return await client.getSnapshot(instrument, timeframes, 250) as MarketSnapshot;
      } catch (error) {
        errors.push({ symbol: instrument.symbol, stage: "market_data", message: errorMessage(error) });
        return null;
      }
    });

    const validSnapshots = snapshots
      .filter((snapshot): snapshot is MarketSnapshot => snapshot !== null)
      .map((snapshot) => ({ ...snapshot, globalMarketState: undefined }));
    let globalMarketState: MarketSnapshot["globalMarketState"];
    try {
      globalMarketState = await loadGlobalMarketState(client, universe, validSnapshots, normalizedTimeframes(runtimeConfig.scanTimeframes));
    } catch (error) {
      errors.push({ stage: "global_market_state", message: errorMessage(error) });
    }
    const statefulSnapshots = validSnapshots.map((snapshot) => ({ ...snapshot, globalMarketState }));
    const v5UniversePolicy = { ...DEFAULT_UNIVERSE_POLICY, minimumHistoryDays: 0 };
    const v5UniverseSnapshots = statefulSnapshots.filter((snapshot) => evaluateUniverseQuality(
      snapshot.instrument,
      closedCandleOnly(snapshot.candles["15m"] ?? [], snapshot.sourceTimestamp),
      Date.now(),
      v5UniversePolicy,
    ).eligible);
    const controlOpportunities = statefulSnapshots
      .flatMap((snapshot) => {
        try {
          const opportunity = buildOpportunity(snapshot, strategyParams, runtimeConfig);
          return opportunity ? [opportunity] : [];
        } catch (error) {
          errors.push({ symbol: snapshot.instrument.symbol, stage: "risk_plan", message: errorMessage(error) });
          return [];
        }
      })
      .sort((left, right) => right.candidate.score - left.candidate.score);
    const v5Opportunities = runtimeConfig.CS_SHADOW_TRADING_ENABLED
      ? v5UniverseSnapshots.flatMap((snapshot) => {
        try {
          const opportunity = buildOpportunity(snapshot, v5StrategyParams, runtimeConfig, approvedPolicy ?? DEFAULT_V5_POLICY);
          return opportunity ? [opportunity] : [];
        } catch (error) {
          errors.push({ symbol: snapshot.instrument.symbol, stage: "v5_shadow_risk_plan", message: errorMessage(error) });
          return [];
        }
      }).sort((left, right) => right.candidate.score - left.candidate.score)
      : [];
    const candidates = controlOpportunities;
    const shadowCandidates = v5Opportunities;
    const signalStats = summarizeSignalStats(universe.length, v5UniverseSnapshots.length, candidates, shadowCandidates, statefulSnapshots.length - v5UniverseSnapshots.length);

    await stageScanCandidates(supabase, candidates.map((opportunity) => ({
      scanRunId: scanRunId as string,
      scanGroupKey: scanGroupKey as string,
      symbol: opportunity.snapshot.instrument.symbol,
      sourceTimestamp: opportunity.snapshot.sourceTimestamp,
      candidate: opportunity.candidate,
      plan: opportunity.plan,
      admission: opportunity.admission,
    })));
    await stageShadowCandidates(supabase, shadowCandidates.map((opportunity) => ({
      scanRunId: scanRunId as string,
      scanGroupKey: scanGroupKey as string,
      symbol: opportunity.snapshot.instrument.symbol,
      sourceTimestamp: opportunity.snapshot.sourceTimestamp,
      candidate: opportunity.candidate,
      plan: opportunity.plan,
      admission: opportunity.admission,
    })));
    await completeScanRun(supabase, scanRunId, {
      scannedSymbols: batch.length,
      candidateCount: candidates.length,
      emailedCount: 0,
      status: errors.length === 0 ? "COMPLETED" : "PARTIAL",
      errorSummary: errors,
      signalStats,
    });
    const finalizing = await tryStartScanGroupFinalization(supabase, scanGroupKey);
    const finalCandidates = finalizing ? await listStagedCandidates(supabase, scanGroupKey) : [];
    const finalShadowCandidates = finalizing && runtimeConfig.CS_SHADOW_TRADING_ENABLED
      ? await listStagedShadowCandidates(supabase, scanGroupKey)
      : [];

    let emailedCount = 0;
    let claimedCount = 0;
    for (const opportunity of finalCandidates) {
      const occurrenceDate = zonedDateString(opportunity.sourceTimestamp, runtimeConfig.CS_DEFAULT_TIMEZONE);
      const key = signalKey({
        symbol: opportunity.symbol,
        side: opportunity.candidate.side,
        timeframe: opportunity.candidate.primaryTimeframe,
        strategyVersion: PRODUCTION_STRATEGY_VERSION,
        sourceTimestamp: opportunity.sourceTimestamp,
      });
      const hasEmailConfig = Boolean(runtimeConfig.GMAIL_SMTP_USER && runtimeConfig.GMAIL_SMTP_APP_PASSWORD && runtimeConfig.GMAIL_RECIPIENT);
      const claim = await claimSignal(
        supabase,
        {
          scanRunId: opportunity.scanRunId,
          scanGroupKey,
          signalKey: key,
          symbol: opportunity.symbol,
          candidate: opportunity.candidate,
          plan: opportunity.plan,
          strategyVersion: PRODUCTION_STRATEGY_VERSION,
          sourceTimestamp: opportunity.sourceTimestamp,
          occurrenceDate,
        },
        {
          dailyDate: occurrenceDate,
          dailyLimitUsdt: runtimeConfig.CS_DAILY_RISK_BUDGET_USDT,
          singleRiskCapUsdt: runtimeConfig.CS_PER_SIGNAL_RISK_CAP_USDT,
          dailyEmailCap: runtimeConfig.CS_NEW_EMAIL_DAILY_CAP,
          scanEmailCap: runtimeConfig.CS_MAX_EMAILS_PER_SCAN,
          shouldEmail: hasEmailConfig,
          maxConcurrentPositions: runtimeConfig.CS_MAX_CONCURRENT_POSITIONS,
          cooldownHours: runtimeConfig.CS_COOLDOWN_HOURS,
          takerFeeRate: runtimeConfig.CS_PAPER_TAKER_FEE_RATE,
          slippageBps: runtimeConfig.CS_PAPER_SLIPPAGE_BPS,
        },
      );
      if (claim.status === "CREATED" || claim.status === "REPLACED") claimedCount += 1;
      if (
        runtimeConfig.CS_PAPER_TRADING_ENABLED
        && (claim.status === "CREATED" || claim.status === "REPLACED" || claim.status === "IDEMPOTENT")
      ) {
        try {
          if (!claim.signal_id) throw new Error("Signal claim did not return an id");
          await createPaperTrade(supabase, {
            signalId: claim.signal_id,
            symbol: opportunity.symbol,
            candidate: opportunity.candidate,
            plan: opportunity.plan,
            strategyVersion: PRODUCTION_STRATEGY_VERSION,
            sourceTimestamp: opportunity.sourceTimestamp,
            slippageBps: runtimeConfig.CS_PAPER_SLIPPAGE_BPS,
          });
        } catch (error) {
          errors.push({
            symbol: opportunity.symbol,
            stage: "paper_trade",
            message: errorMessage(error),
          });
        }
      }
      if (!claim.email_allowed || !runtimeConfig.GMAIL_RECIPIENT || !claim.signal_id) continue;

      const idempotencyKey = `${claim.signal_id}:GMAIL_SMTP`;
      const subject = `[风险警告] ${opportunity.symbol} ${opportunity.candidate.side} · ${opportunity.candidate.score.toFixed(1)} 分`;
      const created = await createNotification(supabase, {
        signalId: claim.signal_id,
        idempotencyKey,
        recipient: runtimeConfig.GMAIL_RECIPIENT,
        subject,
      });
      if (!created) continue;

      try {
        const sent = await sendSignalEmail({
          symbol: opportunity.symbol,
          candidate: opportunity.candidate,
          plan: opportunity.plan,
          strategyVersion: PRODUCTION_STRATEGY_VERSION,
          sourceTimestamp: opportunity.sourceTimestamp,
        });
        await finishNotification(supabase, idempotencyKey, {
          status: sent.skipped ? "SKIPPED" : "SENT",
          providerMessageId: sent.messageId,
        });
        if (!sent.skipped) emailedCount += 1;
      } catch (error) {
        errors.push({ symbol: opportunity.symbol, stage: "email", message: errorMessage(error) });
        await finishNotification(supabase, idempotencyKey, { status: "FAILED", error: errorMessage(error) });
      }
    }

    let shadowPaperTradeCreated = false;
    const shadowOpportunity = finalShadowCandidates[0];
    if (shadowOpportunity) {
      try {
        shadowPaperTradeCreated = await createShadowPaperTrade(supabase, {
          symbol: shadowOpportunity.symbol,
          candidate: shadowOpportunity.candidate,
          plan: shadowOpportunity.plan,
          strategyVersion: V5_STRATEGY_VERSION,
          sourceTimestamp: shadowOpportunity.sourceTimestamp,
          slippageBps: runtimeConfig.CS_PAPER_SLIPPAGE_BPS,
          admission: shadowOpportunity.admission,
          executionDelayMinutes: runtimeConfig.CS_PAPER_EXECUTION_DELAY_MINUTES,
        }, runtimeConfig.CS_COOLDOWN_HOURS);
      } catch (error) {
        errors.push({
          symbol: shadowOpportunity.symbol,
          stage: "shadow_paper_trade",
          message: errorMessage(error),
        });
      }
    }

    await completeScanRun(supabase, scanRunId, {
      scannedSymbols: batch.length,
      candidateCount: candidates.length,
      emailedCount,
      status: errors.length === 0 ? "COMPLETED" : "PARTIAL",
      errorSummary: errors,
      signalStats,
    });
    if (finalizing) await finishScanGroup(supabase, scanGroupKey, "COMPLETED", errors);

    return NextResponse.json({
      ok: true,
      scanGroupKey,
      batchNumber,
      batchCount,
      universeSize: universe.length,
      deepUniverseSize: deepUniverse.length,
      scannedSymbols: batch.length,
      candidateCount: candidates.length,
      v5CandidateCount: shadowCandidates.length,
      finalCandidateCount: finalCandidates.length,
      shadowCandidateCount: shadowCandidates.length,
      finalShadowCandidateCount: finalShadowCandidates.length,
      shadowPaperTradeCreated,
      finalized: finalizing,
      claimedCount,
      emailedCount,
      errors,
      dryRun: runtimeConfig.CS_DRY_RUN,
      strategy: {
        version: PRODUCTION_STRATEGY_VERSION,
        entryMode: PRODUCTION_ENTRY_MODE,
        sideFilter: runtimeConfig.CS_SIGNAL_SIDE_FILTER,
        control: true,
        v5Shadow: {
          version: V5_STRATEGY_VERSION,
          entryMode: V5_ENTRY_MODE,
          policyVersion: approvedPolicy?.policyVersion ?? V5_STRATEGY_VERSION,
          directionApproval: approvedPolicy?.directionApproval ?? DEFAULT_V5_POLICY.directionApproval,
        },
      },
      signalStats,
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
      if (scanGroupKey) {
        try {
          await finishScanGroup(supabase, scanGroupKey, "FAILED", [{ message }]);
        } catch {
          // Preserve the original scan error when group state cannot be updated.
        }
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

function buildOpportunity(
  snapshot: MarketSnapshot,
  strategyParams: StrategyParams,
  config: ServerConfig,
  policy?: V5Policy,
): SignalOpportunity | undefined {
  const isV5 = strategyParams.entryMode === V5_ENTRY_MODE;
  if (isV5 && Date.now() - snapshot.sourceTimestamp > config.CS_STALE_CANDLE_MINUTES * 60_000) return undefined;
  const candidate = rankCandidates(generateCandidates(snapshot, strategyParams), {
    minimumScore: isV5 ? undefined : config.CS_MIN_SIGNAL_SCORE,
    sideFilter: isV5 || config.CS_SIGNAL_SIDE_FILTER === "BOTH" ? undefined : config.CS_SIGNAL_SIDE_FILTER,
    strategyFamily: config.CS_SIGNAL_STRATEGY_FAMILY === "ALL" ? undefined : config.CS_SIGNAL_STRATEGY_FAMILY,
  }).find((item) => isRegimeAllowed(item, config.CS_REQUIRE_REGIME_ALIGNMENT));
  if (!candidate || !isEntryIntervalAllowed(snapshot.sourceTimestamp, config.CS_ENTRY_INTERVAL_HOURS)) return undefined;
  const plan = buildTradePlan(candidate, snapshot.instrument, {
    marginUsdt: config.CS_MARGIN_USDT,
    leverage: config.CS_ASSUMED_LEVERAGE,
    singleSignalRiskCapUsdt: config.CS_PER_SIGNAL_RISK_CAP_USDT,
    dailyRiskBudgetUsdt: config.CS_DAILY_RISK_BUDGET_USDT,
    maxHoldHours: config.CS_MAX_HOLD_HOURS,
    rewardRisk: config.CS_REWARD_RISK,
    riskPerTradeUsdt: config.CS_RISK_PER_TRADE_USDT,
    maxPositionNotionalUsdt: config.CS_MAX_POSITION_NOTIONAL_USDT,
  }, snapshot.sourceTimestamp);
  if (plan.riskOverSingleCap) return undefined;
  const executionCostRisk = estimatedExecutionCostRiskFraction(
    plan,
    config.CS_PAPER_TAKER_FEE_RATE,
    config.CS_PAPER_SLIPPAGE_BPS,
  );
  if (executionCostRisk > config.CS_MAX_EXECUTION_COST_RISK_FRACTION) return undefined;
  const admission = isV5
    ? admitSignal(candidate, policy, {
      policyFeatures: candidate.marketState
        ? { marketState: candidate.marketState, projectedFundingCostRiskFraction: 0, executionCostRiskFraction: executionCostRisk }
        : undefined,
      expectedNetR: policy?.expectedEdgeModel && candidate.marketState
        ? expectedDirectionalNetR(policy.expectedEdgeModel, candidate.side, candidate.score, {
          marketState: candidate.marketState,
          projectedFundingCostRiskFraction: 0,
          executionCostRiskFraction: executionCostRisk,
        })
        : undefined,
      stressCostAdjustmentR: Math.max(0, estimatedExecutionCostRiskFraction(
        plan,
        config.CS_PAPER_TAKER_FEE_RATE,
        config.CS_PAPER_SLIPPAGE_BPS + 10,
      ) - executionCostRisk),
    })
    : undefined;
  return { snapshot, candidate, plan, admission };
}

interface SignalOpportunity {
  snapshot: MarketSnapshot;
  candidate: ScoredCandidate;
  plan: TradePlan;
  admission?: SignalAdmissionDecision;
}

function summarizeSignalStats(
  totalUniverse: number,
  eligibleUniverse: number,
  controlCandidates: SignalOpportunity[],
  v5Candidates: SignalOpportunity[],
  universeRejected: number,
): Record<string, number> {
  const v5ProductionCandidates = v5Candidates.filter((item) => item.admission?.productionEligible);
  const stats: Record<string, number> = {
    totalUniverse,
    eligibleUniverse,
    universeRejected,
    candidates: controlCandidates.length,
    controlCandidates: controlCandidates.length,
    v5Candidates: v5Candidates.length,
    longCandidates: controlCandidates.filter((item) => item.candidate.side === "LONG").length,
    shortCandidates: controlCandidates.filter((item) => item.candidate.side === "SHORT").length,
    v5LongCandidates: v5Candidates.filter((item) => item.candidate.side === "LONG").length,
    v5ShortCandidates: v5Candidates.filter((item) => item.candidate.side === "SHORT").length,
    A: v5ProductionCandidates.length,
    B: v5Candidates.filter((item) => item.admission?.tier === "B").length,
    C: v5Candidates.filter((item) => item.admission?.tier === "C").length,
    noSignal: controlCandidates.length === 0 && v5Candidates.length === 0 ? 1 : 0,
    rejectedByRegime: 0,
    rejectedByChase: 0,
    rejectedByTrigger: 0,
    rejectedByEV: 0,
    rejectedBySample: 0,
    rejectedByCost: 0,
    rejectedByDirectionApproval: 0,
  };
  for (const opportunity of v5Candidates) {
    for (const reason of opportunity.admission?.reasons ?? []) {
      const key = reason === "WRONG_REGIME" || reason === "UNKNOWN_MARKET_STATE"
        ? "rejectedByRegime"
        : reason === "CHASE" ? "rejectedByChase"
          : reason === "NO_TRIGGER" ? "rejectedByTrigger"
            : reason === "NEGATIVE_EV" ? "rejectedByEV"
              : reason === "INSUFFICIENT_SAMPLE" ? "rejectedBySample"
                : reason === "COST_STRESS_FAIL" ? "rejectedByCost"
                  : reason === "DIRECTION_NOT_APPROVED" ? "rejectedByDirectionApproval" : undefined;
      if (key) stats[key] += 1;
    }
  }
  return stats;
}

async function loadGlobalMarketState(
  client: BinancePublicClient,
  universe: Instrument[],
  snapshots: MarketSnapshot[],
  timeframes: Timeframe[],
): Promise<MarketSnapshot["globalMarketState"]> {
  const btcInstrument = universe.find((instrument) => instrument.symbol === "BTCUSDT");
  if (!btcInstrument) return undefined;
  const ethInstrument = universe.find((instrument) => instrument.symbol === "ETHUSDT");
  const [btc, eth] = await Promise.all([
    client.getSnapshot(btcInstrument, timeframes, 250),
    ethInstrument ? client.getSnapshot(ethInstrument, timeframes, 250) : Promise.resolve(undefined),
  ]);
  const trendSymbols = snapshots
    .map((snapshot) => classifyRegime(snapshot.candles["4h"] ?? snapshot.candles["1h"] ?? []))
    .filter((regime) => regime === "BULL" || regime === "BEAR");
  const breadth = trendSymbols.length === 0
    ? null
    : trendSymbols.filter((regime) => regime === "BULL").length / trendSymbols.length;
  return buildGlobalMarketState({ btc, eth, breadth });
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

function isRegimeAllowed(candidate: Parameters<typeof rankCandidates>[0][number], required: boolean): boolean {
  if (!required) return true;
  if (candidate.strategyFamily === "MEAN_REVERSION") {
    return candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN";
  }
  return candidate.side === "LONG"
    ? candidate.marketRegime === "BULL"
    : candidate.marketRegime === "BEAR";
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
    onboard_date: instrument.onboardDate,
    last_seen_at: new Date().toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
