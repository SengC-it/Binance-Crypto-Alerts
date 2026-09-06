import {
  V21_INTERVAL_MS,
  V21_SYMBOLS,
  type V21Symbol,
} from "./constants";
import {
  V21_PIT_OBSERVATION_COUNT,
  V21_PIT_WINDOW_MS,
  type V21PitFeature,
  type V21ReturnRow,
} from "./features";

const V21_Q99 = 0.99;

export interface V21FeatureScanDiagnostics {
  inputRows: number;
  evaluatedFeatures: number;
  eligibleFeatures: number;
  ineligibleFeatures: number;
}

export interface V21FeatureScanResult {
  features: V21PitFeature[];
  diagnostics: V21FeatureScanDiagnostics;
}

interface RollingStats {
  sumX: number;
  sumY: number;
  sumXX: number;
  sumXY: number;
  invalidObservations: number;
  identityObservations: number;
}

export function scanV21Features(rows: readonly V21ReturnRow[]): V21FeatureScanResult {
  const marketBySymbol = buildMarketMatrix(rows);
  const gapPrefix = buildGapPrefix(rows);
  const stats = V21_SYMBOLS.map(() => emptyStats());
  const features: V21PitFeature[] = [];

  const initialRows = Math.min(V21_PIT_OBSERVATION_COUNT, rows.length);
  for (let rowIndex = 0; rowIndex < initialRows; rowIndex += 1) {
    updateStats(stats, marketBySymbol, rows, rowIndex, 1);
  }

  for (let currentIndex = V21_PIT_OBSERVATION_COUNT; currentIndex < rows.length; currentIndex += 1) {
    const currentRow = rows[currentIndex];
    const previousRow = rows[currentIndex - 1];
    const priorStart = currentIndex - V21_PIT_OBSERVATION_COUNT;
    const windowIsExact = isExactWindow(rows, gapPrefix, priorStart, currentIndex);

    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      const symbol = V21_SYMBOLS[symbolIndex];
      features.push(evaluateFeature(
        symbol,
        symbolIndex,
        currentRow,
        previousRow,
        rows,
        marketBySymbol,
        stats[symbolIndex],
        windowIsExact,
        currentIndex,
        priorStart,
      ));
    }

    updateStats(stats, marketBySymbol, rows, priorStart, -1);
    updateStats(stats, marketBySymbol, rows, currentIndex, 1);
  }

  const eligibleFeatures = features.filter((feature) => feature.eligible).length;
  return {
    features,
    diagnostics: {
      inputRows: rows.length,
      evaluatedFeatures: features.length,
      eligibleFeatures,
      ineligibleFeatures: features.length - eligibleFeatures,
    },
  };
}

function evaluateFeature(
  symbol: V21Symbol,
  symbolIndex: number,
  currentRow: V21ReturnRow,
  previousRow: V21ReturnRow,
  rows: readonly V21ReturnRow[],
  marketBySymbol: readonly Float64Array[],
  stats: RollingStats,
  windowIsExact: boolean,
  currentIndex: number,
  priorStart: number,
): V21PitFeature {
  const assetReturn = currentRow.returns[symbol];
  const marketReturn = marketBySymbol[symbolIndex][currentIndex];
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
    priorObservationCount: V21_PIT_OBSERVATION_COUNT,
    eligible: false,
    ineligibleReason: null,
  };

  if (!Number.isSafeInteger(currentRow.openTime) || currentRow.openTime % V21_INTERVAL_MS !== 0) {
    return ineligible(base, "CURRENT_TIMESTAMP_INVALID");
  }
  if (!Number.isFinite(assetReturn) || !Number.isFinite(marketReturn)) {
    return ineligible(base, "NON_FINITE_CURRENT_RETURN");
  }
  if (previousRow.openTime !== currentRow.openTime - V21_INTERVAL_MS) {
    return ineligible(base, "PREVIOUS_RETURN_NOT_ADJACENT");
  }
  if (!windowIsExact) return ineligible(base, "PIT_WINDOW_NOT_EXACT");
  if (stats.invalidObservations > 0) return ineligible(base, "NON_FINITE_OBSERVATION");

  const meanX = stats.sumX / V21_PIT_OBSERVATION_COUNT;
  const meanY = stats.sumY / V21_PIT_OBSERVATION_COUNT;
  const denominator = stats.sumXX - stats.sumX * meanX;
  if (!Number.isFinite(meanX) || !Number.isFinite(meanY) || !Number.isFinite(denominator)) {
    return ineligible(base, "NON_FINITE_OBSERVATION");
  }
  if (denominator <= 0) return ineligible(base, "ZERO_MARKET_VARIANCE");

  const numerator = stats.sumXY - stats.sumX * meanY;
  const beta = numerator / denominator;
  const alpha = meanY - beta * meanX;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta)) {
    return ineligible(base, "NON_FINITE_OLS_PARAMETER");
  }

  const residualAbsQ99 = exactResidualQ99(
    symbol,
    symbolIndex,
    rows,
    marketBySymbol,
    alpha,
    beta,
    stats,
    priorStart,
  );
  const previousMarketReturn = marketBySymbol[symbolIndex][currentIndex - 1];
  const previousAssetReturn = previousRow.returns[symbol];
  if (!Number.isFinite(previousMarketReturn) || !Number.isFinite(previousAssetReturn)) {
    return ineligible(base, "NON_FINITE_PREVIOUS_RETURN");
  }
  const previousResidual = previousAssetReturn - (alpha + beta * previousMarketReturn);
  const currentResidual = assetReturn - (alpha + beta * marketReturn);
  if (!Number.isFinite(residualAbsQ99) || !Number.isFinite(previousResidual) || !Number.isFinite(currentResidual)) {
    return ineligible(base, "NON_FINITE_RESIDUAL");
  }
  return {
    ...base,
    alpha,
    beta,
    previousResidual,
    currentResidual,
    residualAbsQ99,
    eligible: true,
    ineligibleReason: null,
  };
}

