import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZigbeeDevice } from '../z2m-device.js'
import { planZ2mDevice } from '../z2m-exposes.js'
import { ZigbeeGatewayDevice } from '../z2m-gateway-device.js'
import { z2mHub } from '../z2m-hub.js'
import { ZigbeeUpdateDevice } from '../z2m-update-device.js'
import {
  bridgeDevicesPayload,
  bridgeInfoPayload,
  contactSensorExposes,
} from './fixtures/z2m-fixtures.js'
import { FakeNet, ManualTimers, recordingLogger } from './fakes.js'

const INTEGRATION = 'z2m-1'
const DOOR = '0x00158d0001a2b3c4'
const COORD = '0x00124b0000000000'

interface Built {
  readonly ctx: DeviceContext
  readonly providers: Map<string, Record<string, (...args: never[]) => Promise<unknown>>>
  readonly slice: (cap: string) => unknown
}

/** The cast is the documented test boundary: the real DeviceContext is the kernel's. */
function build(id: number, type: DeviceType, persistedConfig: Record<string, unknown>): Built {
  let runtime: IDeviceRuntimeState | null = null
  const providers: Built['providers'] = new Map()
  const ctx = {
    id,
    stableId: `provider-zigbee-z2m:${INTEGRATION}:${String(persistedConfig['equipment'])}`,
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'T',
      location: null,
      disabled: false,
      addonId: 'provider-zigbee-z2m',
      metadata: {},
      role: 'sensor',
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: never) => {
      providers.set(cap.name, provider)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
        setRole: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  return {
    ctx,
    providers,
    slice: (cap) => {
      if (runtime === null) throw new Error('runtime state not bound')
      return runtime.getCapState(cap)
    },
  }
}

function openServer(): FakeNet {
  const net = new FakeNet()
  z2mHub.connect(
    INTEGRATION,
    { host: 'z2m.lan', port: 8080, tls: false, token: null },
    recordingLogger(),
    {
      factory: net.factory,
      timers: new ManualTimers(),
    },
  )
  net.last.open()
  net.last.push('bridge/state', { state: 'online' })
  net.last.push('bridge/info', bridgeInfoPayload)
  net.last.push('bridge/devices', bridgeDevicesPayload)
  return net
}

afterEach(() => z2mHub.disconnectAll())

describe('device-mesh registration', () => {
  it('a Zigbee device registers device-mesh and answers as the node it is', async () => {
    openServer()
    const b = build(11, DeviceType.Sensor, {
      equipment: DOOR,
      integrationId: INTEGRATION,
      plan: planZ2mDevice(contactSensorExposes),
    })
    const device = new ZigbeeDevice(b.ctx)
    await device.onActivate()
    const mesh = b.providers.get('device-mesh')
    expect(mesh).toBeDefined()
    const topology = (await mesh?.['getTopology']?.({ deviceId: 11 } as never)) as {
      nodes: Array<{ nodeKey: string; deviceId: number | null }>
    }
    expect(topology.nodes.find((n) => n.nodeKey === DOOR)?.deviceId).toBe(11)
  })

  it('the Gateway registers device-mesh and binds the coordinator ieee from bridge/info', async () => {
    openServer()
    const b = build(5, DeviceType.Gateway, { equipment: 'gateway', integrationId: INTEGRATION })
    const gateway = new ZigbeeGatewayDevice(b.ctx)
    await gateway.onActivate()
    expect(b.providers.has('device-mesh')).toBe(true)
    expect(z2mHub.deviceIdOf(INTEGRATION, COORD)).toBe(5)
  })
})

describe('Update device', () => {
  const equipment = `${DOOR}#update`

  async function update(net: () => FakeNet) {
    const b = build(21, DeviceType.Update, { equipment, integrationId: INTEGRATION })
    const device = new ZigbeeUpdateDevice(b.ctx)
    await device.onActivate()
    return { b, device, net }
  }

  it('follows the update block the server pushes with the device state', async () => {
    const net = openServer()
    const { b } = await update(() => net)
    expect(b.slice('update')).toMatchObject({ updatable: false, inProgress: false })
    net.last.push('door_front', {
      update: { state: 'available', installed_version: 1, latest_version: 2 },
    })
    expect(b.slice('update')).toMatchObject({
      currentVersion: '1',
      availableVersion: '2',
      updatable: true,
      inProgress: false,
    })
    net.last.push('door_front', {
      update: { state: 'updating', progress: 10, installed_version: 1, latest_version: 2 },
    })
    expect(b.slice('update')).toMatchObject({ inProgress: true, state: 'updating' })
  })

  it('installUpdate asks the server to update that device, and a refusal reaches the caller', async () => {
    const net = openServer()
    const { b } = await update(() => net)
    const install = b.providers.get('update')?.['installUpdate']?.(undefined as never)
    const sent = net.last
      .sentEnvelopes()
      .filter((e) => e.topic === 'bridge/request/device/ota_update/update')
    expect(sent[0]?.payload).toMatchObject({ id: DOOR })
    net.last.push('bridge/response/device/ota_update/update', {
      data: {},
      status: 'error',
      error: 'no image available',
      transaction: sent[0]?.payload['transaction'],
    })
    await expect(install).rejects.toThrow(/no image available/)
  })
})

describe('teardown', () => {
  it('a removed device drops its binding and stops following the server', async () => {
    const net = openServer()
    const b = build(21, DeviceType.Update, {
      equipment: `${DOOR}#update`,
      integrationId: INTEGRATION,
    })
    const device = new ZigbeeUpdateDevice(b.ctx)
    await device.onActivate()
    expect(z2mHub.deviceIdOf(INTEGRATION, DOOR)).toBe(21)
    await device.removeDevice()
    expect(z2mHub.deviceIdOf(INTEGRATION, DOOR)).toBeNull()
    net.last.push('door_front', {
      update: { state: 'available', installed_version: 1, latest_version: 2 },
    })
    expect(b.slice('update')).toMatchObject({ updatable: false })
  })

  it('a removed Zigbee device and Gateway drop their bindings too', async () => {
    openServer()
    const d = build(11, DeviceType.Sensor, {
      equipment: DOOR,
      integrationId: INTEGRATION,
      plan: planZ2mDevice(contactSensorExposes),
    })
    const device = new ZigbeeDevice(d.ctx)
    await device.onActivate()
    const g = build(5, DeviceType.Gateway, { equipment: 'gateway', integrationId: INTEGRATION })
    const gateway = new ZigbeeGatewayDevice(g.ctx)
    await gateway.onActivate()
    await device.removeDevice()
    await gateway.removeDevice()
    expect(z2mHub.deviceIdOf(INTEGRATION, DOOR)).toBeNull()
    expect(z2mHub.deviceIdOf(INTEGRATION, COORD)).toBeNull()
  })
})
