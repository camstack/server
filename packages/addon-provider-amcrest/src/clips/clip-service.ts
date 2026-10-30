/**
 * The clip service: one object the addon wires, holding the pieces in the
 * order they depend on each other.
 *
 * It exists so `addon.ts` wires ONE thing and so every gate has exactly one
 * implementation. In particular the device gate, the camera's CLOCK, the
 * catalog row and the camera clients are resolved HERE and handed down — the
 * media route and the byte reads all ask this object, so none of them can grow
 * a second opinion about which clip a key means or which camera it is on.
 *
 * ## Two protocols, one camera
 *
 * The CGI client is the device's own (`AmcrestCamera` built it, D224: the fact
 * is kept fresh in the addon that owns the device). The RPC2 client is minted
 * here and cached per device, because `mediaFileFind` is the only thing in
 * this addon that needs it.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AddonPeerBytes,
  ClipSourceAvailability,
  IScopedLogger,
  IVideoclipsProvider,
  PinnedFfmpegResolver,
} from '@camstack/types'

import type { AmcrestCgiClient } from '../amcrest-cgi-client.js'
import { AMCREST_ADDON_ID } from '../schema.js'
import { AmcrestRpc2Client } from './amcrest-rpc2-client.js'
import {
  type ClipDeviceRef,
  createAmcrestVideoclipsProvider,
} from './amcrest-videoclips-provider.js'
import {
  CLIP_THUMB_EXTENSION,
  CLIP_THUMB_KIND,
  ClipArtifactStore,
  THUMB_MAX_BYTES_PER_DEVICE,
  THUMB_MAX_FILES_PER_DEVICE,
} from './clip-artifact-store.js'
import { availabilityFromClock } from './clip-availability.js'
import { readClipRows } from './clip-catalog.js'
import {
  type AmcrestCameraClock,
  cameraClockDisagrees,
  cameraClockIsFresh,
  deriveCameraClock,
} from './clip-clock.js'
import {
  CLIP_MEDIA_PREFIX,
  CLIP_THUMB_PREFIX,
  createClipPlaybackHandler,
  createClipThumbHandler,
  type MintResult,
} from './clip-data-plane.js'
import { prepareClipFile } from './clip-file.js'
import { buildReplayUrl } from './clip-replay-url.js'
import type { AmcrestClipRow } from './clip-search.js'
import { cutClipStill } from './clip-still.js'
import { createClipStillGuard } from './clip-still-guard.js'
import { mintClipStill } from './clip-still-mint.js'
import { createClipStreamProducer } from './clip-stream.js'
import { createClipStreamDial } from './clip-stream-dial.js'
import { createReplayLane } from './replay-lane.js'

/** What the addon hands this service for one camera it owns. */
export interface AmcrestClipCamera {
  readonly deviceId: number
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly username: string
  readonly password: string
  /** 1-based, as the device schema carries it. `mediaFileFind` counts from 0. */
  readonly channel: number
  /** The camera's OWN CGI client. Never constructed here — one client per
   *  camera is what keeps its digest nonce-count monotonic. */
  readonly client: AmcrestCgiClient
  /**
   * The camera's storage, as the `recording-onboard` cap already read and
   * parsed it (D614). Handed in rather than read here: one reader, one
   * meaning. `null` when the device has not been asked yet, which is a
   * different thing from "no card" and is answered by asking.
   *
   * `null` means the card is there and readable — nothing to report, ask the
   * next question. Every other answer is terminal.
   */
  readStorage(): Promise<ClipSourceAvailability | null>
}

export interface ClipServiceDeps {
  readonly dataDir: string
  readonly logger: IScopedLogger
  /**
   * The addon→addon byte transport (D613), from `ctx.peerBytes`.
   *
   * Absent only when the addon is loaded in isolation (tests, tooling); a clip
   * byte OFFER then refuses by name rather than falling back to the inline
   * read, because a consumer that silently gets the bounded path back has no
   * way to know its 50 MiB refusal is a wiring fault and not a clip.
   */
  readonly peerBytes?: AddonPeerBytes
  /** `null` when this device is not an Amcrest camera this addon owns. */
  resolveCamera(deviceId: number): Promise<AmcrestClipCamera | null>
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly now?: () => number
}

