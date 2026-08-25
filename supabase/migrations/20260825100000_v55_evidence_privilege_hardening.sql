-- V5.5B Stage 1A.1 least-privilege hardening.
-- This migration only tightens access to the already-created evidence tables.
-- It does not create, update, or backfill any evidence rows.

revoke all on table public.bca_v55_signal_feature_snapshots
from public, anon, authenticated, service_role;
grant select, insert on table public.bca_v55_signal_feature_snapshots to service_role;

revoke all on table public.bca_v55_universe_snapshots
from public, anon, authenticated, service_role;
grant select, insert on table public.bca_v55_universe_snapshots to service_role;

revoke all on table public.bca_v55_forward_experiments
from public, anon, authenticated, service_role;
grant select, insert on table public.bca_v55_forward_experiments to service_role;

create or replace function public.bca_v55_reject_evidence_truncate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'V5.5 evidence tables cannot be truncated';
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'bca_v55_signal_feature_snapshots_no_truncate'
      and tgrelid = 'public.bca_v55_signal_feature_snapshots'::regclass
  ) then
    create trigger bca_v55_signal_feature_snapshots_no_truncate
    before truncate on public.bca_v55_signal_feature_snapshots
    for each statement execute function public.bca_v55_reject_evidence_truncate();
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgname = 'bca_v55_universe_snapshots_no_truncate'
      and tgrelid = 'public.bca_v55_universe_snapshots'::regclass
  ) then
    create trigger bca_v55_universe_snapshots_no_truncate
    before truncate on public.bca_v55_universe_snapshots
    for each statement execute function public.bca_v55_reject_evidence_truncate();
  end if;
end;
$$;

revoke execute on function public.bca_v55_reject_evidence_truncate() from public, anon, authenticated;
