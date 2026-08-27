import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { V55_SHADOW_DEFAULT_ENABLED } from "@/lib/config";

const finalizationMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260827150000_scan_finalization_v55_retention.sql"),
  "utf8",
);
const originalV55Migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260825090000_v55_forward_shadow_evidence.sql"),
  "utf8",
);
const scanRoute = readFileSync(resolve(process.cwd(), "app/api/scan/route.ts"), "utf8");

function finalizationFunction(): string {
  const match = finalizationMigration.match(
    /create or replace function public\.bca_try_finalize_scan_group\(p_scan_group_key text\)[\s\S]*?\n\$\$;/i,
  );
  if (!match) throw new Error("finalization function not found in migration");
  return match[0];
}

describe("P0 scan finalization and V5.5 retention guard", () => {
  it("does not perform cross-scan-group retention deletion", () => {
    const body = finalizationFunction();

    expect(body.toLowerCase()).not.toMatch(/delete\s+from/);
    expect(body).toContain("where scan_group_key = p_scan_group_key");
    expect(body).toContain("for update");
    expect(body).toContain("update public.bca_scan_groups");
  });

  it("finalizes only the requested group, so immutable evidence in other groups is not touched", () => {
    const body = finalizationFunction();

    expect(body).toContain("where scan_group_key = p_scan_group_key");
    expect(body).not.toContain("created_at < now() - interval '2 days'");
    expect(body).not.toMatch(/delete\s+from\s+public\.bca_(scan_groups|scan_runs|scan_candidates|shadow_candidates)/i);
  });

  it("makes the V5.5 parent scan-group and scan-run relationships restrictive", () => {
    expect(finalizationMigration).toMatch(
      /add constraint bca_v55_universe_snapshots_scan_group_key_fkey[\s\S]*?references public\.bca_scan_groups\(scan_group_key\)[\s\S]*?on delete restrict/i,
    );
    expect(finalizationMigration).toMatch(
      /add constraint bca_v55_universe_snapshots_scan_id_fkey[\s\S]*?references public\.bca_scan_runs\(id\)[\s\S]*?on delete restrict/i,
    );
    expect(finalizationMigration).toMatch(
      /add constraint bca_v55_signal_feature_snapshots_scan_id_fkey[\s\S]*?references public\.bca_scan_runs\(id\)[\s\S]*?on delete restrict/i,
    );
  });

  it("leaves immutable evidence triggers intact and does not disable them", () => {
    expect(finalizationMigration.toLowerCase()).not.toContain("drop trigger");
    expect(finalizationMigration.toLowerCase()).not.toContain("disable trigger");
    expect(originalV55Migration).toContain("bca_v55_signal_feature_snapshots_immutable");
    expect(originalV55Migration).toContain("bca_v55_universe_snapshots_immutable");
    expect(originalV55Migration).toContain("bca_v55_guard_shadow_entry");
  });

  it("keeps stopped V5.5 evidence behind the disabled-by-default runtime gate", () => {
    expect(V55_SHADOW_DEFAULT_ENABLED).toBe(false);
    expect(scanRoute).toContain("if (runtimeConfig.BCA_V55_SHADOW_ENABLED)");
    expect(scanRoute).toContain("persistV55UniverseSnapshot");
  });
});
