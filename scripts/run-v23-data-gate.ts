import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  auditSeriesRows,
  basisAtTimestamp,
  buildRollAudit,
  emptySeriesQuality,
  exactSynchronizedTimestamps,
  extractZipSingleFile,
  openTimeMap,
  parseBinanceKlineCsv,
  parseBinanceKlineJson,
  passesV23SeriesQuality,
  type V23DownloadManifest,
} from "@/lib/v23/data";
import {
  V23_BASE_SHA,
  V23_BRANCH,
  V23_COVERAGE_THRESHOLD,
  V23_END_MS,
  V23_EXPERIMENT_ID,
  V23_FAMILY,
  V23_INTERVAL_MS,
  V23_MAX_ALLOWED_GAP_HOURS,
  V23_R1_ADMISSION_SHA,
  V23_REQUIRED_SERIES,
  V23_START_MS,
  V23_TARGET_SYMBOLS,
  V23_UNDERLYINGS,
  V23_V22_TERMINAL_SHA,
  type V23Candle,
  type V23SeriesType,
  type V23Underlying,
} from "@/lib/v23/types";

const execFileAsync = promisify(execFile);
const REPORT_DIR = resolve("reports");
const RAW_ROOT = resolve("data/raw/v23");
const RAW_MANIFEST_PATH = resolve(RAW_ROOT, "v23-download-manifest.json");
const API_BASE = "https://fapi.binance.com";
const BASIS_DOC_URL = "https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data";

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

async function writeJson(name: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(REPORT_DIR, name), text, "utf8");
  return sha256(text);
}

async function gitBytes(spec: string): Promise<Buffer> {
  const output = (await execFileAsync("git", ["show", spec], { encoding: "buffer" })).stdout;
  return Buffer.isBuffer(output) ? output : Buffer.from(output as string, "utf8");
}

async function gitText(spec: string): Promise<string> {
  return (await gitBytes(spec)).toString("utf8");
}

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function readDownloadManifest(): Promise<V23DownloadManifest> {
  return JSON.parse(await readFile(RAW_MANIFEST_PATH, "utf8")) as V23DownloadManifest;
}

async function archiveRows(manifest: V23DownloadManifest, underlying: V23Underlying, seriesType: "TARGET_USDM_PERPETUAL" | "INDEX_PRICE"): Promise<{ rows: V23Candle[]; invalidRows: number; entries: V23DownloadManifest["archiveEntries"] }> {
  const entries = manifest.archiveEntries.filter((entry) => entry.underlying === underlying && entry.seriesType === seriesType);
  const rows: V23Candle[] = [];
  let invalidRows = 0;
  for (const entry of entries) {
    const bytes = await readFile(resolve(RAW_ROOT, entry.bodyPath));
    if (sha256(bytes) !== entry.responseSha256 || !entry.checksumVerified) {
      invalidRows += 1;
      continue;
    }
    try {
      const extracted = extractZipSingleFile(bytes);
      const parsed = parseBinanceKlineCsv(extracted.content, underlying, seriesType);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    } catch {
      invalidRows += 1;
    }
  }
  return { rows, invalidRows, entries };
}

async function continuousRows(manifest: V23DownloadManifest, underlying: V23Underlying, seriesType: "CURRENT_QUARTER" | "NEXT_QUARTER"): Promise<{ rows: V23Candle[]; invalidRows: number; entries: V23DownloadManifest["apiEntries"] }> {
  const entries = manifest.apiEntries.filter((entry) => entry.underlying === underlying && entry.seriesType === seriesType);
  const rows: V23Candle[] = [];
  let invalidRows = 0;
  for (const entry of entries) {
    if (entry.httpStatus !== 200) continue;
    try {
      const payload = JSON.parse(await readFile(resolve(RAW_ROOT, entry.bodyPath), "utf8")) as unknown;
      const parsed = parseBinanceKlineJson(payload, underlying, seriesType);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    } catch {
      invalidRows += 1;
    }
  }
  return { rows, invalidRows, entries };
}

