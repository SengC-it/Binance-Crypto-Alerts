import type { Candle, FundingRatePoint, Side } from "@/lib/core/types";
import {
  V7_CONFIGURATIONS,
  V7_COST_MODEL,
  V7_EMBARGO_HOURS,
  V7_EXECUTION_INTERVAL_MS,
  V7_FAMILIES,
  V7_PURGE_HOURS,
  V7_RISK_TEMPLATES,
  V7_SIGNAL_INTERVAL_MS,
} from "@/lib/v7/registry";
import type {
  DerivativesMetricsPoint,
  V7Configuration,
  V7Dataset,
  V7Family,
  V7FeatureSnapshot,
  V7FoldResult,
  V7MetricSummary,
  V7NestedResult,
  V7RunResult,
  V7Signal,
  V7StressSummary,
  V7Trade,
  V7ValidationResult,
  V7YieldMetrics,
} from "@/lib/v7/types";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EPSILON = 1e-12;

interface DatasetIndex {
  candle1hByOpen: Map<number, Candle>;
  candle1hIndexByOpen: Map<number, number>;
  candles4h: Candle[];
  candle15mByOpen: Map<number, Candle>;
  candle15mIndexByOpen: Map<number, number>;
  derivativeByHour: Map<number, DerivativesMetricsPoint>;
  funding: FundingRatePoint[];
}

const indexCache = new WeakMap<V7Dataset, DatasetIndex>();
const featureCache = new WeakMap<V7Dataset, Map<number, V7FeatureSnapshot | null>>();

export function buildV7Runs(datasets: readonly V7Dataset[], start: number, end: number): V7RunResult[] {
  const runs: V7RunResult[] = [];
  for (const family of V7_FAMILIES) {
    const configurations = getFamilyConfigurations(family);
    for (const configuration of configurations) {
      for (const risk of V7_RISK_TEMPLATES) {
        const trades: V7Trade[] = [];
        for (const dataset of datasets) {
          const signals = buildSignals(dataset, configuration, start, end);
          trades.push(...simulateSignals(dataset, signals, risk));
        }
        const sortedTrades = trades.sort((left, right) => left.executionTimestamp - right.executionTimestamp || left.symbol.localeCompare(right.symbol));
        const metrics = summarizeV7Trades(sortedTrades);
        const stress = stressSummary(sortedTrades);
        const yieldMetrics = summarizeV7Yield(sortedTrades, start, end);
        runs.push({
          runId: `${configuration.id}|${risk.id}`,
          family,
          configId: configuration.id,
          riskTemplateId: risk.id,
          side: configuration.side,
          trades: sortedTrades,
          metrics,
          stress,
          yield: yieldMetrics,
          pareto: false,
          selectionScore: selectionScore(metrics, yieldMetrics),
        });
      }
    }
  }
  return markPareto(runs);
}

export function buildSignals(dataset: V7Dataset, configuration: V7Configuration, start: number, end: number): V7Signal[] {
  const index = getIndex(dataset);
  const signals: V7Signal[] = [];
  for (let candleIndex = 0; candleIndex < dataset.candles1h.length; candleIndex += 1) {
    const candle = dataset.candles1h[candleIndex];
    if (candle.openTime < start || candle.openTime > end || candle.closeTime > end) continue;
    const nextOpenTime = candle.closeTime + 1;
    if (nextOpenTime > end) continue;
    const nextEntryCandle = index.candle15mByOpen.get(nextOpenTime);
    if (!nextEntryCandle || nextEntryCandle.openTime !== nextOpenTime || !Number.isFinite(nextEntryCandle.open)) continue;
    const featureSnapshot = buildFeatureSnapshot(dataset, candleIndex, candle);
    if (!featureSnapshot || !matchesConfiguration(dataset, candleIndex, featureSnapshot, configuration)) continue;
    signals.push({
      family: configuration.family,
      configurationId: configuration.id,
      symbol: dataset.symbol,
      side: configuration.side,
      signalTimestamp: candle.closeTime,
      signalCandleCloseTime: candle.closeTime,
      executionTimestamp: nextOpenTime,
      executionReferencePrice: nextEntryCandle.open,
      executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
      featureSnapshot,
      hypothesis: configuration.hypothesis,
      invalidation: configuration.invalidation,
    });
  }
  return signals;
}

