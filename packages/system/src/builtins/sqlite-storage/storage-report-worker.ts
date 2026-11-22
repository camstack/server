/**
 * The storage-report worker — a thread of the process that OWNS a database,
 * whose one job is the `dbstat` aggregate behind the boot "biggest tables" line.
 *
 * `dbstat` reads EVERY page of the file. On the serving connection, whose
 * `mmap_size` covers the whole file, that made every page resident in the
 * runner (events.db 1.9 GiB + history.db 1 GiB: a ~3.5 GB RSS spike a minute
 * after boot, decaying over ~20 minutes). Here it runs on its OWN read-only
 * connection with the map off and a small page cache — the same footing as the
 * snapshot worker (D693 §1: a read-only connection opened by the owner, D679),
 * and off the serving thread, because the scan is long and synchronous.
 *
 * A worker entry is a separate bundle (`dist/storage-report-worker.js`, wired in
 * `vite.config.ts`). {@link readStorageRows} is exported so a spec can drive it
 * in-process; the thread body runs only when this module is loaded AS the thread.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'

/** Page cache of the report connection (negative = KiB for SQLite). */
export const STORAGE_REPORT_CACHE_PRAGMA = -2048

// dbstat groups by OBJECT, and an index is an object. The join adds what dbstat
// cannot know: whether the object is a table or an index, and which table an
// index belongs to — the only trustworthy ownership signal, since index names
// carry none.
export const STORAGE_REPORT_SQL = `SELECT d.name AS name,
                  COALESCE(m.tbl_name, d.name) AS tableName,
                  SUM(d.pgsize) AS bytes,
                  COUNT(*) AS pages,
                  COALESCE(m.type, 'unknown') AS kind
             FROM dbstat d
             LEFT JOIN sqlite_master m ON m.name = d.name
            GROUP BY d.name, m.tbl_name, m.type`

/** What the thread is told. */
export interface StorageReportWorkerData {
  readonly storageReportPath: string
}

export type StorageReportWorkerMessage =
  | { readonly kind: 'rows'; readonly rows: readonly unknown[] }
  | { readonly kind: 'failed'; readonly error: string }

export function isStorageReportWorkerData(value: unknown): value is StorageReportWorkerData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'storageReportPath' in value &&
    typeof value.storageReportPath === 'string'
  )
}

/** Open the report connection: read-only, no map, a small cache. */
export function openReportConnection(livePath: string): Database.Database {
  const db = new Database(livePath, { readonly: true })
  db.pragma(`cache_size = ${STORAGE_REPORT_CACHE_PRAGMA}`)
  db.pragma('mmap_size = 0')
  db.pragma('busy_timeout = 5000')
  return db
}

/** The `dbstat` rows of one file, read through {@link openReportConnection}. */
export function readStorageRows(livePath: string): unknown[] {
  const db = openReportConnection(livePath)
  try {
    return db.prepare(STORAGE_REPORT_SQL).all()
  } finally {
    db.close()
  }
}

function run(data: StorageReportWorkerData): void {
  const port = parentPort
  if (port === null) throw new Error('storage-report-worker: no parent port')
  let message: StorageReportWorkerMessage
  try {
    message = { kind: 'rows', rows: readStorageRows(data.storageReportPath) }
  } catch (err) {
    message = { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  port.postMessage(message)
  port.close()
}

if (!isMainThread && isStorageReportWorkerData(workerData)) {
  run(workerData)
}
