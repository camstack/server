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
}

/**
 * A DeviceContext stub. The cast is the documented test boundary: the real
 * context is the kernel's and cannot be built in a unit test.
 */
function build(type: DeviceType, config: Record<string, unknown>): Harness {
  let runtime: IDeviceRuntimeState | null = null
  const emitted: unknown[] = []
  let switchProvider: { setState: (input: { on: boolean }) => Promise<void> } | null = null
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
    },
    persistedConfig: config,
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
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
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
  const device = new MqttHaDevice(ctx)
  return {
    device,
    emitted,
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
    expect(meter).toMatchObject({ watts: 42.5, volts: 231, amps: 0.19 })
    expect(meter?.['kwhTotal']).toBeCloseTo(3.2)
    expect(h.state().getCapState('switch')).toMatchObject({ on: true })
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
    expect(h.state().getCapState('battery')).toMatchObject({ percentage: 87 })
  })

  it('fires an event only for a live message', async () => {
    const h = build(DeviceType.EventEmitter, configOf(remoteMessages()))
    await h.device.onActivate()
    const entities = entitiesOf(remoteMessages())
    const event = entities.find((e) => e.component === 'event')!
    deliver(
      mqttHaStateGateway,
      entities,
      event.stateTopic,
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
})
