import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { buildMatterBrokerProvider } from '../matter-broker-provider.js'
import type { MatterBrokerEntry } from '../config.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

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
  it('returns threadDataset and wifiPassword empty on getSettings and getBrokerConfig', async () => {
    const provider = buildMatterBrokerProvider({
      ownerAddonId: 'matter-broker',
      registry: {
        list: () => [],
        get: () => null,
        createEntry: async () => ENTRY,
        removeEntry: async () => undefined,
        updateEntry: async () => ENTRY,
        size: () => 1,
        connectedCount: () => 1,
        commissionNode: async () => ({ nodeId: '1' }),
        getCommissionProgress: () => null,
      },
      getBrokers: () => [ENTRY],
      persistBrokers: async () => undefined,
      cascadeRemoveDevices: async () => undefined,
      logger: silentLogger(),
    })

    const settings = await provider.getSettings({ id: 'matter_001' })
    const config = await provider.getBrokerConfig({ id: 'matter_001' })
    expect(settings).toMatchObject({ threadDataset: '', wifiPassword: '', wifiSsid: 'lab' })
    expect(config).toMatchObject({ threadDataset: '', wifiPassword: '' })
    expect(JSON.stringify(settings)).not.toContain('00112233secret')
    expect(JSON.stringify(config)).not.toContain('wifi-secret')
  })
})
