/** What the reconcile needs to know about one push link. */
export interface LinkHealth {
  readonly brokerId: string
  readonly healthy: boolean
  readonly suspended: boolean
  /** Epoch ms of the next probe while suspended; 0 otherwise. */
  readonly recheckAt: number
}

export interface LinkGapSummary {
  /** Unhealthy and still being tried: a gap the next pass must resync. */
  readonly failing: readonly string[]
  /** Parked on a missing component: a gap too, but nothing can be sent until the probe. */
  readonly suspended: readonly {
    readonly brokerId: string
    readonly recheckAt: number
  }[]
  /** At least one link is not parked. */
  readonly anyLive: boolean
}

/** A parked link is reported, never silently excluded. */
export function summariseLinkGaps(links: readonly LinkHealth[]): LinkGapSummary {
  return {
    failing: links.filter((l) => !l.healthy && !l.suspended).map((l) => l.brokerId),
    suspended: links
      .filter((l) => l.suspended)
      .map((l) => ({ brokerId: l.brokerId, recheckAt: l.recheckAt })),
    anyLive: links.some((l) => !l.suspended),
  }
}
