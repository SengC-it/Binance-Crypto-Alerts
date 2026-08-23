import type { EntryMode } from "./strategies";

export const CONTROL_STRATEGY_VERSION = "current-production-control";
export const CONTROL_ENTRY_MODE = "TREND_REJECTION" satisfies EntryMode;
export const PRODUCTION_STRATEGY_VERSION = "trend-rejection-short-v1";
export const PRODUCTION_ENTRY_MODE = "TREND_REJECTION" satisfies EntryMode;
export const SHADOW_STRATEGY_VERSION = "default-trend-shadow-v1";
export const SHADOW_ENTRY_MODE = "DEFAULT" satisfies EntryMode;
export const V5_STRATEGY_VERSION = "v5-signal-edge-1";
export const V5_ENTRY_MODE = "V5_SIGNAL_EDGE" satisfies EntryMode;
