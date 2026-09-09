import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { V22_END_MS, V22_INTERVAL_MS, V22_OKX_INSTRUMENTS, V22_START_MS, V22_SYMBOLS, type V22Symbol } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);
const ROOT = resolve("data/raw/v22");
const BINANCE_ROOT = resolve(ROOT, "binance");
const OKX_ROOT = resolve(ROOT, "okx");
const BINANCE_BASE = "https://data.binance.vision/data/futures/um/monthly/klines";
const OKX_BASE = "https://www.okx.com/api/v5/market/history-candles";

interface BinanceArtifact {
  symbol: V22Symbol;
  month: string;
  url: string;
  checksumUrl: string;
  zipPath: string;
  checksumPath: string;
  byteLength: number;
  sha256: string;
  officialChecksum: string;
  extractedCsv: string;
}

interface OkxResponseArtifact {
  request: string;
  line: number;
  byteLength: number;
  sha256: string;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  rows: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { accept: "application/octet-stream" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchOkxBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("curl.exe", ["-k", "-sS", "--max-time", "60", url], { maxBuffer: 5 * 1024 * 1024, encoding: "buffer" });
      return new Uint8Array(stdout as Buffer);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`OKX request failed: ${url}`);
}

async function immutableWrite(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== sha256(bytes)) throw new Error(`immutable raw artifact changed: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, bytes, { flag: "wx" });
}

function monthKeys(): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(2023, 6, 1));
  const end = new Date(Date.UTC(2026, 7, 1));
  while (cursor < end) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function extractZip(zipPath: string, outputDirectory: string): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const expectedName = zipPath.replace(/\.zip$/, ".csv");
  try {
    await access(expectedName);
    return expectedName;
  } catch {
    await execFileAsync("tar", ["-xf", zipPath, "-C", outputDirectory]);
    const extracted = expectedName;
    await access(extracted);
    return extracted;
  }
}

async function downloadBinanceArtifact(symbol: V22Symbol, month: string): Promise<BinanceArtifact> {
  const fileName = `${symbol}-5m-${month}`;
  const directory = resolve(BINANCE_ROOT, symbol);
  const zipPath = resolve(directory, `${fileName}.zip`);
  const checksumPath = resolve(directory, `${fileName}.zip.CHECKSUM`);
  const url = `${BINANCE_BASE}/${symbol}/5m/${fileName}.zip`;
  const checksumUrl = `${url}.CHECKSUM`;
  await mkdir(directory, { recursive: true });
  try {
    const existingZip = await readFile(zipPath);
    const existingChecksum = await readFile(checksumPath);
    const officialChecksum = new TextDecoder().decode(existingChecksum).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const actualSha = sha256(existingZip);
    if (actualSha === officialChecksum && /^[a-f0-9]{64}$/.test(officialChecksum)) {
      const extractedCsv = await extractZip(zipPath, directory);
      return { symbol, month, url, checksumUrl, zipPath, checksumPath, byteLength: existingZip.byteLength, sha256: actualSha, officialChecksum, extractedCsv };
    }
  } catch {
    // Missing or invalid local artifacts are downloaded once and then frozen.
  }
  const zipBytes = await fetchBytes(url);
  const checksumBytes = await fetchBytes(checksumUrl);
  await immutableWrite(zipPath, zipBytes);
  await immutableWrite(checksumPath, checksumBytes);
  const checksumText = new TextDecoder().decode(checksumBytes).trim();
  const officialChecksum = checksumText.split(/\s+/)[0]?.toLowerCase() ?? "";
  const actualSha = sha256(zipBytes);
  if (!/^[a-f0-9]{64}$/.test(officialChecksum) || actualSha !== officialChecksum) {
    throw new Error(`Binance checksum mismatch for ${fileName}: ${actualSha} != ${officialChecksum}`);
  }
  const extractedCsv = await extractZip(zipPath, directory);
  return {
    symbol,
    month,
    url,
    checksumUrl,
    zipPath,
    checksumPath,
    byteLength: zipBytes.byteLength,
    sha256: actualSha,
    officialChecksum,
    extractedCsv,
  };
}

async function downloadBinance(): Promise<void> {
  const jobs = V22_SYMBOLS.flatMap((symbol) => monthKeys().map((month) => ({ symbol, month })));
  const results: BinanceArtifact[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) return;
      results.push(await downloadBinanceArtifact(job.symbol, job.month));
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  await writeFile(resolve(BINANCE_ROOT, "manifest.json"), `${JSON.stringify({
    source: "Binance Data Vision official USD-M monthly klines",
    interval: "5m",
    start: new Date(V22_START_MS).toISOString(),
    endExclusive: new Date(V22_END_MS).toISOString(),
    artifacts: results.sort((a, b) => a.zipPath.localeCompare(b.zipPath)),
  }, null, 2)}\n`, "utf8");
}

const OKX_CHUNK_BOUNDARIES = [
  V22_START_MS,
  Date.parse("2024-01-01T00:00:00.000Z"),
  Date.parse("2025-01-01T00:00:00.000Z"),
  Date.parse("2026-01-01T00:00:00.000Z"),
  V22_END_MS,
];

interface OkxChunk {
  chunk: number;
  bodyLines: string[];
  responses: OkxResponseArtifact[];
}

async function downloadOkxChunk(symbol: V22Symbol, startMs: number, endMs: number, chunk: number): Promise<OkxChunk> {
  const bodyLines: string[] = [];
  const responses: OkxResponseArtifact[] = [];
  let cursor = endMs;
  let finished = false;
  while (!finished) {
    const instrument = V22_OKX_INSTRUMENTS[symbol];
    const request = `${OKX_BASE}?instId=${encodeURIComponent(instrument)}&bar=5m&limit=300&after=${cursor}`;
    let bytes: Uint8Array | undefined;
    let parsed: { code?: string; data?: string[][]; msg?: string } | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      bytes = await fetchOkxBytes(request);
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)) as typeof parsed; } catch { parsed = undefined; }
      if (parsed?.code === "0" && Array.isArray(parsed.data) && parsed.data.length > 0) break;
      if (attempt === 5) throw new Error(`OKX response failed for ${symbol} chunk ${chunk}: ${parsed?.msg ?? "invalid response"}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * (attempt + 1)));
    }
    if (!bytes || !parsed?.data) throw new Error(`OKX response unavailable for ${symbol} chunk ${chunk}`);
    const timestamps = parsed.data.map((row) => Number(row[0])).filter(Number.isFinite);
    const minimum = Math.min(...timestamps);
    if (!Number.isFinite(minimum) || minimum >= cursor) throw new Error(`OKX cursor did not advance for ${symbol} chunk ${chunk}`);
    bodyLines.push(new TextDecoder().decode(bytes));
    responses.push({
      request,
      line: responses.length + 1,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      firstTimestamp: timestamps.length ? Math.max(...timestamps) : null,
      lastTimestamp: timestamps.length ? minimum : null,
      rows: parsed.data.length,
    });
    cursor = minimum;
    finished = minimum < startMs;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return { chunk, bodyLines, responses };
}

