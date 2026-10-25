/**
 * The bodies behind `debug.listTracks`, `debug.analyze` and the bundle plan.
 *
 * Extracted from the addon class behind a narrow seam so the whole surface is
 * testable without a store, a fork or a hub — the same shape
 * `rebuild-source-loader` uses for its inventory reads.
 *
 * Everything here is INDEX READS. No blob is opened: the export handler streams
 * those one at a time, by key, once the plan is known.
 */

import type { IScopedLogger, MediaFileRef, ObjectEvent, Track } from '@camstack/types'
import type { MediaProvenance } from '../store/media-store.js'
import {
  type DebugAnalyzeInput,
  type DebugAnalyzeOutput,
  type DebugListTracksInput,
  type DebugListTracksOutput,
  type DebugTrackListItem,
  MAX_DEBUG_TRACKS_PER_DEVICE,
  MAX_EXPORT_TRACKS,
} from './debug-actions.js'
import { type DebugBundlePlan, type DebugBundleTrack, planTrackMediaNames } from './debug-bundle.js'
import {
  buildDebugTrackReport,
  type DebugTrackFacts,
  type DebugTrackInventory,
  type DebugTrackReport,
  trackDurationMs,
} from './debug-track-analysis.js'

/**
 * The three media owners one track's files hang off.
 *
 * A track's face and plate crops are NOT owned by `track:<trackId>` — they live
 * under `face-<trackId>` and `plate-<trackId>`. An inventory that reads only the
 * first owner reports MISSING_BEST_CROP on every track that produced a face,
 * which is the opposite of the truth.
 */
const MEDIA_OWNERS = [
  { kind: 'track', prefix: '' },
  { kind: 'face', prefix: 'face-' },
  { kind: 'plate', prefix: 'plate-' },
] as const

export type DebugMediaOwnerKind = (typeof MEDIA_OWNERS)[number]['kind']

export interface DebugServiceDeps {
  /** Every camera that has persisted tracks — the "all cameras" case. */
  readonly listDeviceIds: () => Promise<readonly number[]>
  readonly listDebugTracks: (deviceId: number, limit: number) => Promise<readonly Track[]>
  readonly getTrack: (trackId: string) => Promise<Track | null>
  readonly listMediaInfo: (
    ownerKind: DebugMediaOwnerKind,
    ownerId: string,
  ) => Promise<readonly MediaFileRef[]>
  readonly listEvents: (trackId: string) => Promise<readonly ObjectEvent[]>
  /**
   * Provenance of the track's stored `thumbnail`, index row only (D276).
   * `null` = no thumbnail row exists.
   *
   * A separate dep rather than a field on {@link DebugServiceDeps.listMediaInfo}
   * because `listInfoByOwner` returns the index shape `MediaFileRef`, and provenance
   * is deliberately store-internal — it is never published on a cap output.
   * This bridge is a custom action, so it may carry it; the cap may not.
   */
  readonly trackThumbnailProvenance: (trackId: string) => Promise<MediaProvenance | null>
  /**
   * Can this media row's BLOB actually be read? One probe per row, no bytes
   * returned.
   *
   * The one place this analysis leaves the index, and it earns the trip: a row
   * whose blob is unreachable is counted by every index read in this file and
   * DROPPED by the two reads that serve pixels (`MediaStore.listByOwner`,
   * `getById`), so without the probe the tab reports six tiles for a track the
   * viewer draws blank. Bounded by the analyze cap (200 tracks), and it fetches
   * no bytes — `exists`, not `read`.
   *
   * A probe that cannot answer must report FALSE only when it means it. An
   * unreachable volume is not an unreadable row, and the caller decides which
   * it has; this dep answers what it knows.
   */
  readonly probeMediaBlob: (mediaId: number) => Promise<boolean>
  readonly logger: IScopedLogger
  readonly now: () => number
}