export function buildFeatureSnapshot(dataset: V7Dataset, candleIndex: number, candle: Candle): V7FeatureSnapshot | null {
  const cached = featureCache.get(dataset);
  if (cached?.has(candle.openTime)) return cached.get(candle.openTime) ?? null;
  const index = getIndex(dataset);
  const currentHour = candle.openTime;
  const derivatives = latestDerivativeAt(index.derivativeByHour, candle.closeTime);
  if (!derivatives || derivatives.sourceTimestamp > candle.closeTime || candle.closeTime - derivatives.sourceTimestamp > HOUR_MS) return cacheFeature(dataset, candle.openTime, null);
  const previousHour = index.derivativeByHour.get(currentHour - HOUR_MS);
  const previous4h = index.derivativeByHour.get(currentHour - 4 * HOUR_MS);
  const previousOiChangePoint = index.derivativeByHour.get(currentHour - 2 * HOUR_MS);
  if (!previousHour || !previous4h || !previousOiChangePoint) return cacheFeature(dataset, candle.openTime, null);
  const candles = dataset.candles1h;
  if (candleIndex < 24 || !candles[candleIndex - 1]) return cacheFeature(dataset, candle.openTime, null);
  const priceReturn1h = candles[candleIndex - 1].close > 0 ? candle.close / candles[candleIndex - 1].close - 1 : Number.NaN;
  const contextIndex = lastClosedCandleIndex(index.candles4h, candle.closeTime);
  const contextCandle = contextIndex >= 1 ? index.candles4h[contextIndex] : undefined;
  const previousContextCandle = contextIndex >= 1 ? index.candles4h[contextIndex - 1] : undefined;
  const priceReturn4h = contextCandle && previousContextCandle && previousContextCandle.close > 0
    ? contextCandle.close / previousContextCandle.close - 1
    : Number.NaN;
  const returns = candles.slice(candleIndex - 23, candleIndex + 1).map((item, offset) => {
    const previous = candles[candleIndex - 24 + offset];
    return previous?.close > 0 && item.close > 0 ? Math.log(item.close / previous.close) : Number.NaN;
  }).filter(Number.isFinite);
  const realizedVolatility = standardDeviation(returns);
  const atr = averageTrueRange(candles.slice(candleIndex - 13, candleIndex + 1));
  if (![priceReturn1h, priceReturn4h, realizedVolatility, atr].every(Number.isFinite) || atr <= EPSILON) return cacheFeature(dataset, candle.openTime, null);
  const oiChange1h = relativeChange(derivatives.openInterest, previousHour.openInterest);
  const oiChange4h = relativeChange(derivatives.openInterest, previous4h.openInterest);
  const previousOiChange1h = relativeChange(previousHour.openInterest, previousOiChangePoint.openInterest);
  if (![oiChange1h, oiChange4h, previousOiChange1h].every(Number.isFinite)) return cacheFeature(dataset, candle.openTime, null);
  const oiAcceleration = oiChange1h - previousOiChange1h;
  const oiHistory: number[] = [];
  for (let timestamp = currentHour - 168 * HOUR_MS; timestamp <= currentHour; timestamp += HOUR_MS) {
    const point = index.derivativeByHour.get(timestamp);
    if (point && Number.isFinite(point.openInterest)) oiHistory.push(point.openInterest);
  }
  const oiLevelPercentile = percentileRank(oiHistory, derivatives.openInterest);
  const takerBuyRatio = derivatives.takerLongShortVolumeRatio / (1 + derivatives.takerLongShortVolumeRatio);
  const previousTaker = index.derivativeByHour.get(currentHour - HOUR_MS);
  const previousTakerBuyRatio = previousTaker ? previousTaker.takerLongShortVolumeRatio / (1 + previousTaker.takerLongShortVolumeRatio) : Number.NaN;
  const takerImbalanceChange = takerBuyRatio - previousTakerBuyRatio;
  const fundingPoint = latestFundingAt(index.funding, candle.closeTime);
  const funding = fundingPoint?.fundingRate ?? 0;
  const fundingHistory = index.funding.filter((point) => point.fundingTime <= candle.closeTime && point.fundingTime >= candle.closeTime - 30 * DAY_MS).map((point) => point.fundingRate);
  const fundingPercentile = fundingHistory.length >= 5 ? percentileRank(fundingHistory, funding) : 0.5;
  const longShortRatio = derivatives.globalLongShortAccountRatio;
  const previousLongShortRatio = previousHour.globalLongShortAccountRatio;
  const longShortRatioChange = relativeChange(longShortRatio, previousLongShortRatio);
  if (![oiLevelPercentile, takerBuyRatio, takerImbalanceChange, funding, fundingPercentile, longShortRatio, longShortRatioChange].every(Number.isFinite)) return cacheFeature(dataset, candle.openTime, null);
  return cacheFeature(dataset, candle.openTime, {
    timestamp: candle.closeTime,
    priceReturn1h,
    priceReturn4h,
    realizedVolatility,
    atr,
    oiLevelPercentile,
    oiChange1h,
    oiChange4h,
    oiAcceleration,
    priceOiDivergence: priceReturn1h * oiChange1h,
    takerBuyRatio,
    takerImbalanceChange,
    funding,
    fundingPercentile,
    longShortRatio,
    longShortRatioChange,
  });
}

