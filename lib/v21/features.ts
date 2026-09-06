import {
  V21_INTERVAL_MS,
  V21_SYMBOLS,
  type V21Symbol,
} from "./constants";

export const V21_PIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const V21_PIT_OBSERVATION_COUNT = 8640;

export interface V21ClosePoint {
  openTime: number;
  close: number;
}

export type V21CloseSeriesBySymbol = Record<V21Symbol, readonly V21ClosePoint[]>;

export interface V21ReturnRow {
  openTime: number;
  returns: Record<V21Symbol, number>;
}

export interface V21PitOlsResult {
  alpha: number;
  beta: number;
  priorObservationCount: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface V21PitFeature {
  symbol: V21Symbol;
  openTime: number;
  assetReturn: number;
  marketReturn: number;
  alpha: number;
  beta: number;
  previousResidual: number;
  currentResidual: number;
  residualAbsQ99: number;
  priorObservationCount: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

export function buildSynchronizedReturns(
  seriesBySymbol: V21CloseSeriesBySymbol,
): V21ReturnRow[] {
  const closeMaps = {} as Record<V21Symbol, Map<number, number>>;
  for (const symbol of V21_SYMBOLS) closeMaps[symbol] = indexCloseSeries(seriesBySymbol[symbol], symbol);

  const firstSymbol = V21_SYMBOLS[0];
  const candidateTimes = [...closeMaps[firstSymbol].keys()].sort((left, right) => left - right);
  const rows: V21ReturnRow[] = [];
  for (const openTime of candidateTimes) {
    const previousOpenTime = openTime - V21_INTERVAL_MS;
    if (!V21_SYMBOLS.every((symbol) => closeMaps[symbol].has(openTime) && closeMaps[symbol].has(previousOpenTime))) continue;

    const returns = {} as Record<V21Symbol, number>;
    for (const symbol of V21_SYMBOLS) {
      const currentClose = closeMaps[symbol].get(openTime);
      const previousClose = closeMaps[symbol].get(previousOpenTime);
      if (currentClose === undefined || previousClose === undefined) throw new Error("Synchronized close lookup failed");
      const value = Math.log(currentClose / previousClose);
      if (!Number.isFinite(value)) throw new Error("Non-finite synchronized return");
      returns[symbol] = value;
    }
    rows.push({ openTime, returns });
  }
  return rows;
}

export function leaveOneOutMedian(row: V21ReturnRow, targetSymbol: V21Symbol): number {
  const values = marketValues(row, targetSymbol);
  if (values === null) throw new Error("Leave-one-out market return is not finite");
  values.sort((left, right) => left - right);
  return values[3];
}

export function selectPitWindow(
  rows: readonly V21ReturnRow[],
  currentOpenTime: number,
): V21ReturnRow[] {
  const start = currentOpenTime - V21_PIT_WINDOW_MS;
  return rows.filter((row) => row.openTime >= start && row.openTime < currentOpenTime);
}

export function fitPitOls(
  priorRows: readonly V21ReturnRow[],
  targetSymbol: V21Symbol,
): V21PitOlsResult {
  if (priorRows.length !== V21_PIT_OBSERVATION_COUNT) {
    return ineligibleOls(priorRows.length, "PIT_OBSERVATION_COUNT_MISMATCH");
  }

  const pairs: Array<{ x: number; y: number }> = [];
  for (const row of priorRows) {
    const marketReturn = marketValues(row, targetSymbol);
    const assetReturn = row.returns[targetSymbol];
    if (marketReturn === null || !Number.isFinite(assetReturn)) {
      return ineligibleOls(priorRows.length, "NON_FINITE_OBSERVATION");
    }
    marketReturn.sort((left, right) => left - right);
    pairs.push({ x: marketReturn[3], y: assetReturn });
  }

  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  const denominator = pairs.reduce((sum, pair) => sum + (pair.x - meanX) ** 2, 0);
  if (!Number.isFinite(meanX) || !Number.isFinite(meanY) || !Number.isFinite(denominator)) {
    return ineligibleOls(priorRows.length, "NON_FINITE_OBSERVATION");
  }
  if (denominator <= 0) return ineligibleOls(priorRows.length, "ZERO_MARKET_VARIANCE");

  const numerator = pairs.reduce((sum, pair) => sum + (pair.x - meanX) * (pair.y - meanY), 0);
  const beta = numerator / denominator;
  const alpha = meanY - beta * meanX;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta)) {
    return ineligibleOls(priorRows.length, "NON_FINITE_OLS_PARAMETER");
  }
  return {
    alpha,
    beta,
    priorObservationCount: priorRows.length,
    eligible: true,
    ineligibleReason: null,
  };
}

export function nearestRankQuantile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("Nearest-rank quantile requires observations");
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) throw new Error("Quantile must be in (0, 1]");
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.every((value) => Number.isFinite(value))) throw new Error("Nearest-rank quantile requires finite observations");
  const rank = Math.ceil(quantile * sorted.length);
  return sorted[rank - 1];
}

