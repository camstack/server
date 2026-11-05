/**
 * `media_storage_check`: do the stored events find their media, and where does
 * that media sit? One read-only answer to "empty thumbnails everywhere":
 *
 *  1. every storage location that can hold event media, or that holds a stored
 *     media row — class, mode (`storage-location-mode`, D385), masked roots,
 *     whether its volume was readable, how much CamStack holds there (D388) —
 *     with the number of stored media rows and bytes that name it
 *     (`pipelineAnalytics.getMediaLocationCensus`: one indexed aggregate per
 *     location, plus one covering-index scan, O(rows), for the total; D447);
 *  2. findings: rows that name a location that no longer exists (judged ONLY
 *     when EVERY location id the hub lists was asked, in chunks; otherwise
 *     unknown, never a guess), rows on a disabled location (unreadable by
 *     choice), on a draining one (being emptied), on a read-only one (served,
 *     never written), legacy rows with no location and no default to resolve to;
 *  3. a bounded, paginated sample per camera of its recent tracks and whether
 *     the thumbnail / keyFrame still resolve in the media index (the same read
 *     `debug_report` makes, reused).
 *
 * Every read is independent; one that fails is `null` with a reason, never a
 * zero (D393). Roots are masked to their first and last segment (`path-mask.ts`).
 */
