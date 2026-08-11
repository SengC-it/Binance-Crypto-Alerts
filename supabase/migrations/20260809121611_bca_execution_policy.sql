-- Production execution policy parity with cross-batch candidate finalization.

alter table public.bca_signals drop constraint if exists bca_signals_status_check;
alter table public.bca_signals add constraint bca_signals_status_check
  check (status in ('ACTIVE', 'REPLACED', 'BUDGET_BLOCKED', 'MANUALLY_CLOSED', 'CLOSED', 'EXPIRED'));

create table public.bca_scan_groups (
  scan_group_key text primary key,
  batch_count integer not null check (batch_count > 0),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'FINALIZING', 'COMPLETED', 'FAILED')),
  finalization_started_at timestamptz,
  finished_at timestamptz,
  error_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bca_scan_candidates (
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

create index bca_scan_candidates_group_score_idx
  on public.bca_scan_candidates (scan_group_key, score desc, symbol);
create index bca_scan_candidates_scan_run_id_idx
  on public.bca_scan_candidates (scan_run_id);
create index if not exists bca_notifications_signal_id_idx
  on public.bca_notifications (signal_id);
create index if not exists bca_signals_replaced_by_idx
  on public.bca_signals (replaced_by)
  where replaced_by is not null;

create trigger bca_scan_groups_set_updated_at
before update on public.bca_scan_groups
for each row execute function public.bca_set_updated_at();

create or replace function public.bca_try_finalize_scan_group(p_scan_group_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.bca_scan_groups%rowtype;
  v_finished_batches integer;
begin
  delete from public.bca_scan_groups
  where created_at < now() - interval '2 days'
    and status in ('COMPLETED', 'FAILED');

  select * into v_group
  from public.bca_scan_groups
  where scan_group_key = p_scan_group_key
  for update;

  if not found then
    raise exception 'Unknown scan group %', p_scan_group_key;
  end if;

  select count(*) into v_finished_batches
  from public.bca_scan_runs
  where scan_group_key = p_scan_group_key
    and status in ('COMPLETED', 'PARTIAL');

  if v_finished_batches < v_group.batch_count or v_group.status = 'COMPLETED' then
    return false;
  end if;
  if v_group.status = 'FINALIZING'
    and v_group.finalization_started_at > now() - interval '10 minutes' then
    return false;
  end if;

  update public.bca_scan_groups
  set status = 'FINALIZING',
      finalization_started_at = now(),
      finished_at = null,
      error_summary = '[]'::jsonb
  where scan_group_key = p_scan_group_key;
  return true;
end;
$$;

drop trigger if exists bca_signals_cancel_replaced_paper_trade on public.bca_signals;
drop function if exists public.bca_cancel_replaced_paper_trade();

create or replace function public.bca_close_replaced_paper_trade(
  p_signal_id uuid,
  p_exit_time timestamptz,
  p_reference_exit_price numeric,
  p_taker_fee_rate numeric,
  p_slippage_bps numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade public.bca_paper_trades%rowtype;
  v_direction numeric;
  v_exit_fill numeric;
  v_gross numeric;
  v_raw_gross numeric;
  v_fees numeric;
  v_net numeric;
begin
  select * into v_trade
  from public.bca_paper_trades
  where signal_id = p_signal_id and status = 'OPEN'
  for update;
  if not found then return; end if;

  v_direction := case when v_trade.side = 'LONG' then 1 else -1 end;
  v_exit_fill := p_reference_exit_price * (
    case when v_trade.side = 'LONG'
      then 1 - p_slippage_bps / 10000
      else 1 + p_slippage_bps / 10000
    end
  );
  v_gross := (v_exit_fill - v_trade.entry_fill_price) * v_direction * v_trade.quantity;
  v_raw_gross := (p_reference_exit_price - v_trade.entry_price) * v_direction * v_trade.quantity;
  v_fees := (abs(v_trade.entry_fill_price * v_trade.quantity) + abs(v_exit_fill * v_trade.quantity)) * p_taker_fee_rate;
  v_net := v_gross - v_fees + v_trade.funding_usdt;

  update public.bca_paper_trades
  set status = 'CANCELLED',
      last_price = v_exit_fill,
      last_candle_close_time = p_exit_time,
      last_checked_at = now(),
      unrealized_pnl_usdt = 0,
      exit_time = p_exit_time,
      exit_price = v_exit_fill,
      exit_reason = 'SIGNAL_REPLACED',
      gross_pnl_usdt = v_gross,
      fees_usdt = v_fees,
      slippage_usdt = greatest(0, v_raw_gross - v_gross),
      net_pnl_usdt = v_net,
      r_multiple = case when theoretical_risk_usdt = 0 then 0 else v_net / theoretical_risk_usdt end,
      settlement_error = null,
      metadata = metadata || jsonb_build_object('replacement_exit_model', 'next_signal_reference'),
      updated_at = now()
  where id = v_trade.id;
end;
$$;

create or replace function public.bca_sync_signal_from_paper_trade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'OPEN' and new.status <> 'OPEN' then
    update public.bca_signals
    set status = 'CLOSED', updated_at = now()
    where id = new.signal_id and status = 'ACTIVE';
  end if;
  return new;
end;
$$;

create trigger bca_paper_trades_sync_signal
after update of status on public.bca_paper_trades
for each row execute function public.bca_sync_signal_from_paper_trade();

drop function public.bca_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer);

create function public.bca_claim_signal(
  p_signal jsonb,
  p_budget_date date,
  p_daily_limit_usdt numeric,
  p_single_risk_cap_usdt numeric,
  p_daily_email_cap integer,
  p_should_email boolean,
  p_scan_group_key text,
  p_scan_email_cap integer,
  p_max_concurrent_positions integer,
  p_cooldown_hours numeric,
  p_taker_fee_rate numeric,
  p_slippage_bps numeric
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
  v_budget public.bca_risk_budgets%rowtype;
  v_email_allowed boolean := false;
  v_is_new_opportunity boolean := false;
  v_confirmation_timeframes text[] := '{}';
  v_scan_email_count integer := 0;
  v_open_positions integer := 0;
  v_last_exit_time timestamptz;
  v_source_time timestamptz;
begin
  v_signal_id := coalesce(nullif(p_signal->>'id', '')::uuid, gen_random_uuid());
  v_new_score := (p_signal->>'score')::numeric;
  v_new_risk := (p_signal->>'theoretical_risk_usdt')::numeric;
  v_source_time := (p_signal->>'source_data_timestamp')::timestamptz;

  update public.bca_signals
  set status = 'EXPIRED', updated_at = now()
  where status = 'ACTIVE' and valid_until <= v_source_time;

  select id into v_existing_id
  from public.bca_signals
  where signal_key = p_signal->>'signal_key'
  limit 1;
  if v_existing_id is not null then
    return jsonb_build_object('status', 'IDEMPOTENT', 'signal_id', v_existing_id, 'email_allowed', false);
  end if;

  select id, score, theoretical_risk_usdt
    into v_existing_id, v_existing_score, v_existing_risk
  from public.bca_signals
  where symbol = p_signal->>'symbol' and status = 'ACTIVE'
  for update;

  if v_existing_id is not null and v_new_score <= v_existing_score then
    return jsonb_build_object('status', 'REJECTED_LOWER_SCORE', 'signal_id', v_existing_id, 'email_allowed', false);
  end if;

  if v_existing_id is null then
    select count(*) into v_open_positions
    from public.bca_paper_trades
    where status = 'OPEN';
    if v_open_positions >= p_max_concurrent_positions then
      return jsonb_build_object('status', 'PORTFOLIO_BLOCKED', 'email_allowed', false);
    end if;

    select max(exit_time) into v_last_exit_time
    from public.bca_paper_trades
    where symbol = p_signal->>'symbol' and exit_time is not null;
    if v_last_exit_time is not null
      and v_source_time < v_last_exit_time + make_interval(secs => (p_cooldown_hours * 3600)::double precision) then
      return jsonb_build_object('status', 'COOLDOWN_BLOCKED', 'email_allowed', false);
    end if;
  end if;

  v_is_new_opportunity := v_existing_id is null;
  v_delta := greatest(v_new_risk - coalesce(v_existing_risk, 0), 0);

  insert into public.bca_risk_budgets (budget_date, daily_limit_usdt)
  values (p_budget_date, p_daily_limit_usdt)
  on conflict (budget_date) do nothing;
  select * into v_budget
  from public.bca_risk_budgets
  where budget_date = p_budget_date
  for update;

  if v_budget.reserved_risk_usdt + v_delta > v_budget.daily_limit_usdt then
    if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
      select array_agg(value) into v_confirmation_timeframes
      from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
    end if;
    insert into public.bca_signals (
      id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
      confirmation_timeframes, strategy_family, strategy_version, score,
      score_components, market_regime, regime_dependency, entry_price,
      stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
      assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
      risk_over_single_cap, risk_budget_blocked, status, valid_until,
      source_data_timestamp, occurrence_date
    ) values (
      v_signal_id, nullif(p_signal->>'scan_run_id', '')::uuid,
      p_signal->>'signal_key', p_signal->>'symbol', p_scan_group_key,
      p_signal->>'side', p_signal->>'primary_timeframe', coalesce(v_confirmation_timeframes, '{}'),
      p_signal->>'strategy_family', p_signal->>'strategy_version', v_new_score,
      coalesce(p_signal->'score_components', '{}'::jsonb), coalesce(p_signal->>'market_regime', 'UNKNOWN'),
      coalesce(p_signal->>'regime_dependency', 'UNKNOWN'), (p_signal->>'entry_price')::numeric,
      (p_signal->>'stop_price')::numeric, (p_signal->>'take_profit_price')::numeric,
      coalesce((p_signal->>'reward_risk')::numeric, 2), (p_signal->>'assumed_margin_usdt')::numeric,
      (p_signal->>'assumed_leverage')::numeric, (p_signal->>'position_notional_usdt')::numeric,
      v_new_risk, v_new_risk > p_single_risk_cap_usdt, true, 'BUDGET_BLOCKED',
      (p_signal->>'valid_until')::timestamptz, v_source_time, (p_signal->>'occurrence_date')::date
    );
    insert into public.bca_signal_events (signal_id, event_type, payload)
    values (v_signal_id, 'BUDGET_BLOCKED', jsonb_build_object('delta_risk_usdt', v_delta));
    return jsonb_build_object('status', 'BUDGET_BLOCKED', 'signal_id', v_signal_id, 'email_allowed', false);
  end if;

  if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
    select array_agg(value) into v_confirmation_timeframes
    from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
  end if;

  if v_existing_id is not null then
    update public.bca_signals set status = 'REPLACED', replaced_by = null, updated_at = now()
    where id = v_existing_id;
    perform public.bca_close_replaced_paper_trade(
      v_existing_id, v_source_time, (p_signal->>'entry_price')::numeric,
      p_taker_fee_rate, p_slippage_bps
    );
  end if;

  insert into public.bca_signals (
    id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
    confirmation_timeframes, strategy_family, strategy_version, score,
    score_components, market_regime, regime_dependency, entry_price,
    stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
    assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
    risk_over_single_cap, risk_budget_blocked, status, valid_until,
    source_data_timestamp, occurrence_date
  ) values (
    v_signal_id, nullif(p_signal->>'scan_run_id', '')::uuid,
    p_signal->>'signal_key', p_signal->>'symbol', p_scan_group_key,
    p_signal->>'side', p_signal->>'primary_timeframe', coalesce(v_confirmation_timeframes, '{}'),
    p_signal->>'strategy_family', p_signal->>'strategy_version', v_new_score,
    coalesce(p_signal->'score_components', '{}'::jsonb), coalesce(p_signal->>'market_regime', 'UNKNOWN'),
    coalesce(p_signal->>'regime_dependency', 'UNKNOWN'), (p_signal->>'entry_price')::numeric,
    (p_signal->>'stop_price')::numeric, (p_signal->>'take_profit_price')::numeric,
    coalesce((p_signal->>'reward_risk')::numeric, 2), (p_signal->>'assumed_margin_usdt')::numeric,
    (p_signal->>'assumed_leverage')::numeric, (p_signal->>'position_notional_usdt')::numeric,
    v_new_risk, v_new_risk > p_single_risk_cap_usdt, false, 'ACTIVE',
    (p_signal->>'valid_until')::timestamptz, v_source_time, (p_signal->>'occurrence_date')::date
  );

  if v_existing_id is not null then
    update public.bca_signals set replaced_by = v_signal_id, updated_at = now()
    where id = v_existing_id;
  end if;

  update public.bca_risk_budgets
  set reserved_risk_usdt = reserved_risk_usdt + v_delta,
      new_signal_count = new_signal_count + case when v_is_new_opportunity then 1 else 0 end,
      updated_at = now()
  where budget_date = p_budget_date;

  insert into public.bca_signal_events (signal_id, event_type, payload)
  values (
    v_signal_id, case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    jsonb_build_object('delta_risk_usdt', v_delta, 'previous_signal_id', v_existing_id)
  );

  select count(*) into v_scan_email_count
  from public.bca_signals
  where scan_group_key = p_scan_group_key and email_reserved = true;
  if p_should_email and v_scan_email_count < p_scan_email_cap then
    update public.bca_risk_budgets
    set new_email_count = new_email_count + 1, updated_at = now()
    where budget_date = p_budget_date and new_email_count < p_daily_email_cap;
    v_email_allowed := found;
  end if;
  if v_email_allowed then
    update public.bca_signals set email_reserved = true, updated_at = now()
    where id = v_signal_id;
  end if;

  return jsonb_build_object(
    'status', case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    'signal_id', v_signal_id, 'email_allowed', v_email_allowed, 'risk_delta_usdt', v_delta
  );
end;
$$;

revoke execute on function public.bca_try_finalize_scan_group(text) from public, anon, authenticated;
revoke execute on function public.bca_close_replaced_paper_trade(uuid, timestamptz, numeric, numeric, numeric) from public, anon, authenticated;
revoke execute on function public.bca_sync_signal_from_paper_trade() from public, anon, authenticated;
revoke execute on function public.bca_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer, integer, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.bca_try_finalize_scan_group(text) to service_role;
grant execute on function public.bca_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer, integer, numeric, numeric, numeric) to service_role;

alter table public.bca_scan_groups enable row level security;
alter table public.bca_scan_candidates enable row level security;
revoke all on table public.bca_scan_groups, public.bca_scan_candidates from anon, authenticated;
grant all on table public.bca_scan_groups, public.bca_scan_candidates to service_role;
