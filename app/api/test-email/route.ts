import { type NextRequest, NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config";
import { sendTestEmail } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const config = getServerConfig();
    if (!isAuthorized(request, config.CRON_SECRET)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const result = await sendTestEmail();
    return NextResponse.json({
      ok: !result.skipped,
      skipped: result.skipped,
      messageId: result.messageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/test-email] failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function isAuthorized(request: NextRequest, expectedSecret?: string): boolean {
  if (!expectedSecret) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === expectedSecret || request.headers.get("x-cron-secret") === expectedSecret;
}
