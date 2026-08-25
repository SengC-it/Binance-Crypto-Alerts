# V5.5A Evidence Schema

- Schema: `SignalFeatureSnapshotV2`
- Strategy manifest hash: `ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305`
- Snapshot rows are insert-only and carry a deterministic `snapshotHash`.
- Captured inputs: scan/source timestamps, 15m/1h/4h close times, symbol status, quote volume, exchange filters, candle counts/timestamps/hashes, feature values, raw trigger, rejection reasons, decision flags, trade plan, cost assumptions, runtime SHA, and manifest hash.
- Snapshot serializer is allow-listed. API secrets, SMTP passwords, Supabase keys, CRON secrets, authorization headers, and private Binance credentials are rejected from the persisted shape.
- V5.5 shadow trades reuse `public.bca_shadow_paper_trades` with additive provenance columns. Entry-side fields are immutable after creation; settlement fields remain mutable only for the existing settlement lifecycle.
- Legacy shadow rows are not forward evidence.
