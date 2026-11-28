/**
 * Applying the edits a `plan` migration returns (D987, M3). Synchronous over the
 * migration's own connection and ALWAYS called inside the per-migration
 * transaction, so the edits and the `applied` ledger row commit together or not at
 * all; this file opens no transaction of its own.
 *
 * ## The vocabulary, and what each op is on disk
 *
 * - `setKeys` / `deleteKeys`: `scope` is a key-value collection table
 *   (`id TEXT PRIMARY KEY, data TEXT` — the canonical settings shape, e.g.
 *   `<addonId>:addon-settings`); a key is the `id`, its value the JSON in `data`.
 * - `putRow` / `deleteRow`: any table; `key` names the columns that identify the
 *   row, `row` the columns to set (an insert when no row matches).
 * - `upsertRecord` / `deleteRecord`: written by the RECORDS ENGINE of this file through
 *   {@link MigrationRecordWriter} (its `writeRecord` / `deleteRecord`, no transaction of
 *   their own), so the derived columns (`device_id`, `at`, `expires_at`, `rev`) and the
 *   kind's rules hold exactly as for `put`. The body was checked by the kind's Zod schema
 *   when the plan built the edit (`recordUpsertEdit`). planning#584.
 * - `rekeyDevice`: the `device-manager:devices` row of `deviceId` gets a new
 *   `(addonId, stableId)`; its key and `deviceId` never change, so every store keyed by
 *   the id alone keeps it. The old provider's `addon-device-settings` rows (scoped
 *   `<addonId>:<deviceId>.`) move under the new addon in the same transaction. A pair
 *   another device holds, or a setting the new addon already has, is refused.
 * - `tombstoneDevice`: what `removeDevice` records (D865), in this transaction — the row
 *   goes, the `tombstones` record is written (an existing one keeps its earlier
 *   `deletedAt`), the device's `addon-device-settings` and `device-runtime-state` rows
 *   are cleared. The data hooks run later off the tombstone; the keychain, the bindings
 *   and the in-process indexes are outside this file and are NOT touched.
 *
 * ## Who may write what
 *
 * A hub plan (`owner: 'hub'`) may name any record owner. An addon plan writes only its
 * own kinds, re-keys only a device it owns or adopts (its `addonId` before or after), and
 * tombstones only its own devices.
 *
 * ## Preconditions
 *
 * An edit with a `precondition` carries `preconditionOf(<what the plan read>)`. The
 * apply step reads the same thing again inside the transaction and refuses a
 * mismatch, so a plan computed from a value that changed since is never applied on top
 * of it. An edit of a row or key that EXISTS at apply time must carry one (an insert
 * of a new key or row need not): a plan that rewrites a value it never read is the
 * blind write the precondition exists to refuse. A table or column that does not exist
 * is an error, never created.
 */
import type Database from 'better-sqlite3'
import {
  type MigrationEdit,
  type MigrationPlan,
  deviceIdentityPrecondition,
  isSecretMarker,
  parseRecordBody,
  preconditionOf,
} from '@dominevo/types'
import { DEVICE_ROWS_COLLECTION } from '../../device-manager/device-row-store.js'
import { deviceManagerRecordKinds } from '../../device-manager/record-kinds.js'
import { HUB_OWNER, type MigrationRecordWriter } from './migration-types.js'

/** The addon that owns the device rows and the tombstones kind. */
const DEVICE_MANAGER_OWNER = 'device-manager'
const DEVICE_SETTINGS_TABLE = 'addon-device-settings'
const DEVICE_RUNTIME_STATE_TABLE = 'device-runtime-state'

/** What the apply step needs beyond the connection: who runs the plan, and this file's records engine. */
export interface MigrationEditScope {
  /** The migration's owner (`meta.owner`): `hub` or the addon id. */
  readonly owner: string
  /** `null` on a file with no records engine (`history.db`): a record or tombstone edit is refused. */
  readonly records: MigrationRecordWriter | null
  readonly now: () => number
}

const TABLE_NAME = /^[A-Za-z0-9_:.-]+$/
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export class MigrationEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationEditError'
  }
}

function table(name: string): string {
  if (!TABLE_NAME.test(name)) throw new MigrationEditError(`"${name}" is not a table name`)
  return `"${name}"`
}

function column(name: string): string {
  if (!COLUMN_NAME.test(name)) throw new MigrationEditError(`"${name}" is not a column name`)
  return `"${name}"`
}

type SqlValue = string | number | bigint | Buffer | null

function bindable(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Buffer.isBuffer(value)) return value
  return JSON.stringify(value)
}

