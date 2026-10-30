/**
 * The `storage-admin` provider of the SQLite engine (D870): the operator's
 * maintenance reach into the settings database - list its tables and record
 * kinds, read a kind for diagnosis. It never drops a table: a table the code
 * no longer creates is dropped by hand, offline, on the operator hubs (D901).
 */
import { type IScopedLogger, type IStorageAdminProvider, type StorageTable } from '@camstack/types'
import type { StaleDataAudit } from './stale-data/stale-data-audit.js'
import type { RecordsProvider } from './records/records-provider.js'
import type { OwnedSqliteFile } from './owned-sqlite-file.js'
import type { SqliteSettingsBackend } from './sqlite-settings-backend.js'

export class StorageAdminProvider implements IStorageAdminProvider {
  constructor(
    private readonly backend: SqliteSettingsBackend,
    private readonly logger: IScopedLogger,
    /** The records provider the System -> Data methods delegate to (D881). */
    private readonly records: Pick<RecordsProvider, 'listKinds' | 'readRecords'>,
    /** The stale-data audit (D905): detection is read-only, deletion is the operator's. */
    private readonly audit: StaleDataAudit,
    /** Non-settings files (`events.db`, `history.db`) whose tables `listTables` lists too. */
    private readonly peerFiles: () => Promise<readonly OwnedSqliteFile[]> = async () => [],
  ) {}

  async staleDataReport(): ReturnType<IStorageAdminProvider['staleDataReport']> {
    return this.audit.current()
  }

  scanStaleData(): ReturnType<IStorageAdminProvider['scanStaleData']> {
    return this.audit.scan('manual')
  }

  dropOrphanedKind(
    input: Parameters<IStorageAdminProvider['dropOrphanedKind']>[0],
  ): ReturnType<IStorageAdminProvider['dropOrphanedKind']> {
    return this.audit.dropOrphanedKind(
      { owner: input.owner, kind: input.kind },
      input.caller.userId,
    )
  }

  unsetStaleSettingsKey(
    input: Parameters<IStorageAdminProvider['unsetStaleSettingsKey']>[0],
  ): ReturnType<IStorageAdminProvider['unsetStaleSettingsKey']> {
    return this.audit.unsetStaleSettingsKey(input.addonId, input.key, input.caller.userId)
  }

  listKinds(
    input: Parameters<IStorageAdminProvider['listKinds']>[0],
  ): ReturnType<IStorageAdminProvider['listKinds']> {
    return this.records.listKinds(input)
  }

  readRecords(
    input: Parameters<IStorageAdminProvider['readRecords']>[0],
  ): ReturnType<IStorageAdminProvider['readRecords']> {
    return this.records.readRecords(input)
  }

  async listTables(input: {
    ownerPrefix?: string | undefined
  }): Promise<{ tables: StorageTable[] }> {
    const tables: StorageTable[] = [...this.backend.listTables(input.ownerPrefix)]
    for (const file of await this.peerFiles()) {
      tables.push(...(await file.listPhysicalTables(input.ownerPrefix)))
    }
    tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    this.logger.info('storage-admin: listed tables', {
      meta: { tables: tables.length, ownerPrefix: input.ownerPrefix ?? null },
    })
    return { tables }
  }
}
