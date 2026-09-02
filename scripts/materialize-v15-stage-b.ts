import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ProxyAgent, fetch } from "undici";
import { parseKlineArchive, readZipEntries, validateKlineIntegrity, type KlineIntegrity } from "@/lib/v15/archive";
import { normalizeBinanceTimestamp, type V15Bar } from "@/lib/v15/lead-lag";
import type { V15FundingPoint } from "@/lib/v15/engine";

const REPORT_DIR = resolve("reports");
const STAGE_B_PATH = resolve(REPORT_DIR, "v15-stage-b-archive-manifest.json");
const COST_PATH = resolve(REPORT_DIR, "v15-cost-input-manifest.json");
const STAGE_B_STATE_PATH = resolve(REPORT_DIR, "v15-stage-b-materialization.json");
const COST_STATE_PATH = resolve(REPORT_DIR, "v15-cost-materialization.json");
const PRICE_CACHE_ROOT = resolve("data/raw/v15-spot-perp-lead-lag");
const DIRECT_ROOT = "https://data.binance.vision";
const PROXY = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
const CONCURRENCY = 128;
const CHECKPOINT_EVERY = 256;

type Exchange = "spot" | "futuresUm";

interface StageBRequirement {
  exchange: Exchange;
  symbol: string;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  expectedBytes: number | null;
}

interface StageBManifest {
  schema: "v15-stage-b-archive-manifest-v1";
  requiredArchiveSlots: number;
  missingMetadataSlots: number;
  expectedBytes: number;
  requiredArchives: StageBRequirement[];
  actualUsedArchives: Array<{ exchange: Exchange; symbol: string; month: string; cachePath: string; sha256: string; bytes: number }>;
  [key: string]: unknown;
}

interface ArchiveRecord {
  exchange: Exchange;
  symbol: string;
  month: string;
  sourceUrl: string;
  checksumUrl: string;
  cachePath: string;
  expectedBytes: number | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  bytes: number | null;
  rowCount: number | null;
  integrity: KlineIntegrity | null;
  status: "PASS" | "FAIL";
  error: string | null;
}

interface StageBState {
  schema: "v15-stage-b-materialization-v1";
  sourceStageBManifestSha256: string;
  requiredArchiveSlots: number;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  records: ArchiveRecord[];
}

interface CostPair {
  symbol: string;
  month: string;
}

interface CostRecord {
  symbol: string;
  month: string;
  fundingUrl: string;
  fundingChecksumUrl: string;
  fundingCachePath: string;
  fundingExpectedSha256: string | null;
  fundingActualSha256: string | null;
  fundingBytes: number | null;
  markPriceUrl: string;
  markPriceChecksumUrl: string;
  markPriceCachePath: string;
  markPriceExpectedSha256: string | null;
  markPriceActualSha256: string | null;
  markPriceBytes: number | null;
  normalizedPath: string;
  normalizedSha256: string | null;
  points: number;
  status: "PASS" | "FAIL";
  error: string | null;
}