async function downloadOkxSymbol(symbol: V22Symbol): Promise<void> {
  const directory = resolve(OKX_ROOT, symbol);
  await mkdir(directory, { recursive: true });
  const bodyPath = resolve(directory, `${symbol}-5m.ndjson`);
  const manifestPath = resolve(directory, "manifest.json");
  try {
    await access(manifestPath);
    await access(bodyPath);
    return;
  } catch {
    // An incomplete pair is never silently reused.
    for (const name of await readdir(directory)) {
      if (name.endsWith(".ndjson") || name === "manifest.json") await unlink(resolve(directory, name));
    }
  }
  const chunks = await Promise.all(OKX_CHUNK_BOUNDARIES.slice(0, -1).map((startMs, chunk) => downloadOkxChunk(symbol, startMs, OKX_CHUNK_BOUNDARIES[chunk + 1]!, chunk)));
  const body = chunks.sort((left, right) => left.chunk - right.chunk).flatMap((item) => item.bodyLines).join("\n") + "\n";
  const responses = chunks.flatMap((item) => item.responses).map((response, index) => ({ ...response, line: index + 1 }));
  await writeFile(bodyPath, body, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({
    source: "OKX official public market history-candles API",
    instrument: V22_OKX_INSTRUMENTS[symbol],
    interval: "5m",
    start: new Date(V22_START_MS).toISOString(),
    endExclusive: new Date(V22_END_MS).toISOString(),
    bodyPath,
    bodyByteLength: Buffer.byteLength(body),
    responseCount: responses.length,
    responses,
  }, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await downloadBinance();
  await Promise.all(V22_SYMBOLS.map((symbol) => downloadOkxSymbol(symbol)));
  console.info(JSON.stringify({ stage: "v22_raw_download_complete", symbols: V22_SYMBOLS, months: monthKeys().length, intervalMs: V22_INTERVAL_MS }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
