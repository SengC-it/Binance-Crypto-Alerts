import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { admitV22Family } from "@/lib/v22/admission";
import { R1_FINAL_GATE_COMMIT, V22_BASE_SHA, V22_BRANCH, V22_END_MS, V22_EXPERIMENT_ID, V22_START_MS, V22_SYMBOLS } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);
const REPORT_DIR = resolve("reports");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitJson<T>(commit: string, path: string): Promise<T> {
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${path}`]);
  return JSON.parse(stdout) as T;
}

async function jsonFile<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as T;
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(REPORT_DIR, name), body, "utf8");
  return sha256(body);
}

async function main(): Promise<void> {
  const r1Decision = await gitJson<{
    dominantHistoricalFailure?: string;
    requiredFutureDirection?: string;
    remainingOrthogonalFamilyBudget?: number;
    legacyFamilyRetuningAllowed?: boolean;
  }>(R1_FINAL_GATE_COMMIT, "reports/r1-wp3-decision.json");
  const r1Future = await gitJson<{ objective?: string }>(R1_FINAL_GATE_COMMIT, "reports/r1-future-research-admission.json");
  if (
    r1Decision.dominantHistoricalFailure !== "EXECUTION_FRICTION_DOMINATED" ||
    r1Decision.requiredFutureDirection !== "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT" ||
    r1Decision.remainingOrthogonalFamilyBudget !== 3 ||
    r1Decision.legacyFamilyRetuningAllowed !== false ||
    r1Future.objective !== "MAXIMIZE_INFORMATION_DENSITY_PER_ALERT"
  ) throw new Error("R1 final gate evidence does not match the V22 admission anchor");

  const admissionResult = admitV22Family({
    experimentId: V22_EXPERIMENT_ID,
    family: "cross-venue same-instrument price discovery",
    informationSourceClass: "CROSS_EXCHANGE_PRICE_DISCOVERY",
  });
  if (admissionResult.status !== "PASS") throw new Error(admissionResult.reason);

  const dataGate = await jsonFile<{ classification: string; researchStop: boolean; symbols: Record<string, unknown> }>("v22-data-gate.json");
  const liveFeed = await jsonFile<{ binancePublicFeed: string; okxPublicFeed: string; allSymbolsPass: boolean }>("v22-live-feed-feasibility.json");
  const admissionSha = await writeJson("v22-admission.json", {
    schema: "v22-admission-v1",
    experimentId: V22_EXPERIMENT_ID,
    family: "cross-venue same-instrument price discovery",
    informationSourceClass: "CROSS_EXCHANGE_PRICE_DISCOVERY",
    targetVenue: "BINANCE_USDM_PERPETUAL",
    referenceVenue: "OKX_USDT_SWAP",
    structuralOrthogonality: "STRUCTURALLY_ORTHOGONAL",
    structuralDifferenceDimensions: ["cross_venue_structure", "information_source", "causal_timing"],
    explanation: {
      differsFromV15: "V15 is same-venue spot-perp lead-lag; V22 uses the same instrument across independent exchanges.",
      differsFromV19: "V19 is BTC shock to alt follower; V22 is same asset to same asset cross-venue price discovery.",
      differsFromV7V17V18: "V7/V17/V18 use OI, funding, crowding, taker-flow or absorption; V22 uses external venue price as the primary information source.",
    },
    r1Admission: {
      verifiedFromCommit: R1_FINAL_GATE_COMMIT,
      dominantHistoricalFailure: r1Decision.dominantHistoricalFailure,
      requiredFutureDirection: r1Decision.requiredFutureDirection,
      legacyFamilyRetuningAllowed: r1Decision.legacyFamilyRetuningAllowed,
      budgetBefore: 3,
      familyBudgetConsumed: true,
      remainingBudget: 2,
    },
    admission: "PASS",
    noSignalDesigned: true,
  });
  const inventorySha = sha256(await readFile(resolve(REPORT_DIR, "v22-data-inventory.json")));
  const dataGateSha = sha256(await readFile(resolve(REPORT_DIR, "v22-data-gate.json")));
  const liveFeedSha = sha256(await readFile(resolve(REPORT_DIR, "v22-live-feed-feasibility.json")));
  const classification = dataGate.classification;
  await writeJson("v22-wp1-manifest.json", {
    schema: "v22-wp1-freeze-manifest-v1",
    experimentId: V22_EXPERIMENT_ID,
    branch: V22_BRANCH,
    baseSha: V22_BASE_SHA,
    r1FinalGateCommit: R1_FINAL_GATE_COMMIT,
    period: { start: new Date(V22_START_MS).toISOString(), endExclusive: new Date(V22_END_MS).toISOString() },
    fixedSymbols: [...V22_SYMBOLS],
    fixedMappings: {
      BTCUSDT: "BTC-USDT-SWAP",
      ETHUSDT: "ETH-USDT-SWAP",
      SOLUSDT: "SOL-USDT-SWAP",
      XRPUSDT: "XRP-USDT-SWAP",
      DOGEUSDT: "DOGE-USDT-SWAP",
    },
    sourcePolicy: {
      binance: "official Binance Data Vision USD-M monthly 5m klines with CHECKSUM",
      okx: "official OKX public history-candles 5m API responses",
      publicOnly: true,
      noSyntheticRows: true,
      noResample: true,
      noForwardFill: true,
      noBackfill: true,
      noInterpolation: true,
    },
    artifactSha256: {
      "reports/v22-admission.json": admissionSha,
      "reports/v22-data-inventory.json": inventorySha,
      "reports/v22-data-gate.json": dataGateSha,
      "reports/v22-live-feed-feasibility.json": liveFeedSha,
    },
    r1AdmissionVerified: true,
    familyBudgetConsumed: true,
    remainingOrthogonalFamilyBudget: 2,
    signalDesigned: false,
    eventDefinitionDesigned: false,
    historicalStrategyOutcomeReturnsRead: false,
    forwardReturnsRead: false,
    futureOutcomePricesRead: false,
    backtestRun: false,
    parameterSearch: false,
    promotionEvaluated: false,
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
    orderPlacement: false,
    autoTrading: false,
    dataGateClassification: classification,
    researchStop: dataGate.researchStop,
    liveFeedFeasible: liveFeed.allSymbolsPass,
    noProductionWrites: true,
  });
  console.info(JSON.stringify({ stage: "v22_wp1_reports_complete", classification, liveFeedPass: liveFeed.allSymbolsPass }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
