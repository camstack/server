/**
 * Retired storage leftovers (planning#328) on real SQLite, sqlite-vec loaded the way the events
 * store loads it. Empty tables drop; a non-empty table stays and is named; a second run changes
 * nothing; the siglip2 index, with a row, survives.
 */
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DROP_RETIRED_SETTINGS_SHELLS_MIGRATION,
  DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION,
  RETIRED_SETTINGS_SHELLS,
  RETIRED_VEC_SHADOWS,
  RETIRED_VEC_TABLE,
  type RetiredTableOutcome,
} from '../../../migrations/hub/2026-11-12-drop-retired-storage-leftovers.js'

const SIGLIP = 'vec_object_clip_siglip2_b16_224'
const SIGLIP_INDEX_ID = 'object-clip-siglip2-b16-224'

const opened: Database.Database[] = []

afterEach(() => {
  for (const db of opened) db.close()
  opened.length = 0
})

function open(): Database.Database {
  const db = new Database(':memory:')
  const req = createRequire(import.meta.url)
  const sv = req('sqlite-vec') as { getLoadablePath: () => string }
  db.loadExtension(sv.getLoadablePath())
  opened.push(db)
  return db
}

function vecTable(db: Database.Database, name: string): void {
  db.exec(
    `CREATE VIRTUAL TABLE "${name}" USING vec0(id TEXT PRIMARY KEY, embedding float[4] distance_metric=cosine)`,
  )
}

function markVec(db: Database.Database, name: string, id: string): void {
  const blob = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer)
  db.prepare(`INSERT INTO "${name}" (id, embedding) VALUES (?, ?)`).run(id, blob)
}

function names(db: Database.Database): readonly string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .flatMap((row) => {
      if (typeof row !== 'object' || row === null) return []
      const name: unknown = Reflect.get(row, 'name')
      return typeof name === 'string' ? [name] : []
    })
}

function outcomeOf(note: Record<string, unknown>, table: string): RetiredTableOutcome {
  const value = note[table]
  if (value === 'absent' || value === 'dropped' || value === 'kept-nonempty') return value
  throw new Error(`no outcome for ${table}`)
}

