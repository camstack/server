import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { LiveWorkerLease, SlotWaiter } from './live-worker-admission.js'
import type { SessionDecodeTeardown, SessionTeardownMode } from './session-decode-coordinator.js'

/**
 * An acquired session-decode restream + its one-shot refcount release.
 * Mirrors `pipeline-runner`'s internal `SessionDecodeRestream` shape so the
 * runner can pass `acquireSessionDecodeRestream`'s result straight through.
 */
export interface AcquiredRestream<S> {
  readonly source: S
  release(): Promise<void>
}

/**
 * Dependencies for {@link startGuardedSessionDecode}. `acquire` resolves the
 * broker restream (or `null` when no profile is bound yet); `startPump`
 * spins up the decode worker for the acquired source and returns its own
 * `stopPump` teardown.
 */
/** What {@link startGuardedSessionDecode} hands the pump it starts. */
export interface GuardedPumpHooks {
  /** The session's worker process is gone — returns the live-worker slot. */
  readonly onWorkerGone: () => void
}

export interface GuardedSessionDecodeDeps<S> {
  acquire: () => Promise<AcquiredRestream<S> | null>
  /**
   * Start the pump for an acquired source. `hooks.onWorkerGone` MUST reach the
   * pump (`SessionDecodePumpDeps.onWorkerGone`): it is what returns the node's
   * live-worker slot, at the worker's real exit rather than at the teardown
   * request (D652).
   */
  startPump: (source: S, hooks: GuardedPumpHooks) => SessionDecodeTeardown
  logger: IScopedLogger
  /**
   * Backoff ladder between acquire attempts, in ms. The LAST entry repeats for
   * every further attempt, so the retry continues indefinitely at that cadence
   * until teardown. Injectable for tests; defaults to
   * {@link DEFAULT_ACQUIRE_RETRY_DELAYS_MS}.
   */
  readonly acquireRetryDelaysMs?: readonly number[]
  /**
   * Take a slot in the node's live-decode-worker budget, or `null` when the
   * node is full. Checked BEFORE `acquire`, deliberately: taking a broker
   * restream refcount for a session that cannot run holds a resource on
   * another process for nothing.
   *
   * A refusal is treated exactly like "no source yet" — backoff and ask again
   * on the ladder below. It must never become a queue: a live decode session
   * lasts as long as the motion does, so a queued one would wait an unbounded
   * time and then decode a moment that has already passed, and the queue would
   * itself be another unbounded structure. See `LiveDecodeWorkerAdmission`.
   *
   * Omitted → no ceiling (the historical behaviour).
   */
  readonly admitWorker?: () => LiveWorkerLease | null
  /**
   * This start's place in the node's queue of refused starts, taken on its
   * first refusal and kept until the start is over. A start the ceiling
   * REFUSED waits on it, not on the backoff timer: the slot of a draining
   * worker comes back at its exit, and a re-attach should not sit out a 2 s
   * timer after that (D652). The timer stays as the fallback. Omitted → timer
   * only.
   */
  readonly slotWaiter?: () => SlotWaiter
}

/**
 * 2s → 5s → 15s → 30s, then 30s forever.
 *
 * Indefinite is deliberate. The failure this recovers from is "the broker has
 * no profile bound yet" or "the broker call failed right now" — both of which
 * clear on their own, often minutes later (a source re-dialing, a runner
 * restarting). A bounded retry would turn a slow recovery back into the
 * permanent outage this exists to prevent, and teardown already stops it: a
 * detach aborts the loop, so nothing retries for a camera nobody wants.
 */
const DEFAULT_ACQUIRE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000]

/** How one backoff wait ended: its timer, a returned slot, or the teardown. */
type BackoffEnd = 'timer' | 'woken' | 'torn-down'

