/**
 * Records over the REAL placement (D851 + D881): `events.db` is served by a
 * worker thread, and a kind declared for it lives only there. The proof is made
 * by stopping everything and opening the files with a plain driver.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordsProvider } from '../records/records-provider.js'
import { declaration, silentLogger } from './support/records-harness.js'
import { makeHarness, type Harness } from './support/owned-files-harness.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

function tablesOf(file: string): readonly string[] {
  const db = new Database(file, { readonly: true })
  try {
    return db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('records over a worker-served events.db', () => {
  it('a kind for events lives only in events.db, survives a restart, and a settings kind stays in camstack.db', async () => {
    harness = makeHarness()
    let router = await harness.router()
    let provider = new RecordsProvider(router, silentLogger())
    await provider.init()
    const as = { callerAddonId: 'owner-addon' }
    await provider.declareKinds({
      ...as,
      kinds: {
        ev: declaration({ database: 'events', indexes: [{ name: 'tag', fields: ['tag'] }] }),
        cfg: declaration({ device: 'none', at: 'none', class: 'config' }),
      },
    })
    await provider.putMany({
      ...as,
      kind: 'ev',
      records: [1, 2, 3].map((n) => ({
        id: `r${n}`,
        deviceId: 7,
        at: n,
        data: { tag: n % 2 === 0 ? 'even' : 'odd' },
      })),
    })
    await provider.put({ ...as, kind: 'cfg', record: { id: 'c', data: { v: 1 } } })
    const page = await provider.query({ ...as, kind: 'ev', where: { tag: 'odd' }, limit: 10 })
    expect(page.records.map((r) => r.id)).toEqual(['r1', 'r3'])
    await harness.stopAll(router)

    expect(tablesOf(harness.pathOf('events'))).toEqual(
      expect.arrayContaining(['records', '_record_kinds']),
    )
    const settingsTables = tablesOf(harness.pathOf('settings'))
    expect(settingsTables).toContain('records')
    const inSettings = new Database(harness.pathOf('settings'), { readonly: true })
    const inEvents = new Database(harness.pathOf('events'), { readonly: true })
    try {
      expect(inSettings.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
      expect(inEvents.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 3 })
    } finally {
      inSettings.close()
      inEvents.close()
    }

    router = await harness.router(['events'])
    provider = new RecordsProvider(router, silentLogger())
    await provider.init()
    expect((await provider.count({ ...as, kind: 'ev', deviceId: 7 })).count).toBe(3)
    expect(await provider.get({ ...as, kind: 'cfg', id: 'c' })).toMatchObject({ data: { v: 1 } })
    await harness.stopAll(router)
  })
})
