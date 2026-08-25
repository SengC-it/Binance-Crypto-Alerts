-- V5.5B activation smoke: READ ONLY. Run only after the approved migration,
-- approved runtime deployment, and explicit forward activation.

-- Experiment identity and lifecycle.
select experiment_id,
       strategy_version,
       strategy_manifest_hash,
       forward_start_timestamp,
       runtime_commit_sha,
       status
from public.bca_v55_forward_experiments
where experiment_id = 'v55-fbos02-forward-001';

-- Point-in-time universe capture and duplicate protection.
select count(*) as universe_snapshot_count,
       count(distinct snapshot_hash) as unique_universe_hashes
from public.bca_v55_universe_snapshots
where experiment_id = 'v55-fbos02-forward-001';

select experiment_id,
       scan_id,
       scan_timestamp,
       snapshot_hash
from public.bca_v55_universe_snapshots
where experiment_id = 'v55-fbos02-forward-001'
order by scan_timestamp desc
limit 5;

-- Signal provenance, execution-reference availability, and natural-key uniqueness.
select count(*) as feature_snapshot_count,
       count(*) filter (where decision_status = 'FINAL_ELIGIBLE') as final_eligible_count,
       count(*) filter (where snapshot_json->>'executionReferenceSource' = 'BINANCE_15M_NEXT_BAR_OPEN') as next_open_reference_count,
       count(*) filter (where snapshot_json->>'executionReferenceStatus' = 'EXECUTION_REFERENCE_UNAVAILABLE') as unavailable_reference_count
from public.bca_v55_signal_feature_snapshots
where experiment_id = 'v55-fbos02-forward-001';

select experiment_id,
       strategy_version,
       symbol,
       source_data_timestamp,
       snapshot_hash,
       snapshot_json->>'signalCandleCloseTime' as signal_candle_close_time,
       snapshot_json->>'executionCandleOpenTime' as execution_candle_open_time,
       snapshot_json->>'executionReferencePrice' as execution_reference_price,
       snapshot_json->>'executionReferenceSource' as execution_reference_source
from public.bca_v55_signal_feature_snapshots
where experiment_id = 'v55-fbos02-forward-001'
order by source_data_timestamp desc
limit 20;

-- V5.5 Shadow trade ownership and immutable entry identity.
select strategy_version,
       forward_experiment_id,
       count(*) as shadow_trade_count,
       count(distinct v55_snapshot_id) as canonical_snapshot_count,
       count(distinct v55_idempotency_key) as idempotency_key_count
from public.bca_shadow_paper_trades
where forward_experiment_id = 'v55-fbos02-forward-001'
group by strategy_version, forward_experiment_id;

select id,
       symbol,
       strategy_version,
       entry_time,
       entry_price,
       exit_time,
       exit_reason,
       status,
       r_multiple,
       net_pnl_usdt
from public.bca_shadow_paper_trades
where forward_experiment_id = 'v55-fbos02-forward-001'
order by entry_time desc
limit 20;

-- Production strategy and email boundary checks.
select strategy_version, count(*) as paper_trade_count
from public.bca_paper_trades
where strategy_version = 'trend-rejection-short-v1'
group by strategy_version;

select n.status, count(*) as notification_count
from public.bca_notifications n
join public.bca_signals s on s.id = n.signal_id
where s.strategy_version = 'trend-rejection-short-v1'
  and n.created_at >= (
    select forward_start_timestamp
    from public.bca_v55_forward_experiments
    where experiment_id = 'v55-fbos02-forward-001'
  )
group by n.status;
