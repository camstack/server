/**
 * Every decode-worker process this runner forked and has not yet seen exit —
 * and what ends them when the runner stops (D666).
 *
 * Every kill path lives in the parent: the coordinator's teardown and its
 * SIGKILL fallback. When the runner exited gracefully, none of them ran.
 * `'immediate'` only queued `iterator.return()` behind a pull the worker
 * never answered, the occupancy bursts were never reached, and the runner's
 * `process.exit(0)` came first. On the Mac agent that left 17 decode workers
 * orphaned at PPID 1, with 3.7 GB RSS and 641 % CPU between them, each still
 * pulling its camera's RTSP.
 *
 * {@link LiveDecodeWorkers} does not depend on any session's bookkeeping. A
 * worker is in it from its fork to its real exit, whoever started it, and a
 * kill is synchronous: `kill(2)` has delivered the signal when it returns.
 * {@link RunnerDecodeWorkers} is the runner's wiring of it, and it guarantees
 * three things:
 *
 * - the addon's shutdown kills every worker first, before anything else in
 *   `onShutdown` can throw;
 * - a fork that lands after that kill is killed at once;
 * - any `process.exit` kills whatever is left. That includes the addon
 *   runner's uncaught-exception `exit(1)`, which never reaches `onShutdown`.
 *   `'exit'` listeners run synchronously inside `process.exit`.
 *
 * A worker in the set is an unreaped child of THIS process, and Node's
 * `ChildProcess.kill` is a no-op once the handle closed. So a kill can never
 * reach a recycled pid.
 */

import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { ChildCostRegistry } from '@camstack/types/node'
import type { ForkDecodeWorkerDeps } from './fork-decode-worker.js'
import type { ForkedChildLike } from './session-decode-coordinator.js'
import type { VideoFrameSource } from './video-frame-generator.js'

/** The part of a forked worker this set needs. */
export interface LiveDecodeWorker {
  readonly deviceId: number
  readonly pid: number | undefined
  /** SIGKILL the process. Must not throw for a process that already exited. */
  readonly killNow: () => void
}

/** The logger surface every kill writes to. A kill is never silent. */
export type DecodeWorkerKillLogger = Pick<IScopedLogger, 'info' | 'warn'>

/** Why the runner killed a worker (the log line says which). */
export type DecodeWorkerKillReason = 'shutdown' | 'forked-after-shutdown' | 'process-exit'

const KILL_MESSAGE: Readonly<Record<DecodeWorkerKillReason, string>> = {
  shutdown: 'session-decode: worker killed at shutdown',
  'forked-after-shutdown': 'session-decode: worker forked after shutdown began — killed at once',
  'process-exit': 'session-decode: worker killed at process exit',
}

/** One worker a kill pass signalled, or failed to. */
interface KillOutcome {
  readonly worker: LiveDecodeWorker
  /** Null when the signal went out; the reason when `killNow` threw. */
  readonly error: string | null
}

/** Send the signal. Never throws: a failure is the outcome. */
function signal(worker: LiveDecodeWorker): KillOutcome {
  try {
    worker.killNow()
    return { worker, error: null }
  } catch (err) {
    return { worker, error: errMsg(err) }
  }
}

/**
 * One line per outcome, each in its own swallowing try. The logger may throw:
 * the `'exit'` hook runs while the transport goes down, and the runner's
 * write path has no guard. A line that fails must not cost another line.
 */
function logOutcomes(
  outcomes: readonly KillOutcome[],
  reason: DecodeWorkerKillReason,
  logger: DecodeWorkerKillLogger,
): void {
  for (const { worker, error } of outcomes) {
    try {
      if (error === null) {
        logger.info(KILL_MESSAGE[reason], {
          tags: { deviceId: worker.deviceId },
          meta: { pid: worker.pid ?? null, signal: 'SIGKILL', reason },
        })
      } else {
        logger.warn('session-decode: worker kill failed — it may outlive the runner', {
          tags: { deviceId: worker.deviceId },
          meta: { pid: worker.pid ?? null, reason, error },
        })
      }
    } catch {
      // The kill already happened (or its failure is kept for a retry); only
      // the line is lost.
    }
  }
}

