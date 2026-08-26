import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashWithoutField } from "@/lib/v5-7/manifest";
import {
  V7_BASELINE_COMMIT,
  V7_CONFIGURATIONS,
  V7_COST_MODEL,
  V7_DEVELOPMENT_END,
  V7_DEVELOPMENT_START,
  V7_DEVELOPMENT_SYMBOLS,
  V7_EMBARGO_HOURS,
  V7_FEATURE_DEFINITIONS,
  V7_FAMILIES,
  V7_PURGE_HOURS,
  V7_RESEARCH_END,
  V7_RESEARCH_RULES,
  V7_RESEARCH_START,
  V7_RISK_TEMPLATES,
  V7_SYMBOL_HOLDOUT,
  V7_TEMPORAL_END,
  V7_TEMPORAL_START,
  V7_UNIVERSE,
} from "@/lib/v7/registry";

const OUTPUT_PATH = resolve("reports/v7-registry.json");

async function main(): Promise<void> {
  const manifest: Record<string, unknown> = {
    schema: "bca-v7-registry-v1",
    status: "FROZEN_BEFORE_RETURN_READ",
    generatedAt: new Date().toISOString(),
    baselineCommit: V7_BASELINE_COMMIT,
    researchPeriod: { start: new Date(V7_RESEARCH_START).toISOString(), end: new Date(V7_RESEARCH_END).toISOString() },
    developmentPeriod: { start: new Date(V7_DEVELOPMENT_START).toISOString(), end: new Date(V7_DEVELOPMENT_END).toISOString() },
    temporalPeriod: { start: new Date(V7_TEMPORAL_START).toISOString(), end: new Date(V7_TEMPORAL_END).toISOString() },
    families: [...V7_FAMILIES],
    familyCount: V7_FAMILIES.length,
    configurations: V7_CONFIGURATIONS,
    configurationCount: V7_CONFIGURATIONS.length,
    riskTemplates: V7_RISK_TEMPLATES,
    riskTemplateCount: V7_RISK_TEMPLATES.length,
    featureDefinitions: [...V7_FEATURE_DEFINITIONS],
    featureCount: V7_FEATURE_DEFINITIONS.length,
    universe: [...V7_UNIVERSE],
    universeCount: V7_UNIVERSE.length,
    symbolHoldout: [...V7_SYMBOL_HOLDOUT],
    developmentSymbols: [...V7_DEVELOPMENT_SYMBOLS],
    costModel: V7_COST_MODEL,
    purgeHours: V7_PURGE_HOURS,
    embargoHours: V7_EMBARGO_HOURS,
    rules: [...V7_RESEARCH_RULES],
    researchOnly: true,
  };
  manifest.registryHash = hashWithoutField(manifest, "registryHash");
  await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v7_registry_frozen", baseline: V7_BASELINE_COMMIT, registryHash: manifest.registryHash, configurations: V7_CONFIGURATIONS.length, features: V7_FEATURE_DEFINITIONS.length, symbols: V7_UNIVERSE.length }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
