/**
 * Move the storage locations onto the write set and retire `isDefault` (planning#440 step 5, D385, D987).
 *
 * The orchestrator used to do this at every boot, against the rows it had just read. It is one
 * ledger step now, over the `storage-orchestrator/locations` records, and the orchestrator reads a
 * row as it finds it.
 *
 * 1. A row with no `mode` is stamped: `config.readOnly === true` or `enabled === false` fold to
 *    `readonly` (the conservative direction), everything else to `active`. `enabled` is derived
 *    from the mode and `config.readOnly` is removed.
 * 2. A type left with NO `active` location gets one made `active`: the row the retired default
 *    flag named, else the `<type>:default` row, else the lexicographically first id. A class with
 *    no write target records nowhere. The ids it re-enabled are left in the ledger summary.
 * 3. The `isDefault` field is removed from every row.
 *
 * A second run finds nothing to change. `tolerate`: a node without the records tables still boots.
 */
import { legacyModeOf, withLocationMode, type MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
  MigrationNote,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const STORAGE_LOCATIONS_WRITE_SET_MIGRATION_ID = 'hub/2026-11-08-storage-locations-write-set'

const META: MigrationMeta = {
  id: STORAGE_LOCATIONS_WRITE_SET_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 7,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Stamp every storage location with its mode, make sure each type can write, and drop isDefault',
  fixtureMark: 'displayName',
}

type Body = Record<string, unknown>

function isBody(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasTable(db: MigrationDatabase, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
    undefined
  )
}

function configOf(body: Body): Record<string, unknown> {
  const config = body['config']
  return isBody(config) ? config : {}
}

function modeOf(body: Body): string | undefined {
  const mode = body['mode']
  return typeof mode === 'string' ? mode : undefined
}

function stampedMode(body: Body): Body {
  if (modeOf(body) !== undefined) return body
  const enabled = body['enabled']
  const mode = legacyModeOf({
    config: configOf(body),
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
  })
  return { ...body, ...withLocationMode({ config: configOf(body) }, mode ?? 'active') }
}

interface Row {
  readonly id: string
  readonly body: Body
}

function withoutIsDefault(body: Body): Body {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'isDefault'))
}

function readRows(db: MigrationDatabase): readonly Row[] {
  const rows: Row[] = []
  const found = db
    .prepare(
      `SELECT r.id AS id, json(r.data) AS data FROM records r
         JOIN _record_kinds k ON k.kind_id = r.kind_id
        WHERE k.owner = ? AND k.kind = ? ORDER BY r.id`,
    )
    .all('storage-orchestrator', 'locations')
  for (const row of found) {
    if (typeof row !== 'object' || row === null) continue
    const id: unknown = Reflect.get(row, 'id')
    const data: unknown = Reflect.get(row, 'data')
    if (typeof id !== 'string' || typeof data !== 'string') continue
    const body: unknown = JSON.parse(data)
    if (isBody(body)) rows.push({ id, body })
  }
  return rows
}

export const STORAGE_LOCATIONS_WRITE_SET_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db): MigrationNote | undefined {
    if (!hasTable(db, '_record_kinds') || !hasTable(db, 'records')) return undefined
    const rows = readRows(db)
    const legacyDefaultOfType = new Map<string, string>()
    for (const row of rows) {
      if (row.body['isDefault'] === true) legacyDefaultOfType.set(String(row.body['type']), row.id)
    }
    const next = new Map<string, Body>(rows.map((r) => [r.id, stampedMode(r.body)]))

    const repaired: string[] = []
    const types = new Set(rows.map((r) => String(r.body['type'])))
    for (const type of types) {
      const ofType = rows.filter((r) => String(r.body['type']) === type).map((r) => r.id)
      if (ofType.some((id) => modeOf(next.get(id) ?? {}) === 'active')) continue
      const pick =
        ofType.find((id) => id === legacyDefaultOfType.get(type)) ??
        ofType.find((id) => id === `${type}:default`) ??
        ofType.toSorted()[0]
      const body = pick === undefined ? undefined : next.get(pick)
      if (pick === undefined || body === undefined) continue
      next.set(pick, { ...body, ...withLocationMode({ config: configOf(body) }, 'active') })
      repaired.push(pick)
    }

    const update = db.prepare(
      `UPDATE records SET data = jsonb(?), updated_at = ? WHERE id = ? AND kind_id IN
         (SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?)`,
    )
    const stamped: string[] = []
    for (const row of rows) {
      const after = withoutIsDefault(next.get(row.id) ?? row.body)
      if (JSON.stringify(after) === JSON.stringify(row.body)) continue
      update.run(JSON.stringify(after), Date.now(), row.id, 'storage-orchestrator', 'locations')
      if (row.body['mode'] === undefined) stamped.push(row.id)
    }
    if (stamped.length === 0 && repaired.length === 0) return undefined
    return { stamped, repaired }
  },
}
