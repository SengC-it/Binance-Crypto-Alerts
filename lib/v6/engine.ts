import type { Candle, FundingRatePoint, MarketRegime, Side } from "@/lib/core/types";
import {
  applyAdditionalSlippage,
  blockBootstrapLowerConfidenceBound,
  calculateMetrics,
  createPurgedWalkForwardFolds,
  isTimestampInWindow,
  type ValidationMetrics,
  type ValidationTrade,
} from "@/lib/v5-2/validation";
import { calculateYieldMetrics } from "@/lib/v5-6-1/research";
import {
  V6_BAR_MS,
  V6_BASE_SLIPPAGE_BPS,
  V6_CONFIGURATIONS,
  V6_DEV_END,
  V6_DEV_START,
  V6_FEE_RATE,
  V6_PURGE_HOURS,
  V6_RISK_PER_TRADE_USDT,
  V6_RISK_TEMPLATES,
} from "@/lib/v6/registry";
import type {
  V6CandidateEvaluation,
  V6Configuration,
  V6CostStressSummary,
  V6Dataset,
  V6Family,
  V6FamilyResult,
  V6FoldResult,
  V6MetricSummary,
  V6PortfolioSummary,
  V6RiskTemplate,
  V6Run,
  V6Signal,
  V6Trade,
  V6ValidationResult,
  V6YieldSummary,
} from "@/lib/v6/types";

const ATR_PERIOD = 14;
const EMA_FAST_PERIOD = 20;
const EMA_TREND_PERIOD = 50;
const EMA_LONG_PERIOD = 100;

interface Derived4h {
  atr: Array<number | null>;
  emaFast: Array<number | null>;
  emaTrend: Array<number | null>;
  emaLong: Array<number | null>;
  regime: MarketRegime[];
}

interface CrossSectionRow {
  dataset: V6Dataset;
  index: number;
  timestamp: number;
  momentum7d: number;
  momentum30d: number;
  volatilityAdjustedMomentum: number;
  volatility: number;
  regime: MarketRegime;
  funding: number | null;
}

interface WindowEvaluation {
  run: V6Run;
  evaluation: V6CandidateEvaluation;
}

const derivedCache = new WeakMap<Candle[], Derived4h>();

export function buildV6Runs(
  datasets: V6Dataset[],
  startTime = V6_DEV_START,
  endTime = V6_DEV_END,
): V6Run[] {
  const runs: V6Run[] = [];
  for (const configuration of configurationsForData()) {
    const signals = buildV6Signals(datasets, configuration, startTime, endTime);
    for (const riskTemplate of V6_RISK_TEMPLATES) {
      for (const side of ["LONG", "SHORT"] as const) {
        const sideSignals = signals.filter((signal) => signal.side === side);
        const trades = runSignalSet(datasets, sideSignals, configuration, riskTemplate, endTime);
        runs.push({
          id: `${configuration.id}|${riskTemplate.id}|${side}`,
          family: configuration.family,
          config: configuration,
          riskTemplate,
          side,
          signals: sideSignals,
          trades,
        });
      }
    }
  }
  return runs;
}

export function configurationsForData(): readonly V6Configuration[] {
  // Kept as a separate function so tests can prove the frozen budget without
  // coupling the research runner to a mutable list.
  return V6_CONFIGURATIONS;
}

export function buildV6Signals(
  datasets: V6Dataset[],
  configuration: V6Configuration,
  startTime = V6_DEV_START,
  endTime = V6_DEV_END,
): V6Signal[] {
  if (configuration.family === "CROSS_SECTIONAL_MOMENTUM") {
    return buildCrossSectionalSignals(datasets, configuration, startTime, endTime);
  }
  return datasets.flatMap((dataset) => buildTimeSeriesSignals(dataset, configuration, startTime, endTime));
}

