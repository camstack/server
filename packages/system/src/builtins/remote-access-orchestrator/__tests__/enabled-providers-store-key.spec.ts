/**
 * The operator's "keep this tunnel up" intent lives under the addon-store key `enabledProviders` —
 * the key every earlier build wrote through `updateGlobalSettings`. A set an old build stored is
 * extended, not replaced, and a write lands under the same key.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { RemoteAccessOrchestratorAddon } from '../remote-access-orchestrator.addon.js'

class StoreAddon extends RemoteAccessOrchestratorAddon {
  protected override async onInitialize(): ReturnType<
    RemoteAccessOrchestratorAddon['onInitialize']
  > {
    return []
  }
  mark(addonId: string, enabled: boolean): Promise<void> {
    return this.markEnabled(addonId, enabled)
  }
}

async function boot(store: Record<string, unknown>): Promise<StoreAddon> {
  const addon = new StoreAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'remote-access-orchestrator',
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

describe('enabledProviders store key', () => {
  it('extends the set an old build stored, under the same key', async () => {
    const store: Record<string, unknown> = { enabledProviders: ['cloudflare'] }
    const addon = await boot(store)
    await addon.mark('tailscale', true)
    expect(Object.keys(store)).toEqual(['enabledProviders'])
    expect(store['enabledProviders']).toEqual(['cloudflare', 'tailscale'])
  })

  it('removes one provider and keeps the others', async () => {
    const store: Record<string, unknown> = { enabledProviders: ['cloudflare', 'tailscale'] }
    const addon = await boot(store)
    await addon.mark('cloudflare', false)
    expect(store['enabledProviders']).toEqual(['tailscale'])
  })
})
