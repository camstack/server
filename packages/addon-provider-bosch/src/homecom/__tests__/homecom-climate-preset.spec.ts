/**
 * planning#741 A5: a heating circuit offers the gateway's away mode as the `away` preset
 * (`none` otherwise), and setting a preset writes awayMode on/off through the heat-pump write path.
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
import { k40Reading } from './homecom-bridge-fixture.js'

type Provider = Record<string, (input: Record<string, unknown>) => Promise<unknown>>

function rig(circuitId = 'hc1') {
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
      nativeId: `hc:${circuitId}`,
      brokerId: 'int-1',
      circuitId,
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

function snapshotOf(away: boolean, awayValue = 'off'): HomeComSystemSnapshot {
  const reading = k40Reading()
  const [hc1] = reading.heatingCircuits
  const circuits = hc1 === undefined ? [] : [hc1, { ...hc1, id: 'hc2' }]
  const answered =
    reading.system.away === null ? null : { ...reading.system.away, value: awayValue }
  return bridgeSnapshot({
    gatewayId: 'g1',
    deviceType: 'k40',
    reading: {
      ...reading,
      heatingCircuits: circuits,
      system: { ...reading.system, away: away ? answered : null },
    },
    logDrop: () => {},
    logTransientProbe: () => {},
  })
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

describe('HomeCom heating circuit presets (planning#741 A5)', () => {
  it('offers none and away when the gateway answers its away mode', async () => {
    const { ctx } = rig()
    connect(
      snapshotOf(true),
      vi.fn(async () => {}),
    )
    const device = new HomeComClimateDevice(ctx)
    await device.onActivate()
    const slice = device.runtimeState.getCapState<ClimateControlStatus>('climate-control')
    expect(slice?.availablePresets).toEqual(['none', 'away'])
    expect(slice?.preset).toBe('none')
    homeComConnections.clear()
  })

  it('offers no preset when the gateway does not answer its away mode', async () => {
    const { ctx } = rig()
    connect(
      snapshotOf(false),
      vi.fn(async () => {}),
    )
    const device = new HomeComClimateDevice(ctx)
    await device.onActivate()
    const slice = device.runtimeState.getCapState<ClimateControlStatus>('climate-control')
    expect(slice?.availablePresets).toEqual([])
    homeComConnections.clear()
  })

  it('away is gateway-wide: a preset set on one circuit shows on the other', async () => {
    const first = rig('hc1')
    const second = rig('hc2')
    const writeHeatPump = vi.fn(async () => {})
    connect(snapshotOf(true, 'off'), writeHeatPump, snapshotOf(true, 'on'))
    const a = new HomeComClimateDevice(first.ctx)
    const b = new HomeComClimateDevice(second.ctx)
    await a.onActivate()
    await b.onActivate()
    const presetOf = (d: HomeComClimateDevice) =>
      d.runtimeState.getCapState<ClimateControlStatus>('climate-control')?.preset
    expect([presetOf(a), presetOf(b)]).toEqual(['none', 'none'])
    await first.providers['climate-control']?.['setPreset']?.({ preset: 'away' })
    expect(writeHeatPump).toHaveBeenCalledTimes(1)
    expect([presetOf(a), presetOf(b)]).toEqual(['away', 'away'])
    homeComConnections.clear()
  })

  it('writes awayMode on and off through the heat-pump write path', async () => {
    const { ctx, providers } = rig()
    const writeHeatPump = vi.fn(async () => {})
    connect(snapshotOf(true), writeHeatPump)
    const device = new HomeComClimateDevice(ctx)
    await device.onActivate()
    await providers['climate-control']?.['setPreset']?.({ preset: 'away' })
    await providers['climate-control']?.['setPreset']?.({ preset: 'none' })
    expect(writeHeatPump.mock.calls).toEqual([
      [[{ op: 'awayMode', value: 'on' }]],
      [[{ op: 'awayMode', value: 'off' }]],
    ])
    await expect(providers['climate-control']?.['setPreset']?.({ preset: 'eco' })).rejects.toThrow(
      /preset/,
    )
    homeComConnections.clear()
  })
})
