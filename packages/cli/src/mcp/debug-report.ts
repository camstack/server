/**
 * `debug_report`: ONE read-only bundle for a reported problem — what runs where
 * (server and addon versions per node) and, for a camera, its streams (profile
 * slots and derived streams with live fps / bitrate / IDR / subscribers), the
 * churn in its logs (slot changes, detection restarts, derived-encoder
 * respawns), its recent tracks with media presence per kind, and the URL shape
 * the viewer requests for a thumbnail. Every read is independent: one that
 * fails leaves `null` and a reason in `unavailable`, never a zero (D393).
 *
 * It writes nothing and calls no mutation. Secrets are scrubbed twice: log
 * lines here, and the whole answer by the shared output scrub.
 */
import type { HubClient } from '@camstack/develop'
import { CameraStreamSchema, ProfileSlotSchema } from '@camstack/types'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { readViewerLines, type ClientLogsResult } from './client-logs.js'
import { analyzeLogs, parseSince, type LogAnalysis } from './debug-logs.js'
import { resolveLinkBase, type LinkBase } from './ops-events.js'
import { readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { readLogWindow, type LogWindow } from './ops-logs.js'
import { opsStatus, type NodeSummary } from './ops-status.js'
import { mapLimit, adminRefusal, READ_CONCURRENCY } from './setup-assist-common.js'
import { readCameraRows, readCameraStatuses } from './setup-camera-reads.js'
import { cameraStreamsView, type CameraStreamsView } from './setup-streams.js'

export const DEBUG_ISSUES = ['stream', 'detections', 'ui', 'media'] as const
export type DebugIssue = (typeof DEBUG_ISSUES)[number]

export const DEFAULT_SINCE_MINUTES = 30
export const MAX_SINCE_MINUTES = 24 * 60
export const TRACK_LIMIT = 10
export const NODE_LIMIT = 40
export const THUMB_SIZE = 160
export const VIEWER_LINES = 40

export interface DebugReportArgs {
  readonly deviceId?: number
  readonly issue?: DebugIssue
  /** `30m`, `2h`, `1d`, or an ISO timestamp. Default 30m, at most 24h back. */
  readonly since?: string
}

export interface NodeVersions {
  readonly nodeId: string
  readonly online: boolean
  readonly serverVersion: string | null
  readonly addons:
    | readonly {
        readonly id: string
        readonly status: string
        readonly version: string | null
      }[]
    | null
}

export interface TrackMediaView {
  readonly trackId: string
  readonly className: string
  readonly firstSeen: number
  readonly active: boolean | null
  /** `null`: the media index could not be read — unknown, not "no media". */
  readonly kinds: { readonly [kind: string]: number } | null
  readonly thumbnail: boolean | null
  readonly keyFrame: boolean | null
  readonly thumbnailMediaUrl: string | null
  /** What the viewer requests for this card: the owner ladder, thumb variant. */
  readonly viewerThumbUrl: { readonly path: string; readonly absolute: string | null }
}

export interface TracksSection {
  readonly checked: number
  readonly withThumbnail: number
  readonly withKeyFrame: number
  /**
   * Closed, picture-bearing tracks (not `audio`) whose media index holds
   * neither a thumbnail nor a keyFrame.
   */
  readonly withoutThumbnailOrKeyFrame: number
  /** Closed tracks whose media index is empty, whatever their class. */
  readonly noMediaAtAll: number
  readonly unreadMedia: number
  readonly urlShape: string
  readonly items: readonly TrackMediaView[]
}

export interface DebugReportResult {
  readonly status: 'ok'
  readonly generatedAt: string
  readonly window: { readonly sinceMs: number; readonly untilMs: number }
  readonly cliVersion: string
  readonly versions: readonly NodeVersions[] | null
  readonly camera?: {
    readonly deviceId: number
    readonly name: string | null
    readonly found: boolean | null
    readonly streams: CameraStreamsView | null
    readonly broker: {
      readonly webrtcSessions: number
      readonly profiles: readonly {
        readonly profile: string
        readonly status: string
        readonly subscribers: number
        readonly inFps: number | null
      }[]
    } | null
    readonly logs: {
      readonly tier: string
      readonly tiersTried: readonly string[]
      readonly partial: boolean
      readonly analysis: LogAnalysis
    } | null
    readonly tracks: TracksSection | null
    /** The viewer app's own lines for this camera and window (ids carried by the hub's tags). */
    readonly viewer: Omit<ClientLogsResult, 'status' | 'window'> | null
  }
  readonly unavailable: { readonly [part: string]: string }
  readonly notes: readonly string[]
}

const NodeAddonsSchema = z.array(
  z.looseObject({
    id: z.string(),
    status: z.string(),
    version: z.string().optional(),
  }),
)

async function nodeVersions(
  client: HubClient,
  nodes: readonly NodeSummary[],
  unavailable: { [part: string]: string },
): Promise<NodeVersions[]> {
  return mapLimit(nodes.slice(0, NODE_LIMIT), READ_CONCURRENCY, async (n) => {
    if (!n.online) {
      return { nodeId: n.id, online: false, serverVersion: n.serverVersion, addons: null }
    }
    const read = await readQuery(client, 'nodes.getNodeAddons', { nodeId: n.id }, NodeAddonsSchema)
    if (!read.ok) unavailable[`addons:${n.id}`] = read.reason
    return {
      nodeId: n.id,
      online: true,
      serverVersion: n.serverVersion,
      addons: read.ok
        ? read.value.map((a) => ({ id: a.id, status: a.status, version: a.version ?? null }))
        : null,
    }
  })
}

const SlimTracksSchema = z.looseObject({
  tracks: z.array(
    z.looseObject({
      trackId: z.string(),
      className: z.string(),
      firstSeen: z.number(),
      active: z.boolean().optional(),
    }),
  ),
})

const MediaRowsSchema = z.array(
  z.looseObject({ mediaId: z.number(), kind: z.string(), timestamp: z.number() }),
)

const EVENT_MEDIA_PREFIX = '/addon/pipeline-analytics/event-media'

export const URL_SHAPE = `${EVENT_MEDIA_PREFIX}/o/track/<trackId>?variant=thumb&size=${String(THUMB_SIZE)} (owner ladder: the best media OF the track); a media row is ${EVENT_MEDIA_PREFIX}/m/<mediaId>`

export function viewerThumbUrl(
  link: LinkBase,
  trackId: string,
): { path: string; absolute: string | null } {
  const path = `${EVENT_MEDIA_PREFIX}/o/track/${encodeURIComponent(trackId)}?variant=thumb&size=${String(THUMB_SIZE)}`
  return { path, absolute: link.base === null ? null : `${link.base}${path}` }
}

async function tracksSection(
  client: HubClient,
  deviceId: number,
  window: { sinceMs: number; untilMs: number },
  link: LinkBase,
  unavailable: { [part: string]: string },
): Promise<TracksSection | null> {
  const page = await readQuery(
    client,
    'pipelineAnalytics.listRecentTracks',
    {
      deviceIds: [deviceId],
      since: window.sinceMs,
      until: window.untilMs,
      limit: TRACK_LIMIT,
      projection: 'slim',
    },
    SlimTracksSchema,
  )
  if (!page.ok) {
    unavailable['tracks'] = page.reason
    return null
  }
  const recent = page.value.tracks
    .toSorted((a, b) => b.firstSeen - a.firstSeen)
    .slice(0, TRACK_LIMIT)
  const items = await mapLimit(recent, READ_CONCURRENCY, async (t): Promise<TrackMediaView> => {
    const media = await readQuery(
      client,
      'pipelineAnalytics.listTrackMedia',
      { deviceId, trackId: t.trackId },
      MediaRowsSchema,
    )
    if (!media.ok) unavailable[`media:${t.trackId}`] = media.reason
    const kinds: { [kind: string]: number } | null = media.ok ? {} : null
    if (kinds !== null && media.ok)
      for (const m of media.value) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
    const thumbRow = media.ok ? media.value.find((m) => m.kind === 'thumbnail') : undefined
    return {
      trackId: t.trackId,
      className: t.className,
      firstSeen: t.firstSeen,
      active: t.active ?? null,
      kinds,
      thumbnail: kinds === null ? null : (kinds['thumbnail'] ?? 0) > 0,
      keyFrame: kinds === null ? null : (kinds['keyFrame'] ?? 0) > 0,
      thumbnailMediaUrl: thumbRow ? `${EVENT_MEDIA_PREFIX}/m/${String(thumbRow.mediaId)}` : null,
      viewerThumbUrl: viewerThumbUrl(link, t.trackId),
    }
  })
  return {
    checked: items.length,
    withThumbnail: items.filter((i) => i.thumbnail === true).length,
    withKeyFrame: items.filter((i) => i.keyFrame === true).length,
    withoutThumbnailOrKeyFrame: items.filter(
      (i) =>
        i.active !== true &&
        i.className !== 'audio' &&
        i.thumbnail === false &&
        i.keyFrame === false,
    ).length,
    noMediaAtAll: items.filter(
      (i) => i.active !== true && i.kinds !== null && Object.keys(i.kinds).length === 0,
    ).length,
    unreadMedia: items.filter((i) => i.kinds === null).length,
    urlShape: URL_SHAPE,
    items,
  }
}

function logsSection(
  log: LogWindow,
  window: { sinceMs: number; untilMs: number },
  unavailable: { [part: string]: string },
): NonNullable<NonNullable<DebugReportResult['camera']>['logs']> | null {
  for (const [k, v] of Object.entries(log.unavailable)) unavailable[`logs:${k}`] = v
  if (log.tier === 'none') return null
  return {
    tier: log.tier,
    tiersTried: log.tiersTried,
    partial: log.partial,
    analysis: analyzeLogs(log.entries, window),
  }
}

export async function debugReport(
  ctx: McpContext,
  args: DebugReportArgs,
  now: number = Date.now(),
): Promise<DebugReportResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<DebugReportResult | RefusedResult> => {
    const refused = adminRefusal(connection, 'debug_report (nodes, logs)')
    if (refused) return refused
    const client = connection.client
    const unavailable: { [part: string]: string } = {}
    const sinceMs = parseSince(args.since, now, DEFAULT_SINCE_MINUTES)
    if (sinceMs === null) {
      return {
        status: 'refused',
        reason: `since "${String(args.since)}" is not 30m, 2h, 1d or an ISO time`,
      }
    }
    const window = {
      sinceMs: Math.max(sinceMs, now - MAX_SINCE_MINUTES * 60_000),
      untilMs: now,
    }
    const wants = (part: DebugIssue): boolean => args.issue === undefined || args.issue === part
    const notes: string[] = []

    const status = await opsStatus(ctx)
    let versions: NodeVersions[] | null = null
    if (status.status === 'ok' && status.nodes !== null) {
      versions = await nodeVersions(client, status.nodes, unavailable)
    } else {
      unavailable['versions'] =
        status.status === 'ok'
          ? (status.unavailable['nodes'] ?? 'node list unavailable')
          : status.message
    }

    const base = {
      status: 'ok' as const,
      generatedAt: new Date(now).toISOString(),
      window,
      cliVersion: ctx.cliVersion,
      versions,
    }
    if (args.deviceId === undefined) {
      notes.push(
        'No deviceId: only versions are reported. Give a camera for streams, logs and tracks.',
      )
      return { ...base, unavailable, notes }
    }
    const deviceId = args.deviceId

    const [cameras, statuses, streams, slots, link, log] = await Promise.all([
      readCameraRows(client),
      readCameraStatuses(client),
      readQuery(
        client,
        'streamBroker.listAllCameraStreams',
        undefined,
        z.array(CameraStreamSchema),
      ),
      readQuery(client, 'streamBroker.listAllProfileSlots', undefined, z.array(ProfileSlotSchema)),
      resolveLinkBase(client),
      readLogWindow(client, { deviceId, sinceMs: window.sinceMs, untilMs: window.untilMs }),
    ])
    if (!cameras.ok) unavailable['cameras'] = cameras.reason
    if (!statuses.ok) unavailable['status'] = statuses.reason
    if (!streams.ok) unavailable['streams'] = streams.reason
    if (!slots.ok) unavailable['slots'] = slots.reason
    if (link.base === null && link.reason) unavailable['viewerAddress'] = link.reason

    const row = cameras.ok ? cameras.value.find((c) => c.id === deviceId) : undefined
    const found: boolean | null = cameras.ok ? row !== undefined : null
    const cam = statuses.ok ? statuses.value.get(deviceId) : undefined
    const camStreams =
      streams.ok && slots.ok && (wants('stream') || wants('detections'))
        ? await cameraStreamsView(
            client,
            row ?? { id: deviceId, name: String(deviceId), disabled: false },
            streams.value,
            slots.value,
            cam,
          )
        : null
    if (camStreams) {
      for (const [k, v] of Object.entries(camStreams.unavailable)) unavailable[`streams:${k}`] = v
    }
    const tracks =
      wants('detections') || wants('ui') || wants('media')
        ? await tracksSection(client, deviceId, window, link, unavailable)
        : null
    const logs = logsSection(log, window, unavailable)
    const viewer =
      wants('ui') || wants('detections')
        ? await readViewerLines(client, { deviceId, level: 'info', limit: VIEWER_LINES }, window)
        : null
    if (viewer) {
      for (const [k, v] of Object.entries(viewer.unavailable)) unavailable[`viewer:${k}`] = v
    }
    if (found === false) notes.push(`device ${String(deviceId)} is not a camera on this hub`)
    if (logs?.partial)
      notes.push('the log page was cut by its line cap: older lines in the window exist')

    return {
      ...base,
      camera: {
        deviceId,
        name: row?.name ?? null,
        found,
        streams: camStreams,
        broker: cam?.broker
          ? {
              webrtcSessions: cam.broker.webrtcSessions,
              profiles: cam.broker.profiles.map((p) => ({
                profile: p.profile,
                status: p.status,
                subscribers: p.subscribers,
                inFps: p.inFps,
              })),
            }
          : null,
        logs,
        tracks,
        viewer,
      },
      unavailable,
      notes,
    }
  })
}
