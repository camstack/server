/**
 * Disk-wins reconcile for pipeline analytics.
 *
 * After a recordings wipe the SQLite index still holds ghost tracks, events and
 * media rows. The track is the primary index: a row whose blobs are gone is
 * deleted, including favourited and staging pins (those pins are against age
 * retention, not against a missing file). Trackless motion/audio events with no
 * remaining blob are dropped — including snapshot-less rows. Enrolled gallery
 * media (`identity` / `vehicle` / `scene`) is never probed.
 */
import type { EventOwnerType } from '@camstack/types'
import { EVENT_OWNER_TYPES } from '@camstack/types'
import {
  FACE_MEDIA_OWNER_PREFIX,
  isMediaOwnerKind,
  PLATE_MEDIA_OWNER_PREFIX,
} from '../store/media-store.js'
import { isRetentionExemptOwnerKind } from './retention-model.js'

/** Is this an event-owned media row — `motion` / `object` / `audio` (D476;
 *  `event` used to cover all three under one owner kind). */
function isEventOwnedMediaRow(ownerKind: string): boolean {
  return (EVENT_OWNER_TYPES as readonly string[]).includes(ownerKind)
}

export function shouldProbeMediaRow(ownerKind: string): boolean {
  if (!isMediaOwnerKind(ownerKind)) return true
  return !isRetentionExemptOwnerKind(ownerKind)
}

export function trackIdFromMediaOwner(ownerKind: string, ownerId: string): string | null {
  if (ownerKind === 'track') return ownerId
  if (ownerKind === 'face' && ownerId.startsWith(FACE_MEDIA_OWNER_PREFIX)) {
    return ownerId.slice(FACE_MEDIA_OWNER_PREFIX.length)
  }
  if (ownerKind === 'plate' && ownerId.startsWith(PLATE_MEDIA_OWNER_PREFIX)) {
    return ownerId.slice(PLATE_MEDIA_OWNER_PREFIX.length)
  }
  return null
}

export function emptyTrackIds(
  allTrackIds: readonly string[],
  withMedia: ReadonlySet<string>,
): readonly string[] {
  return allTrackIds.filter((id) => !withMedia.has(id))
}

/**
 * The key an event-owned media row occupies in the "this event still has
 * media" set — `(ownerKind, ownerId)`, never the id alone (D480).
 *
 * The set used to be keyed by `ownerId` across all three owner kinds, which
 * was safe while event ids were UUIDs. D474 made an event id a per-table rowid
 * alias and the ranges overlap completely: a surviving `motion:5` blob then
 * spoke for `object:5` and `audio:5` too, and a trackless audio event whose
 * blobs were all gone kept its row because some unrelated motion visit
 * numbered 5 still had one.
 */
export function eventMediaKey(ownerKind: string, ownerId: string): string {
  return `${ownerKind}:${ownerId}`
}

export function emptyEventIds(
  trackless: readonly EventRef[],
  withRemaining: ReadonlySet<string>,
): readonly EventRef[] {
  return trackless.filter((ref) => !withRemaining.has(eventMediaKey(ref.table, ref.id)))
}

/** An event named by its TABLE and its id — the pair that identifies it. */
export interface EventRef {
  readonly table: EventOwnerType
  readonly id: string
}

export interface MediaIndexRow {
  /** The media row's own id (D482). */
  readonly mediaId: number
  readonly ownerKind: string
  readonly ownerId: string
  readonly path: string
  readonly location: string
}

export interface DiskReconcileDeps {
  pageMedia(deviceId: number, offset: number, limit: number): Promise<readonly MediaIndexRow[]>
  blobExists(location: string, relativePath: string): Promise<boolean>
  deleteMediaId(mediaId: number): Promise<void>
  listTrackIds(deviceId: number): Promise<readonly string[]>
  listTracklessEventIds(
    deviceId: number,
  ): Promise<{ motion: readonly string[]; audio: readonly string[] }>
  deleteTracks(trackIds: readonly string[]): Promise<{ deleted: number }>
  /** Delete these rows, each from the TABLE its ref names. */
  deleteEvents(refs: readonly EventRef[]): Promise<void>
}

export interface DiskReconcileCounts {
  readonly mediaDropped: number
  readonly tracks: number
  readonly events: number
}

const PAGE = 500

export async function reconcileDeviceFromDisk(
  deps: DiskReconcileDeps,
  deviceId: number,
): Promise<DiskReconcileCounts> {
  const tracksWithMedia = new Set<string>()
  const eventsWithMedia = new Set<string>()
  const missingMediaIds: number[] = []
  let offset = 0
  for (;;) {
    const page = await deps.pageMedia(deviceId, offset, PAGE)
    if (page.length === 0) break
    for (const row of page) {
      if (!shouldProbeMediaRow(row.ownerKind)) continue
      const exists = row.path.length === 0 ? false : await deps.blobExists(row.location, row.path)
      if (exists) {
        const trackId = trackIdFromMediaOwner(row.ownerKind, row.ownerId)
        if (trackId !== null) tracksWithMedia.add(trackId)
        if (isEventOwnedMediaRow(row.ownerKind)) {
          eventsWithMedia.add(eventMediaKey(row.ownerKind, row.ownerId))
        }
        continue
      }
      missingMediaIds.push(row.mediaId)
    }
    offset += page.length
    if (page.length < PAGE) break
  }

  for (const mediaId of missingMediaIds) await deps.deleteMediaId(mediaId)

  const doomedTracks = emptyTrackIds(await deps.listTrackIds(deviceId), tracksWithMedia)
  let tracks = 0
  if (doomedTracks.length > 0) {
    const result = await deps.deleteTracks(doomedTracks)
    tracks = result.deleted
  }

  const trackless = await deps.listTracklessEventIds(deviceId)
  const doomedEvents = emptyEventIds(
    [
      ...trackless.motion.map((id) => ({ table: 'motion', id }) as const),
      ...trackless.audio.map((id) => ({ table: 'audio', id }) as const),
    ],
    eventsWithMedia,
  )
  const EVENT_BATCH = 500
  for (let i = 0; i < doomedEvents.length; i += EVENT_BATCH) {
    await deps.deleteEvents(doomedEvents.slice(i, i + EVENT_BATCH))
  }

  return { mediaDropped: missingMediaIds.length, tracks, events: doomedEvents.length }
}
