import { V22_EXPERIMENT_ID } from "@/lib/v22/types";

export const V22_FAMILY = "cross-venue same-instrument price discovery" as const;
export const V22_INFORMATION_SOURCE_CLASS = "CROSS_EXCHANGE_PRICE_DISCOVERY" as const;
export const V22_DIMENSIONS = ["cross_venue_structure", "information_source", "causal_timing"] as const;

const LEGACY_FAMILY_NAMES = new Set([
  "breakout",
  "failed breakout",
  "spot perp lead lag",
  "crowded positioning failed continuation reversal",
  "taker flow absorption reversal",
  "derivatives flow alpha",
  "cross sectional",
  "cross sectional idiosyncratic jump reversal",
  "last price mark price dislocation convergence",
]);

export function normalizeFamilyName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

export interface V22AdmissionInput {
  experimentId: string;
  family: string;
  informationSourceClass: string;
}

export function isFamilyInAuthoritativeRegistry(
  family: string,
  registryFamilies: readonly string[],
): boolean {
  const normalized = normalizeFamilyName(family);
  return registryFamilies.some((entry) => normalizeFamilyName(entry) === normalized);
}

export function admitV22Family(input: V22AdmissionInput): { status: "PASS" | "FAIL"; reason: string } {
  const normalized = normalizeFamilyName(input.family);
  if (LEGACY_FAMILY_NAMES.has(normalized)) {
    return { status: "FAIL", reason: "legacy family is not eligible for retuning or re-entry" };
  }
  if (
    input.experimentId !== V22_EXPERIMENT_ID ||
    normalized !== normalizeFamilyName(V22_FAMILY) ||
    input.informationSourceClass !== V22_INFORMATION_SOURCE_CLASS
  ) {
    return { status: "FAIL", reason: "V22 family identity or information source mismatch" };
  }
  return { status: "PASS", reason: "new cross-venue family is structurally orthogonal" };
}
