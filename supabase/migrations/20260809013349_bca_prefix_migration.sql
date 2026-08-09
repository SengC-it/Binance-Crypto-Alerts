-- Rename only this project's existing cs_* objects to the requested bca_ prefix.
-- The table renames preserve rows, constraints, RLS state, grants, and dependencies.

do $$
declare
  v_old_name text;
  v_new_name text;
begin
  for v_old_name, v_new_name in
    select * from (values
      ('cs_strategy_versions', 'bca_strategy_versions'),
      ('cs_instruments', 'bca_instruments'),
      ('cs_scan_runs', 'bca_scan_runs'),
      ('cs_signals', 'bca_signals'),
      ('cs_signal_events', 'bca_signal_events'),
      ('cs_risk_budgets', 'bca_risk_budgets'),
      ('cs_notifications', 'bca_notifications'),
      ('cs_backtest_runs', 'bca_backtest_runs'),
      ('cs_system_events', 'bca_system_events'),
      ('cs_app_settings', 'bca_app_settings')
    ) as rename_pair(old_name, new_name)
  loop
    if to_regclass(format('public.%I', v_old_name)) is not null
       and to_regclass(format('public.%I', v_new_name)) is null then
      execute format('alter table public.%I rename to %I', v_old_name, v_new_name);
    end if;
  end loop;
end;
$$;

do $$
declare
  v_old_name text;
  v_new_name text;
begin
  for v_old_name, v_new_name in
    select * from (values
      ('cs_signals_one_active_per_symbol_idx', 'bca_signals_one_active_per_symbol_idx'),
      ('cs_signals_created_at_idx', 'bca_signals_created_at_idx'),
      ('cs_signals_occurrence_date_idx', 'bca_signals_occurrence_date_idx'),
      ('cs_signals_status_idx', 'bca_signals_status_idx'),
      ('cs_signal_events_signal_id_idx', 'bca_signal_events_signal_id_idx'),
      ('cs_notifications_status_idx', 'bca_notifications_status_idx'),
      ('cs_system_events_occurred_at_idx', 'bca_system_events_occurred_at_idx')
    ) as rename_pair(old_name, new_name)
  loop
    if to_regclass(format('public.%I', v_old_name)) is not null
       and to_regclass(format('public.%I', v_new_name)) is null then
      execute format('alter index public.%I rename to %I', v_old_name, v_new_name);
    end if;
  end loop;
end;
$$;

do $$
declare
  v_table_name text;
  v_old_name text;
  v_new_name text;
begin
  for v_table_name, v_old_name, v_new_name in
    select * from (values
      ('bca_instruments', 'cs_instruments_set_updated_at', 'bca_instruments_set_updated_at'),
      ('bca_signals', 'cs_signals_set_updated_at', 'bca_signals_set_updated_at'),
      ('bca_notifications', 'cs_notifications_set_updated_at', 'bca_notifications_set_updated_at'),
      ('bca_risk_budgets', 'cs_risk_budgets_set_updated_at', 'bca_risk_budgets_set_updated_at'),
      ('bca_app_settings', 'cs_app_settings_set_updated_at', 'bca_app_settings_set_updated_at')
    ) as rename_pair(table_name, old_name, new_name)
  loop
    if exists (
      select 1
      from pg_trigger
      where tgrelid = to_regclass(format('public.%I', v_table_name))
        and tgname = v_old_name
        and not tgisinternal
    ) then
      execute format(
        'alter trigger %I on public.%I rename to %I',
        v_old_name,
        v_table_name,
        v_new_name
      );
    end if;
  end loop;
end;
$$;

do $$
begin
  if to_regprocedure('public.cs_set_updated_at()') is not null
     and to_regprocedure('public.bca_set_updated_at()') is null then
    alter function public.cs_set_updated_at() rename to bca_set_updated_at;
  end if;

  if to_regprocedure('public.cs_claim_signal(jsonb,date,numeric,numeric,integer,boolean,text,integer)') is not null
     and to_regprocedure('public.bca_claim_signal(jsonb,date,numeric,numeric,integer,boolean,text,integer)') is null then
    alter function public.cs_claim_signal(jsonb,date,numeric,numeric,integer,boolean,text,integer)
      rename to bca_claim_signal;
  end if;
