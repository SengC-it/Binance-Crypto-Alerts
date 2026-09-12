import { NextResponse } from "next/server";
import { PRODUCTION_ENTRY_MODE, PRODUCTION_STRATEGY_VERSION } from "@/lib/core/production-policy";
import {
  ALPHA_RESEARCH_PROGRAM_STATUS,
  AUTOMATIC_TRADING_ENABLED,
  ORDER_PLACEMENT_ENABLED,
  PRODUCTION_SIGNAL_EMAIL_ENABLED,
  PRODUCTION_STRATEGY_PROMOTED,
  RELEASE_MODE,
} from "@/lib/core/release-policy";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "binance-crypto-alerts",
    mode: "alert-only",
    releaseMode: RELEASE_MODE,
    alphaResearchProgramStatus: ALPHA_RESEARCH_PROGRAM_STATUS,
    signalEmailEnabled: PRODUCTION_SIGNAL_EMAIL_ENABLED,
    productionStrategyPromoted: PRODUCTION_STRATEGY_PROMOTED,
    automaticTrading: AUTOMATIC_TRADING_ENABLED,
    orderPlacement: ORDER_PLACEMENT_ENABLED,
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
