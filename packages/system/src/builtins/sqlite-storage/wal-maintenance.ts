import { statSync } from 'node:fs'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type Database from 'better-sqlite3'

/**
 * Size at or above which the WAL is a candidate for a truncating checkpoint,
 * in bytes. 67108864 = **64 MiB**.
 *
 * Matched to `SQLITE_JOURNAL_SIZE_LIMIT_BYTES`: below this, the passive
 * mechanism (autocheckpoint + `journal_size_limit`) is doing its job and there
 * is nothing to reclaim. The live hub's WAL had reached 248,955,152 bytes —
 * roughly 2x the 130 MB database — which is what says the passive path alone
 * had stopped keeping up.
 */
export const WAL_HIGH_WATER_BYTES = 67_108_864

/**
 * How long the WAL must have gone UNWRITTEN before a truncating checkpoint is
 * allowed, in ms.
 *
 * This is the stall guard and the reason this file exists. `wal_checkpoint
 * (TRUNCATE)` takes the writer lock, waits for readers, and copies the whole
 * WAL back into the database — synchronously, on the thread that serves every
 * request. An unconditional periodic one on a busy NVR would be the disease
 * (hub-main already spends 42 s per 2 minutes inside uninterrupted blocks),
 * not the cure.
 *
 * The idle signal is the WAL file's own mtime. It is one `stat`, and unlike a
 * write counter maintained in this class it covers EVERY writer on the file —
 * the settings backend, the sqlite-vec index sharing the handle, and the
 * short-lived second connection system-backup opens. On a genuinely busy NVR
 * this gate simply never opens, and `journal_size_limit` remains the only
 * thing bounding the file. That is the intended failure mode: doing nothing is
 * strictly better than a 249 MB copy in the middle of a live request.
 */
export const WAL_IDLE_QUIET_MS = 30_000

/**
 * Ceiling on how long the checkpoint may wait for a lock, in ms.
 *
 * better-sqlite3 defaults `busy_timeout` to 5000. A checkpoint invokes the
 * busy handler while waiting for readers, so without this a "quiet" moment
 * that turns out not to be quiet could park the main thread for 5 s. 250 ms
 * means the checkpoint gives up and we try again on the next tick — the WAL
 * staying big for another minute costs nothing.
 */
export const WAL_CHECKPOINT_BUSY_TIMEOUT_MS = 250

/** How often the gate is evaluated, in ms. Cheap: a `stat` unless it fires. */
export const WAL_MAINTENANCE_INTERVAL_MS = 60_000

/**
 * Multiple of the high-water mark past which a persistently un-checkpointable
 * WAL stops being a debug line and becomes a warning. At 4x (256 MiB) the WAL
 * is bigger than the database and something is holding a read transaction
 * open; that is worth seeing in Loki.
 */
const WAL_ALARM_MULTIPLE = 4

/** What a single maintenance tick did. Every branch is named. */
export type WalMaintenanceOutcome =
  | { readonly kind: 'no-wal' }
  | { readonly kind: 'below-high-water'; readonly walBytes: number }
  | { readonly kind: 'deferred-not-idle'; readonly walBytes: number; readonly quietForMs: number }
  | {
      readonly kind: 'checkpointed'
      readonly beforeBytes: number
      readonly afterBytes: number
      readonly busy: boolean
      readonly walFrames: number
      readonly checkpointedFrames: number
    }
  | { readonly kind: 'failed'; readonly error: string }

/** Row shape SQLite returns from `PRAGMA wal_checkpoint(...)`. */
interface CheckpointRow {
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
}

function isCheckpointRow(value: unknown): value is CheckpointRow {
  if (typeof value !== 'object' || value === null) return false
  if (!('busy' in value) || !('log' in value) || !('checkpointed' in value)) return false
  return (
    typeof value.busy === 'number' &&
    typeof value.log === 'number' &&
    typeof value.checkpointed === 'number'
  )
}

/** Narrow `PRAGMA wal_checkpoint` output without a cast; null when unreadable. */
function readCheckpointResult(value: unknown): CheckpointRow | null {
  if (isCheckpointRow(value)) return value
  if (Array.isArray(value)) {
    const [first] = value
    if (isCheckpointRow(first)) return first
  }
  return null
}

/** Construction inputs for {@link WalMaintenance}. */
export interface WalMaintenanceOptions {
  readonly db: Database.Database
  /** Path to the main database file; the WAL is `${dbPath}-wal`. */
  readonly dbPath: string
  readonly logger: IScopedLogger
  readonly highWaterBytes?: number
  readonly idleQuietMs?: number
  readonly intervalMs?: number
  readonly busyTimeoutMs?: number
  /**
   * Pages to hand back to the filesystem per idle tick with
   * `PRAGMA incremental_vacuum(N)`. Absent or 0 = never. Only a file created
   * with `auto_vacuum = INCREMENTAL` (D851) has a freelist this can shrink; on
   * any other the pragma is a no-op, and the tick checks the mode first so it
   * does not even try.
   */
  readonly incrementalVacuumPages?: number
}

/**
 * Periodic, heavily gated `wal_checkpoint(TRUNCATE)`.
 *
 * The interesting behaviour is all refusal. A tick costs one `stat` in the
 * common case; it escalates to a lock-taking checkpoint only when the WAL is
 * over the high-water mark AND nothing has written to it for
 * {@link WAL_IDLE_QUIET_MS}, and even then the wait is bounded to
 * {@link WAL_CHECKPOINT_BUSY_TIMEOUT_MS}.
 */
