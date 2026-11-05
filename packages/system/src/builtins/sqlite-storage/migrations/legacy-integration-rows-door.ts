/**
 * Migration-only door for the leftover integration rows (planning#416).
 *
 * Addon copy migrations run in the addon process, so they cannot open the
 * settings file (D679). This module is the read and the clear on the OWNER's
 * connection, served only by `migrations.readLegacyIntegrationRows` and
 * `migrations.clearLegacyIntegrationRows` (and the two writes the Home
 * Assistant copy migrations still need). It is deleted with the last copy
 * migration.
 *
 * A node that already dropped the store answers with no rows and accepts a
 * clear as a no-op. It never throws because the table or the record kind is
 * gone. Secrets stay markers here: sqlite-settings cannot speak for another
 * addon's keychain (D787). The owning addon's ports resolve and release them
 * with `resolveSecretMarkers`, the same call the old settings door used.
 */
import { collectSecretMarkerRefs } from '@camstack/types'
import type { MigrationDatabase } from './migration-types.js'

export const LEGACY_INTEGRATION_ROWS_TABLE = 'integration_settings'
const SETTINGS_TABLE = LEGACY_INTEGRATION_ROWS_TABLE
const INTEGRATIONS_TABLE = 'integrations'
export const LEGACY_INTEGRATION_ROWS_KIND = 'integration-settings'
const SETTINGS_KIND = LEGACY_INTEGRATION_ROWS_KIND
const INTEGRATIONS_KIND = 'integrations'
const KIND_OWNER = 'integration-registry'

