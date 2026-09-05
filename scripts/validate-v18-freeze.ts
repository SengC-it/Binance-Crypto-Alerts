import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, canonicalTextSha256, sha256, V18_BASELINE, V18_BRANCH, V18_MONTHS, V18_SYMBOLS } from "@/lib/v18/data";

const REPORT_DIR = resolve("reports");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

async function fileSha256(name: string): Promise<string> {
  const text = await readFile(resolve(name), "utf8");
  return canonicalTextSha256(text);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function forbiddenOutcomeKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const match = forbiddenOutcomeKey(item); if (match) return match; }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(return|returns|pnl|profit|loss|pf|winRate|holdoutMetrics|oosMetrics)$/i.test(key)) return key;
    const match = forbiddenOutcomeKey(child);
    if (match) return match;
  }
  return null;
}

async function main(): Promise<void> {
  const dataGate = await readJson<Record<string, unknown>>("v18-data-gate.json");
  const parser = await readJson<Record<string, unknown>>("v18-parser-report.json");
  const preReturn = await readJson<Record<string, unknown>>("v18-pre-return-assessment.json");
  const freeze = await readJson<Record<string, unknown>>("v18-freeze-manifest.json");
  assert(dataGate.schema === "v18-data-gate-v1" && dataGate.status === "PASS", "V18 Data Gate is not PASS");
  assert(parser.schema === "v18-parser-report-v1" && parser.allChecksPassed === true, "V18 parser integrity is not PASS");
  const archive = dataGate.archive as Record<string, unknown>;
  assert(archive.enumeratedSlots === V18_MONTHS.length * V18_SYMBOLS.length && archive.checksumVerifiedSlots === archive.enumeratedSlots && archive.parsedSlots === archive.enumeratedSlots, "V18 archive slot counts are incomplete");
  const bySymbol = dataGate.bySymbol as Record<string, Record<string, unknown>>;
  for (const symbol of V18_SYMBOLS) assert(bySymbol[symbol]?.coverage as number >= 0.999, `V18 coverage failed for ${symbol}`);
  assert(preReturn.schema === "v18-pre-return-assessment-v1" && preReturn.outcomeData === "NOT_READ" && preReturn.forwardReturnsRead === false && preReturn.oosMetricsRead === false && preReturn.holdoutRead === false, "V18 pre-return gate read outcome data");
  assert(forbiddenOutcomeKey(preReturn) === null, "V18 pre-return artifact contains an outcome metric");
  const body = { ...freeze };
  delete body.manifestBodySha256;
  assert(freeze.schema === "v18-freeze-manifest-v1" && freeze.manifestBodySha256 === sha256(canonicalJson(body)), "V18 freeze manifest hash mismatch");
  const baseline = freeze.baseline as Record<string, unknown>;
  assert(baseline.sha === V18_BASELINE && baseline.branch === V18_BRANCH, "V18 baseline or branch drifted");
  const flags = freeze.flags as Record<string, unknown>;
  assert(flags.forwardReturnsRead === false && flags.oosMetricsRead === false && flags.holdoutRead === false && flags.parameterSearch === false && flags.resultCommitCreated === false, "V18 freeze flags are not closed");
  const artifacts = freeze.artifacts as Record<string, unknown>;
  for (const [artifactKey, pathKey] of [["archiveManifestSha256", "archiveManifest"], ["parserReportSha256", "parserReport"], ["dataGateSha256", "dataGate"], ["preReturnAssessmentSha256", "preReturnAssessment"]] as const) {
    const path = artifacts[pathKey];
    assert(typeof path === "string" && artifacts[artifactKey] === await fileSha256(path), `V18 artifact hash mismatch: ${artifactKey}`);
  }
  const boundaries = freeze.boundaries as Record<string, unknown>;
  assert(boundaries.productionChanged === false && boundaries.productionEmail === "OFF" && boundaries.deploy === false && boundaries.merge === false && boundaries.migration === false && boundaries.privateBinanceApi === false && boundaries.orderPlacement === false && boundaries.autoTrading === false, "V18 production boundary drifted");
  console.log("V18 freeze validation PASS");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
