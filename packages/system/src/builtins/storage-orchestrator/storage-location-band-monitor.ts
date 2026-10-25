/**
 * StorageLocationBandMonitor — free-space bands for Notification Center.
 *
 * Two rules, picked per sample:
 *
 * - UNMANAGED (no `floorPercent`): the fixed percentage bands (low <= 15 %,
 *   critical <= 5 %), now with hysteresis so a value hovering at an edge
 *   emits ONE edge.
 * - MANAGED BY EVICTION (`floorPercent` = the free-space floor the evictor
 *   holds): sitting AT the floor is the evictor doing its job, not an
 *   incident. A recordings volume kept at 150 GB free of 3.7 TB is ~4 % free
 *   for ever; the fixed 5 % critical bar flapped it low <-> critical every few
 *   minutes. Bands are relative to the floor instead:
 *     - `low`: free below 80 % of the floor for the whole grace window
 *       (the evictor is falling behind). Exit at 90 %.
 *     - `critical`: free below 50 % of the floor, no grace (writes are about to
 *       fail; the evictor is losing). Exit at 60 %.
 *   "Half the floor" was chosen over an absolute byte minimum because it scales
 *   with the operator's own setting and needs no second knob; it is far above
 *   the few MB a segment needs, so it fires before writes fail.
 *
 * A measurement that FAILED (`freePercent === null`) never changes the band and
 * never opens an episode (D393): "could not read" is not evidence about space.
 * Disabled / non-managed locations are absent from the sweep input and clear
 * any open episode without an `ok` event.
 *
 * Pure, injected clock, one transition per band change.
 */

export type StorageLocationBand = 'ok' | 'low' | 'critical'

export interface StorageLocationBandConfig {
  /** Free percent at/below which the location is low (default 15). */
  readonly lowPercent: number
  /** Free percent at/below which the location is critical (default 5). */
  readonly criticalPercent: number
}

export const DEFAULT_STORAGE_LOCATION_BAND_CONFIG: StorageLocationBandConfig = {
  lowPercent: 15,
  criticalPercent: 5,
}

export interface StorageLocationBandSample {
  readonly locationId: string
  readonly nodeId?: string
  readonly locationName?: string
  /** Free percent, or `null` when the probe failed. */
  readonly freePercent: number | null
  /** Free-space floor (percent) an evictor holds this location at; absent when
   *  the location is not managed by eviction. */
  readonly floorPercent?: number
  /** Absolute figures, carried only so an edge can be logged with them. */
  readonly freeBytes?: number
  readonly floorBytes?: number
}

export interface StorageLocationBandEvent {
  readonly locationId: string
  readonly nodeId?: string
  readonly locationName?: string
  readonly band: StorageLocationBand
  readonly freePercent: number | null
  readonly floorPercent?: number
  readonly freeBytes?: number
  readonly floorBytes?: number
  readonly reason: string
  readonly previous: StorageLocationBand | null
}

/** Enter/exit free-percent bounds of each band edge (exit > enter: hysteresis). */
interface BandBounds {
  readonly lowEnter: number
  readonly lowExit: number
  readonly criticalEnter: number
  readonly criticalExit: number
  /** How long free must stay under `lowEnter` before `low` opens. */
  readonly lowGraceMs: number
  readonly lowReason: string
  readonly criticalReason: string
}

/** Margin, in percentage points, between the enter and exit of an unmanaged edge. */
const UNMANAGED_HYSTERESIS_POINTS = 2
/** Managed: fractions of the floor. */
const MANAGED_LOW_ENTER = 0.8
const MANAGED_LOW_EXIT = 0.9
const MANAGED_CRITICAL_ENTER = 0.5
const MANAGED_CRITICAL_EXIT = 0.6
/** How long the evictor may sit below the low margin before it counts as behind. */
export const MANAGED_LOW_GRACE_MS: number = 10 * 60_000

