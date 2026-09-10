import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseBinanceKlineCsv, parseOkxResponseBodies } from "@/lib/v22/data";
import { verifyBinanceArtifact, verifyOkxFrozenLines, splitNdjsonLines } from "@/lib/v22/provenance";
import {
  canonicalJsonLine,
  compareV22SignalIdentity,
  directionFromSignedReturn,
  evaluateV22ShockSignal,
  hourUtc,
  monthUtc,
  passesV22PreReturnSampleGate,
  periodForV22Signal,
  placeboStratumKey,
  V22_CONTROL_C_SEED,
  V22_CONTROL_C_SEED_HEX,
  V22_PERIODS,
  xorshift32,
  type V22EnumerationPeriod,
  type V22ShockMetric,
  type V22ShockCandidate,
} from "@/lib/v22/enumeration";
import {
  acceptV22PrimaryOverlap,
  buildV22ExecutionContract,
  evaluateV22PrimarySignal,
  firstCross,
  logReturn,
  nearestRankQ99,
  V22_INFORMATION_DENSITY_FLOOR_BPS,
  V22_MIN_GAP_LOG,
  V22_ROLLING_OBSERVATIONS,
} from "@/lib/v22/signal";
import {
  V22_BASE_SHA,
  V22_END_MS,
  V22_EXPERIMENT_ID,
  V22_INTERVAL_MS,
  V22_OKX_INSTRUMENTS,
  V22_START_MS,
  V22_SYMBOLS,
  type V22Symbol,
} from "@/lib/v22/types";
import type { V22Direction, V22SynchronizedObservation } from "@/lib/v22/signal";

const REPORT_DIR = resolve("reports");
const WP1_1_SHA = "1a223849bd8790521c0c139552969b6bd2cc4b93";
const WP2_ORIGINAL_SHA = "9dd7705466a49c82bcfa7e4851747d92bb46bd63";
const WP2_1_SHA = "f99da4c0dbb0f4d937cc63c95f1c969ead6b5a51";
const WP1_1_MANIFEST_SHA = "a3272cd83b0ed661587ea86723aa8e04b764749e49605566cede05721b7e290a";
const WP2_SIGNAL_CONTRACT_SHA = "8516270caa1c7d7f9c929675adbe0a7463d2d6dc4816c7cc1c9dea7e1c70ae55";
const WP2_MANIFEST_SHA = "7ad52a6abb8ac3f3d43ee6a2d08a1e7ff40ce819e77efe0385303989c7d7917e";
const SIGNAL_SOURCE_SHA = "775d160293494fcd115d417c0bc595da83b04ad538b7e9136e0f31f3fa0e0757";

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

type AuditCountKey =
  | "featureEvaluations"
  | "eligibleWindows"
  | "ineligibleWindow"
  | "belowThreshold"
  | "notFirstCross"
  | "venueDirectionMismatch"
  | "okxNotDominant"
  | "zeroGap"
  | "nonfinite"
  | "rawSignalCandidates"
  | "overlapExcluded"
  | "executionGridUnavailable"
  | "acceptedEvents";

type AuditCounts = Record<AuditCountKey, number>;

const emptyAudit = (): AuditCounts => ({
  featureEvaluations: 0,
  eligibleWindows: 0,
  ineligibleWindow: 0,
  belowThreshold: 0,
  notFirstCross: 0,
  venueDirectionMismatch: 0,
  okxNotDominant: 0,
  zeroGap: 0,
  nonfinite: 0,
  rawSignalCandidates: 0,
  overlapExcluded: 0,
  executionGridUnavailable: 0,
  acceptedEvents: 0,
});

interface AuditBook {
  all: AuditCounts;
  period: Record<V22EnumerationPeriod, AuditCounts>;
  symbol: Record<V22Symbol, AuditCounts>;
  year: Record<string, AuditCounts>;
  direction: Record<"LONG" | "SHORT" | "UNKNOWN", AuditCounts>;
}

const createAuditBook = (): AuditBook => ({
  all: emptyAudit(),
  period: Object.fromEntries(V22_PERIODS.map((period) => [period, emptyAudit()])) as Record<V22EnumerationPeriod, AuditCounts>,
  symbol: Object.fromEntries(V22_SYMBOLS.map((symbol) => [symbol, emptyAudit()])) as Record<V22Symbol, AuditCounts>,
  year: {},
  direction: { LONG: emptyAudit(), SHORT: emptyAudit(), UNKNOWN: emptyAudit() },
});

function addAudit(book: AuditBook, input: { symbol: V22Symbol; signalOpenTimeUtc: number; direction?: V22Direction | null }, key: AuditCountKey): void {
  const period = periodForV22Signal(input.signalOpenTimeUtc);
  if (!period) throw new Error(`signal is outside frozen periods: ${input.signalOpenTimeUtc}`);
  const direction = input.direction ?? "UNKNOWN";
  const year = String(new Date(input.signalOpenTimeUtc).getUTCFullYear());
  book.all[key] += 1;
  book.period[period][key] += 1;
  book.symbol[input.symbol][key] += 1;
  (book.year[year] ??= emptyAudit())[key] += 1;
  book.direction[direction][key] += 1;
}

interface PrimaryRawCandidate {
  symbol: V22Symbol;
  direction: V22Direction;
  signalOpenTimeUtc: number;
  decisionTimeUtc: number;
  binanceReturn: number;
  okxReturn: number;
  gap: number;
  threshold: number;
  previousGap: number;
  q99Threshold: number;
  execution: ReturnType<typeof buildV22ExecutionContract>;
  executionAvailable: boolean;
}

interface ShockRawCandidate extends V22ShockCandidate {
  executionAvailable: boolean;
}

interface SymbolEnumeration {
  symbol: V22Symbol;
  instrument: string;
  primaryRaw: PrimaryRawCandidate[];
  shockRaw: Record<"OKX_SHOCK_MOMENTUM" | "BINANCE_SHOCK_MOMENTUM", ShockRawCandidate[]>;
  placeboCandidates: Map<string, number[]>;
  audit: AuditBook;
}