function matchesConfiguration(dataset: V7Dataset, candleIndex: number, features: V7FeatureSnapshot, configuration: V7Configuration): boolean {
  const p = (key: string, fallback: number): number => {
    const value = configuration.parameters[key];
    return typeof value === "number" ? value : fallback;
  };
  if (configuration.family === "OI_PRICE_DIVERGENCE") {
    const priceDirection = p("priceDirection", 1);
    const oiDirection = p("oiDirection", 1);
    return features.priceReturn1h * priceDirection >= p("minPriceReturn1h", 0.003)
      && features.oiChange1h * oiDirection >= p("minOiChange1h", 0.002)
      && features.priceReturn4h * priceDirection > 0;
  }
  if (configuration.family === "OI_TAKER_FLOW") {
    const minOiAcceleration = p("minOiAcceleration", 0);
    const minOiChange4h = p("minOiChange4h", 0);
    const minTakerImbalance = p("minTakerImbalance", Number.NEGATIVE_INFINITY);
    const maxTakerImbalance = p("maxTakerImbalance", Number.POSITIVE_INFINITY);
    const takerImbalance = features.takerBuyRatio - 0.5;
    const priceDirection = configuration.side === "LONG" ? 1 : -1;
    const priceThreshold = configuration.side === "LONG" ? p("minPriceReturn1h", 0) : p("maxPriceReturn1h", 0);
    const pricePass = configuration.side === "LONG" ? features.priceReturn1h >= priceThreshold : features.priceReturn1h <= priceThreshold;
    const breakoutLookbackHours = p("breakoutLookbackHours", 0);
    const breakoutPass = breakoutLookbackHours <= 0 || priorRangeBreakout(dataset.candles1h, candleIndex, configuration.side, breakoutLookbackHours);
    return features.oiAcceleration >= minOiAcceleration
      && features.oiChange4h >= minOiChange4h
      && takerImbalance >= minTakerImbalance
      && takerImbalance <= maxTakerImbalance
      && pricePass
      && priceDirection * features.priceReturn4h > -0.01
      && breakoutPass;
  }
  const minFunding = p("minFunding", Number.NEGATIVE_INFINITY);
  const maxFunding = p("maxFunding", Number.POSITIVE_INFINITY);
  const minLongShortRatio = p("minLongShortRatio", Number.NEGATIVE_INFINITY);
  const maxLongShortRatio = p("maxLongShortRatio", Number.POSITIVE_INFINITY);
  const minOiPercentile = p("minOiPercentile", 0);
  const minPriceReturn4h = p("minPriceReturn4h", Number.NEGATIVE_INFINITY);
  const maxPriceReturn4h = p("maxPriceReturn4h", Number.POSITIVE_INFINITY);
  const pricePass = features.priceReturn4h >= minPriceReturn4h && features.priceReturn4h <= maxPriceReturn4h;
  return features.funding >= minFunding
    && features.funding <= maxFunding
    && features.longShortRatio >= minLongShortRatio
    && features.longShortRatio <= maxLongShortRatio
    && features.oiLevelPercentile >= minOiPercentile
    && pricePass
    && (configuration.side === "LONG" ? features.longShortRatioChange <= 0.25 : features.longShortRatioChange >= -0.25);
}

function priorRangeBreakout(candles: readonly Candle[], candleIndex: number, side: Side, lookbackHours: number): boolean {
  const prior = candles.slice(Math.max(0, candleIndex - lookbackHours), candleIndex);
  if (prior.length < lookbackHours) return false;
  const current = candles[candleIndex];
  return side === "LONG" ? current.close > Math.max(...prior.map((item) => item.high)) : current.close < Math.min(...prior.map((item) => item.low));
}

function simulateSignals(dataset: V7Dataset, signals: readonly V7Signal[], risk: (typeof V7_RISK_TEMPLATES)[number]): V7Trade[] {
  const index = getIndex(dataset);
  const trades: V7Trade[] = [];
  let availableAt = Number.NEGATIVE_INFINITY;
  for (const signal of signals.slice().sort((left, right) => left.executionTimestamp - right.executionTimestamp)) {
    if (signal.executionTimestamp <= availableAt) continue;
    const trade = simulateSignal(dataset, index, signal, risk);
    if (!trade) continue;
    trades.push(trade);
    availableAt = trade.exitTimestamp;
  }
  return trades;
}

