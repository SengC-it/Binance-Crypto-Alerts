import { nearestRankQuantile, V21_PIT_OBSERVATION_COUNT } from "./features";

export const V21_Q99_RANK = Math.ceil(0.99 * V21_PIT_OBSERVATION_COUNT);
export const V21_Q99_TAIL_COUNT = V21_PIT_OBSERVATION_COUNT - V21_Q99_RANK;

export interface V21ExtremePredicateInput {
  priorResiduals: ArrayLike<number>;
  previousResidual: number;
  currentResidual: number;
}

export interface V21ExtremePredicateResult {
  currentExtreme: boolean;
  residualComparisons: number;
  earlyExit: boolean;
  exactThresholdComputed: boolean;
  residualAbsQ99: number | null;
  previousInside: boolean | null;
  firstCross: boolean | null;
}

export function evaluateExactExtremePredicate(
  input: V21ExtremePredicateInput,
): V21ExtremePredicateResult {
  if (input.priorResiduals.length !== V21_PIT_OBSERVATION_COUNT) {
    throw new Error(`Expected ${V21_PIT_OBSERVATION_COUNT} prior residuals`);
  }
  if (!Number.isFinite(input.previousResidual) || !Number.isFinite(input.currentResidual)) {
    throw new Error("Current and previous residuals must be finite");
  }
  for (let index = 0; index < input.priorResiduals.length; index += 1) {
    if (!Number.isFinite(input.priorResiduals[index])) throw new Error("Prior residuals must be finite");
  }

  const currentAbs = Math.abs(input.currentResidual);
  let greaterCount = 0;
  for (let index = 0; index < input.priorResiduals.length; index += 1) {
    if (Math.abs(input.priorResiduals[index]) > currentAbs) {
      greaterCount += 1;
      if (greaterCount > V21_Q99_TAIL_COUNT) {
        return {
          currentExtreme: false,
          residualComparisons: index + 1,
          earlyExit: true,
          exactThresholdComputed: false,
          residualAbsQ99: null,
          previousInside: null,
          firstCross: null,
        };
      }
    }
  }

  const absoluteResiduals: number[] = [];
  for (let index = 0; index < input.priorResiduals.length; index += 1) {
    absoluteResiduals.push(Math.abs(input.priorResiduals[index]));
  }
  const residualAbsQ99 = nearestRankQuantile(absoluteResiduals, 0.99);
  const previousInside = Math.abs(input.previousResidual) < residualAbsQ99;
  return {
    currentExtreme: true,
    residualComparisons: input.priorResiduals.length,
    earlyExit: false,
    exactThresholdComputed: true,
    residualAbsQ99,
    previousInside,
    firstCross: previousInside && currentAbs >= residualAbsQ99,
  };
}