export class LiveDecodeWorkers {
  private readonly live = new Set<LiveDecodeWorker>()
  /** Set by {@link close}: from then on a worker is killed as it is added. */
  private closedLogger: DecodeWorkerKillLogger | null = null

  /** Track a forked worker; call the returned function from its real exit. */
  add(worker: LiveDecodeWorker): () => void {
    if (this.closedLogger !== null) {
      const outcome = signal(worker)
      logOutcomes([outcome], 'forked-after-shutdown', this.closedLogger)
      if (outcome.error === null) return (): void => undefined
    }
    this.live.add(worker)
    return (): void => {
      this.live.delete(worker)
    }
  }

  get size(): number {
    return this.live.size
  }

  /**
   * SIGKILL every tracked worker now, then one log line per worker. SIGKILL
   * rather than SIGTERM: the runner is about to exit and cannot wait for a
   * fallback, and a worker blocked in a native call never runs a SIGTERM
   * handler (D652).
   *
   * EVERY worker is signalled before ANY line is written: a logger that throws
   * must not stop the kills. A signalled worker is forgotten (a second pass
   * logs nothing twice); one whose kill threw stays tracked, so the exit hook
   * or a later pass tries it again. Returns how many it signalled.
   */
  killAll(reason: DecodeWorkerKillReason, logger: DecodeWorkerKillLogger): number {
    const outcomes = [...this.live].map(signal)
    for (const outcome of outcomes) {
      if (outcome.error === null) this.live.delete(outcome.worker)
    }
    logOutcomes(outcomes, reason, logger)
    return outcomes.filter((outcome) => outcome.error === null).length
  }

  /** Kill everything tracked, and kill every later `add` at once. */
  close(reason: DecodeWorkerKillReason, logger: DecodeWorkerKillLogger): number {
    this.closedLogger = logger
    return this.killAll(reason, logger)
  }
}

/** The `process` surface {@link RunnerDecodeWorkers} hooks. */
export interface ExitHookProcess {
  once(event: 'exit', listener: () => void): unknown
  removeListener(event: 'exit', listener: () => void): unknown
}

/** The fork {@link RunnerDecodeWorkers} wraps: `forkDecodeWorker` in production. */
export type DecodeWorkerFork = (
  source: VideoFrameSource,
  deps: ForkDecodeWorkerDeps,
) => ForkedChildLike

export interface RunnerDecodeWorkersDeps {
  readonly fork: DecodeWorkerFork
  readonly costRegistry: ChildCostRegistry
  readonly logger: DecodeWorkerKillLogger
  readonly process: ExitHookProcess
}

/**
 * The runner's decode workers: every fork is registered in the set, and
 * {@link shutdown} and any process exit kill whatever is still alive.
 */
export class RunnerDecodeWorkers {
  private readonly live = new LiveDecodeWorkers()
  private exitHookArmed = false
  private shutDown = false

  constructor(private readonly deps: RunnerDecodeWorkersDeps) {}

  /** Fork one worker, registered and cost-claimed. */
  readonly fork = (source: VideoFrameSource): ForkedChildLike => {
    this.armExitHook()
    return this.deps.fork(source, { costRegistry: this.deps.costRegistry, liveWorkers: this.live })
  }

  /**
   * The addon is shutting down: kill every worker, and every later fork at
   * once. Synchronous, so it is done before the runner's `process.exit`.
   */
  shutdown(): number {
    this.shutDown = true
    const killed = this.live.close('shutdown', this.deps.logger)
    // A worker whose kill threw is still tracked: keep the exit hook for it,
    // it is the last retry before the runner goes.
    if (this.live.size === 0) this.disarmExitHook()
    return killed
  }

  /**
   * The process is exiting without having shut this addon down (an uncaught
   * error, or an `onShutdown` that never reached {@link shutdown}). The log
   * line is attempted but will probably not land: the transport goes down
   * with the process.
   */
  private readonly onProcessExit = (): void => {
    this.exitHookArmed = false
    this.live.close('process-exit', this.deps.logger)
  }

  private armExitHook(): void {
    if (this.exitHookArmed || this.shutDown) return
    this.exitHookArmed = true
    this.deps.process.once('exit', this.onProcessExit)
  }

  private disarmExitHook(): void {
    if (!this.exitHookArmed) return
    this.exitHookArmed = false
    this.deps.process.removeListener('exit', this.onProcessExit)
  }
}
