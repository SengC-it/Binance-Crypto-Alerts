import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LFV_BASELINE_SHA, LFV_COMBINED_PRIMARY, LFV_HYPOTHESES } from "@/lib/lfv/loss-factors";

const REPORT_DIR = resolve("reports");
const ORIGINAL_FREEZE_COMMIT = "d68737cbd27c38e8fb09812ab225cfaaec56f037";
const ORIGINAL_FREEZE_SHA256 = "1bd06d9317203488eef599180f52dd66ecc1d15c87b6dca4ef382daf2dc901f9";
const REQUIRED_REPORTS = [
  "lfv-001-freeze-manifest.json",
  "lfv-001-data-freeze-v2.json",
  "lfv-001-archive-registry.json",
  "lfv-001-pit-universe.json",
  "lfv-001-data-gate.json",
  "lfv-001-replay-parity.json",
  "lfv-001-factor-results.json",
  "lfv-001-combined-results.json",
  "lfv-001-holdouts.json",
  "lfv-001-decision.json",
  "lfv-001-decision.md",
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
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

async function main(): Promise<void> {
  const contents = new Map<string, string>();
  for (const report of [...REQUIRED_REPORTS, "lfv-001-evidence-manifest.json"]) {
    contents.set(report, await readFile(resolve(REPORT_DIR, report), "utf8"));
  }
  const parse = (name: string) => JSON.parse(contents.get(name)!) as Record<string, unknown>;

  const original = parse("lfv-001-freeze-manifest.json");
  const { freezeSha256: originalHash, ...originalCore } = original;
  assertCondition(originalHash === ORIGINAL_FREEZE_SHA256, "original freeze SHA256 changed");
  assertCondition(originalHash === sha256(stableStringify(originalCore)), "original freeze manifest hash mismatch");
  assertCondition((originalCore.baseline as { sha?: string }).sha === LFV_BASELINE_SHA, "original freeze baseline mismatch");

  const freeze = parse("lfv-001-data-freeze-v2.json");
  const { freezeSha256: v2Hash, ...v2Core } = freeze;
  assertCondition(v2Hash === sha256(stableStringify(v2Core)), "data freeze v2 hash mismatch");
  assertCondition(freeze.schema === "bca-lfv-001-data-freeze-v2" && freeze.status === "FROZEN_BEFORE_RETURN_READ", "data freeze v2 status/schema mismatch");
  assertCondition(freeze.originalFreezeCommit === ORIGINAL_FREEZE_COMMIT, "data freeze v2 original commit mismatch");
  assertCondition(freeze.originalFreezeSHA256 === ORIGINAL_FREEZE_SHA256, "data freeze v2 original hash mismatch");
  assertCondition(freeze.returnsRead === false, "data freeze v2 returns-read boundary failed");
  const originalHypotheses = originalCore.hypotheses as Record<string, unknown>;
  const freezeHypothesisHashes = freeze.hypothesisHashes as Record<string, unknown>;
  for (const key of ["H1", "H2", "H3", "H4"]) {
    assertCondition(sameJson((freeze.hypotheses as Record<string, unknown>)[key], originalHypotheses[key]), `${key} definition changed`);
    assertCondition(freezeHypothesisHashes[key] === sha256(stableStringify(originalHypotheses[key])), `${key} hash mismatch`);
  }
  assertCondition(sameJson(freeze.combinedDefinition, LFV_COMBINED_PRIMARY), "combined definition changed");
  assertCondition(freeze.combinedDefinitionHash === sha256(stableStringify(LFV_COMBINED_PRIMARY)), "combined definition hash mismatch");
  const freezeGates = freeze.gateDefinition as Record<string, unknown>;
  const originalGates = originalCore.gates as Record<string, unknown>;
  for (const [key, value] of Object.entries(originalGates)) assertCondition(sameJson(freezeGates[key], value), `original gate changed: ${key}`);
  assertCondition(freeze.archiveRegistryHash && freeze.pitUniverseRuleHash && freeze.dataPipelineDefinitionHash, "v2 provenance hashes missing");

  const registry = parse("lfv-001-archive-registry.json");
  const { registrySha256, ...registryCore } = registry;
  assertCondition(registry.schema === "bca-lfv-001-archive-registry-v2" && registry.status === "FROZEN_BEFORE_RETURN_READ", "archive registry schema/status mismatch");
  assertCondition(registry.baseline === LFV_BASELINE_SHA, "archive registry baseline mismatch");
  assertCondition(registrySha256 === sha256(stableStringify(registryCore)), "archive registry hash mismatch");
  assertCondition(registrySha256 === freeze.archiveRegistryHash, "freeze/archive registry hash mismatch");
  const enumeration = registry.enumeration as Record<string, unknown>;
  assertCondition(enumeration.pagination === "COMPLETE" && enumeration.liveS3Listing === true && enumeration.currentExchangeInfoUsedForHistory === false, "official archive enumeration is not complete PIT-safe evidence");
  const symbols = registry.symbols as Array<Record<string, unknown>>;
  assertCondition(symbols.length === (registry.historicalSymbols as string[]).length && symbols.length > 0, "archive registry symbols missing");
  for (const symbol of symbols) {
    assertCondition(typeof symbol.symbol === "string", "archive registry symbol missing");
    assertCondition(["DISCOVERY_ONLY_NOT_DOWNLOADED", "USED_ARCHIVES_VERIFIED", "FAILED"].includes(String(symbol.checksumStatus)), `archive checksum status missing for ${String(symbol.symbol)}`);
  }

  const pit = parse("lfv-001-pit-universe.json");
  assertCondition(pit.schema === "bca-lfv-001-pit-universe-v2" && pit.baseline === LFV_BASELINE_SHA, "PIT snapshot schema/baseline mismatch");
  assertCondition(pit.registrySha256 === registrySha256 && pit.noFutureLifecycle === true, "PIT provenance/future lifecycle boundary failed");

  const dataGate = parse("lfv-001-data-gate.json");
  assertCondition(dataGate.schema === "bca-lfv-001-data-gate-v2" && dataGate.baseline === LFV_BASELINE_SHA, "data gate schema/baseline mismatch");
  assertCondition(typeof dataGate.pass === "boolean" && dataGate.status === (dataGate.pass ? "PASS" : "FAIL"), "data gate status is inconsistent");
  assertCondition(dataGate.archiveEnumeration && (dataGate.archiveEnumeration as Record<string, unknown>).registrySha256 === registrySha256, "data gate registry provenance mismatch");
  const live = dataGate.liveObservations as Record<string, unknown>;
  assertCondition(live.count === 44 && live.treatment === "EXCLUDED_FROM_RETURNS", "August live observations entered the returns boundary");

  const decision = parse("lfv-001-decision.json");
  const acceptedCodes = ["LFV_DATA_INSUFFICIENT_FINAL", "LFV_REPLAY_PARITY_FAIL"];
  assertCondition(acceptedCodes.includes(String(decision.status)) && decision.finalClassification === decision.status, "decision classification is not a frozen fail-closed result");
  assertCondition(decision.researchStop === true && decision.returnsRead === false, "research/returns boundary failed");
  assertCondition(decision.dataGate === dataGate.status, "decision data gate status mismatch");
  if (dataGate.pass === false) assertCondition(decision.status === "LFV_DATA_INSUFFICIENT_FINAL", "failed data gate did not stop with LFV_DATA_INSUFFICIENT_FINAL");
  const production = decision.production as Record<string, unknown>;
  assertCondition(production.changed === false && production.email === "OFF" && production.autoTrading === false && production.privateBinanceApi === false, "Production boundary changed");
  assertCondition(production["#002"] === "STOPPED" && production.v14 === "UNCHANGED", "research boundary missing");

  const evidence = parse("lfv-001-evidence-manifest.json");
  assertCondition(evidence.schema === "bca-lfv-001-evidence-manifest-v2" && evidence.baseline === LFV_BASELINE_SHA && evidence.returnsRead === false, "evidence manifest schema/boundary mismatch");
  const reports = evidence.reports as Array<{ path: string; bytes: number; sha256: string }>;
  assertCondition(reports.length === REQUIRED_REPORTS.length, "evidence manifest report count mismatch");
  assertCondition(new Set(reports.map((item) => item.path)).size === REQUIRED_REPORTS.length, "evidence manifest contains duplicate reports");
  for (const item of reports) {
    const name = item.path.replace(/^reports\//, "");
    assertCondition(REQUIRED_REPORTS.includes(name), `evidence manifest references unexpected report ${name}`);
    const content = contents.get(name);
    assertCondition(content !== undefined, `evidence manifest references missing report ${name}`);
    assertCondition(item.bytes === Buffer.byteLength(content), `byte count mismatch for ${name}`);
    assertCondition(item.sha256 === sha256(content), `content hash mismatch for ${name}`);
  }
  console.info(JSON.stringify({ ok: true, status: decision.status, dataGate: dataGate.status, reports: reports.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
