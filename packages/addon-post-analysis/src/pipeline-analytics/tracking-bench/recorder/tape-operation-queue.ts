/**
 * Runs tracking-tape operations (promote / release / delete / reconcile) one
 * at a time (D681, Task 12). Promote's budget check and release's "still
 * named by another promotion" set are both read-then-write against the index;
 * two interleaved operations would each see the other's world before it
 * changed.
 *
 * A rejected operation never wedges the queue: the tail swallows it, and the
 * caller still receives the rejection. A HUNG one would — every later tape
 * operation waiting on a disk that never answers — so each operation has a
 * deadline (fix round 1, L2). Past it:
 *
 *  - the op's `AbortSignal` is aborted. Every write phase of promote, release,
 *    delete and reconcile checks it first, so an abandoned op writes nothing
 *    MORE (fix round 2, N1). A write already in flight — a `setBenchPinned`
 *    loop, say — cannot be recalled and may land after the next op;
 *  - the caller is rejected with {@link TapeOperationTimeoutError} and a
 *    tagged line says which operation on which camera;
 *  - the queue moves on;
 *  - when the abandoned op finally settles, `afterAbandoned` (the pin
 *    reconcile, which re-applies every row's pins) is queued, so a late write
 *    is repaired at once instead of at the next operator action.
 */
import type { IScopedLogger } from '@camstack/types'

/** Generous: a promotion reads its window's segments and walks back through
 *  the session for identities (at most `MAX_IDENTITY_LOOKBACK_SEGMENTS`). */
const TAPE_OPERATION_DEADLINE_MS = 5 * 60_000

export interface TapeOperationContext {
  /** What the operation is, for the timeout line (`promote`, `release`, …). */
  readonly name: string
  /** The camera it is about, when it is about one. */
  readonly deviceId?: number
}

/** A queued operation: it must check `signal` before each write. */
export type TapeOperation<T> = (signal: AbortSignal) => Promise<T>

export interface TapeOperationQueueOptions {
  readonly logger: IScopedLogger
  readonly deadlineMs?: number
  /** Queued once an abandoned operation settles (see the file header). */
  readonly afterAbandoned?: TapeOperation<unknown>
}

export class TapeOperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly deadlineMs: number,
  ) {
    super(`tracking tape ${operation} did not finish within ${String(deadlineMs)} ms`)
    this.name = 'TapeOperationTimeoutError'
  }
}

export class TapeOperationQueue {
  private readonly logger: IScopedLogger
  private readonly deadlineMs: number
  private readonly afterAbandoned: TapeOperation<unknown> | undefined
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: TapeOperationQueueOptions) {
    this.logger = options.logger
    this.deadlineMs = options.deadlineMs ?? TAPE_OPERATION_DEADLINE_MS
    this.afterAbandoned = options.afterAbandoned
  }

  run<T>(op: TapeOperation<T>, context: TapeOperationContext): Promise<T> {
    const next = this.tail.then(() => this.withDeadline(op, context))
    this.tail = next.catch(() => undefined)
    return next
  }

  private withDeadline<T>(op: TapeOperation<T>, context: TapeOperationContext): Promise<T> {
    const controller = new AbortController()
    const running = op(controller.signal)
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TapeOperationTimeoutError(context.name, this.deadlineMs)
        controller.abort(error)
        this.logger.warn('tracking tape operation abandoned at its deadline', {
          ...(context.deviceId !== undefined ? { tags: { deviceId: context.deviceId } } : {}),
          meta: { operation: context.name, deadlineMs: this.deadlineMs },
        })
        this.followUpWhenSettled(running, context)
        reject(error)
      }, this.deadlineMs)
      timer.unref?.()
    })
    return Promise.race([running, deadline]).finally(() => clearTimeout(timer))
  }

  private followUpWhenSettled(running: Promise<unknown>, context: TapeOperationContext): void {
    const followUp = this.afterAbandoned
    if (followUp === undefined) return
    const queueFollowUp = (): void => {
      this.run(followUp, { name: `repair after ${context.name}` }).catch((err: unknown) => {
        this.logger.warn('tracking tape repair after an abandoned operation failed', {
          ...(context.deviceId !== undefined ? { tags: { deviceId: context.deviceId } } : {}),
          meta: {
            operation: context.name,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      })
    }
    running.then(queueFollowUp, queueFollowUp)
  }
}