function parsedData(data: unknown): unknown {
  if (typeof data !== 'string') return data ?? null
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function readKeys(
  db: Database.Database,
  scope: string,
  keys: readonly string[],
): Record<string, unknown> {
  const select = db.prepare<[string], { data: unknown }>(
    `SELECT data FROM ${table(scope)} WHERE id = ?`,
  )
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = parsedData(select.get(key)?.data)
  return out
}

function keysExist(db: Database.Database, scope: string, keys: readonly string[]): boolean {
  const select = db.prepare<[string], { id: string }>(`SELECT id FROM ${table(scope)} WHERE id = ?`)
  return keys.some((key) => select.get(key) !== undefined)
}

function whereOf(key: Readonly<Record<string, unknown>>): {
  readonly clause: string
  readonly params: SqlValue[]
} {
  const names = Object.keys(key)
  if (names.length === 0) throw new MigrationEditError('a row edit needs at least one key column')
  return {
    clause: names.map((name) => `${column(name)} = ?`).join(' AND '),
    params: names.map((name) => bindable(key[name])),
  }
}

function readRow(
  db: Database.Database,
  tableName: string,
  key: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const { clause, params } = whereOf(key)
  const row = db
    .prepare<SqlValue[], Record<string, unknown>>(
      `SELECT * FROM ${table(tableName)} WHERE ${clause}`,
    )
    .get(...params)
  return row ?? null
}

/** The columns a `putRow` precondition covers: all of the row, or only the named ones. */
function projectColumns(
  row: Record<string, unknown> | null,
  columns: readonly string[] | undefined,
): unknown {
  if (row === null || columns === undefined) return row
  return Object.fromEntries(columns.map((name) => [name, row[name] ?? null]))
}

function checkPrecondition(edit: MigrationEdit, read: unknown, existed: boolean): void {
  if (edit.precondition === undefined) {
    if (existed) {
      throw new MigrationEditError(
        `${edit.op} edits a value that already exists without a precondition: carry preconditionOf(<what the plan read>)`,
      )
    }
    return
  }
  if (preconditionOf(read) !== edit.precondition) {
    throw new MigrationEditError(
      `precondition failed for ${edit.op}: the value changed since the plan read it`,
    )
  }
}

function requireRecords(scope: MigrationEditScope, op: string): MigrationRecordWriter {
  if (scope.records === null) {
    throw new MigrationEditError(`${op}: this file has no records engine`)
  }
  return scope.records
}

function assertRecordOwner(scope: MigrationEditScope, owner: string, op: string): void {
  if (scope.owner !== HUB_OWNER && scope.owner !== owner) {
    throw new MigrationEditError(
      `${op}: a migration of "${scope.owner}" may write only its own record kinds, not "${owner}"'s`,
    )
  }
}

interface DeviceIdentityRow {
  readonly addonId: string
  readonly stableId: string
}

function isDeviceIdentityRow(row: unknown): row is DeviceIdentityRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'addonId' in row &&
    typeof row.addonId === 'string' &&
    'stableId' in row &&
    typeof row.stableId === 'string'
  )
}

