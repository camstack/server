/**
 * `listDeviceSettingsScopes` walks the store by primary key in pages: a fleet
 * larger than one page (and larger than the engine's defensive row cap) is
 * listed whole, and a read that cannot complete throws instead of listing part.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../../builtins/sqlite-storage/sqlite-settings-backend.js'
import { createDataStoreDispatch } from '../../builtins/storage-orchestrator/data-store-dispatch.js'
import { createDeviceSettingsStore, listDeviceSettingsScopes } from '../device-settings-store.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

describe('listDeviceSettingsScopes', () => {
  it('lists every (addon, device) pair of a store larger than one page and than the row cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scopes-'))
    dirs.push(dir)
    const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
    await backend.initialize()
    const door = createDataStoreDispatch(() => [backend])
    const recorder = createDeviceSettingsStore(door, 'recorder')
    const motion = createDeviceSettingsStore(door, 'motion-wasm')
    // 1100 devices x 2 addons x 1 field = 2200 rows: past one page and past the 2 000-row cap.
    for (let id = 1; id <= 1100; id += 1) {
      await recorder.merge(id, { a: 1 })
      await motion.merge(id, { b: 2 })
    }
    const scopes = await listDeviceSettingsScopes(door)
    expect(scopes).toHaveLength(2200)
    expect(new Set(scopes.map((s) => s.addonId))).toEqual(new Set(['recorder', 'motion-wasm']))
    await backend.shutdown()
  }, 60_000)

  it('a read that fails throws - it never returns the part it got', async () => {
    const failing = {
      query: async (): Promise<never> => {
        throw new Error('store did not answer')
      },
    }
    await expect(listDeviceSettingsScopes(failing)).rejects.toThrow('store did not answer')
  })
})
