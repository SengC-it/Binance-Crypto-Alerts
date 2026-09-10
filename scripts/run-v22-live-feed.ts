import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { V22_OKX_INSTRUMENTS, V22_SYMBOLS, type V22Symbol } from "@/lib/v22/types";

const REPORT_DIR = resolve("reports");
const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publicRequest(url: string): Promise<{ status: number; bytes: Uint8Array }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (process.platform === "win32") {
        const marker = "\n__V22_HTTP_STATUS__:";
        const result = await execFileAsync("curl.exe", ["--silent", "--show-error", "--tlsv1.2", "--max-time", "30", "--write-out", `${marker}%{http_code}`, url], { encoding: "buffer", maxBuffer: 5 * 1024 * 1024 });
        const output = result.stdout as Buffer;
        const markerBytes = Buffer.from(marker, "utf8");
        const markerIndex = output.lastIndexOf(markerBytes);
        if (markerIndex < 0) throw new Error("secure public response status unavailable");
        const status = Number(output.subarray(markerIndex + markerBytes.byteLength).toString("utf8"));
        if (!Number.isInteger(status)) throw new Error("secure public response status invalid");
        return { status, bytes: output.subarray(0, markerIndex) };
      }
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function probe(url: string, venue: "BINANCE" | "OKX", symbol: V22Symbol) {
  const requestedAt = new Date().toISOString();
  try {
    const response = await publicRequest(url);
    const bytes = response.bytes;
    const body = new TextDecoder().decode(bytes);
    const status = response.status;
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* schema result records parse failure */ }
    const rows = venue === "OKX" && parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data?: unknown }).data
      : parsed;
    const valid = status >= 200 && status < 300 && Array.isArray(rows) && rows.length > 0;
    return {
      venue,
      symbol,
      request: url,
      requestedAt,
      httpStatus: status,
      success: status >= 200 && status < 300,
      byteLength: bytes.byteLength,
      responseSha256: sha256(bytes),
      schema: venue === "BINANCE"
        ? ["openTime", "open", "high", "low", "close", "volume", "closeTime"]
        : ["ts", "o", "h", "l", "c", "vol", "volCcy", "volCcyQuote", "confirm"],
      closedCandleMarker: venue === "BINANCE" ? "public klines closeTime < now" : "OKX row[8] === 1",
      closedRowsObserved: valid,
      publicAuthenticationRequired: false,
      accountPermissionRequired: false,
      tradingPermissionRequired: false,
      rateLimitDocumentation: venue === "BINANCE"
        ? "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data"
        : "https://www.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks",
      runtimeCompatibility: "Vercel Node API public HTTPS fetch; no websocket or private permission",
    };
  } catch (error) {
    return {
      venue,
      symbol,
      request: url,
      requestedAt,
      httpStatus: null,
      success: false,
      byteLength: 0,
      responseSha256: null,
      schema: [],
      closedCandleMarker: "unavailable",
      closedRowsObserved: false,
      publicAuthenticationRequired: false,
      accountPermissionRequired: false,
      tradingPermissionRequired: false,
      rateLimitDocumentation: venue === "BINANCE"
        ? "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data"
        : "https://www.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks",
      runtimeCompatibility: "probe failed: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const results = [];
  for (const symbol of V22_SYMBOLS) {
    results.push(await probe(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=2`, "BINANCE", symbol));
    results.push(await probe(`https://www.okx.com/api/v5/market/candles?instId=${V22_OKX_INSTRUMENTS[symbol]}&bar=5m&limit=2`, "OKX", symbol));
  }
  const allPass = results.every((result) => result.success && result.closedRowsObserved);
  await writeFile(resolve(REPORT_DIR, "v22-live-feed-feasibility.json"), `${JSON.stringify({
    schema: "v22-live-feed-feasibility-v1",
    experimentId: "V22_CROSS_VENUE_PRICE_DISCOVERY",
    policy: "REST-first public completed 5m candles; no signal, persistence, email, or private credentials",
    binancePublicFeed: results.filter((result) => result.venue === "BINANCE").every((result) => result.success) ? "PASS" : "FAIL",
    okxPublicFeed: results.filter((result) => result.venue === "OKX").every((result) => result.success) ? "PASS" : "FAIL",
    allSymbolsPass: allPass,
    results,
    noProductionWrites: true,
    noEmail: true,
    noTradingEndpoints: true,
  }, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ stage: "v22_live_feed_feasibility_complete", allPass }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