/**
 * Guards the in-flight restream-acquire against a detach/unsubscribe race,
 * and retries an acquire that fails.
 *
 * `acquireSessionDecodeRestream` + forking the decode worker both take real
 * time (a broker round-trip, then a process fork). If the caller's teardown
 * runs while that acquire is still in flight, the closure that would release
 * the restream and stop the pump does not exist yet by the time the caller
 * stores it — a naive `await acquire(); return () => {...}` construction
 * leaks the acquired restream refcount and, once the acquire resolves, forks
 * an orphan decode worker nobody will ever stop.
 *
 * This helper returns the teardown SYNCHRONOUSLY. The acquire + pump-start
 * run in the background; an `aborted` flag recorded by the (possibly
 * already-called) teardown is checked right after each acquire resolves —
 * if set, any restream is released immediately and the pump is NEVER
 * started (no orphan worker). Otherwise the pump starts and the teardown,
 * once called, stops the pump then releases the restream.
 *
 * **A failed acquire is retried, not swallowed.** The teardown handed back
 * here is stored by the caller (as `attachment.detectionUnsubscribe`) the
 * instant this returns, so a `return` on failure left that handle permanently
 * non-null with no pump behind it: `onEnded` could never fire because nothing
 * had ever started, the camera's phase stayed `active`, and not one frame
 * arrived again. The motion path was hardened against this shape by a frame
 * freshness window (`MOTION_FRESHNESS_WINDOW_MS`); this is the detection
 * path's half.
 */
/** The slot-wake half of the deps, as a caller builds it on its own. */
export type GuardedSlotWake = Pick<GuardedSessionDecodeDeps<unknown>, 'slotWaiter'>

/** A restream release that runs once however many paths reach it. */
function onceRelease(release: () => Promise<void>): () => Promise<void> {
  let done = false
  return () => {
    if (done) return Promise.resolve()
    done = true
    return release()
  }
}

