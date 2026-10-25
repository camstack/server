/**
 * Typed IPC protocol between the per-session decode coordinator (Task 3 —
 * `child_process.fork`s the worker) and the decode-worker child
 * (`decode-worker-child.ts`, Task 2). Pure module: no node-av, no
 * `process.on`/`process.send` here — those live in `decode-worker-child.ts`,
 * which documents why raw IPC is sanctioned for that file.
 *
 * The protocol is a request/response pull: the parent asks for the next
 * frame (`pull`), gets back metadata + an opaque `frameId`, then asks for
 * pixel bytes for that id with an optional ROI (`toBuffer`). No shared
 * memory, no `/dev/shm` — frames travel as IPC messages only.
 */

import { isWorkerLeaseKnobs, type WorkerLeaseKnobs } from './native-lease-knobs.js'
import { isSessionHwaccelOffer, type SessionHwaccelOffer } from './session-hwaccel.js'
import type {
  FrameImageOptions,
  NormalizedBbox,
  VideoFrameGenOptions,
  VideoFrameSource,
} from './video-frame-generator.js'

export type { NormalizedBbox } from './video-frame-generator.js'

/** Pixel format carried on the wire — matches {@link FrameImage.format}. */
export type WorkerFrameFormat = 'rgb' | 'gray'

/** Severity of a worker `log` reply, mapped 1:1 onto `IScopedLogger` methods. */
export type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Classify a worker diagnostic line into a {@link WorkerLogLevel}. Failure /
 * fault lines surface at `warn` (visible at the default log level so a
 * native-crop failure is finally seen in `addons.getLogs`); routine
 * provenance / transition / lifecycle lines stay `debug`. Pure + exported so
 * the mapping is unit-testable without spawning a worker.
 */
export function logLevelForLine(line: string): WorkerLogLevel {
  return /\b(fail(?:ed|ure)?|error|exception|unhandled rejection|corrupt|EIO|EINVAL)\b/i.test(line)
    ? 'warn'
    : 'debug'
}

/**
 * The COLD-START split the worker owns, reported once per session.
 *
 * `forkToFrameMs` alone measured 4 689 ms at the median across 2 501 cold
 * dials and could not say which of four serial steps held it, because nothing
 * between the fork and the first frame was timed. Every number here is a step
 * the parent process cannot see and cannot infer: it happens inside the child,
 * inside libav.
 *
 * They do not sum to `forkToFrameMs`. The residual is module load (measured
 * ~0.2 s), the IPC hop, and the one-shot GPU filter probe — and keeping it a
 * RESIDUAL rather than pretending to a full decomposition is deliberate: a
 * split that always adds up is a split someone has fitted.
 */
export interface WorkerDialTiming {
  /** `HardwareContext.create` — the VAAPI/videotoolbox device, resolved once per worker. */
  readonly hwContextMs: number
  /**
   * `Demuxer.open`. Contains `avformat_find_stream_info` only when
   * {@link WorkerDialTiming.streamInfoProbed} is true — see
   * `pull-demuxer-open.ts` for why the two readings are different measurements.
   */
  readonly demuxerOpenMs: number
  /** `Decoder.create` — codec open + hwaccel binding. */
  readonly decoderCreateMs: number
  /** Decoder created → the FIRST frame out of `decoder.frames()`. */
  readonly firstDecodeMs: number
  /** Whether the redundant `avformat_find_stream_info` probe ran. */
  readonly streamInfoProbed: boolean
}

/**
 * What one session's PRE-ROLL catch-up burst actually did.
 *
 * Sent once, when the burst ends — by budget, by reaching the live edge, or by
 * the session tearing down first. The parent turns it into the operator-facing
 * line, because only the parent knows the camera. Every field is a COUNT of
 * work, including the work thrown away: a burst that inferred 12 of 48 offered
 * frames and one that inferred 12 of 12 are different situations and used to
 * be indistinguishable, which is the whole reason the miss this fixes took a
 * frame-by-frame re-run of the recording to find.
 */
