import type { MarketSnapshot } from "@/lib/core/types";

export function isForwardEligibleSourceTimestamp(
  sourceTimestamp: number,
  forwardStartTimestamp: number,
): boolean {
  return Number.isFinite(sourceTimestamp)
    && Number.isFinite(forwardStartTimestamp)
    && sourceTimestamp >= forwardStartTimestamp;
}

export function filterForwardEligibleSnapshots(
  snapshots: readonly (MarketSnapshot | null)[],
  forwardStartTimestamp: number,
): MarketSnapshot[] {
  return snapshots.filter((snapshot): snapshot is MarketSnapshot => (
    snapshot !== null
    && isForwardEligibleSourceTimestamp(snapshot.sourceTimestamp, forwardStartTimestamp)
  ));
}
