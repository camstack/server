/**
 * Session-decode COORDINATOR — Epic C P1, Task 3.
 *
 * Runs in the pipeline-runner process. Forks a decode-worker child per
 * detection session (`decode-worker-child.ts`, Task 2's child entry point)
 * and adapts its request/response IPC protocol (Task 2's `WorkerRequest` /
 * `WorkerReply`, `worker-protocol.ts`) into a pull-driven `VideoFrameGenerator`
 * (Task 1, `video-frame-generator.ts`).
 *
 * The fork itself is dependency-injected (`deps.fork`) — this file never
 * calls `child_process.fork` and never touches `process.*` directly. Task 4
 * supplies the real fork implementation; the sanctioned-raw-IPC carve-out
 * documented in `decode-worker-child.ts` applies to that child entry point,
 * not to this file, which only speaks the typed `ForkedChildLike` contract.
 *
 * On teardown (`it.return()`, an uncaught error inside the loop, or the
 * generator running to completion) the coordinator sends `stop`, calls
 * `kill()`, and arms a 1s `SIGKILL` fallback in case the child ignores the
 * first signal — a kill-then-force-kill pattern, since the whole point of
 * a disposable
 * per-session worker (Task 0) is that the OS reclaims the VAAPI/GPU decode
 * pool on process EXIT, which never happens if the child lingers.
 *
 * **A planned teardown DRAINS first (D652).** Every frame this generator
 * yields is a zero-copy reference into the child: its pixels exist only while
 * the child does. So when the owner tears the session down while frames it
 * ADMITTED are still queued or in flight, the coordinator sends `drain` (the
 * worker stops decoding but keeps every frame it holds), waits — bounded by
 * {@link SESSION_DECODE_DRAIN_BOUND_MS} — for each yielded image to be closed
 * and each read to be answered, and only then kills. Killing in the same turn
 * as the detach was measured to lose every such frame as `worker exited before
 * toBuffer reply` / `worker already exited`, with zero unexpected worker exits
 * in the same four hours: the runner was destroying its own work. A teardown
 * that must not wait (process shutdown, a crashed session) says
 * `'immediate'` and keeps the kill-now path.
 */

import type { IScopedLogger } from '@camstack/types'
import type { WorkerLeaseKnobs } from './native-lease-knobs.js'
import type { SessionHwaccelOffer } from './session-hwaccel.js'
import type {
  FrameImage,
  FrameImageOptions,
  NativeCropAttempt,
  NormalizedBbox,
  VideoFrame,
  VideoFrameGenerator,
  VideoFrameGenOptions,
  VideoFrameSource,
} from './video-frame-generator.js'
import {
  isWorkerReply,
  type WorkerDialTiming,
  type WorkerPreRollReport,
  type WorkerPreRollSettled,
  type WorkerReply,
  type WorkerRequest,
} from './worker-protocol.js'

/** How long to wait after `kill()` before escalating to `kill('SIGKILL')`. */
const SIGKILL_FALLBACK_MS = 1000

/**
 * The longest a planned teardown keeps a session's worker alive so the frames
 * it already handed out can be read (D652).
 *
 * What is being waited for is the REST of a frame's trip through the runner —
 * semaphore wait + inference + result — for frames that were admitted before
 * the detach. Measured on the live hub 2026-09-26 over one hour of
 * `pipeline stats` (2 254 per-camera 10 s windows): the WORST enqueue→emit in a
 * window was ≤1 000 ms in 96.7% of windows and ≤1 500 ms in 98.0%; going to
 * 5 000 ms buys only another 0.9%, and that tail is the inference-pool GPU hang,
 * which no wait here can rescue. The cost of waiting is one idle worker (its
 * decode already stopped by `drain`) for at most this long, per detach.
 *
 * A frame still held when this expires is not dropped silently: the
 * coordinator logs the count, tagged with the camera, and then kills.
 */
export const SESSION_DECODE_DRAIN_BOUND_MS = 1_500

/**
 * The miss reason for a native crop requested after its session's teardown.
 * Only crops already SENT when the drain began are waited for (D652); a later
 * one would ask a worker that is about to be killed.
 */
export const NATIVE_CROP_REFUSED_DRAINING = 'session draining — crop requested after teardown'

/**
 * The refusal for a `toBuffer` asked for once the worker has been told to exit
 * (D656). A read during a DRAIN is served — that is what the drain is for — but
 * after the kill no reply can come, and a raw rejection read as a worker fault.
 */
export const TO_BUFFER_REFUSED_KILLED =
  'session killed — read requested after the worker was told to exit'

/** The refusal for a `toBuffer` the worker is no longer there to answer. */
export const TO_BUFFER_REFUSED_EXITED = 'worker already exited'

export type SessionDecodeReadRefusal =
  | typeof TO_BUFFER_REFUSED_KILLED
  | typeof TO_BUFFER_REFUSED_EXITED

/** A read the session declined to send, by name — never a worker fault. */
export class SessionDecodeReadRefusedError extends Error {
  constructor(
    readonly reason: SessionDecodeReadRefusal,
    readonly frameId: number,
  ) {
    super(`session-decode-coordinator: ${reason} (frameId=${frameId})`)
    this.name = 'SessionDecodeReadRefusedError'
  }
}

/**
 * How a session's worker is torn down.
 *
 * - `'drain'` — the ORDINARY teardown (detach, session close, occupancy burst
 *   done): stop decoding, let the frames already handed out be read, then kill,
 *   bounded by {@link SESSION_DECODE_DRAIN_BOUND_MS}.
 * - `'immediate'` — kill now. For a teardown with nobody left to read the
 *   frames or no time to wait for them: the addon shutting down (the runner
 *   has already stopped dispatching) and a session whose worker reported a
 *   fatal error.
 */
export type SessionTeardownMode = 'drain' | 'immediate'

/**
 * The teardown handle a session hands its owner. `mode` defaults to
 * `'drain'`: every caller that does not say otherwise is an ordinary teardown,
 * and only the two cases named on {@link SessionTeardownMode} may skip it.
 */
export type SessionDecodeTeardown = (mode?: SessionTeardownMode) => void

