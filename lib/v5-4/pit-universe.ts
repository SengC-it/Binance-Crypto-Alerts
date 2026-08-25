import { createHash } from "node:crypto";

export const V54_PIT_SCHEMA = "bca-pit-universe-v1" as const;
export const BINANCE_DATA_VISION_BUCKET = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
export const BINANCE_UM_MONTHLY_PREFIX = "data/futures/um/monthly/klines/";
export const BINANCE_UM_MONTHLY_INTERVAL = "15m" as const;

export type PitUniverseStatus = "VERIFIED_CONSERVATIVE" | "INCOMPLETE";

export interface PitArchiveSymbolEvidence {
  symbol: string;
  interval: typeof BINANCE_UM_MONTHLY_INTERVAL;
  objectCount: number;
  observedMonths: string[];
  observedFirstMonth: string | null;
  observedLastMonth: string | null;
  listingDate: null;
  delistingDate: null;
  tradableStart: string | null;
  tradableEnd: string | null;
  contractStatus: "HISTORICAL_STATUS_UNAVAILABLE";
  boundaryPrecision: "MONTH";
  source: string;
  rawHash: string;
}

export interface PitUniverseManifest {
  schema: typeof V54_PIT_SCHEMA;
  status: PitUniverseStatus;
  source: string;
  retrievalTimestamp: string;
  rawHashes: {
    rootIndex: string;
    symbolIndexes: Record<string, string>;
  };
  archiveIndexUrl: string;
  monthlyInterval: typeof BINANCE_UM_MONTHLY_INTERVAL;
  rootArchiveSymbolCount: number;
  rootArchiveSymbols: string[];
  evidenceSymbols: PitArchiveSymbolEvidence[];
  methodology: string[];
  limitations: string[];
}

