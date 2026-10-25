import type { DiscoveredChildDevice } from '@camstack/types'
import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import { mapMqttHaComponentToCamStack } from './mqtt-ha-domain-mapping.js'

export function buildMqttHaEntityCandidate(input: {
  readonly entity: MqttHaDiscoveredEntity
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { entity, adoptedDeviceId } = input
  const mapping = mapMqttHaComponentToCamStack(entity.component)
  return {
    childNativeId: entity.entityKey,
    name: entity.name,
    type: mapping.deviceType,
    status: 'online',
    metadata: {
      ...(entity.unitOfMeasurement !== null ? { model: entity.unitOfMeasurement } : {}),
    },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
    capabilities: [...mapping.capabilities],
  }
}

export function mappableMqttHaEntity(entity: MqttHaDiscoveredEntity): boolean {
  return mapMqttHaComponentToCamStack(entity.component).capabilities.length > 0
}
