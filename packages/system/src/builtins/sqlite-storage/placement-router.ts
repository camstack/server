/**
 * PLACEMENT (D851): which database file serves a collection.
 *
 * The router IS the engine's `data-store-provider`: the storage orchestrator
 * dispatches to one engine, and this engine fans out to the files it owns.
 * The rule it enforces is small and absolute:
 *
 *  - a collection's file is declared by its owner on `declareCollection`
 *    (`database`, absent = `settings`) and persisted in THAT file's own
 *    `_collection_declarations`;
 *  - at boot the router rebuilds `collection → file` from those tables, and a
 *    collection declared in two files is a boot ERROR naming both — a corrupt
 *    layout is not served;
 *  - a declaration for a file other than the one the table already lives in is
 *    REFUSED ({@link CollectionPlacementError}), never moved. Moving is the
 *    offline split script's job, once (D853). This is the safety net that turns
 *    an accidental deploy to an unconverted hub into a loud failure of ONE
 *    addon instead of a silent empty file beside the real rows;
 *  - every other op resolves its file from the map; an undeclared collection
 *    (the canonical KV set and its `<addonId>:<canonical>` variants) is
 *    `settings`;
 *  - a `transact` spans ONE file ({@link CrossDatabaseTransactError}).
 *
 * A file other than `settings` is created on the FIRST declaration that names
 * it, so an installation where nothing names `events` / `history` grows no new
 * file.
 */
import type {
  DataStoreDatabase,
  DataStoreEngineInfo,
  IDataStoreProvider,
  IScopedLogger,
} from '@camstack/types'
import { DATA_STORE_DATABASES } from '@camstack/types'
import type { DataStoreInput, DataStoreOp, DataStoreOutput } from './file-host-protocol.js'
import type { OwnedSqliteFile } from './owned-sqlite-file.js'
import {
  CollectionPlacementError,
  CrossDatabaseTransactError,
  DuplicatePlacementError,
} from './placement-errors.js'

/** Opens (creating it if needed) the file for a database id. Called at most once per id. */
export type OpenDatabaseFile = (databaseId: DataStoreDatabase) => Promise<OwnedSqliteFile>

export interface PlacementRouterOptions {
  /** Files already open at boot — `settings` always, `events` / `history` if they exist on disk. */
  readonly files: readonly OwnedSqliteFile[]
  /** How a not-yet-open file is created on first declaration. */
  readonly open: OpenDatabaseFile
  readonly logger: IScopedLogger
}

function scopedName(namespace: string | undefined, collection: string): string {
  return namespace ? `${namespace}:${collection}` : collection
}

export class PlacementRouter implements IDataStoreProvider {
  private readonly files = new Map<DataStoreDatabase, OwnedSqliteFile>()
  private readonly opening = new Map<DataStoreDatabase, Promise<OwnedSqliteFile>>()
  /** `events` / `history` collections only; absence means `settings`. */
  private readonly placement = new Map<string, DataStoreDatabase>()
  private readonly open: OpenDatabaseFile
  private readonly logger: IScopedLogger

  constructor(options: PlacementRouterOptions) {
    this.open = options.open
    this.logger = options.logger
    for (const file of options.files) this.files.set(file.databaseId, file)
    this.rebuildPlacement()
  }

  /**
   * Rebuild `collection → file` from each file's own declarations. A table
   * declared in two files is refused: nothing downstream could tell which is
   * the real one.
   */
  private rebuildPlacement(): void {
    this.placement.clear()
    const owner = new Map<string, DataStoreDatabase>()
    for (const databaseId of DATA_STORE_DATABASES) {
      const file = this.files.get(databaseId)
      if (file === undefined) continue
      for (const name of file.declaredCollections()) {
        const other = owner.get(name)
        if (other !== undefined) {
          throw new DuplicatePlacementError(name, other, databaseId)
        }
        owner.set(name, databaseId)
        if (databaseId !== 'settings') this.placement.set(name, databaseId)
      }
    }
    this.logger.info('placement: database files open', {
      meta: {
        files: DATA_STORE_DATABASES.filter((id) => this.files.has(id)).map((id) => ({
          database: id,
          collections: this.files.get(id)?.declaredCollections().size ?? 0,
        })),
      },
    })
  }

  /** The open file of an id; `settings` is always there. */
  private fileOf(databaseId: DataStoreDatabase): OwnedSqliteFile {
    const file = this.files.get(databaseId)
    if (file === undefined) {
      throw new Error(`placement: database "${databaseId}" is not open`)
    }
    return file
  }

  /** The database a table is served from. */
  databaseOf(table: string): DataStoreDatabase {
    return this.placement.get(table) ?? 'settings'
  }

  /**
   * The file that hosts records of `databaseId`, created by the first
   * declaration that names it (`events`). `history` never hosts records.
   */
  async recordsFileFor(databaseId: DataStoreDatabase): Promise<OwnedSqliteFile> {
    if (databaseId === 'history') {
      throw new Error("placement: history.db is device-history's and never hosts records")
    }
    return this.openFile(databaseId)
  }

  /** The files currently open, settings first. */
  openFiles(): readonly OwnedSqliteFile[] {
    return DATA_STORE_DATABASES.flatMap((id) => {
      const file = this.files.get(id)
      return file === undefined ? [] : [file]
    })
  }

