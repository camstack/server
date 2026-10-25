/**
 * The training-export PLAN — what the archive will contain, decided before a
 * single JPEG is read.
 *
 * ## The shape of this feature, and why it is not the other shape
 *
 * Exporting the media of retrain-STAGING tracks looks like bulk work over stored
 * media, which in this repo means D56: node-pinned `runStatelessStep`, ONE
 * `modelId` for the whole pass, a node that cannot serve it REFUSES. None of
 * that applies here, and pretending it did would be cargo cult — there is no
 * inference in this path. No model is loaded, no step is dispatched, no crop is
 * derived (D52's `deriveDetailCropRect` is never called: stored bytes are copied
 * VERBATIM, which is the whole point of a training set — the pixels a future
 * fine-tune sees must be the pixels the pipeline saw).
 *
 * What DOES carry over from D56 is the part that was never about inference. The
 * incident behind it was `listByOwner` reading and base64-encoding every blob a
 * track owns — 23 files, 7.67 MB, ~10 MB of transient string per track — with
 * hub-main at 82 s busy out of 120 and `nodes.topology` degrading from 0.25 s to
 * 26 s for 43 minutes. An export over hundreds of tracks is exactly that I/O
 * shape, so it inherits both disciplines:
 *
 *  1. **The cheap question first.** This module reads only INDEX rows —
 *     `listInfoByOwner`, never `listByOwner` — so the operator learns the track
 *     count, the file count and the byte total for ~2 KB of reads per track,
 *     before anything decides to move gigabytes. A plan is also the only honest
 *     way to answer "is this export worth starting".
 *  2. **One blob at a time, with pacing.** The plan holds KEYS, not bytes. The
 *     streamer resolves one key, writes it, and yields — see
 *     `training-export-stream.ts`.
 *
 * ## The fan-out nobody remembers
 *
 * A track's media is spread over FOUR owner scopes, not one. Missing any of them
 * produces a dataset that looks complete and is quietly missing its face crops:
 *
 *  - `('track', trackId)` — keyFrame, keyFrameSmall, thumbnail, first/lastFrame,
 *    periodic snapshots. The bulk of the bytes.
 *  - `('face', 'face-<trackId>')` — the unassigned face crop.
 *  - `('plate', 'plate-<trackId>')` — the unassigned plate crop.
 *  - `('event', eventId)` for every object event of the track — the per-event
 *    crops.
 *
 * This mirrors `MediaStore.deleteByTracks` deliberately: the read side and the
 * delete side must walk the same graph, or one of them is wrong. An ENROLLED
 * face/plate crop is absent by design — assignment reowns it to `identity` /
 * `vehicle`, and an identity gallery image is not this track's training data.
 */

import type { Track } from '@camstack/types'
import { displayLabel } from '../pipeline/label-tier.js'
import { type MediaKind, SINGLE_INSTANCE_KINDS } from '../store/media-store.js'

/** One stored media file, placed in the archive. No bytes — a key and a name. */
export interface PlannedFile {
  /** Path inside the archive. */
  readonly archivePath: string
  /** Media id (D482) to resolve at stream time via `MediaStore.getById`. */
  readonly mediaId: number
  readonly kind: string
  readonly sizeBytes: number
  readonly timestamp: number
}

/** One track and every file it contributes. */
export interface PlannedTrack {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly classes: readonly string[]
  readonly zonesVisited: readonly string[]
  readonly importance?: number
  readonly files: readonly PlannedFile[]
}

export interface DeviceTotals {
  readonly deviceId: number
  readonly tracks: number
  readonly files: number
  readonly bytes: number
}

export interface TrainingExportPlan {
  readonly generatedAt: number
  readonly tracks: readonly PlannedTrack[]
  readonly totals: DeviceTotals[]
  readonly trackCount: number
  readonly fileCount: number
  readonly byteCount: number
  /** Hit the track ceiling — more marked tracks exist than this pass will carry. */
  readonly truncated: boolean
  /** Archive paths dropped because ustar cannot represent them. Never silent. */
  readonly skippedPaths: readonly string[]
}

