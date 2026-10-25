/**
 * The owner's snapshot of its live SQLite database (D693) — the runner-side
 * half of the `database-snapshot` capability.
 *
 * It runs the copy on a worker thread (`sqlite-snapshot-worker.ts`) and owns
 * the files around it:
 *
 * - the work directory `<db>.backup-snapshot-partial/` — removed whole before
 *   a snapshot starts (a crash may have left one) and after it ends. It is a
 *   directory so a copy's transient sidecars are removed with it, without this
 *   process ever naming a SQLite sidecar;
 * - the final `<db>.backup-snapshot` — reached ONLY by renaming a copy the
 *   worker verified. A file under that name is always a verified copy. One a
 *   caller never collected (its call timed out, its run was cancelled) is
 *   removed at boot ({@link SqliteSnapshotter.sweep}) and before the next
 *   snapshot starts.
 *
 * Two refusals guard the live database:
 *
 * - **No space**, before any byte is copied. The copy lands on the live
 *   database's own disk while the pinned read makes the live WAL grow; running
 *   that disk full would fail the LIVE settings writes (`SQLITE_FULL`)
 *   cluster-wide. So the free space must cover the copy plus a reserve
 *   ({@link snapshotSpaceNeeded}). A free space nobody could read is `null`,
 *   never 0 (D393) — and it refuses too, saying it is unknown: a backup does
 *   not gamble the live database's disk.
 * - **Deadline.** A thread that stalls past {@link SNAPSHOT_DEADLINE_MS} gets
 *   the call refused at once and is terminated in the background. A native
 *   SQLite call cannot be interrupted, so until the termination settles a new
 *   snapshot is refused immediately rather than joined ({@link draining}).
 *   Without it, every later snapshot would join a never-settling promise.
 *
 * Nothing here opens, reads or closes the live `.db`, `-wal` or `-shm`
 * (D679): the live file is reached only by the worker's own connection, and
 * only `stat`ed here.
 *
 * One snapshot at a time: a second `write()` while one runs joins it.
 */
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  DATABASE_SNAPSHOT_TIMEOUT_MS,
  type DatabaseSnapshotResult,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'
import {
  isSnapshotWorkerMessage,
  type SnapshotRefused,
  type SnapshotWorkerData,
  type SnapshotWorkerMessage,
} from './sqlite-snapshot-protocol.js'

/**
 * Pages per backup step. Every step reads the same pinned transaction, so the
 * size only trades yields against per-step overhead: 1024 pages is 4 MiB at the
 * default page size.
 */
export const SNAPSHOT_PAGES_PER_STEP = 1024

/**
 * How long the snapshot thread may run before it is terminated. A minute under
 * the capability's own timeout, so the runner gives up — and says why — before
 * the caller's call does.
 */
export const SNAPSHOT_DEADLINE_MS: number = DATABASE_SNAPSHOT_TIMEOUT_MS - 60_000

/** The least headroom left on the disk AFTER the copy, whatever the database's size. */
export const SNAPSHOT_MIN_RESERVE_BYTES: number = 256 * 1024 * 1024

/**
 * Free bytes a snapshot needs before it may start: the copy (at most the
 * database plus its WAL), then a reserve the size of the database (at least
 * {@link SNAPSHOT_MIN_RESERVE_BYTES}) for the live writes and the WAL growth
 * the pinned read causes while the copy runs.
 */
export function snapshotSpaceNeeded(databaseBytes: number, walBytes: number): number {
  return databaseBytes + walBytes + Math.max(databaseBytes, SNAPSHOT_MIN_RESERVE_BYTES)
}

/** The `statfs` fields the space check reads. */
export interface DiskSpace {
  readonly bavail: number | bigint
  readonly bsize: number | bigint
}

export type StatfsFn = (dir: string) => Promise<DiskSpace>

/**
 * Where the built worker entry lives: `dist/sqlite-snapshot-worker.js` at the
 * package root, next to `wal-checkpoint-worker.js` (see `wal-checkpointer.ts`
 * for why it resolves through the package's own `package.json`).
 */
export function defaultSnapshotWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@camstack/system/package.json'))
  return path.join(packageRoot, 'dist', 'sqlite-snapshot-worker.js')
}

/**
 * The members of a snapshot thread this class uses. Structural, so a spec can
 * hand in a thread whose `terminate()` never settles — the stall a native call
 * that never returns would cause.
 */
export interface SnapshotWorkerHandle {
  onMessage(listener: (message: unknown) => void): void
  onError(listener: (err: Error) => void): void
  onExit(listener: (code: number) => void): void
  terminate(): Promise<unknown>
}

export type SnapshotWorkerFactory = (data: SnapshotWorkerData) => SnapshotWorkerHandle

