/**
 * The snapshot worker — a thread of the process that OWNS a live SQLite
 * database, whose one job is a consistent, verified copy of it (D693).
 *
 * - Its OWN read-only connection to the live file, in the owner's process: the
 *   same footing as the checkpoint worker (D452, D679). No other process opens
 *   the database, and no filesystem call here touches the `.db`, `-wal` or
 *   `-shm` — the copy is written by SQLite's online backup API.
 * - ONE read transaction for the whole copy. `BEGIN`, then the row count of
 *   every b-tree table, then every backup step: they all read the same pinned
 *   WAL snapshot. Writes on the settings connection go on (a WAL reader blocks
 *   no writer) and do NOT restart the copy, because the backup never opens a
 *   read transaction of its own. Without the pin, every write between two
 *   steps would restart the copy from page 1 — forever, on a hub that writes
 *   every second.
 * - The copy is checked before anyone may call it a snapshot: switched to
 *   `journal_mode = DELETE` (one self-contained file), `PRAGMA integrity_check`
 *   must answer exactly `ok`, and every table's row count must EQUAL the count
 *   read in the pinned transaction. The caller renames it into place only on
 *   `done`.
 * - It runs on a thread because both halves are long and synchronous at the
 *   scale of the hub's ~800 MB file: on the settings thread they would stall
 *   every configuration read in the cluster (the D447 failure).
 *
 * A worker entry is a separate bundle (`dist/sqlite-snapshot-worker.js`, wired
 * in `vite.config.ts` next to `wal-checkpoint-worker`). The functions are
 * exported so a spec can drive them in-process; the thread body runs only when
 * this module is loaded AS the snapshot thread.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import type { DatabaseSnapshotTable } from '@camstack/types'
import Database from 'better-sqlite3'
import {
  isSnapshotWorkerData,
  type SnapshotRefused,
  SnapshotRefusedError,
  type SnapshotWorkerData,
  type SnapshotWorkerMessage,
  type VerifiedCopy,
} from './sqlite-snapshot-protocol.js'

/** The pinned half: when it was taken, what it holds, how long it took. */
export interface PinnedCopy {
  readonly takenAt: number
  readonly tables: readonly DatabaseSnapshotTable[]
  readonly copyMs: number
}

/** The checked half. */
export interface CopyCheck {
  readonly pageCount: number
  readonly pageSize: number
  readonly verifyMs: number
}

/** Every table with its own b-tree (a virtual table has none: `rootpage = 0`). */
const BTREE_TABLES_SQL =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND rootpage > 0 ORDER BY name"

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function readNames(db: Database.Database): string[] {
  const out: string[] = []
  for (const row of db.prepare(BTREE_TABLES_SQL).all()) {
    if (typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string') {
      out.push(row.name)
    }
  }
  return out
}

function countRows(db: Database.Database, table: string): number {
  const row: unknown = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get()
  if (typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number') {
    return row.n
  }
  throw new Error(`count(*) of ${table} answered no number`)
}

function readTables(db: Database.Database): DatabaseSnapshotTable[] {
  return readNames(db).map((name) => ({ name, rows: countRows(db, name) }))
}

/**
 * Copy `source` into `copyPath` from ONE read transaction. `onStep` observes
 * each backup step (a spec interleaves writes there).
 */
export async function copyPinned(
  source: Database.Database,
  copyPath: string,
  pagesPerStep: number,
  onStep?: () => void,
): Promise<PinnedCopy> {
  const started = Date.now()
  source.exec('BEGIN')
  try {
    // The first read opens the transaction; everything after reads its snapshot.
    const tables = readTables(source)
    const takenAt = Date.now()
    await source.backup(copyPath, {
      progress: () => {
        onStep?.()
        return pagesPerStep
      },
    })
    return { takenAt, tables, copyMs: Date.now() - started }
  } finally {
    source.exec('COMMIT')
  }
}

function integrityAnswer(db: Database.Database): string[] {
  const out: string[] = []
  for (const row of db.prepare('PRAGMA integrity_check').all()) {
    if (typeof row === 'object' && row !== null && 'integrity_check' in row) {
      out.push(String(row.integrity_check))
    }
  }
  return out
}

