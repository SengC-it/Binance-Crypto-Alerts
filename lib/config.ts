import { z } from "zod";

const serverEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  BINANCE_API_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  GMAIL_SMTP_HOST: z.string().default("smtp.gmail.com"),
  GMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  GMAIL_SMTP_USER: z.string().email().optional(),
  GMAIL_SMTP_APP_PASSWORD: z.string().min(1).optional(),
  GMAIL_RECIPIENT: z.string().email().optional(),
  CS_DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai"),
  CS_SCAN_TIMEFRAMES: z.string().default("15m,1h,4h"),
  CS_TOP_SYMBOLS: z.coerce.number().int().positive().default(100),
  CS_SCAN_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  CS_MAX_EMAILS_PER_SCAN: z.coerce.number().int().positive().default(6),
  CS_MIN_SIGNAL_SCORE: z.coerce.number().min(0).max(100).default(70),
  CS_SIGNAL_SIDE_FILTER: z.enum(["BOTH", "LONG", "SHORT"]).default("SHORT"),
  CS_SIGNAL_STRATEGY_FAMILY: z.enum(["ALL", "TREND", "BREAKOUT", "MEAN_REVERSION"]).default("TREND"),
  CS_REQUIRE_REGIME_ALIGNMENT: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_STRATEGY_STOP_ATR_MULTIPLIER: z.coerce.number().positive().default(0.5),
  CS_REWARD_RISK: z.coerce.number().positive().default(2),
  CS_RISK_PER_TRADE_USDT: z.coerce.number().positive().default(50),
  CS_MAX_POSITION_NOTIONAL_USDT: z.coerce.number().positive().default(10000),
  CS_MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().max(6).default(1),
  CS_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(8),
  CS_ENTRY_INTERVAL_HOURS: z.coerce.number().nonnegative().default(1),
  CS_MAX_EXECUTION_COST_RISK_FRACTION: z.coerce.number().positive().max(1).default(0.1),
  CS_REQUEST_CONCURRENCY: z.coerce.number().int().positive().default(5),
  CS_MARGIN_USDT: z.coerce.number().positive().default(100),
  CS_PER_SIGNAL_RISK_CAP_USDT: z.coerce.number().positive().default(100),
  CS_DAILY_RISK_BUDGET_USDT: z.coerce.number().positive().default(600),
  CS_ASSUMED_LEVERAGE: z.coerce.number().positive().max(20).default(20),
  CS_NEW_EMAIL_DAILY_CAP: z.coerce.number().int().positive().default(10),
  CS_MAX_HOLD_HOURS: z.coerce.number().positive().default(72),
  CS_INITIAL_PAPER_CAPITAL_USDT: z.coerce.number().positive().default(10000),
  CS_PAPER_TRADING_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_PAPER_TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  CS_PAPER_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(2),
  CS_PAPER_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  CS_SHADOW_TRADING_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_DRY_RUN: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
});

export type ServerConfig = z.infer<typeof serverEnvSchema> & {
  supabaseServiceKey: string;
  scanTimeframes: string[];
};

export function getServerConfig(): ServerConfig {
  const parsed = serverEnvSchema.parse(process.env);
  const supabaseServiceKey = parsed.SUPABASE_SERVICE_ROLE_KEY ?? parsed.SUPABASE_SECRET_KEY;

  if (!supabaseServiceKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY");
  }

  return {
    ...parsed,
    supabaseServiceKey,
    scanTimeframes: parsed.CS_SCAN_TIMEFRAMES.split(",")
      .map((timeframe) => timeframe.trim())
      .filter(Boolean),
  };
}
