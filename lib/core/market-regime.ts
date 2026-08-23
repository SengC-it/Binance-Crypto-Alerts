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
  breadthUniverseId?: string;
  breadthUniverseSize?: number;
}): GlobalMarketState {
  const btcFeatures = trendFeatures(input.btc.candles["4h"] ?? input.btc.candles["1h"] ?? []);
  const ethFeatures = input.eth
    ? trendFeatures(input.eth.candles["4h"] ?? input.eth.candles["1h"] ?? [])
    : null;
  const breadth = input.breadth ?? null;
  const key = classifyGlobalKey(btcFeatures, ethFeatures, breadth);
  return {
    key,
    btcRegime: btcFeatures?.regime ?? "UNKNOWN",
    ethRegime: ethFeatures?.regime,
    breadth,
    sourceTimestamp: input.sourceTimestamp ?? input.btc.sourceTimestamp,
    breadthUniverseId: input.breadthUniverseId,
    breadthUniverseSize: input.breadthUniverseSize,
  };
}

export function buildGlobalMarketStateFromSnapshots(input: {
  snapshots: MarketSnapshot[];
  sourceTimestamp: number;
  breadthUniverseId?: string;
}): GlobalMarketState | undefined {
  const btc = input.snapshots.find((snapshot) => snapshot.instrument.symbol === "BTCUSDT");
  if (!btc) return undefined;
  const eth = input.snapshots.find((snapshot) => snapshot.instrument.symbol === "ETHUSDT");
  return buildGlobalMarketState({
    btc,
    eth,
    breadth: calculateBreadth(input.snapshots),
    sourceTimestamp: input.sourceTimestamp,
    breadthUniverseId: input.breadthUniverseId,
    breadthUniverseSize: input.snapshots.length,
  });
}

export function calculateBreadth(snapshots: MarketSnapshot[]): number | null {
  const regimes = snapshots
    .map((snapshot) => classifyRegime(snapshot.candles["4h"] ?? snapshot.candles["1h"] ?? []))
    .filter((regime) => regime === "BULL" || regime === "BEAR");
  if (regimes.length === 0) return null;
  return regimes.filter((regime) => regime === "BULL").length / regimes.length;
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

function classifyGlobalKey(
  btc: TrendFeatures | null,
  eth: TrendFeatures | null,
  breadth: number | null,
): MarketStateKey {
  if (!btc || btc.regime === "UNKNOWN") return "UNKNOWN";
  const alignedBull = btc.regime === "BULL" && (!eth || eth.regime === "BULL");
  const alignedBear = btc.regime === "BEAR" && (!eth || eth.regime === "BEAR");
  if (eth && eth.regime !== btc.regime && eth.regime !== "UNKNOWN") return "OTHER";
  if (alignedBull) {
    const pullback = btc.close <= btc.fast && btc.close > btc.slow;
    if (pullback) return "BULL_PULLBACK";
    const weakBreadth = breadth !== null && breadth < 0.4;
    if (weakBreadth || (btc.rsi !== null && btc.rsi < 52)) return "BULL_WEAK";
    return "BULL_STRONG";
  }
  if (alignedBear) {
    const rebound = btc.close >= btc.fast || (btc.rsi !== null && btc.rsi > 55);
    if (rebound) return "BEAR_REBOUND";
    const strongBreadth = breadth !== null && breadth <= 0.35;
    if (strongBreadth || (btc.rsi !== null && btc.rsi < 42)) return "BEAR_STRONG";
    return "BEAR_WEAK";
  }
  return "OTHER";
}