interface FrozenProvenance {
  symbols: Record<string, { binance: Array<Record<string, unknown>>; okx: Record<string, unknown> }>;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function assertFrozenSourceProvenance(): Promise<void> {
  const gate = await jsonFile<{ classification: string; allSymbolsPass: boolean; researchStop: boolean; policy: { fixedSymbols: string[]; exactFrozenRange: { startMs: number; endExclusiveMs: number }; synchronizedByExactTimestampIntersection: boolean } }>("reports/v22-data-gate.json");
  if (gate.classification !== "V22_CROSS_VENUE_DATA_GATE_PASS" || !gate.allSymbolsPass || gate.researchStop || JSON.stringify(gate.policy.fixedSymbols) !== JSON.stringify([...V22_SYMBOLS]) || gate.policy.exactFrozenRange.startMs !== V22_START_MS || gate.policy.exactFrozenRange.endExclusiveMs !== V22_END_MS || !gate.policy.synchronizedByExactTimestampIntersection) throw new Error("frozen WP1.1 data gate is not an exact PASS");
  const provenance = await jsonFile<FrozenProvenance>("reports/v22-source-provenance.json");
  const binanceManifest = await jsonFile<{ artifacts: Array<Record<string, unknown>> }>("data/raw/v22/binance/manifest.json");
  for (const symbol of V22_SYMBOLS) {
    const source = provenance.symbols[symbol];
    if (!source) throw new Error(`missing frozen provenance for ${symbol}`);
    const binanceArtifacts = binanceManifest.artifacts.filter((artifact) => artifact.symbol === symbol);
    const frozenBinance = source.binance;
    if (binanceArtifacts.length !== frozenBinance.length || frozenBinance.some((artifact) => artifact.pass !== true)) throw new Error(`frozen Binance provenance is incomplete for ${symbol}`);
    for (const artifact of binanceArtifacts) {
      const month = String(artifact.month);
      const verified = await verifyBinanceArtifact({ symbol, month, zipPath: String(artifact.zipPath), checksumPath: String(artifact.checksumPath), extractedCsvPath: String(artifact.extractedCsv) });
      const frozen = frozenBinance.find((entry) => entry.month === month);
      if (!frozen || !verified.pass || verified.zipSha256 !== frozen.zipSha256 || verified.extractedCsvSha256 !== frozen.extractedCsvSha256) throw new Error(`Binance frozen hash assertion failed for ${symbol} ${month}`);
    }
    const okxManifest = await jsonFile<{ bodyPath: string; responses: Array<{ request: string; byteLength: number; sha256: string }> }>(`data/raw/v22/okx/${symbol}/manifest.json`);
    const okxBody = await readFile(okxManifest.bodyPath);
    const okxVerified = verifyOkxFrozenLines({ bodyBytes: okxBody, responses: okxManifest.responses });
    if (!okxVerified.pass || source.okx.allResponseHashesVerified !== true || source.okx.bodySha256 !== sha256(okxBody)) throw new Error(`OKX frozen hash assertion failed for ${symbol}`);
  }
}

async function loadSymbol(symbol: V22Symbol): Promise<{ binanceCloses: Map<number, number>; okxCloses: Map<number, number>; binanceOpenTimes: Set<number> }> {
  const binanceManifest = await jsonFile<{ artifacts: Array<Record<string, unknown>> }>("data/raw/v22/binance/manifest.json");
  const binanceCloses = new Map<number, number>();
  const binanceOpenTimes = new Set<number>();
  for (const artifact of binanceManifest.artifacts.filter((entry) => entry.symbol === symbol)) {
    const candles = parseBinanceKlineCsv(await readFile(String(artifact.extractedCsv), "utf8"), symbol);
    for (const candle of candles) {
      if (candle.openTimeUtc >= V22_START_MS && candle.openTimeUtc < V22_END_MS) {
        if (binanceCloses.has(candle.openTimeUtc)) throw new Error(`duplicate Binance feature timestamp ${symbol} ${candle.openTimeUtc}`);
        binanceCloses.set(candle.openTimeUtc, candle.close);
        binanceOpenTimes.add(candle.openTimeUtc);
      }
    }
  }
  const okxManifest = await jsonFile<{ bodyPath: string }>(`data/raw/v22/okx/${symbol}/manifest.json`);
  const okxLines = splitNdjsonLines(await readFile(okxManifest.bodyPath));
  const okxCandles = parseOkxResponseBodies(okxLines.map((line) => line.toString("utf8")), symbol).candles;
  const okxCloses = new Map<number, number>();
  for (const candle of okxCandles) {
    if (candle.openTimeUtc >= V22_START_MS && candle.openTimeUtc < V22_END_MS) okxCloses.set(candle.openTimeUtc, candle.close);
  }
  return { binanceCloses, okxCloses, binanceOpenTimes };
}

function executionAvailable(execution: ReturnType<typeof buildV22ExecutionContract>, timestamps: ReadonlySet<number>): boolean {
  return [execution.entry.openTimeUtc, execution.primary.exitOpenTimeUtc, execution.diagnostics.fiveMinute.exitOpenTimeUtc, execution.diagnostics.thirtyMinute.exitOpenTimeUtc].every((timestamp) => timestamps.has(timestamp));
}

function buildObservations(binanceCloses: Map<number, number>, okxCloses: Map<number, number>): V22SynchronizedObservation[] {
  const timestamps = [...binanceCloses.keys()].filter((timestamp) => okxCloses.has(timestamp)).sort((left, right) => left - right);
  const observations: V22SynchronizedObservation[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]!;
    const previousTimestamp = timestamps[index - 1]!;
    const binanceClose = binanceCloses.get(timestamp)!;
    const okxClose = okxCloses.get(timestamp)!;
    const previousBinanceClose = binanceCloses.get(previousTimestamp)!;
    const previousOkxClose = okxCloses.get(previousTimestamp)!;
    const binanceReturn = logReturn(binanceClose, previousBinanceClose);
    const okxReturn = logReturn(okxClose, previousOkxClose);
    observations.push({ openTimeUtc: timestamp, binanceClose, okxClose, binanceReturn, okxReturn, gap: okxReturn - binanceReturn });
  }
  return observations;
}

