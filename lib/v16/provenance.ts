import { createHash } from "node:crypto";

export function canonicalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function canonicalTextSha256(value: string): string {
  return createHash("sha256").update(canonicalizeText(value), "utf8").digest("hex");
}
