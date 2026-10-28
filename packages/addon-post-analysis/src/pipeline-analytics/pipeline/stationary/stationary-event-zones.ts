/**
 * The zones a parked object is in, for the `StationaryChanged` event payload.
 *
 * Membership is {@link computeStationaryEntryZones} — the one rule the
 * occupancy snapshot, the package-drop gate and the live stamps already share —
 * with the camera's own `zoneMembershipMinOverlap`. This file only adds the two
 * reads that rule needs (zones, the bar) and the failure policy: a read that
 * throws yields an empty list and a tagged warning, never a thrown emit (the
 * event is telemetry, D8; an automation's `stationary-present` condition reads
 * the registry and does not depend on it).
 */

import type { IScopedLogger, Zone } from '@camstack/types'
import { computeStationaryEntryZones, type StationaryZoneInput } from './stationary-zones.js'

export interface StationaryEventZoneEntry extends StationaryZoneInput {
  readonly deviceId: number
}

export interface StationaryEventZoneDeps {
  readonly resolveZones: (deviceId: number) => Promise<readonly Zone[]>
  readonly resolveMinOverlap: (deviceId: number) => Promise<number>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

export async function resolveStationaryEventZones(
  entry: StationaryEventZoneEntry,
  deps: StationaryEventZoneDeps,
): Promise<string[]> {
  try {
    const zones = await deps.resolveZones(entry.deviceId)
    if (zones.length === 0) return []
    const minOverlap = await deps.resolveMinOverlap(entry.deviceId)
    return [...computeStationaryEntryZones(entry, zones, minOverlap)]
  } catch (err: unknown) {
    deps.logger.warn('stationary event zones unresolved — emitting none', {
      tags: { deviceId: entry.deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return []
  }
}
