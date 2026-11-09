/**
 * The heat-pump device on a stub device context (the one boundary a spec fakes):
 * how it logs a missing reading, and what it reports when a write went out but the
 * refresh after it failed.
 */
import {
  type DeviceContext,
  DeviceType,
  type HeatPumpStatus,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HomeComHeatPumpDevice } from '../devices/homecom-heat-pump-device.js'
import type { HomeComApiClient, HomeComSystemSnapshot } from '../homecom-api-client.js'
import { homeComConnections } from '../homecom-gateway.js'
import type { HomeComHeatPumpReading } from '../homecom-heat-pump.js'

type Provider = Record<string, (input: Record<string, unknown>) => Promise<unknown>>

function rig() {
  const providers: Record<string, Provider> = {}
  let runtime: IDeviceRuntimeState | null = null
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn(
      (cap: { name: string; runtimeState?: unknown }, provider: Provider) => {
        providers[cap.name] = provider
        if (cap.runtimeState && runtime) {
          runtime.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    api: {},
    logger,
  } as unknown as DeviceContext
  return { ctx, providers, logger }
}

const holiday = {
  path: '/system/holidayMode',
  value: 'off',
  min: null,
  max: null,
  allowed: ['off', 'hm1'],
}
const READING: HomeComHeatPumpReading = {
  circuits: [],
  silent: null,
  away: null,
  additionalHeater: null,
  holiday,
  thermalW: 1000,
  electricalW: 300,
  compressorPct: null,
  supply: null,
  return: null,
  outdoor: null,
  thermalKwh: null,
  electricalKwh: null,
  pressureBar: null,
  starts: null,
}

function snapshot(heatPump: HomeComHeatPumpReading | undefined): HomeComSystemSnapshot {
  return {
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
  }
}

function connect(heatPump: HomeComHeatPumpReading | undefined, api: HomeComApiClient) {
  homeComConnections.set('int-1', {
    gatewayId: 'g1',
    client: api,
    snapshot: snapshot(heatPump),
    discoverables: [],
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
    expect(api.writeHeatPump).toHaveBeenCalledWith([{ path: '/system/holidayMode', value: 'hm1' }])
    const refreshFailed = logger.warn.mock.calls.find((c) =>
      String(c[0]).includes('refresh failed'),
    )
    expect(refreshFailed?.[1]).toMatchObject({ tags: { deviceId: 9 } })
    const slice = device.runtimeState.getCapState<HeatPumpStatus>('heat-pump-status')
    expect(slice?.power.thermalW).toBe(1000)
    homeComConnections.clear()
  })
})
