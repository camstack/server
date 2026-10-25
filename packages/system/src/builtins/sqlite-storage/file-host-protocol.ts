/**
 * The vocabulary between the engine's main thread and the thread that serves
 * one database file (D851). Pure: no driver, no kernel — the worker bundle
 * imports it, and so does the main thread.
 *
 * ## The shape
 *
 * A request is `{ id, kind, op, input }`; the answer is `{ id, ok: true,
 * result }` or `{ id, ok: false, error }`. `kind` is `data` (the
 * `data-store-provider` surface), `vector` (the `vector-store` surface) or
 * `control` (what the placement router needs to ask a file that no cap
 * method covers), or `records` (the `records` surface, D881). Errors cross by NAME (`placement-errors.ts`).
 *
 * ## The type boundary
 *
 * A message is `unknown` the moment it crosses `postMessage`. `trustInput` and
 * `trustResult` are the only two places the engine asserts a type it cannot
 * prove: the message was built by {@link OwnedSqliteFile.call} /
 * {@link OwnedSqliteFile.vector}, whose signature IS the typing. Everything
 * else on either side of the boundary is typed.
 */
import type { IDataStoreProvider, IVectorStoreProvider } from '@camstack/types'
import type { DataStoreDatabase, LogTags } from '@camstack/types'
import type { SerializedError } from './placement-errors.js'
import { isRecordsOp, type RecordsOp } from './records/records-engine-types.js'

/** Every `data-store-provider` method a file serves (all but self-description). */
export type DataStoreMethods = Omit<IDataStoreProvider, 'getEngineInfo'>
export type DataStoreOp = keyof DataStoreMethods
export type DataStoreInput<K extends DataStoreOp> = Parameters<DataStoreMethods[K]>[0]
export type DataStoreOutput<K extends DataStoreOp> = Awaited<ReturnType<DataStoreMethods[K]>>

export type VectorOp = keyof IVectorStoreProvider
export type VectorInput<K extends VectorOp> = Parameters<IVectorStoreProvider[K]>[0]
export type VectorOutput<K extends VectorOp> = Awaited<ReturnType<IVectorStoreProvider[K]>>

/** Questions about a file that are not cap methods. */
export interface ControlOps {
  /** Does a table of this name exist in the file? */
  readonly hasTable: { readonly input: { readonly name: string }; readonly output: boolean }
  /** Which thread serves this file. */
  readonly threadId: { readonly input: Record<string, never>; readonly output: number }
  /** Every physical table in the file (storage-admin / records adopt). */
  readonly listPhysicalTables: {
    readonly input: { readonly ownerPrefix?: string | undefined }
    readonly output: readonly {
      readonly name: string
      readonly owner: string | null
      readonly rows: number
      readonly bytes: number | null
      readonly declaredThisBoot: boolean
    }[]
  }
}
export type ControlOp = keyof ControlOps

/** At most this many calls in flight per worker; beyond it a call is refused, never queued. */
export const FILE_HOST_MAX_IN_FLIGHT = 512

/** A refusal for being busy is logged at most once per this many ms. */
export const FILE_HOST_BUSY_LOG_INTERVAL_MS = 60_000

/** How one file is opened. */
export interface OwnedSqliteFileSpec {
  readonly databaseId: DataStoreDatabase
  /** `<dataDir>/<file>`, absolute. */
  readonly livePath: string
  /** `settings` is served on the engine's main thread; `events`, `history` each on a worker. */
  readonly thread: 'main' | 'worker'
  /** `incremental` only takes effect on a file this open CREATES. */
  readonly autoVacuum: 'none' | 'incremental'
  /** Load sqlite-vec and serve `vector` calls (`events` only). */
  readonly loadVectorExtension: boolean
}

/** `workerData` of one file-host thread. */
export interface FileHostWorkerData {
  readonly kind: 'file-host'
  readonly spec: OwnedSqliteFileSpec
}

export type FileHostRequest =
  | {
      readonly id: number
      readonly kind: 'data'
      readonly op: DataStoreOp
      readonly input: unknown
    }
  | { readonly id: number; readonly kind: 'vector'; readonly op: VectorOp; readonly input: unknown }
  | {
      readonly id: number
      readonly kind: 'records'
      readonly op: RecordsOp
      readonly input: unknown
    }
  | {
      readonly id: number
      readonly kind: 'control'
      readonly op: ControlOp
      readonly input: unknown
    }
  | { readonly id: number; readonly kind: 'stop' }

