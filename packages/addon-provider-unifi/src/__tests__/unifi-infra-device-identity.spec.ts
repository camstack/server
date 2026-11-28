/**
 * D1059 through the device class: a UniFi infra device declares the identity of
 * its live snapshot on activation and on every poll, and a controller read that
 * failed keeps what is stored (D49).
 */
import {
  type DeviceContext,
  type DeviceIdentifiers,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import { UnifiInfraDevice } from '../devices/unifi-infra-device.js'
import type { UnifiControllerClient } from '../unifi-client-contract.js'
import { UnifiIntegrationManager } from '../unifi-integration-manager.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { infraSnapshot } from './unifi-fixtures.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function rig(config: Record<string, unknown>, setIdentifiers: object): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  return {
    id: 11,
    stableId: 'unifi:u1:infra:d1',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Container,
      name: 'sw',
      location: null,
      disabled: false,
      addonId: 'provider-unifi',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: { deviceManager: { setIdentifiers } },
    logger: quiet,
  } as unknown as DeviceContext
}

describe('UnifiInfraDevice declares its identity (D1059)', () => {
  afterEach(() => unifiControllers.clear())

  it('on activation and per poll; a failed controller read keeps the stored values', async () => {
    let reachable = true
    const client: UnifiControllerClient = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      listInfraDevices: async () => {
        if (!reachable) throw new Error('connect ECONNREFUSED')
        return [
          infraSnapshot({ id: 'd1', mac: 'f0:9f:c2:00:00:01', serial: null, ip: '192.0.2.10' }),
        ]
      },
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

    const world: { stored: DeviceIdentifiers | null } = { stored: null }
    const setIdentifiers = {
      mutate: async (input: SetIdentifiersInput) => {
        world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
      },
    }
    const device = new UnifiInfraDevice(
      rig({ integrationId: 'u1', infraNativeId: 'd1' }, setIdentifiers),
    )
    await device.onActivate()
    await vi.waitFor(() => expect(world.stored?.mac?.[0]?.value).toBe('f0:9f:c2:00:00:01'))
    expect(world.stored?.ip?.value).toBe('192.0.2.10')

    reachable = false
    await manager.poll()
    unifiControllers.emitSnapshot('u1')
    await new Promise((r) => setTimeout(r, 0))
    expect(world.stored?.mac?.[0]?.value).toBe('f0:9f:c2:00:00:01')
    expect(world.stored?.ip?.value).toBe('192.0.2.10')
    await manager.stop()
  })
})