/**
 * How often the cold-start wait REPORTS that it is still waiting. Task 0
 * live-measured cold-start (restream dial + hwaccel context + keyframe wait) at
 * 5-8s, so this must tolerate a slow-but-healthy start.
 *
 * It is no longer the point at which the session is abandoned — see
 * {@link DEFAULT_FIRST_FRAME_MAX_WAIT_MS}.
 */
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 20_000

/**
 * Hard ceiling on the TOTAL wait for the FIRST frame of a dial.
 *
 * The first decodable frame is not a fixed cost: it is one IDR interval plus
 * every GOP the decoder has to discard. Measured on device 108 (2560x1440
 * h264, `Invalid NAL unit` / `corrupt decoded frame` in its bitstream), dial →
 * first decoded frame over the broker's own muted restream was 1.8 / 6.5 / 7.0
 * / 7.2 / 9.2 / 10.0 / 10.8 / 12.9 / 14.9 / 20.0 / 30.3 / >40 s across 12
 * trials — against a healthy 587's 2.0 s ± 0.02.
 *
 * **The "8.0 s IDR interval" this used to attribute 618's spread to was wrong,
 * and is corrected here rather than deleted** (2026-08-28): a stated number
 * nobody re-derived reads as verification, and this one was used to argue that
 * 618 was an encoder outlier. The fleet runs 100-frame GOPs at 25 fps — a
 * **4 000 ms** IDR interval — and two independent readings of 6 h of live logs
 * agree with the operator rather than with this docblock. First, the join-burst
 * span logged on `restream prime (lat-probe)` is the time since the last IDR,
 * uniform in `[0, IDR]` and censored at `PRIME_MAX_SPAN_MS`: its median is
 * ~1 000 ms on eleven cameras, which is what `uniform[0, 4000]` conditioned on
 * `≤2000` predicts. Second, `detectionIntentServed` over detection dials puts
 * the SERVED fraction at 44-61 % on the bulk of the fleet, i.e. the ~50 %
 * `P(span > 2000)` a 4 000 ms interval implies. 618 measures 51 %, which is the
 * fleet norm. The genuine long-GOP outlier is **637** at 30 % served (⇒ ~6.7 s).
 *
 * So the spread is not this camera's encoder. It is D57's fixed 2 000 ms bound
 * withholding the join burst WHOLE on roughly half of every 4 s-GOP camera's
 * dials — see `join-burst-bound.ts`, which states the arithmetic, and
 * `docs/architecture/load-ledger.md` (2026-08-28) for the measurement.
 *
 * Abandoning at 20 s was therefore not a timeout, it was a coin flip, and the
 * recovery made it worse: ending the session RE-DIALS, which throws the
 * accumulated wait away and re-pays the RTSP setup + probe from zero, and two
 * ends inside 60 s DETACH the camera. That loop cost 108 25.9% of its assigned
 * decode airtime in one day (325 of 1257 ten-second windows delivered nothing).
 *
 * The wait is bounded instead of deadlined: the worker keeps the outstanding
 * `pull` latched, so re-arming costs nothing but the wait, and the ceiling is
 * what stops a genuinely dead input from holding a spawn permit forever.
 */
const DEFAULT_FIRST_FRAME_MAX_WAIT_MS = 45_000

/** Default timeout for every `pull` round-trip AFTER the first frame arrives. */
const DEFAULT_FRAME_TIMEOUT_MS = 10_000

/**
 * The minimal child-process-like handle the coordinator needs. Task 4's real
 * implementation wraps `child_process.fork(childEntry, [], { serialization:
 * 'advanced' })` (see the handoff note at the bottom of this file) — the
 * fake used by this file's own tests implements the same shape without
 * spawning anything.
 */
/** Exit metadata forwarded from the real ChildProcess 'exit' event. */
export interface WorkerExitInfo {
  readonly code: number | null
  readonly signal: string | null
  /**
   * The runner's own shutdown killed it (D666), and said so per camera: not
   * an unexpected death, so it is not warned about a second time.
   */
  readonly killedByRunner?: boolean
}

export interface ForkedChildLike {
  send(msg: WorkerRequest): void
  /** 'message' delivers worker replies; 'exit' delivers a {@link WorkerExitInfo} (or undefined from fakes). */
  on(ev: 'message' | 'exit', cb: (m: unknown) => void): void
  kill(signal?: string): void
}

/** Narrow an 'exit' payload to {@link WorkerExitInfo} (fakes may emit undefined). */
export function toWorkerExitInfo(v: unknown): WorkerExitInfo | undefined {
  const isInfo = (x: unknown): x is WorkerExitInfo =>
    typeof x === 'object' && x !== null && 'code' in x && 'signal' in x
  return isInfo(v) ? v : undefined
}

/**
 * Dependencies for {@link createSessionDecodeCoordinator}. The two timeouts
 * bound the `pull` round-trip so a hung decode (child stops producing frames
 * WITHOUT exiting) cannot stall teardown — and therefore the GPU/VAAPI pool
 * reclaim — indefinitely. Both are optional with sane defaults; override in
 * tests or for a node with different cold-start characteristics.
 */