interface LiveProbe {
  underlying: V23Underlying;
  seriesType: "TARGET_USDM_PERPETUAL" | "INDEX_PRICE" | "CURRENT_QUARTER" | "NEXT_QUARTER";
  url: string;
  httpStatus: number;
  responseByteLength: number;
  responseSha256: string;
  retrievedAt: string;
  authenticationRequired: false;
  tradingPermissionRequired: false;
  rows: number;
  error: string | null;
}

async function probe(url: string): Promise<{ status: number; bytes: Uint8Array; error: string | null; retrievedAt: string }> {
  const retrievedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), error: null, retrievedAt };
  } catch (error) {
    return { status: 0, bytes: new Uint8Array(), error: error instanceof Error ? error.message : String(error), retrievedAt };
  }
}

async function liveProbe(underlying: V23Underlying, seriesType: LiveProbe["seriesType"]): Promise<LiveProbe> {
  const symbol = V23_TARGET_SYMBOLS[underlying];
  const parameters: Record<string, string> = seriesType === "TARGET_USDM_PERPETUAL"
    ? { symbol, interval: "1h", limit: "2" }
    : seriesType === "INDEX_PRICE"
      ? { pair: symbol, interval: "1h", limit: "2" }
      : { pair: symbol, contractType: seriesType, interval: "1h", limit: "2" };
  const endpoint = seriesType === "TARGET_USDM_PERPETUAL" ? "/fapi/v1/klines" : seriesType === "INDEX_PRICE" ? "/fapi/v1/indexPriceKlines" : "/fapi/v1/continuousKlines";
  const url = `${API_BASE}${endpoint}?${new URLSearchParams(parameters).toString()}`;
  const response = await probe(url);
  let rows = 0;
  if (response.status === 200) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
      rows = Array.isArray(payload) ? payload.length : 0;
    } catch {
      rows = 0;
    }
  }
  const bodyPath = `live/${underlying}-${seriesType}.json`;
  await mkdir(resolve(RAW_ROOT, "live"), { recursive: true });
  await writeFile(resolve(RAW_ROOT, bodyPath), response.bytes);
  return { underlying, seriesType, url, httpStatus: response.status, responseByteLength: response.bytes.byteLength, responseSha256: sha256(response.bytes), retrievedAt: response.retrievedAt, authenticationRequired: false, tradingPermissionRequired: false, rows, error: response.error ?? (response.status === 200 ? null : `HTTP ${response.status}`) };
}

