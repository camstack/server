/**
 * Hard cap on lease-download `FilterAPI.create` calls per dial — the OOM unit
 * on agent-a (Intel N100 VAAPI).
 *
 * node-av reclaims VAAPI hw pools only on process exit (live 2026-07-16:
 * ~6 GB RSS in minutes at ~25 rebuilds/s). Closing a failed download filter and
 * rebuilding on the next armed capture is still "one create per cooldown" under
 * sustained EIO. This bound refuses a further create with a named reason so
 * crops fall back without another `FilterAPI.create`. See
 * `docs/design/2026-10-02-n100-vaapi-lease-download-eio.md` §S1.
 *
 * Pure surface: no node-av. The worker owns the real FilterAPI; tests drive a
 * fake through {@link runLeaseDownloadCreateAttempts}.
 */

/** Creates allowed per dial: one cold graph + one rebuild for early-dial ctx drift. */
export const LEASE_DOWNLOAD_FILTER_CREATES_PER_DIAL = 2

/** Named refusal when the per-dial create cap is hit. */
export const LEASE_DOWNLOAD_REBUILD_CAP_REASON = 'lease-download-rebuild-cap'

/**
 * Counts lease-download filter creates for one dial and refuses past the bound.
 * Reset on every fresh dial (alongside {@link LeaseActivityGate.reset}).
 */
export class LeaseDownloadRebuildCap {
  private creates = 0

  constructor(readonly maxCreatesPerDial: number = LEASE_DOWNLOAD_FILTER_CREATES_PER_DIAL) {}

  /** Metric: how many `FilterAPI.create` calls this dial has already paid. */
  get createsThisDial(): number {
    return this.creates
  }

  /** Whether another create is still inside the dial bound. */
  canCreate(): boolean {
    return this.creates < this.maxCreatesPerDial
  }

  /**
   * Record a create that is about to happen. Throws
   * {@link LEASE_DOWNLOAD_REBUILD_CAP_REASON} if the dial is already at the cap
   * — the caller must not call `FilterAPI.create` after that.
   */
  recordCreate(): void {
    if (this.creates >= this.maxCreatesPerDial) {
      throw new Error(LEASE_DOWNLOAD_REBUILD_CAP_REASON)
    }
    this.creates++
  }

  /** Fresh dial: the create budget starts over with a new `hw_frames_ctx`. */
  resetForDial(): void {
    this.creates = 0
  }
}

export type LeaseDownloadFakeFilter = {
  processAllSync: () => void
  close: () => void
}

export type LeaseDownloadCreateAttemptResult = {
  /** How many times the fake `createFilter` factory ran. */
  filterCreates: number
  /** Named refusals from the cap (no factory call). */
  refusals: string[]
}

/**
 * Drive the ensure→process→close loop against a fake FilterAPI.
 *
 * Models the worker's lease-download path: cache miss ⇒ create (if allowed);
 * `processAllSync` failure ⇒ close and drop the cache so the next attempt
 * would create again — unless the dial cap refuses.
 */
export function runLeaseDownloadCreateAttempts(args: {
  cap: LeaseDownloadRebuildCap
  createFilter: () => LeaseDownloadFakeFilter
  attempts: number
}): LeaseDownloadCreateAttemptResult {
  let filter: LeaseDownloadFakeFilter | null = null
  let filterCreates = 0
  const refusals: string[] = []

  for (let i = 0; i < args.attempts; i++) {
    if (!filter) {
      if (!args.cap.canCreate()) {
        refusals.push(LEASE_DOWNLOAD_REBUILD_CAP_REASON)
        continue
      }
      filter = args.createFilter()
      args.cap.recordCreate()
      filterCreates++
    }
    try {
      filter.processAllSync()
    } catch {
      filter.close()
      filter = null
    }
  }

  return { filterCreates, refusals }
}