function buildTimeSeriesSignals(
  dataset: V6Dataset,
  configuration: V6Configuration,
  startTime: number,
  endTime: number,
): V6Signal[] {
  const candles = dataset.candles4h;
  const derived = derive4h(candles);
  const lookback = configuration.breakoutLookback ?? 40;
  const signals: V6Signal[] = [];
  for (let index = Math.max(EMA_LONG_PERIOD, lookback + 2); index < candles.length - 1; index += 1) {
    const current = candles[index];
    const next = candles[index + 1];
    if (!current || !next || current.closeTime < startTime || current.closeTime > endTime) continue;
    const atr = derived.atr[index];
    const emaTrend = derived.emaTrend[index];
    const emaLong = derived.emaLong[index];
    if (atr === null || emaTrend === null || emaLong === null || atr <= 0) continue;
    const priorHigh = rollingHigh(candles, index - 1, lookback);
    const priorLow = rollingLow(candles, index - 1, lookback);
    if (priorHigh === null || priorLow === null) continue;
    const longTrend = current.close > emaLong && emaTrend >= emaLong;
    const shortTrend = current.close < emaLong && emaTrend <= emaLong;
    const longBreak = current.close > priorHigh && current.close > current.open;
    const shortBreak = current.close < priorLow && current.close < current.open;
    const funding = latestFunding(dataset.fundingRates, current.closeTime);
    if (longBreak && longTrend && (configuration.family !== "TREND_CARRY" || carryAllows(configuration, "LONG", funding))) {
      const signal = buildSignal(dataset, configuration, "LONG", index, {
        breakoutDistanceAtr: (current.close - priorHigh) / atr,
        trendGapAtr: (current.close - emaLong) / atr,
        momentum7d: returnOverBars(candles, index, 42),
        momentum30d: returnOverBars(candles, index, 180),
        volatility: atr / Math.max(current.close, Number.EPSILON),
        funding: funding ?? 0,
      }, endTime);
      if (signal) signals.push(signal);
    }
    if (shortBreak && shortTrend && (configuration.family !== "TREND_CARRY" || carryAllows(configuration, "SHORT", funding))) {
      const signal = buildSignal(dataset, configuration, "SHORT", index, {
        breakoutDistanceAtr: (priorLow - current.close) / atr,
        trendGapAtr: (emaLong - current.close) / atr,
        momentum7d: returnOverBars(candles, index, 42),
        momentum30d: returnOverBars(candles, index, 180),
        volatility: atr / Math.max(current.close, Number.EPSILON),
        funding: funding ?? 0,
      }, endTime);
      if (signal) signals.push(signal);
    }
  }
  return signals;
}

function buildCrossSectionalSignals(
  datasets: V6Dataset[],
  configuration: V6Configuration,
  startTime: number,
  endTime: number,
): V6Signal[] {
  const rowsByTimestamp = new Map<number, CrossSectionRow[]>();
  for (const dataset of datasets) {
    const candles = dataset.candles4h;
    const derived = derive4h(candles);
    for (let index = 180; index < candles.length - 1; index += 1) {
      const current = candles[index];
      const sevenDay = candles[index - 42];
      const thirtyDay = candles[index - 180];
      const atr = derived.atr[index];
      if (!current || !sevenDay || !thirtyDay || current.close <= 0 || sevenDay.close <= 0 || thirtyDay.close <= 0 || atr === null || atr <= 0) continue;
      if (current.closeTime - sevenDay.closeTime !== 42 * V6_BAR_MS || current.closeTime - thirtyDay.closeTime !== 180 * V6_BAR_MS) continue;
      const momentum7d = current.close / sevenDay.close - 1;
      const momentum30d = current.close / thirtyDay.close - 1;
      const volatility = realizedVolatility(candles, index, 42);
      if (volatility === null || volatility <= 0) continue;
      const volatilityAdjustedMomentum = momentum7d / volatility;
      if (![momentum7d, momentum30d, volatilityAdjustedMomentum].every(Number.isFinite)) continue;
      const row: CrossSectionRow = {
        dataset,
        index,
        timestamp: current.closeTime,
        momentum7d,
        momentum30d,
        volatilityAdjustedMomentum,
        volatility,
        regime: derived.regime[index],
        funding: latestFunding(dataset.fundingRates, current.closeTime),
      };
      const rows = rowsByTimestamp.get(current.closeTime) ?? [];
      rows.push(row);
      rowsByTimestamp.set(current.closeTime, rows);
    }
  }
  const signals: V6Signal[] = [];
  for (const rows of rowsByTimestamp.values()) {
    if (rows.length < 5) continue;
    const timestamp = rows[0]?.timestamp ?? 0;
    if (timestamp < startTime || timestamp > endTime) continue;
    const rankBy = (selector: (row: CrossSectionRow) => number): Map<string, number> => new Map(
      [...rows]
        .sort((left, right) => selector(right) - selector(left) || left.dataset.symbol.localeCompare(right.dataset.symbol))
        .map((row, index) => [row.dataset.symbol, index + 1]),
    );
    const sevenDayRanks = rankBy((row) => row.momentum7d);
    const thirtyDayRanks = rankBy((row) => row.momentum30d);
    const volatilityAdjustedRanks = rankBy((row) => row.volatilityAdjustedMomentum);
    const compositeRank = (row: CrossSectionRow): number => (
      (sevenDayRanks.get(row.dataset.symbol) ?? rows.length + 1)
      + (thirtyDayRanks.get(row.dataset.symbol) ?? rows.length + 1)
      + (volatilityAdjustedRanks.get(row.dataset.symbol) ?? rows.length + 1)
    ) / 3;
    const ranked = [...rows].sort((left, right) => compositeRank(left) - compositeRank(right) || left.dataset.symbol.localeCompare(right.dataset.symbol));
    const count = Math.max(1, Math.ceil(rows.length * (configuration.rankFraction ?? 0.1)));
    const top = new Set(ranked.slice(0, count).map((row) => row.dataset.symbol));
    const bottom = new Set(ranked.slice(-count).map((row) => row.dataset.symbol));
    for (const row of rows) {
      const side: Side | null = top.has(row.dataset.symbol) ? "LONG" : bottom.has(row.dataset.symbol) ? "SHORT" : null;
      if (!side) continue;
      const signal = buildSignal(row.dataset, configuration, side, row.index, {
        breakoutDistanceAtr: 0,
        trendGapAtr: side === "LONG" ? row.momentum30d : -row.momentum30d,
        momentum7d: row.momentum7d,
        momentum30d: row.momentum30d,
        volatility: row.volatility,
        funding: row.funding ?? 0,
        crossSectionRank: ranked.findIndex((candidate) => candidate.dataset.symbol === row.dataset.symbol) + 1,
      }, endTime);
      if (signal) signals.push(signal);
    }
  }
  return signals.sort(compareSignals);
}

