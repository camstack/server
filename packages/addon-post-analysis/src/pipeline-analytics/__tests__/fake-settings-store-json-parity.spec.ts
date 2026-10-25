/**
 * The shared fake settings store reads a row back the way the REAL SQLite
 * backend does (follow-up 102, item 1): the same writes through both, the same
 * rows out of `query`.
 *
 * The divergence this pins: the backend's `decodeColumnValue` hands back a
 * TEXT that starts with `[` or `{` already parsed, and the fake used to hand
 * back the string. A store that parsed the string itself passed here and threw
 * on every row in production (the promoted-tape index never listed a tape).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakeSettingsStore } from './test-helpers.js'

const COLLECTION = 'parity:json-columns'

const COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'list', type: 'TEXT' as const },
  { name: 'obj', type: 'TEXT' as const },
  { name: 'plain', type: 'TEXT' as const },
  { name: 'notJson', type: 'TEXT' as const },
  { name: 'flag', type: 'BOOLEAN' as const },
  { name: 'n', type: 'INTEGER' as const },
]

/** Same documented test boundary as the `*-over-real-sqlite` specs. */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    insert: { mutate: (i: never) => backend.insert(i) },
    update: { mutate: (i: never) => backend.update(i) },
    query: { query: (i: never) => backend.query(i) },
    get: { query: (i: never) => backend.get(i) },
  } as unknown as SettingsStoreClient
}

async function writeAndRead(store: SettingsStoreClient): Promise<unknown> {
  await store.declareCollection.mutate({ collection: COLLECTION, columns: COLUMNS })
  await store.insert.mutate({
    collection: COLLECTION,
    record: {
      id: 'stringified',
      data: {
        list: JSON.stringify(['a', 'b']),
        obj: JSON.stringify({ k: 1 }),
        plain: 'hello',
        notJson: '[not json',
        flag: true,
        n: 3,
      },
    },
  })
  await store.insert.mutate({
    collection: COLLECTION,
    record: { id: 'objects', data: { list: ['c'], obj: { k: 2 }, flag: false, n: 4 } },
  })
  await store.update.mutate({
    collection: COLLECTION,
    id: 'objects',
    data: { plain: JSON.stringify([1, 2]) },
  })
  const rows = await store.query.query({
    collection: COLLECTION,
    filter: { orderBy: { field: 'n', direction: 'asc' } },
  })
  // `get` decodes exactly like `query` (fix round 1, review M1).
  const got: unknown[] = []
  for (const key of ['stringified', 'objects']) {
    const value: unknown = await store.get.query({ collection: COLLECTION, key })
    got.push(value !== null && typeof value === 'object' ? { id: key, ...value } : value)
  }
  return [...rows.map((r) => ({ id: r.id, ...r.data })), ...got].map(project)
}

/**
 * The declared columns of one read row. `?? null` is an ACCEPTED divergence
 * (review L2): the backend returns every declared column, `null` when it holds
 * nothing; the fake leaves the key absent. See the fake's header.
 */
function project(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row
  const r = new Map(Object.entries(row))
  return {
    id: r.get('id'),
    list: r.get('list'),
    obj: r.get('obj'),
    plain: r.get('plain') ?? null,
    notJson: r.get('notJson') ?? null,
    flag: r.get('flag'),
    n: r.get('n'),
  }
}

describe('the shared fake settings store decodes JSON text like the real backend', () => {
  let dir: string
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-fake-parity-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
  })

  afterEach(async () => {
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the same writes read back identically from the fake and from SQLite', async () => {
    const real = await writeAndRead(clientOver(backend))
    const fake = await writeAndRead(makeFakeSettingsStore().client)
    const stringified = {
      id: 'stringified',
      list: ['a', 'b'],
      obj: { k: 1 },
      plain: 'hello',
      notJson: '[not json',
      flag: true,
      n: 3,
    }
    const objects = {
      id: 'objects',
      list: ['c'],
      obj: { k: 2 },
      plain: [1, 2],
      notJson: null,
      flag: false,
      n: 4,
    }
    // query (ordered by n), then get of each key.
    expect(real).toEqual([stringified, objects, stringified, objects])
    expect(fake).toEqual(real)
  })
})
