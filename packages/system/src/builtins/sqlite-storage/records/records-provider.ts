/**
 * The `records` capability of the engine (D881): resolves WHO is calling and
 * WHICH file a kind lives in, then hands the call to that file's records engine.
 *
 * - **Owner** = the transport-stamped `callerAddonId` (as device-history's
 *   `not-owner` and the keychain). It is never a field of any input; a call with
 *   no stamp is refused `records/no-caller`.
 * - **Placement**: a kind's file is its declaration's `database`. The map is
 *   rebuilt from each open file's own `_record_kinds` at boot and updated on
 *   declaration. A kind declared for another file than the one it lives in is
 *   refused (the engine never moves data, D853).
 * - **No adoption** (D900): the records migration is closed. A declaration
 *   reads no legacy table.
 */
import {
  type DataStoreDatabase,
  DeclarationRefusedError,
  type DeclareKindResult,
  type IRecordsProvider,
  type IScopedLogger,
  type IStorageAdminProvider,
  InvalidRecordError,
  NoCallerError,
  normalizeSecretOwner,
  type RecordKindDeclaration,
  RecordKindDeclarationSchema,
  type StorageKind,
  TransactRefusedError,
  UnknownRecordKindError,
} from '@camstack/types'
import type { OwnedSqliteFile } from '../owned-sqlite-file.js'
import type { PlacementRouter } from '../placement-router.js'

/** The caller the transport stamped, or a refusal. */
export function recordsCallerOf(input: unknown): string {
  const raw: unknown =
    input !== null && typeof input === 'object' ? Reflect.get(input, 'callerAddonId') : undefined
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new NoCallerError(
      'the call carries no caller identity; records are reached through ctx.records',
    )
  }
  return normalizeSecretOwner(raw)
}

function keyOf(owner: string, kind: string): string {
  return `${owner}\u0000${kind}`
}

type AdminRecords = Pick<IStorageAdminProvider, 'listKinds' | 'readRecords'>

export class RecordsProvider implements IRecordsProvider, AdminRecords {
  private readonly placement = new Map<string, DataStoreDatabase>()

  constructor(
    private readonly router: PlacementRouter,
    private readonly logger: IScopedLogger,
  ) {}

  /** Rebuild the placement map from every open file's catalog. Call once, after the files are open. */
  async init(): Promise<void> {
    this.placement.clear()
    for (const file of this.router.openFiles()) {
      if (file.databaseId === 'history') continue
      const kinds = await file.records('listKinds', {})
      for (const k of kinds) {
        if (k.state === 'dropped') continue
        const key = keyOf(k.owner, k.kind)
        const other = this.placement.get(key)
        if (other !== undefined && other !== file.databaseId) {
          throw new DeclarationRefusedError(
            `kind "${k.kind}" of "${k.owner}" is in both "${other}" and "${file.databaseId}"; the layout is corrupt and is not served`,
          )
        }
        this.placement.set(key, file.databaseId)
      }
    }
    this.logger.info('records: catalog loaded', { meta: { kinds: this.placement.size } })
  }

  private fileOf(owner: string, kind: string): Promise<OwnedSqliteFile> {
    const database = this.placement.get(keyOf(owner, kind))
    if (database === undefined) {
      return Promise.reject(new UnknownRecordKindError(`"${owner}" declared no kind "${kind}"`))
    }
    return this.router.recordsFileFor(database)
  }

  // ── declaration ────────────────────────────────────────────────────────

