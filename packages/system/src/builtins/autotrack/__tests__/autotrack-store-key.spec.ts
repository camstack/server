/**
 * The per-camera records live under the addon-store key `cameras` — the key every earlier build
 * wrote through `updateGlobalSettings`. A record an old build stored is read by the new code, and
 * a write lands under the same key.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { AutotrackAddon } from '../autotrack.addon.js'

class StoreAddon extends AutotrackAddon {
  protected override async onInitialize(): ReturnType<AutotrackAddon['onInitialize']> {
    return {}
  }
  load(): Promise<void> {
    return this.loadRecords()
  }
  persist(): Promise<void> {
    return this.persistRecords()
  }
  enabledOf(deviceId: number): boolean {
    return this.recordOf(deviceId).enabled
  }
}

async function boot(store: Record<string, unknown>): Promise<StoreAddon> {
  const addon = new StoreAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'autotrack',
      settings: {
        readAddonStore: async () => ({ ...store }),
        writeAddonStore: async (patch) => {
          Object.assign(store, patch)
        },
      },
    }),
  )
  return addon
}

describe('cameras store key', () => {
  it('reads a record an old build stored', async () => {
    const addon = await boot({ cameras: { '1438': { enabled: true } } })
    await addon.load()
    expect(addon.enabledOf(1438)).toBe(true)
    expect(addon.enabledOf(1439)).toBe(false)
  })

  it('writes the records back under the same key', async () => {
    const store: Record<string, unknown> = { cameras: { '1438': { enabled: true } } }
    const addon = await boot(store)
    await addon.load()
    await addon.persist()
    expect(Object.keys(store)).toEqual(['cameras'])
    expect(store['cameras']).toMatchObject({ '1438': { enabled: true } })
  })
})
