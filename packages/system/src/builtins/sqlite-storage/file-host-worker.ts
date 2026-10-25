/**
 * The thread that serves ONE database file of the engine (D851): its own
 * `better-sqlite3` connection hosting the same {@link SqliteSettingsBackend}
 * class `camstack.db` runs on the main thread, plus — for `events` — the
 * sqlite-vec index over that connection.
 *
 * A worker entry is a separate bundle (`dist/file-host-worker.js`, wired in
 * `vite.config.ts` next to the checkpoint and snapshot workers). It imports no
 * kernel code: the backend, the protocol and `@camstack/types`, nothing else.
 *
 * What it does NOT own: the WAL checkpoint, the `-shm` canary and the snapshot
 * of this file run in their own threads, started by the main thread's
 * `OwnedSqliteFile` exactly as for `camstack.db`. What it DOES own and the main
 * thread cannot reach: the connection itself — so the statement profiler and
 * the idle-gated `wal_checkpoint(TRUNCATE)` / `incremental_vacuum` live here.
 *
 * Logging: this thread has no logger of its own. Every line is posted to the
 * main thread, which writes it through the runner's `Db/<databaseId>` logger
 * with `tags: { database }`.
 */
import { threadId, parentPort, workerData } from 'node:worker_threads'
import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import {
  callControl,
  callData,
  callRecords,
  callVector,
  type DataTarget,
  controlTargetOf,
} from './file-host-handlers.js'
import {
  collectTransferables,
  type FileHostLogLevel,
  type FileHostMessage,
  type FileHostRequest,
  isFileHostRequest,
  isFileHostWorkerData,
  trustInput,
} from './file-host-protocol.js'
import { serializeError } from './placement-errors.js'
import { RecordsEngine } from './records/records-engine.js'
import { SqliteSettingsBackend } from './sqlite-settings-backend.js'
import { createVectorIndex, vectorProviderOf } from './vector-provider.js'
import type { SqliteVecVectorIndex } from './vector-index-vec.js'
import { WalMaintenance } from './wal-maintenance.js'

/** Pages handed back per idle tick on a file in incremental auto-vacuum mode. */
const INCREMENTAL_VACUUM_PAGES = 256

type Post = (message: FileHostMessage, transfer?: readonly ArrayBuffer[]) => void

/** A logger whose every line is a message to the main thread. */
function forwardingLogger(post: Post, scope: string, bound: LogTags): IScopedLogger {
  const send =
    (level: FileHostLogLevel) =>
    (message: string, extras?: LogExtras): void => {
      const tags: LogTags = { ...bound, ...extras?.tags }
      post({
        kind: 'log',
        level,
        message,
        scope,
        tags,
        ...(extras?.meta !== undefined ? { meta: extras.meta } : {}),
      })
    }
  return {
    debug: send('debug'),
    info: send('info'),
    warn: send('warn'),
    error: send('error'),
    child: (childScope) => forwardingLogger(post, childScope, bound),
    withTags: (tags) => forwardingLogger(post, scope, { ...bound, ...tags }),
  }
}

async function main(): Promise<void> {
  const port = parentPort
  if (port === null) throw new Error('file-host-worker: no parent port')
  if (!isFileHostWorkerData(workerData)) throw new Error('file-host-worker: bad workerData')
  const spec = workerData.spec
  const post: Post = (message, transfer = []) => port.postMessage(message, [...transfer])
  const logger = forwardingLogger(post, '', { database: spec.databaseId })

  let backend: SqliteSettingsBackend
  let vectorIndex: SqliteVecVectorIndex | null = null
  let maintenance: WalMaintenance | null = null
  try {
    backend = new SqliteSettingsBackend(spec.livePath, {}, logger.child('Query'), {
      databaseId: spec.databaseId,
      autoVacuum: spec.autoVacuum,
      canonicalKv: false,
    })
    await backend.initialize()
    if (spec.loadVectorExtension) {
      vectorIndex = createVectorIndex(backend, logger.child('VectorIndex'))
      await vectorIndex.loadIndexRegistry()
    }
    const db = backend.getDatabase()
    if (db !== null) {
      maintenance = new WalMaintenance({
        db,
        dbPath: spec.livePath,
        logger: logger.child('WalMaintenance'),
        incrementalVacuumPages: INCREMENTAL_VACUUM_PAGES,
      })
      maintenance.start()
    }
  } catch (err) {
    post({ kind: 'boot-failed', error: serializeError(err) })
    return
  }

  const dataTarget: DataTarget = backend
  const db = backend.getDatabase()
  // `history.db` has its own data model (D850): it never hosts records.
  const recordsEngine =
    db === null || spec.databaseId === 'history'
      ? null
      : new RecordsEngine(db, { databaseId: spec.databaseId, logger: logger.child('Records') })
  const vectorTarget = vectorIndex === null ? null : vectorProviderOf(vectorIndex)
  const control = controlTargetOf(backend, threadId)

  // Only a vector answer transfers its buffers; rows are cloned (see the client).
  const answer = (id: number, result: unknown, transfer = false): void =>
    post({ kind: 'result', id, ok: true, result }, transfer ? collectTransferables(result) : [])
  // A failed call is the CALLER's to report: it carries the context (which
  // device, which operation) this thread does not have, and an expected
  // failure — a unique-constraint race, a refused composite call — is not a
  // line worth one per occurrence.
  const refuse = (id: number, err: unknown): void => {
    post({ kind: 'result', id, ok: false, error: serializeError(err) })
  }

  const serve = async (request: FileHostRequest): Promise<void> => {
    try {
      if (request.kind === 'stop') {
        maintenance?.stop()
        await backend.shutdown()
        answer(request.id, undefined)
        port.close()
        return
      }
      if (request.kind === 'data') {
        answer(request.id, await callData(dataTarget, request.op, trustInput(request.input)))
        return
      }
      if (request.kind === 'vector') {
        if (vectorTarget === null) {
          throw new Error(`database "${spec.databaseId}" does not serve vector calls`)
        }
        answer(
          request.id,
          await callVector(vectorTarget, request.op, trustInput(request.input)),
          true,
        )
        return
      }
      if (request.kind === 'records') {
        if (recordsEngine === null) throw new Error(`database "${spec.databaseId}" is not open`)
        answer(request.id, await callRecords(recordsEngine, request.op, trustInput(request.input)))
        return
      }
      answer(request.id, callControl(control, request.op, trustInput(request.input)))
    } catch (err) {
      refuse(request.id, err)
    }
  }

  port.on('message', (message: unknown) => {
    if (!isFileHostRequest(message)) return
    void serve(message)
  })
  post({ kind: 'ready', declared: [...backend.declaredCollectionNames()] })
}

main().catch((err: unknown) => {
  // Nothing can be posted reliably from here; the main thread sees the
  // thread's `error` event and fails the runner (D5/D6).
  throw err
})
