/**
 * The main thread's side of a file-host worker: spawns the thread, correlates
 * requests with answers, bounds what is in flight, writes the thread's log
 * lines through the runner's logger, and turns a thread that dies into a dead
 * runner (D5, D6) — never into a half-working one.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  type ControlOp,
  type ControlOps,
  collectTransferables,
  type DataStoreInput,
  type DataStoreOp,
  type DataStoreOutput,
  FILE_HOST_BUSY_LOG_INTERVAL_MS,
  FILE_HOST_MAX_IN_FLIGHT,
  type FileHostMessage,
  type FileHostRequest,
  type FileHostWorkerData,
  isFileHostMessage,
  type OwnedSqliteFileSpec,
  trustResult,
  type VectorInput,
  type VectorOp,
  type VectorOutput,
} from './file-host-protocol.js'
import { DatabaseBusyError, rehydrateError } from './placement-errors.js'
import type { RecordsInput, RecordsOp, RecordsOutput } from './records/records-engine-types.js'

/** The members of a `Worker` this class touches — structural, so a spec can substitute. */
export interface FileHostThread {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void
  terminate(): Promise<number>
}

export type FileHostThreadFactory = (data: FileHostWorkerData) => FileHostThread

/** Where the built worker entry lives (`dist/file-host-worker.js`, next to the checkpoint worker). */
export function defaultFileHostWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@camstack/system/package.json'))
  return path.join(packageRoot, 'dist', 'file-host-worker.js')
}

/** How long a stopped thread has to end on its own before it is terminated. */
const FILE_HOST_EXIT_GRACE_MS = 5_000

export interface FileHostClientOptions {
  readonly spec: OwnedSqliteFileSpec
  /** The runner's logger; this class writes through `child('Db/<id>')`. */
  readonly logger: IScopedLogger
  /** Called when the thread dies unexpectedly. Production: log, then `process.exit(1)`. */
  readonly onFatal: (reason: string) => void
  readonly workerPath?: string
  readonly workerExecArgv?: readonly string[]
  readonly threadFactory?: FileHostThreadFactory
  readonly maxInFlight?: number
  readonly now?: () => number
}

interface Pending {
  readonly op: string
  readonly resolve: (result: unknown) => void
  readonly reject: (err: Error) => void
}

export class FileHostClient {
  private readonly spec: OwnedSqliteFileSpec
  private readonly logger: IScopedLogger
  private readonly onFatal: (reason: string) => void
  private readonly maxInFlight: number
  private readonly now: () => number
  private readonly thread: FileHostThread
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private lastOp = '(none yet)'
  private stopping = false
  /** Settles when the thread's event loop has ended and its isolate is gone. */
  private readonly exited: Promise<void>
  private dead = false
  private lastBusyLogAt = -Infinity
  private declared: ReadonlySet<string> = new Set()
  private bootSettled: { resolve: () => void; reject: (err: Error) => void } | null = null

  constructor(options: FileHostClientOptions) {
    this.spec = options.spec
    this.logger = options.logger.child(`Db/${options.spec.databaseId}`)
    this.onFatal = options.onFatal
    this.maxInFlight = options.maxInFlight ?? FILE_HOST_MAX_IN_FLIGHT
    this.now = options.now ?? (() => Date.now())
    const workerPath = options.workerPath ?? null
    const execArgv = options.workerExecArgv
    const spawn: FileHostThreadFactory =
      options.threadFactory ??
      ((data) => {
        const worker = new Worker(workerPath ?? defaultFileHostWorkerPath(), {
          workerData: data,
          ...(execArgv !== undefined ? { execArgv: [...execArgv] } : {}),
        })
        return worker
      })
    this.thread = spawn({ kind: 'file-host', spec: options.spec })
    this.thread.on('message', (message) => this.onMessage(message))
    this.thread.on('error', (err) => this.die(`worker error: ${errMsg(err)}`))
    this.exited = new Promise<void>((resolve) => {
      this.thread.on('exit', () => resolve())
    })
    this.thread.on('exit', (code) => {
      if (this.stopping) {
        // The thread left before (or instead of) answering `stop`: it is gone,
        // which is what the stop asked for — do not strand the waiting caller.
        for (const pending of this.pending.values())
          if (pending.op === 'stop') pending.resolve(undefined)
        return
      }
      this.die(`worker exited with code ${code}`)
    })
  }

