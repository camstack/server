/**
 * D1062: the gateway is read by the core's scheduled refresh, not by a library timer.
 * The gateway device registers `device-state-refresh` (batch, the operator's poll interval
 * slows the floor), a refresh reaches the live facade's one-shot read, and the facade is
 * built with `pollIntervalMs: 0` so the library arms no timer of its own.
 */
import { Ecowitt } from '@apocaliss92/nodewitt'
import {
  type CapabilityDefinition,
  type DeviceContext,
  DeviceType,
  deviceStateRefreshCapability,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type StateRefreshPolicy,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToEcowittConfig } from '../config.js'
import {
  ECOWITT_GATEWAY_DEVICE_KIND,
  EcowittGatewayDevice,
} from '../devices/ecowitt-gateway-device.js'
import { ecowittConnections } from '../ecowitt-client-registry.js'
import { ecowittFacades } from '../ecowitt-gateway.js'
import { ecowittMacReader } from '../ecowitt-gateway-mac.js'
import { defaultEcowittFacadeFactory } from '../ecowitt-integration-manager.js'

const GATEWAY_ID = 'ecowitt:192-0-2-7'

interface Registration {
  readonly cap: CapabilityDefinition
  readonly provider: { refresh: (input: { reason: string }) => Promise<unknown> }
  readonly policy: StateRefreshPolicy | undefined
}

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function rig(
  registrations: Registration[],
  unregistered: string[] = [],
  logger: IScopedLogger = silentLogger(),
): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object and there is no typed fake of it; the spec supplies
  // only what the Gateway device reads (the same boundary as the identity spec).
  return {
    id: 21,
    stableId: 'ecowitt:192-0-2-7:gateway',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'GW2000A',
      location: null,
      disabled: false,
      addonId: 'provider-ecowitt',
      metadata: {},
    },
    persistedConfig: {
      kind: ECOWITT_GATEWAY_DEVICE_KIND,
      integrationId: 'e1',
      gatewayId: GATEWAY_ID,
    },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (
      cap: CapabilityDefinition,
      provider: Registration['provider'],
      options?: { stateRefresh?: StateRefreshPolicy },
    ) => {
      registrations.push({ cap, provider, policy: options?.stateRefresh })
      if (cap.runtimeState !== undefined && runtime !== null) {
        runtime.installCapSchema(cap.name, cap.runtimeState)
      }
    },
    unregisterNativeCap: (capName: string) => {
      unregistered.push(capName)
    },
    api: { deviceManager: { setIdentifiers: { mutate: vi.fn(async () => {}) } } },
    logger,
  } as unknown as DeviceContext
}

describe('Ecowitt device-state-refresh (D1062)', () => {
  afterEach(() => {
    ecowittConnections.clear()
    ecowittFacades.clear()
    ecowittMacReader.set(null)
    vi.restoreAllMocks()
  })

  it('the gateway registers one batch refresh, slowed by the operator poll interval', async () => {
    ecowittConnections.set(
      'e1',
      settingsToEcowittConfig({ transport: 'local', host: '192.0.2.7', pollIntervalMs: 90_000 }),
    )
    const registrations: Registration[] = []
    await new EcowittGatewayDevice(rig(registrations)).onActivate()
    const refresh = registrations.find((r) => r.cap === deviceStateRefreshCapability)
    expect(refresh?.policy).toEqual({
      integrationId: 'e1',
      minIntervalMs: 1_000,
      intervalMs: 90_000,
      batch: true,
      push: 'none',
    })
  })

  it('a settings change re-registers the policy with the new poll interval', async () => {
    const local = (pollIntervalMs: number) =>
      settingsToEcowittConfig({ transport: 'local', host: '192.0.2.7', pollIntervalMs })
    ecowittConnections.set('e1', local(90_000))
    const registrations: Registration[] = []
    const unregistered: string[] = []
    await new EcowittGatewayDevice(rig(registrations, unregistered)).onActivate()

    ecowittConnections.set('e1', local(300_000))

    const policies = registrations
      .filter((r) => r.cap === deviceStateRefreshCapability)
      .map((r) => r.policy?.intervalMs)
    expect(policies).toEqual([90_000, 300_000])
    expect(unregistered).toEqual([deviceStateRefreshCapability.name])
  })

  it('with no connection known it refreshes at the library default, not the 1 s floor, and says so', async () => {
    const registrations: Registration[] = []
    const logger = silentLogger()
    await new EcowittGatewayDevice(rig(registrations, [], logger)).onActivate()
    const refresh = registrations.find((r) => r.cap === deviceStateRefreshCapability)
    expect(refresh?.policy?.intervalMs).toBe(60_000)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('library default'),
      expect.objectContaining({ tags: { deviceId: 21 } }),
    )
  })

  it('a refresh reaches the live facade one-shot read, and fails loudly with no facade', async () => {
    const refreshFacade = vi.fn(async () => {})
    // Test boundary: only `refresh` of the nodewitt facade is read by the provider.
    ecowittFacades.set(GATEWAY_ID, { refresh: refreshFacade } as unknown as Ecowitt)
    const registrations: Registration[] = []
    await new EcowittGatewayDevice(rig(registrations)).onActivate()
    const refresh = registrations.find((r) => r.cap === deviceStateRefreshCapability)
    await refresh?.provider.refresh({ reason: 'schedule' })
    expect(refreshFacade).toHaveBeenCalledTimes(1)

    ecowittFacades.set(GATEWAY_ID, null)
    await expect(refresh?.provider.refresh({ reason: 'schedule' })).rejects.toThrow(/not connected/)
  })

  it('builds the local facade with no library poll timer (pollIntervalMs 0)', () => {
    const create = vi.spyOn(Ecowitt, 'createLocal')
    defaultEcowittFacadeFactory(
      settingsToEcowittConfig({ transport: 'local', host: '192.0.2.7', pollIntervalMs: 60_000 }),
    )
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMs: 0 }))
  })
})
