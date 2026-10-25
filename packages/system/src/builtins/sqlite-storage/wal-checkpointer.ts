/**
 * The settings thread's side of the checkpoint worker: starts it, reads its
 * reports, decides what is worth a line, and stops it before the engine
 * closes. Why the checkpoint runs on a worker at all is in
 * `wal-checkpoint-policy.ts`.
 *
 * ## What is logged, and why that much
 *
 * A checkpoint every 12–25 s is ~200 an hour: one line each would be the
 * chattiest thing in the runner's log. So:
 *
 * - a checkpoint that HELD the worker past {@link WAL_CHECKPOINT_SLOW_MS} is a
 *   WARN with its numbers — this is the disk-wait event the profiler used to
 *   file as a slow `set` on the settings thread, and its reappearance rate
 *   is the before/after measurement of D452;
 * - every {@link WAL_CHECKPOINT_SUMMARY_INTERVAL_MS} an INFO summary: how
 *   many ran, how many frames, the longest, how many were slow;
 * - a worker that dies is an ERROR naming what now bounds the WAL — the
 *   engine's own `wal_autocheckpoint`, raised to a bound ten times the
 *   default (`SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES`) so it never fires while
 *   the worker is alive and still fires if it is not. No respawn: the bound
 *   is the fallback, and a thread that dies twice needs a person.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  type CheckpointReport,
  isWorkerMessage,
  WAL_CHECKPOINT_LARGE_PASS_FRAMES,
  WAL_CHECKPOINT_MAX_DELAY_MS,
  WAL_CHECKPOINT_POLL_MS,
  WAL_CHECKPOINT_SLOW_MS,
  type WalCheckpointWorkerData,
  type WorkerMessage,
  type WorkerStop,
} from './wal-checkpoint-policy.js'

/** How often the running totals are written as one INFO line, in ms. */
export const WAL_CHECKPOINT_SUMMARY_INTERVAL_MS: number = 10 * 60_000

/** Running totals since the last summary. Exposed for tests. */
export interface WalCheckpointStats {
  readonly checkpoints: number
  readonly frames: number
  readonly slow: number
  readonly maxMs: number
  readonly totalMs: number
  readonly busy: number
  /** Passes that folded more than `WAL_CHECKPOINT_LARGE_PASS_FRAMES` appended frames. */
  readonly large: number
  /** The most appended frames one pass found. */
  readonly maxAppended: number
}

const EMPTY_STATS: WalCheckpointStats = {
  checkpoints: 0,
  frames: 0,
  slow: 0,
  maxMs: 0,
  totalMs: 0,
  busy: 0,
  large: 0,
  maxAppended: 0,
}

/**
 * The members of a `Worker` this class touches. Structural, so the unit spec
 * drives an `EventEmitter` through the same surface without a cast.
 */
export interface CheckpointWorkerHandle {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
}

/** The one impure step — spawning the thread — injectable for the unit spec. */
export type WorkerFactory = (workerData: WalCheckpointWorkerData) => CheckpointWorkerHandle

/**
 * Where the built worker entry lives: `dist/wal-checkpoint-worker.js` at the
 * package root, next to `addon-runner.js`, found through the package's own
 * `exports["./package.json"]` so it resolves the same way from the workspace
 * and from an installed closure.
 */
export function defaultWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@camstack/system/package.json'))
  return path.join(packageRoot, 'dist', 'wal-checkpoint-worker.js')
}

export interface WalCheckpointerOptions {
  readonly dbPath: string
  readonly logger: IScopedLogger
  readonly pollMs?: number
  readonly maxDelayMs?: number
  readonly slowMs?: number
  readonly summaryIntervalMs?: number
  /** Overrides the built entry — a spec points this at the TypeScript source. */
  readonly workerPath?: string
  /** Extra `execArgv` for the thread — a spec passes a loader here. */
  readonly workerExecArgv?: readonly string[]
  readonly workerFactory?: WorkerFactory
}

export class WalCheckpointer {
  private readonly dbPath: string
  private readonly logger: IScopedLogger
  private readonly pollMs: number
  private readonly maxDelayMs: number
  private readonly slowMs: number
  private readonly summaryIntervalMs: number
  private readonly spawn: WorkerFactory
  private worker: CheckpointWorkerHandle | null = null
  private summaryTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private statsValue: WalCheckpointStats = EMPTY_STATS

  constructor(options: WalCheckpointerOptions) {
    this.dbPath = options.dbPath
    this.logger = options.logger
    this.pollMs = options.pollMs ?? WAL_CHECKPOINT_POLL_MS
    this.maxDelayMs = options.maxDelayMs ?? WAL_CHECKPOINT_MAX_DELAY_MS
    this.slowMs = options.slowMs ?? WAL_CHECKPOINT_SLOW_MS
    this.summaryIntervalMs = options.summaryIntervalMs ?? WAL_CHECKPOINT_SUMMARY_INTERVAL_MS
    const workerPath = options.workerPath ?? defaultWorkerPath()
    const execArgv = options.workerExecArgv
    this.spawn =
      options.workerFactory ??
      ((workerData) =>
        new Worker(workerPath, {
          workerData,
          ...(execArgv !== undefined ? { execArgv: [...execArgv] } : {}),
        }))
  }

