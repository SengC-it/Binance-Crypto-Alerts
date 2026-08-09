import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const boundaries = [
  "只读取 Binance 公共行情，不接入账户密钥。",
  "只生成信号和理论止盈止损，不自动下单。",
  "每笔假设保证金和杠杆只用于理论风险估算。",
  "邮件中的任何机会都必须人工确认并自行承担风险。",
];

interface RecentSignal {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy_family: string;
  primary_timeframe: string;
  score: number;
  market_regime: string;
  entry_price: number;
  stop_price: number;
  take_profit_price: number;
  reward_risk: number;
  status: string;
  valid_until: string;
  created_at: string;
}

export default async function HomePage() {
  const signals = await getRecentSignals();

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">CRYPTO SIGNAL SCANNER · MVP</p>
        <h1>合约机会扫描与风险提示</h1>
        <p className="lede">
          面向 Binance USDT-M 永续合约的规则扫描、可解释评分、理论止盈止损和 Gmail 提醒。
        </p>
        <div className="status-pill">
          <span className="status-dot" />
          Alert-only / manual execution
        </div>
      </section>

      <section className="card-grid" aria-label="系统边界">
        {boundaries.map((boundary) => (
          <article className="info-card" key={boundary}>
            <span className="card-mark">✓</span>
            <p>{boundary}</p>
          </article>
        ))}
      </section>

      <section className="signal-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">RECENT SIGNALS</p>
            <h2>最近的候选信号</h2>
          </div>
          <span className="panel-count">{signals.length} 条</span>
        </div>

        {signals.length === 0 ? (
          <div className="empty-state">
            <p>暂时没有已保存的信号。</p>
            <p>先完成 Supabase 配置，再用带有 CRON_SECRET 的请求调用 `/api/scan?batch=0`。</p>
          </div>
        ) : (
          <div className="signal-list">
            {signals.map((signal) => (
              <article className="signal-row" key={signal.id}>
                <div className="signal-main">
                  <div className="signal-title">
                    <strong>{signal.symbol}</strong>
                    <span className={`side-badge ${signal.side.toLowerCase()}`}>{signal.side}</span>
                    <span className="muted-label">{signal.strategy_family}</span>
                  </div>
                  <p>
                    {signal.primary_timeframe} · {signal.market_regime} · {formatDate(signal.created_at)}
                  </p>
                </div>
                <div className="signal-score">
                  <strong>{Number(signal.score).toFixed(1)}</strong>
                  <span>评分</span>
                </div>
                <div className="signal-prices">
                  <span>入场 {formatPrice(signal.entry_price)}</span>
                  <span>止损 {formatPrice(signal.stop_price)}</span>
                  <span>止盈 {formatPrice(signal.take_profit_price)} · {Number(signal.reward_risk).toFixed(1)}R</span>
                </div>
                <span className={`signal-status ${signal.status.toLowerCase()}`}>{signal.status}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="next-step">
        <div>
          <p className="eyebrow">RUN</p>
          <h2>手动触发一批扫描</h2>
          <p>
            扫描接口默认按 25 个交易对分批运行。生产环境用 Supabase Cron 调度，开发阶段可以参考项目 README 的 PowerShell 命令。
          </p>
        </div>
        <a href="/api/health" className="outline-button">
          查看健康检查
        </a>
      </section>
    </main>
  );
}

async function getRecentSignals(): Promise<RecentSignal[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("bca_signals")
      .select("id,symbol,side,strategy_family,primary_timeframe,score,market_regime,entry_price,stop_price,take_profit_price,reward_risk,status,valid_until,created_at")
      .order("created_at", { ascending: false })
      .limit(8);

    if (error) throw error;
    return (data ?? []) as RecentSignal[];
  } catch (error) {
    console.warn("Recent signals are unavailable until Supabase is configured.", error);
    return [];
  }
}

function formatPrice(value: number): string {
  return Number(value).toLocaleString("en-US", { maximumSignificantDigits: 8 });
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: process.env.CS_DEFAULT_TIMEZONE ?? "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