function buildSignal(
  dataset: V6Dataset,
  configuration: V6Configuration,
  side: Side,
  signalIndex: number,
  features: Record<string, number>,
  endTime: number,
): V6Signal | null {
  const candles = dataset.candles4h;
  const signalCandle = candles[signalIndex];
  const executionCandle = candles[signalIndex + 1];
  if (!signalCandle || !executionCandle || executionCandle.openTime !== signalCandle.closeTime + 1 || executionCandle.openTime > endTime || !Number.isFinite(executionCandle.open) || executionCandle.open <= 0) return null;
  return {
    signalId: [configuration.id, dataset.symbol, side, signalCandle.closeTime].join("|"),
    symbol: dataset.symbol,
    family: configuration.family,
    configId: configuration.id,
    side,
    signalIndex,
    signalTimestamp: signalCandle.closeTime,
    signalCandleCloseTime: signalCandle.closeTime,
    executionCandleOpenTime: executionCandle.openTime,
    executionReferencePrice: executionCandle.open,
    executionReferenceSource: "BINANCE_4H_NEXT_BAR_OPEN",
    marketRegime: derive4h(candles).regime[signalIndex] ?? "UNKNOWN",
    features,
  };
}

function runSignalSet(
  datasets: V6Dataset[],
  signals: V6Signal[],
  configuration: V6Configuration,
  riskTemplate: V6RiskTemplate,
  endTime: number,
): V6Trade[] {
  const bySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));
  const ordered = [...signals].sort(compareSignals);
  const lastExitBySymbol = new Map<string, number>();
  const trades: V6Trade[] = [];
  for (const signal of ordered) {
    const dataset = bySymbol.get(signal.symbol);
    if (!dataset) continue;
    const previousExit = lastExitBySymbol.get(signal.symbol) ?? Number.NEGATIVE_INFINITY;
    if (signal.executionCandleOpenTime <= previousExit) continue;
    const trade = simulateSignal(dataset, signal, configuration, riskTemplate, endTime);
    if (!trade) continue;
    trades.push(trade);
    lastExitBySymbol.set(signal.symbol, trade.exitTime ?? signal.executionCandleOpenTime);
  }
  return trades.sort((left, right) => left.entryTime - right.entryTime || left.signalId.localeCompare(right.signalId));
}

