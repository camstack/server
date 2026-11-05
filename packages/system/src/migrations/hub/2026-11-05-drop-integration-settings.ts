/**
 * Drop the legacy `integration_settings` store (planning#416, D1007).
 *
 * Every integration's configuration now lives on its instance record. The per-addon
 * migrations that copied these rows are recorded in `_migrations`. This step removes
 * the table, and the record-kind rows of `integration-settings`, only when no row
 * remains for an addon whose copy migration is not `applied`. Otherwise it throws
 * a typed refusal naming the addon and the row count, and the transaction leaves
 * the table in place. A second run finds nothing to drop.
 *
 * `tolerate`: an unmigrated node must still boot so the addon's own migration can
 * copy the rows. The failure stays in the ledger and is retried on the next boot.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const DROP_INTEGRATION_SETTINGS_MIGRATION_ID = 'hub/2026-11-05-drop-integration-settings'

const SETTINGS_TABLE = 'integration_settings'
const INTEGRATIONS_TABLE = 'integrations'
const SETTINGS_KIND = 'integration-settings'
const INTEGRATIONS_KIND = 'integrations'
const KIND_OWNER = 'integration-registry'
const UNKNOWN_ADDON = '(unknown)'

const COPY_SUFFIXES = ['integration-rows-to-record', 'instance-settings-to-record'] as const

const META: MigrationMeta = {
  id: DROP_INTEGRATION_SETTINGS_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 4,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Drop integration_settings once every addon that still has rows has an applied migration that copied them',
  fixtureMark: 'value',
}

export interface UnmigratedIntegrationSettings {
  readonly addonId: string
  readonly rowCount: number
}

/** The drop refused: rows remain for an addon whose copy migration is not applied. */
export class IntegrationSettingsDropRefused extends Error {
  readonly blocked: readonly UnmigratedIntegrationSettings[]
  readonly addonId: string
  readonly rowCount: number

  constructor(blocked: readonly UnmigratedIntegrationSettings[]) {
    const detail = blocked.map((row) => `'${row.addonId}' (${row.rowCount} row(s))`).join(', ')
    super(
      `integration_settings still holds rows for an addon whose migration is not applied: ${detail}`,
    )
    this.name = 'IntegrationSettingsDropRefused'
    this.blocked = blocked
    const first = blocked[0]
    this.addonId = first?.addonId ?? UNKNOWN_ADDON
    this.rowCount = first?.rowCount ?? 0
  }
}

function hasTable(db: MigrationDatabase, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
    undefined
  )
}

function columnsOf(db: MigrationDatabase, table: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const row of db.prepare(`PRAGMA table_info("${table}")`).all()) {
    if (typeof row === 'object' && row !== null && 'name' in row) {
      const name: unknown = Reflect.get(row, 'name')
      if (typeof name === 'string') names.add(name)
    }
  }
  return names
}

