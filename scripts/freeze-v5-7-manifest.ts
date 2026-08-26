import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { sha256Json } from "@/lib/v5-7/manifest";
import {
  V57_BASE_SLIPPAGE_BPS,
  V57_COOLDOWN_HOURS,
  V57_EXTERNAL_END,
  V57_EXTERNAL_MANIFEST_ID,
  V57_EXTERNAL_START,
  V57_FEE_RATE,
  V57_MAX_SECOND_CANDIDATES,
  V57_PRIMARY_EDGE_FAMILY,
  V57_PRIMARY_EDGE_ID,
  V57_PRIMARY_ROLE,
  V57_RISK_PER_TRADE_USDT,
  V57_SECOND_EDGE_REGISTRY,
} from "@/lib/v5-7/research";

const REPORT_DIR = resolve("reports");
const MANIFEST_PATH = resolve(REPORT_DIR, "v5-7-research-manifest.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v5-7-candidate-registry.json");
const V57_MANIFEST_ID = "v57-second-edge-2021-01-01-2023-07-31";

async function main(): Promise<void> {
  const pitPath = resolve("data/pit-universe/binance-um-monthly-15m-index.json");
  const externalManifestPath = resolve("reports/v5-6-1-external-validation-manifest.json");
  const productionManifestPath = resolve("reports/v5-6-1-production-control-manifest.json");
  const pitSha256 = sha256Buffer(await readFile(pitPath));
  const externalManifest = JSON.parse(await readFile(externalManifestPath, "utf8")) as Record<string, unknown>;
  const productionManifest = JSON.parse(await readFile(productionManifestPath, "utf8")) as Record<string, unknown>;
  const registryHash = sha256Json(V57_SECOND_EDGE_REGISTRY);
  const manifest: Record<string, unknown> = {
    schema: "bca-v5-7-research-manifest-v1",
    status: "FROZEN_BEFORE_DATA_READ",
    manifestId: V57_MANIFEST_ID,
    frozenAt: "2026-08-26T00:00:00.000Z",
    researchBaseline: "75227fc91ce0c3cc29f0ec3df1862ff38131dec4",
    productionBaseline: productionManifest.productionCommit ?? "DATA_UNAVAILABLE",
    primaryEdge: {
      role: V57_PRIMARY_ROLE,
      id: V57_PRIMARY_EDGE_ID,
      family: V57_PRIMARY_EDGE_FAMILY,
      frozenNestedOos: { trades: 40, netR: 20.6614, avgR: 0.5165, profitFactor: 2.1017 },
      source: "reports/v5-6-1-promotion-decision.md",
      sourceSha256: sha256Buffer(await readFile(resolve("reports/v5-6-1-promotion-decision.md"))),
      parameterChangePolicy: "FROZEN; no V5.7 result may alter the Primary definition",
    },
    externalDataset: {
      manifestId: V57_EXTERNAL_MANIFEST_ID,
      manifestSha256: sha256Json(externalManifest),
      source: "Binance Data Vision USDT-M Futures monthly archives",
      sourceRoot: "https://data.binance.vision/data/futures/um/monthly",
      period: { start: new Date(V57_EXTERNAL_START).toISOString(), end: new Date(V57_EXTERNAL_END).toISOString() },
      timeframes: ["15m", "1h", "4h", "funding"],
      selectionUse: "EXTERNAL_VALIDATION_ONLY; NOT USED FOR CANDIDATE SELECTION",
      pitManifest: "data/pit-universe/binance-um-monthly-15m-index.json",
      pitManifestSha256: pitSha256,
    },
    secondEdgeRegistry: {
      maxCandidates: V57_MAX_SECOND_CANDIDATES,
      count: V57_SECOND_EDGE_REGISTRY.length,
      hash: registryHash,
      families: [...new Set(V57_SECOND_EDGE_REGISTRY.map((candidate) => candidate.family))],
      selectionPolicy: "Complete finite registry is frozen before data read; no candidate is added, removed, or tuned after results.",
      prohibitedFamily: "FAILED_BREAKOUT_REVERSAL",
    },
    execution: {
      signalData: "Only the closed 15m signal candle and already-closed higher-timeframe features may affect a trigger.",
      entryReference: "The next contiguous 15m candle open is the only execution reference; no signal-close fallback.",
      contiguousBoundary: "execution.openTime == signal.closeTime + 1ms",
      source: "BINANCE_15M_NEXT_BAR_OPEN",
    },
    costs: {
      takerFeeRate: V57_FEE_RATE,
      baseSlippageBps: V57_BASE_SLIPPAGE_BPS,
      riskPerTradeUsdt: V57_RISK_PER_TRADE_USDT,
      cooldownHours: V57_COOLDOWN_HOURS,
    },
    productionBoundary: {
      researchOnly: true,
      noProductionChange: true,
      noProductionEmail: true,
      noEnvironmentChange: true,
      noMigration: true,
      noDeployment: true,
      noMerge: true,
      noAutoTrading: true,
    },
  };
  const report = { ...manifest, manifestHash: sha256Json(manifest) };
  const registryReport = {
    schema: "bca-v5-7-candidate-registry-v1",
    status: "FROZEN_BEFORE_DATA_READ",
    manifestId: V57_MANIFEST_ID,
    registryHash,
    maxCandidates: V57_MAX_SECOND_CANDIDATES,
    candidateCount: V57_SECOND_EDGE_REGISTRY.length,
    families: [...new Set(V57_SECOND_EDGE_REGISTRY.map((candidate) => candidate.family))],
    candidates: V57_SECOND_EDGE_REGISTRY,
    primaryControl: { id: V57_PRIMARY_EDGE_ID, family: V57_PRIMARY_EDGE_FAMILY, frozen: true },
    selectionPolicy: "Finite preregistration; results cannot alter the registry.",
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registryReport, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v5_7_manifest_frozen", manifestId: V57_MANIFEST_ID, manifestHash: report.manifestHash, registryHash }));
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

void main();
