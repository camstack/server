/**
 * The numbers and the pure judgements behind "is this LIVE pool worker still
 * usable?" (D653). `PoolWorker` in `shared-inference-pool.ts` owns the timers
 * and the process; everything that can be decided without them lives here.
 */

/** The pool runtimes a worker can be spawned for. */
export type PoolRuntime = 'coreml' | 'openvino' | 'onnxruntime' | 'edgetpu'

/** How long ONE model load may take, per runtime. */
export interface ModelLoadBounds {
  /**
   * The SOFT bound, declared to the Python worker as `modelLoadTimeoutMs`.
   * Past it the worker answers `compile-timeout` naming the model and starts
   * no new load — but the compile keeps running, so a slow one still writes
   * its cache.
   */
  readonly softMs: number
  /**
   * The HARD bound, counted from the start of the load. A compile still
   * running at this point is taken to be hung: the worker is recycled.
   */
  readonly hardMs: number
  /** Why these numbers — the evidence, or the absence of it. */
  readonly why: string
  /**
   * May this runtime's compile hold the Python GIL? If it may, a load that is
   * SENT AND UNANSWERED can freeze the worker's loop, and a silent loop must
   * not be read as a wedge until the load's own deadline. Every runtime that
   * claims this goes blind to a hung worker for that long, so it is `true`
   * only where the risk is real and unmeasured.
   */
  readonly gilMayBeHeldDuringCompile: boolean
  readonly gilWhy: string
}

/**
 * The one table of load bounds (D653, fix round 1).
 *
 * The soft bound decides how soon the operator HEARS about a slow compile; the
 * hard bound decides when a compile is given up for hung. A single 120 s bound
 * that also killed the compile was wrong twice: a slow but finite compile was
 * killed before it could write its cache, so every respawn faced the same cold
 * compile and three of them walked the device to `failed`; and on CoreML the
 * bound was shorter than the cross-process compile-cache lock wait alone.
 */
export const POOL_MODEL_LOAD_BOUNDS: Readonly<Record<PoolRuntime, ModelLoadBounds>> = {
  openvino: {
    softMs: 120_000,
    hardMs: 600_000,
    why:
      'A cold iGPU compile of the WHOLE model set measured ~25 s on the N100; one model is 1-3 s ' +
      '(YuNet 1.4 s on a fresh worker, 2026-09-26). 120 s is ~5x the worst measured set. No ' +
      'evidence of a legitimate compile past it; the hard bound gives one 5x more before the ' +
      'worker is recycled.',
    gilMayBeHeldDuringCompile: false,
    gilWhy:
      'The OpenVINO Python binding is believed to release the GIL around compile_model ' +
      '(gil_scoped_release). Not yet measured on this node.',
  },
  coreml: {
    softMs: 300_000,
    hardMs: 900_000,
    why:
      'A load may first WAIT up to 180 s for another worker holding the compile-cache lock ' +
      '(`COMPILE_CACHE_LOCK_TIMEOUT_SEC` in inference_pool.py), then compile itself: 180 s ' +
      'of lock plus 120 s of compile. The old 120 s bound was shorter than the lock wait alone.',
    gilMayBeHeldDuringCompile: true,
    gilWhy:
      'Unverified whether coremltools releases the GIL while it compiles an mlpackage. If it ' +
      'does not, the loop freezes and nothing — not the soft timer, not mem_stats — can answer.',
  },
  onnxruntime: {
    softMs: 120_000,
    hardMs: 600_000,
    why:
      'Session creation, no persistent compile cache; CUDA/CoreML EP init is the slow case. ' +
      'Same numbers as OpenVINO for lack of any measurement saying otherwise.',
    gilMayBeHeldDuringCompile: false,
    gilWhy:
      'Not known to hold the GIL through session creation, and no frozen loop has been ' +
      'observed. Claiming the grace would blind stall detection during every load.',
  },
  edgetpu: {
    softMs: 120_000,
    hardMs: 600_000,
    why:
      'An Edge TPU model is precompiled; a load is an interpreter + delegate bind of seconds. ' +
      'Kept at the shared default rather than tightened without a measurement.',
    gilMayBeHeldDuringCompile: false,
    gilWhy: 'Nothing is compiled: the load is an interpreter + delegate bind of seconds.',
  },
}

