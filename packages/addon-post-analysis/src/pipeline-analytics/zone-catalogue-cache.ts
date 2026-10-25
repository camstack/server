/**
 * zone-catalogue-cache — the per-device zone id→name dictionary the track read
 * path stamps `zoneNames` from.
 *
 * The `zones` capability is per-device, so resolving names on a merged
 * `listRecentTracks` page would otherwise be one cap call per camera per page —
 * the exact fan-out that surface exists to remove. One read per camera per TTL
 * is the whole cost, against a catalogue that changes only when an operator
 * draws a polygon.
 *
 * The failure rule is the important part: a refresh that throws KEEPS the last
 * known catalogue. Dropping it would make every zoned track look unzoned for
 * the next minute, which reads as "zones stopped working" rather than "the
 * zones cap blipped".
 */

/** How long a device's zone catalogue is trusted before a re-read. A zone
 *  rename should reach the feed without a restart; a minute is invisible to an
 *  operator and reduces the read to ~16 cheap calls/min on this fleet. */
export const ZONE_CATALOGUE_TTL_MS = 60_000

/** The subset of a `Zone` this cache needs — structural, so the caller can pass
 *  the cap's own rows without a mapping step. */
export interface ZoneIdentity {
  readonly id: string
  readonly name: string
}

export interface ZoneCatalogueCacheDeps {
  readonly fetchZones: (deviceId: number) => Promise<readonly ZoneIdentity[]>
  readonly now: () => number
  /** Called once per failed refresh. A silent drop here is invisible in the
   *  feed, so the caller logs it with the deviceId tag. */
  readonly onError: (deviceId: number, error: unknown) => void
}

interface CatalogueEntry {
  readonly names: ReadonlyMap<string, string>
  readonly readAtMs: number
}

export class ZoneCatalogueCache {
  private readonly deps: ZoneCatalogueCacheDeps
  private readonly entries = new Map<number, CatalogueEntry>()
  /** In-flight reads, so a burst of pages for the same camera makes one call. */
  private readonly inFlight = new Map<number, Promise<void>>()

  constructor(deps: ZoneCatalogueCacheDeps) {
    this.deps = deps
  }

  /** Make sure every device has a catalogue no older than the TTL. */
  async ensure(deviceIds: readonly number[]): Promise<void> {
    const stale = [...new Set(deviceIds)].filter((id) => this.isStale(id))
    await Promise.all(stale.map((id) => this.refresh(id)))
  }

  /** The device's zone id→name map, or null when it was never readable. */
  lookup(deviceId: number): ReadonlyMap<string, string> | null {
    return this.entries.get(deviceId)?.names ?? null
  }

  private isStale(deviceId: number): boolean {
    const held = this.entries.get(deviceId)
    if (held === undefined) return true
    return this.deps.now() - held.readAtMs >= ZONE_CATALOGUE_TTL_MS
  }

  private async refresh(deviceId: number): Promise<void> {
    const running = this.inFlight.get(deviceId)
    if (running !== undefined) return running
    const task = this.read(deviceId).finally(() => {
      this.inFlight.delete(deviceId)
    })
    this.inFlight.set(deviceId, task)
    return task
  }

  private async read(deviceId: number): Promise<void> {
    try {
      const zones = await this.deps.fetchZones(deviceId)
      const names = new Map<string, string>()
      for (const zone of zones) {
        if (zone.id.length > 0 && zone.name.length > 0) names.set(zone.id, zone.name)
      }
      this.entries.set(deviceId, { names, readAtMs: this.deps.now() })
    } catch (error: unknown) {
      // Keep whatever we hold. Only the read TIME is left untouched, so the
      // next page retries rather than backing off into a permanent hole.
      this.deps.onError(deviceId, error)
    }
  }
}