function addReasonAudit(book: AuditBook, symbol: V22Symbol, timestamp: number, direction: V22Direction | null, reason: string): void {
  const reasonKey: Partial<Record<string, AuditCountKey>> = {
    BELOW_THRESHOLD: "belowThreshold",
    NOT_FIRST_CROSS: "notFirstCross",
    VENUE_DIRECTION_MISMATCH: "venueDirectionMismatch",
    OKX_NOT_DOMINANT: "okxNotDominant",
    ZERO_GAP: "zeroGap",
    NONFINITE_SIGNAL: "nonfinite",
    NONFINITE_OBSERVATION: "nonfinite",
  };
  const key = reasonKey[reason];
  if (!key) throw new Error(`unmapped primary rejection ${reason}`);
  addAudit(book, { symbol, signalOpenTimeUtc: timestamp, direction }, key);
}

interface QuantileNode {
  value: number;
  tie: number;
  priority: number;
  size: number;
  left: QuantileNode | null;
  right: QuantileNode | null;
}

function nodeSize(node: QuantileNode | null): number {
  return node?.size ?? 0;
}

function refreshNode(node: QuantileNode): QuantileNode {
  node.size = 1 + nodeSize(node.left) + nodeSize(node.right);
  return node;
}

function compareQuantileKey(value: number, tie: number, node: QuantileNode): number {
  return value - node.value || tie - node.tie;
}

function priorityForTie(tie: number): number {
  let value = (tie + 1) >>> 0;
  value ^= value << 13;
  value >>>= 0;
  value ^= value >>> 17;
  value >>>= 0;
  value ^= value << 5;
  return value >>> 0;
}

function insertQuantile(node: QuantileNode | null, value: number, tie: number): QuantileNode {
  if (!node) return { value, tie, priority: priorityForTie(tie), size: 1, left: null, right: null };
  if (compareQuantileKey(value, tie, node) < 0) {
    node.left = insertQuantile(node.left, value, tie);
    if (node.left.priority > node.priority) {
      const pivot = node.left;
      node.left = pivot.right;
      pivot.right = refreshNode(node);
      return refreshNode(pivot);
    }
  } else {
    node.right = insertQuantile(node.right, value, tie);
    if (node.right.priority > node.priority) {
      const pivot = node.right;
      node.right = pivot.left;
      pivot.left = refreshNode(node);
      return refreshNode(pivot);
    }
  }
  return refreshNode(node);
}

function removeQuantile(node: QuantileNode | null, value: number, tie: number): QuantileNode | null {
  if (!node) throw new Error("quantile window deletion missed key");
  const comparison = compareQuantileKey(value, tie, node);
  if (comparison < 0) node.left = removeQuantile(node.left, value, tie);
  else if (comparison > 0) node.right = removeQuantile(node.right, value, tie);
  else {
    if (!node.left) return node.right;
    if (!node.right) return node.left;
    if (node.left.priority > node.right.priority) {
      const pivot = node.left;
      node.left = pivot.right;
      pivot.right = refreshNode(node);
      pivot.right = removeQuantile(pivot.right, value, tie);
      return refreshNode(pivot);
    }
    const pivot = node.right;
    node.right = pivot.left;
    pivot.left = refreshNode(node);
    pivot.left = removeQuantile(pivot.left, value, tie);
    return refreshNode(pivot);
  }
  return refreshNode(node);
}

class RollingQuantile {
  private root: QuantileNode | null = null;

  add(value: number, tie: number): void {
    this.root = insertQuantile(this.root, value, tie);
  }

  remove(value: number, tie: number): void {
    this.root = removeQuantile(this.root, value, tie);
  }

  atRank(rank: number): number {
    if (!this.root || rank < 1 || rank > this.root.size) throw new Error("quantile rank outside rolling window");
    let node: QuantileNode | null = this.root;
    let remaining = rank;
    while (node) {
      const leftSize = nodeSize(node.left);
      if (remaining === leftSize + 1) return node.value;
      if (remaining <= leftSize) node = node.left;
      else {
        remaining -= leftSize + 1;
        node = node.right;
      }
    }
    throw new Error("quantile rank traversal failed");
  }
}

function priorWindowView(source: readonly V22SynchronizedObservation[], start: number): readonly V22SynchronizedObservation[] {
  const target: V22SynchronizedObservation[] = [];
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === "length") return V22_ROLLING_OBSERVATIONS;
      if (property === "entries") return () => (function* () { for (let index = 0; index < V22_ROLLING_OBSERVATIONS; index += 1) yield [index, source[start + index]!] as [number, V22SynchronizedObservation]; })();
      if (property === "map") return (callback: (value: V22SynchronizedObservation, index: number, array: readonly V22SynchronizedObservation[]) => number) => Array.from({ length: V22_ROLLING_OBSERVATIONS }, (_, index) => callback(source[start + index]!, index, receiver as readonly V22SynchronizedObservation[]));
      if (property === "some") return (callback: (value: V22SynchronizedObservation, index: number, array: readonly V22SynchronizedObservation[]) => boolean) => Array.from({ length: V22_ROLLING_OBSERVATIONS }, (_, index) => callback(source[start + index]!, index, receiver as readonly V22SynchronizedObservation[])).some(Boolean);
      if (typeof property === "string" && /^\d+$/.test(property)) return source[start + Number(property)];
      return Reflect.get(current, property, receiver);
    },
  });
}

function shockReason(currentReturn: number, previousReturn: number, threshold: number): "ZERO_RETURN" | "BELOW_THRESHOLD" | "NOT_FIRST_CROSS" | null {
  if (currentReturn === 0) return "ZERO_RETURN";
  if (Math.abs(currentReturn) < threshold) return "BELOW_THRESHOLD";
  if (!firstCross(currentReturn, previousReturn, threshold)) return "NOT_FIRST_CROSS";
  return null;
}

