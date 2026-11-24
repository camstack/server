/**
 * The adoption list marks the port children of an ADOPTED switch from the live devices
 * (planning#689). The registry and resolver are real; the device registry is the one boundary
 * a spec supplies.
 */
import { DeviceType, type DiscoveredChildDevice, type IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionFromSettings, UNIFI_SYSTEM } from '../config.js'
import { markPortChildren } from '../unifi-adoption-marking.js'
import { buildUnifiAdoptionProvider } from '../unifi-adoption-provider.js'
import type { UnifiControllerClient, UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { UnifiClientRegistry } from '../unifi-client-registry.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { infraSnapshot, port } from './unifi-fixtures.js'

const INT = 'int-1'
const warn = vi.fn()
const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}
const SWITCH: UnifiInfraSnapshot = infraSnapshot({
  id: 'sw1',
  name: 'Switch',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  ports: [port({ idx: 1 }), port({ idx: 2 })],
})

function fakeClient(infra: readonly UnifiInfraSnapshot[]): UnifiControllerClient {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    listInfraDevices: async () => infra,
    listClients: async () => [],
    getInfraDevice: () => null,
    getClient: () => null,
    setPortPoe: async () => undefined,
    restartDevice: async () => undefined,
    powerCyclePort: async () => undefined,
    setLed: async () => undefined,
    degradedError: () => null,
    onLiveChange: () => () => undefined,
  }
}

interface Registry {
  readonly childIds: (id: number) => Promise<readonly number[]>
  readonly config: (id: number) => Promise<Record<string, unknown> | null>
}

async function providerWith(registryDeps: Registry) {
  const registry = new UnifiClientRegistry(quiet, {
    makeClient: () => fakeClient([SWITCH]),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
  })
  const read = connectionFromSettings({ host: 'ctl.local', apiKey: 'k' }, false)
  if (read === null) throw new Error('settings should parse')
  await registry.upsert(INT, 'Home UDM', read.connection, read.credentialsLocked)
  return buildUnifiAdoptionProvider({
    hasIntegration: (id) => registry.has(id),
    listIntegrations: () => registry.list(),
    integrationName: () => 'Home UDM',
    listAdopted: async () => [
      { id: 100, config: { system: UNIFI_SYSTEM, integrationId: INT, infraNativeId: 'sw1' } },
    ],
    adoptInfra: async () => ({ deviceId: 100, accessoryDeviceIds: [] }),
    adoptClient: async () => ({ deviceId: 0 }),
    childDeviceIds: registryDeps.childIds,
    removeDevice: async () => undefined,
    findDeviceConfig: registryDeps.config,
    logger: quiet,
  })
}

afterEach(() => {
  unifiControllers.clear()
  warn.mockClear()
})

describe('adoption list: port children of an adopted switch', () => {
  it('marks each port from its live device, and only while that device exists', async () => {
    const configs = new Map<number, Record<string, unknown>>([
      [101, { kind: 'port', portIdx: 1, infraNativeId: 'sw1' }],
      [102, { kind: 'sensor', metric: 'clients', infraNativeId: 'sw1' }],
    ])
    const provider = await providerWith({
      childIds: async () => [...configs.keys()],
      config: async (id) => configs.get(id) ?? null,
    })
    const page = await provider.listCandidates({ integrationId: INT, page: 1, pageSize: 50 })
    const parent = page.candidates.find((c) => c.childNativeId === 'infra:sw1')
    expect(parent?.adoptedDeviceId).toBe(100)
    const byId = new Map(parent?.children?.map((c) => [c.childNativeId, c]))
    expect(byId.get('infra:sw1:port-1')).toMatchObject({
      alreadyAdopted: true,
      adoptedDeviceId: 101,
    })
    // Port 2 has no live device: not adopted, never guessed from the parent.
    expect(byId.get('infra:sw1:port-2')).toMatchObject({
      alreadyAdopted: false,
      adoptedDeviceId: null,
    })
  })

  it('a failed read of the children leaves the ports not adopted and logs it', async () => {
    const provider = await providerWith({
      childIds: async () => {
        throw new Error('registry down')
      },
      config: async () => null,
    })
    const page = await provider.listCandidates({ integrationId: INT, page: 1, pageSize: 50 })
    const parent = page.candidates.find((c) => c.childNativeId === 'infra:sw1')
    expect(parent?.children?.every((c) => !c.alreadyAdopted)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('port devices'),
      expect.objectContaining({ tags: { deviceId: 100 } }),
    )
  })

  it('leaves an unadopted candidate untouched', () => {
    const candidate: DiscoveredChildDevice = {
      childNativeId: 'infra:sw9',
      name: 'x',
      type: DeviceType.Switch,
      status: 'online',
      alreadyAdopted: false,
      adoptedDeviceId: null,
      metadata: {},
    }
    expect(markPortChildren([candidate], new Map([[1, [{ id: 5, portIdx: 1 }]]]))).toEqual([
      candidate,
    ])
  })
})