export interface SessionDecodeCoordinatorDeps {
  /** Forks one decode-worker child per `generateVideoFrames()` call. */
  fork: (source: VideoFrameSource) => ForkedChildLike
  /**
   * The native-lease knobs for the session that is about to start, resolved
   * fresh at each `generateVideoFrames()` call.
   *
   * A FUNCTION, not a value: the knobs are cluster-wide operator settings that
   * can change while this coordinator lives, and reading them per session is
   * what makes a changed setting reach the next session while leaving running
   * ones alone. They travel on `start` because the worker can no longer resolve
   * them itself — doing so needed the Zod schemas, and that chunk cost every
   * fork ~170 ms and ~100 MB of heap (D453).
   */
  lease: () => WorkerLeaseKnobs
  /**
   * The hwaccel backends the node's resolver offers, read per session and sent
   * on `start` (D926). Synchronous for the same reason as `lease`: `start` is
   * sent ahead of the first `pull`; the owner refreshes it on the acquire leg.
   */
  hwaccel: () => SessionHwaccelOffer
  logger: IScopedLogger
  /**
   * Timeout (ms) for the `pull` round-trip preceding the FIRST delivered
   * frame. Defaults to {@link DEFAULT_FIRST_FRAME_TIMEOUT_MS}.
   */
  firstFrameTimeoutMs?: number
  /**
   * Timeout (ms) for every `pull` round-trip AFTER the first frame has been
   * delivered. Defaults to {@link DEFAULT_FRAME_TIMEOUT_MS}.
   */
  frameTimeoutMs?: number
  /**
   * Ceiling (ms) on the TOTAL cold-start wait for the first frame. Defaults to
   * {@link DEFAULT_FIRST_FRAME_MAX_WAIT_MS}.
   */
  firstFrameMaxWaitMs?: number
  /**
   * The worker's cold-start split, forwarded once per session.
   *
   * A callback rather than a waiter because the reply is UNSOLICITED: the
   * worker sends it when it has the numbers, ahead of the `frame` reply for the
   * same frame. Nothing here blocks on it — a worker too old to send it (or a
   * session that never decodes) simply leaves the split absent, and the
   * first-frame line keeps its two original fields.
   */
  onDialTiming?: (timing: WorkerDialTiming) => void
  /**
   * The PRE-ROLL catch-up burst's accounting, delivered once when the burst
   * ends. Same shape of contract as {@link onDialTiming}: unsolicited,
   * settle-free, gates nothing — a worker too old to send it, or a session with
   * no history to spend, simply never calls it, and the owner logs no burst
   * line rather than a line full of zeroes that would read as a burst that ran
   * and found nothing.
   */
  onPreRollReport?: (report: WorkerPreRollReport) => void
  /**
   * How the owner wants the worker torn down, read ONCE when the generator
   * ends. Absent ⇒ `'drain'`. A function because the generator's `finally`
   * runs after the owner's teardown call, and that call is what decides.
   */
  teardownMode?: () => SessionTeardownMode
  /**
   * Called once per `generateVideoFrames()` with the new session's `teardown`.
   * The generator's `finally` is the ordinary way a session ends; this is the
   * out-of-band one: a second teardown saying `'immediate'` while the session
   * is draining escalates to the kill (D652). Absent ⇒ no escalation path.
   */
  onSessionTeardown?: (teardown: (mode: SessionTeardownMode) => void) => void
  /**
   * The pre-roll frames' late accounting — how many were read, let go, or lost
   * after the burst's own report was sent (D652). Unsolicited, settle-free.
   */
  onPreRollSettled?: (summary: WorkerPreRollSettled) => void
  /**
   * The worker PROCESS is gone — called exactly once, from its real `exit`,
   * never from the teardown request. The node's live-worker slot is returned
   * here: a draining worker still holds its decoder, GPU pool and hold, so it
   * must stay counted against the ceiling until it exits (D652).
   */
  onWorkerExit?: () => void
}

/**
 * What a session still holds when a drain line is written, per category
 * (D656): only `consumerFrames`, `pendingReads` and `pendingCrops` hold a
 * drain open; `retainedFrames` die with the worker without being waited for.
 */
interface DrainHeldCounts {
  readonly consumerFrames: number
  readonly retainedFrames: number
  readonly pendingReads: number
  readonly pendingCrops: number
}

/** The per-session callbacks a {@link SessionDecodeSession} forwards to. */
interface SessionHooks {
  readonly onDialTiming?: (timing: WorkerDialTiming) => void
  readonly onPreRollReport?: (report: WorkerPreRollReport) => void
  readonly onPreRollSettled?: (summary: WorkerPreRollSettled) => void
  readonly onWorkerExit?: () => void
}

/** Extracted `frame` branch of {@link WorkerReply} — reused for the pull-outcome union. */
type FrameWorkerReply = Extract<WorkerReply, { kind: 'frame' }>

/**
 * Why a `pull` wait was abandoned. Named on the give-up line so the two are
 * never confused: a cold start that never produced a first frame is a stream
 * acquisition problem (IDR interval / damaged GOP), while a stall after frames
 * were flowing is a hung decode.
 */
type PullGiveUpReason = 'no-first-frame' | 'stalled-after-first-frame'

/** Outcome of one `pull` round-trip: either the next frame, or stream end. */
type PullOutcome =
  | { readonly kind: 'frame'; readonly reply: FrameWorkerReply }
  | { readonly kind: 'ended' }

/** A single outstanding `pull` request awaiting its `frame`/`ended` reply. */
interface PendingPullWaiter {
  resolve(outcome: PullOutcome): void
  reject(err: Error): void
}

/** A single outstanding `toBuffer` request awaiting its `buffer` reply. */
interface PendingToBufferWaiter {
  resolve(bytes: Uint8Array): void
  reject(err: Error): void
}

/**
 * A single outstanding `nativeCrop` request awaiting its result. Best-effort:
 * a miss (or the worker exiting) resolves with `null`, never rejects — the
 * caller falls back to today's detection-frame crop.
 */
interface PendingNativeCropWaiter {
  resolve(attempt: NativeCropAttempt): void
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Per-session mutable state + the message-handling logic that adapts the
 * child's `WorkerReply` stream into resolved/rejected waiter promises. One
 * instance is created per `generateVideoFrames()` call (i.e. per forked
 * child) — never shared across sessions.
 */
class SessionDecodeSession {
  private pendingPull: PendingPullWaiter | null = null
  private readonly pendingToBuffers = new Map<number, PendingToBufferWaiter[]>()
  /** Outstanding `nativeCrop` requests, keyed by the monotonic `requestId`. */
  private readonly pendingNativeCrops = new Map<number, PendingNativeCropWaiter>()
  private nextNativeCropId = 1
  private exited = false
  /** Set by teardown() — the session is ending, whether or not it drains first. */
  private stopRequested = false
  /** Set when `kill()` is sent, so handleExit can tell an intentional stop from a death. */
  private killSent = false
  /**
   * A SIGKILL already went out — an `'immediate'` teardown from the pump
   * (D666) and the generator's later `finally` both escalate; one kill is enough.
   */
  private sigkillSent = false
  /**
   * Images yielded and not yet closed that a CONSUMER still holds — queued,
   * in flight, or being read. Each dies with the worker and somebody was going
   * to read it first. This is what a drain waits on.
   */
  private consumerImages = 0
  /**
   * Images yielded and not yet closed that only a RETENTION holder keeps —
   * parked for a read that may come later (the on-demand JPEG fallback, D656).
   * They die with the worker too, but nobody reads them inside any bound worth
   * holding a worker for, so a drain does NOT wait on them.
   */
  private retainedImages = 0
  /** Armed while a drain waits; its expiry kills with frames still held. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private sigkillTimer: ReturnType<typeof setTimeout> | null = null
  private pullTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private firstFrameReceived = false
  /** `Date.now()` of the FIRST `pull` — the origin of the cold-start ceiling. */
  private firstPullAt = 0

