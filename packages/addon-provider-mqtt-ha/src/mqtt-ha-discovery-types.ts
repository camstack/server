/** Supported HA MQTT discovery components in v1. */
export type MqttHaComponent = 'sensor' | 'switch'

/** Normalised discovery record for one MQTT entity. */
export interface MqttHaDiscoveredEntity {
  readonly brokerId: string
  /** Opaque native id for adoption (`childNativeId`). */
  readonly entityKey: string
  readonly component: MqttHaComponent
  readonly objectId: string
  readonly name: string
  readonly stateTopic: string
  readonly commandTopic: string | null
  readonly unitOfMeasurement: string | null
  readonly payloadOn: string
  readonly payloadOff: string
  readonly uniqueId: string | null
  readonly discoveredAt: number
}

export interface ParsedDiscoveryTopic {
  readonly discoveryPrefix: string
  readonly component: string
  readonly objectId: string
}