export type FileHostLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type FileHostMessage =
  | { readonly kind: 'ready'; readonly declared: readonly string[] }
  | {
      readonly kind: 'log'
      readonly level: FileHostLogLevel
      readonly message: string
      readonly scope: string
      readonly tags?: LogTags
      readonly meta?: Record<string, unknown>
    }
  | { readonly kind: 'result'; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly kind: 'result'
      readonly id: number
      readonly ok: false
      readonly error: SerializedError
    }
  /** The thread could not even open its file. */
  | { readonly kind: 'boot-failed'; readonly error: SerializedError }

export const DATA_STORE_OPS: readonly DataStoreOp[] = [
  'get',
  'set',
  'query',
  'insert',
  'upsert',
  'insertMany',
  'upsertMany',
  'transact',
  'update',
  'delete',
  'deleteWhere',
  'updateWhere',
  'count',
  'aggregate',
  'histogram',
  'isEmpty',
  'declareCollection',
]

export const VECTOR_OPS: readonly VectorOp[] = [
  'declareIndex',
  'upsert',
  'query',
  'getByIds',
  'fetchByIds',
  'scan',
  'deleteByIds',
  'deleteByFilter',
  'stats',
]

export const CONTROL_OPS: readonly ControlOp[] = ['hasTable', 'threadId', 'listPhysicalTables']

export function isDataStoreOp(op: string): op is DataStoreOp {
  return DATA_STORE_OPS.some((known) => known === op)
}
export function isVectorOp(op: string): op is VectorOp {
  return VECTOR_OPS.some((known) => known === op)
}
export function isControlOp(op: string): op is ControlOp {
  return CONTROL_OPS.some((known) => known === op)
}

/** Narrow an incoming worker message. */
export function isFileHostMessage(value: unknown): value is FileHostMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'ready' ||
      value.kind === 'log' ||
      value.kind === 'result' ||
      value.kind === 'boot-failed')
  )
}

/** Narrow an incoming request on the worker side. */
export function isFileHostRequest(value: unknown): value is FileHostRequest {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || !('id' in value) || typeof value.id !== 'number') return false
  if (value.kind === 'stop') return true
  if (!('op' in value) || typeof value.op !== 'string') return false
  if (value.kind === 'data') return isDataStoreOp(value.op)
  if (value.kind === 'vector') return isVectorOp(value.op)
  if (value.kind === 'control') return isControlOp(value.op)
  if (value.kind === 'records') return isRecordsOp(value.op)
  return false
}

export function isFileHostWorkerData(value: unknown): value is FileHostWorkerData {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'file-host'
  )
}

/**
 * Type boundary (see the file header): the request was built by a typed
 * `call`/`vector`, so its `input` is the op's input.
 */
export function trustInput<T>(input: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a structured-clone message built by a typed caller
  return input as T
}

/** Type boundary (see the file header): the answer was produced by the op's handler. */
export function trustResult<T>(result: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a structured-clone message built by the op's handler
  return result as T
}

/**
 * The `ArrayBuffer`s a payload carries within three levels (a typed array,
 * a `Buffer`, or an array/record of them, e.g. `{ items: [{ vector }] }`) — what `postMessage` should TRANSFER
 * rather than clone. A transferred buffer is detached on the sender: ownership
 * passes with the message, and a caller must not reuse a buffer it sent.
 *
 * Only plain, non-shared `ArrayBuffer`s qualify; a view over a pooled
 * `Buffer` slab is cloned instead, because transferring the slab would detach
 * every other `Buffer` carved from it.
 */
export function collectTransferables(payload: unknown): readonly ArrayBuffer[] {
  const found = new Set<ArrayBuffer>()
  const visit = (value: unknown, depth: number): void => {
    if (ArrayBuffer.isView(value)) {
      const buffer = value.buffer
      if (
        buffer instanceof ArrayBuffer &&
        value.byteOffset === 0 &&
        value.byteLength === buffer.byteLength
      ) {
        found.add(buffer)
      }
      return
    }
    if (depth >= 3 || typeof value !== 'object' || value === null) return
    const children = Array.isArray(value) ? value : Object.values(value)
    for (const child of children) visit(child, depth + 1)
  }
  visit(payload, 0)
  return [...found]
}