export interface SqliteSnapshotterOptions {
  /** The live database this process owns. */
  readonly livePath: string
  readonly logger: IScopedLogger
  readonly pagesPerStep?: number
  /** Overrides the built entry — a spec points this at the TypeScript source. */
  readonly workerPath?: string
  /** Extra `execArgv` for the thread — a spec passes a loader here. */
  readonly workerExecArgv?: readonly string[]
  /** Overrides {@link SNAPSHOT_DEADLINE_MS}. */
  readonly deadlineMs?: number
  /** Overrides `fs.statfs` — a spec answers the space question here. */
  readonly statfs?: StatfsFn
  /** Overrides the thread itself — a spec hands in one that never terminates. */
  readonly spawnWorker?: SnapshotWorkerFactory
  /** Overrides the directory fsync — a spec makes it fail. */
  readonly syncDirectory?: (dir: string) => Promise<void>
}

/** A `stat` size: `0` when the file does not exist, `null` when it could not be read. */
async function sizeOrAbsent(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return 0
    return null
  }
}

/** Make a rename in `dir` durable: fsync the directory entry. */
async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await fsp.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class SqliteSnapshotter {
  private readonly livePath: string
  private readonly logger: IScopedLogger
  private readonly pagesPerStep: number
  private readonly deadlineMs: number
  private readonly statfs: StatfsFn
  private readonly spawnWorker: SnapshotWorkerFactory
  private readonly syncDirectory: (dir: string) => Promise<void>
  private inFlight: Promise<DatabaseSnapshotResult> | null = null
  /**
   * Set while a thread the deadline gave up on is still being terminated. A
   * native SQLite call cannot be interrupted, so `terminate()` may take as long
   * as that call — or never settle. Until it does, a new snapshot is refused
   * at once (never joined, never started beside a thread that may still hold
   * a pinned read), and the work directory stays until nobody writes into it.
   */
  private draining: Promise<void> | null = null

  constructor(options: SqliteSnapshotterOptions) {
    this.livePath = path.resolve(options.livePath)
    this.logger = options.logger
    this.pagesPerStep = options.pagesPerStep ?? SNAPSHOT_PAGES_PER_STEP
    this.deadlineMs = options.deadlineMs ?? SNAPSHOT_DEADLINE_MS
    this.statfs = options.statfs ?? ((dir) => fsp.statfs(dir))
    this.syncDirectory = options.syncDirectory ?? fsyncDirectory
    const workerPath = options.workerPath ?? null
    const execArgv = options.workerExecArgv
    this.spawnWorker =
      options.spawnWorker ??
      ((data) => {
        const worker = new Worker(workerPath ?? defaultSnapshotWorkerPath(), {
          workerData: data,
          ...(execArgv !== undefined ? { execArgv: [...execArgv] } : {}),
        })
        return {
          onMessage: (listener) => worker.on('message', listener),
          onError: (listener) => worker.on('error', listener),
          onExit: (listener) => worker.on('exit', listener),
          terminate: () => worker.terminate(),
        }
      })
  }

  /** The database this snapshotter copies, absolute. */
  get database(): string {
    return this.livePath
  }

  /** Write `<db>.backup-snapshot`. Joins a snapshot already running. */
  write(): Promise<DatabaseSnapshotResult> {
    if (this.inFlight !== null) return this.inFlight
    if (this.draining !== null) {
      return Promise.reject(
        new Error(
          'database snapshot refused (failed): the previous snapshot thread is still terminating — it timed out inside a call that has not returned',
        ),
      )
    }
    const run = this.run().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /**
   * Remove a snapshot nobody collected and a work directory a crash left.
   * Called at boot; {@link write} does the same before it starts.
   */
  async sweep(): Promise<void> {
    const snapshotPath = this.livePath + DATABASE_SNAPSHOT_SUFFIX
    const workDir = this.livePath + DATABASE_SNAPSHOT_PARTIAL_SUFFIX
    const leftover = (await sizeOrAbsent(snapshotPath)) !== 0
    await fsp.rm(snapshotPath, { force: true })
    await fsp.rm(workDir, { recursive: true, force: true })
    if (leftover) {
      this.logger.info('SQLite snapshot left by an earlier run removed — nobody collected it', {
        meta: { snapshotPath },
      })
    }
  }

  private refuse(message: SnapshotRefused): never {
    this.logger.warn('SQLite snapshot refused — no snapshot written', {
      meta: { livePath: this.livePath, reason: message.reason, detail: message.detail },
    })
    throw new Error(`database snapshot refused (${message.reason}): ${message.detail}`)
  }

  /** Refuses with `no-space` unless the disk can take the copy and keep its reserve. */
  private async checkSpace(): Promise<void> {
    const dir = path.dirname(this.livePath)
    const databaseBytes = await sizeOrAbsent(this.livePath)
    const walBytes = await sizeOrAbsent(`${this.livePath}-wal`)
    let freeBytes: number | null = null
    let statfsError: string | null = null
    try {
      const space = await this.statfs(dir)
      freeBytes = Number(space.bavail) * Number(space.bsize)
    } catch (err) {
      statfsError = errMsg(err)
    }
    if (databaseBytes === null || walBytes === null || freeBytes === null) {
      this.refuse({
        kind: 'refused',
        reason: 'no-space',
        detail: `free space on ${dir} is unknown (${statfsError ?? 'the database size could not be read'}) — a snapshot is never written onto a disk it cannot measure`,
      })
    }
    const needed = snapshotSpaceNeeded(databaseBytes, walBytes)
    if (freeBytes < needed) {
      this.refuse({
        kind: 'refused',
        reason: 'no-space',
        detail: `${freeBytes} bytes free on ${dir}, ${needed} needed (copy ${databaseBytes + walBytes} + reserve) — the live database shares this disk`,
      })
    }
  }

  private async run(): Promise<DatabaseSnapshotResult> {
    const workDir = this.livePath + DATABASE_SNAPSHOT_PARTIAL_SUFFIX
    const snapshotPath = this.livePath + DATABASE_SNAPSHOT_SUFFIX
    const copyPath = path.join(workDir, 'copy')
    await this.sweep()
    await this.checkSpace()
    await fsp.mkdir(workDir, { recursive: true })
    try {
      const message = await this.runWorker({
        kind: 'sqlite-snapshot',
        livePath: this.livePath,
        copyPath,
        pagesPerStep: this.pagesPerStep,
      })
      if (message.kind === 'refused') this.refuse(message)
      // Only a verified copy ever reaches the final name.
      await fsp.rename(copyPath, snapshotPath)
      try {
        await this.syncDirectory(path.dirname(snapshotPath))
      } catch (err) {
        // Durability of an ephemeral file is a nicety: the rename stands, and
        // the archive reads it in this same run.
        this.logger.warn('SQLite snapshot directory fsync failed — continuing', {
          meta: { dir: path.dirname(snapshotPath), error: errMsg(err) },
        })
      }
      const { size } = await fsp.stat(snapshotPath)
      const { copy } = message
      const result: DatabaseSnapshotResult = {
        livePath: this.livePath,
        snapshotPath,
        sizeBytes: size,
        pageCount: copy.pageCount,
        pageSize: copy.pageSize,
        tables: [...copy.tables],
        copyMs: copy.copyMs,
        verifyMs: copy.verifyMs,
        takenAt: copy.takenAt,
      }
      this.logger.info('SQLite snapshot written and verified', {
        meta: {
          snapshotPath,
          sizeBytes: size,
          pageCount: copy.pageCount,
          tables: copy.tables.length,
          rows: copy.tables.reduce((acc, t) => acc + t.rows, 0),
          copyMs: copy.copyMs,
          verifyMs: copy.verifyMs,
        },
      })
      return result
    } finally {
      const removeWorkDir = async (): Promise<void> => {
        try {
          await fsp.rm(workDir, { recursive: true, force: true })
        } catch (err) {
          this.logger.warn('SQLite snapshot work directory could not be removed', {
            meta: { workDir, error: errMsg(err) },
          })
        }
      }
      // A thread still terminating may still write into it: remove it after.
      if (this.draining !== null) void this.draining.then(removeWorkDir)
      else await removeWorkDir()
    }
  }

  private runWorker(data: SnapshotWorkerData): Promise<SnapshotWorkerMessage> {
    const worker = this.spawnWorker(data)
    return new Promise<SnapshotWorkerMessage>((resolve) => {
      let answered = false
      let terminating = false
      const answer = (message: SnapshotWorkerMessage): void => {
        if (answered) return
        answered = true
        clearTimeout(deadline)
        resolve(message)
      }
      // At the deadline the call is refused AT ONCE; the thread is terminated
      // in the background. `terminate()` cannot interrupt a native SQLite call
      // (an integrity_check, a step blocked on I/O), so its settling is not
      // awaited here — {@link draining} holds later snapshots off until it is.
      const deadline = setTimeout(() => {
        terminating = true
        this.logger.warn('SQLite snapshot thread missed its deadline — terminating it', {
          meta: { livePath: this.livePath, deadlineMs: this.deadlineMs },
        })
        const settled = worker.terminate().then(
          () => undefined,
          (err: unknown) => {
            this.logger.warn('SQLite snapshot thread terminate failed', {
              meta: { livePath: this.livePath, error: errMsg(err) },
            })
          },
        )
        this.draining = settled.then(() => {
          this.draining = null
        })
        answer({
          kind: 'refused',
          reason: 'failed',
          detail: `timed out after ${this.deadlineMs} ms — the snapshot thread is being terminated`,
        })
      }, this.deadlineMs)
      worker.onMessage((message) => {
        if (isSnapshotWorkerMessage(message)) answer(message)
        else answer({ kind: 'refused', reason: 'failed', detail: 'malformed worker message' })
      })
      worker.onError((err) => answer({ kind: 'refused', reason: 'failed', detail: errMsg(err) }))
      worker.onExit((code) => {
        // The deadline's own termination was already answered, with its reason.
        if (terminating) return
        answer({
          kind: 'refused',
          reason: 'failed',
          detail: `worker exited ${code} without an answer`,
        })
      })
    })
  }
}
