-- Keep scan-group finalization focused on the requested group.
-- V5.5 evidence is immutable audit data and must not be removed by retention.

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

alter table public.bca_v55_universe_snapshots
  drop constraint if exists bca_v55_universe_snapshots_scan_group_key_fkey,
  drop constraint if exists bca_v55_universe_snapshots_scan_id_fkey;

alter table public.bca_v55_universe_snapshots
  add constraint bca_v55_universe_snapshots_scan_group_key_fkey
    foreign key (scan_group_key)
    references public.bca_scan_groups(scan_group_key)
    on delete restrict,
  add constraint bca_v55_universe_snapshots_scan_id_fkey
    foreign key (scan_id)
    references public.bca_scan_runs(id)
    on delete restrict;

alter table public.bca_v55_signal_feature_snapshots
  drop constraint if exists bca_v55_signal_feature_snapshots_scan_id_fkey;

alter table public.bca_v55_signal_feature_snapshots
  add constraint bca_v55_signal_feature_snapshots_scan_id_fkey
    foreign key (scan_id)
    references public.bca_scan_runs(id)
    on delete restrict;