export interface PitFoldWindow {
  id: string;
  start: number;
  end: number;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function parseS3CommonPrefixes(xml: string): string[] {
  const prefixes: string[] = [];
  const pattern = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g;
  for (const match of xml.matchAll(pattern)) prefixes.push(decodeXmlText(match[1]));
  return [...new Set(prefixes)].sort();
}

export function parseS3Keys(xml: string): string[] {
  const keys: string[] = [];
  const pattern = /<Contents>\s*<Key>([^<]+)<\/Key>/g;
  for (const match of xml.matchAll(pattern)) keys.push(decodeXmlText(match[1]));
  return [...new Set(keys)].sort();
}

export function archiveSymbolFromPrefix(prefix: string): string | null {
  const match = prefix.match(/\/([^/]+)\/$/);
  const symbol = match?.[1] ?? null;
  if (!symbol || !symbol.endsWith("USDT") || symbol.endsWith("USDTSETTLED")) return null;
  return symbol;
}

export function parseMonthly15mMonths(keys: string[], symbol: string): string[] {
  const months: string[] = [];
  const pattern = new RegExp(`/${escapeRegExp(symbol)}/15m/[^/]+-15m-(\\d{4}-\\d{2})\\.zip$`);
  for (const key of keys) {
    const match = key.match(pattern);
    if (match) months.push(match[1]);
  }
  return [...new Set(months)].sort();
}

export function buildPitSymbolEvidence(
  symbol: string,
  keys: string[],
  rawHash: string,
  source = `${BINANCE_DATA_VISION_BUCKET}/${BINANCE_UM_MONTHLY_PREFIX}${symbol}/15m/`,
): PitArchiveSymbolEvidence {
  const observedMonths = parseMonthly15mMonths(keys, symbol);
  const firstMonth = observedMonths[0] ?? null;
  const lastMonth = observedMonths.at(-1) ?? null;
  const firstMonthStart = firstMonth ? monthStart(firstMonth) : null;
  const lastMonthStart = lastMonth ? monthStart(lastMonth) : null;
  // The first and last archive months can be partial. Excluding them prevents
  // intra-month listing/delisting leakage while retaining only observed data.
  const conservativeStart = firstMonthStart ? addMonths(firstMonthStart, 1) : null;
  const conservativeEnd = lastMonthStart ? new Date(lastMonthStart - 1).toISOString() : null;
  return {
    symbol,
    interval: BINANCE_UM_MONTHLY_INTERVAL,
    objectCount: keys.filter((key) => key.endsWith(".zip")).length,
    observedMonths,
    observedFirstMonth: firstMonth,
    observedLastMonth: lastMonth,
    listingDate: null,
    delistingDate: null,
    tradableStart: conservativeStart ? new Date(conservativeStart).toISOString() : null,
    tradableEnd: conservativeEnd,
    contractStatus: "HISTORICAL_STATUS_UNAVAILABLE",
    boundaryPrecision: "MONTH",
    source,
    rawHash,
  };
}

export function isPitTradableAt(record: PitArchiveSymbolEvidence, timestamp: number): boolean {
  if (!record.tradableStart || !record.tradableEnd) return false;
  if (timestamp < Date.parse(record.tradableStart) || timestamp > Date.parse(record.tradableEnd)) return false;
  const month = new Date(timestamp).toISOString().slice(0, 7);
  return record.observedMonths.includes(month);
}

export function buildFoldUniverse(
  records: PitArchiveSymbolEvidence[],
  timestamp: number,
): string[] {
  return records.filter((record) => isPitTradableAt(record, timestamp)).map((record) => record.symbol).sort();
}

export function validateNoSurvivorLeakage(
  records: PitArchiveSymbolEvidence[],
  timestamp: number,
  requestedSymbols: string[],
): { included: string[]; excluded: string[]; unknown: string[] } {
  const available = new Set(buildFoldUniverse(records, timestamp));
  const requested = [...new Set(requestedSymbols)].sort();
  return {
    included: requested.filter((symbol) => available.has(symbol)),
    excluded: requested.filter((symbol) => !available.has(symbol)),
    unknown: requested.filter((symbol) => !records.some((record) => record.symbol === symbol)),
  };
}

export function buildPitManifest(input: {
  retrievalTimestamp: string;
  rootSymbols: string[];
  evidence: PitArchiveSymbolEvidence[];
  rootHash: string;
  source?: string;
}): PitUniverseManifest {
  const rootArchiveSymbols = [...new Set(input.rootSymbols)].sort();
  const evidenceSymbols = [...input.evidence].sort((left, right) => left.symbol.localeCompare(right.symbol));
  const status: PitUniverseStatus = evidenceSymbols.length === rootArchiveSymbols.length
    && evidenceSymbols.every((record) => record.observedMonths.length > 0 && record.contractStatus !== "HISTORICAL_STATUS_UNAVAILABLE")
    ? "VERIFIED_CONSERVATIVE"
    : "INCOMPLETE";
  return {
    schema: V54_PIT_SCHEMA,
    status,
    source: input.source ?? `${BINANCE_DATA_VISION_BUCKET}/${BINANCE_UM_MONTHLY_PREFIX}`,
    retrievalTimestamp: input.retrievalTimestamp,
    rawHashes: {
      rootIndex: input.rootHash,
      symbolIndexes: Object.fromEntries(evidenceSymbols.map((record) => [record.symbol, record.rawHash])),
    },
    archiveIndexUrl: `${BINANCE_DATA_VISION_BUCKET}/?list-type=2&prefix=${encodeURIComponent(BINANCE_UM_MONTHLY_PREFIX)}&delimiter=%2F`,
    monthlyInterval: BINANCE_UM_MONTHLY_INTERVAL,
    rootArchiveSymbolCount: rootArchiveSymbols.length,
    rootArchiveSymbols,
    evidenceSymbols,
    methodology: [
      "The Binance Data Vision monthly futures kline archive index is the public symbol universe source; it includes historical objects for symbols no longer in current exchangeInfo.",
      "Only USDT-M symbols ending in USDT are retained; *_USDTSETTLED and non-USDT contracts are excluded.",
      "15m monthly object presence is treated as observed data availability, not as an exact listing or delisting event.",
      "The first and last observed months are excluded from effective tradability to prevent intra-month boundary leakage.",
      "Fold-specific membership is evaluated at each trade timestamp from the immutable local manifest; no current-live symbol list is backfilled into history.",
    ],
    limitations: [
      "The public archive index does not provide a historical exchangeInfo contractStatus snapshot for each timestamp.",
      "Exact listing_date, delisting_date, and tradable_start/end are unavailable at daily precision; fields remain null and month precision is recorded.",
      "Only symbols with local kline evidence are used for the fixed-candidate replay; the full archive root symbol set is not silently treated as locally validated data.",
    ],
  };
}

function monthStart(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid YYYY-MM month: ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
