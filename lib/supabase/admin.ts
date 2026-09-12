import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerConfig } from "@/lib/config";

let cachedClient: SupabaseClient | undefined;

/**
 * Per-request ceiling for Supabase REST calls.
 *
 * Without this, a hung connection inherits the platform's fetch defaults and
 * can consume the whole serverless `maxDuration`, surfacing as an opaque
 * "Gateway Timeout" with no chance to retry. Bounding each attempt keeps the
 * retry layer in control: a slow query fails at 8s, leaving budget for the
 * remaining attempts inside the 60s function limit.
 */
const SUPABASE_REQUEST_TIMEOUT_MS = 8_000;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const config = getServerConfig();
  cachedClient = createClient(config.SUPABASE_URL, config.supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      // Supabase's client forwards these to the underlying fetch call.
      fetch: (input, init) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);
        // Respect an upstream signal if one is already present.
        const upstream = init?.signal;
        if (upstream) {
          if (upstream.aborted) controller.abort();
          else upstream.addEventListener("abort", () => controller.abort(), { once: true });
        }
        return fetch(input, { ...init, signal: controller.signal }).finally(() => {
          clearTimeout(timeout);
        });
      },
    },
  });
  return cachedClient;
}
