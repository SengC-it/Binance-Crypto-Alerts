import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  getServerConfig: vi.fn(),
}));

vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock("@/lib/config", () => ({ getServerConfig: mocks.getServerConfig }));

import { GET as getHealth } from "@/app/api/health/route";
import {
  ALPHA_RESEARCH_PROGRAM_STATUS,
  AUTOMATIC_TRADING_ENABLED,
  ORDER_PLACEMENT_ENABLED,
  PRODUCTION_SIGNAL_EMAIL_ENABLED,
  PRODUCTION_STRATEGY_PROMOTED,
  RELEASE_MODE,
} from "@/lib/core/release-policy";
import { sendSignalEmail, sendSystemAlertEmail, type SignalEmailInput } from "@/lib/notifications/email";
import type { ServerConfig } from "@/lib/config";

const scanRoute = readFileSync(resolve(process.cwd(), "app/api/scan/route.ts"), "utf8");
const emailRuntime = readFileSync(resolve(process.cwd(), "lib/notifications/email.ts"), "utf8");

beforeEach(() => {
  mocks.createTransport.mockReset();
  mocks.getServerConfig.mockReset();
});

describe("monitoring-only release policy", () => {
  it("freezes monitoring mode and all trading capabilities off", () => {
    expect(RELEASE_MODE).toBe("MONITORING_ONLY");
    expect(ALPHA_RESEARCH_PROGRAM_STATUS).toBe("STOP_NEW_ALPHA_RESEARCH");
    expect(PRODUCTION_SIGNAL_EMAIL_ENABLED).toBe(false);
    expect(PRODUCTION_STRATEGY_PROMOTED).toBe(false);
    expect(AUTOMATIC_TRADING_ENABLED).toBe(false);
    expect(ORDER_PLACEMENT_ENABLED).toBe(false);
  });

  it("blocks a healthy signal email before reading SMTP configuration", async () => {
    mocks.getServerConfig.mockReturnValue({
      GMAIL_SMTP_USER: "alerts@example.com",
      GMAIL_SMTP_APP_PASSWORD: "app-password",
      GMAIL_RECIPIENT: "recipient@example.com",
      CS_DRY_RUN: false,
    });

    await expect(sendSignalEmail(signalInput())).resolves.toEqual({
      skipped: true,
      reason: "RELEASE_POLICY_SIGNAL_EMAIL_DISABLED",
    });
    expect(mocks.getServerConfig).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("keeps the scan admission guard closed even when health would allow production A", () => {
    expect(scanRoute).toContain("PRODUCTION_SIGNAL_EMAIL_ENABLED && hasEmailConfig && productionHealth.productionAAllowed");
    expect(scanRoute).toContain("createPaperTrade");
    expect(scanRoute).toContain("createShadowPaperTrade");
    expect(scanRoute).toContain("persistV55UniverseSnapshot");
  });

  it("does not let an environment variable override the code-level signal policy", () => {
    const releasePolicy = readFileSync(resolve(process.cwd(), "lib/core/release-policy.ts"), "utf8");

    expect(releasePolicy).toContain("PRODUCTION_SIGNAL_EMAIL_ENABLED = false");
    expect(releasePolicy).not.toContain("BCA_SIGNAL_EMAIL_ENABLED");
    expect(emailRuntime).toContain("if (!PRODUCTION_SIGNAL_EMAIL_ENABLED)");
  });

  it("leaves system alert email available independently of signal email", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "system-alert-1" });
    mocks.createTransport.mockReturnValue({ sendMail });

    await expect(sendSystemAlertEmail(nonDryRunSmtpConfig(), {
      component: "release-policy-test",
      message: "system alert path remains available",
    })).resolves.toEqual({ messageId: "system-alert-1", skipped: false });
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("exposes the release policy on the health endpoint without changing existing health fields", async () => {
    const response = getHealth();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "binance-crypto-alerts",
      mode: "alert-only",
      releaseMode: "MONITORING_ONLY",
      alphaResearchProgramStatus: "STOP_NEW_ALPHA_RESEARCH",
      signalEmailEnabled: false,
      productionStrategyPromoted: false,
      automaticTrading: false,
      orderPlacement: false,
      strategy: {
        version: "trend-rejection-short-v1",
        entryMode: "TREND_REJECTION",
      },
      configuration: {
        binancePublicApi: true,
        supabase: false,
        smtp: false,
        dryRun: true,
      },
    });
  });
});

function signalInput(): SignalEmailInput {
  return {
    symbol: "BTCUSDT",
    candidate: {
      strategyFamily: "TREND",
      side: "SHORT",
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h", "4h"],
      entryPrice: 100,
      stopReferencePrice: 101,
      atr: 2,
      scoreComponents: {
        trendAlignment: 0.8,
        momentum: 0.8,
        structure: 0.8,
        liquidity: 0.8,
        volatility: 0.8,
        regimeFit: 0.8,
        dataQuality: 0.8,
      },
      marketRegime: "BEAR",
      regimeDependency: "HIGH",
      rationale: ["unit test"],
      score: 80,
    },
    plan: {
      entryPrice: 100,
      stopPrice: 101,
      takeProfitPrice: 98,
      rewardRisk: 2,
      assumedMarginUsdt: 100,
      assumedLeverage: 20,
      positionNotionalUsdt: 2_000,
      quantity: 20,
      theoreticalRiskUsdt: 40,
      riskOverSingleCap: false,
      validUntil: 1_700_000_000_000,
    },
    strategyVersion: "trend-rejection-short-v1",
    sourceTimestamp: 1_700_000_000_000,
  };
}

function nonDryRunSmtpConfig(): ServerConfig {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    GMAIL_SMTP_HOST: "smtp.example.com",
    GMAIL_SMTP_PORT: 587,
    GMAIL_SMTP_USER: "alerts@example.com",
    GMAIL_SMTP_APP_PASSWORD: "app-password",
    GMAIL_RECIPIENT: "recipient@example.com",
    CS_DRY_RUN: false,
    supabaseServiceKey: "service-key",
    scanTimeframes: ["15m", "1h", "4h"],
  } as ServerConfig;
}
