/**
 * The clip service: one object the addon holds, holding the pieces in the
 * order they depend on each other.
 *
 * It exists so `addon.ts` wires ONE thing and so every gate has exactly one
 * implementation. In particular: the device gate, the catalog row and the
 * camera credentials are read HERE and handed down — the stream route, the
 * dial and the byte read all ask this object, so none of them can grow a
 * second opinion about which clip a key means or which camera it is on.
 */

import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AddonPeerBytes,
  ClipExportFailure,
  IScopedLogger,
  IVideoclipsProvider,
  PinnedFfmpegResolver,
} from '@camstack/types'
import type { HikvisionIsapiClient } from '../hikvision-isapi-client.js'
import {
  CLIP_THUMB_EXTENSION,
  CLIP_THUMB_KIND,
  ClipArtifactStore,
  THUMB_MAX_BYTES_PER_DEVICE,
  THUMB_MAX_FILES_PER_DEVICE,
} from './clip-artifact-store.js'
import {
  type HikvisionClipRow,
  listClipRows,
  readArchivedTracks,
  readStorageState,
} from './clip-catalog.js'
import {
  CLIP_MEDIA_PREFIX,
  CLIP_STREAM_PREFIX,
  CLIP_THUMB_PREFIX,
  type ClipStreamRouteOutcome,
  type ClipStreamRouteSink,
  type ClipStreamTarget,
  createClipPlaybackHandler,
  createClipStreamHandler,
  createClipThumbHandler,
} from './clip-data-plane.js'
import { prepareClipFile } from './clip-file.js'
import { fetchFirstFrame } from './clip-first-frame.js'
import { cutClipStill, cutStillFromAccessUnits } from './clip-still.js'
import { deferStill, type MintResult, refuseStill } from './clip-still-refusal.js'
import { type ClipStreamCamera, createClipStreamProducer } from './clip-stream.js'
import { type ClipStreamDial, createClipStreamDial } from './clip-stream-dial.js'
import {
  type ClipDeviceRef,
  createHikvisionVideoclipsProvider,
} from './hikvision-videoclips-provider.js'
import {
  createReplayLane,
  REPLAY_LANE_WAIT_MS,
  type ReplayLane,
  type ReplayPurpose,
} from './replay-lane.js'
import type { openRtspReplay } from './rtsp/rtsp-replay-session.js'

/**
 * The archived track a camera's catalog is read on.
 *
 * 101 is the main stream's archive on both cameras measured. It is a
 * FALLBACK, not a constant: the availability probe reads `record/tracks` and
 * takes the enabled track the camera itself calls VIDEO — 3833 lists 101 and
 * 103 and only one of them holds a picture — so a camera that archives a
 * different id is read correctly rather than searched for nothing.
 */
export const DEFAULT_ARCHIVED_TRACK_ID = 101

export interface HikvisionClipCamera {
  readonly deviceId: number
  readonly host: string
  readonly username: string
  readonly password: string
  /** The camera's own ISAPI client. Never constructed here. */
  readonly client: HikvisionIsapiClient
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
  /** `null` when this device is not a Hikvision camera this addon owns. */
  resolveCamera(deviceId: number): Promise<HikvisionClipCamera | null>
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly now?: () => number
  /**
   * Seam for the spec, shared by BOTH replay paths.
   *
   * It exists so the camera's one-slot rule can be proved where it is
   * enforced. The lane lives in this file because the stream and the file
   * fetch are two callers of one slot, and a rule proved only in the lane's
   * own unit is a rule nothing checks is WIRED.
   */
  readonly openReplay?: typeof openRtspReplay
  /** Seam for the spec: the real ffmpeg spawn otherwise. */
  readonly spawnMux?: (args: readonly string[]) => ChildProcess
  /** Seam for the spec: the real ffmpeg spawn otherwise. */
  readonly spawnStill?: (args: readonly string[]) => ChildProcess
  /** Seam for the spec. {@link REPLAY_LANE_WAIT_MS} otherwise. */
  readonly replayWaitMs?: number
  /**
   * Seam for the spec: the lane this service serialises on.
   *
   * Exposed so a test can take the camera as a PLAYBACK would and prove that a
   * still in flight gives it back — the rule the live numbers bought, and the
   * one that cannot be proved from inside the service alone.
   */
  readonly lane?: ReplayLane
}

