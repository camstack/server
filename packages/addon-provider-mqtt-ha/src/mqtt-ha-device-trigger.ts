import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'

/**
 * The discovery component a bridge uses to announce a button action as a
 * device trigger: one config per action, all on one topic, each published the
 * first time that action occurs. It is not an entity, so it is folded into an
 * `event` entity of the device (`parseDeviceTrigger`).
 */
export const MQTT_HA_TRIGGER_COMPONENT = 'device_automation'

/** The entity every trigger of one device and trigger type folds into. */
export function triggerEntityKey(deviceId: string, triggerType: string): string {
  return `trigger:${deviceId}:${triggerType}`
}

interface TriggerSource {
  readonly entityKey: string
  readonly eventType: string
}

/** What removing one trigger leaves: the entity without that event, or no entity. */
export interface MqttHaTriggerRemoval {
  readonly entityKey: string
  readonly entity: MqttHaDiscoveredEntity | null
}

/**
 * Which trigger config announced which event. A trigger carries one event;
 * the entity lists every event announced so far, in arrival order, and loses
 * one only when the config that announced it is removed.
 */
export class MqttHaTriggerLedger {
  private readonly sources = new Map<string, TriggerSource>()

  /** Record one trigger config; answers the entity carrying every event of its device. */
  add(sourceKey: string, incoming: MqttHaDiscoveredEntity): MqttHaDiscoveredEntity {
    const eventType = incoming.eventTypes[0]
    if (eventType === undefined) return incoming
    this.sources.set(sourceKey, { entityKey: incoming.entityKey, eventType })
    return { ...incoming, eventTypes: this.eventTypesOf(incoming.entityKey) }
  }

  /** Forget one trigger config; null when it had never been recorded. */
  remove(
    sourceKey: string,
    lookup: (entityKey: string) => MqttHaDiscoveredEntity | null,
  ): MqttHaTriggerRemoval | null {
    const source = this.sources.get(sourceKey)
    if (source === undefined) return null
    this.sources.delete(sourceKey)
    const eventTypes = this.eventTypesOf(source.entityKey)
    const existing = lookup(source.entityKey)
    if (eventTypes.length === 0 || existing === null) {
      return { entityKey: source.entityKey, entity: null }
    }
    return { entityKey: source.entityKey, entity: { ...existing, eventTypes } }
  }

  clear(): void {
    this.sources.clear()
  }

  private eventTypesOf(entityKey: string): string[] {
    const out = new Set<string>()
    for (const source of this.sources.values()) {
      if (source.entityKey === entityKey) out.add(source.eventType)
    }
    return [...out]
  }
}