function describeCountMismatch(
  expected: readonly DatabaseSnapshotTable[],
  actual: readonly DatabaseSnapshotTable[],
): string | null {
  const got = new Map(actual.map((t) => [t.name, t.rows]))
  const want = new Map(expected.map((t) => [t.name, t.rows]))
  const diffs: string[] = []
  for (const [name, rows] of want) {
    const copyRows = got.get(name)
    if (copyRows === undefined) diffs.push(`${name}: missing from the copy (source ${rows})`)
    else if (copyRows !== rows) diffs.push(`${name}: copy ${copyRows} ≠ source ${rows}`)
  }
  for (const name of got.keys()) {
    if (!want.has(name)) diffs.push(`${name}: in the copy, not in the source`)
  }
  return diffs.length === 0 ? null : diffs.join('; ')
}

/**
 * The answer of `PRAGMA journal_mode = DELETE` must be `delete`. SQLite answers
 * the mode it is IN, so a switch it could not make comes back as `wal` with no
 * error — and a copy left in WAL needs sidecars that will not travel with it.
 */
export function requireRollbackJournal(answer: unknown): void {
  if (answer !== 'delete') {
    throw new SnapshotRefusedError(
      'failed',
      `the copy stayed in journal mode ${String(answer)} — it would need sidecars to be read`,
    )
  }
}

/**
 * Check a copy against what the pinned source held. Makes the copy one
 * self-contained file first. Throws {@link SnapshotRefusedError}.
 */
export function verifyCopy(
  copyPath: string,
  expected: readonly DatabaseSnapshotTable[],
): CopyCheck {
  const started = Date.now()
  const db = new Database(copyPath)
  try {
    // The backup copied page 1 as it was: the header still says WAL. Switch the
    // copy to a rollback journal so it is ONE file — no sidecar to lose, none
    // to mispair on restore.
    requireRollbackJournal(db.pragma('journal_mode = DELETE', { simple: true }))
    const answer = integrityAnswer(db)
    if (answer.length !== 1 || answer[0] !== 'ok') {
      throw new SnapshotRefusedError('integrity', answer.slice(0, 5).join(' | '))
    }
    const mismatch = describeCountMismatch(expected, readTables(db))
    if (mismatch !== null) throw new SnapshotRefusedError('row-count', mismatch)
    const pageCount = db.pragma('page_count', { simple: true })
    const pageSize = db.pragma('page_size', { simple: true })
    if (typeof pageCount !== 'number' || typeof pageSize !== 'number') {
      throw new Error('page_count / page_size answered no number')
    }
    return { pageCount, pageSize, verifyMs: Date.now() - started }
  } finally {
    db.close()
  }
}

/** The whole job: open the live database read-only, copy it pinned, check the copy. */
export async function takeVerifiedCopy(data: SnapshotWorkerData): Promise<VerifiedCopy> {
  const source = new Database(data.livePath, { readonly: true })
  let pinned: PinnedCopy
  try {
    // A copy-only connection: a small page cache and no mmap, so it is not a
    // second copy of the engine's working set.
    source.pragma('cache_size = -2048')
    source.pragma('mmap_size = 0')
    source.pragma('busy_timeout = 5000')
    pinned = await copyPinned(source, data.copyPath, data.pagesPerStep)
  } finally {
    source.close()
  }
  const check = verifyCopy(data.copyPath, pinned.tables)
  return {
    takenAt: pinned.takenAt,
    tables: pinned.tables,
    pageCount: check.pageCount,
    pageSize: check.pageSize,
    copyMs: pinned.copyMs,
    verifyMs: check.verifyMs,
  }
}

function toRefusal(err: unknown): SnapshotRefused {
  if (err instanceof SnapshotRefusedError) {
    return { kind: 'refused', reason: err.reason, detail: err.detail }
  }
  return {
    kind: 'refused',
    reason: 'failed',
    detail: err instanceof Error ? err.message : String(err),
  }
}

async function run(data: SnapshotWorkerData): Promise<void> {
  const port = parentPort
  if (port === null) throw new Error('sqlite-snapshot-worker: no parent port')
  let message: SnapshotWorkerMessage
  try {
    message = { kind: 'done', copy: await takeVerifiedCopy(data) }
  } catch (err) {
    message = toRefusal(err)
  }
  port.postMessage(message)
  port.close()
}

if (!isMainThread && isSnapshotWorkerData(workerData)) {
  void run(workerData)
}
