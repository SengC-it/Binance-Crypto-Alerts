-- Crypto Signal Scanner isolated schema objects.
-- This migration intentionally creates only cs_* objects in public.

create extension if not exists pgcrypto with schema extensions;

create table public.cs_strategy_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  strategy_family text not null,
  parameters jsonb not null default '{}'::jsonb,
  training_start_date date,
  training_end_date date,
  validation_start_date date,
  validation_end_date date,
  oos_start_date date,
  oos_end_date date,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz not null default now()
);

create table public.cs_instruments (
  symbol text primary key,
  base_asset text not null,
  quote_asset text not null default 'USDT',
  contract_type text not null default 'PERPETUAL',
  exchange_status text not null default 'TRADING',
  price_tick numeric not null,
  quantity_step numeric not null,
  min_quantity numeric,
  max_leverage numeric,
  quote_volume_24h numeric,
  universe_rank integer,
  exchange_filters jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cs_scan_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  scan_group_key text not null,
  timeframe text not null,
  batch_number integer not null default 0 check (batch_number >= 0),
  batch_count integer not null default 1 check (batch_count > 0),
  universe_size integer not null default 0 check (universe_size >= 0),
  scanned_symbols integer not null default 0 check (scanned_symbols >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  emailed_count integer not null default 0 check (emailed_count >= 0),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  error_summary jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.cs_signals (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid references public.cs_scan_runs(id) on delete set null,
  signal_key text not null unique,
  symbol text not null references public.cs_instruments(symbol) on delete restrict,
  side text not null check (side in ('LONG', 'SHORT')),
  primary_timeframe text not null,
  confirmation_timeframes text[] not null default '{}',
  strategy_family text not null,
  strategy_version text not null,
  score numeric(6, 3) not null check (score >= 0 and score <= 100),
  score_components jsonb not null default '{}'::jsonb,
  market_regime text not null default 'UNKNOWN',
  regime_dependency text not null default 'UNKNOWN',
  entry_price numeric not null check (entry_price > 0),
  stop_price numeric not null check (stop_price > 0),
  take_profit_price numeric not null check (take_profit_price > 0),
  reward_risk numeric(8, 3) not null default 2 check (reward_risk > 0),
  assumed_margin_usdt numeric(20, 8) not null default 100 check (assumed_margin_usdt > 0),
  assumed_leverage numeric(10, 4) not null default 20 check (assumed_leverage > 0),
  position_notional_usdt numeric(20, 8) not null check (position_notional_usdt > 0),
  theoretical_risk_usdt numeric(20, 8) not null check (theoretical_risk_usdt >= 0),
  risk_over_single_cap boolean not null default false,
  risk_budget_blocked boolean not null default false,
  scan_group_key text not null,
  email_reserved boolean not null default false,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REPLACED', 'BUDGET_BLOCKED', 'MANUALLY_CLOSED')),
  valid_until timestamptz not null,
  source_data_timestamp timestamptz not null,
  occurrence_date date not null,
  replaced_by uuid references public.cs_signals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (side = 'SHORT' or stop_price < entry_price),
  check (side = 'LONG' or stop_price > entry_price),
  check (side = 'SHORT' or take_profit_price > entry_price),
  check (side = 'LONG' or take_profit_price < entry_price)
);

create table public.cs_signal_events (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.cs_signals(id) on delete cascade,
  event_type text not null check (event_type in ('CREATED', 'REPLACED', 'EMAIL_QUEUED', 'EMAIL_SENT', 'EMAIL_FAILED', 'BUDGET_BLOCKED', 'ERROR')),
  payload jsonb not null default '{}'::jsonb,
  event_at timestamptz not null default now()
);

create table public.cs_risk_budgets (
  budget_date date primary key,
  daily_limit_usdt numeric(20, 8) not null default 600 check (daily_limit_usdt > 0),
  reserved_risk_usdt numeric(20, 8) not null default 0 check (reserved_risk_usdt >= 0),
  new_signal_count integer not null default 0 check (new_signal_count >= 0),
  new_email_count integer not null default 0 check (new_email_count >= 0),
  updated_at timestamptz not null default now()
);

create table public.cs_notifications (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.cs_signals(id) on delete set null,
  idempotency_key text not null unique,
  channel text not null default 'GMAIL_SMTP' check (channel in ('GMAIL_SMTP')),
  recipient text not null,
  subject text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  provider_message_id text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cs_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_version text not null,
  universe_definition jsonb not null default '{}'::jsonb,
  parameter_set jsonb not null default '{}'::jsonb,
  train_window jsonb not null default '{}'::jsonb,
  validation_window jsonb not null default '{}'::jsonb,
  out_of_sample_window jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.cs_system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('SCAN_STARTED', 'SCAN_COMPLETED', 'SCAN_ERROR', 'DATA_SOURCE_ERROR', 'DATABASE_ERROR', 'EMAIL_ERROR', 'CONFIG_ERROR', 'WARNING')),
  severity text not null default 'INFO' check (severity in ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
  component text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table public.cs_app_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  description text,
  updated_at timestamptz not null default now()
);

create unique index cs_signals_one_active_per_symbol_idx
  on public.cs_signals (symbol)
  where status = 'ACTIVE';

create index cs_signals_created_at_idx on public.cs_signals (created_at desc);
create index cs_signals_occurrence_date_idx on public.cs_signals (occurrence_date desc, score desc);
create index cs_signals_status_idx on public.cs_signals (status, symbol);
create index cs_signal_events_signal_id_idx on public.cs_signal_events (signal_id, event_at desc);
create index cs_notifications_status_idx on public.cs_notifications (status, created_at desc);
create index cs_system_events_occurred_at_idx on public.cs_system_events (occurred_at desc);

create or replace function public.cs_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cs_instruments_set_updated_at
before update on public.cs_instruments
for each row execute function public.cs_set_updated_at();

create trigger cs_signals_set_updated_at
before update on public.cs_signals
for each row execute function public.cs_set_updated_at();

create trigger cs_notifications_set_updated_at
before update on public.cs_notifications
for each row execute function public.cs_set_updated_at();

create trigger cs_risk_budgets_set_updated_at
before update on public.cs_risk_budgets
for each row execute function public.cs_set_updated_at();

create trigger cs_app_settings_set_updated_at
before update on public.cs_app_settings
for each row execute function public.cs_set_updated_at();

-- Atomic same-symbol replacement and daily theoretical-risk reservation.
-- The API calls this function through the server-only Supabase service key.
create or replace function public.cs_claim_signal(
  p_signal jsonb,
  p_budget_date date,
  p_daily_limit_usdt numeric,
  p_single_risk_cap_usdt numeric,
  p_daily_email_cap integer,
  p_should_email boolean,
  p_scan_group_key text,
  p_scan_email_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal_id uuid;
  v_existing_id uuid;
  v_existing_score numeric;
  v_existing_risk numeric := 0;
  v_new_score numeric;
  v_new_risk numeric;
  v_delta numeric;
  v_budget public.cs_risk_budgets%rowtype;
  v_email_allowed boolean := false;
  v_is_new_opportunity boolean := false;
  v_confirmation_timeframes text[] := '{}';
  v_scan_email_count integer := 0;
begin
  v_signal_id := coalesce(nullif(p_signal->>'id', '')::uuid, gen_random_uuid());
  v_new_score := (p_signal->>'score')::numeric;
  v_new_risk := (p_signal->>'theoretical_risk_usdt')::numeric;

  select id into v_existing_id
  from public.cs_signals
  where signal_key = p_signal->>'signal_key'
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object('status', 'IDEMPOTENT', 'signal_id', v_existing_id, 'email_allowed', false);
  end if;

  select id, score, theoretical_risk_usdt
    into v_existing_id, v_existing_score, v_existing_risk
  from public.cs_signals
  where symbol = p_signal->>'symbol' and status = 'ACTIVE'
  for update;

  if v_existing_id is not null and v_new_score <= v_existing_score then
    return jsonb_build_object(
      'status', 'REJECTED_LOWER_SCORE',
      'signal_id', v_existing_id,
      'email_allowed', false
    );
  end if;

  v_is_new_opportunity := v_existing_id is null;
  v_delta := greatest(v_new_risk - coalesce(v_existing_risk, 0), 0);

  insert into public.cs_risk_budgets (budget_date, daily_limit_usdt)
  values (p_budget_date, p_daily_limit_usdt)
  on conflict (budget_date) do nothing;

  select * into v_budget
  from public.cs_risk_budgets
  where budget_date = p_budget_date
  for update;

  if v_budget.reserved_risk_usdt + v_delta > v_budget.daily_limit_usdt then
    if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
      select array_agg(value) into v_confirmation_timeframes
      from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
    end if;

    insert into public.cs_signals (
      id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
      confirmation_timeframes, strategy_family, strategy_version, score,
      score_components, market_regime, regime_dependency, entry_price,
      stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
      assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
      risk_over_single_cap, risk_budget_blocked, status, valid_until,
      source_data_timestamp, occurrence_date
    )
    values (
      v_signal_id,
      nullif(p_signal->>'scan_run_id', '')::uuid,
      p_signal->>'signal_key',
      p_signal->>'symbol',
      p_scan_group_key,
      p_signal->>'side',
      p_signal->>'primary_timeframe',
      coalesce(v_confirmation_timeframes, '{}'),
      p_signal->>'strategy_family',
      p_signal->>'strategy_version',
      v_new_score,
      coalesce(p_signal->'score_components', '{}'::jsonb),
      coalesce(p_signal->>'market_regime', 'UNKNOWN'),
      coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
      (p_signal->>'entry_price')::numeric,
      (p_signal->>'stop_price')::numeric,
      (p_signal->>'take_profit_price')::numeric,
      coalesce((p_signal->>'reward_risk')::numeric, 2),
      (p_signal->>'assumed_margin_usdt')::numeric,
      (p_signal->>'assumed_leverage')::numeric,
      (p_signal->>'position_notional_usdt')::numeric,
      v_new_risk,
      v_new_risk > p_single_risk_cap_usdt,
      true,
      'BUDGET_BLOCKED',
      (p_signal->>'valid_until')::timestamptz,
      (p_signal->>'source_data_timestamp')::timestamptz,
      (p_signal->>'occurrence_date')::date
    );

    insert into public.cs_signal_events (signal_id, event_type, payload)
    values (v_signal_id, 'BUDGET_BLOCKED', jsonb_build_object('delta_risk_usdt', v_delta));

    return jsonb_build_object('status', 'BUDGET_BLOCKED', 'signal_id', v_signal_id, 'email_allowed', false);
  end if;

  if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
    select array_agg(value) into v_confirmation_timeframes
    from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
  end if;

  if v_existing_id is not null then
    update public.cs_signals
    set status = 'REPLACED', replaced_by = v_signal_id, updated_at = now()
    where id = v_existing_id;
  end if;

  insert into public.cs_signals (
    id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
    confirmation_timeframes, strategy_family, strategy_version, score,
    score_components, market_regime, regime_dependency, entry_price,
    stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
    assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
    risk_over_single_cap, risk_budget_blocked, status, valid_until,
    source_data_timestamp, occurrence_date
  )
  values (
    v_signal_id,
    nullif(p_signal->>'scan_run_id', '')::uuid,
    p_signal->>'signal_key',
    p_signal->>'symbol',
    p_scan_group_key,
    p_signal->>'side',
    p_signal->>'primary_timeframe',
    coalesce(v_confirmation_timeframes, '{}'),
    p_signal->>'strategy_family',
    p_signal->>'strategy_version',
    v_new_score,
    coalesce(p_signal->'score_components', '{}'::jsonb),
    coalesce(p_signal->>'market_regime', 'UNKNOWN'),
    coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
    (p_signal->>'entry_price')::numeric,
    (p_signal->>'stop_price')::numeric,
    (p_signal->>'take_profit_price')::numeric,
    coalesce((p_signal->>'reward_risk')::numeric, 2),
    (p_signal->>'assumed_margin_usdt')::numeric,
    (p_signal->>'assumed_leverage')::numeric,
    (p_signal->>'position_notional_usdt')::numeric,
    v_new_risk,
    v_new_risk > p_single_risk_cap_usdt,
    false,
    'ACTIVE',
    (p_signal->>'valid_until')::timestamptz,
    (p_signal->>'source_data_timestamp')::timestamptz,
    (p_signal->>'occurrence_date')::date
  );

  update public.cs_risk_budgets
  set reserved_risk_usdt = reserved_risk_usdt + v_delta,
      new_signal_count = new_signal_count + case when v_is_new_opportunity then 1 else 0 end,
      updated_at = now()
  where budget_date = p_budget_date;

  insert into public.cs_signal_events (signal_id, event_type, payload)
  values (
    v_signal_id,
    case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    jsonb_build_object('delta_risk_usdt', v_delta, 'previous_signal_id', v_existing_id)
  );

  select count(*) into v_scan_email_count
  from public.cs_signals
  where scan_group_key = p_scan_group_key and email_reserved = true;

  if p_should_email and v_scan_email_count < p_scan_email_cap then
    update public.cs_risk_budgets
    set new_email_count = new_email_count + 1,
        updated_at = now()
    where budget_date = p_budget_date
      and new_email_count < p_daily_email_cap;
    v_email_allowed := found;
  end if;

  if v_email_allowed then
    update public.cs_signals
    set email_reserved = true,
        updated_at = now()
    where id = v_signal_id;
  end if;

  return jsonb_build_object(
    'status', case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    'signal_id', v_signal_id,
    'email_allowed', v_email_allowed,
    'risk_delta_usdt', v_delta
  );
end;
$$;

revoke execute on function public.cs_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
from public, anon, authenticated;
grant execute on function public.cs_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
to service_role;

alter table public.cs_strategy_versions enable row level security;
alter table public.cs_instruments enable row level security;
alter table public.cs_scan_runs enable row level security;
alter table public.cs_signals enable row level security;
alter table public.cs_signal_events enable row level security;
alter table public.cs_risk_budgets enable row level security;
alter table public.cs_notifications enable row level security;
alter table public.cs_backtest_runs enable row level security;
alter table public.cs_system_events enable row level security;
alter table public.cs_app_settings enable row level security;

revoke all on table
  public.cs_strategy_versions,
  public.cs_instruments,
  public.cs_scan_runs,
  public.cs_signals,
  public.cs_signal_events,
  public.cs_risk_budgets,
  public.cs_notifications,
  public.cs_backtest_runs,
  public.cs_system_events,
  public.cs_app_settings
from anon, authenticated;

insert into public.cs_app_settings (setting_key, setting_value, description)
values
  ('risk_policy', '{"margin_usdt":100,"single_signal_cap_usdt":100,"daily_budget_usdt":600,"max_leverage":20,"max_hold_hours":72}'::jsonb, 'Confirmed alert-only risk assumptions'),
  ('scan_policy', '{"timeframes":["15m","1h","4h"],"top_symbols":100,"max_new_emails_per_day":10,"same_symbol_policy":"one_active_highest_score"}'::jsonb, 'Confirmed scanner policy'),
  ('data_policy', '{"retain":"latest_results_only","raw_data":"local_only","universe":"all_usdt_m_perpetuals_light_scan_top_100_deep_scan"}'::jsonb, 'Confirmed data retention policy')
on conflict (setting_key) do nothing;
