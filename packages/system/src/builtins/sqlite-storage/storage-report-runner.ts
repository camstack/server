import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type {
  StorageReportWorkerData,
  StorageReportWorkerMessage,
} from './storage-report-worker.js'

/** Reads the `dbstat` rows of one database file, somewhere off the serving thread. */
export type StorageRowsReader = (dbPath: string) => Promise<readonly unknown[]>

/** `dist/storage-report-worker.js` at the package root (see `wal-checkpointer.ts`). */
export function defaultStorageReportWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@dominevo/server/system/package.json'))
  return path.join(packageRoot, 'dist', 'storage-report-worker.js')
}

function isMessage(value: unknown): value is StorageReportWorkerMessage {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  return value.kind === 'rows' || value.kind === 'failed'
}

/** Run the report on a worker thread with its own read-only connection. */
export function readStorageRowsInWorker(workerPath?: string): StorageRowsReader {
  return (dbPath) =>
    new Promise((resolve, reject) => {
      const data: StorageReportWorkerData = { storageReportPath: dbPath }
      const worker = new Worker(workerPath ?? defaultStorageReportWorkerPath(), {
        workerData: data,
      })
      let settled = false
      worker.on('message', (message: unknown) => {
        if (settled || !isMessage(message)) return
        settled = true
        if (message.kind === 'rows') resolve(message.rows)
        else reject(new Error(message.error))
      })
      worker.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      worker.on('exit', () => {
        if (settled) return
        settled = true
        reject(new Error('storage report thread exited without an answer'))
      })
    })
}
