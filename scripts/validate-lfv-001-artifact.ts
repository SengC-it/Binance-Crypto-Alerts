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
  "lfv-001-data-gate.json",
  "lfv-001-replay-freeze-v3.json",
  "lfv-001-replay-freeze-v4.json",
  "lfv-001-observed-universe-evidence-v1.json",
  "lfv-001-live-parity-input-v1.json",
  "lfv-001-live-signal-universe-v2.json",
  "lfv-001-final-execution-freeze.json",
  "lfv-001-universe-parity.json",
  "lfv-001-live-parity.json",
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

async function readReport(name: string): Promise<string> {
  return readFile(resolve(REPORT_DIR, name), "utf8");
}

function sha256(value: string): string {
  return require("node:crypto").createHash("sha256").update(value, "utf8").digest("hex") as string;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

async function main(): Promise<void> {
  const contents = new Map<string, string>();
  for (const report of [...REQUIRED_REPORTS, "lfv-001-evidence-manifest.json"]) contents.set(report, await readReport(report));
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
  assertCondition(freeze.originalFreezeCommit === ORIGINAL_FREEZE_COMMIT && freeze.originalFreezeSHA256 === ORIGINAL_FREEZE_SHA256, "data freeze v2 original provenance mismatch");
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

  const replayFreeze = parse("lfv-001-replay-freeze-v3.json");
  const replayHash = replayFreeze.freezeSha256;
  const replayCore = Object.fromEntries(Object.entries(replayFreeze).filter(([key]) => key !== "freezeSha256" && key !== "generatedAt"));
  assertCondition(replayFreeze.schema === "bca-lfv-001-replay-freeze-v3" && replayFreeze.status === "FROZEN_BEFORE_RETURN_READ", "replay freeze v3 status/schema mismatch");
  assertCondition(replayHash === sha256(stableStringify(replayCore)), "replay freeze v3 hash mismatch");
  assertCondition(replayFreeze.originalFreezeCommit === ORIGINAL_FREEZE_COMMIT && replayFreeze.originalFreezeSHA256 === ORIGINAL_FREEZE_SHA256, "replay freeze v3 original provenance mismatch");
  assertCondition(replayFreeze.returnsRead === false && (replayFreeze.dataFreezeV2 as Record<string, unknown>).returnsRead === false, "replay freeze v3 returns-read boundary failed");
  assertCondition((replayFreeze.universeReplay as Record<string, unknown>).method === "ROLLING_15M_24H_VOLUME_PROXY", "replay freeze universe method mismatch");
  const codeFiles = replayFreeze.codeFiles as Array<{ path: string }>;
  assertCondition(codeFiles.length > 0 && codeFiles.every((item) => !/^[A-Za-z]:[\\/]/.test(item.path) && !item.path.startsWith("/")), "replay freeze contains non-portable code paths");

  const replayFreezeV4 = parse("lfv-001-replay-freeze-v4.json");
  const replayV4Hash = replayFreezeV4.freezeSha256;
  const replayV4Core = Object.fromEntries(Object.entries(replayFreezeV4).filter(([key]) => key !== "freezeSha256" && key !== "generatedAt"));
  assertCondition(replayFreezeV4.schema === "bca-lfv-001-replay-freeze-v4" && replayFreezeV4.status === "FROZEN_BEFORE_RETURN_READ", "replay freeze v4 status/schema mismatch");
  assertCondition(replayV4Hash === sha256(stableStringify(replayV4Core)), "replay freeze v4 hash mismatch");
  assertCondition(replayFreezeV4.originalFreezeCommit === ORIGINAL_FREEZE_COMMIT && replayFreezeV4.originalFreezeSHA256 === ORIGINAL_FREEZE_SHA256, "replay freeze v4 original provenance mismatch");
  assertCondition(replayFreezeV4.returnsRead === false && (replayFreezeV4.dataFreezeV2 as Record<string, unknown>).returnsRead === false, "replay freeze v4 returns-read boundary failed");
  const v4Reference = replayFreezeV4.replayFreezeV3 as Record<string, unknown>;
  assertCondition(v4Reference.freezeSha256 === replayFreeze.freezeSha256, "replay freeze v4 does not reference replay freeze v3");
  const v4DataFreeze = replayFreezeV4.dataFreezeV2 as Record<string, unknown>;
  assertCondition(v4DataFreeze.gateDefinitionHash === freeze.gateDefinitionHash && sameJson(v4DataFreeze.hypothesisHashes, freeze.hypothesisHashes), "replay freeze v4 changed frozen gate or hypothesis hashes");
  const v4Definitions = replayFreezeV4.unchangedDefinitions as Record<string, unknown>;
  assertCondition(sameJson(v4Definitions.hypotheses, LFV_HYPOTHESES) && sameJson(v4Definitions.combinedDefinition, LFV_COMBINED_PRIMARY), "replay freeze v4 definitions changed");
  assertCondition(v4Definitions.gateDefinitionHash === freeze.gateDefinitionHash, "replay freeze v4 gate hash changed");
  const v4Universe = replayFreezeV4.universeReplay as Record<string, unknown>;
  const v4ParityGate = v4Universe.parityGate as Record<string, unknown>;
  assertCondition(v4Universe.method === "ROLLING_15M_24H_VOLUME_PROXY" && v4Universe.windowBars === 96, "replay freeze v4 universe method changed");
  assertCondition(v4ParityGate.signalArchiveCoverage === ">=0.95" && v4ParityGate.signalInclusionRecall === ">=0.98", "replay freeze v4 signal gate missing");
  const v4Provenance = replayFreezeV4.v4Provenance as Record<string, unknown>;
  const trendProvenance = replayFreezeV4.trendProvenance as Record<string, unknown>;
  assertCondition(["RESTORED", "V4_REPLAY_PROVENANCE_UNAVAILABLE"].includes(String(v4Provenance.status)), "replay freeze v4 V4 provenance status invalid");
  assertCondition(trendProvenance.status === "RESTORED", "replay freeze v4 trend provenance is not restored");
  assertCondition(sameJson(replayFreezeV4.eligibleStrategies, ["trend-rejection-short-v1"]), "replay freeze v4 eligible strategy set changed");

  const liveSignalUniverse = parse("lfv-001-live-signal-universe-v2.json");
  const { reportSha256: liveSignalUniverseHash, ...liveSignalUniverseCore } = liveSignalUniverse;
  assertCondition(liveSignalUniverse.schema === "bca-lfv-001-live-signal-universe-v2", "live-signal universe schema mismatch");
  assertCondition(liveSignalUniverseHash === sha256(stableStringify(liveSignalUniverseCore)), "live-signal universe report hash mismatch");
  const liveSignalCoverage = liveSignalUniverse.dataCoverage as Record<string, unknown>;
  assertCondition(liveSignalCoverage.frozenSignals === 44, "live-signal universe does not cover 44 frozen rows");
  assertCondition(Number(liveSignalCoverage.signalRowsEvaluated) + Number(liveSignalCoverage.signalRowsMissingArchive) === 44, "live-signal universe coverage does not account for all 44 frozen rows");
  assertCondition(Number(liveSignalCoverage.signalRowsIncluded) <= Number(liveSignalCoverage.signalRowsEvaluated), "live-signal universe inclusion exceeds evaluated rows");
  assertCondition(Array.isArray(liveSignalUniverse.snapshots) && liveSignalUniverse.snapshots.length > 0, "live-signal universe snapshots are missing");
  assertCondition(liveSignalUniverse.returnsRead === false, "live-signal universe was generated after returns were read");

  const finalExecutionFreeze = parse("lfv-001-final-execution-freeze.json");
  const { freezeSha256: finalFreezeHash, ...finalFreezeCore } = finalExecutionFreeze;
  const finalFreezeCoreWithoutGeneratedAt = Object.fromEntries(Object.entries(finalFreezeCore).filter(([key]) => key !== "generatedAt"));
  assertCondition(finalExecutionFreeze.schema === "bca-lfv-001-final-execution-freeze-v1" && finalExecutionFreeze.status === "FROZEN_BEFORE_RETURN_READ", "final execution freeze schema/status mismatch");
  assertCondition(finalFreezeHash === sha256(stableStringify(finalFreezeCoreWithoutGeneratedAt)), "final execution freeze hash mismatch");
  assertCondition(finalExecutionFreeze.originalFreezeCommit === ORIGINAL_FREEZE_COMMIT && finalExecutionFreeze.originalFreezeSHA256 === ORIGINAL_FREEZE_SHA256, "final execution freeze original provenance mismatch");
  assertCondition(finalExecutionFreeze.returnsRead === false, "final execution freeze returns-read boundary failed");
  assertCondition((finalExecutionFreeze.originalFreeze as Record<string, unknown>).freezeSha256 === originalHash, "final execution freeze does not reference original freeze");
  assertCondition((finalExecutionFreeze.dataFreezeV2 as Record<string, unknown>).freezeSha256 === freeze.freezeSha256, "final execution freeze does not reference data freeze v2");
  assertCondition((finalExecutionFreeze.replayFreezeV3 as Record<string, unknown>).freezeSha256 === replayFreeze.freezeSha256, "final execution freeze does not reference replay freeze v3");
  assertCondition((finalExecutionFreeze.replayFreezeV4 as Record<string, unknown>).freezeSha256 === replayFreezeV4.freezeSha256, "final execution freeze does not reference replay freeze v4");
  const finalLiveUniverse = finalExecutionFreeze.liveSignalUniverse as Record<string, unknown>;
  assertCondition(finalLiveUniverse.reportSha256 === liveSignalUniverseHash && finalLiveUniverse.status === liveSignalUniverse.status, "final execution freeze live-signal provenance mismatch");
  const finalDefinitions = finalExecutionFreeze.unchangedDefinitions as Record<string, unknown>;
  assertCondition(sameJson(finalDefinitions.hypotheses, LFV_HYPOTHESES) && sameJson(finalDefinitions.combined, LFV_COMBINED_PRIMARY), "final execution freeze definitions changed");
  assertCondition(finalDefinitions.gateDefinitionHash === freeze.gateDefinitionHash && sameJson(finalDefinitions.hypothesisHashes, freeze.hypothesisHashes), "final execution freeze gate/hypothesis hashes changed");
  const finalTrend = finalExecutionFreeze.trendRuntime as Record<string, unknown>;
  assertCondition((finalTrend.provenance as Record<string, unknown>).status === "RESTORED" && typeof finalExecutionFreeze.trendCodeHash === "string", "final execution freeze Trend provenance is incomplete");

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
  for (const symbol of symbols) assertCondition(["DISCOVERY_ONLY_NOT_DOWNLOADED", "USED_ARCHIVES_VERIFIED", "FAILED"].includes(String(symbol.checksumStatus)), `archive checksum status missing for ${String(symbol.symbol)}`);

  const dataGate = parse("lfv-001-data-gate.json");
  assertCondition(dataGate.schema === "bca-lfv-001-data-gate-v2" && dataGate.baseline === LFV_BASELINE_SHA, "data gate schema/baseline mismatch");
  assertCondition(typeof dataGate.pass === "boolean" && dataGate.status === (dataGate.pass ? "PASS" : "FAIL"), "data gate status is inconsistent");
  assertCondition(dataGate.archiveEnumeration && (dataGate.archiveEnumeration as Record<string, unknown>).registrySha256 === registrySha256, "data gate registry provenance mismatch");
  assertCondition(dataGate.pit && (dataGate.pit as Record<string, unknown>).futureLifecycleFilter === "NO" && (dataGate.pit as Record<string, unknown>).currentSurvivorOnlyFilter === "NO", "data gate PIT lifecycle boundary failed");
  assertCondition((dataGate.liveObservations as Record<string, unknown>).count === 44 && (dataGate.liveObservations as Record<string, unknown>).treatment === "EXCLUDED_FROM_RETURNS", "August live observations entered returns boundary");

  const universe = parse("lfv-001-universe-parity.json");
  assertCondition(universe.schema === "bca-lfv-001-universe-parity-v2" && ["PASS", "FAIL", "NOT_RUN"].includes(String(universe.status)), "universe parity schema/status mismatch");
  const universeMetrics = universe.metrics as Record<string, unknown>;
  const universeCoverage = universe.dataCoverage as Record<string, unknown>;
  assertCondition(universeCoverage.signalRowsEvaluated !== undefined && universeCoverage.signalRowsIncluded !== undefined && universeCoverage.signalRowsMissingArchive !== undefined, "universe signal coverage fields missing");
  assertCondition(Number(universeCoverage.signalRowsEvaluated) + Number(universeCoverage.signalRowsMissingArchive) === 44, "universe signal coverage does not account for all 44 frozen rows");
  assertCondition(Number(universeCoverage.signalRowsIncluded) <= Number(universeCoverage.signalRowsEvaluated), "universe signal inclusion exceeds evaluated rows");
  if (universe.status === "PASS") {
    assertCondition(universe.code === null && universeMetrics.pass === true, "universe parity PASS is inconsistent");
    assertCondition(Number(universeMetrics.medianTop100Overlap) >= 0.95 && Number(universeMetrics.p10Top100Overlap) >= 0.9 && Number(universeMetrics.signalInclusionRecall) >= 0.98, "universe parity thresholds not met");
  } else if (universe.status === "FAIL") {
    assertCondition(["LFV_UNIVERSE_PARITY_FAIL", "LFV_UNIVERSE_PARITY_INSUFFICIENT"].includes(String(universe.code)) && universeMetrics.pass === false, "universe parity FAIL is inconsistent");
    const signalCoverage = Number(universeCoverage.signalRowsEvaluated) / 44;
    if (signalCoverage < 0.95) assertCondition(universe.code === "LFV_UNIVERSE_PARITY_INSUFFICIENT", "insufficient signal archive coverage did not use the insufficient code");
    else assertCondition(universe.code === "LFV_UNIVERSE_PARITY_FAIL", "failed signal inclusion gate did not use the parity failure code");
  } else {
    assertCondition(dataGate.pass === false, "universe parity was not run despite a passing Data Gate");
  }

  const liveParity = parse("lfv-001-live-parity.json");
  assertCondition(liveParity.schema === "bca-lfv-001-live-parity-v2" && liveParity.status === "NOT_RUN" && liveParity.returnsRead === false, "live parity returns boundary failed");
  assertCondition((liveParity.observations as Record<string, unknown>).count === 44, "live parity observation count changed");

  const decision = parse("lfv-001-decision.json");
  const acceptedCodes = ["LFV_DATA_INSUFFICIENT_FINAL", "LFV_UNIVERSE_PARITY_FAIL", "LFV_UNIVERSE_PARITY_INSUFFICIENT", "V4_REPLAY_PROVENANCE_FAIL", "V4_REPLAY_PROVENANCE_UNAVAILABLE", "LFV_REPLAY_PARITY_FAIL"];
  assertCondition(decision.schema === "bca-lfv-001-decision-v3" && acceptedCodes.includes(String(decision.status)) && decision.finalClassification === decision.status, "decision classification is not a frozen fail-closed result");
  assertCondition(decision.researchStop === true && decision.returnsRead === false, "research/returns boundary failed");
  assertCondition(decision.dataGate === dataGate.status, "decision data gate status mismatch");
  assertCondition((decision.universeParity as Record<string, unknown>).status === universe.status, "decision universe parity mismatch");
  if (dataGate.pass === false) assertCondition(decision.status === "LFV_DATA_INSUFFICIENT_FINAL", "failed data gate did not stop with LFV_DATA_INSUFFICIENT_FINAL");
  else if (universe.status !== "PASS") assertCondition(decision.status === universe.code, "failed universe parity did not stop with its exact code");
  else assertCondition(["V4_REPLAY_PROVENANCE_UNAVAILABLE", "V4_REPLAY_PROVENANCE_FAIL", "LFV_REPLAY_PARITY_FAIL"].includes(String(decision.status)), "post-universe replay gate did not stop returns");
  const production = decision.production as Record<string, unknown>;
  assertCondition(production.changed === false && production.email === "OFF" && production.autoTrading === false && production.privateBinanceApi === false, "Production boundary changed");
  assertCondition(production["#002"] === "STOPPED" && production.v14 === "UNCHANGED", "research boundary missing");

  for (const reportName of ["lfv-001-replay-parity.json", "lfv-001-factor-results.json", "lfv-001-combined-results.json", "lfv-001-holdouts.json"]) assertCondition(parse(reportName).returnsRead === false && parse(reportName).status === "NOT_RUN", `${reportName} returns boundary failed`);

  const evidence = parse("lfv-001-evidence-manifest.json");
  assertCondition(evidence.schema === "bca-lfv-001-evidence-manifest-v3" && evidence.baseline === LFV_BASELINE_SHA && evidence.returnsRead === false, "evidence manifest schema/boundary mismatch");
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
  console.info(JSON.stringify({ ok: true, status: decision.status, dataGate: dataGate.status, universeParity: universe.status, reports: reports.length, returnsRead: false }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
