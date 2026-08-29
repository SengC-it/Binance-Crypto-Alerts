import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  LFV_BASELINE_SHA,
  LFV_COMBINED_PRIMARY,
  LFV_HYPOTHESES,
  LFV_LIVE_OBSERVATION_CUTOFF,
  LFV_SYSTEM_BOUNDARY,
} from "@/lib/lfv/loss-factors";

const REPORT_DIR = resolve("reports");
const PERIOD_START = "2021-01";
const PERIOD_END = "2026-07";
const PRODUCTION_TOP_SYMBOLS = 100;
const REQUIRED_FORMATION_COVERAGE = 0.98;
const PIT_MANIFEST_NAME = "binance-um-monthly-15m-index.json";
const CACHE_ROOT_CANDIDATES = [
  process.env.LFV_CACHE_ROOT,
  resolve("data/raw"),
  resolve("../../data/raw"),
].filter((value): value is string => Boolean(value));

const ARCHIVE_ROOTS = [
  "v5-7-external-cache/archives",
  "v5-9-1-untouched-cache/archives",
  "v7-derivatives-flow-cache/market",
  "v14-cross-sectional-cache/um",
];

const REQUIRED_REPORTS = [
  "lfv-001-freeze-manifest.json",
  "lfv-001-data-gate.json",
  "lfv-001-replay-parity.json",
  "lfv-001-factor-results.json",
  "lfv-001-combined-results.json",
  "lfv-001-holdouts.json",
  "lfv-001-decision.json",
  "lfv-001-decision.md",
  "lfv-001-evidence-manifest.json",
];

interface ArchiveRecord {
  sourceRoot: string;
  symbol: string;
  period: string;
  path: string;
  bytes: number;
}

interface DataGate {
  schema: "bca-lfv-001-data-gate-v1";
  generatedAt: string;
  status: "PASS" | "FAIL";
  code: "LFV_DATA_INSUFFICIENT" | null;
  pass: boolean;
  source: string;
  period: { start: string; end: string; months: number };
  productionUniverse: {
    topSymbols: number;
    exactHistoricalReconstruction: boolean;
    historicalSymbolsObserved: number;
    monthly15mArchiveCoverage: number;
    maximumMonthly15mSymbols: number;
    requiredFormationCoverage: number;
  };
  pitEvidence: {
    path: string | null;
    status: string;
    sha256: string | null;
  };
  checksum: {
    inventorySha256: string;
    contentChecksumVerified: boolean;
    note: string;
  };
  archiveInventory: {
    records: number;
    bySource: Record<string, number>;
    monthly15mSymbols: Record<string, number>;
  };
  reasons: string[];
  historicalReturnReplay: "NOT_RUN";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function chooseCacheRoot(): Promise<string | null> {
  for (const candidate of CACHE_ROOT_CANDIDATES) {
    if (await pathExists(join(candidate, ARCHIVE_ROOTS[0]))) return candidate;
  }
  return null;
}

function periodRange(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const periods: string[] = [];
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth);) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return periods;
}