function toFacts(track: Track): DebugTrackFacts {
  return {
    trackId: track.trackId,
    deviceId: track.deviceId,
    className: track.className,
    ...(track.label === undefined ? {} : { label: track.label }),
    ...(track.labelScore === undefined ? {} : { labelScore: track.labelScore }),
    ...(track.labelMeta?.stepId === undefined ? {} : { labelStepId: track.labelMeta.stepId }),
    firstSeen: track.firstSeen,
    lastSeen: track.lastSeen,
    active: track.active,
    positionCount: track.positions.length,
    snapshotCount: track.snapshots.length,
    ...(track.importance === undefined ? {} : { importance: track.importance }),
    ...(track.bestEventId === undefined ? {} : { bestEventId: track.bestEventId }),
    ...(track.previewMissReason === undefined
      ? {}
      : { previewMissReason: track.previewMissReason }),
    // Absent ≠ false on both (see the field docs): copied only when present so
    // the analysis can tell "no face" from "this row predates the column".
    ...(track.hasFace === undefined ? {} : { hasFace: track.hasFace }),
    ...(track.hasEmbeddedFace === undefined ? {} : { hasEmbeddedFace: track.hasEmbeddedFace }),
  }
}

/**
 * The list row.
 *
 * Every field here is already on the `slim` row `listDebug` fetched, so the
 * list stays exactly one indexed query per camera. That is what lets the tab
 * render a card — a tile, a name, the operator flags — before `debug.analyze`
 * has said anything: the cheap half answers "what did the operator mark", and
 * only the expensive half answers "what is wrong with it".
 */
function toListItem(track: Track): DebugTrackListItem {
  return {
    trackId: track.trackId,
    deviceId: track.deviceId,
    className: track.className,
    ...(track.label === undefined ? {} : { label: track.label }),
    ...(track.subLabel === undefined ? {} : { subLabel: track.subLabel }),
    firstSeen: track.firstSeen,
    lastSeen: track.lastSeen,
    durationMs: trackDurationMs(toFacts(track)),
    active: track.active,
    ...(track.importance === undefined ? {} : { importance: track.importance }),
    ...(track.bestEventId === undefined ? {} : { bestEventId: track.bestEventId }),
    ...(track.markForTrain === undefined ? {} : { markForTrain: track.markForTrain }),
    ...(track.favourited === undefined ? {} : { favourited: track.favourited }),
    ...(track.previewMissReason === undefined
      ? {}
      : { previewMissReason: track.previewMissReason }),
  }
}

/** Which cameras to sweep — the caller's list, else every camera with tracks. */
async function resolveDeviceIds(
  deps: DebugServiceDeps,
  requested: readonly number[] | undefined,
): Promise<readonly number[]> {
  if (requested !== undefined && requested.length > 0) return requested
  return deps.listDeviceIds()
}

/**
 * The marked set, newest first per camera.
 *
 * One indexed query per camera and nothing else — no media, no events, and no
 * trajectory: `listDebug` reads `slim` rows, so nothing here parses the
 * `positions` JSON. The counts an operator wants (media, events, positions) come
 * from `debug.analyze`, per track, by id.
 *
 * A camera that hits `limit` sets `truncated`, because a list that silently
 * stops at 200 is how an operator concludes a mark did not take.
 */
export async function listDebugTracks(
  deps: DebugServiceDeps,
  input: DebugListTracksInput,
): Promise<DebugListTracksOutput> {
  const limit = input.limit ?? MAX_DEBUG_TRACKS_PER_DEVICE
  const deviceIds = await resolveDeviceIds(deps, input.deviceIds)
  const tracks: DebugTrackListItem[] = []
  let truncated = false
  for (const deviceId of deviceIds) {
    const rows = await deps.listDebugTracks(deviceId, limit)
    if (rows.length >= limit) {
      truncated = true
      deps.logger.warn('debug listTracks hit the per-camera cap', {
        tags: { deviceId },
        meta: { deviceId, limit },
      })
    }
    for (const row of rows) tracks.push(toListItem(row))
  }
  // Newest first ACROSS cameras — the tab is read as one chronology.
  return { tracks: tracks.toSorted((a, b) => b.lastSeen - a.lastSeen), truncated }
}

/** One track's inventory, and the events it was counted from. */
export interface DebugTrackGathering {
  readonly inventory: DebugTrackInventory
  readonly events: readonly ObjectEvent[]
}

/**
 * Gather one track's whole inventory: three media queries plus its events.
 *
 * The events are RETURNED as well as counted — the bundle writes them to
 * `events.json`, and fetching them a second time there would double the query
 * count of an export for a number the caller already holds.
 */
