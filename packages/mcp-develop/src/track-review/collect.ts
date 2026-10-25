/** Page through the hub's tracks for a window — bounded in hours, tracks and wall time. */
import type { ReviewHub, TriageTrack } from './hub-api.js'

export const MAX_WINDOW_HOURS = 24 * 14
export const DEFAULT_WINDOW_HOURS = 72
/**
 * The server's own page ceiling for `listRecentTracks`
 * (`RECENT_TRACKS_MAX_LIMIT`, packages/types/src/capabilities/pipeline-analytics.cap.ts:1863).
 * A page is further cut to `floor(2000 / deviceCount)` rows by the fan-out budget
 * (`RECENT_FANOUT_ROW_BUDGET`, packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts:357),
 * so a merged 32-camera query was served 62 rows a page. We therefore walk ONE camera
 * per call, the only shape served the full page, and interleave the cameras
 * round-robin so a bound cuts every camera at the same age, not the last ones.
 */
export const PAGE_SIZE = 1000
/** Stop after this many tracks, however many pages that is. */
export const MAX_TRACKS = 20_000
/** Stop after this much wall time. */
export const MAX_WALK_MS = 60_000
const HOUR_MS = 3_600_000

export interface CollectRequest {
  readonly hours: number
  readonly deviceIds?: readonly number[]
  readonly classes?: readonly string[]
  readonly now: number
  /** Wall clock for the time bound; injectable for tests. */
  readonly clock?: () => number
  readonly maxTracks?: number
  readonly maxWalkMs?: number
}

export type TruncationReason = 'max-tracks' | 'max-wall-time'

export interface CollectedTracks {
  readonly tracks: readonly TriageTrack[]
  readonly cameras: number
  /** Camera id to display name, for the cameras that were walked. */
  readonly cameraNames: Readonly<Record<number, string>>
  readonly pages: number
  /** A bound stopped the walk before the window was exhausted. */
  readonly truncated: boolean
  /** Which bound hit; absent when the window was walked whole. */
  readonly truncatedBy?: TruncationReason
  /** Cameras whose window was walked to its end. */
  readonly camerasComplete: number
}

export function clampHours(hours: number | undefined): number {
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0) return DEFAULT_WINDOW_HOURS
  return Math.min(hours, MAX_WINDOW_HOURS)
}

export async function collectTracks(hub: ReviewHub, req: CollectRequest): Promise<CollectedTracks> {
  const cameras = await hub.listCameras()
  const known = new Set(cameras.map((c) => c.id))
  const deviceIds =
    req.deviceIds !== undefined && req.deviceIds.length > 0
      ? req.deviceIds.filter((id) => known.has(id))
      : cameras.map((c) => c.id)
  if (deviceIds.length === 0) {
    return {
      tracks: [],
      cameras: 0,
      cameraNames: {},
      pages: 0,
      truncated: false,
      camerasComplete: 0,
    }
  }
  const clock = req.clock ?? Date.now
  const maxTracks = req.maxTracks ?? MAX_TRACKS
  const deadline = clock() + (req.maxWalkMs ?? MAX_WALK_MS)
  const since = req.now - clampHours(req.hours) * HOUR_MS
  const tracks: TriageTrack[] = []
  // Camera -> next cursor; a camera leaves the map when its window is exhausted.
  let open = new Map<number, string | undefined>(deviceIds.map((id) => [id, undefined]))
  let pages = 0
  let truncatedBy: TruncationReason | undefined
  while (open.size > 0 && truncatedBy === undefined) {
    const next = new Map<number, string | undefined>()
    for (const [deviceId, cursor] of open) {
      if (truncatedBy === undefined) {
        if (tracks.length >= maxTracks) truncatedBy = 'max-tracks'
        else if (clock() >= deadline) truncatedBy = 'max-wall-time'
      }
      if (truncatedBy !== undefined) {
        next.set(deviceId, cursor)
        continue
      }
      const page = await hub.listRecentTracks({
        deviceIds: [deviceId],
        since,
        until: req.now,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(req.classes !== undefined ? { classes: req.classes } : {}),
      })
      pages++
      tracks.push(...page.tracks)
      if (page.nextCursor !== null) next.set(deviceId, page.nextCursor)
    }
    open = next
  }
  return {
    tracks,
    cameras: deviceIds.length,
    cameraNames: Object.fromEntries(
      cameras.filter((c) => deviceIds.includes(c.id)).map((c) => [c.id, c.name]),
    ),
    pages,
    truncated: truncatedBy !== undefined,
    ...(truncatedBy !== undefined ? { truncatedBy } : {}),
    camerasComplete: deviceIds.length - open.size,
  }
}