/** The index-only reads the plan needs. Nothing here touches a blob. */
/**
 * One media INDEX row as the export plan reads it — the row's own id (D482),
 * its kind and how big it is. No blob is opened to produce it.
 */
export interface TrainingExportMediaRow {
  readonly mediaId: number
  readonly kind: string
  readonly sizeBytes: number
  readonly timestamp: number
}

export interface PlanReaders {
  /** Tracks in retrain STAGING for a device, newest first, at most `limit`.
   *  Never `trained` ones: those are evictable again (D81), so the sweep may
   *  delete one mid-pass and the manifest would describe files the archive does
   *  not contain. */
  readonly listMarkedTracks: (deviceId: number, limit: number) => Promise<readonly Track[]>
  /** Media INDEX rows for one owner — key, kind, size, timestamp. No bytes.
   *  `deviceId` scopes the list (D694): an object-event id is a reusable
   *  rowid, so an unscoped list can pick up another camera's leftovers. */
  readonly listMediaInfo: (
    ownerKind: string,
    ownerId: string,
    deviceId?: number,
  ) => Promise<readonly TrainingExportMediaRow[]>
  /** Object-event ids owned by these tracks, batched — each with the event's
   *  own timestamp so the plan can refuse media of another generation on a
   *  reused id (D694). */
  readonly listEventIdsForTracks: (
    trackIds: readonly string[],
  ) => Promise<readonly { eventId: string; trackId: string; recordAt: number }[]>
  readonly now: () => number
}

export interface BuildPlanInput {
  readonly deviceIds: readonly number[]
  /** Hard ceiling on tracks in one pass. */
  readonly maxTracks: number
}

const FACE_OWNER_PREFIX = 'face-'
const PLATE_OWNER_PREFIX = 'plate-'

/**
 * Tracks one export pass will carry.
 *
 * It is the per-device pin budget (500) times the four cameras a homelab hub
 * plausibly runs, rounded — i.e. "every track that can be marked", not a
 * throttle the operator has to think about. The ceiling exists so a fleet-wide
 * export cannot become an unbounded walk if the pin budget is ever raised, and
 * `truncated` in the summary says when it bit rather than quietly shipping a
 * partial dataset as if it were the whole one.
 */
export const TRAINING_EXPORT_MAX_TRACKS = 2000

/**
 * Archive path for one media file.
 *
 * The scope segment is not decoration: a track and its best object event can
 * both own a `crop` at the same millisecond, and without the segment the second
 * one would overwrite the first inside the archive — a silent loss that only
 * shows up as a dataset that is smaller than the manifest says.
 */
export function archivePathFor(params: {
  deviceId: number
  trackId: string
  scope: string
  kind: string
  timestamp: number
  singleInstance: boolean
}): string {
  const leaf = params.singleInstance
    ? `${params.kind}.jpg`
    : `${params.kind}-${params.timestamp}.jpg`
  const dir = params.scope === '' ? '' : `${params.scope}/`
  return `tracks/${params.deviceId}/${params.trackId}/${dir}${leaf}`
}

/**
 * Does this kind hold exactly ONE row per owner?
 *
 * It used to be read off the media KEY — an accumulating kind's key ended in
 * `:<timestamp>` and a single-instance one stopped at the kind — and the
 * comment here said that reading it off the key "keeps this from drifting when
 * a kind changes sides". A surrogate id spells nothing (D482), so the trick is
 * gone; asking the AUTHORITY (`SINGLE_INSTANCE_KINDS`, the set the write path
 * itself uses) is the same guarantee without the encoding, and it drifts less,
 * not more: there is now exactly one list instead of a list and a spelling of
 * it.
 */
function isSingleInstanceArchiveKind(kind: string): boolean {
  return SINGLE_INSTANCE_KINDS.has(kind as MediaKind)
}

/**
 * Build the plan. Index reads only — the returned plan holds no image bytes and
 * is safe to send over tRPC.
 */
