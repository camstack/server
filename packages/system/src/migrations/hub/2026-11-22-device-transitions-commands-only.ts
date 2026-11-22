/**
 * The device transition ledger keeps COMMANDS only (D1084). Before, its rows were of two
 * kinds: a command with the outcome the 30 s confirmation machinery gave it (`confirmed`,
 * `already`, `unconfirmed`, `failed`), and one `device` row per change nobody asked for. The
 * device changes are now read back from device-history, so the stored ones are deleted; the
 * command outcomes collapse to `ok | failed`: the three confirmation outcomes mean "the call
 * returned", so they become `ok`, and `failed` stays.
 *
 * One `sql` step over `events.db`, where the `device-transitions` kind lives (history.db never
 * hosts records, D850). It runs in the engine's own transaction, so a count that does not add
 * up throws and rolls the whole step back: rows before = rows after + `device` rows deleted,
 * every remaining row carries `ok` or `failed`, and the row set of the kind is otherwise
 * untouched (the id, time, actor, command and any other field of a row are not rewritten).
 * Idempotent: a second run finds no retired outcome and no `device` row. A node that never
 * recorded a transition has no catalog row for the kind and nothing to do.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
  MigrationNote,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION_ID =
  'hub/2026-11-22-device-transitions-commands-only'

/** The record kind the device-history addon declares, and its owner. */
export const DEVICE_TRANSITIONS_OWNER = 'device-history'
export const DEVICE_TRANSITIONS_KIND = 'device-transitions'

/** The outcomes the retired confirmation machinery wrote for a command that did not throw. */
export const RETIRED_COMMAND_OUTCOMES: readonly string[] = ['confirmed', 'already', 'unconfirmed']

const META: MigrationMeta = {
  id: DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 10,
  dependsOn: [],
  store: 'events',
  scope: 'cluster',
  // A count that does not add up must not keep the hub from booting; the ledger names it.
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Keep only command rows in the device-transitions ledger: confirmed/already/unconfirmed become ok, device rows are deleted',
  fixtureMark: 'mark',
}

function scalar(db: MigrationDatabase, sql: string, ...params: unknown[]): number {
  const row: unknown = db.prepare(sql).get(...params)
  const n: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'n') : undefined
  return typeof n === 'number' ? n : 0
}

function kindIdOf(db: MigrationDatabase): number | null {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all('_record_kinds')
  if (tables.length === 0) return null
  const row: unknown = db
    .prepare('SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?')
    .get(DEVICE_TRANSITIONS_OWNER, DEVICE_TRANSITIONS_KIND)
  const id: unknown =
    typeof row === 'object' && row !== null ? Reflect.get(row, 'kind_id') : undefined
  return typeof id === 'number' ? id : null
}

const OUTCOME = "json_extract(data, '$.outcome')"

function commandsOnly(db: MigrationDatabase): MigrationNote {
  const kindId = kindIdOf(db)
  if (kindId === null) return { kind: 'absent' }
  const before = scalar(db, 'SELECT COUNT(*) AS n FROM records WHERE kind_id = ?', kindId)
  const deviceRows = scalar(
    db,
    `SELECT COUNT(*) AS n FROM records WHERE kind_id = ? AND ${OUTCOME} = 'device'`,
    kindId,
  )
  const marks = RETIRED_COMMAND_OUTCOMES.map(() => '?').join(', ')
  const retired = scalar(
    db,
    `SELECT COUNT(*) AS n FROM records WHERE kind_id = ? AND ${OUTCOME} IN (${marks})`,
    kindId,
    ...RETIRED_COMMAND_OUTCOMES,
  )
  db.prepare(`DELETE FROM records WHERE kind_id = ? AND ${OUTCOME} = 'device'`).run(kindId)
  // A merge patch rewrites the outcome alone; every other field of the row stays as stored.
  db.prepare(
    `UPDATE records SET data = jsonb_patch(data, '{"outcome":"ok"}') WHERE kind_id = ? AND ${OUTCOME} IN (${marks})`,
  ).run(kindId, ...RETIRED_COMMAND_OUTCOMES)
  const after = scalar(db, 'SELECT COUNT(*) AS n FROM records WHERE kind_id = ?', kindId)
  const stray = scalar(
    db,
    `SELECT COUNT(*) AS n FROM records WHERE kind_id = ? AND (${OUTCOME} IS NULL OR ${OUTCOME} NOT IN ('ok', 'failed'))`,
    kindId,
  )
  if (after !== before - deviceRows || stray !== 0) {
    throw new Error(
      `device-transitions: ${before} row(s) before, ${after} after, ${deviceRows} device row(s) deleted, ${stray} row(s) without an ok/failed outcome - rolled back`,
    )
  }
  return { kind: 'migrated', before, after, deviceRowsDeleted: deviceRows, mappedToOk: retired }
}

export const DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION: HubSqlMigration = {
  meta: META,
  run: commandsOnly,
}
