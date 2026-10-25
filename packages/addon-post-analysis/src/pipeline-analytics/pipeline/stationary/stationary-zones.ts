/**
 * stationary-zones — zone membership for parked ("stationary") registry entries.
 *
 * A live detection gets its zone tags from {@link ZoneEngine} (bbox/polygon
 * overlap + `zoneMembershipMinOverlap`). A stationary REGISTRY entry never
 * flows through the FrameProcessor — it is folded straight into the occupancy
 * aggregate — so it needs its own membership call. The geometry and the
 * threshold are the SAME as live: one engine, one Tracking setting, regardless
 * of origin (live track, parked registry, hydration, package-drop).
 *
 * An entry carries its bbox in detection-frame PIXEL space plus the
 * `frameWidth`/`frameHeight` it was captured at; zones are 0–1 normalised
 * polygons. The engine converts polygons to pixels with the entry's OWN frame
 * dims, so a detached camera still resolves membership without a live frame.
 */

import type { Zone } from '@camstack/types'
import { ZoneEngine } from '../zones/zone-engine.js'
import type { StationaryBbox } from './stationary-types.js'

/** Shared with every call — ZoneEngine is stateless for annotateDetection. */
const ENGINE = new ZoneEngine()

export interface StationaryZoneInput {
  readonly bbox: StationaryBbox
  readonly frameWidth: number
  readonly frameHeight: number
}

/**
 * Zone ids whose bbox overlap exceeds `minOverlap` (0–1 fraction of the
 * detection's own area) — identical to {@link ZoneEngine.annotateDetection}.
 * Empty when the entry has no frame dims or no zone meets the bar.
 *
 * `minOverlap` is required: callers pass `TrackingSettings.zoneMembershipMinOverlap`
 * so parked and live never disagree on the threshold.
 */
export function computeStationaryEntryZones(
  entry: StationaryZoneInput,
  zones: readonly Zone[],
  minOverlap: number,
): readonly string[] {
  if (entry.frameWidth <= 0 || entry.frameHeight <= 0 || zones.length === 0) return []
  const memberships = ENGINE.annotateDetection(
    entry.bbox,
    zones,
    entry.frameWidth,
    entry.frameHeight,
    undefined,
    undefined,
    undefined,
    minOverlap,
  )
  return memberships.map((m) => m.zoneId)
}