function boundsOf(floorPercent: number | undefined, config: StorageLocationBandConfig): BandBounds {
  if (floorPercent === undefined) {
    return {
      lowEnter: config.lowPercent,
      lowExit: config.lowPercent + UNMANAGED_HYSTERESIS_POINTS,
      criticalEnter: config.criticalPercent,
      criticalExit: config.criticalPercent + UNMANAGED_HYSTERESIS_POINTS,
      lowGraceMs: 0,
      lowReason: 'free-below-warn',
      criticalReason: 'free-below-critical',
    }
  }
  return {
    lowEnter: floorPercent * MANAGED_LOW_ENTER,
    lowExit: floorPercent * MANAGED_LOW_EXIT,
    criticalEnter: floorPercent * MANAGED_CRITICAL_ENTER,
    criticalExit: floorPercent * MANAGED_CRITICAL_EXIT,
    lowGraceMs: MANAGED_LOW_GRACE_MS,
    lowReason: 'free-below-floor',
    criticalReason: 'free-below-hard-bound',
  }
}

export class StorageLocationBandMonitor {
  private readonly config: StorageLocationBandConfig
  private readonly now: () => number
  private readonly band = new Map<string, StorageLocationBand>()
  /** When free first went under `lowEnter` and has stayed there. */
  private readonly belowLowSince = new Map<string, number>()

  constructor(
    config: StorageLocationBandConfig = DEFAULT_STORAGE_LOCATION_BAND_CONFIG,
    now: () => number = Date.now,
  ) {
    this.config = config
    this.now = now
  }

  private nextBand(
    locationId: string,
    previous: StorageLocationBand | null,
    free: number,
    b: BandBounds,
  ): { band: StorageLocationBand; reason: string } {
    if (free < b.criticalEnter || (previous === 'critical' && free < b.criticalExit)) {
      return { band: 'critical', reason: b.criticalReason }
    }
    const lowActive = previous === 'low' || previous === 'critical'
    if (free < b.lowEnter || (lowActive && free < b.lowExit)) {
      if (lowActive) return { band: 'low', reason: b.lowReason }
      const since = this.belowLowSince.get(locationId) ?? this.now()
      this.belowLowSince.set(locationId, since)
      if (this.now() - since >= b.lowGraceMs) return { band: 'low', reason: b.lowReason }
      // Still inside the grace window: the band does not move yet.
      return { band: previous ?? 'ok', reason: 'free-ok' }
    }
    this.belowLowSince.delete(locationId)
    return { band: 'ok', reason: 'free-ok' }
  }

  /**
   * Observe one sweep of managed locations. Locations missing from `samples`
   * drop their episode without emitting `ok` (disabled / removed).
   */
  observe(samples: readonly StorageLocationBandSample[]): readonly StorageLocationBandEvent[] {
    const seen = new Set<string>()
    const out: StorageLocationBandEvent[] = []
    for (const sample of samples) {
      seen.add(sample.locationId)
      // A failed measurement changes nothing (D393).
      if (sample.freePercent === null) continue
      const previous = this.band.get(sample.locationId) ?? null
      const { band, reason } = this.nextBand(
        sample.locationId,
        previous,
        sample.freePercent,
        boundsOf(sample.floorPercent, this.config),
      )
      if (previous === band) continue
      this.band.set(sample.locationId, band)
      // First observation of `ok` is silence — only transitions into a problem
      // or out of one are operator-facing.
      if (previous === null && band === 'ok') continue
      out.push({
        locationId: sample.locationId,
        ...(sample.nodeId !== undefined ? { nodeId: sample.nodeId } : {}),
        ...(sample.locationName !== undefined ? { locationName: sample.locationName } : {}),
        band,
        freePercent: sample.freePercent,
        ...(sample.floorPercent !== undefined ? { floorPercent: sample.floorPercent } : {}),
        ...(sample.freeBytes !== undefined ? { freeBytes: sample.freeBytes } : {}),
        ...(sample.floorBytes !== undefined ? { floorBytes: sample.floorBytes } : {}),
        reason,
        previous,
      })
    }
    for (const id of [...this.band.keys()]) {
      if (!seen.has(id)) {
        this.band.delete(id)
        this.belowLowSince.delete(id)
      }
    }
    return out
  }
}