function simulateSignal(dataset: V7Dataset, index: DatasetIndex, signal: V7Signal, risk: (typeof V7_RISK_TEMPLATES)[number]): V7Trade | null {
  const entryCandle = index.candle15mByOpen.get(signal.executionTimestamp);
  if (!entryCandle || entryCandle.openTime !== signal.signalCandleCloseTime + 1) return null;
  const entryPrice = entryCandle.open;
  const riskPrice = signal.featureSnapshot.atr * risk.stopAtrMultiplier;
  if (![entryPrice, riskPrice].every(Number.isFinite) || entryPrice <= 0 || riskPrice <= EPSILON) return null;
  const sideSign = signal.side === "LONG" ? 1 : -1;
  const stopPrice = entryPrice - sideSign * riskPrice;
  const targetPrice = entryPrice + sideSign * riskPrice * risk.rewardRisk;
  const quantity = V7_COST_MODEL.riskUsdt / riskPrice;
  if (![stopPrice, targetPrice, quantity].every(Number.isFinite) || quantity <= 0) return null;
  const entryIndex = index.candle15mIndexByOpen.get(entryCandle.openTime);
  if (entryIndex === undefined) return null;
  const maxBars = risk.maxHoldBars * 4;
  let exitPrice = entryPrice;
  let exitTimestamp = entryCandle.closeTime;
  let exitReason: V7Trade["exitReason"] = "END_OF_DATA";
  let trailingStop = stopPrice;
  let bestClose = entryPrice;
  for (let offset = 0; offset <= maxBars; offset += 1) {
    const candle = dataset.candles15m[entryIndex + offset];
    if (!candle) break;
    if (signal.side === "LONG") {
      if (candle.low <= trailingStop) { exitPrice = trailingStop; exitReason = "STOP"; exitTimestamp = candle.openTime; break; }
      if (candle.high >= targetPrice) { exitPrice = targetPrice; exitReason = "TARGET"; exitTimestamp = candle.openTime; break; }
      bestClose = Math.max(bestClose, candle.close);
      if (risk.trailingAtrMultiplier) trailingStop = Math.max(trailingStop, bestClose - signal.featureSnapshot.atr * risk.trailingAtrMultiplier);
    } else {
      if (candle.high >= trailingStop) { exitPrice = trailingStop; exitReason = "STOP"; exitTimestamp = candle.openTime; break; }
      if (candle.low <= targetPrice) { exitPrice = targetPrice; exitReason = "TARGET"; exitTimestamp = candle.openTime; break; }
      bestClose = Math.min(bestClose, candle.close);
      if (risk.trailingAtrMultiplier) trailingStop = Math.min(trailingStop, bestClose + signal.featureSnapshot.atr * risk.trailingAtrMultiplier);
    }
    exitPrice = candle.close;
    exitTimestamp = candle.closeTime;
    if (offset === maxBars) exitReason = "TIME";
  }
  if (exitReason === "END_OF_DATA" && exitTimestamp <= signal.executionTimestamp) return null;
  const grossR = sideSign * (exitPrice - entryPrice) / riskPrice;
  const notional = quantity * entryPrice;
  const feesR = ((entryPrice + exitPrice) * quantity * V7_COST_MODEL.takerFeeBpsPerSide / 10_000) / V7_COST_MODEL.riskUsdt;
  const slippageR = ((entryPrice + exitPrice) * quantity * V7_COST_MODEL.baseSlippageBpsPerSide / 10_000) / V7_COST_MODEL.riskUsdt;
  const fundingR = fundingCost(dataset.fundingRates, signal.executionTimestamp, exitTimestamp, sideSign, notional);
  return {
    family: signal.family,
    configurationId: signal.configurationId,
    symbol: signal.symbol,
    side: signal.side,
    signalTimestamp: signal.signalTimestamp,
    executionTimestamp: signal.executionTimestamp,
    entryPrice,
    exitTimestamp,
    exitPrice,
    exitReason,
    stopPrice,
    targetPrice,
    riskPrice,
    rewardRisk: risk.rewardRisk,
    quantity,
    grossR,
    netR: grossR - feesR - slippageR + fundingR,
    feesR,
    slippageR,
    fundingR,
    costStressBps: 0,
    oiRegime: signal.featureSnapshot.oiChange1h > 0.001 ? "RISING" : signal.featureSnapshot.oiChange1h < -0.001 ? "FALLING" : "FLAT",
    fundingRegime: signal.featureSnapshot.funding > 0.0001 ? "POSITIVE" : signal.featureSnapshot.funding < -0.0001 ? "NEGATIVE" : "NEUTRAL",
    executionReferenceSource: "BINANCE_15M_NEXT_BAR_OPEN",
  };
}

function fundingCost(points: readonly FundingRatePoint[], start: number, end: number, sideSign: number, notional: number): number {
  return points.filter((point) => point.fundingTime > start && point.fundingTime <= end).reduce((sum, point) => sum - sideSign * point.fundingRate * notional / V7_COST_MODEL.riskUsdt, 0);
}