export async function buildTrainingExportPlan(
  readers: PlanReaders,
  input: BuildPlanInput,
): Promise<TrainingExportPlan> {
  const tracks: PlannedTrack[] = []
  const skippedPaths: string[] = []
  let truncated = false
  let remaining = input.maxTracks

  for (const deviceId of input.deviceIds) {
    if (remaining <= 0) break
    const marked = await readers.listMarkedTracks(deviceId, remaining + 1)
    if (marked.length > remaining) truncated = true
    const take = marked.slice(0, remaining)
    remaining -= take.length
    if (take.length === 0) continue

    const eventLinks = await readers.listEventIdsForTracks(take.map((t) => t.trackId))
    const eventsByTrack = new Map<string, { eventId: string; recordAt: number }[]>()
    for (const link of eventLinks) {
      const list = eventsByTrack.get(link.trackId)
      if (list) list.push({ eventId: link.eventId, recordAt: link.recordAt })
      else eventsByTrack.set(link.trackId, [{ eventId: link.eventId, recordAt: link.recordAt }])
    }

    for (const track of take) {
      const files: PlannedFile[] = []
      const owners: {
        ownerKind: string
        ownerId: string
        scope: string
        recordAt?: number
      }[] = [
        { ownerKind: 'track', ownerId: track.trackId, scope: '' },
        { ownerKind: 'face', ownerId: `${FACE_OWNER_PREFIX}${track.trackId}`, scope: 'face' },
        { ownerKind: 'plate', ownerId: `${PLATE_OWNER_PREFIX}${track.trackId}`, scope: 'plate' },
        // D476: `listEventIdsForTracks` returns OBJECT-event ids only (the
        // only event kind a track owns) — `ownerKind: 'object'`, not `'event'`.
        ...(eventsByTrack.get(track.trackId) ?? []).map((ev) => ({
          ownerKind: 'object',
          ownerId: ev.eventId,
          scope: `events/${ev.eventId}`,
          recordAt: ev.recordAt,
        })),
      ]

      for (const owner of owners) {
        // D694: scope object media to this track's camera, then keep only rows
        // stamped with the event's own timestamp (the only object writer does).
        const infos = await readers.listMediaInfo(
          owner.ownerKind,
          owner.ownerId,
          owner.ownerKind === 'object' ? track.deviceId : undefined,
        )
        const kept =
          owner.recordAt === undefined
            ? infos
            : infos.filter((info) => info.timestamp === owner.recordAt)
        for (const info of kept) {
          const archivePath = archivePathFor({
            deviceId: track.deviceId,
            trackId: track.trackId,
            scope: owner.scope,
            kind: info.kind,
            timestamp: info.timestamp,
            singleInstance: isSingleInstanceArchiveKind(info.kind),
          })
          files.push({
            archivePath,
            mediaId: info.mediaId,
            kind: info.kind,
            sizeBytes: info.sizeBytes,
            timestamp: info.timestamp,
          })
        }
      }

      tracks.push({
        trackId: track.trackId,
        deviceId: track.deviceId,
        className: track.className,
        ...(displayLabel(track) !== undefined ? { label: displayLabel(track) } : {}),
        firstSeen: track.firstSeen,
        lastSeen: track.lastSeen,
        classes: track.classes ?? [],
        zonesVisited: track.zonesVisited,
        ...(track.importance !== undefined ? { importance: track.importance } : {}),
        files,
      })
    }
  }

  const perDevice = new Map<number, { tracks: number; files: number; bytes: number }>()
  let fileCount = 0
  let byteCount = 0
  for (const track of tracks) {
    const agg = perDevice.get(track.deviceId) ?? { tracks: 0, files: 0, bytes: 0 }
    agg.tracks += 1
    for (const file of track.files) {
      agg.files += 1
      agg.bytes += file.sizeBytes
      fileCount += 1
      byteCount += file.sizeBytes
    }
    perDevice.set(track.deviceId, agg)
  }

  return {
    generatedAt: readers.now(),
    tracks,
    totals: [...perDevice.entries()].map(([deviceId, agg]) => ({ deviceId, ...agg })),
    trackCount: tracks.length,
    fileCount,
    byteCount,
    truncated,
    skippedPaths,
  }
}