function simulateSignal(
  dataset: V6Dataset,
  signal: V6Signal,
  configuration: V6Configuration,
  riskTemplate: V6RiskTemplate,
  endTime: number,
): V6Trade | null {
  const candles = dataset.candles4h;
  const entryIndex = signal.signalIndex + 1;
  const entry = candles[entryIndex];
  const atr = derive4h(candles).atr[signal.signalIndex];
  if (!entry || atr === null || atr <= 0 || entry.openTime !== signal.signalCandleCloseTime + 1) return null;
  const direction = signal.side === "LONG" ? 1 : -1;
  const riskDistance = atr * riskTemplate.stopAtrMultiplier;
  const stopPrice = entry.open - direction * riskDistance;
  const targetPrice = entry.open + direction * riskDistance * riskTemplate.rewardRisk;
  const quantity = V6_RISK_PER_TRADE_USDT / riskDistance;
  if (!Number.isFinite(riskDistance) || riskDistance <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(stopPrice) || stopPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  let maxIndex = Math.min(candles.length - 1, entryIndex + riskTemplate.maxHoldBars);
  while (maxIndex >= entryIndex && (candles[maxIndex]?.closeTime ?? Number.POSITIVE_INFINITY) > endTime) maxIndex -= 1;
  if (maxIndex < entryIndex) return null;
  let activeStop = stopPrice;
  let exit = candles[maxIndex];
  let rawExitPrice = exit.close;
  let exitReason: V6Trade["exitReason"] = "DATA_END";
  for (let index = entryIndex; index <= maxIndex; index += 1) {
    const candle = candles[index];
    if (candle.closeTime > endTime) break;
    const stopHit = direction === 1 ? candle.low <= activeStop : candle.high >= activeStop;
    const targetHit = direction === 1 ? candle.high >= targetPrice : candle.low <= targetPrice;
    if (stopHit) {
      exit = candle;
      rawExitPrice = activeStop;
      exitReason = riskTemplate.trailingAtrMultiplier ? "TRAILING_STOP" : "STOP";
      break;
    }
    if (targetHit) {
      exit = candle;
      rawExitPrice = targetPrice;
      exitReason = "TAKE_PROFIT";
      break;
    }
    if (configuration.exitLookback && index >= entryIndex + 1) {
      const trendExit = direction === 1
        ? candle.close < (rollingLow(candles, index, configuration.exitLookback) ?? Number.NEGATIVE_INFINITY)
        : candle.close > (rollingHigh(candles, index, configuration.exitLookback) ?? Number.POSITIVE_INFINITY);
      if (trendExit) {
        exit = candle;
        rawExitPrice = candle.close;
        exitReason = "TIME_STOP";
        break;
      }
    }
    if (riskTemplate.trailingAtrMultiplier) {
      const currentAtr = derive4h(candles).atr[index] ?? atr;
      const candidateStop = direction === 1
        ? candle.close - currentAtr * riskTemplate.trailingAtrMultiplier
        : candle.close + currentAtr * riskTemplate.trailingAtrMultiplier;
      activeStop = direction === 1 ? Math.max(activeStop, candidateStop) : Math.min(activeStop, candidateStop);
    }
    if (index === maxIndex || candle.closeTime >= endTime) {
      exit = candle;
      rawExitPrice = candle.close;
      exitReason = "TIME_STOP";
    }
  }
  if (!exit || !Number.isFinite(rawExitPrice) || rawExitPrice <= 0 || exit.closeTime < entry.openTime) return null;
  const slippageRate = V6_BASE_SLIPPAGE_BPS / 10_000;
  const entryFill = entry.open * (1 + direction * slippageRate);
  const exitFill = rawExitPrice * (1 - direction * slippageRate);
  const grossPnlUsdt = (exitFill - entryFill) * direction * quantity;
  const feesUsdt = (Math.abs(entryFill * quantity) + Math.abs(exitFill * quantity)) * V6_FEE_RATE;
  const fundingUsdt = calculateFunding(dataset.fundingRates, entry.openTime, exit.closeTime, entryFill * quantity, direction);
  const netPnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  return {
    symbol: dataset.symbol,
    side: signal.side,
    entryTime: entry.openTime,
    exitTime: exit.closeTime,
    rMultiple: netPnlUsdt / V6_RISK_PER_TRADE_USDT,
    netPnlUsdt,
    pnlUsdt: netPnlUsdt,
    theoreticalRiskUsdt: V6_RISK_PER_TRADE_USDT,
    feesUsdt,
    fundingUsdt,
    slippageUsdt: Math.abs(entry.open - entryFill) * quantity + Math.abs(rawExitPrice - exitFill) * quantity,
    marketRegime: signal.marketRegime,
    signalId: signal.signalId,
    family: signal.family,
    configId: signal.configId,
    riskTemplateId: riskTemplate.id,
    signalTimestamp: signal.signalTimestamp,
    signalCandleCloseTime: signal.signalCandleCloseTime,
    executionCandleOpenTime: signal.executionCandleOpenTime,
    executionReferencePrice: signal.executionReferencePrice,
    executionReferenceSource: signal.executionReferenceSource,
    entryPrice: entryFill,
    exitPrice: exitFill,
    stopPrice,
    targetPrice,
    riskPrice: riskDistance,
    exitReason,
    cluster: dataset.symbol === "BTCUSDT" || dataset.symbol === "ETHUSDT" ? "BTC_ETH" : "BTC_BETA",
  };
}

export function summarizeV6Trades(trades: V6Trade[]): V6MetricSummary {
  const metrics = calculateMetrics(trades);
  const symbols = [...new Set(trades.map((trade) => trade.symbol))];
  const positiveSymbols = symbols.filter((symbol) => trades.filter((trade) => trade.symbol === symbol).reduce((sum, trade) => sum + trade.rMultiple, 0) > 0).length;
  return {
    metrics,
    cvar95: calculateCvar95(trades),
    symbolBreadth: symbols.length,
    positiveSymbolRatio: symbols.length > 0 ? positiveSymbols / symbols.length : null,
  };
}

export function buildCostStress(trades: V6Trade[]): V6CostStressSummary {
  const additional = (targetBps: number) => summarizeV6Trades(applyAdditionalSlippage(trades, Math.max(0, targetBps - V6_BASE_SLIPPAGE_BPS)) as V6Trade[]);
  return {
    base: summarizeV6Trades(trades),
    plus5Bps: additional(5),
    plus10Bps: additional(10),
    plus15Bps: additional(15),
  };
}

export function summarizeV6Yield(trades: ValidationTrade[], startTime: number, endTime: number): V6YieldSummary {
  const value = calculateYieldMetrics(trades, startTime, endTime);
  return {
    calendarDays: value.calendarDays,
    calendarMonths: value.calendarMonths,
    alertsPerWeek: value.alertsPerWeek,
    alertsPerMonth: value.alertsPerMonth,
    activeMonthRatio: value.activeMonthRatio,
    medianAlertsPerMonth: value.medianAlertsPerMonth,
    p95DroughtDays: value.p95SignalDroughtDays,
    maxDroughtDays: value.maxSignalDroughtDays,
  };
}

export function evaluateRun(run: V6Run, startTime = V6_DEV_START, endTime = V6_DEV_END): V6CandidateEvaluation {
  const trades = filterTrades(run.trades, startTime, endTime);
  const metrics = summarizeV6Trades(trades);
  const stress = buildCostStress(trades);
  return {
    runId: run.id,
    family: run.family,
    configId: run.config.id,
    riskTemplateId: run.riskTemplate.id,
    side: run.side,
    metrics,
    stress,
    yield: summarizeV6Yield(trades, startTime, endTime),
    pareto: false,
    selectionScore: selectionScore(metrics, stress, summarizeV6Yield(trades, startTime, endTime)),
  };
}

export function markParetoFrontier(evaluations: V6CandidateEvaluation[]): V6CandidateEvaluation[] {
  return evaluations.map((candidate, index) => ({
    ...candidate,
    pareto: !evaluations.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)),
  }));
}

