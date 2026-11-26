/**
 * The heat-pump device on a stub device context (the one boundary a spec fakes):
 * how it logs a missing reading, and what it reports when a write went out but the
 * refresh after it failed.
 */
import {
  type DeviceContext,
  DeviceType,
  type ErrorStatus,
  type HeatPumpStatus,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HomeComHeatPumpDevice } from '../devices/homecom-heat-pump-device.js'
import type { HomeComApiClient, HomeComSystemSnapshot } from '../homecom-api-client.js'
import { homeComConnections } from '../homecom-gateway.js'
import type { HomeComBridgeReading } from '../homecom-bridge.js'
import { k40Reading, setting } from './homecom-bridge-fixture.js'
import { heatPumpReadingFrom, type HomeComHeatPumpReading } from '../homecom-heat-pump.js'

type Provider = Record<string, (input: Record<string, unknown>) => Promise<unknown>>

function rig(api: unknown = {}) {
  const providers: Record<string, Provider> = {}
  const refreshPolicies: unknown[] = []
  let runtime: IDeviceRuntimeState | null = null
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 9,
    stableId: 'bosch-homecom:int-1:heat-pump',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.HeatPump,
      name: 'Heat pump',
      location: null,
      disabled: false,
      addonId: 'bosch-homecom',
      metadata: {},
    },
    persistedConfig: { nativeId: 'hp:0', brokerId: 'int-1', system: 'homecom' },
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
      (
        cap: { name: string; runtimeState?: unknown },
        provider: Provider,
        options?: { stateRefresh?: unknown },
      ) => {
        providers[cap.name] = provider
        if (options?.stateRefresh !== undefined) refreshPolicies.push(options.stateRefresh)
        if (cap.runtimeState && runtime) {
          runtime.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    api,
    logger,
  } as unknown as DeviceContext
  return { ctx, providers, logger, refreshPolicies }
}

const holiday = {
  value: 'off',
  min: null,
  max: null,
  allowed: ['off', 'hm1'],
  writeable: true,
  step: null,
}
const READING: HomeComHeatPumpReading = {
  circuits: [],
  heatPumpType: 'air_water',
  heatSourceRefused: false,
  silent: null,
  away: null,
  additionalHeater: null,
  holiday,
  compressorPct: 55,
  supply: null,
  return: null,
  outdoor: null,
  thermalKwh: null,
  electricalKwh: null,
  pressureBar: null,
  starts: null,
  workingTimeS: null,
  heatDemand: null,
  compressorRunning: null,
  faults: [],
}

function snapshot(
  heatPump: HomeComHeatPumpReading | undefined,
  bridge?: HomeComBridgeReading,
): HomeComSystemSnapshot {
  return {
    ...(bridge === undefined ? {} : { bridge }),
    gateway: { gatewayId: 'g1', name: 'K40', model: 'K40' },
    circuits: [],
    dhw: null,
    ...(heatPump === undefined ? {} : { heatPump }),
  }
}

function client(fetchSystem: HomeComApiClient['fetchSystem']): HomeComApiClient {
  const unused = async () => {
    throw new Error('not used')
  }
  return {
    refreshTokens: unused,
    listGateways: unused,
    fetchSystem,
    probeGateway: unused,
    setCircuitSetpoint: unused,
    setCircuitMode: unused,
    setDhwTarget: unused,
    setDhwMode: unused,
    setFanMode: unused,
    setSwingVertical: unused,
    setSwingHorizontal: unused,
    writeHeatPump: vi.fn(async () => {}),
    readResource: vi.fn(async () => ({ status: 404, body: null })),
  }
}

function connect(
  heatPump: HomeComHeatPumpReading | undefined,
  api: HomeComApiClient,
  bridge?: HomeComBridgeReading,
) {
  homeComConnections.set('int-1', {
    gatewayId: 'g1',
    client: api,
    snapshot: snapshot(heatPump, bridge),
    discoverables: [],
    refresh: async () => {
      homeComConnections.updateSnapshot('int-1', await api.fetchSystem())
    },
  })
}