end;
$$;

create or replace function public.bca_set_updated_at()
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

-- Keep the atomic same-symbol replacement and daily theoretical-risk reservation
-- logic, but bind it to the renamed bca_* tables.
create or replace function public.bca_claim_signal(
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
  v_budget public.bca_risk_budgets%rowtype;
  v_email_allowed boolean := false;
  v_is_new_opportunity boolean := false;
  v_confirmation_timeframes text[] := '{}';
  v_scan_email_count integer := 0;
begin
  v_signal_id := coalesce(nullif(p_signal->>'id', '')::uuid, gen_random_uuid());
  v_new_score := (p_signal->>'score')::numeric;
  v_new_risk := (p_signal->>'theoretical_risk_usdt')::numeric;

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
    return jsonb_build_object(
      'status', 'REJECTED_LOWER_SCORE',
      'signal_id', v_existing_id,
      'email_allowed', false
    );
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

    insert into public.bca_signal_events (signal_id, event_type, payload)
    values (v_signal_id, 'BUDGET_BLOCKED', jsonb_build_object('delta_risk_usdt', v_delta));

    return jsonb_build_object('status', 'BUDGET_BLOCKED', 'signal_id', v_signal_id, 'email_allowed', false);
  end if;

  if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
    select array_agg(value) into v_confirmation_timeframes
    from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
  end if;

  if v_existing_id is not null then
    update public.bca_signals
    set status = 'REPLACED', replaced_by = null, updated_at = now()
    where id = v_existing_id;
  end if;

  insert into public.bca_signals (
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

  if v_existing_id is not null then
    update public.bca_signals
    set replaced_by = v_signal_id, updated_at = now()
    where id = v_existing_id;
  end if;

  update public.bca_risk_budgets
  set reserved_risk_usdt = reserved_risk_usdt + v_delta,
      new_signal_count = new_signal_count + case when v_is_new_opportunity then 1 else 0 end,
      updated_at = now()
  where budget_date = p_budget_date;

  insert into public.bca_signal_events (signal_id, event_type, payload)
  values (
    v_signal_id,
    case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    jsonb_build_object('delta_risk_usdt', v_delta, 'previous_signal_id', v_existing_id)
  );

  select count(*) into v_scan_email_count
  from public.bca_signals
  where scan_group_key = p_scan_group_key and email_reserved = true;

  if p_should_email and v_scan_email_count < p_scan_email_cap then
    update public.bca_risk_budgets
    set new_email_count = new_email_count + 1,
        updated_at = now()
    where budget_date = p_budget_date
      and new_email_count < p_daily_email_cap;
    v_email_allowed := found;
  end if;

  if v_email_allowed then
    update public.bca_signals
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

revoke execute on function public.bca_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
from public, anon, authenticated;
grant execute on function public.bca_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
to service_role;

alter table public.bca_strategy_versions enable row level security;
alter table public.bca_instruments enable row level security;
alter table public.bca_scan_runs enable row level security;
alter table public.bca_signals enable row level security;
alter table public.bca_signal_events enable row level security;
alter table public.bca_risk_budgets enable row level security;
alter table public.bca_notifications enable row level security;
alter table public.bca_backtest_runs enable row level security;
alter table public.bca_system_events enable row level security;
alter table public.bca_app_settings enable row level security;

revoke all on table
  public.bca_strategy_versions,
  public.bca_instruments,
  public.bca_scan_runs,
  public.bca_signals,
  public.bca_signal_events,
  public.bca_risk_budgets,
  public.bca_notifications,
  public.bca_backtest_runs,
  public.bca_system_events,
  public.bca_app_settings
from anon, authenticated;