  constructor(
    private readonly child: ForkedChildLike,
    private readonly logger: IScopedLogger,
    private readonly deviceId: number,
    private readonly firstFrameTimeoutMs: number,
    private readonly frameTimeoutMs: number,
    private readonly firstFrameMaxWaitMs: number,
    private readonly hooks: SessionHooks,
  ) {
    this.child.on('message', (m: unknown) => this.handleMessage(m))
    this.child.on('exit', (m: unknown) => this.handleExit(toWorkerExitInfo(m)))
  }

  start(
    source: VideoFrameSource,
    opts: VideoFrameGenOptions,
    lease: WorkerLeaseKnobs,
    hwaccel: SessionHwaccelOffer,
  ): void {
    this.trySend({ kind: 'start', source, opts, lease, hwaccel })
  }

  /**
   * Send `pull` and resolve with the next `frame` or `ended` reply. Arms a
   * bounded liveness timeout for the round-trip: if the child stops
   * producing frames WITHOUT exiting, the timeout settles this pull as
   * `ended` so the caller's async generator resumes, runs its `finally`,
   * and tears the child down — see {@link handlePullTimeout}.
   */
  pullNext(): Promise<PullOutcome> {
    if (this.exited) return Promise.resolve({ kind: 'ended' })
    if (this.firstPullAt === 0) this.firstPullAt = Date.now()
    return new Promise<PullOutcome>((resolve, reject) => {
      this.pendingPull = { resolve, reject }
      this.armPullTimeout()
      try {
        this.child.send({ kind: 'pull' })
      } catch (err) {
        this.clearPullTimeout()
        this.pendingPull = null
        reject(toError(err))
      }
    })
  }

  /** Send `toBuffer` for `frameId` and resolve with the matching `buffer` reply's bytes. */
  requestBuffer(frameId: number, opts: FrameImageOptions | undefined): Promise<Uint8Array> {
    if (this.exited) {
      return Promise.reject(new SessionDecodeReadRefusedError(TO_BUFFER_REFUSED_EXITED, frameId))
    }
    // Once the kill is sent the worker answers nothing new (D656): refused by
    // name here, never queued for a rejection at exit.
    if (this.killSent) {
      return Promise.reject(new SessionDecodeReadRefusedError(TO_BUFFER_REFUSED_KILLED, frameId))
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: PendingToBufferWaiter = { resolve, reject }
      this.queueToBufferWaiter(frameId, waiter)
      try {
        this.child.send({ kind: 'toBuffer', frameId, opts })
      } catch (err) {
        this.removeToBufferWaiter(frameId, waiter)
        reject(toError(err))
      }
    })
  }

  /**
   * Send `nativeCrop` for `frameId` and resolve with the crop result, or `null`
   * on any miss (frame aged out, worker error, or worker already exited). Never
   * rejects — native crops are strictly best-effort with a free fallback.
   */
  requestNativeCrop(
    frameId: number,
    bbox: NormalizedBbox,
    maxWidth: number | undefined,
  ): Promise<NativeCropAttempt> {
    if (this.exited) return Promise.resolve({ kind: 'miss' })
    // A crop asked for AFTER the teardown is not waited for (D652): only the
    // ones already sent hold the drain open. Refused here, with a name, rather
    // than sent to a worker about to be killed.
    if (this.stopRequested) {
      return Promise.resolve({ kind: 'miss', workerReason: NATIVE_CROP_REFUSED_DRAINING })
    }
    const requestId = this.nextNativeCropId++
    return new Promise<NativeCropAttempt>((resolve) => {
      this.pendingNativeCrops.set(requestId, { resolve })
      try {
        this.child.send({
          kind: 'nativeCrop',
          requestId,
          frameId,
          bbox,
          ...(maxWidth !== undefined ? { maxWidth } : {}),
        })
      } catch {
        this.pendingNativeCrops.delete(requestId)
        resolve({ kind: 'miss' })
        this.settleDrainIfDone()
      }
    })
  }

  /**
   * The runner has this frame's detections: cut one native subject tile per box
   * and END the hold on `frameId`. Fire and forget (no reply) so the encode can
   * never delay the runner; a dropped message costs only the tiles.
   *
   * An EMPTY box list is still sent — it is how a frame that detected nothing
   * releases its hold, and that is the common case.
   */
  cutTiles(frameId: number, bboxes: readonly NormalizedBbox[]): void {
    if (this.exited) return
    this.trySend({ kind: 'cutTiles', frameId, bboxes })
  }

  /**
   * Prompt-release the worker's RAM native-frame hold for `frameId`. Fire and
   * forget (no reply): the hold is also bounded by a frame count, so a dropped
   * release only defers reclaim. No-op once the worker has exited.
   */
  releaseLease(frameId: number): void {
    if (this.exited) return
    this.trySend({ kind: 'releaseNativeLease', frameId })
  }

  /**
   * Tell the worker `frameId` reached inference, so its native lease is worth
   * keeping. Fire and forget, no reply. Ordering matters and is free here: the
   * caller runs in the same turn that consumed the frame, and the pull that
   * decides this frame's admission is issued after that turn returns.
   */
  markInferred(frameId: number): void {
    if (this.exited) return
    this.trySend({ kind: 'markInferred', frameId })
  }

  /** A yielded image the consumer now holds — see {@link consumerImages}. */
  noteImageOpened(): void {
    this.consumerImages += 1
  }

  /**
   * An open image moved between a consumer and a retention-only holder
   * (D656). Losing its last consumer may complete a waiting drain.
   */
  noteImageHolder(pendingConsumer: boolean): void {
    if (pendingConsumer) {
      this.retainedImages = Math.max(0, this.retainedImages - 1)
      this.consumerImages += 1
      return
    }
    this.consumerImages = Math.max(0, this.consumerImages - 1)
    this.retainedImages += 1
    this.settleDrainIfDone()
  }

  /** A yielded image was closed; a waiting drain may now be done. */
  noteImageClosed(pendingConsumer: boolean): void {
    if (pendingConsumer) this.consumerImages = Math.max(0, this.consumerImages - 1)
    else this.retainedImages = Math.max(0, this.retainedImages - 1)
    this.settleDrainIfDone()
  }

