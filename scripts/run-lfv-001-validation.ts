import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createLfvDataFreezeV2,
  runLfvDataGateV2,
  type DataGateV2,
} from "./run-lfv-001-data-pipeline";
import {
  LFV_BASELINE_SHA,
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_LIVE_OBSERVATION_CUTOFF,
  LFV_SYSTEM_BOUNDARY,
} from "@/lib/lfv/loss-factors";
import { sha256Text, stableStringify } from "@/lib/lfv/archive-data";

const REPORT_DIR = resolve("reports");
const ORIGINAL_FREEZE_COMMIT = "d68737cbd27c38e8fb09812ab225cfaaec56f037";
const ORIGINAL_FREEZE_SHA256 = "1bd06d9317203488eef599180f52dd66ecc1d15c87b6dca4ef382daf2dc901f9";
const REQUIRED_REPORTS = [
  "lfv-001-freeze-manifest.json",
  "lfv-001-data-freeze-v2.json",
  "lfv-001-archive-registry.json",
  "lfv-001-pit-universe.json",
  "lfv-001-data-gate.json",
  "lfv-001-replay-parity.json",
  "lfv-001-factor-results.json",
  "lfv-001-combined-results.json",
  "lfv-001-holdouts.json",
  "lfv-001-decision.json",
  "lfv-001-decision.md",
];

type JsonObject = Record<string, unknown>;

async function readJson(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(REPORT_DIR, name), "utf8")) as JsonObject;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertOriginalFreeze(manifest: JsonObject): void {
  const { freezeSha256, ...core } = manifest;
  if (freezeSha256 !== ORIGINAL_FREEZE_SHA256 || freezeSha256 !== sha256Text(stableStringify(core))) {
    throw new Error("original LFV freeze manifest hash mismatch");
  }
  const baseline = core.baseline as { sha?: string } | undefined;
  if (baseline?.sha !== LFV_BASELINE_SHA) throw new Error("original LFV baseline mismatch");
}

async function readOriginalFreeze(): Promise<JsonObject> {
  const manifest = await readJson("lfv-001-freeze-manifest.json");
  assertOriginalFreeze(manifest);
  return manifest;
}

function notRunArtifact(name: string, code: string, reason: string): JsonObject {
  return {
    schema: `bca-lfv-001-${name}-v2`,
    status: "NOT_RUN",
    code,
    reason,
    baseline: LFV_BASELINE_SHA,
    metrics: null,
    returnsRead: false,
    note: "No strategy returns were read after the mandatory data/replay gate stopped the run; no missing value was imputed.",
  };
}

function stopReason(dataGate: DataGateV2): { code: string; reason: string } {
  if (!dataGate.pass) {
    return {
      code: "LFV_DATA_INSUFFICIENT_FINAL",
      reason: dataGate.reasons.join("; ") || "official historical archive gate failed",
    };
  }
  return {
    code: "LFV_REPLAY_PARITY_FAIL",
    reason: "Data Gate passed, but an independently frozen Production replay export is not available; historical returns remain unread.",
  };
}