export function summarizeV7Trades(trades: readonly V7Trade[], stressBps = 0): V7MetricSummary {
  const returns = trades.map((trade) => netRAtStress(trade, stressBps));
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const netR = sum(returns);
  const monthly = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  for (const [index, trade] of trades.entries()) {
    const month = new Date(trade.exitTimestamp).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 0) + returns[index]);
    bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + returns[index]);
  }
  const positiveSymbols = [...bySymbol.values()].filter((value) => value > 0).length;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    netR,
    avgR: trades.length > 0 ? netR / trades.length : 0,
    profitFactor: sum(wins) / Math.max(EPSILON, Math.abs(sum(losses))),
    maxDD: maxDrawdown(returns),
    cvar95: cvar95(returns),
    positiveMonthRatio: monthly.size > 0 ? [...monthly.values()].filter((value) => value > 0).length / monthly.size : null,
    symbolBreadth: bySymbol.size,
    positiveSymbolRatio: bySymbol.size > 0 ? positiveSymbols / bySymbol.size : null,
    totalNetPnlUsdt: netR * V7_COST_MODEL.riskUsdt,
    totalFeesUsdt: sum(trades.map((trade) => trade.feesR * V7_COST_MODEL.riskUsdt)),
    totalFundingUsdt: sum(trades.map((trade) => trade.fundingR * V7_COST_MODEL.riskUsdt)),
    totalSlippageUsdt: sum(trades.map((trade) => netSlippageR(trade, stressBps) * V7_COST_MODEL.riskUsdt)),
  };
}

export function stressSummary(trades: readonly V7Trade[]): V7StressSummary {
  return {
    base: summarizeV7Trades(trades, 0),
    plus5Bps: summarizeV7Trades(trades, 5),
    plus10Bps: summarizeV7Trades(trades, 10),
    plus15Bps: summarizeV7Trades(trades, 15),
  };
}

export function summarizeV7Yield(trades: readonly V7Trade[], start: number, end: number): V7YieldMetrics {
  const months = monthKeys(start, end);
  const activeMonths = new Set(trades.map((trade) => new Date(trade.executionTimestamp).toISOString().slice(0, 7)));
  const byMonth = new Map(months.map((month) => [month, 0]));
  for (const trade of trades) {
    const month = new Date(trade.executionTimestamp).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }
  const counts = [...byMonth.values()];
  const gaps = droughts(trades.map((trade) => trade.executionTimestamp).sort((left, right) => left - right), start, end);
  return {
    calendarDays: Math.max(1, Math.ceil((end - start) / DAY_MS)),
    calendarMonths: months.length,
    alertsPerWeek: trades.length / Math.max(1, (end - start) / (7 * DAY_MS)),
    alertsPerMonth: trades.length / Math.max(1, months.length),
    activeMonthRatio: months.length > 0 ? activeMonths.size / months.length : 0,
    medianAlertsPerMonth: median(counts),
    p95DroughtDays: percentile(gaps, 0.95),
    maxDroughtDays: gaps.length > 0 ? Math.max(...gaps) : Math.max(1, (end - start) / DAY_MS),
  };
}

export function runNestedFamily(runs: readonly V7RunResult[], family: V7Family, start: number, end: number, eligibleSymbols: ReadonlySet<string>): V7NestedResult {
  const familyRuns = runs.filter((run) => run.family === family);
  const folds: V7FoldResult[] = [];
  const nestedTrades: V7Trade[] = [];
  for (const fold of outerFolds(start, end)) {
    const innerValidationStart = addHours(addMonths(fold.trainStart, 6), V7_PURGE_HOURS);
    const candidates = familyRuns.map((run) => {
      const innerTrades = filterTrades(run.trades, innerValidationStart, fold.trainEnd, eligibleSymbols);
      return { run, score: selectionScore(summarizeV7Trades(innerTrades), summarizeV7Yield(innerTrades, innerValidationStart, fold.trainEnd)) };
    });
    const selected = candidates.sort((left, right) => right.score - left.score || left.run.runId.localeCompare(right.run.runId))[0]?.run;
    if (!selected) continue;
    const validationStart = addHours(fold.trainEnd, V7_PURGE_HOURS + V7_EMBARGO_HOURS);
    // The holdout symbols are excluded from inner selection above, but they
    // remain in the outer OOS evaluation. This preserves the preregistered
    // selection boundary while measuring full-universe breadth honestly.
    const oosTrades = filterTrades(selected.trades, validationStart, fold.validationEnd, null);
    const metrics = summarizeV7Trades(oosTrades);
    nestedTrades.push(...oosTrades);
    folds.push({ fold: fold.id, selectedRunId: selected.runId, trades: metrics.trades, netR: metrics.netR, avgR: metrics.avgR, profitFactor: metrics.profitFactor, positive: metrics.netR > 0 });
  }
  const diagnosticRun = familyRuns
    .map((run) => ({ run, score: selectionScore(summarizeV7Trades(filterTrades(run.trades, start, end, eligibleSymbols)), summarizeV7Yield(filterTrades(run.trades, start, end, eligibleSymbols), start, end)) }))
    .sort((left, right) => right.score - left.score || left.run.runId.localeCompare(right.run.runId))[0]?.run ?? emptyRun(family);
  const metrics = summarizeV7Trades(nestedTrades);
  const stress = stressSummary(nestedTrades);
  const yieldMetrics = summarizeV7Yield(nestedTrades, start, end);
  const foldNetRs = folds.map((fold) => fold.netR);
  return {
    selectedRun: diagnosticRun,
    nestedTrades: nestedTrades.sort((left, right) => left.executionTimestamp - right.executionTimestamp),
    folds,
    metrics,
    stress,
    yield: yieldMetrics,
    positiveFoldRatio: folds.length > 0 ? folds.filter((fold) => fold.positive).length / folds.length : 0,
    medianFoldNetR: median(foldNetRs) ?? 0,
    promotionLCB: lowerConfidenceBound(nestedTrades.map((trade) => trade.netR)),
  };
}

