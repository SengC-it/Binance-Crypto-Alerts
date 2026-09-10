import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { compareV22SignalIdentity, periodForV22Signal, V22_CONTROL_C_SEED, V22_CONTROL_C_SEED_HEX, V22_PERIODS, xorshift32, type V22EnumerationPeriod } from "@/lib/v22/enumeration";
import { V22_BASE_SHA, V22_END_MS, V22_EXPERIMENT_ID, V22_INTERVAL_MS, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);
const REPORT_DIR = resolve("reports");
const WP1_1_SHA = "1a223849bd8790521c0c139552969b6bd2cc4b93";
const WP2_ORIGINAL_SHA = "9dd7705466a49c82bcfa7e4851747d92bb46bd63";
const WP2_1_SHA = "f99da4c0dbb0f4d937cc63c95f1c969ead6b5a51";
const WP1_1_MANIFEST_SHA = "a3272cd83b0ed661587ea86723aa8e04b764749e49605566cede05721b7e290a";
const WP2_SIGNAL_CONTRACT_SHA = "8516270caa1c7d7f9c929675adbe0a7463d2d6dc4816c7cc1c9dea7e1c70ae55";
const WP2_MANIFEST_SHA = "7ad52a6abb8ac3f3d43ee6a2d08a1e7ff40ce819e77efe0385303989c7d7917e";
const SIGNAL_SOURCE_SHA = "775d160293494fcd115d417c0bc595da83b04ad538b7e9136e0f31f3fa0e0757";
const ALLOWED_PATHS = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "lib/v22/enumeration.ts",
  "scripts/run-v22-wp3a.ts",
  "scripts/validate-v22-wp1.ts",
  "scripts/validate-v22-wp2.ts",
  "scripts/validate-v22-wp3a.ts",
  "tests/v22-enumeration.test.ts",
  "reports/v22-primary-event-identities.jsonl",
  "reports/v22-control-a-identities.jsonl",
  "reports/v22-control-b-identities.jsonl",
  "reports/v22-control-c-identities.jsonl",
  "reports/v22-event-enumeration.json",
  "reports/v22-event-audit.json",
  "reports/v22-control-enumeration.json",
  "reports/v22-pre-return-freeze-manifest.json",
]);
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V22 WP3A validation failed: ${message}`);
}

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function jsonFile<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

interface IdentityRecord {
  eventKind: string;
  symbol: string;
  signalOpenTimeUtc: string;
  decisionTimeUtc: string;
  direction: string;
  period: V22EnumerationPeriod;
  clusterId: string;
  entryOpenTimeUtc: string;
  primaryExitOpenTimeUtc: string;
  primaryOutcomeBoundaryTimeUtc: string;
  [key: string]: unknown;
}

async function identityFile(name: string): Promise<{ records: IdentityRecord[]; text: string }> {
  const text = await readFile(resolve(REPORT_DIR, name), "utf8");
  const records = text.split("\n").filter(Boolean).map((line, index) => {
    const record = JSON.parse(line) as IdentityRecord;
    requireThat(canonicalLine(record) === line + "\n", `${name} line ${index + 1} is not canonical JSONL`);
    return record;
  });
  return { records, text };
}

function canonicalLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function isoMs(value: unknown): number {
  const parsed = Date.parse(String(value));
  requireThat(Number.isFinite(parsed), `invalid timestamp ${String(value)}`);
  return parsed;
}

function assertOrdered(records: readonly IdentityRecord[], name: string): void {
  for (let index = 1; index < records.length; index += 1) requireThat(compareV22SignalIdentity({ signalOpenTimeUtc: isoMs(records[index - 1]!.signalOpenTimeUtc), symbol: records[index - 1]!.symbol as never }, { signalOpenTimeUtc: isoMs(records[index]!.signalOpenTimeUtc), symbol: records[index]!.symbol as never }) <= 0, `${name} ordering is not signal timestamp then fixed symbol order`);
  const keys = records.map((record) => `${record.symbol}|${record.signalOpenTimeUtc}`);
  requireThat(new Set(keys).size === keys.length, `${name} has duplicate symbol/timestamp identities`);
}

function assertPeriodAndIdentity(records: readonly IdentityRecord[], expectedKind: string, name: string): void {
  const forbiddenKeys = new Set(["entryPrice", "exitPrice", "grossReturn", "netReturn", "PnL", "profitFactor", "winRate", "expectancy", "bootstrapReturn", "holdoutReturn", "stressReturn"]);
  for (const record of records) {
    requireThat(record.experimentId === V22_EXPERIMENT_ID && record.eventKind === expectedKind, `${name} identity contract drifted`);
    requireThat((V22_SYMBOLS as readonly string[]).includes(record.symbol), `${name} has an unknown symbol`);
    const signalTime = isoMs(record.signalOpenTimeUtc);
    requireThat(signalTime >= V22_START_MS && signalTime < V22_END_MS, `${name} timestamp outside frozen range`);
    requireThat(record.period === periodForV22Signal(signalTime), `${name} period is not based on signalOpenTimeUtc`);
    requireThat(record.clusterId === record.signalOpenTimeUtc, `${name} cluster identity is not canonical`);
    requireThat(isoMs(record.decisionTimeUtc) === signalTime + V22_INTERVAL_MS, `${name} decision timestamp drifted`);
    for (const key of Object.keys(record)) requireThat(!forbiddenKeys.has(key), `${name} contains forbidden outcome field ${key}`);
  }
  assertOrdered(records, name);
}

function countsByPeriod(records: readonly IdentityRecord[]): Record<V22EnumerationPeriod, number> {
  return Object.fromEntries(V22_PERIODS.map((period) => [period, records.filter((record) => record.period === period).length])) as Record<V22EnumerationPeriod, number>;
}

function assertNoSameSymbolOverlap(records: readonly IdentityRecord[], name: string): void {
  const lastBySymbol = new Map<string, number>();
  for (const record of records) {
    const entry = isoMs(record.entryOpenTimeUtc);
    const boundary = isoMs(record.primaryOutcomeBoundaryTimeUtc);
    const previousBoundary = lastBySymbol.get(record.symbol);
    requireThat(previousBoundary === undefined || entry >= previousBoundary, `${name} has same-symbol 15m overlap`);
    lastBySymbol.set(record.symbol, boundary);
  }
}

async function main(): Promise<void> {
  const branch = process.env.GITHUB_HEAD_REF || await git(["branch", "--show-current"]);
  requireThat(branch === "feat/v22-cross-venue-price-discovery", `branch must be feat/v22-cross-venue-price-discovery, got ${branch}`);
  requireThat((await git(["status", "--porcelain"])) === "", "working tree is dirty");
  const target = process.env.GITHUB_HEAD_REF ? `origin/${process.env.GITHUB_HEAD_REF}` : "HEAD";
  const targetHead = await git(["rev-parse", target]);
  requireThat((await git(["merge-base", targetHead, V22_BASE_SHA])) === V22_BASE_SHA, "base ancestry drifted");
  requireThat((await git(["merge-base", targetHead, WP1_1_SHA])) === WP1_1_SHA, "WP1.1 is not an ancestor");
  requireThat((await git(["merge-base", targetHead, WP2_1_SHA])) === WP2_1_SHA, "WP2.1 is not an ancestor");
  requireThat((await git(["rev-parse", `${targetHead}^`])) === WP2_1_SHA, "WP3A must be exactly one commit after WP2.1");
  requireThat((await git(["rev-list", "--count", `${WP2_1_SHA}..${targetHead}`])) === "1", "more than one WP3A commit exists");
  requireThat((await git(["rev-parse", `${WP2_1_SHA}^`])) === WP2_ORIGINAL_SHA, "WP2.1 parent drifted");
  const changed = (await git(["diff", "--name-only", `${WP2_1_SHA}..${targetHead}`])).split(/\r?\n/).filter(Boolean);
  requireThat(changed.length > 0 && changed.every((path) => ALLOWED_PATHS.has(path)), `unexpected changed path: ${changed.find((path) => !ALLOWED_PATHS.has(path)) ?? "unknown"}`);

  const wp1Output = (await execFileAsync("git", ["show", `${WP1_1_SHA}:reports/v22-wp1-manifest.json`], { encoding: "buffer" })).stdout;
  const wp1Text = Buffer.isBuffer(wp1Output) ? wp1Output : Buffer.from(wp1Output as string, "utf8");
  requireThat(sha256(wp1Text) === WP1_1_MANIFEST_SHA, "WP1.1 manifest hash drifted");
  const contract = await jsonFile<{ experimentId: string; fixedSymbols: string[]; fixedMappings: Record<string, string>; controls: { C: { seedHex: string; seedDecimal: number; generatedOnce: boolean } }; wp3aSampleGate: { primaryEventsMinimum: number; distinctSignalClustersMinimum: number; perFixedSymbolMinimum: number }; flags: Record<string, boolean> }>("v22-signal-contract.json");
  requireThat(contract.experimentId === V22_EXPERIMENT_ID && JSON.stringify(contract.fixedSymbols) === JSON.stringify([...V22_SYMBOLS]) && contract.fixedMappings.DOGEUSDT === V22_OKX_INSTRUMENTS.DOGEUSDT, "WP2 contract identity drifted");
  requireThat(contract.controls.C.seedHex === V22_CONTROL_C_SEED_HEX && contract.controls.C.seedDecimal === V22_CONTROL_C_SEED && contract.controls.C.generatedOnce, "Control C seed drifted");
  requireThat(contract.wp3aSampleGate.primaryEventsMinimum === 500 && contract.wp3aSampleGate.distinctSignalClustersMinimum === 250 && contract.wp3aSampleGate.perFixedSymbolMinimum === 50, "sample gate threshold drifted");
  for (const flag of ["historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "futureOutcomePricesRead", "eventEnumerationRun", "backtestRun", "parameterSearch", "promotionEvaluated"]) requireThat(contract.flags[flag] === false, `${flag} must remain false in WP2 contract`);
  requireThat(sha256(await readFile(resolve(REPORT_DIR, "v22-signal-contract.json"))) === WP2_SIGNAL_CONTRACT_SHA, "signal contract hash drifted");
  requireThat(sha256(await readFile(resolve(REPORT_DIR, "v22-wp2-freeze-manifest.json"))) === WP2_MANIFEST_SHA, "WP2 freeze manifest hash drifted");

  const manifest = await jsonFile<Record<string, unknown>>("v22-pre-return-freeze-manifest.json");
  requireThat(manifest.schema === "v22-pre-return-freeze-manifest-v1" && manifest.experimentId === V22_EXPERIMENT_ID && manifest.branch === "feat/v22-cross-venue-price-discovery" && manifest.baseSha === V22_BASE_SHA && manifest.directParent === WP2_1_SHA && manifest.wp1_1AcceptedCommit === WP1_1_SHA && manifest.wp1_1ManifestSha256 === WP1_1_MANIFEST_SHA && manifest.wp2OriginalCommit === WP2_ORIGINAL_SHA && manifest.wp2_1Commit === WP2_1_SHA && manifest.wp2SignalContractSha256 === WP2_SIGNAL_CONTRACT_SHA && manifest.wp2FreezeManifestSha256 === WP2_MANIFEST_SHA, "freeze manifest identity drifted");
  const period = manifest.period as { start: string; endExclusive: string; interval: string; signalOpenTimeUtc: boolean; closedCandlesOnly: boolean };
  requireThat(period.start === new Date(V22_START_MS).toISOString() && period.endExclusive === new Date(V22_END_MS).toISOString() && period.interval === "5m" && period.signalOpenTimeUtc && period.closedCandlesOnly, "freeze period drifted");
  requireThat(manifest.signalEvaluatorSha256 === SIGNAL_SOURCE_SHA && (manifest.remainingResearchBudget === 2), "accepted evaluator or budget drifted");
  for (const flag of ["historicalFeaturePricesRead", "eventEnumerationRun", "primaryIdentitiesFrozen", "controlAIdentitiesFrozen", "controlBIdentitiesFrozen", "controlCIdentitiesFrozen"]) requireThat(manifest[flag] === true, `${flag} must be true`);
  for (const flag of ["executionOutcomePricesRead", "historicalStrategyOutcomeReturnsRead", "forwardReturnsRead", "strategyOutcomeMappingRun", "backtestRun", "parameterSearch", "promotionEvaluated", "productionChanged", "deploy", "merge", "orderPlacement", "autoTrading"]) requireThat(manifest[flag] === false, `${flag} must be false`);
  requireThat(manifest.productionEmail === "OFF", "Production Email is not OFF");
  const sourceHashes = manifest.sourceFileSha256 as Record<string, string>;
  for (const path of ["lib/v22/enumeration.ts", "lib/v22/signal.ts", "lib/v22/types.ts", "lib/v22/data.ts", "lib/v22/provenance.ts", "scripts/run-v22-wp3a.ts", "tests/v22-enumeration.test.ts", "scripts/validate-v22-wp3a.ts"]) requireThat(sourceHashes[path] === sha256(await readFile(resolve(path))), `source hash mismatch for ${path}`);

  const files = await Promise.all([
    identityFile("v22-primary-event-identities.jsonl"),
    identityFile("v22-control-a-identities.jsonl"),
    identityFile("v22-control-b-identities.jsonl"),
    identityFile("v22-control-c-identities.jsonl"),
  ]);
  const [primary, controlA, controlB, controlC] = files;
  assertPeriodAndIdentity(primary.records, "PRIMARY", "primary");
  assertPeriodAndIdentity(controlA.records, "OKX_SHOCK_MOMENTUM", "control A");
  assertPeriodAndIdentity(controlB.records, "BINANCE_SHOCK_MOMENTUM", "control B");
  assertPeriodAndIdentity(controlC.records, "TIME_MATCHED_RANDOM", "control C");
  assertNoSameSymbolOverlap(primary.records, "primary");
  assertNoSameSymbolOverlap(controlA.records, "control A");
  assertNoSameSymbolOverlap(controlB.records, "control B");
  assertNoSameSymbolOverlap(controlC.records, "control C");
  const identityNames = ["reports/v22-primary-event-identities.jsonl", "reports/v22-control-a-identities.jsonl", "reports/v22-control-b-identities.jsonl", "reports/v22-control-c-identities.jsonl"] as const;
  const identityRecords = [primary, controlA, controlB, controlC];
  const identityHashes = manifest.identityFileSha256 as Record<string, string>;
  for (const [index, name] of identityNames.entries()) requireThat(identityHashes[name] === sha256(identityRecords[index]!.text), `${name} hash drifted`);
  const primaryByPeriod = countsByPeriod(primary.records);
  const manifestPrimary = manifest.primaryEnumeration as { acceptedAll: number; acceptedPrimaryOos: number; distinctClustersAll: number; sampleGate: { primaryOosAcceptedEvents: number; primaryOosDistinctClusters: number; primaryOosBySymbol: Record<string, number>; pass: boolean } };
  const primaryOos = primary.records.filter((record) => record.period === "PRIMARY_OOS");
  const primaryOosClusters = new Set(primaryOos.map((record) => record.clusterId)).size;
  const primaryOosBySymbol = Object.fromEntries(V22_SYMBOLS.map((symbol) => [symbol, primaryOos.filter((record) => record.symbol === symbol).length]));
  requireThat(primaryByPeriod.PRIMARY_OOS === manifestPrimary.acceptedPrimaryOos && primary.records.length === manifestPrimary.acceptedAll && new Set(primary.records.map((record) => record.clusterId)).size === manifestPrimary.distinctClustersAll, "primary count summary drifted");
  requireThat(manifestPrimary.sampleGate.primaryOosAcceptedEvents === primaryOos.length && manifestPrimary.sampleGate.primaryOosDistinctClusters === primaryOosClusters && JSON.stringify(manifestPrimary.sampleGate.primaryOosBySymbol) === JSON.stringify(primaryOosBySymbol), "sample gate evidence drifted");
  const samplePass = primaryOos.length >= 500 && primaryOosClusters >= 250 && Object.values(primaryOosBySymbol).every((count) => count >= 50);
  requireThat(manifestPrimary.sampleGate.pass === samplePass, "sample gate pass/fail is not exact");
  requireThat(primary.records.every((record) => record.entryTimestampAvailable === true && record.primaryExitTimestampAvailable === true && record.diagnostic5TimestampAvailable === true && record.diagnostic30TimestampAvailable === true), "accepted primary event lacks complete timestamp-only execution grid");

  const controls = await jsonFile<{ controls: Record<string, { count: number; byPeriod: Record<V22EnumerationPeriod, number>; expectedCount?: number; identitySha256: string }>; randomPlacebo: { seedHex: string; seedDecimal: number; prng: string; matchingFailures: unknown[]; candidateOrdering: string; matchOrdering: string } }>("v22-control-enumeration.json");
  requireThat(controls.controls.OKX_SHOCK_MOMENTUM.count === controlA.records.length && controls.controls.BINANCE_SHOCK_MOMENTUM.count === controlB.records.length && controls.controls.TIME_MATCHED_RANDOM.count === controlC.records.length, "control count summary drifted");
  requireThat(controls.randomPlacebo.seedHex === V22_CONTROL_C_SEED_HEX && controls.randomPlacebo.seedDecimal === V22_CONTROL_C_SEED && controls.randomPlacebo.prng === "xorshift32" && controls.randomPlacebo.candidateOrdering === "timestamp ascending" && controls.randomPlacebo.matchOrdering === "signalOpenTimeUtc ascending then fixed symbol order", "Control C PRNG/order drifted");
  if (samplePass) requireThat(controlC.records.length === primary.records.length && controls.randomPlacebo.matchingFailures.length === 0, "Control C must match every primary event after a passing sample gate");
  const primaryKeys = new Set(primary.records.map((record) => `${record.symbol}|${record.signalOpenTimeUtc}`));
  requireThat(controlC.records.every((record) => !primaryKeys.has(`${record.symbol}|${record.signalOpenTimeUtc}`)), "Control C matched a primary timestamp");
  requireThat(controlC.records.every((record) => record.seedHex === V22_CONTROL_C_SEED_HEX && record.seedDecimal === V22_CONTROL_C_SEED && record.prng === "xorshift32"), "Control C identity seed drifted");
  requireThat(xorshift32(V22_CONTROL_C_SEED) === 1639492563, "xorshift32 known sequence drifted");
  const event = await jsonFile<{ primary: { all: number; byPeriod: Record<V22EnumerationPeriod, number>; distinctClustersAll: number; bySymbol: Record<string, number>; byDirection: Record<string, number>; byYear: Record<string, number>; rawSignalCandidates: number }; sampleGate: { pass: boolean; classification: string }; classification: string; researchStop: boolean; historicalFeaturePricesRead: boolean; eventEnumerationRun: boolean; strategyOutcomeMappingRun: boolean; executionOutcomePricesRead: boolean; noOutcomePriceFields: boolean; identityFiles: Record<string, string>; periodDigests: Record<V22EnumerationPeriod, { primary: string; count: number }> }>("v22-event-enumeration.json");
  const expectedClassification = samplePass && controls.randomPlacebo.matchingFailures.length === 0 ? "V22_PRE_RETURN_SAMPLE_GATE_PASS" : samplePass ? "V22_CONTROL_C_MATCHING_INSUFFICIENT" : "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT";
  requireThat(event.primary.all === primary.records.length && event.primary.distinctClustersAll === new Set(primary.records.map((record) => record.clusterId)).size && event.sampleGate.pass === samplePass && event.sampleGate.classification === (samplePass ? "PASS" : "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT") && event.classification === expectedClassification && event.researchStop === (event.classification !== "V22_PRE_RETURN_SAMPLE_GATE_PASS"), "event enumeration classification drifted");
  requireThat(event.historicalFeaturePricesRead && event.eventEnumerationRun && !event.strategyOutcomeMappingRun && !event.executionOutcomePricesRead && event.noOutcomePriceFields, "event enumeration flags drifted");
  for (const periodName of V22_PERIODS) {
    const eventDigest = event.periodDigests[periodName]!.primary;
    const manifestDigest = (manifest.periodDigests as Record<string, { primary: { sha256: string; count: number } }>)[periodName]!.primary;
    requireThat(eventDigest === manifestDigest.sha256 && event.periodDigests[periodName]!.count === manifestDigest.count && event.periodDigests[periodName]!.count === primaryByPeriod[periodName], `primary ${periodName} digest summary drifted`);
  }
  const audit = await jsonFile<{ counts: { all: Record<string, number> }; noUnexplainedLoss: boolean }>("v22-event-audit.json");
  requireThat(audit.noUnexplainedLoss, "audit did not assert no unexplained loss");
  requireThat(audit.counts.all.featureEvaluations === audit.counts.all.eligibleWindows + audit.counts.all.ineligibleWindow, "feature window audit does not reconcile");
  requireThat(audit.counts.all.eligibleWindows === audit.counts.all.belowThreshold + audit.counts.all.notFirstCross + audit.counts.all.venueDirectionMismatch + audit.counts.all.okxNotDominant + audit.counts.all.zeroGap + audit.counts.all.nonfinite + audit.counts.all.rawSignalCandidates, "predicate rejection audit does not reconcile");
  requireThat(audit.counts.all.rawSignalCandidates === audit.counts.all.overlapExcluded + audit.counts.all.executionGridUnavailable + audit.counts.all.acceptedEvents, "candidate disposition audit does not reconcile");
  requireThat(audit.counts.all.acceptedEvents === primary.records.length, "accepted event audit count drifted");
  requireThat(!["v22-event-enumeration.json", "v22-event-audit.json", "v22-control-enumeration.json", "v22-pre-return-freeze-manifest.json"].some((name) => /result|performance|holdout|pnl/i.test(name)), "WP3A artifact path is a result artifact");
  console.info(JSON.stringify({ stage: "v22_wp3a_validation_pass", targetHead, primary: primary.records.length, primaryOos: primaryOos.length, controlA: controlA.records.length, controlB: controlB.records.length, controlC: controlC.records.length, classification: event.classification, researchStop: event.researchStop, remainingResearchBudget: 2 }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
