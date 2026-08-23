-- V5 Signal Edge registry and trace fields.
-- This migration is additive: it does not remove or rewrite historical signal,
-- paper, shadow, or backtest rows. No policy is seeded as APPROVED.

create table if not exists public.bca_policy_registry (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null unique,
  strategy_params jsonb not null default '{}'::jsonb,
  supported_directions text[] not null default '{LONG,SHORT}',
  direction_approval jsonb not null default '{"LONG":"DRAFT","SHORT":"DRAFT"}'::jsonb,
  entry_policy jsonb not null default '{}'::jsonb,
  regime_policy jsonb not null default '{}'::jsonb,
  no_chase_policy jsonb not null default '{}'::jsonb,
  universe_policy jsonb not null default '{}'::jsonb,
  calibration_model jsonb,
  expected_edge_model jsonb,
  cost_model_version text not null default 'reference-fee-slippage-funding-v1',
  train_window jsonb not null default '{}'::jsonb,
  validation_window jsonb not null default '{}'::jsonb,
  holdout_window jsonb not null default '{}'::jsonb,
  validation_metrics jsonb not null default '{}'::jsonb,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'CANDIDATE', 'SHADOW', 'APPROVED', 'REJECTED', 'RETIRED')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.bca_signals add column if not exists policy_version text;
alter table public.bca_signals add column if not exists signal_tier text
  check (signal_tier is null or signal_tier in ('A', 'B', 'C'));
alter table public.bca_signals add column if not exists market_state text;
alter table public.bca_signals add column if not exists setup_type text;
alter table public.bca_signals add column if not exists entry_trigger text;
alter table public.bca_signals add column if not exists expected_net_r numeric;
alter table public.bca_signals add column if not exists win_probability numeric;
alter table public.bca_signals add column if not exists edge_confidence numeric;
alter table public.bca_signals add column if not exists confidence numeric;
alter table public.bca_signals add column if not exists calibration_samples integer;
alter table public.bca_signals add column if not exists rejection_reason text;
alter table public.bca_instruments add column if not exists onboard_date bigint;
alter table public.bca_shadow_candidates add column if not exists policy_version text;
alter table public.bca_shadow_candidates add column if not exists signal_tier text
  check (signal_tier is null or signal_tier in ('A', 'B', 'C'));
alter table public.bca_shadow_candidates add column if not exists expected_net_r numeric;
alter table public.bca_shadow_candidates add column if not exists win_probability numeric;
alter table public.bca_shadow_candidates add column if not exists edge_confidence numeric;
alter table public.bca_shadow_candidates add column if not exists rejection_reason text;

alter table public.bca_paper_trades add column if not exists policy_version text;
alter table public.bca_paper_trades add column if not exists signal_tier text
  check (signal_tier is null or signal_tier in ('A', 'B', 'C'));
alter table public.bca_paper_trades add column if not exists market_state text;
alter table public.bca_paper_trades add column if not exists setup_type text;
alter table public.bca_paper_trades add column if not exists entry_trigger text;
alter table public.bca_paper_trades add column if not exists expected_net_r numeric;
alter table public.bca_paper_trades add column if not exists win_probability numeric;
alter table public.bca_paper_trades add column if not exists edge_confidence numeric;
alter table public.bca_paper_trades add column if not exists confidence numeric;
alter table public.bca_paper_trades add column if not exists calibration_samples integer;
alter table public.bca_paper_trades add column if not exists rejection_reason text;

alter table public.bca_shadow_paper_trades add column if not exists policy_version text;
alter table public.bca_shadow_paper_trades add column if not exists signal_tier text
  check (signal_tier is null or signal_tier in ('A', 'B', 'C'));
alter table public.bca_shadow_paper_trades add column if not exists market_state text;
alter table public.bca_shadow_paper_trades add column if not exists setup_type text;
alter table public.bca_shadow_paper_trades add column if not exists entry_trigger text;
alter table public.bca_shadow_paper_trades add column if not exists expected_net_r numeric;
alter table public.bca_shadow_paper_trades add column if not exists win_probability numeric;
alter table public.bca_shadow_paper_trades add column if not exists edge_confidence numeric;
alter table public.bca_shadow_paper_trades add column if not exists confidence numeric;
alter table public.bca_shadow_paper_trades add column if not exists calibration_samples integer;
alter table public.bca_shadow_paper_trades add column if not exists rejection_reason text;

alter table public.bca_scan_runs add column if not exists signal_stats jsonb not null default '{}'::jsonb;
alter table public.bca_scan_groups add column if not exists global_market_state jsonb;
alter table public.bca_backtest_runs add column if not exists policy_version text;
alter table public.bca_backtest_runs add column if not exists holdout_frozen boolean not null default false;

create index if not exists bca_policy_registry_status_idx
  on public.bca_policy_registry (status, approved_at desc);
create index if not exists bca_signals_policy_direction_idx
  on public.bca_signals (policy_version, side, signal_tier, created_at desc);
create index if not exists bca_paper_trades_policy_idx
  on public.bca_paper_trades (policy_version, side, entry_time desc);
create index if not exists bca_shadow_paper_trades_policy_idx
  on public.bca_shadow_paper_trades (policy_version, side, entry_time desc);
create index if not exists bca_shadow_candidates_policy_idx
  on public.bca_shadow_candidates (policy_version, signal_tier, created_at desc);

create trigger bca_policy_registry_set_updated_at
before update on public.bca_policy_registry
for each row execute function public.bca_set_updated_at();

alter table public.bca_policy_registry enable row level security;
revoke all on table public.bca_policy_registry from anon, authenticated;
grant all on table public.bca_policy_registry to service_role;
