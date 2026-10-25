/**
 * One database FILE of the `sqlite-settings` engine, with everything D447,
 * D452, D679 and D693 already require per file (D851):
 *
 * - a serving thread — the engine's main thread for `settings`, a dedicated
 *   worker for `events` and `history`;
 * - a WAL checkpointer, a `-shm` lock canary and the idle-gated WAL
 *   maintenance;
 * - a verified snapshot written by the owner, never a file copy.
 *
 * The router (`placement-router.ts`) holds one of these per open file and
 * sends each call to the file its collection lives in. Nothing outside this
 * package knows a file path.
 */
import type {
  DatabaseSnapshotResult,
  DataStoreDatabase,
  IScopedLogger,
  IVectorStoreProvider,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  callControl,
  callData,
  callRecords,
  callVector,
  controlTargetOf,
} from './file-host-handlers.js'
import { RecordsEngine } from './records/records-engine.js'
import type { RecordsInput, RecordsOp, RecordsOutput } from './records/records-engine-types.js'
import { FileHostClient, type FileHostThreadFactory } from './file-host-client.js'
import type {
  DataStoreInput,
  DataStoreOp,
  DataStoreOutput,
  OwnedSqliteFileSpec,
  VectorInput,
  VectorOp,
  VectorOutput,
} from './file-host-protocol.js'
import { ShmLockCanary } from './shm-lock-canary.js'
import { SqliteSettingsBackend } from './sqlite-settings-backend.js'
import { SqliteSnapshotter } from './sqlite-snapshotter.js'
import type { SqliteVecVectorIndex } from './vector-index-vec.js'
import { createVectorIndex, vectorProviderOf } from './vector-provider.js'
import { WalCheckpointer } from './wal-checkpointer.js'
import { WalMaintenance } from './wal-maintenance.js'

export type { OwnedSqliteFileSpec } from './file-host-protocol.js'

export interface OwnedSqliteFile {
  readonly databaseId: DataStoreDatabase
  readonly livePath: string
  call<K extends DataStoreOp>(op: K, input: DataStoreInput<K>): Promise<DataStoreOutput<K>>
  /** `records` calls (D881). */
  records<K extends RecordsOp>(op: K, input: RecordsInput<K>): Promise<RecordsOutput<K>>
  /** `vector-store` calls; refused on a file that does not load sqlite-vec. */
  vector<K extends VectorOp>(op: K, input: VectorInput<K>): Promise<VectorOutput<K>>
  /** The collections this file's own `_collection_declarations` names. */
  declaredCollections(): ReadonlySet<string>
  /** Does a table of this name exist in this file (declared or not)? */
  hasTable(name: string): Promise<boolean>
  /** Physical tables for storage-admin (read-only; may include undeclared legacy). */
  listPhysicalTables(ownerPrefix?: string | undefined): Promise<
    readonly {
      readonly name: string
      readonly owner: string | null
      readonly rows: number
      readonly bytes: number | null
      readonly declaredThisBoot: boolean
    }[]
  >
  /** Which thread serves this file: 0 is the engine's main thread. */
  servingThreadId(): Promise<number>
  /** The owner's verified copy of this file (D693). */
  snapshot(): Promise<DatabaseSnapshotResult>
  /** Checkpointer, canary, maintenance, then the connection. */
  stop(): Promise<void>
}

/** What the per-file lifecycle needs, injectable so a spec can count and substitute. */
export interface FileLifecycle {
  readonly checkpointer: { start(): void; stop(): Promise<void> }
  readonly canary: { start(): void; stop(): void }
  readonly snapshotter: { sweep(): Promise<unknown>; write(): Promise<DatabaseSnapshotResult> }
}