export interface ClipService {
  readonly provider: IVideoclipsProvider
  readonly mediaPrefix: string
  readonly mediaHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** The still plane: a cached JPEG, or a 204 that says why there is none. */
  readonly thumbPrefix: string
  readonly thumbHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Drop a camera's cached RPC2 session and clock. For a credential or host
   *  change, where the old session means nothing at the new address. */
  forgetDevice(deviceId: number): void
  /** Close the clip stream dial listener. A runner that shuts down without
   *  this leaves a bound port behind. */
  dispose(): Promise<void>
}

export function createClipService(deps: ClipServiceDeps): ClipService {
  const now = deps.now ?? ((): number => Date.now())
  const logger = deps.logger
  const store = new ClipArtifactStore({ root: deps.dataDir })
  // A SECOND store, same algorithm, different bounds — a still is ~30 KB and
  // outlives the eight 33–73 MiB clips the media scratch rolls through, which
  // matters because re-making one costs the camera a replay.
  const thumbs = new ClipArtifactStore({
    root: deps.dataDir,
    kind: CLIP_THUMB_KIND,
    extension: CLIP_THUMB_EXTENSION,
    maxFilesPerDevice: THUMB_MAX_FILES_PER_DEVICE,
    maxBytesPerDevice: THUMB_MAX_BYTES_PER_DEVICE,
  })

  /** One RPC2 client per camera. Minted lazily: a camera nobody asks for clips
   *  about never logs in. */
  const rpcByDevice = new Map<number, AmcrestRpc2Client>()
  /** The measured camera-clock offset, per device. */
  const clockByDevice = new Map<number, AmcrestCameraClock>()
  /** Every row the provider has listed, mirrored here so the media ROUTE —
   *  which is reached without a cap call — resolves a key without the camera. */
  const rowsByKey = new Map<string, AmcrestClipRow>()
  /**
   * The credentialled `/cam/playback` URL a minted dial will open, per clip.
   *
   * Built when the dial is MINTED and not when it is taken, because that is
   * where the camera's clock is already in hand. It never leaves this closure
   * and it is never logged (`describeReplayUrl` is what a line gets).
   */
  const replayUrlByKey = new Map<string, string>()

  const rowKey = (deviceId: number, clipKey: string): string => `${String(deviceId)}|${clipKey}`

  const rpcFor = (camera: AmcrestClipCamera): AmcrestRpc2Client => {
    const existing = rpcByDevice.get(camera.deviceId)
    if (existing !== undefined) return existing
    const client = new AmcrestRpc2Client({
      host: camera.host,
      port: camera.port,
      https: camera.https,
      username: camera.username,
      password: camera.password,
      now,
    })
    rpcByDevice.set(camera.deviceId, client)
    return client
  }

  /**
   * The camera's clock, measured and cached.
   *
   * `null` when the read failed — never a zero offset, which is the same shape
   * as "this camera runs on UTC" and would move its whole archive by the
   * timezone it really has.
   */
  const clockFor = async (camera: AmcrestClipCamera): Promise<AmcrestCameraClock | null> => {
    const cached = clockByDevice.get(camera.deviceId)
    if (cached !== undefined && cameraClockIsFresh(cached, now())) return cached
    let body: string
    const sentAt = now()
    try {
      body = await camera.client.getCurrentTime()
    } catch (err: unknown) {
      logger.warn('videoclips: the camera did not say what time it thinks it is', {
        tags: { deviceId: camera.deviceId },
        meta: {
          branch: 'clock-unread',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
    const clock = deriveCameraClock({
      currentTimeBody: body,
      hostUtcBeforeMs: sentAt,
      hostUtcAfterMs: now(),
    })
    if (clock === null) {
      logger.warn('videoclips: the camera answered a time this provider could not read', {
        tags: { deviceId: camera.deviceId },
        meta: { branch: 'clock-unparsed' },
      })
      return null
    }
    clockByDevice.set(camera.deviceId, clock)
    if (cameraClockDisagrees(clock)) {
      // Not a refusal: the map is self-consistent at any offset and refusing
      // would break a working camera. It IS a camera fault an operator can act
      // on, and nothing else in the system will say it.
      logger.warn(
        "videoclips: the camera's clock disagrees with the hub by more than any timezone",
        {
          tags: { deviceId: camera.deviceId },
          meta: { branch: 'clock-disagrees', offsetMs: clock.offsetMs },
        },
      )
    } else {
      logger.debug('videoclips: measured this camera’s clock offset', {
        tags: { deviceId: camera.deviceId },
        meta: { offsetMs: clock.offsetMs },
      })
    }
    return clock
  }

  /** ONE replay per camera from this node (`replay-lane.ts`). */
  const lane = createReplayLane({ logger, now })
  const producer = createClipStreamProducer({
    logger,
    lane,
    resolveFfmpeg: deps.resolveFfmpeg,
    now,
  })
  /**
   * The dial listener, lazily bound: a node with no Amcrest camera anyone asks
   * a clip about never opens a port.
   */
  const dial = createClipStreamDial({
    logger,
    now,
    stream: async (target, sink) => {
      const url = replayUrlByKey.get(rowKey(target.deviceId, target.clipKey))
      // The row is the ONE authority on how long this clip is, and it is
      // already here — `rowsByKey` was filled by the same mint that built the
      // URL. Nothing derives a span from the clip key: a second arithmetic on
      // the same fact is how two answers start disagreeing (D623).
      const row = rowsByKey.get(rowKey(target.deviceId, target.clipKey))
      if (url === undefined || row === undefined) {
        // A token whose URL is gone means this process restarted between the
        // mint and the dial. Named, never a silent 404 that would read as an
        // evicted clip.
        return {
          kind: 'refused',
          code: 'fetch-failed',
          detail:
            `no replay was prepared for clip "${target.clipKey}" — the dial outlived the ` +
            'process that minted it; ask for the clip again',
        }
      }
      return await producer.run({
        deviceId: target.deviceId,
        clipKey: target.clipKey,
        url,
        audio: target.audio,
        expectedMs: row.endMs - row.startMs,
        sink,
      })
    },
  })

  const resolveDevice = async (deviceId: number): Promise<ClipDeviceRef | null> => {
    const camera = await deps.resolveCamera(deviceId)
    if (camera === null) return null
    // Dahua config and `mediaFileFind` count channels from 0; the device
    // schema carries the 1-based stream channel.
    return { deviceId, findChannel: Math.max(0, camera.channel - 1) }
  }

  const fileFor = async (
    deviceId: number,
    clipKey: string,
  ): Promise<
    | {
        readonly kind: 'ok'
        readonly path: string
        readonly bytes: number
        readonly durationMs: number | null
      }
    | {
        readonly kind: 'refused'
        readonly code: 'camera-refused' | 'fetch-failed' | 'too-large-to-transfer' | 'catalog-miss'
        readonly detail: string
      }
  > => {
    const camera = await deps.resolveCamera(deviceId)
    if (camera === null) {
      // `catalog-miss`, not `fetch-failed`: nothing was fetched and nothing
      // failed. This node has no such camera, which is the one branch of this
      // route that really is a 404.
      return {
        kind: 'refused',
        code: 'catalog-miss',
        detail: `device ${String(deviceId)} is not an Amcrest camera`,
      }
    }
    const row = rowsByKey.get(rowKey(deviceId, clipKey))
    if (row === undefined) {
      return {
        kind: 'refused',
        code: 'catalog-miss',
        detail: 'no-catalog-row: list the window that holds this clip first',
      }
    }
    return await prepareClipFile(
      { deviceId, row },
      {
        logger,
        store,
        client: camera.client,
        resolveFfmpeg: deps.resolveFfmpeg,
      },
    )
  }

  /**
   * One still for one clip, off the camera's own replay.
   *
   * The policy — which question is asked first, what takes the lane, what
   * DEFERS — lives in `clip-still-mint.ts`; this is only the wiring that gives
   * it a camera, a clock and a place to put the bytes.
   */
  const stillGuard = createClipStillGuard({ logger, now })
  const mintStill = async (
    deviceId: number,
    clipKey: string,
    signal: AbortSignal,
  ): Promise<MintResult> =>
    await mintClipStill(
      deviceId,
      clipKey,
      {
        logger,
        lane,
        guard: stillGuard,
        readCached: async (id, key) => await thumbs.read(id, key),
        hasCamera: async () => (await deps.resolveCamera(deviceId)) !== null,
        rowFor: (id, key) => rowsByKey.get(rowKey(id, key)),
        replayUrlFor: async (id, row, window) => {
          const camera = await deps.resolveCamera(id)
          if (camera === null) {
            return {
              kind: 'refused',
              detail: `device ${String(id)} is not an Amcrest camera`,
            }
          }
          const clock = await clockFor(camera)
          if (clock === null) {
            // NEVER a zero offset: `/cam/playback` is addressed by the camera's
            // own wall clock, and a guessed offset returns the WRONG FOOTAGE
            // rather than an error — a still of somebody else's minute.
            return {
              kind: 'refused',
              detail:
                'this camera would not say what time it thinks it is, and /cam/playback is ' +
                'addressed by its own wall clock — a still cut from a window built on a ' +
                'guessed offset would be a picture of the wrong moment rather than an error',
            }
          }
          return {
            kind: 'ok',
            url: buildReplayUrl({
              host: camera.host,
              username: camera.username,
              password: camera.password,
              // `mediaFileFind` counts channels from 0; `/cam/playback` from 1.
              channel: row.channel + 1,
              startMs: window.startMs,
              endMs: window.endMs,
              clock,
            }),
          }
        },
        cut: async ({ url, signal }) =>
          await cutClipStill(
            { url },
            {
              logger,
              signal,
              resolveFfmpeg: deps.resolveFfmpeg,
            },
          ),
        putStill: async (id, key, bytes) => {
          await thumbs.put(id, key, bytes)
        },
      },
      signal,
    )

  const provider = createAmcrestVideoclipsProvider({
    now,
    logger,
    resolveDevice,

    probeAvailability: async (device): Promise<ClipSourceAvailability> => {
      const camera = await deps.resolveCamera(device.deviceId)
      if (camera === null) {
        return {
          state: 'unreachable',
          reason: 'this device is not an Amcrest camera',
        }
      }
      const tags = { deviceId: device.deviceId }
      // SLICE 1, and the cheap question first (D54): never search a camera
      // whose card is not there. One CGI round-trip, and it turns "no clips"
      // into "no card".
      const storage = await camera.readStorage()
      if (storage !== null) {
        logger.info('videoclips: the storage read settled this source', {
          tags,
          meta: { branch: storage.state, reason: storage.reason ?? null },
        })
        return storage
      }
      // The second gate, and it is not optional: every window this provider
      // asks for travels as the camera's LOCAL wall clock.
      const clock = await clockFor(camera)
      const clockRefusal = availabilityFromClock(clock)
      if (clockRefusal !== null) return clockRefusal
      return { state: 'ok', catalogAsOf: now() }
    },

    readCatalog: async ({ device, sinceMs, untilMs }) => {
      const camera = await deps.resolveCamera(device.deviceId)
      if (camera === null) {
        return {
          kind: 'refused',
          availability: {
            state: 'unreachable',
            reason: 'this device is not an Amcrest camera',
          },
        }
      }
      const storage = await camera.readStorage()
      if (storage !== null) return { kind: 'refused', availability: storage }
      const clock = await clockFor(camera)
      const clockRefusal = availabilityFromClock(clock)
      if (clockRefusal !== null || clock === null) {
        return {
          kind: 'refused',
          availability: clockRefusal ?? {
            state: 'unreachable',
            reason: 'no camera clock',
          },
        }
      }

      const outcome = await readClipRows(
        { rpc: rpcFor(camera), logger, deviceId: device.deviceId },
        { channel: device.findChannel, sinceMs, untilMs, clock },
      )
      switch (outcome.kind) {
        case 'unreachable':
          logger.warn('videoclips: the catalog search did not complete', {
            tags: { deviceId: device.deviceId },
            meta: { branch: 'camera-refused', error: outcome.detail },
          })
          return {
            kind: 'refused',
            availability: { state: 'unreachable', reason: outcome.detail },
          }
        case 'index-empty':
          logger.warn('videoclips: the camera’s index answers nothing anywhere', {
            tags: { deviceId: device.deviceId },
            meta: { branch: 'index-empty', error: outcome.detail },
          })
          return {
            kind: 'refused',
            availability: { state: 'index-empty', reason: outcome.detail },
          }
        case 'empty-window':
          return { kind: 'empty' }
        case 'ok': {
          for (const row of outcome.rows) {
            rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
          }
          logger.info('videoclips: the camera answered a catalog search', {
            tags: { deviceId: device.deviceId },
            meta: {
              rows: outcome.rows.length,
              pages: outcome.pages,
              rejected: outcome.rejectedCount,
              findChannel: device.findChannel,
              oldestStartMs: outcome.rows[0]?.startMs ?? null,
              newestStartMs: outcome.rows[outcome.rows.length - 1]?.startMs ?? null,
            },
          })
          return { kind: 'ok', rows: outcome.rows }
        }
      }
    },

    playbackUrl: (deviceId, clipKey) =>
      `/addon/${AMCREST_ADDON_ID}/${CLIP_MEDIA_PREFIX}/${String(deviceId)}/${clipKey}.mp4`,

    // A `stat`, every time, never a memory of having minted one: the claim has
    // to survive a restart, an eviction and a half-finished write. It is what
    // separates `thumbnail` (a vouch) from `thumbnailMint` (an offer).
    hasVouchedStill: async (deviceId, clipKey) => await thumbs.has(deviceId, clipKey),

    stillUrl: (deviceId, clipKey) =>
      `/addon/${AMCREST_ADDON_ID}/${CLIP_THUMB_PREFIX}/${String(deviceId)}/${clipKey}`,

    prepareBytes: async ({ device, row, maxBytes }) => {
      rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
      const file = await fileFor(device.deviceId, row.clipKey)
      if (file.kind === 'refused') return { kind: 'refused', code: file.code, detail: file.detail }
      if (file.bytes > maxBytes) {
        return {
          kind: 'refused',
          code: 'too-large-to-transfer',
          detail:
            `clip "${row.clipKey}" is ${String(file.bytes)} bytes, over the ` +
            `${String(maxBytes)}-byte bound for an inline read — play it from its playback URL`,
        }
      }
      return {
        kind: 'ok',
        bytes: await readFile(file.path),
        durationMs: file.durationMs,
      }
    },

    prepareOffer: async ({ device, row, maxBytes }) => {
      const peerBytes = deps.peerBytes
      if (peerBytes === undefined) {
        logger.warn('videoclips: no peer-bytes transport on this node', {
          tags: { deviceId: device.deviceId },
          meta: { clipKey: row.clipKey, branch: 'no-peer-bytes' },
        })
        return {
          kind: 'refused',
          code: 'fetch-failed',
          detail: 'this node has no addon-to-addon byte transport wired',
        }
      }
      rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
      const file = await fileFor(device.deviceId, row.clipKey)
      if (file.kind === 'refused') return { kind: 'refused', code: file.code, detail: file.detail }
      if (file.bytes > maxBytes) {
        return {
          kind: 'refused',
          code: 'too-large-to-transfer',
          detail:
            `clip "${row.clipKey}" is ${String(file.bytes)} bytes, over the ` +
            `${String(maxBytes)}-byte bound for one transfer`,
        }
      }
      // The SCRATCH file is offered, not a copy of it: the transfer reads it a
      // chunk at a time and this process holds nothing (D613).
      const offered = await peerBytes.offerFile({
        path: file.path,
        contentType: 'video/mp4',
        label: 'amcrest-clip',
        deviceId: device.deviceId,
      })
      if (offered.kind === 'refused') {
        logger.warn('videoclips: the clip byte offer could not be minted', {
          tags: { deviceId: device.deviceId },
          meta: {
            clipKey: row.clipKey,
            branch: offered.code,
            detail: offered.detail,
          },
        })
        return {
          kind: 'refused',
          code: 'fetch-failed',
          detail: `${offered.code}: ${offered.detail}`,
        }
      }
      return {
        kind: 'ok',
        ticket: offered.ticket,
        durationMs: file.durationMs,
        bytes: file.bytes,
      }
    },

    /**
     * A one-shot URL for this clip's forward-only stream (D597).
     *
     * The camera is NOT touched here — the replay opens when the broker dials
     * the token. What this does need is the camera's measured clock, because
     * `/cam/playback` is addressed by the camera's own wall clock and a
     * window two hours out returns the WRONG FOOTAGE rather than an error
     * (`clip-replay-url.ts`). A clock that could not be read refuses; it is
     * never a zero offset.
     */
    prepareStreamDial: async ({ device, row, audio }) => {
      const camera = await deps.resolveCamera(device.deviceId)
      if (camera === null) {
        return {
          kind: 'refused',
          code: 'catalog-miss',
          detail: `device ${String(device.deviceId)} is not an Amcrest camera`,
        }
      }
      const clock = await clockFor(camera)
      if (clock === null) {
        return {
          kind: 'refused',
          code: 'camera-refused',
          detail:
            'this camera would not say what time it thinks it is, and /cam/playback is ' +
            'addressed by its own wall clock — a window built on a guessed offset would ' +
            'return the wrong footage rather than an error',
        }
      }
      rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
      const url = buildReplayUrl({
        host: camera.host,
        username: camera.username,
        password: camera.password,
        // `mediaFileFind` counts channels from 0; `/cam/playback` from 1.
        channel: row.channel + 1,
        startMs: row.startMs,
        endMs: row.endMs,
        clock,
      })
      replayUrlByKey.set(rowKey(device.deviceId, row.clipKey), url)
      const ticket = await dial.mint({
        deviceId: device.deviceId,
        clipKey: row.clipKey,
        audio,
      })
      if (ticket.kind === 'refused') {
        return {
          kind: 'refused',
          code: 'fetch-failed',
          detail: `${ticket.code}: ${ticket.detail}`,
        }
      }
      return { kind: 'ok', url: ticket.url, expiresAtMs: ticket.expiresAtMs }
    },
  })

  return {
    provider,
    mediaPrefix: CLIP_MEDIA_PREFIX,
    mediaHandler: createClipPlaybackHandler({
      logger,
      resolvePath: async (deviceId, clipKey) => {
        const file = await fileFor(deviceId, clipKey)
        if (file.kind === 'ok') return { kind: 'ok', path: file.path }
        // `fileFor` answers with a NAMED reason and it now travels all the way
        // to the peer: a bare 404 from this route was indistinguishable from a
        // clip that does not exist, and that is what the operator read as
        // "above 100 MB it does not deliver at all" (D391, D611).
        logger.warn('videoclips: a clip file was refused', {
          tags: { deviceId },
          meta: { clipKey, branch: file.code, reason: file.detail },
        })
        return {
          kind: 'refused',
          refusal: { code: file.code, detail: file.detail },
        }
      },
    }),
    thumbPrefix: CLIP_THUMB_PREFIX,
    thumbHandler: createClipThumbHandler({
      logger,
      readCached: async (deviceId, clipKey) => await thumbs.read(deviceId, clipKey),
      mint: mintStill,
    }),
    forgetDevice: (deviceId) => {
      rpcByDevice.get(deviceId)?.reset()
      rpcByDevice.delete(deviceId)
      clockByDevice.delete(deviceId)
    },
    dispose: async () => {
      await dial.dispose()
    },
  }
}