/**
 * The host-side deadline of a `load` / `replace`: the soft bound plus a margin,
 * so the worker's NAMED answer always lands first.
 */
export const POOL_MODEL_LOAD_REPLY_MARGIN_MS = 30_000

/**
 * Why a LIVE worker was declared unusable and recycled:
 *  - `compile-hung` — a load answered `compile-timeout` and its compile was
 *    STILL running at the hard bound. Not charged to the device's crash budget:
 *    the model's own timeout count bounds it (the same model timing out again
 *    on a respawn is refused by name — `ModelCompileRefusals`).
 *  - `unresponsive` — a command AND the liveness probe sent after it both
 *    missed their deadlines. A crash in all but name. On a runtime flagged
 *    `gilMayBeHeldDuringCompile` (CoreML) it waits while a load is sent and
 *    unanswered (`gilGraceActive`); everywhere else a load changes nothing.
 *  - `infer-unresponsive` — live inference kept expiring with not one real
 *    result for {@link INFER_STALL_MS}: the executor is hung even if the loop
 *    still answers `mem_stats`.
 */
export type PoolPoisonReason = 'compile-hung' | 'unresponsive' | 'infer-unresponsive'

/** What a recycled worker hands the provider to charge. */
export interface PoolDeathCause {
  readonly reason: PoolPoisonReason
  /** `false` only for `compile-hung` — see {@link PoolPoisonReason}. */
  readonly chargesDeviceBudget: boolean
  readonly message: string
}

export function chargesDeviceBudget(reason: PoolPoisonReason): boolean {
  return reason !== 'compile-hung'
}

/** Live requests that ended without a result before a stall can be declared. */
export const INFER_STALL_MIN_REQUESTS = 20

/**
 * How long a worker may go without ONE real inference result, while live
 * requests keep ending unanswered, before its executor is declared hung. Ten
 * live deadlines: an overloaded worker still completes the requests it runs
 * (results arrive, interleaved with sheds), a 9-22 s inference seen on the N100
 * still produces results, and a hung executor produces none at all.
 */
export const INFER_STALL_MS = 30_000

/**
 * Tracks live inference outcomes on one worker and says when its executor has
 * produced nothing for too long. Consulted on demand — no timer.
 *
 * A SHED (`dropped`) does not count as a result: the Python loop answers sheds
 * itself, so a worker whose executor threads are hung keeps shedding happily.
 */
export class InferStallDetector {
  private unanswered = 0
  private lastResultAt: number
  /**
   * When the current streak of unanswered requests began — the first one after
   * a result. IDLE time is not silence: quiet cameras send nothing, and a
   * worker that was asked nothing has failed nothing. Measuring from the last
   * result let a 60 s lull plus the first 20 sheds of a burst (~8 s with six
   * cameras) poison a healthy worker and charge the device.
   */
  private streakStartedAt: number | null = null

  constructor(now: number) {
    this.lastResultAt = now
  }

  /** A reply that carried a real result (or a real error) from the executor. */
  noteResult(now: number): void {
    this.unanswered = 0
    this.lastResultAt = now
    this.streakStartedAt = null
  }

  /**
   * A live request that ended without a result (deadline expiry or a shed).
   * Returns the stall when the worker has crossed both thresholds.
   */
  noteUnanswered(now: number): { readonly unanswered: number; readonly silentMs: number } | null {
    this.unanswered += 1
    if (this.streakStartedAt === null) this.streakStartedAt = now
    const silentMs = now - Math.max(this.lastResultAt, this.streakStartedAt)
    if (this.unanswered >= INFER_STALL_MIN_REQUESTS && silentMs >= INFER_STALL_MS) {
      return { unanswered: this.unanswered, silentMs }
    }
    return null
  }
}
