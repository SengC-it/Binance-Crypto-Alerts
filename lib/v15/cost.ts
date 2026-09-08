import { V15_CONSTANTS } from "@/lib/v15/lead-lag";

export interface V15CostBreakdown {
  feesR: number;
  slippageR: number;
  stressR: number;
  netR: number;
}

export function roundTripCostR(entryPrice: number, riskPrice: number, bpsPerSide: number): number {
  return (2 * entryPrice * bpsPerSide / 10_000) / riskPrice;
}

export function calculateV15Cost(entryPrice: number, riskPrice: number, grossR: number, fundingR: number, stressRoundTripBps = 0): V15CostBreakdown {
  const feesR = roundTripCostR(entryPrice, riskPrice, V15_CONSTANTS.takerFeeBpsPerSide);
  const slippageR = roundTripCostR(entryPrice, riskPrice, V15_CONSTANTS.baseSlippageBpsPerSide);
  const stressR = (2 * entryPrice * stressRoundTripBps / 10_000) / riskPrice;
  return { feesR, slippageR, stressR, netR: grossR + fundingR - feesR - slippageR - stressR };
}
