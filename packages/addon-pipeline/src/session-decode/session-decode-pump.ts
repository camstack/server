/**
 * Session-decode PUMP + gating predicate — Epic C P1, Task 4.
 *
 * The addon-facing adapter between the pull-driven `VideoFrameGenerator`
 * (Task 3's `createSessionDecodeCoordinator`) and the pipeline-runner's
 * per-frame consumers (`enqueueDetectionFrame` / `enqueueMotionFrame`). It
 * turns each pulled {@link VideoFrame} into a {@link DecodedFrame} — the exact
 * shape the existing shm frame-handle poller feeds INLINE (no `FrameHandle`)
 * — and hands it to `onDecodedFrame`.
 *
 * This unit is deliberately free of `ctx.api`: the addon method acquires the
 * restream (needs the broker cap) and injects the resulting
 * {@link VideoFrameSource}, so the pump stays pure and unit-testable with a
 * fake fork.
 */

import type { DecodedFrame, FrameViewSpec, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { resolveFrameViewGeometry } from './frame-view-geometry.js'
import type { LocalFrameRegistry } from './local-frame-registry.js'
import type { WorkerLeaseKnobs } from './native-lease-knobs.js'
import type { SessionHwaccelOffer } from './session-hwaccel.js'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
  type SessionDecodeTeardown,
  type SessionTeardownMode,
} from './session-decode-coordinator.js'
import type {
  NativeCropAttempt,
  NormalizedBbox,
  VideoFrame,
  VideoFrameGenOptions,
  VideoFrameSource,
} from './video-frame-generator.js'
import type {
  WorkerDialTiming,
  WorkerPreRollReport,
  WorkerPreRollSettled,
} from './worker-protocol.js'

/** The pixel format a session-decode worker produces — `'rgb'` (detection) or `'gray'` (motion). */
type SessionFrameFormat = NonNullable<VideoFrameGenOptions['format']>

/**
 * A late, best-effort native-resolution crop of the just-decoded frame, bound
 * to the worker's retained native surface. Handed to `onDecodedFrame` alongside
 * the (downscaled) {@link DecodedFrame} so the runner can register it against
 * the retention handle and serve native crops after detection. Returns `null`
 * on a miss (surface aged out) — callers fall back to the detection-frame crop.
 */
export interface NativeCropRequester {
  /**
   * Best-effort native crop of `bbox` from this frame. Resolves a typed
   * {@link NativeCropAttempt} — the pixels, or a `miss` carrying the worker's
   * own reason, which is the only way the runner's warn can say more than
   * `worker-lease-gone`.
   */
  (bbox: NormalizedBbox, maxWidth?: number): Promise<NativeCropAttempt>
  /**
   * This frame's detections are known: cut one native subject TILE per box and
   * end the hold. Best-effort, never awaited, and an empty list still ends the
   * hold. The tiles are what serves a crop that arrives seconds later, which
   * measurement says is the ordinary case.
   */
  cutTiles(bboxes: readonly NormalizedBbox[]): void
  /**
   * Prompt-release the frame's RAM native hold — the consumer is done cutting
   * crops. Best-effort + idempotent (the hold is also frame-count bounded).
   */
  release(): void
  /**
   * Tell the worker this frame reached INFERENCE — the runner admitted it to
   * the detection queue, so its id can ride an inference result and be named by
   * a later native-crop request. That is the set the worker leases when
   * `nativeLeaseAdmission` is `'inferred'`; an unmarked frame is dropped instead
   * of costing a full native-resolution GPU→RAM download.
   *
   * Must be called from the same synchronous turn that received the frame (the
   * `onDecodedFrame` callback): admission for this frame is decided inside the
   * NEXT pull. Best-effort and idempotent.
   */
  markInferred(): void
}

/**
 * How long this session took to produce its FIRST decoded frame, split at the
 * only boundary the pump owns.
 *
 * There was no success-path timing anywhere in this path: a dial that produced
 * its first frame in 1 s and one that took 8 s logged exactly the same thing —
 * nothing. Only the FAILURE (`session-decode-coordinator`'s still-waiting /
 * gave-up warns) was ever visible, so the blind ramp between motion and the
 * first inferenced frame could only be reconstructed by hand-correlating
 * unrelated lines across processes.
 *
 * The split matters because the two halves have different owners: queuing is
 * the node's spawn gate (raise the cap), while the rest is fork + RTSP dial +
 * the wait for a decodable GOP (a camera/join-policy problem).
 */
