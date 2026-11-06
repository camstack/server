/**
 * Drop the legacy `integrations` and `storage_locations` tables (planning#440 step 5, D987).
 *
 * Both stores now live in record kinds (`integration-registry/integrations`,
 * `storage-orchestrator/locations`); the boot copy that moved the rows is gone. Each table is
 * dropped, with its `_collection_declarations` row, only when its record kind already holds
 * rows or the table itself is empty. A table that still has rows while its kind is empty was
 * never copied: the step throws a typed refusal naming the table and the count, the transaction
 * leaves everything in place, and the next boot retries. A second run finds no table and does
 * nothing.
 *
 * `tolerate`: a node that was never copied must still boot.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION_ID =
  'hub/2026-11-06-drop-legacy-integrations-and-storage-locations'

interface LegacyStore {
  readonly table: string
  readonly owner: string
  readonly kind: string
}

const LEGACY_STORES: readonly LegacyStore[] = [
  {
    table: 'integrations',
    owner: 'integration-registry',
    kind: 'integrations',
  },
  {
    table: 'storage_locations',
    owner: 'storage-orchestrator',
    kind: 'locations',
  },
]

const META: MigrationMeta = {
  id: DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 5,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Drop the integrations and storage_locations tables once their record kinds hold the rows',
  fixtureMark: 'minFreePercent',
}

export interface UncopiedLegacyStore {
  readonly table: string
  readonly rowCount: number
}

/** The drop refused: a legacy table holds rows its record kind never received. */
export class LegacyStoreDropRefused extends Error {
  readonly blocked: readonly UncopiedLegacyStore[]

  constructor(blocked: readonly UncopiedLegacyStore[]) {
    const detail = blocked.map((s) => `'${s.table}' (${s.rowCount} row(s))`).join(', ')
    super(`legacy table still holds rows its record kind does not have: ${detail}`)
    this.name = 'LegacyStoreDropRefused'
    this.blocked = blocked
  }
}

function hasTable(db: MigrationDatabase, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
    undefined
  )
}

function countOf(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0
  const n: unknown = Reflect.get(row, 'n')
  return typeof n === 'number' ? n : 0
}

function tableRows(db: MigrationDatabase, table: string): number {
  if (!hasTable(db, table)) return 0
  return countOf(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get())
}

function kindRows(db: MigrationDatabase, store: LegacyStore): number {
  if (!hasTable(db, '_record_kinds') || !hasTable(db, 'records')) return 0
  return countOf(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM records WHERE kind_id IN
           (SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?)`,
      )
      .get(store.owner, store.kind),
  )
}

function dropStore(db: MigrationDatabase, store: LegacyStore): void {
  if (hasTable(db, store.table)) db.exec(`DROP TABLE "${store.table}"`)
  if (hasTable(db, '_collection_declarations')) {
    db.prepare('DELETE FROM _collection_declarations WHERE name = ?').run(store.table)
  }
}

export const DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db) {
    const blocked: UncopiedLegacyStore[] = []
    for (const store of LEGACY_STORES) {
      const rows = tableRows(db, store.table)
      if (rows > 0 && kindRows(db, store) === 0)
        blocked.push({ table: store.table, rowCount: rows })
    }
    if (blocked.length > 0) throw new LegacyStoreDropRefused(blocked)
    for (const store of LEGACY_STORES) dropStore(db, store)
  },
}