export interface OwnedFileDeps {
  /** The runner's logger; per-file loggers are derived from it. */
  readonly logger: IScopedLogger
  /** The runner is respawned on a serving thread's death (D5/D6). Production: `process.exit(1)`. */
  readonly onFatal: (reason: string) => void
  /** Runtime defaults seeded into a fresh `settings` file. */
  readonly runtimeDefaults?: Record<string, unknown>
  readonly workerPath?: string
  readonly workerExecArgv?: readonly string[]
  readonly threadFactory?: FileHostThreadFactory
  readonly maxInFlight?: number
  /** Replaces the real checkpointer / canary / snapshotter (specs). */
  readonly lifecycle?: (
    spec: OwnedSqliteFileSpec,
    logger: (scope: string) => IScopedLogger,
  ) => FileLifecycle
  /**
   * Runs once the file is open and BEFORE its lifecycle is armed — the slot
   * for the boot-time purges, which must happen before anything can read.
   */
  readonly afterOpen?: (file: OwnedSqliteFile) => Promise<void>
}

/** The loggers of one file: scope per sub-component, `tags.database` on every line. */
function fileLoggerFor(
  base: IScopedLogger,
  databaseId: DataStoreDatabase,
): (scope: string) => IScopedLogger {
  return (scope) =>
    base
      .child(databaseId === 'settings' ? scope : `Db/${databaseId}/${scope}`)
      .withTags({ database: databaseId })
}

function realLifecycle(
  spec: OwnedSqliteFileSpec,
  logger: (scope: string) => IScopedLogger,
): FileLifecycle {
  return {
    checkpointer: new WalCheckpointer({ dbPath: spec.livePath, logger: logger('WalCheckpoint') }),
    canary: new ShmLockCanary({ dbPath: spec.livePath, logger: logger('ShmLock') }),
    snapshotter: new SqliteSnapshotter({ livePath: spec.livePath, logger: logger('Snapshot') }),
  }
}

/** Shared by both thread flavours: the per-file lifecycle. */
abstract class OwnedFileBase implements OwnedSqliteFile {
  readonly databaseId: DataStoreDatabase
  readonly livePath: string
  protected readonly log: (scope: string) => IScopedLogger
  protected lifecycle: FileLifecycle | null = null

  constructor(
    protected readonly spec: OwnedSqliteFileSpec,
    protected readonly deps: OwnedFileDeps,
  ) {
    this.databaseId = spec.databaseId
    this.livePath = spec.livePath
    this.log = fileLoggerFor(deps.logger, spec.databaseId)
  }

  abstract call<K extends DataStoreOp>(op: K, input: DataStoreInput<K>): Promise<DataStoreOutput<K>>
  abstract vector<K extends VectorOp>(op: K, input: VectorInput<K>): Promise<VectorOutput<K>>
  abstract records<K extends RecordsOp>(op: K, input: RecordsInput<K>): Promise<RecordsOutput<K>>
  abstract declaredCollections(): ReadonlySet<string>
  abstract hasTable(name: string): Promise<boolean>
  abstract listPhysicalTables(ownerPrefix?: string | undefined): Promise<
    readonly {
      readonly name: string
      readonly owner: string | null
      readonly rows: number
      readonly bytes: number | null
      readonly declaredThisBoot: boolean
    }[]
  >
  abstract servingThreadId(): Promise<number>
  protected abstract stopConnection(): Promise<void>
  protected abstract stopMaintenance(): void

  /**
   * Arm the checkpointer, the canary and the snapshotter. Called after the
   * connection is open and the boot purges have run.
   */
  protected async armLifecycle(): Promise<void> {
    const lifecycle = (this.deps.lifecycle ?? realLifecycle)(this.spec, this.log)
    lifecycle.checkpointer.start()
    lifecycle.canary.start()
    // A snapshot a caller never collected (its call timed out, the hub died
    // mid-run) is a full copy of the database sitting on this disk.
    try {
      await lifecycle.snapshotter.sweep()
    } catch (err) {
      this.log('Snapshot').warn('SQLite snapshot sweep failed at boot', {
        meta: { error: errMsg(err) },
      })
    }
    this.lifecycle = lifecycle
  }

  async snapshot(): Promise<DatabaseSnapshotResult> {
    if (this.lifecycle === null) throw new Error(`database "${this.databaseId}" is not open`)
    return this.lifecycle.snapshotter.write()
  }

