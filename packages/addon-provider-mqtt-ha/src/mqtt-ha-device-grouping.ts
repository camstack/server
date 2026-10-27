import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import { isActuatorEntity } from './mqtt-ha-domain-mapping.js'

/**
 * What the operator adopts. `device`: every entity sharing one discovery
 * `device` block. `entity`: an entity with no device block, or one gang of a
 * multi-gang device (two switches in one wall box are two devices, never one
 * device that silently drops the second gang).
 */
export interface MqttHaPhysicalDevice {
  readonly kind: 'device' | 'entity'
  /** Opaque id used as `childNativeId` and in the stable id. */
  readonly nativeId: string
  readonly name: string
  readonly manufacturer: string | null
  readonly model: string | null
  readonly entities: readonly MqttHaDiscoveredEntity[]
}

export function deviceNativeId(deviceId: string): string {
  return `device:${deviceId}`
}

function splitMultiGang(
  entities: readonly MqttHaDiscoveredEntity[],
): MqttHaPhysicalDevice[] | null {
  const actuators = entities.filter(isActuatorEntity)
  if (actuators.length < 2) return null
  const first = entities[0]?.device
  if (first === undefined || first === null) return null
  const rest = entities.filter((e) => !actuators.includes(e))
  return actuators.map((actuator, index) => ({
    kind: 'entity',
    nativeId: actuator.entityKey,
    name:
      first.name !== null && actuator.name !== first.name
        ? `${first.name} ${actuator.name}`
        : actuator.name,
    manufacturer: first.manufacturer,
    model: first.model,
    // The first gang carries the device-wide readings (meter, battery).
    entities: index === 0 ? [actuator, ...rest] : [actuator],
  }))
}

/** Group a broker's discovered entities into the devices an operator adopts. */
export function groupEntitiesByDevice(
  entities: readonly MqttHaDiscoveredEntity[],
): MqttHaPhysicalDevice[] {
  const byDevice = new Map<string, MqttHaDiscoveredEntity[]>()
  const out: MqttHaPhysicalDevice[] = []
  const order: Array<string | MqttHaPhysicalDevice> = []
  for (const entity of entities) {
    if (entity.device === null) {
      order.push({
        kind: 'entity',
        nativeId: entity.entityKey,
        name: entity.name,
        manufacturer: null,
        model: null,
        entities: [entity],
      })
      continue
    }
    const bucket = byDevice.get(entity.device.id)
    if (bucket === undefined) {
      byDevice.set(entity.device.id, [entity])
      order.push(entity.device.id)
    } else {
      bucket.push(entity)
    }
  }
  for (const item of order) {
    if (typeof item !== 'string') {
      out.push(item)
      continue
    }
    const members = byDevice.get(item) ?? []
    const info = members[0]?.device
    if (info === undefined || info === null) continue
    const split = splitMultiGang(members)
    if (split !== null) {
      out.push(...split)
      continue
    }
    out.push({
      kind: 'device',
      nativeId: deviceNativeId(item),
      name: info.name ?? members[0]?.name ?? item,
      manufacturer: info.manufacturer,
      model: info.model,
      entities: members,
    })
  }
  return out
}
