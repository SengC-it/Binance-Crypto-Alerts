import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { Candle } from "@/lib/core/types";

export const BINANCE_DATA_VISION_S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
export const BINANCE_DATA_VISION_ROOT = "https://data.binance.vision/data/futures/um/monthly";
export const BINANCE_UM_KLINE_PREFIX = "data/futures/um/monthly/klines/";
export const BINANCE_UM_FUNDING_PREFIX = "data/futures/um/monthly/fundingRate/";
export const BINANCE_UM_MARK_PREFIX = "data/futures/um/monthly/markPriceKlines/";

export type LfvArchiveTimeframe = "1d" | "15m" | "1h" | "4h" | "funding" | "markPriceKlines";

export interface S3Listing {
  keys: string[];
  prefixes: string[];
  truncated: boolean;
  pages: number;
}

export interface LfvArchiveAvailability {
  symbol: string;
  firstObserved: string | null;
  lastObserved: string | null;
  checksumStatus: "DISCOVERY_ONLY_NOT_DOWNLOADED" | "USED_ARCHIVES_VERIFIED" | "FAILED";
  available1dMonths: string[];
  available15mMonths: string[];
  available1hMonths: string[];
  available4hMonths: string[];
  fundingMonths: string[];
  markPriceKlineMonths: string[];
  sourceIndexHashes: Record<string, string>;
}

export interface LfvBar extends Candle {
  quoteVolume: number;
}

export interface PitUniversePoint {
  symbol: string;
  latestBarTime: number;
  quoteVolume24h: number;
}

export interface PitUniverseSnapshot {
  timestamp: number;
  eligible: PitUniversePoint[];
  deepScan: string[];
  effectiveUniverseSize: number;
}

export interface ArchiveChecksumRecord {
  symbol: string;
  timeframe: LfvArchiveTimeframe;
  period: string;
  sourceUrl: string;
  cachePath: string | null;
  status: "AVAILABLE" | "MISSING" | "FAILED";
  bytes: number;
  rowCount: number;
  sha256: string | null;
  expectedSha256: string | null;
  checksumStatus: "PASS" | "FAIL" | "NOT_CHECKED";
  error?: string;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function parseS3XmlValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeXmlText(match[1]));
}

export function parseS3CommonPrefixes(xml: string): string[] {
  const pattern = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g;
  return [...xml.matchAll(pattern)].map((match) => decodeXmlText(match[1])).sort();
}

export function parseS3Keys(xml: string): string[] {
  const pattern = /<Contents>\s*<Key>([^<]+)<\/Key>/g;
  return [...xml.matchAll(pattern)].map((match) => decodeXmlText(match[1])).sort();
}

export function parseS3ListingPage(xml: string): { keys: string[]; prefixes: string[]; truncated: boolean; nextToken: string | null } {
  return {
    keys: parseS3Keys(xml),
    prefixes: parseS3CommonPrefixes(xml),
    truncated: parseS3XmlValues(xml, "IsTruncated")[0] === "true",
    nextToken: parseS3XmlValues(xml, "NextContinuationToken")[0] ?? null,
  };
}

