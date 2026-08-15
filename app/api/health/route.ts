import { NextResponse } from "next/server";
import { PRODUCTION_ENTRY_MODE, PRODUCTION_STRATEGY_VERSION } from "@/lib/core/production-policy";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "binance-crypto-alerts",
    mode: "alert-only",
    strategy: {
      version: PRODUCTION_STRATEGY_VERSION,
      entryMode: PRODUCTION_ENTRY_MODE,
      sideFilter: process.env.CS_SIGNAL_SIDE_FILTER ?? "SHORT",
    },
    configuration: {
      binancePublicApi: Boolean(process.env.BINANCE_API_BASE_URL ?? "https://fapi.binance.com"),
      supabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY)),
      smtp: Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD && process.env.GMAIL_RECIPIENT),
      dryRun: (process.env.CS_DRY_RUN ?? "true").toLowerCase() === "true",
    },
    timestamp: new Date().toISOString(),
  });
}
