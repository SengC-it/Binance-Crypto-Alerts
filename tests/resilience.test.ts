import { describe, expect, it, vi } from "vitest";
import {
  isTransientSupabaseError,
  runQuery,
  withSupabaseRetry,
} from "../lib/supabase/resilience";

describe("supabase resilience", () => {
  it("treats gateway timeouts as transient", () => {
    expect(isTransientSupabaseError(new Error("Gateway Timeout"))).toBe(true);
    expect(isTransientSupabaseError({ message: "upstream request timeout" })).toBe(true);
    expect(isTransientSupabaseError({ status: 504, message: "Bad gateway" })).toBe(true);
    expect(isTransientSupabaseError({ code: "08006", message: "connection failure" })).toBe(true);
  });

  it("does not treat real data errors as transient", () => {
    expect(isTransientSupabaseError({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isTransientSupabaseError({ code: "42P01", message: "relation does not exist" })).toBe(false);
    expect(isTransientSupabaseError(new Error("Invalid paper trade entry_price"))).toBe(false);
  });

  it("recovers when a transient error clears on retry", async () => {
    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Gateway Timeout");
      return "ok";
    });

    await expect(
      withSupabaseRetry(operation, { operation: "test lookup", baseDelayMs: 1 }),
    ).resolves.toBe("ok");
    expect(attempts).toBe(3);
  });

  it("fails fast on a non-transient error", async () => {
    const operation = vi.fn(async () => {
      throw new Error("Invalid paper trade quantity");
    });

    await expect(
      withSupabaseRetry(operation, { operation: "test lookup", baseDelayMs: 1 }),
    ).rejects.toThrow("Invalid paper trade quantity");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempt budget", async () => {
    const operation = vi.fn(async () => {
      throw new Error("Gateway Timeout");
    });

    await expect(
      withSupabaseRetry(operation, { operation: "test lookup", attempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow("Gateway Timeout");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("surfaces PostgREST errors returned in the response body", async () => {
    await expect(
      runQuery("paper trade lookup", async () => ({
        data: null,
        error: { message: "Gateway Timeout", code: "", details: "", hint: "" } as never,
      }), { attempts: 1 }),
    ).rejects.toThrow("Gateway Timeout");
  });

  it("returns data when the query succeeds", async () => {
    await expect(
      runQuery("paper trade lookup", async () => ({ data: { id: "trade-1" }, error: null })),
    ).resolves.toEqual({ id: "trade-1" });
  });
});
