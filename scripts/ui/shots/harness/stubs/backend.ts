import type { System } from '@camstack/sdk'
import { fakeClient } from './transport'

const noop = () => () => undefined
let instance: System | null = null

function make(): System {
  const trpcClient = fakeClient() as unknown as Record<string, unknown>
  const known: Record<string, unknown> = {
    trpcClient,
    serverUrl: 'https://camstack.example.com',
    connectionVersion: 1,
    subscribeConnectionEvents: noop,
    onEvent: noop,
    onEvents: noop,
    subscribeEvents: noop,
    subscribeEvent: noop,
    onDeviceAdded: noop,
    onDeviceRemoved: noop,
    awaitConnected: async () => undefined,
    init: async () => undefined,
    close: () => undefined,
    reconnect: () => undefined,
    setToken: () => undefined,
    isReady: () => true,
    getOwnTotpStatus: async () => ({ enabled: true, confirmedAt: Date.UTC(2026, 7, 20) }),
    isConnected: () => true,
    listDevices: () => [],
    listDeviceInfos: () => [],
    getDeviceInfo: () => null,
    getDevice: () => null,
    getDeviceByName: () => null,
    getDeviceByStableId: () => null,
  }
  return new Proxy(known, {
    get(t, p: string | symbol) {
      if (typeof p === 'symbol') return undefined
      if (p in t) return t[p]
      if (p === 'then') return undefined
      return trpcClient[p]
    },
  }) as unknown as System
}

export function getSystem(): System {
  instance ??= make()
  return instance
}
export function resetSystem(): void {}
