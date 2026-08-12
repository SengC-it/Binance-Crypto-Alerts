import nodemailer from "nodemailer";
import { getServerConfig, type ServerConfig } from "@/lib/config";
import { sideLabel } from "@/lib/core/risk";
import type { ScoredCandidate, TradePlan } from "@/lib/core/types";

export interface SignalEmailInput {
  symbol: string;
  candidate: ScoredCandidate;
  plan: TradePlan;
  strategyVersion: string;
  sourceTimestamp: number;
}

export async function sendSignalEmail(input: SignalEmailInput): Promise<{ messageId?: string; skipped: boolean }> {
  const config = getServerConfig();
  return sendWithConfig(config, {
    subject: `[风险警告] ${input.symbol} ${sideLabel(input.candidate.side)} · ${input.candidate.score.toFixed(1)} 分`,
    text: buildText(input),
    html: buildHtml(input),
  });
}

export async function sendTestEmail(): Promise<{ messageId?: string; skipped: boolean }> {
  const config = getServerConfig();
  const sentAt = new Date().toISOString();
  return sendWithConfig(config, {
    subject: "[BCA 测试] Gmail SMTP 已连接",
    text: [
      "Binance Crypto Alerts 测试邮件发送成功。",
      "",
      `发送时间：${sentAt}`,
      "用途：验证生产环境 Gmail SMTP 通道。",
      "",
      "这不是交易信号，请勿据此进行任何交易。",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:680px;color:#12221d;line-height:1.6">
        <div style="background:#0f766e;color:#fff;padding:16px 18px;border-radius:8px;font-weight:700">BCA Gmail SMTP 测试成功</div>
        <p>Binance Crypto Alerts 已通过生产环境的 Gmail SMTP 通道发送此邮件。</p>
        <p><strong>发送时间：</strong>${escapeHtml(sentAt)}</p>
        <p style="color:#8b1e1e"><strong>这不是交易信号，请勿据此进行任何交易。</strong></p>
      </div>`,
  });
}

export async function sendSystemAlertEmail(
  config: ServerConfig,
  input: { component: string; message: string; scanRunId?: string },
): Promise<{ messageId?: string; skipped: boolean }> {
  const subject = "[严重告警] Crypto Signal Scanner 扫描故障";
  const text = [
    "Crypto Signal Scanner 发生故障，需要人工检查。",
    "",
    `组件：${input.component}`,
    `时间：${new Date().toISOString()}`,
    `扫描批次：${input.scanRunId ?? "未创建"}`,
    `错误：${input.message}`,
    "",
    "如果这是 Supabase 暂停或数据库连接故障，本告警通过独立 Gmail SMTP 旁路发送，不依赖 Supabase 写入。",
  ].join("\n");
  const html = `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:680px;line-height:1.6;color:#12221d">
      <div style="background:#8b1e1e;color:#fff;padding:16px 18px;border-radius:8px;font-weight:700">严重告警：扫描服务发生故障，请暂停依据旧信号操作。</div>
      <p><strong>组件：</strong>${escapeHtml(input.component)}</p>
      <p><strong>时间：</strong>${escapeHtml(new Date().toISOString())}</p>
      <p><strong>扫描批次：</strong>${escapeHtml(input.scanRunId ?? "未创建")}</p>
      <p><strong>错误：</strong>${escapeHtml(input.message)}</p>
      <p>如果这是 Supabase 暂停或数据库连接故障，本告警通过独立 Gmail SMTP 旁路发送，不依赖 Supabase 写入。</p>
    </div>`;
  return sendWithConfig(config, { subject, text, html });
}

async function sendWithConfig(
  config: ServerConfig,
  message: { subject: string; text: string; html: string },
): Promise<{ messageId?: string; skipped: boolean }> {
  const user = config.GMAIL_SMTP_USER;
  const password = config.GMAIL_SMTP_APP_PASSWORD;
  const recipient = config.GMAIL_RECIPIENT;

  if (!user || !password || !recipient) {
    throw new Error("Gmail SMTP configuration is incomplete");
  }

  if (config.CS_DRY_RUN) {
    console.info(`[dry-run] would send email: ${message.subject}`);
    return { skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: config.GMAIL_SMTP_HOST,
    port: config.GMAIL_SMTP_PORT,
    secure: config.GMAIL_SMTP_PORT === 465,
    auth: { user, pass: password.replace(/\s+/g, "") },
  });

  const result = await transporter.sendMail({
    from: `Binance Crypto Alerts <${user}>`,
    to: recipient,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return { messageId: result.messageId, skipped: false };
}

function buildText(input: SignalEmailInput): string {
  const warning = input.plan.riskOverSingleCap
    ? "⚠️ 醒目风险警告：按当前假设计算，本信号止损对应的理论亏损超过单笔风险上限；这不是建议扩大风险。"
    : "⚠️ 风险警告：以下理论亏损按假设保证金、杠杆和止损价估算，不代表实际成交损失上限。";

  return [
    warning,
    "",
    `币种：${input.symbol}`,
    `方向：${sideLabel(input.candidate.side)} (${input.candidate.side})`,
    `主周期：${input.candidate.primaryTimeframe}`,
    `策略：${input.candidate.strategyFamily}`,
    `评分：${input.candidate.score.toFixed(2)} / 100`,
    `市场状态：${input.candidate.marketRegime}；状态依赖：${input.candidate.regimeDependency}`,
    `入场参考价：${input.plan.entryPrice}`,
    `止损价：${input.plan.stopPrice}`,
    `止盈价：${input.plan.takeProfitPrice}（${input.plan.rewardRisk}R）`,
    `假设保证金：${input.plan.assumedMarginUsdt}U`,
    `假设杠杆：${input.plan.assumedLeverage}倍`,
    `理论亏损：${input.plan.theoreticalRiskUsdt.toFixed(4)}U`,
    `评分拆解：${formatScoreComponents(input.candidate)}`,
    `信号有效截止：${new Date(input.plan.validUntil).toLocaleString("zh-CN", { timeZone: configTimeZone() })}`,
    `数据时间：${new Date(input.sourceTimestamp).toLocaleString("zh-CN", { timeZone: configTimeZone() })}`,
    `策略版本：${input.strategyVersion}`,
    "",
    "触发依据：",
    ...input.candidate.rationale.map((reason) => `- ${reason}`),
    "",
    "本系统只发送信号，不自动下单、不跟踪真实账户。请人工核对盘口、滑点、手续费、资金费率、标记价格、强平距离和仓位风险。",
  ].join("\n");
}

function buildHtml(input: SignalEmailInput): string {
  const riskWarning = input.plan.riskOverSingleCap
    ? "background:#8b1e1e;color:#fff;"
    : "background:#fff0d6;color:#7b3f00;";
  const rows = [
    ["币种 / 方向", `${input.symbol} · ${sideLabel(input.candidate.side)}`],
    ["评分", `${input.candidate.score.toFixed(2)} / 100`],
    ["入场参考价", String(input.plan.entryPrice)],
    ["止损价", String(input.plan.stopPrice)],
    ["止盈价", `${input.plan.takeProfitPrice}（${input.plan.rewardRisk}R）`],
    ["理论亏损", `${input.plan.theoreticalRiskUsdt.toFixed(4)}U`],
    ["有效截止", new Date(input.plan.validUntil).toLocaleString("zh-CN", { timeZone: configTimeZone() })],
    ["策略 / 周期", `${input.candidate.strategyFamily} / ${input.candidate.primaryTimeframe}`],
    ["市场状态", `${input.candidate.marketRegime}（依赖 ${input.candidate.regimeDependency}）`],
  ];

  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:680px;color:#12221d;line-height:1.6">
      <div style="${riskWarning}padding:16px 18px;border-radius:8px;font-weight:700">
        ${escapeHtml(input.plan.riskOverSingleCap ? "醒目风险警告：理论止损亏损超过单笔风险上限。" : "风险警告：以下是理论计算，不是盈利保证。")}
      </div>
      <h2>${escapeHtml(input.symbol)} · ${escapeHtml(sideLabel(input.candidate.side))}</h2>
      <table style="border-collapse:collapse;width:100%">
        ${rows.map(([label, value]) => `<tr><td style="border-bottom:1px solid #ddd;padding:8px 4px;color:#61716b">${escapeHtml(label)}</td><td style="border-bottom:1px solid #ddd;padding:8px 4px;font-weight:700">${escapeHtml(value)}</td></tr>`).join("")}
      </table>
      <h3>触发依据</h3>
      <ul>${input.candidate.rationale.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      <p><strong>评分拆解：</strong>${escapeHtml(formatScoreComponents(input.candidate))}</p>
      <p style="color:#7b3f00"><strong>本系统只发送信号，不自动下单、不跟踪真实账户。</strong>请人工核对盘口、滑点、手续费、资金费率、标记价格、强平距离和仓位风险。</p>
      <p style="color:#61716b;font-size:12px">策略版本：${escapeHtml(input.strategyVersion)}；数据时间：${escapeHtml(new Date(input.sourceTimestamp).toISOString())}</p>
    </div>`;
}

function configTimeZone(): string {
  return process.env.CS_DEFAULT_TIMEZONE ?? "Asia/Shanghai";
}

function formatScoreComponents(candidate: ScoredCandidate): string {
  return Object.entries(candidate.scoreComponents)
    .map(([key, value]) => `${key}=${(value * 100).toFixed(0)}`)
    .join(" · ");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
