/**
 * `upsert` addresses a SLOT that is not the primary key, and answers with the
 * id the row HAS (D482).
 *
 * `set` is already an upsert, but its slot IS the primary key — so a collection
 * keyed by an `INTEGER` rowid alias cannot use it: SQLite owns the id, and the
 * writer has none to name. `pipeline-analytics:media` is exactly that shape
 * after D482: its uniqueness rule is "one row per
 * `(ownerKind, ownerId, kind, slotTs)`", and the row's address is whatever
 * rowid SQLite assigned.
 *
 * Every `it` below is one property the media store's idempotence rests on. The
 * two that matter most are the pair: a re-write of the SAME slot must land on
 * the SAME row (never a second one), and a write to a DIFFERENT slot must land
 * on a new one (never overwrite a neighbour). Get either backwards and
 * re-captures either duplicate rows or start destroying them.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upsert-slot-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

/** The media table's shape, reduced to what the slot rule needs. */
async function declareSlotted(b: SqliteSettingsBackend): Promise<void> {
  await b.declareCollection({
    namespace: 'test',
    collection: 'media',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
      { name: 'ownerKind', type: 'TEXT', notNull: true },
      { name: 'ownerId', type: 'TEXT', notNull: true },
      { name: 'kind', type: 'TEXT', notNull: true },
      { name: 'slotTs', type: 'INTEGER', notNull: true },
      { name: 'path', type: 'TEXT' },
      { name: 'sizeBytes', type: 'INTEGER' },
    ],
    indexes: [
      {
        name: 'idx_test_media_slot',
        columns: ['ownerKind', 'ownerId', 'kind', 'slotTs'],
        unique: true,
      },
    ],
  })
}

const SLOT = ['ownerKind', 'ownerId', 'kind', 'slotTs'] as const

describe('upsert against a non-primary-key slot', () => {
  it('inserts and hands back the ROWID SQLite assigned', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    const { id } = await b.upsert({
      namespace: 'test',
      collection: 'media',
      conflict: [...SLOT],
      record: {
        data: { ownerKind: 'track', ownerId: 't1', kind: 'thumbnail', slotTs: 0, sizeBytes: 10 },
      },
    })
    expect(typeof id).toBe('number')
    expect(id).toBe(1)
  })

  it('a SECOND write to the SAME slot updates the SAME row — one row, one id', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    const write = (sizeBytes: number): Promise<{ readonly id: string | number }> =>
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: [...SLOT],
        record: {
          data: {
            ownerKind: 'track',
            ownerId: 't1',
            kind: 'thumbnail',
            slotTs: 0,
            path: `p-${sizeBytes}`,
            sizeBytes,
          },
        },
      })
    const first = await write(10)
    const second = await write(20)
    const third = await write(30)

    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
    const rows = await b.query({ namespace: 'test', collection: 'media' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(String(first.id))
    // The row carries the LATEST write, not the first.
    expect(rows[0]?.data['sizeBytes']).toBe(30)
    expect(rows[0]?.data['path']).toBe('p-30')
  })

  it('a write to a DIFFERENT slot is a NEW row — a neighbour is never overwritten', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    const write = (kind: string, slotTs: number): Promise<{ readonly id: string | number }> =>
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: [...SLOT],
        record: {
          data: { ownerKind: 'track', ownerId: 't1', kind, slotTs, sizeBytes: 1 },
        },
      })
    const thumbnail = await write('thumbnail', 0)
    const otherKind = await write('keyFrame', 0)
    const otherTs = await write('snapshot', 1_700_000_000_000)
    const otherTs2 = await write('snapshot', 1_700_000_001_000)

    const ids = new Set([thumbnail.id, otherKind.id, otherTs.id, otherTs2.id])
    expect(ids.size).toBe(4)
    const rows = await b.query({ namespace: 'test', collection: 'media' })
    expect(rows).toHaveLength(4)
  })

  it('the same slot under a DIFFERENT owner is a different slot', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    const write = (ownerKind: string, ownerId: string): Promise<{ readonly id: string | number }> =>
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: [...SLOT],
        record: { data: { ownerKind, ownerId, kind: 'thumbnail', slotTs: 0, sizeBytes: 1 } },
      })
    // The collision D482 exists to remove: motion #5 and object #5 are two
    // rows, and under the composite-key scheme they were one string.
    const motion = await write('motion', '5')
    const object = await write('object', '5')
    const otherTrack = await write('motion', '6')
    expect(new Set([motion.id, object.id, otherTrack.id]).size).toBe(3)
  })

  it('refuses an EMPTY conflict target rather than emitting ON CONFLICT()', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    await expect(
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: [],
        record: { data: { ownerKind: 'track', ownerId: 't1', kind: 'thumbnail', slotTs: 0 } },
      }),
    ).rejects.toThrow(/EMPTY conflict target/)
  })

  it('refuses a conflict column the collection does not declare', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    await expect(
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: ['ownerKind', 'ghost'],
        record: { data: { ownerKind: 'track', ownerId: 't1', kind: 'thumbnail', slotTs: 0 } },
      }),
    ).rejects.toThrow(/does not declare: ghost/)
  })

  it('refuses a conflict target no UNIQUE index covers — loudly, on the first write', async () => {
    const b = await openBackend()
    await declareSlotted(b)
    // `path` is declared but not unique. SQLite cannot resolve the ON CONFLICT
    // target, so the statement throws instead of inserting a duplicate — which
    // is the property that makes a wrong `conflict` list a bug you find, not a
    // silently doubled table.
    await expect(
      b.upsert({
        namespace: 'test',
        collection: 'media',
        conflict: ['path'],
        record: {
          data: { ownerKind: 'track', ownerId: 't1', kind: 'thumbnail', slotTs: 0, path: 'p' },
        },
      }),
    ).rejects.toThrow()
  })

  it('honours a TEXT primary key too: the supplied id is kept, the slot still arbitrates', async () => {
    const b = await openBackend()
    await b.declareCollection({
      namespace: 'test',
      collection: 'texty',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'slot', type: 'TEXT', notNull: true },
        { name: 'value', type: 'INTEGER' },
      ],
      indexes: [{ name: 'idx_texty_slot', columns: ['slot'], unique: true }],
    })
    const first = await b.upsert({
      namespace: 'test',
      collection: 'texty',
      conflict: ['slot'],
      record: { id: 'chosen', data: { slot: 's', value: 1 } },
    })
    expect(first.id).toBe('chosen')
    const second = await b.upsert({
      namespace: 'test',
      collection: 'texty',
      conflict: ['slot'],
      // A DIFFERENT supplied id for the same slot: the row that already owns
      // the slot keeps its own id, and that is what comes back. Rewriting the
      // primary key of a row we matched by another column is the one update
      // that cannot be right.
      record: { id: 'ignored', data: { slot: 's', value: 2 } },
    })
    expect(second.id).toBe('chosen')
    const rows = await b.query({ namespace: 'test', collection: 'texty' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data['value']).toBe(2)
  })
})
