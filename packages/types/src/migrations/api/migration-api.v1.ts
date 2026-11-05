/**
 * The ONLY surface a migration body may reach (planning#447). Version 1, append-only:
 * see `migration-api.v1.schema.ts` for the contract and the guard that holds it.
 *
 * It is a facade over what the addon already has (`ctx.migrationApi`); a migration's
 * ports are built from it (`BaseAddon.runMigrations(catalogue, (api) => ports)`) and
 * from nothing else, so a migration written against 1.4 keeps running on the kernel of
 * 1.9. `legacyRows` stays for as long as an old settings layout can still be found on
 * a node: against an absent store it answers `{}` / writes nothing, it never throws.
 */
import type { z } from 'zod'
import type { DefinedRecordKind } from '../../records/record-kind.js'
import type {
  MigrationApiInput as In,
  MIGRATION_API_VERSION,
  MigrationApiOutput as Out,
} from './migration-api.v1.schema.js'

export type { MigrationApiMethodName } from './migration-api.v1.schema.js'
export type MigrationApiVersion = typeof MIGRATION_API_VERSION

/** A record row; `data` is the kind's own shape. */
export interface MigrationRecordRowV1<T> {
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: T
}

/** One record kind of the addon, narrow on purpose: no transaction, no aggregate. */
export interface MigrationRecordsKindV1<T> {
  get(input: In<'records.get'>): Promise<MigrationRecordRowV1<T> | null>
  getResolved(input: In<'records.getResolved'>): Promise<MigrationRecordRowV1<T> | null>
  put(input: Omit<In<'records.put'>, 'data'> & { readonly data: T }): Promise<Out<'records.put'>>
  putMany(input: {
    readonly records: readonly (Omit<In<'records.put'>, 'data' | 'ifRev'> & { readonly data: T })[]
  }): Promise<Out<'records.putMany'>>
  patch(input: In<'records.patch'>): Promise<Out<'records.patch'>>
  delete(input: In<'records.delete'>): Promise<Out<'records.delete'>>
  query(input: In<'records.query'>): Promise<{
    readonly records: readonly MigrationRecordRowV1<T>[]
    readonly nextCursor: string | null
  }>
  deleteWhere(input: In<'records.deleteWhere'>): Promise<Out<'records.deleteWhere'>>
}

export interface MigrationApiV1 {
  readonly version: MigrationApiVersion
  readonly ledger: {
    declare(input: In<'ledger.declare'>): Promise<Out<'ledger.declare'>>
    start(input: In<'ledger.start'>): Promise<Out<'ledger.start'>>
    finish(input: In<'ledger.finish'>): Promise<Out<'ledger.finish'>>
  }
  /** The pre-records integration rows, by integration id. Absent store: `{}` and no-ops. */
  readonly legacyRows: {
    read(input: In<'legacyRows.read'>): Promise<Out<'legacyRows.read'>>
    clear(input: In<'legacyRows.clear'>): Promise<Out<'legacyRows.clear'>>
    patch(input: In<'legacyRows.patch'>): Promise<Out<'legacyRows.patch'>>
    deleteKeys(input: In<'legacyRows.deleteKeys'>): Promise<Out<'legacyRows.deleteKeys'>>
  }
  readonly records: {
    /** Bind one of THIS addon's declared kinds. Not a contract method: it names the handle. */
    kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): MigrationRecordsKindV1<z.infer<S>>
  }
  /** The addon's own settings store, secret values resolved on read. */
  readonly settings: {
    read(input: In<'settings.read'>): Promise<Out<'settings.read'>>
    write(input: In<'settings.write'>): Promise<Out<'settings.write'>>
    deleteKeys(input: In<'settings.deleteKeys'>): Promise<Out<'settings.deleteKeys'>>
  }
  /** The addon's own keychain handle. */
  readonly secrets: {
    resolve(input: In<'secrets.resolve'>): Promise<Out<'secrets.resolve'>>
    put(input: In<'secrets.put'>): Promise<Out<'secrets.put'>>
    delete(input: In<'secrets.delete'>): Promise<Out<'secrets.delete'>>
  }
  readonly integrations: {
    list(input: In<'integrations.list'>): Promise<Out<'integrations.list'>>
    get(input: In<'integrations.get'>): Promise<Out<'integrations.get'>>
  }
  readonly node: {
    localNodeId(input: In<'node.localNodeId'>): Promise<Out<'node.localNodeId'>>
  }
  readonly log: {
    info(input: In<'log.info'>): Promise<Out<'log.info'>>
    warn(input: In<'log.warn'>): Promise<Out<'log.warn'>>
  }
}
