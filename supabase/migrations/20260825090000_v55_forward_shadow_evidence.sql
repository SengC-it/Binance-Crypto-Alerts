-- V5.5A additive forward-shadow evidence schema.
-- This migration is prepared for a later V5.5B rollout and is intentionally
-- not applied by V5.5A. Existing legacy shadow rows are left untouched.

create table if not exists public.bca_v55_forward_experiments (
  experiment_id text primary key,
  strategy_version text not null,
  strategy_manifest_hash text not null,
  forward_start_timestamp timestamptz,
  runtime_commit_sha text,
  status text not null default 'PLANNED'
    check (status in ('PLANNED', 'ACTIVE', 'STOPPED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bca_v55_universe_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.bca_scan_runs(id) on delete cascade,
  scan_group_key text not null references public.bca_scan_groups(scan_group_key) on delete cascade,
  experiment_id text not null references public.bca_v55_forward_experiments(experiment_id) on delete restrict,
  scan_timestamp timestamptz not null,
  snapshot_json jsonb not null,
  snapshot_hash text not null check (length(snapshot_hash) = 64),
  created_at timestamptz not null default now(),
  unique (experiment_id, scan_group_key),
  unique (experiment_id, snapshot_hash)
);

create table if not exists public.bca_v55_signal_feature_snapshots (
  snapshot_id uuid primary key,
  scan_id uuid not null references public.bca_scan_runs(id) on delete cascade,
  signal_id text not null,
  shadow_signal_id text,
  experiment_id text not null references public.bca_v55_forward_experiments(experiment_id) on delete restrict,
  strategy_version text not null,
  strategy_manifest_hash text not null check (length(strategy_manifest_hash) = 64),
  symbol text not null references public.bca_instruments(symbol) on delete restrict,
  side text not null check (side = 'SHORT'),
  source_data_timestamp timestamptz not null,
  decision_status text not null
    check (decision_status in ('RAW_TRIGGER_FALSE', 'REJECTED', 'FINAL_ELIGIBLE')),
  raw_trigger boolean not null,
  snapshot_json jsonb not null,
  snapshot_hash text not null check (length(snapshot_hash) = 64),
  created_at timestamptz not null default now(),
  unique (experiment_id, strategy_version, symbol, source_data_timestamp),
  unique (experiment_id, snapshot_hash)
);

create index if not exists bca_v55_feature_snapshots_experiment_time_idx
  on public.bca_v55_signal_feature_snapshots (experiment_id, strategy_version, source_data_timestamp);

create index if not exists bca_v55_universe_snapshots_scan_idx
  on public.bca_v55_universe_snapshots (experiment_id, scan_timestamp desc);

alter table public.bca_shadow_paper_trades
  add column if not exists v55_snapshot_id uuid,
  add column if not exists forward_experiment_id text,
  add column if not exists strategy_manifest_hash text,
  add column if not exists source_data_timestamp timestamptz,
  add column if not exists v55_idempotency_key text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bca_shadow_paper_trades_v55_snapshot_fk'
      and conrelid = 'public.bca_shadow_paper_trades'::regclass
  ) then
    alter table public.bca_shadow_paper_trades
      add constraint bca_shadow_paper_trades_v55_snapshot_fk
      foreign key (v55_snapshot_id)
      references public.bca_v55_signal_feature_snapshots(snapshot_id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists bca_shadow_paper_trades_v55_idempotency_idx
  on public.bca_shadow_paper_trades (v55_idempotency_key)
  where v55_idempotency_key is not null;

create index if not exists bca_shadow_paper_trades_v55_forward_idx
  on public.bca_shadow_paper_trades (forward_experiment_id, strategy_version, source_data_timestamp);

create or replace function public.bca_v55_snapshot_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'V5.5 signal feature snapshots are immutable';
end;
$$;

create or replace function public.bca_v55_guard_shadow_entry()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.v55_snapshot_id is not null and (
    old.symbol is distinct from new.symbol
    or old.side is distinct from new.side
    or old.strategy_family is distinct from new.strategy_family
    or old.strategy_version is distinct from new.strategy_version
    or old.entry_time is distinct from new.entry_time
    or old.entry_price is distinct from new.entry_price
    or old.entry_fill_price is distinct from new.entry_fill_price
    or old.stop_price is distinct from new.stop_price
    or old.take_profit_price is distinct from new.take_profit_price
    or old.max_hold_until is distinct from new.max_hold_until
    or old.quantity is distinct from new.quantity
    or old.assumed_margin_usdt is distinct from new.assumed_margin_usdt
    or old.assumed_leverage is distinct from new.assumed_leverage
    or old.position_notional_usdt is distinct from new.position_notional_usdt
    or old.theoretical_risk_usdt is distinct from new.theoretical_risk_usdt
    or old.metadata is distinct from new.metadata
    or old.v55_snapshot_id is distinct from new.v55_snapshot_id
    or old.forward_experiment_id is distinct from new.forward_experiment_id
    or old.strategy_manifest_hash is distinct from new.strategy_manifest_hash
    or old.source_data_timestamp is distinct from new.source_data_timestamp
    or old.v55_idempotency_key is distinct from new.v55_idempotency_key
  ) then
    raise exception 'V5.5 shadow entry evidence is immutable';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'bca_v55_signal_feature_snapshots_immutable'
  ) then
    create trigger bca_v55_signal_feature_snapshots_immutable
    before update or delete on public.bca_v55_signal_feature_snapshots
    for each row execute function public.bca_v55_snapshot_immutable();
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'bca_v55_shadow_entry_guard'
  ) then
    create trigger bca_v55_shadow_entry_guard
    before update on public.bca_shadow_paper_trades
    for each row execute function public.bca_v55_guard_shadow_entry();
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'bca_v55_forward_experiments_set_updated_at'
      and tgrelid = 'public.bca_v55_forward_experiments'::regclass
  ) then
    create trigger bca_v55_forward_experiments_set_updated_at
    before update on public.bca_v55_forward_experiments
    for each row execute function public.bca_set_updated_at();
  end if;
end;
$$;

alter table public.bca_v55_forward_experiments enable row level security;
alter table public.bca_v55_universe_snapshots enable row level security;
alter table public.bca_v55_signal_feature_snapshots enable row level security;

revoke all on table
  public.bca_v55_forward_experiments,
  public.bca_v55_universe_snapshots,
  public.bca_v55_signal_feature_snapshots
from anon, authenticated;

grant all on table
  public.bca_v55_forward_experiments,
  public.bca_v55_universe_snapshots,
  public.bca_v55_signal_feature_snapshots
to service_role;

revoke execute on function public.bca_v55_snapshot_immutable() from public, anon, authenticated;
revoke execute on function public.bca_v55_guard_shadow_entry() from public, anon, authenticated;
