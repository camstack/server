/**
 * planning#741 B-zone: the zone child is a climate device over a bridge zone; its mode and
 * temperature go out through the heat-pump write path, checked against the zone's own limits.
 */
import {
  type ClimateControlStatus,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HomeComClimateDevice } from '../devices/homecom-climate-device.js'
import type { HomeComApiClient, HomeComSystemSnapshot } from '../homecom-api-client.js'
import { bridgeSnapshot } from '../homecom-bridge-snapshot.js'
import { homeComConnections } from '../homecom-gateway.js'
import type { HomeComBridgeZone } from '../homecom-bridge.js'
import { k40Reading, setting } from './homecom-bridge-fixture.js'

type Provider = Record<string, (input: Record<string, unknown>) => Promise<unknown>>

function rig(zoneId = 'zn1') {
  const providers: Record<string, Provider> = {}
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 11,
    stableId: 'bosch-homecom:int-1:hc1',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Climate,
      name: 'Heating circuit 1',
      location: null,
      disabled: false,
      addonId: 'bosch-homecom',
      metadata: {},
    },
    persistedConfig: {
      nativeId: `zone:${zoneId}`,
      brokerId: 'int-1',
      zoneId,
      system: 'homecom',
    },
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
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  return { ctx, providers }
}

function connect(
  snapshot: HomeComSystemSnapshot,
  writeHeatPump: HomeComApiClient['writeHeatPump'],
  afterWrite: HomeComSystemSnapshot = snapshot,
) {
  const unused = async () => {
    throw new Error('not used')
  }
  const client: HomeComApiClient = {
    refreshTokens: unused,
    listGateways: unused,
    fetchSystem: async () => afterWrite,
    probeGateway: unused,
    setCircuitSetpoint: unused,
    setCircuitMode: unused,
    setDhwTarget: unused,
    setDhwMode: unused,
    setFanMode: unused,
    setSwingVertical: unused,
    setSwingHorizontal: unused,
    writeHeatPump,
    readResource: async () => ({ status: 404, body: null }),
  }
  homeComConnections.set('int-1', {
    gatewayId: 'g1',
    client,
    snapshot,
    discoverables: [],
  })
}

const ZONE: HomeComBridgeZone = {
  id: 'zn1',
  userMode: setting('manual', { allowed: ['manual', 'clock'], writeable: true }),
  setpointTemp: 21,
  currentTemp: 20.5,
  manualTemp: setting(21, { min: 5, max: 30, writeable: true }),
}

function snapshotWith(zone: HomeComBridgeZone): HomeComSystemSnapshot {
  return bridgeSnapshot({
    gatewayId: 'g1',
    deviceType: 'k40',
    reading: { ...k40Reading(), zones: [zone] },
    logDrop: () => {},
    logTransientProbe: () => {},
  })
}

describe('HomeCom zone climate child (planning#741 B-zone)', () => {
  it('shows the zone as a climate slice and writes its mode and temperature', async () => {
    const { ctx, providers } = rig()
    const writeHeatPump = vi.fn(async () => {})
    connect(snapshotWith(ZONE), writeHeatPump)
    const device = new HomeComClimateDevice(ctx)
    await device.onActivate()
    expect(device.runtimeState.getCapState<ClimateControlStatus>('climate-control')).toMatchObject({
      mode: 'heat',
      target: 21,
      currentTemp: 20.5,
      minTemp: 5,
      maxTemp: 30,
    })
    await providers['climate-control']?.['setTarget']?.({ target: 23 })
    await providers['climate-control']?.['setMode']?.({ mode: 'auto' })
    expect(writeHeatPump).toHaveBeenNthCalledWith(1, [
      { op: 'zoneManualTemp', circuitId: 'zn1', value: 23 },
    ])
    expect(writeHeatPump).toHaveBeenNthCalledWith(2, [
      { op: 'zoneUserMode', circuitId: 'zn1', value: 'clock' },
    ])
    await expect(providers['climate-control']?.['setTarget']?.({ target: 99 })).rejects.toThrow(
      /outside/,
    )
    await expect(providers['climate-control']?.['setFanMode']?.({ fanMode: 'x' })).rejects.toThrow(
      /not supported/,
    )
    homeComConnections.clear()
  })

  it('publishes no slice, so the mode reads unknown, when the gateway refused the zone mode', async () => {
    const { ctx } = rig()
    connect(
      snapshotWith({ ...ZONE, userMode: null, setpointTemp: null, manualTemp: null }),
      vi.fn(async () => {}),
    )
    const device = new HomeComClimateDevice(ctx)
    await device.onActivate()
    expect(
      device.runtimeState.getCapState<ClimateControlStatus>('climate-control')?.lastFetchedAt,
    ).toBe(0)
    homeComConnections.clear()
  })
})
