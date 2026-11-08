/**
 * Integration rows are keyed by the BARE addon id. A hub-resident addon passed its `ctx.id`
 * (`addon:<id>`) to `integrationInstances.createInstance`, so rows such as `addon:loki-logging` reached the
 * `integrations` records of `integration-registry`. The registry now canonicalises on write and
 * lookup; this migration re-stamps the rows already on disk, `addon:<id>` → `<id>`, keeping the
 * row id and every other field.
 *
 * The rows are `records` of kind `integrations` (owner `integration-registry`); `data` is JSONB.
 * A rewrite bumps `rev`, so an optimistic writer holding the old row conflicts instead of
 * overwriting. When a bare-id row already exists for the same addon the migration writes
 * NOTHING for any addon and fails naming both row ids: two rows for one addon is an operator
 * decision, never a merge. A second run finds no prefixed row and edits nothing.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const INTEGRATION_ADDON_ID_BARE_MIGRATION_ID = 'hub/2026-11-02-integration-addon-id-bare'

const META: MigrationMeta = {
  id: INTEGRATION_ADDON_ID_BARE_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 2,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  // A duplicate pair needs the operator, and must not keep the hub from booting.
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Re-stamp integration rows keyed `addon:<id>` with the bare addon id, keeping the row id and every other field',
  fixtureMark: 'name',
}

const PREFIX = 'addon:'

function hasTable(db: MigrationDatabase, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
    undefined
  )
}

interface IntegrationRow {
  readonly id: string
  readonly addonId: string
}

function integrationRows(db: MigrationDatabase, kindId: number): readonly IntegrationRow[] {
  const out: IntegrationRow[] = []
  const rows = db
    .prepare(`SELECT id, json_extract(data, '$.addonId') AS addonId FROM records WHERE kind_id = ?`)
    .all(kindId)
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id: unknown = Reflect.get(row, 'id')
    const addonId: unknown = Reflect.get(row, 'addonId')
    if (typeof id === 'string' && typeof addonId === 'string') out.push({ id, addonId })
  }
  return out
}

function kindIdOf(db: MigrationDatabase): number | null {
  const row = db
    .prepare('SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?')
    .get('integration-registry', 'integrations')
  if (typeof row !== 'object' || row === null) return null
  const kindId: unknown = Reflect.get(row, 'kind_id')
  return typeof kindId === 'number' ? kindId : null
}

export const INTEGRATION_ADDON_ID_BARE_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db) {
    if (!hasTable(db, 'records') || !hasTable(db, '_record_kinds')) return
    const kindId = kindIdOf(db)
    if (kindId === null) return
    const rows = integrationRows(db, kindId)
    const prefixed = rows.filter((r) => r.addonId.startsWith(PREFIX))
    if (prefixed.length === 0) return
    const bareOwner = new Map<string, string>()
    for (const r of rows) if (!r.addonId.startsWith(PREFIX)) bareOwner.set(r.addonId, r.id)
    const clashes = prefixed.flatMap((r) => {
      const bare = r.addonId.slice(PREFIX.length)
      const other = bareOwner.get(bare)
      return other === undefined ? [] : [`${r.id} ("${r.addonId}") and ${other} ("${bare}")`]
    })
    if (clashes.length > 0) {
      throw new Error(
        `two integration rows exist for one addon, nothing was rewritten: ${clashes.join('; ')}. Delete one of each pair, then retry.`,
      )
    }
    const update = db.prepare(
      `UPDATE records SET data = jsonb(json_set(json(data), '$.addonId', ?)), rev = rev + 1 WHERE kind_id = ? AND id = ?`,
    )
    for (const r of prefixed) update.run(r.addonId.slice(PREFIX.length), kindId, r.id)
  },
}
