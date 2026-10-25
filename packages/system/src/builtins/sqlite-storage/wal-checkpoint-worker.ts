/**
 * The checkpoint worker — a thread of `hub/sqlite-settings` whose only job is
 * `PRAGMA wal_checkpoint(PASSIVE)` over its own connection.
 *
 * Why it exists, the measurement, and the rule it follows are in
 * `wal-checkpoint-policy.ts`. What this file adds is the mechanics:
 *
 * - Its OWN connection to the same file. A checkpoint's fsyncs happen on the
 *   thread that issues the pragma; issuing it here is what takes them off the
 *   settings thread. The connection is sized to do nothing but checkpoint —
 *   a 2 MiB page cache and no mmap — so it is not a second copy of the
 *   engine's working set.
 * - PASSIVE, never FULL/RESTART/TRUNCATE. PASSIVE takes no writer lock and
 *   waits for nobody: it copies what it can and returns. The settings thread's
 *   writers and readers are never blocked by this thread. (The idle-gated
 *   TRUNCATE in `wal-maintenance.ts` is a different job — reclaiming a
 *   sidecar that outgrew its limit — and stays where it is.)
 * - It NEVER touches a SQLite file except through that connection — no
 *   `open`/`read`/`close` of the `.db`, `-wal` or `-shm`. Until 2026-09-29 it
 *   read the wal-index header out of `-shm` once a second, and each
 *   `closeSync` dropped every fcntl lock this PROCESS held on the file —
 *   SQLite's DMS lock included — which let the nightly backup's connection
 *   rebuild the `-shm` under the runner's mappings: the SIGBUS of D468,
 *   diagnosed in D679. `scripts/check-sqlite-files-not-opened-by-fs.ts`
 *   refuses the pattern. The schedule is derived from the checkpoints'
 *   own answers instead (`nextCheckpointPlan`).
 * - Every checkpoint is reported to the parent with its numbers. The parent
 *   decides what is worth a line.
 *
 * A worker entry is a separate bundle (`dist/wal-checkpoint-worker.js`, wired
 * in `vite.config.ts` next to `addon-runner`). It imports nothing from the
 * kernel: it must load in a bare thread with `better-sqlite3` and the policy
 * module, nothing else.
 */
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import {
  type CheckpointObservation,
  type CheckpointReport,
  isWorkerStop,
  nextCheckpointPlan,
  type WalCheckpointWorkerData,
  workerStartObservation,
  type WorkerFailure,
  type WorkerMessage,
} from './wal-checkpoint-policy.js'

/** `PRAGMA wal_checkpoint` row shape. Narrowed, never cast. */
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

function readCheckpointRow(value: unknown): CheckpointRow | null {
  if (isCheckpointRow(value)) return value
  if (Array.isArray(value)) {
    const [first] = value
    if (isCheckpointRow(first)) return first
  }
  return null
}

function isWorkerData(value: unknown): value is WalCheckpointWorkerData {
  if (typeof value !== 'object' || value === null) return false
  if (!('dbPath' in value) || !('pollMs' in value) || !('maxDelayMs' in value)) return false
  return (
    typeof value.dbPath === 'string' &&
    typeof value.pollMs === 'number' &&
    typeof value.maxDelayMs === 'number'
  )
}

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message)
}

function run(): void {
  const port = parentPort
  if (port === null) throw new Error('wal-checkpoint-worker: no parent port')
  if (!isWorkerData(workerData)) throw new Error('wal-checkpoint-worker: bad workerData')
  const { dbPath, pollMs, maxDelayMs } = workerData

  const db = new Database(dbPath)
  // A checkpoint-only connection: nothing to cache, nothing to map.
  db.pragma('cache_size = -2048')
  db.pragma('mmap_size = 0')

  let previous: CheckpointObservation = workerStartObservation(Date.now())
  let first = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping = false

  const tick = (): void => {
    if (stopping) return
    const startedAt = Date.now()
    let raw: unknown = null
    try {
      raw = db.pragma('wal_checkpoint(PASSIVE)')
    } catch (err) {
      const failure: WorkerFailure = {
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
      post(failure)
    }
    const row = readCheckpointRow(raw)
    if (row === null) {
      // Nothing measured: try again at the longest gap, never faster — a
      // failing pragma must not become a once-a-second WARN.
      timer = setTimeout(tick, maxDelayMs)
      return
    }
    if (row.busy !== 0) {
      // Another checkpointer held the lock (the engine fallback, or the
      // idle-gated TRUNCATE in wal-maintenance): this answer measured
      // nothing. Keep the previous observation — adopting it would count the
      // whole WAL as new next time — and look again soon, because a busy
      // pass usually means the WAL is hot.
      const report: CheckpointReport = {
        kind: 'checkpointed',
        reason: first ? 'first' : 'scheduled',
        appendedFrames: 0,
        nextDelayMs: pollMs,
        walFrames: row.log,
        checkpointedFrames: row.checkpointed,
        busy: true,
        ms: Date.now() - startedAt,
      }
      post(report)
      timer = setTimeout(tick, pollMs)
      return
    }
    const current: CheckpointObservation = {
      at: Date.now(),
      walFrames: row.log,
      checkpointedFrames: row.checkpointed,
    }
    const plan = nextCheckpointPlan({ previous, current, minDelayMs: pollMs, maxDelayMs })
    const report: CheckpointReport = {
      kind: 'checkpointed',
      reason: first ? 'first' : 'scheduled',
      appendedFrames: plan.appendedFrames,
      nextDelayMs: plan.nextDelayMs,
      walFrames: row.log,
      checkpointedFrames: row.checkpointed,
      busy: row.busy !== 0,
      ms: current.at - startedAt,
    }
    post(report)
    previous = current
    first = false
    timer = setTimeout(tick, plan.nextDelayMs)
  }

  port.on('message', (message: unknown) => {
    if (!isWorkerStop(message)) return
    stopping = true
    if (timer !== null) clearTimeout(timer)
    try {
      db.close()
    } finally {
      port.close()
    }
  })

  post({ kind: 'ready' })
  timer = setTimeout(tick, pollMs)
}

run()
