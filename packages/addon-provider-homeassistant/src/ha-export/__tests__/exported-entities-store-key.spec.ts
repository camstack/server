/**
 * The exported actions and notification targets live under the addon-store key `exportedEntities`
 * (D968) — the key every earlier build wrote through `updateGlobalSettings`. A selection an old build
 * stored is served by the new code, and a change is written back under the same key.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import type { ExportedEntities } from '../exported-entities.js'

class StoreAddon extends HaExportAddon {
  protected override async onInitialize(): ReturnType<HaExportAddon['onInitialize']> {
    return []
  }
  open(): Promise<ExportedEntities> {
    return this.openExportedEntities(async () => undefined)
  }
}

const OLD_SELECTION = {
  actions: [{ actionId: 'scene:night', displayName: 'Night', addedAt: 1_700_000_000_000 }],
  targets: [{ targetId: 'tg:1', displayName: 'Phone', addedAt: 1_700_000_000_001 }],
}

async function boot(store: Record<string, unknown>): Promise<StoreAddon> {
  const addon = new StoreAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'ha-export',
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

describe('exportedEntities store key', () => {
  it('serves the selection an old build stored', async () => {
    const addon = await boot({ exportedEntities: OLD_SELECTION })
    const entities = await addon.open()
    expect(entities.list()).toEqual([
      { entity: { kind: 'action', actionId: 'scene:night' }, exposedAs: 'Night' },
      { entity: { kind: 'notifier', targetId: 'tg:1' }, exposedAs: 'Phone' },
    ])
  })

  it('writes a removal back under the same key, keeping the rest', async () => {
    const store: Record<string, unknown> = { exportedEntities: OLD_SELECTION }
    const addon = await boot(store)
    const entities = await addon.open()
    await entities.unexpose({ kind: 'action', actionId: 'scene:night' })
    expect(Object.keys(store)).toEqual(['exportedEntities'])
    expect(store['exportedEntities']).toEqual({ actions: [], targets: OLD_SELECTION.targets })
  })
})
