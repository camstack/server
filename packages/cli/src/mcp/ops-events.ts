/**
 * `ops_events` and `ops_track`: find what a camera saw, and audit one track's
 * media.
 *
 * Links are built on the hub address the operator flagged for app connections
 * (`local-network.getAddresses().roles.appConnections`, D729/D734) — never an
 * environment variable and never a loopback address. When no usable address
 * exists the links are `null` with the reason, not a guess.
 *
 * The media audit shares its rules with the private operator MCP
 * (`analyzeTrack`, in `@camstack/develop`) and adds what D400 requires: every
 * missing media kind is named, with the reason the track recorded for it.
 */
import {
  TrackSchema,
  analyzeTrack,
  type Finding,
  type HubClient,
  type MediaInfo,
  type Track,
} from '@camstack/develop'
import { buildViewerLink } from '@camstack/types'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { cap, readQuery, withHub, type NoSessionResult } from './ops-hub.js'

// ---------------------------------------------------------------------------
// links

const AddressesSchema = z.looseObject({
  roles: z.looseObject({
    appConnections: z.looseObject({ resolved: z.array(z.string()) }),
  }),
})

const LOOPBACK = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return true
  }
}

export interface LinkBase {
  readonly base: string | null
  readonly reason?: string
}

/** The address the operator flagged for app connections, first usable one. */
export async function resolveLinkBase(client: HubClient): Promise<LinkBase> {
  const read = await readQuery(client, 'localNetwork.getAddresses', undefined, AddressesSchema)
  if (!read.ok) return { base: null, reason: read.reason }
  const usable = read.value.roles.appConnections.resolved.find((u) => !isLoopbackUrl(u))
  if (usable === undefined) {
    return {
      base: null,
      reason: 'no non-loopback address is flagged for app connections (Network page)',
    }
  }
  return { base: usable.replace(/\/+$/, '') }
}

export interface Links {
  readonly admin: string | null
  readonly viewer: string | null
}

