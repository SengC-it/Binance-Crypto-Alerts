-- Keep the active-position guard synchronized with the production portfolio cap.
alter function public.bca_claim_signal(
  jsonb, date, numeric, numeric, integer, boolean, text, integer,
  integer, numeric, numeric, numeric
) rename to bca_claim_signal_unchecked;

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
  v_active_count integer;
  v_same_symbol_active boolean;
  v_source_time timestamptz;
begin
  v_source_time := (p_signal->>'source_data_timestamp')::timestamptz;
  update public.bca_signals
  set status = 'EXPIRED', updated_at = now()
  where status = 'ACTIVE' and valid_until <= v_source_time;

  select count(*), bool_or(symbol = p_signal->>'symbol')
    into v_active_count, v_same_symbol_active
  from public.bca_signals
  where status = 'ACTIVE';

  if v_active_count >= p_max_concurrent_positions and not coalesce(v_same_symbol_active, false) then
    return jsonb_build_object('status', 'PORTFOLIO_BLOCKED', 'email_allowed', false);
  end if;

  return public.bca_claim_signal_unchecked(
    p_signal,
    p_budget_date,
    p_daily_limit_usdt,
    p_single_risk_cap_usdt,
    p_daily_email_cap,
    p_should_email,
    p_scan_group_key,
    p_scan_email_cap,
    p_max_concurrent_positions,
    p_cooldown_hours,
    p_taker_fee_rate,
    p_slippage_bps
  );
end;
$$;

revoke execute on function public.bca_claim_signal_unchecked(
  jsonb, date, numeric, numeric, integer, boolean, text, integer,
  integer, numeric, numeric, numeric
) from public, anon, authenticated, service_role;
revoke execute on function public.bca_claim_signal(
  jsonb, date, numeric, numeric, integer, boolean, text, integer,
  integer, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.bca_claim_signal(
  jsonb, date, numeric, numeric, integer, boolean, text, integer,
  integer, numeric, numeric, numeric
) to service_role;
