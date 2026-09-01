import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPORT_DIR = resolve("reports");
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const DIRECT_ROOT = "https://data.binance.vision";
const STAGE_B_PATH = resolve(REPORT_DIR, "v15-stage-b-archive-manifest.json");
const REGISTRY_PATH = resolve(REPORT_DIR, "v15-archive-registry.json");
const GATE_PATH = resolve(REPORT_DIR, "v15-data-gate.json");
const COST_PATH = resolve(REPORT_DIR, "v15-cost-input-manifest.json");

type Exchange = "spot" | "futuresUm";

interface RegistryRecord {
  symbol: string;
  spotAvailableMonths: string[];
  futuresAvailableMonths: string[];
  sharedAvailableMonths: string[];
}

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
  selectionRule: string;
  requiredArchiveSlots: number;
  missingMetadataSlots: number;
  expectedBytes: number;
  requiredArchives: StageBRequirement[];
  actualUsedArchives: Array<{ exchange: Exchange; symbol: string; month: string; cachePath: string; sha256: string; bytes: number }>;
  immutablePolicy: string;
}

interface DataGateReport {
  pitUniverse: { monthly: Array<{ month: string; symbols: string[] }> };
}

function monthKeys(start: number, end: number): string[] {
  const values: string[] = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  while (cursor.getTime() <= end) {
    values.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return values;
}

function monthStart(month: string): number {
  return Date.parse(`${month}-01T00:00:00.000Z`);
}

function monthBefore(month: string, count: number): string {
  const date = new Date(monthStart(month));
  date.setUTCMonth(date.getUTCMonth() - count);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function directArchiveUrl(exchange: Exchange, symbol: string, month: string): string {
  const root = exchange === "spot" ? "spot" : "futures/um";
  return `${DIRECT_ROOT}/data/${root}/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`;
}

function relativeCachePath(exchange: Exchange, symbol: string, month: string): string {
  return `data/raw/v15-spot-perp-lead-lag/${exchange}/${symbol}/${month}.zip`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const registry = await readJson<{ records: RegistryRecord[] }>(REGISTRY_PATH);
  const gate = await readJson<DataGateReport>(GATE_PATH);
  const previous = await readJson<StageBManifest>(STAGE_B_PATH);
  const previousByKey = new Map(previous.requiredArchives.map((row) => [`${row.exchange}/${row.symbol}/${row.month}`, row]));
  const previousActual = new Map(previous.actualUsedArchives.map((row) => [`${row.exchange}/${row.symbol}/${row.month}`, row]));
  const months = monthKeys(START, END);
  const eligibleBySymbol = new Map<string, string>();
  for (const month of gate.pitUniverse.monthly) {
    for (const symbol of month.symbols) {
      const current = eligibleBySymbol.get(symbol);
      if (!current || monthStart(month.month) < monthStart(current)) eligibleBySymbol.set(symbol, month.month);
    }
  }

  const requirements: StageBRequirement[] = [];
  for (const record of registry.records) {
    const firstEligible = eligibleBySymbol.get(record.symbol);
    if (!firstEligible) continue;
    const warmupStart = monthBefore(firstEligible, 2);
    const eligibleMonths = new Set(record.sharedAvailableMonths);
    for (const month of months) {
      if (monthStart(month) < Math.max(START - 60 * 24 * 60 * 60_000, monthStart(warmupStart))) continue;
      if (!eligibleMonths.has(month)) continue;
      for (const exchange of ["spot", "futuresUm"] as const) {
        const key = `${exchange}/${record.symbol}/${month}`;
        const old = previousByKey.get(key);
        requirements.push({
          exchange,
          symbol: record.symbol,
          month,
          sourceUrl: directArchiveUrl(exchange, record.symbol, month),
          checksumUrl: `${directArchiveUrl(exchange, record.symbol, month)}.CHECKSUM`,
          cachePath: relativeCachePath(exchange, record.symbol, month),
          expectedBytes: old?.expectedBytes ?? null,
        });
      }
    }
  }
  requirements.sort((left, right) => `${left.symbol}/${left.month}/${left.exchange}`.localeCompare(`${right.symbol}/${right.month}/${right.exchange}`));
  const actualUsedArchives = requirements.flatMap((row) => {
    const actual = previousActual.get(`${row.exchange}/${row.symbol}/${row.month}`);
    return actual ? [actual] : [];
  });
  const manifest: StageBManifest = {
    schema: "v15-stage-b-archive-manifest-v1",
    selectionRule: "Materialize only official monthly Spot/Perp 5m archives needed by the frozen PIT engine: every PIT-actionable symbol/month plus the preceding two calendar months required for the 60d quantile, 30d ADV, and six-bar feature warm-up; no blind download and no current-survivor filter.",
    requiredArchiveSlots: requirements.length,
    missingMetadataSlots: requirements.filter((row) => row.expectedBytes === null).length,
    expectedBytes: requirements.reduce((sum, row) => sum + (row.expectedBytes ?? 0), 0),
    requiredArchives: requirements,
    actualUsedArchives,
    immutablePolicy: "Every materialized ZIP must be verified against its official .CHECKSUM before first write; an existing cache path with a different digest is a hard failure.",
  };
  await writeJson(STAGE_B_PATH, manifest);

  const symbolMonths = [...new Set(requirements.map((row) => `${row.symbol}/${row.month}`))].sort();
  await writeJson(COST_PATH, {
    schema: "v15-cost-input-manifest-v1",
    funding: {
      sourceTemplate: `${DIRECT_ROOT}/data/futures/um/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{month}.zip`,
      requiredSymbolMonths: symbolMonths.length,
      materializedSymbolMonths: 0,
      coverage: 0,
      actualFiles: [],
    },
    markPrice: {
      sourceTemplate: `${DIRECT_ROOT}/data/futures/um/monthly/markPriceKlines/{symbol}/5m/{symbol}-5m-{month}.zip`,
      requiredArchiveSlots: symbolMonths.length,
      materializedArchiveSlots: 0,
      coverage: 0,
      actualFiles: [],
    },
    noFallback: true,
  });
  console.info(JSON.stringify({
    stageB: { requiredArchiveSlots: requirements.length, warmupPairs: requirements.length / 2, missingMetadataSlots: manifest.missingMetadataSlots, previousActual: actualUsedArchives.length },
    cost: { requiredSymbolMonths: symbolMonths.length, fundingSource: "monthly", markPriceSource: "monthly" },
    stageBManifestSha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
  }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