export class WalMaintenance {
  private readonly db: Database.Database
  private readonly walPath: string
  private readonly logger: IScopedLogger
  private readonly highWaterBytes: number
  private readonly idleQuietMs: number
  private readonly intervalMs: number
  private readonly busyTimeoutMs: number
  private readonly incrementalVacuumPages: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: WalMaintenanceOptions) {
    this.db = options.db
    this.walPath = `${options.dbPath}-wal`
    this.logger = options.logger
    this.highWaterBytes = options.highWaterBytes ?? WAL_HIGH_WATER_BYTES
    this.idleQuietMs = options.idleQuietMs ?? WAL_IDLE_QUIET_MS
    this.intervalMs = options.intervalMs ?? WAL_MAINTENANCE_INTERVAL_MS
    this.busyTimeoutMs = options.busyTimeoutMs ?? WAL_CHECKPOINT_BUSY_TIMEOUT_MS
    this.incrementalVacuumPages = options.incrementalVacuumPages ?? 0
  }

  start(): void {
    if (this.timer !== null) return
    const timer = setInterval(() => {
      this.runOnce()
      this.vacuumOnce()
    }, this.intervalMs)
    timer.unref?.()
    this.timer = timer
    this.logger.info('WAL maintenance armed', {
      meta: {
        intervalMs: this.intervalMs,
        highWaterBytes: this.highWaterBytes,
        idleQuietMs: this.idleQuietMs,
      },
    })
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  /**
   * Give up to `incrementalVacuumPages` free pages back, when the file is in
   * incremental auto-vacuum mode, has a freelist, and nothing has written for
   * the idle window (the same gate the checkpoint uses — reclaiming pages
   * takes the writer lock). Returns the pages released; 0 when it did nothing.
   * Never throws.
   */
  vacuumOnce(): number {
    if (this.incrementalVacuumPages <= 0) return 0
    try {
      if (this.db.pragma('auto_vacuum', { simple: true }) !== 2) return 0
      const free = this.db.pragma('freelist_count', { simple: true })
      if (typeof free !== 'number' || free <= 0) return 0
      const stat = this.statWal()
      if (stat !== null && Math.max(0, Date.now() - stat.mtimeMs) < this.idleQuietMs) return 0
      const pages = Math.min(free, this.incrementalVacuumPages)
      this.db.pragma(`incremental_vacuum(${pages})`)
      this.logger.debug('incremental vacuum released free pages', {
        meta: { pages, freeBefore: free },
      })
      return pages
    } catch (err) {
      this.logger.warn('incremental vacuum failed', { meta: { error: errMsg(err) } })
      return 0
    }
  }

  /** Evaluate the gate once and act. Never throws. */
  runOnce(): WalMaintenanceOutcome {
    try {
      return this.evaluate()
    } catch (err) {
      const error = errMsg(err)
      this.logger.warn('WAL maintenance tick failed', { meta: { error, walPath: this.walPath } })
      return { kind: 'failed', error }
    }
  }

  private evaluate(): WalMaintenanceOutcome {
    const stat = this.statWal()
    if (stat === null) return { kind: 'no-wal' }

    if (stat.size < this.highWaterBytes) {
      return { kind: 'below-high-water', walBytes: stat.size }
    }

    const quietForMs = Date.now() - stat.mtimeMs
    if (quietForMs < this.idleQuietMs) {
      // Work deliberately NOT done — say so, or a WAL that never gets
      // reclaimed looks like a checkpoint that never ran.
      const meta = { walBytes: stat.size, quietForMs, idleQuietMs: this.idleQuietMs }
      if (stat.size >= this.highWaterBytes * WAL_ALARM_MULTIPLE) {
        this.logger.warn(
          'WAL checkpoint deferred: file far over high-water and still being written',
          { meta },
        )
      } else {
        this.logger.debug('WAL checkpoint deferred: database is not idle', { meta })
      }
      return { kind: 'deferred-not-idle', walBytes: stat.size, quietForMs }
    }

    return this.checkpoint(stat.size)
  }

  /**
   * Take the writer lock and fold the WAL back, with the wait bounded.
   *
   * The original `busy_timeout` is restored in a `finally`: this connection is
   * shared with the settings backend and the vector index, and leaving them on
   * a 250 ms timeout would turn an ordinary contended write into a spurious
   * SQLITE_BUSY.
   */
  private checkpoint(beforeBytes: number): WalMaintenanceOutcome {
    const previousTimeout = this.db.pragma('busy_timeout', { simple: true })
    this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`)
    let raw: unknown
    try {
      raw = this.db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      if (typeof previousTimeout === 'number') {
        this.db.pragma(`busy_timeout = ${previousTimeout}`)
      }
    }

    const result = readCheckpointResult(raw)
    const afterBytes = this.statWal()?.size ?? 0
    const outcome: WalMaintenanceOutcome = {
      kind: 'checkpointed',
      beforeBytes,
      afterBytes,
      busy: result !== null && result.busy !== 0,
      walFrames: result?.log ?? -1,
      checkpointedFrames: result?.checkpointed ?? -1,
    }
    this.logger.info('WAL truncating checkpoint completed', {
      meta: {
        beforeBytes,
        afterBytes,
        reclaimedBytes: beforeBytes - afterBytes,
        busy: outcome.busy,
        walFrames: outcome.walFrames,
        checkpointedFrames: outcome.checkpointedFrames,
      },
    })
    return outcome
  }

  private statWal(): { readonly size: number; readonly mtimeMs: number } | null {
    try {
      const s = statSync(this.walPath)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      // Missing sidecar = no WAL to reclaim. Not an error worth a line every
      // minute on a node whose database is idle.
      return null
    }
  }
}