import {
  MediaLocationCensusSchema,
  resolveLocationMode,
  StorageLocationSchema,
} from '@camstack/types'
import type { StorageLocationMode } from '@camstack/types'
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { tracksSection, type TracksSection } from './debug-report.js'
import { maskPath } from './path-mask.js'
import { readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { adminRefusal, mapLimit, READ_CONCURRENCY } from './setup-assist-common.js'
import { readCameraRows } from './setup-camera-reads.js'

export const MEDIA_CLASSES: readonly string[] = ['eventMedia', 'galleryMedia']
/** The census method takes at most this many ids per call. */
export const CENSUS_IDS_PER_CALL = 50
/** Calls per report: 400 locations; beyond that "gone" is unknown. */
export const CENSUS_MAX_CALLS = 8
/** Config keys that name where a location lives; a path is masked, anything else is not shown. */
export const ROOT_PATH_KEYS: readonly string[] = [
  'basePath',
  'path',
  'rootPath',
  'root',
  'directory',
  'dir',
  'mountPath',
  'mountPoint',
  'share',
  'localPath',
]
export const ROOT_REMOTE_KEYS: readonly string[] = ['url', 'endpoint', 'host', 'bucket', 'server']
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
  /** Every root-bearing config key, masked: `basePath=/mnt/…/events`. */
  readonly roots: readonly string[]
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
    | 'location-gone-unknown'
    | 'location-disabled'
    | 'location-draining'
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
    /** `null`: not every location id was asked, so "gone" cannot be judged. */
    readonly unlistedRows: number | null
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

/** The root-bearing keys of a location config, masked: a path keeps its mount shape, a remote key shows nothing. */
export function rootsOf(config: { readonly [key: string]: unknown }): string[] {
  const out: string[] = []
  for (const key of ROOT_PATH_KEYS) {
    const value = config[key]
    if (typeof value === 'string' && value !== '') out.push(`${key}=${maskPath(value)}`)
  }
  for (const key of ROOT_REMOTE_KEYS) {
    const value = config[key]
    if (typeof value === 'string' && value !== '') out.push(`${key}=[remote]`)
  }
  return out
}

/** The location bare legacy rows (no `locationId`) resolve to, or null: the orchestrator's rule. */
function legacyTargetOf(ids: readonly string[]): string | null {
  const ofType = ids.filter((id) => id.startsWith('eventMedia:'))
  if (ofType.length === 1) return ofType[0] ?? null
  return ofType.find((id) => id === 'eventMedia:default') ?? null
}

/** Pure: what the numbers say is wrong. */
export interface CensusFacts {
  readonly unstampedRows: number
  /** `null`: not every location id was asked. */
  readonly unlistedRows: number | null
  readonly unlistedUnknownReason: string | null
}

export function findingsOf(
  locations: readonly LocationCensusView[],
  census: CensusFacts,
): MediaFinding[] {
  const out: MediaFinding[] = []
  if (census.unlistedRows === null) {
    out.push({
      severity: 'info',
      code: 'location-gone-unknown',
      rows: 0,
      locationId: null,
      message: `rows naming a location that no longer exists could not be judged: ${census.unlistedUnknownReason ?? 'not every location was asked'}`,
    })
  } else if (census.unlistedRows > 0) {
    out.push({
      severity: 'problem',
      code: 'location-gone',
      rows: census.unlistedRows,
      locationId: null,
      message: `${String(census.unlistedRows)} stored media rows name a storage location that no longer exists: their thumbnails and key frames cannot be read`,
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
    } else if (l.mode === 'drain') {
      out.push({
        severity: 'info',
        code: 'location-draining',
        rows,
        locationId: l.id,
        message: `${String(rows)} media rows sit on ${l.id}, which is being drained: still served, its media is being moved off it`,
      })
    } else if (l.mode === 'readonly') {
      out.push({
        severity: 'info',
        code: 'location-readonly',
        rows,
        locationId: l.id,
        message: `${String(rows)} media rows sit on ${l.id}, which is read-only: still served, never written`,
      })
    }
  }
  const ids = locations.filter((l) => l.class === 'eventMedia').map((l) => l.id)
  if (census.unstampedRows > 0 && legacyTargetOf(ids) === null) {
    out.push({
      severity: 'problem',
      code: 'unstamped-unresolvable',
      rows: census.unstampedRows,
      locationId: null,
      message: `${String(census.unstampedRows)} legacy media rows have no location and there is neither a single eventMedia location nor eventMedia:default to resolve them to`,
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

interface EveryLocationCensus {
  readonly byLocation: ReadonlyMap<string, { readonly rows: number; readonly bytes: number }>
  readonly totalRows: number | null
  readonly unstampedRows: number
  /** `null` unless EVERY id the hub lists was asked and answered. */
  readonly unlistedRows: number | null
  readonly unlistedUnknownReason: string | null
}

/**
 * Ask the census for EVERY location id the hub lists, in chunks the method
 * accepts. "A row names a location that no longer exists" is the total minus the
 * rows of every known location minus the unstamped ones, so it is only true when
 * no known location was left out of the ask: a partial ask would call a row on a
 * live location "gone". When a chunk fails or the ids exceed the call budget the
 * answer is unknown, with the reason.
 */
async function countEveryLocation(
  client: HubClient,
  ids: readonly string[],
  unavailable: { [part: string]: string },
): Promise<EveryLocationCensus | null> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CENSUS_IDS_PER_CALL)
    chunks.push(ids.slice(i, i + CENSUS_IDS_PER_CALL))
  if (chunks.length === 0) chunks.push([])
  const asked = chunks.slice(0, CENSUS_MAX_CALLS)
  const byLocation = new Map<string, { rows: number; bytes: number }>()
  let totalRows: number | null = null
  let unstampedRows = 0
  let reason: string | null =
    chunks.length > asked.length
      ? `${String(ids.length)} locations exceed the ${String(CENSUS_MAX_CALLS * CENSUS_IDS_PER_CALL)} one report asks about`
      : null
  let answered = 0
  for (const chunk of asked) {
    const read = await readQuery(
      client,
      'pipelineAnalytics.getMediaLocationCensus',
      { locationIds: chunk },
      MediaLocationCensusSchema,
    )
    if (!read.ok) {
      unavailable['census'] = read.reason
      reason ??= read.reason
      continue
    }
    answered += 1
    for (const l of read.value.locations)
      byLocation.set(l.locationId, { rows: l.rows, bytes: l.bytes })
    totalRows ??= read.value.total.rows
    unstampedRows = read.value.unstamped.rows
  }
  if (answered === 0) return null
  let known = 0
  for (const v of byLocation.values()) known += v.rows
  const complete = reason === null && byLocation.size === ids.length
  return {
    byLocation,
    totalRows,
    unstampedRows,
    unlistedRows:
      complete && totalRows !== null ? Math.max(0, totalRows - known - unstampedRows) : null,
    unlistedUnknownReason: complete ? null : (reason ?? 'a location was not counted'),
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
    const all = rows.ok ? rows.value : []
    const census = rows.ok
      ? await countEveryLocation(
          client,
          all.map((l) => l.id),
          unavailable,
        )
      : null

    const locations: LocationCensusView[] | null = rows.ok
      ? all
          .map((l): LocationCensusView => {
            const c = census?.byLocation.get(l.id)
            return {
              id: l.id,
              class: l.type,
              mode: resolveLocationMode(l),
              nodeId: l.nodeId ?? null,
              roots: rootsOf(l.config),
              volumeReadable: l.capacity ? true : null,
              freeBytes: l.capacity?.availableBytes ?? null,
              heldBytes: l.owned?.bytes ?? null,
              mediaRows: c ? c.rows : null,
              mediaBytes: c ? c.bytes : null,
            }
          })
          // A location that cannot hold media is shown only when a row names it.
          .filter((l) => MEDIA_CLASSES.includes(l.class) || (l.mediaRows ?? 0) > 0)
      : null
    if (rows.ok && locations !== null && !locations.some((l) => MEDIA_CLASSES.includes(l.class))) {
      notes.push('no eventMedia or galleryMedia location is configured')
    }
    const findings =
      locations !== null && census !== null
        ? findingsOf(locations, {
            unstampedRows: census.unstampedRows,
            unlistedRows: census.unlistedRows,
            unlistedUnknownReason: census.unlistedUnknownReason,
          })
        : []

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
      census:
        census !== null && census.totalRows !== null
          ? {
              totalRows: census.totalRows,
              unstampedRows: census.unstampedRows,
              unlistedRows: census.unlistedRows,
            }
          : null,
      findings,
      sample,
      unavailable,
      notes,
    }
  })
}