export interface WorkerPreRollReport {
  readonly offered: number
  readonly inferred: number
  readonly dropped: number
  /** Drops keyed by reason (`stride`, `budget-frames`, `budget-wall-ms`, `live-edge`). */
  readonly droppedByReason: Readonly<Record<string, number>>
  /** Media-time gap the burst sampled the window at. */
  readonly strideMs: number
  /** True when the stride was widened past the session cadence to fit the budget. */
  readonly subsampled: boolean
  /** Media the burst spanned, in ms — what the window was actually worth. */
  readonly spanMs: number
  /**
   * Frames the burst was allowed to send to inference — the operator's
   * `preRollInferenceFrames`, capped at `holdFrames - 1` (D652).
   */
  readonly budgetFrames: number
}

/** Why a delivered pre-roll frame could no longer be read (D652). */
export type PreRollLossReason = 'evicted' | 'cleared' | 'download-failed' | 'miss'

/**
 * What became of the pre-roll frames a burst DELIVERED, sent once they have
 * all settled — after the burst's own report, which goes out at burst end —
 * or, on teardown, with whatever is still `unsettled` (D652).
 *
 * `lostByReason` is the loss the report line could not see: a history frame
 * the runner admitted and inference never read — the hold evicted it
 * (`evicted`), a re-dial cleared the hold (`cleared`), its native download
 * failed (`download-failed`), or the read found it gone (`miss`).
 */
export interface WorkerPreRollSettled {
  readonly read: number
  readonly released: number
  readonly lostByReason: Readonly<Record<PreRollLossReason, number>>
  readonly unsettled: number
}

/** {@link WorkerPreRollSettled} as it travels on the wire. */
export interface WorkerPreRollSettledReply extends WorkerPreRollSettled {
  readonly kind: 'preRollSettled'
}

/** {@link WorkerPreRollReport} as it travels on the wire. */
export interface WorkerPreRollReportReply extends WorkerPreRollReport {
  readonly kind: 'preRollReport'
}

/** {@link WorkerDialTiming} as it travels on the wire. */
export interface WorkerDialTimingReply extends WorkerDialTiming {
  readonly kind: 'dialTiming'
}

/** A crop region, as validated on the wire. */
export type WorkerCropRegion = NonNullable<FrameImageOptions['crop']>

/** A resize target, as validated on the wire. */
export type WorkerResizeTarget = NonNullable<FrameImageOptions['resize']>