export function evaluateTemporalValidation(run: V7RunResult, start: number, end: number): V7ValidationResult {
  const trades = filterTrades(run.trades, start, end, null);
  const metrics = summarizeV7Trades(trades);
  const stress = stressSummary(trades);
  const gate = { trades: metrics.trades >= 50, netR: metrics.netR > 0, avgR: metrics.avgR > 0, profitFactor: metrics.profitFactor >= 1.2, plus10BpsNetR: stress.plus10Bps.netR > 0 };
  return { status: Object.values(gate).every(Boolean) ? "PASS" : trades.length === 0 ? "DATA_INSUFFICIENT" : "INCOMPLETE", metrics, stress, symbols: new Set(trades.map((trade) => trade.symbol)).size, gate };
}

export function evaluateSymbolValidation(run: V7RunResult, symbols: ReadonlySet<string>, start: number, end: number): V7ValidationResult {
  const trades = filterTrades(run.trades, start, end, symbols);
  const metrics = summarizeV7Trades(trades);
  const stress = stressSummary(trades);
  const symbolCount = new Set(trades.map((trade) => trade.symbol)).size;
  const gate = { trades: metrics.trades >= 50, symbols: symbolCount >= 10, netR: metrics.netR > 0, avgR: metrics.avgR > 0, profitFactor: metrics.profitFactor >= 1.2, positiveSymbolRatio: (metrics.positiveSymbolRatio ?? 0) >= 0.6 };
  return { status: Object.values(gate).every(Boolean) ? "PASS" : trades.length === 0 ? "DATA_INSUFFICIENT" : "INCOMPLETE", metrics, stress, symbols: symbolCount, gate };
}

export function familyPasses(nested: V7NestedResult, temporal: V7ValidationResult, symbol: V7ValidationResult): boolean {
  const nestedPass = nested.metrics.trades >= 100
    && nested.metrics.netR > 0
    && nested.metrics.avgR >= 0.1
    && nested.metrics.profitFactor >= 1.3
    && nested.positiveFoldRatio >= 0.67
    && nested.medianFoldNetR > 0
    && nested.stress.plus10Bps.netR > 0
    && nested.metrics.symbolBreadth >= 15
    && nested.promotionLCB >= 0;
  const yieldPass = nested.yield.alertsPerMonth >= 4
    && nested.yield.activeMonthRatio >= 0.7
    && (nested.yield.medianAlertsPerMonth ?? 0) >= 2
    && nested.yield.p95DroughtDays <= 30
    && nested.yield.maxDroughtDays <= 45;
  return nestedPass && yieldPass && Object.values(temporal.gate).every(Boolean) && Object.values(symbol.gate).every(Boolean);
}

