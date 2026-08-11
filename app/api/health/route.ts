import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "binance-crypto-alerts",
    mode: "alert-only",
    configuration: {
      binancePublicApi: Boolean(process.env.BINANCE_API_BASE_URL ?? "https://fapi.binance.com"),
      supabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY)),
      smtp: Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD && process.env.GMAIL_RECIPIENT),
      dryRun: (process.env.CS_DRY_RUN ?? "true").toLowerCase() === "true",
    },
    timestamp: new Date().toISOString(),
  });
}
