/**
 * The `videoclips` source over THIS addon's archive — the deps half.
 *
 * The composer (`videoclips-provider.ts`, `videoclip-visits.ts`) is unchanged
 * and moved here verbatim from `addon-post-analysis`: a clip is still a time
 * WINDOW over recorded footage, visits are still clustered at
 * `VISIT_MERGE_GAP_MS`, and `getClipPlayback` still resolves through
 * `recording.getPlaybackManifest`. What moved is WHO registers it — the addon
 * that owns the footage, not one that borrowed it (D560).
 *
 * All four reads go over `ctx.api`, the recorder's own two included. That is
 * not laziness:
 *
 *   - `recorder` is `placement: 'any-node'`, so several nodes register this
 *     capability and the hub's collection dispatcher resolves the binding to
 *     ONE of them (`addonIdentityOf` strips the `@<nodeId>`). That registration
 *     is not necessarily the node holding this camera's segments.
 *   - `ctx.api.recording.*` is device-scoped and routes to the node that IS
 *     holding them. A short cut to the local `RecordingProvider` would answer a
 *     camera recorded on agent-a out of the hub's empty index — an empty
 *     clip list on a camera with weeks of footage, which is the exact
 *     misreading this whole line of work exists to end.
 *
 * The events arriving over a process boundary is the new failure mode, and the
 * provider answers it per branch — see `listWithoutEvents`.
 */
import {
  type ClipPlayback,
  EVENT_PAD_MS,
  type IScopedLogger,
  type IVideoclipsProvider,
  type MediaPresenceOwnerKind,
  RECORDING_SOURCE_CAMSTACK_ADDON,
  type RecordingPlayback,
} from '@camstack/types'
import { createVideoclipsProvider } from './videoclips-provider.js'
import type { EventBuckets, FootageRange, MediaOwnersQuery } from './videoclips-shared.js'
import { toEventLike } from './videoclips-shared.js'

/** One analytics event as the slim projections answer it (D474: a numeric id). */
interface WireEvent {
  readonly id: number
  readonly timestamp: number
  readonly mediaUrl?: string
  readonly trackId?: string
  readonly className?: string
}

/**
 * The generated tRPC client widens every input with an index signature (the
 * cap-router envelope's passthrough fields). A narrow slice of `ctx.api` has to
 * declare it too, or the real client is not assignable to the slice.
 */
type WireInput<T> = { [key: string]: unknown } & T

interface EventQueryInput {
  readonly deviceId: number
  readonly since: number
  readonly until: number
  readonly limit?: number
  readonly projection: 'slim'
}

interface EventQuery {
  query(input: WireInput<EventQueryInput>): Promise<readonly WireEvent[]>
}

interface OwnersWithMediaQuery {
  query(
    input: WireInput<{
      readonly deviceId: number
      readonly ownerKind: MediaPresenceOwnerKind
      readonly ownerIds: readonly string[]
    }>,
  ): Promise<readonly string[]>
}

interface FootageWindowInput {
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
  /**
   * WHICH source of this camera's recordings to ask. Required by the cap since
   * `recording` became a device collection (D625), and it is always OURS here:
   * an analytics clip is a window over the footage THIS addon wrote, so the
   * camera's own card is not an answer to the question being asked.
   */
  readonly provider: string
}

interface AvailabilityQuery {
  query(input: WireInput<FootageWindowInput>): Promise<{
    readonly read: 'read' | 'unreadable'
    readonly ranges: readonly FootageRange[]
  }>
}

interface PlaybackQuery {
  query(input: WireInput<FootageWindowInput>): Promise<RecordingPlayback>
}

/**
 * The slice of `ctx.api` this source uses — deliberately narrower than the
 * addon api, so nothing here can reach a method the source has no business
 * calling, and so the wiring is testable without a kernel.
 */
export interface VideoclipsWiringApi {
  readonly pipelineAnalytics: {
    readonly getMotionEvents: EventQuery
    readonly getObjectEvents: EventQuery
    readonly getAudioEvents: EventQuery
    readonly ownersWithMedia: OwnersWithMediaQuery
  }
  readonly recording: {
    readonly getAvailability: AvailabilityQuery
    readonly getPlayback: PlaybackQuery
  }
}

/** The two levels this source uses — a narrowing of `IScopedLogger`, never a
 *  second logger interface. */
export type VideoclipsWiringLogger = Pick<IScopedLogger, 'warn' | 'info'>

