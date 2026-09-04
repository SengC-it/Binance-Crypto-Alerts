import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { V17_BASELINE, V17_BRANCH, V17_END, V17_START, V17_SYMBOLS, sha256 } from "../lib/v17/data";
import { V17_PARAMETERS } from "../lib/v17/engine";

const REPORT_DIR = resolve("reports");
const FREEZE_V2_PATH = resolve(REPORT_DIR, "v17-data-freeze-v2.json");
const ORIGINAL_FREEZE_COMMIT = "c09e462330788c5f3e290a86d7fa6c02e9431c5b";
const ORIGINAL_FREEZE_SHA256 = "5b438583ae859f972c5b0c81b295bb4432a1e717ce321151f79fbbbc095e1b8a";
const PARSER_CORRECTNESS_COMMIT = "bb3a189eec29df9f2ef8c3820454c6630f1ccd03";
const PRIOR_RESULT_COMMIT = "1045caee352321eab2f18f41e3be40970465de30";
const execFileAsync = promisify(execFile);

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function fileHash(path: string): Promise<string> { return sha256(await readFile(path)); }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

async function main(): Promise<void> {
  const originalOutput = await execFileAsync("git", ["show", `${ORIGINAL_FREEZE_COMMIT}:reports/v17-freeze-manifest.json`], { encoding: "utf8" });
  const original = JSON.parse(originalOutput.stdout) as Record<string, unknown>;
  const originalBody = { ...original };
  delete originalBody.manifestSha256;
  if (original.baseline !== V17_BASELINE || original.branch !== V17_BRANCH || original.status !== "FROZEN_BEFORE_RETURNS" || original.historicalReturnsRead !== false) throw new Error("original V17 freeze is not a valid pre-return freeze");
  if (original.manifestSha256 !== ORIGINAL_FREEZE_SHA256 || hash(JSON.stringify(originalBody)) !== ORIGINAL_FREEZE_SHA256) throw new Error("original V17 freeze provenance does not match the frozen manifest");
  const inventory = resolve(REPORT_DIR, "v17-official-inventory.json");
  const cache = resolve(REPORT_DIR, "v17-cache-manifest.json");
  const parser = resolve(REPORT_DIR, "v17-parser-report.json");
  const engine = resolve("lib/v17/engine.ts");
  const assessment = resolve("lib/v17/pre-return.ts");
  const body = {
    schema: "v17-data-freeze-v2",
    baseline: V17_BASELINE,
    branch: V17_BRANCH,
    status: "FROZEN_BEFORE_RETURNS",
    historicalReturnsRead: false,
    lineage: { productionBaseline: V17_BASELINE, originalFreezeCommit: ORIGINAL_FREEZE_COMMIT, originalFreezeManifestSha256: ORIGINAL_FREEZE_SHA256, parserCorrectnessCommit: PARSER_CORRECTNESS_COMMIT, priorDataGateResultCommit: PRIOR_RESULT_COMMIT },
    source: { provider: "Binance Data Vision", officialOnly: true, noSyntheticData: true, noForwardFill: true, start: V17_START, end: V17_END, symbols: [...V17_SYMBOLS], inventorySha256: await fileHash(inventory), cacheManifestSha256: await fileHash(cache), parserReportSha256: await fileHash(parser) },
    alphaDefinitionsUnchanged: true,
    parameters: V17_PARAMETERS,
    semantics: { fundingHistory: "funding rows in [F-180d,F); available span before F must be >=90d; future rows excluded", pitDenominator: "eligible evaluation events only; warmup and under-90d events reported separately", responseQ50: "prior 180d valid reference extreme events with funding/pre-return/post data by symbol and crowding side; current F excluded; current response gate does not define reference eligibility", priceAtFunding: "latest fully closed USD-M futures 15m close strictly before F; mark price is settlement-only", markSettlement: "only future funding rows in (entry,entry+6h] for theoretical candidates require marks; zero required settlements is valid" },
    codeProvenance: { engineSha256: await fileHash(engine), preReturnAssessmentSha256: await fileHash(assessment), parameterSha256: hash(JSON.stringify(V17_PARAMETERS)) },
    gates: { noArchiveChanges: true, noParameterSearch: true, noHistoricalReturnsRead: true, preReturnOnly: true },
    boundaries: { productionChanged: "NO", productionEmail: "OFF", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" },
  };
  const manifestSha256 = hash(JSON.stringify(body));
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(FREEZE_V2_PATH, `${JSON.stringify({ ...body, manifestSha256 }, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ phase: "v17-data-freeze-v2", commitMessage: "research(v17): freeze corrected pre-return semantics", manifestSha256, historicalReturnsRead: false }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
