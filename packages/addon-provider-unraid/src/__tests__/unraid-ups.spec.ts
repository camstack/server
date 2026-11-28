/**
 * A UPS of an Unraid server is its own adoptable Sensor device (role `ups`): proposed by the
 * scan like the Host, mapped to `battery` + `power-meter`, its readings as accessory children.
 * Nothing the API did not report is ever 0.
 */
import {
  batteryCapability,
  deviceStateRefreshCapability,
  type DeviceConstructor,
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDevice,
  type IDeviceRuntimeState,
  type InitialDeviceMeta,
  type IScopedLogger,
  powerMeterCapability,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection, UNRAID_SYSTEM } from '../config.js'
import {
  UNRAID_MIN_REFRESH_INTERVAL_MS,
  unraidRefreshPolicy,
} from '../devices/unraid-state-refresh.js'
import { UnraidUpsDevice } from '../devices/unraid-ups-device.js'
import { UnraidProviderAddon } from '../addon.js'
import { mapUps } from '../unraid-client-live.js'
import { buildUnraidDeviceAdopter } from '../unraid-device-adopter.js'
import {
  buildUnraidCandidates,
  parseUnraidNativeId,
  UNRAID_INSTANCE_ID,
} from '../unraid-discovery.js'
import type { UnraidClientLike, UnraidSnapshot, UnraidUpsInfo } from '../unraid-client-contract.js'
import { UnraidIntegrationManager } from '../unraid-integration-manager.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { upsBatteryStatus, upsEntityDescriptors, upsPowerMeterStatus } from '../unraid-ups.js'

const INT = 'int-1'
const SERVER = '4b0175070bd2bdbc14112e80333b73341203a1e3197cc6c8a1b2c3d4e5f60718'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const ups = (over: Partial<UnraidUpsInfo> = {}): UnraidUpsInfo => ({
  id: `${SERVER}:apc1`,
  name: 'Rack UPS',
  model: 'Back-UPS 700',
  status: 'ONLINE',
  chargeLevel: 97,
  estimatedRuntimeS: 1800,
  batteryHealth: 'Good',
  inputVoltage: 231,
  outputVoltage: 230,
  loadPercent: 12,
  nominalPowerW: 390,
  currentPowerW: 47,
  ...over,
})

function snapshot(over: Partial<UnraidSnapshot> = {}): UnraidSnapshot {
  return {
    array: {
      state: 'STARTED',
      capacityKb: { total: 1000, used: 400, free: 600 },
      parityCheck: null,
      disks: [],
    },
    cpu: { percent: 1, tempC: null, powerW: null },
    disks: [],
    dockers: [],
    vms: [],
    ups: [ups()],
    notifications: { activeCount: 0, latest: null },
    ...over,
  }
}

describe('UPS mapping', () => {
  it('battery: charge and the charging source from the mains status', () => {
    expect(upsBatteryStatus(ups(), 5)).toMatchObject({
      level: 97,
      charging: 'dc',
      lastUpdated: 5,
    })
    expect(upsBatteryStatus(ups({ status: 'ONBATT' }), 5).charging).toBe('none')
    expect(upsBatteryStatus(ups({ status: null }), 5).charging).toBe('unknown')
    expect(upsBatteryStatus(ups({ chargeLevel: null }), 5).level).toBeNull()
  })

  it('power-meter: the power drawn; absent, never 0, when not reported', () => {
    expect(upsPowerMeterStatus(ups(), 5)).toEqual({
      power: 47,
      lastFetchedAt: 5,
    })
    const unknown = upsPowerMeterStatus(ups({ currentPowerW: null }), 5)
    expect('power' in unknown).toBe(false)
  })

  it('readings: status, runtime, health, load, voltages, nominal power, a null stays null', () => {
    const byKey = new Map(upsEntityDescriptors(ups({ inputVoltage: null })).map((d) => [d.key, d]))
    expect(byKey.get('ups_status')?.enumValue).toBe('ONLINE')
    expect(byKey.get('ups_runtime')?.numeric).toEqual({
      value: 1800,
      quantity: 'duration',
    })
    expect(byKey.get('ups_battery_health')?.enumValue).toBe('Good')
    expect(byKey.get('ups_load')?.numeric).toEqual({
      value: 12,
      quantity: 'percentage',
    })
    expect(byKey.get('ups_input_voltage')?.numeric).toEqual({
      value: null,
      quantity: 'voltage',
    })
    expect(byKey.get('ups_nominal_power')?.numeric).toEqual({
      value: 390,
      quantity: 'power',
    })
  })

  it('the live client maps the node-unraid UPS, an unreported number is null', () => {
    const mapped = mapUps({
      id: 'a:b',
      name: ' ',
      model: 'M',
      status: 'ONLINE',
      battery: { chargeLevel: 50, estimatedRuntime: 60, health: 'Good' },
      power: {
        inputVoltage: 1,
        outputVoltage: 2,
        loadPercentage: 3,
        nominalPower: null,
        currentPower: null,
      },
    })
    expect(mapped).toMatchObject({
      name: 'M',
      nominalPowerW: null,
      currentPowerW: null,
      estimatedRuntimeS: 60,
    })
  })
})

