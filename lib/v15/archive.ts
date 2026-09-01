import { inflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { normalizeBinanceTimestamp, type V15Bar } from "@/lib/v15/lead-lag";

export interface ZipEntry { name: string; data: Buffer; }

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("ZIP entry exceeds archive length");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP method ${method}`); })();
    entries.push({ name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"), data });
    offset = dataEnd;
  }
  if (!entries.length) throw new Error("ZIP archive contained no local file entries");
  return entries;
}

function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { fields.push(current); current = ""; }
    else current += character;
  }
  fields.push(current);
  return fields;
}

export function parseKlineArchive(buffer: Buffer): V15Bar[] {
  const entry = readZipEntries(buffer).find((item) => !item.name.endsWith("/"));
  if (!entry) throw new Error("ZIP archive contained no data file");
  const lines = entry.data.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  return lines.map(splitCsv).filter((fields) => fields.length >= 8 && Number.isFinite(normalizeBinanceTimestamp(fields[0]))).map((fields) => ({
    openTime: normalizeBinanceTimestamp(fields[0]),
    open: Number(fields[1]),
    high: Number(fields[2]),
    low: Number(fields[3]),
    close: Number(fields[4]),
    quoteVolume: Number(fields[7]),
    takerBuyQuoteVolume: Number(fields[10] ?? 0),
    closeTime: normalizeBinanceTimestamp(fields[6]),
  })).filter((bar) => [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.quoteVolume, bar.takerBuyQuoteVolume, bar.closeTime].every(Number.isFinite));
}

export async function readKlineArchive(path: string): Promise<V15Bar[]> {
  return parseKlineArchive(await readFile(path));
}
