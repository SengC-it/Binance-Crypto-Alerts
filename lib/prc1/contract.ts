export const PRC1_EXPERIMENT_ID = "PRC1_STOP_DISTANCE_FORWARD" as const;
export const PRC1_PURPOSE = "PROFIT_RECOVERY" as const;
export const PRC1_SINGLE_VARIABLE_CHANGE = "STOP_DISTANCE_EXCLUSION" as const;
export const PRC1_BASELINE_STRATEGY_VERSION = "default-trend-shadow-v1" as const;
export const PRC1_CHALLENGER_STRATEGY_VERSION = "default-trend-shadow-v2-stopband-filter" as const;
export const PRC1_FILTER_RULE = "REJECT_IF_2_5_LE_X_LT_3_5" as const;
export const PRC1_STOP_DISTANCE_LOWER_PCT = 2.5 as const;
export const PRC1_STOP_DISTANCE_UPPER_PCT = 3.5 as const;
export const PRC1_HYPOTHESIS_FROZEN_AT_UTC = "2026-09-12T23:46:20.666Z" as const;
export const PRC1_MIN_FORWARD_CLOSED_TRADES = 50 as const;

export function isPrc1ForwardEligible(sourceTimestamp: number): boolean {
  return Number.isFinite(sourceTimestamp)
    && sourceTimestamp >= Date.parse(PRC1_HYPOTHESIS_FROZEN_AT_UTC);
}
