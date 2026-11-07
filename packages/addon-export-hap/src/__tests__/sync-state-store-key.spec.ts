/**
 * The default bridge's reconcile cache lives under the addon-store key `exportSyncState` — the key
 * every earlier build wrote through `updateGlobalSettings`. A value an old build stored is read by
 * the new code (an unchanged restart must not rebuild), and a write lands under the same key.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { BridgeInstance } from '../bridge-instance.js'
import { BridgeHost } from '../bridge-host.js'
import { ExportHapAddon } from '../hap-export.addon.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'

class StoreAddon extends ExportHapAddon {
  protected override async onInitialize(): ReturnType<ExportHapAddon['onInitialize']> {
    return { providers: [] }
  }
  syncOf(inst: BridgeInstance) {
    return this.syncStateOf(inst)
  }
  persist(inst: BridgeInstance, deviceId: number, fingerprint: string) {
    return this.persistFingerprint(inst, deviceId, fingerprint)
  }
}

/** An uninitialised host: these specs only read and write the reconcile cache, never the host. */
const NO_HOST: BridgeHost = Object.create(BridgeHost.prototype)

function defaultBridge(): BridgeInstance {
  return new BridgeInstance(
    HAP_DEFAULT_INSTANCE_ID,
    'Test bridge',
    { username: 'AA:BB:CC:DD:EE:FF', uuid: 'u', pincode: '031-45-154' },
    NO_HOST,
    { name: 'HomeKit exposure', devices: [], actions: [] },
  )
}

async function boot(store: Record<string, unknown>): Promise<StoreAddon> {
  const addon = new StoreAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'export-hap',
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

describe('exportSyncState store key', () => {
  it('reads a cache written by the old build', async () => {
    const store = {
      exportSyncState: { '7': { fingerprint: 'old-fp', externalIds: ['uuid-7'] } },
    }
    const addon = await boot(store)
    const state = await addon.syncOf(defaultBridge())
    expect(state.get(7)).toEqual({ fingerprint: 'old-fp', externalIds: ['uuid-7'] })
  })

  it('writes a new entry under the same key and keeps the old ones', async () => {
    const store: Record<string, unknown> = {
      exportSyncState: { '7': { fingerprint: 'old-fp', externalIds: ['uuid-7'] } },
    }
    const addon = await boot(store)
    await addon.persist(defaultBridge(), 9, 'new-fp')
    expect(Object.keys(store)).toEqual(['exportSyncState'])
    expect(store['exportSyncState']).toMatchObject({
      '7': { fingerprint: 'old-fp', externalIds: ['uuid-7'] },
      '9': { fingerprint: 'new-fp' },
    })
  })

  it('two concurrent attaches both survive (the cache is written read-modify-write, per bridge)', async () => {
    const store: Record<string, unknown> = {}
    const addon = await boot(store)
    const bridge = defaultBridge()
    await Promise.all([addon.persist(bridge, 1, 'fp-1'), addon.persist(bridge, 2, 'fp-2')])
    expect(store['exportSyncState']).toMatchObject({
      '1': { fingerprint: 'fp-1' },
      '2': { fingerprint: 'fp-2' },
    })
  })
})
