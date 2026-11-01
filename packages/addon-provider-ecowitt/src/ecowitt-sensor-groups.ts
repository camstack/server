import type { Sensor } from '@apocaliss92/nodewitt'
import {
  deviceGroupForSensor,
  ECOWITT_DEVICE_GROUPS,
  type EcowittDeviceGroup,
} from './ecowitt-mapping.js'
import type { EcowittSensorEntry } from './devices/ecowitt-container-device.js'

/** Resolve `deviceGroup` from a persisted container config (defaults to 'gateway'). */
export function configDeviceGroup(config: Record<string, unknown>): EcowittDeviceGroup {
  const g = config['deviceGroup']
  return ECOWITT_DEVICE_GROUPS.find((group) => group === g) ?? 'gateway'
}

/** Build the persisted sensor entry (incl. self-describing category) from a live Sensor. */
export function sensorToEntry(s: Sensor): EcowittSensorEntry {
  return {
    sensorId: s.id,
    quantity: s.quantity,
    ...(s.channel !== undefined ? { channel: s.channel } : {}),
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.category !== undefined ? { category: s.category } : {}),
  }
}

/** Bucket live sensors into their device group. */
export function bucketSensorsByGroup(
  sensors: readonly Sensor[],
): Map<EcowittDeviceGroup, EcowittSensorEntry[]> {
  const byGroup = new Map<EcowittDeviceGroup, EcowittSensorEntry[]>()
  for (const group of ECOWITT_DEVICE_GROUPS) byGroup.set(group, [])
  for (const s of sensors) {
    const group = deviceGroupForSensor(s.category, s.channel)
    byGroup.get(group)?.push(sensorToEntry(s))
  }
  return byGroup
}

/** Structural equality of two persisted sensor lists (order-independent by id + name). */
export function sensorsEqual(a: readonly unknown[], b: readonly EcowittSensorEntry[]): boolean {
  if (a.length !== b.length) return false
  const aById = new Map<string, string | undefined>()
  for (const entry of a) {
    if (typeof entry === 'object' && entry !== null && 'sensorId' in entry) {
      const id = entry.sensorId
      if (typeof id === 'string') {
        const name = 'name' in entry && typeof entry.name === 'string' ? entry.name : undefined
        aById.set(id, name)
      }
    }
  }
  for (const entry of b) {
    if (!aById.has(entry.sensorId)) return false
    if (aById.get(entry.sensorId) !== entry.name) return false
  }
  return true
}
