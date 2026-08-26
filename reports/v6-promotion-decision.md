# V6.0 Strategy Reset & Final Robustness Bake-off

Baseline: **4925d1b819770149a98c7014ef984fd1dba1a89c**; research-only; V5.5 through V5.9.1 frozen.
Best diagnostic Pareto representative: **CROSS_SECTIONAL_MOMENTUM / V6-B-CSM-5 / LONG**.
EMAIL_PROMOTION_CANDIDATE: **FAIL**.
Research stop: **YES**.

## Validation boundary
Validation A and Validation B are independent manifests. DATA_INSUFFICIENT is not converted into a pass and old V5 holdouts are not reused.

## Hard boundary
- Production: NO change
- #002: NO change
- Production email: NO change
- Deployment: NO
- Merge: NO
- Migration: NO
- Auto trading: NO
- V5.5-V5.9.1: FROZEN
