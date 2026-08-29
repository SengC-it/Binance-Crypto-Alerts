export const LFV_V4_PROVENANCE = {
  strategyVersion: "rules-profit-oriented-v4",
  sourceCommit: "29edac8a98f7f9564ed8fdd754854de6a85a20ba",
  status: "V4_REPLAY_PROVENANCE_FAIL",
  sourceEvidence: [
    "The historical source commit contains the V4 strategy identifier and the Production route entry point.",
    "The 26 August paper rows contain observed outputs but are LIVE_OBSERVATION_ONLY and cannot restore runtime configuration.",
  ],
  documentedDefaults: {
    minimumScore: 60,
    sideFilter: null,
    strategyFamily: null,
    requireRegimeAlignment: null,
    stopAtrMultiplier: 0.25,
    rewardRisk: null,
    cooldownHours: null,
    entryIntervalHours: null,
    takerFeeRate: null,
    slippageBps: null,
  },
  missingRuntimeFields: [
    "Production environment values for side/family/regime filters",
    "CS_STRATEGY_STOP_ATR_MULTIPLIER effective value",
    "reward-risk, cooldown, entry interval and execution-cost policy",
    "historical instrument filters used for quantity/price rounding",
  ],
  runtimeConfig: null,
} as const;

export const LFV_TREND_PROVENANCE = {
  strategyVersion: "trend-rejection-short-v1",
  entryMode: "TREND_REJECTION",
  sourceCommit: "1a6f0663e4dfe71869373cb41863856581713a7c",
  status: "RESTORED",
  runtimeConfig: {
    minimumScore: 70,
    sideFilter: "SHORT",
    strategyFamily: "TREND",
    requireRegimeAlignment: true,
    stopAtrMultiplier: 0.5,
    rewardRisk: 2,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
    maxConcurrentPositions: 1,
    cooldownHours: 8,
    entryIntervalHours: 1,
    maxExecutionCostRiskFraction: 0.1,
    marginUsdt: 100,
    perSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    assumedLeverage: 20,
    maxHoldHours: 72,
    takerFeeRate: 0.0004,
    slippageBps: 2,
  },
} as const;

export const LFV_LIVE_PARITY_THRESHOLDS = {
  signalMatchRate: 0.95,
  scoreDelta: 0.5,
  priceRelativeError: 0.0025,
} as const;