/** Messages the coordinator (parent) sends to the decode-worker (child). */
export type WorkerRequest =
  | {
      readonly kind: 'start'
      readonly source: VideoFrameSource
      readonly opts: VideoFrameGenOptions
      /**
       * The native-lease knobs in force for THIS session, resolved by the
       * parent (`native-lease-config.ts`) and frozen here. REQUIRED: a start
       * that names no knobs would be a default acting without a decision, and
       * the worker cannot resolve them itself without the schemas that made it
       * 3× slower to boot (D453). The worker builds its hold, tile and scene
       * stores from these at `start`, before the first packet — so a
       * pre-forked worker is bound to no configuration until it is handed one.
       */
      readonly lease: WorkerLeaseKnobs
      /**
       * The hwaccel backends this node's resolver OFFERS for decode (D926), or
       * `null` when it has not answered — the worker then uses its platform
       * order. REQUIRED, like `lease`: a node whose libva cannot initialise
       * the driver offers no vaapi/qsv, and the worker must not try them.
       */
      readonly hwaccel: SessionHwaccelOffer
    }
  | { readonly kind: 'pull' }
  | { readonly kind: 'toBuffer'; readonly frameId: number; readonly opts?: FrameImageOptions }
  | {
      /**
       * Best-effort NATIVE-RESOLUTION crop of a still-retained frame. Unlike
       * `toBuffer` (the detection downscale), this GPU-crops (or CPU-crops) ONLY
       * the `bbox` region out of the retained NATIVE surface and downloads just
       * that crop — no full-frame download. Correlated by `requestId` (many
       * crops per frame, e.g. several faces). A miss (frame aged out of the
       * retention ring) replies `nativeCropMiss`.
       */
      readonly kind: 'nativeCrop'
      readonly requestId: number
      readonly frameId: number
      readonly bbox: NormalizedBbox
      /** Optional cap on the output crop width (aspect-preserved). Absent → true native. */
      readonly maxWidth?: number
    }
  | {
      /**
       * The runner has this frame's `FrameResult`: cut ONE native subject tile
       * per box, retain them compressed, and END THE HOLD on `frameId`.
       *
       * This is the moment the whole two-tier design turns on — the last
       * instant native pixels for this frame exist. What survives is a handful
       * of subject-sized JPEGs (~60-120 KB each at 4K) instead of a ~24.9 MB
       * raster, so the retention window can be tens of seconds rather than one
       * that the measured 2.2-9.9 s ask age outran.
       *
       * Each `bbox` is the DETECTION's box, normalised. The worker pads it into
       * a CONTAINER (`native-tile-geometry.ts`) — never a model-input crop:
       * that rectangle is still derived once, by the runner, and cut out of the
       * tile later ([D52](../../../../docs/decisions/adr-0052.md)).
       *
       * Fire-and-forget, no reply: it must never be able to delay the runner,
       * and a lost message costs only the tiles (the crop then misses exactly
       * as it does today). An empty `bboxes` still ends the hold — a frame on
       * which nothing was detected has nothing worth keeping.
       */
      readonly kind: 'cutTiles'
      readonly frameId: number
      readonly bboxes: readonly NormalizedBbox[]
    }
  | {
      /**
       * Prompt release of the RAM native-frame hold for `frameId` — the caller
       * (detection-pipeline, via the runner's native-crop registry) is done with
       * this frame's crops. Best-effort with no reply: the hold is also bounded
       * by a frame count, so a dropped release only defers reclaim, never leaks.
       */
      readonly kind: 'releaseNativeLease'
      readonly frameId: number
    }
  | {
      /**
       * The runner ADMITTED this frame to its detection queue — it will reach
       * inference, so its id can later ride an inference result and be named by
       * a native-crop request. Payload-free apart from the id, fire-and-forget,
       * no reply.
       *
       * Ordering is the contract: the mark must reach the worker before the
       * NEXT `pull`, because that pull's `FrameSlot.reserveSlot()` is what
       * decides this frame's lease admission. The consumer sends it from the
       * same synchronous turn that receives the frame, so IPC order usually
       * guarantees it. A mark that still loses the race parks for one
       * supersede (`PendingMarkHold`) rather than freeing — the reserved-slot
       * margin only covers the newest id. See `lease-admission-ledger.ts`.
       */
      readonly kind: 'markInferred'
      readonly frameId: number
    }
  | {
      /**
       * Stop DECODING, but keep every frame already handed out (D652).
       *
       * The decode loop ends and never re-dials, the demuxer (the network
       * input) is closed, and the one undelivered slot frame is freed. What a
       * READ needs stays: the reserved frame, the hold, the tile stores and the
       * decoder whose GPU pool those surfaces belong to — so `toBuffer`,
       * `nativeCrop` and `cutTiles` on frames the parent already has keep
       * working. A later `pull` answers `ended`. The parent follows up with
       * `stop` + `kill()` once the frames it yielded are closed and every
       * `toBuffer` / `nativeCrop` it already SENT is answered, or its drain
       * bound expires — this message never ends the process by itself.
       */
      readonly kind: 'drain'
    }
  | { readonly kind: 'stop' }

