/**
 * Phase P0 is LAYOUT-NEUTRAL (D851, D853): an engine on which no collection
 * names `events` or `history` behaves as it did before the owned-file layer —
 * one file, `camstack.db`, every collection in it, nothing new on disk.
 *
 * Booted through the real addon, so the claim covers the wiring and not only
 * the router.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteSettingsAddon } from '../sqlite-settings.addon.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

describe('the engine with no events/history declaration', () => {
  it('serves every collection from camstack.db and creates no other database file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-layout-neutral-'))
    tmpDirs.push(dir)
    const addon = new SqliteSettingsAddon()
    const ctx = {
      id: 'sqlite-settings',
      dataDir: dir,
      logger: makeLogger(),
      // The stale-data audit subscribes to the registry's readiness event at init.
      eventBus: { subscribe: () => () => undefined },
    }
    const result = await addon.initialize(ctx as unknown as AddonContext)
    const registrations =
      result && 'providers' in result && result.providers ? result.providers : []
    const registration = registrations.find((p) => p.capability.name === 'data-store-provider')
    // The door's engine IS the placement router.
    const engine = addon.getRouter()
    if (engine === null) throw new Error('the engine built no placement router')
    expect(registration?.provider).toBe(engine)

    await engine.declareCollection({
      collection: 'neutral:ledger',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        { name: 'atMs', type: 'INTEGER' },
      ],
    })
    await engine.insert({ collection: 'neutral:ledger', record: { id: 'r', data: { atMs: 1 } } })
    await engine.set({ collection: 'addon-settings', key: 'k', value: { v: 1 } })

    expect(engine.openFiles().map((f) => f.databaseId)).toEqual(['settings'])
    expect(engine.databaseOf('neutral:ledger')).toBe('settings')
    expect(engine.databaseOf('addon-settings')).toBe('settings')
    await addon.shutdown()

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.db')).toSorted()
    expect(files).toEqual(['camstack.db'])
  })
})
