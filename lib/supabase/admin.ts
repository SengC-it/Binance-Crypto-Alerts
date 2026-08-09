import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerConfig } from "@/lib/config";

let cachedClient: SupabaseClient | undefined;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const config = getServerConfig();
  cachedClient = createClient(config.SUPABASE_URL, config.supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cachedClient;
}