async function main(): Promise<void> {
  const branch = await git(["branch", "--show-current"]);
  if (branch !== V23_BRANCH) throw new Error(`V23 branch mismatch: ${branch}`);
  const downloadManifest = await readDownloadManifest();
  const rawManifestBytes = await readFile(RAW_MANIFEST_PATH);
  const rawManifestSha256 = sha256(rawManifestBytes);
  const months = new Set(downloadManifest.archiveEntries.filter((entry) => entry.underlying === "BTC" && entry.seriesType === "TARGET_USDM_PERPETUAL").map((entry) => entry.month)).size;
  const expected1hRows = ((V23_END_MS - V23_START_MS) / V23_INTERVAL_MS);

  const admissionRegistry = JSON.parse(await gitText(`${V23_R1_ADMISSION_SHA}:reports/r1-exhausted-alpha-families.json`)) as { registryExperimentIds: string[]; families: Array<{ experimentIds: string[] }>; registryCompleteness: { exactSetEquality: boolean } };
  const admissionRule = JSON.parse(await gitText(`${V23_R1_ADMISSION_SHA}:reports/r1-future-research-admission.json`)) as { structuralOrthogonalityDimensions: string[]; futureInformationSourceClasses: string[]; structuralOrthogonalityRule: string; noSpecificStrategyDesign: boolean; noThresholdsOrParameters: boolean };
  const v23AlreadyExhausted = admissionRegistry.registryExperimentIds.includes(V23_EXPERIMENT_ID) || admissionRegistry.families.some((family) => family.experimentIds.includes(V23_EXPERIMENT_ID));
  const requiredDimensions = ["information_source", "derivative_state", "economic_mechanism"];
  const structuralAdmissionPass = !v23AlreadyExhausted && requiredDimensions.every((dimension) => admissionRule.structuralOrthogonalityDimensions.includes(dimension)) && admissionRegistry.registryCompleteness.exactSetEquality && admissionRule.structuralOrthogonalityRule === "STRUCTURALLY_ORTHOGONAL" && admissionRule.noSpecificStrategyDesign && admissionRule.noThresholdsOrParameters;
  const admissionSha = await writeJson("v23-admission.json", {
    schema: "v23-admission-v1",
    experimentId: V23_EXPERIMENT_ID,
    family: V23_FAMILY,
    informationSourceClass: "TERM_STRUCTURE_BASIS",
    r1AuthoritativeCommit: V23_R1_ADMISSION_SHA,
    r1ExhaustedRegistryContainsV23: v23AlreadyExhausted,
    structuralAdmissionPass,
    structuralDimensions: requiredDimensions,
    orthogonality: {
      V23_NOT_V15_SPOT_PERP_LEAD_LAG: "V15 compares spot and perpetual short-horizon lead-lag; V23 compares multiple dated futures maturities on one underlying against a common index.",
      V23_NOT_V17: "V17 is funding/crowding positioning; V23 does not use funding thresholds or crowding continuation.",
      V23_NOT_V20: "V20 is last/mark-price dislocation convergence; V23 is same-exchange multi-maturity curve state.",
      V23_NOT_V12_V13: "V12/V13 are multi-asset market-neutral relative value; V23 is same underlying across maturities.",
      V23_NOT_V22: "V22 is same instrument across exchanges; V23 is same exchange, same underlying, different maturities.",
    },
    declarations: {
      expectedSignalMechanism: "Changes in the relative pricing of perpetual, current-quarter and next-quarter futures may reveal changes in leverage demand, hedging pressure and risk premium before they are fully reflected in the target perpetual market.",
      whyInformationArrivesBeforePriceAdjustment: "Different maturity contracts are held and traded by different hedgers, arbitrageurs and leveraged participants; curve repricing can therefore contain derivative-state information distinct from single-contract price momentum.",
      whyNotEquivalentToLegacyFamily: "The information source is maturity-curve state rather than spot/perpetual lead-lag, crowding/funding state, fair-value mark dislocation, multi-asset relative value, or cross-exchange price discovery.",
      expectedAlertFrequencyBand: "NOT_EVALUATED_IN_WP1",
      humanActionability: "1h closed-candle state is intended for human alert review, not HFT.",
      requiredPublicData: ["Binance USD-M target perpetual 1h regular klines", "Binance USD-M index-price 1h klines", "Binance USD-M CURRENT_QUARTER continuous 1h klines", "Binance USD-M NEXT_QUARTER continuous 1h klines"],
      dataAvailabilityRisk: "Dated continuous futures history may be unavailable from the official archive and public REST may be jurisdiction-restricted; no repair or replacement is allowed.",
      executionLatencySensitivity: "NOT_EVALUATED_IN_WP1",
      expectedHoldingMechanism: "NOT_DEFINED_BEFORE_DATA_GATE",
      frictionSensitivityRationale: "A term-structure state is expected to persist longer than exchange micro-latency and therefore must plausibly support signals whose magnitude can exceed realistic trading friction.",
    },
    budget: { budgetBefore: 2, budgetConsumed: 1, remainingBudget: 1 },
    v22Terminal: { commit: V23_V22_TERMINAL_SHA, classification: "V22_CROSS_VENUE_SIGNAL_SAMPLE_INSUFFICIENT", researchStop: true },
    productionChanged: false,
    productionEmail: "OFF",
    deploy: false,
    merge: false,
  });

  const inventoryByUnderlying: Record<string, unknown> = {};
  const gateByUnderlying: Record<string, unknown> = {};
  const rollByUnderlying: Record<string, unknown> = {};
  const basisByUnderlying: Record<string, unknown> = {};
  let allSeriesPass = true;
  for (const underlying of V23_UNDERLYINGS) {
    const seriesRows = new Map<V23SeriesType, V23Candle[]>();
    const seriesQuality: Record<string, unknown> = {};
    const sourceDetails: Record<string, unknown> = {};
    for (const seriesType of V23_REQUIRED_SERIES) {
      if (seriesType === "TARGET_USDM_PERPETUAL" || seriesType === "INDEX_PRICE") {
        const loaded = await archiveRows(downloadManifest, underlying, seriesType);
        seriesRows.set(seriesType, loaded.rows);
        seriesQuality[seriesType] = auditSeriesRows(underlying, seriesType, loaded.rows, loaded.invalidRows);
        sourceDetails[seriesType] = { source: "Binance official public data archive", archiveResponses: loaded.entries };
      } else {
        const loaded = await continuousRows(downloadManifest, underlying, seriesType);
        seriesRows.set(seriesType, loaded.rows);
        seriesQuality[seriesType] = loaded.rows.length > 0 ? auditSeriesRows(underlying, seriesType, loaded.rows, loaded.invalidRows) : emptySeriesQuality(underlying, seriesType);
        sourceDetails[seriesType] = { source: "Binance official public USD-M continuousKlines REST", apiResponses: loaded.entries };
      }
    }
    const maps = new Map<V23SeriesType, ReadonlyMap<number, V23Candle>>();
    for (const seriesType of V23_REQUIRED_SERIES) maps.set(seriesType, openTimeMap(seriesRows.get(seriesType) ?? []));
    const synchronized = exactSynchronizedTimestamps(maps, V23_REQUIRED_SERIES);
    const syncCoverage = synchronized.length / expected1hRows;
    const qualityValues = V23_REQUIRED_SERIES.map((seriesType) => seriesQuality[seriesType] as never);
    const qualityPass = qualityValues.every(passesV23SeriesQuality);
    const syncPass = syncCoverage >= V23_COVERAGE_THRESHOLD;
    allSeriesPass = allSeriesPass && qualityPass && syncPass;
    inventoryByUnderlying[underlying] = { underlying, targetSymbol: V23_TARGET_SYMBOLS[underlying], expected1hRows, series: seriesQuality, synchronizedRows: synchronized.length, synchronizedCoverage: syncCoverage, sourceDetails };
    gateByUnderlying[underlying] = { requiredSeriesPass: qualityPass, synchronizedPass: syncPass, synchronizedRows: synchronized.length, synchronizedCoverage: syncCoverage, maxGapHours: Object.fromEntries(V23_REQUIRED_SERIES.map((seriesType) => [seriesType, (seriesQuality[seriesType] as { maxContiguousMissingHours: number }).maxContiguousMissingHours])) };
    const currentRows = seriesRows.get("CURRENT_QUARTER") ?? [];
    const nextRows = seriesRows.get("NEXT_QUARTER") ?? [];
    rollByUnderlying[underlying] = {
      underlying,
      diagnosticOnly: true,
      discontinuityRule: "absolute one-bar open/previous-close gap >= 5%; not a signal threshold",
      CURRENT_QUARTER: { transitions: buildRollAudit(currentRows, "CURRENT_QUARTER"), count: buildRollAudit(currentRows, "CURRENT_QUARTER").length },
      NEXT_QUARTER: { transitions: buildRollAudit(nextRows, "NEXT_QUARTER"), count: buildRollAudit(nextRows, "NEXT_QUARTER").length },
    };
    const basisRows = synchronized.map((timestamp) => basisAtTimestamp(timestamp, maps.get("CURRENT_QUARTER")!, maps.get("NEXT_QUARTER")!, maps.get("INDEX_PRICE")!, maps.get("TARGET_USDM_PERPETUAL"))).filter((value): value is NonNullable<typeof value> => value !== null);
    basisByUnderlying[underlying] = { synchronizedRows: synchronized.length, finiteRows: basisRows.length, currentBasisFeasible: synchronized.length > 0 && basisRows.length === synchronized.length, nextBasisFeasible: synchronized.length > 0 && basisRows.length === synchronized.length, curveSlopeFeasible: synchronized.length > 0 && basisRows.length === synchronized.length, PITFeasible: synchronized.length > 0 && basisRows.length === synchronized.length, formula: { currentBasis: "ln(CURRENT_QUARTER.close / INDEX_PRICE.close)", nextBasis: "ln(NEXT_QUARTER.close / INDEX_PRICE.close)", curveSlope: "nextBasis - currentBasis", noFutureReturns: true, noPrediction: true } };
  }

  const liveProbes: LiveProbe[] = [];
  for (const underlying of V23_UNDERLYINGS) for (const seriesType of ["TARGET_USDM_PERPETUAL", "INDEX_PRICE", "CURRENT_QUARTER", "NEXT_QUARTER"] as const) liveProbes.push(await liveProbe(underlying, seriesType));
  const liveFeedSha = await writeJson("v23-live-feed-feasibility.json", {
    schema: "v23-live-feed-feasibility-v1",
    source: API_BASE,
    probes: liveProbes,
    authenticationRequired: false,
    tradingPermissionRequired: false,
    restPollingCompatible: liveProbes.every((probe) => probe.httpStatus === 200 && probe.rows > 0),
    compatibilityRationale: "Vercel scheduled REST polling is compatible only if all four public series respond with current rows; persistent WebSocket is not required.",
    productionSupabaseWrites: false,
    emailSent: false,
  });
  const basisProbeUrl = `${API_BASE}/futures/data/basis?${new URLSearchParams({ pair: "BTCUSDT", contractType: "CURRENT_QUARTER", period: "1h", startTime: String(V23_START_MS), endTime: String(V23_START_MS + V23_INTERVAL_MS * 2 - 1), limit: "500" }).toString()}`;
  const basisProbe = await probe(basisProbeUrl);
  const basisEndpoint = { url: basisProbeUrl, httpStatus: basisProbe.status, responseByteLength: basisProbe.bytes.byteLength, responseSha256: sha256(basisProbe.bytes), retrievedAt: basisProbe.retrievedAt, error: basisProbe.error ?? (basisProbe.status === 200 ? null : `HTTP ${basisProbe.status}`), historicalBasisEndpointEligible: false, documentedHistoryWindow: "latest 30 days only", documentationUrl: BASIS_DOC_URL, historicalSeriesSourceUsed: false };
  const inventorySha = await writeJson("v23-data-inventory.json", { schema: "v23-data-inventory-v1", experimentId: V23_EXPERIMENT_ID, source: "Binance official public data archive and USD-M public REST", authenticationRequired: false, accountPermissionRequired: false, tradingPermissionRequired: false, start: new Date(V23_START_MS).toISOString(), endExclusive: new Date(V23_END_MS).toISOString(), interval: "1h", expected1hRows, archiveMonthCount: months, archiveRawManifestSha256: rawManifestSha256, byUnderlying: inventoryByUnderlying, noNearestTimestamp: true, noForwardFill: true, noBackfill: true, noInterpolation: true });
  const rollSha = await writeJson("v23-roll-audit.json", { schema: "v23-roll-audit-v1", experimentId: V23_EXPERIMENT_ID, diagnosticOnly: true, byUnderlying: rollByUnderlying, noFutureReturns: true, noSignalThreshold: true });
  const basisSha = await writeJson("v23-basis-construction-feasibility.json", { schema: "v23-basis-construction-feasibility-v1", experimentId: V23_EXPERIMENT_ID, byUnderlying: basisByUnderlying, noThreshold: true, noPrediction: true, noFutureReturns: true });
  const classification = structuralAdmissionPass && allSeriesPass ? "V23_TERM_STRUCTURE_DATA_GATE_PASS" : "V23_TERM_STRUCTURE_DATA_INSUFFICIENT";
  const dataGateSha = await writeJson("v23-data-gate.json", { schema: "v23-data-gate-v1", experimentId: V23_EXPERIMENT_ID, coverageThreshold: V23_COVERAGE_THRESHOLD, maximumAllowedGapHours: V23_MAX_ALLOWED_GAP_HOURS, requiredSeries: [...V23_REQUIRED_SERIES], byUnderlying: gateByUnderlying, historicalBasisEndpoint: basisEndpoint, structuralAdmissionPass, dataGatePass: classification === "V23_TERM_STRUCTURE_DATA_GATE_PASS", classification, researchStop: classification !== "V23_TERM_STRUCTURE_DATA_GATE_PASS", remainingBudget: 1, historicalFeatureDataRead: true, historicalStrategyOutcomeReturnsRead: false, forwardReturnsRead: false, futureOutcomePricesRead: false, backtestRun: false, parameterSearch: false, promotionEvaluated: false, productionChanged: false, productionEmail: "OFF", deploy: false, merge: false, orderPlacement: false, autoTrading: false });
  const sourcePaths = ["lib/v23/types.ts", "lib/v23/data.ts", "scripts/download-v23-data.ts", "scripts/run-v23-data-gate.ts", "tests/v23-data.test.ts", "scripts/validate-v23-wp1.ts"];
  const sourceFileSha256: Record<string, string> = {};
  for (const path of sourcePaths) sourceFileSha256[path] = sha256(await readFile(resolve(path)));
  const reportSha256 = { "reports/v23-admission.json": admissionSha, "reports/v23-data-inventory.json": inventorySha, "reports/v23-data-gate.json": dataGateSha, "reports/v23-roll-audit.json": rollSha, "reports/v23-basis-construction-feasibility.json": basisSha, "reports/v23-live-feed-feasibility.json": liveFeedSha };
  const manifest = { schema: "v23-wp1-manifest-v1", experimentId: V23_EXPERIMENT_ID, branch: V23_BRANCH, baseSha: V23_BASE_SHA, directParent: V23_BASE_SHA, r1AdmissionVerified: structuralAdmissionPass, r1AuthoritativeCommit: V23_R1_ADMISSION_SHA, v22TerminalCommit: V23_V22_TERMINAL_SHA, familyBudgetConsumed: true, budgetBefore: 2, remainingOrthogonalFamilyBudget: 1, fixedUnderlyings: [...V23_UNDERLYINGS], fixedTargetSymbols: Object.values(V23_TARGET_SYMBOLS), interval: "1h", start: new Date(V23_START_MS).toISOString(), endExclusive: new Date(V23_END_MS).toISOString(), source: "Binance official public archives and public USD-M REST", authenticationRequired: false, accountPermissionRequired: false, tradingPermissionRequired: false, historicalBasisEndpointWindow: "latest 30 days only", historicalBasisEndpointEligible: false, rawDownloadManifestSha256: rawManifestSha256, reportSha256, sourceFileSha256, signalDesigned: false, eventDefinitionDesigned: false, historicalFeatureDataRead: true, historicalStrategyOutcomeReturnsRead: false, forwardReturnsRead: false, futureOutcomePricesRead: false, backtestRun: false, parameterSearch: false, promotionEvaluated: false, productionChanged: false, productionEmail: "OFF", deploy: false, merge: false, orderPlacement: false, autoTrading: false, dataGateClassification: classification, researchStop: classification !== "V23_TERM_STRUCTURE_DATA_GATE_PASS", noRepair: true, noThirdPartyData: true };
  const manifestSha = await writeJson("v23-wp1-manifest.json", manifest);
  console.info(JSON.stringify({ stage: "v23_wp1_complete", classification, structuralAdmissionPass, expected1hRows, archiveMonthCount: months, archiveRawManifestSha256: rawManifestSha256, reportSha256, manifestSha }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
