import { createHash } from "node:crypto";

export function canonicalText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalTextSha256(value: string): string {
  return sha256(canonicalText(value));
}
