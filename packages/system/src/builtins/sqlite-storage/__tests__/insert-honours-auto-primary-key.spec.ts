/**
 * `insert` and `insertMany` answer the same question the same way (D473-prep).
 *
 * `declareCollection` records `autoPrimaryKey` when the primary key is
 * `INTEGER` — a SQLite ROWID ALIAS, which SQLite assigns itself when the column
 * is omitted from an INSERT. The backend's own docblock explains why it matters:
 *
 *   "On a TEXT key a caller that supplies none is asking for a generated one,
 *    so `insert` mints a `randomUUID()`. Doing that on an integer rowid alias
 *    would bind a 36-character string to the row key: SQLite's INTEGER affinity
 *    cannot convert it, so it is stored AS TEXT and the column stops being a
 *    rowid alias for that row."
 *
 * **`insertMany` honours the flag. `insert` did not.** It ran
 * `record.id || randomUUID()` unconditionally, so every single-row insert into
 * an `INTEGER`-keyed collection would silently store a UUID string in it — and
 * `pipeline-analytics` inserts its events one at a time.
 *
 * Nothing caught it because nothing used `autoPrimaryKey` yet: the flag was
 * added, wired into the batch path, and left half-connected. This is the
 * precondition for the event-key migration, not part of it — the migration is
 * worth 263 MB and cannot start on a path that quietly stores text in an
 * integer column.
 *
 * Two paths answering one question differently is also exactly the drift that
 * cost an evening in D464, which is why the symmetry itself is pinned below.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-pk-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

async function declareIntKeyed(b: SqliteSettingsBackend): Promise<void> {
  await b.declareCollection({
    namespace: 'test',
    collection: 'events',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
      { name: 'deviceId', type: 'INTEGER' },
    ],
  })
}

function idsOf(b: SqliteSettingsBackend): readonly unknown[] {
  const db = b.getDatabase()
  if (db === null) throw new Error('backend not open')
  return db
    .prepare('SELECT id FROM "test:events" ORDER BY id')
    .all()
    .map((r) => (r as { id: unknown }).id)
}

describe('insert on an INTEGER-keyed collection', () => {
  it('lets SQLite assign the rowid instead of binding a UUID string', async () => {
    const b = await openBackend()
    await declareIntKeyed(b)
    await b.insert({ namespace: 'test', collection: 'events', record: { data: { deviceId: 101 } } })
    const [id] = idsOf(b)
    expect(typeof id, 'a UUID string was bound to an INTEGER rowid alias').toBe('number')
    await b.shutdown()
  })

  it('assigns ASCENDING rowids across several inserts', async () => {
    const b = await openBackend()
    await declareIntKeyed(b)
    for (const deviceId of [101, 102, 108]) {
      await b.insert({ namespace: 'test', collection: 'events', record: { data: { deviceId } } })
    }
    const ids = idsOf(b)
    expect(ids).toHaveLength(3)
    expect(ids.every((i) => typeof i === 'number')).toBe(true)
    expect(Number(ids[2]) > Number(ids[0])).toBe(true)
    await b.shutdown()
  })

  it('agrees with insertMany — two paths, one question', async () => {
    const b = await openBackend()
    await declareIntKeyed(b)
    await b.insert({ namespace: 'test', collection: 'events', record: { data: { deviceId: 1 } } })
    await b.insertMany({
      namespace: 'test',
      collection: 'events',
      records: [{ data: { deviceId: 2 } }, { data: { deviceId: 3 } }],
    })
    expect(idsOf(b).every((i) => typeof i === 'number')).toBe(true)
    await b.shutdown()
  })

  it('still mints a UUID on a TEXT-keyed collection', async () => {
    // The flag changes ONE case. A text key with no id supplied is still a
    // caller asking for a generated one.
    const b = await openBackend()
    await b.declareCollection({
      namespace: 'test',
      collection: 'texty',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER' },
      ],
    })
    await b.insert({ namespace: 'test', collection: 'texty', record: { data: { deviceId: 1 } } })
    const db = b.getDatabase()
    const row = db?.prepare('SELECT id FROM "test:texty"').get() as { id: unknown } | undefined
    expect(typeof row?.id).toBe('string')
    expect(String(row?.id)).toHaveLength(36)
    await b.shutdown()
  })
})