  /** Resolves once the thread has opened its file; rejects if it could not. */
  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.bootSettled = { resolve, reject }
    })
  }

  /** The collections this file's own declarations table names (updated as declarations land). */
  declaredCollections(): ReadonlySet<string> {
    return this.declared
  }

  noteDeclared(table: string): void {
    this.declared = new Set([...this.declared, table])
  }

  data<K extends DataStoreOp>(op: K, input: DataStoreInput<K>): Promise<DataStoreOutput<K>> {
    return this.request({ kind: 'data', op, input })
  }

  vector<K extends VectorOp>(op: K, input: VectorInput<K>): Promise<VectorOutput<K>> {
    return this.request({ kind: 'vector', op, input })
  }

  records<K extends RecordsOp>(op: K, input: RecordsInput<K>): Promise<RecordsOutput<K>> {
    return this.request({ kind: 'records', op, input })
  }

  control<K extends ControlOp>(
    op: K,
    input: ControlOps[K]['input'],
  ): Promise<ControlOps[K]['output']> {
    return this.request({ kind: 'control', op, input })
  }

  /** Ask the thread to close its connection, then end it. */
  async stop(): Promise<void> {
    if (this.dead || this.stopping) return
    this.stopping = true
    try {
      await new Promise<void>((resolve, reject) => {
        const id = this.nextId++
        this.pending.set(id, { op: 'stop', resolve: () => resolve(), reject })
        this.thread.postMessage({ id, kind: 'stop' } satisfies FileHostRequest)
      })
    } finally {
      await this.awaitExit()
    }
  }

  /**
   * Let the thread END ITSELF after it answered `stop`: it has closed every
   * statement and the connection and closed its port, so its loop drains and
   * the isolate is disposed from inside. `terminate()` straight after the
   * answer races that disposal and, on macOS, took the whole process down with
   * a SIGSEGV in the isolate's teardown GC. Terminate is only the fallback for
   * a thread that does not leave in time.
   */
  private async awaitExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FILE_HOST_EXIT_GRACE_MS)
    })
    const outcome = await Promise.race([this.exited.then(() => 'exited' as const), timedOut])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.logger.warn('database worker did not leave after stop — terminating it', {
        tags: { database: this.spec.databaseId },
      })
      await this.thread.terminate()
    }
  }

  inFlight(): number {
    return this.pending.size
  }

  private request<T>(
    body:
      | { kind: 'data'; op: DataStoreOp; input: unknown }
      | { kind: 'vector'; op: VectorOp; input: unknown }
      | { kind: 'records'; op: RecordsOp; input: unknown }
      | { kind: 'control'; op: ControlOp; input: unknown },
  ): Promise<T> {
    if (this.dead || this.stopping) {
      return Promise.reject(new Error(`database "${this.spec.databaseId}" is not serving`))
    }
    if (this.pending.size >= this.maxInFlight) {
      this.logBusy()
      return Promise.reject(new DatabaseBusyError(this.spec.databaseId, this.pending.size))
    }
    const id = this.nextId++
    this.lastOp = `${body.kind}:${body.op}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        op: this.lastOp,
        resolve: (result) => resolve(trustResult(result)),
        reject,
      })
      // Only a vector payload is TRANSFERRED: ownership of its buffers passes
      // with the message. A data payload is rows — cloned, so a caller that
      // keeps a buffer inside a JSON column never finds it detached.
      const transfer = body.kind === 'vector' ? collectTransferables(body.input) : []
      this.thread.postMessage({ id, ...body }, transfer)
    })
  }

  private logBusy(): void {
    const at = this.now()
    if (at - this.lastBusyLogAt < FILE_HOST_BUSY_LOG_INTERVAL_MS) return
    this.lastBusyLogAt = at
    this.logger.warn('database refused a call: too many in flight', {
      tags: { database: this.spec.databaseId },
      meta: { inFlight: this.pending.size, bound: this.maxInFlight, lastOp: this.lastOp },
    })
  }

  private onMessage(raw: unknown): void {
    if (!isFileHostMessage(raw)) return
    const message: FileHostMessage = raw
    if (message.kind === 'log') {
      this.writeLog(message)
      return
    }
    if (message.kind === 'ready') {
      this.declared = new Set(message.declared)
      this.bootSettled?.resolve()
      this.bootSettled = null
      return
    }
    if (message.kind === 'boot-failed') {
      const err = rehydrateError(message.error)
      this.bootSettled?.reject(err)
      this.bootSettled = null
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(rehydrateError(message.error))
  }

  private writeLog(message: Extract<FileHostMessage, { kind: 'log' }>): void {
    const scoped =
      message.scope === ''
        ? this.logger
        : this.logger.child(`Db/${this.spec.databaseId}/${message.scope}`)
    const extras = {
      tags: { ...message.tags, database: this.spec.databaseId },
      ...(message.meta !== undefined ? { meta: message.meta } : {}),
    }
    scoped[message.level](message.message, extras)
  }

  /** The thread is gone and nobody asked it to be: say so, fail what waits, fail the runner. */
  private die(reason: string): void {
    if (this.dead) return
    this.dead = true
    this.logger.error('database worker died — failing the runner', {
      tags: { database: this.spec.databaseId },
      meta: { reason, lastOp: this.lastOp, inFlight: this.pending.size },
    })
    const err = new Error(`database "${this.spec.databaseId}" worker died: ${reason}`)
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
    this.bootSettled?.reject(err)
    this.bootSettled = null
    this.onFatal(reason)
  }
}