export function selectParetoEvaluation(evaluations: V6CandidateEvaluation[]): V6CandidateEvaluation | null {
  const frontier = markParetoFrontier(evaluations).filter((candidate) => candidate.pareto && candidate.metrics.metrics.trades > 0);
  return [...frontier].sort((left, right) => right.selectionScore - left.selectionScore || right.metrics.metrics.avgNetR - left.metrics.metrics.avgNetR || left.runId.localeCompare(right.runId))[0] ?? null;
}

export function runNestedFamily(
  runs: V6Run[],
  family: V6Family,
  startTime = V6_DEV_START,
  endTime = V6_DEV_END,
): V6FamilyResult {
  const familyRuns = runs.filter((run) => run.family === family);
  const evaluations = markParetoFrontier(familyRuns.map((run) => evaluateRun(run, startTime, endTime)));
  const folds = createPurgedWalkForwardFolds({ start: startTime, end: endTime, initialTrainMonths: 18, validationMonths: 6, foldCount: 10, purgeHours: V6_PURGE_HOURS });
  const nestedTrades: V6Trade[] = [];
  const foldResults: V6FoldResult[] = [];
  for (const fold of folds) {
    const selected = selectRunForWindow(familyRuns, fold.trainStart, fold.trainEnd);
    const oosTrades = selected
      ? filterTrades(selected.run.trades, fold.validationStart, fold.validationEnd)
      : [];
    nestedTrades.push(...oosTrades);
    const metrics = summarizeV6Trades(oosTrades).metrics;
    foldResults.push({
      fold: fold.id,
      selectedRunId: selected?.run.id ?? null,
      trades: metrics.trades,
      netR: metrics.netR,
      avgR: metrics.avgNetR,
      profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null,
      positive: metrics.netR > 0,
    });
  }
  const nested = summarizeV6Trades(nestedTrades);
  const stress = buildCostStress(nestedTrades);
  const yieldSummary = summarizeV6Yield(nestedTrades, startTime, endTime);
  const selected = selectRunForWindow(familyRuns, startTime, endTime);
  const positiveFoldRatio = foldResults.length > 0 ? foldResults.filter((fold) => fold.positive).length / foldResults.length : null;
  const sortedFoldNetR = foldResults.map((fold) => fold.netR).sort((left, right) => left - right);
  const medianFoldNetR = sortedFoldNetR.length > 0 ? sortedFoldNetR[Math.floor((sortedFoldNetR.length - 1) / 2)] ?? null : null;
  const lcbValues = [nested.metrics.lowerConfidenceBound95, stress.plus10Bps.metrics.lowerConfidenceBound95, stress.plus15Bps.metrics.lowerConfidenceBound95, blockBootstrapLowerConfidenceBound(foldResults.map((fold) => fold.netR), 1_000, 2)].filter((value): value is number => value !== null && Number.isFinite(value));
  const promotionLCB = lcbValues.length > 0 ? Math.min(...lcbValues) : null;
  const gate = familyGate(nested, stress, positiveFoldRatio, medianFoldNetR, promotionLCB);
  return {
    family,
    configurations: evaluations,
    folds: foldResults,
    nestedTrades,
    nested,
    stress,
    yield: yieldSummary,
    positiveFoldRatio,
    medianFoldNetR,
    promotionLCB,
    selectedRun: selected?.run ?? null,
    validationA: emptyValidation("DATA_INSUFFICIENT"),
    validationB: emptyValidation("DATA_INSUFFICIENT"),
    passed: Object.values(gate).every(Boolean),
  };
}

