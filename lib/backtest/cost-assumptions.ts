import type { ExecutionDelay } from "./execution-stress";

/**
 * One named set of execution assumptions is shared by validation, stress
 * reports, and the promotion gate. Keeping these values together prevents a
 * report from comparing metrics that were produced with different costs.
 */
export interface ValidationCostAssumptions {
  takerFeeRate: number;
  baseSlippageBps: number;
  stressSlippageBps: number[];
  delayScenarios: ExecutionDelay[];
  maxHoldHours: number;
  maximumCvar95LossR: number;
}

export const DEFAULT_VALIDATION_COST_ASSUMPTIONS: ValidationCostAssumptions = {
  takerFeeRate: 0.0004,
  baseSlippageBps: 2,
  stressSlippageBps: [5, 10, 20],
  delayScenarios: ["T0", "T+5m", "T+15m"],
  maxHoldHours: 72,
  maximumCvar95LossR: 1.25,
};

export function validationCostAssumptions(input: Partial<ValidationCostAssumptions> = {}): ValidationCostAssumptions {
  return {
    ...DEFAULT_VALIDATION_COST_ASSUMPTIONS,
    ...input,
    stressSlippageBps: [...(input.stressSlippageBps ?? DEFAULT_VALIDATION_COST_ASSUMPTIONS.stressSlippageBps)],
    delayScenarios: [...(input.delayScenarios ?? DEFAULT_VALIDATION_COST_ASSUMPTIONS.delayScenarios)],
  };
}
