export interface BinanceExchangeFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
}

export interface BinanceExchangeSymbol {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  onboardDate?: number;
  filters: BinanceExchangeFilter[];
}

export interface BinanceExchangeInfo {
  symbols: BinanceExchangeSymbol[];
}

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  volume: string;
  priceChangePercent: string;
}

export interface BinanceKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BinanceFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}
