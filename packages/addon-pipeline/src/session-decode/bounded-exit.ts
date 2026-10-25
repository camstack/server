/**
 * Exit the decode worker only after its last lines have LEFT the process —
 * bounded (D652).
 *
 * `process.send` is asynchronous: a line queued in the same turn as
 * `process.exit` is lost. Until D652 the child had no SIGTERM handler at all,
 * so the parent's `kill()` ended it mid-flight and the teardown's pre-roll
 * report — a line whose whole point is to say what was dropped — vanished with
 * it (D391). The child now tracks every send until its callback fires and, on
 * SIGTERM / `stop`, waits for them to drain before exiting, never longer than
 * a bound that sits well inside the parent's SIGKILL fallback. When the PARENT
 * is gone (disconnect, ppid changed, stdio lost with the channel down) it
 * exits in the same turn instead (D666): the bound is a timer, and a starved
 * loop never fires one.
 *
 * Pure: no `process`, no IPC. The child wires `exit` and the send callbacks.
 */

/** Longest the child waits for queued lines before exiting anyway. */
export const WORKER_EXIT_FLUSH_BOUND_MS = 250

export class OutboundSendTracker {
  private inFlight = 0
  private idleWaiters: Array<() => void> = []

  /** A send left for the channel; call the returned function from its callback. */
  begin(): () => void {
    this.inFlight += 1
    let done = false
    return (): void => {
      if (done) return
      done = true
      this.inFlight = Math.max(0, this.inFlight - 1)
      if (this.inFlight > 0) return
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  get pending(): number {
    return this.inFlight
  }

  /** Resolves when nothing is in flight, or after `boundMs` — whichever is first. */
  whenIdle(boundMs: number): Promise<'idle' | 'bound'> {
    if (this.inFlight === 0) return Promise.resolve('idle')
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('bound'), boundMs)
      this.idleWaiters.push(() => {
        clearTimeout(timer)
        resolve('idle')
      })
    })
  }
}

/**
 * The worker's exit, in the only order it may happen (D652):
 *
 * 1. `quiesce` — stop timers, loops and the burst. NO native call: the decode
 *    loop may still be inside libav, and disposing under it is the
 *    use-after-free that would crash the process before its lines leave.
 * 2. `flushFinalLines` — queue the last report lines.
 * 3. wait — bounded — for every queued send to leave, then `exit`. Skipped
 *    for a `'now'` exit (the parent is gone): `exit` runs in the same turn.
 *
 * There is no dispose step, on purpose: process exit reclaims every native
 * resource, the GPU pool included. Idempotent: SIGTERM, `stop` and
 * `disconnect` can all arrive for one shutdown.
 */
export interface WorkerExitSteps {
  readonly quiesce: () => void
  readonly flushFinalLines: () => void
}

/**
 * How urgently an exit request must end the process (D666).
 *
 * - `'flush'` — the parent is alive (`stop`, SIGTERM, a first uncaught error):
 *   wait, bounded, for the queued lines to leave. The parent has its own
 *   SIGKILL fallback behind it.
 * - `'now'` — the parent is GONE (`disconnect`, stdio lost with the channel
 *   down, the ppid changed) or the process is faulting repeatedly: exit in the
 *   SAME turn. Nobody is left to read a flushed line, and the bound is a timer
 *   — a timer is exactly what a starved event loop never fires. On the Mac
 *   agent a worker whose stderr reader died re-raised EPIPE from its own
 *   uncaught handler inside the check phase forever: the 250 ms timer never
 *   ran, SIGTERM was never serviced, and 17 orphans spun at 641 % CPU.
 */
export type WorkerExitUrgency = 'flush' | 'now'

/** The worker's one exit: idempotent, and a later `'now'` cuts a pending flush short. */
export type WorkerExitFn = (code: number, urgency?: WorkerExitUrgency) => void

export function createWorkerExit(deps: {
  readonly sends: OutboundSendTracker
  readonly steps: WorkerExitSteps
  readonly exit: (code: number) => void
  readonly boundMs?: number
}): WorkerExitFn {
  let exiting = false
  let exited = false
  let exitCode = 0
  const finish = (): void => {
    if (exited) return
    exited = true
    deps.exit(exitCode)
  }
  return (code: number, urgency: WorkerExitUrgency = 'flush'): void => {
    if (exiting) {
      // A flush already waiting on its bound, and now the parent is gone (or
      // the process faults again): nothing is left to flush to — exit now.
      if (urgency === 'now') finish()
      return
    }
    exiting = true
    // The exit is ALWAYS reached, whatever the steps do: `exiting` is
    // already set, so a step that throws would otherwise leave a process that
    // every later exit request returns from early — and on `disconnect`
    // nothing else ever ends it. A failed step turns the code into 1.
    exitCode = code
    try {
      deps.steps.quiesce()
    } catch {
      exitCode = 1
    }
    try {
      deps.steps.flushFinalLines()
    } catch {
      exitCode = 1
    }
    if (urgency === 'now') {
      finish()
      return
    }
    void deps.sends.whenIdle(deps.boundMs ?? WORKER_EXIT_FLUSH_BOUND_MS).then(finish)
  }
}

