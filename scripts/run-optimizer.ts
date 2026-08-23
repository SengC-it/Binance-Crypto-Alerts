import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getServerConfig } from "@/lib/config";
import { createParameterGrid, optimizeDatasets } from "@/lib/backtest/optimizer";
import type { HistoricalDataset } from "@/lib/backtest/types";
import type { BacktestContext } from "@/lib/backtest/engine";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { DEFAULT_V5_POLICY } from "@/lib/core/policy-registry";

async function main() {
  const config = getServerConfig();
  const dataDirectory = resolve(process.env.CS_OPTIMIZER_DATA_DIR ?? "data/raw");
  const datasets = await loadDatasets(dataDirectory);
  if (datasets.length === 0) {
    throw new Error(`No optimizer datasets found in ${dataDirectory}`);
  }

  const variants = createParameterGrid();
  const benchmarkDataset = datasets.find((dataset) => dataset.symbol === "BTCUSDT") ?? datasets[0];
  const results = optimizeDatasets(datasets, variants, { benchmarkDataset } satisfies BacktestContext);
  const best = results[0];
  if (!best) throw new Error("Optimizer produced no result");

  const supabase = getSupabaseAdmin();
  const version = `grid-${new Date().toISOString().slice(0, 10)}-${hashParams(best.params)}`;
  const { error: versionError } = await supabase.from("bca_strategy_versions").upsert({
    version,
    strategy_family: "ENSEMBLE_RULES",
    parameters: best.params,
    metrics: {
      train: best.train,
      validation: best.validation,
      out_of_sample: best.outOfSample,
      dataset_count: best.datasetCount,
      variant_count: variants.length,
      minimum_sample_days: 365,
      max_drawdown_cap_percent: 30,
    },
    // The legacy table is retained for historical compatibility. Promotion
    // state is now owned by bca_policy_registry below.
    status: "DRAFT",
  }, { onConflict: "version" });
  if (versionError) throw new Error(`Strategy version write failed: ${versionError.message}`);

  for (const result of results) {
    const policyVersion = result === best ? version : `grid-${new Date().toISOString().slice(0, 10)}-${hashParams(result.params)}`;
    const { error: policyError } = await supabase.from("bca_policy_registry").upsert({
      policy_version: policyVersion,
      strategy_params: result.params,
      supported_directions: ["LONG", "SHORT"],
      direction_approval: { LONG: "CANDIDATE", SHORT: "CANDIDATE" },
      entry_policy: DEFAULT_V5_POLICY.entryPolicy,
      regime_policy: DEFAULT_V5_POLICY.regimePolicy,
      no_chase_policy: DEFAULT_V5_POLICY.noChasePolicy,
      universe_policy: DEFAULT_V5_POLICY.universePolicy,
      calibration_model: null,
      expected_edge_model: null,
      cost_model_version: DEFAULT_V5_POLICY.costModelVersion,
      train_window: { months: 6, purge_hours: 72 },
      validation_window: { months: 3, purge_hours: 72 },
      holdout_window: { frozen: true },
      validation_metrics: { train: result.train, validation: result.validation, holdout: result.outOfSample },
      status: result.eligible ? "CANDIDATE" : "REJECTED",
    }, { onConflict: "policy_version" });
    if (policyError) throw new Error(`Policy registry write failed: ${policyError.message}`);
  }

  const { error: runError } = await supabase.from("bca_backtest_runs").insert({
    strategy_version: version,
    universe_definition: { symbols: datasets.map((dataset) => dataset.symbol), source: "local_raw" },
    parameter_set: best.params,
    train_window: { months: 6, purge_hours: 72 },
    validation_window: { months: 3, purge_hours: 72 },
    out_of_sample_window: { months: 3 },
    metrics: { train: best.train, validation: best.validation, out_of_sample: best.outOfSample, eligible: best.eligible },
    policy_version: version,
    holdout_frozen: true,
    status: "COMPLETED",
    finished_at: new Date().toISOString(),
  });
  if (runError) throw new Error(`Backtest result write failed: ${runError.message}`);

  console.info(JSON.stringify({
    ok: true,
    dataDirectory,
    datasetCount: datasets.length,
    variantCount: variants.length,
    policyRegistryCandidates: results.length,
    version,
    eligible: best.eligible,
    train: best.train,
    validation: best.validation,
    outOfSample: best.outOfSample,
    dryRun: config.CS_DRY_RUN,
  }, null, 2));
}

async function loadDatasets(directory: string): Promise<HistoricalDataset[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  return Promise.all(files.map(async (file) => {
    const raw = JSON.parse(await readFile(resolve(directory, file), "utf8")) as HistoricalDataset;
    if (!raw.symbol || !raw.instrument || !raw.candles?.["15m"]) {
      throw new Error(`Invalid optimizer dataset: ${file}`);
    }
    return raw;
  }));
}

function hashParams(params: object): string {
  const serialized = JSON.stringify(params);
  let hash = 0;
  for (const character of serialized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