  /**
   * End the session.
   *
   * `'drain'` with frames still held: tell the worker to stop decoding (it
   * keeps every frame it holds), and kill only once every yielded image has
   * been closed and every read answered — or when
   * {@link SESSION_DECODE_DRAIN_BOUND_MS} expires, which is logged. Nothing
   * held: `stop` + SIGTERM now. `'immediate'`: SIGKILL now.
   *
   * A SECOND call that says `'immediate'` while a drain is in progress
   * ESCALATES (D652): addon shutdown lands on sessions already draining from
   * a detach, and the runner exits right after — a drain it does not wait for
   * is an orphaned worker holding its GPU pool. Any other repeat is ignored.
   */
  teardown(mode: SessionTeardownMode): void {
    if (this.stopRequested) {
      if (mode === 'immediate') this.escalateToImmediate()
      return
    }
    this.stopRequested = true
    this.clearPullTimeout()
    if (this.exited) return
    if (mode === 'drain' && this.unsettledCount() > 0) {
      this.trySend({ kind: 'drain' })
      this.drainTimer = setTimeout(
        () => this.handleDrainBoundExpired(),
        SESSION_DECODE_DRAIN_BOUND_MS,
      )
      this.drainTimer.unref?.()
      return
    }
    this.killNow(mode)
  }

