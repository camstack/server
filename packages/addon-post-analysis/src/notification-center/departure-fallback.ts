/**
 * Extracted from NotificationCenter (registerDepartureFallback, departureFallbackMedia, departureStillOwner, reportNoDepartureStill).
 * The class method forwards private state through {@link DepartureFallbackHost}.
 */

import type { OccupancyEdge } from './occupancy-watcher.js'
import { NC_DEPARTURE_STILL_LEAD_MS, NC_STILL_SHELF_TTL_MS, NcStillShelf } from './still-shelf.js'
import type { IScopedLogger, MediaFileBytes } from '@camstack/types'

/** Bound on remembered departure fallbacks (D691 review M3) — the shelf's own
 *  capture bound. */
export const NC_DEPARTURE_FALLBACK_MAX = 64

export interface DepartureFallbackHost {
  readonly departureFallbacks: Map<
    string,
    {
      readonly deviceId: number
      readonly atMs: number
      readonly expiresAt: number
      readonly ownerId: string | null
    }
  >
  readonly logger: IScopedLogger
  readonly now: () => number
  reportNoDepartureStill(edge: OccupancyEdge, reason: 'moment-unknown' | 'no-ring-still'): undefined
  readonly stills: NcStillShelf | null
}

/**
 * Remember where a departed track's ring still would be cut, so the media
 * lookup can stand it in if the track resolves nothing (review M3). LAZY: the
 * ring is cut only on that miss — the ordinary departure, whose track owns
 * its best shot, costs nothing. The moment is still in the ring then: the
 * lookup runs seconds after the commit, a sustain after `observedAt`.
 * Bounded by the shelf's TTL and {@link NC_DEPARTURE_FALLBACK_MAX}.
 *
 * A fused-away id is resolved to its survivor before any of this is reached
 * ({@link resolveDepartedTrack}, D683).
 */
export function registerDepartureFallback(
  host: DepartureFallbackHost,
  shelf: NcStillShelf,
  edge: OccupancyEdge,
  trackId: string,
): void {
  if (edge.observedAt === undefined || !shelf.canCapturePast()) return
  const now = host.now()
  for (const [id, held] of host.departureFallbacks) {
    if (held.expiresAt <= now) host.departureFallbacks.delete(id)
  }
  while (host.departureFallbacks.size >= NC_DEPARTURE_FALLBACK_MAX) {
    const oldest = host.departureFallbacks.keys().next()
    if (oldest.done === true) break
    host.departureFallbacks.delete(oldest.value)
  }
  host.departureFallbacks.set(trackId, {
    deviceId: edge.deviceId,
    atMs: edge.observedAt - NC_DEPARTURE_STILL_LEAD_MS,
    expiresAt: now + NC_STILL_SHELF_TTL_MS,
    ownerId: null,
  })
}
/**
 * The media-lookup half of {@link registerDepartureFallback}: a departed
 * track that resolved nothing is answered from the ring still, started on
 * the first miss and read on every later poll.
 */
export function departureFallbackMedia(
  host: DepartureFallbackHost,
  trackId: string,
): readonly MediaFileBytes[] | undefined {
  const held = host.departureFallbacks.get(trackId)
  const shelf = host.stills
  if (held === undefined || shelf === null || held.expiresAt <= host.now()) return undefined
  if (held.ownerId !== null) return shelf.get(held.ownerId)
  host.logger.info(
    'occupancy departure still: the departed track owns no media — cut from the ring',
    { tags: { deviceId: held.deviceId }, meta: { trackId, atMs: held.atMs } },
  )
  const ownerId = shelf.capture(held.deviceId, held.atMs, 'occupancy', 'past')
  host.departureFallbacks.set(trackId, { ...held, ownerId })
  return shelf.get(ownerId)
}
/**
 * The picture of a departure nobody who left can own (D691): a frame from the
 * clip ring a lead BEFORE the moment it happened — never a live frame, which
 * by the commit (a sustain window later, at best) is the empty space. A
 * departure that cannot be dated, or a node with nothing to cut a past frame
 * from, ships no picture and says why, per camera: the operator asked for the
 * subject that left, and an empty space would answer something else.
 */
export function departureStillOwner(
  host: DepartureFallbackHost,
  shelf: NcStillShelf,
  edge: OccupancyEdge,
): string | undefined {
  const observedAt = edge.observedAt
  if (observedAt === undefined) return host.reportNoDepartureStill(edge, 'moment-unknown')
  if (!shelf.canCapturePast()) return host.reportNoDepartureStill(edge, 'no-ring-still')
  return shelf.capture(edge.deviceId, observedAt - NC_DEPARTURE_STILL_LEAD_MS, 'occupancy', 'past')
}
/** A departure that ships no picture names why — and returns no owner. */
export function reportNoDepartureStill(
  host: DepartureFallbackHost,
  edge: OccupancyEdge,
  reason: 'moment-unknown' | 'no-ring-still',
): undefined {
  host.logger.warn('occupancy departure still: none — no picture of the empty space', {
    tags: { deviceId: edge.deviceId },
    meta: { reason, zoneId: edge.zoneId ?? '@frame', committedAt: edge.timestamp },
  })
  return undefined
}
