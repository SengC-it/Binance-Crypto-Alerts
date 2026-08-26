import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V58_BASE_SLIPPAGE_BPS,
  V58_BURNED_EXTERNAL_END,
  V58_BURNED_EXTERNAL_START,
  V58_COOLDOWN_HOURS,
  V58_DEV_START,
  V58_FEE_RATE,
  V58_FRESH_END,
  V58_FRESH_MANIFEST_ID,
  V58_FRESH_START,
  V58_FRESH_SYMBOLS,
  V58_FRESH_SYMBOL_EFFECTIVE_STARTS,
  V58_LOCAL_DEVELOPMENT_END,
  V58_LOCAL_DEVELOPMENT_START,
  V58_MAX_REGIME_GATES,
  V58_PRIMARY_EDGE_FAMILY,
  V58_PRIMARY_EDGE_ID,
  V58_REGIME_GATE_REGISTRY,
  V58_RISK_PER_TRADE_USDT,
} from "@/lib/v5-8/regime";
import { hashWithoutField, sha256Json } from "@/lib/v5-7/manifest";

const REPORT_DIR = resolve("reports");
const V57_MANIFEST_PATH = resolve(REPORT_DIR, "v5-7-research-manifest.json");
const FRESH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-8-fresh-validation-manifest.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v5-8-regime-gate-registry.json");
const RESEARCH_MANIFEST_PATH = resolve(REPORT_DIR, "v5-8-research-manifest.json");
const FROZEN_AT = "2026-08-26T00:00:00.000Z";
const BASELINE_COMMIT = "cc5d31e4e9984edafb7b077ef334e07a3f7391d4";

