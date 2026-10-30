import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  VeluxDisconnect,
  VeluxGatewayClient,
  VeluxGatewayClientFactory,
  VeluxNode,
} from '../velux-client-contract.js'
import { VeluxClientRegistry } from '../velux-client-registry.js'
import { cascadeRemoveDevicesForIntegration } from '../velux-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from '../velux-integration-offline.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { RecordingLogger } from './recording-logger.js'

const NODE: VeluxNode = {
  nodeId: 3,
  serial: 'aabbccddeeff0011',
  name: 'Roof window',
  position: 40,
  targetPosition: 40,
  moving: false,
  coverClass: 'window',
  online: true,
  rainSensor: true,
  raining: false,
}

class StubClient implements VeluxGatewayClient {
  disconnected = 0
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnected += 1
  }
  listNodes(): readonly VeluxNode[] {
    return [NODE]
  }
  async readVersion(): Promise<string> {
    return '0.2.0.0.71.0'
  }
  async reboot(): Promise<void> {}
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async stop(): Promise<void> {}
  async setPosition(): Promise<void> {}
  onNodeChanged(): () => void {
    return () => undefined
  }
  onDisconnected(_l: (e: VeluxDisconnect) => void): () => void {
    return () => undefined
  }
}

function registry() {
  const clients: StubClient[] = []
  const makeClient = vi.fn<VeluxGatewayClientFactory>(() => {
    const c = new StubClient()
    clients.push(c)
    return c
  })
  const events: string[] = []
  const reg = new VeluxClientRegistry(new RecordingLogger(), {
    makeClient,
    onConnected: (id) => events.push(`up:${id}`),
    onDisconnected: (id) => events.push(`down:${id}`),
  })
  return { reg, clients, makeClient, events }
}

afterEach(() => {
  veluxGateways.clear()
})

describe('VeluxClientRegistry', () => {
  it('starts one session per integration and publishes it to the devices', async () => {
    const { reg, makeClient, events } = registry()
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'x' })
    await reg.upsert('int-b', 'B', { host: '10.0.0.6', password: 'y' })
    expect(makeClient).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['up:int-a', 'up:int-b'])
    expect(veluxGateways.getNodes('int-a')).toEqual([NODE])
    expect(veluxGateways.getManager('int-b')?.status).toBe('connected')
    expect(veluxGateways.getManager('int-a')?.firmware).toBe('0.2.0.0.71.0')
    await reg.shutdown()
  })

  it('leaves a running session alone when the same settings come again, and reconnects when they change', async () => {
    const { reg, makeClient } = registry()
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'x' })
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'x' })
    expect(makeClient).toHaveBeenCalledTimes(1)
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'new' })
    expect(makeClient).toHaveBeenCalledTimes(2)
    await reg.shutdown()
  })

  it('closes the session and unpublishes it when the integration is removed or no longer retained', async () => {
    const { reg, clients } = registry()
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'x' })
    await reg.upsert('int-b', 'B', { host: '10.0.0.6', password: 'y' })
    await reg.retain(new Set(['int-b']))
    expect(reg.list()).toEqual(['int-b'])
    expect(clients[0]?.disconnected).toBe(1)
    expect(veluxGateways.getManager('int-a')).toBeNull()
    await reg.shutdown()
    expect(veluxGateways.getManager('int-b')).toBeNull()
  })

  it('counts the live sessions held on a host, for the connection test', async () => {
    const { reg } = registry()
    await reg.upsert('int-a', 'A', { host: '10.0.0.5', password: 'x' })
    await reg.upsert('int-b', 'B', { host: '10.0.0.5', password: 'y' })
    await reg.upsert('int-c', 'C', { host: '10.0.0.6', password: 'z' })
    expect(reg.liveSessions('10.0.0.5')).toBe(2)
    expect(reg.liveSessions('10.0.0.6')).toBe(1)
    expect(reg.liveSessions('10.0.0.7')).toBe(0)
    await reg.shutdown()
  })
})

describe('integration device helpers', () => {
  function target(config: Record<string, unknown>, online: boolean) {
    const t = {
      online,
      config: { get: (k: string) => config[k] },
      markOnline(next: boolean) {
        t.online = next
      },
    }
    return t
  }

  it('flips only the devices of that integration', () => {
    const mine = target({ system: 'velux', integrationId: 'int-a' }, true)
    const theirs = target({ system: 'velux', integrationId: 'int-b' }, true)
    const foreign = target({ system: 'bosch-shc', integrationId: 'int-a' }, true)
    expect(setIntegrationDevicesOnline([mine, theirs, foreign], 'int-a', false)).toBe(1)
    expect([mine.online, theirs.online, foreign.online]).toEqual([false, true, true])
  })

  it('cascade removes the top-level devices of the integration and nothing else', async () => {
    const configs: Record<number, Record<string, unknown>> = {
      1: { system: 'velux', integrationId: 'int-a' },
      2: { system: 'velux', integrationId: 'int-b' },
      3: { system: 'velux', integrationId: 'int-a' },
    }
    const removed: number[] = []
    const count = await cascadeRemoveDevicesForIntegration({
      reg: {
        getAllForAddon: () => [
          { id: 1, parentDeviceId: null },
          { id: 2, parentDeviceId: null },
          // a child: removed with its container, never on its own
          { id: 3, parentDeviceId: 1 },
        ],
      },
      devices: {
        loadConfig: async (id: number) => configs[id] ?? {},
        remove: async (id: number) => {
          removed.push(id)
        },
      },
      addonId: 'provider-velux',
      integrationId: 'int-a',
      logger: new RecordingLogger(),
    })
    expect(count).toBe(1)
    expect(removed).toEqual([1])
  })
})