function textField(row: unknown, key: string): string | null {
  if (typeof row !== 'object' || row === null) return null
  const value: unknown = Reflect.get(row, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function kindIdOf(db: MigrationDatabase, kind: string): number | null {
  if (!hasTable(db, '_record_kinds')) return null
  const row = db
    .prepare('SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?')
    .get(KIND_OWNER, kind)
  if (typeof row !== 'object' || row === null) return null
  const kindId: unknown = Reflect.get(row, 'kind_id')
  return typeof kindId === 'number' ? kindId : null
}

function addonFromTable(db: MigrationDatabase, integrationId: string): string | null {
  if (!hasTable(db, INTEGRATIONS_TABLE)) return null
  const columns = columnsOf(db, INTEGRATIONS_TABLE)
  if (columns.has('addon_id')) {
    return textField(
      db.prepare('SELECT addon_id AS addonId FROM integrations WHERE id = ?').get(integrationId),
      'addonId',
    )
  }
  if (!columns.has('data')) return null
  return textField(
    db
      .prepare(`SELECT json_extract(data, '$.addon_id') AS addonId FROM integrations WHERE id = ?`)
      .get(integrationId),
    'addonId',
  )
}

function addonFromRecords(db: MigrationDatabase, integrationId: string): string | null {
  const kindId = kindIdOf(db, INTEGRATIONS_KIND)
  if (kindId === null || !hasTable(db, 'records')) return null
  return textField(
    db
      .prepare(
        `SELECT json_extract(data, '$.addonId') AS addonId FROM records WHERE kind_id = ? AND id = ?`,
      )
      .get(kindId, integrationId),
    'addonId',
  )
}

function integrationIds(db: MigrationDatabase, sql: string, params: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const row of db.prepare(sql).all(...params)) {
    const id = textField(row, 'integrationId')
    ids.push(id ?? '')
  }
  return ids
}

function physicalIntegrationIds(db: MigrationDatabase): readonly string[] {
  if (!hasTable(db, SETTINGS_TABLE)) return []
  const columns = columnsOf(db, SETTINGS_TABLE)
  if (columns.has('integration_id')) {
    return integrationIds(
      db,
      'SELECT integration_id AS integrationId FROM integration_settings',
      [],
    )
  }
  if (columns.has('data')) {
    return integrationIds(
      db,
      `SELECT json_extract(data, '$.integration_id') AS integrationId FROM integration_settings`,
      [],
    )
  }
  return []
}

function recordIntegrationIds(db: MigrationDatabase): readonly string[] {
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId === null || !hasTable(db, 'records')) return []
  return integrationIds(
    db,
    `SELECT json_extract(data, '$.integrationId') AS integrationId FROM records WHERE kind_id = ?`,
    [kindId],
  )
}

function bump(counts: Map<string, number>, addonId: string | null): void {
  const key = addonId === null || addonId.length === 0 ? UNKNOWN_ADDON : addonId
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** Rows of the legacy store, counted per owning addon. An unresolved owner is `(unknown)`. */
export function legacyIntegrationSettingsByAddon(
  db: MigrationDatabase,
): readonly UnmigratedIntegrationSettings[] {
  const counts = new Map<string, number>()
  const cache = new Map<string, string | null>()
  const ownerOf = (integrationId: string): string | null => {
    if (integrationId.length === 0) return null
    const cached = cache.get(integrationId)
    if (cached !== undefined) return cached
    const addon = addonFromRecords(db, integrationId) ?? addonFromTable(db, integrationId)
    cache.set(integrationId, addon)
    return addon
  }
  for (const integrationId of physicalIntegrationIds(db)) bump(counts, ownerOf(integrationId))
  for (const integrationId of recordIntegrationIds(db)) bump(counts, ownerOf(integrationId))
  return [...counts.entries()].map(([addonId, rowCount]) => ({ addonId, rowCount }))
}

function copyApplied(db: MigrationDatabase, addonId: string): boolean {
  if (addonId === UNKNOWN_ADDON || !hasTable(db, '_migrations')) return false
  for (const suffix of COPY_SUFFIXES) {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM _migrations WHERE owner = ? AND status = 'applied' AND id LIKE ?`,
      )
      .get(addonId, `${addonId}/%-${suffix}`)
    if (row !== undefined) return true
  }
  return false
}

function dropStore(db: MigrationDatabase): void {
  if (hasTable(db, SETTINGS_TABLE)) db.exec(`DROP TABLE "${SETTINGS_TABLE}"`)
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId !== null && hasTable(db, 'records')) {
    db.prepare('DELETE FROM records WHERE kind_id = ?').run(kindId)
  }
}

export const DROP_INTEGRATION_SETTINGS_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db) {
    const blocked = legacyIntegrationSettingsByAddon(db).filter(
      (row) => !copyApplied(db, row.addonId),
    )
    if (blocked.length > 0) throw new IntegrationSettingsDropRefused(blocked)
    dropStore(db)
  },
}
