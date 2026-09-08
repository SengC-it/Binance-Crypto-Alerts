import type { V15Bar } from "@/lib/v15/lead-lag";

export const V15_ADV_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
export const V15_ADV_LOOKBACK_BARS = 30 * 24 * 12;
export const V15_FUNDING_INTERVAL_MS = 8 * 60 * 60_000;

export interface PairMonthAvailability {
  spotIntegrityPass: boolean;
  futuresIntegrityPass: boolean;
}

export interface TrailingAdvWindow {
  available: boolean;
  observedBars: number;
  quoteVolume: number;
}

/** A bad leg makes only this pair-month unavailable; it is not an experiment-wide failure. */
export function pairMonthIsAvailable(availability: PairMonthAvailability): boolean {
  return availability.spotIntegrityPass && availability.futuresIntegrityPass;
}

/**
 * Return the complete 30-calendar-day quote-volume window immediately before T.
 * Zero quote volume is still observed data; it is not the same as a missing bar.
 */
export function trailingAdvWindow(bars: V15Bar[], timestamp: number): TrailingAdvWindow {
  const cutoff = timestamp - V15_ADV_LOOKBACK_MS;
  const window = bars.filter((bar) => bar.closeTime >= cutoff && bar.closeTime < timestamp).sort((left, right) => left.openTime - right.openTime);
  const complete = window.length === V15_ADV_LOOKBACK_BARS
    && window.every((bar, index) => index === 0 || bar.openTime - window[index - 1].openTime === 5 * 60_000);
  return {
    available: complete,
    observedBars: window.length,
    quoteVolume: window.reduce((sum, bar) => sum + bar.quoteVolume, 0),
  };
}

/** Funding timestamps are generated only for the potential holding interval, never from exits. */
export function potentialFundingSettlements(entryTime: number, potentialEndTime: number): number[] {
  const first = Math.floor(entryTime / V15_FUNDING_INTERVAL_MS) * V15_FUNDING_INTERVAL_MS + V15_FUNDING_INTERVAL_MS;
  const values: number[] = [];
  for (let timestamp = first; timestamp <= potentialEndTime; timestamp += V15_FUNDING_INTERVAL_MS) values.push(timestamp);
  return values;
}

export function settlementInputsCover(requiredTimestamps: number[], available: Map<number, number>): boolean {
  return requiredTimestamps.every((timestamp) => {
    const markPrice = available.get(timestamp);
    return Number.isFinite(markPrice) && (markPrice as number) > 0;
  });
}

export function coverageOrNotApplicable(covered: number, required: number): number | null {
  return required === 0 ? null : covered / required;
}