async function enumerateSymbol(symbol: V22Symbol): Promise<SymbolEnumeration> {
  const { binanceCloses, okxCloses, binanceOpenTimes } = await loadSymbol(symbol);
  const observations = buildObservations(binanceCloses, okxCloses);
  const audit = createAuditBook();
  const primaryRaw: PrimaryRawCandidate[] = [];
  const shockRaw: SymbolEnumeration["shockRaw"] = { OKX_SHOCK_MOMENTUM: [], BINANCE_SHOCK_MOMENTUM: [] };
  const placeboCandidates = new Map<string, number[]>();
  const gapQuantile = new RollingQuantile();
  const okxQuantile = new RollingQuantile();
  const binanceQuantile = new RollingQuantile();
  for (let index = 0; index < observations.length; index += 1) {
    const current = observations[index]!;
    const period = periodForV22Signal(current.openTimeUtc);
    if (!period) continue;
    addAudit(audit, { symbol, signalOpenTimeUtc: current.openTimeUtc }, "featureEvaluations");
    if (index < V22_ROLLING_OBSERVATIONS) {
      addAudit(audit, { symbol, signalOpenTimeUtc: current.openTimeUtc }, "ineligibleWindow");
      continue;
    }
    if (index === V22_ROLLING_OBSERVATIONS) {
      for (let priorIndex = 0; priorIndex < V22_ROLLING_OBSERVATIONS; priorIndex += 1) {
        const observation = observations[priorIndex]!;
        gapQuantile.add(Math.abs(observation.gap), priorIndex);
        okxQuantile.add(Math.abs(observation.okxReturn), priorIndex);
        binanceQuantile.add(Math.abs(observation.binanceReturn), priorIndex);
      }
    } else {
      const removedIndex = index - V22_ROLLING_OBSERVATIONS - 1;
      const addedIndex = index - 1;
      const removed = observations[removedIndex]!;
      const added = observations[addedIndex]!;
      gapQuantile.remove(Math.abs(removed.gap), removedIndex);
      okxQuantile.remove(Math.abs(removed.okxReturn), removedIndex);
      binanceQuantile.remove(Math.abs(removed.binanceReturn), removedIndex);
      gapQuantile.add(Math.abs(added.gap), addedIndex);
      okxQuantile.add(Math.abs(added.okxReturn), addedIndex);
      binanceQuantile.add(Math.abs(added.binanceReturn), addedIndex);
    }
    addAudit(audit, { symbol, signalOpenTimeUtc: current.openTimeUtc }, "eligibleWindows");
    const threshold = gapQuantile.atRank(8_554);
    const gap = current.gap;
    const direction = directionFromSignedReturn(gap);
    let primary: ReturnType<typeof evaluateV22PrimarySignal>;
    const fastReason = ![current.binanceReturn, current.okxReturn, gap].every(Number.isFinite) ? "NONFINITE_SIGNAL" : !direction ? "ZERO_GAP" : Math.abs(gap) < Math.max(threshold, V22_MIN_GAP_LOG) ? "BELOW_THRESHOLD" : !firstCross(gap, observations[index - 1]!.gap, Math.max(threshold, V22_MIN_GAP_LOG)) ? "NOT_FIRST_CROSS" : current.okxReturn * current.binanceReturn < 0 ? "VENUE_DIRECTION_MISMATCH" : Math.abs(current.okxReturn) <= Math.abs(current.binanceReturn) ? "OKX_NOT_DOMINANT" : null;
    if (fastReason) addReasonAudit(audit, symbol, current.openTimeUtc, direction, fastReason);
    else {
      const prior = priorWindowView(observations, index - V22_ROLLING_OBSERVATIONS);
      primary = evaluateV22PrimarySignal({ symbol, signalOpenTimeUtc: current.openTimeUtc, signalCloseTimeUtc: current.openTimeUtc + V22_INTERVAL_MS, binanceReturn: current.binanceReturn, okxReturn: current.okxReturn, priorObservations: prior });
      if (!primary.eligible) throw new Error(`accepted primary evaluator disagreed at ${symbol} ${current.openTimeUtc}: ${primary.reason}`);
      addAudit(audit, { symbol, signalOpenTimeUtc: current.openTimeUtc, direction: primary.candidate.direction }, "rawSignalCandidates");
      const available = executionAvailable(primary.candidate.execution, binanceOpenTimes);
      if (!available) addAudit(audit, { symbol, signalOpenTimeUtc: current.openTimeUtc, direction: primary.candidate.direction }, "executionGridUnavailable");
      else {
        const q99Threshold = threshold;
        primaryRaw.push({ symbol, direction: primary.candidate.direction, signalOpenTimeUtc: current.openTimeUtc, decisionTimeUtc: primary.candidate.decisionTimeUtc, binanceReturn: current.binanceReturn, okxReturn: current.okxReturn, gap: primary.candidate.gap, threshold: primary.candidate.threshold, previousGap: prior[prior.length - 1]!.gap, q99Threshold, execution: primary.candidate.execution, executionAvailable: available });
      }
    }
    const shockInputs: Array<[V22ShockMetric, number, number, "OKX_SHOCK_MOMENTUM" | "BINANCE_SHOCK_MOMENTUM"]> = [["OKX_RETURN", current.okxReturn, okxQuantile.atRank(8_554), "OKX_SHOCK_MOMENTUM"], ["BINANCE_RETURN", current.binanceReturn, binanceQuantile.atRank(8_554), "BINANCE_SHOCK_MOMENTUM"]];
    for (const [metric, currentReturn, metricQ99, kind] of shockInputs) {
      const previousReturn = observations[index - 1]![metric === "OKX_RETURN" ? "okxReturn" : "binanceReturn"];
      const reason = !Number.isFinite(currentReturn) ? "NONFINITE_SIGNAL" : shockReason(currentReturn, previousReturn, Math.max(metricQ99, V22_MIN_GAP_LOG));
      if (reason) continue;
      const shock = evaluateV22ShockSignal({ symbol, metric, signalOpenTimeUtc: current.openTimeUtc, currentReturn, priorObservations: priorWindowView(observations, index - V22_ROLLING_OBSERVATIONS) });
      if (!shock.eligible) {
        const directQ99 = nearestRankQ99(priorWindowView(observations, index - V22_ROLLING_OBSERVATIONS).map((observation) => metric === "OKX_RETURN" ? Math.abs(observation.okxReturn) : Math.abs(observation.binanceReturn)));
        throw new Error(`accepted ${kind} evaluator disagreed at ${symbol} ${current.openTimeUtc}: ${shock.reason}; current=${currentReturn}; rollingQ99=${metricQ99}; directQ99=${directQ99}; previous=${previousReturn}`);
      }
      if (shock.eligible && executionAvailable(buildV22ExecutionContract(current.openTimeUtc), binanceOpenTimes)) shockRaw[kind].push({ ...shock.candidate, executionAvailable: true });
    }
    if (executionAvailable(buildV22ExecutionContract(current.openTimeUtc), binanceOpenTimes)) {
      for (const candidatePeriod of [period]) {
        const keyPrefix = `${candidatePeriod}|${monthUtc(current.openTimeUtc)}|${hourUtc(current.openTimeUtc)}`;
        const list = placeboCandidates.get(keyPrefix) ?? [];
        list.push(current.openTimeUtc);
        placeboCandidates.set(keyPrefix, list);
      }
    }
  }
  return { symbol, instrument: V22_OKX_INSTRUMENTS[symbol], primaryRaw, shockRaw, placeboCandidates, audit };
}

