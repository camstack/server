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
 * - `upsertRecord` / `deleteRecord`: REFUSED. A record's indexed columns
 *   (`device_id`, `at`, `expires_at`, `rev`) derive from its kind's declaration, which
 *   only the records engine interprets; an edit that wrote the blob alone would leave
 *   them stale. A migration over records is a `procedure` through the records cap.
 *
 * ## Preconditions
 *
 * An edit with a `precondition` carries `preconditionOf(<what the plan read>)`. The
 * apply step reads the same thing again inside the transaction and refuses a
 * mismatch, so a plan computed from a value that changed since is never applied on top
 * of it. A table or column that does not exist is an error, never created.
 */
import type Database from 'better-sqlite3'
import { type MigrationEdit, type MigrationPlan, preconditionOf } from '@camstack/types'

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

function checkPrecondition(edit: MigrationEdit, read: unknown): void {
  if (edit.precondition === undefined) return
  if (preconditionOf(read) !== edit.precondition) {
    throw new MigrationEditError(
      `precondition failed for ${edit.op}: the value changed since the plan read it`,
    )
  }
}

function applyOne(db: Database.Database, edit: MigrationEdit): void {
  switch (edit.op) {
    case 'setKeys': {
      const keys = Object.keys(edit.values)
      checkPrecondition(edit, readKeys(db, edit.scope, keys))
      const upsert = db.prepare(
        `INSERT INTO ${table(edit.scope)} (id, data) VALUES (?, ?) ` +
          'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      for (const key of keys) upsert.run(key, JSON.stringify(edit.values[key]))
      return
    }
    case 'deleteKeys': {
      checkPrecondition(edit, readKeys(db, edit.scope, edit.keys))
      const remove = db.prepare(`DELETE FROM ${table(edit.scope)} WHERE id = ?`)
      for (const key of edit.keys) remove.run(key)
      return
    }
    case 'putRow': {
      const existing = readRow(db, edit.table, edit.key)
      checkPrecondition(edit, existing)
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
      checkPrecondition(edit, readRow(db, edit.table, edit.key))
      const { clause, params } = whereOf(edit.key)
      db.prepare(`DELETE FROM ${table(edit.table)} WHERE ${clause}`).run(...params)
      return
    }
    case 'upsertRecord':
    case 'deleteRecord':
      throw new MigrationEditError(
        `edit op "${edit.op}" is not applied by the engine: records are written by the records engine (a migration over records is a procedure through the records capability)`,
      )
  }
}

/** Apply every edit, in order. Throws on the first that cannot be applied; the caller's transaction undoes the rest. */
export function applyEdits(db: Database.Database, plan: MigrationPlan): void {
  for (const edit of plan.edits) applyOne(db, edit)
}
