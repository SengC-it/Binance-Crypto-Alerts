import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BinancePublicClient, mapWithConcurrency } from "@/lib/binance/public-client";
import type { Timeframe } from "@/lib/core/types";

async function main() {
  const baseUrl = process.env.BINANCE_API_BASE_URL ?? "https://fapi.binance.com";
  const symbols = csv(process.env.CS_HISTORY_SYMBOLS);
  if (symbols.length === 0) {
    throw new Error("Set CS_HISTORY_SYMBOLS before downloading local history");
  }

  const days = positiveNumber(process.env.CS_HISTORY_DAYS, 400);
  const endTime = Date.now();
  const startTime = endTime - days * 86_400_000;
  const timeframes = csv(process.env.CS_HISTORY_TIMEFRAMES).filter(isTimeframe);
  const selectedTimeframes: Timeframe[] = timeframes.length > 0 ? timeframes : ["15m", "1h", "4h"];
  const outputDirectory = resolve(process.env.CS_OPTIMIZER_DATA_DIR ?? "data/raw");
  const client = new BinancePublicClient(baseUrl);
  const universe = await client.getUniverse();
  const instrumentBySymbol = new Map(universe.map((instrument) => [instrument.symbol, instrument]));
  const outputSymbols = symbols.filter((symbol) => instrumentBySymbol.has(symbol));
  const unknownSymbols = symbols.filter((symbol) => !instrumentBySymbol.has(symbol));
  if (unknownSymbols.length > 0) {
    console.warn(`Skipping symbols not present in the current USDT-M perpetual universe: ${unknownSymbols.join(", ")}`);
  }
  if (outputSymbols.length === 0) throw new Error("None of CS_HISTORY_SYMBOLS are active USDT-M perpetuals");

  await mkdir(outputDirectory, { recursive: true });
  const concurrency = positiveNumber(process.env.CS_HISTORY_CONCURRENCY, 2);
  const results = await mapWithConcurrency(outputSymbols, concurrency, async (symbol) => {
    const instrument = instrumentBySymbol.get(symbol)!;
    const candleEntries: Record<string, unknown> = {};
    for (const timeframe of selectedTimeframes) {
      candleEntries[timeframe] = await client.getCandlesRange(symbol, timeframe, startTime, endTime);
    }
    const fundingRates = await client.getFundingRatesRange(symbol, startTime, endTime);
    const path = join(outputDirectory, `${symbol}.json`);
    await writeFile(path, JSON.stringify({ symbol, instrument, candles: candleEntries, fundingRates }, null, 2), "utf8");
    return { symbol, path, fundingCount: fundingRates.length };
  });

  console.info(JSON.stringify({
    ok: true,
    outputDirectory,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    timeframes: selectedTimeframes,
    files: results,
  }, null, 2));
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isTimeframe(value: string): value is Timeframe {
  return value === "15m" || value === "1h" || value === "4h";
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
