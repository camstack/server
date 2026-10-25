/**
 * THE SEGMENTS OF A MOTION DISPATCH, AND THE ONE THAT MAY NOT HOLD IT (D440).
 *
 * `session motion → attach latency` reported three numbers — bus lag, lock
 * wait, `dispatchMs` — and `dispatchMs` was one undifferentiated span from the
 * lock to the attach. Camera 101, 2026-09-10 16:45:33: `dispatchMs 5032`, and
 * the log's own timestamps put the `attachOn` RPC at 13 ms of it
 * (`inference device selection` 38.455 → `dispatched on motion` 38.468). The
 * other five seconds were spent BEFORE a node was even chosen, and nothing
 * named where. Twelve hours of the hub: 2 841 dispatches, p50 44 ms, p90
 * 1 182 ms, p99 6 341 ms, max 18 975 ms.
 *
 * What runs before the node is chosen is one non-memoised remote fan-out:
 * `reconcilePlacementFromRunners()`, awaited at the head of every session
 * dispatch, which asks EVERY runner node for its attached cameras — in
 * sequence — and then detaches the orphans it finds, in sequence. Of the 163
 * dispatches over 2 s, 82 had a reconcile detach line inside their window;
 * the other 81 had nothing, because a census that merely took long said
 * nothing. So this module gives the dispatch its segments, and a budget for
 * the one segment whose cost is another node's event loop.
 */

/**
 * How long a session dispatch waits for the placement census before it goes
 * ahead and places. The census is the only remote fan-out on the path; the
 * dispatch itself (balancer inputs from memory, settings reads, the attach
 * RPC) measures 13–600 ms on this hub. Half a second is about what the
 * pre-roll can absorb: every ms spent here is a ms of the retained window
 * (5 s by default) that the first inferenced frame will never see.
 *
 * Going ahead is SAFE because the dispatch guard (`markDispatching`) stays
 * held until the overrunning census settles: the pure reconcile skips a
 * dispatching device for both its detach and its stale-assignment drop, so a
 * census that took its runner snapshot before the attach landed cannot
 * deregister the session it did not see.
 */
export const DISPATCH_RECONCILE_BUDGET_MS = 500

/**
 * How long the placement census waits for ONE runner's `getLocalCameras`
 * before counting that node as not having reported. A node that did not
 * report never has its assignments dropped (`reconcilePlacement` says so), so
 * skipping a slow node costs one pass of orphan cleanup on that node, not
 * correctness. The census fans out in parallel, so this bounds the whole
 * census at one budget rather than one budget per node.
 */
export const RECONCILE_NODE_BUDGET_MS = 1500

/** Above this a placement census reports itself, with the per-node cost. */
export const RECONCILE_SLOW_MS = 1000

/**
 * How long the balancer waits for a load re-read before balancing on the last
 * known load (D441). The memo is invalidated after EVERY dispatch and teardown
 * (`notePlacementChanged`), so in a burst the next camera always finds a
 * re-read in flight; on a saturated hub-main event loop that re-read took
 * 9 205 ms for three cameras at once (2026-09-10 18:39:49). Same budget as the
 * census, for the same reason: every ms here is a ms of retained pre-roll the
 * first inferenced frame will not see. A load snapshot a few seconds old is
 * only ever wrong by the sessions dispatched since — the balancer's own
 * session registry counts those separately.
 */
export const BALANCE_LOAD_BUDGET_MS = 500

/** How a budgeted wait ended. */
export type BudgetOutcome<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'budget-exceeded' }

/**
 * Wait for `promise`, but never longer than `budgetMs`.
 *
 * The promise is NOT cancelled — it keeps running, and its eventual rejection
 * is observed here so an overrun never becomes an unhandled rejection. The
 * caller decides what an overrun means; this only says that it happened.
 */
export function raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<BudgetOutcome<T>> {
  return new Promise<BudgetOutcome<T>>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ kind: 'budget-exceeded' })
    }, budgetMs)
    timer.unref?.()
    promise.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'settled', value })
      },
      (error: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'rejected', error })
      },
    )
  })
}

/** The segments of one session dispatch, in ms, in the order they run. */
export interface DispatchTimings {
  /** `reconcilePlacementFromRunners`, as long as the dispatch waited for it. */
  readonly reconcileMs: number
  /** The census was still running when {@link DISPATCH_RECONCILE_BUDGET_MS} expired. */
  readonly reconcileBudgetExceeded: boolean
  /** Pin + balancer inputs (memoised) + `balance()`. */
  readonly balanceMs: number
  /** The load re-read overran {@link BALANCE_LOAD_BUDGET_MS}; the last known load was used. */
  readonly balanceLoadStale: boolean
  /** Inference-device roster + caps + device pin + the pick. */
  readonly deviceSelectMs: number
  /** Pipeline config, per-(node,device) provisioning, zones. */
  readonly configMs: number
  /** The `attachOn` RPC itself. */
  readonly attachMs: number
}

/** One runner's answer to the placement census, with what it cost. */
export interface RunnerCensusEntry {
  readonly nodeId: string
  readonly ms: number
  readonly outcome: 'reported' | 'failed' | 'budget-exceeded'
}
