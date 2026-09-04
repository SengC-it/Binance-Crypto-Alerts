import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { V17_BASELINE, V17_BRANCH, V17_END, V17_MONTHS, V17_START, V17_SYMBOLS, V17_CACHE_MANIFEST_PATH, V17_INVENTORY_PATH, V17_PARSER_REPORT_PATH, readJson, sha256 } from "../lib/v17/data";
import { V17_PARAMETERS } from "../lib/v17/engine";

const REPORT_DIR = resolve("reports");
const FREEZE_PATH = resolve(REPORT_DIR, "v17-freeze-manifest.json");

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

async function fileHash(path: string): Promise<string> { return sha256(await readFile(path)); }

async function main(): Promise<void> {
  const inventory = await readJson<{ enumerationComplete: boolean; expectedSlots: number; records: Array<{ expectedSha256: string | null }> }>(V17_INVENTORY_PATH);
  const cache = await readJson<{ sealed: boolean; verifiedArchiveSlots: number }>(resolve(V17_CACHE_MANIFEST_PATH));
  const parser = await readJson<{ archiveSlots: { expected: number; checksumVerified: number; parseComplete: boolean } }>(V17_PARSER_REPORT_PATH);
  const body = {
    schema: "v17-freeze-manifest-v1",
    baseline: V17_BASELINE,
    branch: V17_BRANCH,
    status: "FROZEN_BEFORE_RETURNS",
    historicalReturnsRead: false,
    source: { provider: "Binance Data Vision", market: "USD-M perpetual", officialOnly: true, noThirdPartyPriceData: true, noCurrentSurvivorUniverse: true, noSyntheticBars: true, noForwardFill: true, start: V17_START, end: V17_END, symbols: [...V17_SYMBOLS], datasets: ["15m", "1h", "fundingRate", "markPriceKlines-5m"], months: V17_MONTHS.length, archiveInventory: "complete deterministic symbol/month/dataset enumeration", checksumPolicy: "every used ZIP must match its official .CHECKSUM before first write", inventorySha256: await fileHash(V17_INVENTORY_PATH), cacheManifestSha256: await fileHash(V17_CACHE_MANIFEST_PATH), parserReportSha256: await fileHash(V17_PARSER_REPORT_PATH), inventorySlots: inventory.expectedSlots, inventoryChecksumListed: inventory.records.filter((record) => record.expectedSha256 !== null).length, cacheSealed: cache.sealed, checksumVerifiedSlots: cache.verifiedArchiveSlots, parseComplete: parser.archiveSlots.parseComplete },
    signal: { fundingClock: "actual fundingRate timestamp; never rounded to 00/08/16 UTC", fundingQuantiles: { long: V17_PARAMETERS.fundingQuantiles.long, short: V17_PARAMETERS.fundingQuantiles.short }, fundingLookbackDays: V17_PARAMETERS.fundingLookbackDays, minimumFundingHistoryDays: V17_PARAMETERS.minimumFundingHistoryDays, preReturn8h: "closed 15m prices before funding timestamp", failedContinuationWindow: "funding timestamp + 30m using two fully closed 15m bars", continuationResponse: "crowding direction multiplied by postFunding30m", continuationResponseQuantile: V17_PARAMETERS.continuationQuantile, primaryDirections: { crowdedLong: "SHORT", crowdedShort: "LONG" } },
    execution: { decisionTime: "funding timestamp + 30m", entryRule: "first complete 15m futures candle open after decision", noSameWindowExecution: true, atr: "15m ATR14", stop: "1.5 ATR", takeProfit: "2R", maxHold: "6h", sameBarStopFirst: true, noOverlappingSameSymbol: true },
    costs: { takerFeeBpsPerSide: V17_PARAMETERS.takerFeeBpsPerSide, baseSlippageBpsPerSide: V17_PARAMETERS.baseSlippageBpsPerSide, funding: "actual future fundingRate rows and mark price; missing required settlement is DATA_UNAVAILABLE", stressRoundTripBps: [...V17_PARAMETERS.stressRoundTripBps], noDoubleCounting: true },
    manualDelay: { delaysMinutes: [...V17_PARAMETERS.manualDelayMinutes], execution: "first actual 15m executable open after delay; expired if frozen bracket is hit before entry" },
    placebos: ["EXTREME_FUNDING_ONLY", "CONTINUATION_DIRECTION", "TIME_MATCHED_RANDOM"],
    validation: { nestedPurgedWalkForward: true, primaryOosYears: [2022, 2023, 2024], holdoutA: "2025-01-01/2025-12-31", holdoutB: "2026-01-01/2026-07-31", bootstrap: "block bootstrap with AvgR 95% CI and LCB", diagnostics: ["funding magnitude Q90-95/Q95-99/Q99+", "fixed horizon 1h/2h/4h/6h", "instrument BTC/ETH", "direction", "year", "random placebo", "email utility"], noParameterSearch: true },
    gates: { data: { officialArchiveInventoryComplete: true, usedZipChecksumCoverage: 1, kline15mCoverage: 0.995, kline1hCoverage: 0.995, fundingValidity: 1, fundingTimestampMonotonicity: true, markSettlementCoverage: 1, pit180dFundingHistory: 0.99, preReturn8h: 0.99, postFunding30m: 0.99, execution: 0.99, atr14: 0.99, noSyntheticFallback: true }, primary: { trades: 150, netR: ">0", avgR: ">=0.10", profitFactor: ">=1.30", maxDrawdownR: "<=8", positiveYearRatio: ">=0.67", medianYearNetR: ">0", stress5bps: ">0", stress10bps: ">0" }, holdouts: { A: { trades: 35, netR: ">0", avgR: ">0", profitFactor: ">=1.20", maxDrawdownR: "<=6" }, B: { trades: 20, netR: ">0", avgR: ">0", profitFactor: ">=1.20", maxDrawdownR: "<=6" } }, manual: { delay15m: { netR: ">0", profitFactor: ">=1.20" }, delay30m: { netR: ">0", profitFactor: ">=1.15" } }, confidence: { robustLCB: ">0" }, emailUtility: { meanSignalsPerMonth: ">=2", medianSignalsPerMonth: ">=2", activeMonthRatio: ">=0.70", maxDroughtDays: "<=45" } },
    boundaries: { productionChanged: "NO", productionEmail: "OFF", deploy: "NO", merge: "NO", migration: "NO", autoTrading: "NO", privateBinanceApi: "NO", orderPlacement: "NO" },
  };
  const manifestSha256 = hash(JSON.stringify(body));
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(FREEZE_PATH, `${JSON.stringify({ ...body, manifestSha256 }, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ phase: "v17-freeze", commitMessage: "research(v17): freeze crowding failed-continuation experiment", manifestSha256, historicalReturnsRead: false }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