/** The identity of device `deviceId`, after checking the plan read the same one. */
function readDevice(
  db: Database.Database,
  deviceId: number,
  edit: Extract<MigrationEdit, { readonly op: 'rekeyDevice' | 'tombstoneDevice' }>,
): DeviceIdentityRow {
  const row: unknown = db
    .prepare(`SELECT addonId, stableId FROM ${table(DEVICE_ROWS_COLLECTION)} WHERE id = ?`)
    .get(String(deviceId))
  if (!isDeviceIdentityRow(row)) {
    throw new MigrationEditError(`${edit.op}: device ${deviceId} does not exist`)
  }
  if (edit.precondition === undefined) {
    throw new MigrationEditError(
      `${edit.op} edits device ${deviceId} without a precondition: carry deviceIdentityPrecondition(<what the plan read>)`,
    )
  }
  if (deviceIdentityPrecondition(row) !== edit.precondition) {
    throw new MigrationEditError(
      `precondition failed for ${edit.op}: device ${deviceId} changed since the plan read it`,
    )
  }
  return row
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

function rekeyDevice(
  db: Database.Database,
  edit: Extract<MigrationEdit, { readonly op: 'rekeyDevice' }>,
  scope: MigrationEditScope,
): void {
  const current = readDevice(db, edit.deviceId, edit)
  if (
    scope.owner !== HUB_OWNER &&
    current.addonId !== scope.owner &&
    edit.addonId !== scope.owner
  ) {
    throw new MigrationEditError(
      `rekeyDevice: a migration of "${scope.owner}" may re-key only a device it owns or adopts (device ${edit.deviceId} is "${current.addonId}"'s)`,
    )
  }
  const holder: unknown = db
    .prepare(
      `SELECT id FROM ${table(DEVICE_ROWS_COLLECTION)} WHERE addonId = ? AND stableId = ? AND id != ?`,
    )
    .get(edit.addonId, edit.stableId, String(edit.deviceId))
  if (holder !== undefined) {
    throw new MigrationEditError(
      `rekeyDevice: ("${edit.addonId}", "${edit.stableId}") already belongs to another device`,
    )
  }
  if (current.addonId !== edit.addonId) {
    moveProviderSettings(db, edit.deviceId, current.addonId, edit.addonId)
  }
  db.prepare(
    `UPDATE ${table(DEVICE_ROWS_COLLECTION)} SET addonId = ?, stableId = ? WHERE id = ?`,
  ).run(edit.addonId, edit.stableId, String(edit.deviceId))
}

/**
 * The per-device settings store scopes a row by the PROVIDER's addon
 * (`<addonId>:<deviceId>.<key>`, data `{ addonId, deviceId, key, value }`), so a
 * re-key to another addon moves the old provider's rows under the new one; rows
 * other addons keep about the device (`recorder:<id>.…`) stay where they are. A
 * key the new owner already holds for this device is refused, never overwritten.
 *
 * A row holding a keychain marker is refused too: its ref names the old provider's
 * scope (`secret://<owner>/device/<id>/<field>`, the AAD of the stored value) and
 * the keychain is outside this file, so the move would hand the new owner a marker
 * naming a scope that is not its own. Such a device changes provider through a
 * procedure that re-puts the secret. A re-key within one addon never gets here.
 */
function moveProviderSettings(
  db: Database.Database,
  deviceId: number,
  fromAddon: string,
  toAddon: string,
): void {
  if (!tableExists(db, DEVICE_SETTINGS_TABLE)) return
  const fromScope = `${fromAddon}:${String(deviceId)}.`
  const toScope = `${toAddon}:${String(deviceId)}.`
  const rows = db
    .prepare<[number, string], { id: string; data: string }>(
      `SELECT id, data FROM ${table(DEVICE_SETTINGS_TABLE)} WHERE substr(id, 1, ?) = ?`,
    )
    .all(fromScope.length, fromScope)
  const exists = db.prepare<[string], { id: string }>(
    `SELECT id FROM ${table(DEVICE_SETTINGS_TABLE)} WHERE id = ?`,
  )
  const move = db.prepare<[string, string, string]>(
    `UPDATE ${table(DEVICE_SETTINGS_TABLE)} SET id = ?, data = json_set(data, '$.addonId', ?) WHERE id = ?`,
  )
  for (const { id, data } of rows) {
    const key = id.slice(fromScope.length)
    if (holdsSecretMarker(parseJson(data))) {
      throw new MigrationEditError(
        `rekeyDevice: setting "${key}" of device ${deviceId} holds a keychain secret of "${fromAddon}"; the keychain is outside the migration transaction, so move this device to "${toAddon}" through a procedure`,
      )
    }
    if (exists.get(`${toScope}${key}`) !== undefined) {
      throw new MigrationEditError(
        `rekeyDevice: "${toAddon}" already has setting "${key}" for device ${deviceId}`,
      )
    }
    move.run(`${toScope}${key}`, toAddon, id)
  }
}

/** A stored settings row, parsed; a row that is not JSON holds no marker. */
function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

/** True when `value` carries a keychain marker (`{ $secret }`) at any depth. */
function holdsSecretMarker(value: unknown): boolean {
  if (isSecretMarker(value)) return true
  if (Array.isArray(value)) return value.some(holdsSecretMarker)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(holdsSecretMarker)
  }
  return false
}