export function familyGate(
  nested: V6MetricSummary,
  stress: V6CostStressSummary,
  positiveFoldRatio: number | null,
  medianFoldNetR: number | null,
  promotionLCB: number | null,
): Record<string, boolean> {
  return {
    nestedTrades: nested.metrics.trades >= 100,
    netR: nested.metrics.netR > 0,
    avgR: nested.metrics.avgNetR >= 0.1,
    profitFactor: nested.metrics.profitFactor >= 1.25,
    positiveFoldRatio: positiveFoldRatio !== null && positiveFoldRatio >= 0.67,
    medianFoldNetR: medianFoldNetR !== null && medianFoldNetR > 0,
    plus10BpsNetR: stress.plus10Bps.metrics.netR > 0,
    promotionLCB: promotionLCB !== null && promotionLCB >= 0,
    symbolBreadth: nested.symbolBreadth >= 15,
  };
}

export function evaluateValidation(
  run: V6Run | null,
  datasets: V6Dataset[],
  manifestStatus: string,
  startTime: number,
  endTime: number,
  validation: "A" | "B",
): V6ValidationResult {
  const symbols = new Set(datasets.map((dataset) => dataset.symbol));
  const trades = run ? filterTrades(run.trades, startTime, endTime).filter((trade) => symbols.has(trade.symbol)) : [];
  const metrics = summarizeV6Trades(trades);
  const stress = buildCostStress(trades);
  const yieldSummary = summarizeV6Yield(trades, startTime, endTime);
  const gate: Record<string, boolean> = validation === "A"
    ? {
      trades: metrics.metrics.trades >= 50,
      symbols: metrics.symbolBreadth >= 10,
      netR: metrics.metrics.netR > 0,
      avgR: metrics.metrics.avgNetR > 0,
      profitFactor: metrics.metrics.profitFactor >= 1.2,
      plus10BpsNetR: stress.plus10Bps.metrics.netR > 0,
    }
    : {
      trades: metrics.metrics.trades >= 30,
      netR: metrics.metrics.netR > 0,
      avgR: metrics.metrics.avgNetR > 0,
      profitFactor: metrics.metrics.profitFactor > 1.1,
    };
  const dataInsufficient = manifestStatus !== "AVAILABLE";
  return {
    status: dataInsufficient ? "DATA_INSUFFICIENT" : Object.values(gate).every(Boolean) ? "PASS" : metrics.metrics.trades > 0 ? "FAIL" : "INCONCLUSIVE",
    metrics,
    stress,
    yield: yieldSummary,
    gate,
    symbols: metrics.symbolBreadth,
    dataStatus: manifestStatus,
  };
}

export function emptyValidation(status: V6ValidationResult["status"] = "DATA_INSUFFICIENT"): V6ValidationResult {
  const metrics = summarizeV6Trades([]);
  const stress = buildCostStress([]);
  return { status, metrics, stress, yield: summarizeV6Yield([], V6_DEV_START, V6_DEV_END), gate: {}, symbols: 0, dataStatus: status };
}

export function buildPortfolioSummary(trades: V6Trade[], maxConcurrent = 6, maxPerSymbol = 1, maxPerCluster = 3): V6PortfolioSummary {
  const accepted: V6Trade[] = [];
  let rejectedForCapacity = 0;
  let rejectedForSymbolConcentration = 0;
  let rejectedForClusterConcentration = 0;
  const ordered = [...trades].sort((left, right) => left.entryTime - right.entryTime || left.signalId.localeCompare(right.signalId));
  for (const trade of ordered) {
    const active = accepted.filter((candidate) => (candidate.exitTime ?? candidate.entryTime) > trade.entryTime);
    if (active.length >= maxConcurrent) {
      rejectedForCapacity += 1;
      continue;
    }
    if (active.filter((candidate) => candidate.symbol === trade.symbol).length >= maxPerSymbol) {
      rejectedForSymbolConcentration += 1;
      continue;
    }
    if (active.filter((candidate) => candidate.cluster === trade.cluster).length >= maxPerCluster) {
      rejectedForClusterConcentration += 1;
      continue;
    }
    accepted.push(trade);
  }
  const maxConcurrentObserved = maxActive(accepted);
  const maxSymbolConcentration = maximumActiveConcentration(accepted, (trade) => trade.symbol);
  const maxClusterConcentration = maximumActiveConcentration(accepted, (trade) => trade.cluster);
  return {
    metrics: summarizeV6Trades(accepted),
    maxConcurrent: maxConcurrentObserved,
    maxSymbolConcentration,
    maxClusterConcentration,
    rejectedForCapacity,
    rejectedForSymbolConcentration,
    rejectedForClusterConcentration,
    concentrationProxy: "BTC_ETH are their own cluster; every other symbol is conservatively treated as BTC_BETA. This is a capacity/concentration proxy, not a measured return correlation.",
  };
}

export function yearMetrics(trades: V6Trade[], years: number[]): Record<string, V6MetricSummary> {
  return Object.fromEntries(years.map((year) => {
    const start = Date.parse(`${year}-01-01T00:00:00.000Z`);
    const end = Date.parse(`${year}-12-31T23:59:59.999Z`);
    return [String(year), summarizeV6Trades(filterTrades(trades, start, end))];
  }));
}

export function regimeMetrics(trades: V6Trade[]): Record<string, V6MetricSummary> {
  return Object.fromEntries(["BULL", "BEAR", "RANGE"].map((regime) => [regime, summarizeV6Trades(trades.filter((trade) => trade.marketRegime === regime))]));
}

