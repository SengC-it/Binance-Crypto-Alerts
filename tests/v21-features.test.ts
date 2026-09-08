import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  V21_BASE_SHA,
  V21_BOUNDARIES,
  V21_SYMBOLS,
  type V21Symbol,
} from "../lib/v21/constants";
import { canonicalTextSha256 } from "../lib/v21/canonical";
import {
  V21_PIT_OBSERVATION_COUNT,
  V21_PIT_WINDOW_MS,
  buildPitFeature,
  buildSynchronizedReturns,
  fitPitOls,
  leaveOneOutMedian,
  nearestRankQuantile,
  selectPitWindow,
  type V21CloseSeriesBySymbol,
  type V21ReturnRow,
} from "../lib/v21/features";

const interval = 5 * 60 * 1000;

describe("V21 PIT feature engine", () => {
  it("builds synchronized returns for all eight symbols", () => {
    const rows = buildSynchronizedReturns(closeSeries([0, interval, interval * 2]));
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0].returns)).toEqual([...V21_SYMBOLS]);
    expect(Object.values(rows[0].returns).every(Number.isFinite)).toBe(true);
  });

  it("omits a row when one symbol is missing at t", () => {
    const series = closeSeries([0, interval, interval * 2, interval * 3]);
    series.ETHUSDT = series.ETHUSDT.filter((point) => point.openTime !== interval * 2);
    const rows = buildSynchronizedReturns(series);
    expect(rows.map((row) => row.openTime)).toEqual([interval]);
  });

  it("omits a row when one symbol is missing at t-1", () => {
    const series = closeSeries([0, interval, interval * 2, interval * 3]);
    series.ETHUSDT = series.ETHUSDT.filter((point) => point.openTime !== interval);
    const rows = buildSynchronizedReturns(series);
    expect(rows.map((row) => row.openTime)).toEqual([interval * 3]);
  });

  it("uses the exact logarithmic return formula", () => {
    const series = closeSeries([0, interval]);
    series.BTCUSDT = [
      { openTime: 0, close: 100 },
      { openTime: interval, close: 110 },
    ];
    const rows = buildSynchronizedReturns(series);
    expect(rows[0].returns.BTCUSDT).toBe(Math.log(110 / 100));
  });

  it("strictly excludes the target from the leave-one-out market return", () => {
    const row = rowWithMarketValues(0, [100, 2, 3, 4, 5, 6, 7, 8]);
    expect(leaveOneOutMedian(row, "BTCUSDT")).toBe(5);
    expect(leaveOneOutMedian(row, "ADAUSDT")).toBe(6);
  });

  it("uses the exact seven-value median for every target", () => {
    const row = rowWithMarketValues(0, [1, 2, 3, 4, 5, 6, 7, 8]);
    const medians = V21_SYMBOLS.map((symbol) => leaveOneOutMedian(row, symbol));
    expect(medians).toEqual([5, 5, 5, 5, 4, 4, 4, 4]);
  });

  it("selects exactly 8640 PIT rows and excludes current t", () => {
    const priorRows = pitRows();
    const current = rowAt(V21_PIT_WINDOW_MS, 3, 999);
    const window = selectPitWindow([...priorRows, current], current.openTime);
    expect(window).toHaveLength(V21_PIT_OBSERVATION_COUNT);
    expect(window.at(-1)?.openTime).toBe(current.openTime - interval);
    expect(window.some((row) => row.openTime === current.openTime)).toBe(false);
  });

  it("calculates OLS intercept and beta with the fixed PIT sample", () => {
    const result = fitPitOls(pitRows(), "BTCUSDT");
    expect(result.eligible).toBe(true);
    expect(result.priorObservationCount).toBe(8640);
    expect(result.alpha).toBeCloseTo(0.5, 12);
    expect(result.beta).toBeCloseTo(2, 12);
  });

  it("returns INELIGIBLE for zero market variance", () => {
    const rows = Array.from({ length: V21_PIT_OBSERVATION_COUNT }, (_, index) => rowAt(index * interval, 5, 10));
    const result = fitPitOls(rows, "BTCUSDT");
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe("ZERO_MARKET_VARIANCE");
  });

  it("returns INELIGIBLE for a non-finite observation", () => {
    const rows = pitRows();
    rows[100].returns.BTCUSDT = Number.NaN;
    const result = fitPitOls(rows, "BTCUSDT");
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe("NON_FINITE_OBSERVATION");
  });

  it("uses the current-t model and excludes current t from OLS and Q99", () => {
    const priorRows = pitRows();
    const current = rowAt(V21_PIT_WINDOW_MS, 3, 999);
    const feature = buildPitFeature("BTCUSDT", current, priorRows.at(-1)!, priorRows);
    expect(feature.eligible).toBe(true);
    expect(feature.alpha).toBeCloseTo(0.5, 12);
    expect(feature.beta).toBeCloseTo(2, 12);
    expect(feature.residualAbsQ99).toBeCloseTo(0, 12);
    expect(feature.currentResidual).toBeCloseTo(992.5, 12);
  });

  it("rejects a PIT sample containing a current or future row", () => {
    const rows = pitRows();
    const current = rowAt(V21_PIT_WINDOW_MS, 3, 999);
    const contaminated = [...rows.slice(1), current];
    const feature = buildPitFeature("BTCUSDT", current, rows.at(-1)!, contaminated);
    expect(feature.eligible).toBe(false);
    expect(feature.ineligibleReason).toBe("PIT_WINDOW_NOT_EXACT");
  });

  it("uses one alpha and beta for every historical residual", () => {
    const priorRows = pitRows(100, 0.25);
    const current = rowAt(V21_PIT_WINDOW_MS, 3, 6.5);
    const feature = buildPitFeature("BTCUSDT", current, priorRows.at(-1)!, priorRows);
    expect(feature.eligible).toBe(true);
    expect(feature.currentResidual).toBeCloseTo(
      current.returns.BTCUSDT - (feature.alpha + feature.beta * feature.marketReturn),
      12,
    );
    expect(feature.residualAbsQ99).toBeGreaterThan(0);
  });

  it("implements nearest-rank Q99 without interpolation", () => {
    expect(nearestRankQuantile(Array.from({ length: 100 }, (_, index) => index + 1), 0.99)).toBe(99);
    expect(nearestRankQuantile([0, 10], 0.5)).toBe(0);
  });

  it("calculates previous residual with the current-t alpha and beta", () => {
    const priorRows = pitRows(V21_PIT_OBSERVATION_COUNT - 1, 0.4);
    const previous = priorRows.at(-1)!;
    const current = rowAt(V21_PIT_WINDOW_MS, 3, 6.5);
    const feature = buildPitFeature("BTCUSDT", current, previous, priorRows);
    expect(feature.previousResidual).toBeCloseTo(
      previous.returns.BTCUSDT - (feature.alpha + feature.beta * leaveOneOutMedian(previous, "BTCUSDT")),
      12,
    );
  });

  it("is deterministic and exposes no event or direction output", () => {
    const first = buildPitFeature("BTCUSDT", rowAt(V21_PIT_WINDOW_MS, 3, 999), pitRows().at(-1)!, pitRows());
    const second = buildPitFeature("BTCUSDT", rowAt(V21_PIT_WINDOW_MS, 3, 999), pitRows().at(-1)!, pitRows());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect("direction" in first).toBe(false);
    expect("event" in first).toBe(false);
    expect(existsSync("lib/v21/signals.ts")).toBe(false);
    expect(existsSync("reports/v21-result.json")).toBe(true);
    expect(existsSync("reports/v21-holdout.json")).toBe(false);
  });

  it("keeps WP1 artifacts and production boundaries unchanged", () => {
    const stageManifest = JSON.parse(readFileSync("reports/v21-data-stage-manifest.json", "utf8")) as Record<string, unknown>;
    expect(stageManifest.baseSha).toBe(V21_BASE_SHA);
    expect(stageManifest.archiveManifestSha256).toBe("5ac81354e12033017f68b08e05a0d1da0c11eb3fc0088af80418232387dcd452");
    expect(stageManifest.parserReportSha256).toBe("ecdf62a144a317658ac04dc9c5d6e1944190ed4158e4bfa01fd37c0464ed307e");
    expect(stageManifest.dataGateSha256).toBe("878f6a3969b9da34d9958e97518686c533740936ece0708941f08b1e2d1b4d6e");
    expect(stageManifest.manifestBodySha256).toBe("a3de9ecada560d2b3beb8c6319751f1144e26c93d03911d26a5c4fca7aa1fb5f");
    expect(canonicalTextSha256(readFileSync("reports/v21-archive-manifest.json", "utf8"))).toBe(stageManifest.archiveManifestSha256);
    expect(canonicalTextSha256(readFileSync("reports/v21-parser-report.json", "utf8"))).toBe(stageManifest.parserReportSha256);
    expect(canonicalTextSha256(readFileSync("reports/v21-data-gate.json", "utf8"))).toBe(stageManifest.dataGateSha256);
    expect(V21_BOUNDARIES.productionChanged).toBe(false);
    expect(V21_BOUNDARIES.productionEmail).toBe("OFF");
    expect(V21_BOUNDARIES.autoTrading).toBe(false);
  });
});