/** The process events that end a decode worker. */
export type WorkerExitEvent =
  | 'SIGTERM'
  | 'disconnect'
  | 'stdioLost'
  | 'parentChanged'
  | 'uncaughtException'
  | 'unhandledRejection'

/** The two process-level faults the worker reports. */
export type WorkerFaultKind = 'uncaughtException' | 'unhandledRejection'

/** At most this many fault reports per {@link FAULT_REPORT_WINDOW_MS}; the rest are counted. */
export const FAULT_REPORT_LIMIT = 5
export const FAULT_REPORT_WINDOW_MS = 60_000

/**
 * Reports every fault, rate-limited: the first {@link FAULT_REPORT_LIMIT} in
 * each {@link FAULT_REPORT_WINDOW_MS} window go out, and the rest are counted
 * and reported as one line by {@link flushSuppressed} at exit (D666).
 *
 * A report that throws is swallowed here. If it were rethrown, it would become
 * the next uncaught error, and reporting that one would write again. That is
 * the loop that kept the Mac agent's orphans spinning.
 */
export class FaultReporter {
  private windowStart = Number.NEGATIVE_INFINITY
  private inWindow = 0
  private suppressed = 0

  constructor(
    private readonly report: (kind: WorkerFaultKind, err: unknown) => void,
    private readonly reportSuppressed: (count: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Report one fault unless the window is full; true when it was reported. */
  fault(kind: WorkerFaultKind, err: unknown): boolean {
    const at = this.now()
    if (at - this.windowStart >= FAULT_REPORT_WINDOW_MS) {
      this.windowStart = at
      this.inWindow = 0
    }
    if (this.inWindow >= FAULT_REPORT_LIMIT) {
      this.suppressed += 1
      return false
    }
    this.inWindow += 1
    this.attempt(() => this.report(kind, err))
    return true
  }

  /** The count of faults not reported, as one line. Nothing when there were none. */
  flushSuppressed(): void {
    const count = this.suppressed
    if (count === 0) return
    this.suppressed = 0
    this.attempt(() => this.reportSuppressed(count))
  }

  private attempt(write: () => void): void {
    try {
      write()
    } catch {
      // Swallowed on purpose: see the class comment.
    }
  }
}

/** What {@link wireWorkerExit} needs from the process entry. */
export interface WorkerExitWiring {
  readonly on: (event: WorkerExitEvent, listener: (arg: unknown) => void) => void
  readonly exitWorker: WorkerExitFn
  readonly faults: FaultReporter
  /**
   * The inherited stdout/stderr failed (EPIPE: its reader is gone). Stop every
   * raw write to it, and — when the channel is still up — say so over IPC.
   * Called at most once.
   */
  readonly onStdioLost: (err: unknown) => void
  /** Whether the IPC channel to the parent is still up. */
  readonly parentConnected: () => boolean
}

/**
 * Route every event that ends the worker through the one exit (D652, D666):
 *
 * - SIGTERM (the parent's `kill()`) flushes, bounded; a SECOND SIGTERM exits now.
 * - a lost channel, and a changed ppid, exit NOW — the parent is gone.
 * - stdio lost is never an uncaught exception. While the channel is up it is
 *   NOT an exit: raw stderr is the secondary log path (the IPC copy is what
 *   reaches the runner's logger), so the worker says so once over IPC and
 *   keeps decoding; exiting would only make the runner re-dial into the same
 *   dead stderr. With the channel down too, it exits now.
 * - an uncaught error is reported (rate-limited) and exits 1: flushed the
 *   first time, now for every later one — a process that keeps faulting must
 *   not keep formatting stacks.
 * - an unhandled rejection is reported (rate-limited) and does not end the worker.
 *
 * When the parent is gone there is NO sink for the exit reason: stderr's
 * reader died with it and the channel is closed. The exit is not logged, and
 * must not try to be — trying is what looped.
 */
export function wireWorkerExit(deps: WorkerExitWiring): void {
  let sigterms = 0
  deps.on('SIGTERM', () => {
    sigterms += 1
    deps.exitWorker(0, sigterms > 1 ? 'now' : 'flush')
  })
  deps.on('disconnect', () => deps.exitWorker(0, 'now'))
  deps.on('parentChanged', () => deps.exitWorker(0, 'now'))
  let stdioLost = false
  deps.on('stdioLost', (err) => {
    if (!stdioLost) {
      stdioLost = true
      try {
        deps.onStdioLost(err)
      } catch {
        // Nothing left to say it on.
      }
    }
    if (!deps.parentConnected()) deps.exitWorker(0, 'now')
  })
  let uncaught = 0
  deps.on('uncaughtException', (err) => {
    uncaught += 1
    deps.faults.fault('uncaughtException', err)
    deps.exitWorker(1, uncaught > 1 ? 'now' : 'flush')
  })
  deps.on('unhandledRejection', (reason) => {
    deps.faults.fault('unhandledRejection', reason)
  })
}
