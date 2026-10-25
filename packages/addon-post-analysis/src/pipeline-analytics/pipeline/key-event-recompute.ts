/**
 * key-event-recompute — recompute a PERSISTED track's importance and re-propagate
 * it to the track's object-event rows. Used when a late signal (a face `label`
 * assigned after the track already expired) should retroactively bump the
 * identity term of the score.
 *
 * Only acts on already-persisted tracks: for a track still active in RAM the
 * eventual expiry sweep scores it once, WITH the label already set, so there is
 * nothing to recompute (this returns early). Structural deps keep it decoupled
 * from the concrete store classes and unit-testable with fakes.
 */

import type { Track } from '@camstack/types'
import { computeImportance } from './key-event-scoring.js'
import { displayLabel } from './label-tier.js'

export interface ImportanceTrackStore {
  getPersistedByTrackId(trackId: string): Promise<Track | null>
  setImportance(
    trackId: string,
    importance: number,
    reason: string,
    bestEventId?: string,
  ): Promise<void>
}

export interface ImportancePeak {
  readonly peakConfidence: number
  readonly peakBboxAreaFrac: number
  readonly bestEventId: string | undefined
}

export interface ImportanceEventStore {
  peakForTrack(trackId: string): Promise<ImportancePeak>
  setImportanceForTrack(trackId: string, importance: number): Promise<number>
}

export interface RecomputeDeps {
  readonly trackStore: ImportanceTrackStore
  readonly eventStore: ImportanceEventStore
}

/**
 * Recompute + persist a persisted track's importance from its current fields
 * (including any newly-assigned label) and re-stamp its object events. No-op
 * when the track is not (yet) persisted.
 */
export async function recomputeTrackImportance(
  deps: RecomputeDeps,
  trackId: string,
): Promise<void> {
  const track = await deps.trackStore.getPersistedByTrackId(trackId)
  if (track === null) return
  const peak = await deps.eventStore.peakForTrack(trackId)
  const { importance, reason } = computeImportance({
    peakConfidence: peak.peakConfidence,
    className: track.className,
    durationMs: track.lastSeen - track.firstSeen,
    peakBboxAreaFrac: peak.peakBboxAreaFrac,
    totalDistance: track.totalDistance,
    zonesVisited: track.zonesVisited,
    ...(displayLabel(track) !== undefined ? { label: displayLabel(track) } : {}),
  })
  const bestEventId = track.bestEventId ?? peak.bestEventId
  await deps.trackStore.setImportance(trackId, importance, reason, bestEventId)
  await deps.eventStore.setImportanceForTrack(trackId, importance)
}
