# V5.4 Point-in-Time Universe Audit

- Status: **INCOMPLETE**
- Source: https://s3-ap-northeast-1.amazonaws.com/data.binance.vision/data/futures/um/monthly/klines/
- Retrieved: 2026-08-25T00:04:58.598Z
- Root archive USDT-M symbols: 832
- Local validation symbols with 15m monthly evidence: 50/50

## Method
- The Binance Data Vision monthly futures kline archive index is the public symbol universe source; it includes historical objects for symbols no longer in current exchangeInfo.
- Only USDT-M symbols ending in USDT are retained; *_USDTSETTLED and non-USDT contracts are excluded.
- 15m monthly object presence is treated as observed data availability, not as an exact listing or delisting event.
- The first and last observed months are excluded from effective tradability to prevent intra-month boundary leakage.
- Fold-specific membership is evaluated at each trade timestamp from the immutable local manifest; no current-live symbol list is backfilled into history.

## Limitations
- The public archive index does not provide a historical exchangeInfo contractStatus snapshot for each timestamp.
- Exact listing_date, delisting_date, and tradable_start/end are unavailable at daily precision; fields remain null and month precision is recorded.
- Only symbols with local kline evidence are used for the fixed-candidate replay; the full archive root symbol set is not silently treated as locally validated data.

## Boundary rule
The first and last observed archive months are excluded from effective membership. Exact listing_date, delisting_date and historical contractStatus remain unavailable, so this report is not a Promotion verification.
