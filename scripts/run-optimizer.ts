import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getServerConfig } from "@/lib/config";
import { createParameterGrid, optimizeDatasets } from "@/lib/backtest/optimizer";
import type { HistoricalDataset } from "@/lib/backtest/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

async function main() {
  const config = getServerConfig();
  const dataDirectory = resolve(process.env.CS_OPTIMIZER_DATA_DIR ?? "data/raw");
  const datasets = await loadDatasets(dataDirectory);
  if (datasets.length === 0) {
    throw new Error(`No optimizer datasets found in ${dataDirectory}`);
  }

  const variants = createParameterGrid();
  const results = optimizeDatasets(datasets, variants);
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
      out_of_sample: best.outOfSample,
      dataset_count: best.datasetCount,
      variant_count: variants.length,
      minimum_sample_days: 365,
      max_drawdown_cap_percent: 30,
    },
    status: best.eligible ? "ACTIVE" : "DRAFT",
  }, { onConflict: "version" });
  if (versionError) throw new Error(`Strategy version write failed: ${versionError.message}`);

  const { error: runError } = await supabase.from("bca_backtest_runs").insert({
    strategy_version: version,
    universe_definition: { symbols: datasets.map((dataset) => dataset.symbol), source: "local_raw" },
    parameter_set: best.params,
    train_window: { months: 9 },
    validation_window: {},
    out_of_sample_window: { months: 3 },
    metrics: { train: best.train, out_of_sample: best.outOfSample, eligible: best.eligible },
    status: "COMPLETED",
    finished_at: new Date().toISOString(),
  });
  if (runError) throw new Error(`Backtest result write failed: ${runError.message}`);

  console.info(JSON.stringify({
    ok: true,
    dataDirectory,
    datasetCount: datasets.length,
    variantCount: variants.length,
    version,
    eligible: best.eligible,
    train: best.train,
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
