/**
 * PLACEMENT over the real engine (D851): a collection that names a file lives
 * ONLY in that file.
 *
 * The check is made the only way that cannot be fooled by the router's own
 * map: stop everything, then open the files on disk with a plain driver and
 * ask `sqlite_master`. A router that answered correctly while writing the table
 * to `camstack.db` would pass any test that stays behind the door.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DuplicatePlacementError } from '../placement-errors.js'
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

async function writeOne(router: PlacementRouter, collection: string, label: string): Promise<void> {
  await router.insert({ collection, record: { id: label, data: { atMs: 1, label } } })
}

describe('placement over real SQLite', () => {
  it('a collection declared for events lives only in events.db', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('plc:ledger', 'events'))
    await router.declareCollection(ledgerDeclaration('plc:config'))
    await writeOne(router, 'plc:ledger', 'a')
    await writeOne(router, 'plc:config', 'b')

    expect(await router.count({ collection: 'plc:ledger' })).toBe(1)
    expect(router.databaseOf('plc:ledger')).toBe('events')
    expect(router.databaseOf('plc:config')).toBe('settings')
    await harness.stopAll(router)

    const inEvents = tablesOf(harness.pathOf('events'))
    const inSettings = tablesOf(harness.pathOf('settings'))
    expect(inEvents).toContain('plc:ledger')
    expect(inEvents).not.toContain('plc:config')
    expect(inSettings).toContain('plc:config')
    expect(inSettings).not.toContain('plc:ledger')
  })

  it('creates no events.db or history.db until a collection names it', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('plc:only-settings'))
    await router.set({ collection: 'addon-settings', key: 'k', value: { v: 1 } })
    expect(existsSync(harness.pathOf('events'))).toBe(false)
    expect(existsSync(harness.pathOf('history'))).toBe(false)
    await harness.stopAll(router)
    expect(existsSync(harness.pathOf('events'))).toBe(false)
    expect(existsSync(harness.pathOf('history'))).toBe(false)
  })

  it('rebuilds placement at boot from the files on disk', async () => {
    harness = makeHarness()
    const first = await harness.router()
    await first.declareCollection(ledgerDeclaration('plc:ledger', 'events'))
    await writeOne(first, 'plc:ledger', 'survives')
    await harness.stopAll(first)

    // A new life of the engine: nothing re-declares, the files are on disk.
    const second = await harness.router(['events'])
    expect(second.databaseOf('plc:ledger')).toBe('events')
    expect(await second.count({ collection: 'plc:ledger' })).toBe(1)
    await harness.stopAll(second)
  })

  it('serves the canonical KV collections from settings without any other file open', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.set({
      namespace: 'some-addon',
      collection: 'addon-settings',
      key: 'k',
      value: { v: 2 },
    })
    expect(
      await router.get({ namespace: 'some-addon', collection: 'addon-settings', key: 'k' }),
    ).toEqual({
      v: 2,
    })
    expect(router.databaseOf('some-addon:addon-settings')).toBe('settings')
    await harness.stopAll(router)
  })

  it('refuses to serve a layout where one table is declared in two files', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('plc:dup', 'events'))
    await harness.stopAll(router)

    // Corrupt the layout on purpose: the same declaration in camstack.db.
    const db = new Database(harness.pathOf('settings'))
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS "_collection_declarations" (name TEXT PRIMARY KEY NOT NULL, decl TEXT NOT NULL)',
      )
      db.prepare(
        'INSERT OR REPLACE INTO "_collection_declarations" (name, decl) VALUES (?, ?)',
      ).run(
        'plc:dup',
        JSON.stringify({
          primaryKey: 'id',
          columns: ['atMs'],
          booleanColumns: [],
          autoPrimaryKey: false,
        }),
      )
    } finally {
      db.close()
    }

    await expect(harness.router(['events'])).rejects.toBeInstanceOf(DuplicatePlacementError)
    await expect(harness.router(['events'])).rejects.toThrow(/plc:dup.*settings.*events/)
  })
})