  /** Totals since the last summary line. */
  get stats(): WalCheckpointStats {
    return this.statsValue
  }

  isRunning(): boolean {
    return this.worker !== null
  }

  start(): void {
    if (this.worker !== null) return
    this.stopping = false
    const worker = this.spawn({
      dbPath: this.dbPath,
      pollMs: this.pollMs,
      maxDelayMs: this.maxDelayMs,
    })
    this.worker = worker
    worker.on('message', (message: unknown) => this.onMessage(message))
    worker.on('error', (err: unknown) => {
      this.logger.error('WAL checkpoint worker threw', { meta: { error: errMsg(err) } })
    })
    worker.on('exit', (code: number) => this.onExit(code))
    const summaryTimer = setInterval(() => this.logSummary(), this.summaryIntervalMs)
    summaryTimer.unref?.()
    this.summaryTimer = summaryTimer
    this.logger.info('WAL checkpoint worker armed', {
      meta: { pollMs: this.pollMs, maxDelayMs: this.maxDelayMs, slowMs: this.slowMs },
    })
  }

  /** Ask the thread to close its connection and exit; resolves when it has. */
  async stop(): Promise<void> {
    const worker = this.worker
    if (worker === null) return
    this.stopping = true
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer)
      this.summaryTimer = null
    }
    const stop: WorkerStop = { kind: 'stop' }
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    worker.postMessage(stop)
    await exited
    this.worker = null
  }

  /** One message off the port. Public so the spec can feed it directly. */
  onMessage(message: unknown): void {
    if (!isWorkerMessage(message)) {
      this.logger.warn('WAL checkpoint worker sent an unreadable message', {
        meta: { message: String(message) },
      })
      return
    }
    this.handle(message)
  }

  private handle(message: WorkerMessage): void {
    switch (message.kind) {
      case 'ready':
        return
      case 'failed':
        this.logger.warn('WAL checkpoint failed on the worker', { meta: { error: message.error } })
        return
      case 'checkpointed':
        this.record(message)
        return
    }
  }

  private record(report: CheckpointReport): void {
    const slow = report.ms >= this.slowMs
    // The first pass counts the whole WAL it found at boot as "appended";
    // that is not a gap the schedule let grow, so it is not judged.
    const large =
      report.reason === 'scheduled' && report.appendedFrames > WAL_CHECKPOINT_LARGE_PASS_FRAMES
    const prev = this.statsValue
    this.statsValue = {
      checkpoints: prev.checkpoints + 1,
      // Frames that passed through the WAL since the previous pass — what
      // the passes folded between them. `checkpointedFrames` is the WAL
      // cycle's running backfill total, so summing it would count a frame
      // once per pass that saw it.
      frames: prev.frames + report.appendedFrames,
      slow: prev.slow + (slow ? 1 : 0),
      maxMs: Math.max(prev.maxMs, report.ms),
      totalMs: prev.totalMs + report.ms,
      busy: prev.busy + (report.busy ? 1 : 0),
      large: prev.large + (large ? 1 : 0),
      maxAppended: Math.max(prev.maxAppended, report.appendedFrames),
    }
    if (large && prev.large === 0) {
      // Sampled: the first of each summary window; the rest are counted in
      // `large`. This is the field measurement `WAL_CHECKPOINT_MAX_DELAY_MS`
      // is tuned from (D679): a gap that let this much pile up was within 2×
      // of the engine fallback firing on the settings thread.
      this.logger.warn('WAL checkpoint pass found a large backlog', {
        meta: {
          appendedFrames: report.appendedFrames,
          thresholdFrames: WAL_CHECKPOINT_LARGE_PASS_FRAMES,
          walFrames: report.walFrames,
          nextDelayMs: report.nextDelayMs,
          maxDelayMs: this.maxDelayMs,
        },
      })
    }
    if (slow) {
      this.logger.warn('WAL checkpoint held the worker', {
        meta: {
          ms: report.ms,
          reason: report.reason,
          appendedFrames: report.appendedFrames,
          nextDelayMs: report.nextDelayMs,
          walFrames: report.walFrames,
          checkpointedFrames: report.checkpointedFrames,
          busy: report.busy,
        },
      })
    }
  }

  private logSummary(): void {
    const stats = this.statsValue
    this.statsValue = EMPTY_STATS
    if (stats.checkpoints === 0) return
    this.logger.info('WAL checkpoints on the worker', {
      meta: {
        windowMs: this.summaryIntervalMs,
        checkpoints: stats.checkpoints,
        frames: stats.frames,
        slow: stats.slow,
        maxMs: stats.maxMs,
        totalMs: stats.totalMs,
        busy: stats.busy,
        large: stats.large,
        maxAppended: stats.maxAppended,
      },
    })
  }

  private onExit(code: number): void {
    const wasStopping = this.stopping
    this.worker = null
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer)
      this.summaryTimer = null
    }
    if (wasStopping) return
    // Not a stop we asked for. The engine's own auto-checkpoint bound now
    // folds the WAL, inside a writer's commit again — say so, once, loudly.
    this.logger.error(
      'WAL checkpoint worker died — the engine autocheckpoint bound is now the only checkpoint',
      { meta: { exitCode: code, dbPath: this.dbPath } },
    )
  }
}