function selectRunForWindow(runs: V6Run[], startTime: number, endTime: number): WindowEvaluation | null {
  if (runs.length === 0) return null;
  const innerFolds = createPurgedWalkForwardFolds({ start: startTime, end: endTime, initialTrainMonths: 6, validationMonths: 3, foldCount: 3, purgeHours: V6_PURGE_HOURS });
  const innerEvaluations = runs.map((run) => {
    const innerTrades = innerFolds.flatMap((fold) => filterTrades(run.trades, fold.validationStart, fold.validationEnd));
    const metrics = summarizeV6Trades(innerTrades);
    const stress = buildCostStress(innerTrades);
    const yieldSummary = summarizeV6Yield(innerTrades, startTime, endTime);
    return {
      runId: run.id,
      family: run.family,
      configId: run.config.id,
      riskTemplateId: run.riskTemplate.id,
      side: run.side,
      metrics,
      stress,
      yield: yieldSummary,
      pareto: false,
      selectionScore: selectionScore(metrics, stress, yieldSummary),
    } satisfies V6CandidateEvaluation;
  });
  const selectedEvaluation = selectParetoEvaluation(innerEvaluations);
  if (selectedEvaluation) {
    const run = runs.find((candidate) => candidate.id === selectedEvaluation.runId);
    if (run) return { run, evaluation: selectedEvaluation };
  }
  const fallback = selectParetoEvaluation(runs.map((run) => evaluateRun(run, startTime, endTime)));
  if (!fallback) return null;
  const run = runs.find((candidate) => candidate.id === fallback.runId);
  return run ? { run, evaluation: fallback } : null;
}

function filterTrades(trades: V6Trade[], startTime: number, endTime: number): V6Trade[] {
  return trades.filter((trade) => isTimestampInWindow(trade.entryTime, startTime, endTime));
}

function dominates(left: V6CandidateEvaluation, right: V6CandidateEvaluation): boolean {
  const leftValues = [left.metrics.metrics.netR, left.metrics.metrics.avgNetR, finitePF(left.metrics.metrics.profitFactor), -left.metrics.metrics.maxDrawdownR, left.metrics.metrics.positiveMonthRatio ?? 0, left.yield.alertsPerMonth, left.metrics.symbolBreadth];
  const rightValues = [right.metrics.metrics.netR, right.metrics.metrics.avgNetR, finitePF(right.metrics.metrics.profitFactor), -right.metrics.metrics.maxDrawdownR, right.metrics.metrics.positiveMonthRatio ?? 0, right.yield.alertsPerMonth, right.metrics.symbolBreadth];
  return leftValues.every((value, index) => value >= rightValues[index]) && leftValues.some((value, index) => value > rightValues[index]);
}

function selectionScore(metrics: V6MetricSummary, stress: V6CostStressSummary, yieldSummary: V6YieldSummary): number {
  const frequencyFit = Math.max(0, 5 - Math.abs(yieldSummary.alertsPerWeek - 2.5));
  return metrics.metrics.avgNetR * 100
    + Math.min(finitePF(stress.plus10Bps.metrics.profitFactor), 4) * 7
    - Math.min(metrics.metrics.maxDrawdownR, 100) * 0.08
    + (metrics.metrics.positiveMonthRatio ?? 0) * 8
    + Math.min(metrics.symbolBreadth, 30) * 0.15
    + frequencyFit;
}

function carryAllows(configuration: V6Configuration, side: Side, funding: number | null): boolean {
  if (funding === null || !Number.isFinite(funding)) return false;
  const absolute = Math.abs(funding);
  if (configuration.fundingRule === "AVOID_EXTREME_CROWDING") return side === "LONG" ? funding <= 0.0005 : funding >= -0.0005;
  if (configuration.fundingRule === "CARRY_PREFERENCE") return side === "LONG" ? funding <= 0 : funding >= 0;
  return absolute <= 0.001;
}

function compareSignals(left: V6Signal, right: V6Signal): number {
  return left.signalTimestamp - right.signalTimestamp || left.symbol.localeCompare(right.symbol) || left.side.localeCompare(right.side) || left.signalId.localeCompare(right.signalId);
}