  private async openFile(databaseId: DataStoreDatabase): Promise<OwnedSqliteFile> {
    const open = this.files.get(databaseId)
    if (open !== undefined) return open
    const inFlight = this.opening.get(databaseId)
    if (inFlight !== undefined) return inFlight
    const opening = this.open(databaseId).then((file) => {
      this.files.set(databaseId, file)
      this.opening.delete(databaseId)
      return file
    })
    this.opening.set(databaseId, opening)
    try {
      return await opening
    } catch (err) {
      this.opening.delete(databaseId)
      throw err
    }
  }

  private route<K extends DataStoreOp>(
    namespace: string | undefined,
    collection: string,
    op: K,
    input: DataStoreInput<K>,
  ): Promise<DataStoreOutput<K>> {
    return this.fileOf(this.databaseOf(scopedName(namespace, collection))).call(op, input)
  }

  async declareCollection(input: DataStoreInput<'declareCollection'>): Promise<void> {
    const table = scopedName(input.namespace, input.collection)
    const target: DataStoreDatabase = input.database ?? 'settings'
    // A table that already lives in another file is refused — whether the
    // placement map knows it from a declaration, or only the file's catalogue
    // does (a table created outside a declaration is still a table).
    for (const file of this.openFiles()) {
      if (file.databaseId === target) continue
      if (file.declaredCollections().has(table) || (await file.hasTable(table))) {
        this.logger.error('placement: declaration refused — the table lives in another file', {
          tags: { database: target },
          meta: { table, livesIn: file.databaseId, declaredFor: target },
        })
        throw new CollectionPlacementError(table, file.databaseId, target)
      }
    }
    const file = await this.openFile(target)
    await file.call('declareCollection', input)
    if (target !== 'settings') this.placement.set(table, target)
  }

  async transact(input: DataStoreInput<'transact'>): Promise<DataStoreOutput<'transact'>> {
    const targets = new Set<DataStoreDatabase>()
    if (input.guard !== undefined) {
      targets.add(this.databaseOf(scopedName(input.namespace, input.guard.collection)))
    }
    for (const op of input.ops) {
      targets.add(this.databaseOf(scopedName(input.namespace, op.collection)))
    }
    if (targets.size > 1) throw new CrossDatabaseTransactError([...targets])
    const [only] = targets
    return this.fileOf(only ?? 'settings').call('transact', input)
  }

  async getEngineInfo(): Promise<DataStoreEngineInfo> {
    return { engineId: 'sqlite', kind: 'relational', displayName: 'SQLite (WAL)' }
  }

  get(input: DataStoreInput<'get'>): Promise<DataStoreOutput<'get'>> {
    return this.route(input.namespace, input.collection, 'get', input)
  }
  set(input: DataStoreInput<'set'>): Promise<DataStoreOutput<'set'>> {
    return this.route(input.namespace, input.collection, 'set', input)
  }
  query(input: DataStoreInput<'query'>): Promise<DataStoreOutput<'query'>> {
    return this.route(input.namespace, input.collection, 'query', input)
  }
  insert(input: DataStoreInput<'insert'>): Promise<DataStoreOutput<'insert'>> {
    return this.route(input.namespace, input.collection, 'insert', input)
  }
  upsert(input: DataStoreInput<'upsert'>): Promise<DataStoreOutput<'upsert'>> {
    return this.route(input.namespace, input.collection, 'upsert', input)
  }
  insertMany(input: DataStoreInput<'insertMany'>): Promise<DataStoreOutput<'insertMany'>> {
    return this.route(input.namespace, input.collection, 'insertMany', input)
  }
  upsertMany(input: DataStoreInput<'upsertMany'>): Promise<DataStoreOutput<'upsertMany'>> {
    return this.route(input.namespace, input.collection, 'upsertMany', input)
  }
  update(input: DataStoreInput<'update'>): Promise<DataStoreOutput<'update'>> {
    return this.route(input.namespace, input.collection, 'update', input)
  }
  delete(input: DataStoreInput<'delete'>): Promise<DataStoreOutput<'delete'>> {
    return this.route(input.namespace, input.collection, 'delete', input)
  }
  deleteWhere(input: DataStoreInput<'deleteWhere'>): Promise<DataStoreOutput<'deleteWhere'>> {
    return this.route(input.namespace, input.collection, 'deleteWhere', input)
  }
  updateWhere(input: DataStoreInput<'updateWhere'>): Promise<DataStoreOutput<'updateWhere'>> {
    return this.route(input.namespace, input.collection, 'updateWhere', input)
  }
  count(input: DataStoreInput<'count'>): Promise<DataStoreOutput<'count'>> {
    return this.route(input.namespace, input.collection, 'count', input)
  }
  aggregate(input: DataStoreInput<'aggregate'>): Promise<DataStoreOutput<'aggregate'>> {
    return this.route(input.namespace, input.collection, 'aggregate', input)
  }
  histogram(input: DataStoreInput<'histogram'>): Promise<DataStoreOutput<'histogram'>> {
    return this.route(input.namespace, input.collection, 'histogram', input)
  }
  isEmpty(input: DataStoreInput<'isEmpty'>): Promise<DataStoreOutput<'isEmpty'>> {
    return this.route(input.namespace, input.collection, 'isEmpty', input)
  }
}