  /** The drain (or a SIGTERM still waiting on its fallback) gives way to SIGKILL now. */
  private escalateToImmediate(): void {
    if (this.exited || this.sigkillSent) return
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    if (!this.killSent) {
      this.killNow('immediate')
      return
    }
    if (this.sigkillTimer !== null) {
      clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.tryKill('SIGKILL')
  }

  /**
   * Frames a CONSUMER still holds, reads still waiting on the worker, and
   * native crops already REQUESTED. A crop asked for before the teardown
   * request is waited for; one asked for after it is refused by name — post-analysis's
   * ordinary crop arrives 2.2–9.9 s after the frame, past any bound worth
   * holding a worker for, and is served from subject tiles that die with the
   * worker either way.
   *
   * A frame only PARKED for such a late read ({@link retainedImages}) is not
   * counted, for the same reason (D656): counting it made nearly every
   * teardown wait the full bound for frames nobody was going to read. Its read,
   * once STARTED, is a pending read like any other and is waited for.
   */
  private unsettledCount(): number {
    return this.consumerImages + this.pendingReadCount() + this.pendingNativeCrops.size
  }

  /** What the session still holds, per category — every drain line carries it. */
  private heldCounts(): DrainHeldCounts {
    return {
      consumerFrames: this.consumerImages,
      retainedFrames: this.retainedImages,
      pendingReads: this.pendingReadCount(),
      pendingCrops: this.pendingNativeCrops.size,
    }
  }

  private pendingReadCount(): number {
    let n = 0
    for (const waiters of this.pendingToBuffers.values()) n += waiters.length
    return n
  }

  private settleDrainIfDone(): void {
    if (this.drainTimer === null || this.unsettledCount() > 0) return
    clearTimeout(this.drainTimer)
    this.drainTimer = null
    this.killNow('drain')
  }

  /**
   * The drain ran out of time with frames still held. Those frames die with
   * the worker; that is a branch that DROPS work (D391), so it says how many,
   * on which camera.
   */
  private handleDrainBoundExpired(): void {
    this.drainTimer = null
    if (this.exited) return
    this.logger.warn(
      'session-decode-coordinator: drain bound expired — killing the worker with frames still held',
      {
        tags: { deviceId: this.deviceId },
        meta: { ...this.heldCounts(), boundMs: SESSION_DECODE_DRAIN_BOUND_MS },
      },
    )
    this.killNow('drain')
  }

  /**
   * `stop`, then the kill — unless already exited.
   *
   * `'drain'`: SIGTERM, so the child flushes its last lines (`bounded-exit.ts`),
   * and a SIGKILL fallback. `'immediate'`: SIGKILL outright. Since D652 gave the
   * child a SIGTERM handler, SIGTERM is no longer instant death: a worker
   * blocked in a native call (a VAAPI hang) never runs the handler, and the
   * fallback was an `unref`'d timer the exiting parent did not wait for — so
   * on shutdown that worker was orphaned with its GPU pool. The fallback timer
   * is now ref'd: it exists only for a drain while the parent is alive (a
   * shutdown escalates to SIGKILL and clears it), and a timer that keeps the
   * process up for at most one second is the price of a kill that lands.
   */
  private killNow(mode: SessionTeardownMode): void {
    if (this.killSent) return
    this.killSent = true
    // Frames only PARKED for a late crop die here without having been waited
    // for (D656). Routine on every teardown after a detection, so debug — the
    // late request that finds them gone is counted as an on-demand miss.
    if (this.retainedImages > 0) {
      this.logger.debug('session-decode-coordinator: retained frames die with the worker', {
        tags: { deviceId: this.deviceId },
        meta: { mode, ...this.heldCounts() },
      })
    }
    this.trySend({ kind: 'stop' })
    if (mode === 'immediate') {
      this.tryKill('SIGKILL')
      return
    }
    this.tryKill(undefined)
    if (this.exited) return
    this.sigkillTimer = setTimeout(() => {
      this.sigkillTimer = null
      if (this.exited) return
      this.logger.warn(
        'session-decode-coordinator: child did not exit within SIGKILL fallback window — forcing',
        { tags: { deviceId: this.deviceId }, meta: { fallbackMs: SIGKILL_FALLBACK_MS } },
      )
      this.tryKill('SIGKILL')
    }, SIGKILL_FALLBACK_MS)
  }

  private handleMessage(raw: unknown): void {
    if (!isWorkerReply(raw)) {
      this.logger.warn('session-decode-coordinator: dropping malformed worker reply', {
        meta: { raw },
      })
      return
    }
    switch (raw.kind) {
      case 'frame':
        this.settlePendingPull({ kind: 'frame', reply: raw })
        return
      case 'ended':
        this.settlePendingPull({ kind: 'ended' })
        return
      case 'buffer':
        this.settleToBuffer(raw.frameId, raw.bytes)
        return
      case 'nativeCropResult':
        this.settleNativeCrop(raw.requestId, {
          kind: 'crop',
          crop: {
            bytes: raw.bytes,
            width: raw.width,
            height: raw.height,
            ...(raw.source ? { source: raw.source } : {}),
          },
        })
        return
      case 'nativeCropMiss':
        if (raw.reason !== undefined) {
          // Surface WHY a native crop missed (worker-thrown crop failure vs an
          // evicted frame) so a subject-ROI-vs-full-frame asymmetry is finally
          // visible in `addons.getLogs`. Debug-level: a cold-gate miss is
          // routine; the worker itself re-logs a THROWN failure at `warn` via a
          // `log` reply.
          this.logger.debug('session-decode: native crop miss', {
            meta: { requestId: raw.requestId, reason: raw.reason },
          })
        }
        // The reason travels WITH the miss now, not only into the debug line
        // above: a `deviceId`-tagged per-camera query used to return misses and
        // no reasons at all, because this string never left the coordinator.
        this.settleNativeCrop(raw.requestId, {
          kind: 'miss',
          ...(raw.reason !== undefined ? { workerReason: raw.reason } : {}),
        })
        return
      case 'ready':
        // The worker booted and tried its native preload. Nothing here waits on
        // it: a session sends `start` immediately and the child handles a start
        // that lands mid-preload by sharing the in-flight import. It exists for
        // a pool that hands out only warm workers — see D453 for why no such
        // pool is built, and why the reply is kept anyway (it is the one signal
        // that would make one buildable without changing the child again).
        return
      case 'error':
        this.settleError(raw.message, raw.frameId)
        return
      case 'log':
        // A worker diagnostic forwarded so it lands in the scoped logger (→
        // `addons.getLogs`) rather than ONLY the inherited raw stderr. The
        // worker already classified the severity.
        this.logger[raw.level](raw.message)
        return
      case 'dialTiming':
        // Unsolicited and settle-free: it resolves no waiter and gates no pull,
        // so a dropped or absent split can never stall a session.
        this.hooks.onDialTiming?.({
          hwContextMs: raw.hwContextMs,
          demuxerOpenMs: raw.demuxerOpenMs,
          decoderCreateMs: raw.decoderCreateMs,
          firstDecodeMs: raw.firstDecodeMs,
          streamInfoProbed: raw.streamInfoProbed,
        })
        return
      case 'preRollSettled':
        this.hooks.onPreRollSettled?.({
          read: raw.read,
          released: raw.released,
          lostByReason: raw.lostByReason,
          unsettled: raw.unsettled,
        })
        return
      case 'preRollReport':
        // Unsolicited and settle-free, exactly like `dialTiming`: the burst is
        // already over by the time this arrives, so nothing waits on it and a
        // dropped report costs a log line, never a frame.
        this.hooks.onPreRollReport?.({
          offered: raw.offered,
          inferred: raw.inferred,
          dropped: raw.dropped,
          droppedByReason: raw.droppedByReason,
          strideMs: raw.strideMs,
          subsampled: raw.subsampled,
          spanMs: raw.spanMs,
          budgetFrames: raw.budgetFrames,
        })
        return
    }
  }

  private handleExit(info?: WorkerExitInfo): void {
    // The process is gone: its budget slot goes back NOW, and only now (D652).
    // Once — a fake or a racing signal may deliver `exit` twice.
    if (!this.exited) this.hooks.onWorkerExit?.()
    // A worker death (no teardown asked for it) was previously INVISIBLE: the
    // generator just ended and the session zombied. Surface it loudly — the
    // exit code/signal is the only forensic signal for a silent native crash.
    if (!this.killSent && !this.exited && info?.killedByRunner === true) {
      this.logger.debug('session-decode worker ended by the runner shutdown kill', {
        tags: { deviceId: this.deviceId },
        meta: { code: info.code, signal: info.signal },
      })
    } else if (!this.killSent && !this.exited) {
      // A death during a drain is still a death: the frames the drain was
      // waiting for die with it, and the line says how many.
      this.logger.warn(
        this.stopRequested
          ? 'session-decode worker exited unexpectedly while draining'
          : 'session-decode worker exited unexpectedly',
        {
          tags: { deviceId: this.deviceId },
          meta: {
            code: info?.code ?? null,
            signal: info?.signal ?? null,
            ...(this.stopRequested ? this.heldCounts() : {}),
          },
        },
      )
    }
    this.exited = true
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    if (this.sigkillTimer) {
      clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.clearPullTimeout()
    // Resolve/reject every in-flight waiter so the generator (or a pending
    // toBuffer() caller) never hangs waiting on a reply that can no longer
    // arrive.
    if (this.pendingPull) {
      const waiter = this.pendingPull
      this.pendingPull = null
      waiter.resolve({ kind: 'ended' })
    }
    for (const waiters of this.pendingToBuffers.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error('session-decode-coordinator: worker exited before toBuffer reply'))
      }
    }
    this.pendingToBuffers.clear()
    // Native crops are best-effort: resolve any in-flight crop with `null` (a
    // miss) rather than rejecting, so the caller falls back cleanly.
    for (const waiter of this.pendingNativeCrops.values()) waiter.resolve({ kind: 'miss' })
    this.pendingNativeCrops.clear()
  }

  /** Settle the `nativeCrop` waiter for `requestId` (dropping unknown/stale ids). */
  private settleNativeCrop(requestId: number, attempt: NativeCropAttempt): void {
    const waiter = this.pendingNativeCrops.get(requestId)
    if (!waiter) return
    this.pendingNativeCrops.delete(requestId)
    waiter.resolve(attempt)
    this.settleDrainIfDone()
  }

  private settlePendingPull(outcome: PullOutcome): void {
    const waiter = this.pendingPull
    if (!waiter) {
      this.logger.debug('session-decode-coordinator: dropping unsolicited pull-shaped reply', {
        meta: { outcomeKind: outcome.kind },
      })
      return
    }
    this.pendingPull = null
    this.clearPullTimeout()
    if (outcome.kind === 'frame') this.firstFrameReceived = true
    waiter.resolve(outcome)
  }