/** The column layout the leftover store used. A no-op when the table is already there. */
export function ensureLegacyIntegrationRowsTable(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL
    )
  `)
}

export interface LegacyIntegrationRowsClear {
  readonly rows: number
  readonly secrets: number
}

export interface LegacyIntegrationRowsPatch {
  readonly written: boolean
}

export interface LegacyIntegrationRowsKeyDelete {
  /** `false` when the store is already gone. */
  readonly present: boolean
  readonly removed: Readonly<Record<string, unknown>>
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
    if (typeof row !== 'object' || row === null || !('name' in row)) continue
    const name: unknown = Reflect.get(row, 'name')
    if (typeof name === 'string') names.add(name)
  }
  return names
}

function cell(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return Reflect.get(row, key)
}

function textField(row: unknown, key: string): string | null {
  if (typeof row !== 'object' || row === null) return null
  const value: unknown = Reflect.get(row, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function kindIdOf(db: MigrationDatabase, kind: string): number | null {
  if (!hasTable(db, '_record_kinds')) return null
  const row = db
    .prepare(
      `SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ? AND state <> 'dropped'`,
    )
    .get(KIND_OWNER, kind)
  if (typeof row !== 'object' || row === null) return null
  const kindId: unknown = Reflect.get(row, 'kind_id')
  return typeof kindId === 'number' ? kindId : null
}

function serializeSetting(value: unknown): { readonly value: string; readonly valueType: string } {
  if (typeof value === 'number') return { value: String(value), valueType: 'number' }
  if (typeof value === 'boolean') return { value: String(value), valueType: 'boolean' }
  if (typeof value === 'string') return { value, valueType: 'string' }
  return { value: JSON.stringify(value), valueType: 'json' }
}

/** Decode one stored cell. A `json` cell may already be an object (the collection surface parses it). */
function deserializeSetting(raw: unknown, valueType: string): unknown {
  if (valueType === 'json') {
    if (typeof raw !== 'string') return raw
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  const value = String(raw ?? '')
  if (valueType === 'number') return Number(value)
  if (valueType === 'boolean') return value === 'true'
  return value
}

function putCell(
  into: Record<string, unknown>,
  key: string | null,
  raw: unknown,
  valueType: string | null,
): void {
  if (key === null) return
  into[key] = deserializeSetting(raw, valueType ?? 'string')
}

function readPhysical(db: MigrationDatabase, integrationId: string): Record<string, unknown> {
  if (!hasTable(db, SETTINGS_TABLE)) return {}
  const columns = columnsOf(db, SETTINGS_TABLE)
  const out: Record<string, unknown> = {}
  if (columns.has('integration_id')) {
    for (const row of db
      .prepare(
        'SELECT key, value, value_type AS valueType FROM integration_settings WHERE integration_id = ?',
      )
      .all(integrationId)) {
      putCell(out, textField(row, 'key'), cell(row, 'value'), textField(row, 'valueType'))
    }
    return out
  }
  if (!columns.has('data')) return {}
  for (const row of db
    .prepare(
      `SELECT json_extract(data, '$.key') AS key, json_extract(data, '$.value') AS value,
              json_extract(data, '$.value_type') AS valueType
       FROM integration_settings WHERE json_extract(data, '$.integration_id') = ?`,
    )
    .all(integrationId)) {
    putCell(out, textField(row, 'key'), cell(row, 'value'), textField(row, 'valueType'))
  }
  return out
}

function readRecordKind(db: MigrationDatabase, integrationId: string): Record<string, unknown> {
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId === null || !hasTable(db, 'records')) return {}
  const out: Record<string, unknown> = {}
  for (const row of db
    .prepare(
      `SELECT json_extract(data, '$.key') AS key, json_extract(data, '$.value') AS value,
              json_extract(data, '$.valueType') AS valueType
       FROM records WHERE kind_id = ? AND json_extract(data, '$.integrationId') = ?`,
    )
    .all(kindId, integrationId)) {
    putCell(out, textField(row, 'key'), cell(row, 'value'), textField(row, 'valueType'))
  }
  return out
}

function storePresent(db: MigrationDatabase): boolean {
  return hasTable(db, SETTINGS_TABLE) || kindIdOf(db, SETTINGS_KIND) !== null
}

/** The rows of one integration. Empty when the store is gone or the integration has none. */
export function readLegacyIntegrationRows(
  db: MigrationDatabase,
  integrationId: string,
): Readonly<Record<string, unknown>> {
  // The record kind is the adopted copy and wins on a key that still exists in both.
  return { ...readPhysical(db, integrationId), ...readRecordKind(db, integrationId) }
}

function deletePhysical(db: MigrationDatabase, integrationId: string): number {
  if (!hasTable(db, SETTINGS_TABLE)) return 0
  const columns = columnsOf(db, SETTINGS_TABLE)
  if (columns.has('integration_id')) {
    const result = db
      .prepare('DELETE FROM integration_settings WHERE integration_id = ?')
      .run(integrationId)
    return Number(result.changes)
  }
  if (!columns.has('data')) return 0
  const result = db
    .prepare(`DELETE FROM integration_settings WHERE json_extract(data, '$.integration_id') = ?`)
    .run(integrationId)
  return Number(result.changes)
}

function deleteRecordKind(db: MigrationDatabase, integrationId: string): number {
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId === null || !hasTable(db, 'records')) return 0
  const result = db
    .prepare(`DELETE FROM records WHERE kind_id = ? AND json_extract(data, '$.integrationId') = ?`)
    .run(kindId, integrationId)
  return Number(result.changes)
}

/**
 * Delete one integration's rows. Does not touch the keychain: the caller
 * releases the refs first, while the rows still point at them. A missing
 * store is a no-op. `secrets` is how many marker refs the rows held.
 */
export function clearLegacyIntegrationRows(
  db: MigrationDatabase,
  integrationId: string,
): LegacyIntegrationRowsClear {
  const stored = readLegacyIntegrationRows(db, integrationId)
  const refs = collectSecretMarkerRefs(stored)
  const rows = deletePhysical(db, integrationId) + deleteRecordKind(db, integrationId)
  return { rows, secrets: refs.length }
}

function upsertPhysical(
  db: MigrationDatabase,
  integrationId: string,
  key: string,
  encoded: { readonly value: string; readonly valueType: string },
): boolean {
  if (!hasTable(db, SETTINGS_TABLE)) return false
  const columns = columnsOf(db, SETTINGS_TABLE)
  const rowId = `${integrationId}:${key}`
  if (columns.has('integration_id')) {
    db.prepare('DELETE FROM integration_settings WHERE integration_id = ? AND key = ?').run(
      integrationId,
      key,
    )
    db.prepare(
      'INSERT INTO integration_settings (id, integration_id, key, value, value_type) VALUES (?, ?, ?, ?, ?)',
    ).run(rowId, integrationId, key, encoded.value, encoded.valueType)
    return true
  }
  if (!columns.has('data')) return false
  const body = JSON.stringify({
    integration_id: integrationId,
    key,
    value: encoded.value,
    value_type: encoded.valueType,
  })
  const existing = db
    .prepare(
      `SELECT id FROM integration_settings
       WHERE json_extract(data, '$.integration_id') = ? AND json_extract(data, '$.key') = ?`,
    )
    .get(integrationId, key)
  const id = textField(existing, 'id') ?? rowId
  if (existing !== undefined) {
    db.prepare('UPDATE integration_settings SET data = ? WHERE id = ?').run(body, id)
  } else {
    db.prepare('INSERT INTO integration_settings (id, data) VALUES (?, ?)').run(id, body)
  }
  return true
}

function upsertRecordKind(
  db: MigrationDatabase,
  integrationId: string,
  key: string,
  encoded: { readonly value: string; readonly valueType: string },
): boolean {
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId === null || !hasTable(db, 'records')) return false
  const rowId = `${integrationId}:${key}`
  const body = JSON.stringify({
    integrationId,
    key,
    value: encoded.value,
    valueType: encoded.valueType,
  })
  const now = Date.now()
  db.prepare(
    `INSERT INTO records (kind_id, id, rev, updated_at, data) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(kind_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = rev + 1`,
  ).run(kindId, rowId, now, body)
  return true
}

/** Upsert only the keys in `patch`. Other keys, including secret markers, stay as stored. */
export function patchLegacyIntegrationRows(
  db: MigrationDatabase,
  integrationId: string,
  patch: Readonly<Record<string, unknown>>,
): LegacyIntegrationRowsPatch {
  if (!storePresent(db)) return { written: false }
  for (const [key, value] of Object.entries(patch)) {
    const encoded = serializeSetting(value)
    const wroteRecord = upsertRecordKind(db, integrationId, key, encoded)
    const wroteTable = upsertPhysical(db, integrationId, key, encoded)
    if (!wroteRecord && !wroteTable) return { written: false }
  }
  return { written: true }
}

function deletePhysicalKeys(
  db: MigrationDatabase,
  integrationId: string,
  keys: ReadonlySet<string>,
): void {
  if (!hasTable(db, SETTINGS_TABLE) || keys.size === 0) return
  const columns = columnsOf(db, SETTINGS_TABLE)
  if (columns.has('integration_id')) {
    const statement = db.prepare(
      'DELETE FROM integration_settings WHERE integration_id = ? AND key = ?',
    )
    for (const key of keys) statement.run(integrationId, key)
    return
  }
  if (!columns.has('data')) return
  const statement = db.prepare(
    `DELETE FROM integration_settings
     WHERE json_extract(data, '$.integration_id') = ? AND json_extract(data, '$.key') = ?`,
  )
  for (const key of keys) statement.run(integrationId, key)
}

function deleteRecordKeys(
  db: MigrationDatabase,
  integrationId: string,
  keys: ReadonlySet<string>,
): void {
  const kindId = kindIdOf(db, SETTINGS_KIND)
  if (kindId === null || !hasTable(db, 'records') || keys.size === 0) return
  const statement = db.prepare(
    `DELETE FROM records WHERE kind_id = ? AND json_extract(data, '$.integrationId') = ?
     AND json_extract(data, '$.key') = ?`,
  )
  for (const key of keys) statement.run(kindId, integrationId, key)
}

/** Remove named keys. `present` is false when the store is already gone. */
export function deleteLegacyIntegrationRowKeys(
  db: MigrationDatabase,
  integrationId: string,
  keys: readonly string[],
): LegacyIntegrationRowsKeyDelete {
  if (!storePresent(db)) return { present: false, removed: {} }
  const stored = readLegacyIntegrationRows(db, integrationId)
  const drop = new Set(keys)
  const removed: Record<string, unknown> = {}
  for (const key of drop) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) removed[key] = stored[key]
  }
  deletePhysicalKeys(db, integrationId, drop)
  deleteRecordKeys(db, integrationId, drop)
  return { present: true, removed }
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

/** The addon that owns the integration, or null when the integration is gone. */
export function legacyIntegrationAddonId(
  db: MigrationDatabase,
  integrationId: string,
): string | null {
  return addonFromRecords(db, integrationId) ?? addonFromTable(db, integrationId)
}
