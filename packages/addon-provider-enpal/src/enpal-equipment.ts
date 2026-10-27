import { DeviceType, type AccessoryChildSpec } from '@camstack/types'
import { z } from 'zod'
import { ENPAL_SYSTEM } from './config.js'
import { findSpec } from './enpal-catalog.js'
import { enpalSensorFactory } from './devices/enpal-sensor-factory.js'

/** One physical piece of the installation: a Container, with the catalog entries it owns. */
export interface EnpalEquipment {
  readonly id: string
  readonly name: string
  readonly specIds: readonly string[]
}

/** Order is the order the candidates are listed in. Every catalog entry belongs to one. */
export const ENPAL_EQUIPMENT: readonly EnpalEquipment[] = [
  { id: 'pv', name: 'Photovoltaic', specIds: ['pv', 'inverter-temperature'] },
  {
    id: 'battery',
    name: 'Battery',
    specIds: [
      'battery',
      'battery-charged',
      'battery-discharged',
      'battery-temperature',
      'battery-health',
    ],
  },
  { id: 'grid', name: 'Grid', specIds: ['grid-import', 'grid-export'] },
  { id: 'house', name: 'House', specIds: ['house'] },
  {
    id: 'heatpump',
    name: 'Heat pump',
    specIds: ['heatpump', 'heatpump-hot-water', 'heatpump-outside'],
  },
]

export function findEquipment(id: string): EnpalEquipment | undefined {
  return ENPAL_EQUIPMENT.find((e) => e.id === id)
}

/** The `childNativeId` of a child candidate: namespaced by its container. */
export function childNativeId(equipmentId: string, specId: string): string {
  return `${equipmentId}#${specId}`
}

/**
 * Persisted config of an equipment Container. `specIds` are the children it was adopted with:
 * they stay, whatever the box reports later, so a restart with the box off keeps them.
 */
export const enpalEquipmentSchema = z.object({
  equipment: z.string().min(1).describe('Equipment id (pv, battery, grid, house, heatpump)'),
  specIds: z.array(z.string().min(1)).describe('Catalog entries adopted as children'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
})

export type EnpalEquipmentConfig = z.infer<typeof enpalEquipmentSchema>

/** The Sensor children the kernel spawns under an equipment Container. */
export function accessoryChildSpecs(config: {
  readonly equipment: string
  readonly specIds: readonly string[]
  readonly integrationId: string
}): readonly AccessoryChildSpec[] {
  const out: AccessoryChildSpec[] = []
  for (const specId of config.specIds) {
    const spec = findSpec(specId)
    if (spec === undefined) continue
    out.push({
      stableIdSuffix: spec.id,
      meta: {
        type: DeviceType.Sensor,
        name: spec.name,
        role: spec.role,
        integrationId: config.integrationId,
      },
      config: {
        specId: spec.id,
        integrationId: config.integrationId,
        system: ENPAL_SYSTEM,
      },
      factory: enpalSensorFactory,
    })
  }
  return out
}
