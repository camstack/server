import { describe, expect, it, vi } from 'vitest'
import {
  DeviceType,
  EventCategory,
  type DeviceContext,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { MqttHaDevice } from '../devices/mqtt-ha-device.js'
import { groupEntitiesByDevice } from '../mqtt-ha-device-grouping.js'
import { planMqttHaDevice } from '../mqtt-ha-domain-mapping.js'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import { mqttHaStateGateway } from '../mqtt-ha-state-gateway.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import {
  plugMessages,
  remoteMessages,
  contactMessages,
  irBlasterButtonMessages,
  irBlasterMessages,
  IR_TOPIC,
  triggerMessage,
  type DiscoveryMessage,
} from './fixtures/z2m-discovery.js'

const BROKER = 'mqtt_z2m'

function entitiesOf(messages: readonly DiscoveryMessage[]): MqttHaDiscoveredEntity[] {
  const out: MqttHaDiscoveredEntity[] = []
  for (const m of messages) {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: BROKER,
      component: m.component,
      objectId: m.objectId,
      payload: JSON.stringify(m.payload),
      now: 1,
    })
    if (parsed !== null && parsed !== 'remove') out.push(parsed)
  }
  return out
}

function configOf(messages: readonly DiscoveryMessage[]): Record<string, unknown> {
  const group = groupEntitiesByDevice(entitiesOf(messages))[0]!
  const plan = planMqttHaDevice(group)!
  return {
    brokerId: BROKER,
    entityKey: plan.members[0]!.entityKey,
    deviceKey: group.nativeId,
    entities: [...plan.members],
    bindings: plan.bindings,
    meter: plan.meter,
    capabilities: [...plan.capabilities],
  }
}

interface Harness {
  readonly device: MqttHaDevice
  readonly emitted: unknown[]
  readonly setSwitch: (on: boolean) => Promise<void>
  readonly state: () => IDeviceRuntimeState
  /** Every native cap provider the device registered, by cap name. */
  readonly providers: Map<string, unknown>
  readonly setRole: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
}

/**
 * A DeviceContext stub. The cast is the documented test boundary: the real
 * context is the kernel's and cannot be built in a unit test.
 */
function build(
  type: DeviceType,
  config: Record<string, unknown>,
  restored: Record<string, unknown> = {},
  role: string | null = null,
): Harness {
  let runtime: IDeviceRuntimeState | null = null
  const emitted: unknown[] = []
  const providers = new Map<string, unknown>()
  let switchProvider: { setState: (input: { on: boolean }) => Promise<void> } | null = null
  const setRole = vi.fn(async () => {})
  const info = vi.fn()
  const ctx = {
    id: 9,
    stableId: 'mqtt:test',
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'T',
      location: null,
      disabled: false,
      addonId: 'provider-mqtt-ha',
      metadata: {},
      ...(role !== null ? { role } : {}),
    },
    persistedConfig: config,
    initialRuntimeState: restored,
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
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
      providers.set(cap.name, provider)
      if (cap.name === 'switch') {
        switchProvider = provider as { setState: (input: { on: boolean }) => Promise<void> }
      }
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
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  const device = new MqttHaDevice(ctx)
  return {
    device,
    emitted,
    providers,
    setRole,
    info,
    setSwitch: async (on) => {
      if (switchProvider === null) throw new Error('no switch cap')
      await switchProvider.setState({ on })
    },
    state: () => {
      if (runtime === null) throw new Error('runtime state not bound')
      return runtime
    },
  }
}

/** Deliver a message the way the broker session does. */
function deliver(
  gateway: typeof mqttHaStateGateway,
  entities: readonly MqttHaDiscoveredEntity[],
  topic: string,
  payload: string,
): void {
  gateway.recordMessage(BROKER, topic, payload)
  for (const e of entities) {
    if (e.stateTopic === topic || e.availability.some((a) => a.topic === topic)) {
      gateway.notifyEntity(BROKER, e.entityKey, topic, payload)
    }
  }
}

