import type { EntryMode } from "./strategies";

export const PRODUCTION_STRATEGY_VERSION = "trend-rejection-short-v1";
export const PRODUCTION_ENTRY_MODE = "TREND_REJECTION" satisfies EntryMode;
export const SHADOW_STRATEGY_VERSION = "default-trend-shadow-v1";
export const SHADOW_ENTRY_MODE = "DEFAULT" satisfies EntryMode;
