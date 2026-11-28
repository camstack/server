/**
 * The adoption page reads candidates from the account list the manager keeps (D224):
 * `listCandidates` answers from it at once and only asks for a background revalidation;
 * `refresh` re-lists the account before it answers, so a device added in the app appears.
 */
import type { IScopedLogger } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import type { VeSyncDeviceSnapshot, VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { buildVeSyncAdoptionProvider } from '../vesync-adoption-provider.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

function purifier(nativeId: string): VeSyncPurifierSnapshot {
  return {
    kind: 'purifier',
    nativeId,
    name: `Purifier ${nativeId}`,
    power: false,
    speedPercent: null,
    preset: '',
    availablePresets: [],
    childLock: false,
    display: true,
    filterLifePercent: 90,
    online: true,
  }
}

function rig() {
  const order: string[] = []
  let cloud: readonly VeSyncDeviceSnapshot[] = [purifier('cid-1')]
  let cache: readonly VeSyncDeviceSnapshot[] = cloud
  const fail = async (): Promise<never> => {
    throw new Error('not used')
  }
  const provider = buildVeSyncAdoptionProvider({
    getDevices: () => {
      order.push('getDevices')
      return cache
    },
    hasIntegration: () => true,
    integrationOnline: () => true,
    listIntegrations: () => ['int_1'],
    integrationName: () => 'Home',
    listAdopted: async () => [],
    revalidate: () => {
      order.push('revalidate')
    },
    relist: async () => {
      order.push('relist')
      cache = cloud
    },
    adoptPurifier: fail,
    adoptHumidifier: fail,
    removeDevice: fail,
    findDeviceConfig: async () => null,
    logger: silent,
  })
  return {
    provider,
    order,
    addInApp: (nativeId: string): void => {
      cloud = [...cloud, purifier(nativeId)]
    },
  }
}

describe('VeSync adoption candidates (D224)', () => {
  it('listCandidates answers from the cache and only asks for a revalidation', async () => {
    const r = rig()
    r.addInApp('cid-2')
    const page = await r.provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })
    expect(r.order).toContain('revalidate')
    expect(r.order).not.toContain('relist')
    expect(page.candidates.some((c) => c.childNativeId.includes('cid-2'))).toBe(false)
  })

  it('refresh re-lists the account before it answers: a device added in the app appears', async () => {
    const r = rig()
    r.addInApp('cid-2')
    const status = await r.provider.refresh({ integrationId: 'int_1' })
    expect(r.order.indexOf('relist')).toBeGreaterThanOrEqual(0)
    expect(r.order.indexOf('relist')).toBeLessThan(r.order.indexOf('getDevices'))
    const page = await r.provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })
    expect(page.candidates.some((c) => c.childNativeId.includes('cid-2'))).toBe(true)
    expect(status.candidateCount).toBe(page.totalCount)
  })
})
