import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  enumerateOfficialArchives,
  loadCacheManifest,
  materializeOfficialArchives,
  parseMaterializedArchives,
  V16_CACHE_MANIFEST,
  V16_OFFICIAL_INVENTORY,
  V16_PARSER_REPORT,
} from "../lib/v16/data-engine";

const args = new Set(process.argv.slice(2));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function enumerateOnly(): Promise<void> {
  const inventory = await enumerateOfficialArchives();
  const existing = await readFile(V16_OFFICIAL_INVENTORY, "utf8").catch(() => null);
  if (existing !== null) {
    const previous = JSON.parse(existing) as { enumerationSha256?: string };
    if (previous.enumerationSha256 !== inventory.enumerationSha256) throw new Error("Official inventory changed after freeze; refusing to overwrite immutable enumeration");
  } else {
    await writeJson(V16_OFFICIAL_INVENTORY, inventory);
  }
  console.info(JSON.stringify({ phase: "v16-official-enumeration", expectedSlots: inventory.expectedSlots, officialAvailableSlots: inventory.officialAvailableSlots, officialUnavailableSlots: inventory.officialUnavailableSlots, checksumUnavailableSlots: inventory.checksumUnavailableSlots, enumerationComplete: inventory.enumerationComplete, enumerationSha256: inventory.enumerationSha256 }));
}

async function parseOnly(): Promise<void> {
  const manifest = await loadCacheManifest();
  const report = await parseMaterializedArchives(manifest);
  await writeJson(V16_PARSER_REPORT, report);
  console.info(JSON.stringify({ phase: "v16-official-parse", parserReport: V16_PARSER_REPORT, BTCUSDT: report.bySymbol.BTCUSDT, ETHUSDT: report.bySymbol.ETHUSDT, featureCoverage: report.featureCoverage, executionPriceCoverage: report.executionPriceCoverage, fundingSettlement: report.fundingSettlement, markSettlement: report.markSettlement }));
}

async function main(): Promise<void> {
  if (args.has("--enumerate-only")) {
    await enumerateOnly();
    return;
  }
  if (args.has("--parse-only")) {
    await parseOnly();
    return;
  }
  const maxValue = process.argv.find((value) => value.startsWith("--max-archives="))?.slice("--max-archives=".length);
  const maxArchives = maxValue === undefined ? undefined : Number(maxValue);
  if (maxArchives !== undefined && (!Number.isInteger(maxArchives) || maxArchives < 1)) throw new Error("--max-archives must be a positive integer");
  const manifest = await materializeOfficialArchives({ maxArchives, stopOnError: true });
  const verified = manifest.records.filter((record) => record.status === "CHECKSUM_VERIFIED").length;
  const available = manifest.records.filter((record) => record.availability === "AVAILABLE").length;
  console.info(JSON.stringify({ phase: "v16-official-materialization", manifest: V16_CACHE_MANIFEST, verified, available, complete: verified === available }));
  if (args.has("--all")) {
    if (verified !== available) throw new Error(`Materialization is incomplete: ${verified}/${available}; parser was not started`);
    const report = await parseMaterializedArchives(manifest);
    await writeJson(V16_PARSER_REPORT, report);
    console.info(JSON.stringify({ phase: "v16-official-parse", parserReport: V16_PARSER_REPORT, featureCoverage: report.featureCoverage, executionPriceCoverage: report.executionPriceCoverage, fundingSettlement: report.fundingSettlement, markSettlement: report.markSettlement }));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