function derive4h(candles: Candle[]): Derived4h {
  const cached = derivedCache.get(candles);
  if (cached) return cached;
  const atr: Array<number | null> = Array.from({ length: candles.length }, () => null);
  const emaFast: Array<number | null> = Array.from({ length: candles.length }, () => null);
  const emaTrend: Array<number | null> = Array.from({ length: candles.length }, () => null);
  const emaLong: Array<number | null> = Array.from({ length: candles.length }, () => null);
  let trSum = 0;
  let previousClose: number | null = null;
  const alphaFast = 2 / (EMA_FAST_PERIOD + 1);
  const alphaTrend = 2 / (EMA_TREND_PERIOD + 1);
  const alphaLong = 2 / (EMA_LONG_PERIOD + 1);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const trueRange = previousClose === null ? candle.high - candle.low : Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    trSum += trueRange;
    if (index >= ATR_PERIOD) {
      const old = candles[index - ATR_PERIOD];
      const oldPrevious = index - ATR_PERIOD - 1 >= 0 ? candles[index - ATR_PERIOD - 1]?.close : null;
      const oldTrueRange = oldPrevious === null || oldPrevious === undefined ? old.high - old.low : Math.max(old.high - old.low, Math.abs(old.high - oldPrevious), Math.abs(old.low - oldPrevious));
      trSum -= oldTrueRange;
    }
    // Sliding-window subtraction can leave a tiny positive residue after a
    // genuinely flat run. Treat only machine-rounding noise as zero so a
    // stale/no-volatility dataset cannot create an unbounded position size.
    const numericNoise = Number.EPSILON * 32 * Math.max(Math.abs(candle.high), Math.abs(candle.low), 1e-12);
    if (Math.abs(trSum) < numericNoise) trSum = 0;
    if (index >= ATR_PERIOD - 1) atr[index] = trSum / ATR_PERIOD;
    emaFast[index] = index === 0 ? candle.close : (emaFast[index - 1] ?? candle.close) * (1 - alphaFast) + candle.close * alphaFast;
    emaTrend[index] = index === 0 ? candle.close : (emaTrend[index - 1] ?? candle.close) * (1 - alphaTrend) + candle.close * alphaTrend;
    emaLong[index] = index === 0 ? candle.close : (emaLong[index - 1] ?? candle.close) * (1 - alphaLong) + candle.close * alphaLong;
    previousClose = candle.close;
  }
  const regime = candles.map((candle, index) => {
    const fast = emaFast[index];
    const trend = emaTrend[index];
    const long = emaLong[index];
    if (fast === null || trend === null || long === null) return "UNKNOWN" as const;
    if (fast > trend && trend > long && candle.close > long) return "BULL" as const;
    if (fast < trend && trend < long && candle.close < long) return "BEAR" as const;
    return "RANGE" as const;
  });
  const result = { atr, emaFast, emaTrend, emaLong, regime };
  derivedCache.set(candles, result);
  return result;
}

function rollingHigh(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.max(...window.map((candle) => candle.high));
}

function rollingLow(candles: Candle[], endExclusive: number, period: number): number | null {
  const window = candles.slice(Math.max(0, endExclusive - period), endExclusive);
  return window.length < period ? null : Math.min(...window.map((candle) => candle.low));
}

function returnOverBars(candles: Candle[], index: number, bars: number): number {
  const prior = candles[index - bars];
  const current = candles[index];
  return prior && current && prior.close > 0 ? current.close / prior.close - 1 : 0;
}

function realizedVolatility(candles: Candle[], index: number, bars: number): number | null {
  const returns: number[] = [];
  for (let cursor = Math.max(1, index - bars + 1); cursor <= index; cursor += 1) {
    const previous = candles[cursor - 1];
    const current = candles[cursor];
    if (!previous || !current || previous.close <= 0) continue;
    returns.push(current.close / previous.close - 1);
  }
  if (returns.length < Math.max(10, bars / 2)) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length) * Math.sqrt(42);
}

function latestFunding(points: FundingRatePoint[], timestamp: number): number | null {
  let low = 0;
  let high = points.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((points[middle]?.fundingTime ?? Number.POSITIVE_INFINITY) <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result >= 0 ? points[result]?.fundingRate ?? null : null;
}

function calculateFunding(points: FundingRatePoint[], entryTime: number, exitTime: number, notional: number, direction: number): number {
  return points.filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime).reduce((sum, point) => sum - direction * notional * point.fundingRate, 0);
}

function calculateCvar95(trades: ValidationTrade[]): number | null {
  const values = trades.map((trade) => trade.rMultiple).filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) return null;
  const count = Math.max(1, Math.ceil(values.length * 0.05));
  return values.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}

function finitePF(value: number): number {
  return Number.isFinite(value) ? value : 5;
}

function maxActive(trades: V6Trade[]): number {
  const events = trades.flatMap((trade) => [{ time: trade.entryTime, delta: 1 }, { time: trade.exitTime ?? trade.entryTime, delta: -1 }]).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function maximumActiveConcentration(trades: V6Trade[], keyOf: (trade: V6Trade) => string): number {
  const timestamps = [...new Set(trades.flatMap((trade) => [trade.entryTime, trade.exitTime ?? trade.entryTime]))].sort((left, right) => left - right);
  let maximum = 0;
  for (const timestamp of timestamps) {
    const active = trades.filter((trade) => trade.entryTime <= timestamp && (trade.exitTime ?? trade.entryTime) > timestamp);
    const counts = new Map<string, number>();
    for (const trade of active) counts.set(keyOf(trade), (counts.get(keyOf(trade)) ?? 0) + 1);
    maximum = Math.max(maximum, ...counts.values(), 0);
  }
  return maximum;
}