function sortBySignal<T extends { signalOpenTimeUtc: number; symbol: V22Symbol }>(records: T[]): T[] {
  return records.sort(compareV22SignalIdentity);
}

function sortIdentityRecords<T extends Record<string, unknown>>(records: T[]): T[] {
  return records.sort((left, right) => Date.parse(String(left.signalOpenTimeUtc)) - Date.parse(String(right.signalOpenTimeUtc)) || V22_SYMBOLS.indexOf(String(left.symbol) as V22Symbol) - V22_SYMBOLS.indexOf(String(right.symbol) as V22Symbol));
}

function identityDigest(records: readonly Record<string, unknown>[]): { content: string; sha256: string; count: number } {
  const content = records.map(canonicalJsonLine).join("");
  return { content, sha256: sha256(content), count: records.length };
}

function countsByIdentityPeriod(records: readonly { period: V22EnumerationPeriod }[]): Record<V22EnumerationPeriod, number> {
  return Object.fromEntries(V22_PERIODS.map((period) => [period, records.filter((record) => record.period === period).length])) as Record<V22EnumerationPeriod, number>;
}

function primaryIdentity(candidate: PrimaryRawCandidate, instrument: string): Record<string, unknown> {
  return {
    experimentId: V22_EXPERIMENT_ID,
    eventKind: "PRIMARY",
    symbol: candidate.symbol,
    okxInstrument: instrument,
    signalOpenTimeUtc: new Date(candidate.signalOpenTimeUtc).toISOString(),
    decisionTimeUtc: new Date(candidate.decisionTimeUtc).toISOString(),
    direction: candidate.direction,
    binanceReturn: candidate.binanceReturn,
    okxReturn: candidate.okxReturn,
    gap: candidate.gap,
    threshold: candidate.threshold,
    previousGap: candidate.previousGap,
    q99Threshold: candidate.q99Threshold,
    informationDensityFloor: V22_MIN_GAP_LOG,
    informationDensityFloorBps: V22_INFORMATION_DENSITY_FLOOR_BPS,
    entryOpenTimeUtc: new Date(candidate.execution.entry.openTimeUtc).toISOString(),
    primaryExitOpenTimeUtc: new Date(candidate.execution.primary.exitOpenTimeUtc).toISOString(),
    primaryOutcomeBoundaryTimeUtc: new Date(candidate.execution.primary.outcomeBoundaryTimeUtc).toISOString(),
    diagnostic5OpenTimeUtc: new Date(candidate.execution.diagnostics.fiveMinute.exitOpenTimeUtc).toISOString(),
    diagnostic30OpenTimeUtc: new Date(candidate.execution.diagnostics.thirtyMinute.exitOpenTimeUtc).toISOString(),
    entryTimestampAvailable: candidate.executionAvailable,
    primaryExitTimestampAvailable: candidate.executionAvailable,
    diagnostic5TimestampAvailable: candidate.executionAvailable,
    diagnostic30TimestampAvailable: candidate.executionAvailable,
    clusterId: new Date(candidate.signalOpenTimeUtc).toISOString(),
    period: periodForV22Signal(candidate.signalOpenTimeUtc),
    yearUtc: new Date(candidate.signalOpenTimeUtc).getUTCFullYear(),
    monthUtc: monthUtc(candidate.signalOpenTimeUtc),
    hourUtc: hourUtc(candidate.signalOpenTimeUtc),
  };
}

function shockIdentity(candidate: ShockRawCandidate, eventKind: "OKX_SHOCK_MOMENTUM" | "BINANCE_SHOCK_MOMENTUM"): Record<string, unknown> {
  return {
    experimentId: V22_EXPERIMENT_ID,
    eventKind,
    symbol: candidate.symbol,
    signalOpenTimeUtc: new Date(candidate.signalOpenTimeUtc).toISOString(),
    decisionTimeUtc: new Date(candidate.decisionTimeUtc).toISOString(),
    direction: candidate.direction,
    currentReturn: candidate.currentReturn,
    threshold: candidate.threshold,
    previousReturn: candidate.previousReturn,
    clusterId: new Date(candidate.signalOpenTimeUtc).toISOString(),
    period: periodForV22Signal(candidate.signalOpenTimeUtc),
    entryOpenTimeUtc: new Date(candidate.signalOpenTimeUtc + V22_INTERVAL_MS).toISOString(),
    primaryExitOpenTimeUtc: new Date(candidate.signalOpenTimeUtc + 3 * V22_INTERVAL_MS).toISOString(),
    primaryOutcomeBoundaryTimeUtc: new Date(candidate.signalOpenTimeUtc + 4 * V22_INTERVAL_MS).toISOString(),
    entryTimestampAvailable: candidate.executionAvailable,
    primaryExitTimestampAvailable: candidate.executionAvailable,
  };
}