  /**
   * Fires when a `pull` round-trip outlives its liveness timeout — the child
   * has not produced a frame and has not exited.
   *
   * BEFORE the first frame this is not yet a failure. The worker latches the
   * outstanding `pull` (`decode-worker-child.handlePull` sets `pendingPull` and
   * delivers on the next decoded frame), so re-arming the timer costs nothing
   * but the wait and the session keeps the dial, the RTSP setup and the probe
   * it has already paid for. Only the {@link firstFrameMaxWaitMs} ceiling ends
   * it — see that constant for the measurement that set it.
   *
   * AFTER the first frame the deadline is unchanged: a steady stream that stops
   * is a hung decode, and ending settles the outstanding pull as `ended` (not a
   * throw) so the consumer's async generator resumes cleanly, runs its
   * `finally`, and tears the child down via {@link teardown}.
   *
   * Every line here carries `tags: { deviceId }` and a `reason`, because
   * "detaching" a camera is the loudest dropped work in this path and an
   * operator has to be able to answer "why did 618 stop" from the logs alone.
   */
  private handlePullTimeout(timeoutMs: number): void {
    this.pullTimeoutTimer = null
    const waiter = this.pendingPull
    if (!waiter) return
    const waitedMs = this.firstPullAt === 0 ? timeoutMs : Date.now() - this.firstPullAt

    if (!this.firstFrameReceived && waitedMs < this.firstFrameMaxWaitMs) {
      this.logger.warn(
        'session-decode-coordinator: still waiting for its first decodable frame — holding the dial',
        {
          tags: { deviceId: this.deviceId },
          meta: {
            waitedMs,
            reportEveryMs: timeoutMs,
            maxWaitMs: this.firstFrameMaxWaitMs,
            // The wait is one IDR interval plus every GOP the decoder discards,
            // so a long-GOP or damaged stream lives HERE, not in a dead dial.
            hint: 'long IDR interval or a discarded GOP looks exactly like this',
          },
        },
      )
      this.armPullTimeout()
      return
    }

    this.pendingPull = null
    const reason: PullGiveUpReason = this.firstFrameReceived
      ? 'stalled-after-first-frame'
      : 'no-first-frame'
    this.logger.warn(
      this.firstFrameReceived
        ? 'session-decode-coordinator: gave up waiting for the next frame — ending session'
        : 'session-decode-coordinator: gave up waiting for the first decodable frame — ending session',
      {
        tags: { deviceId: this.deviceId },
        meta: {
          reason,
          waitedMs,
          timeoutMs,
          ...(this.firstFrameReceived ? {} : { maxWaitMs: this.firstFrameMaxWaitMs }),
        },
      },
    )
    waiter.resolve({ kind: 'ended' })
  }

  /**
   * Arm the next round-trip deadline. Before the first frame the timer is
   * clamped to what is LEFT of the ceiling, so the give-up lands exactly on
   * {@link firstFrameMaxWaitMs} instead of on the next report boundary past it
   * — otherwise a 45 s ceiling reported every 20 s would really give up at 60 s.
   */
  private armPullTimeout(): void {
    const timeoutMs = this.firstFrameReceived
      ? this.frameTimeoutMs
      : Math.max(
          1,
          Math.min(
            this.firstFrameTimeoutMs,
            this.firstFrameMaxWaitMs - (this.firstPullAt === 0 ? 0 : Date.now() - this.firstPullAt),
          ),
        )
    this.pullTimeoutTimer = setTimeout(() => this.handlePullTimeout(timeoutMs), timeoutMs)
    this.pullTimeoutTimer.unref?.()
  }

  private clearPullTimeout(): void {
    if (this.pullTimeoutTimer) {
      clearTimeout(this.pullTimeoutTimer)
      this.pullTimeoutTimer = null
    }
  }

  /**
   * Correlate by `frameId`: a `buffer` reply only ever settles waiters queued
   * under the SAME frameId — a late reply for a stale/superseded frame that
   * nobody is (still) awaiting is dropped, never mistakenly resolves a
   * different, newer frame's waiter.
   */
  private settleToBuffer(frameId: number, bytes: Uint8Array): void {
    const queue = this.pendingToBuffers.get(frameId)
    if (!queue || queue.length === 0) {
      this.logger.debug('session-decode-coordinator: dropping stale/unknown buffer reply', {
        meta: { frameId },
      })
      return
    }
    const waiter = queue.shift()
    if (queue.length === 0) this.pendingToBuffers.delete(frameId)
    waiter?.resolve(bytes)
    this.settleDrainIfDone()
  }

  /**
   * `error` replies MAY carry a `frameId` (a `toBuffer`-scoped miss, e.g. a
   * stale/unknown frameId or a scale failure in `decode-worker-child.ts`) —
   * those fail ONLY that frame's `toBuffer` waiter(s) so the pull stays alive
   * and the generator keeps running (P2/I1: a single dropped frame must not
   * tear the whole session down). An error WITHOUT a `frameId` is a
   * session-level failure (decode-loop crash, dial error) and keeps the
   * original fatal behavior: fail the outstanding `pull` first (the more
   * common source), else fail every outstanding `toBuffer` waiter rather than
   * silently dropping the error and leaving a caller hanging forever.
   */
  private settleError(message: string, frameId?: number): void {
    const err = new Error(`session-decode-coordinator: worker error — ${message}`)
    // A toBuffer-scoped error (carries frameId): fail ONLY that frame's waiter(s);
    // the pull stays alive so the generator keeps running (P2/I1).
    if (frameId !== undefined) {
      const queue = this.pendingToBuffers.get(frameId)
      if (queue && queue.length > 0) {
        for (const waiter of queue) waiter.reject(err)
        this.pendingToBuffers.delete(frameId)
        this.settleDrainIfDone()
        return
      }
      // No waiter for it (already settled/superseded) — drop, do NOT end the session.
      this.logger.debug('session-decode-coordinator: dropping toBuffer error for unknown frameId', {
        meta: { frameId },
      })
      return
    }
    // A session-level error (no frameId): existing fatal behavior.
    if (this.pendingPull) {
      const waiter = this.pendingPull
      this.pendingPull = null
      this.clearPullTimeout()
      waiter.reject(err)
      return
    }
    for (const waiters of this.pendingToBuffers.values()) {
      for (const waiter of waiters) waiter.reject(err)
    }
    this.pendingToBuffers.clear()
    this.settleDrainIfDone()
  }