  async stop(): Promise<void> {
    // Stop the timers BEFORE the handle closes, or a tick can fire against a
    // closed connection and log a failure that is really an orderly shutdown.
    this.stopMaintenance()
    this.lifecycle?.canary.stop()
    // The checkpoint worker holds its own connection: it closes BEFORE the
    // engine so a checkpoint cannot land on a file the backend is closing.
    await this.lifecycle?.checkpointer.stop()
    this.lifecycle = null
    await this.stopConnection()
  }
}

/** `camstack.db`: served in place on the engine's main thread. */
export class InlineOwnedFile extends OwnedFileBase {
  readonly backend: SqliteSettingsBackend
  private declared: ReadonlySet<string> = new Set()
  private vectorIndex: SqliteVecVectorIndex | null = null
  private vectorProvider: IVectorStoreProvider | null = null
  private maintenance: WalMaintenance | null = null
  private recordsEngine: RecordsEngine | null = null

  constructor(spec: OwnedSqliteFileSpec, deps: OwnedFileDeps) {
    super(spec, deps)
    // The logger is what makes the defensive row cap visible. Without it a
    // truncated read is indistinguishable from a complete one — which is a
    // worse failure than the OOM the cap prevents (see `query-bounds.ts`).
    this.backend = new SqliteSettingsBackend(
      spec.livePath,
      deps.runtimeDefaults === undefined ? {} : { ...deps.runtimeDefaults },
      this.log('Query'),
      {
        databaseId: spec.databaseId,
        autoVacuum: spec.autoVacuum,
        canonicalKv: spec.databaseId === 'settings',
      },
    )
  }

  async open(): Promise<void> {
    await this.backend.initialize()
    this.declared = this.backend.declaredCollectionNames()
    if (this.spec.loadVectorExtension) {
      const vectorIndex = createVectorIndex(this.backend, this.log('VectorIndex'))
      // Recover persisted index declarations BEFORE the provider is exposed:
      // callers declare lazily (the dimension comes from the active encoder),
      // so without this an existing index is unqueryable until something writes.
      await vectorIndex.loadIndexRegistry()
      this.vectorIndex = vectorIndex
      this.vectorProvider = vectorProviderOf(vectorIndex)
    }
    const handle = this.backend.getDatabase()
    if (handle !== null) {
      this.recordsEngine = new RecordsEngine(handle, {
        databaseId: this.spec.databaseId,
        logger: this.log('Records'),
      })
    }
    await this.deps.afterOpen?.(this)
    // Arm WAL maintenance only once the engine is fully open. It is gated on
    // an idle database and bounded by a short busy_timeout — see
    // `wal-maintenance.ts` for why an unconditional periodic checkpoint would
    // make the main-thread stalls worse rather than better.
    const db = this.backend.getDatabase()
    if (db !== null) {
      const maintenance = new WalMaintenance({
        db,
        dbPath: this.spec.livePath,
        logger: this.log('WalMaintenance'),
      })
      maintenance.start()
      this.maintenance = maintenance
    }
    await this.armLifecycle()
  }

  getVectorIndex(): SqliteVecVectorIndex | null {
    return this.vectorIndex
  }

  async call<K extends DataStoreOp>(op: K, input: DataStoreInput<K>): Promise<DataStoreOutput<K>> {
    const result = await callData(this.backend, op, input)
    if (op === 'declareCollection') this.declared = this.backend.declaredCollectionNames()
    return result
  }

  async records<K extends RecordsOp>(op: K, input: RecordsInput<K>): Promise<RecordsOutput<K>> {
    if (this.recordsEngine === null) throw new Error(`database "${this.databaseId}" is not open`)
    return callRecords(this.recordsEngine, op, input)
  }

  async vector<K extends VectorOp>(op: K, input: VectorInput<K>): Promise<VectorOutput<K>> {
    if (this.vectorProvider === null) {
      throw new Error(`database "${this.databaseId}" does not serve vector calls`)
    }
    return callVector(this.vectorProvider, op, input)
  }

  declaredCollections(): ReadonlySet<string> {
    return this.declared
  }

  async hasTable(name: string): Promise<boolean> {
    return callControl(controlTargetOf(this.backend, 0), 'hasTable', { name })
  }