/** Messages the decode-worker (child) sends back to the coordinator (parent). */
export type WorkerReply =
  | {
      readonly kind: 'frame'
      readonly frameId: number
      readonly timestamp: number
      readonly width: number
      readonly height: number
      readonly format: WorkerFrameFormat
      /**
       * Wall clock at which the frame was SHOT. Present once the worker has a
       * media clock (`media-clock.ts`); absent on a worker that predates it, in
       * which case the parent falls back to its own `Date.now()` exactly as
       * before.
       */
      readonly capturedAt?: number
      /** True for a frame replayed out of the session's retained history. */
      readonly preRoll?: boolean
    }
  | { readonly kind: 'buffer'; readonly frameId: number; readonly bytes: Uint8Array }
  | {
      readonly kind: 'nativeCropResult'
      readonly requestId: number
      readonly bytes: Uint8Array
      /** Actual pixel dimensions of the returned rgb crop. */
      readonly width: number
      readonly height: number
      /** Optional: lease vs subject-tile. Absent on pre-source workers. */
      readonly source?: 'lease' | 'tile'
    }
  | {
      readonly kind: 'nativeCropMiss'
      readonly requestId: number
      /**
       * Why the crop missed — a THROWN worker error (crop/scale failure) or the
       * frame being absent (lease/ring evicted). Optional (a pre-reason worker
       * omits it). Surfaced by the coordinator so a subject-ROI-vs-full-frame
       * asymmetry is finally attributable in `addons.getLogs`, not buried in the
       * worker's inherited raw stderr.
       */
      readonly reason?: string
    }
  | { readonly kind: 'ended' }
  | { readonly kind: 'error'; readonly message: string; readonly frameId?: number }
  /**
   * Sent ONCE, unsolicited, when the worker has booted and tried to load its
   * native modules (node-av) — before any `start`. `warm` says whether that
   * load succeeded; a worker that could not is still usable (the `start` path
   * retries the import and reports the failure the way it always did), it just
   * pays the load then. The zygote pool (`decode-worker-pool.ts`) reads it to
   * tell a warm worker from one still booting; the coordinator ignores it.
   */
  | { readonly kind: 'ready'; readonly warm: boolean }
  /**
   * The cold-start split for the dial that produced this session's first
   * decoded frame. Sent exactly once, and sent BEFORE that frame's `frame`
   * reply — IPC order is what lets the pump attach it to the first-frame line
   * without a second round-trip or a waiter.
   */
  | WorkerDialTimingReply
  /**
   * The catch-up burst's own accounting, sent once when the burst ends. See
   * {@link WorkerPreRollReport}.
   */
  | WorkerPreRollReportReply
  /** The burst's frames, once settled. See {@link WorkerPreRollSettled}. */
  | WorkerPreRollSettledReply
  | {
      /**
       * A diagnostic line the worker forwards to the coordinator so it lands in
       * the runner's scoped logger (→ `addons.getLogs`) instead of ONLY the
       * inherited raw stderr, which `addons.getLogs` does not capture. Mirrors
       * every `emitStderr` line; the coordinator maps `level` onto its logger.
       */
      readonly kind: 'log'
      readonly level: WorkerLogLevel
      readonly message: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isWorkerFrameFormat(value: unknown): value is WorkerFrameFormat {
  return value === 'rgb' || value === 'gray'
}

function isWorkerBufferFormat(value: unknown): value is NonNullable<FrameImageOptions['format']> {
  return isWorkerFrameFormat(value) || value === 'jpeg'
}

function isWorkerLogLevel(value: unknown): value is WorkerLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

function isWorkerCropRegion(value: unknown): value is WorkerCropRegion {
  return (
    isRecord(value) &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  )
}

function isWorkerResizeTarget(value: unknown): value is WorkerResizeTarget {
  return isRecord(value) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
}

function isFrameImageOptions(value: unknown): value is FrameImageOptions {
  if (!isRecord(value)) return false
  if (value.crop !== undefined && !isWorkerCropRegion(value.crop)) return false
  if (value.resize !== undefined && !isWorkerResizeTarget(value.resize)) return false
  if (value.format !== undefined && !isWorkerBufferFormat(value.format)) return false
  return true
}

function isNormalizedBbox(value: unknown): value is NormalizedBbox {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.w) &&
    isFiniteNumber(value.h)
  )
}

function isVideoFrameSource(value: unknown): value is VideoFrameSource {
  return (
    isRecord(value) &&
    typeof value.restreamUrl === 'string' &&
    isFiniteNumber(value.deviceId) &&
    typeof value.codec === 'string'
  )
}

function isVideoFrameGenOptions(value: unknown): value is VideoFrameGenOptions {
  if (!isRecord(value)) return false
  if (value.fps !== undefined && !isFiniteNumber(value.fps)) return false
  if (value.format !== undefined && !isWorkerFrameFormat(value.format)) return false
  if (value.preRollMs !== undefined && !isFiniteNumber(value.preRollMs)) return false
  if (value.preRollMaxFrames !== undefined && !isFiniteNumber(value.preRollMaxFrames)) return false
  return true
}

