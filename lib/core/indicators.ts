import type { Candle } from "./types";

export function closes(candles: Candle[]): number[] {
  return candles.map((candle) => candle.close);
}

export function sma(values: number[], period: number): Array<number | null> {
  if (period <= 0) throw new Error("SMA period must be positive");

  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) result[index] = sum / period;
  }

  return result;
}

export function ema(values: number[], period: number): Array<number | null> {
  if (period <= 0) throw new Error("EMA period must be positive");
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;

  const seed = values.slice(0, period).reduce((total, value) => total + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;

  for (let index = period; index < values.length; index += 1) {
    const previous = result[index - 1];
    if (previous === null) continue;
    result[index] = (values[index] - previous) * multiplier + previous;
  }

  return result;
}

export function atr(candles: Candle[], period = 14): Array<number | null> {
  if (period <= 0) throw new Error("ATR period must be positive");
  if (candles.length === 0) return [];

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  return ema(trueRanges, period);
}

export function rsi(values: number[], period = 14): Array<number | null> {
  if (period <= 0) throw new Error("RSI period must be positive");
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiValue(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }

  return result;
}

function rsiValue(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function standardDeviation(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (period <= 0) throw new Error("Standard deviation period must be positive");

  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((total, value) => total + value, 0) / period;
    const variance = window.reduce((total, value) => total + (value - mean) ** 2, 0) / period;
    result[index] = Math.sqrt(variance);
  }

  return result;
}

export function bollinger(values: number[], period = 20, deviationMultiplier = 2) {
  const middle = sma(values, period);
  const deviation = standardDeviation(values, period);
  return values.map((_, index) => {
    if (middle[index] === null || deviation[index] === null) {
      return { middle: null, upper: null, lower: null };
    }
    return {
      middle: middle[index],
      upper: middle[index]! + deviation[index]! * deviationMultiplier,
      lower: middle[index]! - deviation[index]! * deviationMultiplier,
    };
  });
}

export function donchian(candles: Candle[], period = 20) {
  return candles.map((_, index) => {
    if (index < period) return { upper: null, lower: null };
    const window = candles.slice(index - period, index);
    return {
      upper: Math.max(...window.map((candle) => candle.high)),
      lower: Math.min(...window.map((candle) => candle.low)),
    };
  });
}

export function volumeRatio(candles: Candle[], period = 20): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  for (let index = period; index < candles.length; index += 1) {
    const window = candles.slice(index - period, index).map((candle) => candle.volume);
    const average = window.reduce((total, value) => total + value, 0) / period;
    result[index] = average === 0 ? null : candles[index].volume / average;
  }
  return result;
}

export function latest<T>(values: Array<T | null>): T | null {
  return values.length === 0 ? null : values[values.length - 1];
}
