import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SUMMARY_PATH = resolve("reports", "validation-v5-signal-edge-summary.json");
const REQUIRED_STRATEGIES = ["CURRENT_PRODUCTION", "TREND_REJECTION_RESEARCH", "V5_SHORT", "V5_LONG"];
const REQUIRED_METRICS = [
  "trades",
  "winRate",
  "averageNetR",
  "medianNetR",
  "profitFactor",
  "netR",
  "maxDrawdownPercent",
  "cvar95",
  "positiveFolds",
  "positiveMonths",
  "foldsEvaluated",
  "monthsObserved",
  "symbolBreadth",
  "regimeBreadth",
  "topSymbolProfitShare",
  "topThreeSymbolProfitShare",
  "profitConcentrationHhi",
  "averageMFE24h",
  "averageMFE72h",
  "averageMAE24h",
  "averageMAE72h",
  "rFirst24h",
  "rFirst72h",
  "stressNetR",
];

async function main() {
  let report: any;
  try {
    report = JSON.parse(await readFile(SUMMARY_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read committed V5 validation summary at ${SUMMARY_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(report?.schemaVersion === "v5-signal-edge-validation-summary.v2", "schemaVersion");
  assert(report?.command === "pnpm validate:v5", "command");
  assert(report?.baseline?.productionBaseSha === "1a6f0663e4dfe71869373cb41863856581713a7c", "production base SHA");
  assert(report?.baseline?.v5BaseSha === "1a6f0663e4dfe71869373cb41863856581713a7c", "V5 base SHA");
  assert(report?.history?.holdoutUsedForSelection === false, "holdoutUsedForSelection must be false");
  assert(Number(report?.history?.years) >= 1, "at least one year of history");
  assert(Number(report?.history?.symbolCount) >= 50, "at least 50 symbols");
  assert(Array.isArray(report?.history?.folds) && report.history.folds.length > 0, "purged folds");
  assert(report.history.folds.every((fold: any) => Number(fold.purgeHours) >= 72), "purge >= 72h");
  assert(report?.history?.holdout?.start && report?.history?.holdout?.end, "frozen holdout");

  assert(Number.isFinite(report?.costs?.takerFeeRate), "taker fee assumption");
  assert(Number.isFinite(report?.costs?.baseSlippageBps), "base slippage assumption");
  for (const bps of [5, 10, 20]) assert(report.costs.stressSlippageBps.includes(bps), `${bps}bps stress assumption`);
  for (const delay of ["T0", "T+5m", "T+15m"]) assert(report.costs.delayScenarios.includes(delay), `${delay} delay assumption`);
  assert(Number(report?.costs?.maxHoldHours) >= 72, "max hold assumption");
  const control = report?.validationProfiles?.CONTROL_OPTIONS;
  const research = report?.validationProfiles?.V5_RESEARCH_OPTIONS;
  assert(control?.minScore === 70, "Control minScore must be 70");
  assert(control?.sideFilter === "SHORT", "Control side must be SHORT");
  assert(JSON.stringify(control?.strategyFamilies) === JSON.stringify(["TREND"]), "Control strategy family must be TREND");
  assert(control?.requireRegimeAlignment === true, "Control regime alignment");
  assert(control?.maxConcurrentPositions === 1 && control?.cooldownHours === 8 && control?.entryIntervalHours === 1, "Control portfolio timing");
  assert(research?.minScore === 0 && research?.sideFilter === "BOTH", "V5 research direction/score profile");
  assert(research?.requireFundingData === true, "V5 research funding requirement");

  const strategies = new Map<string, any>((report.strategies ?? []).map((strategy: any) => [strategy.id, strategy] as [string, any]));
  for (const id of REQUIRED_STRATEGIES) {
    const strategy = strategies.get(id);
    assert(strategy, `strategy ${id}`);
    const metrics = strategy.frozenHoldout;
    for (const key of REQUIRED_METRICS) assert(Object.prototype.hasOwnProperty.call(metrics, key), `${id}.${key}`);
    for (const bps of ["5bps", "10bps", "20bps"]) assert(Number.isFinite(strategy.stress?.[bps]), `${id}.stress.${bps}`);
    for (const delay of ["T0", "T+5m", "T+15m"]) {
      assert(Number.isFinite(strategy.executionDelay?.[delay]?.netR), `${id}.executionDelay.${delay}.netR`);
      assert(Number.isFinite(strategy.executionDelay?.[delay]?.trades), `${id}.executionDelay.${delay}.trades`);
    }
    assert(["APPROVED", "SHADOW_ONLY", "REJECTED"].includes(strategy.promotion?.status), `${id}.promotion.status`);
  }
  console.info(JSON.stringify({ ok: true, summaryPath: SUMMARY_PATH, strategies: REQUIRED_STRATEGIES }, null, 2));
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`V5 validation integrity check failed: ${label}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