describe('MqttHaDevice on a zigbee2mqtt plug', () => {
  it('folds power, energy, voltage and current into one power-meter slice', async () => {
    const h = build(DeviceType.Switch, configOf(plugMessages()))
    await h.device.onActivate()
    const entities = entitiesOf(plugMessages())
    deliver(
      mqttHaStateGateway,
      entities,
      'zigbee2mqtt/Kitchen plug',
      JSON.stringify({ state: 'ON', power: 42.5, energy: 3.2, voltage: 231, current: 0.19 }),
    )
    const meter = h.state().getCapState('power-meter')
    expect(meter).toMatchObject({ power: 42.5, voltage: 231, current: 0.19 })
    expect(meter?.['energy']).toBeCloseTo(3.2)
    expect(h.state().getCapState('switch')).toMatchObject({ on: true })
  })

  it('reads a switch that never reported as unknown, never as off (D393)', async () => {
    mqttHaStateGateway.clearBroker(BROKER)
    const h = build(DeviceType.Switch, configOf(plugMessages()))
    await h.device.onActivate()
    expect(h.state().getCapState('switch')).toMatchObject({ on: null, lastChangedAt: 0 })
  })

  it('migrates a legacy restored off-with-no-change-time slice to unknown, after the cap schema is registered', async () => {
    mqttHaStateGateway.clearBroker(BROKER)
    const h = build(DeviceType.Switch, configOf(plugMessages()), {
      switch: { on: false, lastChangedAt: 0 },
    })
    await expect(h.device.onActivate()).resolves.toBeUndefined()
    expect(h.state().getCapState('switch')).toMatchObject({ on: null, lastChangedAt: 0 })
  })

  it('publishes the switch command on its command topic', async () => {
    const h = build(DeviceType.Switch, configOf(plugMessages()))
    await h.device.onActivate()
    const publish = vi.fn(async () => {})
    mqttHaStateGateway.setPublisher(publish)
    const cmd = entitiesOf(plugMessages()).find((e) => e.component === 'switch')!
    await h.setSwitch(false)
    expect(publish).toHaveBeenCalledWith({
      brokerId: BROKER,
      topic: cmd.commandTopic,
      payload: cmd.payloadOff,
    })
  })
})

describe('MqttHaDevice on a contact sensor and a remote', () => {
  it('maps payload_on false to an open entry and fills the battery', async () => {
    const h = build(DeviceType.Sensor, configOf(contactMessages()))
    await h.device.onActivate()
    deliver(
      mqttHaStateGateway,
      entitiesOf(contactMessages()),
      'zigbee2mqtt/Front door',
      JSON.stringify({ contact: false, battery: 87 }),
    )
    expect(h.state().getCapState('contact')).toMatchObject({ entryOpen: true })
    expect(h.state().getCapState('battery')).toMatchObject({ level: 87 })
  })

  it('fires an event only for a live message', async () => {
    const h = build(DeviceType.EventEmitter, configOf(remoteMessages()))
    await h.device.onActivate()
    const entities = entitiesOf(remoteMessages())
    const event = entities.find((e) => e.component === 'event')!
    deliver(
      mqttHaStateGateway,
      entities,
      event.stateTopic!,
      JSON.stringify({ event_type: 'single' }),
    )
    const fired = h.emitted.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'category' in e &&
        e.category === EventCategory.EventEmitted,
    )
    expect(fired).toHaveLength(1)
    expect(h.state().getCapState('event-emitter')).toMatchObject({ eventCountSinceStart: 1 })
  })

  it('fires the plain payload of a device trigger, and lists an event it had not been told about', async () => {
    const entities = entitiesOf([triggerMessage('single')])
    const h = build(DeviceType.EventEmitter, configOf([triggerMessage('single')]))
    await h.device.onActivate()
    const topic = entities[0]!.stateTopic!
    deliver(mqttHaStateGateway, entities, topic, 'single')
    expect(h.state().getCapState('event-emitter')).toMatchObject({
      eventTypes: ['single'],
      lastEvent: { eventType: 'single' },
    })
    deliver(mqttHaStateGateway, entities, topic, 'double')
    deliver(mqttHaStateGateway, entities, topic, 'double')
    expect(h.state().getCapState('event-emitter')).toMatchObject({
      eventTypes: ['single', 'double'],
      vocabulary: [
        { id: 'single', label: 'Single' },
        { id: 'double', label: 'Double', kind: 'double-press' },
      ],
      lastEvent: { eventType: 'double' },
      eventCountSinceStart: 3,
    })
  })

  it('stamps contact-sensor when a restored contact has no role, and leaves a set role alone', async () => {
    const missing = build(DeviceType.Sensor, configOf(contactMessages()))
    await missing.device.onActivate()
    expect(missing.setRole).toHaveBeenCalledWith({ deviceId: 9, role: 'contact-sensor' })
    expect(missing.info).toHaveBeenCalledWith(
      expect.stringContaining('role'),
      expect.objectContaining({ tags: { deviceId: 9 } }),
    )

    const kept = build(DeviceType.Sensor, configOf(contactMessages()), {}, 'motion-sensor')
    await kept.device.onActivate()
    expect(kept.setRole).not.toHaveBeenCalled()
  })
})

