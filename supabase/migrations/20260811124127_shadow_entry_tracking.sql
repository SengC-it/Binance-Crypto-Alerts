-- Isolated staging and paper ledger for the validated trend-rejection shadow strategy.
-- Shadow records never participate in production signal, email, risk-budget,
-- cooldown, or position-cap enforcement.

create table public.bca_shadow_candidates (
  scan_group_key text not null references public.bca_scan_groups(scan_group_key) on delete cascade,
  scan_run_id uuid not null references public.bca_scan_runs(id) on delete cascade,
  symbol text not null references public.bca_instruments(symbol) on delete restrict,
  source_data_timestamp timestamptz not null,
  score numeric(8, 4) not null,
  candidate jsonb not null,
  trade_plan jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scan_group_key, symbol)
);

create index bca_shadow_candidates_group_score_idx
  on public.bca_shadow_candidates (scan_group_key, score desc, symbol);
create index bca_shadow_candidates_scan_run_id_idx
  on public.bca_shadow_candidates (scan_run_id);
create index bca_shadow_candidates_symbol_idx
  on public.bca_shadow_candidates (symbol);

create table public.bca_shadow_paper_trades (
  id uuid primary key default gen_random_uuid(),
  symbol text not null references public.bca_instruments(symbol) on delete restrict,
  side text not null check (side in ('LONG', 'SHORT')),
  strategy_family text not null,
  strategy_version text not null,
  entry_time timestamptz not null,
  entry_price numeric(30, 12) not null check (entry_price > 0),
  entry_fill_price numeric(30, 12) not null check (entry_fill_price > 0),
  stop_price numeric(30, 12) not null check (stop_price > 0),
  take_profit_price numeric(30, 12) not null check (take_profit_price > 0),
  max_hold_until timestamptz not null,
  quantity numeric(30, 12) not null check (quantity > 0),
  assumed_margin_usdt numeric(20, 8) not null check (assumed_margin_usdt > 0),
  assumed_leverage numeric(10, 4) not null check (assumed_leverage > 0),
  position_notional_usdt numeric(20, 8) not null check (position_notional_usdt > 0),
  theoretical_risk_usdt numeric(20, 8) not null check (theoretical_risk_usdt >= 0),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'TAKE_PROFIT', 'STOP_LOSS', 'TIME_LIMIT', 'DATA_END', 'CANCELLED', 'ERROR')),
  last_price numeric(30, 12) not null check (last_price > 0),
  last_candle_close_time timestamptz,
  last_checked_at timestamptz not null default now(),
  unrealized_pnl_usdt numeric(20, 8) not null default 0,
  exit_time timestamptz,
  exit_price numeric(30, 12),
  exit_reason text,
  gross_pnl_usdt numeric(20, 8),
  fees_usdt numeric(20, 8) not null default 0,
  funding_usdt numeric(20, 8) not null default 0,
  slippage_usdt numeric(20, 8) not null default 0,
  net_pnl_usdt numeric(20, 8),
  r_multiple numeric(20, 8),
  settlement_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((side = 'LONG' and stop_price < entry_price) or (side = 'SHORT' and stop_price > entry_price)),
  check ((side = 'LONG' and take_profit_price > entry_price) or (side = 'SHORT' and take_profit_price < entry_price)),
  check (status = 'OPEN' or exit_time is not null or status = 'CANCELLED'),
  unique (strategy_version, symbol, side, entry_time)
);

create index bca_shadow_paper_trades_open_hold_idx
  on public.bca_shadow_paper_trades (status, max_hold_until)
  where status = 'OPEN';
create index bca_shadow_paper_trades_symbol_entry_idx
  on public.bca_shadow_paper_trades (symbol, entry_time desc);

create trigger bca_shadow_paper_trades_set_updated_at
before update on public.bca_shadow_paper_trades
for each row execute function public.bca_set_updated_at();

alter table public.bca_shadow_candidates enable row level security;
alter table public.bca_shadow_paper_trades enable row level security;
revoke all on table public.bca_shadow_candidates, public.bca_shadow_paper_trades from anon, authenticated;
grant all on table public.bca_shadow_candidates, public.bca_shadow_paper_trades to service_role;
