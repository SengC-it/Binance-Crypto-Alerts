import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Shared retry/timeout policy for Supabase reads and writes.
 *
 * Supabase (especially the free tier) can briefly return gateway-level
 * failures - HTTP 502/503/504, "Gateway Timeout", "upstream request timeout",
 * connection resets, or DNS hiccups - while the database itself is healthy.
 * Treating a single blip as a fatal scan failure produced false "严重告警"
 * emails, so every repository call now goes through a bounded retry.
 */

export interface SupabaseRetryOptions {
  /** Logical operation name, used for error messages and logging. */
  operation: string;
  /** Total attempts, including the first one. */
  attempts?: number;
  /** Base backoff in milliseconds; grows exponentially per attempt. */
  baseDelayMs?: number;
  /** Maximum backoff in milliseconds. */
  maxDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 2_000;

/**
 * Messages that indicate a transient transport/gateway problem rather than a
 * real schema, constraint, or authorization error. Matching these lets us
 * retry instead of alerting.
 */
const TRANSIENT_MESSAGE_PATTERNS = [
  /gateway\s*timeout/i,
  /upstream\s+(request\s+)?timeout/i,
  /timeout/i,
  /timed\s*out/i,
  /econnreset/i,
  /econnrefused/i,
  /epipe/i,
  /etimedout/i,
  /socket\s+hang\s*up/i,
  /fetch\s+failed/i,
  /network\s+error/i,
  /connection\s+(error|reset|closed|terminated)/i,
  /temporarily\s+unavailable/i,
  /service\s+unavailable/i,
  /bad\s+gateway/i,
  /too\s+many\s+connections/i,
  /enotfound/i,
  /eai_again/i,
];

/** HTTP statuses returned by the Supabase gateway that are safe to retry. */
const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** Postgres SQLSTATE codes that indicate transient infrastructure pressure. */
const TRANSIENT_PG_CODES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
]);

export function isTransientSupabaseError(error: unknown): boolean {
  if (!error) return false;

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && TRANSIENT_STATUS_CODES.has(status)) return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_PG_CODES.has(code)) return true;

  const message = errorMessage(error);
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Runs a Supabase operation with bounded retries and exponential backoff.
 *
 * `operation` receives the current attempt number (1-based) so callers can log
 * or vary behaviour. Only transient errors are retried; a real constraint
 * violation fails fast so the caller still sees the real problem.
 */
export async function withSupabaseRetry<T>(
  operation: () => Promise<T>,
  options: SupabaseRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientSupabaseError(error) || attempt === attempts) break;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      console.warn(
        `[supabase] ${options.operation} failed (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms: ${errorMessage(error)}`,
      );
      await delay(delayMs);
    }
  }

  // Supabase surfaces transport failures as plain `{ message, code }` objects
  // rather than `Error` instances. Normalise so callers and alert emails keep
  // the real reason (e.g. "Gateway Timeout") instead of a generic fallback.
  if (lastError instanceof Error) throw lastError;
  throw new Error(errorMessage(lastError) || `${options.operation} failed`);
}

/**
 * Wraps a PostgREST response. Supabase resolves query builders with
 * `{ data, error }` instead of rejecting, so transient errors must be turned
 * into throwables before `withSupabaseRetry` can see them.
 */
export async function runQuery<TExt>(
  operation: string,
  build: () => PromiseLike<{ data: TExt; error: PostgrestError | null }>,
  options: Omit<SupabaseRetryOptions, "operation"> = {},
): Promise<TExt> {
  return withSupabaseRetry(async () => {
    const { data, error } = await build();
    if (error) throw error;
    return data;
  }, { operation, ...options });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
