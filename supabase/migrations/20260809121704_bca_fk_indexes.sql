-- Cover the remaining bca_ foreign keys reported by the database advisor.
create index bca_scan_candidates_symbol_idx
  on public.bca_scan_candidates (symbol);

create index bca_signals_scan_run_id_idx
  on public.bca_signals (scan_run_id)
  where scan_run_id is not null;
