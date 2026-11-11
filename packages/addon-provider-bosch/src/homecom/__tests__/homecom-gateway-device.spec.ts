/**
 * The HomeCom gateway as a Gateway device, on a stub device context (the one boundary a spec
 * fakes): it registers no action the cloud account cannot perform, and follows the session.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeComGatewayDevice } from '../devices/homecom-gateway-device.js'
import {
  buildDiscoverables,
  HOMECOM_GATEWAY_NATIVE_ID,
  homeComConnections,
} from '../homecom-gateway.js'
import { buildHomeComCandidates } from '../homecom-discovery.js'
import { planHomeComAdoption } from '../homecom-adoption-plan.js'
import {
  createInMemoryHomeComApiClient,
  type HomeComSystemSnapshot,
} from '../homecom-api-client.js'

function rig(): { readonly ctx: DeviceContext; readonly registered: string[] } {
  const registered: string[] = []
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 9,
    stableId: `homecom:int-1:${HOMECOM_GATEWAY_NATIVE_ID}`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Casa',
      location: null,
      disabled: false,
      addonId: 'bosch-homecom',
      metadata: {},
    },
    persistedConfig: {
      nativeId: HOMECOM_GATEWAY_NATIVE_ID,
      brokerId: 'int-1',
      system: 'homecom',
      integrationId: 'int-1',
    },
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
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      registered.push(cap.name)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  return { ctx, registered }
}

const SNAPSHOT: HomeComSystemSnapshot = {
  gateway: { gatewayId: '102311222', name: 'Casa', model: 'k40' },
  circuits: [
    {
      id: 'hc1',
      name: 'Heating circuit 1',
      operationMode: 'manual',
      setpoint: 21,
      currentRoomTemp: 20,
      minTemp: 5,
      maxTemp: 30,
    },
  ],
  dhw: null,
  deviceType: 'k40',
  family: 'hydronic',
}

afterEach(() => homeComConnections.clear())

describe('HomeComGatewayDevice', () => {
  it('is a Gateway that registers no action the account cannot perform', async () => {
    const { ctx, registered } = rig()
    const device = new HomeComGatewayDevice(ctx)
    await device.onActivate()
    expect(device.type).toBe(DeviceType.Gateway)
    expect(registered).not.toContain('reboot')
    expect(registered).not.toContain('device-admin-link')
    expect(registered).not.toContain('device-update')
  })

  it('starts online only while the integration has a live connection', () => {
    expect(new HomeComGatewayDevice(rig().ctx).online).toBe(false)
    homeComConnections.set('int-1', {
      gatewayId: '102311222',
      client: createInMemoryHomeComApiClient({ snapshot: SNAPSHOT }),
      snapshot: SNAPSHOT,
      discoverables: buildDiscoverables(SNAPSHOT),
    })
    expect(new HomeComGatewayDevice(rig().ctx).online).toBe(true)
  })
})

describe('the HomeCom gateway as an adoption pick', () => {
  it('is offered first, as a Gateway sibling of the circuits, never their parent', () => {
    const picks = buildDiscoverables(SNAPSHOT)
    expect(picks.map((p) => [p.nativeId, p.kind])).toEqual([
      [HOMECOM_GATEWAY_NATIVE_ID, 'gateway'],
      ['hc:hc1', 'heating-circuit'],
    ])
    const candidates = buildHomeComCandidates({
      devices: picks,
      adopted: new Map(),
    })
    expect(candidates[0]).toMatchObject({
      childNativeId: HOMECOM_GATEWAY_NATIVE_ID,
      name: 'Casa',
      type: DeviceType.Gateway,
      capabilities: [],
    })
    const gateway = picks[0]
    if (gateway === undefined) throw new Error('expected the gateway pick')
    expect(planHomeComAdoption(gateway, 'int-1', []).create.map((c) => c.nativeId)).toEqual([
      HOMECOM_GATEWAY_NATIVE_ID,
    ])
  })

  it('is offered next to the heat pump, which still creates its circuits as children', () => {
    const picks = buildDiscoverables({
      ...SNAPSHOT,
      heatPump: {
        circuits: [],
        heatPumpType: 'air_water',
        silent: null,
        away: null,
        additionalHeater: null,
        holiday: null,
        compressorPct: null,
        supply: null,
        return: null,
        outdoor: null,
        thermalKwh: null,
        electricalKwh: null,
        pressureBar: null,
        starts: null,
      },
    })
    expect(picks.map((p) => p.nativeId)).toEqual([HOMECOM_GATEWAY_NATIVE_ID, 'hp:0'])
    expect(picks[1]?.children?.map((c) => c.nativeId)).toEqual(['hc:hc1'])
  })
})
