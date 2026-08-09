export function zonedDateString(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function fifteenMinuteGroupKey(timestamp: number): string {
  const bucket = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
  return new Date(bucket).toISOString();
}

export function signalKey(input: {
  symbol: string;
  side: string;
  timeframe: string;
  strategyVersion: string;
  sourceTimestamp: number;
}): string {
  return [input.symbol, input.side, input.timeframe, input.strategyVersion, input.sourceTimestamp].join(":");
}