interface CostState {
  schema: "v15-cost-materialization-v1";
  sourceStageBManifestSha256: string;
  requiredSymbolMonths: number;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  records: CostRecord[];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function request(url: string, as: "text" | "bytes"): Promise<string | Buffer> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        dispatcher: PROXY,
        headers: { "user-agent": "binance-crypto-alerts-v15-materializer/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return as === "text" ? await response.text() : Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function checksumValue(text: string): string {
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error("official checksum response did not contain a SHA-256 digest");
  return match[0].toLowerCase();
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.part`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

interface RawArchiveResult {
  expectedSha256: string;
  actualSha256: string;
  bytes: number;
  payload: Buffer;
}

async function fetchRawArchive(sourceUrl: string, checksumUrl: string, cachePath: string, expectedBytes: number | null): Promise<RawArchiveResult> {
  let payload: Buffer;
  try {
    const checksumText = await request(checksumUrl, "text") as string;
    const expectedSha256 = checksumValue(checksumText);
    payload = await readFile(resolve(cachePath));
    const actualSha256 = sha256(payload);
    if (actualSha256 !== expectedSha256) throw new Error(`official checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    if (expectedBytes !== null && payload.length !== expectedBytes) throw new Error(`archive byte length mismatch: expected ${expectedBytes}, got ${payload.length}`);
    return await finishRawArchive(sourceUrl, checksumUrl, cachePath, expectedSha256, payload, actualSha256, expectedBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [checksumText, downloaded] = await Promise.all([
    request(checksumUrl, "text"),
    request(sourceUrl, "bytes"),
  ]);
  const expectedSha256 = checksumValue(checksumText as string);
  payload = downloaded as Buffer;
  const actualSha256 = sha256(payload);
  if (actualSha256 !== expectedSha256) throw new Error(`official checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  if (expectedBytes !== null && payload.length !== expectedBytes) throw new Error(`archive byte length mismatch: expected ${expectedBytes}, got ${payload.length}`);
  return await finishRawArchive(sourceUrl, checksumUrl, cachePath, expectedSha256, payload, actualSha256, expectedBytes);
}

async function finishRawArchive(sourceUrl: string, _checksumUrl: string, cachePath: string, expectedSha256: string, payload: Buffer, actualSha256: string, expectedBytes: number | null): Promise<RawArchiveResult> {
  if (actualSha256 !== expectedSha256) throw new Error(`official checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  if (expectedBytes !== null && payload.length !== expectedBytes) throw new Error(`archive byte length mismatch: expected ${expectedBytes}, got ${payload.length}`);
  try {
    const existing = await readFile(resolve(cachePath));
    if (sha256(existing) !== actualSha256) throw new Error(`immutable cache collision at ${cachePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(resolve(cachePath), payload);
  }
  const checksumPath = `${resolve(cachePath)}.CHECKSUM`;
  const canonicalChecksum = `${expectedSha256}  ${basename(sourceUrl)}\n`;
  try {
    const existing = await readFile(checksumPath, "utf8");
    if (checksumValue(existing) !== expectedSha256) throw new Error(`immutable checksum sidecar collision at ${checksumPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(checksumPath, Buffer.from(canonicalChecksum, "utf8"));
  }
  return { expectedSha256, actualSha256, bytes: payload.length, payload };
}

function validKline(integrity: KlineIntegrity): boolean {
  return integrity.duplicateOpenTimes === 0
    && integrity.nonMonotonicOpenTimes === 0
    && integrity.invalidDurations === 0
    && integrity.cadenceCoverage >= 0.99;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
  return results;
}

function archiveKey(row: { exchange: Exchange; symbol: string; month: string }): string {
  return `${row.exchange}/${row.symbol}/${row.month}`;
}

async function loadStageBState(stageB: StageBManifest, sourceHash: string): Promise<StageBState> {
  try {
    const state = await readJson<StageBState>(STAGE_B_STATE_PATH);
    if (state.sourceStageBManifestSha256 !== sourceHash || state.requiredArchiveSlots !== stageB.requiredArchives.length) {
      throw new Error("existing Stage B materialization state does not match the exact current Stage B manifest");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    return { schema: "v15-stage-b-materialization-v1", sourceStageBManifestSha256: sourceHash, requiredArchiveSlots: stageB.requiredArchives.length, startedAt: now, updatedAt: now, complete: false, records: [] };
  }
}

async function materializePriceArchive(requirement: StageBRequirement): Promise<ArchiveRecord> {
  const base: ArchiveRecord = { ...requirement, expectedSha256: null, actualSha256: null, bytes: null, rowCount: null, integrity: null, status: "FAIL", error: null };
  try {
    const raw = await fetchRawArchive(requirement.sourceUrl, requirement.checksumUrl, requirement.cachePath, requirement.expectedBytes);
    const bars = parseKlineArchive(raw.payload);
    const integrity = validateKlineIntegrity(bars);
    if (!bars.length || !validKline(integrity)) throw new Error(`kline integrity failed: ${JSON.stringify(integrity)}`);
    return { ...base, expectedSha256: raw.expectedSha256, actualSha256: raw.actualSha256, bytes: raw.bytes, rowCount: bars.length, integrity, status: "PASS" };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runPrice(): Promise<void> {
  const stageB = await readJson<StageBManifest>(STAGE_B_PATH);
  const sourceBytes = await readFile(STAGE_B_PATH);
  const sourceHash = sha256(sourceBytes);
  const state = await loadStageBState(stageB, sourceHash);
  const records = new Map(state.records.map((record) => [archiveKey(record), record]));
  const pending = stageB.requiredArchives.filter((requirement) => records.get(archiveKey(requirement))?.status !== "PASS");
  console.info(JSON.stringify({ phase: "price", required: stageB.requiredArchives.length, alreadyPassed: stageB.requiredArchives.length - pending.length, pending: pending.length }));
  for (let offset = 0; offset < pending.length; offset += CHECKPOINT_EVERY) {
    const batch = pending.slice(offset, offset + CHECKPOINT_EVERY);
    const results = await mapLimit(batch, CONCURRENCY, materializePriceArchive);
    for (const result of results) records.set(archiveKey(result), result);
    const now = new Date().toISOString();
    state.updatedAt = now;
    state.records = stageB.requiredArchives.map((requirement) => records.get(archiveKey(requirement))).filter((record): record is ArchiveRecord => Boolean(record));
    state.complete = state.records.length === stageB.requiredArchives.length && state.records.every((record) => record.status === "PASS");
    await writeJson(STAGE_B_STATE_PATH, state);
    const passed = state.records.filter((record) => record.status === "PASS").length;
    const failed = state.records.filter((record) => record.status === "FAIL" && record.error).length;
    console.info(JSON.stringify({ phase: "price", processed: Math.min(offset + batch.length, pending.length), pending: pending.length - Math.min(offset + batch.length, pending.length), passed, failed }));
  }
  state.records = stageB.requiredArchives.map((requirement) => records.get(archiveKey(requirement))).filter((record): record is ArchiveRecord => Boolean(record));
  state.complete = state.records.length === stageB.requiredArchives.length && state.records.every((record) => record.status === "PASS");
  await writeJson(STAGE_B_STATE_PATH, state);
  if (!state.complete) throw new Error(`Stage B price materialization incomplete: ${state.records.filter((record) => record.status === "PASS").length}/${stageB.requiredArchives.length} passed`);
  const actualUsedArchives = state.records.map((record) => ({ exchange: record.exchange, symbol: record.symbol, month: record.month, cachePath: record.cachePath, sha256: record.actualSha256 as string, bytes: record.bytes as number }));
  const updated: StageBManifest = {
    ...stageB,
    requiredArchives: stageB.requiredArchives.map((requirement) => ({ ...requirement, expectedBytes: records.get(archiveKey(requirement))?.bytes ?? requirement.expectedBytes })),
    missingMetadataSlots: 0,
    expectedBytes: state.records.reduce((sum, record) => sum + (record.bytes ?? 0), 0),
    actualUsedArchives,
  };
  await writeJson(STAGE_B_PATH, updated);
  state.sourceStageBManifestSha256 = sha256(Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8"));
  await writeJson(STAGE_B_STATE_PATH, state);
  console.info(JSON.stringify({ phase: "price", status: "PASS", materializedArchiveSlots: actualUsedArchives.length }));
}

function costUrls(symbol: string, month: string): { fundingUrl: string; markPriceUrl: string } {
  return {
    fundingUrl: `${DIRECT_ROOT}/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`,
    markPriceUrl: `${DIRECT_ROOT}/data/futures/um/monthly/markPriceKlines/${symbol}/5m/${symbol}-5m-${month}.zip`,
  };
}

function fundingCachePath(symbol: string, month: string): string {
  return `data/raw/v15-spot-perp-lead-lag/fundingRate/${symbol}/${month}.zip`;
}

function markPriceCachePath(symbol: string, month: string): string {
  return `data/raw/v15-spot-perp-lead-lag/markPriceKlines/${symbol}/${month}.zip`;
}

function normalizedFundingPath(symbol: string, month: string): string {
  return `data/raw/v15-spot-perp-lead-lag/funding/${symbol}/${month}.json`;
}

function parseFundingArchive(buffer: Buffer): Array<{ timestamp: number; fundingRate: number }> {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("funding archive contained no data file");
  const lines = entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  const points = lines.slice(1).map((line) => line.split(",")).map((fields) => ({ timestamp: normalizeBinanceTimestamp(fields[0] ?? ""), fundingRate: Number(fields[2]) })).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.fundingRate));
  if (!points.length) throw new Error("funding archive contained no valid rows");
  return points;
}

function markPriceAt(timestamp: number, marks: V15Bar[]): number | null {
  let candidate: V15Bar | null = null;
  for (const bar of marks) {
    if (bar.openTime > timestamp) break;
    candidate = bar;
    if (timestamp >= bar.openTime && timestamp <= bar.closeTime) return bar.open;
  }
  return candidate && candidate.openTime <= timestamp ? candidate.open : null;
}

async function writeNormalized(path: string, value: { symbol: string; month: string; points: V15FundingPoint[] }): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    const existing = await readFile(resolve(path));
    const existingHash = sha256(existing);
    const nextHash = sha256(bytes);
    if (existingHash !== nextHash) throw new Error(`immutable normalized funding collision at ${path}`);
    return existingHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(resolve(path), bytes);
    return sha256(bytes);
  }
}

async function loadCostState(sourceHash: string, requiredSymbolMonths: number): Promise<CostState> {
  try {
    const state = await readJson<CostState>(COST_STATE_PATH);
    if (state.sourceStageBManifestSha256 !== sourceHash || state.requiredSymbolMonths !== requiredSymbolMonths) throw new Error("existing cost materialization state does not match the exact current Stage B manifest");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    return { schema: "v15-cost-materialization-v1", sourceStageBManifestSha256: sourceHash, requiredSymbolMonths, startedAt: now, updatedAt: now, complete: false, records: [] };
  }
}

async function materializeCostPair(pair: CostPair): Promise<CostRecord> {
  const urls = costUrls(pair.symbol, pair.month);
  const fundingCache = fundingCachePath(pair.symbol, pair.month);
  const markPriceCache = markPriceCachePath(pair.symbol, pair.month);
  const normalizedPath = normalizedFundingPath(pair.symbol, pair.month);
  const base: CostRecord = {
    symbol: pair.symbol, month: pair.month,
    fundingUrl: urls.fundingUrl, fundingChecksumUrl: `${urls.fundingUrl}.CHECKSUM`, fundingCachePath: fundingCache, fundingExpectedSha256: null, fundingActualSha256: null, fundingBytes: null,
    markPriceUrl: urls.markPriceUrl, markPriceChecksumUrl: `${urls.markPriceUrl}.CHECKSUM`, markPriceCachePath: markPriceCache, markPriceExpectedSha256: null, markPriceActualSha256: null, markPriceBytes: null,
    normalizedPath, normalizedSha256: null, points: 0, status: "FAIL", error: null,
  };
  try {
    const [funding, mark] = await Promise.all([
      fetchRawArchive(urls.fundingUrl, `${urls.fundingUrl}.CHECKSUM`, fundingCache, null),
      fetchRawArchive(urls.markPriceUrl, `${urls.markPriceUrl}.CHECKSUM`, markPriceCache, null),
    ]);
    const marks = parseKlineArchive(mark.payload);
    const markIntegrity = validateKlineIntegrity(marks);
    if (!marks.length || !validKline(markIntegrity)) throw new Error(`mark-price integrity failed: ${JSON.stringify(markIntegrity)}`);
    const rawFunding = parseFundingArchive(funding.payload);
    const points: V15FundingPoint[] = rawFunding.map((point) => ({ timestamp: point.timestamp, fundingRate: point.fundingRate, markPrice: markPriceAt(point.timestamp, marks) ?? Number.NaN }));
    if (points.some((point) => !Number.isFinite(point.markPrice) || point.markPrice <= 0)) throw new Error("mark-price settlement unavailable for one or more funding timestamps");
    const normalizedSha256 = await writeNormalized(normalizedPath, { symbol: pair.symbol, month: pair.month, points });
    return { ...base, fundingExpectedSha256: funding.expectedSha256, fundingActualSha256: funding.actualSha256, fundingBytes: funding.bytes, markPriceExpectedSha256: mark.expectedSha256, markPriceActualSha256: mark.actualSha256, markPriceBytes: mark.bytes, normalizedSha256, points: points.length, status: "PASS" };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCost(): Promise<void> {
  const stageB = await readJson<StageBManifest>(STAGE_B_PATH);
  const stageBHash = sha256(await readFile(STAGE_B_PATH));
  const pairs = [...new Set(stageB.requiredArchives.map((row) => `${row.symbol}/${row.month}`))].map((value) => {
    const [symbol, month] = value.split("/");
    return { symbol, month };
  }).sort((left, right) => `${left.symbol}/${left.month}`.localeCompare(`${right.symbol}/${right.month}`));
  const state = await loadCostState(stageBHash, pairs.length);
  const records = new Map(state.records.map((record) => [`${record.symbol}/${record.month}`, record]));
  const pending = pairs.filter((pair) => records.get(`${pair.symbol}/${pair.month}`)?.status !== "PASS");
  console.info(JSON.stringify({ phase: "cost", requiredSymbolMonths: pairs.length, alreadyPassed: pairs.length - pending.length, pending: pending.length }));
  for (let offset = 0; offset < pending.length; offset += CHECKPOINT_EVERY) {
    const batch = pending.slice(offset, offset + CHECKPOINT_EVERY);
    const results = await mapLimit(batch, CONCURRENCY, materializeCostPair);
    for (const result of results) records.set(`${result.symbol}/${result.month}`, result);
    const now = new Date().toISOString();
    state.updatedAt = now;
    state.records = pairs.map((pair) => records.get(`${pair.symbol}/${pair.month}`)).filter((record): record is CostRecord => Boolean(record));
    state.complete = state.records.length === pairs.length && state.records.every((record) => record.status === "PASS");
    await writeJson(COST_STATE_PATH, state);
    const passed = state.records.filter((record) => record.status === "PASS").length;
    const failed = state.records.filter((record) => record.status === "FAIL" && record.error).length;
    console.info(JSON.stringify({ phase: "cost", processed: Math.min(offset + batch.length, pending.length), pending: pending.length - Math.min(offset + batch.length, pending.length), passed, failed }));
  }
  state.records = pairs.map((pair) => records.get(`${pair.symbol}/${pair.month}`)).filter((record): record is CostRecord => Boolean(record));
  state.complete = state.records.length === pairs.length && state.records.every((record) => record.status === "PASS");
  await writeJson(COST_STATE_PATH, state);
  if (!state.complete) throw new Error(`Cost input materialization incomplete: ${state.records.filter((record) => record.status === "PASS").length}/${pairs.length} passed`);
  const normalizedFiles = state.records.map((record) => record.normalizedPath);
  const markFiles = state.records.map((record) => record.markPriceCachePath);
  await writeJson(COST_PATH, {
    schema: "v15-cost-input-manifest-v1",
    funding: { sourceTemplate: `${DIRECT_ROOT}/data/futures/um/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{month}.zip`, requiredSymbolMonths: pairs.length, materializedSymbolMonths: normalizedFiles.length, coverage: normalizedFiles.length / pairs.length, actualFiles: normalizedFiles },
    markPrice: { sourceTemplate: `${DIRECT_ROOT}/data/futures/um/monthly/markPriceKlines/{symbol}/5m/{symbol}-5m-{month}.zip`, requiredArchiveSlots: pairs.length, materializedArchiveSlots: markFiles.length, coverage: markFiles.length / pairs.length, actualFiles: markFiles },
    noFallback: true,
  });
  console.info(JSON.stringify({ phase: "cost", status: "PASS", materializedSymbolMonths: normalizedFiles.length, markPriceArchives: markFiles.length }));
}

async function main(): Promise<void> {
  const kind = process.argv.find((arg) => arg.startsWith("--kind="))?.split("=")[1] ?? "price";
  if (kind === "price") await runPrice();
  else if (kind === "cost") await runCost();
  else throw new Error(`unknown materialization kind: ${kind}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