export interface VideoclipsWiringDeps {
  readonly api: VideoclipsWiringApi
  readonly logger: VideoclipsWiringLogger
}

/**
 * Every log line about a camera carries `tags: { deviceId }`, always the
 * numeric id. A miss rate or a media gap is always asked per camera, and a line
 * that omits the tag cannot answer it.
 */
function stamp(
  logger: VideoclipsWiringDeps['logger'],
  level: 'warn' | 'info',
): (message: string, meta: Record<string, unknown>) => void {
  return (message, meta) => {
    logger[level](message, { tags: { deviceId: Number(meta['deviceId']) }, meta })
  }
}

export function createRecorderVideoclipsProvider(deps: VideoclipsWiringDeps): IVideoclipsProvider {
  const api = deps.api
  return createVideoclipsProvider({
    // The canonical event-clip window (−5 s / +10 s) — the one pad convention
    // for event↔footage joins.
    defaultPad: EVENT_PAD_MS,
    fetchEvents: async ({ deviceId, since, until, limit }): Promise<EventBuckets> => {
      const query = { deviceId, since, until, limit, projection: 'slim' as const }
      const [motion, object, audio] = await Promise.all([
        api.pipelineAnalytics.getMotionEvents.query(query),
        api.pipelineAnalytics.getObjectEvents.query(query),
        api.pipelineAnalytics.getAudioEvents.query(query),
      ])
      // `EventLike.id` stays a STRING (D474): downstream it is a clip-id
      // component and a media OWNER id, both of which are text.
      return {
        motion: toEventLike(motion),
        object: toEventLike(object),
        audio: toEventLike(audio),
      }
    },
    // The VOUCH. `mediaUrl` is stamped from a template for every event, so it
    // proves the data-plane is up and nothing more; this is the index read that
    // turns it into a claim. Batched per owner kind, never per clip, and it
    // THROWS rather than under-reporting so the provider fails closed on the
    // claim and open on the list.
    fetchMediaOwners: async ({
      deviceId,
      ownerKind,
      ownerIds,
    }: MediaOwnersQuery): Promise<ReadonlySet<string>> =>
      new Set(await api.pipelineAnalytics.ownersWithMedia.query({ deviceId, ownerKind, ownerIds })),
    // Footage gate: a clip is a window over recorded footage, so windows a
    // camera never recorded are dropped instead of listed unplayable.
    fetchAvailability: async ({ deviceId, since, until }) => {
      const answer = await api.recording.getAvailability.query({
        deviceId,
        provider: RECORDING_SOURCE_CAMSTACK_ADDON,
        fromMs: since,
        toMs: until,
      })
      // A read that FAILED is not an empty archive. The footage gate DROPS
      // clip windows it finds no footage for, so answering `unreadable` as
      // `[]` would delete every clip of a camera whose calendar rung threw —
      // a read that fails must not destroy work (D49). Refuse instead.
      if (answer.read === 'unreadable') {
        throw new Error(
          `videoclips: the recording archive could not be read for device ${String(deviceId)} — the clip window gate is not run on an unreadable answer`,
        )
      }
      return answer.ranges
    },
    logWarn: stamp(deps.logger, 'warn'),
    logInfo: stamp(deps.logger, 'info'),
    resolvePlayback: async ({ deviceId, startMs, endMs }): Promise<ClipPlayback> => {
      const playback = await api.recording.getPlayback.query({
        deviceId,
        provider: RECORDING_SOURCE_CAMSTACK_ADDON,
        fromMs: startMs,
        toMs: endMs,
      })
      // Ours is an HLS source and only an HLS source. Any other arm of the
      // union is a refusal that names itself, never a null we invent a message
      // for (D391).
      if (playback.kind !== 'hls') {
        throw new Error(
          `videoclips: no footage for clip window [${String(startMs)},${String(endMs)}] on device ${String(deviceId)}` +
            (playback.kind === 'none'
              ? ` — ${playback.reason}`
              : ` — served as "${playback.kind}"`),
        )
      }
      const manifest = playback.manifest
      if (manifest.playbackUrl == null) {
        throw new Error(
          `videoclips: no playback URL for clip window [${String(startMs)},${String(endMs)}] on device ${String(deviceId)}`,
        )
      }
      return {
        playbackUrl: manifest.playbackUrl,
        ...(manifest.playbackEndpoints === undefined
          ? {}
          : { playbackEndpoints: [...manifest.playbackEndpoints] }),
      }
    },
  })
}
