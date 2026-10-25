/**
 * Since when each device has been ABSENT from every successful device listing.
 *
 * A listing that answered is not a listing that was complete: after a hub restart
 * a provider addon that is still booting leaves its devices out of an otherwise
 * successful `listAll`, and change-only capture means a stable series has not been
 * written for days. Deciding "gone" from one listing, or from the series' own last
 * write, would delete live history for good (D49). So the only thing a listing may
 * do here is move a clock: the first listing that misses a device records WHEN
 * (persisted, so a restart neither resets it to now nor treats it as old), any
 * listing that shows the device clears it, and a series becomes purgeable only
 * after {@link DEPARTED_ABSENCE_MS} of unbroken absence.
 *
 * The `device.unregistered` event is deliberately not used: it is telemetry and
 * may be dropped, and a provider that restarts emits it for devices that come back.
 */
import type { IScopedLogger } from '@camstack/types'
import type { HistoryStore } from '../store/history-store.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import { DAY_MS } from '../time/bucket-time.js'

export const DEPARTED_ABSENCE_MS: number = 7 * DAY_MS

export class DepartureTracker {
  private missing: ReadonlyMap<number, number> = new Map()

  constructor(
    private readonly store: HistoryStore,
    private readonly registry: SeriesRegistry,
    private readonly logger: IScopedLogger,
  ) {}

  async load(): Promise<void> {
    this.missing = await this.store.loadDepartures()
  }

  missingSince(deviceId: number): number | undefined {
    return this.missing.get(deviceId)
  }

  /** Forget a device's clock — its series were removed because it was DELETED (D865). */
  async forget(deviceId: number): Promise<void> {
    await this.store.clearMissing([deviceId])
    const next = new Map(this.missing)
    next.delete(deviceId)
    this.missing = next
  }

  /** Feed one SUCCESSFUL listing. A failed read never reaches here. */
  async observe(listed: ReadonlySet<number>, now: number): Promise<void> {
    const withSeries = new Set(
      this.registry.all().flatMap((s) => (s.deviceId === null ? [] : [s.deviceId])),
    )
    const back = [...this.missing.keys()].filter((id) => listed.has(id))
    const gone = [...withSeries].filter((id) => !listed.has(id) && !this.missing.has(id))
    try {
      await this.store.clearMissing(back)
      await this.store.markMissing(gone, now)
    } catch (err) {
      // The in-memory view stays as it was: a clock that could not be written is not moved.
      this.logger.warn('device-history: departure clock not written', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const next = new Map(this.missing)
    for (const id of back) next.delete(id)
    for (const id of gone) next.set(id, now)
    this.missing = next
  }
}
