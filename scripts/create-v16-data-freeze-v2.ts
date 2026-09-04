import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256File } from "../lib/v16/data-engine";
import { V16_BASELINE, V16_BRANCH } from "../lib/v16/data-gate";

const REPORT_DIR = resolve("reports");
const FREEZE_V1 = resolve(REPORT_DIR, "v16-freeze-manifest.json");
const FREEZE_V2 = resolve(REPORT_DIR, "v16-data-freeze-v2.json");
const INVENTORY = resolve("data/raw/v16-aggtrade-absorption/official-inventory.json");
const CACHE_MANIFEST = resolve("data/raw/v16-aggtrade-absorption/manifest.json");

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function alphaBody(freeze: Record<string, unknown>): Record<string, unknown> {
  return { flowFeatures: freeze.flowFeatures, absorption: freeze.absorption, decisionClock: freeze.decisionClock, risk: freeze.risk, costs: freeze.costs, manualDelay: freeze.manualDelay, validation: freeze.validation, placebos: freeze.placebos, gates: freeze.gates };
}

async function main(): Promise<void> {
  const original = await readJson(FREEZE_V1);
  const originalManifestSha = original.manifestSha256;
  if (original.baseline !== V16_BASELINE || original.branch !== V16_BRANCH || original.status !== "FROZEN_BEFORE_RETURNS" || original.historicalReturnsRead !== false || typeof originalManifestSha !== "string") throw new Error("Original V16 Freeze is not valid or claims historical returns were read");
  if (originalManifestSha !== "b9af07c66b1890acc9090a947b4e510fdb5b2dada749aec14fce4cea5f876f8f") throw new Error(`Original V16 Freeze SHA drift: ${originalManifestSha}`);
  const inventory = await readJson(INVENTORY);
  const cacheManifest = await readJson(CACHE_MANIFEST);
  const sourceFiles = {
    materializer: await sha256File(resolve("scripts/materialize-v16-official-data.ts")),
    dataEngine: await sha256File(resolve("lib/v16/data-engine.ts")),
    dataGate: await sha256File(resolve("lib/v16/data-gate.ts")),
  };
  const semantics = {
    funding: "Use only official fundingRate calc_time rows; no fixed 8h clock; no row means no settlement and funding=0; occurred-but-missing archive is DATA_UNAVAILABLE.",
    mark: "Use only official markPriceKlines 5m candle containing an actual funding timestamp; no synthetic or forward-filled mark input.",
    features: "At each 15m decision T use only aggTrades timestamp<T and closed 5m bars ending before T; trailing 30m window and trailing 60d PIT quantiles.",
    execution: "Use the first complete futures 5m open after T; never use the signal candle close as execution price.",
  };
  const body = {
    schema: "v16-data-freeze-v2",
    status: "FROZEN_BEFORE_RETURNS",
    generatedAt: new Date().toISOString(),
    baseline: V16_BASELINE,
    branch: V16_BRANCH,
    originalFreeze: { commit: "da77ba6c83e9066658d331972353d05b8341c152", manifestSha256: originalManifestSha },
    officialEnumeration: { path: "data/raw/v16-aggtrade-absorption/official-inventory.json", enumerationSha256: inventory.enumerationSha256, inventoryFileSha256: await sha256File(INVENTORY), expectedSlots: inventory.expectedSlots, officialAvailableSlots: inventory.officialAvailableSlots, officialUnavailableSlots: inventory.officialUnavailableSlots, checksumUnavailableSlots: inventory.checksumUnavailableSlots },
    cacheManifest: { path: "data/raw/v16-aggtrade-absorption/manifest.json", sha256: await sha256File(CACHE_MANIFEST), schema: cacheManifest.schema, sealed: cacheManifest.sealed },
    sourceFiles,
    semantics: { ...semantics, fundingSha256: hashText(semantics.funding), markSha256: hashText(semantics.mark), featureSha256: hashText(semantics.features), executionSha256: hashText(semantics.execution) },
    alphaRules: { unchanged: true, originalSha256: hashText(JSON.stringify(alphaBody(original))), currentSha256: hashText(JSON.stringify(alphaBody(original))) },
    historicalReturnsRead: false,
    boundaries: { productionEmail: "OFF", productionChanged: false, deploy: false, merge: false, migration: false, autoTrading: false, privateBinanceApi: false, orderPlacement: false },
  };
  const existing = await readFile(FREEZE_V2, "utf8").catch(() => null);
  if (existing !== null) {
    const current = JSON.parse(existing) as Record<string, unknown>;
    if (current.schema !== body.schema || current.originalFreeze === undefined || JSON.stringify(current.originalFreeze) !== JSON.stringify(body.originalFreeze) || current.historicalReturnsRead !== false) throw new Error("Existing V16 data Freeze v2 is immutable and does not match the original Freeze");
    console.info(JSON.stringify({ phase: "v16-data-freeze-v2", status: "ALREADY_FROZEN", path: FREEZE_V2, historicalReturnsRead: false }));
    return;
  }
  const manifest = { ...body, manifestSha256: hashText(JSON.stringify(body)) };
  await writeFile(FREEZE_V2, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ phase: "v16-data-freeze-v2", status: manifest.status, manifestSha256: manifest.manifestSha256, historicalReturnsRead: manifest.historicalReturnsRead }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
