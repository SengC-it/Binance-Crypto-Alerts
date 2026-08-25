# V5.5A Executive Summary

1. Frozen strategy hash: `ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305` for `failed-breakout-short-02-shadow-v1`.
2. Production email protection: V5.5A writes only to the isolated Shadow evidence path; it never calls the Production claim/email path and the feature flag defaults to `false`.
3. Forward evidence start: the first approved rollout timestamp, supplied as `BCA_V55_FORWARD_START_TIMESTAMP`; current status is **NOT STARTED** and no backfill is allowed.
4. Point-in-time inputs: universe membership and exclusion reasons, contract status, quote volume, exchange filters, candle counts/timestamps/hashes, features, raw trigger/decision attrition, trade plan, costs, runtime SHA, and manifest hash.
5. Deterministic replay: yes for the allow-listed snapshot payload and frozen manifest; replay still requires the recorded public candle inputs identified by their hashes.
6. Missing evidence: no V5.5 prospective rows exist before rollout; at least 50 settled trades over 30 days are needed for the minimum observation target.
7. V5.5B minimum rollout: selectively port the listed runtime files, apply the additive migration, set the forward experiment/start timestamp, keep `BCA_V55_SHADOW_ENABLED=false` until approval, then enable only through a separately reviewed Production change.

Source code SHA recorded for this report: `3080519295ac246a099a21681ebe3d51c3cde3b3`.
Forward evaluator pre-rollout status: `INSUFFICIENT_FORWARD_EVIDENCE`.
