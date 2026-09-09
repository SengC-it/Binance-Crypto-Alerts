import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateCandle } from "@/lib/v22/data";
import { V22_INTERVAL_MS, type V22Candle, type V22Symbol } from "@/lib/v22/types";

const execFileAsync = promisify(execFile);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface BinanceProvenance {
  symbol: V22Symbol;
  month: string;
  zipSha256: string;
  officialChecksum: string;
  checksumVerified: boolean;
  archiveEntryName: string | null;
  extractedCsvSha256: string;
  extractedCsvByteLength: number;
  freshExtractionSha256: string | null;
  freshExtractionByteLength: number | null;
  extractedCsvVerifiedAgainstZip: boolean;
  pass: boolean;
  error?: string;
}

async function tarStdout(args: string[], maxBuffer = 32 * 1024 * 1024): Promise<Buffer> {
  const result = await execFileAsync("tar", args, { encoding: "buffer", maxBuffer });
  return result.stdout as Buffer;
}

function parseOfficialChecksum(bytes: Uint8Array): string {
  const token = new TextDecoder().decode(bytes).trim().split(/\s+/)[0] ?? "";
  return token.toLowerCase();
}

export function verifyZipChecksum(zipBytes: Uint8Array, officialChecksum: string): boolean {
  return /^[a-f0-9]{64}$/i.test(officialChecksum) && digest(zipBytes) === officialChecksum.toLowerCase();
}

export function verifyExtractedCsvMatch(storedBytes: Uint8Array, freshlyExtractedBytes: Uint8Array): boolean {
  return storedBytes.byteLength === freshlyExtractedBytes.byteLength && digest(storedBytes) === digest(freshlyExtractedBytes);
}

export async function verifyBinanceArtifact(input: {
  symbol: V22Symbol;
  month: string;
  zipPath: string;
  checksumPath: string;
  extractedCsvPath: string;
}): Promise<BinanceProvenance> {
  const storedCsv = await readFile(input.extractedCsvPath);
  const zip = await readFile(input.zipPath);
  const checksum = parseOfficialChecksum(await readFile(input.checksumPath));
  const zipSha256 = digest(zip);
  const checksumVerified = verifyZipChecksum(zip, checksum);
  let archiveEntryName: string | null = null;
  let freshExtractionSha256: string | null = null;
  let freshExtractionByteLength: number | null = null;
  let extractedCsvVerifiedAgainstZip = false;
  let error: string | undefined;
  try {
    if (!checksumVerified) throw new Error("official Binance checksum does not match ZIP bytes");
    const entries = (await tarStdout(["-tf", input.zipPath], 64 * 1024)).toString("utf8").split(/\r?\n/).filter((value) => value.endsWith(".csv"));
    if (entries.length !== 1) throw new Error(`expected exactly one CSV archive entry, found ${entries.length}`);
    archiveEntryName = entries[0]!;
    const extracted = await tarStdout(["-xOf", input.zipPath, archiveEntryName]);
    freshExtractionSha256 = digest(extracted);
    freshExtractionByteLength = extracted.byteLength;
    extractedCsvVerifiedAgainstZip = verifyExtractedCsvMatch(storedCsv, extracted);
    if (!extractedCsvVerifiedAgainstZip) throw new Error("stored extracted CSV differs from fresh verified ZIP extraction");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    symbol: input.symbol,
    month: input.month,
    zipSha256,
    officialChecksum: checksum,
    checksumVerified,
    archiveEntryName,
    extractedCsvSha256: digest(storedCsv),
    extractedCsvByteLength: storedCsv.byteLength,
    freshExtractionSha256,
    freshExtractionByteLength,
    extractedCsvVerifiedAgainstZip,
    pass: checksumVerified && extractedCsvVerifiedAgainstZip,
    ...(error ? { error } : {}),
  };
}

export interface OkxLineAudit {
  line: number;
  request: string;
  manifestByteLength: number;
  actualByteLength: number;
  manifestSha256: string;
  actualSha256: string;
  byteHashVerified: boolean;
  responseCode: string | null;
  rows: number;
  rowsValid: boolean;
  pass: boolean;
  error?: string;
}

export function splitNdjsonLines(bytes: Uint8Array): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 10) continue;
    const line = Buffer.from(bytes.slice(start, index)).toString("utf8").replace(/\r$/, "");
    if (line.length > 0) lines.push(Buffer.from(line, "utf8"));
    start = index + 1;
  }
  return lines;
}

function parseOkxBody(bytes: Uint8Array): { code: string | null; data: string[][]; valid: boolean } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown; data?: unknown };
    const data = Array.isArray(parsed.data) ? parsed.data as string[][] : [];
    const valid = parsed.code === "0" && data.every((row) => Array.isArray(row) && row.length >= 9 && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[1])) && Number.isFinite(Number(row[2])) && Number.isFinite(Number(row[3])) && Number.isFinite(Number(row[4])) && Number.isFinite(Number(row[5])) && (row[8] === "0" || row[8] === "1"));
    return { code: typeof parsed.code === "string" ? parsed.code : null, data, valid };
  } catch {
    return { code: null, data: [], valid: false };
  }
}

