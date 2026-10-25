/**
 * The seam that turns the clip modules into a running feature.
 *
 * It owns the three things the pure modules cannot: WHICH device a call is
 * about, WHERE the bytes live, and the three data-plane routes (the still,
 * the file, the stream). Everything else — the catalog, the identity, the
 * label mapping, the queue, the LRU, the mux, the stream producer — is pure
 * or injectable and tested on its own.
 *
 * ## Why the routes are registered here and not in the provider
 *
 * A capability method must not carry bytes (D9/D18): frames and files travel
 * by HANDLE, over the addon's own data plane, and the cap answers with a URL.
 * So the provider mints URLs into THIS service's prefixes and never sees a
 * buffer.
 *
 * ## The one session
 *
 * `ClipDeviceRef.getApi` is whatever the device hands out — the parent hub's
 * socket for a child, the camera's own for a standalone. Nothing in this file
 * constructs a `ReolinkBaichuanApi`, and that is enforced by the provider spec
 * rather than by hope.
 */
import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AddonPeerBytes,
  CamProfile,
  ClipWake,
  IScopedLogger,
  PinnedFfmpegResolver,
} from '@camstack/types'
import { NO_PINNED_FFMPEG_DETAIL, resolvePinnedFfmpegSpawner } from '@camstack/types/node'
import { REOLINK_ADDON_ID } from '../schema.js'
import {
  ClipArtifactStore,
  CLIP_SCRATCH_MAX_BYTES_PER_DEVICE,
  CLIP_SCRATCH_MAX_FILES_PER_DEVICE,
  THUMB_MAX_BYTES_PER_DEVICE,
  THUMB_MAX_FILES_PER_DEVICE,
} from './clip-artifact-store.js'
import { uidIsMissing, UID_MISSING_REASON } from './clip-addressing.js'
import { ClipCatalogCache } from './clip-catalog-cache.js'
import type { ReolinkClipRow } from './clip-catalog.js'
import {
  CLIP_MEDIA_PREFIX,
  CLIP_STREAM_PREFIX,
  CLIP_THUMB_PREFIX,
  createClipPlaybackHandler,
  createClipStreamHandler,
  createClipThumbHandler,
} from './clip-data-plane.js'
import { createClipStreamProducer } from './clip-stream.js'
import { createClipStreamDial } from './clip-stream-dial.js'
import { createClipStreamRoute } from './clip-stream-route.js'
import { type MintResult, queueRefusal, refuseStill } from './clip-still-refusal.js'
import {
  buildClipMuxArgs,
  type ClipDownloadResult,
  createFfmpegClipMuxRunner,
  decideClipAudio,
  describeMuxFailure,
  fetchClipBytes,
} from './clip-mux.js'
import {
  CLIP_IDLE_WINDOW_MS,
  CLIP_IDLE_WINDOW_RETRY_MS,
  type ClipDurationVerdict,
  judgeClipDuration,
} from './clip-truncation.js'
import { ClipThumbQueue, type ThumbLane } from './clip-thumb-queue.js'
import {
  PREFETCH_BATCH,
  type ClipPrefetchOutcome,
  type ClipPrefetchStop,
  PREFETCH_HEADROOM_RECHECK,
} from './clip-prefetch.js'
import {
  createReolinkVideoclipsProvider,
  type ClipBytesRefusalCode,
  type ClipDeviceRef,
  type ClipTwin,
  type PrepareClipBytesInput,
  type PrepareClipBytesOutcome,
  type PrepareClipOfferOutcome,
} from './reolink-videoclips-provider.js'
import { CLIP_CATALOG_REFRESH_WINDOW_MS } from './clip-refresh.js'

export interface ClipServiceDeps {
  /**
   * The addon→addon byte transport (D613), from `ctx.peerBytes`.
   *
   * Absent only when the addon is loaded in isolation (tests, tooling); a clip
   * byte OFFER then refuses by name rather than falling back to the inline
   * read, because a consumer that silently gets the bounded path back has no
   * way to know its 50 MiB refusal is a wiring fault and not a clip.
   */
  readonly peerBytes?: AddonPeerBytes
  /** `ctx.dataDir` — `<nodeDataDir>/addons-data/provider-reolink`. */
  readonly dataDir: string
  readonly logger: IScopedLogger
  /** `null` when this device is not a Reolink camera in this runner. */
  resolveDevice(deviceId: number): Promise<ClipDeviceRef | null>
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly now?: () => number
}

/** Which byte path is asking — only for the log line; the gates are the same. */
export type ClipBytePath = 'file' | 'stream'

