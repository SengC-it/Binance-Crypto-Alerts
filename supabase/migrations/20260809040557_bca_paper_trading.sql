-- Paper-trading ledger for the bca signal scanner.
-- This table stores derived results only; raw Binance candles remain local.

create table public.bca_paper_trades (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null unique references public.bca_signals(id) on delete cascade,
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
  check (status = 'OPEN' or exit_time is not null or status = 'CANCELLED')
);

create index bca_paper_trades_open_hold_idx
  on public.bca_paper_trades (status, max_hold_until)
  where status = 'OPEN';

create index bca_paper_trades_symbol_entry_idx
  on public.bca_paper_trades (symbol, entry_time desc);

create trigger bca_paper_trades_set_updated_at
before update on public.bca_paper_trades
for each row execute function public.bca_set_updated_at();

-- A higher-scored signal replaces the previous same-symbol signal. Keep the
-- paper ledger aligned so the old signal cannot remain an open paper position.
create or replace function public.bca_cancel_replaced_paper_trade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'REPLACED' and old.status = 'ACTIVE' then
    update public.bca_paper_trades
    set status = 'CANCELLED',
        exit_reason = 'SIGNAL_REPLACED',
        last_checked_at = now(),
        settlement_error = null,
        updated_at = now()
    where signal_id = new.id and status = 'OPEN';
  end if;
  return new;
end;
$$;

drop trigger if exists bca_signals_cancel_replaced_paper_trade on public.bca_signals;
create trigger bca_signals_cancel_replaced_paper_trade
after update of status on public.bca_signals
for each row execute function public.bca_cancel_replaced_paper_trade();

revoke execute on function public.bca_cancel_replaced_paper_trade() from public, anon, authenticated;
grant execute on function public.bca_cancel_replaced_paper_trade() to service_role;

alter table public.bca_paper_trades enable row level security;
revoke all on table public.bca_paper_trades from anon, authenticated;
grant all on table public.bca_paper_trades to service_role;
