# V5.5B Minimal Production Shadow Rollout Plan

Status: PREPARATION ONLY. No forward experiment has started. The V5.5 flag remains disabled and no Production environment value was changed.

Frozen runtime identity:

- Strategy: `SHORT-FAILED_BREAKOUT_SHORT-02`
- Strategy version: `failed-breakout-short-02-shadow-v1`
- Manifest hash: `ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305`
- Formal experiment ID: `v55-fbos02-forward-001`
- Runtime SHA: `NOT_STARTED / TO_BE_ASSIGNED_AFTER_APPROVAL`
- Forward start timestamp: `NOT_STARTED / TO_BE_ASSIGNED_AFTER_APPROVAL`

## Rollout order

1. Apply the approved additive migration `20260825090000_v55_forward_shadow_evidence.sql` in the Production Supabase project. This is a future activation step; it was not performed by this preparation.
2. Verify the three V5.5 evidence tables, foreign keys, unique keys, RLS, service-role grants, immutable entry guards, settlement mutability, and the unchanged legacy `bca_shadow_paper_trades` rows.
3. Deploy the approved rollout commit with `BCA_V55_SHADOW_ENABLED=false` and verify the environment still has the Production strategy and Health Gate settings.
4. Run the normal protected Production scan smoke with the flag off. Confirm existing candidate processing, paper tracking, legacy Shadow tracking, Health Gate blocking, email admission, batching, cooldown, and risk behavior are unchanged.
5. Choose an immutable future `forwardStartTimestamp` after approval. Do not backfill historical rows and do not infer a start from existing Shadow evidence.
6. Set the formal experiment ID, approved forward start timestamp, and exact approved deployed runtime SHA. Keep the feature flag false while these identity values are verified.
7. Redeploy or restart the approved runtime and perform a read-only identity check: experiment ID, strategy version, manifest hash, forward start, and runtime SHA must match exactly.
8. Obtain explicit activation approval, then set `BCA_V55_SHADOW_ENABLED=true`. No Production email capability is enabled by this flag; V5.5 writes only evidence and Shadow paper rows.
9. Run the first real forward scan group. Verify closed-candle features, next-bar open provenance, idempotent snapshot ownership, no entry fallback, and fail-closed behavior when execution reference data is unavailable.
10. Perform the read-only acceptance checks in `reports/v5-5b-activation-smoke.sql`: experiment identity, point-in-time universe, feature snapshots, Shadow trades, settlement fields, zero V5.5 Production A-email path, unchanged Production strategy, and no Binance private API activity.

## Activation smoke checks

- `BCA_V55_SHADOW_ENABLED=true` is present only after approval.
- `BCA_V55_FORWARD_EXPERIMENT_ID=v55-fbos02-forward-001`.
- `BCA_V55_FORWARD_START_TIMESTAMP` is a newly approved immutable future boundary.
- `BCA_V55_RUNTIME_COMMIT_SHA` equals the deployed rollout commit; it is never the research SHA.
- The first scan writes at most one canonical universe snapshot per scan and one canonical feature snapshot per natural identity.
- A missing next-bar open produces no V5.5 Shadow trade and records `EXECUTION_REFERENCE_UNAVAILABLE`.
- V5.5 never calls the Production email, signal-claim, or Production paper-trade path.
- The existing Production strategy remains `trend-rejection-short-v1`.

## Rollback

1. Disable `BCA_V55_SHADOW_ENABLED` and redeploy the last approved runtime or set the flag false in the current runtime.
2. Verify the normal Production scan path, Health Gate, email admission, paper ledger, and legacy Shadow path remain healthy.
3. Do not delete evidence, rewrite entry provenance, or apply a destructive database rollback. Preserve the forward evidence for investigation; mark the experiment stopped only through a separately approved operational action.

Current preparation state: flag off, forward not started, migration prepared but not applied, no Production deployment, no Production email, no strategy promotion.