describe('UPS discovery and adoption', () => {
  const base = {
    server: { name: 'Tower', online: true },
    dockers: null,
    vms: null,
    adopted: new Map<string, number>(),
  }

  it('the scan proposes each UPS beside the Host, as a Sensor', () => {
    const out = buildUnraidCandidates({ ...base, ups: [ups()] })
    expect(out.map((c) => [c.childNativeId, c.type, c.name])).toEqual([
      [UNRAID_INSTANCE_ID, DeviceType.Workload, 'Tower'],
      ['ups:apc1', DeviceType.Sensor, 'Rack UPS'],
    ])
    expect(out[1]?.capabilities).toEqual([batteryCapability.name, powerMeterCapability.name])
  })

  it('no UPS, or an unread list, proposes nothing', () => {
    for (const list of [[], null, undefined] as const) {
      const out = buildUnraidCandidates({
        ...base,
        ...(list === undefined ? {} : { ups: list }),
      })
      expect(out.map((c) => c.childNativeId)).toEqual([UNRAID_INSTANCE_ID])
    }
  })

  it('parses the native id', () => {
    expect(parseUnraidNativeId('ups:apc1')).toEqual({
      kind: 'ups',
      localId: 'apc1',
    })
    expect(parseUnraidNativeId('ups:')).toBeNull()
  })

  it('adopting creates a top-level Sensor, role ups, with the fixed reading list', async () => {
    const created: {
      stableId: string
      cls: unknown
      config: Record<string, unknown>
      parent: unknown
      meta: InitialDeviceMeta | undefined
    }[] = []
    const devices = {
      create: async <T extends IDevice>(
        stableId: string,
        cls: DeviceConstructor<T>,
        config: Record<string, unknown>,
        parent?: number | null,
        meta?: InitialDeviceMeta,
      ): Promise<T> => {
        created.push({ stableId, cls, config, parent, meta })
        return Object.assign(Object.create(cls.prototype), { id: 7 })
      },
      getChildren: async () => [],
    }
    const adopter = buildUnraidDeviceAdopter({
      devices,
      getSnapshot: () => snapshot(),
    })
    await adopter.adoptUps({
      integrationId: INT,
      name: 'Rack UPS',
      nativeId: 'ups:apc1',
    })
    const [c] = created
    expect(c?.stableId).toBe(`unraid:${INT}:ups:apc1`)
    expect(c?.cls).toBe(UnraidUpsDevice)
    expect(c?.parent).toBeNull()
    expect(c?.meta).toMatchObject({
      type: DeviceType.Sensor,
      role: DeviceRole.Ups,
    })
    expect(c?.config).toMatchObject({
      upsLocalId: 'apc1',
      system: UNRAID_SYSTEM,
    })
    expect(Array.isArray(c?.config['entities']) && c?.config['entities'].length).toBe(7)
    await expect(
      adopter.adoptUps({ integrationId: INT, name: 'x', nativeId: 'ups:gone' }),
    ).rejects.toThrow(/no ups:gone/)
  })

  it('a restored Sensor row is rebuilt as a UPS only for the UPS stable id', () => {
    const addon = new UnraidProviderAddon()
    const classFor = (stableId: string): unknown =>
      Reflect.apply(Reflect.get(addon, 'deviceClassForRow'), addon, [
        { type: DeviceType.Sensor, stableId },
      ])
    expect(classFor(`unraid:${INT}:ups:apc1`)).toBe(UnraidUpsDevice)
    expect(classFor(`unraid:${INT}:ups:apc1:ups_load`)).not.toBe(UnraidUpsDevice)
  })
})

interface StatusProvider {
  getStatus(): Promise<unknown>
}

function isStatusProvider(value: unknown): value is StatusProvider {
  return typeof value === 'object' && value !== null && 'getStatus' in value
}

function statusOf(value: unknown): StatusProvider {
  if (!isStatusProvider(value)) throw new Error('cap not registered')
  return value
}

