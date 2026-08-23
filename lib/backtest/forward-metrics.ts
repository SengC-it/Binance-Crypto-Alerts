import type { Candle, Side } from "@/lib/core/types";

export interface ForwardEdgeMetrics {
  forwardReturn15m: number | null;
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn12h: number | null;
  forwardReturn24h: number | null;
  maxFavorableR: number;
  maxAdverseR: number;
  timeToMFEHours: number | null;
  timeToMAEHours: number | null;
  pPositiveHalfRBeforeStop: boolean;
  pPositiveOneRBeforeStop: boolean;
  pPositiveTwoRBeforeStop: boolean;
}

export function calculateForwardEdge(
  candles: Candle[],
  entryIndex: number,
  side: Side,
  entryPrice: number,
  riskDistance: number,
  horizonsHours = [0.25, 1, 4, 12, 24],
): ForwardEdgeMetrics {
  const direction = side === "LONG" ? 1 : -1;
  const entryTime = candles[entryIndex]?.closeTime ?? 0;
  const returns = horizonsHours.map((hours) => {
    const target = entryTime + hours * 3_600_000;
    const candle = candles.find((item) => item.closeTime >= target);
    return candle ? ((candle.close - entryPrice) * direction) / entryPrice : null;
  });
  let maxFavorableR = 0;
  let maxAdverseR = 0;
  let timeToMFEHours: number | null = null;
  let timeToMAEHours: number | null = null;
  const firstHit = { half: false, one: false, two: false };
  let stopSeen = false;
  if (riskDistance > 0) {
    for (const candle of candles.slice(entryIndex + 1)) {
      const favorablePrice = side === "LONG" ? candle.high : candle.low;
      const adversePrice = side === "LONG" ? candle.low : candle.high;
      const favorableR = Math.max(0, ((favorablePrice - entryPrice) * direction) / riskDistance);
      const adverseR = Math.max(0, ((entryPrice - adversePrice) * direction) / riskDistance);
      if (favorableR > maxFavorableR) {
        maxFavorableR = favorableR;
        timeToMFEHours = (candle.closeTime - entryTime) / 3_600_000;
      }
      if (adverseR > maxAdverseR) {
        maxAdverseR = adverseR;
        timeToMAEHours = (candle.closeTime - entryTime) / 3_600_000;
      }
      if (!stopSeen) {
        // OHLC cannot reveal the intrabar path; use the same conservative
        // stop-first convention as the main backtest engine.
        if (adverseR >= 1) {
          stopSeen = true;
        } else {
          if (favorableR >= 0.5) firstHit.half = true;
          if (favorableR >= 1) firstHit.one = true;
          if (favorableR >= 2) firstHit.two = true;
        }
      }
    }
  }
  return {
    forwardReturn15m: returns[0] ?? null,
    forwardReturn1h: returns[1] ?? null,
    forwardReturn4h: returns[2] ?? null,
    forwardReturn12h: returns[3] ?? null,
    forwardReturn24h: returns[4] ?? null,
    maxFavorableR: round(maxFavorableR),
    maxAdverseR: round(maxAdverseR),
    timeToMFEHours: timeToMFEHours === null ? null : round(timeToMFEHours),
    timeToMAEHours: timeToMAEHours === null ? null : round(timeToMAEHours),
    pPositiveHalfRBeforeStop: firstHit.half,
    pPositiveOneRBeforeStop: firstHit.one,
    pPositiveTwoRBeforeStop: firstHit.two,
  };
}

export function summarizeRFirstProbabilities(metrics: ForwardEdgeMetrics[]): {
  positiveHalfRBeforeStop: number;
  positiveOneRBeforeStop: number;
  positiveTwoRBeforeStop: number;
} {
  if (metrics.length === 0) return { positiveHalfRBeforeStop: 0, positiveOneRBeforeStop: 0, positiveTwoRBeforeStop: 0 };
  return {
    positiveHalfRBeforeStop: metrics.filter((metric) => metric.pPositiveHalfRBeforeStop).length / metrics.length,
    positiveOneRBeforeStop: metrics.filter((metric) => metric.pPositiveOneRBeforeStop).length / metrics.length,
    positiveTwoRBeforeStop: metrics.filter((metric) => metric.pPositiveTwoRBeforeStop).length / metrics.length,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
