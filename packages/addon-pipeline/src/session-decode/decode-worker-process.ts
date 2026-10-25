/**
 * The decode worker's PROCESS wiring — everything that ties one
 * {@link DecodeWorkerChild} to the process it runs in, and the ONE exit every
 * ending goes through (D652, D666).
 *
 * Extracted from `decode-worker-main.ts` so a test fixture runs exactly the
 * code production runs: the orphan loop of D666 lived in this wiring, and the
 * unit tests that drove its pure pieces with fake timers and a fake `on` could
 * not see an event loop that never reaches its timers.
 *
 * ‼ SANCTIONED RAW IPC ‼ — `process.on('message')` / `process.send` are the
 * correct mechanism for this private, directly-forked worker only; see the
 * note at the top of `decode-worker-child.ts`.
 */

import {
  createWorkerExit,
  FaultReporter,
  type WorkerExitFn,
  wireWorkerExit,
} from './bounded-exit.js'
import { DecodeWorkerChild, errMessage } from './decode-worker-child.js'

/**
 * How often the worker checks that its parent is still the process that forked
 * it. A parent whose IPC end outlives it would otherwise never `disconnect`.
 */
export const DECODE_WORKER_PPID_CHECK_MS = 1000

/** Stack lines carried by a fault report — enough to place it, bounded. */
const FAULT_STACK_LINES = 8

/** The one thing the ppid watchdog reads. */
export interface ParentPidSource {
  readonly ppid: number
}

/**
 * Call `onChanged` (once) when `proc.ppid` no longer matches its value now.
 * Compares against the ppid at start, never against 1: an orphan is adopted
 * by tini inside docker and may be adopted by a subreaper on macOS. The timer
 * is unref'd — it never keeps the worker alive on its own. Returns a stop.
 */
export function watchParentPid(
  proc: ParentPidSource,
  onChanged: (ppid: number) => void,
  intervalMs: number = DECODE_WORKER_PPID_CHECK_MS,
): () => void {
  const initialPpid = proc.ppid
  const timer = setInterval(() => {
    const ppid = proc.ppid
    if (ppid === initialPpid) return
    clearInterval(timer)
    onChanged(ppid)
  }, intervalMs)
  timer.unref()
  return (): void => clearInterval(timer)
}

/** The wired worker and its exit, for the entry (and a test fixture). */
export interface WiredDecodeWorker {
  readonly worker: DecodeWorkerChild
  readonly exitWorker: WorkerExitFn
}

function errorCode(err: unknown): string {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code
  return errMessage(err)
}

/** The message, plus the first stack frames: the report is rate-limited, so it must place the fault. */
function describeFault(err: unknown): string {
  if (!(err instanceof Error) || err.stack === undefined) return errMessage(err)
  return err.stack.split('\n').slice(0, FAULT_STACK_LINES).join(' | ')
}

/**
 * Build the worker and wire `proc` to it: IPC messages, stdio loss, parent
 * loss, SIGTERM, uncaught errors and the ppid watchdog. Does NOT load native
 * modules — the entry calls `worker.warm()` itself.
 */
export function wireDecodeWorkerProcess(proc: NodeJS.Process): WiredDecodeWorker {
  const worker = new DecodeWorkerChild({ requestExit: (code) => exitWorker(code) })

  proc.on('message', (message: unknown) => {
    worker.handleMessage(message)
  })

  const faults = new FaultReporter(
    (kind, err) => {
      const what = kind === 'uncaughtException' ? 'uncaught exception' : 'unhandled rejection'
      worker.emitStderr(`decode-worker-child: ${what} — ${describeFault(err)}\n`)
    },
    (count) => {
      worker.emitStderr(`decode-worker-child: ${count} further fault report(s) suppressed\n`)
    },
  )

  /**
   * quiesce (the disposer starts refusing, so nothing native is freed under a
   * live read), queue the last lines, then exit — after a bounded wait for
   * those lines while the parent is alive, in the same turn once it is gone.
   */
  const exitWorker = createWorkerExit({
    sends: worker.outbound,
    steps: {
      quiesce: () => worker.quiesceForExit(),
      flushFinalLines: () => {
        faults.flushSuppressed()
        worker.flushFinalLines()
      },
    },
    exit: (code) => proc.exit(code),
  })

  wireWorkerExit({
    on: (event, listener) => {
      switch (event) {
        case 'SIGTERM':
          proc.on('SIGTERM', () => listener(undefined))
          return
        case 'disconnect':
          proc.on('disconnect', () => listener(undefined))
          return
        case 'stdioLost':
          // Without these listeners an EPIPE on the inherited stdio is an
          // uncaughtException — and reporting it wrote to stderr again (D666).
          proc.stdout.on('error', (err: unknown) => listener(err))
          proc.stderr.on('error', (err: unknown) => listener(err))
          return
        case 'parentChanged':
          watchParentPid(proc, (ppid) => listener(ppid))
          return
        case 'uncaughtException':
          proc.on('uncaughtException', (err: unknown) => listener(err))
          return
        case 'unhandledRejection':
          proc.on('unhandledRejection', (reason: unknown) => listener(reason))
          return
      }
    },
    exitWorker,
    faults,
    // Raw writes stop here, so a dead stderr is not re-hit on every metrics
    // tick. With the channel up this line reaches the runner's scoped logger,
    // which tags it with the camera; with the channel down there is no sink.
    onStdioLost: (err) => {
      worker.markStderrLost()
      worker.emitStderr(
        `decode-worker-child: stdio lost (${errorCode(err)}) — raw stderr off, IPC logging continues\n`,
        'warn',
      )
    },
    parentConnected: () => proc.connected,
  })

  return { worker, exitWorker }
}
