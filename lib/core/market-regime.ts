import { closes, ema, latest, rsi } from "./indicators";
import type { Candle, GlobalMarketState, MarketRegime, MarketSnapshot, MarketStateKey } from "./types";

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

interface TrendFeatures {
  regime: MarketRegime;
  close: number;
  fast: number;
  slow: number;
  slope: number;
  rsi: number | null;
}

export function buildGlobalMarketState(input: {
  btc: MarketSnapshot;
  eth?: MarketSnapshot;
  breadth?: number | null;
  sourceTimestamp?: number;
}): GlobalMarketState {
  const btcFeatures = trendFeatures(input.btc.candles["4h"] ?? input.btc.candles["1h"] ?? []);
  const ethRegime = input.eth
    ? classifyRegime(input.eth.candles["4h"] ?? input.eth.candles["1h"] ?? [])
    : undefined;
  const breadth = input.breadth ?? null;
  const key = classifyGlobalKey(btcFeatures, breadth);
  return {
    key,
    btcRegime: btcFeatures?.regime ?? "UNKNOWN",
    ethRegime,
    breadth,
    sourceTimestamp: input.sourceTimestamp ?? input.btc.sourceTimestamp,
  };
}

export function marketStateForDirection(state: GlobalMarketState | undefined, side: "LONG" | "SHORT"): MarketStateKey {
  if (!state) return "UNKNOWN";
  if (state.key === "UNKNOWN") return "UNKNOWN";
  if (side === "LONG") {
    return state.key.startsWith("BULL") ? state.key : state.key === "BEAR_REBOUND" ? "OTHER" : state.key;
  }
  return state.key.startsWith("BEAR") ? state.key : state.key === "BULL_PULLBACK" ? "OTHER" : state.key;
}

function trendFeatures(candles: Candle[]): TrendFeatures | null {
  if (candles.length < 80) return null;
  const values = closes(candles);
  const fastValues = ema(values, 20);
  const slowValues = ema(values, 50);
  const fast = latest(fastValues);
  const slow = latest(slowValues);
  const close = values.at(-1);
  const previousFast = fastValues.at(-5) ?? null;
  if (fast === null || slow === null || close === undefined || previousFast === null || fast === 0) return null;
  return {
    regime: classifyRegime(candles),
    close,
    fast,
    slow,
    slope: (fast - previousFast) / fast,
    rsi: latest(rsi(values, 14)),
  };
}

function classifyGlobalKey(features: TrendFeatures | null, breadth: number | null): MarketStateKey {
  if (!features || features.regime === "UNKNOWN") return "UNKNOWN";
  if (features.regime === "BULL") {
    const pullback = features.close <= features.fast && features.close > features.slow;
    if (pullback) return "BULL_PULLBACK";
    const weakBreadth = breadth !== null && breadth < 0.4;
    if (weakBreadth || (features.rsi !== null && features.rsi < 52)) return "BULL_WEAK";
    return "BULL_STRONG";
  }
  if (features.regime === "BEAR") {
    const rebound = features.close >= features.fast || (features.rsi !== null && features.rsi > 55);
    if (rebound) return "BEAR_REBOUND";
    const strongBreadth = breadth !== null && breadth <= 0.35;
    if (strongBreadth || (features.rsi !== null && features.rsi < 42)) return "BEAR_STRONG";
    return "BEAR_WEAK";
  }
  return "OTHER";
}
