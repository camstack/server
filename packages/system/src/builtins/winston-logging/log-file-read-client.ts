/**
 * The parent side of the rotated-file reader thread (D898).
 *
 * The thread is spawned on the first read, not at boot: a hub nobody reads
 * logs on pays nothing but the background index pass, which starts with the
 * thread. A thread that dies fails its in-flight reads and is respawned on
 * the next one.
 */
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LogReadQuery, LogReadResult } from '@camstack/types'
import { LogFileIndexStore } from './log-file-index-store.js'
import {
  CancelBook,
  isFromReader,
  serveRead,
  type ReadWorkerData,
  type ToReader,
} from './log-file-read-protocol.js'

/** The structural surface of a `Worker` this client uses. */
export interface ReaderWorkerHandle {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: ToReader): void
  unref?(): void
}

export type ReaderWorkerFactory = (data: ReadWorkerData) => ReaderWorkerHandle

/** `dist/log-file-read-worker.js` at the package root, found through its own `package.json`. */
export function defaultReaderWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@camstack/system/package.json'))
  return path.join(packageRoot, 'dist', 'log-file-read-worker.js')
}

export interface LogFileReadClientOptions {
  readonly logsDir: string
  /** Background index pass period. Default 60 s; 0 disables (specs). */
  readonly backgroundPassMs?: number
  /** Run in the calling thread — specs only. */
  readonly inProcess?: boolean
  readonly workerPath?: string
  readonly workerExecArgv?: readonly string[]
  readonly workerFactory?: ReaderWorkerFactory
}

interface Pending {
  readonly resolve: (result: LogReadResult) => void
  readonly reject: (error: Error) => void
}

export class LogFileReadClient {
  private readonly logsDir: string
  private readonly backgroundPassMs: number
  private readonly spawn: ReaderWorkerFactory | null
  private worker: ReaderWorkerHandle | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  // In-process mode: the same store and cancel book the thread would own.
  private readonly local: { store: LogFileIndexStore; cancels: CancelBook } | null

  constructor(options: LogFileReadClientOptions) {
    this.logsDir = options.logsDir
    this.backgroundPassMs = options.backgroundPassMs ?? 60_000
    if (options.inProcess === true) {
      this.spawn = null
      this.local = { store: new LogFileIndexStore(options.logsDir), cancels: new CancelBook() }
      return
    }
    this.local = null
    const workerPath = options.workerPath ?? defaultReaderWorkerPath()
    const execArgv = options.workerExecArgv
    this.spawn =
      options.workerFactory ??
      ((workerData) =>
        new Worker(workerPath, {
          workerData,
          ...(execArgv !== undefined ? { execArgv: [...execArgv] } : {}),
        }))
  }

  async read(query: LogReadQuery): Promise<LogReadResult> {
    if (this.local !== null) {
      return (await serveRead(this.logsDir, this.local.store, this.local.cancels, query)).result
    }
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<LogReadResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ type: 'read', id, query })
    })
  }

  /**
   * Start the thread now, so its background pass indexes the existing files
   * before anyone reads them. The hub calls this; an agent, whose files
   * nobody reads, leaves the thread unstarted.
   */
  warm(): void {
    if (this.local === null) this.ensureWorker()
  }

  cancel(requestId: string): boolean {
    if (this.local !== null) {
      this.local.cancels.cancel(requestId)
      return true
    }
    if (this.worker === null) return false
    this.worker.postMessage({ type: 'cancel', requestId })
    return true
  }

  stop(): void {
    this.worker?.postMessage({ type: 'stop' })
    this.worker = null
    this.failAll(new Error('log reader stopped'))
  }

  private ensureWorker(): ReaderWorkerHandle {
    if (this.worker !== null) return this.worker
    if (this.spawn === null) throw new Error('log reader has no worker factory')
    const worker = this.spawn({ logsDir: this.logsDir, backgroundPassMs: this.backgroundPassMs })
    worker.unref?.()
    worker.on('message', (message: unknown) => {
      if (!isFromReader(message)) return
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (message.type === 'result') waiter.resolve(message.result)
      else waiter.reject(new Error(message.message))
    })
    worker.on('error', (err: unknown) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)))
    })
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null
      this.failAll(new Error('log reader thread exited'))
    })
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}