/** Discriminated-union guard for {@link WorkerRequest} — no `as` casts. */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'start':
      return (
        isVideoFrameSource(value.source) &&
        isVideoFrameGenOptions(value.opts) &&
        isWorkerLeaseKnobs(value.lease) &&
        isSessionHwaccelOffer(value.hwaccel)
      )
    case 'pull':
      return true
    case 'toBuffer':
      return (
        isFiniteNumber(value.frameId) &&
        (value.opts === undefined || isFrameImageOptions(value.opts))
      )
    case 'nativeCrop':
      return (
        isFiniteNumber(value.requestId) &&
        isFiniteNumber(value.frameId) &&
        isNormalizedBbox(value.bbox) &&
        (value.maxWidth === undefined || isFiniteNumber(value.maxWidth))
      )
    case 'cutTiles':
      return (
        isFiniteNumber(value.frameId) &&
        Array.isArray(value.bboxes) &&
        value.bboxes.every(isNormalizedBbox)
      )
    case 'releaseNativeLease':
    case 'markInferred':
      return isFiniteNumber(value.frameId)
    case 'drain':
    case 'stop':
      return true
    default:
      return false
  }
}

/** Discriminated-union guard for {@link WorkerReply} — no `as` casts. */
export function isWorkerReply(value: unknown): value is WorkerReply {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'frame':
      return (
        isFiniteNumber(value.frameId) &&
        isFiniteNumber(value.timestamp) &&
        isFiniteNumber(value.width) &&
        isFiniteNumber(value.height) &&
        isWorkerFrameFormat(value.format) &&
        (value.capturedAt === undefined || isFiniteNumber(value.capturedAt)) &&
        (value.preRoll === undefined || typeof value.preRoll === 'boolean')
      )
    case 'buffer':
      return isFiniteNumber(value.frameId) && value.bytes instanceof Uint8Array
    case 'nativeCropResult':
      return (
        isFiniteNumber(value.requestId) &&
        value.bytes instanceof Uint8Array &&
        isFiniteNumber(value.width) &&
        isFiniteNumber(value.height) &&
        (value.source === undefined || value.source === 'lease' || value.source === 'tile')
      )
    case 'nativeCropMiss':
      return (
        isFiniteNumber(value.requestId) &&
        (value.reason === undefined || typeof value.reason === 'string')
      )
    case 'ended':
      return true
    case 'ready':
      return typeof value.warm === 'boolean'
    case 'error':
      return (
        typeof value.message === 'string' &&
        (value.frameId === undefined || isFiniteNumber(value.frameId))
      )
    case 'log':
      return isWorkerLogLevel(value.level) && typeof value.message === 'string'
    case 'preRollReport':
      return (
        isFiniteNumber(value.offered) &&
        isFiniteNumber(value.inferred) &&
        isFiniteNumber(value.dropped) &&
        isRecord(value.droppedByReason) &&
        isFiniteNumber(value.strideMs) &&
        typeof value.subsampled === 'boolean' &&
        isFiniteNumber(value.spanMs) &&
        isFiniteNumber(value.budgetFrames)
      )
    case 'preRollSettled':
      return (
        isFiniteNumber(value.read) &&
        isFiniteNumber(value.released) &&
        isFiniteNumber(value.unsettled) &&
        isRecord(value.lostByReason) &&
        isFiniteNumber(value.lostByReason['evicted']) &&
        isFiniteNumber(value.lostByReason['cleared']) &&
        isFiniteNumber(value.lostByReason['download-failed']) &&
        isFiniteNumber(value.lostByReason['miss'])
      )
    case 'dialTiming':
      return (
        isFiniteNumber(value.hwContextMs) &&
        isFiniteNumber(value.demuxerOpenMs) &&
        isFiniteNumber(value.decoderCreateMs) &&
        isFiniteNumber(value.firstDecodeMs) &&
        typeof value.streamInfoProbed === 'boolean'
      )
    default:
      return false
  }
}
