/**
 * The ledger migration that keeps command rows only (D1084), on real SQLite with the real `records`
 * layout and the kind's real declaration. A MARKED field proves a row was re-outcomed, not rewritten;
 * the `device` rows are gone; another kind's rows (even with a `device` outcome) are untouched; a
 * count that does not add up rolls the step back; a second run changes nothing.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION,
  DEVICE_TRANSITIONS_KIND,
  DEVICE_TRANSITIONS_OWNER,
  MIGRATION_BATCH_ROWS,
} from '../../../migrations/hub/2026-11-22-device-transitions-commands-only.js'
import { deviceTransitionsRecordKinds } from '../../device-history/transitions/device-transitions-record-kinds.js'
import { declareKind, ensureRecordsSchema } from '../records/records-catalog.js'

const opened: Database.Database[] = []
afterEach(() => {
  for (const db of opened) db.close()
  opened.length = 0
})

const declaration = deviceTransitionsRecordKinds['device-transitions'].declaration

interface Row {
  readonly id: string
  readonly outcome: string
  readonly mark: string
}

function seed(rows: readonly Row[], other: readonly Row[] = []) {
  const db = new Database(':memory:')
  opened.push(db)
  ensureRecordsSchema(db)
  const kindId = declareKind(
    db,
    DEVICE_TRANSITIONS_OWNER,
    DEVICE_TRANSITIONS_KIND,
    declaration,
    undefined,
  ).row.kindId
  const otherId = declareKind(db, 'someone-else', 'audit', declaration, undefined).row.kindId
  const insert = db.prepare(
    'INSERT INTO records(kind_id, id, rev, updated_at, data) VALUES (?, ?, 1, 100, jsonb(?))',
  )
  const body = (r: Row): string =>
    JSON.stringify({
      id: r.id,
      deviceId: 7,
      at: 1,
      capName: 'switch',
      field: 'on',
      from: false,
      to: true,
      outcome: r.outcome,
      actor: { kind: r.outcome === 'device' ? 'device' : 'user' },
      mark: r.mark,
    })
  for (const r of rows) insert.run(kindId, r.id, body(r))
  for (const r of other) insert.run(otherId, r.id, body(r))
  return { db, kindId, otherId }
}

function stored(
  db: Database.Database,
  kindId: number,
): Record<string, { outcome: string; mark: string }> {
  const out: Record<string, { outcome: string; mark: string }> = {}
  const rows = db
    .prepare('SELECT id, json(data) AS data FROM records WHERE kind_id = ?')
    .all(kindId) as { id: string; data: string }[]
  for (const r of rows) {
    const d = JSON.parse(r.data) as { outcome: string; mark: string }
    out[r.id] = { outcome: d.outcome, mark: d.mark }
  }
  return out
}

const OLD: readonly Row[] = [
  { id: 'a', outcome: 'confirmed', mark: 'mark-a' },
  { id: 'b', outcome: 'already', mark: 'mark-b' },
  { id: 'c', outcome: 'unconfirmed', mark: 'mark-c' },
  { id: 'd', outcome: 'failed', mark: 'mark-d' },
  { id: 'e', outcome: 'device', mark: 'mark-e' },
  { id: 'f', outcome: 'device', mark: 'mark-f' },
]

describe('device-transitions commands-only migration (D1084)', () => {
  it('maps confirmed/already/unconfirmed to ok, keeps failed, deletes device rows, keeps every mark', () => {
    const { db, kindId } = seed(OLD)
    const note = DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    expect(stored(db, kindId)).toEqual({
      a: { outcome: 'ok', mark: 'mark-a' },
      b: { outcome: 'ok', mark: 'mark-b' },
      c: { outcome: 'ok', mark: 'mark-c' },
      d: { outcome: 'failed', mark: 'mark-d' },
    })
    expect(note).toMatchObject({ before: 6, after: 4, deviceRowsDeleted: 2, mappedToOk: 3 })
  })

  it('bumps rev and updated_at of a re-outcomed row and leaves the others as they were', () => {
    const { db, kindId } = seed(OLD)
    DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    const meta = (id: string) =>
      db
        .prepare('SELECT rev, updated_at AS at FROM records WHERE kind_id = ? AND id = ?')
        .get(kindId, id) as {
        rev: number
        at: number
      }
    expect(meta('a').rev).toBe(2)
    expect(meta('a').at).toBeGreaterThan(100)
    expect(meta('d')).toEqual({ rev: 1, at: 100 })
  })

  it('handles more rows than one batch, device rows and retired outcomes alike', () => {
    const many: Row[] = []
    for (let i = 0; i < MIGRATION_BATCH_ROWS * 2 + 7; i += 1) {
      many.push({ id: `r${i}`, outcome: i % 2 === 0 ? 'device' : 'confirmed', mark: `m${i}` })
    }
    const { db, kindId } = seed(many)
    const note = DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    const left = stored(db, kindId)
    expect(Object.values(left).every((r) => r.outcome === 'ok')).toBe(true)
    expect(left['r1']).toEqual({ outcome: 'ok', mark: 'm1' })
    expect(left['r0']).toBeUndefined()
    expect(note).toMatchObject({ before: many.length, after: Object.keys(left).length })
  })

  it('leaves another kind alone, even a row of it with a device outcome', () => {
    const { db, otherId } = seed(OLD, [{ id: 'x', outcome: 'device', mark: 'mark-x' }])
    DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    expect(stored(db, otherId)).toEqual({ x: { outcome: 'device', mark: 'mark-x' } })
  })

  it('a second run changes nothing', () => {
    const { db, kindId } = seed(OLD)
    DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    const first = stored(db, kindId)
    const note = DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)
    expect(stored(db, kindId)).toEqual(first)
    expect(note).toMatchObject({ before: 4, after: 4, deviceRowsDeleted: 0, mappedToOk: 0 })
  })

  it('a node that never recorded a transition has nothing to do', () => {
    const db = new Database(':memory:')
    opened.push(db)
    expect(DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)).toEqual({ kind: 'absent' })
    ensureRecordsSchema(db)
    expect(DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db)).toEqual({ kind: 'absent' })
  })

  it('a row the migration cannot account for fails the step and the engine transaction rolls it back', () => {
    const { db, kindId } = seed([...OLD, { id: 'g', outcome: 'mystery', mark: 'mark-g' }])
    const run = db.transaction(() => DEVICE_TRANSITIONS_COMMANDS_ONLY_MIGRATION.run(db))
    expect(() => run()).toThrow(/without an ok\/failed outcome - rolled back/)
    expect(Object.keys(stored(db, kindId)).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(stored(db, kindId)['a']?.outcome).toBe('confirmed')
  })
})
