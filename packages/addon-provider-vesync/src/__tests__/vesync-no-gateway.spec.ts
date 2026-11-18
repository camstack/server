/**
 * VeSync no longer creates a Gateway device: the account's connection state is the
 * integration's status. Discovery does not propose it and adoption refuses its old id.
 */
import { DeviceType, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildVeSyncAdoptionProvider } from '../vesync-adoption-provider.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

function rig() {
  const created: string[] = []
  const provider = buildVeSyncAdoptionProvider({
    getDevices: () => [],
    hasIntegration: () => true,
    integrationOnline: () => true,
    listIntegrations: () => ['int_1'],
    integrationName: () => 'Home',
    listAdopted: async () => [],
    revalidate: () => undefined,
    relist: async () => undefined,
    adoptPurifier: async ({ cid }) => {
      created.push(cid)
      return { deviceId: 1 }
    },
    adoptHumidifier: async ({ cid }) => {
      created.push(cid)
      return { deviceId: 2 }
    },
    removeDevice: async () => undefined,
    findDeviceConfig: async () => null,
    logger: silent,
  })
  return { provider, created }
}

describe('VeSync has no Gateway device', () => {
  it('proposes no Gateway candidate for an account', async () => {
    const { provider } = rig()
    const page = await provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })
    expect(page.candidates.some((c) => c.type === DeviceType.Gateway)).toBe(false)
    expect(page.candidates.some((c) => c.childNativeId === 'account')).toBe(false)
  })

  it('refuses to adopt the old account id and creates nothing', async () => {
    const { provider, created } = rig()
    await expect(
      provider.adopt({ integrationId: 'int_1', childNativeIds: ['account'] }),
    ).rejects.toThrow(/failed/)
    expect(created).toEqual([])
  })
})
