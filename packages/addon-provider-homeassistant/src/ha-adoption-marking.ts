import { childDeviceIdsByEntity } from './ha-dismissed-children.js'
import type { HaDiscoveredDevice } from './ha-discovery-types.js'

/** The slice of a registry device the adoption marking reads. */
export interface AdoptionRegistryDevice {
  readonly id: number
  readonly stableId: string
  readonly parentDeviceId: number | null
  /** The `haDeviceId` of its config, when it is a string. */
  readonly haDeviceId: string | null
}

/** haDeviceId to the CamStack id of the top-level device that adopted it. */
export function adoptedDeviceIdsByHaDevice(
  devices: readonly AdoptionRegistryDevice[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of devices) {
    if (d.parentDeviceId !== null || d.haDeviceId === null) continue
    out.set(d.haDeviceId, d.id)
  }
  return out
}

/**
 * Fill `alreadyAdopted` + `adoptedCamDeviceId` on the discovered devices and on
 * each entity child. A child is adopted only while its live device exists
 * (stableId `${parent.stableId}-${entityId}`), so a dismissed or deleted child
 * stays not adopted.
 */
export function markAdoption(
  haDevices: readonly HaDiscoveredDevice[],
  registry: readonly AdoptionRegistryDevice[],
): HaDiscoveredDevice[] {
  const byHaDevice = adoptedDeviceIdsByHaDevice(registry)
  const parentById = new Map(registry.map((d) => [d.id, d]))
  return haDevices.map((dev) => {
    const camId = byHaDevice.get(dev.haDeviceId)
    if (camId === undefined) return { ...dev, alreadyAdopted: false, adoptedCamDeviceId: null }
    const parent = parentById.get(camId)
    const childIds =
      parent === undefined
        ? {}
        : childDeviceIdsByEntity(
            parent.stableId,
            registry.filter((d) => d.parentDeviceId === camId),
          )
    return {
      ...dev,
      alreadyAdopted: true,
      adoptedCamDeviceId: camId,
      entities: dev.entities.map((e) => {
        const childId = childIds[e.entityId]
        return childId === undefined
          ? { ...e, alreadyAdopted: false, adoptedCamDeviceId: null }
          : { ...e, alreadyAdopted: true, adoptedCamDeviceId: childId }
      }),
    }
  })
}