describe('UnraidUpsDevice', () => {
  afterEach(() => unraidInstances.clear())

  function rig(config: Record<string, unknown>) {
    const providers = new Map<string, unknown>()
    let runtime: IDeviceRuntimeState | null = null
    const ctx = {
      id: 60,
      stableId: `unraid:${INT}:ups:apc1`,
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Sensor,
        name: 'u',
        location: null,
        disabled: false,
        addonId: 'provider-unraid',
        metadata: {},
      },
      persistedConfig: config,
      initialRuntimeState: {},
      eventBus: {
        emit: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        getRecent: vi.fn(() => []),
      },
      persistConfig: vi.fn(async () => {}),
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtime = rs
      },
      registerNativeCap: vi.fn(
        (cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
          providers.set(cap.name, provider)
          if (cap.runtimeState && runtime) {
            runtime.installCapSchema(
              cap.name,
              cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
            )
          }
        },
      ),
      api: {},
      logger: quiet,
    } as unknown as DeviceContext
    return { ctx, providers }
  }

  async function liveManager(list: () => Promise<readonly UnraidUpsInfo[]>) {
    const done = async (): Promise<void> => undefined
    const client: UnraidClientLike = {
      connect: done,
      disconnect: done,
      array: {
        get: async () => snapshot().array,
        setState: done,
        parity: { start: done, cancel: done },
      },
      docker: {
        list: async () => [],
        start: done,
        stop: done,
        pause: done,
        unpause: done,
      },
      vms: {
        list: async () => [],
        start: done,
        stop: done,
        pause: done,
        resume: done,
        forceStop: done,
        reboot: done,
      },
      system: { cpu: async () => snapshot().cpu },
      notifications: { active: async () => snapshot().notifications },
      ups: { list },
    }
    const manager = new UnraidIntegrationManager({
      id: INT,
      name: 'Tower',
      connection: settingsToConnection({
        host: 'tower.example.com',
        apiKey: 'k',
      }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: () => client,
    })
    await manager.start()
    unraidInstances.set(INT, manager)
    return manager
  }

  const CONFIG = {
    nativeId: 'ups:apc1',
    integrationId: INT,
    upsLocalId: 'apc1',
    entities: [],
  }

  it('arms no timer; the core read (device-state-refresh) re-fetches the snapshot (D1062)', async () => {
    vi.useFakeTimers()
    try {
      const list = vi.fn(async () => [ups()])
      await liveManager(list)
      const { ctx, providers } = rig(CONFIG)
      const device = new UnraidUpsDevice(ctx)
      await device.onActivate()
      const calls = list.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(list.mock.calls.length).toBe(calls)
      const refresh = providers.get(deviceStateRefreshCapability.name) as {
        refresh: (i: object) => Promise<{ ok: boolean }>
      }
      await refresh.refresh({ deviceId: 60, deviceIds: [60], reason: 'schedule' })
      expect(list.mock.calls.length).toBe(calls + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('declares a batched polled policy', () => {
    expect(unraidRefreshPolicy(INT, 5000)).toEqual({
      integrationId: INT,
      minIntervalMs: UNRAID_MIN_REFRESH_INTERVAL_MS,
      intervalMs: 5000,
      batch: true,
      push: 'none',
    })
  })

  it('serves battery and power-meter from the polled UPS; a null power stays absent', async () => {
    let current = ups()
    const manager = await liveManager(async () => [current])
    const { ctx, providers } = rig(CONFIG)
    const device = new UnraidUpsDevice(ctx)
    await device.onActivate()
    const battery = statusOf(providers.get(batteryCapability.name))
    const power = statusOf(providers.get(powerMeterCapability.name))
    expect(await battery.getStatus()).toMatchObject({
      level: 97,
      charging: 'dc',
    })
    expect(await power.getStatus()).toMatchObject({ power: 47 })

    current = ups({ status: 'ONBATT', chargeLevel: 40, currentPowerW: null })
    await manager.poll()
    unraidInstances.emitSnapshot(INT)
    expect(await battery.getStatus()).toMatchObject({
      level: 40,
      charging: 'none',
    })
    expect(await power.getStatus()).not.toHaveProperty('power')
  })

  it('a UPS the server stops listing goes offline', async () => {
    let list: readonly UnraidUpsInfo[] = [ups()]
    const manager = await liveManager(async () => list)
    const device = new UnraidUpsDevice(rig(CONFIG).ctx)
    await device.onActivate()
    expect(device.online).toBe(true)
    list = []
    await manager.poll()
    unraidInstances.emitSnapshot(INT)
    expect(device.online).toBe(false)
  })
})
