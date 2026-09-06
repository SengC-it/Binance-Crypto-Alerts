import { V20_END_EXCLUSIVE_TIMESTAMP, V20_INTERVAL_MS, V20_START_TIMESTAMP, type V20Symbol } from "./constants";
import type { V20Bar } from "./archive";

export interface V20SynchronizedSeries {
  symbol: V20Symbol;
  openTimes: number[];
  closeTimes: number[];
  lastOpens: number[];
  lastHighs: number[];
  lastLows: number[];
  lastCloses: number[];
  markCloses: number[];
  indexCloses: number[];
}
export interface V20SyncSummary {
  symbol: V20Symbol;
  expectedRows: number;
  regularRows: number;
  markRows: number;
  indexRows: number;
  synchronizedRows: number;
  synchronizedCoverage: number;
  missingRegularRows: number;
  missingMarkRows: number;
  missingIndexRows: number;
  duplicateOpenTimes: number;
  cadenceErrors: number;
  noNearestTimeJoin: true;
  noForwardFill: true;
}

export function synchronizeExact(
  symbol: V20Symbol,
  regular: readonly V20Bar[],
  mark: readonly V20Bar[],
  index: readonly V20Bar[],
): { series: V20SynchronizedSeries; summary: V20SyncSummary } {
  const openTimes: number[] = [];
  const closeTimes: number[] = [];
  const lastOpens: number[] = [];
  const lastHighs: number[] = [];
  const lastLows: number[] = [];
  const lastCloses: number[] = [];
  const markCloses: number[] = [];
  const indexCloses: number[] = [];
  let regularIndex = 0;
  let markIndex = 0;
  let indexIndex = 0;
  let duplicateOpenTimes = 0;
  let cadenceErrors = 0;
  const joined = (left: V20Bar, middle: V20Bar, right: V20Bar): void => {
    if (left.openTime !== middle.openTime || left.openTime !== right.openTime) throw new Error("internal exact-join mismatch");
    const previous = openTimes.at(-1);
    if (previous !== undefined && left.openTime !== previous + V20_INTERVAL_MS) cadenceErrors += 1;
    openTimes.push(left.openTime);
    closeTimes.push(left.closeTime);
    lastOpens.push(left.open);
    lastHighs.push(left.high);
    lastLows.push(left.low);
    lastCloses.push(left.close);
    markCloses.push(middle.close);
    indexCloses.push(right.close);
  };

  while (regularIndex < regular.length && markIndex < mark.length && indexIndex < index.length) {
    const regularTime = regular[regularIndex].openTime;
    const markTime = mark[markIndex].openTime;
    const indexTime = index[indexIndex].openTime;
    if (regularTime === markTime && regularTime === indexTime) {
      joined(regular[regularIndex], mark[markIndex], index[indexIndex]);
      regularIndex += 1;
      markIndex += 1;
      indexIndex += 1;
    } else {
      const next = Math.min(regularTime, markTime, indexTime);
      if (regularTime === next) regularIndex += 1;
      if (markTime === next) markIndex += 1;
      if (indexTime === next) indexIndex += 1;
    }
  }

  const expectedRows = Math.round((Date.parse(V20_END_EXCLUSIVE_TIMESTAMP) - Date.parse(V20_START_TIMESTAMP)) / V20_INTERVAL_MS);
  const series: V20SynchronizedSeries = {
    symbol,
    openTimes,
    closeTimes,
    lastOpens,
    lastHighs,
    lastLows,
    lastCloses,
    markCloses,
    indexCloses,
  };
  const summary: V20SyncSummary = {
    symbol,
    expectedRows,
    regularRows: regular.length,
    markRows: mark.length,
    indexRows: index.length,
    synchronizedRows: openTimes.length,
    synchronizedCoverage: expectedRows === 0 ? 0 : openTimes.length / expectedRows,
    missingRegularRows: Math.max(0, regular.length - openTimes.length),
    missingMarkRows: Math.max(0, mark.length - openTimes.length),
    missingIndexRows: Math.max(0, index.length - openTimes.length),
    duplicateOpenTimes,
    cadenceErrors,
    noNearestTimeJoin: true,
    noForwardFill: true,
  };
  return { series, summary };
}