export function buildPortfolioSummary(trades: readonly V7Trade[]): { trades: V7Trade[]; metrics: V7MetricSummary; maxConcurrent: number; maxSymbolConcentration: number; maxClusterConcentration: number; rejectedForCapacity: number; rejectedForSymbolConcentration: number; rejectedForClusterConcentration: number; concentrationProxy: string } {
  const accepted: V7Trade[] = [];
  let maxConcurrent = 0;
  let maxSymbolConcentration = 0;
  let maxClusterConcentration = 0;
  let rejectedForCapacity = 0;
  let rejectedForSymbolConcentration = 0;
  let rejectedForClusterConcentration = 0;
  for (const trade of trades.slice().sort((left, right) => left.executionTimestamp - right.executionTimestamp)) {
    const active = accepted.filter((item) => item.executionTimestamp <= trade.executionTimestamp && item.exitTimestamp >= trade.executionTimestamp);
    if (active.length >= 5) { rejectedForCapacity += 1; continue; }
    if (active.some((item) => item.symbol === trade.symbol)) { rejectedForSymbolConcentration += 1; continue; }
    const cluster = concentrationCluster(trade.symbol);
    if (active.filter((item) => concentrationCluster(item.symbol) === cluster).length >= 3) { rejectedForClusterConcentration += 1; continue; }
    accepted.push(trade);
    maxConcurrent = Math.max(maxConcurrent, active.length + 1);
    maxSymbolConcentration = Math.max(maxSymbolConcentration, 1);
    maxClusterConcentration = Math.max(maxClusterConcentration, active.filter((item) => concentrationCluster(item.symbol) === cluster).length + 1);
  }
  return { trades: accepted, metrics: summarizeV7Trades(accepted), maxConcurrent, maxSymbolConcentration, maxClusterConcentration, rejectedForCapacity, rejectedForSymbolConcentration, rejectedForClusterConcentration, concentrationProxy: "BTCUSDT is its own cluster; all other symbols are conservatively treated as BTC_BETA. This is a capacity proxy, not measured return correlation." };
}

export function yearMetrics(trades: readonly V7Trade[], years: readonly number[]): Record<string, V7MetricSummary> {
  return Object.fromEntries(years.map((year) => [String(year), summarizeV7Trades(trades.filter((trade) => new Date(trade.exitTimestamp).getUTCFullYear() === year))]));
}

export function regimeMetrics(trades: readonly V7Trade[]): Record<string, V7MetricSummary> {
  return Object.fromEntries(["RISING", "FALLING", "FLAT"].map((regime) => [regime, summarizeV7Trades(trades.filter((trade) => trade.oiRegime === regime))]));
}

export function fundingRegimeMetrics(trades: readonly V7Trade[]): Record<string, V7MetricSummary> {
  return Object.fromEntries(["POSITIVE", "NEGATIVE", "NEUTRAL"].map((regime) => [regime, summarizeV7Trades(trades.filter((trade) => trade.fundingRegime === regime))]));
}

function getFamilyConfigurations(family: V7Family): readonly V7Configuration[] {
  return V7_CONFIGURATIONS.filter((configuration) => configuration.family === family);
}

function getIndex(dataset: V7Dataset): DatasetIndex {
  const cached = indexCache.get(dataset);
  if (cached) return cached;
  const index: DatasetIndex = {
    candle1hByOpen: new Map(dataset.candles1h.map((candle) => [candle.openTime, candle])),
    candle1hIndexByOpen: new Map(dataset.candles1h.map((candle, position) => [candle.openTime, position])),
    candles4h: dataset.candles4h.slice().sort((left, right) => left.openTime - right.openTime),
    candle15mByOpen: new Map(dataset.candles15m.map((candle) => [candle.openTime, candle])),
    candle15mIndexByOpen: new Map(dataset.candles15m.map((candle, position) => [candle.openTime, position])),
    derivativeByHour: new Map(dataset.derivatives.map((point) => [point.timestamp, point])),
    funding: dataset.fundingRates.slice().sort((left, right) => left.fundingTime - right.fundingTime),
  };
  indexCache.set(dataset, index);
  return index;
}

function latestDerivativeAt(points: Map<number, DerivativesMetricsPoint>, timestamp: number): DerivativesMetricsPoint | null {
  return points.get(Math.floor(timestamp / HOUR_MS) * HOUR_MS) ?? null;
}

function lastClosedCandleIndex(candles: readonly Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function cacheFeature(dataset: V7Dataset, timestamp: number, value: V7FeatureSnapshot | null): V7FeatureSnapshot | null {
  const cache = featureCache.get(dataset) ?? new Map<number, V7FeatureSnapshot | null>();
  cache.set(timestamp, value);
  featureCache.set(dataset, cache);
  return value;
}

function latestFundingAt(points: readonly FundingRatePoint[], timestamp: number): FundingRatePoint | null {
  let candidate: FundingRatePoint | null = null;
  for (const point of points) {
    if (point.fundingTime <= timestamp && (!candidate || point.fundingTime > candidate.fundingTime)) candidate = point;
  }
  return candidate;
}

function averageTrueRange(candles: readonly Candle[]): number {
  if (candles.length === 0) return Number.NaN;
  const ranges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.open;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  return sum(ranges) / ranges.length;
}

function relativeChange(current: number, previous: number): number {
  return Math.abs(previous) > EPSILON ? current / previous - 1 : Number.NaN;
}

function percentileRank(values: readonly number[], value: number): number {
  if (values.length < 5) return 0.5;
  return values.filter((item) => item <= value).length / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const mean = sum(values) / values.length;
  return Math.sqrt(sum(values.map((value) => (value - mean) ** 2)) / (values.length - 1));
}

function cvar95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const tailCount = Math.max(1, Math.ceil(values.length * 0.05));
  return values.slice().sort((left, right) => left - right).slice(0, tailCount).reduce((a, b) => a + b, 0) / tailCount;
}

