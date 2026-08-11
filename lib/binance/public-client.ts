import type { Candle, FundingRatePoint, Instrument, MarketSnapshot, Timeframe } from "@/lib/core/types";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type {
  BinanceExchangeInfo,
  BinanceExchangeSymbol,
  BinanceFundingRate,
  BinanceKline,
  BinanceTicker24h,
} from "./types";

configureNodeProxy();

const INTERVALS: Record<Timeframe, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
};

const INTERVAL_MS: Record<Timeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

const DEFAULT_REQUEST_DELAY_MS = 0;

export class BinancePublicClient {
  constructor(
    private readonly baseUrl = process.env.BINANCE_API_BASE_URL ?? "https://fapi.binance.com",
    private readonly timeoutMs = 12_000,
    private readonly requestDelayMs = configuredRequestDelayMs(),
  ) {}

  private nextRequestAt = 0;

  async getUniverse(): Promise<Instrument[]> {
    const [exchangeInfo, tickers] = await Promise.all([
      this.get<BinanceExchangeInfo>("/fapi/v1/exchangeInfo"),
      this.get<BinanceTicker24h[]>("/fapi/v1/ticker/24hr"),
    ]);
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));

    return exchangeInfo.symbols
      .filter(
        (symbol) =>
          symbol.status === "TRADING" &&
          symbol.contractType === "PERPETUAL" &&
          symbol.quoteAsset === "USDT",
      )
      .map((symbol) => this.toInstrument(symbol, tickerBySymbol.get(symbol.symbol)))
      .sort((left, right) => (right.quoteVolume24h ?? 0) - (left.quoteVolume24h ?? 0))
      .map((instrument, index) => ({ ...instrument, universeRank: index + 1 }));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 250): Promise<Candle[]> {
    const raw = await this.get<unknown[][]>("/fapi/v1/klines", {
      symbol,
      interval: INTERVALS[timeframe],
      limit: String(limit),
    });

    return raw
      .map(parseKline)
      .filter((candle) => candle.closeTime <= Date.now());
  }

  async getCandlesRange(
    symbol: string,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    const candles = new Map<number, Candle>();
    const intervalMs = INTERVAL_MS[timeframe];
    let cursor = startTime;
    let page = 0;

    while (cursor <= endTime && page < 10_000) {
      const raw = await this.get<unknown[][]>("/fapi/v1/klines", {
        symbol,
        interval: INTERVALS[timeframe],
        startTime: String(cursor),
        endTime: String(endTime),
        limit: "1500",
      });
      if (raw.length === 0) break;

      const parsed = raw
        .map(parseKline)
        .filter((candle) => candle.openTime >= startTime && candle.closeTime <= endTime && candle.closeTime <= Date.now());
      for (const candle of parsed) candles.set(candle.openTime, candle);

      const lastOpenTime = Number(raw.at(-1)?.[0]);
      if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor || raw.length < 1500) break;
      cursor = lastOpenTime + intervalMs;
      page += 1;
      await delay(40);
    }

    return [...candles.values()].sort((left, right) => left.openTime - right.openTime);
  }

  async getFundingRatesRange(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<FundingRatePoint[]> {
    const rates = new Map<number, FundingRatePoint>();
    let cursor = startTime;
    let page = 0;

    while (cursor <= endTime && page < 100) {
      const raw = await this.get<BinanceFundingRate[]>("/fapi/v1/fundingRate", {
        symbol,
        startTime: String(cursor),
        endTime: String(endTime),
        limit: "1000",
      });
      if (raw.length === 0) break;

      for (const point of raw) {
        const fundingTime = Number(point.fundingTime);
        const fundingRate = Number(point.fundingRate);
        if (Number.isFinite(fundingTime) && Number.isFinite(fundingRate)) {
          rates.set(fundingTime, { fundingTime, fundingRate });
        }
      }

      const lastFundingTime = Number(raw.at(-1)?.fundingTime);
      if (!Number.isFinite(lastFundingTime) || lastFundingTime < cursor || raw.length < 1000) break;
      cursor = lastFundingTime + 1;
      page += 1;
      await delay(40);
    }

    return [...rates.values()].sort((left, right) => left.fundingTime - right.fundingTime);
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const result = await this.get<{ symbol: string; price: string }>("/fapi/v1/ticker/price", {
      symbol,
    });
    return Number(result.price);
  }

  async getSnapshot(
    instrument: Instrument,
    timeframes: Timeframe[],
    limit = 250,
  ): Promise<MarketSnapshot> {
    const requestedTimeframes = Array.from(new Set(["15m" as Timeframe, ...timeframes]));
    const candleEntries = await Promise.all(
      requestedTimeframes.map(async (timeframe) => [timeframe, await this.getCandles(instrument.symbol, timeframe, limit)] as const),
    );
    const primaryCandles = candleEntries.find(([timeframe]) => timeframe === "15m")?.[1] ?? [];
    const tickerPrice = primaryCandles.at(-1)?.close
      ?? (await this.getTickerPrice(instrument.symbol));
    const sourceTimestamp = primaryCandles.at(-1)?.closeTime
      ?? candleEntries.flatMap(([, candles]) => candles).reduce((latest, candle) => Math.max(latest, candle.closeTime), 0);

    return {
      instrument,
      tickerPrice,
      candles: Object.fromEntries(candleEntries),
      // Signal identity follows the primary 15m candle. A higher timeframe can stay
      // unchanged for hours and must not suppress new 15m opportunities.
      sourceTimestamp,
    };
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.waitForRequestSlot();
        const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        const body = await response.text();
        if (!response.ok) {
          throw new BinanceApiError(response.status, body.slice(0, 500));
        }
        return JSON.parse(body) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof BinanceApiError && error.status < 500 && error.status !== 429) break;
        if (attempt < 2) await delay(250 * 2 ** attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Binance request failed");
  }

  private async waitForRequestSlot(): Promise<void> {
    if (this.requestDelayMs <= 0) return;
    const now = Date.now();
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.requestDelayMs;
    if (requestAt > now) await delay(requestAt - now);
  }

  private toInstrument(symbol: BinanceExchangeSymbol, ticker?: BinanceTicker24h): Instrument {
    const priceFilter = symbol.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lotSizeFilter = symbol.filters.find((filter) => filter.filterType === "LOT_SIZE");
    return {
      symbol: symbol.symbol,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
      contractType: symbol.contractType,
      status: symbol.status,
      priceTick: Number(priceFilter?.tickSize ?? "0.00000001"),
      quantityStep: Number(lotSizeFilter?.stepSize ?? "0.00000001"),
      minQuantity: lotSizeFilter?.minQty ? Number(lotSizeFilter.minQty) : undefined,
      maxLeverage: undefined,
      quoteVolume24h: ticker?.quoteVolume ? Number(ticker.quoteVolume) : undefined,
      onboardDate: Number.isFinite(Number(symbol.onboardDate)) ? Number(symbol.onboardDate) : undefined,
    };
  }
}

export class BinanceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`Binance API ${status}: ${message}`);
    this.name = "BinanceApiError";
  }
}

export function selectDeepUniverse(universe: Instrument[], limit: number): Instrument[] {
  return universe.slice(0, Math.max(1, limit));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

function parseKline(raw: unknown[]): BinanceKline {
  if (raw.length < 7) throw new Error("Malformed Binance kline");
  const candle = {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
  if (Object.values(candle).some((value) => !Number.isFinite(value))) {
    throw new Error("Malformed Binance kline values");
  }
  return candle;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configuredRequestDelayMs(): number {
  const value = Number(process.env.BINANCE_REQUEST_DELAY_MS);
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_REQUEST_DELAY_MS;
}

function configureNodeProxy(): void {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