export interface FirstFrameTiming {
  /** Time spent queued for a decode-worker spawn permit. `0` when ungated. */
  readonly spawnWaitMs: number
  /** Permit granted (i.e. fork) → first frame off the worker. */
  readonly forkToFrameMs: number
  /**
   * The INSIDE of `forkToFrameMs`, as measured by the worker itself.
   *
   * `forkToFrameMs` said 4 689 ms at the median and could not say where: the
   * hw-device create, the demuxer open, the codec open and the first decode are
   * four serial steps behind one number, and this process can see none of them.
   * Optional because it is a worker report: a session that ends before it ever
   * decodes never sends one, and the fields must be ABSENT rather than zero —
   * a zero here would read as "that step was free".
   */
  readonly dial?: WorkerDialTiming
}

/** Dependencies for {@link startSessionDecodePump}. */
export interface SessionDecodePumpDeps {
  /** Forks one decode-worker child per session (Task 4's real `child_process.fork`). */
  readonly fork: (source: VideoFrameSource) => ForkedChildLike
  /**
   * The native-lease knobs for this session, resolved by the OWNER at the
   * moment the session starts and carried to the worker on `start` (D453).
   * Forwarded untouched — the pump neither reads nor defaults them: a default
   * chosen here would be a configuration nobody decided.
   */
  readonly lease: () => WorkerLeaseKnobs
  /** The hwaccel backends the node's resolver offers (D926), read per session. */
  readonly hwaccel: () => SessionHwaccelOffer
  readonly logger: IScopedLogger
  /** The acquired restream source (URL + deviceId + codec). Injected by the addon. */
  readonly source: VideoFrameSource
  /** Generation options: `fps` (detection/motion) + `format` (`'rgb'` detection, `'gray'` motion). */
  readonly opts: VideoFrameGenOptions
  /**
   * Pixel-free admission hook invoked before `image.toBuffer()`. Returning
   * false closes the lazy frame immediately, avoiding conversion, IPC and any
   * downstream retention work. Omitted means every pulled frame materializes.
   *
   * `preRoll` says whether this frame came out of the session's catch-up burst.
   * The consumer needs it HERE, not only at the sink: the live admission gate
   * paces on wall clock, and a catch-up burst delivers seconds of media inside
   * milliseconds of it, so asking the live gate about a history frame refuses
   * the whole burst before a single pixel is ever materialized.
   */
  readonly shouldMaterializeFrame?: (preRoll: boolean) => boolean
  /** Process-local lazy path. Both fields are required to transfer ownership. */
  readonly frameRegistry?: LocalFrameRegistry
  /**
   * Asked per frame on the ref path: `true` copies this frame's pixels NOW,
   * while it is still the worker's reserved frame, instead of registering a
   * lazy ref the executor would read later. The ref is a promise the worker
   * keeps for `holdFrames` frames; under backpressure (a cold engine, a full
   * queue) the read came ~11 s later and the hold had rolled over — the
   * "unknown or stale frameId" the shm passthrough already avoids the same
   * way (`HANDLE_PASSTHROUGH_MAX_QUEUE_DEPTH`).
   */
  readonly inlineWhen?: () => boolean
  readonly onFrameRef?: (
    frame: DecodedFrame,
    nativeCrop?: NativeCropRequester,
  ) => boolean | Promise<boolean>
  /** Explicit inline compatibility view for split/rollback paths. */
  readonly inlineViewSpec?: FrameViewSpec
  /**
   * Sink for each decoded frame — the runner's `enqueueDetectionFrame` /
   * `enqueueMotionFrame`. The optional second argument is a best-effort
   * native-crop requester bound to this exact frame's retained native surface
   * (present only when the underlying frame source supports it); the runner
   * registers it against the retention handle so post-analysis can cut
   * native-res crops. Absent → no native crops for this frame (fallback only).
   */
  readonly onDecodedFrame: (frame: DecodedFrame, nativeCrop?: NativeCropRequester) => void
  /** Optional cold-start pull timeout override (ms). */
  readonly firstFrameTimeoutMs?: number
  /** Optional steady-state pull timeout override (ms). */
  readonly frameTimeoutMs?: number
  /**
   * Optional per-runner (per-node) SPAWN-CONCURRENCY GATE (P5 first pass). When
   * provided, the pump acquires a permit BEFORE the decode-worker fork and
   * releases it once the worker delivers its FIRST frame (GPU/VAAPI context
   * established) OR on teardown/session-end if no frame ever arrives — so a
   * synchronized multi-camera motion burst forks at most N workers at once
   * instead of stampeding the shared iGPU. Kept ctx-free: the addon injects the
   * real acquire (it owns the {@link Semaphore}). The returned closure releases
   * exactly one permit; the pump guarantees it is called exactly once on every
   * exit path (see {@link startSessionDecodePump}). Absent → no gating (the
   * pre-P5 behavior).
   */
  readonly acquireSpawnSlot?: () => Promise<() => void>
  /**
   * Invoked when the frame loop ends WITHOUT the teardown having been called —
   * i.e. the decode worker died or the generator errored while the session was
   * still wanted. Callers use it to re-dial (bounded) or detach so the camera
   * doesn't zombie with a live attachment and no frames. NOT invoked on an
   * ordinary teardown.
   */
  readonly onEnded?: () => void
  /**
   * Invoked ONCE, when the worker delivers its first frame, with
   * {@link FirstFrameTiming}. Never invoked for a session that ends without
   * ever producing one (that case is already loud — the coordinator's give-up
   * warn). The owner turns it into the operator-facing line, since only the
   * owner knows the camera, the stream and what triggered the dial.
   */
  readonly onFirstFrame?: (timing: FirstFrameTiming) => void
  /**
   * Invoked ONCE when the session's PRE-ROLL catch-up burst ends, with what it
   * offered, inferred and dropped. Never invoked for a session that asked for
   * no history — the owner then logs no burst line at all, rather than a line
   * of zeroes that would read as a burst that ran and found nothing.
   */
  readonly onPreRollReport?: (report: WorkerPreRollReport) => void
  /** The burst's frames' late fate (D652). See {@link WorkerPreRollSettled}. */
  readonly onPreRollSettled?: (summary: WorkerPreRollSettled) => void
  /**
   * This session's worker is GONE — called exactly once: from the process's
   * real exit, or, for a session that never forked, when the pump ends. Never
   * from the teardown request: a draining worker still holds its decoder, GPU
   * pool and hold, and the node's live-worker ceiling must keep counting it
   * (D652). The owner returns its budget slot here.
   */
  readonly onWorkerGone?: () => void
}