function tombstoneDevice(
  db: Database.Database,
  edit: Extract<MigrationEdit, { readonly op: 'tombstoneDevice' }>,
  scope: MigrationEditScope,
): void {
  const records = requireRecords(scope, edit.op)
  const current = readDevice(db, edit.deviceId, edit)
  if (scope.owner !== HUB_OWNER && current.addonId !== scope.owner) {
    throw new MigrationEditError(
      `tombstoneDevice: a migration of "${scope.owner}" may delete only its own devices (device ${edit.deviceId} is "${current.addonId}"'s)`,
    )
  }
  const id = String(edit.deviceId)
  db.prepare(`DELETE FROM ${table(DEVICE_ROWS_COLLECTION)} WHERE id = ?`).run(id)
  const kind = deviceManagerRecordKinds.tombstones
  // Re-recording keeps the EARLIER deletedAt, exactly as DeviceTombstoneStore.record.
  if (records.read(DEVICE_MANAGER_OWNER, kind.name, id) === null) {
    const deletedAt = scope.now()
    const body = parseRecordBody(kind, id, {
      deletedAt,
      providerAddonId: current.addonId,
    })
    records.upsert(DEVICE_MANAGER_OWNER, kind.name, {
      id,
      at: deletedAt,
      data: body,
    })
  }
  // D865's central settings clearance: every addon's scope of this device, matched on the
  // deviceId each row carries (the same predicate `clearDeviceSettings` compiles).
  if (tableExists(db, DEVICE_SETTINGS_TABLE)) {
    db.prepare(
      `DELETE FROM ${table(DEVICE_SETTINGS_TABLE)} WHERE json_extract(data, '$.deviceId') IN (?, ?)`,
    ).run(id, edit.deviceId)
  }
  if (tableExists(db, DEVICE_RUNTIME_STATE_TABLE)) {
    db.prepare(`DELETE FROM ${table(DEVICE_RUNTIME_STATE_TABLE)} WHERE id = ?`).run(id)
  }
}

function applyOne(db: Database.Database, edit: MigrationEdit, scope: MigrationEditScope): void {
  switch (edit.op) {
    case 'setKeys': {
      const keys = Object.keys(edit.values)
      checkPrecondition(edit, readKeys(db, edit.scope, keys), keysExist(db, edit.scope, keys))
      const upsert = db.prepare(
        `INSERT INTO ${table(edit.scope)} (id, data) VALUES (?, ?) ` +
          'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      for (const key of keys) upsert.run(key, JSON.stringify(edit.values[key]))
      return
    }
    case 'deleteKeys': {
      checkPrecondition(
        edit,
        readKeys(db, edit.scope, edit.keys),
        keysExist(db, edit.scope, edit.keys),
      )
      const remove = db.prepare(`DELETE FROM ${table(edit.scope)} WHERE id = ?`)
      for (const key of edit.keys) remove.run(key)
      return
    }
    case 'putRow': {
      const existing = readRow(db, edit.table, edit.key)
      checkPrecondition(edit, projectColumns(existing, edit.preconditionColumns), existing !== null)
      const { clause, params } = whereOf(edit.key)
      if (existing !== null) {
        const names = Object.keys(edit.row)
        if (names.length === 0) return
        db.prepare(
          `UPDATE ${table(edit.table)} SET ${names.map((n) => `${column(n)} = ?`).join(', ')} WHERE ${clause}`,
        ).run(...names.map((n) => bindable(edit.row[n])), ...params)
        return
      }
      const all = { ...edit.key, ...edit.row }
      const names = Object.keys(all)
      db.prepare(
        `INSERT INTO ${table(edit.table)} (${names.map(column).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      ).run(...names.map((n) => bindable(all[n])))
      return
    }
    case 'deleteRow': {
      const existing = readRow(db, edit.table, edit.key)
      checkPrecondition(edit, existing, existing !== null)
      const { clause, params } = whereOf(edit.key)
      db.prepare(`DELETE FROM ${table(edit.table)} WHERE ${clause}`).run(...params)
      return
    }
    case 'upsertRecord': {
      assertRecordOwner(scope, edit.owner, edit.op)
      const records = requireRecords(scope, edit.op)
      const stored = records.read(edit.owner, edit.kind, edit.recordKey)
      checkPrecondition(edit, stored, stored !== null)
      records.upsert(edit.owner, edit.kind, {
        id: edit.recordKey,
        ...(edit.deviceId === undefined ? {} : { deviceId: edit.deviceId }),
        ...(edit.at === undefined ? {} : { at: edit.at }),
        data: edit.value,
      })
      return
    }
    case 'deleteRecord': {
      assertRecordOwner(scope, edit.owner, edit.op)
      const records = requireRecords(scope, edit.op)
      const stored = records.read(edit.owner, edit.kind, edit.recordKey)
      checkPrecondition(edit, stored, stored !== null)
      records.remove(edit.owner, edit.kind, edit.recordKey)
      return
    }
    case 'rekeyDevice':
      rekeyDevice(db, edit, scope)
      return
    case 'tombstoneDevice':
      tombstoneDevice(db, edit, scope)
      return
  }
}

/** Apply every edit, in order. Throws on the first that cannot be applied; the caller's transaction undoes the rest. */
export function applyEdits(
  db: Database.Database,
  plan: MigrationPlan,
  scope: MigrationEditScope,
): void {
  for (const edit of plan.edits) applyOne(db, edit, scope)
}
