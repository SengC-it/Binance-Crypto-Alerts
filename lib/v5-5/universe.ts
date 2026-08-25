import type { ExchangeUniverseSnapshot } from "@/lib/binance/public-client";
import type { Instrument } from "@/lib/core/types";
import { canonicalJson, sha256 } from "./canonical";

export interface V55InstrumentCapture {
  symbol: string;
  quoteAsset: string;
  contractType: string;
  contractStatus: string;
  onboardDate: string | null;
  quoteVolume24h: number | null;
  filters: {
    tickSize: number | null;
    stepSize: number | null;
    minQty: number | null;
    minNotional: number | null;
    pricePrecision: number | null;
    quantityPrecision: number | null;
  };
}

export interface V55UniverseSnapshot {
  schema: "V55UniverseSnapshot";
  schemaVersion: "1";
  scanId: string;
  scanGroupKey: string;
  scanTimestamp: string;
  consideredSymbols: V55InstrumentCapture[];
  eligibleSymbols: V55InstrumentCapture[];
  excludedSymbols: Array<V55InstrumentCapture & { exclusionReason: string }>;
  selectedForEvaluation: string[];
  snapshotHash: string;
}

export function buildUniverseSnapshot(input: {
  scanId: string;
  scanGroupKey: string;
  scanTimestamp: number;
  observed: ExchangeUniverseSnapshot;
  selectedForEvaluation: string[];
}): V55UniverseSnapshot {
  const body = {
    schema: "V55UniverseSnapshot" as const,
    schemaVersion: "1" as const,
    scanId: input.scanId,
    scanGroupKey: input.scanGroupKey,
    scanTimestamp: new Date(input.scanTimestamp).toISOString(),
    consideredSymbols: input.observed.allSymbols.map(captureInstrument).sort(bySymbol),
    eligibleSymbols: input.observed.eligibleSymbols.map(captureInstrument).sort(bySymbol),
    excludedSymbols: input.observed.excludedSymbols
      .map(({ instrument, reason }) => ({ ...captureInstrument(instrument), exclusionReason: reason }))
      .sort(bySymbol),
    selectedForEvaluation: [...new Set(input.selectedForEvaluation)].sort(),
  };
  return {
    ...body,
    snapshotHash: sha256(canonicalJson(body)),
  };
}

function captureInstrument(instrument: Instrument): V55InstrumentCapture {
  return {
    symbol: instrument.symbol,
    quoteAsset: instrument.quoteAsset,
    contractType: instrument.contractType,
    contractStatus: instrument.status,
    onboardDate: instrument.onboardDate === undefined ? null : new Date(instrument.onboardDate).toISOString(),
    quoteVolume24h: instrument.quoteVolume24h ?? null,
    filters: {
      tickSize: instrument.priceTick ?? null,
      stepSize: instrument.quantityStep ?? null,
      minQty: instrument.minQuantity ?? null,
      minNotional: instrument.minNotional ?? null,
      pricePrecision: instrument.pricePrecision ?? null,
      quantityPrecision: instrument.quantityPrecision ?? null,
    },
  };
}

function bySymbol(left: { symbol: string }, right: { symbol: string }): number {
  return left.symbol.localeCompare(right.symbol);
}