  async declareKinds(
    input: Parameters<IRecordsProvider['declareKinds']>[0],
  ): ReturnType<IRecordsProvider['declareKinds']> {
    const owner = recordsCallerOf(input)
    const byDatabase = new Map<DataStoreDatabase, Record<string, RecordKindDeclaration>>()
    const parsed = new Map<string, RecordKindDeclaration>()
    for (const [kind, raw] of Object.entries(input.kinds)) {
      parsed.set(kind, RecordKindDeclarationSchema.parse(raw))
    }
    await this.assertFamiliesInOneFile(owner, parsed)
    for (const [kind, declaration] of parsed) {
      const known = this.placement.get(keyOf(owner, kind))
      if (known !== undefined && known !== declaration.database) {
        throw new DeclarationRefusedError(
          `kind "${kind}" of "${owner}" lives in "${known}", declared for "${declaration.database}" - the engine never moves data`,
        )
      }
      const group = byDatabase.get(declaration.database) ?? {}
      byDatabase.set(declaration.database, { ...group, [kind]: declaration })
    }
    const merged: Record<string, DeclareKindResult> = {}
    for (const [database, kinds] of byDatabase) {
      const file = await this.router.recordsFileFor(database)
      const { kinds: results } = await file.records('declareKinds', { owner, kinds })
      for (const [kind, result] of Object.entries(results)) {
        this.placement.set(keyOf(owner, kind), database)
        merged[kind] = result
      }
    }
    return { kinds: merged }
  }

  /**
   * `transactFamily` (plan risk 8): kinds that must agree through one `transact` sit
   * in ONE file. A family split across files is refused whole, whether the split is
   * inside this declaration or against a kind of the same owner declared before.
   */
  private async assertFamiliesInOneFile(
    owner: string,
    declared: ReadonlyMap<string, RecordKindDeclaration>,
  ): Promise<void> {
    const families = new Map<string, Map<string, DataStoreDatabase>>()
    const note = (family: string, kind: string, database: DataStoreDatabase): void => {
      const members = families.get(family) ?? new Map<string, DataStoreDatabase>()
      members.set(kind, database)
      families.set(family, members)
    }
    for (const file of this.router.openFiles()) {
      if (file.databaseId === 'history') continue
      for (const k of await file.records('listKinds', { owner, counts: false })) {
        if (k.state === 'dropped' || declared.has(k.kind)) continue
        const family = k.declaration.transactFamily
        if (family !== undefined) note(family, k.kind, file.databaseId)
      }
    }
    for (const [kind, declaration] of declared) {
      if (declaration.transactFamily !== undefined) {
        note(declaration.transactFamily, kind, declaration.database)
      }
    }
    for (const [family, members] of families) {
      if (new Set(members.values()).size <= 1) continue
      const where = [...members.entries()].map(([k, db]) => `${k}@${db}`).join(', ')
      throw new DeclarationRefusedError(
        `transactFamily "${family}" of "${owner}" is split across files (${where}); a family lives in ONE file`,
      )
    }
  }

  // ── owner-scoped operations ────────────────────────────────────────────

