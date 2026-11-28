import {
  type DeviceContext,
  DeviceType,
  EventCategory,
  type IDeviceRuntimeState,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZigbeeDevice } from '../z2m-device.js'
import { planZ2mDevice } from '../z2m-exposes.js'
import { z2mHub } from '../z2m-hub.js'
import type { Z2mExpose } from '../z2m-protocol.js'
import {
  bulbExposes,
  buttonExposes,
  contactSensorExposes,
  lockExposes,
  shutterExposes,
  weatherSensorExposes,
} from './fixtures/z2m-fixtures.js'
import { FakeNet, ManualTimers, recordingLogger } from './fakes.js'

const INTEGRATION = 'z2m-1'

function listing(ieee: string, name: string, exposes: readonly Z2mExpose[]) {
  return {
    ieee_address: ieee,
    type: 'EndDevice',
    network_address: 1,
    supported: true,
    friendly_name: name,
    disabled: false,
    definition: { model: 'X', vendor: 'V', exposes },
    interviewing: false,
    interview_completed: true,
  }
}

interface Harness {
  readonly device: ZigbeeDevice
  readonly net: FakeNet
  readonly emitted: unknown[]
  readonly providers: Map<string, Record<string, (...args: never[]) => Promise<unknown>>>
  readonly slice: (cap: string) => unknown
  readonly setRole: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

/**
 * Wire one device to a session over a fake socket. The cast is the documented test boundary: the real
 * DeviceContext is the kernel's and cannot be built in a unit test.
 */
async function setup(
  type: DeviceType,
  ieee: string,
  name: string,
  exposes: readonly Z2mExpose[],
  role: string | null = null,
): Promise<Harness> {
  const plan = planZ2mDevice(exposes)
  let runtime: IDeviceRuntimeState | null = null
  const emitted: unknown[] = []
  const providers: Harness['providers'] = new Map()
  const setRole = vi.fn(async () => {})
  const warn = vi.fn()
  const ctx = {
    id: 9,
    stableId: `provider-zigbee-z2m:${INTEGRATION}:${ieee}`,
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'T',
      location: null,
      disabled: false,
      addonId: 'provider-zigbee-z2m',
      metadata: {},
      ...(role !== null ? { role } : {}),
    },
    persistedConfig: { equipment: ieee, integrationId: INTEGRATION, plan },
    initialRuntimeState: {},
    eventBus: {
      emit: (e: unknown) => emitted.push(e),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
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
        setRole: { mutate: setRole },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
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
  net.last.push('bridge/devices', [listing(ieee, name, exposes)])
  const device = new ZigbeeDevice(ctx)
  await device.onActivate()
  return {
    device,
    net,
    emitted,
    providers,
    setRole,
    warn,
    slice: (cap) => {
      if (runtime === null) throw new Error('runtime state not bound')
      return runtime.getCapState(cap)
    },
  }
}

afterEach(() => z2mHub.disconnectAll())

function presses(h: Harness): unknown[] {
  return h.emitted.filter(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      'category' in e &&
      e.category === EventCategory.EventEmitted,
  )
}

const DOOR = '0x00158d0001a2b3c4'

describe('ZigbeeDevice readings', () => {
  it('fills temperature, humidity, pressure and battery from one state message', async () => {
    const h = await setup(DeviceType.Sensor, '0x1', 'weather', weatherSensorExposes)
    h.net.last.push('weather', { temperature: 21.5, humidity: 48, pressure: 1013, battery: 87 })
    expect(h.slice('temperature-sensor')).toMatchObject({ temperature: 21.5 })
    expect(h.slice('humidity-sensor')).toMatchObject({ humidity: 48 })
    expect(h.slice('pressure-sensor')).toMatchObject({ pressure: 1013 })
    expect(h.slice('battery')).toMatchObject({ level: 87 })
  })

  it('leaves a reading unknown, never zero, until the device reports it (D393)', async () => {
    const h = await setup(DeviceType.Sensor, '0x1', 'weather', weatherSensorExposes)
    expect(h.slice('temperature-sensor')).toMatchObject({ temperature: null })
    h.net.last.push('weather', { humidity: 40 })
    expect(h.slice('temperature-sensor')).toMatchObject({ temperature: null })
  })

  it('reads the inverted contact polarity: contact false means open', async () => {
    const h = await setup(DeviceType.Sensor, DOOR, 'door', contactSensorExposes)
    h.net.last.push('door', { contact: false })
    expect(h.slice('contact')).toMatchObject({ entryOpen: true })
    h.net.last.push('door', { contact: true })
    expect(h.slice('contact')).toMatchObject({ entryOpen: false })
  })

  it('scales a bulb brightness from the device scale to a percentage', async () => {
    const h = await setup(DeviceType.Light, '0x2', 'lamp', bulbExposes)
    h.net.last.push('lamp', { state: 'ON', brightness: 127, color_temp: 300 })
    expect(h.slice('switch')).toMatchObject({ on: true })
    expect(h.slice('brightness')).toMatchObject({ level: 50 })
    expect(h.slice('color')).toMatchObject({ colorTemperature: 300 })
  })

  it('reports a lock that is not fully locked as unlocked', async () => {
    const h = await setup(DeviceType.Lock, '0x3', 'front_lock', lockExposes)
    h.net.last.push('front_lock', { state: 'LOCK', lock_state: 'not_fully_locked' })
    expect(h.slice('lock-control')).toMatchObject({ state: 'unlocked' })
  })

  it('reads the shutter position and state', async () => {
    const h = await setup(DeviceType.Cover, '0x4', 'shutter', shutterExposes)
    h.net.last.push('shutter', { state: 'OPEN', position: 100 })
    expect(h.slice('cover')).toMatchObject({ state: 'open', position: 100 })
  })
})

describe('ZigbeeDevice commands', () => {
  it('sends the on/off value the device declares, to its friendly name', async () => {
    const h = await setup(DeviceType.Light, '0x2', 'lamp', bulbExposes)
    await h.providers.get('switch')?.['setState']?.({ on: false } as never)
    expect(h.net.last.sentEnvelopes().at(-1)).toEqual({
      topic: 'lamp/set',
      payload: { state: 'OFF' },
    })
  })

  it('scales a brightness percentage back to the device scale', async () => {
    const h = await setup(DeviceType.Light, '0x2', 'lamp', bulbExposes)
    await h.providers.get('brightness')?.['setBrightness']?.({ level: 50 } as never)
    expect(h.net.last.sentEnvelopes().at(-1)).toEqual({
      topic: 'lamp/set',
      payload: { brightness: 127 },
    })
  })

  it('opens, closes and positions a shutter', async () => {
    const h = await setup(DeviceType.Cover, '0x4', 'shutter', shutterExposes)
    await h.providers.get('cover')?.['open']?.({} as never)
    await h.providers.get('cover')?.['setPosition']?.({ position: 30 } as never)
    expect(h.net.last.sentEnvelopes().map((e) => e.payload)).toEqual([
      { state: 'OPEN' },
      { position: 30 },
    ])
  })

  it('locks with the value the lock declares', async () => {
    const h = await setup(DeviceType.Lock, '0x3', 'front_lock', lockExposes)
    await h.providers.get('lock-control')?.['lock']?.({} as never)
    expect(h.net.last.sentEnvelopes().at(-1)?.payload).toEqual({ state: 'LOCK' })
  })

  it('refuses a command while the socket is down instead of pretending it was sent', async () => {
    const h = await setup(DeviceType.Light, '0x2', 'lamp', bulbExposes)
    h.net.last.drop()
    await expect(h.providers.get('switch')?.['setState']?.({ on: true } as never)).rejects.toThrow(
      'not connected',
    )
  })
})

describe('ZigbeeDevice presence', () => {
  it('is online only while the socket is up, the bridge is online and the device is available', async () => {
    const h = await setup(DeviceType.Sensor, DOOR, 'door', contactSensorExposes)
    expect(h.device.online).toBe(true)
    h.net.last.push('door/availability', { state: 'offline' })
    expect(h.device.online).toBe(false)
    h.net.last.push('door/availability', { state: 'online' })
    expect(h.device.online).toBe(true)
    h.net.last.push('bridge/state', { state: 'offline' })
    expect(h.device.online).toBe(false)
    h.net.last.push('bridge/state', { state: 'online' })
    h.net.last.drop()
    expect(h.device.online).toBe(false)
  })

  it('stamps the role of its primary function once, and not over an operator choice', async () => {
    const fresh = await setup(DeviceType.Sensor, DOOR, 'door', contactSensorExposes)
    expect(fresh.setRole).toHaveBeenCalledWith({ deviceId: 9, role: 'contact-sensor' })
    z2mHub.disconnectAll()
    const chosen = await setup(DeviceType.Sensor, DOOR, 'door', contactSensorExposes, 'door')
    expect(chosen.setRole).not.toHaveBeenCalled()
  })
})

describe('ZigbeeDevice buttons', () => {
  it('fires an event for a press and not for the state replayed on connect', async () => {
    const h = await setup(DeviceType.EventEmitter, '0x5', 'button', buttonExposes)
    h.net.last.push('button', { action: 'single', battery: 90 }) // the snapshot
    expect(presses(h)).toHaveLength(0)
    h.net.last.push('button', { action: 'double' })
    expect(presses(h)).toHaveLength(1)
    expect(presses(h)[0]).toMatchObject({
      category: EventCategory.EventEmitted,
      data: { eventType: 'double' },
    })
    h.net.last.push('button', { battery: 89 }) // merged state still holds `double`: not a second press
    expect(presses(h)).toHaveLength(1)
  })
})