function addOverlapAudit(book: AuditBook, candidate: { symbol: V22Symbol; signalOpenTimeUtc: number; direction: V22Direction }, key: "overlapExcluded" | "acceptedEvents"): void {
  addAudit(book, candidate, key);
}

function matchPlaceboC(primary: readonly Record<string, unknown>[], pools: Map<string, number[]>): { records: Record<string, unknown>[]; state: number; failures: Array<Record<string, unknown>> } {
  let state: number = V22_CONTROL_C_SEED;
  const records: Record<string, unknown>[] = [];
  const failures: Array<Record<string, unknown>> = [];
  const positions: Array<{ symbol: V22Symbol; entryOpenTimeUtc: number; outcomeBoundaryTimeUtc: number; accepted: boolean }> = [];
  const used = new Set<string>();
  for (const event of primary) {
    const symbol = String(event.symbol) as V22Symbol;
    const period = String(event.period) as V22EnumerationPeriod;
    const timestamp = Date.parse(String(event.signalOpenTimeUtc));
    const direction = String(event.direction) as V22Direction;
    const key = placeboStratumKey(symbol, period, timestamp, direction);
    const candidates = (pools.get(key) ?? []).filter((candidateTimestamp) => {
      const candidateKey = `${symbol}|${candidateTimestamp}`;
      if (candidateTimestamp === timestamp || used.has(candidateKey)) return false;
      const execution = buildV22ExecutionContract(candidateTimestamp);
      return acceptV22PrimaryOverlap(positions, { symbol, entryOpenTimeUtc: execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: execution.primary.outcomeBoundaryTimeUtc }).accepted;
    });
    if (!candidates.length) {
      failures.push({ symbol, stratum: key, primarySignalOpenTimeUtc: String(event.signalOpenTimeUtc), reason: "V22_CONTROL_C_MATCHING_INSUFFICIENT" });
      continue;
    }
    state = xorshift32(state);
    const selectedTimestamp = candidates[state % candidates.length]!;
    const selectedKey = `${symbol}|${selectedTimestamp}`;
    used.add(selectedKey);
    const execution = buildV22ExecutionContract(selectedTimestamp);
    positions.push({ symbol, entryOpenTimeUtc: execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: execution.primary.outcomeBoundaryTimeUtc, accepted: true });
    records.push({
      experimentId: V22_EXPERIMENT_ID,
      eventKind: "TIME_MATCHED_RANDOM",
      symbol,
      signalOpenTimeUtc: new Date(selectedTimestamp).toISOString(),
      decisionTimeUtc: new Date(selectedTimestamp + V22_INTERVAL_MS).toISOString(),
      direction,
      matchedPrimarySignalOpenTimeUtc: String(event.signalOpenTimeUtc),
      clusterId: new Date(selectedTimestamp).toISOString(),
      period: periodForV22Signal(selectedTimestamp),
      entryOpenTimeUtc: new Date(execution.entry.openTimeUtc).toISOString(),
      primaryExitOpenTimeUtc: new Date(execution.primary.exitOpenTimeUtc).toISOString(),
      primaryOutcomeBoundaryTimeUtc: new Date(execution.primary.outcomeBoundaryTimeUtc).toISOString(),
      entryTimestampAvailable: true,
      primaryExitTimestampAvailable: true,
      seedHex: V22_CONTROL_C_SEED_HEX,
      seedDecimal: V22_CONTROL_C_SEED,
      prng: "xorshift32",
    });
  }
  return { records: sortIdentityRecords(records), state, failures };
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(REPORT_DIR, name), content, "utf8");
  return sha256(content);
}

