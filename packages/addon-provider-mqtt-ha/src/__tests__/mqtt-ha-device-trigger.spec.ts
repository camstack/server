import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import { MqttHaTriggerLedger } from '../mqtt-ha-device-trigger.js'
import { groupEntitiesByDevice } from '../mqtt-ha-device-grouping.js'
import { planMqttHaDevice } from '../mqtt-ha-domain-mapping.js'
import {
  TRIGGER_REMOTE_FRIENDLY,
  TRIGGER_REMOTE_IEEE,
  triggerMessage,
  triggerRemoteMessages,
  type DiscoveryMessage,
} from './fixtures/z2m-discovery.js'

function parse(message: DiscoveryMessage): MqttHaDiscoveredEntity | null | 'remove' {
  return parseDiscoveryConfigPayload({
    brokerId: 'mqtt_z2m',
    component: message.component,
    objectId: message.objectId,
    payload: JSON.stringify(message.payload),
    now: 1,
  })
}

function parsed(message: DiscoveryMessage): MqttHaDiscoveredEntity {
  const entity = parse(message)
  if (entity === null || entity === 'remove') throw new Error('not an entity')
  return entity
}

describe('a device trigger in discovery', () => {
  it('reads as the event entity of its device, with the one event it announces', () => {
    const entity = parsed(triggerMessage('single'))
    expect(entity.component).toBe('event')
    expect(entity.stateTopic).toBe(`zigbee2mqtt/${TRIGGER_REMOTE_FRIENDLY}/action`)
    expect(entity.eventTypes).toEqual(['single'])
    expect(entity.device?.id).toBe(`zigbee2mqtt_${TRIGGER_REMOTE_IEEE}`)
    expect(entity.valueTemplate).toBeNull()
  })

  it('gives every trigger of one device and type the same entity', () => {
    expect(parsed(triggerMessage('single')).entityKey).toBe(
      parsed(triggerMessage('double')).entityKey,
    )
  })

  it('is nothing without a topic, a device or a payload, or when it is not a trigger', () => {
    const base = triggerMessage('single')
    const without = (key: string): DiscoveryMessage => ({
      ...base,
      payload: Object.fromEntries(Object.entries(base.payload).filter(([k]) => k !== key)),
    })
    expect(parse(without('topic'))).toBeNull()
    expect(parse(without('device'))).toBeNull()
    expect(
      parse({ ...base, payload: { ...without('payload').payload, subtype: undefined } }),
    ).toBeNull()
    expect(
      parse({ ...base, payload: { ...base.payload, automation_type: 'condition' } }),
    ).toBeNull()
  })

  it('an empty payload is a removal', () => {
    expect(
      parseDiscoveryConfigPayload({
        brokerId: 'mqtt_z2m',
        component: 'device_automation',
        objectId: 'action_single',
        payload: '',
      }),
    ).toBe('remove')
  })
})

describe('MqttHaTriggerLedger', () => {
  it('folds the triggers of a device into one entity, events in arrival order, each once', () => {
    const ledger = new MqttHaTriggerLedger()
    ledger.add('action_single', parsed(triggerMessage('single')))
    ledger.add('action_double', parsed(triggerMessage('double')))
    const entity = ledger.add('action_single', parsed(triggerMessage('single')))
    expect(entity.eventTypes).toEqual(['single', 'double'])
  })

  it('a removed trigger takes its event with it, and the last one takes the entity', () => {
    const ledger = new MqttHaTriggerLedger()
    ledger.add('action_single', parsed(triggerMessage('single')))
    const both = ledger.add('action_double', parsed(triggerMessage('double')))
    const lookup = (): MqttHaDiscoveredEntity => both
    const afterOne = ledger.remove('action_single', lookup)
    expect(afterOne?.entity?.eventTypes).toEqual(['double'])
    const afterAll = ledger.remove('action_double', lookup)
    expect(afterAll).toEqual({ entityKey: both.entityKey, entity: null })
    expect(ledger.remove('action_double', lookup)).toBeNull()
  })

  it('forgets everything on clear', () => {
    const ledger = new MqttHaTriggerLedger()
    const entity = ledger.add('action_single', parsed(triggerMessage('single')))
    ledger.clear()
    expect(ledger.remove('action_single', () => entity)).toBeNull()
  })
})

describe('a remote whose buttons are device triggers', () => {
  it('is an event device with the events seen so far, and battery', () => {
    const ledger = new MqttHaTriggerLedger()
    const byKey = new Map<string, MqttHaDiscoveredEntity>()
    for (const message of triggerRemoteMessages()) {
      const entity = parsed(message)
      const stored =
        message.component === 'device_automation' ? ledger.add(message.objectId, entity) : entity
      byKey.set(stored.entityKey, stored)
    }
    const groups = groupEntitiesByDevice([...byKey.values()])
    expect(groups).toHaveLength(1)
    const plan = planMqttHaDevice(groups[0]!)
    expect(plan?.deviceType).toBe(DeviceType.EventEmitter)
    expect(plan?.capabilities).toEqual(['event-emitter', 'battery'])
    const eventKey = plan?.bindings['event-emitter']
    expect(byKey.get(eventKey ?? '')?.eventTypes).toEqual(['single', 'double', 'hold'])
  })
})
