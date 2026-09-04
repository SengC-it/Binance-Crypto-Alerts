import { describe, expect, it } from "vitest";
import { canonicalTextSha256 } from "../lib/v16/provenance";

describe("V16 text artifact provenance hashing", () => {
  it("uses the same SHA-256 for LF and CRLF text", () => {
    const lf = "parser-report-v1\n{\"status\":\"FAIL\"}\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(canonicalTextSha256(crlf)).toBe(canonicalTextSha256(lf));
  });

  it("changes the SHA-256 when the canonical content changes", () => {
    const original = "parser-report-v1\n{\"status\":\"FAIL\"}\n";
    const changed = "parser-report-v1\n{\"status\":\"PASS\"}\n";

    expect(canonicalTextSha256(changed)).not.toBe(canonicalTextSha256(original));
  });
});
