import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const BRANCH = "feat/v15-spot-perp-lead-lag";
const REPORT_DIR = resolve("reports");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as Record<string, unknown>;
}

function fail(message: string): never {
  throw new Error(`V15 artifact validation failed: ${message}`);
}

async function main(): Promise<void> {
  const manifest = await readJson("v15-freeze-manifest.json");
  const manifestHash = manifest.manifestSha256;
  const manifestBody = { ...manifest };
  delete manifestBody.manifestSha256;
  if (typeof manifestHash !== "string" || manifestHash !== hash(JSON.stringify(manifestBody))) fail("freeze manifest SHA-256 mismatch");
  if (manifest.baseline !== BASELINE) fail("baseline drift");
  if (manifest.branch !== BRANCH) fail("branch drift");
  if (manifest.status !== "FROZEN_BEFORE_RETURNS") fail("manifest is not marked frozen before returns");
  if (manifest.historicalReturnsRead !== false) fail("freeze manifest claims returns were read");

  const dataGate = await readJson("v15-data-gate.json");
  if (dataGate.baseline !== BASELINE || dataGate.branch !== BRANCH) fail("data gate identity drift");
  if (dataGate.historicalReturnsRead !== false) fail("data gate claims returns were read");
  if (dataGate.status !== "V15_DATA_INSUFFICIENT" && dataGate.status !== "PASS") fail("unknown data gate status");

  let result: Record<string, unknown> | null = null;
  try {
    result = await readJson("v15-validation-summary.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (result) {
    if (result.baseline !== BASELINE || result.branch !== BRANCH) fail("result identity drift");
    if (result.freezeSha256 !== manifestHash) fail("result does not reference the frozen manifest");
    if (result.historicalReturnsRead !== false) fail("result claims returns were read");
    if (result.emailPromotionCandidate !== "FAIL") fail("promotion result is not fail-closed");
    if (result.researchStop !== "YES") fail("research stop is not recorded");
    for (const file of ["v15-oos-results.json", "v15-holdouts.json", "v15-placebos.json", "v15-manual-delay.json", "v15-cost-attribution.json", "v15-promotion-decision.json", "v15-promotion-decision.md", "v15-evidence-manifest.json"]) await readFile(resolve(REPORT_DIR, file));
  }
  console.info(JSON.stringify({ artifact: "v15", status: "PASS", freezeSha256: manifestHash, resultWritten: Boolean(result), historicalReturnsRead: false }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
