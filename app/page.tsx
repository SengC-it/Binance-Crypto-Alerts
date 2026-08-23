import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface Signal {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy_family: string;
  primary_timeframe: string;
  score: number;
  score_components: Record<string, number>;
  market_regime: string;
  entry_price: number;
  stop_price: number;
  take_profit_price: number;
  reward_risk: number;
  assumed_leverage: number;
  theoretical_risk_usdt: number;
  risk_over_single_cap: boolean;
  valid_until: string;
  created_at: string;
  signal_tier?: string | null;
  policy_version?: string | null;
  market_state?: string | null;
  setup_type?: string | null;
  entry_trigger?: string | null;
  expected_net_r?: number | null;
  confidence?: number | null;
  calibration_samples?: number | null;
  rejection_reason?: string | null;
}

interface ScanRun {
  id: string;
  scan_group_key: string;
  universe_size: number;
  scanned_symbols: number;
  candidate_count: number;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  error_summary: unknown[];
  started_at: string;
  finished_at: string | null;
}

interface PaperTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  status: string;
  net_pnl_usdt: number | null;
  r_multiple: number | null;
  exit_time: string | null;
}

interface SignalSummaryRow {
  score: number;
  status: string;
  signal_tier?: string | null;
  policy_version?: string | null;
  rejection_reason?: string | null;
}

interface ShadowCandidateRow {
  symbol: string;
  score: number;
  candidate: {
    side?: string;
    marketState?: string;
    setupType?: string;
    entryTrigger?: string;
    admission?: {
      tier?: string;
      reasons?: string[];
      policyVersion?: string;
      expectedNetR?: number | null;
    };
  };
}

interface SettledTradeSummaryRow {
  assumed_margin_usdt: number | null;
  net_pnl_usdt: number | null;
  exit_time: string | null;
}

interface DashboardData {
  signals: Signal[];
  scanRuns: ScanRun[];
  paperTrades: PaperTrade[];
  signalSummaryRows: SignalSummaryRow[];
  shadowCandidates: ShadowCandidateRow[];
  settledTradeSummaryRows: SettledTradeSummaryRow[];
  databaseAvailable: boolean;
}

const scoreLabels: Record<string, string> = {
  trend: "趋势结构",
  momentum: "动量确认",
  quality: "信号质量",
  liquidity: "流动性",
  regime: "市场状态",
  expected_edge: "成本后优势",
  regimeFit: "市场匹配",
  structure: "结构质量",
  volatility: "波动质量",
};