async function main(): Promise<void> {
  const v57Manifest = JSON.parse(await readFile(V57_MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  assertV57Manifest(v57Manifest);
  const registryHash = sha256Json(V58_REGIME_GATE_REGISTRY);
  if (V58_REGIME_GATE_REGISTRY.length !== V58_MAX_REGIME_GATES) throw new Error("V5.8 regime registry count changed");

  const freshManifestBody = {
    schema: "bca-v5-8-fresh-validation-manifest-v1",
    status: "FROZEN_BEFORE_DATA_READ",
    manifestId: V58_FRESH_MANIFEST_ID,
    frozenAt: FROZEN_AT,
    source: "BINANCE_USDT_M_FUTURES_DATA_VISION",
    sourceRoot: "https://data.binance.vision/data/futures/um/monthly",
    exchange: "Binance USDT-M Futures",
    symbols: [...V58_FRESH_SYMBOLS],
    contractEligibility: V58_FRESH_SYMBOLS.map((symbol) => ({ symbol, effectiveStart: new Date(V58_FRESH_SYMBOL_EFFECTIVE_STARTS[symbol]).toISOString(), effectiveEnd: new Date(V58_FRESH_END).toISOString() })),
    period: { start: new Date(V58_FRESH_START).toISOString(), end: new Date(V58_FRESH_END).toISOString() },
    timeframes: ["15m", "1h", "4h", "funding"],
    pointInTimeRule: "Only contracts with a frozen 2020 listing window are pre-registered; no symbol is added after return data is read.",
    execution: {
      signal: "closed 15m candle only",
      entryReference: "next contiguous 15m candle open",
      contiguousBoundary: "execution.openTime == signal.closeTime + 1ms",
      source: "BINANCE_15M_NEXT_BAR_OPEN",
      noLookahead: "The next candle contributes only openTime and open to execution reference; its high/low/close/volume never affect signal detection.",
    },
    costs: {
      takerFeeRate: V58_FEE_RATE,
      baseSlippageBps: V58_BASE_SLIPPAGE_BPS,
      riskPerTradeUsdt: V58_RISK_PER_TRADE_USDT,
      cooldownHours: V58_COOLDOWN_HOURS,
    },
    selectionUse: "VALIDATION_ONLY; excluded from diagnosis, gate selection, and parameter selection",
    rawCache: "data/raw/v5-8-fresh-cache/archives (ignored; never committed)",
  };
  const freshManifest = { ...freshManifestBody, manifestHash: sha256Json(freshManifestBody) };
  const registryReportBody = {
    schema: "bca-v5-8-regime-gate-registry-v1",
    status: "FROZEN_BEFORE_DATA_READ",
    manifestId: "v58-regime-gate-registry-01",
    frozenAt: FROZEN_AT,
    maxCandidates: V58_MAX_REGIME_GATES,
    candidateCount: V58_REGIME_GATE_REGISTRY.length,
    registryHash,
    candidates: V58_REGIME_GATE_REGISTRY,
    primaryControl: { id: V58_PRIMARY_EDGE_ID, family: V58_PRIMARY_EDGE_FAMILY, frozen: true },
    selectionPolicy: "Finite eight-gate registry is frozen before gated or fresh results; no Cartesian search and no result-based gate changes.",
  };
  const registryReport = { ...registryReportBody, reportHash: sha256Json(registryReportBody) };
  const researchManifestBody = {
    schema: "bca-v5-8-research-manifest-v1",
    status: "FROZEN_BEFORE_DATA_READ",
    manifestId: "v58-regime-dependency-reconstruction-01",
    frozenAt: FROZEN_AT,
    baselineCommit: BASELINE_COMMIT,
    priorFrozenStage: {
      branch: "feat/v5-7-second-edge-data-completion",
      head: BASELINE_COMMIT,
      manifestPath: "reports/v5-7-research-manifest.json",
      manifestHash: v57Manifest.manifestHash,
      resultsPolicy: "V5.7 results remain unchanged; 2021-01-01 through 2023-07-31 is BURNED_EXTERNAL_DIAGNOSTIC, not fresh validation.",
    },
    primary: {
      role: "PRIMARY_EDGE_CONTROL",
      id: V58_PRIMARY_EDGE_ID,
      family: V58_PRIMARY_EDGE_FAMILY,
      frozen: true,
      parameterChange: "NO",
      tradePlan: "The existing runIndependentCandidate/buildStructuralPlan path is reused unchanged.",
    },
    pools: {
      development: {
        start: new Date(V58_DEV_START).toISOString(),
        end: new Date(V58_LOCAL_DEVELOPMENT_END).toISOString(),
        burnedExternalStart: new Date(V58_BURNED_EXTERNAL_START).toISOString(),
        burnedExternalEnd: new Date(V58_BURNED_EXTERNAL_END).toISOString(),
        localStart: new Date(V58_LOCAL_DEVELOPMENT_START).toISOString(),
        use: "Diagnosis, inner gate selection, and nested walk-forward only",
      },
      fresh: {
        manifestId: V58_FRESH_MANIFEST_ID,
        manifestHash: freshManifest.manifestHash,
        use: "Fresh validation only; never used for selection",
      },
    },
    regimeGateRegistry: {
      path: "reports/v5-8-regime-gate-registry.json",
      count: V58_REGIME_GATE_REGISTRY.length,
      maxCandidates: V58_MAX_REGIME_GATES,
      hash: registryHash,
      policy: "Gates filter the frozen Primary; they do not change signal, entry, stop, TP, risk, or costs.",
    },
    promotionGates: {
      nested: {
        trades: ">= 50",
        netR: "> 0",
        avgR: "> 0",
        profitFactor: ">= 1.30",
        positiveFoldRatio: ">= 0.67",
        medianFoldNetR: "> 0",
        plus10BpsNetR: "> 0",
        selectionAdjustedLcb95: ">= 0",
        promotionLcb95: ">= 0",
      },
      fresh: { trades: ">= 20", netR: "> 0", avgR: "> 0", profitFactor: "> 1" },
      yield: { alertsPerMonth: ">= 2", activeMonthRatio: ">= 0.65", medianAlertsPerMonth: ">= 1", p95DroughtDays: "<= 45", maxDroughtDays: "<= 60" },
    },
    productionBoundary: {
      researchOnly: true,
      noProductionChange: true,
      noV55Change: true,
      noProductionEmail: true,
      noEnvironmentChange: true,
      noMigration: true,
      noDeployment: true,
      noMerge: true,
      noAutoTrading: true,
    },
  };
  const researchManifest = { ...researchManifestBody, manifestHash: sha256Json(researchManifestBody) };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(FRESH_MANIFEST_PATH, `${JSON.stringify(freshManifest, null, 2)}\n`, "utf8");
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registryReport, null, 2)}\n`, "utf8");
  await writeFile(RESEARCH_MANIFEST_PATH, `${JSON.stringify(researchManifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_8_manifests_frozen", freshManifestHash: freshManifest.manifestHash, registryHash, researchManifestHash: researchManifest.manifestHash }));
}

function assertV57Manifest(manifest: Record<string, unknown>): void {
  if (manifest.status !== "FROZEN_BEFORE_DATA_READ") throw new Error("V5.7 manifest is not frozen");
  if (typeof manifest.manifestHash !== "string" || hashWithoutField(manifest, "manifestHash") !== manifest.manifestHash) throw new Error("V5.7 manifest integrity check failed");
  if (manifest.manifestId !== "v57-second-edge-2021-01-01-2023-07-31") throw new Error("Unexpected V5.7 manifest identity");
}

void main();