async function collectArchiveInventory(cacheRoot: string | null): Promise<ArchiveRecord[]> {
  if (!cacheRoot) return [];
  const records: ArchiveRecord[] = [];
  for (const sourceRoot of ARCHIVE_ROOTS) {
    const root = join(cacheRoot, sourceRoot);
    let symbolEntries;
    try {
      symbolEntries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const symbolEntry of symbolEntries) {
      if (!symbolEntry.isDirectory()) continue;
      const timeframeDir = join(root, symbolEntry.name, "15m");
      let files;
      try {
        files = await readdir(timeframeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        const match = /^(\d{4}-\d{2})\.zip$/.exec(file.name);
        if (!file.isFile() || !match || !periodRange(PERIOD_START, PERIOD_END).includes(match[1])) continue;
        const filePath = join(timeframeDir, file.name);
        const fileStat = await stat(filePath);
        records.push({
          sourceRoot,
          symbol: symbolEntry.name,
          period: match[1],
          path: relative(cacheRoot, filePath),
          bytes: fileStat.size,
        });
      }
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadPitEvidence(): Promise<DataGate["pitEvidence"]> {
  const candidates = [
    process.env.LFV_PIT_MANIFEST,
    resolve("data/pit-universe", PIT_MANIFEST_NAME),
    resolve("../../data/pit-universe", PIT_MANIFEST_NAME),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      const parsed = JSON.parse(content) as { status?: string };
      return {
        path: candidate,
        status: parsed.status ?? "UNKNOWN",
        sha256: sha256Text(content),
      };
    } catch {
      // Continue to the next explicitly discovered evidence path.
    }
  }
  return { path: null, status: "MISSING", sha256: null };
}

async function buildDataGate(): Promise<DataGate> {
  const cacheRoot = await chooseCacheRoot();
  const records = await collectArchiveInventory(cacheRoot);
  const periods = periodRange(PERIOD_START, PERIOD_END);
  const monthlySymbols = Object.fromEntries(periods.map((period) => [
    period,
    new Set(records.filter((record) => record.period === period).map((record) => record.symbol)).size,
  ]));
  const observedSymbols = new Set(records.map((record) => record.symbol));
  const coveredMonths = periods.filter((period) => monthlySymbols[period] >= PRODUCTION_TOP_SYMBOLS).length;
  const monthly15mArchiveCoverage = coveredMonths / periods.length;
  const maximumMonthly15mSymbols = Math.max(0, ...Object.values(monthlySymbols));
  const pitEvidence = await loadPitEvidence();
  const inventory = records.map(({ sourceRoot, symbol, period, path, bytes }) => ({ sourceRoot, symbol, period, path, bytes }));
  const inventorySha256 = sha256Text(stableStringify(inventory));
  const reasons: string[] = [];
  if (pitEvidence.status !== "COMPLETE") reasons.push(`PIT manifest status is ${pitEvidence.status}; exact historical listing/delisting reconstruction is not proven`);
  if (maximumMonthly15mSymbols < PRODUCTION_TOP_SYMBOLS) {
    reasons.push(`available historical 15m archive breadth peaks at ${maximumMonthly15mSymbols} symbols, below Production top_symbols=${PRODUCTION_TOP_SYMBOLS}`);
  }
  if (monthly15mArchiveCoverage < REQUIRED_FORMATION_COVERAGE) {
    reasons.push(`historical 15m archive coverage is ${(monthly15mArchiveCoverage * 100).toFixed(2)}%, below required ${(REQUIRED_FORMATION_COVERAGE * 100).toFixed(2)}%`);
  }
  if (records.length === 0) reasons.push("no immutable historical 15m archive inventory is available to this checkout");
  return {
    schema: "bca-lfv-001-data-gate-v1",
    generatedAt: new Date().toISOString(),
    status: reasons.length === 0 ? "PASS" : "FAIL",
    code: reasons.length === 0 ? null : "LFV_DATA_INSUFFICIENT",
    pass: reasons.length === 0,
    source: "Binance Data Vision USDⓈ-M perpetual public monthly archives",
    period: { start: PERIOD_START, end: PERIOD_END, months: periods.length },
    productionUniverse: {
      topSymbols: PRODUCTION_TOP_SYMBOLS,
      exactHistoricalReconstruction: reasons.length === 0,
      historicalSymbolsObserved: observedSymbols.size,
      monthly15mArchiveCoverage,
      maximumMonthly15mSymbols,
      requiredFormationCoverage: REQUIRED_FORMATION_COVERAGE,
    },
    pitEvidence,
    checksum: {
      inventorySha256,
      contentChecksumVerified: false,
      note: "The gate stops before returns; no incomplete archive is treated as a frozen content-complete dataset.",
    },
    archiveInventory: {
      records: records.length,
      bySource: records.reduce<Record<string, number>>((counts, record) => ({
        ...counts,
        [record.sourceRoot]: (counts[record.sourceRoot] ?? 0) + 1,
      }), {}),
      monthly15mSymbols: monthlySymbols,
    },
    reasons,
    historicalReturnReplay: "NOT_RUN",
  };
}

function freezeCore() {
  return {
    schema: "bca-lfv-001-freeze-manifest-v1",
    baseline: {
      branch: "agent/shadow-entry-deployment",
      sha: LFV_BASELINE_SHA,
    },
    strategies: [
      { id: "rules-profit-oriented-v4", status: "FROZEN" },
      { id: "trend-rejection-short-v1", status: "FROZEN" },
    ],
    observations: {
      livePaperTrades: 44,
      usage: "HYPOTHESIS_GENERATION_ONLY; LIVE_OBSERVATION_ONLY; excluded from training, gates, and promotion",
      researchHistoryEnd: "2026-07-31T23:59:59.999Z",
      cutoff: new Date(LFV_LIVE_OBSERVATION_CUTOFF).toISOString(),
    },
    data: {
      source: "Binance Data Vision USDⓈ-M perpetual public monthly archives",
      range: { start: "2021-01-01T00:00:00.000Z", end: "2026-07-31T23:59:59.999Z" },
      timeframes: ["15m", "1h", "4h", "fundingRate", "markPriceKlines"],
      rawDataPolicy: "External immutable cache only; raw historical data is never committed",
      pitUniverse: "At each timestamp use only then-listed, sufficiently aged, sufficiently liquid, complete symbols; Production top_symbols=100 must be reconstructed exactly",
      fundingSchema: ["calc_time", "funding_interval_hours", "last_funding_rate"],
    },
    hypotheses: {
      H1: { id: LFV_HYPOTHESES.H1_SESSION, placebos: ["00-05 SGT", "06-11 SGT", "12-17 SGT"] },
      H2: { id: LFV_HYPOTHESES.H2_HIGH_VOLATILITY, percentile: "trailing PIT 90-day Q4", placebos: ["LOW_VOL_Q1_BLOCK", "matched random 25% removal"] },
      H3: { id: LFV_HYPOTHESES.H3_ENTRY_DELAY, primaryMinutes: 30, diagnosticsMinutes: [15, 60], execution: "first complete real Binance 15m open at or after signal+delay; pre-entry stop/TP expires signal" },
      H4: { id: LFV_HYPOTHESES.H4_COOLDOWN, primaryHours: 12, diagnosticsHours: [6, 24], trigger: "STOP_LOSS or realized R <= -0.75; sequential PIT-safe same-symbol block" },
      combined: LFV_COMBINED_PRIMARY,
      allowedComparisons: ["BASELINE", "H1_ONLY", "H2_ONLY", "H3_PRIMARY", "H4_PRIMARY", "COMBINED_PRIMARY"],
    },
    executionAndCosts: {
      entry: "next complete 15m open after signal; no same-window execution",
      feeBpsPerSide: 4,
      baseSlippageBpsPerSide: 2,
      stressSlippageBpsPerSide: [2, 5, 10],
      funding: "official actual funding settled from markPriceKlines; no artificial missing-data penalty",
      exits: "frozen Production STOP_LOSS/TAKE_PROFIT/max-hold/same-symbol replacement-cancellation semantics",
    },
    validation: {
      method: "strict nested purged walk-forward",
      nestedOos: { start: "2021-07-01T00:00:00.000Z", end: "2024-12-31T23:59:59.999Z" },
      holdoutA: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z" },
      holdoutB: { start: "2026-01-01T00:00:00.000Z", end: "2026-07-31T23:59:59.999Z" },
      liveAugust: "OOS parity diagnostic only; never promotion evidence",
      minimums: { baselineTradesPerStrategy: 300, combinedNestedTrades: 150, holdoutA: 40, holdoutB: 25 },
    },
    gates: {
      nested: ["trades>=150", "NetR>0", "AvgR>=0.08", "PF>=1.25", "MaxDD<=8R", "positiveFoldRatio>=0.67", "medianFoldNetR>0", "+5bps NetR>0", "+10bps not catastrophic", "30m NetR>0", "30m PF>=1.20"],
      holdouts: ["A trades>=40", "A NetR>0", "A PF>=1.20", "A DD<=6R", "B trades>=25", "B NetR>0", "B PF>=1.20", "B DD<=6R"],
      confidence: "AvgR 95% bootstrap LCB > 0",
      emailUtility: ["average>=2 actionable emails/month", "activeMonthRatio>=75%", "medianMonth>=2", "maxDrought<=30d"],
    },
    boundary: LFV_SYSTEM_BOUNDARY,
    freezeOrder: "Freeze code/tests/manifest and push Commit A before reading historical strategy returns",
  };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeFreezeManifest(): Promise<void> {
  const core = freezeCore();
  const manifest = { ...core, freezeSha256: sha256Text(stableStringify(core)) };
  await writeJson("lfv-001-freeze-manifest.json", manifest);
  console.info(JSON.stringify({ stage: "freeze", baseline: LFV_BASELINE_SHA, freezeSha256: manifest.freezeSha256 }, null, 2));
}

async function readFreezeManifest(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(REPORT_DIR, "lfv-001-freeze-manifest.json"), "utf8")) as Record<string, unknown>;
  const { freezeSha256, ...core } = manifest;
  if (typeof freezeSha256 !== "string" || freezeSha256 !== sha256Text(stableStringify(core))) {
    throw new Error("LFV freeze manifest hash mismatch");
  }
  if ((core.baseline as { sha?: string } | undefined)?.sha !== LFV_BASELINE_SHA) {
    throw new Error("LFV freeze manifest baseline mismatch");
  }
  return manifest;
}

function notRunArtifact(name: string, reason: string) {
  return {
    schema: `bca-lfv-001-${name}-v1`,
    status: "NOT_RUN",
    reason,
    metrics: null,
    note: "No returns were read after the mandatory data gate failed; no missing value is imputed.",
  };
}

async function writeDataInsufficientArtifacts(dataGate: DataGate, freeze: Record<string, unknown>): Promise<void> {
  const reason = dataGate.code ?? "LFV_DATA_INSUFFICIENT";
  await writeJson("lfv-001-replay-parity.json", {
    ...notRunArtifact("replay-parity", reason),
    baseline: LFV_BASELINE_SHA,
    liveObservationDiagnostic: "NOT_RUN",
    strategies: {
      "rules-profit-oriented-v4": "NOT_RUN",
      "trend-rejection-short-v1": "NOT_RUN",
    },
  });
  await writeJson("lfv-001-factor-results.json", {
    ...notRunArtifact("factor-results", reason),
    hypotheses: LFV_HYPOTHESES,
    classification: "FACTOR_NOT_VALIDATED",
    factors: Object.fromEntries(Object.entries(LFV_HYPOTHESES).map(([key, id]) => [key, { id, status: "NOT_RUN", blockedTradeMetrics: null, placebo: null }])),
  });
  await writeJson("lfv-001-combined-results.json", {
    ...notRunArtifact("combined-results", reason),
    definition: LFV_COMBINED_PRIMARY,
    strategies: {
      "rules-profit-oriented-v4": null,
      "trend-rejection-short-v1": null,
    },
  });
  await writeJson("lfv-001-holdouts.json", {
    ...notRunArtifact("holdouts", reason),
    holdoutA: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z", metrics: null },
    holdoutB: { start: "2026-01-01T00:00:00.000Z", end: "2026-07-31T23:59:59.999Z", metrics: null },
  });
  const decision = {
    schema: "bca-lfv-001-decision-v1",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    freezeSha256: freeze.freezeSha256,
    dataGate: dataGate.status,
    status: "LFV_DATA_INSUFFICIENT",
    finalClassification: "LFV_DATA_INSUFFICIENT",
    researchStop: true,
    returnsRead: false,
    metrics: null,
    reasons: dataGate.reasons,
    production: {
      changed: false,
      strategyChanged: false,
      email: "OFF",
      deploy: false,
      merge: false,
      migration: false,
      autoTrading: false,
      privateBinanceApi: false,
      liveSignalEmail: false,
      "#002": "STOPPED",
      v14: "UNCHANGED",
    },
    nextStep: "Do not tune existing Production strategies; obtain complete immutable PIT top-100 data before any new LFV run.",
  };
  await writeJson("lfv-001-decision.json", decision);
  const markdown = [
    "# LFV-001 Decision",
    "",
    "- Status: **LFV_DATA_INSUFFICIENT**",
    "- Research stop: **YES**",
    `- Baseline: \`${LFV_BASELINE_SHA}\``,
    "- Historical returns: **NOT READ**",
    "",
    "The mandatory gate could not prove exact historical Production `top_symbols=100` PIT replay with complete 15m archive coverage. The 44 August live paper observations remain `LIVE_OBSERVATION_ONLY` and were not used for training, fitting, or promotion.",
    "",
    "No factor, combined gate, holdout, confidence, or email-utility profitability conclusion is made. No Production code, strategy, email state, deployment, migration, or trading boundary was changed.",
    "",
    "## Gate reasons",
    ...dataGate.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
  await writeFile(resolve(REPORT_DIR, "lfv-001-decision.md"), markdown + "\n", "utf8");
}

async function writeEvidenceManifest(): Promise<void> {
  const files = [];
  for (const name of REQUIRED_REPORTS.filter((item) => item !== "lfv-001-evidence-manifest.json")) {
    const content = await readFile(resolve(REPORT_DIR, name));
    files.push({ path: `reports/${name}`, bytes: content.byteLength, sha256: sha256Text(content.toString("utf8")) });
  }
  await writeJson("lfv-001-evidence-manifest.json", {
    schema: "bca-lfv-001-evidence-manifest-v1",
    generatedAt: new Date().toISOString(),
    baseline: LFV_BASELINE_SHA,
    rawHistoricalDataCommitted: false,
    reports: files,
  });
}

async function runFull(): Promise<void> {
  const freeze = await readFreezeManifest();
  const dataGate = await buildDataGate();
  await writeJson("lfv-001-data-gate.json", dataGate);
  if (dataGate.pass) {
    throw new Error("LFV full replay is intentionally not entered without an independently verified complete Production PIT dataset");
  }
  await writeDataInsufficientArtifacts(dataGate, freeze);
  await writeEvidenceManifest();
  console.info(JSON.stringify({ stage: "full", status: dataGate.code, reasons: dataGate.reasons }, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--freeze")) {
    await writeFreezeManifest();
    return;
  }
  if (process.argv.includes("--full")) {
    await runFull();
    return;
  }
  throw new Error("Use --freeze or --full");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
