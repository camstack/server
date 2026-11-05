import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { LocalNetworkAddon } from '../local-network.addon.js'

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

/**
 * D986 M4: the LAN settings are all per node, declared on the node hook of `local-network` only,
 * with the keys the migration `lan-settings-per-node` copied (`<key>@<nodeId>`).
 */
function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('the local-network scoped settings', () => {
  it('declares the six LAN keys on the node hook only', async () => {
    const addon = new LocalNetworkAddon()
    expect(keysOf(await addon.getScopedSettingsSchema('node', 'local-network'))).toEqual(
      [
        'httpEnabled',
        'httpPort',
        'localHostname',
        'mdnsAdvertise',
        'passiveDiscovery',
        'tlsEnabled',
      ].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'local-network')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'local-network')).toBeNull()
  })
})