  async get(input: Parameters<IRecordsProvider['get']>[0]): ReturnType<IRecordsProvider['get']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('get', { ...input, owner })
  }
  async getMany(
    input: Parameters<IRecordsProvider['getMany']>[0],
  ): ReturnType<IRecordsProvider['getMany']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('getMany', { ...input, owner })
  }
  async secretRefs(
    input: Parameters<IRecordsProvider['secretRefs']>[0],
  ): ReturnType<IRecordsProvider['secretRefs']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('secretRefs', { ...input, owner })
  }
  async put(input: Parameters<IRecordsProvider['put']>[0]): ReturnType<IRecordsProvider['put']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('put', { ...input, owner })
  }
  async putMany(
    input: Parameters<IRecordsProvider['putMany']>[0],
  ): ReturnType<IRecordsProvider['putMany']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('putMany', { ...input, owner })
  }
  async patch(
    input: Parameters<IRecordsProvider['patch']>[0],
  ): ReturnType<IRecordsProvider['patch']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('patch', { ...input, owner })
  }
  async delete(
    input: Parameters<IRecordsProvider['delete']>[0],
  ): ReturnType<IRecordsProvider['delete']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('delete', { ...input, owner })
  }
  async deleteMany(
    input: Parameters<IRecordsProvider['deleteMany']>[0],
  ): ReturnType<IRecordsProvider['deleteMany']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('deleteMany', { ...input, owner })
  }
  async query(
    input: Parameters<IRecordsProvider['query']>[0],
  ): ReturnType<IRecordsProvider['query']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('query', { ...input, owner })
  }
  async count(
    input: Parameters<IRecordsProvider['count']>[0],
  ): ReturnType<IRecordsProvider['count']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('count', { ...input, owner })
  }
  async histogram(
    input: Parameters<IRecordsProvider['histogram']>[0],
  ): ReturnType<IRecordsProvider['histogram']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('histogram', { ...input, owner })
  }
  async aggregate(
    input: Parameters<IRecordsProvider['aggregate']>[0],
  ): ReturnType<IRecordsProvider['aggregate']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('aggregate', { ...input, owner })
  }
  async deleteWhere(
    input: Parameters<IRecordsProvider['deleteWhere']>[0],
  ): ReturnType<IRecordsProvider['deleteWhere']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('deleteWhere', { ...input, owner })
  }
  /**
   * All ops must resolve to ONE file (`records/transact-refused` `cross-file`
   * otherwise); that file's engine then checks the family and runs one SQLite
   * transaction.
   */
  async transact(
    input: Parameters<IRecordsProvider['transact']>[0],
  ): ReturnType<IRecordsProvider['transact']> {
    const owner = recordsCallerOf(input)
    const files = new Map<DataStoreDatabase, string[]>()
    for (const op of input.ops) {
      const database = this.placement.get(keyOf(owner, op.kind))
      if (database === undefined) {
        throw new UnknownRecordKindError(`"${owner}" declared no kind "${op.kind}"`)
      }
      files.set(database, [...(files.get(database) ?? []), op.kind])
    }
    if (files.size > 1) {
      const where = [...files.entries()].map(
        ([db, kinds]) => `${[...new Set(kinds)].join('+')}@${db}`,
      )
      throw new TransactRefusedError(
        `cross-file: the ops span more than one database file (${where.join(', ')}); a transaction lives in ONE file`,
      )
    }
    const first = input.ops[0]
    if (first === undefined) throw new InvalidRecordError('transact: no ops')
    return (await this.fileOf(owner, first.kind)).records('transact', { ...input, owner })
  }

  async allocateId(
    input: Parameters<IRecordsProvider['allocateId']>[0],
  ): ReturnType<IRecordsProvider['allocateId']> {
    const owner = recordsCallerOf(input)
    return (await this.fileOf(owner, input.kind)).records('allocateId', { ...input, owner })
  }

  /** The D865 hook body: every file that holds kinds of this owner. */
  async deleteDevice(
    input: Parameters<IRecordsProvider['deleteDevice']>[0],
  ): ReturnType<IRecordsProvider['deleteDevice']> {
    const owner = recordsCallerOf(input)
    const deleted: Record<string, number> = {}
    const secretRefs: string[] = []
    const databases = new Set(
      [...this.placement.entries()]
        .filter(([key]) => key.startsWith(`${owner}\u0000`))
        .map(([, database]) => database),
    )
    for (const database of databases) {
      const file = await this.router.recordsFileFor(database)
      const result = await file.records('deleteDevice', { ...input, owner })
      Object.assign(deleted, result.deleted)
      secretRefs.push(...result.secretRefs)
    }
    return { deleted, secretRefs }
  }

  // ── admin: System -> Data and the migration copy path ──────────────────

  async listKinds(input: {
    readonly owner?: string | undefined
    readonly counts?: boolean | undefined
  }): Promise<{ kinds: StorageKind[] }> {
    const kinds: StorageKind[] = []
    for (const file of this.router.openFiles()) {
      if (file.databaseId === 'history') continue
      kinds.push(...(await file.records('listKinds', input)))
    }
    return { kinds }
  }

  async readRecords(
    input: Parameters<IStorageAdminProvider['readRecords']>[0],
  ): ReturnType<IStorageAdminProvider['readRecords']> {
    this.logger.info('records: admin read', {
      meta: { owner: input.owner, kind: input.kind, limit: input.limit },
    })
    const file = await this.fileOf(input.owner, input.kind)
    return file.records('query', input)
  }

  /** Housekeeping: delete rows past `expires_at` in every file that hosts kinds. */
  async sweepExpired(): Promise<number> {
    let deleted = 0
    for (const file of this.router.openFiles()) {
      if (file.databaseId === 'history') continue
      deleted += (await file.records('sweepExpired', {})).deleted
    }
    return deleted
  }
}