  private queueToBufferWaiter(frameId: number, waiter: PendingToBufferWaiter): void {
    const queue = this.pendingToBuffers.get(frameId)
    if (queue) queue.push(waiter)
    else this.pendingToBuffers.set(frameId, [waiter])
  }

  private removeToBufferWaiter(frameId: number, waiter: PendingToBufferWaiter): void {
    const queue = this.pendingToBuffers.get(frameId)
    if (!queue) return
    const idx = queue.indexOf(waiter)
    if (idx >= 0) queue.splice(idx, 1)
    if (queue.length === 0) this.pendingToBuffers.delete(frameId)
  }

  private trySend(msg: WorkerRequest): void {
    try {
      this.child.send(msg)
    } catch (err) {
      this.logger.warn('session-decode-coordinator: send to child failed', {
        meta: { requestKind: msg.kind, err: toError(err).message },
      })
    }
  }

  private tryKill(signal: string | undefined): void {
    try {
      this.child.kill(signal)
      // Only once the signal went out: a kill that threw leaves the next
      // escalation free to try again.
      if (signal === 'SIGKILL') this.sigkillSent = true
    } catch (err) {
      this.logger.warn('session-decode-coordinator: kill() on child failed', {
        tags: { deviceId: this.deviceId },
        meta: { signal, err: toError(err).message },
      })
    }
  }
}

/** Build the {@link FrameImage} adapter for one `frame` reply. */
function buildFrameImage(session: SessionDecodeSession, reply: FrameWorkerReply): FrameImage {
  let closed = false
  let pendingConsumer = true
  session.noteImageOpened()
  return {
    width: reply.width,
    height: reply.height,
    format: reply.format,
    frameId: reply.frameId,
    toBuffer: async (opts?: FrameImageOptions): Promise<Uint8Array> => {
      if (closed) {
        throw new Error(
          `session-decode-coordinator: toBuffer() called on a closed frame (frameId=${reply.frameId})`,
        )
      }
      return session.requestBuffer(reply.frameId, opts)
    },
    // Best-effort native crop — intentionally NOT gated on `closed`: it is a
    // distinct, late read (after detection has run) that must outlive the
    // per-frame `toBuffer` close. A miss resolves `null`.
    nativeCrop: (bbox: NormalizedBbox, maxWidth?: number): Promise<NativeCropAttempt> =>
      session.requestNativeCrop(reply.frameId, bbox, maxWidth),
    cutTiles: (bboxes: readonly NormalizedBbox[]): void => session.cutTiles(reply.frameId, bboxes),
    releaseNativeLease: (): void => session.releaseLease(reply.frameId),
    markInferred: (): void => session.markInferred(reply.frameId),
    setPendingConsumer: (pending: boolean): void => {
      if (closed || pending === pendingConsumer) return
      pendingConsumer = pending
      session.noteImageHolder(pending)
    },
    close: (): void => {
      if (closed) return
      closed = true
      session.noteImageClosed(pendingConsumer)
    },
  }
}

/**
 * Create the `VideoFrameGenerator` adapter: forks one decode-worker child per
 * `generateVideoFrames()` call, drives it with `pull`/`toBuffer` requests
 * one at a time (no pre-fetch — back-pressure is the async generator's
 * natural suspend-on-yield), and guarantees the child is torn down
 * (bounded drain, then `stop` + `kill()` + SIGKILL fallback) in every exit
 * path via `finally`.
 */
export function createSessionDecodeCoordinator(
  deps: SessionDecodeCoordinatorDeps,
): VideoFrameGenerator {
  const firstFrameTimeoutMs = deps.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS
  const frameTimeoutMs = deps.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS
  // The ceiling can never be below the report interval — an override that set
  // `firstFrameTimeoutMs` alone would otherwise silently restore the old
  // single-deadline behaviour it was raised to remove.
  const firstFrameMaxWaitMs = Math.max(
    deps.firstFrameMaxWaitMs ?? DEFAULT_FIRST_FRAME_MAX_WAIT_MS,
    firstFrameTimeoutMs,
  )
  return {
    async *generateVideoFrames(
      source: VideoFrameSource,
      opts: VideoFrameGenOptions,
    ): AsyncGenerator<VideoFrame, void> {
      const child = deps.fork(source)
      const session = new SessionDecodeSession(
        child,
        deps.logger,
        source.deviceId,
        firstFrameTimeoutMs,
        frameTimeoutMs,
        firstFrameMaxWaitMs,
        {
          ...(deps.onDialTiming ? { onDialTiming: deps.onDialTiming } : {}),
          ...(deps.onPreRollReport ? { onPreRollReport: deps.onPreRollReport } : {}),
          ...(deps.onPreRollSettled ? { onPreRollSettled: deps.onPreRollSettled } : {}),
          ...(deps.onWorkerExit ? { onWorkerExit: deps.onWorkerExit } : {}),
        },
      )
      session.start(source, opts, deps.lease(), deps.hwaccel())
      deps.onSessionTeardown?.((mode) => session.teardown(mode))
      // A session whose worker reported a fatal error is a crash: nothing it
      // still holds can be served, so it is not drained (D652).
      let failed = false
      try {
        while (true) {
          const outcome = await session.pullNext()
          if (outcome.kind === 'ended') return
          const { reply } = outcome
          yield {
            timestamp: reply.timestamp,
            image: buildFrameImage(session, reply),
            // The frame's OWN moment and whether it is history, carried
            // straight through: this generator must never substitute a clock
            // of its own for one the worker measured (see `media-clock.ts`).
            ...(reply.capturedAt !== undefined ? { capturedAt: reply.capturedAt } : {}),
            ...(reply.preRoll === true ? { preRoll: true } : {}),
          }
        }
      } catch (err) {
        failed = true
        throw err
      } finally {
        session.teardown(failed ? 'immediate' : (deps.teardownMode?.() ?? 'drain'))
      }
    },
  }
}

// Handoff to Task 4 (real fork implementation): the real `fork` MUST call
// `child_process.fork(childEntry, [], { serialization: 'advanced' })`. Plain
// (default 'json') serialization would JSON-stringify the `buffer` reply's
// `Uint8Array` bytes into a base64-ish array-of-numbers, breaking the "raw
// bytes, not base64" contract `worker-protocol.ts`'s `isWorkerReply` guard
// (`value.bytes instanceof Uint8Array`) and this file's zero-copy assumption
// both depend on.