export function buildPitFeature(
  symbol: V21Symbol,
  currentRow: V21ReturnRow,
  previousRow: V21ReturnRow,
  priorRows: readonly V21ReturnRow[],
): V21PitFeature {
  const assetReturn = currentRow.returns[symbol];
  const marketValuesForCurrent = marketValues(currentRow, symbol);
  const marketReturn = marketValuesForCurrent === null
    ? Number.NaN
    : medianFromValues(marketValuesForCurrent);
  const base: V21PitFeature = {
    symbol,
    openTime: currentRow.openTime,
    assetReturn,
    marketReturn,
    alpha: Number.NaN,
    beta: Number.NaN,
    previousResidual: Number.NaN,
    currentResidual: Number.NaN,
    residualAbsQ99: Number.NaN,
    priorObservationCount: priorRows.length,
    eligible: false,
    ineligibleReason: null,
  };

  if (!Number.isSafeInteger(currentRow.openTime) || currentRow.openTime % V21_INTERVAL_MS !== 0) {
    return ineligibleFeature(base, "CURRENT_TIMESTAMP_INVALID");
  }
  if (!Number.isFinite(assetReturn) || marketValuesForCurrent === null) {
    return ineligibleFeature(base, "NON_FINITE_CURRENT_RETURN");
  }
  if (previousRow.openTime !== currentRow.openTime - V21_INTERVAL_MS) {
    return ineligibleFeature(base, "PREVIOUS_RETURN_NOT_ADJACENT");
  }
  if (priorRows.length !== V21_PIT_OBSERVATION_COUNT) {
    return ineligibleFeature(base, "PIT_OBSERVATION_COUNT_MISMATCH");
  }
  if (!isExactPitWindow(priorRows, currentRow.openTime)) {
    return ineligibleFeature(base, "PIT_WINDOW_NOT_EXACT");
  }

  const ols = fitPitOls(priorRows, symbol);
  if (!ols.eligible) return ineligibleFeature(base, ols.ineligibleReason ?? "OLS_INELIGIBLE");

  const residuals: number[] = [];
  for (const row of priorRows) {
    const marketReturnForRow = leaveOneOutMedian(row, symbol);
    const assetReturnForRow = row.returns[symbol];
    const residual = assetReturnForRow - (ols.alpha + ols.beta * marketReturnForRow);
    if (!Number.isFinite(residual)) return ineligibleFeature(base, "NON_FINITE_RESIDUAL");
    residuals.push(residual);
  }
  const residualAbsQ99 = nearestRankQuantile(residuals.map((value) => Math.abs(value)), 0.99);
  const previousMarketReturn = marketValues(previousRow, symbol);
  const previousAssetReturn = previousRow.returns[symbol];
  if (previousMarketReturn === null || !Number.isFinite(previousAssetReturn)) {
    return ineligibleFeature(base, "NON_FINITE_PREVIOUS_RETURN");
  }
  const previousResidual = previousAssetReturn - (ols.alpha + ols.beta * medianFromValues(previousMarketReturn));
  const currentResidual = assetReturn - (ols.alpha + ols.beta * marketReturn);
  if (!Number.isFinite(previousResidual) || !Number.isFinite(currentResidual) || !Number.isFinite(residualAbsQ99)) {
    return ineligibleFeature(base, "NON_FINITE_RESIDUAL");
  }
  return {
    ...base,
    alpha: ols.alpha,
    beta: ols.beta,
    previousResidual,
    currentResidual,
    residualAbsQ99,
    eligible: true,
    ineligibleReason: null,
  };
}

function indexCloseSeries(series: readonly V21ClosePoint[], symbol: V21Symbol): Map<number, number> {
  const result = new Map<number, number>();
  let previousOpenTime: number | null = null;
  for (const point of series) {
    if (!Number.isSafeInteger(point.openTime) || point.openTime % V21_INTERVAL_MS !== 0) {
      throw new Error("Invalid close timestamp for " + symbol);
    }
    if (!Number.isFinite(point.close) || point.close <= 0) throw new Error("Invalid close for " + symbol);
    if (previousOpenTime !== null && point.openTime <= previousOpenTime) {
      throw new Error("Close timestamps must be strictly increasing for " + symbol);
    }
    result.set(point.openTime, point.close);
    previousOpenTime = point.openTime;
  }
  return result;
}

function marketValues(row: V21ReturnRow, targetSymbol: V21Symbol): number[] | null {
  const values: number[] = [];
  for (const symbol of V21_SYMBOLS) {
    if (symbol === targetSymbol) continue;
    const value = row.returns[symbol];
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  return values.length === V21_SYMBOLS.length - 1 ? values : null;
}

function medianFromValues(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function ineligibleOls(priorObservationCount: number, reason: string): V21PitOlsResult {
  return {
    alpha: Number.NaN,
    beta: Number.NaN,
    priorObservationCount,
    eligible: false,
    ineligibleReason: reason,
  };
}

function ineligibleFeature(feature: V21PitFeature, reason: string): V21PitFeature {
  return { ...feature, eligible: false, ineligibleReason: reason };
}

function isExactPitWindow(rows: readonly V21ReturnRow[], currentOpenTime: number): boolean {
  const start = currentOpenTime - V21_PIT_WINDOW_MS;
  return rows.every((row, index) => row.openTime === start + index * V21_INTERVAL_MS && row.openTime < currentOpenTime);
}
