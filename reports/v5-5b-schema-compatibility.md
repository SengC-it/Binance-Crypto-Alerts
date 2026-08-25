# V5.5B Schema Compatibility

Preparation-time read-only audit for Supabase project `jfvbikivtpfjgfsnggiz`.

| Compatibility check | Result |
| --- | --- |
| `public.bca_scan_runs` exists | PASS |
| `public.bca_scan_groups` exists | PASS |
| `public.bca_instruments` exists | PASS |
| `public.bca_shadow_paper_trades` exists | PASS |
| `bca_scan_runs.id` is compatible with the prepared foreign key | PASS |
| `bca_scan_groups.scan_group_key` is compatible with the prepared foreign key | PASS |
| `bca_instruments.symbol` is compatible with the prepared foreign key | PASS |
| Required legacy Shadow entry columns exist | PASS |
| `bca_shadow_paper_trades.metadata` is JSON-compatible | PASS |
| Existing `bca_set_updated_at()` function exists | PASS |
| Existing `updated_at` triggers remain present | PASS |
| Legacy Shadow rows were read-only audited | PASS |
| Legacy Shadow rows were modified by preparation | PASS |
| V5.5 forward tables remain absent before migration | PASS |
| Prepared migration has no destructive DDL | PASS |
| Prepared migration has RLS and service-role-only grants | PASS |
| Prepared migration has immutable evidence guards | PASS |
| Prepared migration is rerunnable by construction | PASS |

The forward tables were not present in the production schema at audit time; no migration was applied and no rows were written. The existing legacy Shadow ledger was observed read-only (45 rows) and remained unchanged.