async function gatherTrack(deps: DebugServiceDeps, track: Track): Promise<DebugTrackGathering> {
  const media: MediaFileRef[] = []
  for (const owner of MEDIA_OWNERS) {
    media.push(...(await deps.listMediaInfo(owner.kind, `${owner.prefix}${track.trackId}`)))
  }
  const events = await deps.listEvents(track.trackId)
  // A fourth indexed read, `limit: 1`, and the only way this bridge can answer
  // "is that face crop standing in for a person?" — `listMediaInfo` returns the
  // cap shape, which does not carry provenance.
  const thumbnailProvenance = await deps.trackThumbnailProvenance(track.trackId)
  // Sequential on purpose: this walks a marked SET, and a burst of parallel
  // stats against the footage volume is exactly the load the rest of this
  // module refuses to place on a live hub.
  const unreadableMedia: number[] = []
  for (const row of media) {
    if (!(await deps.probeMediaBlob(row.mediaId))) unreadableMedia.push(row.mediaId)
  }
  return {
    inventory: {
      facts: toFacts(track),
      media,
      eventCount: events.length,
      thumbnailProvenance,
      unreadableMedia,
    },
    events,
  }
}

/**
 * Analyse the named tracks.
 *
 * An id that no longer resolves is reported in `vanished` rather than dropped: a
 * `debug` mark does not pin retention (D81), so a track CAN disappear between
 * the list and the analysis, and the tab has to be able to say so instead of
 * quietly showing fewer rows than it listed.
 */
export async function analyzeDebugTracks(
  deps: DebugServiceDeps,
  input: DebugAnalyzeInput,
): Promise<DebugAnalyzeOutput> {
  const reports: DebugTrackReport[] = []
  const vanished: string[] = []
  for (const trackId of input.trackIds) {
    const track = await deps.getTrack(trackId)
    if (track === null) {
      vanished.push(trackId)
      deps.logger.info('debug analyze — track no longer exists', { meta: { trackId } })
      continue
    }
    const gathered = await gatherTrack(deps, track)
    reports.push(buildDebugTrackReport(gathered.inventory))
  }
  return { reports, vanished }
}

/**
 * Plan the bundle — INDEX READS ONLY, no blob touched.
 *
 * The plan is what the manifest is built from and what the handler streams
 * against, so it must be produced in one pass: a plan that re-queried while
 * streaming could describe a set the archive does not contain.
 *
 * **Bounded at {@link MAX_EXPORT_TRACKS}, far below the list cap.** Listing is
 * index rows; exporting is every blob those rows point at, base64-decoded and
 * pushed through the hub's one thread. An unbounded "export all" is a
 * self-inflicted outage on a busy hub, so the plan stops and SAYS it stopped
 * rather than quietly shipping less than the button offered.
 *
 * Each row is re-read at full projection: `listDebugTracks` deliberately returns
 * `slim` rows, and a bundle built from those would report ZERO_POSITIONS on
 * every track and write an empty `positions` array into `track.json`.
 */
export async function buildDebugBundlePlan(
  deps: DebugServiceDeps,
  requestedDeviceIds: readonly number[],
): Promise<DebugBundlePlan> {
  const deviceIds = await resolveDeviceIds(deps, requestedDeviceIds)
  const tracks: DebugBundleTrack[] = []
  const covered: number[] = []
  let capped = false
  for (const deviceId of deviceIds) {
    if (tracks.length >= MAX_EXPORT_TRACKS) {
      capped = true
      break
    }
    const rows = await deps.listDebugTracks(deviceId, MAX_DEBUG_TRACKS_PER_DEVICE)
    if (rows.length > 0) covered.push(deviceId)
    for (const row of rows) {
      if (tracks.length >= MAX_EXPORT_TRACKS) {
        capped = true
        break
      }
      // The slim row cannot answer the analysis; the full one is a single
      // indexed read, and only for the tracks that are actually being exported.
      const full = (await deps.getTrack(row.trackId)) ?? row
      const { inventory, events } = await gatherTrack(deps, full)
      tracks.push({
        report: buildDebugTrackReport(inventory),
        track: full,
        events,
        media: planTrackMediaNames(inventory.media),
      })
    }
  }
  if (capped) {
    deps.logger.warn('debug export capped — more marked tracks than one bundle may carry', {
      meta: { limit: MAX_EXPORT_TRACKS, deviceIds: covered },
    })
  }
  return { generatedAt: deps.now(), deviceIds: covered, tracks, capped }
}