export function startGuardedSessionDecode<S>(
  deps: GuardedSessionDecodeDeps<S>,
): SessionDecodeTeardown {
  let aborted = false
  /** The mode the teardown asked for — replayed if it raced `startPump`. */
  let abortMode: SessionTeardownMode = 'drain'
  let stopPump: SessionDecodeTeardown | null = null
  let release: (() => Promise<void>) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** The live-worker slot held by the RUNNING session, released on teardown. */
  let workerLease: LiveWorkerLease | null = null

  const delays =
    deps.acquireRetryDelaysMs && deps.acquireRetryDelaysMs.length > 0
      ? deps.acquireRetryDelaysMs
      : DEFAULT_ACQUIRE_RETRY_DELAYS_MS

  /** Ends a parked start's wait when the session is torn down. */
  let abortWait: (() => void) | null = null
  /**
   * This start's place in the ceiling queue — taken on its first refusal, kept
   * to the end so a re-park keeps the FIFO position (D652).
   */
  let waiter: SlotWaiter | null = null
  /**
   * The start was handed a returned slot and has not yet ASKED for it. Set on
   * a wake, cleared by the next `admitWorker` call; a start torn down while
   * this is set passes the slot on (`SlotWaiter.leave(true)`), or nobody gets
   * it and every other parked start waits out its full timer.
   */
  let wakeInHand = false

  /**
   * Resolves after the backoff for `attempt` (`'timer'`) — or, when `parked`,
   * as soon as the node hands this start a returned slot (`'woken'`) or the
   * session is torn down (`'torn-down'`), whichever is first. The start leaves
   * the queue on every exit, so a torn-down start leaves no listener behind.
   */
  const waitBackoff = (attempt: number, parked: SlotWaiter | null): Promise<BackoffEnd> =>
    new Promise((resolve) => {
      const ms = delays[Math.min(attempt, delays.length - 1)] ?? delays[delays.length - 1] ?? 2_000
      const done = (why: BackoffEnd): void => {
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        // On 'woken' the admission already took this start out of the queue;
        // cancelling again is a no-op. On the other two it must leave now.
        parked?.cancel()
        abortWait = null
        resolve(why)
      }
      retryTimer = setTimeout(() => done('timer'), ms)
      retryTimer.unref?.()
      // EVERY wait ends on teardown, parked or not: a timer-only wait (no
      // profile yet, acquire threw) whose timer was cleared and whose promise
      // never resolved left the loop suspended forever, its `finally` — the
      // waiter's `leave` — never run.
      abortWait = () => done('torn-down')
      if (parked) parked.wait(() => done('woken'))
    })

  const releaseWorkerSlot = (): void => {
    workerLease?.release()
    workerLease = null
  }

  const startLoop = async (): Promise<void> => {
    for (let attempt = 0; !aborted; attempt++) {
      // The node's live-worker ceiling comes FIRST — before the broker
      // restream, before the fork. A refusal is a real branch that drops work,
      // so it is on the record per camera (the WARN is emitted by
      // `LiveDecodeWorkerAdmission.admit`, which owns the deviceId tag).
      let lease: LiveWorkerLease | null = null
      if (deps.admitWorker) {
        // Asking spends a wake, admitted or not: a refusal here means
        // something else took the slot, so there is nothing to pass on.
        wakeInHand = false
        lease = deps.admitWorker()
        if (!lease) {
          waiter ??= deps.slotWaiter?.() ?? null
          const why = await waitBackoff(attempt, waiter)
          if (why === 'woken') {
            // A WAKE is not a failed attempt: it must not advance the backoff,
            // or a start that loses its wake to a faster one would find its
            // fallback timer stretched (D652).
            attempt -= 1
            wakeInHand = true
          }
          continue
        }
      }
      let acquired: AcquiredRestream<S> | null = null
      try {
        acquired = await deps.acquire()
      } catch (err: unknown) {
        lease?.release()
        // A THROW and a `null` are the same situation from here: no source yet.
        // Only the first is loud — a broker that is down produces one of these
        // per camera per cadence, and drowning the log helps nobody.
        const log = attempt === 0 ? deps.logger.warn : deps.logger.debug
        log.call(deps.logger, 'session-decode: acquire failed — retrying', {
          meta: { attempt: attempt + 1, error: errMsg(err) },
        })
        await waitBackoff(attempt, null) // no slot in question: timer only
        continue
      }

      if (aborted) {
        // Detached mid-acquire → release, never spawn a worker.
        lease?.release()
        if (acquired) void acquired.release()
        return
      }

      if (!acquired) {
        lease?.release()
        const log = attempt === 0 ? deps.logger.warn : deps.logger.debug
        log.call(deps.logger, 'session-decode: no broker profile bound yet — retrying', {
          meta: { attempt: attempt + 1 },
        })
        await waitBackoff(attempt, null) // no slot in question: timer only
        continue
      }

      if (attempt > 0) {
        deps.logger.info('session-decode: acquire succeeded after retry', {
          meta: { attempts: attempt + 1 },
        })
      }
      release = onceRelease(acquired.release)
      workerLease = lease
      // The slot is the WORKER's, not the session's: it goes back when the
      // process exits, so a draining worker still counts against the node
      // ceiling and a re-attach during the drain cannot double the camera's
      // native footprint unseen (D652).
      try {
        stopPump = deps.startPump(acquired.source, { onWorkerGone: releaseWorkerSlot })
      } catch (err: unknown) {
        // No pump, so no worker will ever exit to return the slot: return it
        // here, with the restream, or the node loses a slot for good.
        releaseWorkerSlot()
        const restream = release
        release = null
        void restream?.()
        throw err
      }
      // Torn down from INSIDE `startPump` (a consumer that finished on the
      // very first frames): the teardown ran while `stopPump` was still null,
      // so it could not reach the pump. Honour it now, in the mode it asked.
      if (aborted) stopPump(abortMode)
      return
    }
  }

  void startLoop()
    .catch((err: unknown) => {
      deps.logger.warn('session-decode: guarded start failed', { meta: { error: errMsg(err) } })
    })
    .finally(() => {
      // However the start ended — admitted, torn down, thrown — its place in
      // the queue is given up, the camera's refused memory with it, and a slot
      // it was handed but never asked for goes to the next parked start.
      waiter?.leave(wakeInHand)
      waiter = null
    })

  return (mode: SessionTeardownMode = 'drain') => {
    if (aborted) {
      // A second call that says 'immediate' while the first drains ESCALATES
      // (D652): shutdown must not wait out a detach's drain, or the exiting
      // runner orphans the worker. Any other repeat is the old no-op.
      if (mode === 'immediate' && abortMode !== 'immediate') {
        abortMode = mode
        stopPump?.(mode)
      }
      return
    }
    aborted = true
    abortMode = mode
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    // A start parked on the ceiling: end its wait so the loop sees `aborted`
    // and leaves the queue now.
    abortWait?.()
    // The pump drains the frames it already handed out before it kills the
    // worker (D652). The restream goes back at once — a draining worker
    // decodes nothing. The live-worker slot does NOT: a draining worker still
    // holds its decoder, GPU pool and hold, so the pump returns the slot from
    // the worker's real exit (`onWorkerGone`), and until then a re-attach of
    // this camera, or any other, is counted against the ceiling.
    stopPump?.(mode)
    // No slot to return here. Before a pump starts the slot is the start
    // loop's own (`lease`): the loop returns it on every exit, including the
    // one this teardown causes (the `aborted` check after the acquire). Once
    // a pump started, it is the worker's, and comes back from its exit. A
    // teardown raced from INSIDE `startPump` is replayed after it returns.
    if (release) void release()
  }
}