async function writeStopArtifacts(
  dataGate: DataGateV2,
  freeze: JsonObject,
): Promise<void> {
  const { code, reason } = stopReason(dataGate);
  const freezeSha256 = String(freeze.freezeSha256);
  await writeJson("lfv-001-replay-parity.json", {
    ...notRunArtifact("replay-parity", code, reason),
    liveObservationDiagnostic: {
      count: 44,
      cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(),
      status: "NOT_USED_FOR_RETURNS",
    },
    requiredInput: "independent frozen Production replay export for rules-profit-oriented-v4 and trend-rejection-short-v1",
    strategies: {
      "rules-profit-oriented-v4": "NOT_RUN",
      "trend-rejection-short-v1": "NOT_RUN",
    },
  });
  await writeJson("lfv-001-factor-results.json", {
    ...notRunArtifact("factor-results", code, reason),
    hypotheses: LFV_HYPOTHESES,
    classification: "FACTOR_NOT_VALIDATED",
    factors: Object.fromEntries(Object.entries(LFV_HYPOTHESES).map(([key, id]) => [key, {
      id,
      status: "NOT_RUN",
      blockedTradeMetrics: null,
      placebo: null,
    }])),
  });
  await writeJson("lfv-001-combined-results.json", {
    ...notRunArtifact("combined-results", code, reason),
    definition: LFV_COMBINED_PRIMARY,
    allowedComparisons: ["BASELINE", "H1_ONLY", "H2_ONLY", "H3_PRIMARY", "H4_PRIMARY", "COMBINED_PRIMARY"],
    strategies: {
      "rules-profit-oriented-v4": null,
      "trend-rejection-short-v1": null,
    },
  });
  await writeJson("lfv-001-holdouts.json", {
    ...notRunArtifact("holdouts", code, reason),
    holdoutA: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z", metrics: null },
    holdoutB: { start: "2026-01-01T00:00:00.000Z", end: "2026-07-31T23:59:59.999Z", metrics: null },
  });
  const decision = {
    schema: "bca-lfv-001-decision-v2",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    originalFreezeCommit: ORIGINAL_FREEZE_COMMIT,
    originalFreezeSHA256: ORIGINAL_FREEZE_SHA256,
    freezeSha256,
    dataGate: dataGate.status,
    dataGateCode: dataGate.code,
    status: code,
    finalClassification: code,
    researchStop: true,
    returnsRead: false,
    metrics: null,
    reasons: [reason],
    unchangedDefinitions: {
      hypotheses: LFV_HYPOTHESES,
      combined: LFV_COMBINED_PRIMARY,
      gateHash: freeze.gateDefinitionHash,
    },
    production: {
      ...LFV_SYSTEM_BOUNDARY,
      changed: false,
      strategyChanged: false,
      email: "OFF",
      deploy: false,
      merge: false,
      migration: false,
      "#002": "STOPPED",
      v14: "UNCHANGED",
    },
    nextStep: code === "LFV_DATA_INSUFFICIENT_FINAL"
      ? "Obtain complete immutable official PIT archives before any new LFV run; do not tune H1-H4."
      : "Obtain an independently frozen Production replay export; do not read returns or tune H1-H4 until parity passes.",
  };
  await writeJson("lfv-001-decision.json", decision);
  const markdown = [
    "# LFV-001 Decision",
    "",
    `- Status: **${code}**`,
    "- Research stop: **YES**",
    `- Baseline: \`${LFV_BASELINE_SHA}\``,
    "- Historical returns: **NOT READ**",
    "- August live observations: **EXCLUDED_FROM_RETURNS**",
    "",
    reason,
    "",
    "H1-H4 definitions and the Promotion Gate were not changed. No Production code, strategy, email state, deployment, migration, or trading boundary was changed.",
    "",
    "## Gate evidence",
    `- Data Gate: **${dataGate.status}**`,
    ...dataGate.reasons.map((item) => `- ${item}`),
  ].join("\n");
  await writeFile(resolve(REPORT_DIR, "lfv-001-decision.md"), `${markdown}\n`, "utf8");
}

async function writeEvidenceManifest(): Promise<void> {
  const reports = [];
  for (const name of REQUIRED_REPORTS) {
    const content = await readFile(resolve(REPORT_DIR, name));
    reports.push({
      path: `reports/${name}`,
      bytes: content.byteLength,
      sha256: sha256Text(content.toString("utf8")),
    });
  }
  await writeJson("lfv-001-evidence-manifest.json", {
    schema: "bca-lfv-001-evidence-manifest-v2",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    rawHistoricalDataCommitted: false,
    returnsRead: false,
    reports,
  });
}

async function validateOriginalFreezeOnly(): Promise<void> {
  await readOriginalFreeze();
  console.info(JSON.stringify({ stage: "freeze", baseline: LFV_BASELINE_SHA, freezeSha256: ORIGINAL_FREEZE_SHA256 }, null, 2));
}

async function writeFreezeV2(): Promise<void> {
  await createLfvDataFreezeV2();
}

async function runFull(): Promise<void> {
  const freeze = await readJson("lfv-001-data-freeze-v2.json");
  const { freezeSha256, ...freezeCore } = freeze;
  if (freezeSha256 !== sha256Text(stableStringify(freezeCore))) throw new Error("LFV data freeze v2 hash mismatch");
  if (freeze.originalFreezeCommit !== ORIGINAL_FREEZE_COMMIT || freeze.originalFreezeSHA256 !== ORIGINAL_FREEZE_SHA256) {
    throw new Error("LFV data freeze v2 original freeze provenance mismatch");
  }
  if (freeze.returnsRead !== false) throw new Error("LFV data freeze v2 was created after returns were read");
  const pipeline = await runLfvDataGateV2();
  await writeStopArtifacts(pipeline.gate, freeze);
  await writeEvidenceManifest();
  console.info(JSON.stringify({
    stage: "full",
    status: stopReason(pipeline.gate).code,
    dataGate: pipeline.gate.status,
    reasons: pipeline.gate.reasons,
  }, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--freeze")) {
    await validateOriginalFreezeOnly();
    return;
  }
  if (process.argv.includes("--freeze-v2")) {
    await writeFreezeV2();
    return;
  }
  if (process.argv.includes("--full")) {
    await runFull();
    return;
  }
  throw new Error("Use --freeze, --freeze-v2, or --full");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