/**
 * Build a {@link DecodedFrame} from one pulled {@link VideoFrame}. Downscales to
 * the detection working width (see {@link resolveWorkingResize}) so the ROI
 * scaler ships a small frame instead of the full source resolution.
 * `capturedAt` is the frame's OWN moment: the worker's media clock when it has
 * one (`media-clock.ts`), else `Date.now()` as before, so downstream frameAge
 * metrics keep diffing against the wall clock (mirroring the shm-ring source,
 * which stamps commit time) — this is what lets Step 5 MEASURE session-decode
 * frameAge vs the shm-ring cameras.
 *
 * The fallback is deliberate and must stay: a `Date.now()` here for a frame
 * replayed out of ~4 s of retained history would date its detections, its
 * track's `firstSeen`, its media and the notification's instant at SESSION
 * OPEN. That is a silently wrong timestamp — nothing downstream can tell it
 * from a right one — and it is a worse failure than the late birth the pre-roll
 * pass exists to fix.
 */
async function toDecodedFrame(
  frame: VideoFrame,
  format: SessionFrameFormat,
  viewSpec?: FrameViewSpec,
): Promise<DecodedFrame> {
  const geometry = viewSpec
    ? resolveFrameViewGeometry(frame.image.width, frame.image.height, viewSpec)
    : undefined
  const bytes = await frame.image.toBuffer(
    geometry
      ? {
          crop: geometry.sourceCrop,
          resize: geometry.output,
          format: viewSpec?.format ?? format,
        }
      : { format },
  )
  return {
    data: Buffer.from(bytes),
    width: geometry?.output.width ?? frame.image.width,
    height: geometry?.output.height ?? frame.image.height,
    format: viewSpec?.format ?? format,
    timestamp: frame.timestamp,
    capturedAt: frame.capturedAt ?? Date.now(),
    ...(frame.preRoll === true ? { preRoll: true } : {}),
  }
}

/**
 * Start pulling frames from a per-session decode worker and feed each decoded
 * frame to `onDecodedFrame`. Returns an idempotent teardown closure that stops
 * the async generator (`it.return()`) — which triggers the coordinator's
 * `finally` → a bounded DRAIN of the frames already handed out (D652), then
 * `stop` + SIGTERM + 1s SIGKILL fallback → worker exit → the OS reclaims the
 * VAAPI/GPU decode pool. `teardown('immediate')` SIGKILLs at once (shutdown),
 * and said a second time during a drain it escalates that drain to the kill.
 * Fire-and-forget: the returned closure is synchronous; the frame loop and
 * generator teardown run on their own tasks.
 */
