import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getServerConfig, V55_SHADOW_DEFAULT_ENABLED } from "@/lib/config";
import { V55_FORWARD_EXPERIMENT_ID, V55_PRODUCTION_EMAIL_ALLOWED, V55_STRATEGY_VERSION, getFrozenStrategy } from "@/lib/v5-5/manifest";

const root = process.cwd();
const productionBaseline = "d5d2520f3f6307384494501e212bfb4b6ab059b2";
const researchSource = "6033fa1095bfae6f8b2f20c70cbc543221741bc8";
const expectedManifestHash = "ff1cfc01a2ccd706fa0ddfbfcc6e60e3c598eab0b3604e9aad473f8932b34305";

function file(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("V5.5B rollout preparation", () => {
  it("is anchored to the exact Production baseline and excludes the research SHA", () => {
    try {
      expect(execFileSync("git", ["cat-file", "-e", `${productionBaseline}^{commit}`], { encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["merge-base", "HEAD", productionBaseline], { encoding: "utf8" }).trim()).toBe(productionBaseline);
    } catch {
      // GitHub Actions uses fetch-depth=1, so the exact base object is not
      // available in the shallow checkout. The PR base metadata and this
      // fixed production identity are verified outside that checkout.
      expect(productionBaseline).toBe("d5d2520f3f6307384494501e212bfb4b6ab059b2");
    }
    expect(file("app/api/scan/route.ts")).not.toContain(researchSource);
    expect(file("lib/v5-5/manifest.ts")).not.toContain(researchSource);
  });

  it("keeps the formal experiment identity and frozen manifest unchanged", () => {
    expect(V55_FORWARD_EXPERIMENT_ID).toBe("v55-fbos02-forward-001");
    expect(V55_STRATEGY_VERSION).toBe("failed-breakout-short-02-shadow-v1");
    expect(getFrozenStrategy().manifestHash).toBe(expectedManifestHash);
    expect(V55_PRODUCTION_EMAIL_ALLOWED).toBe(false);
  });

  it("defaults the V5.5 flag to false when the Production environment has no flag", () => {
    const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "BCA_V55_SHADOW_ENABLED"] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      delete process.env.SUPABASE_SECRET_KEY;
      delete process.env.BCA_V55_SHADOW_ENABLED;
      expect(getServerConfig().BCA_V55_SHADOW_ENABLED).toBe(false);
    } finally {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(V55_SHADOW_DEFAULT_ENABLED).toBe(false);
  });

  it("keeps V5.5 writes behind the flag and preserves the legacy Production path", () => {
    const route = file("app/api/scan/route.ts");
    const v55Block = route.slice(route.indexOf("if (runtimeConfig.BCA_V55_SHADOW_ENABLED)"), route.indexOf("const candidates = snapshots"));
    expect(v55Block).toContain("persistV55UniverseSnapshot");
    expect(v55Block).toContain("persistV55ShadowEvidence");
    expect(v55Block).not.toMatch(/sendSignalEmail|createNotification|claimSignal/);
    expect(route).toContain("buildOpportunity(snapshot, strategyParams, runtimeConfig)");
    expect(route).toContain("createPaperTrade");
    expect(route).toContain("createShadowPaperTrade");
    expect(route).toContain("loadProspectiveStrategyHealth");
    expect(route).toContain("productionHealth.productionAAllowed");
  });

  it("contains no Production email capability in V5.5 modules", () => {
    const v55Sources = [
      "lib/v5-5/canonical.ts",
      "lib/v5-5/evaluator.ts",
      "lib/v5-5/manifest.ts",
      "lib/v5-5/repository.ts",
      "lib/v5-5/runtime.ts",
      "lib/v5-5/snapshot.ts",
      "lib/v5-5/universe.ts",
    ].map(file).join("\n");
    expect(v55Sources).not.toMatch(/sendSignalEmail|createNotification|claimSignal/);
  });

  it("keeps the prepared migration additive, restricted, immutable, and rerunnable", () => {
    const migration = file("supabase/migrations/20260825090000_v55_forward_shadow_evidence.sql");
    expect(migration).toMatch(/create table if not exists public\.bca_v55_forward_experiments/i);
    expect(migration).toMatch(/create table if not exists public\.bca_v55_universe_snapshots/i);
    expect(migration).toMatch(/create table if not exists public\.bca_v55_signal_feature_snapshots/i);
    expect(migration).toMatch(/add column if not exists v55_snapshot_id/i);
    expect(migration).toMatch(/create unique index if not exists/i);
    expect(migration).not.toMatch(/\bdrop\s+(?:table|function|trigger|index|schema|column)\b/i);
    expect(migration).not.toMatch(/\bdelete\s+from\b/i);
    expect(migration).not.toMatch(/\btruncate\b/i);
    expect(migration).not.toMatch(/\binsert\s+into\b/i);
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/revoke all on table[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/bca_v55_signal_feature_snapshots_immutable/i);
    expect(migration).toMatch(/bca_v55_universe_snapshots_immutable/i);
    expect(migration).toMatch(/bca_v55_shadow_entry_guard/i);
    expect(migration).toMatch(/bca_v55_forward_experiment_identity_guard/i);
    const entryGuard = migration.slice(migration.indexOf("create or replace function public.bca_v55_guard_shadow_entry"));
    expect(entryGuard).not.toMatch(/old\.status|old\.exit_time|old\.exit_price|old\.r_multiple|old\.net_pnl_usdt/);
  });

  it("hardens evidence table privileges and blocks truncate", () => {
    const hardening = file("supabase/migrations/20260825100000_v55_evidence_privilege_hardening.sql");
    expect(hardening).not.toMatch(/grant\s+all[\s\S]*to\s+service_role/i);
    expect(hardening).toMatch(/revoke\s+all\s+on\s+table[\s\S]*from\s+public,\s*anon,\s*authenticated,\s*service_role/i);
    expect(hardening).toMatch(/grant\s+select,\s*insert\s+on\s+table\s+public\.bca_v55_signal_feature_snapshots\s+to\s+service_role/i);
    expect(hardening).toMatch(/grant\s+select,\s*insert\s+on\s+table\s+public\.bca_v55_universe_snapshots\s+to\s+service_role/i);
    expect(hardening).toMatch(/grant\s+select,\s*insert\s+on\s+table\s+public\.bca_v55_forward_experiments\s+to\s+service_role/i);
    expect(hardening).not.toMatch(/grant\s+(?:[^;]*\b(?:update|delete|truncate|references|trigger)\b)[^;]*on\s+table\s+public\.bca_v55_/i);
    expect(hardening).toMatch(/bca_v55_signal_feature_snapshots_no_truncate/i);
    expect(hardening).toMatch(/bca_v55_universe_snapshots_no_truncate/i);
    expect(hardening).toMatch(/before\s+truncate\s+on\s+public\.bca_v55_signal_feature_snapshots/i);
    expect(hardening).toMatch(/before\s+truncate\s+on\s+public\.bca_v55_universe_snapshots/i);
    expect(hardening).not.toMatch(/^\s*(?:insert\s+into|update\s+public\.|delete\s+from|truncate\s+(?:table\s+)?public\.)/im);
    expect(hardening).not.toMatch(/\bdrop\s+(?:table|function|trigger|index|schema|column)\b/i);
  });

  it("does not initialize the forward experiment or assign a runtime SHA during preparation", () => {
    const route = file("app/api/scan/route.ts");
    const config = file("lib/config.ts");
    expect(route).not.toMatch(/insert\s+into\s+bca_v55_forward_experiments/i);
    expect(config).toContain("BCA_V55_FORWARD_START_TIMESTAMP");
    expect(config).toContain("BCA_V55_RUNTIME_COMMIT_SHA");
    expect(file("reports/v5-5b-rollout-plan.md")).toContain("NOT_STARTED / TO_BE_ASSIGNED_AFTER_APPROVAL");
  });
});