async function main(): Promise<void> {
  await assertFrozenSourceProvenance();
  const enumerations: SymbolEnumeration[] = [];
  for (const symbol of V22_SYMBOLS) {
    console.info(JSON.stringify({ stage: "v22_wp3a_symbol_start", symbol }));
    enumerations.push(await enumerateSymbol(symbol));
  }

  const audit = createAuditBook();
  const mergeAudit = (source: AuditBook): void => {
    for (const key of Object.keys(audit.all) as AuditCountKey[]) {
      audit.all[key] += source.all[key];
      for (const period of V22_PERIODS) audit.period[period][key] += source.period[period][key];
      for (const symbol of V22_SYMBOLS) audit.symbol[symbol][key] += source.symbol[symbol][key];
      for (const year of Object.keys(source.year)) (audit.year[year] ??= emptyAudit())[key] += source.year[year]![key];
      for (const direction of ["LONG", "SHORT", "UNKNOWN"] as const) audit.direction[direction][key] += source.direction[direction][key];
    }
  };
  for (const enumeration of enumerations) mergeAudit(enumeration.audit);
  const primaryRaw = sortBySignal(enumerations.flatMap((entry) => entry.primaryRaw));
  const primaryPositions: Array<{ symbol: V22Symbol; entryOpenTimeUtc: number; outcomeBoundaryTimeUtc: number; accepted: boolean }> = [];
  const primaryAccepted: PrimaryRawCandidate[] = [];
  for (const candidate of primaryRaw) {
    const decision = acceptV22PrimaryOverlap(primaryPositions, { symbol: candidate.symbol, entryOpenTimeUtc: candidate.execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: candidate.execution.primary.outcomeBoundaryTimeUtc });
    if (!decision.accepted) addOverlapAudit(audit, candidate, "overlapExcluded");
    else {
      primaryAccepted.push(candidate);
      primaryPositions.push({ symbol: candidate.symbol, entryOpenTimeUtc: candidate.execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: candidate.execution.primary.outcomeBoundaryTimeUtc, accepted: true });
      addOverlapAudit(audit, candidate, "acceptedEvents");
    }
  }
  const primaryIdentities = sortIdentityRecords(primaryAccepted.map((candidate) => primaryIdentity(candidate, V22_OKX_INSTRUMENTS[candidate.symbol])));
  const acceptedByPeriod = countsByIdentityPeriod(primaryIdentities.map((record) => ({ period: record.period as V22EnumerationPeriod })));
  const primaryDistinctClusters = new Set(primaryIdentities.map((record) => String(record.clusterId))).size;
  const primaryBySymbol = Object.fromEntries(V22_SYMBOLS.map((symbol) => [symbol, primaryIdentities.filter((record) => record.symbol === symbol).length]));
  const primaryByDirection = { LONG: primaryIdentities.filter((record) => record.direction === "LONG").length, SHORT: primaryIdentities.filter((record) => record.direction === "SHORT").length };
  const primaryByYear = Object.fromEntries([...new Set(primaryIdentities.map((record) => String(record.yearUtc)))].sort().map((year) => [year, primaryIdentities.filter((record) => String(record.yearUtc) === year).length]));
  const sampleGate = {
    primaryOosAcceptedEvents: acceptedByPeriod.PRIMARY_OOS,
    primaryOosDistinctClusters: new Set(primaryIdentities.filter((record) => record.period === "PRIMARY_OOS").map((record) => String(record.clusterId))).size,
    primaryOosBySymbol: Object.fromEntries(V22_SYMBOLS.map((symbol) => [symbol, primaryIdentities.filter((record) => record.period === "PRIMARY_OOS" && record.symbol === symbol).length])),
    minimumAcceptedEvents: 500,
    minimumDistinctClusters: 250,
    minimumPerFixedSymbol: 50,
  };
  const sampleGatePass = passesV22PreReturnSampleGate({ acceptedEvents: sampleGate.primaryOosAcceptedEvents, distinctClusters: sampleGate.primaryOosDistinctClusters, perSymbol: sampleGate.primaryOosBySymbol as Record<V22Symbol, number> });

  const controlA = sortBySignal(enumerations.flatMap((entry) => entry.shockRaw.OKX_SHOCK_MOMENTUM));
  const controlB = sortBySignal(enumerations.flatMap((entry) => entry.shockRaw.BINANCE_SHOCK_MOMENTUM));
  const acceptShock = (raw: ShockRawCandidate[]): ShockRawCandidate[] => {
    const positions: Array<{ symbol: V22Symbol; entryOpenTimeUtc: number; outcomeBoundaryTimeUtc: number; accepted: boolean }> = [];
    return raw.filter((candidate) => {
      const execution = buildV22ExecutionContract(candidate.signalOpenTimeUtc);
      const accepted = acceptV22PrimaryOverlap(positions, { symbol: candidate.symbol, entryOpenTimeUtc: execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: execution.primary.outcomeBoundaryTimeUtc }).accepted;
      if (accepted) positions.push({ symbol: candidate.symbol, entryOpenTimeUtc: execution.entry.openTimeUtc, outcomeBoundaryTimeUtc: execution.primary.outcomeBoundaryTimeUtc, accepted: true });
      return accepted;
    });
  };
  const controlAIdentities = sortIdentityRecords(acceptShock(controlA).map((candidate) => shockIdentity(candidate, "OKX_SHOCK_MOMENTUM")));
  const controlBIdentities = sortIdentityRecords(acceptShock(controlB).map((candidate) => shockIdentity(candidate, "BINANCE_SHOCK_MOMENTUM")));
  const pools = new Map<string, number[]>();
  for (const enumeration of enumerations) {
    for (const [prefix, timestamps] of enumeration.placeboCandidates) {
      for (const direction of ["LONG", "SHORT"] as const) pools.set(`${enumeration.symbol}|${prefix}|${direction}`, [...timestamps].sort((left, right) => left - right));
    }
  }
  const controlCResult = matchPlaceboC(primaryIdentities, pools);
  const controlCIdentities = controlCResult.records;
  const files = {
    primary: identityDigest(primaryIdentities),
    controlA: identityDigest(controlAIdentities),
    controlB: identityDigest(controlBIdentities),
    controlC: identityDigest(controlCIdentities),
  };
  await writeFile(resolve(REPORT_DIR, "v22-primary-event-identities.jsonl"), files.primary.content, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-control-a-identities.jsonl"), files.controlA.content, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-control-b-identities.jsonl"), files.controlB.content, "utf8");
  await writeFile(resolve(REPORT_DIR, "v22-control-c-identities.jsonl"), files.controlC.content, "utf8");
  const identityFiles = {
    "reports/v22-primary-event-identities.jsonl": files.primary.sha256,
    "reports/v22-control-a-identities.jsonl": files.controlA.sha256,
    "reports/v22-control-b-identities.jsonl": files.controlB.sha256,
    "reports/v22-control-c-identities.jsonl": files.controlC.sha256,
  };
  const periodDigests = Object.fromEntries(V22_PERIODS.map((period) => [period, { primary: identityDigest(primaryIdentities.filter((record) => record.period === period)), controlA: identityDigest(controlAIdentities.filter((record) => record.period === period)), controlB: identityDigest(controlBIdentities.filter((record) => record.period === period)), controlC: identityDigest(controlCIdentities.filter((record) => record.period === period)) }]));
  const classification = !sampleGatePass ? "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT" : controlCResult.failures.length ? "V22_CONTROL_C_MATCHING_INSUFFICIENT" : "V22_PRE_RETURN_SAMPLE_GATE_PASS";
  const researchStop = classification !== "V22_PRE_RETURN_SAMPLE_GATE_PASS";
  const eventEnumerationSha = await writeJson("v22-event-enumeration.json", {
    schema: "v22-event-enumeration-v1",
    experimentId: V22_EXPERIMENT_ID,
    period: { start: new Date(V22_START_MS).toISOString(), endExclusive: new Date(V22_END_MS).toISOString(), signalTimestampField: "signalOpenTimeUtc" },
    fixedSymbols: [...V22_SYMBOLS],
    primary: { all: primaryIdentities.length, byPeriod: acceptedByPeriod, distinctClustersAll: primaryDistinctClusters, bySymbol: primaryBySymbol, byDirection: primaryByDirection, byYear: primaryByYear, rawSignalCandidates: audit.all.rawSignalCandidates },
    sampleGate: { ...sampleGate, pass: sampleGatePass, classification: !sampleGatePass ? "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT" : "PASS" },
    identityFiles,
    periodDigests: Object.fromEntries(V22_PERIODS.map((period) => [period, { primary: periodDigests[period]!.primary.sha256, count: periodDigests[period]!.primary.count }])),
    historicalFeaturePricesRead: true,
    eventEnumerationRun: true,
    strategyOutcomeMappingRun: false,
    executionOutcomePricesRead: false,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    classification,
    researchStop,
    noOutcomePriceFields: true,
  });
  const auditSha = await writeJson("v22-event-audit.json", { schema: "v22-event-audit-v1", experimentId: V22_EXPERIMENT_ID, counts: audit, auditInvariant: "eligibleWindows = reason rejections + rawSignalCandidates; rawSignalCandidates = overlapExcluded + executionGridUnavailable + acceptedEvents", noUnexplainedLoss: true });
  const controlSha = await writeJson("v22-control-enumeration.json", {
    schema: "v22-control-enumeration-v1",
    experimentId: V22_EXPERIMENT_ID,
    controls: {
      OKX_SHOCK_MOMENTUM: { count: controlAIdentities.length, byPeriod: countsByIdentityPeriod(controlAIdentities.map((record) => ({ period: record.period as V22EnumerationPeriod }))), identitySha256: sha256(files.controlA.content) },
      BINANCE_SHOCK_MOMENTUM: { count: controlBIdentities.length, byPeriod: countsByIdentityPeriod(controlBIdentities.map((record) => ({ period: record.period as V22EnumerationPeriod }))), identitySha256: sha256(files.controlB.content) },
      TIME_MATCHED_RANDOM: { count: controlCIdentities.length, byPeriod: countsByIdentityPeriod(controlCIdentities.map((record) => ({ period: record.period as V22EnumerationPeriod }))), identitySha256: sha256(files.controlC.content), expectedCount: primaryIdentities.length },
    },
    randomPlacebo: { seedHex: V22_CONTROL_C_SEED_HEX, seedDecimal: V22_CONTROL_C_SEED, prng: "xorshift32", candidateOrdering: "timestamp ascending", matchOrdering: "signalOpenTimeUtc ascending then fixed symbol order", matchingFailures: controlCResult.failures, finalState: controlCResult.state },
    noFuturePricesUsed: true,
    strategyOutcomeMappingRun: false,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
  });
  const sourceHashes: Record<string, string> = {};
  for (const path of ["lib/v22/enumeration.ts", "lib/v22/signal.ts", "lib/v22/types.ts", "lib/v22/data.ts", "lib/v22/provenance.ts", "scripts/run-v22-wp3a.ts", "tests/v22-enumeration.test.ts", "scripts/validate-v22-wp3a.ts"]) sourceHashes[path] = sha256(await readFile(resolve(path)));
  const manifest = {
    schema: "v22-pre-return-freeze-manifest-v1",
    experimentId: V22_EXPERIMENT_ID,
    branch: "feat/v22-cross-venue-price-discovery",
    baseSha: V22_BASE_SHA,
    directParent: WP2_1_SHA,
    wp1_1AcceptedCommit: WP1_1_SHA,
    wp1_1ManifestSha256: WP1_1_MANIFEST_SHA,
    wp2OriginalCommit: WP2_ORIGINAL_SHA,
    wp2_1Commit: WP2_1_SHA,
    wp2SignalContractSha256: WP2_SIGNAL_CONTRACT_SHA,
    wp2FreezeManifestSha256: WP2_MANIFEST_SHA,
    period: { start: new Date(V22_START_MS).toISOString(), endExclusive: new Date(V22_END_MS).toISOString(), interval: "5m", signalOpenTimeUtc: true, closedCandlesOnly: true },
    fixedSymbols: [...V22_SYMBOLS],
    rawDataPolicy: { source: "WP1.1 frozen official Binance USD-M and OKX USDT-SWAP 5m artifacts", noRedownload: true, noReplacement: true, noGapRepair: true, noForwardFill: true, provenanceAssertionsReexecuted: true },
    sourceFileSha256: sourceHashes,
    signalEvaluatorSha256: SIGNAL_SOURCE_SHA,
    identityFileSha256: identityFiles,
    periodDigests: Object.fromEntries(V22_PERIODS.map((period) => [period, { primary: { sha256: periodDigests[period]!.primary.sha256, count: periodDigests[period]!.primary.count }, controlA: { sha256: periodDigests[period]!.controlA.sha256, count: periodDigests[period]!.controlA.count }, controlB: { sha256: periodDigests[period]!.controlB.sha256, count: periodDigests[period]!.controlB.count }, controlC: { sha256: periodDigests[period]!.controlC.sha256, count: periodDigests[period]!.controlC.count } }])),
    reportSha256: { "reports/v22-event-enumeration.json": eventEnumerationSha, "reports/v22-event-audit.json": auditSha, "reports/v22-control-enumeration.json": controlSha },
    primaryEnumeration: { acceptedAll: primaryIdentities.length, acceptedPrimaryOos: acceptedByPeriod.PRIMARY_OOS, distinctClustersAll: primaryDistinctClusters, sampleGate: { ...sampleGate, pass: sampleGatePass } },
    controlC: { seedHex: V22_CONTROL_C_SEED_HEX, seedDecimal: V22_CONTROL_C_SEED, prng: "xorshift32", generatedOnce: true, matchingFailures: controlCResult.failures.length },
    classification,
    researchStop,
    remainingResearchBudget: 2,
    historicalFeaturePricesRead: true,
    eventEnumerationRun: true,
    primaryIdentitiesFrozen: true,
    controlAIdentitiesFrozen: true,
    controlBIdentitiesFrozen: true,
    controlCIdentitiesFrozen: true,
    executionOutcomePricesRead: false,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    strategyOutcomeMappingRun: false,
    backtestRun: false,
    parameterSearch: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
  };
  const manifestSha = await writeJson("v22-pre-return-freeze-manifest.json", manifest);
  console.info(JSON.stringify({ stage: "v22_wp3a_complete", classification, primary: primaryIdentities.length, primaryOos: acceptedByPeriod.PRIMARY_OOS, controlA: controlAIdentities.length, controlB: controlBIdentities.length, controlC: controlCIdentities.length, manifestSha }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
