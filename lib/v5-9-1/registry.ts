import {
  V59_BASE_SLIPPAGE_BPS,
  V59_COOLDOWN_HOURS,
  V59_DEV_END,
  V59_DEV_START,
  V59_EVENT_REGISTRY,
  V59_FEE_RATE,
  V59_MAX_CORE_FEATURES,
  V59_MAX_EVENTS_PER_FAMILY,
  V59_PRIMARY_EDGE_ID,
  V59_PURGE_HOURS,
  V59_RISK_PER_TRADE_USDT,
  V59_RISK_TEMPLATES,
  V59_UNTOUCHED_END,
  V59_UNTOUCHED_START,
  V59_CORE_FEATURE_NAMES,
  type V59ModelFamily,
} from "@/lib/v5-9/registry";

export const V591_BASELINE_COMMIT = "25f99797603b3500cd9e44bd6e3154e8d2475a0d";
export const V591_OLD_MANIFEST_ID = "v59-binance-untouched-symbols-2023-01-01-2026-07-31";
export const V591_OLD_BURN_STATE = "BURNED_AFTER_ZERO_SIGNAL_REVIEW";
export const V591_NEW_MANIFEST_ID = "v59-1-binance-untouched-symbols-2023-01-01-2026-07-31";
export const V591_DEV_START = V59_DEV_START;
export const V591_DEV_END = V59_DEV_END;
export const V591_UNTOUCHED_START = V59_UNTOUCHED_START;
export const V591_UNTOUCHED_END = V59_UNTOUCHED_END;
export const V591_PURGE_HOURS = V59_PURGE_HOURS;
export const V591_FEE_RATE = V59_FEE_RATE;
export const V591_BASE_SLIPPAGE_BPS = V59_BASE_SLIPPAGE_BPS;
export const V591_RISK_PER_TRADE_USDT = V59_RISK_PER_TRADE_USDT;
export const V591_COOLDOWN_HOURS = V59_COOLDOWN_HOURS;
export const V591_MAX_CORE_FEATURES = V59_MAX_CORE_FEATURES;
export const V591_MAX_EVENTS_PER_FAMILY = V59_MAX_EVENTS_PER_FAMILY;
export const V591_PRIMARY_EDGE_ID = V59_PRIMARY_EDGE_ID;

export const V591_EVENT_REGISTRY = V59_EVENT_REGISTRY;
export const V591_RISK_TEMPLATES = V59_RISK_TEMPLATES;
export const V591_CORE_FEATURE_NAMES = V59_CORE_FEATURE_NAMES;

/**
 * This is a pre-registered static liquidity tier. It is only a screening
 * order; archive availability and listing-window completeness decide which
 * symbols actually enter the frozen manifest. No return or signal result is
 * read during selection.
 */
export const V591_LIQUIDITY_PROXY_CANDIDATES = [
  "ARBUSDT",
  "APTUSDT",
  "ETCUSDT",
  "CHZUSDT",
  "COMPUSDT",
  "DASHUSDT",
  "ENJUSDT",
  "FLOWUSDT",
  "FTMUSDT",
  "HBARUSDT",
  "LDOUSDT",
  "MANAUSDT",
  "MKRUSDT",
  "NEOUSDT",
  "ROSEUSDT",
  "SNXUSDT",
  "STXUSDT",
  "THETAUSDT",
  "TIAUSDT",
  "TONUSDT",
  "WIFUSDT",
  "WOOUSDT",
  "XTZUSDT",
  "ZILUSDT",
  "KSMUSDT",
  "LPTUSDT",
  "MINAUSDT",
  "PENDLEUSDT",
  "JASMYUSDT",
  "JTOUSDT",
  "JUPUSDT",
  "ORDIUSDT",
] as const;

export interface V591ModelConfig {
  id: string;
  family: V59ModelFamily;
  evThresholdR: number;
  l2: number;
}

/** Six finite EV decision rules: two simple model families x three margins. */
export const V591_MODEL_CONFIGS: readonly V591ModelConfig[] = [
  { id: "V591-LOGISTIC-L2-EV05", family: "LOGISTIC_L2", evThresholdR: 0.05, l2: 0.1 },
  { id: "V591-LOGISTIC-L2-EV10", family: "LOGISTIC_L2", evThresholdR: 0.1, l2: 0.1 },
  { id: "V591-LOGISTIC-L2-EV15", family: "LOGISTIC_L2", evThresholdR: 0.15, l2: 0.1 },
  { id: "V591-SHALLOW-TREE-EV05", family: "SHALLOW_TREE", evThresholdR: 0.05, l2: 0 },
  { id: "V591-SHALLOW-TREE-EV10", family: "SHALLOW_TREE", evThresholdR: 0.1, l2: 0 },
  { id: "V591-SHALLOW-TREE-EV15", family: "SHALLOW_TREE", evThresholdR: 0.15, l2: 0 },
] as const;

export interface V591ResearchRules {
  positiveLabel: string;
  decision: string;
  probabilitySource: string;
  payoffSource: string;
  theoreticalBreakeven: string;
  costMargin: string;
  oldHoldout: string;
  yieldGate: Record<string, string>;
  newHoldout: Record<string, string>;
}

export const V591_RESEARCH_RULES: V591ResearchRules = {
  positiveLabel: "POSITIVE when fixed-cost net R > 0; HIGH_QUALITY when fixed-cost net R >= +0.5R",
  decision: "SEND when expectedNetR = pWin * avgWinR + (1 - pWin) * avgLossR is strictly greater than the preregistered EV margin.",
  probabilitySource: "Model probability is fit only on the outer-fold training rows for the selected risk template.",
  payoffSource: "avgWinR and avgLossR are calculated only from the same outer-fold training rows; validation and holdout outcomes never set the payoff.",
  theoreticalBreakeven: "Before costs p*=1/(1+rewardRisk): 1.5R=0.4000, 1.8R=0.3571, 2.0R=0.3333.",
  costMargin: "Net-R outcomes already include fixed fee, slippage, and funding; EV margins 0.05R/0.10R/0.15R add a preregistered positive-cost buffer.",
  oldHoldout: "The V5.9 20-symbol holdout is BURNED_AFTER_ZERO_SIGNAL_REVIEW and POST_HOC_DIAGNOSTIC_ONLY.",
  yieldGate: {
    alertsPerMonth: ">= 2",
    activeMonthRatio: ">= 0.65",
    medianAlertsPerMonth: ">= 1",
    p95DroughtDays: "<= 45",
    maxDroughtDays: "<= 60",
  },
  newHoldout: {
    selection: "Archive availability, month-precision listing window, and a pre-registered static liquidity proxy only.",
    gate: ">=50 signals, >=10 symbols, NetR>0, AvgR>0, PF>=1.20, +10bps NetR>0, positive-symbol ratio>=0.60.",
    insufficient: "Fewer than 50 signals is INCONCLUSIVE and cannot promote email.",
  },
};

export const V591_THEORETICAL_BREAKEVEN = V591_RISK_TEMPLATES.map((template) => ({
  templateId: template.id,
  rewardRisk: template.rewardRisk,
  beforeCostsProbability: 1 / (1 + template.rewardRisk),
}));
