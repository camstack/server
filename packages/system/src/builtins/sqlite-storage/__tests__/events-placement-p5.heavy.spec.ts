/**
 * LTS P5 — listed ledgers land in `events.db`; vectors round-trip on the events worker;
 * retrain-shaped `transact` stays atomic within one file.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { vectorProviderOfOwnedFile } from '../vector-provider.js'
import type { PlacementRouter } from '../placement-router.js'
import { ledgerDeclaration, makeHarness, type Harness } from './support/owned-files-harness.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

function tablesOf(file: string): readonly string[] {
  const db = new Database(file, { readonly: true })
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (typeof r === 'object' && r !== null && 'name' in r ? String(r.name) : ''))
  } finally {
    db.close()
  }
}

async function stopAndInspect(router: PlacementRouter): Promise<void> {
  await harness!.stopAll(router)
  const inEvents = tablesOf(harness!.pathOf('events'))
  const inSettings = tablesOf(harness!.pathOf('settings'))
  expect(inEvents).toContain('p5:tracks')
  expect(inEvents).toContain('p5:media')
  expect(inEvents).toContain('vec_indexes')
  expect(inSettings).not.toContain('p5:tracks')
  expect(inSettings).not.toContain('p5:media')
  expect(inSettings).not.toContain('vec_indexes')
}

describe('events.db placement (P5)', () => {
  it('representative ledgers and vec_indexes live only in events.db', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('p5:tracks', 'events'))
    await router.declareCollection(ledgerDeclaration('p5:media', 'events'))
    await router.declareCollection(ledgerDeclaration('p5:settings-only'))
    await router.insert({ collection: 'p5:tracks', record: { id: 't1', data: { atMs: 1 } } })

    const vector = vectorProviderOfOwnedFile(() => router.recordsFileFor('events'))
    await vector.declareIndex({ index: 'p5-clip', dim: 4, metric: 'cosine' })
    await vector.upsert({
      index: 'p5-clip',
      items: [
        {
          id: 'v1',
          vector: Buffer.from(new Float32Array([1, 0, 0, 0]).buffer).toString('base64'),
          metadata: { deviceId: 1, timestamp: 1, className: 'person', trackId: 't1' },
        },
      ],
    })
    const found = await vector.query({
      index: 'p5-clip',
      vector: Buffer.from(new Float32Array([1, 0, 0, 0]).buffer).toString('base64'),
      topK: 1,
    })
    expect(found.matches.map((m) => m.id)).toEqual(['v1'])

    await stopAndInspect(router)
    expect(existsSync(harness.pathOf('events'))).toBe(true)
  })

  it('retrain-shaped transact stays atomic on the events worker', async () => {
    harness = makeHarness()
    const router = await harness.router()
    const frames = 'p5:retrain-frames'
    const rows = 'p5:retrain-annotations'
    await router.declareCollection({
      collection: frames,
      database: 'events',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'revision', type: 'INTEGER', notNull: true, defaultValue: 0 },
      ],
    })
    await router.declareCollection({
      collection: rows,
      database: 'events',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'frame', type: 'TEXT', notNull: true },
        { name: 'n', type: 'INTEGER', notNull: true },
      ],
    })
    await router.insert({ collection: frames, record: { id: 'f1', data: { revision: 0 } } })
    await router.insertMany({
      collection: rows,
      records: [{ id: 'old1', data: { frame: 'f1', n: 1 } }],
    })

    const ok = await router.transact({
      guard: { collection: frames, key: 'f1', column: 'revision', equals: 0 },
      ops: [
        { op: 'deleteWhere', collection: rows, filter: { where: { frame: 'f1' } } },
        {
          op: 'insertMany',
          collection: rows,
          records: [{ id: 'new1', data: { frame: 'f1', n: 9 } }],
        },
        { op: 'update', collection: frames, id: 'f1', data: { revision: 1 } },
      ],
    })
    expect(ok).toEqual({ applied: true })
    expect(await router.count({ collection: rows })).toBe(1)
    await harness.stopAll(router)
  })
})
