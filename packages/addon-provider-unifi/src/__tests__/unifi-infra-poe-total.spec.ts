/**
 * The PoE power an infra device delivers, on the device's own card: the sum of its PoE ports'
 * readings, unknown (never 0) when none reported, and no `power-meter` without a PoE port.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type PowerMeterStatus,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import { UnifiInfraDevice } from '../devices/unifi-infra-device.js'
import type { UnifiControllerClient, UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { buildDiscoveryCandidates } from '../unifi-discovery.js'
import { UnifiIntegrationManager } from '../unifi-integration-manager.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { infraPoeTotalStatus } from '../unifi-port-state.js'
import { infraSnapshot, port } from './unifi-fixtures.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function rig(registered: string[]): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  return {
    id: 11,
    stableId: 'unifi:u1:infra:d1',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Workload,
      name: 'sw',
      location: null,
      disabled: false,
      addonId: 'provider-unifi',
      metadata: {},
    },
    persistedConfig: { integrationId: 'u1', infraNativeId: 'd1' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      registered.push(cap.name)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: { deviceManager: { setIdentifiers: { mutate: async () => undefined } } },
    logger: quiet,
  } as unknown as DeviceContext
}

async function activate(snapshot: UnifiInfraSnapshot) {
  const client: UnifiControllerClient = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    listInfraDevices: async () => [snapshot],
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
  const manager = new UnifiIntegrationManager({
    id: 'u1',
    name: 'UniFi',
    connection: settingsToConnection({ host: 'console.example', apiKey: 'k' }),
    logger: quiet,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
    makeClient: () => client,
  })
  unifiControllers.set('u1', manager)
  await manager.start()
  const registered: string[] = []
  const device = new UnifiInfraDevice(rig(registered))
  await device.onActivate()
  return {
    registered,
    power: () => device.runtimeState.getCapState<PowerMeterStatus>('power-meter'),
    stop: () => manager.stop(),
  }
}

describe('infraPoeTotalStatus', () => {
  it('sums the reported ports; a port without a reading is unknown, not 0', () => {
    const ports = [
      port({ idx: 1, poePowerW: 3.5 }),
      port({ idx: 2, poePowerW: 2 }),
      port({ idx: 3, poePowerW: null }),
    ]
    expect(infraPoeTotalStatus(ports, 5)).toEqual({ power: 5.5, lastFetchedAt: 5 })
  })

  it('is absent when no port reported (D393)', () => {
    const status = infraPoeTotalStatus([port({ idx: 1 }), port({ idx: 2 })], 5)
    expect(status.power).toBeUndefined()
  })
})

describe('UnifiInfraDevice power-meter', () => {
  afterEach(() => unifiControllers.clear())

  it('serves the PoE total of a switch with PoE ports', async () => {
    const h = await activate(
      infraSnapshot({
        id: 'd1',
        kind: 'switch',
        ports: [port({ idx: 1, poePowerW: 3.5 }), port({ idx: 2, poePowerW: 2 }), port({ idx: 3 })],
      }),
    )
    expect(h.registered).toContain('power-meter')
    expect(h.power()?.power).toBe(5.5)
    await h.stop()
  })

  it('every port null: the total is unknown', async () => {
    const h = await activate(
      infraSnapshot({ id: 'd1', kind: 'switch', ports: [port({ idx: 1 }), port({ idx: 2 })] }),
    )
    expect(h.registered).toContain('power-meter')
    expect(h.power()?.power).toBeUndefined()
    await h.stop()
  })

  it('no PoE port: no power-meter', async () => {
    const h = await activate(
      infraSnapshot({
        id: 'd1',
        kind: 'access-point',
        ports: [port({ idx: 1, poeCapable: false })],
      }),
    )
    expect(h.registered).not.toContain('power-meter')
    await h.stop()
  })
})

describe('discovery hint', () => {
  it('a switch with a PoE port is proposed with power-meter; one without is not', () => {
    const build = (ports: ReturnType<typeof port>[]) =>
      buildDiscoveryCandidates({
        controllerName: 'c',
        controllerOnline: true,
        infra: [infraSnapshot({ id: 'd1', kind: 'switch', ports })],
        clients: [],
        adopted: new Map(),
      })[0]?.capabilities
    expect(build([port({ idx: 1 })])).toEqual(['power-meter'])
    expect(build([port({ idx: 1, poeCapable: false })])).toBeUndefined()
  })
})
