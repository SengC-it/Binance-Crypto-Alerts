import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE = "7b9e5d82f471ee3c9fec07e00101263c8d84e953";
const REPORT_DIR = resolve("reports");
const REPORTS = [
  "lfv-001-freeze-manifest.json",
  "lfv-001-data-gate.json",
  "lfv-001-replay-parity.json",
  "lfv-001-factor-results.json",
  "lfv-001-combined-results.json",
  "lfv-001-holdouts.json",
  "lfv-001-decision.json",
  "lfv-001-decision.md",
  "lfv-001-evidence-manifest.json",
];

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const contents = new Map<string, string>();
  for (const report of REPORTS) contents.set(report, await readFile(resolve(REPORT_DIR, report), "utf8"));
  const freeze = JSON.parse(contents.get("lfv-001-freeze-manifest.json")!) as Record<string, unknown>;
  const { freezeSha256, ...freezeCore } = freeze;
  assertCondition(freezeSha256 === sha256(stableStringify(freezeCore)), "freeze manifest hash mismatch");
  assertCondition((freezeCore.baseline as { sha?: string }).sha === BASELINE, "freeze baseline mismatch");
  assertCondition((freezeCore.observations as { usage?: string }).usage?.includes("LIVE_OBSERVATION_ONLY"), "live observation boundary missing");
  assertCondition((freezeCore.boundary as { privateBinanceApi?: boolean }).privateBinanceApi === false, "private API boundary failed");

  const dataGate = JSON.parse(contents.get("lfv-001-data-gate.json")!) as Record<string, unknown>;
  const decision = JSON.parse(contents.get("lfv-001-decision.json")!) as Record<string, unknown>;
  assertCondition(dataGate.schema === "bca-lfv-001-data-gate-v1", "data gate schema mismatch");
  assertCondition(dataGate.pass === false && dataGate.code === "LFV_DATA_INSUFFICIENT", "data gate must fail closed for the current evidence set");
  assertCondition(decision.status === "LFV_DATA_INSUFFICIENT" && decision.researchStop === true, "decision is not fail-closed");
  const production = decision.production as Record<string, unknown>;
  assertCondition(production.changed === false && production.email === "OFF" && production.autoTrading === false, "production boundary changed");
  assertCondition(production["#002"] === "STOPPED" && production.v14 === "UNCHANGED", "research boundary missing");

  const evidence = JSON.parse(contents.get("lfv-001-evidence-manifest.json")!) as { reports?: Array<{ path: string; bytes: number; sha256: string }> };
  assertCondition(evidence.reports?.length === REPORTS.length - 1, "evidence manifest report count mismatch");
  for (const item of evidence.reports ?? []) {
    const name = item.path.replace(/^reports\//, "");
    assertCondition(contents.has(name), `evidence manifest references missing report ${name}`);
    const content = contents.get(name)!;
    assertCondition(item.bytes === Buffer.byteLength(content), `byte count mismatch for ${name}`);
    assertCondition(item.sha256 === sha256(content), `content hash mismatch for ${name}`);
  }
  console.info(JSON.stringify({ ok: true, status: "LFV_DATA_INSUFFICIENT", reports: REPORTS.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