export function linksFor(link: LinkBase, deviceId: number, atMs?: number): Links {
  if (link.base === null) return { admin: null, viewer: null }
  return {
    admin: `${link.base}/devices/${String(deviceId)}`,
    viewer: buildViewerLink({
      base: { form: 'hub', hubBaseUrl: link.base },
      destination: {
        kind: 'camera',
        deviceId,
        ...(atMs !== undefined ? { atMs } : {}),
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// ops_events

const DeviceNameSchema = z.array(
  z.looseObject({
    id: z.number(),
    name: z.string(),
    disabled: z.boolean().optional(),
  }),
)

const SlimTrackSchema = z.looseObject({
  trackId: z.string(),
  deviceId: z.number(),
  className: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  state: z.string().optional(),
  active: z.boolean().optional(),
  classes: z.array(z.string()).optional(),
  zonesVisited: z.array(z.string()).optional(),
  bestEventId: z.string().optional(),
})
type SlimTrack = z.infer<typeof SlimTrackSchema>

const TracksPageSchema = z.looseObject({
  tracks: z.array(SlimTrackSchema),
  nextCursor: z.string().nullable().optional(),
})

const ObjectEventsSchema = z.array(
  z.looseObject({
    id: z.number(),
    timestamp: z.number(),
    className: z.string().optional(),
    trackId: z.string().optional(),
  }),
)

export const DEFAULT_EVENT_WINDOW_MINUTES = 60
export const MAX_EVENT_WINDOW_MINUTES = 7 * 24 * 60
export const DEFAULT_RESULT_LIMIT = 20
export const MAX_RESULT_LIMIT = 50
const FETCH_TRACKS = 200

export interface OpsEventsArgs {
  readonly deviceId?: number
  readonly className?: string
  /** Substring of a zone name the track visited. */
  readonly zone?: string
  /** Free text over track id, class, zones and the camera's name. */
  readonly text?: string
  readonly windowMinutes?: number
  readonly limit?: number
}

export interface TrackHit {
  readonly deviceId: number
  readonly deviceName: string | null
  readonly trackId: string
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly durationMs: number
  readonly state: string | null
  readonly active: boolean | null
  readonly zonesVisited: readonly string[]
  readonly links: Links
}

export interface EventHit {
  readonly id: number
  readonly timestamp: number
  readonly className: string | null
  readonly trackId: string | null
  readonly links: Links
}

export interface OpsEventsResult {
  readonly status: 'ok'
  readonly window: { readonly sinceMs: number; readonly untilMs: number }
  readonly tracks: readonly TrackHit[]
  readonly tracksTruncated: number
  /** True when the hub holds more tracks in the window than were scanned. */
  readonly moreTracksAvailable: boolean | null
  /** Only for a single camera: its object events in the window. */
  readonly events?: readonly EventHit[]
  readonly linksUnavailable?: string
  readonly unavailable: { readonly [part: string]: string }
}

const matches = (haystack: readonly string[], needle: string): boolean => {
  const n = needle.toLowerCase()
  return haystack.some((h) => h.toLowerCase().includes(n))
}

export function trackMatches(
  track: SlimTrack,
  deviceName: string | null,
  args: Pick<OpsEventsArgs, 'zone' | 'text'>,
): boolean {
  const zones = track.zonesVisited ?? []
  if (args.zone !== undefined && args.zone !== '' && !matches(zones, args.zone)) return false
  if (args.text !== undefined && args.text !== '') {
    const fields = [
      track.trackId,
      track.className,
      ...(track.classes ?? []),
      ...zones,
      ...(deviceName ? [deviceName] : []),
    ]
    if (!matches(fields, args.text)) return false
  }
  return true
}

export async function opsEvents(
  ctx: McpContext,
  args: OpsEventsArgs,
  now: number = Date.now(),
): Promise<OpsEventsResult | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: { [part: string]: string } = {}
    const windowMinutes = Math.min(
      args.windowMinutes ?? DEFAULT_EVENT_WINDOW_MINUTES,
      MAX_EVENT_WINDOW_MINUTES,
    )
    const limit = Math.min(args.limit ?? DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT)
    const since = now - windowMinutes * 60_000
    const window = { sinceMs: since, untilMs: now }

    const [namesRead, link] = await Promise.all([
      readQuery(
        client,
        'deviceManager.listAll',
        { projection: 'slim', isCamera: true },
        DeviceNameSchema,
      ),
      resolveLinkBase(client),
    ])
    const names = new Map<number, string>()
    if (namesRead.ok) for (const d of namesRead.value) names.set(d.id, d.name)
    else unavailable['cameras'] = namesRead.reason

    const deviceIds =
      args.deviceId !== undefined
        ? [args.deviceId]
        : namesRead.ok
          ? namesRead.value.filter((d) => d.disabled !== true).map((d) => d.id)
          : []
    if (deviceIds.length === 0 && args.deviceId === undefined) {
      return {
        status: 'ok' as const,
        window,
        tracks: [],
        tracksTruncated: 0,
        moreTracksAvailable: null,
        unavailable,
      }
    }

    const tracksRead = await readQuery(
      client,
      'pipelineAnalytics.listRecentTracks',
      {
        deviceIds,
        since,
        until: now,
        limit: FETCH_TRACKS,
        projection: 'slim',
        ...(args.className ? { classes: [args.className] } : {}),
      },
      TracksPageSchema,
    )
    let tracks: readonly TrackHit[] = []
    let tracksTruncated = 0
    let more: boolean | null = null
    if (tracksRead.ok) {
      more = tracksRead.value.nextCursor !== null && tracksRead.value.nextCursor !== undefined
      const hits = tracksRead.value.tracks
        .filter((t) => (args.className ? t.className === args.className : true))
        .filter((t) => trackMatches(t, names.get(t.deviceId) ?? null, args))
        .map(
          (t): TrackHit => ({
            deviceId: t.deviceId,
            deviceName: names.get(t.deviceId) ?? null,
            trackId: t.trackId,
            className: t.className,
            firstSeen: t.firstSeen,
            lastSeen: t.lastSeen,
            durationMs: t.lastSeen - t.firstSeen,
            state: t.state ?? null,
            active: t.active ?? null,
            zonesVisited: t.zonesVisited ?? [],
            links: linksFor(link, t.deviceId, t.firstSeen),
          }),
        )
      const capped = cap(hits, limit)
      tracks = capped.items
      tracksTruncated = capped.truncated
    } else {
      unavailable['tracks'] = tracksRead.reason
    }

    let events: readonly EventHit[] | undefined
    if (args.deviceId !== undefined) {
      const eventsRead = await readQuery(
        client,
        'pipelineAnalytics.getObjectEvents',
        {
          deviceId: args.deviceId,
          since,
          until: now,
          limit,
          projection: 'slim',
          ...(args.className ? { classFilter: args.className } : {}),
        },
        ObjectEventsSchema,
      )
      if (eventsRead.ok) {
        events = eventsRead.value
          .filter((e) =>
            args.text ? matches([e.trackId ?? '', e.className ?? ''], args.text) : true,
          )
          .map(
            (e): EventHit => ({
              id: e.id,
              timestamp: e.timestamp,
              className: e.className ?? null,
              trackId: e.trackId ?? null,
              links: linksFor(link, args.deviceId ?? 0, e.timestamp),
            }),
          )
      } else {
        unavailable['events'] = eventsRead.reason
      }
    }

    return {
      status: 'ok' as const,
      window,
      tracks,
      tracksTruncated,
      moreTracksAvailable: more,
      ...(events ? { events } : {}),
      ...(link.base === null && link.reason ? { linksUnavailable: link.reason } : {}),
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------
// ops_track

const TrackExtrasSchema = z.looseObject({
  bestEventId: z.string().optional(),
  hasFace: z.boolean().optional(),
  importance: z.number().optional(),
  previewMissReason: z.string().optional(),
})

const MediaListSchema = z.array(
  z.looseObject({
    mediaId: z.number(),
    kind: z.string(),
    sizeBytes: z.number(),
    timestamp: z.number(),
  }),
)

/** What a closed track is expected to hold (D400); the derived kinds follow their source. */
export const EXPECTED_MEDIA_KINDS = ['keyFrame', 'firstFrame', 'lastFrame', 'thumbnail'] as const

export interface MissingKind {
  readonly kind: string
  /** The reason the track recorded, or the cascade this kind belongs to. */
  readonly reason: string
}

export interface TrackMediaAudit {
  readonly kinds: { readonly [kind: string]: number }
  readonly bestShot: {
    readonly eventId: string | null
    readonly thumbnailAt: number | null
    readonly keyFrameAt: number | null
  }
  readonly keyFrames: {
    readonly keyFrame: boolean
    readonly keyFrameSmall: boolean
  }
  /** Empty for an active track (its media is still being written). */
  readonly missing: readonly MissingKind[]
  readonly findings: readonly {
    readonly code: string
    readonly detail: string
  }[]
  readonly findingsTruncated: number
}

export const FINDING_LIMIT = 15

/** Pure: the media audit of one track from its index. */
export function auditMedia(
  track: Track,
  extras: z.infer<typeof TrackExtrasSchema>,
  media: readonly MediaInfo[],
): TrackMediaAudit {
  const kinds: { [kind: string]: number } = {}
  for (const m of media) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
  const has = (kind: string): boolean => (kinds[kind] ?? 0) > 0
  const closed = track.active !== true
  const missing: MissingKind[] = []
  if (closed) {
    for (const kind of EXPECTED_MEDIA_KINDS) {
      if (has(kind)) continue
      let reason: string
      if (kind === 'keyFrame') {
        reason =
          extras.previewMissReason ??
          'no reason recorded on the track (it predates the record, or the capture was never attempted)'
      } else if (!has('keyFrame') && (kind === 'lastFrame' || kind === 'thumbnail')) {
        reason = `follows the missing keyFrame: ${extras.previewMissReason ?? 'cause not recorded'}`
      } else {
        reason = 'no reason recorded for this kind'
      }
      missing.push({ kind, reason })
    }
  }
  const findings: Finding[] = analyzeTrack({
    track,
    siblings: [],
    media,
    ffEqualsLf: null,
    enrichment: { face: null, plate: null },
  })
  const cappedFindings = cap(findings, FINDING_LIMIT)
  const at = (kind: string): number | null => media.find((m) => m.kind === kind)?.timestamp ?? null
  return {
    kinds,
    bestShot: {
      eventId: extras.bestEventId ?? null,
      thumbnailAt: at('thumbnail'),
      keyFrameAt: at('keyFrame'),
    },
    keyFrames: {
      keyFrame: has('keyFrame'),
      keyFrameSmall: has('keyFrameSmall'),
    },
    missing,
    findings: cappedFindings.items.map((f) => ({
      code: f.code,
      detail: f.detail,
    })),
    findingsTruncated: cappedFindings.truncated,
  }
}

export interface OpsTrackResult {
  readonly status: 'ok'
  readonly deviceId: number
  readonly trackId: string
  readonly found: boolean | null
  readonly track?: {
    readonly className: string
    readonly state: string | null
    readonly active: boolean | null
    readonly firstSeen: number
    readonly lastSeen: number
    readonly durationMs: number
    readonly hasFace: boolean | null
    readonly importance: number | null
  }
  readonly links?: Links
  /** `null` when the media index could not be read: unknown, not "no media". */
  readonly media?: TrackMediaAudit | null
  readonly linksUnavailable?: string
  readonly unavailable: { readonly [part: string]: string }
}

export async function opsTrack(
  ctx: McpContext,
  args: { readonly deviceId: number; readonly trackId: string },
): Promise<OpsTrackResult | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: { [part: string]: string } = {}
    const [trackRead, mediaRead, link] = await Promise.all([
      readQuery(
        client,
        'pipelineAnalytics.getTrack',
        { deviceId: args.deviceId, trackId: args.trackId },
        z.unknown(),
      ),
      readQuery(
        client,
        'pipelineAnalytics.listTrackMedia',
        { deviceId: args.deviceId, trackId: args.trackId },
        MediaListSchema,
      ),
      resolveLinkBase(client),
    ])
    const base = {
      status: 'ok' as const,
      deviceId: args.deviceId,
      trackId: args.trackId,
    }
    if (!trackRead.ok) {
      unavailable['track'] = trackRead.reason
      return { ...base, found: null, unavailable }
    }
    if (trackRead.value === null) return { ...base, found: false, unavailable }
    const parsed = TrackSchema.safeParse(trackRead.value)
    const extras = TrackExtrasSchema.safeParse(trackRead.value)
    if (!parsed.success || !extras.success) {
      unavailable['track'] = 'pipelineAnalytics.getTrack: unexpected answer shape'
      return { ...base, found: null, unavailable }
    }
    const track = parsed.data
    let media: TrackMediaAudit | null = null
    if (mediaRead.ok) media = auditMedia(track, extras.data, mediaRead.value)
    else unavailable['media'] = mediaRead.reason
    return {
      ...base,
      found: true,
      track: {
        className: track.className,
        state: track.state ?? null,
        active: track.active ?? null,
        firstSeen: track.firstSeen,
        lastSeen: track.lastSeen,
        durationMs: track.lastSeen - track.firstSeen,
        hasFace: extras.data.hasFace ?? null,
        importance: extras.data.importance ?? null,
      },
      links: linksFor(link, args.deviceId, track.firstSeen),
      media,
      ...(link.base === null && link.reason ? { linksUnavailable: link.reason } : {}),
      unavailable,
    }
  })
}
