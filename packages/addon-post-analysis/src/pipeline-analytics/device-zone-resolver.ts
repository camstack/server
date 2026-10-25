/**
 * device-zone-resolver — the one place occupancy asks "which zones does this
 * camera have?".
 *
 * The device-state `zones` slice is a MIRROR, not the authority. It is written
 * by `ZonesProvider.persist` in the orchestrator, i.e. only when an operator
 * mutates a zone; the durable catalogue lives in the orchestrator's per-device
 * settings store behind `zones.listZones`. A device whose runtime-state row was
 * never written (or was reset) therefore has NO mirror slice at all, and a
 * reader that trusts the mirror alone concludes "this camera has no zones" —
 * forever, because no mutation is coming.
 *
 * Live cost of getting that wrong (camera 102 "Parking", 2026-08-12):
 * `zones.listZones {102}` returned 'Parking pat' while
 * `deviceState.getCapSlice {102,'zones'}` returned `null`. Every occupancy
 * snapshot reported `zones: []` and dropped all three parked vehicles into
 * `unzoned`, so an occupancy rule scoped to that zone could never fire. Camera
 * 101 had both sides populated, which is exactly why the mirror looked sound.
 *
 * D8 spells out the rule this restores: an event-fed cache may be dropped, and
 * the durable channel is RPC. So the mirror stays the fast path — when it
 * carries zones it wins, and its push callback invalidates this cache — but an
 * absent or empty mirror is re-asked of the capability itself, TTL-cached so the
 * per-frame path costs one call a minute per camera rather than one per frame.
 *
 * Failure rule, same as {@link ZoneCatalogueCache}: a read that throws KEEPS the
 * last known catalogue. Dropping to `[]` would turn every parked car unzoned for
 * the next minute, which an operator reads as "the zone stopped working".
 */

import type { Zone } from '@camstack/types'

/**
 * How long a catalogue read from the capability is trusted. Only consulted when
 * the mirror is absent/empty, and the mirror's own push invalidates it, so this
 * bounds nothing an operator can see except the case where the mirror is broken
 * — where a minute is the whole exposure.
 */
export const ZONE_AUTHORITY_TTL_MS = 60_000

export interface DeviceZoneResolverDeps {
  /**
   * The loaded device-state `zones` mirror for a device, or `undefined` when the
   * slice has never loaded. `[]` means "loaded, and it says none" — which is a
   * real answer from the mirror but NOT an authoritative one, so it still gets
   * checked against the cap.
   */
  readonly readMirror: (deviceId: number) => readonly Zone[] | undefined
  /** The `zones` capability — the durable authority (`zones.listZones`). */
  readonly fetchZones: (deviceId: number) => Promise<readonly Zone[]>
  readonly now: () => number
  /**
   * The mirror said "no zones" and the capability disagreed. Fired on the
   * TRANSITION only (not once per frame) so the caller can log it warn-level:
   * a branch that silently drops zone membership must never be silent.
   */
  readonly onMirrorDiverged: (deviceId: number, authorityCount: number) => void
  /** A capability read that threw. The caller logs it, deviceId-tagged. */
  readonly onError: (deviceId: number, error: unknown) => void
}

interface CatalogueEntry {
  readonly zones: readonly Zone[]
  readonly readAtMs: number
}

export class DeviceZoneResolver {
  private readonly deps: DeviceZoneResolverDeps
  /** Last catalogue read from the capability, per device. */
  private readonly entries = new Map<number, CatalogueEntry>()
  /** In-flight reads, so a burst of frames for one camera makes one call. */
  private readonly inFlight = new Map<number, Promise<void>>()
  /** Devices already reported as diverging — keeps the warn to one per episode. */
  private readonly reportedDivergence = new Set<number>()

  constructor(deps: DeviceZoneResolverDeps) {
    this.deps = deps
  }

  /**
   * The device's current 0–1 zone catalogue. Mirror first; capability when the
   * mirror is absent or empty.
   */
  async resolve(deviceId: number): Promise<readonly Zone[]> {
    const mirrored = this.deps.readMirror(deviceId)
    if (mirrored !== undefined && mirrored.length > 0) {
      this.reportedDivergence.delete(deviceId)
      return mirrored
    }
    if (this.isStale(deviceId)) await this.refresh(deviceId)
    const held = this.entries.get(deviceId)?.zones ?? []
    if (held.length > 0 && !this.reportedDivergence.has(deviceId)) {
      this.reportedDivergence.add(deviceId)
      this.deps.onMirrorDiverged(deviceId, held.length)
    }
    return held
  }

  /**
   * Force the next `resolve` to re-ask the capability. Wired to the mirror's
   * push callback: an operator who deletes their LAST zone pushes `{zones: []}`,
   * and without this the cached non-empty answer would outlive the deletion by
   * up to a TTL.
   */
  invalidate(deviceId: number): void {
    this.entries.delete(deviceId)
    this.reportedDivergence.delete(deviceId)
  }

  /** Drop a device entirely — called on device removal. */
  forgetDevice(deviceId: number): void {
    this.invalidate(deviceId)
    this.inFlight.delete(deviceId)
  }

  private isStale(deviceId: number): boolean {
    const held = this.entries.get(deviceId)
    if (held === undefined) return true
    return this.deps.now() - held.readAtMs >= ZONE_AUTHORITY_TTL_MS
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
      this.entries.set(deviceId, { zones, readAtMs: this.deps.now() })
    } catch (err: unknown) {
      this.deps.onError(deviceId, err)
      // Keep whatever we last knew; only stamp a fresh read time so a hard-down
      // capability is retried at the TTL rather than on every frame.
      const held = this.entries.get(deviceId)
      this.entries.set(deviceId, {
        zones: held?.zones ?? [],
        readAtMs: this.deps.now(),
      })
    }
  }
}