export interface GateClipDeviceInput {
  readonly deviceId: number
  readonly clipKey: string
  readonly twin: ClipTwin
  readonly path: ClipBytePath
  /** See {@link PrepareClipBytesInput.wake}. Absent means REFUSED by name. */
  readonly wake?: ClipWake
}

export type GateClipDeviceOutcome =
  | { readonly kind: 'ok'; readonly device: ClipDeviceRef }
  | {
      readonly kind: 'refused'
      /** The branch that refused, as the log line names it. */
      readonly branch: 'unknown-device' | 'sleeping' | 'uid-missing'
      /** The same refusal in the clip-export vocabulary (D572). */
      readonly code: Extract<ClipBytesRefusalCode, 'catalog-unreachable' | 'sleeping'>
      readonly detail: string
    }

export interface ClipService {
  readonly provider: ReturnType<typeof createReolinkVideoclipsProvider>
  readonly thumbPrefix: string
  readonly mediaPrefix: string
  readonly thumbHandler: ReturnType<typeof createClipThumbHandler>
  readonly playbackHandler: ReturnType<typeof createClipPlaybackHandler>
  /**
   * The STREAMED clip (`clip-stream.ts`): the same recording as
   * {@link playbackHandler} serves, handed on as it arrives from the camera,
   * video only, nothing written. Beside the file route, not in its place —
   * which consumer gets which is stage 2's decision.
   */
  readonly streamPrefix: string
  readonly streamHandler: ReturnType<typeof createClipStreamHandler>
  /**
   * Close the stream DIAL listener (D597) — the loopback front door the
   * broker dials the stream through. Bound lazily on the first dial; closed
   * on shutdown so a respawned runner does not leave a port behind.
   */
  disposeClipStreamDial(): Promise<void>
  /**
   * Prefetch this device's missing stills, newest first — bounded by the
   * number it may MINT, yielding to interactive work, never evicting, and
   * stopping at the first refusal (D549 16, wired and amended by D577).
   *
   * The caller is the catalog refresh; `clip-prefetch.ts` decides whether this
   * camera's stills are free at all.
   */
  prefetchThumbnails(deviceId: number, limit?: number): Promise<ClipPrefetchOutcome>
  /** The catalog cache, so a refresh timer can mark a device stale. */
  readonly cache: ClipCatalogCache<ReolinkClipRow>
  /**
   * Re-read one camera's catalog for {@link CLIP_CATALOG_REFRESH_WINDOW_MS}.
   *
   * It goes through the provider's own `listClips`, so the topology decides
   * the API exactly as an operator's read would (the parent's event log for a
   * hub child, the camera's file list for a standalone) and there is no second
   * path that could drift from it. It REJECTS when the catalog could not be
   * confirmed — including the sleep gate refusing a standalone battery camera
   * — which is what lets the scheduler leave `catalogAsOf` alone and say so.
   */
  refreshCatalog(deviceId: number): Promise<void>
  /** True while an operator-facing still is using this host's lane. The
   *  periodic refresh yields to it, exactly as the prefetch does. */
  hostBusy(hostKey: string): boolean
}

