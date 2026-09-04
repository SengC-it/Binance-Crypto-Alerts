import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { enumerateOfficialArchives, fileExists, materializeOfficialArchives, parseMaterializedArchives, readJson, sha256, V17_CACHE_MANIFEST_PATH, V17_DATA_ROOT, V17_INVENTORY_PATH, V17_PARSER_REPORT_PATH, type V17CacheManifest, type V17OfficialInventory } from "../lib/v17/data";

const REPORT_DIR = resolve("reports");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function immutableJson(path: string, value: unknown): Promise<void> {
  if (await fileExists(path)) {
    const existing = await readFile(path, "utf8");
    const expected = `${JSON.stringify(value, null, 2)}\n`;
    if (existing !== expected) throw new Error(`immutable V17 artifact differs at ${path}`);
    return;
  }
  await writeJson(path, value);
}

async function main(): Promise<void> {
  await mkdir(V17_DATA_ROOT, { recursive: true });
  const inventory: V17OfficialInventory = await fileExists(V17_INVENTORY_PATH) ? await readJson<V17OfficialInventory>(V17_INVENTORY_PATH) : await enumerateOfficialArchives();
  await immutableJson(V17_INVENTORY_PATH, inventory);
  const inventorySha256 = sha256(Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, "utf8"));
  const cache: V17CacheManifest = await materializeOfficialArchives(inventory, inventorySha256);
  const parsed = await parseMaterializedArchives(cache);
  await writeJson(V17_CACHE_MANIFEST_PATH, parsed.cache);
  await writeJson(V17_PARSER_REPORT_PATH, parsed.report);
  await writeJson(resolve(REPORT_DIR, "v17-official-inventory.json"), inventory);
  await writeJson(resolve(REPORT_DIR, "v17-cache-manifest.json"), parsed.cache);
  await writeJson(resolve(REPORT_DIR, "v17-parser-report.json"), parsed.report);
  await writeJson(resolve(REPORT_DIR, "v17-archive-registry.json"), { schema: "v17-archive-registry-v1", inventorySha256, expectedSlots: inventory.expectedSlots, checksumVerified: parsed.cache.verifiedArchiveSlots, records: inventory.records.map((record) => ({ dataset: record.dataset, symbol: record.symbol, month: record.month, sourceUrl: record.sourceUrl, checksumUrl: record.checksumUrl, expectedBytes: record.expectedBytes, expectedSha256: record.expectedSha256, actualSha256: record.actualSha256 ?? null, actualBytes: record.actualBytes ?? null, status: record.status ?? null })) });
  console.info(JSON.stringify({ phase: "v17-data-prepared", inventorySlots: inventory.expectedSlots, enumerationComplete: inventory.enumerationComplete, checksumVerified: parsed.cache.verifiedArchiveSlots, parseComplete: parsed.report.archiveSlots.parseComplete, fundingSettlementCoverage: parsed.report.fundingSettlement.coverage, historicalReturnsRead: false }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
