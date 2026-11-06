/**
 * Drop the legacy `integrations`, `storage_locations` and `storage_drain_state` tables (planning#440 step 5, D987).
 *
 * Both stores now live in record kinds (`integration-registry/integrations`,
 * `storage-orchestrator/locations`); the boot copy that moved the rows is gone. Each table is
 * dropped, with its `_collection_declarations` row, only when every legacy row id already
 * exists in its record kind (or the table is empty). A table with a row its kind lacks was never
 * (fully) copied: the step throws a typed refusal naming the table, the count and the first
 * missing ids (the engine logs it as a warn), the transaction leaves everything in place, and the
 * next boot retries. A second run finds no table and does nothing.
 *
 * Drain state needs a copy first: a `storage_drain_state` row of a location that still exists in
 * the `locations` kind is copied into `drain-state` (never over an existing record); a row of a
 * location that is gone is an orphan and is dropped. Both id lists are left in the ledger summary
 * and logged at info by the engine.
 *
 * `tolerate`: a node that was never copied must still boot.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
  MigrationNote,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION_ID =
  'hub/2026-11-06-drop-legacy-integrations-and-storage-locations'

interface LegacyStore {
  readonly table: string
  readonly owner: string
  readonly kind: string
  /** The legacy table's primary-key column; a record id is the same string. */
  readonly idColumn: string
}

const LEGACY_STORES: readonly LegacyStore[] = [
  {
    table: 'integrations',
    owner: 'integration-registry',
    kind: 'integrations',
    idColumn: 'id',
  },
  {
    table: 'storage_locations',
    owner: 'storage-orchestrator',
    kind: 'locations',
    idColumn: 'id',
  },
  {
    table: 'storage_drain_state',
    owner: 'storage-orchestrator',
    kind: 'drain-state',
    idColumn: 'location_id',
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
  readonly missingIds: readonly string[]
}

const NAMED_IDS = 5

/** The drop refused: a legacy table holds rows its record kind never received. */
export class LegacyStoreDropRefused extends Error {
  readonly blocked: readonly UncopiedLegacyStore[]

  constructor(blocked: readonly UncopiedLegacyStore[]) {
    const detail = blocked
      .map((s) => {
        const named = s.missingIds.slice(0, NAMED_IDS).join(', ')
        const more = s.missingIds.length > NAMED_IDS ? ', ...' : ''
        return `'${s.table}' (${s.missingIds.length} row(s) without a record: ${named}${more})`
      })
      .join('; ')
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

function idsOf(rows: readonly unknown[]): readonly string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id: unknown = Reflect.get(row, 'id')
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

function tableIds(db: MigrationDatabase, store: LegacyStore): readonly string[] {
  if (!hasTable(db, store.table)) return []
  return idsOf(
    db.prepare(`SELECT "${store.idColumn}" AS id FROM "${store.table}" ORDER BY 1`).all(),
  )
}

function kindIds(db: MigrationDatabase, store: LegacyStore): ReadonlySet<string> {
  if (!hasTable(db, '_record_kinds') || !hasTable(db, 'records')) return new Set()
  return new Set(
    idsOf(
      db
        .prepare(
          `SELECT id FROM records WHERE kind_id IN
             (SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?)`,
        )
        .all(store.owner, store.kind),
    ),
  )
}

function dropStore(db: MigrationDatabase, store: LegacyStore): void {
  if (hasTable(db, store.table)) db.exec(`DROP TABLE "${store.table}"`)
  if (hasTable(db, '_collection_declarations')) {
    db.prepare('DELETE FROM _collection_declarations WHERE name = ?').run(store.table)
  }
}

const DRAIN_STORE = LEGACY_STORES.find((s) => s.table === 'storage_drain_state')
const LOCATIONS_STORE = LEGACY_STORES.find((s) => s.table === 'storage_locations')

function kindIdOf(db: MigrationDatabase, store: LegacyStore): number | null {
  if (!hasTable(db, '_record_kinds')) return null
  const row: unknown = db
    .prepare('SELECT kind_id AS id FROM _record_kinds WHERE owner = ? AND kind = ?')
    .get(store.owner, store.kind)
  const id: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : undefined
  return typeof id === 'number' ? id : null
}

function finite(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function drainBody(row: unknown): Record<string, unknown> | null {
  if (typeof row !== 'object' || row === null) return null
  const locationId: unknown = Reflect.get(row, 'location_id')
  if (typeof locationId !== 'string' || locationId === '') return null
  const peer: unknown = Reflect.get(row, 'last_peer_bytes')
  return {
    locationId,
    startedAtMs: finite(Reflect.get(row, 'started_at_ms'), 0),
    startBytes: finite(Reflect.get(row, 'start_bytes'), 0),
    capBytes: finite(Reflect.get(row, 'cap_bytes'), 0),
    lastPeerBytes: typeof peer === 'number' && Number.isFinite(peer) ? peer : null,
    lastSweepMs: finite(Reflect.get(row, 'last_sweep_ms'), 0),
    observedGrowthBytes: finite(Reflect.get(row, 'observed_growth_bytes'), 0),
    observedElapsedMs: finite(Reflect.get(row, 'observed_elapsed_ms'), 0),
  }
}

interface DrainOutcome {
  readonly copied: readonly string[]
  readonly orphaned: readonly string[]
}

/**
 * A drain row of a location that still exists is COPIED into the `drain-state` kind (never over a
 * record that is there); a drain row of a location that no longer exists is an orphan, droppable.
 */
function settleDrainRows(db: MigrationDatabase): DrainOutcome {
  const none: DrainOutcome = { copied: [], orphaned: [] }
  if (DRAIN_STORE === undefined || LOCATIONS_STORE === undefined) return none
  if (!hasTable(db, DRAIN_STORE.table) || !hasTable(db, 'records')) return none
  const kindId = kindIdOf(db, DRAIN_STORE)
  if (kindId === null) return none
  const locations = kindIds(db, LOCATIONS_STORE)
  const have = kindIds(db, DRAIN_STORE)
  const insert = db.prepare(
    'INSERT OR IGNORE INTO records (kind_id, id, updated_at, data) VALUES (?, ?, ?, jsonb(?))',
  )
  const copied: string[] = []
  const orphaned: string[] = []
  for (const row of db.prepare(`SELECT * FROM "${DRAIN_STORE.table}" ORDER BY 1`).all()) {
    const body = drainBody(row)
    const id = body === null ? null : String(body['locationId'])
    if (body === null || id === null || have.has(id)) continue
    if (!locations.has(id)) {
      orphaned.push(id)
      continue
    }
    insert.run(kindId, id, Date.now(), JSON.stringify(body))
    copied.push(id)
  }
  return { copied, orphaned }
}

export const DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db): MigrationNote | undefined {
    const drain = settleDrainRows(db)
    const blocked: UncopiedLegacyStore[] = []
    for (const store of LEGACY_STORES) {
      const legacy = tableIds(db, store).filter(
        (id) => store !== DRAIN_STORE || !drain.orphaned.includes(id),
      )
      if (legacy.length === 0) continue
      const have = kindIds(db, store)
      const missingIds = legacy.filter((id) => !have.has(id))
      if (missingIds.length > 0) blocked.push({ table: store.table, missingIds })
    }
    if (blocked.length > 0) throw new LegacyStoreDropRefused(blocked)
    for (const store of LEGACY_STORES) dropStore(db, store)
    if (drain.copied.length === 0 && drain.orphaned.length === 0) return undefined
    return { drainCopied: drain.copied, drainOrphansDropped: drain.orphaned }
  },
}
