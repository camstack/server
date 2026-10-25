/**
 * How much of each location CamStack ITSELF holds (D388) — the slice
 * `listLocations` stamps from.
 *
 * ## Why this is a slice and not a call
 *
 * `listLocations` is on the admin UI's hot path. Fanning out a per-addon RPC
 * synchronously on every list would put a cross-process round trip (and, in the
 * providers, an indexed SQL aggregate) in front of a screen that repaints on
 * every navigation, and a slow or dead addon would hang the whole page.
 *
 * So this follows D224's freshness discipline: the figure has a WINDOW, a read
 * is answered from the slice — empty included — and a read NEVER joins a
 * refresh already in flight. Staleness costs the operator a figure that is up
 * to one window old, which the stamped `measuredAtMs` tells them; the
 * alternative costs them the screen.
 *
 * ## Absence is the answer (D315)
 *
 * A location no provider reported for is UNKNOWN, and this module has no code
 * path that turns that into a zero. `ownedFor` returns `undefined`, the
 * orchestrator omits the field, and a UI omits the segment. A share drawn at
 * zero would claim we occupy nothing, which is a different and false statement.
 */
import type { IScopedLogger, IStorageOccupancyProvider } from '@camstack/types'

/** What one location's owners hold there, merged. */
export interface LocationOwnedBytes {
  readonly bytes: number
  /** The OLDEST contributing measurement — honest about the whole figure
   *  rather than about its freshest part. */
  readonly measuredAtMs: number
}

export interface OccupancySliceDeps {
  readonly logger: IScopedLogger
  /** Registered `storage-occupancy` providers (cross-process proxies). */
  readonly getProviders: () => readonly IStorageOccupancyProvider[]
  /** Every location worth asking about, at refresh time. */
  readonly locationIds: () => readonly string[]
  readonly now: () => number
  /** How long a figure stays servable before a refresh is kicked. */
  readonly staleAfterMs?: number
}

/** One minute: the same order as the pressure sweep, and far longer than an
 *  admin-UI repaint. */
const DEFAULT_STALE_AFTER_MS = 60_000

export class LocationOccupancySlice {
  private slice: ReadonlyMap<string, LocationOwnedBytes> = new Map()
  private refreshing: Promise<void> | null = null
  private lastRefreshMs = 0

  constructor(private readonly deps: OccupancySliceDeps) {}

  /**
   * What the last completed refresh saw for this location, or `undefined` when
   * nothing has reported for it. There is deliberately no fallback: unknown is
   * the truth about a location nobody owns bytes on.
   */
  ownedFor(locationId: string): LocationOwnedBytes | undefined {
    return this.slice.get(locationId)
  }

  /**
   * Serve-and-revalidate. Called by every read: it returns immediately, and
   * kicks a background refresh when the slice is older than the window. A read
   * never awaits, and never joins a refresh already in flight (D224).
   */
  serveAndRevalidate(): void {
    if (this.refreshing !== null) return
    const staleAfter = this.deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    if (this.lastRefreshMs !== 0 && this.deps.now() - this.lastRefreshMs < staleAfter) return
    void this.refresh()
  }

  /**
   * Ask every provider once and replace the slice.
   *
   * A provider that throws contributes NOTHING and is logged — it does not
   * contribute a zero, and it does not take the other providers' answers down
   * with it. A location that ends up with no contribution at all simply stays
   * out of the slice, which is what makes it read back as unknown.
   */
  async refresh(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async runRefresh(): Promise<void> {
    const locationIds = [...this.deps.locationIds()]
    if (locationIds.length === 0) {
      this.slice = new Map()
      this.lastRefreshMs = this.deps.now()
      return
    }
    const merged = new Map<string, { bytes: number; measuredAtMs: number }>()
    for (const provider of this.deps.getProviders()) {
      let reports: Awaited<ReturnType<IStorageOccupancyProvider['getOccupancy']>>
      try {
        reports = await provider.getOccupancy({ locationIds })
      } catch (err) {
        // A branch that DROPS work says so. Silence here would read as "nobody
        // holds anything", which is exactly the claim absence exists to avoid.
        this.deps.logger.warn(
          'storage-orchestrator: a storage-occupancy provider failed — its bytes are ' +
            'MISSING from this refresh, not counted as zero',
          { meta: { error: err instanceof Error ? err.message : String(err) } },
        )
        continue
      }
      for (const report of reports) {
        const previous = merged.get(report.locationId)
        merged.set(report.locationId, {
          bytes: (previous?.bytes ?? 0) + report.ownedBytes,
          measuredAtMs:
            previous === undefined
              ? report.measuredAtMs
              : Math.min(previous.measuredAtMs, report.measuredAtMs),
        })
      }
    }
    this.slice = merged
    this.lastRefreshMs = this.deps.now()
  }
}