describe('drop retired storage leftovers', () => {
  it('drops empty settings shells and leaves a non-empty one, named', () => {
    const db = open()
    for (const name of RETIRED_SETTINGS_SHELLS) {
      db.exec(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    }
    db.exec(
      'CREATE TABLE _collection_declarations (name TEXT PRIMARY KEY NOT NULL, decl TEXT NOT NULL)',
    )
    const insertDecl = db.prepare('INSERT INTO _collection_declarations (name, decl) VALUES (?, ?)')
    for (const name of RETIRED_SETTINGS_SHELLS) insertDecl.run(name, '{}')
    db.prepare(`INSERT INTO "${RETIRED_SETTINGS_SHELLS[0]}" (id, data) VALUES (?, ?)`).run(
      'cell-1',
      '{}',
    )

    const note = DROP_RETIRED_SETTINGS_SHELLS_MIGRATION.run(db) ?? {}
    expect(outcomeOf(note, RETIRED_SETTINGS_SHELLS[0])).toBe('kept-nonempty')
    expect(outcomeOf(note, RETIRED_SETTINGS_SHELLS[1])).toBe('dropped')
    expect(outcomeOf(note, RETIRED_SETTINGS_SHELLS[2])).toBe('dropped')
    expect(names(db)).toContain(RETIRED_SETTINGS_SHELLS[0])
    expect(names(db)).not.toContain(RETIRED_SETTINGS_SHELLS[1])
    expect(names(db)).not.toContain(RETIRED_SETTINGS_SHELLS[2])
    const decls = db.prepare('SELECT name FROM _collection_declarations ORDER BY name').all()
    expect(decls).toEqual([{ name: RETIRED_SETTINGS_SHELLS[0] }])

    const again = DROP_RETIRED_SETTINGS_SHELLS_MIGRATION.run(db) ?? {}
    expect(outcomeOf(again, RETIRED_SETTINGS_SHELLS[1])).toBe('absent')
    expect(outcomeOf(again, RETIRED_SETTINGS_SHELLS[0])).toBe('kept-nonempty')
    expect(names(db)).toContain(RETIRED_SETTINGS_SHELLS[0])
  })

  it('drops an empty vec0 index, its shadows and its registry row, and keeps siglip2', () => {
    const db = open()
    vecTable(db, RETIRED_VEC_TABLE)
    vecTable(db, SIGLIP)
    markVec(db, SIGLIP, 'kept')
    db.exec(
      `CREATE TABLE vec_indexes (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, metric TEXT NOT NULL)`,
    )
    const insert = db.prepare('INSERT INTO vec_indexes (id, dim, metric) VALUES (?, ?, ?)')
    insert.run('object-clip', 4, 'cosine')
    insert.run(SIGLIP_INDEX_ID, 4, 'cosine')
    const before = names(db)
    const presentShadows = RETIRED_VEC_SHADOWS.filter((shadow) => before.includes(shadow))
    expect(presentShadows.length).toBeGreaterThan(0)

    const note = DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION.run(db) ?? {}
    expect(outcomeOf(note, RETIRED_VEC_TABLE)).toBe('dropped')
    expect(outcomeOf(note, 'vec_indexes:vec_object_clip')).toBe('dropped')
    for (const shadow of RETIRED_VEC_SHADOWS) {
      const outcome = presentShadows.includes(shadow) ? 'dropped' : 'absent'
      expect(outcomeOf(note, shadow)).toBe(outcome)
      expect(names(db)).not.toContain(shadow)
    }
    expect(names(db)).not.toContain(RETIRED_VEC_TABLE)
    expect(names(db)).toContain(SIGLIP)
    const siglip = db.prepare(`SELECT id FROM "${SIGLIP}"`).all()
    expect(siglip).toEqual([{ id: 'kept' }])
    const registry = db.prepare('SELECT id FROM vec_indexes ORDER BY id').all()
    expect(registry).toEqual([{ id: SIGLIP_INDEX_ID }])

    const again = DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION.run(db) ?? {}
    expect(outcomeOf(again, RETIRED_VEC_TABLE)).toBe('absent')
    expect(outcomeOf(again, 'vec_indexes:vec_object_clip')).toBe('absent')
    expect(db.prepare(`SELECT id FROM "${SIGLIP}"`).all()).toEqual([{ id: 'kept' }])
  })

  it('keeps a non-empty vec_object_clip and names it, shadows included', () => {
    const db = open()
    vecTable(db, RETIRED_VEC_TABLE)
    markVec(db, RETIRED_VEC_TABLE, 'still-here')
    db.exec(
      `CREATE TABLE vec_indexes (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, metric TEXT NOT NULL)`,
    )
    db.prepare('INSERT INTO vec_indexes (id, dim, metric) VALUES (?, ?, ?)').run(
      'object_clip',
      4,
      'cosine',
    )

    const note = DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION.run(db) ?? {}
    expect(outcomeOf(note, RETIRED_VEC_TABLE)).toBe('kept-nonempty')
    expect(outcomeOf(note, 'vec_indexes:vec_object_clip')).toBe('kept-nonempty')
    expect(db.prepare(`SELECT id FROM "${RETIRED_VEC_TABLE}"`).all()).toEqual([
      { id: 'still-here' },
    ])
    expect(db.prepare('SELECT id FROM vec_indexes').all()).toEqual([{ id: 'object_clip' }])
    const kept = names(db)
    const presentShadows = RETIRED_VEC_SHADOWS.filter((shadow) => kept.includes(shadow))
    expect(presentShadows.length).toBeGreaterThan(0)
    for (const shadow of presentShadows) {
      expect(outcomeOf(note, shadow)).toBe('kept-nonempty')
    }
  })

  it('drops leftover shadows when the virtual table is already gone', () => {
    const db = open()
    db.exec(`CREATE TABLE "${RETIRED_VEC_SHADOWS[0]}" (id INTEGER PRIMARY KEY)`)
    db.exec(`CREATE TABLE "${RETIRED_VEC_SHADOWS[1]}" (id INTEGER PRIMARY KEY)`)
    db.prepare(`INSERT INTO "${RETIRED_VEC_SHADOWS[1]}" (id) VALUES (?)`).run(1)

    const note = DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION.run(db) ?? {}
    expect(outcomeOf(note, RETIRED_VEC_TABLE)).toBe('absent')
    expect(outcomeOf(note, RETIRED_VEC_SHADOWS[0])).toBe('dropped')
    expect(outcomeOf(note, RETIRED_VEC_SHADOWS[1])).toBe('kept-nonempty')
    expect(names(db)).not.toContain(RETIRED_VEC_SHADOWS[0])
    expect(names(db)).toContain(RETIRED_VEC_SHADOWS[1])
  })
})