export default async function HomePage() {
  const { signals, scanRuns, paperTrades, signalSummaryRows, shadowCandidates, settledTradeSummaryRows, databaseAvailable } = await getDashboardData();
  const selected = signals[0] ?? null;
  const latestGroup = scanRuns[0]?.scan_group_key;
  const latestRuns = latestGroup ? scanRuns.filter((run) => run.scan_group_key === latestGroup) : [];
  const scanSummary = summarizeScans(latestRuns);
  const signalSummary = summarizeSignals(signalSummaryRows, shadowCandidates);
  const tradeSummary = summarizeTrades(settledTradeSummaryRows);
  const healthy = databaseAvailable && scanSummary.status !== "FAILED";

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">BCA</span>
          <div>
            <strong>Binance Crypto Alerts</strong>
            <span>机会雷达 · 仅信号辅助</span>
          </div>
        </div>
        <span className="nav-section">机会雷达</span>
        <div className="topbar-meta">
          <a href="/api/health" className={`health-state ${healthy ? "is-healthy" : "is-warning"}`}>
            <span className="health-dot" />
            {healthy ? "系统运行正常" : "系统需要检查"}
          </a>
          <time>{formatFullDate(new Date())}</time>
        </div>
      </header>

      <section className="summary-panel" aria-label="汇总数据">
        <div className="summary-heading">
          <div>
            <p className="section-kicker">PERFORMANCE SUMMARY</p>
            <h1>策略汇总</h1>
          </div>
          <span>提醒统计全量记录 · 收益统计已结算纸上交易</span>
        </div>
        <div className="summary-grid">
          <div className="summary-card">
            <span>提醒总数</span>
            <strong>{signalSummary.totalSignals}</strong>
            <small>当前有效 {signalSummary.activeSignals} 条</small>
          </div>
          <div className="summary-card">
            <span>平均评分</span>
            <strong>{signalSummary.averageScore.toFixed(1)}</strong>
            <small>满分 100</small>
          </div>
          <div className="summary-card">
            <span>最大回撤</span>
            <strong className={tradeSummary.maxDrawdownUsdt > 0 ? "loss" : "profit"}>
              {formatDrawdown(tradeSummary.maxDrawdownUsdt)} U
            </strong>
            <small>{tradeSummary.maxDrawdownPercent.toFixed(2)}% · 按纸上保证金估算</small>
          </div>
          <div className="summary-card">
            <span>胜率</span>
            <strong>{tradeSummary.winRate.toFixed(1)}%</strong>
            <small>{tradeSummary.wins} 胜 / {tradeSummary.losses} 负</small>
          </div>
          <div className="summary-card">
            <span>净收益</span>
            <strong className={tradeSummary.netPnlUsdt >= 0 ? "profit" : "loss"}>
              {formatSigned(tradeSummary.netPnlUsdt)} U
            </strong>
            <small>{tradeSummary.settledTrades} 笔已结算</small>
          </div>
          <div className="summary-card">
            <span>平均每笔</span>
            <strong className={tradeSummary.averagePnlUsdt >= 0 ? "profit" : "loss"}>
              {formatSigned(tradeSummary.averagePnlUsdt)} U
            </strong>
            <small>盈亏因子 {tradeSummary.profitFactorLabel}</small>
          </div>
          <div className="summary-card">
            <span>V5 分层</span>
            <strong>A {signalSummary.tierA}</strong>
            <small>Watch B {signalSummary.tierB} · Reject C {signalSummary.tierC}</small>
          </div>
        </div>
      </section>

      <div className="dashboard-grid">
        <div className="main-column">
          <section className="panel radar-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">SCAN STATUS</p>
                <h2>本轮扫描 · {scanSummary.scanned}/{scanSummary.universe || 100}</h2>
              </div>
              <div className="scan-header-status">
                <span>{formatRelativeTime(scanSummary.finishedAt)}</span>
                <strong className={`status-label status-${scanSummary.status.toLowerCase()}`}>
                  {formatScanStatus(scanSummary.status)}
                </strong>
              </div>
            </div>

            <div className="scan-overview">
              <div className="scan-progress-copy">
                <strong>{scanSummary.scanned}</strong>
                <span>/ {scanSummary.universe || 100} 个交易对</span>
              </div>
              <div className="progress-track" aria-label={`已扫描 ${scanSummary.progress}%`}>
                <span style={{ width: `${scanSummary.progress}%` }} />
              </div>
              <dl className="scan-stats">
                <div><dt>候选机会</dt><dd>{scanSummary.candidates}</dd></div>
                <div><dt>运行批次</dt><dd>{latestRuns.length || 0}</dd></div>
                <div><dt>扫描异常</dt><dd>{scanSummary.errors}</dd></div>
              </dl>
            </div>

            <div className="opportunity-header">
              <div>
                <p className="section-kicker">TOP OPPORTUNITIES</p>
                <h2>最高评分机会</h2>
              </div>
              <span>当前有效 {signalSummary.activeSignals} 条 · 展示前 {signals.length} 条</span>
            </div>

            {signals.length === 0 ? (
              <div className="radar-empty">
                <div className="radar-rings" aria-hidden="true"><span /></div>
                <strong>当前没有达到阈值的机会</strong>
                <p>市场保持安静。系统会在下一轮继续扫描，不会为了增加数量而降低信号标准。</p>
              </div>
            ) : (
              <div className="opportunity-table">
                <div className="table-row table-head">
                  <span>合约 / 方向</span><span>周期</span><span>评分</span><span>入场参考</span><span>有效至</span>
                </div>
                {signals.map((signal) => (
                  <div className={`table-row ${signal.id === selected?.id ? "is-selected" : ""}`} key={signal.id}>
                    <span className="symbol-cell"><strong>{signal.symbol}</strong><em className={signal.side.toLowerCase()}>{signal.side}</em></span>
                    <span>{signal.primary_timeframe}</span>
                    <span className="score-cell">{Number(signal.score).toFixed(1)}</span>
                    <span>{formatPrice(signal.entry_price)}</span>
                    <span>{formatShortTime(signal.valid_until)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="opportunity-header">
              <div>
                <p className="section-kicker">V5 SHADOW / WATCH</p>
                <h2>V5 观察与拒绝原因</h2>
              </div>
              <span>不产生生产告警 · 仅用于校准与人工复核</span>
            </div>
            {shadowCandidates.length === 0 ? (
              <p className="inline-empty">本轮暂无 V5 影子候选。</p>
            ) : (
              <div className="opportunity-table">
                <div className="table-row table-head">
                  <span>合约 / 方向</span><span>层级</span><span>状态</span><span>触发</span><span>拒绝原因</span>
                </div>
                {shadowCandidates.slice(0, 8).map((item, index) => (
                  <div className="table-row" key={`${item.symbol}-${item.candidate.admission?.policyVersion ?? "v5"}-${index}`}>
                    <span className="symbol-cell"><strong>{item.symbol}</strong><em className={(item.candidate.side ?? "").toLowerCase()}>{item.candidate.side ?? "—"}</em></span>
                    <span>{item.candidate.admission?.tier ?? "—"}</span>
                    <span>{item.candidate.marketState ?? "UNKNOWN"}</span>
                    <span>{item.candidate.entryTrigger ?? item.candidate.setupType ?? "—"}</span>
                    <span>{item.candidate.admission?.reasons?.join(", ") ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel history-panel">
            <div className="panel-header compact">
              <div>
                <p className="section-kicker">PAPER SETTLEMENT</p>
                <h2>最近纸上交易结果</h2>
              </div>
              <span>仅用于验证策略，不代表真实收益</span>
            </div>
            {paperTrades.length === 0 ? (
              <p className="inline-empty">暂无已结算记录。</p>
            ) : (
              <div className="trade-list">
                {paperTrades.map((trade) => (
                  <article key={trade.id}>
                    <div><strong>{trade.symbol}</strong><span className={trade.side.toLowerCase()}>{trade.side}</span></div>
                    <span>{formatTradeStatus(trade.status)}</span>
                    <strong className={Number(trade.net_pnl_usdt) >= 0 ? "profit" : "loss"}>
                      {formatSigned(trade.net_pnl_usdt)} U
                    </strong>
                    <span>{formatShortDate(trade.exit_time)}</span>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="side-column">
          <section className="panel detail-panel">
            <div className="panel-header compact">
              <div>
                <p className="section-kicker">SIGNAL DETAIL</p>
                <h2>信号详情</h2>
              </div>
              {selected ? <span className={`direction-badge ${selected.side.toLowerCase()}`}>{selected.side}</span> : null}
            </div>

            {selected ? (
              <div className="signal-detail">
                <div className="detail-title">
                  <div><strong>{selected.symbol}</strong><span>{selected.strategy_family} · {selected.policy_version ?? "CONTROL"}</span></div>
                  <div className="score-orb"><strong>{Number(selected.score).toFixed(0)}</strong><span>评分</span></div>
                </div>
                <dl className="price-grid">
                  <div><dt>入场参考</dt><dd>{formatPrice(selected.entry_price)}</dd></div>
                  <div><dt>止损价格</dt><dd>{formatPrice(selected.stop_price)}</dd></div>
                  <div><dt>止盈价格</dt><dd>{formatPrice(selected.take_profit_price)}</dd></div>
                  <div><dt>盈亏比</dt><dd>{Number(selected.reward_risk).toFixed(2)}R</dd></div>
                </dl>
                <div className="factor-block">
                  <div className="factor-heading"><strong>评分因子</strong><span>{selected.market_regime}</span></div>
                  {normalizeFactors(selected.score_components, selected.score).map((factor) => (
                    <div className="factor-row" key={factor.name}>
                      <span>{factor.label}</span>
                      <div><i style={{ width: `${factor.value}%` }} /></div>
                      <strong>{factor.value.toFixed(0)}</strong>
                    </div>
                  ))}
                </div>
                <dl className="risk-metrics">
                  <div><dt>市场状态 / 结构</dt><dd>{selected.market_state ?? selected.market_regime} · {selected.setup_type ?? "—"}</dd></div>
                  <div><dt>入场触发</dt><dd>{selected.entry_trigger ?? "—"}</dd></div>
                  <div><dt>假设杠杆</dt><dd>{Number(selected.assumed_leverage).toFixed(0)}×</dd></div>
                  <div><dt>理论最大亏损</dt><dd className={selected.risk_over_single_cap ? "loss" : ""}>{formatPrice(selected.theoretical_risk_usdt)} U</dd></div>
                  <div><dt>信号有效至</dt><dd>{formatDateTime(selected.valid_until)}</dd></div>
                </dl>
              </div>
            ) : (
              <div className="detail-empty">
                <span>NO ACTIVE SIGNAL</span>
                <strong>等待高质量机会</strong>
                <p>只有通过评分、市场状态与风险预算校验的信号才会出现在这里。</p>
              </div>
            )}
          </section>

          <section className="risk-warning" aria-label="重要风险提示">
            <p className="section-kicker">RISK WARNING</p>
            <h2>重要风险提示</h2>
            <p>本系统只提供规则信号与理论价格，不连接 Binance 账户，也不会自动下单。</p>
            <ul>
              <li>每笔按 100 U 保证金进行理论风险估算</li>
              <li>杠杆上限 20× 不代表建议使用 20×</li>
              <li>历史回测与纸上收益不保证未来盈利</li>
            </ul>
            <strong>请人工复核，并自行承担全部交易风险。</strong>
          </section>
        </aside>
      </div>

      <footer>
        <span>BCA · Alert-only / Manual execution</span>
        <span>数据源 Binance 公共行情 · 结果存储 bca_* 表</span>
      </footer>
    </main>
  );
}

async function getDashboardData(): Promise<DashboardData> {
  try {
    const supabase = getSupabaseAdmin();
    const [signalsResult, scansResult, tradesResult, signalSummaryResult, shadowCandidatesResult, settledTradeSummaryResult] = await withTimeout(Promise.all([
      supabase
        .from("bca_signals")
        .select("id,symbol,side,strategy_family,primary_timeframe,score,score_components,market_regime,entry_price,stop_price,take_profit_price,reward_risk,assumed_leverage,theoretical_risk_usdt,risk_over_single_cap,valid_until,created_at,signal_tier,policy_version,market_state,setup_type,entry_trigger,expected_net_r,confidence,calibration_samples,rejection_reason")
        .eq("status", "ACTIVE")
        .order("score", { ascending: false })
        .limit(6),
      supabase
        .from("bca_scan_runs")
        .select("id,scan_group_key,universe_size,scanned_symbols,candidate_count,status,error_summary,started_at,finished_at")
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("bca_paper_trades")
        .select("id,symbol,side,status,net_pnl_usdt,r_multiple,exit_time")
        .neq("status", "OPEN")
        .order("exit_time", { ascending: false })
        .limit(5),
      supabase
        .from("bca_signals")
        .select("score,status,signal_tier,policy_version,rejection_reason"),
      supabase
        .from("bca_shadow_candidates")
        .select("symbol,score,candidate")
        .order("created_at", { ascending: false })
        .limit(24),
      supabase
        .from("bca_paper_trades")
        .select("assumed_margin_usdt,net_pnl_usdt,exit_time")
        .neq("status", "OPEN")
        .not("net_pnl_usdt", "is", null)
        .order("exit_time", { ascending: true }),
    ]), 8_000);

    const error = signalsResult.error ?? scansResult.error ?? tradesResult.error ?? signalSummaryResult.error ?? shadowCandidatesResult.error ?? settledTradeSummaryResult.error;
    if (error) throw error;

    return {
      signals: (signalsResult.data ?? []) as Signal[],
      scanRuns: (scansResult.data ?? []) as ScanRun[],
      paperTrades: (tradesResult.data ?? []) as PaperTrade[],
      signalSummaryRows: (signalSummaryResult.data ?? []) as SignalSummaryRow[],
      shadowCandidates: (shadowCandidatesResult.data ?? []) as ShadowCandidateRow[],
      settledTradeSummaryRows: (settledTradeSummaryResult.data ?? []) as SettledTradeSummaryRow[],
      databaseAvailable: true,
    };
  } catch (error) {
    console.warn("Dashboard data is unavailable until Supabase is configured.", error);
    return {
      signals: [],
      scanRuns: [],
      paperTrades: [],
      signalSummaryRows: [],
      shadowCandidates: [],
      settledTradeSummaryRows: [],
      databaseAvailable: false,
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Dashboard data request timed out.")), milliseconds);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function summarizeScans(runs: ScanRun[]) {
  const scanned = runs.reduce((sum, run) => sum + Number(run.scanned_symbols), 0);
  const marketUniverse = Math.max(0, ...runs.map((run) => Number(run.universe_size)));
  const configuredTarget = Number(process.env.CS_TOP_SYMBOLS ?? 100);
  const universe = marketUniverse > 0 ? Math.min(marketUniverse, configuredTarget) : configuredTarget;
  const candidates = runs.reduce((sum, run) => sum + Number(run.candidate_count), 0);
  const errors = runs.reduce((sum, run) => sum + (Array.isArray(run.error_summary) ? run.error_summary.length : 0), 0);
  const status = runs.some((run) => run.status === "FAILED")
    ? "FAILED"
    : runs.some((run) => run.status === "PARTIAL")
      ? "PARTIAL"
      : runs.some((run) => run.status === "RUNNING")
        ? "RUNNING"
        : runs.length > 0
          ? "COMPLETED"
          : "PARTIAL";

  return {
    scanned,
    universe,
    candidates,
    errors,
    status,
    progress: universe > 0 ? Math.min(100, Math.round((scanned / universe) * 100)) : 0,
    finishedAt: runs.find((run) => run.finished_at)?.finished_at ?? runs[0]?.started_at ?? null,
  };
}

function summarizeSignals(rows: SignalSummaryRow[], shadowCandidates: ShadowCandidateRow[]) {
  const scores = rows.map((row) => Number(row.score)).filter(Number.isFinite);
  const shadowTiers = shadowCandidates.map((row) => row.candidate.admission?.tier);
  return {
    totalSignals: rows.length,
    activeSignals: rows.filter((row) => row.status === "ACTIVE").length,
    averageScore: scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    tierA: rows.filter((row) => row.signal_tier === "A").length + shadowTiers.filter((tier) => tier === "A").length,
    tierB: rows.filter((row) => row.signal_tier === "B").length + shadowTiers.filter((tier) => tier === "B").length,
    tierC: rows.filter((row) => row.signal_tier === "C").length + shadowTiers.filter((tier) => tier === "C").length,
  };
}

function summarizeTrades(rows: SettledTradeSummaryRow[]) {
  const trades = rows
    .filter((row) => row.net_pnl_usdt !== null)
    .map((row) => ({
      assumedMarginUsdt: row.assumed_margin_usdt === null ? 0 : Number(row.assumed_margin_usdt),
      netPnlUsdt: Number(row.net_pnl_usdt),
      exitTime: row.exit_time ? new Date(row.exit_time).getTime() : Number.POSITIVE_INFINITY,
    }))
    .filter((trade) => Number.isFinite(trade.assumedMarginUsdt) && Number.isFinite(trade.netPnlUsdt))
    .sort((left, right) => left.exitTime - right.exitTime);
  const netPnlUsdt = trades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const wins = trades.filter((trade) => trade.netPnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.netPnlUsdt < 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + (trade.netPnlUsdt > 0 ? trade.netPnlUsdt : 0), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + (trade.netPnlUsdt < 0 ? trade.netPnlUsdt : 0), 0));
  const initialCapitalUsdt = Math.max(0, ...trades.map((trade) => trade.assumedMarginUsdt));
  let equity = initialCapitalUsdt;
  let peakEquity = initialCapitalUsdt;
  let maxDrawdownUsdt = 0;

  for (const trade of trades) {
    equity += trade.netPnlUsdt;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peakEquity - equity);
  }

  return {
    settledTrades: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : wins / trades.length * 100,
    netPnlUsdt,
    averagePnlUsdt: trades.length === 0 ? 0 : netPnlUsdt / trades.length,
    profitFactorLabel: grossLoss === 0 ? (grossProfit > 0 ? "∞" : "—") : (grossProfit / grossLoss).toFixed(2),
    maxDrawdownUsdt,
    maxDrawdownPercent: peakEquity === 0 ? 0 : maxDrawdownUsdt / peakEquity * 100,
  };
}

function formatDrawdown(value: number): string {
  return value > 0 ? formatSigned(-value) : "0.00";
}

function normalizeFactors(components: Record<string, number> | null, fallback: number) {
  const entries = Object.entries(components ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  if (entries.length === 0) return [{ name: "overall", label: "综合质量", value: clampScore(fallback) }];

  return entries.slice(0, 5).map(([name, rawValue]) => ({
    name,
    label: scoreLabels[name] ?? name.replaceAll("_", " "),
    value: clampScore(rawValue <= 1 ? rawValue * 100 : rawValue),
  }));
}

function clampScore(value: number) {
  return Math.min(100, Math.max(0, Number(value)));
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", { maximumSignificantDigits: 8 });
}

function formatSigned(value: number | null): string {
  if (value === null) return "—";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function formatFullDate(value: Date): string {
  return value.toLocaleDateString("zh-CN", { timeZone: defaultTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatShortDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: defaultTimeZone(), month: "2-digit", day: "2-digit" });
}

function formatShortTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { timeZone: defaultTimeZone(), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { timeZone: defaultTimeZone(), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "尚无记录";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚完成";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatScanStatus(status: string): string {
  return ({ COMPLETED: "扫描完成", RUNNING: "扫描中", PARTIAL: "部分完成", FAILED: "扫描失败" })[status] ?? status;
}

function formatTradeStatus(status: string): string {
  return ({ TAKE_PROFIT: "止盈", STOP_LOSS: "止损", TIME_LIMIT: "到期", DATA_END: "数据结束", CANCELLED: "已取消", ERROR: "异常" })[status] ?? status;
}

function defaultTimeZone(): string {
  return process.env.CS_DEFAULT_TIMEZONE ?? "Asia/Shanghai";
}
