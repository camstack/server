/**
 * The location NEW `eventMedia` blobs are written to — resolved once per
 * "location set generation", never per blob (no RPC per blob).
 *
 * The pick used to be cached for the life of the process and dropped only by
 * `refreshStorageLocationsForMigration` under a migration lease. A location set
 * to `drain` (or `readonly`/`disabled`), or a repoint, therefore changed nothing
 * until a restart: on 2026-10-20 new media kept landing on a draining disk. The
 * `StorageLocationsChanged` doorbell (D387) now invalidates the cache, exactly as
 * the recorder's `LocationRefresher` does. The doorbell is telemetry and may be
 * dropped; a missed one costs latency until the next ring, and the migration
 * lease path still invalidates too.
 */
import type { IEventBus, IScopedLogger, StorageLocation } from '@camstack/types'
import { errMsg, EventCategory, resolveLocationMode } from '@camstack/types'
import { DEFAULT_MEDIA_LOCATION } from './store/media-store.js'
import { type MediaLocation, pickWritableMediaLocation } from './media-locations.js'

export interface EventMediaWriteLocatorDeps {
  /** Every `eventMedia` location, as the storage orchestrator lists them. */
  readonly list: () => Promise<readonly StorageLocation[]>
}

export class EventMediaWriteLocator {
  private cached: string | null = null
  /**
   * The last location actually picked. Survives {@link invalidate}, so a ring
   * keeps writing where it was writing while that stays writable — the
   * stickiness the class default used to provide (D383).
   */
  private lastPick: string | null = null

  constructor(private readonly deps: EventMediaWriteLocatorDeps) {}

  /** Drop the cached pick: the next write re-reads the location set. */
  invalidate(): void {
    this.cached = null
  }

  async resolve(logger: IScopedLogger, deviceId: number): Promise<string> {
    if (this.cached !== null) return this.cached
    let locations: readonly StorageLocation[]
    try {
      locations = await this.deps.list()
    } catch (err: unknown) {
      logger.debug(
        'pipeline-analytics: eventMedia location list unavailable — writing through the default ref',
        { meta: { error: errMsg(err) } },
      )
      this.cached = DEFAULT_MEDIA_LOCATION
      return DEFAULT_MEDIA_LOCATION
    }
    const mapped: MediaLocation[] = locations.map((l) => ({
      id: l.id,
      // The state, resolved ONCE by the policy module (D385) — it folds the
      // legacy `enabled` / `config.readOnly` pair for an unmigrated hub.
      mode: resolveLocationMode(l),
      headroomBytes: l.capacity?.availableBytes ?? 0,
    }))
    const picked = pickWritableMediaLocation(mapped, this.lastPick ?? undefined)
    if (picked === null) {
      const seen =
        locations.length > 0 ? locations.map((l) => l.id).join(', ') : '(none registered)'
      logger.error(
        'pipeline-analytics: no writable eventMedia storage location — refusing the write ' +
          'instead of failing far downstream as a filesystem error',
        { tags: { deviceId }, meta: { locationsSeen: seen } },
      )
      throw new Error(`no writable eventMedia storage location (seen: ${seen})`)
    }
    this.cached = picked
    this.lastPick = picked
    return picked
  }
}

/**
 * Ring the locator from the location-set doorbell. `onRing` lets the caller drop
 * its other location-derived caches in the same breath.
 */
export function subscribeEventMediaWriteLocator(
  eventBus: Pick<IEventBus, 'subscribe'>,
  locator: EventMediaWriteLocator,
  onRing: () => void,
): () => void {
  return eventBus.subscribe({ category: EventCategory.StorageLocationsChanged }, () => {
    locator.invalidate()
    onRing()
  })
}