export function startSessionDecodePump(deps: SessionDecodePumpDeps): SessionDecodeTeardown {
  const format: SessionFrameFormat = deps.opts.format ?? 'rgb'
  // The worker's cold-start split, captured as it arrives. The worker sends it
  // BEFORE the `frame` reply for the same frame, so by the time the loop below
  // sees its first frame this is already populated — no waiter, no extra
  // round-trip, and an absent split simply means a worker that never got there.
  let dialTiming: WorkerDialTiming | null = null
  // Decided by the teardown call, read by the coordinator's `finally`, which
  // always runs after it.
  let teardownMode: SessionTeardownMode = 'drain'
  // The live session's own teardown, for a second call that must ESCALATE a
  // drain in progress to the kill (D652). Null until the worker is forked.
  let escalateSession: ((mode: SessionTeardownMode) => void) | null = null
  // Exactly-once "the worker is gone": the real exit when a worker was forked,
  // the pump's own end when none ever was.
  let forked = false
  let workerGone = false
  const noteWorkerGone = (): void => {
    if (workerGone) return
    workerGone = true
    deps.onWorkerGone?.()
  }
  const coordinator = createSessionDecodeCoordinator({
    fork: (source) => {
      const child = deps.fork(source)
      forked = true
      return child
    },
    lease: deps.lease,
    hwaccel: deps.hwaccel,
    logger: deps.logger,
    teardownMode: () => teardownMode,
    onSessionTeardown: (teardown) => {
      escalateSession = teardown
    },
    onWorkerExit: noteWorkerGone,
    ...(deps.onPreRollSettled ? { onPreRollSettled: deps.onPreRollSettled } : {}),
    onDialTiming: (timing) => {
      dialTiming = timing
    },
    ...(deps.firstFrameTimeoutMs !== undefined
      ? { firstFrameTimeoutMs: deps.firstFrameTimeoutMs }
      : {}),
    ...(deps.frameTimeoutMs !== undefined ? { frameTimeoutMs: deps.frameTimeoutMs } : {}),
    ...(deps.onPreRollReport ? { onPreRollReport: deps.onPreRollReport } : {}),
  })
  const iterator = coordinator.generateVideoFrames(deps.source, deps.opts)
  let stopped = false

  // Spawn-gate permit lifecycle (P5). `releaseSpawnSlot` is the concrete
  // release closure once a permit is granted; `spawnSlotReleased` guards
  // against a double-release. `releaseSpawnSlotOnce` is a no-op UNTIL the
  // permit is actually held — so a teardown that lands while the acquire is
  // still queued (permit not yet granted) does NOT poison the flag: the
  // post-acquire check inside `pump` still releases the (later-granted) permit.
  // This is what makes the release leak-free on EVERY teardown path.
  let releaseSpawnSlot: (() => void) | null = null
  let spawnSlotReleased = false
  const releaseSpawnSlotOnce = (): void => {
    if (spawnSlotReleased) return
    const release = releaseSpawnSlot
    if (!release) return // not yet acquired — pump's post-acquire check will release
    spawnSlotReleased = true
    releaseSpawnSlot = null
    release()
  }

  // Origin of the first-frame timing: the instant this session began asking for
  // a worker. Everything after it is cost the operator experiences.
  const pumpStartedAt = Date.now()

  const pump = async (): Promise<void> => {
    try {
      // Acquire the spawn permit BEFORE the first `iterator.next()` — that first
      // pull is what triggers the coordinator's `deps.fork(source)`. Queuing
      // here (not around the running decode) is exactly the burst gate.
      if (deps.acquireSpawnSlot) {
        releaseSpawnSlot = await deps.acquireSpawnSlot()
        if (stopped) {
          // Detached while queued for a permit → release it and never fork.
          releaseSpawnSlotOnce()
          return
        }
      }
      const spawnGrantedAt = Date.now()
      let firstFrameSeen = false
      for await (const frame of iterator) {
        // The worker produced its first frame: the GPU/VAAPI decode context is
        // live, so free the spawn permit for the next queued fork.
        if (!firstFrameSeen) {
          firstFrameSeen = true
          releaseSpawnSlotOnce()
          // Reported from HERE, before materialization, so the number is the
          // decode path's cost and not this consumer's conversion work.
          const dial: WorkerDialTiming | null = dialTiming
          deps.onFirstFrame?.({
            spawnWaitMs: spawnGrantedAt - pumpStartedAt,
            forkToFrameMs: Date.now() - spawnGrantedAt,
            ...(dial !== null ? { dial } : {}),
          })
        }
        if (stopped) {
          frame.image.close()
          break
        }
        let imageOwnershipTransferred = false
        try {
          if (deps.shouldMaterializeFrame && !deps.shouldMaterializeFrame(frame.preRoll === true))
            continue
          // Bind a native-crop requester to THIS frame (best-effort; the worker
          // returns a miss once the surface ages out). `frame.image.nativeCrop`
          // is intentionally safe to call after the `frame.image.close()` in the
          // finally below, so the runner may invoke it later (after detection).
          const image = frame.image
          const cropFn = image.nativeCrop
          const nativeCrop: NativeCropRequester | undefined = cropFn
            ? Object.assign((bbox: NormalizedBbox, maxWidth?: number) => cropFn(bbox, maxWidth), {
                cutTiles: (bboxes: readonly NormalizedBbox[]): void => image.cutTiles?.(bboxes),
                release: (): void => image.releaseNativeLease?.(),
                markInferred: (): void => image.markInferred?.(),
              })
            : undefined
          if (deps.frameRegistry && deps.onFrameRef && deps.inlineWhen?.() !== true) {
            // Same rule as `toDecodedFrame`: the frame's own moment when the
            // worker measured one, never a fresh wall clock for history.
            const capturedAt = frame.capturedAt ?? Date.now()
            const ref = deps.frameRegistry.register(image, {
              timestamp: frame.timestamp,
              capturedAt,
            })
            imageOwnershipTransferred = true
            if (!ref) continue
            const lazyFrame: DecodedFrame = {
              data: Buffer.alloc(0),
              width: ref.width,
              height: ref.height,
              format: ref.format,
              timestamp: ref.timestamp,
              capturedAt,
              frameRef: ref,
              ...(frame.preRoll === true ? { preRoll: true } : {}),
            }
            try {
              const admitted = await deps.onFrameRef(lazyFrame, nativeCrop)
              if (!admitted) deps.frameRegistry.release(ref, 'drop')
            } catch (err) {
              deps.frameRegistry.release(ref, 'error')
              throw err
            }
          } else {
            const decoded = await toDecodedFrame(frame, format, deps.inlineViewSpec)
            deps.onDecodedFrame(decoded, nativeCrop)
          }
        } catch (err) {
          deps.logger.debug('session-decode pump: skipped a frame (decode/consume error)', {
            tags: { deviceId: deps.source.deviceId },
            meta: { format, error: errMsg(err) },
          })
          // continue — a single dropped frame (toBuffer miss OR a consumer-side
          // enqueue error) must not end the session; only generator-level errors do.
        } finally {
          if (!imageOwnershipTransferred) frame.image.close()
        }
      }
    } catch (err: unknown) {
      deps.logger.warn('session-decode pump: frame loop ended with error', {
        tags: { deviceId: deps.source.deviceId },
        meta: { format, error: errMsg(err) },
      })
    } finally {
      // Safety net: release on ANY exit (no frame ever arrived, generator
      // ended, or the loop threw) so a permit is never leaked. Idempotent.
      releaseSpawnSlotOnce()
      // No worker was ever forked (torn down while queued, or the fork threw):
      // there is no exit to wait for, so the session's worker is gone now.
      if (!forked) noteWorkerGone()
      // Unexpected end (worker death / generator error, NOT a teardown):
      // surface it so the owner can re-dial or detach instead of zombieing.
      if (!stopped) deps.onEnded?.()
    }
  }
  void pump()

  return (mode: SessionTeardownMode = 'drain'): void => {
    if (stopped) {
      // Shutdown landing on a session already draining from a detach: the
      // drain gives way to the kill, or the exiting runner orphans the worker.
      if (mode === 'immediate' && teardownMode !== 'immediate') {
        teardownMode = 'immediate'
        escalateSession?.('immediate')
      }
      return
    }
    stopped = true
    teardownMode = mode
    // Release the permit on teardown. No-op if still queued (the pump's
    // post-acquire `stopped` check releases the later-granted permit); no-op if
    // already released on first frame.
    releaseSpawnSlotOnce()
    // `'immediate'` kills NOW, in this turn (D666). `iterator.return()` alone
    // cannot: the generator is parked in `await session.pullNext()`, not at a
    // `yield`, so the return — and the `finally` that is the only other kill —
    // queues behind a frame the worker may never send. On shutdown the runner
    // exits first and the worker is orphaned. The generator's later `finally`
    // finds the session already stopped.
    if (mode === 'immediate') escalateSession?.('immediate')
    void iterator.return().catch(() => {})
  }
}