export function createClipService(deps: ClipServiceDeps): ClipService {
  const now = deps.now ?? (() => Date.now())
  const cache = new ClipCatalogCache<ReolinkClipRow>({ now })
  const thumbs = new ClipArtifactStore({
    root: deps.dataDir,
    kind: 'clip-thumbs',
    maxFilesPerDevice: THUMB_MAX_FILES_PER_DEVICE,
    maxBytesPerDevice: THUMB_MAX_BYTES_PER_DEVICE,
    extension: '.jpg',
  })
  const media = new ClipArtifactStore({
    root: deps.dataDir,
    kind: 'clip-media',
    maxFilesPerDevice: CLIP_SCRATCH_MAX_FILES_PER_DEVICE,
    maxBytesPerDevice: CLIP_SCRATCH_MAX_BYTES_PER_DEVICE,
    extension: '.mp4',
  })
  const queue = new ClipThumbQueue({ now })
  const muxRunner = createFfmpegClipMuxRunner({
    resolveFfmpeg: deps.resolveFfmpeg,
    spawnFn: spawn,
  })
  /**
   * One production per `(device, clip, twin)`: two clicks on one row — or a
   * click and an EXPORT of the same row — must not pay cmd 5 twice. It is
   * keyed by the twin because the two files are different bytes, and it is
   * shared by the player and the byte read because those two are the only
   * callers there are: an in-flight map per caller would be a second wake on
   * a battery camera the operator authorised once.
   */
  const producing = new Map<string, Promise<PrepareClipBytesOutcome>>()

  const rowFor = (deviceId: number, clipKey: string): ReolinkClipRow | null => {
    // The row is whatever the catalog last listed for this key. It is held by
    // day, so this walks the days the device has — bounded by the cache, never
    // by the camera.
    return cache.findBy(deviceId, (row) => row.clipKey === clipKey)
  }

  const mintThumbnail = async (
    deviceId: number,
    clipKey: string,
    lane: ThumbLane,
  ): Promise<MintResult> => {
    const device = await deps.resolveDevice(deviceId)
    if (device === null) {
      return refuseStill(
        'unknown-device',
        `unknown-device: ${deviceId} is not a Reolink camera here`,
      )
    }
    // Gate BEFORE the api — the login is the wake.
    if (device.isBattery && device.sleeping && !device.isHubChild) {
      return refuseStill('sleeping', 'sleeping: a still would wake this standalone battery camera')
    }
    // The uid requirement is the hub child's, never every camera's
    // (`clip-addressing.ts`): a standalone ignores it and the library resolves
    // its own over cmd 114 when a command needs one.
    if (uidIsMissing(device)) {
      return refuseStill('uid-missing', UID_MISSING_REASON)
    }
    const row = rowFor(deviceId, clipKey)
    if (row === null) {
      return refuseStill(
        'no-catalog-row',
        'no-catalog-row: list this day before asking for its stills',
      )
    }
    // The CoverPreview answer is a raw I-frame the library decodes with
    // ffmpeg, and its own default for the binary is a PATH `ffmpeg` — absent
    // on the hub image (`spawn ffmpeg ENOENT` on every still, for a day).
    // Resolved BEFORE the queue: no binary is our failure, not the camera's,
    // and never worth a login (the wake on a battery camera).
    let ffmpegPath: string
    try {
      ffmpegPath = await deps.resolveFfmpeg()
    } catch (err: unknown) {
      const reason = `${NO_PINNED_FFMPEG_DETAIL}: ${err instanceof Error ? err.message : String(err)}`
      deps.logger.warn('videoclips: a thumbnail mint refused', {
        tags: { deviceId },
        meta: { clipKey, lane, branch: 'decode-failed', error: reason },
      })
      return refuseStill('decode-failed', reason)
    }
    try {
      const bytes = await queue.submit({
        host: device.hostKey,
        lane,
        run: async () => {
          const api = await device.getApi()
          // Sub stream: the operator's choice, and on the E1 Outdoor PoE a
          // `mainStream` CoverPreview returns the same 640×360 sub frame
          // anyway (measured on 592).
          return api.getVideoclipThumbnailJpeg({
            channel: device.channel,
            time: new Date(row.startMs),
            endTime: new Date(row.endMs),
            snapType: 'sub',
            // Omitted rather than sent as `undefined`: the wrapper resolves a
            // standalone's own uid itself, and an explicit absent key is not
            // the same as an absent one under `exactOptionalPropertyTypes`.
            ...(device.uid === undefined ? {} : { uid: device.uid }),
            isNvr: device.isHubChild,
            timeZone: device.timeZone,
            ffmpegPath,
          })
        },
      })
      if (bytes.byteLength === 0) {
        return refuseStill('no-keyframe', 'no-keyframe: the camera returned an empty frame')
      }
      await thumbs.put(deviceId, clipKey, bytes)
      return { ok: true, bytes }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      // The QUEUE refusing is about the lane, not the camera: the still is
      // still coming and the caller is told to come back. Anything else is
      // the camera, and no retry inside this tile's life changes it.
      const deferred = queueRefusal(err)
      if (deferred !== null) {
        deps.logger.debug('videoclips: a thumbnail mint was deferred', {
          tags: { deviceId },
          meta: { clipKey, lane, code: deferred.code, retryAfterMs: deferred.retryAfterMs },
        })
        return deferred
      }
      deps.logger.warn('videoclips: a thumbnail mint refused', {
        tags: { deviceId },
        meta: { clipKey, lane, branch: 'camera-refused', error: reason },
      })
      return refuseStill('camera-refused', reason)
    }
  }

  /**
   * ONE clip's bytes, on the short window, with the fetch PROVED (D568).
   *
   * Completion is an idle window because nothing on the wire ends a cmd 5
   * transfer, and that window is short. What makes it safe is not the window,
   * it is the decoded duration judged against the row that asked for it.
   */
  const fetchVerifiedClipBytes = async (
    device: ClipDeviceRef,
    row: ReolinkClipRow,
    clipKey: string,
    fileName: string,
  ): Promise<ClipDownloadResult> => {
    const deviceId = device.deviceId
    const api = await device.getApi()
    const fetchPass = (idleTimeoutMs: number): Promise<ClipDownloadResult> =>
      fetchClipBytes({
        download: () =>
          api.downloadRecordingDemuxed({
            channel: device.channel,
            ...(device.uid !== undefined ? { uid: device.uid } : {}),
            fileName,
            idleTimeoutMs,
          }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })
    const judge = (pass: ClipDownloadResult): ClipDurationVerdict =>
      judgeClipDuration({
        expectedMs: row.endMs - row.startMs,
        decodedSeconds: pass.stats.durationSeconds,
        ...(row.inProgress === true ? { inProgress: true } : {}),
      })

    const first = await fetchPass(CLIP_IDLE_WINDOW_MS)
    const firstVerdict = judge(first)
    if (firstVerdict.kind === 'unknown') {
      // The check is INERT for this clip, and that is not the same as passing
      // it. `clip-open` is expected — an open file's endMs is frozen (D563) —
      // so it is not an operator's problem; the other two are.
      const line = {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: 'completeness-unverified',
          reason: firstVerdict.reason,
          idleTimeoutMs: CLIP_IDLE_WINDOW_MS,
          expectedMs: row.endMs - row.startMs,
          decodedSeconds: first.stats.durationSeconds,
        },
      }
      if (firstVerdict.reason === 'clip-open')
        deps.logger.debug('videoclips: an open clip cannot be checked for truncation', line)
      else deps.logger.warn('videoclips: a clip fetch could not be checked for truncation', line)
      return first
    }
    if (firstVerdict.kind === 'complete') return first

    deps.logger.warn('videoclips: a clip fetch came back truncated', {
      tags: { deviceId },
      meta: {
        clipKey,
        branch: 'truncated-fetch',
        idleTimeoutMs: CLIP_IDLE_WINDOW_MS,
        expectedSeconds: firstVerdict.expectedSeconds,
        decodedSeconds: firstVerdict.decodedSeconds,
        shortfallSeconds: firstVerdict.shortfallSeconds,
        bytes: first.annexB.byteLength,
        keyframes: first.stats.keyframes,
      },
    })
    // ONE retry, on the conservative window, so the answer to "was that the
    // window or the camera?" is measured and not assumed. A camera that serves
    // a short file twice will not serve a longer one on a third pass, and the
    // operator is already waiting.
    const retry = await fetchPass(CLIP_IDLE_WINDOW_RETRY_MS)
    // A retry never serves LESS media than the pass it replaces.
    const keepRetry = (retry.stats.durationSeconds ?? 0) >= (first.stats.durationSeconds ?? 0)
    const kept = keepRetry ? retry : first
    const verdict = keepRetry ? judge(retry) : firstVerdict
    const keptWindowMs = keepRetry ? CLIP_IDLE_WINDOW_RETRY_MS : CLIP_IDLE_WINDOW_MS
    if (verdict.kind === 'short') {
      // Served, because this is exactly what the 2 000 ms window shipped for
      // this clip's whole life — but NAMED, so a truncated fetch can never be
      // mistaken for a short recording.
      deps.logger.warn('videoclips: a clip is still short after the long window', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: 'truncated-after-retry',
          idleTimeoutMs: keptWindowMs,
          retriedOnMs: CLIP_IDLE_WINDOW_RETRY_MS,
          expectedSeconds: verdict.expectedSeconds,
          decodedSeconds: verdict.decodedSeconds,
          shortfallSeconds: verdict.shortfallSeconds,
          bytes: kept.annexB.byteLength,
        },
      })
      return kept
    }
    deps.logger.info('videoclips: a truncated clip fetch landed whole on the long window', {
      tags: { deviceId },
      meta: {
        clipKey,
        branch: 'truncation-recovered',
        idleTimeoutMs: keptWindowMs,
        decodedSeconds: verdict.kind === 'complete' ? verdict.decodedSeconds : null,
        bytes: kept.annexB.byteLength,
      },
    })
    return kept
  }

  /**
   * ONE production of one twin's MP4 — the only place a clip's bytes are made.
   *
   * The player and `readClipBytes` are both served from here, which is the
   * whole point: D568's completion rules (the 300 ms window, the decoded
   * duration proved against the row, the single retry on 2 000 ms) and D567's
   * mux (the MEASURED rate, the AAC copy, `+faststart`) exist once. A byte
   * read with its own fetch would be the second authority those records were
   * written to prevent.
   *
   * It never throws for a gated branch: every exit is a NAMED refusal in the
   * clip-export vocabulary, so the provider can hand the engine a token it
   * believes rather than prose it has to guess at (D572).
   */
  /**
   * The gates every clip byte path runs, in ONE place: the device, the
   * sleeping standalone, the uid. The file producer and the stream producer
   * both call this and neither decides any of it again — a second copy of
   * the sleeping gate is a second chance to wake a camera nobody authorised.
   * Every refusal is logged HERE, with its branch, so a caller cannot forget.
   */
  const gateClipDevice = async (input: GateClipDeviceInput): Promise<GateClipDeviceOutcome> => {
    const { deviceId, clipKey, twin, path } = input
    const tags = { deviceId }
    const device = await deps.resolveDevice(deviceId)
    if (device === null) {
      deps.logger.warn('videoclips: no Reolink camera here to fetch this clip from', {
        tags,
        meta: { clipKey, twin, path, branch: 'unknown-device' },
      })
      return {
        kind: 'refused',
        branch: 'unknown-device',
        code: 'catalog-unreachable',
        detail: `device ${deviceId} is not a Reolink camera on this node`,
      }
    }
    // Gate BEFORE `getApi()` — on a UDP battery camera the login IS the wake,
    // so a gate after it gates nothing.
    if (device.isBattery && device.sleeping && !device.isHubChild) {
      if (input.wake !== 'authorised') {
        deps.logger.warn('videoclips: refusing to fetch a clip from a sleeping camera', {
          tags,
          meta: { clipKey, twin, path, branch: 'sleeping' },
        })
        return {
          kind: 'refused',
          branch: 'sleeping',
          code: 'sleeping',
          detail:
            `device ${deviceId} is a standalone battery camera and is sleeping — ` +
            'fetching a clip would wake it, and no operator authorisation was carried',
        }
      }
      // One authorised yes is ONE wake, and it is spent HERE, once: the
      // in-flight map above is what stops a second caller buying a second one.
      deps.logger.warn('videoclips: waking a sleeping battery camera on an authorised clip read', {
        tags,
        meta: { clipKey, twin, path, branch: 'wake-authorised' },
      })
    }
    // The uid requirement is the hub child's, never every camera's
    // (`clip-addressing.ts`): a standalone ignores it.
    if (uidIsMissing(device)) {
      deps.logger.warn('videoclips: no uid for this camera — its clip cannot be addressed', {
        tags,
        meta: { clipKey, twin, path, branch: 'uid-missing' },
      })
      return {
        kind: 'refused',
        branch: 'uid-missing',
        code: 'catalog-unreachable',
        detail: UID_MISSING_REASON,
      }
    }
    return { kind: 'ok', device }
  }

  const produceTwin = async (input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome> => {
    const { deviceId, row, fileName, twin } = input
    const clipKey = row.clipKey
    const tags = { deviceId }
    const gate = await gateClipDevice({
      deviceId,
      clipKey,
      twin,
      path: 'file',
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
    })
    if (gate.kind === 'refused') return { kind: 'refused', code: gate.code, detail: gate.detail }
    const { device } = gate

    let downloaded: ClipDownloadResult
    // WHICH file is about to be pulled off the camera, in the camera's own
    // words. The operator reported tapping a 15:30 card and watching a clip
    // from an hour earlier play: the app's trace proves the tap, the stage and
    // the byte request all carry the 15:39 id, so the only unmeasured hop left
    // is what the CAMERA hands back for it (2026-09-21).
    deps.logger.info('videoclips: fetching a clip file from the camera', {
      tags,
      meta: { clipKey, twin, fileName, startMs: row.startMs, endMs: row.endMs },
    })
    try {
      downloaded = await fetchVerifiedClipBytes(device, row, clipKey, fileName)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      deps.logger.warn('videoclips: the camera never delivered this clip', {
        tags,
        meta: { clipKey, twin, branch: 'camera-refused', error: reason },
      })
      return { kind: 'refused', code: 'camera-refused', detail: reason }
    }

    // What the download really delivered, decided BEFORE any bytes are
    // written: an absent track and a track we refuse to copy are different
    // answers, and a clip served without sound says which (D567).
    const audio = decideClipAudio(downloaded.audio)
    if (audio.kind === 'silent') {
      deps.logger.warn('videoclips: serving a clip with no sound', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: audio.reason,
          audioFormat: audio.format,
          audioPackets: downloaded.stats.audioPackets,
          audioBytes: downloaded.stats.audioBytes,
        },
      })
    }
    // The MEASURED rate, never the declared one: a hub child's info header
    // says 30 where the camera delivers 15.019, and muxing at the declared
    // rate makes the video half as long as its own audio.
    if (downloaded.stats.fpsSource !== 'timestamps') {
      deps.logger.warn('videoclips: no measured frame rate for this clip', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: 'fps-unmeasured',
          fpsSource: downloaded.stats.fpsSource,
          fps: downloaded.stats.fps,
          infoFps: downloaded.stats.infoFps,
        },
      })
    }

    const scratch = await mkdtemp(join(tmpdir(), 'camstack-clip-mux-'))
    try {
      const rawPath = join(scratch, 'clip.h264')
      const audioPath = join(scratch, 'clip.aac')
      const outPath = join(scratch, 'clip.mp4')
      await writeFile(rawPath, downloaded.annexB)
      if (audio.kind === 'copy') await writeFile(audioPath, audio.data)
      const run = await muxRunner(
        buildClipMuxArgs({
          inputPath: rawPath,
          outputPath: outPath,
          videoType: downloaded.videoType,
          fps: downloaded.stats.fps,
          ...(audio.kind === 'copy' ? { audio: { path: audioPath, format: audio.format } } : {}),
        }),
      )
      const failure = describeMuxFailure(run)
      if (failure !== null) {
        deps.logger.warn('videoclips: the clip mux failed', {
          tags: { deviceId },
          meta: { clipKey, twin, branch: 'mux-failed', error: failure },
        })
        return { kind: 'refused', code: 'fetch-failed', detail: failure }
      }
      const muxed = await readFile(outPath)
      // MEASURED, or nothing. A measurement that failed is `null`, never `0`
      // and never the catalog row's own span wearing a measurement's clothes
      // (D393) — the row is a projection and the caller already has it.
      const decoded = downloaded.stats.durationSeconds
      const durationMs =
        decoded !== null && Number.isFinite(decoded) && decoded > 0
          ? Math.round(decoded * 1_000)
          : null
      return { kind: 'ok', bytes: muxed, durationMs }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** {@link produceTwin}, deduplicated per `(device, clip, twin)`. */
  const produceOnce = (input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome> => {
    const key = `${input.deviceId}|${input.row.clipKey}|${input.twin}`
    const inFlight = producing.get(key)
    if (inFlight !== undefined) return inFlight
    const run = produceTwin(input).finally(() => {
      producing.delete(key)
    })
    producing.set(key, run)
    return run
  }

  /**
   * The PLAYER's path: the sub twin, filed in the scratch, served by URL.
   *
   * `null` for every refusal — the playback route answers a status code and
   * has no vocabulary to carry a token; the named reason is already in the log
   * line `produceTwin` wrote.
   */
  const prepareClip = async (deviceId: number, clipKey: string): Promise<string | null> => {
    const ready = await media.pathIfPresent(deviceId, clipKey)
    if (ready !== null) return ready
    const row = rowFor(deviceId, clipKey)
    // The row carries the byte handle. Without it there is nothing to fetch —
    // and nothing to guess, because a file name is a path on the camera.
    if (row === null) {
      deps.logger.warn('videoclips: no catalog row for this clip', {
        tags: { deviceId },
        meta: { clipKey, branch: 'no-catalog-row' },
      })
      return null
    }
    const outcome = await produceOnce({
      deviceId,
      row,
      fileName: row.subFileName,
      twin: 'sub',
    })
    if (outcome.kind !== 'ok') return null
    // `put` is immutable and returns the path it already holds, so two racing
    // players cost one file and one fetch.
    return media.put(deviceId, clipKey, outcome.bytes)
  }

  /**
   * The EXPORT's path: the asked twin's bytes, in memory, once.
   *
   * The scratch is the PLAYER's cache and its key
   * (`clipKeyFor(channel, subFileName)`) carries no twin, so it holds exactly
   * one thing: the sub file. A `sub` read therefore reuses it and warms it — a
   * clip the operator just watched costs no second cmd 5, and one he exports
   * first is already there when he plays it. A `main` read BYPASSES it in both
   * directions: writing a main file under that key would serve 33× the bytes
   * to every `low` playback of the clip, and filing it under a second key
   * would evict the sub clips the player really does re-read (10 files /
   * 200 MiB per device) to cache a one-shot export nobody reads twice.
   */
  const prepareBytes = async (input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome> => {
    const { deviceId, row, twin } = input
    if (twin === 'sub') {
      const cached = await media.read(deviceId, row.clipKey)
      if (cached !== null) {
        deps.logger.info('videoclips: a clip byte read was served from the scratch', {
          tags: { deviceId },
          meta: { clipKey: row.clipKey, twin, branch: 'scratch-hit', bytes: cached.byteLength },
        })
        // No duration: THIS pass measured nothing, and the file carries no
        // sidecar. Absent is the honest answer; the row's span is not.
        return { kind: 'ok', bytes: cached, durationMs: null }
      }
    }
    const outcome = await produceOnce(input)
    if (outcome.kind === 'ok' && twin === 'sub') {
      await media.put(deviceId, row.clipKey, outcome.bytes)
    }
    return outcome
  }

  /**
   * The same clip, offered over the addon→addon byte transport (D613).
   *
   * It reuses {@link prepareBytes} whole — one fetch path, one set of
   * completion rules, one scratch. A second producer here would be the second
   * authority D558 refuses to create. What changes is only how the result
   * LEAVES: `offerBuffer` writes it to a one-shot loopback socket in bounded
   * chunks, honouring `write()`'s return (D447), instead of base64-ing it into
   * a cap envelope that the caller then copies again.
   */
  const prepareOffer = async (input: PrepareClipBytesInput): Promise<PrepareClipOfferOutcome> => {
    const peerBytes = deps.peerBytes
    if (peerBytes === undefined) {
      deps.logger.warn('videoclips: no peer-bytes transport on this node', {
        tags: { deviceId: input.deviceId },
        meta: { clipKey: input.row.clipKey, branch: 'no-peer-bytes' },
      })
      return {
        kind: 'refused',
        code: 'fetch-failed',
        detail: 'this node has no addon-to-addon byte transport wired',
      }
    }
    const outcome = await prepareBytes(input)
    if (outcome.kind === 'refused') return outcome
    const offered = await peerBytes.offerBuffer({
      bytes: outcome.bytes,
      contentType: 'video/mp4',
      label: 'reolink-clip',
      deviceId: input.deviceId,
    })
    if (offered.kind === 'refused') {
      deps.logger.warn('videoclips: the clip byte offer could not be minted', {
        tags: { deviceId: input.deviceId },
        meta: { clipKey: input.row.clipKey, branch: offered.code, detail: offered.detail },
      })
      return { kind: 'refused', code: 'fetch-failed', detail: `${offered.code}: ${offered.detail}` }
    }
    return {
      kind: 'ok',
      ticket: offered.ticket,
      durationMs: outcome.durationMs,
      bytes: outcome.bytes.byteLength,
    }
  }

  /**
   * The STREAM's path (`clip-stream-route.ts`): the same gates, the same row,
   * nothing written. Beside the file path, not in its place.
   */
  const streamClip = createClipStreamRoute({
    logger: deps.logger,
    gate: gateClipDevice,
    rowFor,
    producer: createClipStreamProducer({
      logger: deps.logger,
      // FOUR pipes: fd 3 is the ADTS input the mux reads as `pipe:3` (D600).
      // Always present, never conditional — an unused extra pipe costs an fd,
      // and a spawner that had to know the args would be a second authority
      // on whether this stream carries sound.
      // Asked per stream, before the dial; a refusal is named per camera —
      // never a PATH `ffmpeg` (D540).
      resolveMuxSpawner: () =>
        resolvePinnedFfmpegSpawner(undefined, deps.resolveFfmpeg, {
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        }),
    }),
  })

  /**
   * The stream's DIAL (D597): the same route behind a one-shot token on a
   * loopback listener, because the broker holds no credential the data
   * plane or the hub proxy would take. See `clip-stream-dial.ts`.
   */
  const streamDial = createClipStreamDial({ logger: deps.logger, stream: streamClip, now })

  const provider = createReolinkVideoclipsProvider({
    now,
    cache,
    resolveDevice: deps.resolveDevice,
    hasVouchedThumbnail: (deviceId, clipKey) => thumbs.has(deviceId, clipKey),
    thumbnailUrl: (deviceId, clipKey) =>
      `/addon/${REOLINK_ADDON_ID}/${CLIP_THUMB_PREFIX}/${deviceId}/${clipKey}`,
    thumbnailMintUrl: (deviceId, clipKey) =>
      `/addon/${REOLINK_ADDON_ID}/${CLIP_THUMB_PREFIX}/${deviceId}/${clipKey}`,
    preparePlayback: async ({ device, clipKey, profile }) => ({
      // The URL is minted without touching the camera: the bytes are fetched
      // when the player asks for them, so opening a clip panel costs nothing
      // until somebody presses play.
      playbackUrl: `/addon/${REOLINK_ADDON_ID}/${CLIP_MEDIA_PREFIX}/${device.deviceId}/${clipKey}.mp4`,
      served: (profile === 'high' ? 'high' : 'low') satisfies CamProfile,
    }),
    prepareBytes,
    prepareOffer,
    prepareStreamDial: async ({ deviceId, row, twin, audio }) => {
      // The same gate the file path and the stream route run — a sleeping
      // standalone, a hub child with no uid — decided BEFORE a URL exists,
      // so a refusal is named at the cap and no dial is minted for nothing.
      const gate = await gateClipDevice({ deviceId, clipKey: row.clipKey, twin, path: 'stream' })
      if (gate.kind === 'refused') return { kind: 'refused', code: gate.code, detail: gate.detail }
      const minted = await streamDial.mint({ deviceId, clipKey: row.clipKey, twin, audio })
      if (minted.kind === 'refused') {
        return { kind: 'refused', code: 'fetch-failed', detail: `${minted.code}: ${minted.detail}` }
      }
      return { kind: 'ok', url: minted.url, expiresAtMs: minted.expiresAtMs }
    },
    logger: deps.logger,
  })

  return {
    provider,
    cache,
    disposeClipStreamDial: () => streamDial.dispose(),
    refreshCatalog: async (deviceId) => {
      const until = now()
      await provider.listClips({
        deviceId,
        since: until - CLIP_CATALOG_REFRESH_WINDOW_MS,
        until,
        // Naming the provider is required (D554 amended). This one is asking ITSELF —
        // an in-process refresh, no dispatcher in between — so it names itself.
        provider: REOLINK_ADDON_ID,
      })
    },
    hostBusy: (hostKey) => queue.busy(hostKey),
    thumbPrefix: CLIP_THUMB_PREFIX,
    mediaPrefix: CLIP_MEDIA_PREFIX,
    streamPrefix: CLIP_STREAM_PREFIX,
    streamHandler: createClipStreamHandler({ stream: streamClip, logger: deps.logger }),
    thumbHandler: createClipThumbHandler({
      readCached: (deviceId, clipKey) => thumbs.read(deviceId, clipKey),
      mint: (deviceId, clipKey) => mintThumbnail(deviceId, clipKey, 'interactive'),
      logger: deps.logger,
    }),
    playbackHandler: createClipPlaybackHandler({
      resolvePath: (deviceId, clipKey, _req: IncomingMessage) => prepareClip(deviceId, clipKey),
      logger: deps.logger,
    }),
    prefetchThumbnails: async (deviceId, limit = PREFETCH_BATCH) => {
      // NEWEST first, and the whole catalog behind them: the budget below is
      // on MINTS, so a pass keeps up with the live edge AND backfills what the
      // pass before it could not reach. Bounding the ROWS instead is what left
      // 592 at 25.3 % of 1 188 with a warm newest-20 for ever (D577).
      const rows = cache.allRows(deviceId).toSorted((a, b) => b.startMs - a.startMs)
      let minted = 0
      let scanned = 0
      let alreadyHeld = 0
      const outcome = (
        stop: ClipPrefetchStop,
        refusal: ClipPrefetchOutcome['refusal'] = null,
      ): ClipPrefetchOutcome => ({ minted, scanned, alreadyHeld, stop, refusal })

      // A prefetch NEVER evicts, so headroom gates the whole pass. Only a
      // write can move it, and reading it is a `readdir` plus a `stat` per
      // file — so it is read here and then every PREFETCH_HEADROOM_RECHECK
      // mints, a stride that cannot cross the bound (see that constant).
      if (!(await thumbs.hasHeadroomForPrefetch(deviceId))) return outcome('no-headroom')

      for (const row of rows) {
        scanned += 1
        if (await thumbs.has(deviceId, row.clipKey)) {
          alreadyHeld += 1
          continue
        }
        if (minted >= limit) return outcome('budget')
        const result = await mintThumbnail(deviceId, row.clipKey, 'prefetch')
        if (!result.ok) {
          // The host has ONE lane and the next row walks into the same wall —
          // a refusal that does not arm the lane's backoff (a timeout is not a
          // `400 rejected`) would otherwise cost a budget's worth of it per
          // pass, for ever. The scheduler turns this into a quiet period.
          return outcome('refused', {
            code: result.code,
            disposition: result.disposition,
            clipKey: row.clipKey,
          })
        }
        minted += 1
        if (
          minted % PREFETCH_HEADROOM_RECHECK === 0 &&
          !(await thumbs.hasHeadroomForPrefetch(deviceId))
        ) {
          return outcome('no-headroom')
        }
      }
      return outcome('rows-exhausted')
    },
  }
}
