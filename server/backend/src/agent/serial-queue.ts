/**
 * Run async jobs ONE AT A TIME, in the order they were asked for, whether the previous one
 * succeeded or failed.
 *
 * The agent's `reconnect()` stops the broker and builds a new one. The UI, a mesh-leaf swap
 * and its rollback can all ask for one; two interleaved stop/rebuild cycles would leave two
 * brokers - or none. Every caller gets the result of ITS OWN job.
 *
 * A job that never settles (a broker whose `start()` hangs) would hold the queue, and with
 * it every later reconnect - including the rollback that would put a working leaf back. So
 * each job has a deadline: on expiry `onTimeout` runs (it destroys what the job half-built),
 * the caller gets a rejection, and the next job starts.
 */
export interface SerialQueueOptions {
  readonly deadlineMs?: number
  /** Called once when a job passes its deadline, before the next job starts. */
  readonly onTimeout?: () => void
  /** Timer seam for specs. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

export class SerialQueueTimeoutError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`the job did not finish within ${deadlineMs} ms and was abandoned`)
    this.name = 'SerialQueueTimeoutError'
  }
}

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function createSerialQueue<T>(
  job: () => Promise<T>,
  options: SerialQueueOptions = {},
): () => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  const setTimer = options.setTimer ?? defaultSetTimer
  const guarded = (): Promise<T> => {
    const deadlineMs = options.deadlineMs
    if (deadlineMs === undefined) return job()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimer(() => {
        try {
          options.onTimeout?.()
        } finally {
          reject(new SerialQueueTimeoutError(deadlineMs))
        }
      }, deadlineMs)
      job().then(
        (value) => {
          timer.cancel()
          resolve(value)
        },
        (error: unknown) => {
          timer.cancel()
          reject(error)
        },
      )
    })
  }
  return () => {
    const run = tail.then(guarded, guarded)
    tail = run.catch(() => undefined)
    return run
  }
}
