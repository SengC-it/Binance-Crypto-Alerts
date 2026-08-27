# Final Research Closeout

- Closeout date: `2026-08-27`
- Research status: `RESEARCH_CLOSED`
- Final verdict: `NO_VALID_PROFITABLE_EMAIL_STRATEGY`

## Research scope

V5 through V11 are complete and archived. Every Email Promotion gate failed or remained ineligible; no researched strategy is approved for Production Email promotion.

The research program is closed. Do not start V11.1 or V12, perform parameter or threshold tuning, or start new ML tuning unless a new, explicitly authorized research project is opened.

The following evidence remains preserved and auditable: historical reports, candidate registries, frozen manifests, CI evidence, V5.5 Forward Shadow #002 evidence, paper trades, feature snapshots, and universe snapshots. No historical evidence was deleted or backfilled.

## V5.5 Forward Shadow #002

- Experiment: `v55-fbos02-forward-002`
- Final status: `STOPPED`
- Effective stopped_at: `2026-08-27T03:32:07.083939Z`
- Stop reason: `RESEARCH_CLOSED_NO_PROMOTABLE_STRATEGY`
- The existing schema has no `stopped_at` or `stop_reason` columns. The effective stop time above is the existing row `updated_at`; the stop reason is recorded here as the immutable closeout decision.
- `forward_start_timestamp` was not changed: `2026-08-25T23:59:59.999Z`
- `strategy_version` was not changed: `failed-breakout-short-02-shadow-v1`
- `strategy_manifest_hash` was not changed: `ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305`
- Runtime identity was not changed: `a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d`
- No experiment was recreated and no `#003` experiment was created.

## Post-stop write verification

The existing Vault-backed scan path was invoked after the stop without exposing a secret. The stop guard reported that the experiment was stopped and the Production scan continued. The latest scan completed with `error_summary = []`.

The pre-stop evidence sample was:

- Universe snapshots for #002: `440`
- Feature snapshots for #002: `10,986`
- Shadow trades for #002: `13`

The status transition occurred while a four-batch scan group was already in flight. Its completed final counts were:

- Universe snapshots for #002: `444`
- Feature snapshots for #002: `11,086`
- Shadow trades for #002: `13`

The exact stop-time audit found `0` universe rows and `0` shadow trades created after the status transition. It found `30` feature rows completing after the transition, all belonging to the already-started scan group (scan IDs were created before the stop). No later stop-guarded verification increased any of the three counters.

Therefore the post-stop result is:

- New universe writes: `0`
- New feature writes: `0` after the in-flight group drained
- New #002 shadow-trade writes: `0`

This closeout does not delete or alter the in-flight evidence. The scheduler remains available for other existing Production/Paper paths; it was not globally disabled.

## Production boundary

- Production branch: `agent/shadow-entry-deployment`
- Production branch SHA: `a7e55bc3ba865c50ef0ff7988ec41f28c7e6749d` (unchanged)
- Production strategy remains `trend-rejection-short-v1`.
- Production Email remains `OFF / BLOCKED`.
- Health Gate remains unchanged.
- Auto trading, Binance private API use, order placement, position management, strategy replacement, and automatic promotion remain disabled.
- No Production deployment, merge, migration, environment-variable change, or new experiment was performed for this closeout.