function exactResidualQ99(
  symbol: V21Symbol,
  symbolIndex: number,
  rows: readonly V21ReturnRow[],
  marketBySymbol: readonly Float64Array[],
  alpha: number,
  beta: number,
  stats: RollingStats,
  priorStart: number,
): number {
  if (stats.identityObservations === V21_PIT_OBSERVATION_COUNT && alpha === 0 && beta === 1) return 0;

  const absoluteResiduals = new Float64Array(V21_PIT_OBSERVATION_COUNT);
  for (let index = 0; index < V21_PIT_OBSERVATION_COUNT; index += 1) {
    const rowIndex = priorStart + index;
    const residual = rows[rowIndex].returns[symbol] - (alpha + beta * marketBySymbol[symbolIndex][rowIndex]);
    absoluteResiduals[index] = Math.abs(residual);
  }
  const rank = Math.ceil(V21_Q99 * V21_PIT_OBSERVATION_COUNT);
  return selectKth(absoluteResiduals, rank - 1);
}

function selectKth(values: Float64Array, targetIndex: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    let low = left;
    let high = right;
    const pivot = values[Math.floor((left + right) / 2)];
    while (low <= high) {
      while (values[low] < pivot) low += 1;
      while (values[high] > pivot) high -= 1;
      if (low <= high) {
        const value = values[low];
        values[low] = values[high];
        values[high] = value;
        low += 1;
        high -= 1;
      }
    }
    if (targetIndex <= high) right = high;
    else if (targetIndex >= low) left = low;
    else return values[targetIndex];
  }
  return values[left];
}

function buildMarketMatrix(rows: readonly V21ReturnRow[]): Float64Array[] {
  const marketBySymbol = V21_SYMBOLS.map(() => new Float64Array(rows.length));
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
      const values: number[] = [];
      for (let otherIndex = 0; otherIndex < V21_SYMBOLS.length; otherIndex += 1) {
        if (otherIndex === symbolIndex) continue;
        const value = rows[rowIndex].returns[V21_SYMBOLS[otherIndex]];
        if (!Number.isFinite(value)) {
          values.length = 0;
          break;
        }
        values.push(value);
      }
      if (values.length === V21_SYMBOLS.length - 1) {
        values.sort((left, right) => left - right);
        marketBySymbol[symbolIndex][rowIndex] = values[3];
      } else {
        marketBySymbol[symbolIndex][rowIndex] = Number.NaN;
      }
    }
  }
  return marketBySymbol;
}

function buildGapPrefix(rows: readonly V21ReturnRow[]): Int32Array {
  const result = new Int32Array(rows.length);
  for (let index = 1; index < rows.length; index += 1) {
    result[index] = result[index - 1]
      + (rows[index].openTime === rows[index - 1].openTime + V21_INTERVAL_MS ? 0 : 1);
  }
  return result;
}

function isExactWindow(
  rows: readonly V21ReturnRow[],
  gapPrefix: Int32Array,
  priorStart: number,
  currentIndex: number,
): boolean {
  const current = rows[currentIndex];
  const previous = rows[currentIndex - 1];
  const firstPrior = rows[priorStart];
  const internalGaps = gapPrefix[currentIndex - 1] - gapPrefix[priorStart];
  return current.openTime - V21_PIT_WINDOW_MS === firstPrior.openTime
    && previous.openTime === current.openTime - V21_INTERVAL_MS
    && internalGaps === 0;
}

function emptyStats(): RollingStats {
  return {
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumXY: 0,
    invalidObservations: 0,
    identityObservations: 0,
  };
}

function updateStats(
  stats: RollingStats[],
  marketBySymbol: readonly Float64Array[],
  rows: readonly V21ReturnRow[],
  rowIndex: number,
  direction: 1 | -1,
): void {
  for (let symbolIndex = 0; symbolIndex < V21_SYMBOLS.length; symbolIndex += 1) {
    const symbol = V21_SYMBOLS[symbolIndex];
    const x = marketBySymbol[symbolIndex][rowIndex];
    const y = rows[rowIndex].returns[symbol];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      stats[symbolIndex].invalidObservations += direction;
      continue;
    }
    stats[symbolIndex].sumX += direction * x;
    stats[symbolIndex].sumY += direction * y;
    stats[symbolIndex].sumXX += direction * x * x;
    stats[symbolIndex].sumXY += direction * x * y;
    if (x === y) stats[symbolIndex].identityObservations += direction;
  }
}

function ineligible(feature: V21PitFeature, reason: string): V21PitFeature {
  return { ...feature, eligible: false, ineligibleReason: reason };
}