export function verifyOkxFrozenLines(input: {
  bodyBytes: Uint8Array;
  responses: readonly { request: string; byteLength: number; sha256: string }[];
}): { lineCount: number; responseCount: number; lines: OkxLineAudit[]; allResponseHashesVerified: boolean; pass: boolean } {
  const lines = splitNdjsonLines(input.bodyBytes);
  const audits = input.responses.map((manifest, index): OkxLineAudit => {
    const line = lines[index];
    if (!line) {
      return { line: index + 1, request: manifest.request, manifestByteLength: manifest.byteLength, actualByteLength: 0, manifestSha256: manifest.sha256, actualSha256: "", byteHashVerified: false, responseCode: null, rows: 0, rowsValid: false, pass: false, error: "missing NDJSON line" };
    }
    const parsed = parseOkxBody(line);
    const actualSha256 = digest(line);
    const byteHashVerified = line.byteLength === manifest.byteLength && actualSha256 === manifest.sha256;
    return {
      line: index + 1,
      request: manifest.request,
      manifestByteLength: manifest.byteLength,
      actualByteLength: line.byteLength,
      manifestSha256: manifest.sha256,
      actualSha256,
      byteHashVerified,
      responseCode: parsed.code,
      rows: parsed.data.length,
      rowsValid: parsed.valid,
      pass: byteHashVerified && parsed.valid,
    };
  });
  const allResponseHashesVerified = lines.length === input.responses.length && audits.length === input.responses.length && audits.every((audit) => audit.byteHashVerified);
  return { lineCount: lines.length, responseCount: input.responses.length, lines: audits, allResponseHashesVerified, pass: allResponseHashesVerified && audits.every((audit) => audit.pass) };
}

export interface OkxSecureRevalidation {
  attempted: number;
  succeeded: number;
  failed: number;
  parsedRowsEqual: number;
  mismatches: Array<{ line: number; request: string; reason: string }>;
  pass: boolean;
}

async function fetchSecure(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (process.platform !== "win32") {
        const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }
      const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
      const result = await execFileAsync(curlCommand, ["-sS", "--tlsv1.2", "--max-time", "60", url], { encoding: "buffer", maxBuffer: 5 * 1024 * 1024 });
      if (!result.stdout || (result.stdout as Buffer).byteLength === 0) throw new Error("secure response was empty");
      return new Uint8Array(result.stdout as Buffer);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchSecureBatch(urls: readonly string[], parallelism: number): Promise<Array<Uint8Array | null>> {
  const results: Array<Uint8Array | null> = Array.from({ length: urls.length }, () => null);
  const workerCount = Math.max(1, Math.min(parallelism, urls.length || 1));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= urls.length) return;
      try { results[index] = await fetchSecure(urls[index]!); } catch { results[index] = null; }
    }
  }));
  return results;
}

export async function secureRevalidateOkxResponses(input: {
  lines: readonly Buffer[];
  responses: readonly { request: string }[];
  concurrency?: number;
}): Promise<OkxSecureRevalidation> {
  const mismatches: Array<{ line: number; request: string; reason: string }> = [];
  let succeeded = 0;
  let parsedRowsEqual = 0;
  let completed = 0;
  const batchSize = Math.max(1, Math.min(input.concurrency ?? 24, 32));
  for (let start = 0; start < input.responses.length; start += batchSize) {
    const batch = input.responses.slice(start, start + batchSize);
    const freshBodies = await fetchSecureBatch(batch.map((response) => response.request), batchSize);
    for (let offset = 0; offset < batch.length; offset += 1) {
      const index = start + offset;
      const manifest = batch[offset]!;
      const frozen = input.lines[index];
      try {
        const freshBody = freshBodies[offset];
        if (!frozen || !freshBody) throw new Error("secure response unavailable");
        const fresh = parseOkxBody(freshBody);
        const prior = parseOkxBody(frozen);
        if (fresh.code !== "0" || !fresh.valid) throw new Error("secure response code or rows invalid");
        if (JSON.stringify(fresh.data) !== JSON.stringify(prior.data)) throw new Error("secure parsed rows differ from frozen response");
        succeeded += 1;
        parsedRowsEqual += 1;
      } catch (error) {
        mismatches.push({ line: index + 1, request: manifest.request, reason: error instanceof Error ? error.message : String(error) });
      }
      completed += 1;
    }
    if (completed % 250 < batch.length || completed === input.responses.length) console.info(JSON.stringify({ stage: "v22_okx_secure_revalidation", completed, total: input.responses.length }));
  }
  return {
    attempted: input.responses.length,
    succeeded,
    failed: input.responses.length - succeeded,
    parsedRowsEqual,
    mismatches: mismatches.sort((left, right) => left.line - right.line),
    pass: succeeded === input.responses.length && mismatches.length === 0,
  };
}

export function candleFromOkxRow(row: readonly string[], symbol: V22Symbol, instrument: string): V22Candle {
  const openTime = Number(row[0]);
  return { venue: "OKX_USDT_SWAP", instrument, symbol, openTimeUtc: openTime, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTimeUtc: openTime + V22_INTERVAL_MS - 1, closed: row[8] === "1" };
}

export function okxRowsAreValid(rows: readonly string[][]): boolean {
  return rows.every((row) => row.length >= 9 && validateCandle(candleFromOkxRow(row, "BTCUSDT", "BTC-USDT-SWAP")));
}
