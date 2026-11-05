import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { TailscaleClientAddon } from '../client/tailscale.addon.js'
import { TailscaleIngressAddon } from '../ingress/tailscale-ingress.addon.js'

/** The first config resolve runs before providers register (D986 M4): the node caps are named. */
interface Probe {
  scopedSettingsCapabilities(): readonly string[]
  getScopedSettingsSchema(scope: 'node', cap: string): Promise<ConfigUISchema | null>
}

class ClientProbe extends TailscaleClientAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}
class IngressProbe extends TailscaleIngressAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}

describe('tailscale scoped settings capabilities', () => {
  it.each([
    ['client', new ClientProbe()],
    ['ingress', new IngressProbe()],
  ] as const)('%s names every capability that has a node schema', async (_name, addon: Probe) => {
    for (const cap of ['mesh-network', 'network-access']) {
      if ((await addon.getScopedSettingsSchema('node', cap)) !== null) {
        expect(addon.scopedSettingsCapabilities()).toContain(cap)
      }
    }
    expect(addon.scopedSettingsCapabilities().length).toBeGreaterThan(0)
  })
})
