import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'

/**
 * What the operator adopts. `device`: every entity sharing one discovery
 * `device` block (a multi-actuator one becomes a Container, see
 * `mqtt-ha-container-plan.ts`). `entity`: an entity with no device block.
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