  listPhysicalTables(ownerPrefix?: string | undefined): Promise<
    readonly {
      readonly name: string
      readonly owner: string | null
      readonly rows: number
      readonly bytes: number | null
      readonly declaredThisBoot: boolean
    }[]
  > {
    return Promise.resolve(
      callControl(controlTargetOf(this.backend, 0), 'listPhysicalTables', { ownerPrefix }),
    )
  }

  async servingThreadId(): Promise<number> {
    return 0
  }

  protected stopMaintenance(): void {
    this.maintenance?.stop()
    this.maintenance = null
  }

  protected async stopConnection(): Promise<void> {
    await this.backend.shutdown()
  }
}

/** `events.db`, `history.db`: served by a dedicated worker thread. */
export class WorkerOwnedFile extends OwnedFileBase {
  private readonly client: FileHostClient

  constructor(spec: OwnedSqliteFileSpec, deps: OwnedFileDeps) {
    super(spec, deps)
    this.client = new FileHostClient({
      spec,
      logger: deps.logger,
      onFatal: deps.onFatal,
      ...(deps.workerPath !== undefined ? { workerPath: deps.workerPath } : {}),
      ...(deps.workerExecArgv !== undefined ? { workerExecArgv: deps.workerExecArgv } : {}),
      ...(deps.threadFactory !== undefined ? { threadFactory: deps.threadFactory } : {}),
      ...(deps.maxInFlight !== undefined ? { maxInFlight: deps.maxInFlight } : {}),
    })
  }

  async open(): Promise<void> {
    await this.client.ready()
    await this.deps.afterOpen?.(this)
    await this.armLifecycle()
  }

  async call<K extends DataStoreOp>(op: K, input: DataStoreInput<K>): Promise<DataStoreOutput<K>> {
    const result = await this.client.data(op, input)
    if (op === 'declareCollection') {
      // The thread already persisted the declaration; mirror its name here so
      // the router's placement checks need no round trip.
      const table = tableNameOf(input)
      if (table !== null) this.client.noteDeclared(table)
    }
    return result
  }

  vector<K extends VectorOp>(op: K, input: VectorInput<K>): Promise<VectorOutput<K>> {
    return this.client.vector(op, input)
  }

  records<K extends RecordsOp>(op: K, input: RecordsInput<K>): Promise<RecordsOutput<K>> {
    return this.client.records(op, input)
  }

  declaredCollections(): ReadonlySet<string> {
    return this.client.declaredCollections()
  }

  hasTable(name: string): Promise<boolean> {
    return this.client.control('hasTable', { name })
  }

  listPhysicalTables(ownerPrefix?: string | undefined): Promise<
    readonly {
      readonly name: string
      readonly owner: string | null
      readonly rows: number
      readonly bytes: number | null
      readonly declaredThisBoot: boolean
    }[]
  > {
    return this.client.control('listPhysicalTables', { ownerPrefix })
  }

  servingThreadId(): Promise<number> {
    return this.client.control('threadId', {})
  }

  protected stopMaintenance(): void {
    // The idle-gated maintenance lives inside the worker, with the connection.
  }

  protected async stopConnection(): Promise<void> {
    await this.client.stop()
  }
}

/** The table a `declareCollection` input names, from its (possibly absent) namespace. */
function tableNameOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const collection = 'collection' in input ? input.collection : undefined
  if (typeof collection !== 'string') return null
  const namespace = 'namespace' in input ? input.namespace : undefined
  return typeof namespace === 'string' && namespace !== ''
    ? `${namespace}:${collection}`
    : collection
}

/** Open a file on the thread its spec names. */
export async function openOwnedSqliteFile(
  spec: OwnedSqliteFileSpec,
  deps: OwnedFileDeps,
): Promise<InlineOwnedFile | WorkerOwnedFile> {
  if (spec.thread === 'main') {
    const file = new InlineOwnedFile(spec, deps)
    await file.open()
    return file
  }
  const file = new WorkerOwnedFile(spec, deps)
  await file.open()
  return file
}
