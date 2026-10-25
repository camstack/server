import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import { decodeSensorPayload, decodeSwitchPayload } from './mqtt-ha-discovery-parser.js'

export interface MqttHaSwitchState {
  readonly on: boolean
  readonly lastChangedAt: number
}

export interface MqttHaSensorState {
  readonly value: number
  readonly lastFetchedAt: number
}

type EntityState = MqttHaSwitchState | MqttHaSensorState

export type MqttHaPublish = (input: {
  readonly brokerId: string
  readonly topic: string
  readonly payload: string
}) => Promise<void>

/**
 * Live MQTT state keyed by (brokerId, entityKey). Devices read from here;
 * broker sessions write on each state_topic message.
 */
export class MqttHaStateGateway {
  private readonly states = new Map<string, EntityState>()
  private publishImpl: MqttHaPublish | null = null

  setPublisher(publish: MqttHaPublish): void {
    this.publishImpl = publish
  }

  private key(brokerId: string, entityKey: string): string {
    return `${brokerId}\0${entityKey}`
  }

  applyStateMessage(entity: MqttHaDiscoveredEntity, payload: string): void {
    const k = this.key(entity.brokerId, entity.entityKey)
    const now = Date.now()
    if (entity.component === 'switch') {
      const on = decodeSwitchPayload(payload, entity)
      if (on === null) return
      this.states.set(k, { on, lastChangedAt: now })
      return
    }
    const value = decodeSensorPayload(payload)
    if (value === null) return
    this.states.set(k, { value, lastFetchedAt: now })
  }

  getSwitchState(brokerId: string, entityKey: string): MqttHaSwitchState | null {
    const state = this.states.get(this.key(brokerId, entityKey))
    if (state === undefined || !('on' in state)) return null
    return state
  }

  getSensorState(brokerId: string, entityKey: string): MqttHaSensorState | null {
    const state = this.states.get(this.key(brokerId, entityKey))
    if (state === undefined || !('value' in state)) return null
    return state
  }

  setSwitchStateLocal(brokerId: string, entityKey: string, on: boolean): void {
    this.states.set(this.key(brokerId, entityKey), { on, lastChangedAt: Date.now() })
  }

  async publishSwitchCommand(entity: MqttHaDiscoveredEntity, on: boolean): Promise<void> {
    const publish = this.publishImpl
    if (publish === null) throw new Error('mqtt-ha: MQTT publisher not wired')
    if (entity.commandTopic === null) {
      throw new Error('mqtt-ha: switch entity has no command_topic')
    }
    const payload = on ? entity.payloadOn : entity.payloadOff
    await publish({ brokerId: entity.brokerId, topic: entity.commandTopic, payload })
    this.setSwitchStateLocal(entity.brokerId, entity.entityKey, on)
  }

  clearBroker(brokerId: string): void {
    const prefix = `${brokerId}\0`
    for (const k of this.states.keys()) {
      if (k.startsWith(prefix)) this.states.delete(k)
    }
  }
}

/** Process-wide gateway for the addon runner (one import addon instance). */
export const mqttHaStateGateway = new MqttHaStateGateway()
