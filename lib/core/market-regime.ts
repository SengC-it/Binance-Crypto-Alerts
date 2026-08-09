import { closes, ema, latest } from "./indicators";
import type { Candle, MarketRegime } from "./types";

export function classifyRegime(candles: Candle[]): MarketRegime {
  if (candles.length < 80) return "UNKNOWN";

  const closeValues = closes(candles);
  const fast = ema(closeValues, 20);
  const slow = ema(closeValues, 50);
  const fastNow = latest(fast);
  const slowNow = latest(slow);
  const fastPrevious = fast[fast.length - 5] ?? null;

  if (fastNow === null || slowNow === null || fastPrevious === null) return "UNKNOWN";
  const slope = fastNow - fastPrevious;
  const normalizedSlope = slope / fastNow;

  if (fastNow > slowNow && normalizedSlope > 0.002) return "BULL";
  if (fastNow < slowNow && normalizedSlope < -0.002) return "BEAR";
  return "RANGE";
}
