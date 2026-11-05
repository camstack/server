import { describe, expect, it } from 'vitest'
import { buildMatterBrokerProvider } from '../matter-broker-provider.js'
import type { MatterBrokerEntry } from '../config.js'

const ENTRY: MatterBrokerEntry = {
  id: 'matter_001',
  name: 'Home',
  connection: {
    threadDataset: '00112233secret',
    wifiSsid: 'lab',
    wifiPassword: 'wifi-secret',
    reconcileIntervalMs: 300_000,
  },
}

describe('Matter broker settings redact fabric secrets', () => {
  it('returns threadDataset and wifiPassword empty on getBrokerConfig', async () => {
    const provider = buildMatterBrokerProvider({
      registry: {
        size: () => 1,
        connectedCount: () => 1,
        commissionNode: async () => ({ nodeId: '1' }),
        getCommissionProgress: () => null,
      },
      getBrokers: () => [ENTRY],
    })

    const config = await provider.getBrokerConfig({ id: 'matter_001' })
    expect(config).toMatchObject({ threadDataset: '', wifiPassword: '', wifiSsid: 'lab' })
    expect(JSON.stringify(config)).not.toContain('00112233secret')
    expect(JSON.stringify(config)).not.toContain('wifi-secret')
  })
})
