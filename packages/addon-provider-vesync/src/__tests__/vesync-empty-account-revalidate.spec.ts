/**
 * D224, D1062 — an account with ZERO devices registers nothing for the core to read, so the only
 * reader left is the adoption page: a listing of a stale list starts ONE re-read (served from the
 * list at once), and the device added in the app shows on the next listing.
 */
import type { IScopedLogger } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { vesyncConnectionSchema } from '../config.js'
import { buildVeSyncAdoptionProvider } from '../vesync-adoption-provider.js'
import type { VeSyncClient, VeSyncDeviceSnapshot } from '../vesync-client-contract.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

const POLL_MS = 3_600_000

function rig() {
  let cloud: readonly VeSyncDeviceSnapshot[] = []
  const lists = { count: 0 }
  const unused = async (): Promise<never> => {
    throw new Error('not used')
  }
  const client: VeSyncClient = {
    login: async () => undefined,
    restoreSession: () => undefined,
    logout: async () => undefined,
    listDevices: async () => {
      lists.count += 1
      return cloud
    },
    refreshDevice: async () => null,
    getDevice: () => null,
    setPower: unused,
    setFanSpeed: unused,
    setMode: unused,
    setChildLock: unused,
    setDisplay: unused,
    setTargetHumidity: unused,
  }
  const manager = new VeSyncIntegrationManager({
    id: 'int_1',
    name: 'Home',
    connection: vesyncConnectionSchema.parse({
      email: 'me@example.com',
      password: 'pw',
      pollIntervalMs: POLL_MS,
    }),
    logger: silent,
    sessions: {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
      prune: async () => undefined,
    },
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
    makeClient: () => client,
  })
  const provider = buildVeSyncAdoptionProvider({
    getDevices: () => manager.getDevices(),
    hasIntegration: () => true,
    integrationOnline: () => manager.status === 'connected',
    listIntegrations: () => ['int_1'],
    integrationName: () => 'Home',
    listAdopted: async () => [],
    revalidate: () => {
      manager.revalidate()
    },
    relist: async () => manager.relist(),
    adoptPurifier: unused,
    adoptHumidifier: unused,
    removeDevice: unused,
    findDeviceConfig: async () => null,
    logger: silent,
  })
  return {
    manager,
    provider,
    lists,
    addInApp: (device: VeSyncDeviceSnapshot): void => {
      cloud = [...cloud, device]
    },
  }
}

describe('VeSync account with no devices (D224, D1062)', () => {
  it('a listing of a stale list starts one re-read, and the next listing shows the new device', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const r = rig()
      await r.manager.start()
      expect(r.lists.count).toBe(1)
      r.addInApp({
        kind: 'purifier',
        nativeId: 'cid-9',
        name: 'Purifier',
        power: false,
        speedPercent: null,
        preset: '',
        availablePresets: [],
        childLock: false,
        display: true,
        filterLifePercent: 90,
        online: true,
      })
      const ask = () => r.provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })

      expect((await ask()).totalCount).toBe(0)
      expect(r.lists.count).toBe(1)

      vi.setSystemTime(Date.now() + POLL_MS + 1)
      await ask()
      await vi.waitFor(() => expect(r.lists.count).toBe(2))
      expect((await ask()).candidates.some((c) => c.childNativeId.includes('cid-9'))).toBe(true)
      expect(r.lists.count).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