function maxDrawdown(values: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return drawdown;
}

function netRAtStress(trade: V7Trade, stressBps: number): number {
  return trade.grossR - trade.feesR - netSlippageR(trade, stressBps) + trade.fundingR;
}

function netSlippageR(trade: V7Trade, stressBps: number): number {
  return trade.slippageR * ((V7_COST_MODEL.baseSlippageBpsPerSide + stressBps) / V7_COST_MODEL.baseSlippageBpsPerSide);
}

function selectionScore(metrics: V7MetricSummary, yieldMetrics: V7YieldMetrics): number {
  if (metrics.trades < 10) return Number.NEGATIVE_INFINITY;
  const pfScore = Math.log(Math.max(0.1, metrics.profitFactor));
  const riskPenalty = Math.min(5, metrics.maxDD / Math.max(1, metrics.trades));
  const yieldScore = yieldMetrics.activeMonthRatio - Math.min(1, yieldMetrics.maxDroughtDays / 180);
  return metrics.avgR * 10 + pfScore + (metrics.positiveMonthRatio ?? 0) + yieldScore - riskPenalty;
}

function markPareto(runs: V7RunResult[]): V7RunResult[] {
  return runs.map((run, index) => {
    const dominated = runs.some((other, otherIndex) => otherIndex !== index
      && other.metrics.netR >= run.metrics.netR
      && other.metrics.profitFactor >= run.metrics.profitFactor
      && other.metrics.maxDD <= run.metrics.maxDD
      && other.yield.activeMonthRatio >= run.yield.activeMonthRatio
      && (other.metrics.netR > run.metrics.netR || other.metrics.profitFactor > run.metrics.profitFactor || other.metrics.maxDD < run.metrics.maxDD));
    return { ...run, pareto: !dominated };
  });
}

function filterTrades(trades: readonly V7Trade[], start: number, end: number, symbols: ReadonlySet<string> | null): V7Trade[] {
  return trades.filter((trade) => trade.signalTimestamp >= start && trade.signalTimestamp <= end && trade.exitTimestamp <= end && (!symbols || symbols.has(trade.symbol)));
}

function outerFolds(start: number, end: number): Array<{ id: string; trainStart: number; trainEnd: number; validationEnd: number }> {
  const folds: Array<{ id: string; trainStart: number; trainEnd: number; validationEnd: number }> = [];
  let trainStart = start;
  let position = 0;
  while (true) {
    const trainEnd = addHours(addMonths(trainStart, 9), -1);
    const validationEnd = addHours(addMonths(trainEnd + 1, 3), -1);
    if (validationEnd > end) break;
    folds.push({ id: `fold-${++position}`, trainStart, trainEnd, validationEnd });
    trainStart = addMonths(trainStart, 3);
  }
  return folds;
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function addHours(timestamp: number, hours: number): number { return timestamp + hours * HOUR_MS; }

function monthKeys(start: number, end: number): string[] {
  const cursor = new Date(start);
  cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setUTCDate(1); last.setUTCHours(0, 0, 0, 0);
  const output: string[] = [];
  while (cursor <= last) { output.push(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  return output;
}

function droughts(timestamps: readonly number[], start: number, end: number): number[] {
  const points = [start, ...timestamps, end];
  return points.slice(1).map((timestamp, index) => Math.max(0, (timestamp - points[index]) / DAY_MS));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function lowerConfidenceBound(values: readonly number[]): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  const mean = sum(values) / values.length;
  const deviation = standardDeviation(values) || 0;
  return mean - 1.96 * deviation / Math.sqrt(values.length);
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

function concentrationCluster(symbol: string): string { return symbol === "BTCUSDT" ? "BTC" : "BTC_BETA"; }

function emptyRun(family: V7Family): V7RunResult {
  const metrics = summarizeV7Trades([]);
  return { runId: `EMPTY-${family}`, family, configId: "EMPTY", riskTemplateId: "EMPTY", side: "LONG", trades: [], metrics, stress: stressSummary([]), yield: summarizeV7Yield([], 0, V7_SIGNAL_INTERVAL_MS), pareto: false, selectionScore: Number.NEGATIVE_INFINITY };
}