export interface ClipService {
  readonly provider: IVideoclipsProvider
  readonly mediaPrefix: string
  readonly streamPrefix: string
  readonly thumbPrefix: string
  readonly mediaHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly streamHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly thumbHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  disposeClipStreamDial(): Promise<void>
}

export function createClipService(deps: ClipServiceDeps): ClipService {
  const now = deps.now ?? (() => Date.now())
  const logger = deps.logger
  const store = new ClipArtifactStore({ root: deps.dataDir })
  // A SECOND store, same algorithm, different bounds — a still is 30 KB and
  // outlives the ten 40 MB segments the media scratch rolls through.
  const thumbs = new ClipArtifactStore({
    root: deps.dataDir,
    kind: CLIP_THUMB_KIND,
    extension: CLIP_THUMB_EXTENSION,
    maxFilesPerDevice: THUMB_MAX_FILES_PER_DEVICE,
    maxBytesPerDevice: THUMB_MAX_BYTES_PER_DEVICE,
  })
  // One camera, one replay. Everything in this file that reaches the RTSP
  // playback port goes through it — the stream, the file fetch — because the
  // camera's slot is one slot whichever of them is holding it.
  const lane: ReplayLane =
    deps.lane ??
    createReplayLane({
      logger,
      ...(deps.replayWaitMs !== undefined ? { waitMs: deps.replayWaitMs } : {}),
    })
  const producer = createClipStreamProducer({
    logger,
    resolveFfmpeg: deps.resolveFfmpeg,
    ...(deps.openReplay !== undefined ? { openReplay: deps.openReplay } : {}),
    ...(deps.spawnMux !== undefined ? { spawnMux: deps.spawnMux } : {}),
  })

  /** Every row the provider has listed, mirrored here so the ROUTES — which
   *  are reached without a cap call — can resolve a key without the camera. */
  const rowsByKey = new Map<string, HikvisionClipRow>()
  /** Which track each device's catalog was read on, from its own probe. */
  const trackByDevice = new Map<number, number>()

  const rowKey = (deviceId: number, clipKey: string): string => `${String(deviceId)}|${clipKey}`

  const cameraFor = (camera: HikvisionClipCamera): ClipStreamCamera => ({
    deviceId: camera.deviceId,
    host: camera.host,
    username: camera.username,
    password: camera.password,
  })

  const resolveDevice = async (deviceId: number): Promise<ClipDeviceRef | null> => {
    const camera = await deps.resolveCamera(deviceId)
    if (camera === null) return null
    return {
      deviceId,
      trackId: trackByDevice.get(deviceId) ?? DEFAULT_ARCHIVED_TRACK_ID,
      host: camera.host,
      username: camera.username,
      password: camera.password,
    }
  }

  /**
   * The stream ROUTE: the device, then the row, then the producer.
   *
   * Nothing here is a second authority — the row is the provider's own and the
   * bytes are the producer's. This module only decides, in order, which of
   * them refuses, and says so per camera before the camera is touched.
   */
  const streamRoute = async (
    target: ClipStreamTarget,
    sink: ClipStreamRouteSink,
  ): Promise<ClipStreamRouteOutcome> => {
    const camera = await deps.resolveCamera(target.deviceId)
    if (camera === null) {
      logger.warn('videoclips: a clip stream names a device this addon does not own', {
        tags: { deviceId: target.deviceId },
        meta: { clipKey: target.clipKey, branch: 'unknown-device' },
      })
      return {
        kind: 'refused',
        code: 'unknown-device',
        detail: `device ${String(target.deviceId)} is not a Hikvision camera`,
      }
    }
    const row = rowsByKey.get(rowKey(target.deviceId, target.clipKey))
    if (row === undefined) {
      logger.warn('videoclips: no catalog row for this clip stream', {
        tags: { deviceId: target.deviceId },
        meta: { clipKey: target.clipKey, branch: 'no-catalog-row' },
      })
      return {
        kind: 'refused',
        code: 'no-catalog-row',
        detail: 'no-catalog-row: list this window before asking for its stream',
      }
    }
    const lease = await lane.acquire(target.deviceId, 'stream')
    if (lease.kind === 'busy') {
      // Refused BY NAME with the surface still alive, and never by dialling a
      // camera we already know will answer 500 (D611/D315). The lane logged
      // the branch; this is the answer the route carries.
      return { kind: 'refused', code: 'replay-busy', detail: lease.detail }
    }
    let outcome
    try {
      outcome = await producer.stream({
        camera: cameraFor(camera),
        row,
        audio: target.audio,
        sink,
      })
    } finally {
      lease.release()
    }
    switch (outcome.kind) {
      case 'served':
        return { kind: 'served' }
      case 'cut':
        return { kind: 'cut' }
      case 'refused':
        return { kind: 'refused', code: outcome.code, detail: outcome.detail }
    }
  }

  const dial: ClipStreamDial = createClipStreamDial({ logger, stream: streamRoute })

  /**
   * The one archived copy of a clip, fetched if it is not held.
   *
   * `purpose` names who is asking, because the camera's one replay slot is one
   * slot: a still, a playback URL and an export all queue on it, and the lane
   * refuses by name rather than dialling into an opaque 500. The refusal is
   * reported in THIS function's own vocabulary — including `replay-busy` — and
   * each caller maps it into the vocabulary its own answer travels on.
   */
  const fileFor = async (
    deviceId: number,
    clipKey: string,
    purpose: ReplayPurpose,
  ): Promise<
    | {
        readonly kind: 'ok'
        readonly path: string
        readonly bytes: number
        readonly durationMs: number | null
      }
    | {
        readonly kind: 'refused'
        readonly code:
          | 'camera-refused'
          | 'fetch-failed'
          | 'too-large-to-transfer'
          | 'replay-busy'
          | 'no-catalog-row'
          | 'unknown-device'
        readonly detail: string
      }
  > => {
    const camera = await deps.resolveCamera(deviceId)
    if (camera === null) {
      return {
        kind: 'refused',
        code: 'unknown-device',
        detail: `device ${String(deviceId)} is not a Hikvision camera`,
      }
    }
    const row = rowsByKey.get(rowKey(deviceId, clipKey))
    if (row === undefined) {
      return {
        kind: 'refused',
        code: 'no-catalog-row',
        detail: 'no-catalog-row: list the window that holds this clip first',
      }
    }
    // A clip already archived costs no camera slot at all, so the cheap
    // question comes first (D54): taking the lane for a file that is on disk
    // would refuse a stream for nothing.
    const held = await store.pathIfPresent(deviceId, clipKey)
    if (held === null) {
      const lease = await lane.acquire(deviceId, purpose)
      if (lease.kind === 'busy') {
        return { kind: 'refused', code: 'replay-busy', detail: lease.detail }
      }
      let fetched
      try {
        fetched = await prepareClipFile(
          { camera: cameraFor(camera), row, audio: true },
          {
            logger,
            store,
            resolveFfmpeg: deps.resolveFfmpeg,
            ...(deps.openReplay !== undefined ? { openReplay: deps.openReplay } : {}),
            ...(deps.spawnMux !== undefined ? { spawnMux: deps.spawnMux } : {}),
          },
        )
      } finally {
        lease.release()
      }
      // The still, cut on the way past. This is the ONLY thing that puts a
      // thumbnail on a Hikvision clip, and it is free: the bytes are already
      // here, the camera is already released, and a fetch the operator asked
      // for is the only event that earns one.
      if (fetched.kind === 'ok') await mintPassing(deviceId, clipKey, fetched)
      return fetched
    }
    const cached = await prepareClipFile(
      { camera: cameraFor(camera), row, audio: true },
      {
        logger,
        store,
        resolveFfmpeg: deps.resolveFfmpeg,
        ...(deps.openReplay !== undefined ? { openReplay: deps.openReplay } : {}),
        ...(deps.spawnMux !== undefined ? { spawnMux: deps.spawnMux } : {}),
      },
    )
    if (cached.kind === 'ok') await mintPassing(deviceId, clipKey, cached)
    return cached
  }

  /**
   * Mint the still of a clip whose bytes have just been put on this disk.
   *
   * Cheap and idempotent: a `stat` says whether one is already held, and the
   * cut itself is one frame of a local file. It is AWAITED rather than fired
   * and forgotten, because an unhandled rejection in a detached promise is
   * exactly the silence D391 forbids — and because a caller that just waited
   * 30 s for a fetch is not harmed by 1.8 s of decode.
   *
   * A failure here NEVER fails the fetch. The caller asked for a clip, not a
   * picture, and a still that could not be cut is named and left absent.
   */
  const mintPassing = async (
    deviceId: number,
    clipKey: string,
    file: { readonly path: string; readonly durationMs: number | null },
  ): Promise<void> => {
    if (await thumbs.has(deviceId, clipKey)) return
    try {
      const minted = await cutHeldStill(deviceId, clipKey, file.path, file.durationMs)
      if (minted.ok) return
      logger.debug('videoclips: no still was cut from a clip that was just fetched', {
        tags: { deviceId },
        meta: { clipKey, branch: minted.code, reason: minted.reason },
      })
    } catch (err: unknown) {
      logger.warn('videoclips: the passing still mint threw', {
        tags: { deviceId },
        meta: { clipKey, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  type FileRefusal = Extract<Awaited<ReturnType<typeof fileFor>>, { kind: 'refused' }>

  /**
   * `fileFor`'s vocabulary, in the one a clip EXPORT answers on.
   *
   * `ClipExportFailure` is a cross-provider enum in `@camstack/types` and a
   * Hikvision-shaped fact has no business widening it, so the two codes it
   * does not have are folded HERE, in one place, rather than at each call
   * site. Nothing is lost: `detail` opens with the real branch and the lane
   * has already logged the line that names the holder.
   */
  const asExportFailure = (refusal: FileRefusal): ClipExportFailure => {
    switch (refusal.code) {
      case 'replay-busy':
        return 'camera-refused'
      case 'no-catalog-row':
        return 'catalog-miss'
      case 'unknown-device':
        return 'fetch-failed'
      default:
        return refusal.code
    }
  }

  /**
   * One clip's STILL: cut from the clip's own archived copy, at its midpoint.
   *
   * The gates are the cheap ones first (D54) and they are the same gates the
   * media path uses, in the same order — this function adds no second opinion
   * about which clip a key means. Its whole job is to turn `fileFor`'s answer
   * into the still vocabulary, and to cut one frame when there is a file.
   */
  /**
   * One clip's STILL, at the cheapest source that can give one.
   *
   * **Held bytes first, and they are free.** A clip the operator has played or
   * exported is already on this disk: one frame of local decode, no network.
   *
   * **Otherwise the camera's FIRST frame, for ~0.5 s of its playback slot.**
   * The clip is never FETCHED for a still — that was shipped once and cost
   * 898 s of camera time to fill one 20-row screen. A first-frame mint holds
   * the slot for 433–528 ms whatever the clip's length, and it is speculative:
   * the lane evicts it the moment an operator taps anything (`yielded`), and
   * an eviction or a busy slot is DEFERRED, because half a second that lost a
   * race is worth coming back for where twenty seconds was not.
   *
   * The midpoint the operator asked for is not reachable: a narrowed
   * `ContentMgmt/search` window is accepted with 200 and silently served from
   * the segment head (`clip-first-frame.ts` has the measurement).
   */
  const mintStill = async (deviceId: number, clipKey: string): Promise<MintResult> => {
    const camera = await deps.resolveCamera(deviceId)
    if (camera === null) {
      return refuseStill('unknown-device', `device ${String(deviceId)} is not a Hikvision camera`)
    }
    const row = rowsByKey.get(rowKey(deviceId, clipKey))
    if (row === undefined) {
      return refuseStill(
        'no-catalog-row',
        'no-catalog-row: list the window that holds this clip first',
      )
    }
    // The cheap question first (D54): bytes on this disk cost no camera at all.
    const held = await store.pathIfPresent(deviceId, clipKey)
    if (held !== null) return await cutHeldStill(deviceId, clipKey, held, null)

    // SPECULATIVE from here on. `yieldNow` is what makes it subordinate: an
    // operator's tap aborts this mid-replay instead of queueing behind it.
    const evict = new AbortController()
    const lease = await lane.acquire(deviceId, 'still', () => evict.abort())
    if (lease.kind === 'busy') {
      // DEFERRED, not final: the slot is busy NOW. A still that costs half a
      // second is worth asking for again — which is precisely what was not
      // true when a still cost the clip's whole duration.
      return deferStill('queue-full', lease.detail, REPLAY_LANE_WAIT_MS)
    }
    let frame
    try {
      frame = await fetchFirstFrame(
        { camera: cameraFor(camera), row },
        {
          logger,
          signal: evict.signal,
          ...(deps.openReplay !== undefined ? { openReplay: deps.openReplay } : {}),
        },
      )
    } finally {
      lease.release()
    }
    if (frame.kind === 'refused') {
      if (frame.code === 'yielded') {
        return deferStill('queue-full', frame.detail, REPLAY_LANE_WAIT_MS)
      }
      return refuseStill('camera-refused', frame.detail)
    }
    // The camera is already released; the decode happens without it.
    const cut = await cutStillFromAccessUnits(frame.units, frame.codec, {
      logger,
      resolveFfmpeg: deps.resolveFfmpeg,
      ...(deps.spawnStill !== undefined ? { spawnStill: deps.spawnStill } : {}),
    })
    if (cut.kind === 'refused') return refuseStill(cut.code, cut.detail)
    await thumbs.put(deviceId, clipKey, cut.bytes)
    logger.debug('videoclips: a clip still was minted from the camera’s first frame', {
      tags: { deviceId },
      meta: { clipKey, bytes: cut.bytes.byteLength, slotMs: frame.slotMs },
    })
    return { ok: true, bytes: cut.bytes }
  }

  /**
   * The cut itself, over bytes already on this disk. Touches no camera.
   *
   * `measuredMs` is the span the fetch really delivered when one has just run;
   * `null` falls back to the catalog row, which is the number the operator was
   * already shown. Zero is refused rather than seeked to (D393/D382).
   */
  const cutHeldStill = async (
    deviceId: number,
    clipKey: string,
    path: string,
    measuredMs: number | null,
  ): Promise<MintResult> => {
    const row = rowsByKey.get(rowKey(deviceId, clipKey))
    const durationMs = measuredMs ?? (row === undefined ? 0 : row.endMs - row.startMs)
    if (durationMs <= 0) {
      return refuseStill(
        'no-keyframe',
        'this clip has no length to take a midpoint of — nothing measured it and its ' +
          'catalog row spans nothing',
      )
    }
    const cut = await cutClipStill(
      { path, durationMs },
      {
        logger,
        resolveFfmpeg: deps.resolveFfmpeg,
        ...(deps.spawnStill !== undefined ? { spawnStill: deps.spawnStill } : {}),
      },
    )
    if (cut.kind === 'refused') return refuseStill(cut.code, cut.detail)
    await thumbs.put(deviceId, clipKey, cut.bytes)
    logger.debug('videoclips: a clip still was minted', {
      tags: { deviceId },
      meta: {
        clipKey,
        bytes: cut.bytes.byteLength,
        durationMs,
        measured: measuredMs !== null,
      },
    })
    return { ok: true, bytes: cut.bytes }
  }

  const provider = createHikvisionVideoclipsProvider({
    now,
    logger,
    resolveDevice,

    probeAvailability: async (device) => {
      const camera = await deps.resolveCamera(device.deviceId)
      if (camera === null) {
        return { state: 'unreachable', reason: 'this device is not a Hikvision camera' }
      }
      const tags = { deviceId: device.deviceId }
      // The cheap question first (D54): never search a camera whose card is
      // not there, and never read `freeSpace` for the answer — a card at loop
      // steady state reports the same number whether it recorded yesterday or
      // stopped a month ago.
      const storage = await readStorageState(camera.client)
      if (storage.kind === 'absent') {
        logger.info('videoclips: no usable storage — nothing to list', {
          tags,
          meta: { branch: 'no-storage', reason: storage.reason },
        })
        return { state: 'no-storage', reason: storage.reason }
      }
      if (storage.kind === 'unknown') {
        // D393: a measurement that FAILED is not a measurement. Folding an
        // unreadable storage read into "the card is fine" is how a camera with
        // no card answers `ok` and then an empty list.
        logger.warn('videoclips: the storage question was not answered', {
          tags,
          meta: { branch: 'camera-refused', error: storage.reason },
        })
        return { state: 'unreachable', reason: storage.reason }
      }
      try {
        const tracks = await readArchivedTracks(camera.client)
        // The camera's own word for which track holds a picture. Never "the
        // first enabled one": 3833 lists 101 and 103 and only one of them is
        // video.
        const archived =
          tracks.find((track) => track.enabled && track.isVideo) ??
          tracks.find((track) => track.isVideo) ??
          tracks.find((track) => track.enabled) ??
          tracks[0]
        if (archived !== undefined) {
          trackByDevice.set(device.deviceId, archived.id)
          logger.info('videoclips: read this camera’s archived tracks', {
            tags,
            meta: {
              tracks: tracks.map((track) => track.id),
              reading: archived.id,
              codec: archived.codec ?? null,
              resolution: archived.resolution ?? null,
              // How many VIDEO tracks the archive holds — the number that
              // would say a sub twin had appeared. `tracks.length` counts the
              // audio one too and says nothing about quality.
              videoTracks: tracks.filter((track) => track.isVideo).length,
            },
          })
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn('videoclips: the archived track list refused', {
          tags,
          meta: { branch: 'camera-refused', error: reason },
        })
        return { state: 'unreachable', reason }
      }
      return { state: 'ok', catalogAsOf: now() }
    },

    readCatalog: async ({ device, sinceMs, untilMs }) => {
      const camera = await deps.resolveCamera(device.deviceId)
      if (camera === null) {
        return {
          kind: 'refused',
          availability: {
            state: 'unreachable',
            reason: 'this device is not a Hikvision camera',
          },
        }
      }
      const outcome = await listClipRows(camera.client, {
        trackId: device.trackId,
        sinceMs,
        untilMs,
        logger,
        deviceId: device.deviceId,
      })
      if (outcome.kind === 'refused') {
        logger.warn('videoclips: the catalog search refused', {
          tags: { deviceId: device.deviceId },
          meta: { branch: 'camera-refused', error: outcome.detail },
        })
        return { kind: 'refused', availability: { state: 'unreachable', reason: outcome.detail } }
      }
      for (const row of outcome.rows) rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
      logger.info('videoclips: the camera answered a catalog search', {
        tags: { deviceId: device.deviceId },
        meta: {
          rows: outcome.rows.length,
          pages: outcome.pages,
          trackId: device.trackId,
          oldestStartMs: outcome.rows[0]?.startMs ?? null,
          newestStartMs: outcome.rows[outcome.rows.length - 1]?.startMs ?? null,
        },
      })
      return { kind: 'ok', rows: outcome.rows }
    },

    playbackUrl: (deviceId, clipKey) =>
      `/addon/provider-hikvision/${CLIP_MEDIA_PREFIX}/${String(deviceId)}/${clipKey}.mp4`,

    // The VOUCH is a `stat`, every listing, because the claim has to survive a
    // restart, an eviction and a half-finished write.
    hasVouchedStill: (deviceId, clipKey) => thumbs.has(deviceId, clipKey),
    // The same string either way: the two fields differ in what the provider
    // is CLAIMING, not in where the bytes are.
    stillUrl: (deviceId, clipKey) =>
      `/addon/provider-hikvision/${CLIP_THUMB_PREFIX}/${String(deviceId)}/${clipKey}`,

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
      const file = await fileFor(device.deviceId, row.clipKey, 'file')
      if (file.kind === 'refused') {
        return { kind: 'refused', code: asExportFailure(file), detail: file.detail }
      }
      if (file.bytes > maxBytes) {
        return {
          kind: 'refused',
          code: 'too-large-to-transfer',
          detail:
            `clip "${row.fileName}" muxed to ${String(file.bytes)} bytes, over the ` +
            `${String(maxBytes)}-byte bound for one transfer`,
        }
      }
      // The SCRATCH file is offered, not a copy of it: the transfer reads it a
      // chunk at a time and this process holds nothing (D613).
      const offered = await peerBytes.offerFile({
        path: file.path,
        contentType: 'video/mp4',
        label: 'hikvision-clip',
        deviceId: device.deviceId,
      })
      if (offered.kind === 'refused') {
        logger.warn('videoclips: the clip byte offer could not be minted', {
          tags: { deviceId: device.deviceId },
          meta: { clipKey: row.clipKey, branch: offered.code, detail: offered.detail },
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

    prepareBytes: async ({ device, row, maxBytes }) => {
      const file = await fileFor(device.deviceId, row.clipKey, 'file')
      if (file.kind === 'refused') {
        return { kind: 'refused', code: asExportFailure(file), detail: file.detail }
      }
      if (file.bytes > maxBytes) {
        return {
          kind: 'refused',
          code: 'too-large-to-transfer',
          detail:
            `clip "${row.fileName}" muxed to ${String(file.bytes)} bytes, over the ` +
            `${String(maxBytes)}-byte bound for an inline read — play it from its playback URL`,
        }
      }
      return { kind: 'ok', bytes: await readFile(file.path), durationMs: file.durationMs }
    },

    prepareStreamDial: async ({ device, row, audio }) => {
      // Mirrored so the ROUTE — reached without a cap call — resolves the same
      // row the dial was minted for.
      rowsByKey.set(rowKey(device.deviceId, row.clipKey), row)
      const ticket = await dial.mint({
        deviceId: device.deviceId,
        clipKey: row.clipKey,
        audio,
      })
      if (ticket.kind === 'refused') {
        return { kind: 'refused', code: 'fetch-failed', detail: ticket.detail }
      }
      return { kind: 'ok', url: ticket.url, expiresAtMs: ticket.expiresAtMs }
    },
  })

  return {
    provider,
    mediaPrefix: CLIP_MEDIA_PREFIX,
    streamPrefix: CLIP_STREAM_PREFIX,
    thumbPrefix: CLIP_THUMB_PREFIX,
    mediaHandler: createClipPlaybackHandler({
      logger,
      resolvePath: async (deviceId, clipKey) => {
        const file = await fileFor(deviceId, clipKey, 'file')
        if (file.kind === 'ok') return file.path
        // `fileFor` answers with a NAMED reason; the media route's
        // contract is `string | null`, so the name has to land in the log
        // or it lands nowhere. Measured 2026-09-23: eight clips opened at
        // once against 1436, three answered a bare 404 in 0.36 s — the
        // route never reached the camera, nothing was written, and the
        // surface read it as "this clip does not exist" for a clip the
        // list had just shown. The same URL served 200 on its own a
        // moment later. A refusal under load is not an absence (D391),
        // and the sibling STREAM route has always named it.
        deps.logger.warn('videoclips: a clip file was refused', {
          tags: { deviceId },
          meta: { clipKey, branch: file.code, reason: file.detail },
        })
        return null
      },
    }),
    streamHandler: createClipStreamHandler({ logger, stream: streamRoute }),
    thumbHandler: createClipThumbHandler({
      logger,
      // The VOUCHED read: bytes only when a real JPEG is on disk.
      readCached: (deviceId, clipKey) => thumbs.read(deviceId, clipKey),
      mint: mintStill,
    }),
    disposeClipStreamDial: () => dial.dispose(),
  }
}