export async function listS3Objects(
  prefix: string,
  options: { delimiter?: string; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; s3Root?: string } = {},
): Promise<S3Listing> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const s3Root = options.s3Root ?? BINANCE_DATA_VISION_S3;
  const keys: string[] = [];
  const prefixes: string[] = [];
  let continuationToken: string | null = null;
  let truncated = false;
  let pages = 0;
  do {
    const query = new URLSearchParams({ "list-type": "2", prefix });
    if (options.delimiter) query.set("delimiter", options.delimiter);
    if (continuationToken) query.set("continuation-token", continuationToken);
    const response = await fetchImpl(`${s3Root}/?${query.toString()}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`official archive listing failed: HTTP ${response.status} for ${prefix}`);
    const page = parseS3ListingPage(await response.text());
    keys.push(...page.keys);
    prefixes.push(...page.prefixes);
    truncated = page.truncated;
    continuationToken = page.nextToken;
    pages += 1;
    if (truncated && !continuationToken) throw new Error(`truncated archive listing without continuation token: ${prefix}`);
  } while (truncated);
  return { keys: [...new Set(keys)].sort(), prefixes: [...new Set(prefixes)].sort(), truncated: false, pages };
}

export function archiveUrl(symbol: string, timeframe: LfvArchiveTimeframe, period: string): string {
  if (timeframe === "funding") return `${BINANCE_DATA_VISION_ROOT}/fundingRate/${symbol}/${symbol}-fundingRate-${period}.zip`;
  if (timeframe === "markPriceKlines") return `${BINANCE_DATA_VISION_ROOT}/markPriceKlines/${symbol}/1m/${symbol}-1m-${period}.zip`;
  return `${BINANCE_DATA_VISION_ROOT}/klines/${symbol}/${timeframe}/${symbol}-${timeframe}-${period}.zip`;
}

export function archiveIndexPrefix(timeframe: LfvArchiveTimeframe, symbol: string): string {
  if (timeframe === "funding") return `${BINANCE_UM_FUNDING_PREFIX}${symbol}/`;
  if (timeframe === "markPriceKlines") return `${BINANCE_UM_MARK_PREFIX}${symbol}/1m/`;
  return `${BINANCE_UM_KLINE_PREFIX}${symbol}/${timeframe}/`;
}

export function periodsFromArchiveKeys(keys: string[], symbol: string, timeframe: LfvArchiveTimeframe): string[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = timeframe === "funding"
    ? `${escaped}-fundingRate`
    : timeframe === "markPriceKlines" ? `${escaped}-1m` : `${escaped}-${timeframe}`;
  const pattern = new RegExp(`${suffix}-(\\d{4}-\\d{2})\\.zip$`);
  return [...new Set(keys.map((key) => key.match(pattern)?.[1]).filter((value): value is string => Boolean(value)))].sort();
}

export function coverageRatio(required: readonly string[], available: readonly string[]): number {
  if (required.length === 0) return 0;
  const availableSet = new Set(available);
  return required.filter((period) => availableSet.has(period)).length / required.length;
}

export function buildArchiveAvailability(
  symbol: string,
  timeframeKeys: Record<LfvArchiveTimeframe, string[]>,
): LfvArchiveAvailability {
  const allLifecycleMonths = [...new Set([
    ...periodsFromArchiveKeys(timeframeKeys["1d"], symbol, "1d"),
    ...periodsFromArchiveKeys(timeframeKeys["15m"], symbol, "15m"),
    ...periodsFromArchiveKeys(timeframeKeys["1h"], symbol, "1h"),
    ...periodsFromArchiveKeys(timeframeKeys["4h"], symbol, "4h"),
  ])].sort();
  const firstObserved = allLifecycleMonths[0] ?? null;
  const lastObserved = allLifecycleMonths.at(-1) ?? null;
  return {
    symbol,
    firstObserved,
    lastObserved,
    checksumStatus: "DISCOVERY_ONLY_NOT_DOWNLOADED",
    available1dMonths: periodsFromArchiveKeys(timeframeKeys["1d"], symbol, "1d"),
    available15mMonths: periodsFromArchiveKeys(timeframeKeys["15m"], symbol, "15m"),
    available1hMonths: periodsFromArchiveKeys(timeframeKeys["1h"], symbol, "1h"),
    available4hMonths: periodsFromArchiveKeys(timeframeKeys["4h"], symbol, "4h"),
    fundingMonths: periodsFromArchiveKeys(timeframeKeys.funding, symbol, "funding"),
    markPriceKlineMonths: periodsFromArchiveKeys(timeframeKeys.markPriceKlines, symbol, "markPriceKlines"),
    sourceIndexHashes: Object.fromEntries(Object.entries(timeframeKeys).map(([key, value]) => [key, sha256Text(stableStringify(value))])),
  };
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("ZIP entry exceeds archive length");
    const name = buffer.subarray(nameStart, dataStart - extraLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP compression method ${method}`); })();
    entries.push({ name, data });
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("ZIP archive contained no local file entries");
  return entries;
}

export function parseKlineArchive(buffer: Buffer): LfvBar[] {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("ZIP archive contained no kline data file");
  const output: LfvBar[] = [];
  for (const line of entry.data.toString("utf8").split(/\r?\n/).filter((value) => value.trim())) {
    const fields = splitCsvLine(line);
    if (fields.length < 8 || !Number.isFinite(Number(fields[0]))) continue;
    const values = [fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], fields[7]].map(Number);
    if (!values.every(Number.isFinite)) continue;
    output.push({ openTime: values[0], open: values[1], high: values[2], low: values[3], close: values[4], volume: values[5], closeTime: values[6], quoteVolume: values[7] });
  }
  return output;
}

export function dedupeBars(bars: LfvBar[]): LfvBar[] {
  return [...new Map(bars.map((bar) => [bar.openTime, bar])).values()].sort((left, right) => left.openTime - right.openTime);
}

export function buildPitUniverseSnapshot(
  timestamp: number,
  barsBySymbol: Map<string, LfvBar[]>,
  options: { topSymbols: number; minimumAgeDays: number; recentDays: number; minimumRecentBars: number } = { topSymbols: 100, minimumAgeDays: 90, recentDays: 30, minimumRecentBars: 28 },
): PitUniverseSnapshot {
  const eligible: PitUniversePoint[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    const ordered = dedupeBars(bars);
    const latest = [...ordered].reverse().find((bar) => bar.closeTime <= timestamp);
    if (!latest || latest.quoteVolume <= 0) continue;
    const first = ordered[0];
    if (!first || latest.openTime - first.openTime < options.minimumAgeDays * 86_400_000) continue;
    const recent = ordered.filter((bar) => bar.openTime <= latest.openTime && bar.openTime > latest.openTime - options.recentDays * 86_400_000);
    if (recent.length < options.minimumRecentBars || recent.some((bar) => bar.quoteVolume <= 0)) continue;
    eligible.push({ symbol, latestBarTime: latest.openTime, quoteVolume24h: latest.quoteVolume });
  }
  eligible.sort((left, right) => right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol));
  const deepScan = eligible.slice(0, Math.min(options.topSymbols, eligible.length)).map((item) => item.symbol);
  return { timestamp, eligible, deepScan, effectiveUniverseSize: deepScan.length };
}

export function validatePitSnapshot(snapshot: PitUniverseSnapshot, timestamp: number): boolean {
  return snapshot.timestamp === timestamp
    && snapshot.deepScan.length === Math.min(100, snapshot.eligible.length)
    && snapshot.deepScan.every((symbol) => snapshot.eligible.some((candidate) => candidate.symbol === symbol && candidate.latestBarTime <= timestamp));
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { fields.push(current); current = ""; }
    else current += character;
  }
  fields.push(current);
  return fields;
}