describe('HomeComHeatPumpDevice', () => {
  it('warns once on the way into "no reading" and says so once on the way out', async () => {
    const { ctx, providers, logger } = rig()
    connect(
      undefined,
      client(async () => snapshot(undefined)),
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    const status = providers['heat-pump-status']
    await status?.['getStatus']?.({})
    await status?.['getStatus']?.({})
    const noReading = logger.warn.mock.calls.filter((c) => String(c[0]).includes('no heat-pump'))
    expect(noReading).toHaveLength(1)
    expect(noReading[0]?.[1]).toEqual({ tags: { deviceId: 9 } })
    connect(
      READING,
      client(async () => snapshot(READING)),
    )
    await status?.['getStatus']?.({})
    await status?.['getStatus']?.({})
    expect(logger.info.mock.calls.filter((c) => String(c[0]).includes('again'))).toHaveLength(1)
    homeComConnections.clear()
  })

  it('reports the write as sent and the refresh as failed when only the refresh throws', async () => {
    const { ctx, providers, logger } = rig()
    const api = client(async () => {
      throw new Error('gateway timeout')
    })
    connect(READING, api)
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    const control = providers['heat-pump-control']
    await expect(control?.['setHolidayMode']?.({ mode: 'hm1' })).resolves.toBeUndefined()
    expect(api.writeHeatPump).toHaveBeenCalledWith([{ op: 'holidayMode', value: 'hm1' }])
    const refreshFailed = logger.warn.mock.calls.find((c) =>
      String(c[0]).includes('refresh failed'),
    )
    expect(refreshFailed?.[1]).toMatchObject({ tags: { deviceId: 9 } })
    const slice = device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')
    expect(slice?.power.compressorPct).toBe(55)
    homeComConnections.clear()
  })

  it('declares the batched polled policy, and a refresh re-reads the gateway and moves the slice (D1062)', async () => {
    const { ctx, providers, refreshPolicies } = rig()
    const fetchSystem = vi.fn(async () => snapshot({ ...READING, compressorPct: 77 }))
    connect(READING, client(fetchSystem))
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    expect(refreshPolicies).toEqual([
      { integrationId: 'int-1', minIntervalMs: 60_000, batch: true, push: 'none' },
    ])
    expect(
      device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')?.power.compressorPct,
    ).toBe(55)
    await providers['device-state-refresh']?.['refresh']?.({})
    expect(fetchSystem).toHaveBeenCalledTimes(1)
    expect(
      device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')?.power.compressorPct,
    ).toBe(77)
    await device.removeDevice()
    homeComConnections.clear()
  })

  it('a refresh of an integration that is not connected fails, never a silent success', async () => {
    const { ctx, providers } = rig()
    connect(
      READING,
      client(async () => snapshot(READING)),
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    homeComConnections.clear()
    await expect(providers['device-state-refresh']?.['refresh']?.({})).rejects.toThrow(
      /not connected/,
    )
  })
  it('publishes the gateway notifications on the error cap, unknown when they were not read', async () => {
    const { ctx } = rig()
    const raised: HomeComHeatPumpReading = {
      ...READING,
      faults: [{ code: 'A11-1010', active: true, severity: 'error' }],
    }
    connect(
      { ...READING, faults: null },
      client(async () => snapshot(raised)),
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    expect(device.runtimeState.getCapState<ErrorStatus>('error')?.active).toBeNull()
    homeComConnections.updateSnapshot('int-1', snapshot(raised))
    await Promise.resolve()
    expect(device.runtimeState.getCapState<ErrorStatus>('error')).toMatchObject({
      active: true,
      code: 'A11-1010',
    })
    homeComConnections.clear()
  })

  it('keeps a raised fault when the next read has no notifications (unread never clears, D49)', async () => {
    const { ctx } = rig()
    const raised: HomeComHeatPumpReading = {
      ...READING,
      faults: [{ code: 'A11-1010', active: true, severity: 'error' }],
    }
    connect(
      raised,
      client(async () => snapshot(raised)),
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    await Promise.resolve()
    expect(device.runtimeState.getCapState<ErrorStatus>('error')?.active).toBe(true)
    homeComConnections.updateSnapshot('int-1', snapshot({ ...READING, faults: null }))
    await Promise.resolve()
    expect(device.runtimeState.getCapState<ErrorStatus>('error')).toMatchObject({
      active: true,
      code: 'A11-1010',
    })
    homeComConnections.updateSnapshot('int-1', snapshot({ ...READING, faults: [] }))
    await Promise.resolve()
    expect(device.runtimeState.getCapState<ErrorStatus>('error')?.active).toBe(false)
    homeComConnections.clear()
  })

  it('logs the blind extra-hot-water start, with the device tag, when the charge was not read', async () => {
    const { ctx, providers, logger } = rig()
    const noCharge: HomeComHeatPumpReading = {
      ...READING,
      circuits: [
        {
          id: 'dhw1',
          kind: 'dhw',
          currentTemp: null,
          targetTemp: null,
          operationMode: null,
          heatCoolMode: null,
          summerWinter: null,
          comfort: null,
          eco: null,
          maxFlow: null,
          level: null,
          chargeDuration: null,
          charge: null,
          controlType: null,
          levels: null,
          tankBottomTemp: null,
          maxCylinderTemp: null,
          yieldKwh: null,
        },
      ],
    }
    const api = client(async () => snapshot(noCharge))
    connect(noCharge, api)
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    await providers['heat-pump-control']?.['startExtraHotWater']?.({ circuitId: 'dhw1' })
    expect(api.writeHeatPump).toHaveBeenCalledWith([
      { op: 'dhwCharge', circuitId: 'dhw1', value: 'start' },
    ])
    const blind = logger.info.mock.calls.find((c) => String(c[0]).includes('sent blind'))
    expect(blind?.[1]).toMatchObject({ tags: { deviceId: 9 } })
    homeComConnections.clear()
  })

  it('names the registry child of each circuit, and says once when the lookup fails', async () => {
    const getChildren = {
      query: vi.fn(async () => [
        { id: 5631, name: 'Living room', type: DeviceType.Climate, config: { circuitId: 'hc1' } },
        { id: 5633, name: 'Boiler', type: DeviceType.WaterHeater, config: {} },
      ]),
    }
    const { ctx, providers } = rig({ deviceManager: { getChildren } })
    const bridge = k40Reading()
    const withCircuits = { ...READING, circuits: heatPumpReadingFrom(bridge).circuits }
    connect(
      withCircuits,
      client(async () => snapshot(withCircuits, bridge)),
      bridge,
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    await providers['heat-pump-status']?.['getStatus']?.({})
    await vi.waitFor(() => {
      const slice = device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')
      expect(slice?.circuits.map((c) => [c.id, c.deviceId, c.label])).toEqual([
        ['hc1', 5631, 'Living room'],
        ['dhw1', 5633, 'Boiler'],
      ])
    })
    expect(getChildren.query).toHaveBeenCalledWith({ parentDeviceId: 9 })
    await device.removeDevice()
    homeComConnections.clear()
  })

  it('keeps the circuits without a device id, and logs it with the device tag, when the children cannot be listed', async () => {
    const { ctx, logger } = rig({})
    const bridge = k40Reading()
    const withCircuits = { ...READING, circuits: heatPumpReadingFrom(bridge).circuits }
    connect(
      withCircuits,
      client(async () => snapshot(withCircuits, bridge)),
      bridge,
    )
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    await vi.waitFor(() => {
      const failed = logger.warn.mock.calls.filter((c) => String(c[0]).includes('children'))
      expect(failed).toHaveLength(1)
      expect(failed[0]?.[1]).toMatchObject({ tags: { deviceId: 9 } })
    })
    const slice = device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')
    expect(slice?.circuits.every((c) => c.deviceId === null)).toBe(true)
    await device.removeDevice()
    homeComConnections.clear()
  })

  it('writes the new controls through the checked builders and the shared setpoint write', async () => {
    const { ctx, providers } = rig()
    const base = k40Reading()
    const bridge: HomeComBridgeReading = {
      ...base,
      heatingCircuits: base.heatingCircuits.map((c) => ({
        ...c,
        controlType: setting('wdcoptimized', {
          allowed: ['wdcoptimized', 'ISRC'],
          writeable: true,
        }),
      })),
    }
    const hp = { ...READING, circuits: heatPumpReadingFrom(bridge).circuits }
    const api = client(async () => snapshot(hp, bridge))
    connect(hp, api, bridge)
    const device = new HomeComHeatPumpDevice(ctx)
    await device.onActivate()
    const control = providers['heat-pump-control']
    await control?.['setCircuitControlType']?.({ circuitId: 'hc1', controlType: 'ISRC' })
    await control?.['setCircuitTargetTemp']?.({ circuitId: 'hc1', temp: 21 })
    await control?.['setDhwLevelTemp']?.({ circuitId: 'dhw1', level: 'eco', temp: 55 })
    expect(api.writeHeatPump).toHaveBeenNthCalledWith(1, [
      { op: 'hcControlType', circuitId: 'hc1', value: 'ISRC' },
    ])
    expect(api.writeHeatPump).toHaveBeenNthCalledWith(2, [
      { op: 'hcManualRoomSetpoint', circuitId: 'hc1', value: 21 },
    ])
    expect(api.writeHeatPump).toHaveBeenNthCalledWith(3, [
      { op: 'dhwLevelTemp', circuitId: 'dhw1', level: 'eco', value: 55 },
    ])
    await expect(
      control?.['setCircuitTargetTemp']?.({ circuitId: 'hc1', temp: 99 }),
    ).rejects.toThrow(/outside/)
    await expect(
      control?.['setDhwLevelTemp']?.({ circuitId: 'dhw1', level: 'eco', temp: 99 }),
    ).rejects.toThrow(/outside/)
    homeComConnections.clear()
  })
})