interface IrProvider {
  send(input: {
    timings?: number[]
    native?: { format: 'tuya'; code: string }
  }): Promise<{ ok: true; ignoredSettings: string[] }>
  learn(input: { timeoutMs: number }): Promise<{
    native: { format: string; code: string } | null
    timings: number[]
    carrierHz: number | null
  }>
  getInfo(): Promise<{ learn: boolean; formats: string[]; media: string[] }>
}

describe('MqttHaDevice on a zigbee2mqtt IR blaster', () => {
  const entities = entitiesOf(irBlasterMessages())

  async function activate(): Promise<{ provider: IrProvider; published: [string, string][] }> {
    const published: [string, string][] = []
    mqttHaStateGateway.setPublisher(async ({ topic, payload }) => {
      published.push([topic, payload])
    })
    const group = groupEntitiesByDevice(entities)[0]!
    const plan = planMqttHaDevice(group)!
    expect(plan.deviceType).toBe(DeviceType.Generic)
    const h = build(plan.deviceType, configOf(irBlasterMessages()))
    await h.device.onActivate()
    const provider = h.providers.get('ir-transmitter') as IrProvider
    expect(provider).toBeDefined()
    return { provider, published }
  }

  it('is an ir-transmitter that learns and replays tuya codes', async () => {
    const { provider } = await activate()
    expect(await provider.getInfo()).toMatchObject({
      learn: true,
      formats: ['tuya'],
      media: ['ir'],
    })
  })

  it('publishes a native code on the code entity command topic, verbatim', async () => {
    const { provider, published } = await activate()
    await provider.send({ native: { format: 'tuya', code: 'AxAAIABAAw==' } })
    expect(published).toEqual([[`${IR_TOPIC}/set/ir_code_to_send`, 'AxAAIABAAw==']])
  })

  it('publishes on the DISCOVERED command topics, whatever their shape', async () => {
    const odd = irBlasterMessages({
      sendTopic: 'blaster/livingroom/tx',
      learnTopic: 'blaster/livingroom/learn',
    })
    const published: [string, string][] = []
    mqttHaStateGateway.setPublisher(async ({ topic, payload }) => {
      published.push([topic, payload])
    })
    const plan = planMqttHaDevice(groupEntitiesByDevice(entitiesOf(odd))[0]!)!
    const h = build(plan.deviceType, configOf(odd))
    await h.device.onActivate()
    const provider = h.providers.get('ir-transmitter') as IrProvider
    await provider.send({ native: { format: 'tuya', code: 'AxAAIABAAw==' } })
    const learning = provider.learn({ timeoutMs: 50 })
    learning.catch(() => undefined)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(published).toEqual([
      ['blaster/livingroom/tx', 'AxAAIABAAw=='],
      ['blaster/livingroom/learn', 'ON'],
    ])
  })

  it('encodes a pulse train before publishing it', async () => {
    const { provider, published } = await activate()
    await provider.send({ timings: [16, -32, 16, -32] })
    expect(published).toHaveLength(1)
    expect(published[0]?.[0]).toBe(`${IR_TOPIC}/set/ir_code_to_send`)
    expect(published[0]?.[1]).toBe('AxAAIABAAw==')
  })

  it('learn resolves on the NEXT learned state, not on the one already held', async () => {
    mqttHaStateGateway.recordMessage(BROKER, IR_TOPIC, JSON.stringify({ learned_ir_code: 'AAAA' }))
    const { provider, published } = await activate()
    const pending = provider.learn({ timeoutMs: 5000 })
    await vi.waitFor(() => expect(published).toEqual([[`${IR_TOPIC}/set/learn_ir_code`, 'ON']]))
    deliver(
      mqttHaStateGateway,
      entities,
      IR_TOPIC,
      JSON.stringify({ learned_ir_code: 'AxAAIABAAw==' }),
    )
    const learned = await pending
    expect(learned.native).toEqual({ format: 'tuya', code: 'AxAAIABAAw==' })
    expect(learned.timings).toEqual([16, -32, 16, -32])
  })

  it('learn ignores an unchanged learned code republished with other fields', async () => {
    mqttHaStateGateway.recordMessage(BROKER, IR_TOPIC, JSON.stringify({ learned_ir_code: 'AAAA' }))
    const { provider, published } = await activate()
    const pending = provider.learn({ timeoutMs: 5000 })
    await vi.waitFor(() => expect(published).toHaveLength(1))
    let settled = false
    pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    deliver(
      mqttHaStateGateway,
      entities,
      IR_TOPIC,
      JSON.stringify({ learned_ir_code: 'AAAA', linkquality: 87 }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    deliver(
      mqttHaStateGateway,
      entities,
      IR_TOPIC,
      JSON.stringify({ learned_ir_code: 'AxAAIABAAw==', linkquality: 87 }),
    )
    expect((await pending).native).toEqual({ format: 'tuya', code: 'AxAAIABAAw==' })
  })

  it('learn times out with a typed error when nothing arrives', async () => {
    const { provider } = await activate()
    await expect(provider.learn({ timeoutMs: 20 })).rejects.toMatchObject({
      i18nCode: 'ir-transmitter.learn-timeout',
    })
  })

  it('learn on the button announcement publishes that button payload_press', async () => {
    const messages = irBlasterButtonMessages({ payloadPress: 'PRESS' })
    const published: [string, string][] = []
    mqttHaStateGateway.setPublisher(async ({ topic, payload }) => {
      published.push([topic, payload])
    })
    const plan = planMqttHaDevice(groupEntitiesByDevice(entitiesOf(messages))[0]!)!
    expect(plan.capabilities).toEqual(['ir-transmitter'])
    const h = build(plan.deviceType, configOf(messages))
    await h.device.onActivate()
    const provider = h.providers.get('ir-transmitter') as IrProvider
    const pending = provider.learn({ timeoutMs: 30 })
    pending.catch(() => undefined)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published).toEqual([[`${IR_TOPIC}/set/learn_ir_code`, 'PRESS']])
  })

  it('a button that omits payload_press publishes payload_on', async () => {
    const messages = irBlasterButtonMessages({ payloadPress: '' })
    const published: [string, string][] = []
    mqttHaStateGateway.setPublisher(async ({ topic, payload }) => {
      published.push([topic, payload])
    })
    const plan = planMqttHaDevice(groupEntitiesByDevice(entitiesOf(messages))[0]!)!
    const h = build(plan.deviceType, configOf(messages))
    await h.device.onActivate()
    const provider = h.providers.get('ir-transmitter') as IrProvider
    const pending = provider.learn({ timeoutMs: 30 })
    pending.catch(() => undefined)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published).toEqual([[`${IR_TOPIC}/set/learn_ir_code`, 'ON']])
  })

  it('records a refused send as not ok with the error code', async () => {
    const h = build(DeviceType.Generic, configOf(irBlasterMessages()))
    await h.device.onActivate()
    const provider = h.providers.get('ir-transmitter') as IrProvider
    const long = Array.from({ length: 514 }, (_, i) => (i % 2 === 0 ? 16 : -32))
    await expect(provider.send({ timings: long })).rejects.toMatchObject({
      i18nCode: 'ir-transmitter.too-long',
    })
    expect(
      h.state().getCapState<{
        lastSend?: { ok: boolean; error: string | null; medium: string }
      }>('ir-transmitter')?.lastSend,
    ).toMatchObject({ ok: false, error: 'ir-transmitter.too-long', medium: 'ir' })
  })

  it('learn refuses an undecodable code with a typed error', async () => {
    const { provider, published } = await activate()
    const pending = provider.learn({ timeoutMs: 5000 })
    await vi.waitFor(() => expect(published).toHaveLength(1))
    deliver(mqttHaStateGateway, entities, IR_TOPIC, JSON.stringify({ learned_ir_code: '!!!' }))
    await expect(pending).rejects.toMatchObject({ i18nCode: 'ir-transmitter.learn-undecodable' })
  })
})
