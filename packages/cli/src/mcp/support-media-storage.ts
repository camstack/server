/**
 * `media_storage_check`: do the stored events find their media, and where does
 * that media sit? One read-only answer to "empty thumbnails everywhere":
 *
 *  1. every storage location that can hold event media — class, mode
 *     (`storage-location-mode`, D385), a masked root, whether its volume was
 *     readable, how much CamStack holds there (D388) — with the number of stored
 *     media rows and bytes that name it (`pipelineAnalytics.getMediaLocationCensus`,
 *     indexed aggregates, no walk, D447);
 *  2. findings: rows that name a location that no longer exists, rows on a
 *     disabled location (unreadable by choice), rows on a read-only one (served,
 *     never written), legacy rows with no location and no default to resolve to;
 *  3. a bounded, paginated sample per camera of its recent tracks and whether
 *     the thumbnail / keyFrame still resolve in the media index (the same read
 *     `debug_report` makes, reused).
 *
 * Every read is independent; one that fails is `null` with a reason, never a
 * zero (D393). Roots are masked to their first two and last segment.
 */
import {
  MediaLocationCensusSchema,
  resolveLocationMode,
  StorageLocationSchema,
} from '@camstack/types'
import type { MediaLocationCensus, StorageLocationMode } from '@camstack/types'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { tracksSection, type TracksSection } from './debug-report.js'
import { readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { adminRefusal, mapLimit, READ_CONCURRENCY } from './setup-assist-common.js'
import { readCameraRows } from './setup-camera-reads.js'

export const MEDIA_CLASSES: readonly string[] = ['eventMedia', 'galleryMedia']
export const CAMERAS_PER_PAGE = 12
export const TRACKS_PER_CAMERA = 6
export const SAMPLE_WINDOW_DAYS = 7
export const MISSING_LISTED_PER_CAMERA = 3

export interface MediaStorageArgs {
  readonly cameraOffset?: number
  readonly cameras?: number
  readonly tracksPerCamera?: number
}

export interface LocationCensusView {
  readonly id: string
  readonly class: string
  readonly mode: StorageLocationMode
  readonly nodeId: string | null
  readonly root: string | null
  /** `true`: the volume was read. `null`: remote or unreachable - unknown. */
  readonly volumeReadable: true | null
  readonly freeBytes: number | null
  readonly heldBytes: number | null
  readonly mediaRows: number | null
  readonly mediaBytes: number | null
}

export interface MediaFinding {
  readonly severity: 'problem' | 'info'
  readonly code:
    | 'location-gone'
    | 'location-disabled'
    | 'location-readonly'
    | 'unstamped-unresolvable'
  readonly rows: number
  readonly locationId: string | null
  readonly message: string
}

export interface CameraSample {
  readonly deviceId: number
  readonly checked: number
  readonly withThumbnail: number
  readonly withKeyFrame: number
  readonly missingThumbnail: number
  readonly noMediaAtAll: number
  readonly unread: number
  /** At most MISSING_LISTED_PER_CAMERA tracks that have no thumbnail. */
  readonly missing: readonly {
    readonly trackId: string
    readonly className: string
    readonly firstSeen: string
    readonly kinds: { readonly [kind: string]: number } | null
  }[]
}

export interface MediaStorageResult {
  readonly status: 'ok'
  readonly locations: readonly LocationCensusView[] | null
  readonly census: {
    readonly totalRows: number
    readonly unstampedRows: number
    readonly unlistedRows: number
  } | null
  readonly findings: readonly MediaFinding[]
  readonly sample: {
    readonly window: string
    readonly camerasTotal: number
    readonly cameraOffset: number
    /** Pass this as `cameraOffset` for the next page; `null` when this was the last. */
    readonly nextCameraOffset: number | null
    readonly cameras: readonly CameraSample[]
  } | null
  readonly unavailable: { readonly [part: string]: string }
  readonly notes: readonly string[]
}

const LocationListSchema = z.array(StorageLocationSchema)

/** `/mnt/user/appdata/camstack/events` becomes `/mnt/user/…/events`: the mount shape, not the layout. */
export function maskRoot(root: unknown): string | null {
  if (typeof root !== 'string' || root === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) return '[remote url]'
  const parts = root.split(/[\\/]/).filter((p) => p !== '')
  if (parts.length <= 3) return root
  const lead = root.startsWith('/') ? '/' : ''
  return `${lead}${parts.slice(0, 2).join('/')}/…/${parts[parts.length - 1] ?? ''}`
}

/** The location bare legacy rows (no `locationId`) resolve to, or null: the orchestrator's rule. */
function legacyTargetOf(ids: readonly string[]): string | null {
  const ofType = ids.filter((id) => id.startsWith('eventMedia:'))
  if (ofType.length === 1) return ofType[0] ?? null
  return ofType.find((id) => id === 'eventMedia:default') ?? null
}

/** Pure: what the numbers say is wrong. */
export function findingsOf(
  locations: readonly LocationCensusView[],
  census: MediaLocationCensus,
): MediaFinding[] {
  const out: MediaFinding[] = []
  if (census.unlisted.rows > 0) {
    out.push({
      severity: 'problem',
      code: 'location-gone',
      rows: census.unlisted.rows,
      locationId: null,
      message: `${String(census.unlisted.rows)} stored media rows name a storage location that no longer exists: their thumbnails and key frames cannot be read`,
    })
  }
  for (const l of locations) {
    const rows = l.mediaRows ?? 0
    if (rows === 0) continue
    if (l.mode === 'disabled') {
      out.push({
        severity: 'problem',
        code: 'location-disabled',
        rows,
        locationId: l.id,
        message: `${String(rows)} media rows sit on ${l.id}, which is disabled: not read until it is re-enabled`,
      })
    } else if (l.mode === 'readonly' || l.mode === 'drain') {
      out.push({
        severity: 'info',
        code: 'location-readonly',
        rows,
        locationId: l.id,
        message: `${String(rows)} media rows sit on ${l.id}, which is ${l.mode}: still served, never written`,
      })
    }
  }
  const ids = locations.filter((l) => l.class === 'eventMedia').map((l) => l.id)
  if (census.unstamped.rows > 0 && legacyTargetOf(ids) === null) {
    out.push({
      severity: 'problem',
      code: 'unstamped-unresolvable',
      rows: census.unstamped.rows,
      locationId: null,
      message: `${String(census.unstamped.rows)} legacy media rows have no location and there is neither a single eventMedia location nor eventMedia:default to resolve them to`,
    })
  }
  return out
}

function sampleOf(deviceId: number, tracks: TracksSection): CameraSample {
  const missing = tracks.items
    .filter((i) => i.active !== true && i.className !== 'audio' && i.thumbnail === false)
    .slice(0, MISSING_LISTED_PER_CAMERA)
    .map((i) => ({
      trackId: i.trackId,
      className: i.className,
      firstSeen: new Date(i.firstSeen).toISOString(),
      kinds: i.kinds,
    }))
  return {
    deviceId,
    checked: tracks.checked,
    withThumbnail: tracks.withThumbnail,
    withKeyFrame: tracks.withKeyFrame,
    missingThumbnail: tracks.items.filter(
      (i) => i.active !== true && i.className !== 'audio' && i.thumbnail === false,
    ).length,
    noMediaAtAll: tracks.noMediaAtAll,
    unread: tracks.unreadMedia,
    missing,
  }
}

export async function mediaStorageCheck(
  ctx: McpContext,
  args: MediaStorageArgs = {},
  now: number = Date.now(),
): Promise<MediaStorageResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<MediaStorageResult | RefusedResult> => {
    const refused = adminRefusal(connection, 'media_storage_check (storage locations, events)')
    if (refused) return refused
    const client = connection.client
    const unavailable: { [part: string]: string } = {}
    const notes: string[] = []

    const rows = await readQuery(client, 'storage.listLocations', {}, LocationListSchema)
    if (!rows.ok) unavailable['locations'] = rows.reason
    const mediaRows = rows.ok ? rows.value.filter((l) => MEDIA_CLASSES.includes(l.type)) : []
    if (rows.ok && mediaRows.length === 0)
      notes.push('no eventMedia or galleryMedia location is configured')
    const asked = mediaRows.slice(0, 50)
    if (mediaRows.length > asked.length) notes.push('only the first 50 locations were counted')

    const census = rows.ok
      ? await readQuery(
          client,
          'pipelineAnalytics.getMediaLocationCensus',
          { locationIds: asked.map((l) => l.id) },
          MediaLocationCensusSchema,
        )
      : null
    if (census !== null && !census.ok) unavailable['census'] = census.reason
    const counted = census !== null && census.ok ? census.value : null

    const locations: LocationCensusView[] | null = rows.ok
      ? mediaRows.map((l) => {
          const c = counted?.locations.find((x) => x.locationId === l.id)
          return {
            id: l.id,
            class: l.type,
            mode: resolveLocationMode(l),
            nodeId: l.nodeId ?? null,
            root: maskRoot(l.config['basePath']),
            volumeReadable: l.capacity ? true : null,
            freeBytes: l.capacity?.availableBytes ?? null,
            heldBytes: l.owned?.bytes ?? null,
            mediaRows: c ? c.rows : null,
            mediaBytes: c ? c.bytes : null,
          }
        })
      : null
    const findings = locations !== null && counted !== null ? findingsOf(locations, counted) : []

    // The per-camera sample, one page.
    const cameraRows = await readCameraRows(client)
    if (!cameraRows.ok) unavailable['cameras'] = cameraRows.reason
    let sample: MediaStorageResult['sample'] = null
    if (cameraRows.ok) {
      const enabled = cameraRows.value.filter((c) => !c.disabled).toSorted((a, b) => a.id - b.id)
      const offset = Math.max(0, args.cameraOffset ?? 0)
      const size = Math.min(CAMERAS_PER_PAGE, Math.max(1, args.cameras ?? CAMERAS_PER_PAGE))
      const perCamera = Math.min(
        TRACKS_PER_CAMERA,
        Math.max(1, args.tracksPerCamera ?? TRACKS_PER_CAMERA),
      )
      const page = enabled.slice(offset, offset + size)
      const window = { sinceMs: now - SAMPLE_WINDOW_DAYS * 86_400_000, untilMs: now }
      const cameras = await mapLimit(
        page,
        READ_CONCURRENCY,
        async (cam): Promise<CameraSample | null> => {
          const tracks = await tracksSection(
            client,
            cam.id,
            window,
            { base: null },
            unavailable,
            perCamera,
          )
          return tracks === null ? null : sampleOf(cam.id, tracks)
        },
      )
      sample = {
        window: `${String(SAMPLE_WINDOW_DAYS)}d`,
        camerasTotal: enabled.length,
        cameraOffset: offset,
        nextCameraOffset: offset + size < enabled.length ? offset + size : null,
        cameras: cameras.filter((c): c is CameraSample => c !== null),
      }
    }
    notes.push(
      'mediaRows counts stored media rows (thumbnails, key frames, ...) that name the location, not events; "resolves" means the media index still holds the kind, the blob is not fetched.',
    )
    return {
      status: 'ok',
      locations,
      census: counted
        ? {
            totalRows: counted.total.rows,
            unstampedRows: counted.unstamped.rows,
            unlistedRows: counted.unlisted.rows,
          }
        : null,
      findings,
      sample,
      unavailable,
      notes,
    }
  })
}