function closeSeries(times: readonly number[]): V21CloseSeriesBySymbol {
  const result = {} as V21CloseSeriesBySymbol;
  V21_SYMBOLS.forEach((symbol, symbolIndex) => {
    result[symbol] = times.map((openTime, timeIndex) => ({
      openTime,
      close: 100 + symbolIndex * 10 + timeIndex,
    }));
  });
  return result;
}

function rowAt(openTime: number, marketReturn: number, assetReturn: number): V21ReturnRow {
  const returns = {} as Record<V21Symbol, number>;
  V21_SYMBOLS.forEach((symbol) => {
    returns[symbol] = symbol === "BTCUSDT" ? assetReturn : marketReturn;
  });
  return { openTime, returns };
}

function rowWithMarketValues(openTime: number, values: readonly number[]): V21ReturnRow {
  const returns = {} as Record<V21Symbol, number>;
  V21_SYMBOLS.forEach((symbol, index) => {
    returns[symbol] = values[index];
  });
  return { openTime, returns };
}

function pitRows(residualIndex = -1, residual = 0): V21ReturnRow[] {
  return Array.from({ length: V21_PIT_OBSERVATION_COUNT }, (_, index) => {
    const market = (index % 17) + 1;
    return rowAt(index * interval, market, 0.5 + 2 * market + (index === residualIndex ? residual : 0));
  });
}
